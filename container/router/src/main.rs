use binnacle_router::app;
use std::env;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("healthcheck") {
        std::process::exit(healthcheck().await);
    }

    let port = router_port();
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind router port");
    println!("binnacle-router listening on 0.0.0.0:{port}");
    axum::serve(listener, app()).await.expect("serve router");
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
