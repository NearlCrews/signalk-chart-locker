#!/usr/bin/env python3
"""Independent reference reader and cross-check for the storage-tracer spike.

This is the ground-truth oracle for the milestone 1.5 storage spike. It is on
purpose a SEPARATE implementation from the Rust reader: it opens the same
GeoPackage with the Python standard library sqlite3 module, runs the same R-tree
bounding-box query from the spike contract, and decodes the GeoPackage geometry
blob and WKB polygon by hand. Two independent decoders that agree are far
stronger evidence than one decoder checked against itself, so this file never
imports or reuses any of the Rust code.

Standard library only: no third-party packages.

Usage:
  verify.py oracle                 print the oracle (fids and geometry summary) per vector
  verify.py structure              print the structural authenticity checks
  verify.py crosscheck --ferro B   run the Rust binary B per vector and diff against the oracle
  verify.py all --ferro B          structure + oracle + crosscheck, exit nonzero on any failure

Defaults: --gpkg container/storage-spike/data/sample.gpkg
          --vectors container/storage-spike/vectors.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import struct
import subprocess
import sys
from urllib.request import pathname2url

# GeoPackage application_id "GPKG" and the 1.3 user_version, per the spec and
# the spike contract.
GPKG_APPLICATION_ID = 0x47504B47
GPKG_USER_VERSION = 10301

# The candidate query from the contract: an R-tree envelope overlap test. This
# is the candidate set, not a point-in-polygon refinement, which is the engine's
# job and out of spike scope.
RTREE_QUERY = (
    "SELECT id FROM rtree_regions_geom "
    "WHERE minx <= :maxx AND maxx >= :minx "
    "AND miny <= :maxy AND maxy >= :miny "
    "ORDER BY id"
)

# How many leading vertices of the first ring we keep for the readable summary.
# The full first ring is kept separately for the bit-for-bit geometry diff.
HEAD_VERTICES = 5

# Cross-check tolerance. Both readers decode the same IEEE-754 doubles, so the
# values should be exactly equal. A tiny epsilon absorbs any rounding that a
# text output format might introduce on the Rust side; JSON full precision needs
# none of it.
COORD_EPSILON = 1e-9


class BlobError(Exception):
    """Raised when a GeoPackage geometry blob or its WKB body is malformed."""


# --------------------------------------------------------------------------- #
# WKB and GeoPackage geometry blob decoding (independent implementation)
# --------------------------------------------------------------------------- #

class _Cursor:
    """A tiny forward-only byte cursor with bounds checking."""

    __slots__ = ("buf", "pos")

    def __init__(self, buf: bytes, pos: int = 0) -> None:
        self.buf = buf
        self.pos = pos

    def take(self, n: int) -> bytes:
        end = self.pos + n
        if end > len(self.buf):
            have = len(self.buf) - self.pos
            raise BlobError(f"WKB truncated: need {n} bytes at offset {self.pos}, have {have}")
        chunk = self.buf[self.pos:end]
        self.pos = end
        return chunk

    def remaining(self) -> int:
        return len(self.buf) - self.pos


def _normalize_wkb_type(raw_type: int) -> tuple[int, int]:
    """Reduce a WKB geometry type code to (base_type, coordinate_dimension).

    Handles plain 2D OGC codes (3, 6), ISO Z/M/ZM thousands (1003, 2003, 3003,
    and so on), and PostGIS EWKB high-bit flags. The spike generator emits plain
    2D, but tolerating the variants means a generator change cannot silently
    corrupt the oracle.
    """
    has_z = bool(raw_type & 0x80000000)
    has_m = bool(raw_type & 0x40000000)
    base = raw_type & 0x1FFFFFFF
    if base >= 1000:
        thousands, base = divmod(base, 1000)
        if thousands in (1, 3):
            has_z = True
        if thousands in (2, 3):
            has_m = True
    dim = 2 + (1 if has_z else 0) + (1 if has_m else 0)
    return base, dim


def _read_uint32(cur: _Cursor, little_endian: bool) -> int:
    fmt = "<I" if little_endian else ">I"
    return struct.unpack(fmt, cur.take(4))[0]


def _read_polygon_body(cur: _Cursor, little_endian: bool, dim: int) -> list[list[tuple[float, float]]]:
    """Read a polygon body (after byte order and type) into a list of rings.

    Each ring is a list of (x, y) pairs. Z and M ordinates, if present per the
    dimension, are read and discarded: the spike compares planar geometry.
    """
    fmt_pt = ("<" if little_endian else ">") + ("d" * dim)
    point_size = dim * 8
    num_rings = _read_uint32(cur, little_endian)
    rings: list[list[tuple[float, float]]] = []
    for _ in range(num_rings):
        num_points = _read_uint32(cur, little_endian)
        raw = cur.take(num_points * point_size)
        ring: list[tuple[float, float]] = []
        for off in range(0, len(raw), point_size):
            vals = struct.unpack_from(fmt_pt, raw, off)
            ring.append((vals[0], vals[1]))
        rings.append(ring)
    return rings


def _read_geometry(cur: _Cursor) -> tuple[str, list]:
    """Read one WKB geometry. Returns (geom_type_name, list-of-rings-or-polys)."""
    byte_order = cur.take(1)[0]
    if byte_order not in (0, 1):
        raise BlobError(f"invalid WKB byte order {byte_order}")
    little_endian = byte_order == 1
    raw_type = _read_uint32(cur, little_endian)
    if raw_type & 0x20000000:  # EWKB SRID flag: consume the 4-byte SRID
        cur.take(4)
    base, dim = _normalize_wkb_type(raw_type)
    if base == 3:  # Polygon
        return "Polygon", _read_polygon_body(cur, little_endian, dim)
    if base == 6:  # MultiPolygon
        num_polys = _read_uint32(cur, little_endian)
        polys: list[list[list[tuple[float, float]]]] = []
        for _ in range(num_polys):
            sub_order = cur.take(1)[0]
            if sub_order not in (0, 1):
                raise BlobError(f"invalid MultiPolygon member byte order {sub_order}")
            sub_le = sub_order == 1
            sub_raw = _read_uint32(cur, sub_le)
            if sub_raw & 0x20000000:
                cur.take(4)
            sub_base, sub_dim = _normalize_wkb_type(sub_raw)
            if sub_base != 3:
                raise BlobError(f"MultiPolygon member type {sub_base} is not Polygon")
            polys.append(_read_polygon_body(cur, sub_le, sub_dim))
        return "MultiPolygon", polys
    raise BlobError(f"unsupported geometry base type {base} (spike reads Polygon and MultiPolygon)")


# Envelope indicator -> byte length, per the StandardGeoPackageBinary header.
_ENVELOPE_BYTES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}


def decode_gpkg_blob(blob: bytes) -> dict:
    """Decode a StandardGeoPackageBinary blob into its header fields and geometry.

    Returns a dict with srs_id, the header envelope (if present), the empty flag,
    the geometry type name, and the decoded rings or polygons.
    """
    if len(blob) < 8:
        raise BlobError("blob shorter than the 8-byte GeoPackage header")
    if blob[0:2] != b"GP":
        raise BlobError(f"bad magic {blob[0:2]!r}, expected b'GP'")
    version = blob[2]
    flags = blob[3]
    header_little_endian = bool(flags & 0x01)
    envelope_indicator = (flags >> 1) & 0x07
    empty = bool(flags & 0x10)
    extended = bool(flags & 0x20)
    if extended:
        raise BlobError("ExtendedGeoPackageBinary is out of spike scope")
    if envelope_indicator not in _ENVELOPE_BYTES:
        raise BlobError(f"invalid envelope indicator {envelope_indicator}")
    hdr_fmt = "<i" if header_little_endian else ">i"
    srs_id = struct.unpack(hdr_fmt, blob[4:8])[0]

    env_len = _ENVELOPE_BYTES[envelope_indicator]
    env_end = 8 + env_len
    envelope = None
    if env_len:
        ndoubles = env_len // 8
        dfmt = ("<" if header_little_endian else ">") + ("d" * ndoubles)
        env_vals = struct.unpack(dfmt, blob[8:env_end])
        # Layout is minx, maxx, miny, maxy first regardless of Z/M extras.
        envelope = {
            "minx": env_vals[0],
            "maxx": env_vals[1],
            "miny": env_vals[2],
            "maxy": env_vals[3],
        }

    result = {
        "version": version,
        "srs_id": srs_id,
        "envelope": envelope,
        "envelope_indicator": envelope_indicator,
        "empty": empty,
        "geom_type": None,
        "rings": [],
        "polys": [],
    }
    if empty:
        return result

    cur = _Cursor(blob, env_end)
    geom_type, body = _read_geometry(cur)
    result["geom_type"] = geom_type
    if geom_type == "Polygon":
        result["rings"] = body
    else:  # MultiPolygon
        result["polys"] = body
    if cur.remaining() != 0:
        # Not fatal, but a real decoder consumes the whole blob. Surface it.
        raise BlobError(f"{cur.remaining()} trailing bytes after geometry (decode misaligned)")
    return result


def summarize_geometry(decoded: dict) -> dict:
    """Reduce a decoded geometry to the comparable summary the contract names.

    The summary is the total decoded vertex count, the first ring vertex count,
    the decoded bounding box of the first ring, and the leading vertices of the
    first ring (for a readable diff). The full first ring is kept for the
    bit-for-bit cross-check.
    """
    geom_type = decoded["geom_type"]
    if geom_type == "Polygon":
        rings = decoded["rings"]
        polygon_count = 1
    elif geom_type == "MultiPolygon":
        rings = [ring for poly in decoded["polys"] for ring in poly]
        polygon_count = len(decoded["polys"])
    else:
        rings = []
        polygon_count = 0

    total_vertices = sum(len(r) for r in rings)
    first_ring = rings[0] if rings else []
    first_ring_bbox = _bbox_of_points(first_ring)
    whole_geom_bbox = _bbox_of_points([p for ring in rings for p in ring])

    return {
        "geom_type": geom_type,
        "wkb_type": 3 if geom_type == "Polygon" else (6 if geom_type == "MultiPolygon" else None),
        "total_vertices": total_vertices,
        "polygon_count": polygon_count,
        "ring_count": len(rings),
        "first_ring_vertices": len(first_ring),
        "first_ring_bbox": first_ring_bbox,
        "whole_geom_bbox": whole_geom_bbox,
        "first_ring_head": first_ring[:HEAD_VERTICES],
        "first_ring": first_ring,
    }


def _bbox_of_points(points: list[tuple[float, float]]) -> dict | None:
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"minx": min(xs), "maxx": max(xs), "miny": min(ys), "maxy": max(ys)}


# --------------------------------------------------------------------------- #
# Database access
# --------------------------------------------------------------------------- #

def open_immutable(gpkg_path: str) -> sqlite3.Connection:
    """Open the GeoPackage read-only and immutable, the read-only-mount path.

    immutable=1 tells SQLite the file cannot change underneath it: no locking,
    no journal, works on a read-only mount. This mirrors the Rust open flags.
    """
    abspath = os.path.abspath(gpkg_path)
    if not os.path.exists(abspath):
        raise FileNotFoundError(abspath)
    uri = f"file:{pathname2url(abspath)}?immutable=1"
    return sqlite3.connect(uri, uri=True)


def oracle_for_bbox(conn: sqlite3.Connection, bbox: dict) -> tuple[list[int], dict]:
    """Run the R-tree query for one bbox and decode every candidate geometry."""
    rows = conn.execute(RTREE_QUERY, bbox).fetchall()
    fids = [int(r[0]) for r in rows]
    geoms: dict[int, dict] = {}
    for fid in fids:
        row = conn.execute("SELECT geom FROM regions WHERE fid = ?", (fid,)).fetchone()
        if row is None:
            raise BlobError(f"rtree id {fid} has no matching regions row")
        decoded = decode_gpkg_blob(bytes(row[0]))
        geoms[fid] = summarize_geometry(decoded)
    return fids, geoms


# --------------------------------------------------------------------------- #
# Structural authenticity validation
# --------------------------------------------------------------------------- #

def structural_checks(conn: sqlite3.Connection) -> dict:
    """Confirm the file is a structurally real OGC GeoPackage."""
    app_id = conn.execute("PRAGMA application_id").fetchone()[0]
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]

    names = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        ).fetchall()
    }
    required_tables = (
        "gpkg_spatial_ref_sys",
        "gpkg_contents",
        "gpkg_geometry_columns",
    )

    feature_count = conn.execute("SELECT count(*) FROM regions").fetchone()[0]
    rtree_count = conn.execute("SELECT count(*) FROM rtree_regions_geom").fetchone()[0]

    checks = {
        "sqlite_version": sqlite3.sqlite_version,
        "application_id": app_id,
        "application_id_ok": app_id == GPKG_APPLICATION_ID,
        "user_version": user_version,
        "user_version_ok": user_version == GPKG_USER_VERSION,
        "tables_present": {t: (t in names) for t in required_tables},
        "tables_ok": all(t in names for t in required_tables),
        "feature_count": feature_count,
        "rtree_count": rtree_count,
        "rtree_matches_features": feature_count == rtree_count,
    }
    checks["all_ok"] = (
        checks["application_id_ok"]
        and checks["user_version_ok"]
        and checks["tables_ok"]
        and checks["rtree_matches_features"]
    )
    return checks


def gitignore_status(gpkg_path: str) -> dict:
    """Confirm the sample is git-ignored, so it can never be committed.

    Uses `git check-ignore`, which exits 0 and echoes the path when it is
    ignored. This backs the verdict claim that the GeoPackage stays out of the
    repository and out of any npm tarball.
    """
    abspath = os.path.abspath(gpkg_path)
    try:
        proc = subprocess.run(
            ["git", "check-ignore", abspath],
            capture_output=True, text=True, timeout=15,
            cwd=os.path.dirname(abspath) or ".",
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"ignored": None, "detail": f"git check-ignore unavailable: {exc}"}
    return {"ignored": proc.returncode == 0, "detail": proc.stdout.strip()}


def gdal_authenticity(data_dir: str, timeout_seconds: int = 90) -> dict:
    """Best-effort: open the file with GDAL's ogrinfo in a throwaway container.

    Time-bounded and never fatal. If podman is missing, the image pull is slow,
    or the run fails, we report that and rely on the structural checks instead,
    exactly as the contract allows.
    """
    result = {"attempted": True, "method": "podman ogrinfo (gdal:alpine-small)", "ok": False, "detail": ""}
    abs_dir = os.path.abspath(data_dir)
    cmd = [
        "podman", "run", "--rm",
        "-v", f"{abs_dir}:/d:ro",
        "ghcr.io/osgeo/gdal:alpine-small-latest",
        "ogrinfo", "-so", "/d/sample.gpkg", "regions",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_seconds
        )
    except FileNotFoundError:
        result["detail"] = "podman not found"
        return result
    except subprocess.TimeoutExpired:
        result["detail"] = f"timed out after {timeout_seconds}s (image pull too slow)"
        return result
    if proc.returncode == 0:
        result["ok"] = True
        result["detail"] = proc.stdout.strip()
    else:
        result["detail"] = (proc.stderr or proc.stdout).strip()[:2000]
    return result


# --------------------------------------------------------------------------- #
# Vector loading
# --------------------------------------------------------------------------- #

def _bbox_from_vector(vec: dict) -> dict:
    """Pull a {minx,miny,maxx,maxy} bbox out of a vector record.

    Accepts either a nested "bbox" object or flat keys, since the vectors.json
    schema is owned by cartographer. Fails loudly on anything unrecognized.
    """
    src = vec.get("bbox", vec)
    try:
        return {
            "minx": float(src["minx"]),
            "miny": float(src["miny"]),
            "maxx": float(src["maxx"]),
            "maxy": float(src["maxy"]),
        }
    except (KeyError, TypeError) as exc:
        raise SystemExit(
            f"vector {vec!r} has no usable bbox (need minx/miny/maxx/maxy): {exc}"
        )


def _expected_fids(vec: dict) -> list[int] | None:
    for key in ("expected_fids", "expected", "fids"):
        if key in vec:
            return sorted(int(x) for x in vec[key])
    return None


def load_vectors(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        # Allow a wrapper like {"vectors": [...]}.
        data = data.get("vectors", data.get("cases", []))
    norm = []
    for i, vec in enumerate(data):
        norm.append({
            "name": vec.get("name") or vec.get("label") or vec.get("case") or f"vector_{i}",
            "case": vec.get("case") or vec.get("kind") or "",
            "bbox": _bbox_from_vector(vec),
            "expected_fids": _expected_fids(vec),
        })
    return norm


# --------------------------------------------------------------------------- #
# Cross-check against the Rust binary (ferro)
# --------------------------------------------------------------------------- #

def run_ferro_json(ferro_bin: str, gpkg_path: str, bbox: dict) -> dict:
    """Invoke the Rust binary and parse its JSON output for one bbox.

    CLI (confirmed against the binary): `storage-spike --db <path> minx miny
    maxx maxy`, bbox as positional args in that order. The binary parses leading
    hyphens as negative numbers, so western/southern coordinates pass directly.
    repr() preserves full f64 precision. Output is JSON on stdout.
    """
    cmd = [
        ferro_bin, "--db", gpkg_path,
        repr(bbox["minx"]), repr(bbox["miny"]),
        repr(bbox["maxx"]), repr(bbox["maxy"]),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise SystemExit(
            f"ferro exited {proc.returncode} for bbox {bbox}\nstderr: {proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ferro JSON parse failed: {exc}\nstdout was:\n{proc.stdout}")


def _coords_match(oracle_pts, ferro_pts) -> bool:
    """Bit-for-bit (within epsilon) comparison of two full point lists."""
    if oracle_pts is None or ferro_pts is None:
        return oracle_pts is None and ferro_pts is None
    if len(oracle_pts) != len(ferro_pts):
        return False
    for (ax, ay), (bx, by) in zip(oracle_pts, ferro_pts):
        if abs(ax - bx) > COORD_EPSILON or abs(ay - by) > COORD_EPSILON:
            return False
    return True


def _bbox_match(oracle_bbox, ferro_bbox) -> bool:
    """Compare two {minx,miny,maxx,maxy} dicts within tolerance."""
    if oracle_bbox is None or ferro_bbox is None:
        return oracle_bbox is None and ferro_bbox is None
    try:
        return all(
            abs(oracle_bbox[k] - ferro_bbox[k]) <= COORD_EPSILON
            for k in ("minx", "miny", "maxx", "maxy")
        )
    except (KeyError, TypeError):
        return False


def diff_vector(name: str, oracle_fids: list[int], oracle_geoms: dict, ferro: dict) -> list[str]:
    """Return a list of mismatch strings for one vector. Empty means agreement.

    Compares the full ferro JSON schema: the candidate fid set, the top-level
    total_vertices, and per feature the geom_type, vertex count, polygon count,
    ring count, srs_id, whole-geometry bbox, first-ring bbox, and the entire
    first ring at full precision.
    """
    problems: list[str] = []

    ferro_fids = sorted(int(x) for x in ferro.get("fids", []))
    if ferro_fids != oracle_fids:
        problems.append(f"fid set differs: oracle={oracle_fids} ferro={ferro_fids}")

    oracle_total = sum(oracle_geoms[fid]["total_vertices"] for fid in oracle_fids)
    if ferro.get("total_vertices") != oracle_total:
        problems.append(
            f"top-level total_vertices oracle={oracle_total} ferro={ferro.get('total_vertices')}"
        )

    ferro_features = {int(f["fid"]): f for f in ferro.get("features", [])}
    for fid in oracle_fids:
        o = oracle_geoms[fid]
        f = ferro_features.get(fid)
        if f is None:
            problems.append(f"fid {fid}: ferro returned no feature summary")
            continue
        if f.get("geom_type") != o["geom_type"]:
            problems.append(
                f"fid {fid}: geom_type oracle={o['geom_type']} ferro={f.get('geom_type')}"
            )
        if f.get("total_vertices") != o["total_vertices"]:
            problems.append(
                f"fid {fid}: total_vertices oracle={o['total_vertices']} ferro={f.get('total_vertices')}"
            )
        if f.get("polygons") != o["polygon_count"]:
            problems.append(
                f"fid {fid}: polygons oracle={o['polygon_count']} ferro={f.get('polygons')}"
            )
        if f.get("rings") != o["ring_count"]:
            problems.append(f"fid {fid}: rings oracle={o['ring_count']} ferro={f.get('rings')}")
        if f.get("srs_id") != 4326:
            problems.append(f"fid {fid}: srs_id {f.get('srs_id')} != 4326")
        if not _bbox_match(o["whole_geom_bbox"], f.get("feature_bbox")):
            problems.append(
                f"fid {fid}: feature_bbox oracle={o['whole_geom_bbox']} ferro={f.get('feature_bbox')}"
            )
        if not _bbox_match(o["first_ring_bbox"], f.get("first_ring_bbox")):
            problems.append(
                f"fid {fid}: first_ring_bbox oracle={o['first_ring_bbox']} ferro={f.get('first_ring_bbox')}"
            )
        if not _coords_match(o["first_ring"], f.get("first_ring")):
            problems.append(
                f"fid {fid}: full first_ring coordinates differ "
                f"(len oracle={len(o['first_ring'])} ferro={len(f.get('first_ring') or [])})"
            )
    return problems


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #

def _print_oracle(vectors: list[dict], conn: sqlite3.Connection) -> int:
    rc = 0
    for vec in vectors:
        fids, geoms = oracle_for_bbox(conn, vec["bbox"])
        exp = vec["expected_fids"]
        tag = ""
        if exp is not None:
            ok = fids == exp
            tag = "  EXPECTED-OK" if ok else f"  EXPECTED-MISMATCH expected={exp}"
            if not ok:
                rc = 1
        print(f"[{vec['name']}] case={vec['case']!r} bbox={vec['bbox']}")
        print(f"  fids={fids}{tag}")
        for fid in fids:
            g = geoms[fid]
            print(
                f"    fid {fid}: {g['geom_type']} vertices={g['total_vertices']} "
                f"first_ring_vertices={g['first_ring_vertices']} "
                f"first_ring_bbox={g['first_ring_bbox']}"
            )
            head = ", ".join(f"({x:.6f},{y:.6f})" for x, y in g["first_ring_head"])
            print(f"      first_ring_head: {head}")
    return rc


def _print_structure(conn: sqlite3.Connection, gpkg_path: str, run_gdal: bool) -> int:
    data_dir = os.path.dirname(os.path.abspath(gpkg_path))
    checks = structural_checks(conn)
    print("Structural authenticity checks")
    print(f"  sqlite_version: {checks['sqlite_version']}")
    print(f"  application_id: 0x{checks['application_id'] & 0xFFFFFFFF:08X} "
          f"({'OK' if checks['application_id_ok'] else 'WRONG, expected 0x47504B47'})")
    print(f"  user_version:   {checks['user_version']} "
          f"({'OK' if checks['user_version_ok'] else 'WRONG, expected 10301'})")
    for tbl, present in checks["tables_present"].items():
        print(f"  table {tbl}: {'present' if present else 'MISSING'}")
    print(f"  feature_count: {checks['feature_count']}  rtree_count: {checks['rtree_count']} "
          f"({'match' if checks['rtree_matches_features'] else 'MISMATCH'})")
    gi = gitignore_status(gpkg_path)
    if gi["ignored"] is True:
        print(f"  git-ignored: yes ({gi['detail']})")
    elif gi["ignored"] is False:
        print("  git-ignored: NO (sample is committable, should be gitignored)")
    else:
        print(f"  git-ignored: unknown ({gi['detail']})")
    print(f"  structural verdict: {'PASS' if checks['all_ok'] else 'FAIL'}")
    if run_gdal:
        print("  GDAL authenticity (podman ogrinfo):")
        g = gdal_authenticity(data_dir)
        print(f"    ok={g['ok']} method={g['method']}")
        print(f"    detail: {g['detail'][:500]}")
    return 0 if checks["all_ok"] else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Independent verifier for the storage spike")
    parser.add_argument("mode", choices=["oracle", "structure", "crosscheck", "all"])
    parser.add_argument("--gpkg", default="container/storage-spike/data/sample.gpkg")
    parser.add_argument("--vectors", default="container/storage-spike/vectors.json")
    parser.add_argument("--ferro", default=None, help="path to the Rust release binary")
    parser.add_argument("--gdal", action="store_true", help="also try GDAL ogrinfo via podman")
    args = parser.parse_args(argv)

    if not os.path.exists(args.gpkg):
        print(f"SKIP: GeoPackage not found at {args.gpkg} (waiting on the sample)", file=sys.stderr)
        return 2

    conn = open_immutable(args.gpkg)
    rc = 0
    try:
        if args.mode in ("structure", "all"):
            rc |= _print_structure(conn, args.gpkg, run_gdal=args.gdal)
        if args.mode in ("oracle", "all"):
            print()
            rc |= _print_oracle(load_vectors(args.vectors), conn)
        if args.mode in ("crosscheck", "all"):
            if not args.ferro:
                print("crosscheck needs --ferro <binary>", file=sys.stderr)
                return 2
            print()
            vectors = load_vectors(args.vectors)
            gpkg_abs = os.path.abspath(args.gpkg)
            any_fail = False
            for vec in vectors:
                fids, geoms = oracle_for_bbox(conn, vec["bbox"])
                ferro = run_ferro_json(args.ferro, gpkg_abs, vec["bbox"])
                problems = diff_vector(vec["name"], fids, geoms, ferro)
                status = "AGREE" if not problems else "DISAGREE"
                print(f"[{vec['name']}] case={vec['case']!r} {status} oracle_fids={fids}")
                for p in problems:
                    print(f"    - {p}")
                    any_fail = True
            rc |= 1 if any_fail else 0
    finally:
        conn.close()
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
