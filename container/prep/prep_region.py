#!/usr/bin/env python3
"""Build one per-region GeoPackage for the binnacle-companion LocalProvider.

This is the Milestone 3B offline prep stage. It runs inside the prep container (GDAL plus
Python), reads NOAA ENC .000 cells with the GDAL S-57 driver, and writes the exact store
schema the runtime LocalProvider reads. GDAL lives here and only here: the output GeoPackage
carries no GDAL dependency, so the runtime image stays free of GDAL, GEOS, PROJ, and
SpatiaLite.

The output schema (the shared contract with the 3A reader, container/localprovider):
  enc_depth_areas(fid INTEGER PRIMARY KEY, geom BLOB, band TEXT, drval1 REAL, drval2 REAL)
  enc_land_areas (fid INTEGER PRIMARY KEY, geom BLOB, band TEXT)
  osm_water      (fid INTEGER PRIMARY KEY, geom BLOB)
  boundaries     (fid INTEGER PRIMARY KEY, geom BLOB, country_id TEXT)
plus the standard GeoPackage metadata tables and one R-tree per feature table named
rtree_<table>_geom(id, minx, maxx, miny, maxy). Coordinates are WGS84 (EPSG:4326), the
NOAA ENC and OSM native CRS, so no reprojection.

DRVAL1 maps to drval1 (shallow depth value, meters) and DRVAL2 to drval2 (deep depth value).
A negative DRVAL1 is a drying height and is preserved with its sign: the reader and the engine
treat drval1 < 0 as land.

ENC and chart data are downloaded by the owner per region and are never bundled. See README.md.
"""

import argparse
import os
import pathlib
import sqlite3
import subprocess
import sys

# The NOAA ENC cell name's third character is the navigational purpose, which is the usage band.
BANDS_BY_DIGIT = {
    "1": "overview",
    "2": "general",
    "3": "coastal",
    "4": "approach",
    "5": "harbour",
    "6": "berthing",
}

# DEPARE and DRGARE are depth areas (they carry DRVAL1 and DRVAL2). LNDARE is land.
DEPTH_LAYERS = ("DEPARE", "DRGARE")
LAND_LAYERS = ("LNDARE",)

FEATURE_TABLES = ("enc_depth_areas", "enc_land_areas", "osm_water", "boundaries")

S57_ENV = {**os.environ, "OGR_S57_OPTIONS": "RECODE_BY_DSSI=ON"}


def band_for_cell(cell_path):
    """Resolve the usage band from the ENC cell file name's third character."""
    name = pathlib.Path(cell_path).name
    if len(name) < 3 or name[2] not in BANDS_BY_DIGIT:
        raise ValueError(f"cannot resolve a usage band from cell name {name!r}")
    return BANDS_BY_DIGIT[name[2]]


def run(cmd, env=None):
    """Run a command, raising on failure with the captured output."""
    result = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def cell_layers(cell_path):
    """Return the set of OGR layer names present in a cell."""
    out = run(["ogrinfo", "-ro", "-q", cell_path], env=S57_ENV)
    layers = set()
    for line in out.splitlines():
        # ogrinfo -q prints lines like "1: DEPARE (Polygon)".
        part = line.split(":", 1)
        if len(part) == 2:
            layers.add(part[1].strip().split(" ")[0])
    return layers


# The routing store is polygon-only: the runtime reader decodes Polygon and MultiPolygon
# WKB and rejects anything else. S-57 LNDARE (and in principle a depth layer) can carry
# point and line features too, which PROMOTE_TO_MULTI would write as MultiPoint or
# MultiLineString. A single such row makes the reader fail the whole band and the router
# decline no-coverage, so keep only area geometry. Point and line land features are not
# area obstacles and are out of the routing schema, like the point hazards (WRECKS, UWTROC,
# OBSTRN) that belong to the separate leg-safety geometry, not this store.
POLYGON_ONLY = "OGR_GEOMETRY LIKE '%POLYGON'"


