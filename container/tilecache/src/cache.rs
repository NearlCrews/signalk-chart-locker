//! The microSD-aware tile cache: one bundled-SQLite DB, a single serialized connection, WAL,
//! synchronous=NORMAL (survives boat power loss without corruption), a normal rowid table, a running
//! byte total (so eviction needs no SUM scan), and LRU eviction under one global byte cap. Reads
//! serialize through the same connection: tile reads are fast point lookups and the real cost on a
//! miss is the network fetch, so a read pool is deferred.

use bytes::Bytes;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// The cache schema version. A mismatch drops and recreates the `tiles` table (the cache is
/// disposable, so a column change rebuilds rather than reading stale rows). A bump wipes the
/// pinned box along with the rest of the cache; the pinned-box durability guarantee holds only
/// within a schema version, not across a bump. A warm can always be re-run.
const SCHEMA_VERSION: i64 = 3;

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

/// The outcome of a put: stored, or degraded (the disk is full) so the caller serves the bytes
/// without caching them rather than erroring the tile.
#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Stored,
    Degraded,
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

struct Inner {
    conn: Connection,
    total_bytes: i64,
    pinned_bytes: i64,
}

/// The disk tile cache, opened at a path on the mounted cache volume.
pub struct TileCache {
    inner: Mutex<Inner>,
}

