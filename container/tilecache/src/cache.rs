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
const SCHEMA_VERSION: i64 = 2;

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
        Ok(Self { inner: Mutex::new(Inner { conn, total_bytes }) })
    }

    /// Take the connection lock, recovering the guard on a poisoned mutex so a single panic under the
    /// lock (none is reachable today) cannot wedge the cache for the rest of the process.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != SCHEMA_VERSION {
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

    /// Store a batch of warm tiles pinned, in one transaction, with an explicit pre-store cap check.
    /// A warm NEVER evicts: when the next sized row would cross `cap_bytes`, it stops and reports
    /// `capped`. Negative-cache rows (zero bytes) always store. Pinned rows are eviction-exempt but
    /// still count against the cap, so the budget stays honest. The cap check uses the NET byte delta
    /// (new bytes minus any existing row's bytes), so re-warming an already-cached tile does not trip
    /// the cap early on an `INSERT OR REPLACE`.
    pub fn put_many_pinned(&self, rows: &[WarmRow], cap_bytes: i64, now: i64) -> rusqlite::Result<PutManyOutcome> {
        let mut inner = self.lock();
        let base = inner.total_bytes;
        let mut added = 0i64;
        let mut stored = 0usize;
        let mut capped = false;
        {
            let tx = inner.conn.unchecked_transaction()?;
            for r in rows {
                let old: Option<i64> = tx.query_row(
                    "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                    params![r.source, r.z, r.x, r.y], |row| row.get(0),
                ).optional()?;
                let delta = r.tile.bytes - old.unwrap_or(0);
                // Only a net-positive sized row can cross the cap; a re-warm of equal or smaller bytes never does.
                if delta > 0 && base + added + delta > cap_bytes {
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
                added += delta;
                stored += 1;
            }
            tx.commit()?;
        }
        inner.total_bytes = base + added;
        Ok(PutManyOutcome { stored, bytes_added: added, capped })
    }

    /// Mark an already-cached row pinned (eviction-exempt) without re-fetching or changing its
    /// bytes. A warm calls this when it skips a tile that is already cached fresh, so a tile
    /// previously stored unpinned by the live proxy still becomes part of the eviction-exempt box.
    /// A no-op when the row is absent.
    pub fn pin(&self, source: &str, z: u32, x: u32, y: u32) -> rusqlite::Result<()> {
        let inner = self.lock();
        inner.conn.execute(
            "UPDATE tiles SET pinned = 1 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y],
        )?;
        Ok(())
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

    /// Row count and total bytes. The total is O(1) (maintained on every put and delete); the count is
    /// a `COUNT(*)`, O(n) in SQLite, but `/cache/stats` is called rarely.
    pub fn stats(&self) -> rusqlite::Result<(i64, i64)> {
        let inner = self.lock();
        let rows: i64 = inner.conn.query_row("SELECT COUNT(*) FROM tiles", [], |r| r.get(0))?;
        Ok((rows, inner.total_bytes))
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
        assert_eq!(c.stats().unwrap(), (1, 2));
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
        let outcome = c.put_many_pinned(&rows, 10, 5).unwrap();
        assert_eq!(outcome.stored, 1, "only the first tile fits under the 10-byte cap");
        assert!(outcome.capped, "the batch reports capped rather than evicting");
        assert_eq!(c.stats().unwrap().1, 8, "no eviction happened");
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
}