def ingest_cell(cell_path, out_gpkg):
    """Append a cell's depth and land areas into the store, tagged with its band."""
    band = band_for_cell(cell_path)
    present = cell_layers(cell_path)
    for layer in DEPTH_LAYERS:
        if layer in present:
            _ogr_append(
                cell_path, out_gpkg, "enc_depth_areas",
                f"SELECT DRVAL1 AS drval1, DRVAL2 AS drval2, '{band}' AS band FROM {layer} WHERE {POLYGON_ONLY}",
            )
    for layer in LAND_LAYERS:
        if layer in present:
            _ogr_append(
                cell_path, out_gpkg, "enc_land_areas",
                f"SELECT '{band}' AS band FROM {layer} WHERE {POLYGON_ONLY}",
            )


def _ogr_append(src, out_gpkg, table, sql):
    """ogr2ogr one SELECT into a store table, creating it on first write with an R-tree."""
    update = ["-update", "-append"] if pathlib.Path(out_gpkg).exists() else []
    run(
        ["ogr2ogr", "-f", "GPKG", out_gpkg, src, "-sql", sql,
         "-nln", table, "-nlt", "PROMOTE_TO_MULTI",
         "-lco", "GEOMETRY_NAME=geom", "-lco", "FID=fid", "-lco", "SPATIAL_INDEX=YES"]
        + update,
        env=S57_ENV,
    )


def ingest_boundaries(src, out_gpkg, country_field, clip=None):
    """Ingest admin-0 polygons into boundaries, mapping country_field to country_id, clipped to clip."""
    _ogr_append_plain(
        src, out_gpkg, "boundaries",
        f'SELECT "{country_field}" AS country_id FROM "{_first_layer(src)}" WHERE {POLYGON_ONLY}',
        clip,
    )


def ingest_osm_water(src, out_gpkg, clip=None):
    """Ingest OSM water polygons into osm_water, clipped to clip."""
    _ogr_append_plain(
        src, out_gpkg, "osm_water",
        f'SELECT 1 AS keep FROM "{_first_layer(src)}" WHERE {POLYGON_ONLY}',
        clip,
    )


def _first_layer(src):
    out = run(["ogrinfo", "-ro", "-q", src])
    for line in out.splitlines():
        part = line.split(":", 1)
        if len(part) == 2:
            return part[1].strip().split(" ")[0]
    raise RuntimeError(f"no layers found in {src}")


def _ogr_append_plain(src, out_gpkg, table, sql, clip=None):
    update = ["-update", "-append"] if pathlib.Path(out_gpkg).exists() else []
    # clip is (west, south, east, north): keep the store regional so a global OSM water or admin-0
    # source does not write the whole world. -spat uses the source spatial index to skip
    # non-overlapping features fast, which matters for a multi-GB source. -spat is read in the
    # source SRS (ogr2ogr rejects -spat_srs alongside -sql), so the OSM water and admin-0 sources
    # must be EPSG:4326: the recommended osmdata 4326 split product and Natural Earth both are.
    # -clipdst then trims the kept geometry to the window in the target SRS.
    bb = [str(clip[0]), str(clip[1]), str(clip[2]), str(clip[3])] if clip else None
    clip_args = (["-spat", *bb, "-clipdst", *bb] if clip else [])
    run(
        ["ogr2ogr", "-f", "GPKG", out_gpkg, src, "-sql", sql, "-dialect", "OGRSQL",
         "-nln", table, "-nlt", "PROMOTE_TO_MULTI", "-t_srs", "EPSG:4326"]
        + clip_args
        + ["-lco", "GEOMETRY_NAME=geom", "-lco", "FID=fid", "-lco", "SPATIAL_INDEX=YES"]
        + update,
    )


