#!/usr/bin/env python3
"""Deterministic OGC GeoPackage sample generator for the storage tracer spike.

This writes a structurally valid OGC GeoPackage 1.3 (EPSG:4326, lon/lat) holding
real polygon geometry for the world's admin-0 country boundaries, then derives a
set of bounding-box test vectors from the R-tree it just built.

Design notes:
  - Pure Python standard library only. No GDAL, no spatialite, no third-party
    packages. Geometry blobs are encoded by hand per the StandardGeoPackageBinary
    byte layout so the spike has a fully independent writer.
  - Source data is Natural Earth admin-0 countries at the 50m scale, pinned to a
    fixed release tag so the build is reproducible. The download is cached under
    data/ (git-ignored) so re-runs are fast and work offline once primed. If no
    network and no cache are available, a small embedded set of real island
    outlines is used so the file still contains genuine geometry.
  - Big multipolygon countries whose territories span the globe (the United
    States, Russia, France with overseas departments, and similar) have envelopes
    that cover nearly the whole planet, which makes an R-tree candidate query
    almost useless. Those few are exploded into their component polygons so each
    feature carries a tight envelope. Compact multipolygon countries are kept
    whole so the MultiPolygon (WKB type 6) decode path is still exercised.
  - The output is deterministic: features are emitted in a stable sorted order,
    fids are assigned sequentially, gpkg_contents.last_change is a fixed
    timestamp, and the database is vacuumed into a canonical layout. Running the
    generator twice produces a byte-identical sample.gpkg.

Outputs:
  data/sample.gpkg  the GeoPackage (git-ignored, never committed)
  vectors.json      bbox -> expected fid test vectors (committed, ground truth)
"""

from __future__ import annotations

import json
import os
import struct
import sqlite3
import sys
import urllib.request

# --- paths -----------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
GPKG_PATH = os.path.join(DATA_DIR, "sample.gpkg")
SOURCE_CACHE = os.path.join(DATA_DIR, "source_ne50.geojson")
VECTORS_PATH = os.path.join(HERE, "vectors.json")

# Natural Earth admin-0 countries, 50m, pinned to a fixed release for
# reproducibility. Raw GeoJSON, no GDAL needed to read it.
NE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "v5.1.2/geojson/ne_50m_admin_0_countries.geojson"
)

# --- GeoPackage / WKB constants -------------------------------------------

GPKG_APPLICATION_ID = 0x47504B47  # "GPKG"
GPKG_USER_VERSION = 10301  # GeoPackage 1.3.1
SRS_ID = 4326  # WGS 84 geographic lon/lat
FIXED_LAST_CHANGE = "2024-01-01T00:00:00.000Z"  # frozen for byte determinism
PAGE_SIZE = 4096

WKB_POLYGON = 3
WKB_MULTIPOLYGON = 6

# A MultiPolygon country is kept whole when its envelope is no wider than this in
# longitude and latitude. Anything larger (continental sprawl or territories that
# straddle the antimeridian) is exploded into component polygons for tight
# envelopes. These bounds keep every compact island nation whole.
KEEP_WHOLE_MAX_LON_SPAN = 80.0
KEEP_WHOLE_MAX_LAT_SPAN = 60.0


# --- geometry helpers ------------------------------------------------------


def ring_points(ring):
    """Yield (x, y) for each vertex of a GeoJSON ring."""
    for pt in ring:
        yield pt[0], pt[1]


def polygon_points(polygon):
    """Yield (x, y) for every vertex of a GeoJSON polygon (all of its rings)."""
    for ring in polygon:
        yield from ring_points(ring)


def envelope(points):
    """Return (minx, maxx, miny, maxy) over an iterable of (x, y) points."""
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for x, y in points:
        if x < minx:
            minx = x
        if x > maxx:
            maxx = x
        if y < miny:
            miny = y
        if y > maxy:
            maxy = y
    return minx, maxx, miny, maxy


def encode_polygon_body(rings):
    """Encode the WKB body of a polygon: numRings, then per ring numPoints and
    the (x, y) double pairs. Little-endian."""
    out = bytearray()
    out += struct.pack("<I", len(rings))
    for ring in rings:
        out += struct.pack("<I", len(ring))
        for x, y in ring_points(ring):
            out += struct.pack("<dd", x, y)
    return bytes(out)


