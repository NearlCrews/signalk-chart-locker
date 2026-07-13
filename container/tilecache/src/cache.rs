//! The microSD-aware tile cache: one bundled-SQLite DB, a single serialized connection, WAL,
//! synchronous=NORMAL (survives boat power loss without corruption), a normal rowid table, a running
//! byte total (so eviction needs no SUM scan), and LRU eviction under one global byte cap. Reads
//! serialize through the same connection: tile reads are fast point lookups and the real cost on a
//! miss is the network fetch, so a read pool is deferred.

use bytes::Bytes;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// The cache schema version. A mismatch drops and recreates the `tiles` table (the cache is
/// disposable, so a column change rebuilds rather than reading stale rows). A bump wipes the
/// pinned box along with the rest of the cache; the pinned-box durability guarantee holds only
/// within a schema version, not across a bump. A warm can always be re-run.
const SCHEMA_VERSION: i64 = 3;

/// Rows deleted per chunk by the age sweep and the clear, so a large reclaim releases the single
/// connection lock between chunks rather than stalling all tile serving in one long DELETE. A plain
/// `DELETE ... LIMIT` is unavailable (the bundled SQLite is built without
/// SQLITE_ENABLE_UPDATE_DELETE_LIMIT), so the delete targets a bounded `rowid IN (SELECT ... LIMIT)`.
const DELETE_CHUNK: i64 = 4096;

/// A stored tile, or a negative-cache marker when `blob` is `None` (a 404 or 204 from upstream). The
/// blob is a ref-counted `Bytes`, so serving a cache hit clones a handle, not the bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedTile {
    pub content_type: String,
    pub strong_etag: String,
    pub upstream_validator: Option<String>,
    pub status: i64,
    pub fetched_at: i64,
    pub last_access: i64,
    pub bytes: i64,
    pub blob: Option<Bytes>,
}

impl CachedTile {
    /// A zero-byte negative-cache row for a miss `status` (404 or 204), stamped at `now`. Shared by the
    /// raster, vector, and warm negative paths so the negative-row shape lives in one place.
    pub(crate) fn negative(status: i64, now: i64) -> CachedTile {
        CachedTile {
            content_type: String::new(),
            strong_etag: String::new(),
            upstream_validator: None,
            status,
            fetched_at: now,
            last_access: now,
            bytes: 0,
            blob: None,
        }
    }
}

/// The outcome of a put: stored, or degraded (the disk is full) so the caller serves the bytes
/// without caching them rather than erroring the tile.
#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Stored,
    Degraded,
}

/// Filesystem space kept outside the cache cap for SQLite WAL growth and other host writes.
pub const MIN_FREE_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

/// A cache row key: the source id plus the z, x, and y tile coordinates. Passed by value (Copy) to the
/// cache methods so the four fields travel together and cannot be transposed positionally.
#[derive(Clone, Copy)]
pub struct TileKey<'a> {
    pub source: &'a str,
    pub z: u32,
    pub x: u32,
    pub y: u32,
}

impl<'a> TileKey<'a> {
    pub fn new(source: &'a str, z: u32, x: u32, y: u32) -> Self {
        Self { source, z, x, y }
    }
}

/// A tile to store as part of a warm, carrying its key and its `CachedTile`.
pub struct WarmRow {
    pub source: String,
    pub z: u32,
    pub x: u32,
    pub y: u32,
    pub tile: CachedTile,
}

/// The outcome of a batched warm put: how many rows stored, the byte delta, and whether the cap was hit.
#[derive(Debug, PartialEq, Eq)]
pub struct PutManyOutcome {
    pub stored: usize,
    pub bytes_added: i64,
    pub capped: bool,
}

/// One source's aggregate cache statistics, produced in a single table scan.
pub struct SourceStats {
    pub source: String,
    pub average_bytes: Option<f64>,
    pub scroll_bytes: i64,
    pub scroll_rows: i64,
}

struct Inner {
    conn: Connection,
    total_bytes: i64,
    pinned_bytes: i64,
    /// Memoized `real_region_pinned_bytes` result, valid while `regions_dirty` is false. Invalidated on
    /// every path that changes real-region membership or a pinned tile's bytes (the pin paths,
    /// put_many_pinned, delete_region, and a live-proxy put that keeps a tile pinned).
    real_region_cache: i64,
    regions_dirty: bool,
}

/// The disk tile cache, opened at a path on the mounted cache volume.
pub struct TileCache {
    inner: Mutex<Inner>,
    db_path: PathBuf,
    disk_pressure_events: AtomicU64,
    operation_error_events: AtomicU64,
}

