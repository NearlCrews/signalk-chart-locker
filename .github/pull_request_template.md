# Pull Request

## Summary

<!-- 1-3 sentences: what changes and why. Link related issue with "Fixes #N" if applicable. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Dependency update

## Verification

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
- [ ] `npm run check:package` passes
- [ ] `npm run test:browser:cross` passes for panel changes
- [ ] `npm audit` passes when dependencies or release files change
- [ ] For container changes: `cargo test --locked --workspace --all-features`,
  `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`,
  `cargo build --locked --release --bin tilecache --all-features`,
  `cargo audit --file Cargo.lock`,
  `TILECACHE_BIN="$PWD/container/target/release/tilecache" npm run test:node-rust-contract`, and
  `npm run licenses:rust:check` pass
- [ ] Panel changes were checked in a real browser in light, dark, and night-red themes
- [ ] Maintained documentation and App Store screenshots were updated when applicable

## Chart sources, regions, PMTiles, and container affected

<!-- Optional. List affected chart sources (raster overlays, the vector basemap), saved-region or auto-cache behavior, PMTiles chart serving, or tilecache container changes. Remove section if not applicable. Note: any change under container/ requires a plugin version bump, because the image tag is pinned to the plugin version. -->

## Breaking changes / migration

<!-- Remove section if not applicable. Otherwise describe the break and how users migrate. -->
