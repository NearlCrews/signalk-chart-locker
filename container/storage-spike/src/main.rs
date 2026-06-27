//! Storage tracer spike: open a real GeoPackage read-only, run an R-tree
//! bounding-box query, and decode the candidate polygon geometry with a
//! pure-Rust decoder (see `gpkg`). The point is to prove the offline storage
//! path on aarch64 with no geospatial C libraries linked.
//!
//! Usage (the bbox may be positional or given as flags, and the db path may be
//! a leading positional or `--db <path>`; `--json` is accepted and is a no-op
//! because stdout is always JSON):
//!   storage-spike [<path> | --db <path>] [--json] <minx> <miny> <maxx> <maxy>
//!   storage-spike <path> --minx A --miny B --maxx C --maxy D --json
//!
//! Default db path is `data/sample.gpkg` relative to the current directory.
//! Output is JSON on stdout so a reference reader can diff it field for field.

mod gpkg;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rusqlite::{params, Connection, OpenFlags};
use serde_json::json;

use gpkg::Geometry;

const DEFAULT_DB: &str = "data/sample.gpkg";

#[derive(Debug, Clone, Copy)]
struct Bbox {
    minx: f64,
    miny: f64,
    maxx: f64,
    maxy: f64,
}

struct Args {
    db: PathBuf,
    bbox: Bbox,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args(std::env::args().skip(1))?;
    let conn = open_readonly(&args.db)?;
    let report = query(&conn, &args.bbox)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn usage() -> String {
    "usage: storage-spike [<path> | --db <path>] [--json] \
     (--minx A --miny B --maxx C --maxy D | <minx> <miny> <maxx> <maxy>)"
        .to_string()
}

/// Resolve a flag's value: use the inline `--flag=value` part if present,
/// otherwise consume the next argument as a space-separated value.
fn flag_value<I: Iterator<Item = String>>(
    inline: Option<String>,
    it: &mut I,
    flag: &str,
) -> Result<String, String> {
    match inline {
        Some(v) => Ok(v),
        None => it
            .next()
            .ok_or_else(|| format!("{flag} needs a value\n{}", usage())),
    }
}

fn flag_num<I: Iterator<Item = String>>(
    inline: Option<String>,
    it: &mut I,
    flag: &str,
) -> Result<f64, String> {
    let s = flag_value(inline, it, flag)?;
    s.parse::<f64>()
        .map_err(|_| format!("{flag} value is not a number: {s}\n{}", usage()))
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut db: Option<PathBuf> = None;
    let (mut minx, mut miny, mut maxx, mut maxy) = (None, None, None, None);
    let mut positional: Vec<f64> = Vec::new();
    let mut it = args;
    while let Some(arg) = it.next() {
        // Accept both "--flag value" and "--flag=value". The equals form keeps a
        // leading-hyphen value such as --minx=-122.45 from looking like a flag.
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        match key.as_str() {
            "--db" => db = Some(PathBuf::from(flag_value(inline, &mut it, "--db")?)),
            "--minx" => minx = Some(flag_num(inline, &mut it, "--minx")?),
            "--miny" => miny = Some(flag_num(inline, &mut it, "--miny")?),
            "--maxx" => maxx = Some(flag_num(inline, &mut it, "--maxx")?),
            "--maxy" => maxy = Some(flag_num(inline, &mut it, "--maxy")?),
            "--json" => {} // accepted: stdout is always JSON.
            "-h" | "--help" => return Err(usage()),
            _ => {
                // A token that parses as a float is a positional bbox coordinate
                // (this is what lets a leading "-8" be a number, not a flag). A
                // non-numeric token is the db path; anything else starting with
                // "-" is an unknown flag.
                if let Ok(value) = arg.parse::<f64>() {
                    positional.push(value);
                } else if arg.starts_with('-') {
                    return Err(format!("unknown flag: {arg}\n{}", usage()));
                } else if db.is_none() {
                    db = Some(PathBuf::from(arg));
                } else {
                    return Err(format!("unexpected argument: {arg}\n{}", usage()));
                }
            }
        }
    }

    let flag_bbox = match (minx, miny, maxx, maxy) {
        (Some(minx), Some(miny), Some(maxx), Some(maxy)) => Some(Bbox {
            minx,
            miny,
            maxx,
            maxy,
        }),
        (None, None, None, None) => None,
        _ => {
            return Err(format!(
                "provide all four of --minx, --miny, --maxx, and --maxy\n{}",
                usage()
            ))
        }
    };
    let bbox = match (flag_bbox, positional.len()) {
        (Some(b), 0) => b,
        (Some(_), _) => {
            return Err(format!(
                "provide the bbox via flags or positionally, not both\n{}",
                usage()
            ))
        }
        (None, 4) => Bbox {
            minx: positional[0],
            miny: positional[1],
            maxx: positional[2],
            maxy: positional[3],
        },
        (None, n) => {
            return Err(format!(
                "expected 4 bbox numbers (minx miny maxx maxy), got {n}\n{}",
                usage()
            ))
        }
    };

    Ok(Args {
        db: db.unwrap_or_else(|| PathBuf::from(DEFAULT_DB)),
        bbox,
    })
}

/// Open the GeoPackage read-only and immutable. `immutable=1` tells SQLite the
/// file will not change, so it skips the lock and WAL machinery: that is what
/// lets the engine read from a read-only mount with no sidecar files.
fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    let uri = format!("file:{}?immutable=1", path.display());
    Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
}