impl TileCache {
    /// Open (creating if absent) the cache DB, apply the microSD pragmas, and ensure the schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
        Self::ensure_schema(&conn)?;
        let total_bytes: i64 =
            conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tiles", [], |r| {
                r.get(0)
            })?;
        let pinned_bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE pinned = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(Self {
            inner: Mutex::new(Inner {
                conn,
                total_bytes,
                pinned_bytes,
                real_region_cache: 0,
                regions_dirty: true,
            }),
            db_path: path.to_path_buf(),
            disk_pressure_events: AtomicU64::new(0),
            operation_error_events: AtomicU64::new(0),
        })
    }

    /// A cheap database probe used by the HTTP and container healthchecks.
    pub fn probe(&self) -> rusqlite::Result<()> {
        let inner = self.lock();
        inner.conn.query_row("SELECT 1", [], |_row| Ok(()))
    }

    /// Available bytes on the filesystem containing the cache database.
    pub fn available_bytes(&self) -> std::io::Result<u64> {
        fs2::available_space(self.db_path.parent().unwrap_or(Path::new("/")))
    }

    fn has_disk_headroom(&self, additional_bytes: i64) -> bool {
        if additional_bytes <= 0 {
            return true;
        }
        self.available_bytes()
            .map(|available| {
                available >= MIN_FREE_HEADROOM_BYTES.saturating_add(additional_bytes as u64)
            })
            // If the platform cannot report free space, retain SQLite's existing DiskFull fallback.
            .unwrap_or(true)
    }

    pub fn disk_pressure_events(&self) -> u64 {
        self.disk_pressure_events.load(Ordering::Relaxed)
    }

    pub fn operation_error_events(&self) -> u64 {
        self.operation_error_events.load(Ordering::Relaxed)
    }

    pub(crate) fn record_operation_error(&self, event: &str, error: &dyn std::fmt::Display) {
        self.operation_error_events.fetch_add(1, Ordering::Relaxed);
        eprintln!("event={event} error={error}");
    }

    /// Take the connection lock, recovering the guard on a poisoned mutex so a single panic under the
    /// lock (none is reachable today) cannot wedge the cache for the rest of the process.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            conn.execute_batch("DROP TABLE IF EXISTS region_tiles;")?;
            conn.execute_batch("DROP TABLE IF EXISTS tiles;")?;
            conn.execute_batch(
                "CREATE TABLE tiles (
                    source TEXT NOT NULL,
                    z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
                    content_type TEXT NOT NULL,
                    strong_etag TEXT NOT NULL,
                    upstream_validator TEXT,
                    status INTEGER NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    last_access INTEGER NOT NULL,
                    bytes INTEGER NOT NULL,
                    blob BLOB,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (source, z, x, y)
                );",
            )?;
            conn.execute_batch(
                "CREATE TABLE region_tiles (
                    region_id TEXT NOT NULL,
                    source    TEXT NOT NULL,
                    z         INTEGER NOT NULL,
                    x         INTEGER NOT NULL,
                    y         INTEGER NOT NULL,
                    PRIMARY KEY (region_id, source, z, x, y)
                );",
            )?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        // Speeds the age sweep and the LRU window without a schema-version wipe: created on every open
        // so an existing cache gains it. Partial on pinned = 0 because only scroll rows are swept or
        // LRU-evicted, which also bounds the index write cost on pinned writes.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tiles_scroll_lru ON tiles(last_access) WHERE pinned = 0;",
        )?;
        // Speeds the (source, z, x, y) probes that real_region_pinned_bytes and delete_region run per
        // pinned tile: the region_tiles primary key leads with region_id, so a lookup that filters only
        // source, z, x, and y cannot use that key and falls back to a full scan of region_tiles per tile.
        // Created on every open so an existing cache gains it, with no schema-version wipe.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_region_tiles_key ON region_tiles(source, z, x, y);",
        )?;
        Ok(())
    }

    /// Look up a cached tile by key. Does not update last_access (the caller throttles touches).
    pub fn get(&self, key: TileKey) -> rusqlite::Result<Option<CachedTile>> {
        let TileKey { source, z, x, y } = key;
        let inner = self.lock();
        let result = inner
            .conn
            .query_row(
                "SELECT content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob
                 FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| {
                    let blob: Option<Vec<u8>> = r.get(7)?;
                    Ok(CachedTile {
                        content_type: r.get(0)?,
                        strong_etag: r.get(1)?,
                        upstream_validator: r.get(2)?,
                        status: r.get(3)?,
                        fetched_at: r.get(4)?,
                        last_access: r.get(5)?,
                        bytes: r.get(6)?,
                        blob: blob.map(Bytes::from),
                    })
                },
            )
            .optional();
        if let Err(ref error) = result {
            self.record_operation_error("cache_read_failed", error);
        }
        result
    }

    /// Insert or replace a tile, keeping the running byte total in sync. Returns `Degraded` on a
    /// full disk so the caller serves the bytes without storing them. Pass `pinned = true` to mark
    /// the row eviction-exempt (used by the warm engine; the live proxy always passes `false`).
    pub fn put(
        &self,
        key: TileKey,
        tile: &CachedTile,
        pinned: bool,
        now: i64,
    ) -> rusqlite::Result<PutOutcome> {
        let TileKey { source, z, x, y } = key;
        let mut inner = self.lock();
        let prev: Option<(i64, i64)> = inner
            .conn
            .query_row(
                "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (old_bytes, was_pinned) = match prev {
            Some((b, p)) => (b, p == 1),
            None => (0, false),
        };
        if !self.has_disk_headroom(tile.bytes - old_bytes) {
            self.disk_pressure_events.fetch_add(1, Ordering::Relaxed);
            return Ok(PutOutcome::Degraded);
        }
        // A live-proxy refresh passes pinned = false, but pinning is cleared only by delete_region, so a
        // row that is already pinned must stay pinned. Without this, a 304 or 200 revalidation of a
        // region-pinned or basemap-asset tile after fresh_secs would flip pinned 1 to 0 and silently drop
        // its offline guarantee. pinned_bytes tracks the pinned rows, so add the byte delta when the row
        // stays pinned and the full bytes when it newly enters the pinned set.
        let effective_pinned = pinned || was_pinned;
        let result = inner.conn.execute(
            "INSERT OR REPLACE INTO tiles
             (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                source, z, x, y, tile.content_type, tile.strong_etag, tile.upstream_validator,
                tile.status, tile.fetched_at, now, tile.bytes, tile.blob.as_deref(), effective_pinned as i64
            ],
        );
        match result {
            Ok(_) => {
                inner.total_bytes += tile.bytes - old_bytes;
                if effective_pinned {
                    inner.pinned_bytes += tile.bytes - if was_pinned { old_bytes } else { 0 };
                    // A pinned tile's bytes changed, so a real-region sum that includes it is now stale.
                    inner.regions_dirty = true;
                }
                Ok(PutOutcome::Stored)
            }
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::DiskFull =>
            {
                self.disk_pressure_events.fetch_add(1, Ordering::Relaxed);
                Ok(PutOutcome::Degraded)
            }
            Err(e) => Err(e),
        }
    }

    /// Bump a tile's last_access so the LRU keeps the hot tiles. The caller throttles this so a pan
    /// does not turn every read into a write (microSD wear).
    pub fn touch(&self, key: TileKey, now: i64) -> rusqlite::Result<()> {
        let TileKey { source, z, x, y } = key;
        let inner = self.lock();
        inner.conn.execute(
            "UPDATE tiles SET last_access = ?5 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y, now],
        )?;
        Ok(())
    }

    /// Delete least-recently-used UNPINNED rows on the caller's open transaction until the total of
    /// all rows is at or below `target`, in one windowed DELETE (the oldest rows whose running total
    /// crosses the deficit) rather than a round-trip per row. Returns the bytes freed. Never deletes a
    /// pinned row. Does not touch `pinned_bytes` (it only removes `pinned = 0` rows). The caller updates
    /// `total_bytes` by the returned amount. `current_total` is the SUM(bytes) the caller has already
    /// established for the open transaction, so the freed bytes are exact without a second pre-scan.
    fn evict_unpinned_within(
        tx: &rusqlite::Transaction,
        current_total: i64,
        target: i64,
    ) -> rusqlite::Result<i64> {
        if current_total <= target {
            return Ok(0);
        }
        let to_free = current_total - target;
        // Delete the oldest unpinned rows whose running prior is under the deficit, and sum the bytes of
        // exactly those deleted rows through RETURNING. One window pass over the unpinned rows yields both
        // the deletion and the freed total, so no second full-table SUM (which also passes over every
        // pinned row) is needed; the caller decrements its authoritative `total_bytes` by this exact freed.
        let mut stmt = tx.prepare(
            "DELETE FROM tiles WHERE rowid IN (
                SELECT rowid FROM (
                    SELECT rowid, SUM(bytes) OVER (ORDER BY last_access ASC, rowid ASC) - bytes AS prior
                    FROM tiles WHERE pinned = 0
                ) WHERE prior < ?1
            ) RETURNING bytes",
        )?;
        let mut freed = 0i64;
        let mut rows = stmt.query(params![to_free])?;
        while let Some(row) = rows.next()? {
            freed += row.get::<_, i64>(0)?;
        }
        Ok(freed)
    }

    /// Evict the least-recently-accessed UNPINNED rows until the total is at or below `cap_bytes`. Runs
    /// the shared `evict_unpinned_within` helper on its own transaction so the eviction logic lives in
    /// one place (the warm path runs the same helper on its already-open transaction).
    pub fn evict_to(&self, cap_bytes: i64) -> rusqlite::Result<()> {
        let mut inner = self.lock();
        let current = inner.total_bytes;
        if current <= cap_bytes {
            return Ok(());
        }
        let freed = {
            let tx = inner.conn.unchecked_transaction()?;
            let freed = Self::evict_unpinned_within(&tx, current, cap_bytes)?;
            tx.commit()?;
            freed
        };
        inner.total_bytes = current - freed;
        if inner.total_bytes > cap_bytes {
            eprintln!(
                "tilecache: cap exceeded ({} bytes > {} limit); all remaining tiles are pinned",
                inner.total_bytes, cap_bytes
            );
        }
        Ok(())
    }

    /// Delete unpinned scroll rows selected by `subquery` (a `SELECT rowid ...` that must filter
    /// `pinned = 0` and `LIMIT DELETE_CHUNK`), in bounded chunks that release the lock between chunks.
    /// The SUM and the DELETE share the identical subquery under the held lock, so they target the same
    /// rowset. Decrements `total_bytes` by the freed bytes; leaves `pinned_bytes` untouched (only
    /// `pinned = 0` rows are removed, and an unpinned row carries no `region_tiles` join row, so none is
    /// orphaned). Returns the freed bytes and the freed row count.
    fn delete_unpinned_chunks(
        &self,
        subquery: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> rusqlite::Result<(i64, i64)> {
        let sum_sql =
            format!("SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE rowid IN ({subquery})");
        let delete_sql = format!("DELETE FROM tiles WHERE rowid IN ({subquery})");
        let mut freed_bytes = 0i64;
        let mut freed_rows = 0i64;
        loop {
            let mut inner = self.lock();
            let chunk_bytes: i64 = inner.conn.query_row(&sum_sql, params, |r| r.get(0))?;
            let n = inner.conn.execute(&delete_sql, params)? as i64;
            inner.total_bytes -= chunk_bytes;
            drop(inner);
            freed_bytes += chunk_bytes;
            freed_rows += n;
            if n < DELETE_CHUNK {
                break;
            }
        }
        Ok((freed_bytes, freed_rows))
    }

    /// Delete unpinned scroll rows whose `last_access` is older than `now - ttl_secs`, in bounded
    /// chunks that release the lock between chunks. A no-op when `ttl_secs <= 0`. Never deletes a
    /// pinned row. Decrements `total_bytes` by the freed bytes; leaves `pinned_bytes` unchanged.
    /// Returns the freed bytes and the freed row count. Relies on the invariant that an unpinned row
    /// (`pinned = 0`) carries no `region_tiles` join row, so deleting it leaves no orphan join row:
    /// the pin paths set `pinned = 1` and the join row together, and `delete_region` clears both.
    pub fn sweep_aged_unpinned(&self, ttl_secs: i64, now: i64) -> rusqlite::Result<(i64, i64)> {
        if ttl_secs <= 0 {
            return Ok((0, 0));
        }
        let cutoff = now - ttl_secs;
        // The ORDER BY makes the LIMIT deterministic (oldest first).
        self.delete_unpinned_chunks(
            "SELECT rowid FROM tiles WHERE pinned = 0 AND last_access < ?1 ORDER BY last_access ASC LIMIT ?2",
            &[&cutoff as &dyn rusqlite::ToSql, &DELETE_CHUNK],
        )
    }

    /// Delete every unpinned scroll row, in bounded chunks that release the lock between chunks. Never
    /// deletes a pinned row, so `total_bytes` settles at `pinned_bytes`. Leaves `pinned_bytes`
    /// unchanged. Returns the freed bytes and the freed row count. Like the age sweep, this relies on
    /// the invariant that an unpinned row carries no `region_tiles` join row, so it leaves none orphaned.
    pub fn clear_unpinned(&self) -> rusqlite::Result<(i64, i64)> {
        self.delete_unpinned_chunks(
            "SELECT rowid FROM tiles WHERE pinned = 0 LIMIT ?1",
            &[&DELETE_CHUNK as &dyn rusqlite::ToSql],
        )
    }

    /// Store a batch of warm tiles pinned, in one transaction, with an explicit pre-store budget check.
    /// A warm never evicts a PINNED tile; it evicts unpinned scroll tiles to fit within the cap. When
    /// the next sized row would push the pinned set past `budget`, it stops and reports `capped`.
    /// `budget` is the EFFECTIVE pinned budget the caller passes for this warm (R for the position-warm
    /// pseudo-region, R - P for a real region, each cap-clamped). `cap` is the live cache byte cap.
    /// Negative-cache rows (zero bytes) always store. The gate is on the PINNED byte total, never the
    /// cache total: an unpinned scroll tile filling the cache does not trip a region warm; instead the
    /// make-room pass drops unpinned LRU rows down to the cap after the inserts. A row's pin
    /// contribution is the net delta (new bytes minus old bytes) when the row was ALREADY pinned, and
    /// the full new bytes when it was previously unpinned or absent (the tile newly enters the pinned
    /// set), so a shared tile is counted once. When `region_id` is `Some`, each stored tile is also
    /// recorded in `region_tiles` for reference counting.
    ///
    /// INSERT precedes EVICT, never the reverse: the inserts flip any pre-existing unpinned scroll row
    /// that is being re-pinned to `pinned = 1` first, so it is eviction-exempt before the make-room
    /// pass runs. Evicting first could delete the very row about to be re-pinned, turning a replace into
    /// a fresh insert and under-counting `total_bytes` by the old bytes. Because the gate bounds the
    /// pinned set at the cap-clamped `budget <= cap`, evicting unpinned down to the cap always leaves
    /// room for the pinned set, so the gate is the only `capped` path.
    pub fn put_many_pinned(
        &self,
        rows: &[WarmRow],
        budget: i64,
        cap: i64,
        region_id: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<PutManyOutcome> {
        let requested_growth: i64 = rows.iter().map(|row| row.tile.bytes.max(0)).sum();
        if !self.has_disk_headroom(requested_growth) {
            self.disk_pressure_events.fetch_add(1, Ordering::Relaxed);
            return Ok(PutManyOutcome {
                stored: 0,
                bytes_added: 0,
                capped: true,
            });
        }
        let mut inner = self.lock();
        let base = inner.total_bytes;
        let pinned_base = inner.pinned_bytes;
        let mut added = 0i64;
        let mut pinned_added = 0i64;
        let mut stored = 0usize;
        let mut capped = false;
        let mut freed = 0i64;
        {
            let tx = inner.conn.unchecked_transaction()?;
            for r in rows {
                let prev: Option<(i64, i64)> = tx.query_row(
                    "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                    params![r.source, r.z, r.x, r.y], |row| Ok((row.get(0)?, row.get(1)?)),
                ).optional()?;
                let old_bytes = prev.map(|(b, _)| b).unwrap_or(0);
                let was_pinned = prev.map(|(_, p)| p == 1).unwrap_or(false);
                let delta = r.tile.bytes - old_bytes;
                // The pin contribution is the net delta when the row was already pinned, else the full
                // new bytes (the tile newly enters the pinned set).
                let pin_delta = if was_pinned {
                    r.tile.bytes - old_bytes
                } else {
                    r.tile.bytes
                };
                // Only a net-positive pin contribution can cross the budget; the gate is on pinned bytes.
                if pin_delta > 0 && pinned_base + pinned_added + pin_delta > budget {
                    capped = true;
                    break;
                }
                tx.execute(
                    "INSERT OR REPLACE INTO tiles
                     (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob, pinned)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)",
                    params![
                        r.source, r.z, r.x, r.y, r.tile.content_type, r.tile.strong_etag, r.tile.upstream_validator,
                        r.tile.status, r.tile.fetched_at, now, r.tile.bytes, r.tile.blob.as_deref()
                    ],
                )?;
                if let Some(rid) = region_id {
                    tx.execute(
                        "INSERT OR IGNORE INTO region_tiles (region_id, source, z, x, y) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![rid, r.source, r.z, r.x, r.y],
                    )?;
                }
                added += delta;
                pinned_added += pin_delta;
                stored += 1;
            }
            // Make room: the inserts above flipped any re-pinned scroll row to pinned, so it is now
            // eviction-exempt. Drop unpinned LRU rows down to the cap in one pass. Never deletes pinned
            // rows, so the just-pinned batch and every other region's tiles survive.
            let new_total = base + added;
            if new_total > cap {
                freed = Self::evict_unpinned_within(&tx, new_total, cap)?;
            }
            tx.commit()?;
        }
        inner.total_bytes = base + added - freed;
        inner.pinned_bytes = pinned_base + pinned_added;
        // The batch pinned rows and recorded region_tiles rows, so the real-region memo is stale.
        inner.regions_dirty = true;
        Ok(PutManyOutcome {
            stored,
            bytes_added: added,
            capped,
        })
    }

    /// Set the pinned bit (and record the `region_tiles` join row when `region_id` is Some) under the
    /// caller's already-held lock, then add the bytes to `pinned_bytes` only when the row newly entered
    /// the pinned set. Shared by `pin`, `pin_if_fresh`, and `pin_for_region` so the pin transaction and
    /// its accounting live in one place.
    fn pin_locked(
        inner: &mut Inner,
        key: TileKey,
        region_id: Option<&str>,
        was_pinned: bool,
        tile_bytes: i64,
    ) -> rusqlite::Result<()> {
        let TileKey { source, z, x, y } = key;
        {
            let tx = inner.conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE tiles SET pinned = 1 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
            )?;
            if let Some(rid) = region_id {
                tx.execute(
                    "INSERT OR IGNORE INTO region_tiles (region_id, source, z, x, y) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![rid, source, z, x, y],
                )?;
            }
            tx.commit()?;
        }
        if !was_pinned {
            inner.pinned_bytes += tile_bytes;
        }
        // A pin changes region_tiles membership (or re-pins), so the real-region memo is now stale.
        inner.regions_dirty = true;
        Ok(())
    }

    /// Mark an already-cached row pinned (eviction-exempt) without re-fetching or changing its
    /// bytes, keeping `pinned_bytes` in sync (the bytes are added only when the row was previously
    /// unpinned). Test-only: the warm path uses `pin_if_fresh` so the budget gate and the join-table
    /// insert run under the same lock. A no-op when the row is absent.
    #[cfg(test)]
    pub fn pin(&self, key: TileKey) -> rusqlite::Result<()> {
        let TileKey { source, z, x, y } = key;
        let mut inner = self.lock();
        let prev: Option<(i64, i64)> = inner.conn.query_row(
            "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((tile_bytes, pinned)) = prev else {
            return Ok(());
        };
        Self::pin_locked(&mut inner, key, None, pinned == 1, tile_bytes)
    }

    /// Check freshness and pin under the same lock, eliminating the get-then-pin race where a
    /// concurrent evict_to could delete the row between the two separate calls. Returns `true`
    /// when a fresh or negative-TTL row was found and pinned; `false` when absent, stale, or when
    /// the tile is not yet pinned and pinning it would push the pinned set past `budget`. `budget`
    /// is the effective pinned budget for this warm (R for the pseudo-region, R - P for a real
    /// region). `pinned_bytes` grows only when the tile newly enters the pinned set, so an
    /// already-pinned shared tile is never double-counted; when `region_id` is `Some`, the join row
    /// is recorded regardless so the tile is reference-counted for this region too.
    pub fn pin_if_fresh(
        &self,
        key: TileKey,
        now: i64,
        fresh_secs: i64,
        negative_ttl_secs: i64,
        budget: i64,
        region_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let TileKey { source, z, x, y } = key;
        let mut inner = self.lock();
        let row: Option<(i64, i64)> = inner
            .conn
            .query_row(
                "SELECT status, fetched_at FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((status, fetched_at)) = row else {
            return Ok(false);
        };
        let fresh = status == 200 && now - fetched_at < fresh_secs;
        let neg = status != 200 && now - fetched_at < negative_ttl_secs;
        if !fresh && !neg {
            return Ok(false);
        }
        let (tile_bytes, was_pinned): (i64, bool) = inner.conn.query_row(
            "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? == 1)),
        ).optional()?.unwrap_or((0, false));
        // Only a tile that newly enters the pinned set AND carries positive bytes can cross the budget;
        // a free (zero-byte) negative-cache row is never refused on budget.
        if !was_pinned && tile_bytes > 0 && inner.pinned_bytes + tile_bytes > budget {
            return Ok(false);
        }
        Self::pin_locked(&mut inner, key, region_id, was_pinned, tile_bytes)?;
        Ok(true)
    }

    /// Pin an already-cached tile for a region, gating on the effective pinned `budget`. Returns
    /// `false` when the tile is unpinned and pinning it would push the pinned set past `budget`;
    /// otherwise pins it (adding the bytes to `pinned_bytes` only when it newly enters the pinned
    /// set), records the join row when `region_id` is `Some`, and returns `true`. A no-op returning
    /// `false` when the row is absent.
    pub fn pin_for_region(
        &self,
        key: TileKey,
        budget: i64,
        region_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let TileKey { source, z, x, y } = key;
        let mut inner = self.lock();
        let prev: Option<(i64, i64)> = inner.conn.query_row(
            "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((tile_bytes, pinned)) = prev else {
            return Ok(false);
        };
        let was_pinned = pinned == 1;
        // Only a tile that newly enters the pinned set AND carries positive bytes can cross the budget;
        // a free (zero-byte) row is never refused on budget.
        if !was_pinned && tile_bytes > 0 && inner.pinned_bytes + tile_bytes > budget {
            return Ok(false);
        }
        Self::pin_locked(&mut inner, key, region_id, was_pinned, tile_bytes)?;
        Ok(true)
    }

    /// Drop a region's join rows; for each tile whose reference count reaches zero, clear its pin and
    /// subtract its bytes from `pinned_bytes` (it demotes to the scroll cache). `total_bytes` is
    /// unchanged: the tile is not deleted, only made eviction-eligible. Re-running this at warm start
    /// clears a region's prior pins before a re-download or a position-warm re-pin, so a narrower tile
    /// set leaves no orphan join rows.
    pub fn delete_region(&self, region_id: &str) -> rusqlite::Result<()> {
        let mut inner = self.lock();
        let mut freed = 0i64;
        {
            let tx = inner.conn.unchecked_transaction()?;
            let tiles: Vec<(String, u32, u32, u32)> = {
                let mut stmt =
                    tx.prepare("SELECT source, z, x, y FROM region_tiles WHERE region_id = ?1")?;
                let rows = stmt.query_map(params![region_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, u32>(1)?,
                        r.get::<_, u32>(2)?,
                        r.get::<_, u32>(3)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            tx.execute(
                "DELETE FROM region_tiles WHERE region_id = ?1",
                params![region_id],
            )?;
            for (source, z, x, y) in tiles {
                let refs: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM region_tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                    params![source, z, x, y], |r| r.get(0),
                )?;
                if refs == 0 {
                    let bytes: Option<i64> = tx.query_row(
                        "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4 AND pinned = 1",
                        params![source, z, x, y], |r| r.get(0),
                    ).optional()?;
                    if let Some(b) = bytes {
                        tx.execute(
                            "UPDATE tiles SET pinned = 0 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                            params![source, z, x, y],
                        )?;
                        freed += b;
                    }
                }
            }
            tx.commit()?;
        }
        inner.pinned_bytes -= freed;
        // Region membership changed, so the real-region memo is stale.
        inner.regions_dirty = true;
        Ok(())
    }

    /// The total stored bytes pinned by a region, summing only that region's join rows.
    pub fn region_bytes(&self, region_id: &str) -> rusqlite::Result<i64> {
        let inner = self.lock();
        inner.conn.query_row(
            "SELECT COALESCE(SUM(t.bytes), 0) FROM region_tiles rt JOIN tiles t
             ON rt.source = t.source AND rt.z = t.z AND rt.x = t.x AND rt.y = t.y WHERE rt.region_id = ?1",
            params![region_id], |r| r.get(0),
        )
    }

    /// Byte totals for every persisted region in one grouped query. This backs the plugin's regions list
    /// and startup reconciliation without one HTTP request and one SQLite query per saved region.
    pub fn all_region_bytes(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT rt.region_id, COALESCE(SUM(t.bytes), 0)
             FROM region_tiles rt JOIN tiles t
             ON rt.source = t.source AND rt.z = t.z AND rt.x = t.x AND rt.y = t.y
             GROUP BY rt.region_id",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// The total stored bytes pinned by at least one NON-position-warm region, counting a shared tile
    /// once. A tile pinned ONLY by the position-warm pseudo-region is excluded, and a tile shared
    /// between a real region and position-warm still counts once toward the real-region usage. This is
    /// the exact real-region pinned total, so the server-side regions budget gate stays exact rather
    /// than over-subtracting a shared tile.
    pub fn real_region_pinned_bytes(&self, position_warm_region_id: &str) -> rusqlite::Result<i64> {
        let mut inner = self.lock();
        // Memoized: this per-tile EXISTS scan can take seconds on a large cache, and `/cache/stats` is
        // polled. Recompute only when a pin, unpin, put, or delete_region has marked the regions dirty.
        if !inner.regions_dirty {
            return Ok(inner.real_region_cache);
        }
        let value: i64 = inner.conn.query_row(
            "SELECT COALESCE(SUM(t.bytes), 0) FROM tiles t \
             WHERE t.pinned = 1 AND EXISTS ( \
               SELECT 1 FROM region_tiles rt \
               WHERE rt.source = t.source AND rt.z = t.z AND rt.x = t.x AND rt.y = t.y \
                 AND rt.region_id != ?1)",
            params![position_warm_region_id],
            |r| r.get(0),
        )?;
        inner.real_region_cache = value;
        inner.regions_dirty = false;
        Ok(value)
    }

    /// The mean stored byte size per source over real (status 200, blob present) tiles, excluding
    /// negative-cache rows (which would understate the average and let a warm exceed the cap).
    /// Computed on demand; `/cache/stats` is called rarely.
    pub fn per_source_avg(&self) -> rusqlite::Result<Vec<(String, f64)>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT source, AVG(bytes) FROM tiles WHERE status = 200 AND blob IS NOT NULL GROUP BY source ORDER BY source",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        rows.collect()
    }

    /// The total stored bytes and the row count per source over UNPINNED scroll rows only, so the
    /// cache-management breakdown reports what the scroll cache holds by source. Computed on demand;
    /// `/cache/stats` is called rarely.
    pub fn per_source_totals(&self) -> rusqlite::Result<Vec<(String, i64, i64)>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT source, COALESCE(SUM(bytes), 0), COUNT(*) FROM tiles WHERE pinned = 0 GROUP BY source ORDER BY source",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect()
    }

    /// Average real-tile size plus unpinned totals in one table scan for `/cache/stats`.
    pub fn per_source_stats(&self) -> rusqlite::Result<Vec<SourceStats>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT source,
                    AVG(CASE WHEN status = 200 AND blob IS NOT NULL THEN bytes END),
                    COALESCE(SUM(CASE WHEN pinned = 0 THEN bytes ELSE 0 END), 0),
                    SUM(CASE WHEN pinned = 0 THEN 1 ELSE 0 END)
             FROM tiles GROUP BY source ORDER BY source",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SourceStats {
                source: r.get(0)?,
                average_bytes: r.get(1)?,
                scroll_bytes: r.get(2)?,
                scroll_rows: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Row count, total bytes, and pinned bytes. The totals are O(1) (maintained on every mutating
    /// call); the count is a `COUNT(*)`, O(n) in SQLite, but `/cache/stats` is called rarely.
    pub fn stats(&self) -> rusqlite::Result<(i64, i64, i64)> {
        let inner = self.lock();
        let rows: i64 = inner
            .conn
            .query_row("SELECT COUNT(*) FROM tiles", [], |r| r.get(0))?;
        Ok((rows, inner.total_bytes, inner.pinned_bytes))
    }
}

/// One-time rename of the legacy `binnacle-tilecache` cache dir to the current dir, so an upgrade keeps
/// its warmed cache instead of starting cold. No-op when no legacy dir exists, when the legacy name is
/// already the current name, or when the current dir already exists. Must run before the cache dir is
/// created: once the current dir exists this skips, leaving a populated legacy dir orphaned. Both dirs
/// share the same parent (the data mount), so the rename is same-filesystem and atomic.
pub fn migrate_legacy_cache_dir(cache_dir: &Path) {
    const LEGACY_NAME: &str = "binnacle-tilecache";
    let Some(parent) = cache_dir.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_NAME);
    if legacy == cache_dir || !legacy.is_dir() {
        return;
    }
    if cache_dir.exists() {
        // The current dir is already present, so the legacy one cannot be moved in. Leave it untouched
        // and warn, so a populated legacy cache stays recoverable rather than silently ignored.
        eprintln!(
            "tilecache: legacy cache dir {} left in place; the current dir {} already exists",
            legacy.display(),
            cache_dir.display()
        );
        return;
    }
    match std::fs::rename(&legacy, cache_dir) {
        Ok(()) => eprintln!(
            "tilecache: migrated legacy cache dir {} -> {}",
            legacy.display(),
            cache_dir.display()
        ),
        Err(e) => eprintln!(
            "tilecache: could not migrate legacy cache dir {} -> {}: {e}; starting cold",
            legacy.display(),
            cache_dir.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn tile(bytes: i64, status: i64, blob: Option<Vec<u8>>) -> CachedTile {
        CachedTile {
            content_type: "image/png".into(),
            strong_etag: "etag".into(),
            upstream_validator: None,
            status,
            fetched_at: 0,
            last_access: 0,
            bytes,
            blob: blob.map(Bytes::from),
        }
    }

    fn open() -> (NamedTempFile, TileCache) {
        let f = NamedTempFile::new().unwrap();
        let c = TileCache::open(f.path()).unwrap();
        (f, c)
    }

    #[test]
    fn migrate_renames_the_legacy_dir_when_the_current_dir_is_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("binnacle-tilecache");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("cache.sqlite"), b"x").unwrap();
        let current = tmp.path().join("chart-locker-tilecache");
        migrate_legacy_cache_dir(&current);
        assert!(
            current.join("cache.sqlite").exists(),
            "the cache moved to the current dir"
        );
        assert!(!legacy.exists(), "the legacy dir was renamed away");
    }

    #[test]
    fn migrate_leaves_the_legacy_dir_when_the_current_dir_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("binnacle-tilecache");
        std::fs::create_dir(&legacy).unwrap();
        let current = tmp.path().join("chart-locker-tilecache");
        std::fs::create_dir(&current).unwrap();
        migrate_legacy_cache_dir(&current);
        assert!(legacy.exists(), "the legacy dir is left untouched");
        assert!(current.exists(), "the current dir is left untouched");
    }

    #[test]
    fn migrate_is_a_noop_with_no_legacy_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("chart-locker-tilecache");
        migrate_legacy_cache_dir(&current);
        assert!(
            !current.exists(),
            "nothing is created when there is no legacy dir"
        );
    }

    #[test]
    fn put_then_get_round_trips_bytes_and_metadata() {
        let (_f, c) = open();
        assert_eq!(
            c.put(
                TileKey::new("s", 1, 0, 0),
                &tile(3, 200, Some(vec![1, 2, 3])),
                false,
                10
            )
            .unwrap(),
            PutOutcome::Stored
        );
        let got = c.get(TileKey::new("s", 1, 0, 0)).unwrap().unwrap();
        assert_eq!(got.blob, Some(Bytes::from(vec![1, 2, 3])));
        assert_eq!(got.content_type, "image/png");
        assert_eq!(got.status, 200);
        assert_eq!(got.last_access, 10);
        assert!(c.get(TileKey::new("s", 1, 0, 1)).unwrap().is_none());
    }

    #[test]
    fn replace_keeps_the_byte_total_in_sync() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(5, 200, Some(vec![0; 5])),
            false,
            1,
        )
        .unwrap();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(2, 200, Some(vec![0; 2])),
            false,
            2,
        )
        .unwrap();
        assert_eq!(c.stats().unwrap(), (1, 2, 0));
    }

    #[test]
    fn evict_to_removes_the_least_recently_accessed_first() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            1,
        )
        .unwrap(); // older
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            2,
        )
        .unwrap();
        c.evict_to(10).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_none(),
            "the older tile is evicted"
        );
        assert!(c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_some());
        assert_eq!(c.stats().unwrap().1, 10);
    }

    #[test]
    fn negative_cache_row_round_trips() {
        let (_f, c) = open();
        c.put(TileKey::new("s", 0, 0, 0), &tile(0, 404, None), false, 1)
            .unwrap();
        let got = c.get(TileKey::new("s", 0, 0, 0)).unwrap().unwrap();
        assert_eq!(got.status, 404);
        assert_eq!(got.blob, None);
    }

    #[test]
    fn touch_protects_a_hot_tile_from_eviction() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            1,
        )
        .unwrap();
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            2,
        )
        .unwrap();
        c.touch(TileKey::new("s", 0, 0, 0), 9).unwrap(); // the older tile is now the most recently accessed
        c.evict_to(10).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the touched tile survives"
        );
        assert!(c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_none());
    }

    #[test]
    fn a_pinned_tile_survives_eviction_that_drops_unpinned_tiles() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            true,
            1,
        )
        .unwrap(); // pinned box tile
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            2,
        )
        .unwrap(); // unpinned; gets evicted because the pinned tile is exempt despite having older access
        c.evict_to(10).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the pinned tile is never evicted"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_none(),
            "the unpinned tile is evicted to make room"
        );
    }

    #[test]
    fn a_live_revalidation_put_does_not_unpin_a_pinned_tile() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            1,
        )
        .unwrap();
        c.pin(TileKey::new("s", 0, 0, 0)).unwrap(); // pinned by a region warm
        assert_eq!(c.stats().unwrap().2, 10, "pinned_bytes counts the pin");
        // A 304 or 200 revalidation of the same tile after fresh_secs re-puts it with pinned = false.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            90_000,
        )
        .unwrap();
        c.evict_to(0).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "a pinned tile keeps its pin across a live revalidation and is never evicted"
        );
        assert_eq!(
            c.stats().unwrap().2,
            10,
            "pinned_bytes stays exact across the revalidation put"
        );
    }

    #[test]
    fn put_many_pinned_caps_when_the_r_ceiling_is_reached_even_with_disk_room() {
        let (_f, c) = open();
        // R = 10, cap is large (disk room to spare). Two 8-byte tiles: the first fits the R ceiling,
        // the second trips it, so the warm caps on R, not on disk.
        let rows = vec![
            WarmRow {
                source: "s".into(),
                z: 0,
                x: 0,
                y: 0,
                tile: tile(8, 200, Some(vec![0; 8])),
            },
            WarmRow {
                source: "s".into(),
                z: 0,
                x: 0,
                y: 1,
                tile: tile(8, 200, Some(vec![0; 8])),
            },
        ];
        let outcome = c
            .put_many_pinned(&rows, 10, 2_000_000_000, None, 5)
            .unwrap();
        assert_eq!(
            outcome.stored, 1,
            "only the first tile fits under the R = 10 ceiling"
        );
        assert!(
            outcome.capped,
            "the batch caps on the R ceiling, not on disk"
        );
        assert_eq!(
            c.stats().unwrap(),
            (1, 8, 8),
            "one tile stored, 8 bytes, 8 pinned"
        );
    }

    #[test]
    fn pin_if_fresh_pins_atomically_and_returns_false_when_stale_or_absent() {
        let (_f, c) = open();
        let now = 1000i64;
        let fresh_secs = 86_400i64;
        let neg_ttl = 600i64;

        // Absent row: returns false.
        assert!(!c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 0),
                now,
                fresh_secs,
                neg_ttl,
                2_000_000_000,
                None
            )
            .unwrap());

        // Fresh 200 row: returns true and pins it.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            now,
        )
        .unwrap();
        assert!(c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 0),
                now,
                fresh_secs,
                neg_ttl,
                2_000_000_000,
                None
            )
            .unwrap());
        c.evict_to(0).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "pinned row survives eviction"
        );

        // Stale row: fetched_at far enough in the past that now - fetched_at >= fresh_secs.
        let stale = CachedTile {
            fetched_at: now - fresh_secs - 1,
            ..tile(10, 200, Some(vec![0; 10]))
        };
        c.put(TileKey::new("s", 0, 0, 1), &stale, false, now)
            .unwrap();
        assert!(!c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 1),
                now,
                fresh_secs,
                neg_ttl,
                2_000_000_000,
                None
            )
            .unwrap());

        // Fresh negative (404) row within negative_ttl: returns true and pins it.
        // fetched_at must be `now` so now - fetched_at = 0 < neg_ttl.
        let neg_row = CachedTile {
            fetched_at: now,
            ..tile(0, 404, None)
        };
        c.put(TileKey::new("s", 0, 0, 2), &neg_row, false, now)
            .unwrap();
        assert!(c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 2),
                now,
                fresh_secs,
                neg_ttl,
                2_000_000_000,
                None
            )
            .unwrap());
        c.evict_to(0).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 2)).unwrap().is_some(),
            "pinned negative row survives eviction"
        );
    }

    #[test]
    fn per_source_avg_excludes_negative_cache_rows() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            1,
        )
        .unwrap();
        c.put(TileKey::new("s", 0, 0, 1), &tile(0, 404, None), false, 2)
            .unwrap(); // negative cache, excluded
        let avg = c.per_source_avg().unwrap();
        assert_eq!(avg, vec![("s".to_string(), 100.0)]);
    }

    #[test]
    fn pin_marks_an_existing_unpinned_row_eviction_exempt() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            1,
        )
        .unwrap(); // unpinned, e.g. cached by the live proxy
        c.pin(TileKey::new("s", 0, 0, 0)).unwrap();
        c.evict_to(0).unwrap(); // would drop every unpinned row
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "a pinned row survives eviction"
        );
        assert_eq!(c.stats().unwrap().1, 10, "pin changes no bytes");
    }

    #[test]
    fn join_table_reference_counting_keeps_shared_tile_on_partial_delete() {
        let (_f, c) = open();
        let now = 1000i64;
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(10, 200, Some(vec![0; 10])),
        }];
        // Two regions share the same tile.
        c.put_many_pinned(&rows, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        c.put_many_pinned(&rows, 2_000_000_000, 2_000_000_000, Some("r2"), now)
            .unwrap();
        // Deleting r1 must not unpin the tile because r2 still references it.
        c.delete_region("r1").unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "tile survives: r2 still holds a reference"
        );
        // Deleting r2 drops the last reference; the tile demotes to unpinned and is evictable.
        c.delete_region("r2").unwrap();
        c.evict_to(0).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_none(),
            "tile evicted after all references are removed"
        );
    }

    #[test]
    fn region_warm_gates_on_pinned_bytes_not_total_bytes() {
        let (_f, c) = open();
        let now = 1000i64;
        // Fill the scroll cache to 900 bytes (unpinned); total_bytes = 900.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(900, 200, Some(vec![0; 900])),
            false,
            now,
        )
        .unwrap();
        // R = 200; even though total_bytes >> R, pinned_bytes = 0 so a 150-byte region warm fits.
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 1,
            y: 0,
            tile: tile(150, 200, Some(vec![0; 150])),
        }];
        let out = c
            .put_many_pinned(&rows, 200, 2_000_000_000, Some("r1"), now)
            .unwrap();
        assert!(
            !out.capped,
            "region warm fits within R even when total_bytes >> R"
        );
        assert_eq!(out.stored, 1);
    }

    #[test]
    fn scroll_uses_the_whole_cap_not_cap_minus_r() {
        let (_f, c) = open();
        let now = 1000i64;
        // Pin 100 bytes as a region.
        let pinned = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        c.put_many_pinned(&pinned, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        // Add 350 unpinned scroll bytes; total = 450, which fits the full 500 cap but NOT the old
        // cap - R = 400 reserve.
        c.put(
            TileKey::new("s", 1, 0, 0),
            &tile(350, 200, Some(vec![0; 350])),
            false,
            now,
        )
        .unwrap();
        // Soft reserve: the scroll cache is bounded at the FULL cap, so evict_to(cap) keeps all 350
        // scroll bytes. Under the dead hard reserve this call site passed cap - R = 400 and would have
        // trimmed the scroll cache.
        c.evict_to(500).unwrap();
        let (_rows, total, pinned_b) = c.stats().unwrap();
        assert_eq!(pinned_b, 100, "pinned bytes unchanged");
        assert_eq!(
            total, 450,
            "scroll uses the whole cap minus pinned, not the old cap - R reserve"
        );
    }

    #[test]
    fn put_many_pinned_repins_a_preexisting_unpinned_lru_candidate_without_evicting_it() {
        let (_f, c) = open();
        let now = 1000i64;
        // Tile A: an unpinned scroll tile, the oldest (LRU make-room candidate), 100 bytes.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            now,
        )
        .unwrap();
        // Tile B: a newer unpinned scroll tile, 100 bytes. total = 200.
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            now + 10,
        )
        .unwrap();
        // A region warm re-pins A (same key, same bytes) under cap = 150. base + added = 200 > cap, so
        // make-room evicts unpinned LRU down to the cap. Insert precedes evict: A is flipped to pinned
        // first, so it is eviction-exempt and the only evictable unpinned row left is B.
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        let out = c
            .put_many_pinned(&rows, 2_000_000_000, 150, Some("r1"), now + 20)
            .unwrap();
        assert!(!out.capped);
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "A was re-pinned, not evicted (insert precedes evict)"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_none(),
            "B, the only remaining unpinned LRU, is evicted to make room"
        );
        let (_rows, total, pinned_b) = c.stats().unwrap();
        assert_eq!(
            pinned_b, 100,
            "A newly enters the pinned set: pinned_bytes = 100"
        );
        assert_eq!(
            total, 100,
            "total = base(200) + added(0) - freed(100): A survives, B evicted"
        );
    }

    #[test]
    fn region_warm_into_a_full_scroll_cache_evicts_unpinned_and_succeeds() {
        let (_f, c) = open();
        let now = 1000i64;
        let cap = 500i64;
        // Fill the scroll cache to the cap with one unpinned tile.
        c.put(
            TileKey::new("s", 9, 0, 0),
            &tile(500, 200, Some(vec![0; 500])),
            false,
            now,
        )
        .unwrap();
        assert_eq!(c.stats().unwrap().1, 500, "scroll cache is full");
        // A 200-byte region warm. budget is large; cap = 500. It must evict unpinned LRU to fit rather
        // than cap.
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(200, 200, Some(vec![0; 200])),
        }];
        let out = c
            .put_many_pinned(&rows, 2_000_000_000, cap, Some("r1"), now + 1)
            .unwrap();
        assert!(
            !out.capped,
            "the warm no longer caps: it evicts unpinned to make room"
        );
        assert_eq!(out.stored, 1);
        let (_rows, total, pinned_b) = c.stats().unwrap();
        assert!(
            total <= cap,
            "total stays within the cap after make-room: {total} <= {cap}"
        );
        assert_eq!(pinned_b, 200, "the region tile is pinned");
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the pinned region tile is present"
        );
        assert!(
            c.get(TileKey::new("s", 9, 0, 0)).unwrap().is_none(),
            "the unpinned scroll tile is evicted"
        );
    }

    #[test]
    fn a_region_warm_never_evicts_another_regions_pinned_tile() {
        let (_f, c) = open();
        let now = 1000i64;
        let cap = 500i64;
        // r1 pins a 200-byte tile.
        let r1 = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(200, 200, Some(vec![0; 200])),
        }];
        c.put_many_pinned(&r1, 2_000_000_000, cap, Some("r1"), now)
            .unwrap();
        // Fill the scroll cache near the cap (unpinned). total = 480.
        c.put(
            TileKey::new("s", 9, 0, 0),
            &tile(280, 200, Some(vec![0; 280])),
            false,
            now + 1,
        )
        .unwrap();
        // r2 warms a 200-byte tile under cap = 500. Make-room evicts the unpinned scroll tile, never
        // r1's pinned tile, even though r1's tile is the least recently accessed.
        let r2 = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 1,
            y: 0,
            tile: tile(200, 200, Some(vec![0; 200])),
        }];
        let out = c
            .put_many_pinned(&r2, 2_000_000_000, cap, Some("r2"), now + 2)
            .unwrap();
        assert!(!out.capped);
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "r1's pinned tile survives the r2 warm"
        );
        assert!(
            c.get(TileKey::new("s", 9, 0, 0)).unwrap().is_none(),
            "the unpinned scroll tile is evicted instead"
        );
        let (_rows, total, pinned_b) = c.stats().unwrap();
        assert!(total <= cap, "total within the cap: {total} <= {cap}");
        assert_eq!(pinned_b, 400, "both region tiles stay pinned (200 + 200)");
    }

    #[test]
    fn pin_if_fresh_and_pin_for_region_do_not_evict() {
        let (_f, c) = open();
        let now = 1000i64;
        // Two unpinned scroll tiles; total = 200.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            now,
        )
        .unwrap();
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            now,
        )
        .unwrap();
        // pin_if_fresh pins the first; it adds no bytes and must NOT evict the second.
        assert!(c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 0),
                now,
                86_400,
                600,
                2_000_000_000,
                Some("r1")
            )
            .unwrap());
        assert_eq!(
            c.stats().unwrap().1,
            200,
            "pin_if_fresh changes no total bytes"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_some(),
            "pin_if_fresh did not evict the other scroll tile"
        );
        // pin_for_region pins the second; same: no bytes added, no eviction.
        assert!(c
            .pin_for_region(TileKey::new("s", 0, 0, 1), 2_000_000_000, Some("r1"))
            .unwrap());
        assert_eq!(
            c.stats().unwrap().1,
            200,
            "pin_for_region changes no total bytes"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "pin_for_region did not evict the other tile"
        );
        assert_eq!(c.stats().unwrap().2, 200, "both tiles are now pinned");
    }

    #[test]
    fn pin_for_region_refuses_when_budget_would_be_exceeded() {
        let (_f, c) = open();
        let now = 1000i64;
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(500, 200, Some(vec![0; 500])),
            false,
            now,
        )
        .unwrap();
        // R = 100; pinning a 500-byte tile would exceed R.
        let pinned = c
            .pin_for_region(TileKey::new("s", 0, 0, 0), 100, Some("r1"))
            .unwrap();
        assert!(
            !pinned,
            "pin_for_region must refuse when pinned_bytes + tile_bytes > R"
        );
        c.evict_to(0).unwrap();
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_none(),
            "the tile was not pinned and is evictable"
        );
    }

    #[test]
    fn repinning_an_existing_unpinned_tile_adds_the_full_bytes_to_pinned_bytes() {
        let (_f, c) = open();
        let now = 1000i64;
        // A live-proxy scroll tile already exists UNPINNED at 100 bytes; pinned_bytes = 0.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            now,
        )
        .unwrap();
        let (_r0, _t0, pinned0) = c.stats().unwrap();
        assert_eq!(
            pinned0, 0,
            "an unpinned scroll tile contributes nothing to pinned_bytes"
        );
        // A region warm pins that same key (equal bytes). pinned_bytes must grow by the FULL 100,
        // not by the net delta (0), because the tile newly ENTERS the pinned set.
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        let out = c
            .put_many_pinned(&rows, 100, 2_000_000_000, Some("r1"), now)
            .unwrap();
        assert!(!out.capped, "the re-pin fits exactly within R = 100");
        let (_r1, _t1, pinned1) = c.stats().unwrap();
        assert_eq!(
            pinned1, 100,
            "re-pinning an existing unpinned tile adds the full bytes to pinned_bytes"
        );
        // The R gate counts it: a second distinct pinned tile would now exceed R = 100.
        let more = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 1,
            y: 0,
            tile: tile(50, 200, Some(vec![0; 50])),
        }];
        let out2 = c
            .put_many_pinned(&more, 100, 2_000_000_000, Some("r1"), now)
            .unwrap();
        assert!(
            out2.capped,
            "with 100 already pinned, another 50 must trip R = 100"
        );
    }

    #[test]
    fn pin_if_fresh_does_not_double_count_an_already_pinned_tile() {
        let (_f, c) = open();
        let now = 1000i64;
        // r1 pins the tile (100 bytes); pinned_bytes = 100.
        let rows = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        c.put_many_pinned(&rows, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        // r2's warm skips-but-pins the same already-pinned tile via pin_if_fresh; pinned_bytes must NOT grow.
        assert!(c
            .pin_if_fresh(
                TileKey::new("s", 0, 0, 0),
                now,
                86_400,
                600,
                2_000_000_000,
                Some("r2")
            )
            .unwrap());
        let (_r, _t, pinned) = c.stats().unwrap();
        assert_eq!(
            pinned, 100,
            "pinning an already-pinned shared tile does not double-count pinned_bytes"
        );
    }

    #[test]
    fn region_bytes_sums_only_the_regions_tiles() {
        let (_f, c) = open();
        let now = 1000i64;
        let r1 = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        let r2 = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 1,
            y: 0,
            tile: tile(40, 200, Some(vec![0; 40])),
        }];
        c.put_many_pinned(&r1, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        c.put_many_pinned(&r2, 2_000_000_000, 2_000_000_000, Some("r2"), now)
            .unwrap();
        assert_eq!(c.region_bytes("r1").unwrap(), 100);
        assert_eq!(c.region_bytes("r2").unwrap(), 40);
        assert_eq!(c.region_bytes("absent").unwrap(), 0);
    }

    #[test]
    fn schema_version_3_wipe_clears_both_tables() {
        let f = NamedTempFile::new().unwrap();
        {
            let c = TileCache::open(f.path()).unwrap();
            let rows = vec![WarmRow {
                source: "s".into(),
                z: 0,
                x: 0,
                y: 0,
                tile: tile(10, 200, Some(vec![0; 10])),
            }];
            c.put_many_pinned(&rows, 2_000_000_000, 2_000_000_000, Some("r1"), 1)
                .unwrap();
        }
        // Force a version mismatch so the next open wipes both tables.
        {
            let conn = rusqlite::Connection::open(f.path()).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1)
                .unwrap();
        }
        let c2 = TileCache::open(f.path()).unwrap();
        let (rows, total, pinned) = c2.stats().unwrap();
        assert_eq!(rows, 0, "wipe clears all tiles");
        assert_eq!(total, 0);
        assert_eq!(pinned, 0);
    }

    #[test]
    fn real_region_pinned_bytes_excludes_position_warm_only_and_counts_shared_once() {
        let (_f, c) = open();
        let now = 1000i64;
        let pw = crate::state::POSITION_WARM_REGION_ID;
        // Tile A is pinned ONLY by the position-warm pseudo-region: it must not count.
        let a = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        c.put_many_pinned(&a, 2_000_000_000, 2_000_000_000, Some(pw), now)
            .unwrap();
        // Tile B is shared between a real region r1 and the position-warm pseudo-region: it counts once.
        let b = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 1,
            y: 0,
            tile: tile(40, 200, Some(vec![0; 40])),
        }];
        c.put_many_pinned(&b, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        c.put_many_pinned(&b, 2_000_000_000, 2_000_000_000, Some(pw), now)
            .unwrap();
        assert_eq!(
            c.real_region_pinned_bytes(pw).unwrap(),
            40,
            "only the shared tile counts toward real-region usage, and exactly once",
        );
    }

    #[test]
    fn real_region_pinned_bytes_memo_invalidates_on_pin_delete_and_repin_put() {
        let (_f, c) = open();
        let now = 1000i64;
        let pw = crate::state::POSITION_WARM_REGION_ID;
        let row = |x: u32, bytes: i64| WarmRow {
            source: "s".into(),
            z: 0,
            x,
            y: 0,
            tile: tile(bytes, 200, Some(vec![0; bytes as usize])),
        };
        // Pin a real-region tile, read the memoized value, then pin another: the memo must reflect it.
        c.put_many_pinned(
            &[row(0, 100)],
            2_000_000_000,
            2_000_000_000,
            Some("r1"),
            now,
        )
        .unwrap();
        assert_eq!(c.real_region_pinned_bytes(pw).unwrap(), 100, "first read");
        c.put_many_pinned(&[row(1, 40)], 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        assert_eq!(
            c.real_region_pinned_bytes(pw).unwrap(),
            140,
            "a new pin invalidates the memo"
        );
        // A live-proxy revalidation put keeps the tile pinned and changes its bytes: the memo must update.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            now + 1,
        )
        .unwrap();
        assert_eq!(
            c.real_region_pinned_bytes(pw).unwrap(),
            50,
            "a re-pin put that changes bytes invalidates the memo"
        );
        // Deleting the region drops both tiles from the real-region sum.
        c.delete_region("r1").unwrap();
        assert_eq!(
            c.real_region_pinned_bytes(pw).unwrap(),
            0,
            "delete_region invalidates the memo"
        );
    }

    #[test]
    fn pin_if_fresh_pins_a_zero_byte_row_even_when_pinned_bytes_exceeds_budget() {
        let (_f, c) = open();
        let now = 1000i64;
        // Pin a real 100-byte tile so pinned_bytes = 100.
        let real = vec![WarmRow {
            source: "s".into(),
            z: 0,
            x: 0,
            y: 0,
            tile: tile(100, 200, Some(vec![0; 100])),
        }];
        c.put_many_pinned(&real, 2_000_000_000, 2_000_000_000, Some("r1"), now)
            .unwrap();
        assert_eq!(c.stats().unwrap().2, 100, "pinned_bytes starts at 100");
        // A fresh negative-cache (zero-byte) row.
        let neg = CachedTile {
            fetched_at: now,
            ..tile(0, 404, None)
        };
        c.put(TileKey::new("s", 0, 1, 0), &neg, false, now).unwrap();
        // Even with a budget BELOW the current pinned_bytes, a free row is never refused on budget.
        assert!(
            c.pin_if_fresh(TileKey::new("s", 0, 1, 0), now, 86_400, 600, 50, Some("r1"))
                .unwrap(),
            "a free zero-byte row is pinned even when pinned_bytes already exceeds the budget",
        );
        assert_eq!(
            c.stats().unwrap().2,
            100,
            "a zero-byte row adds nothing to pinned_bytes"
        );
    }

    #[test]
    fn open_creates_the_scroll_lru_partial_index() {
        let (_f, c) = open();
        let inner = c.lock();
        let count: i64 = inner
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_tiles_scroll_lru'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "the partial scroll-LRU index exists after open");
    }

    #[test]
    fn sweep_aged_unpinned_deletes_old_scroll_rows_keeps_fresh_and_pinned() {
        let (_f, c) = open();
        // Pinned region tile at an old access time: must survive regardless of age. Pin through pin()
        // so pinned_bytes is tracked (raw put with pinned = true sets the column but not the counter).
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            0,
        )
        .unwrap();
        c.pin(TileKey::new("s", 0, 0, 0)).unwrap();
        // Old unpinned scroll tile (last_access = 100): swept.
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(20, 200, Some(vec![0; 20])),
            false,
            100,
        )
        .unwrap();
        // Fresh unpinned scroll tile (last_access = 10_000): kept.
        c.put(
            TileKey::new("s", 0, 0, 2),
            &tile(30, 200, Some(vec![0; 30])),
            false,
            10_000,
        )
        .unwrap();
        // now = 10_000, ttl = 1000, cutoff = 9000. Only the last_access=100 row is older than cutoff.
        let (freed_bytes, freed_rows) = c.sweep_aged_unpinned(1000, 10_000).unwrap();
        assert_eq!(
            (freed_bytes, freed_rows),
            (20, 1),
            "exactly the one old scroll tile is freed"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the pinned tile survives"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_none(),
            "the old scroll tile is swept"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 2)).unwrap().is_some(),
            "the fresh scroll tile survives"
        );
        let (_rows, total, pinned) = c.stats().unwrap();
        assert_eq!(
            total, 40,
            "total decremented by the freed 20: 10 pinned + 30 fresh"
        );
        assert_eq!(pinned, 10, "pinned_bytes unchanged");
    }

    #[test]
    fn sweep_aged_unpinned_is_a_no_op_when_ttl_is_zero() {
        let (_f, c) = open();
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(20, 200, Some(vec![0; 20])),
            false,
            1,
        )
        .unwrap();
        let (freed_bytes, freed_rows) = c.sweep_aged_unpinned(0, 10_000).unwrap();
        assert_eq!(
            (freed_bytes, freed_rows),
            (0, 0),
            "ttl 0 disables the sweep"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 1)).unwrap().is_some(),
            "the row survives a disabled sweep"
        );
    }

    #[test]
    fn clear_unpinned_deletes_all_scroll_rows_and_keeps_pinned() {
        let (_f, c) = open();
        // Store as a scroll tile, then pin it so it enters the pinned set and pinned_bytes tracks it.
        c.put(
            TileKey::new("s", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            0,
        )
        .unwrap();
        c.pin(TileKey::new("s", 0, 0, 0)).unwrap(); // pinned
        c.put(
            TileKey::new("s", 0, 0, 1),
            &tile(20, 200, Some(vec![0; 20])),
            false,
            5,
        )
        .unwrap(); // scroll
        c.put(
            TileKey::new("s", 0, 0, 2),
            &tile(30, 200, Some(vec![0; 30])),
            false,
            9_999,
        )
        .unwrap(); // fresh scroll
        let (freed_bytes, freed_rows) = c.clear_unpinned().unwrap();
        assert_eq!(
            (freed_bytes, freed_rows),
            (50, 2),
            "both scroll tiles freed regardless of age"
        );
        assert!(
            c.get(TileKey::new("s", 0, 0, 0)).unwrap().is_some(),
            "the pinned tile survives the clear"
        );
        let (_rows, total, pinned) = c.stats().unwrap();
        assert_eq!(total, 10, "total equals pinned after the clear");
        assert_eq!(pinned, 10, "pinned_bytes unchanged");
    }

    #[test]
    fn per_source_totals_sums_scroll_rows_per_source() {
        let (_f, c) = open();
        c.put(
            TileKey::new("a", 0, 0, 0),
            &tile(100, 200, Some(vec![0; 100])),
            false,
            1,
        )
        .unwrap();
        c.put(
            TileKey::new("a", 0, 0, 1),
            &tile(40, 200, Some(vec![0; 40])),
            false,
            1,
        )
        .unwrap();
        c.put(
            TileKey::new("b", 0, 0, 0),
            &tile(10, 200, Some(vec![0; 10])),
            false,
            1,
        )
        .unwrap();
        // A pinned row is excluded from the scroll totals.
        c.put(
            TileKey::new("a", 0, 0, 2),
            &tile(1000, 200, Some(vec![0; 1000])),
            true,
            1,
        )
        .unwrap();
        let totals = c.per_source_totals().unwrap();
        assert_eq!(
            totals,
            vec![("a".to_string(), 140, 2), ("b".to_string(), 10, 1)]
        );
    }
}
