use binnacle_router::app_with_store;
use std::env;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("healthcheck") {
        std::process::exit(healthcheck().await);
    }

    let store_path =
        std::env::var("BINNACLE_REGION_STORE").ok().map(std::path::PathBuf::from);
    let port = router_port();
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind router port");
    println!("binnacle-router listening on 0.0.0.0:{port}");
    axum::serve(listener, app_with_store(store_path))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve router");
}

/// Resolves when the process receives SIGTERM or SIGINT, so the container stops promptly on
/// `podman stop` instead of ignoring the signal, waiting out the stop timeout, and being
/// SIGKILLed. The distroless runtime has no init to forward signals, so the binary handles
/// them directly.
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = terminate.recv() => {},
        _ = interrupt.recv() => {},
    }
}

fn router_port() -> u16 {
    env::var("ROUTER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080)
}

/// Liveness probe used by the container HEALTHCHECK: a successful TCP connect to
/// the listening port means the server is up. Exits 0 on success, 1 on failure.
async fn healthcheck() -> i32 {
    let connect = tokio::net::TcpStream::connect(("127.0.0.1", router_port()));
    match tokio::time::timeout(std::time::Duration::from_secs(5), connect).await {
        Ok(Ok(_)) => 0,
        _ => 1,
    }
}