/// R-tree candidate query from the contract. The R-tree stores each feature's
/// envelope; a row is a candidate when its envelope overlaps the query bbox.
fn candidate_fids(conn: &Connection, bbox: &Bbox) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM rtree_regions_geom \
         WHERE minx <= ?1 AND maxx >= ?2 AND miny <= ?3 AND maxy >= ?4 \
         ORDER BY id",
    )?;
    let rows = stmt.query_map(
        params![bbox.maxx, bbox.minx, bbox.maxy, bbox.miny],
        |row| row.get::<_, i64>(0),
    )?;
    rows.collect()
}

fn load_geometry(conn: &Connection, fid: i64) -> Result<Geometry, Box<dyn std::error::Error>> {
    let blob: Vec<u8> =
        conn.query_row("SELECT geom FROM regions WHERE fid = ?1", params![fid], |row| {
            row.get(0)
        })?;
    Ok(gpkg::decode(&blob)?)
}

/// Turn an optional `[minx, miny, maxx, maxy]` into a JSON object or null.
fn bbox_obj(b: Option<[f64; 4]>) -> serde_json::Value {
    match b {
        Some([minx, miny, maxx, maxy]) => json!({
            "minx": minx, "miny": miny, "maxx": maxx, "maxy": maxy,
        }),
        None => serde_json::Value::Null,
    }
}

