PRAGMA auto_vacuum = NONE;

CREATE TABLE tiles (
    source TEXT NOT NULL,
    z INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
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
);

CREATE TABLE region_tiles (
    region_id TEXT NOT NULL,
    source TEXT NOT NULL,
    z INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    PRIMARY KEY (region_id, source, z, x, y)
);

CREATE INDEX idx_tiles_scroll_lru ON tiles(last_access) WHERE pinned = 0;
CREATE INDEX idx_region_tiles_key ON region_tiles(source, z, x, y);

INSERT INTO tiles (
    source, z, x, y, content_type, strong_etag, upstream_validator, status,
    fetched_at, last_access, bytes, blob, pinned
) VALUES (
    'legacy-scroll', 5, 10, 12, 'image/png', '"legacy-scroll"', 'upstream-scroll',
    200, 100, 110, 4, X'01020304', 0
);

INSERT INTO tiles (
    source, z, x, y, content_type, strong_etag, upstream_validator, status,
    fetched_at, last_access, bytes, blob, pinned
) VALUES (
    'legacy-region', 6, 20, 24, 'image/webp', '"legacy-region"', NULL,
    200, 120, 130, 3, X'AABBCC', 1
);

INSERT INTO region_tiles (region_id, source, z, x, y)
VALUES ('legacy-region-id', 'legacy-region', 6, 20, 24);

INSERT INTO tiles (
    source, z, x, y, content_type, strong_etag, upstream_validator, status,
    fetched_at, last_access, bytes, blob, pinned
) VALUES (
    'legacy-staging', 7, 30, 36, 'image/png', '"legacy-staging"', NULL,
    200, 140, 150, 2, X'DDEE', 1
);

INSERT INTO region_tiles (region_id, source, z, x, y)
VALUES ('__warm_staging__legacy', 'legacy-staging', 7, 30, 36);

PRAGMA user_version = 3;
