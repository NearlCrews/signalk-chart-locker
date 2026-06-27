#!/usr/bin/env python3
"""Build one per-region GeoPackage for the binnacle-companion LocalProvider.

This is the Milestone 3B offline prep stage. It runs inside the prep container (GDAL plus
Python), reads NOAA ENC .000 cells with the GDAL S-57 driver, and writes the exact store
schema the runtime LocalProvider reads. GDAL lives here and only here: the output GeoPackage
carries no GDAL dependency, so the runtime image stays free of GDAL, GEOS, PROJ, and
SpatiaLite.

The output schema (the shared contract with the 3A reader, container/localprovider) is the
single source TABLE_SCHEMAS below: enc_depth_areas, enc_land_areas, osm_water, and boundaries,
plus the standard GeoPackage metadata tables and one R-tree per feature table named
rtree_<table>_geom(id, minx, maxx, miny, maxy). Coordinates are WGS84 (EPSG:4326), the NOAA
ENC, OSM, and EEZ native CRS.

DRVAL1 maps to drval1 (shallow depth value, meters) and DRVAL2 to drval2 (deep depth value).
A negative DRVAL1 is a drying height and is preserved with its sign: the reader and the engine
treat drval1 < 0 as land.

To add a feature type, add a row to TABLE_SCHEMAS and, for an ENC source, ENC_INGESTS; the
schema, the R-tree, and the report all derive from TABLE_SCHEMAS, so no parallel list needs a
matching edit.

ENC and chart data are downloaded by the owner per region and are never bundled. See README.md.
"""

import argparse
import contextlib
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
from typing import NamedTuple, Optional

# The NOAA ENC cell name's third character is the navigational purpose, which is the usage band.
BANDS_BY_DIGIT = {
    "1": "overview",
    "2": "general",
    "3": "coastal",
    "4": "approach",
    "5": "harbour",
    "6": "berthing",
}

# The single source of the store schema. ensure_schema, the R-tree creation, FEATURE_TABLES,
# and report all derive from this, so adding a feature table is a one-line edit here.
TABLE_SCHEMAS = {
    "enc_depth_areas": "fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL, drval1 REAL, drval2 REAL",
    "enc_land_areas": "fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL",
    "osm_water": "fid INTEGER PRIMARY KEY, geom BLOB NOT NULL",
    "boundaries": "fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, country_id TEXT NOT NULL",
}
FEATURE_TABLES = tuple(TABLE_SCHEMAS)

# ENC ingests, data driven: each row is (source S-57 layers, destination table, attribute SELECT).
# DEPARE and DRGARE are depth areas and carry DRVAL1 and DRVAL2; LNDARE is land. To ingest a new
# S-57 layer type, add a row here and a matching table to TABLE_SCHEMAS.
class EncIngest(NamedTuple):
    src_layers: tuple        # S-57 source layers to read for this destination table
    dst_table: str           # store table the geometry is written into
    attr_select: Optional[str]  # attribute SELECT prefix (depth values), or None for geometry only


ENC_INGESTS = (
    EncIngest(("DEPARE", "DRGARE"), "enc_depth_areas", "DRVAL1 AS drval1, DRVAL2 AS drval2"),
    EncIngest(("LNDARE",), "enc_land_areas", None),
)

S57_ENV = {**os.environ, "OGR_S57_OPTIONS": "RECODE_BY_DSSI=ON"}

# The routing store is polygon-only: the runtime reader decodes Polygon and MultiPolygon WKB and
# rejects anything else. S-57 LNDARE (and in principle a depth layer) can carry point and line
# features too, which PROMOTE_TO_MULTI would write as MultiPoint or MultiLineString. A single such
# row makes the reader fail the whole band and the router decline no-coverage, so keep only area
# geometry. Point and line land features are not area obstacles and are out of the routing schema,
# like the point hazards (WRECKS, UWTROC, OBSTRN) that belong to the separate leg-safety geometry.
POLYGON_ONLY = "OGR_GEOMETRY LIKE '%POLYGON'"

# Margin in degrees added around the ENC extent when clipping OSM water and boundaries, wider than
# the router's snap padding (about 0.033 deg) so water and borders near a cell edge survive.
CLIP_MARGIN_DEG = 0.1