def ensure_schema(out_gpkg):
    """Create any feature table and R-tree the ingests did not, so the reader never hits a
    missing table. An empty table reads as no-coverage, which is the honest result."""
    conn = sqlite3.connect(out_gpkg)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS enc_depth_areas (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL, drval1 REAL, drval2 REAL);
        CREATE TABLE IF NOT EXISTS enc_land_areas  (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS osm_water       (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS boundaries      (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, country_id TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS rtree_enc_depth_areas_geom USING rtree(id, minx, maxx, miny, maxy);
        CREATE VIRTUAL TABLE IF NOT EXISTS rtree_enc_land_areas_geom  USING rtree(id, minx, maxx, miny, maxy);
        CREATE VIRTUAL TABLE IF NOT EXISTS rtree_osm_water_geom       USING rtree(id, minx, maxx, miny, maxy);
        CREATE VIRTUAL TABLE IF NOT EXISTS rtree_boundaries_geom      USING rtree(id, minx, maxx, miny, maxy);
        """
    )
    conn.commit()
    conn.close()


# Margin in degrees added around the ENC extent when clipping OSM water and boundaries, wider
# than the router's snap padding (about 0.033 deg) so water and borders near a cell edge survive.
CLIP_MARGIN_DEG = 0.1


def enc_region_bbox(out_gpkg, margin_deg=CLIP_MARGIN_DEG):
    """The ENC extent (depth plus land R-trees) padded by margin_deg, as (west, south, east, north),
    or None when the store charted nothing to bound."""
    conn = sqlite3.connect(out_gpkg)
    extents = []
    for table in ("enc_depth_areas", "enc_land_areas"):
        rtree = f"rtree_{table}_geom"
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (rtree,)).fetchone():
            continue
        row = conn.execute(f"SELECT min(minx), min(miny), max(maxx), max(maxy) FROM {rtree}").fetchone()
        if row and row[0] is not None:
            extents.append(row)
    conn.close()
    if not extents:
        return None
    return (
        min(r[0] for r in extents) - margin_deg,
        min(r[1] for r in extents) - margin_deg,
        max(r[2] for r in extents) + margin_deg,
        max(r[3] for r in extents) + margin_deg,
    )


def report(out_gpkg):
    conn = sqlite3.connect(out_gpkg)
    for table in FEATURE_TABLES:
        n = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {n} rows")
    conn.close()


def main():
    ap = argparse.ArgumentParser(description="Build a per-region GeoPackage for LocalProvider.")
    ap.add_argument("--enc-dir", required=True, help="directory containing ENC .000 cells (searched recursively)")
    ap.add_argument("--out", required=True, help="output GeoPackage path")
    ap.add_argument("--boundaries", help="admin-0 polygons (any OGR source) for the boundaries table")
    ap.add_argument("--country-field", default="iso_sov1",
                    help="boundaries field stored as country_id (Marine Regions EEZ iso_sov1, ISO alpha-3)")
    ap.add_argument("--osm", help="OSM water polygons (any OGR source) for the osm_water table")
    args = ap.parse_args()

    out = pathlib.Path(args.out)
    if out.exists():
        out.unlink()

    cells = sorted(pathlib.Path(args.enc_dir).rglob("*.000"))
    if not cells:
        sys.exit(f"no .000 cells found under {args.enc_dir}")
    # Coarse to fine so a finer band's polygons are appended last, matching the engine's
    # finest-first read precedence.
    cells.sort(key=lambda c: c.name[2] if len(c.name) > 2 else "9")
    print(f"ingesting {len(cells)} cell(s):")
    for cell in cells:
        print(f"  {cell.name} -> band {band_for_cell(cell)}")
        ingest_cell(str(cell), str(out))

    # Clip OSM water and boundaries to the ENC extent so a regional or global source does not
    # write the whole world into this region's store.
    region = enc_region_bbox(str(out))
    if region:
        print(f"clipping OSM and boundaries to ENC extent + {CLIP_MARGIN_DEG} deg: {region}")
    if args.boundaries:
        ingest_boundaries(args.boundaries, str(out), args.country_field, region)
    if args.osm:
        ingest_osm_water(args.osm, str(out), region)

    ensure_schema(str(out))
    print("store contents:")
    report(str(out))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
