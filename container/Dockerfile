# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS builder
WORKDIR /build
# Build the router binary from the container Cargo workspace. The workspace root
# .cargo/config.toml (which disables x86_64 FMA contraction for parity) applies to every crate
# compiled into the binary automatically, so no per-crate copy is needed. Adding a crate to the
# workspace needs no Dockerfile change beyond a COPY of its directory if the router depends on it.
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
COPY engine ./engine
COPY gpkg ./gpkg
COPY localprovider ./localprovider
COPY router ./router
COPY storage-spike ./storage-spike
# tilecache is a workspace member, so cargo loads its manifest even to build only the router. Its
# directory is copied for that manifest load; the router binary does not depend on it, so none of the
# tilecache networking dependencies are compiled into the router image (it stays offline).
COPY tilecache ./tilecache
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --bin router \
 && cp target/release/router /router

FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=builder /router /router
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/router", "healthcheck"]
ENTRYPOINT ["/router"]
