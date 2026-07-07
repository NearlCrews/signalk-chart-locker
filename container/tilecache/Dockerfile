# syntax=docker/dockerfile:1.7

# The tilecache image is separate from the offline router image, so internet egress is isolated from
# the routing engine. Build with `podman build --format docker` or the HEALTHCHECK is dropped.

FROM rust:1-bookworm AS builder
WORKDIR /build
# cmake is needed by the aws-lc-rs crypto backend that rustls pulls in; rust:1-bookworm ships cc but
# not cmake. It is a build-only dependency: the runtime image gets only the static binary.
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
# Copy the whole workspace: cargo loads every member manifest even to build one binary. The root
# .cargo/config.toml (the FMA determinism flag) applies automatically.
COPY Cargo.toml Cargo.lock ./
COPY .cargo ./.cargo
COPY tilecache ./tilecache
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --bin tilecache \
 && cp target/release/tilecache /tilecache

# Egress TLS uses rustls-platform-verifier: it reads the runtime base image's CA bundle through
# rustls-native-certs (/etc/ssl/certs, from ca-certificates, which distroless/cc-debian12 ships), with
# a bundled webpki-root-certs fallback if that is absent. Currently fine on this base. If the runtime
# base is ever swapped to a CA-less image (distroless/static or scratch), egress TLS would fail
# silently, so keep a CA bundle in whatever runtime base replaces this one.
FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=builder /tilecache /tilecache
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/tilecache", "healthcheck"]
ENTRYPOINT ["/tilecache"]