impl TileCache {
    /// Open (creating if absent) the cache DB, apply the microSD pragmas, and ensure the schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
        )?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
        Self::ensure_schema(&conn)?;
        let total_bytes: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tiles", [], |r| r.get(0))?;
        let pinned_bytes: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE pinned = 1", [], |r| r.get(0))?;
        Ok(Self { inner: Mutex::new(Inner { conn, total_bytes, pinned_bytes }) })
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
        Ok(())
    }

    /// Look up a cached tile by key. Does not update last_access (the caller throttles touches).
    pub fn get(&self, source: &str, z: u32, x: u32, y: u32) -> rusqlite::Result<Option<CachedTile>> {
        let inner = self.lock();
        inner
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
            .optional()
    }

    /// Insert or replace a tile, keeping the running byte total in sync. Returns `Degraded` on a
    /// full disk so the caller serves the bytes without storing them. Pass `pinned = true` to mark
    /// the row eviction-exempt (used by the warm engine; the live proxy always passes `false`).
    #[allow(clippy::too_many_arguments)]
    pub fn put(&self, source: &str, z: u32, x: u32, y: u32, tile: &CachedTile, pinned: bool, now: i64) -> rusqlite::Result<PutOutcome> {
        let mut inner = self.lock();
        let old_bytes: Option<i64> = inner.conn.query_row(
            "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| r.get(0),
        ).optional()?;
        let result = inner.conn.execute(
            "INSERT OR REPLACE INTO tiles
             (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                source, z, x, y, tile.content_type, tile.strong_etag, tile.upstream_validator,
                tile.status, tile.fetched_at, now, tile.bytes, tile.blob.as_deref(), pinned as i64
            ],
        );
        match result {
            Ok(_) => { inner.total_bytes += tile.bytes - old_bytes.unwrap_or(0); Ok(PutOutcome::Stored) }
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DiskFull => Ok(PutOutcome::Degraded),
            Err(e) => Err(e),
        }
    }

    /// Bump a tile's last_access so the LRU keeps the hot tiles. The caller throttles this so a pan
    /// does not turn every read into a write (microSD wear).
    pub fn touch(&self, source: &str, z: u32, x: u32, y: u32, now: i64) -> rusqlite::Result<()> {
        let inner = self.lock();
        inner.conn.execute(
            "UPDATE tiles SET last_access = ?5 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y, now],
        )?;
        Ok(())
    }

    /// Evict the least-recently-accessed rows until the total is at or below `cap_bytes`, in one
    /// windowed DELETE (the oldest rows whose running total crosses the deficit) rather than a
    /// round-trip per row, so a large eviction does not hold the connection lock for N statements.
    pub fn evict_to(&self, cap_bytes: i64) -> rusqlite::Result<()> {
        let mut inner = self.lock();
        if inner.total_bytes <= cap_bytes {
            return Ok(());
        }
        let to_free = inner.total_bytes - cap_bytes;
        inner.conn.execute(
            "DELETE FROM tiles WHERE rowid IN (
                SELECT rowid FROM (
                    SELECT rowid, SUM(bytes) OVER (ORDER BY last_access ASC, rowid ASC) - bytes AS prior
                    FROM tiles WHERE pinned = 0
                ) WHERE prior < ?1
            )",
            params![to_free],
        )?;
        inner.total_bytes = inner.conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tiles", [], |r| r.get(0))?;
        if inner.total_bytes > cap_bytes {
            eprintln!("tilecache: cap exceeded ({} bytes > {} limit); all remaining tiles are pinned", inner.total_bytes, cap_bytes);
        }
        Ok(())
    }

    /// Store a batch of warm tiles pinned, in one transaction, with an explicit pre-store budget check.
    /// A warm NEVER evicts: when the next sized row would push the pinned set past `budget`, it stops
    /// and reports `capped`. `budget` is the EFFECTIVE pinned budget the caller passes for this warm
    /// (R for the position-warm pseudo-region, R - P for a real region). Negative-cache rows (zero
    /// bytes) always store. The gate is on the PINNED byte total, never the cache total: an unpinned
    /// scroll tile filling the cache does not trip a region warm. A row's pin contribution is the net
    /// delta (new bytes minus old bytes) when the row was ALREADY pinned, and the full new bytes when
    /// it was previously unpinned or absent (the tile newly enters the pinned set), so a shared tile
    /// is counted once. When `region_id` is `Some`, each stored tile is also recorded in
    /// `region_tiles` for reference counting.
    pub fn put_many_pinned(&self, rows: &[WarmRow], budget: i64, region_id: Option<&str>, now: i64) -> rusqlite::Result<PutManyOutcome> {
        let mut inner = self.lock();
        let base = inner.total_bytes;
        let pinned_base = inner.pinned_bytes;
        let mut added = 0i64;
        let mut pinned_added = 0i64;
        let mut stored = 0usize;
        let mut capped = false;
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
                let pin_delta = if was_pinned { r.tile.bytes - old_bytes } else { r.tile.bytes };
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
            tx.commit()?;
        }
        inner.total_bytes = base + added;
        inner.pinned_bytes = pinned_base + pinned_added;
        Ok(PutManyOutcome { stored, bytes_added: added, capped })
    }

    /// Mark an already-cached row pinned (eviction-exempt) without re-fetching or changing its
    /// bytes, keeping `pinned_bytes` in sync (the bytes are added only when the row was previously
    /// unpinned). Test-only: the warm path uses `pin_if_fresh` so the budget gate and the join-table
    /// insert run under the same lock. A no-op when the row is absent.
    pub fn pin(&self, source: &str, z: u32, x: u32, y: u32) -> rusqlite::Result<()> {
        let mut inner = self.lock();
        let prev: Option<(i64, i64)> = inner.conn.query_row(
            "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((tile_bytes, pinned)) = prev else { return Ok(()) };
        {
            let tx = inner.conn.unchecked_transaction()?;
            tx.execute(
                "UPDATE tiles SET pinned = 1 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
            )?;
            tx.commit()?;
        }
        if pinned != 1 {
            inner.pinned_bytes += tile_bytes;
        }
        Ok(())
    }

    /// Check freshness and pin under the same lock, eliminating the get-then-pin race where a
    /// concurrent evict_to could delete the row between the two separate calls. Returns `true`
    /// when a fresh or negative-TTL row was found and pinned; `false` when absent, stale, or when
    /// the tile is not yet pinned and pinning it would push the pinned set past `budget`. `budget`
    /// is the effective pinned budget for this warm (R for the pseudo-region, R - P for a real
    /// region). `pinned_bytes` grows only when the tile newly enters the pinned set, so an
    /// already-pinned shared tile is never double-counted; when `region_id` is `Some`, the join row
    /// is recorded regardless so the tile is reference-counted for this region too.
    #[allow(clippy::too_many_arguments)]
    pub fn pin_if_fresh(
        &self,
        source: &str,
        z: u32,
        x: u32,
        y: u32,
        now: i64,
        fresh_secs: i64,
        negative_ttl_secs: i64,
        budget: i64,
        region_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let mut inner = self.lock();
        let row: Option<(i64, i64)> = inner
            .conn
            .query_row(
                "SELECT status, fetched_at FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((status, fetched_at)) = row else { return Ok(false) };
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
        Ok(true)
    }

    /// Pin an already-cached tile for a region, gating on the effective pinned `budget`. Returns
    /// `false` when the tile is unpinned and pinning it would push the pinned set past `budget`;
    /// otherwise pins it (adding the bytes to `pinned_bytes` only when it newly enters the pinned
    /// set), records the join row when `region_id` is `Some`, and returns `true`. A no-op returning
    /// `false` when the row is absent.
    pub fn pin_for_region(
        &self,
        source: &str,
        z: u32,
        x: u32,
        y: u32,
        budget: i64,
        region_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let mut inner = self.lock();
        let prev: Option<(i64, i64)> = inner.conn.query_row(
            "SELECT bytes, pinned FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let Some((tile_bytes, pinned)) = prev else { return Ok(false) };
        let was_pinned = pinned == 1;
        // Only a tile that newly enters the pinned set AND carries positive bytes can cross the budget;
        // a free (zero-byte) row is never refused on budget.
        if !was_pinned && tile_bytes > 0 && inner.pinned_bytes + tile_bytes > budget {
            return Ok(false);
        }
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
                let mut stmt = tx.prepare(
                    "SELECT source, z, x, y FROM region_tiles WHERE region_id = ?1",
                )?;
                let rows = stmt.query_map(params![region_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?, r.get::<_, u32>(3)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            tx.execute("DELETE FROM region_tiles WHERE region_id = ?1", params![region_id])?;
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

    /// The total stored bytes pinned by at least one NON-position-warm region, counting a shared tile
    /// once. A tile pinned ONLY by the position-warm pseudo-region is excluded, and a tile shared
    /// between a real region and position-warm still counts once toward the real-region usage. This is
    /// the exact real-region pinned total, so the server-side regions budget gate stays exact rather
    /// than over-subtracting a shared tile.
    pub fn real_region_pinned_bytes(&self, position_warm_region_id: &str) -> rusqlite::Result<i64> {
        let inner = self.lock();
        inner.conn.query_row(
            "SELECT COALESCE(SUM(t.bytes), 0) FROM tiles t \
             WHERE t.pinned = 1 AND EXISTS ( \
               SELECT 1 FROM region_tiles rt \
               WHERE rt.source = t.source AND rt.z = t.z AND rt.x = t.x AND rt.y = t.y \
                 AND rt.region_id != ?1)",
            params![position_warm_region_id], |r| r.get(0),
        )
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

    /// Row count, total bytes, and pinned bytes. The totals are O(1) (maintained on every mutating
    /// call); the count is a `COUNT(*)`, O(n) in SQLite, but `/cache/stats` is called rarely.
    pub fn stats(&self) -> rusqlite::Result<(i64, i64, i64)> {
        let inner = self.lock();
        let rows: i64 = inner.conn.query_row("SELECT COUNT(*) FROM tiles", [], |r| r.get(0))?;
        Ok((rows, inner.total_bytes, inner.pinned_bytes))
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
    fn put_then_get_round_trips_bytes_and_metadata() {
        let (_f, c) = open();
        assert_eq!(c.put("s", 1, 0, 0, &tile(3, 200, Some(vec![1, 2, 3])), false, 10).unwrap(), PutOutcome::Stored);
        let got = c.get("s", 1, 0, 0).unwrap().unwrap();
        assert_eq!(got.blob, Some(Bytes::from(vec![1, 2, 3])));
        assert_eq!(got.content_type, "image/png");
        assert_eq!(got.status, 200);
        assert_eq!(got.last_access, 10);
        assert!(c.get("s", 1, 0, 1).unwrap().is_none());
    }

    #[test]
    fn replace_keeps_the_byte_total_in_sync() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(5, 200, Some(vec![0; 5])), false, 1).unwrap();
        c.put("s", 0, 0, 0, &tile(2, 200, Some(vec![0; 2])), false, 2).unwrap();
        assert_eq!(c.stats().unwrap(), (1, 2, 0));
    }

    #[test]
    fn evict_to_removes_the_least_recently_accessed_first() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), false, 1).unwrap(); // older
        c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), false, 2).unwrap();
        c.evict_to(10).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "the older tile is evicted");
        assert!(c.get("s", 0, 0, 1).unwrap().is_some());
        assert_eq!(c.stats().unwrap().1, 10);
    }

    #[test]
    fn negative_cache_row_round_trips() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(0, 404, None), false, 1).unwrap();
        let got = c.get("s", 0, 0, 0).unwrap().unwrap();
        assert_eq!(got.status, 404);
        assert_eq!(got.blob, None);
    }

    #[test]
    fn touch_protects_a_hot_tile_from_eviction() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), false, 1).unwrap();
        c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), false, 2).unwrap();
        c.touch("s", 0, 0, 0, 9).unwrap(); // the older tile is now the most recently accessed
        c.evict_to(10).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the touched tile survives");
        assert!(c.get("s", 0, 0, 1).unwrap().is_none());
    }

    #[test]
    fn a_pinned_tile_survives_eviction_that_drops_unpinned_tiles() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), true, 1).unwrap(); // pinned box tile
        c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), false, 2).unwrap(); // unpinned; gets evicted because the pinned tile is exempt despite having older access
        c.evict_to(10).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the pinned tile is never evicted");
        assert!(c.get("s", 0, 0, 1).unwrap().is_none(), "the unpinned tile is evicted to make room");
    }

    #[test]
    fn put_many_pinned_stops_at_the_cap_and_never_evicts() {
        let (_f, c) = open();
        let rows = vec![
            WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(8, 200, Some(vec![0; 8])) },
            WarmRow { source: "s".into(), z: 0, x: 0, y: 1, tile: tile(8, 200, Some(vec![0; 8])) },
        ];
        let outcome = c.put_many_pinned(&rows, 10, None, 5).unwrap();
        assert_eq!(outcome.stored, 1, "only the first tile fits under the 10-byte cap");
        assert!(outcome.capped, "the batch reports capped rather than evicting");
        assert_eq!(c.stats().unwrap().1, 8, "no eviction happened");
    }

    #[test]
    fn pin_if_fresh_pins_atomically_and_returns_false_when_stale_or_absent() {
        let (_f, c) = open();
        let now = 1000i64;
        let fresh_secs = 86_400i64;
        let neg_ttl = 600i64;

        // Absent row: returns false.
        assert!(!c.pin_if_fresh("s", 0, 0, 0, now, fresh_secs, neg_ttl, 2_000_000_000, None).unwrap());

        // Fresh 200 row: returns true and pins it.
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), false, now).unwrap();
        assert!(c.pin_if_fresh("s", 0, 0, 0, now, fresh_secs, neg_ttl, 2_000_000_000, None).unwrap());
        c.evict_to(0).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "pinned row survives eviction");

        // Stale row: fetched_at far enough in the past that now - fetched_at >= fresh_secs.
        let stale = CachedTile { fetched_at: now - fresh_secs - 1, ..tile(10, 200, Some(vec![0; 10])) };
        c.put("s", 0, 0, 1, &stale, false, now).unwrap();
        assert!(!c.pin_if_fresh("s", 0, 0, 1, now, fresh_secs, neg_ttl, 2_000_000_000, None).unwrap());

        // Fresh negative (404) row within negative_ttl: returns true and pins it.
        // fetched_at must be `now` so now - fetched_at = 0 < neg_ttl.
        let neg_row = CachedTile { fetched_at: now, ..tile(0, 404, None) };
        c.put("s", 0, 0, 2, &neg_row, false, now).unwrap();
        assert!(c.pin_if_fresh("s", 0, 0, 2, now, fresh_secs, neg_ttl, 2_000_000_000, None).unwrap());
        c.evict_to(0).unwrap();
        assert!(c.get("s", 0, 0, 2).unwrap().is_some(), "pinned negative row survives eviction");
    }

    #[test]
    fn per_source_avg_excludes_negative_cache_rows() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(100, 200, Some(vec![0; 100])), false, 1).unwrap();
        c.put("s", 0, 0, 1, &tile(0, 404, None), false, 2).unwrap(); // negative cache, excluded
        let avg = c.per_source_avg().unwrap();
        assert_eq!(avg, vec![("s".to_string(), 100.0)]);
    }

    #[test]
    fn pin_marks_an_existing_unpinned_row_eviction_exempt() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), false, 1).unwrap(); // unpinned, e.g. cached by the live proxy
        c.pin("s", 0, 0, 0).unwrap();
        c.evict_to(0).unwrap(); // would drop every unpinned row
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "a pinned row survives eviction");
        assert_eq!(c.stats().unwrap().1, 10, "pin changes no bytes");
    }

    #[test]
    fn join_table_reference_counting_keeps_shared_tile_on_partial_delete() {
        let (_f, c) = open();
        let now = 1000i64;
        let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(10, 200, Some(vec![0; 10])) }];
        // Two regions share the same tile.
        c.put_many_pinned(&rows, 2_000_000_000, Some("r1"), now).unwrap();
        c.put_many_pinned(&rows, 2_000_000_000, Some("r2"), now).unwrap();
        // Deleting r1 must not unpin the tile because r2 still references it.
        c.delete_region("r1").unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "tile survives: r2 still holds a reference");
        // Deleting r2 drops the last reference; the tile demotes to unpinned and is evictable.
        c.delete_region("r2").unwrap();
        c.evict_to(0).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "tile evicted after all references are removed");
    }

    #[test]
    fn region_warm_gates_on_pinned_bytes_not_total_bytes() {
        let (_f, c) = open();
        let now = 1000i64;
        // Fill the scroll cache to 900 bytes (unpinned); total_bytes = 900.
        c.put("s", 0, 0, 0, &tile(900, 200, Some(vec![0; 900])), false, now).unwrap();
        // R = 200; even though total_bytes >> R, pinned_bytes = 0 so a 150-byte region warm fits.
        let rows = vec![WarmRow { source: "s".into(), z: 0, x: 1, y: 0, tile: tile(150, 200, Some(vec![0; 150])) }];
        let out = c.put_many_pinned(&rows, 200, Some("r1"), now).unwrap();
        assert!(!out.capped, "region warm fits within R even when total_bytes >> R");
        assert_eq!(out.stored, 1);
    }

    #[test]
    fn scroll_eviction_is_bounded_at_cap_minus_r() {
        let (_f, c) = open();
        let now = 1000i64;
        // Pin 100 bytes as a region.
        let pinned = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        c.put_many_pinned(&pinned, 2_000_000_000, Some("r1"), now).unwrap();
        // Add 300 bytes unpinned (scroll).
        c.put("s", 1, 0, 0, &tile(300, 200, Some(vec![0; 300])), false, now).unwrap();
        // cap - R = 500 - 100 = 400; evict_to(400) leaves all 300 scroll bytes and the 100 pinned.
        c.evict_to(400).unwrap();
        let (_rows, total, pinned_b) = c.stats().unwrap();
        assert_eq!(pinned_b, 100, "pinned bytes unchanged");
        assert_eq!(total, 400, "100 pinned plus 300 scroll, all within the scroll budget");
    }

    #[test]
    fn pin_for_region_refuses_when_budget_would_be_exceeded() {
        let (_f, c) = open();
        let now = 1000i64;
        c.put("s", 0, 0, 0, &tile(500, 200, Some(vec![0; 500])), false, now).unwrap();
        // R = 100; pinning a 500-byte tile would exceed R.
        let pinned = c.pin_for_region("s", 0, 0, 0, 100, Some("r1")).unwrap();
        assert!(!pinned, "pin_for_region must refuse when pinned_bytes + tile_bytes > R");
        c.evict_to(0).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "the tile was not pinned and is evictable");
    }

    #[test]
    fn repinning_an_existing_unpinned_tile_adds_the_full_bytes_to_pinned_bytes() {
        let (_f, c) = open();
        let now = 1000i64;
        // A live-proxy scroll tile already exists UNPINNED at 100 bytes; pinned_bytes = 0.
        c.put("s", 0, 0, 0, &tile(100, 200, Some(vec![0; 100])), false, now).unwrap();
        let (_r0, _t0, pinned0) = c.stats().unwrap();
        assert_eq!(pinned0, 0, "an unpinned scroll tile contributes nothing to pinned_bytes");
        // A region warm pins that same key (equal bytes). pinned_bytes must grow by the FULL 100,
        // not by the net delta (0), because the tile newly ENTERS the pinned set.
        let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        let out = c.put_many_pinned(&rows, 100, Some("r1"), now).unwrap();
        assert!(!out.capped, "the re-pin fits exactly within R = 100");
        let (_r1, _t1, pinned1) = c.stats().unwrap();
        assert_eq!(pinned1, 100, "re-pinning an existing unpinned tile adds the full bytes to pinned_bytes");
        // The R gate counts it: a second distinct pinned tile would now exceed R = 100.
        let more = vec![WarmRow { source: "s".into(), z: 0, x: 1, y: 0, tile: tile(50, 200, Some(vec![0; 50])) }];
        let out2 = c.put_many_pinned(&more, 100, Some("r1"), now).unwrap();
        assert!(out2.capped, "with 100 already pinned, another 50 must trip R = 100");
    }

    #[test]
    fn pin_if_fresh_does_not_double_count_an_already_pinned_tile() {
        let (_f, c) = open();
        let now = 1000i64;
        // r1 pins the tile (100 bytes); pinned_bytes = 100.
        let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        c.put_many_pinned(&rows, 2_000_000_000, Some("r1"), now).unwrap();
        // r2's warm skips-but-pins the same already-pinned tile via pin_if_fresh; pinned_bytes must NOT grow.
        assert!(c.pin_if_fresh("s", 0, 0, 0, now, 86_400, 600, 2_000_000_000, Some("r2")).unwrap());
        let (_r, _t, pinned) = c.stats().unwrap();
        assert_eq!(pinned, 100, "pinning an already-pinned shared tile does not double-count pinned_bytes");
    }

    #[test]
    fn region_bytes_sums_only_the_regions_tiles() {
        let (_f, c) = open();
        let now = 1000i64;
        let r1 = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        let r2 = vec![WarmRow { source: "s".into(), z: 0, x: 1, y: 0, tile: tile(40, 200, Some(vec![0; 40])) }];
        c.put_many_pinned(&r1, 2_000_000_000, Some("r1"), now).unwrap();
        c.put_many_pinned(&r2, 2_000_000_000, Some("r2"), now).unwrap();
        assert_eq!(c.region_bytes("r1").unwrap(), 100);
        assert_eq!(c.region_bytes("r2").unwrap(), 40);
        assert_eq!(c.region_bytes("absent").unwrap(), 0);
    }

    #[test]
    fn schema_version_3_wipe_clears_both_tables() {
        let f = NamedTempFile::new().unwrap();
        {
            let c = TileCache::open(f.path()).unwrap();
            let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(10, 200, Some(vec![0; 10])) }];
            c.put_many_pinned(&rows, 2_000_000_000, Some("r1"), 1).unwrap();
        }
        // Force a version mismatch so the next open wipes both tables.
        {
            let conn = rusqlite::Connection::open(f.path()).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1).unwrap();
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
        let a = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        c.put_many_pinned(&a, 2_000_000_000, Some(pw), now).unwrap();
        // Tile B is shared between a real region r1 and the position-warm pseudo-region: it counts once.
        let b = vec![WarmRow { source: "s".into(), z: 0, x: 1, y: 0, tile: tile(40, 200, Some(vec![0; 40])) }];
        c.put_many_pinned(&b, 2_000_000_000, Some("r1"), now).unwrap();
        c.put_many_pinned(&b, 2_000_000_000, Some(pw), now).unwrap();
        assert_eq!(
            c.real_region_pinned_bytes(pw).unwrap(),
            40,
            "only the shared tile counts toward real-region usage, and exactly once",
        );
    }

    #[test]
    fn pin_if_fresh_pins_a_zero_byte_row_even_when_pinned_bytes_exceeds_budget() {
        let (_f, c) = open();
        let now = 1000i64;
        // Pin a real 100-byte tile so pinned_bytes = 100.
        let real = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
        c.put_many_pinned(&real, 2_000_000_000, Some("r1"), now).unwrap();
        assert_eq!(c.stats().unwrap().2, 100, "pinned_bytes starts at 100");
        // A fresh negative-cache (zero-byte) row.
        let neg = CachedTile { fetched_at: now, ..tile(0, 404, None) };
        c.put("s", 0, 1, 0, &neg, false, now).unwrap();
        // Even with a budget BELOW the current pinned_bytes, a free row is never refused on budget.
        assert!(
            c.pin_if_fresh("s", 0, 1, 0, now, 86_400, 600, 50, Some("r1")).unwrap(),
            "a free zero-byte row is pinned even when pinned_bytes already exceeds the budget",
        );
        assert_eq!(c.stats().unwrap().2, 100, "a zero-byte row adds nothing to pinned_bytes");
    }
}