/// Run the candidate query, decode every candidate, and build the JSON report.
/// Features come out in ascending fid order (the candidate query is ORDER BY id).
/// `first_ring` is the full exterior ring at full f64 precision so a reference
/// reader can diff geometry bit for bit, not just counts.
fn query(conn: &Connection, bbox: &Bbox) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let fids = candidate_fids(conn, bbox)?;
    let mut features = Vec::with_capacity(fids.len());
    let mut total_vertices = 0usize;
    for fid in &fids {
        let geom = load_geometry(conn, *fid)?;
        total_vertices += geom.vertex_count();
        let first_ring: Vec<gpkg::Point> = geom.first_ring().cloned().unwrap_or_default();
        features.push(json!({
            "fid": fid,
            "geom_type": geom.geom_type_name(),
            "srs_id": geom.srs_id,
            "polygons": geom.polygons.len(),
            "rings": geom.ring_count(),
            "total_vertices": geom.vertex_count(),
            "feature_bbox": bbox_obj(geom.bounds()),
            "first_ring_bbox": bbox_obj(geom.first_ring_bounds()),
            "first_ring": first_ring,
        }));
    }
    Ok(json!({
        "bbox": {
            "minx": bbox.minx, "miny": bbox.miny, "maxx": bbox.maxx, "maxy": bbox.maxy,
        },
        "fids": fids,
        "total_vertices": total_vertices,
        "features": features,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("data/sample.gpkg")
    }

    fn vectors_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors.json")
    }

    #[test]
    fn parse_args_reads_db_and_bbox() {
        let argv = ["--db", "/x/y.gpkg", "-122.5", "37.7", "-122.4", "37.8"]
            .into_iter()
            .map(String::from);
        let args = parse_args(argv).expect("parse");
        assert_eq!(args.db, PathBuf::from("/x/y.gpkg"));
        assert_eq!(args.bbox.minx, -122.5);
        assert_eq!(args.bbox.maxy, 37.8);
    }

    #[test]
    fn parse_args_rejects_wrong_count() {
        let argv = ["1.0", "2.0", "3.0"].into_iter().map(String::from);
        assert!(parse_args(argv).is_err());
    }

    #[test]
    fn parse_args_reads_flag_form_and_leading_path() {
        // checksum's invocation: leading path positional, bbox via flags, --json.
        let argv = [
            "data/sample.gpkg",
            "--minx",
            "-8",
            "--miny",
            "50",
            "--maxx",
            "2",
            "--maxy",
            "58",
            "--json",
        ]
        .into_iter()
        .map(String::from);
        let args = parse_args(argv).expect("parse");
        assert_eq!(args.db, PathBuf::from("data/sample.gpkg"));
        assert_eq!(args.bbox.minx, -8.0);
        assert_eq!(args.bbox.maxy, 58.0);
    }

    #[test]
    fn parse_args_rejects_mixing_flags_and_positional_bbox() {
        let argv = ["--minx", "-8", "--miny", "50", "--maxx", "2", "--maxy", "58", "1.0"]
            .into_iter()
            .map(String::from);
        assert!(parse_args(argv).is_err());
    }

    /// Pull a bbox from a case object. Accepts the flat `minx/miny/maxx/maxy`
    /// schema vectors.json uses, or a `bbox: [minx, miny, maxx, maxy]` array.
    fn case_bbox(case: &serde_json::Value) -> Option<Bbox> {
        let field = |k: &str| case.get(k).and_then(|v| v.as_f64());
        if let (Some(minx), Some(miny), Some(maxx), Some(maxy)) =
            (field("minx"), field("miny"), field("maxx"), field("maxy"))
        {
            return Some(Bbox { minx, miny, maxx, maxy });
        }
        let a = case.get("bbox")?.as_array()?;
        if a.len() != 4 {
            return None;
        }
        Some(Bbox {
            minx: a[0].as_f64()?,
            miny: a[1].as_f64()?,
            maxx: a[2].as_f64()?,
            maxy: a[3].as_f64()?,
        })
    }

    /// Pull the expected fid set, tolerating a few likely field names.
    fn case_expected_fids(case: &serde_json::Value) -> Option<Vec<i64>> {
        for key in ["expected_fids", "fids", "expected", "expect"] {
            if let Some(v) = case.get(key) {
                if let Some(arr) = v.as_array() {
                    let mut out: Vec<i64> = arr.iter().filter_map(|x| x.as_i64()).collect();
                    out.sort_unstable();
                    return Some(out);
                }
            }
        }
        None
    }

    /// Normalize the vectors.json document into a list of case objects whether
    /// it is a bare array or an object keyed by "vectors", "cases", or "tests".
    fn cases(doc: &serde_json::Value) -> Vec<serde_json::Value> {
        if let Some(arr) = doc.as_array() {
            return arr.clone();
        }
        for key in ["vectors", "cases", "tests"] {
            if let Some(arr) = doc.get(key).and_then(|v| v.as_array()) {
                return arr.clone();
            }
        }
        Vec::new()
    }

    #[test]
    fn sample_bbox_query_matches_vectors() {
        let sample = sample_path();
        let vectors = vectors_path();
        if !sample.exists() || !vectors.exists() {
            eprintln!(
                "SKIP sample_bbox_query_matches_vectors: missing {} or {} (cartographer has not produced the sample yet)",
                sample.display(),
                vectors.display()
            );
            return;
        }

        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&vectors).expect("read vectors.json"))
                .expect("parse vectors.json");
        let cases = cases(&doc);
        assert!(!cases.is_empty(), "vectors.json had no recognizable cases");

        let conn = open_readonly(&sample).expect("open sample");
        let mut checked = 0;
        for case in &cases {
            let (Some(bbox), Some(expected)) = (case_bbox(case), case_expected_fids(case)) else {
                // A case without a bbox or an expected-fid list is not one we can
                // assert against here; the Python reference reader covers shape.
                continue;
            };
            let mut got = candidate_fids(&conn, &bbox).expect("query");
            got.sort_unstable();
            assert_eq!(
                got, expected,
                "fid mismatch for bbox {:?} (case {})",
                bbox, case
            );
            // Every candidate must also decode without error.
            for fid in &got {
                load_geometry(&conn, *fid).expect("decode candidate geometry");
            }
            checked += 1;
        }
        assert!(checked > 0, "no vectors.json case had both bbox and expected fids");
        eprintln!("checked {checked} bbox vectors against the sample");
    }
}