# A boundaries country field is interpolated into SQL, so restrict it to a plain identifier.
_FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def run(cmd, env=None):
    """Run a command, raising on failure with the captured output."""
    result = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def band_for_cell(cell_path):
    """Resolve the usage band from the ENC cell file name's third character."""
    name = pathlib.Path(cell_path).name
    if len(name) < 3 or name[2] not in BANDS_BY_DIGIT:
        raise ValueError(f"cannot resolve a usage band from cell name {name!r}")
    return BANDS_BY_DIGIT[name[2]]


def ogr_layers(src, env=None):
    """The OGR layer names in a source, in declaration order. ogrinfo -q prints lines like
    '1: DEPARE (Polygon)'. Callers take [0] for the primary layer or wrap the result in a set for
    membership tests."""
    names = []
    for line in run(["ogrinfo", "-ro", "-q", src], env=env).splitlines():
        part = line.split(":", 1)
        if len(part) == 2:
            names.append(part[1].strip().split(" ")[0])
    return names


def _ogr2ogr(src, out_gpkg, table, sql, *, env=None, target_srs=None, clip=None):
    """Run one ogr2ogr OGRSQL SELECT into a store table, creating it on first write with an R-tree.

    `clip` is (west, south, east, north): -spat uses the source spatial index to skip
    non-overlapping features fast (it matters for a multi-GB source and is read in the source SRS,
    so the source must be EPSG:4326), and -clipdst then trims the kept geometry in the target SRS.
    """
    update = ["-update", "-append"] if pathlib.Path(out_gpkg).exists() else []
    srs_args = ["-t_srs", target_srs] if target_srs else []
    if clip:
        bb = [str(clip[0]), str(clip[1]), str(clip[2]), str(clip[3])]
        clip_args = ["-spat", *bb, "-clipdst", *bb]
    else:
        clip_args = []
    run(
        ["ogr2ogr", "-f", "GPKG", out_gpkg, src, "-sql", sql, "-dialect", "OGRSQL",
         "-nln", table, "-nlt", "PROMOTE_TO_MULTI", *srs_args, *clip_args,
         "-lco", "GEOMETRY_NAME=geom", "-lco", "FID=fid", "-lco", "SPATIAL_INDEX=YES",
         *update],
        env=env,
    )


def _drop_column(out_gpkg, table, column):
    """Drop a throwaway attribute column so a geometry-only table matches the schema contract.

    table and column are internal string literals at every call site, never operator input, so the
    f-string interpolation here cannot be influenced externally."""
    with contextlib.closing(sqlite3.connect(out_gpkg)) as conn:
        if any(r[1] == column for r in conn.execute(f"PRAGMA table_info({table})")):
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
            conn.commit()


def ingest_cell(cell_path, out_gpkg):
    """Append a cell's depth and land areas into the store, tagged with its band, per ENC_INGESTS."""
    band = band_for_cell(cell_path)
    present = set(ogr_layers(cell_path, env=S57_ENV))
    for src_layers, table, attr_select in ENC_INGESTS:
        cols = f"{attr_select}, " if attr_select else ""
        for layer in src_layers:
            if layer in present:
                _ogr2ogr(
                    cell_path, out_gpkg, table,
                    f"SELECT {cols}'{band}' AS band FROM {layer} WHERE {POLYGON_ONLY}",
                    env=S57_ENV,
                )


def ingest_boundaries(src, out_gpkg, country_field, clip=None):
    """Ingest maritime-jurisdiction polygons into boundaries, mapping country_field to country_id."""
    if not _FIELD_NAME.match(country_field):
        sys.exit(f"--country-field {country_field!r} is not a plain field name")
    layer = ogr_layers(src)[0]
    _ogr2ogr(
        src, out_gpkg, "boundaries",
        f'SELECT "{country_field}" AS country_id FROM "{layer}" WHERE {POLYGON_ONLY}',
        target_srs="EPSG:4326", clip=clip,
    )


def ingest_osm_water(src, out_gpkg, clip=None):
    """Ingest OSM water polygons into osm_water (geometry only), clipped to clip.

    ogr2ogr -select cannot combine with -append (the store already exists from the ENC ingest), so
    write a throwaway attribute then drop it, leaving osm_water geometry-only per the contract.
    """
    layer = ogr_layers(src)[0]
    _ogr2ogr(
        src, out_gpkg, "osm_water",
        f'SELECT 1 AS keep FROM "{layer}" WHERE {POLYGON_ONLY}',
        target_srs="EPSG:4326", clip=clip,
    )
    _drop_column(out_gpkg, "osm_water", "keep")