def encode_wkb(geom_type, geom_coords):
    """Encode standard ISO/OGC WKB, little-endian.

    geom_type WKB_POLYGON:      geom_coords is a polygon (list of rings).
    geom_type WKB_MULTIPOLYGON: geom_coords is a list of polygons.
    """
    out = bytearray()
    out += b"\x01"  # byte order: little endian
    out += struct.pack("<I", geom_type)
    if geom_type == WKB_POLYGON:
        out += encode_polygon_body(geom_coords)
    else:
        out += struct.pack("<I", len(geom_coords))
        for polygon in geom_coords:
            out += b"\x01"
            out += struct.pack("<I", WKB_POLYGON)
            out += encode_polygon_body(polygon)
    return bytes(out)


def gpkg_blob(geom_type, geom_coords, env):
    """Build a StandardGeoPackageBinary blob: GP header with an XY envelope plus
    the WKB body. Header byte order and WKB byte order are both little-endian."""
    minx, maxx, miny, maxy = env
    # flags: bit0 = 1 little-endian header, envelope indicator 1 (XY) in bits 1..3.
    flags = 0x01 | (1 << 1)
    header = bytearray()
    header += b"\x47\x50"  # magic "GP"
    header += bytes([0x00, flags])  # version 0, flags
    header += struct.pack("<i", SRS_ID)
    header += struct.pack("<dddd", minx, maxx, miny, maxy)
    return bytes(header) + encode_wkb(geom_type, geom_coords)


# --- source acquisition ----------------------------------------------------


