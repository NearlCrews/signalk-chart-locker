//! The microSD-aware tile cache: one bundled-SQLite DB, a single serialized connection, WAL,
//! synchronous=NORMAL (survives boat power loss without corruption), a normal rowid table, a running
//! byte total (so /cache/stats is O(1) and eviction needs no SUM scan), and LRU eviction under one
//! global byte cap. Reads serialize through the same connection: tile reads are fast point lookups
//! and the real cost on a miss is the network fetch, so a read pool is deferred.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

/// The cache schema version. A mismatch drops and recreates the table (the cache is disposable, so a
/// later column change rebuilds rather than reading stale rows).
const SCHEMA_VERSION: i64 = 1;

/// A stored tile, or a negative-cache marker when `blob` is `None` (a 404 or 204 from upstream).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedTile {
    pub content_type: String,
    pub strong_etag: String,
    pub upstream_validator: Option<String>,
    pub status: i64,
    pub fetched_at: i64,
    pub bytes: i64,
    pub blob: Option<Vec<u8>>,
}

/// The outcome of a put: stored, or degraded (the disk is full) so the caller serves the bytes
/// without caching them rather than erroring the tile.
#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Stored,
    Degraded,
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
                    PRIMARY KEY (source, z, x, y)
                );",
            )?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(())
    }

    /// Look up a cached tile by key. Does not update last_access (the caller throttles touches).
    pub fn get(&self, source: &str, z: u32, x: u32, y: u32) -> rusqlite::Result<Option<CachedTile>> {
        let inner = self.inner.lock().unwrap();
        inner
            .conn
            .query_row(
                "SELECT content_type, strong_etag, upstream_validator, status, fetched_at, bytes, blob
                 FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| {
                    Ok(CachedTile {
                        content_type: r.get(0)?,
                        strong_etag: r.get(1)?,
                        upstream_validator: r.get(2)?,
                        status: r.get(3)?,
                        fetched_at: r.get(4)?,
                        bytes: r.get(5)?,
                        blob: r.get(6)?,
                    })
                },
            )
            .optional()
    }

    /// Insert or replace a tile, keeping the running byte total in sync. Returns Degraded on a full
    /// disk so the caller serves the bytes without storing them.
    pub fn put(&self, source: &str, z: u32, x: u32, y: u32, tile: &CachedTile, now: i64) -> rusqlite::Result<PutOutcome> {
        let mut inner = self.inner.lock().unwrap();
        let old_bytes: Option<i64> = inner
            .conn
            .query_row(
                "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
                |r| r.get(0),
            )
            .optional()?;
        let result = inner.conn.execute(
            "INSERT OR REPLACE INTO tiles
             (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                source, z, x, y, tile.content_type, tile.strong_etag, tile.upstream_validator,
                tile.status, tile.fetched_at, now, tile.bytes, tile.blob
            ],
        );
        match result {
            Ok(_) => {
                inner.total_bytes += tile.bytes - old_bytes.unwrap_or(0);
                Ok(PutOutcome::Stored)
            }
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DiskFull => Ok(PutOutcome::Degraded),
            Err(e) => Err(e),
        }
    }

    /// Bump a tile's last_access so the LRU keeps the hot tiles. The caller throttles this so a pan
    /// does not turn every read into a write (microSD wear).
    pub fn touch(&self, source: &str, z: u32, x: u32, y: u32, now: i64) -> rusqlite::Result<()> {
        let inner = self.inner.lock().unwrap();
        inner.conn.execute(
            "UPDATE tiles SET last_access = ?5 WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y, now],
        )?;
        Ok(())
    }

    /// Evict the least-recently-accessed rows until the total is at or below `cap_bytes`.
    pub fn evict_to(&self, cap_bytes: i64) -> rusqlite::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        while inner.total_bytes > cap_bytes {
            let oldest: Option<(String, u32, u32, u32, i64)> = inner
                .conn
                .query_row(
                    "SELECT source, z, x, y, bytes FROM tiles ORDER BY last_access ASC LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()?;
            let Some((source, z, x, y, bytes)) = oldest else { break };
            inner.conn.execute(
                "DELETE FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                params![source, z, x, y],
            )?;
            inner.total_bytes -= bytes;
        }
        Ok(())
    }

    /// Row count and total bytes, both O(1) (the total is maintained on every put and delete).
    pub fn stats(&self) -> rusqlite::Result<(i64, i64)> {
        let inner = self.inner.lock().unwrap();
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
            bytes,
            blob,
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
        assert_eq!(c.put("s", 1, 0, 0, &tile(3, 200, Some(vec![1, 2, 3])), 10).unwrap(), PutOutcome::Stored);
        let got = c.get("s", 1, 0, 0).unwrap().unwrap();
        assert_eq!(got.blob, Some(vec![1, 2, 3]));
        assert_eq!(got.content_type, "image/png");
        assert_eq!(got.status, 200);
        assert!(c.get("s", 1, 0, 1).unwrap().is_none());
    }

    #[test]
    fn replace_keeps_the_byte_total_in_sync() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(5, 200, Some(vec![0; 5])), 1).unwrap();
        c.put("s", 0, 0, 0, &tile(2, 200, Some(vec![0; 2])), 2).unwrap();
        assert_eq!(c.stats().unwrap(), (1, 2));
    }

    #[test]
    fn evict_to_removes_the_least_recently_accessed_first() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), 1).unwrap(); // older
        c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), 2).unwrap();
        c.evict_to(10).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "the older tile is evicted");
        assert!(c.get("s", 0, 0, 1).unwrap().is_some());
        assert_eq!(c.stats().unwrap().1, 10);
    }

    #[test]
    fn negative_cache_row_round_trips() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(0, 404, None), 1).unwrap();
        let got = c.get("s", 0, 0, 0).unwrap().unwrap();
        assert_eq!(got.status, 404);
        assert_eq!(got.blob, None);
    }

    #[test]
    fn touch_protects_a_hot_tile_from_eviction() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), 1).unwrap();
        c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), 2).unwrap();
        c.touch("s", 0, 0, 0, 9).unwrap(); // the older tile is now the most recently accessed
        c.evict_to(10).unwrap();
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the touched tile survives");
        assert!(c.get("s", 0, 0, 1).unwrap().is_none());
    }
}
