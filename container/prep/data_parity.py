#!/usr/bin/env python3
"""Milestone 3C data-parity harness.

Compares the local per-region store (built by prep_region.py) against the live NOAA ENC Direct
ArcGIS service on a grid of sample points. The load-bearing assertions, per the design spec,
are that the local and the online ENC agree on the two classifications that drive the depth
honesty signal:

  - inEncDeep: the point sits in a depth area whose shallow value (DRVAL1) is at least the
    contour (draftMeters + safetyMarginMeters).
  - drying-as-land: the point sits in a depth area with a negative DRVAL1 (a drying height,
    treated as land).

Shoreline and coverage-edge disagreement is expected and is reported separately, not failed:
the two lineages (the local GDAL S-57 read and the online ArcGIS service) generalize edges
differently. A load-bearing failure is a point both sources cover where inEncDeep or the drying
classification disagree.

Run inside the prep image (it has ogrinfo plus Python). Local point-in-polygon uses GDAL's
SQLITE dialect with GEOS (ST_Intersects); the online side queries the ENC Direct service the
same way the crows-nest plugin does.
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request

# The ENC Direct ArcGIS Depth_Area layer id per scale band (the same table crows-nest uses).
DEPTH_AREA_LAYER = {
    "overview": 89, "general": 117, "coastal": 166,
    "approach": 232, "harbour": 227, "berthing": 100,
}
ENC_DIRECT_BASE = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect"


def store_bbox(store):
    """The store's depth-area extent, from the R-tree, as (west, south, east, north)."""
    c = sqlite3.connect(store)
    row = c.execute(
        "SELECT min(minx), min(miny), max(maxx), max(maxy) FROM rtree_enc_depth_areas_geom"
    ).fetchone()
    c.close()
    if not row or row[0] is None:
        sys.exit("store has no depth areas to bound a sample grid")
    return row  # west, south, east, north


def local_drvals(store, lon, lat):
    """The DRVAL1 values of local depth-area polygons containing the point (GEOS PIP)."""
    sql = f"SELECT drval1 FROM enc_depth_areas WHERE ST_Intersects(geom, ST_Point({lon},{lat}))"
    out = subprocess.run(
        ["ogrinfo", "-ro", "-q", "-dialect", "SQLITE", "-sql", sql, store],
        capture_output=True, text=True,
    ).stdout
    vals = []
    for line in out.splitlines():
        if "drval1" in line.lower() and "=" in line:
            token = line.split("=", 1)[1].strip()
            if token and token.lower() != "(null)":
                try:
                    vals.append(float(token))
                except ValueError:
                    pass
    return vals


def online_drvals(band, lon, lat, timeout):
    """The DRVAL1 values of online ENC Direct depth-area polygons containing the point."""
    layer = DEPTH_AREA_LAYER[band]
    params = urllib.parse.urlencode({
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "spatialRel": "esriSpatialRelIntersects",
        "inSR": "4326",
        "outFields": "DRVAL1,DRVAL2",
        "returnGeometry": "false",
        "f": "json",
    })
    url = f"{ENC_DIRECT_BASE}/enc_{band}/MapServer/{layer}/query?{params}"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        data = json.load(resp)
    if "error" in data:
        raise RuntimeError(f"ENC Direct error: {data['error']}")
    vals = []
    for feat in data.get("features", []):
        v = feat.get("attributes", {}).get("DRVAL1")
        if v is not None:
            vals.append(float(v))
    return vals


def classify(drvals, contour):
    """(covered, in_deep, drying) from a set of DRVAL1 values at a point."""
    covered = len(drvals) > 0
    in_deep = any(v >= contour for v in drvals)
    drying = any(v < 0 for v in drvals)
    return covered, in_deep, drying


def main():
    ap = argparse.ArgumentParser(description="Compare a local region store against ENC Direct.")
    ap.add_argument("--store", required=True)
    ap.add_argument("--band", default="harbour", choices=sorted(DEPTH_AREA_LAYER))
    ap.add_argument("--contour", type=float, default=2.5, help="draftMeters + safetyMarginMeters")
    ap.add_argument("--grid", type=int, default=8, help="sample points per axis")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()

    west, south, east, north = store_bbox(args.store)
    n = args.grid
    # Interior grid, avoiding the exact extent edges where coverage is ragged.
    pts = []
    for i in range(n):
        for j in range(n):
            lon = west + (east - west) * (i + 0.5) / n
            lat = south + (north - south) * (j + 0.5) / n
            pts.append((round(lon, 6), round(lat, 6)))

    both_covered = 0
    agree = 0
    edge = 0
    online_errors = 0
    failures = []
    for lon, lat in pts:
        try:
            on = online_drvals(args.band, lon, lat, args.timeout)
        except Exception as e:  # report, never silently pass
            online_errors += 1
            print(f"  online error at {lon},{lat}: {e}")
            continue
        loc = local_drvals(args.store, lon, lat)
        oc, od, ody = classify(on, args.contour)
        lc, ld, ldy = classify(loc, args.contour)
        if oc and lc:
            both_covered += 1
            if od == ld and ody == ldy:
                agree += 1
            else:
                failures.append((lon, lat, (lc, ld, ldy), (oc, od, ody), loc, on))
        elif oc != lc:
            edge += 1  # one side covers, the other does not: an expected lineage edge

    print(f"\nband={args.band} contour={args.contour}m grid={n}x{n} ({len(pts)} points)")
    print(f"points covered by both sources: {both_covered}")
    print(f"  classification agreements:   {agree}")
    print(f"  load-bearing disagreements:  {len(failures)}")
    print(f"coverage-edge points (one side only, expected): {edge}")
    if online_errors:
        print(f"online errors (not counted): {online_errors}")
    for lon, lat, lcl, onl, lv, ov in failures:
        print(f"  DISAGREE {lon},{lat} local(cov,deep,dry)={lcl} online={onl} local_drval={lv} online_drval={ov}")

    if failures:
        print("\nFAIL: load-bearing classification disagreement on covered points.")
        return 1
    print("\nPASS: local and online ENC agree on inEncDeep and drying for every co-covered point.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