def ensure_schema(out_gpkg):
    """Create any feature table and R-tree the ingests did not, so the reader never hits a missing
    table. An empty table reads as no-coverage, which is the honest result. Derived from TABLE_SCHEMAS."""
    ddl = []
    for table, columns in TABLE_SCHEMAS.items():
        ddl.append(f"CREATE TABLE IF NOT EXISTS {table} ({columns});")
        ddl.append(f"CREATE VIRTUAL TABLE IF NOT EXISTS rtree_{table}_geom USING rtree(id, minx, maxx, miny, maxy);")
    with contextlib.closing(sqlite3.connect(out_gpkg)) as conn:
        conn.executescript("\n".join(ddl))
        conn.commit()


def enc_region_bbox(out_gpkg, margin_deg=CLIP_MARGIN_DEG):
    """The ENC extent (depth plus land R-trees) padded by margin_deg, as (west, south, east, north),
    or None when the store charted nothing to bound."""
    extents = []
    with contextlib.closing(sqlite3.connect(out_gpkg)) as conn:
        for table in ("enc_depth_areas", "enc_land_areas"):
            rtree = f"rtree_{table}_geom"
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (rtree,)).fetchone():
                continue
            row = conn.execute(f"SELECT min(minx), min(miny), max(maxx), max(maxy) FROM {rtree}").fetchone()
            if row and row[0] is not None:
                extents.append(row)
    if not extents:
        return None
    return (
        min(r[0] for r in extents) - margin_deg,
        min(r[1] for r in extents) - margin_deg,
        max(r[2] for r in extents) + margin_deg,
        max(r[3] for r in extents) + margin_deg,
    )


def report(out_gpkg):
    with contextlib.closing(sqlite3.connect(out_gpkg)) as conn:
        for table in FEATURE_TABLES:
            n = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            print(f"  {table}: {n} rows")


def discover_cells(enc_dir):
    """ENC .000 cells under enc_dir, coarse band to fine so a finer band's polygons append last,
    matching the engine's finest-first read precedence. Exits if none are found."""
    cells = sorted(
        pathlib.Path(enc_dir).rglob("*.000"),
        key=lambda c: (c.name[2] if len(c.name) > 2 else "9", c.name),
    )
    if not cells:
        sys.exit(f"no .000 cells found under {enc_dir}")
    return cells


def build_region(enc_dir, out, boundaries=None, country_field="iso_sov1", osm=None):
    """Build the region store: ingest the ENC cells, then clip and ingest boundaries and OSM water."""
    if out.exists():
        out.unlink()
    cells = discover_cells(enc_dir)
    print(f"ingesting {len(cells)} cell(s):")
    for cell in cells:
        print(f"  {cell.name} -> band {band_for_cell(cell)}")
        ingest_cell(str(cell), str(out))

    # Clip OSM water and boundaries to the ENC extent so a regional or global source does not write
    # the whole world into this region's store.
    region = enc_region_bbox(str(out))
    if region:
        print(f"clipping OSM and boundaries to ENC extent + {CLIP_MARGIN_DEG} deg: {region}")
    if boundaries:
        ingest_boundaries(boundaries, str(out), country_field, region)
    if osm:
        ingest_osm_water(osm, str(out), region)

    ensure_schema(str(out))
    print("store contents:")
    report(str(out))
    print(f"wrote {out}")


def main():
    ap = argparse.ArgumentParser(description="Build a per-region GeoPackage for LocalProvider.")
    ap.add_argument("--enc-dir", required=True, help="directory containing ENC .000 cells (searched recursively)")
    ap.add_argument("--out", required=True, help="output GeoPackage path")
    ap.add_argument("--boundaries", help="maritime-jurisdiction polygons (Marine Regions EEZ) for the boundaries table")
    ap.add_argument("--country-field", default="iso_sov1",
                    help="boundaries field stored as country_id (Marine Regions EEZ iso_sov1, ISO alpha-3)")
    ap.add_argument("--osm", help="OSM water polygons (any OGR source) for the osm_water table")
    args = ap.parse_args()
    build_region(args.enc_dir, pathlib.Path(args.out), args.boundaries, args.country_field, args.osm)


if __name__ == "__main__":
    main()
