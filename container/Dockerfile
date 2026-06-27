# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS builder
WORKDIR /build
# The router binary depends on the sibling engine crate by relative path (`../engine`), so
# both crates must be copied into the build context with that layout before building. The
# engine's `.cargo/config.toml` (which disables x86_64 FMA contraction for parity) is placed
# at the common build root so its rustflags apply to the engine code compiled into the
# router binary, not just to a standalone engine build.
COPY engine/.cargo/config.toml .cargo/config.toml
COPY engine/Cargo.toml engine/Cargo.toml
COPY engine/src engine/src
COPY router/Cargo.toml router/Cargo.lock router/
COPY router/src router/src
WORKDIR /build/router
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/router/target \
    cargo build --release --bin router \
 && cp target/release/router /router

FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=builder /router /router
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/router", "healthcheck"]
ENTRYPOINT ["/router"]
