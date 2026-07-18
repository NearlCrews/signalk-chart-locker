# syntax=docker/dockerfile:1.7

# The tilecache image is separate from the offline router image, so internet egress is isolated from
# the routing engine. Build from the repository root with
# `podman build --format docker --file container/tilecache/Dockerfile .` or the HEALTHCHECK is dropped.

FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073 AS builder
WORKDIR /build
# cmake is needed by the aws-lc-rs crypto backend that rustls pulls in; rust:1-bookworm ships cc but
# not cmake. It is a build-only dependency: the runtime image gets only the compiled binary.
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
# The repository-root build context makes the project license material available to the runtime
# image. Cargo still receives only the container workspace and its configuration.
COPY container/Cargo.toml container/Cargo.lock ./
COPY container/.cargo ./.cargo
COPY container/tilecache ./tilecache
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release --bin tilecache \
 && cp target/release/tilecache /tilecache \
 && mkdir /runtime-data

# Egress TLS uses rustls-platform-verifier: it reads the runtime base image's CA bundle through
# rustls-native-certs (/etc/ssl/certs, from ca-certificates, which distroless/cc-debian12 ships), with
# a bundled webpki-root-certs fallback if that is absent. Currently fine on this base. If the runtime
# base is ever swapped to a CA-less image (distroless/static or scratch), egress TLS would fail
# silently, so keep a CA bundle in whatever runtime base replaces this one.
FROM gcr.io/distroless/cc-debian12:latest@sha256:7ee09f36862efbdbf70422db263e411c2618409ca46faa555bd5b636155307df AS runtime
COPY --from=builder /tilecache /tilecache
COPY --from=builder --chown=65532:65532 /runtime-data /data
COPY LICENSE-APACHE THIRD_PARTY_NOTICES.md RUST_THIRD_PARTY_LICENSES.md /usr/share/licenses/chart-locker/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/tilecache", "healthcheck"]
USER 65532:65532
ENTRYPOINT ["/tilecache"]
