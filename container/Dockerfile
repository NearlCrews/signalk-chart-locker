# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS builder
WORKDIR /build
COPY router/Cargo.toml router/Cargo.lock ./
COPY router/src ./src
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