def load_source():
    """Return (features, source_label). Prefer the cached download, then the
    network, then the embedded fallback set."""
    if os.path.exists(SOURCE_CACHE) and os.path.getsize(SOURCE_CACHE) > 0:
        with open(SOURCE_CACHE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data["features"], "Natural Earth 50m admin-0 countries (cached)"

    try:
        req = urllib.request.Request(NE_URL, headers={"User-Agent": "storage-spike"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
        with open(SOURCE_CACHE, "wb") as handle:
            handle.write(raw)
        data = json.loads(raw.decode("utf-8"))
        return data["features"], "Natural Earth 50m admin-0 countries (v5.1.2)"
    except Exception as exc:  # noqa: BLE001 - any failure falls back to embedded data
        print(f"  download unavailable ({exc}); using embedded fallback polygons")
        return EMBEDDED_FEATURES, "embedded fallback island outlines"


# --- feature emission ------------------------------------------------------


def feature_sort_key(feature, index):
    """Stable ordering key so fids are assigned deterministically."""
    props = feature.get("properties", {})
    return (props.get("NAME") or "", props.get("ADM0_A3") or "", index)


def emit_rows(features):
    """Turn source features into stored rows in deterministic order.

    Returns a list of dicts with: name, geom_type, coords, env. fids are the
    1-based position in this list.
    """
    rows = []
    ordered = sorted(
        range(len(features)), key=lambda i: feature_sort_key(features[i], i)
    )
    for idx in ordered:
        feature = features[idx]
        name = feature.get("properties", {}).get("NAME") or "unnamed"
        geom = feature["geometry"]
        gtype = geom["type"]
        coords = geom["coordinates"]

        if gtype == "Polygon":
            rows.append(
                {
                    "name": name,
                    "geom_type": WKB_POLYGON,
                    "coords": coords,
                    "env": envelope(polygon_points(coords)),
                }
            )
        elif gtype == "MultiPolygon":
            env = envelope(p for poly in coords for p in polygon_points(poly))
            minx, maxx, miny, maxy = env
            compact = (
                (maxx - minx) <= KEEP_WHOLE_MAX_LON_SPAN
                and (maxy - miny) <= KEEP_WHOLE_MAX_LAT_SPAN
            )
            if compact:
                rows.append(
                    {
                        "name": name,
                        "geom_type": WKB_MULTIPOLYGON,
                        "coords": coords,
                        "env": env,
                    }
                )
            else:
                for part_no, polygon in enumerate(coords, start=1):
                    rows.append(
                        {
                            "name": f"{name} (part {part_no})",
                            "geom_type": WKB_POLYGON,
                            "coords": polygon,
                            "env": envelope(polygon_points(polygon)),
                        }
                    )
        else:
            # The admin-0 dataset is polygons only; ignore anything unexpected.
            continue
    return rows


# --- GeoPackage writer -----------------------------------------------------


def create_schema(con):
    """Create the required GeoPackage system tables, the regions feature table,
    and the R-tree index table."""
    con.execute(
        """
        CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL,
            organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL,
            description TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY,
            data_type TEXT NOT NULL,
            identifier TEXT UNIQUE,
            description TEXT DEFAULT '',
            last_change TEXT NOT NULL,
            min_x DOUBLE,
            min_y DOUBLE,
            max_x DOUBLE,
            max_y DOUBLE,
            srs_id INTEGER,
            CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id)
                REFERENCES gpkg_spatial_ref_sys(srs_id)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL,
            z TINYINT NOT NULL,
            m TINYINT NOT NULL,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
            CONSTRAINT uk_gc_table_name UNIQUE (table_name),
            CONSTRAINT fk_gc_tn FOREIGN KEY (table_name)
                REFERENCES gpkg_contents(table_name),
            CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id)
                REFERENCES gpkg_spatial_ref_sys(srs_id)
        )
        """
    )
    con.execute(
        """
        CREATE TABLE regions (
            fid INTEGER PRIMARY KEY,
            geom BLOB NOT NULL,
            name TEXT
        )
        """
    )
    con.execute(
        "CREATE VIRTUAL TABLE rtree_regions_geom USING rtree(id, minx, maxx, miny, maxy)"
    )


def populate_srs(con):
    """Insert the three required spatial reference system rows: undefined
    cartesian (-1), undefined geographic (0), and WGS 84 (4326)."""
    wgs84 = (
        'GEOGCS["WGS 84",DATUM["WGS_1984",'
        'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],'
        'AUTHORITY["EPSG","6326"]],'
        'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
        'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
        'AUTHORITY["EPSG","4326"]]'
    )
    con.executemany(
        "INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)",
        [
            (
                "Undefined cartesian SRS",
                -1,
                "NONE",
                -1,
                "undefined",
                "undefined cartesian coordinate reference system",
            ),
            (
                "Undefined geographic SRS",
                0,
                "NONE",
                0,
                "undefined",
                "undefined geographic coordinate reference system",
            ),
            (
                "WGS 84 geodetic",
                4326,
                "EPSG",
                4326,
                wgs84,
                "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid",
            ),
        ],
    )


def write_gpkg(rows):
    """Write the full GeoPackage to GPKG_PATH from the prepared rows."""
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = GPKG_PATH + suffix
        if os.path.exists(path):
            os.remove(path)

    con = sqlite3.connect(GPKG_PATH)
    try:
        con.execute(f"PRAGMA page_size = {PAGE_SIZE}")
        con.execute(f"PRAGMA application_id = {GPKG_APPLICATION_ID}")
        con.execute(f"PRAGMA user_version = {GPKG_USER_VERSION}")

        create_schema(con)
        populate_srs(con)

        # Overall dataset extent for gpkg_contents.
        ext_minx = min(r["env"][0] for r in rows)
        ext_maxx = max(r["env"][1] for r in rows)
        ext_miny = min(r["env"][2] for r in rows)
        ext_maxy = max(r["env"][3] for r in rows)

        con.execute(
            "INSERT INTO gpkg_contents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "regions",
                "features",
                "regions",
                "Admin-0 country boundary polygons for the storage tracer spike",
                FIXED_LAST_CHANGE,
                ext_minx,
                ext_miny,
                ext_maxx,
                ext_maxy,
                SRS_ID,
            ),
        )
        # Mixed POLYGON and MULTIPOLYGON storage, so declare the GEOMETRY supertype.
        con.execute(
            "INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, ?, ?)",
            ("regions", "geom", "GEOMETRY", SRS_ID, 0, 0),
        )

        feature_rows = []
        rtree_rows = []
        for fid, row in enumerate(rows, start=1):
            blob = gpkg_blob(row["geom_type"], row["coords"], row["env"])
            feature_rows.append((fid, blob, row["name"]))
            minx, maxx, miny, maxy = row["env"]
            rtree_rows.append((fid, minx, maxx, miny, maxy))

        con.executemany(
            "INSERT INTO regions (fid, geom, name) VALUES (?, ?, ?)", feature_rows
        )
        con.executemany(
            "INSERT INTO rtree_regions_geom VALUES (?, ?, ?, ?, ?)", rtree_rows
        )
        con.commit()
        con.execute("VACUUM")
        con.commit()
    finally:
        con.close()


# --- test vectors ----------------------------------------------------------

RTREE_QUERY = (
    "SELECT id FROM rtree_regions_geom "
    "WHERE minx <= :maxx AND maxx >= :minx "
    "AND miny <= :maxy AND maxy >= :miny ORDER BY id"
)


def query_fids(con, minx, miny, maxx, maxy):
    cur = con.execute(
        RTREE_QUERY, {"minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy}
    )
    return [r[0] for r in cur.fetchall()]


def build_vectors(con):
    """Derive bbox test vectors from the freshly built R-tree so every
    expected_fids list is ground truth. Covers a clear hit, a clean miss, a
    partial overlap, an exact-boundary touch, and a just-outside miss."""
    cases = []

    # 1. Clear hit: a box over the British Isles and the southern North Sea.
    #    Returns several real coastal features.
    cases.append(
        {
            "name": "hit_british_isles",
            "kind": "hit",
            "note": "Box over the British Isles and southern North Sea.",
            "minx": -8.0,
            "miny": 50.0,
            "maxx": 2.0,
            "maxy": 58.0,
        }
    )

    # 2. Clean miss: a small box in the open North Pacific, far from any land
    #    envelope (verified empty below).
    cases.append(
        {
            "name": "miss_north_pacific",
            "kind": "miss",
            "note": "Open ocean box in the central North Pacific, no land.",
            "minx": -150.0,
            "miny": 10.0,
            "maxx": -148.0,
            "maxy": 12.0,
        }
    )

    # 3. Partial overlap: a box over the central Mediterranean that clips the
    #    envelopes of several countries along the Adriatic and Tyrrhenian seas.
    cases.append(
        {
            "name": "partial_central_mediterranean",
            "kind": "partial",
            "note": "Box clipping the central Mediterranean and Adriatic coasts.",
            "minx": 10.0,
            "miny": 40.0,
            "maxx": 16.0,
            "maxy": 44.0,
        }
    )

    # 4 and 5. Exact-boundary touch and just-outside miss, constructed against a
    #    chosen feature's stored R-tree envelope so the inclusive <= / >=
    #    comparison is exercised at a real edge. We pick Iceland, a compact,
    #    well-isolated island whose western envelope edge is in open ocean.
    target_fid = None
    cur = con.execute(
        "SELECT id, minx, maxx, miny, maxy FROM rtree_regions_geom "
        "JOIN regions ON regions.fid = rtree_regions_geom.id "
        "WHERE regions.name = 'Iceland'"
    )
    target = cur.fetchone()
    if target is not None:
        target_fid, t_minx, t_maxx, t_miny, t_maxy = target
        # A box to the west whose eastern edge exactly equals the feature's
        # stored western edge (minx); its latitude band sits inside the feature's
        # envelope. The inclusive comparison includes it.
        touch_w = t_minx - 1.0
        band_lo = t_miny + 0.25 * (t_maxy - t_miny)
        band_hi = t_miny + 0.75 * (t_maxy - t_miny)
        cases.append(
            {
                "name": "boundary_touch_iceland_west",
                "kind": "boundary",
                "note": (
                    "Eastern edge of the query equals Iceland's western envelope "
                    "edge; the inclusive comparison includes it."
                ),
                "minx": touch_w,
                "miny": band_lo,
                "maxx": t_minx,
                "maxy": band_hi,
            }
        )
        # The same box nudged a hair west of the edge drops the feature, proving
        # the boundary is what decides inclusion.
        nudge = abs(t_minx) * 1e-6 + 1e-6
        cases.append(
            {
                "name": "boundary_just_outside_iceland_west",
                "kind": "miss",
                "note": (
                    "Same box moved just west of Iceland's western edge; the "
                    "feature is excluded."
                ),
                "minx": touch_w,
                "miny": band_lo,
                "maxx": t_minx - nudge,
                "maxy": band_hi,
            }
        )

    # Resolve expected_fids from the live R-tree for every case.
    vectors = []
    for case in cases:
        fids = query_fids(con, case["minx"], case["miny"], case["maxx"], case["maxy"])
        case = dict(case)
        case["expected_fids"] = fids
        case["expected_count"] = len(fids)
        vectors.append(case)

    # Sanity checks so a bad dataset cannot silently produce meaningless vectors.
    by_name = {v["name"]: v for v in vectors}
    assert by_name["hit_british_isles"]["expected_count"] > 0, "hit case returned nothing"
    assert by_name["miss_north_pacific"]["expected_count"] == 0, "miss case was not empty"
    assert by_name["partial_central_mediterranean"]["expected_count"] > 0, "partial empty"
    if target_fid is not None:
        touch = by_name["boundary_touch_iceland_west"]
        outside = by_name["boundary_just_outside_iceland_west"]
        assert target_fid in touch["expected_fids"], "boundary touch missed the feature"
        assert target_fid not in outside["expected_fids"], "just-outside still hit"

    return vectors


# --- embedded fallback -----------------------------------------------------
# Real, simplified island outlines (lon, lat) used only when the Natural Earth
# download is unavailable and nothing is cached. Coordinates are genuine
# boundary approximations, not toy squares. Rings are closed.

EMBEDDED_FEATURES = [
    {
        "properties": {"NAME": "Iceland", "ADM0_A3": "ISL"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-24.5, 65.5],
                    [-22.0, 66.5],
                    [-18.0, 66.3],
                    [-14.5, 66.0],
                    [-13.5, 64.6],
                    [-15.5, 63.9],
                    [-18.0, 63.4],
                    [-21.5, 63.8],
                    [-24.0, 64.5],
                    [-24.5, 65.5],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Ireland", "ADM0_A3": "IRL"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-10.4, 51.5],
                    [-9.0, 53.1],
                    [-9.9, 54.3],
                    [-8.2, 55.2],
                    [-6.0, 55.2],
                    [-6.0, 54.1],
                    [-6.4, 52.2],
                    [-8.2, 51.5],
                    [-10.4, 51.5],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Great Britain", "ADM0_A3": "GBR"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-5.7, 50.1],
                    [-3.0, 51.6],
                    [-5.0, 53.4],
                    [-3.1, 54.9],
                    [-5.0, 56.6],
                    [-3.0, 58.6],
                    [-1.8, 57.5],
                    [0.2, 53.5],
                    [1.7, 52.8],
                    [1.3, 51.1],
                    [-1.0, 50.7],
                    [-5.7, 50.1],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Sicily", "ADM0_A3": "SIC"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [12.4, 37.8],
                    [15.1, 38.3],
                    [15.6, 38.1],
                    [15.1, 36.7],
                    [13.2, 37.1],
                    [12.4, 37.8],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Sardinia", "ADM0_A3": "SAR"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [8.2, 38.9],
                    [9.6, 39.2],
                    [9.8, 40.9],
                    [8.7, 41.3],
                    [8.1, 40.6],
                    [8.4, 39.6],
                    [8.2, 38.9],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Crete", "ADM0_A3": "CRT"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [23.5, 35.2],
                    [25.0, 35.4],
                    [26.3, 35.3],
                    [25.7, 34.9],
                    [24.0, 34.9],
                    [23.5, 35.2],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Cyprus", "ADM0_A3": "CYP"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [32.3, 34.6],
                    [34.0, 34.9],
                    [34.6, 35.7],
                    [33.0, 35.4],
                    [32.3, 34.9],
                    [32.3, 34.6],
                ]
            ],
        },
    },
    {
        "properties": {"NAME": "Corsica", "ADM0_A3": "COR"},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [8.5, 41.4],
                    [9.5, 41.6],
                    [9.4, 42.7],
                    [9.0, 43.0],
                    [8.6, 42.4],
                    [8.5, 41.4],
                ]
            ],
        },
    },
]


# --- entry point -----------------------------------------------------------


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    print("Loading source geometry...")
    features, source_label = load_source()
    print(f"  source: {source_label} ({len(features)} input features)")

    rows = emit_rows(features)
    n_poly = sum(r["geom_type"] == WKB_POLYGON for r in rows)
    n_multi = len(rows) - n_poly
    print(f"  stored features: {len(rows)} (POLYGON={n_poly}, MULTIPOLYGON={n_multi})")

    print("Writing GeoPackage...")
    write_gpkg(rows)
    size = os.path.getsize(GPKG_PATH)
    print(f"  wrote {GPKG_PATH} ({size} bytes, {size / 1_000_000:.2f} MB)")

    print("Deriving test vectors from the R-tree...")
    con = sqlite3.connect(GPKG_PATH)
    try:
        vectors = build_vectors(con)
    finally:
        con.close()
    with open(VECTORS_PATH, "w", encoding="utf-8") as handle:
        json.dump(vectors, handle, indent=2)
        handle.write("\n")
    print(f"  wrote {VECTORS_PATH} ({len(vectors)} cases)")
    for v in vectors:
        print(f"    {v['name']:36s} {v['kind']:8s} -> {v['expected_count']} fid(s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
