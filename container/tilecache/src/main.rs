//! The tilecache binary entrypoint. Mirrors the router binary: a `healthcheck` subcommand for the
//! container HEALTHCHECK, env-driven port, DB path, and cap, and a graceful SIGTERM and SIGINT
//! shutdown. The cache DB lives on the mounted volume the plugin configures.

use chart_locker_tilecache::cache::TileCache;
use chart_locker_tilecache::routes::app;
use chart_locker_tilecache::state::{AppState, Knobs};
use std::path::Path;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck());
    }

    let port = tilecache_port();
    let db = std::env::var("TILECACHE_DB").unwrap_or_else(|_| "/data/tilecache.sqlite".to_string());
    let cap = std::env::var("TILECACHE_CAP_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_147_483_648i64);
    let scroll_ttl_secs = std::env::var("TILECACHE_SCROLL_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0i64);
    // Production never sets this; it exists for a same-host dev or test against a private upstream.
    let allow_private = std::env::var("TILECACHE_ALLOW_PRIVATE").as_deref() == Ok("1");

    if let Some(parent) = Path::new(&db).parent() {
        // Migrate the legacy cache dir BEFORE creating the current one: create_dir_all would otherwise
        // create the current dir first, the migration would skip, and the warmed legacy cache would be
        // orphaned and the cache would start cold.
        chart_locker_tilecache::cache::migrate_legacy_cache_dir(parent);
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "tilecache: could not create cache directory {}: {e}",
                parent.display()
            );
        }
    }
    let cache = Arc::new(open_or_recreate(Path::new(&db)));
    let knobs = Knobs {
        cap_bytes: cap,
        scroll_ttl_secs,
        allow_private_egress: allow_private,
        ..Default::default()
    };
    let state = AppState::new(cache, knobs);

    tokio::spawn(chart_locker_tilecache::sweep::run_sweeper(state.clone()));

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind the tilecache port");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve");
}

/// Open the disposable cache DB, and on a failure that is not a stale schema (open() rebuilds the table
/// for that) delete the DB and its WAL and shm sidecars once and reopen, so a corrupt cache self-heals
/// instead of crash-looping the container. A second failure is fatal.
fn open_or_recreate(path: &Path) -> TileCache {
    match TileCache::open(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "tilecache: opening the cache DB {} failed: {e}; recreating it",
                path.display()
            );
            for suffix in ["", "-wal", "-shm"] {
                let p = if suffix.is_empty() {
                    path.to_path_buf()
                } else {
                    std::path::PathBuf::from(format!("{}{}", path.display(), suffix))
                };
                let _ = std::fs::remove_file(&p);
            }
            TileCache::open(path)
                .expect("recreate the tile cache DB after removing the corrupt one")
        }
    }
}

fn tilecache_port() -> u16 {
    std::env::var("TILECACHE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080)
}

/// Connect to the local port; exit 0 if the service is listening, else 1. Used by the container
/// HEALTHCHECK on a distroless image that has no shell.
fn healthcheck() -> i32 {
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = format!("127.0.0.1:{}", tilecache_port());
    match addr.parse() {
        Ok(sa) => {
            if TcpStream::connect_timeout(&sa, Duration::from_secs(3)).is_ok() {
                0
            } else {
                1
            }
        }
        Err(_) => 1,
    }
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv() => {},
    }
}
