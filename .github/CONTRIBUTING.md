# Contributing

Thanks for your interest in contributing to Chart Locker (`signalk-chart-locker`).

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Reporting bugs

Check existing issues first to avoid duplicates, then open a bug report with:

- A clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, Signal K server version, container
  runtime, OS)
- Relevant log output

## Suggesting enhancements

Open a feature request issue describing the proposed feature, the use case it
serves, and any implementation ideas you have.

## Pull requests

1. Fork the repository and create a feature branch from `main`.
2. Install the locked dependencies with `npm ci`.
3. Make focused commits with clear messages (see below).
4. Add tests for any new functionality and keep the existing suites green.
5. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:browser:cross`,
   `npm run build`, `npm run check:package`, and `npm audit` before pushing.
6. For container changes, run `cargo test --locked --workspace --all-features`,
   `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings`,
   `cargo build --locked --release --bin tilecache --all-features`, and
   `cargo audit --file Cargo.lock` from `container/`, then run
   `TILECACHE_BIN="$PWD/container/target/release/tilecache" npm run test:node-rust-contract` and
   `npm run licenses:rust:check` from the repository root.
7. Exercise panel layout and interaction changes in a real browser in light, dark, and night-red
   themes. Update the App Store screenshots when the visible panel changes materially.
8. Update the maintained documentation surfaces that apply: `README.md`, `CHANGELOG.md`,
   `docs/OPERATIONS.md`, `docs/API.md`, `.github/SECURITY.md`, and the publish runbook.
9. Open a pull request with a clear description of the change.

## Code style

- The Node plugin is TypeScript under `src/`, compiled to `dist/` by `tsc`.
  The tile-cache service is a Rust Cargo workspace under `container/` with one
  member, `tilecache`, built into a container image.
- Keep modules focused and small. Hoist shared logic into one place (a shared
  module, helper, or crate) rather than duplicating it.
- Lint the TypeScript with ESLint 9 and [neostandard](https://github.com/neostandard/neostandard)
  (`npm run lint`, or `npm run lint:fix` to auto-fix). Lint the Rust with
  `cargo clippy`.
- Do not edit `dist/`; it is generated build output.
- Do not add generated files under retired paths such as `dist/bridge`, `prewarm`, or `route-draft`.
  `npm run check:package` verifies the publication allowlist and rejects retired output plus
  development-only source, test, workflow, container, fixture, and script paths.
- Default to no comments. Add one only when the WHY is non-obvious (a hidden
  constraint, a subtle invariant, or a workaround).

## Architecture rule

This repository ships exactly ONE npm package (the thin Node plugin) plus one
container build artifact (the `tilecache` crate under `container/`). Keep the
code modular by splitting it into focused files under `src/` and one Cargo
workspace under `container/`. Never split the project into multiple npm
packages or a monorepo. The container is a build artifact, not an npm package.
Container lifecycle is delegated to the installed `signalk-container` plugin.

Any change under `container/` requires a plugin version bump: the container
image tag is pinned to the plugin version, so an unchanged tag leaves existing
installs on the stale image.

See the [README](../README.md), [operations guide](../docs/OPERATIONS.md), and
[HTTP API reference](../docs/API.md) for current project behavior and conventions. Files under
`docs/superpowers/` are historical design and implementation records unless explicitly identified as
a maintained runbook.

Executable workflow dependencies are pinned to reviewed commits. Follow the
[dependency-update policy](../docs/DEPENDENCY_UPDATES.md) when advancing an action, reusable workflow,
toolchain, or container base image.

`RUST_THIRD_PARTY_LICENSES.md` is generated from the locked runtime dependency graph. When a Cargo
dependency update changes it, run `npm run licenses:rust:update`, review the resulting attribution and
license texts, then run `npm run licenses:rust:check` before committing both the lockfile and report.
The script downloads checksum-pinned cargo-about 0.9.1 binaries on Linux x64 and arm64. On another
platform, set `CARGO_ABOUT` to the absolute path of a cargo-about 0.9.1 binary.

## Commit messages

Use conventional-commit prefixes that match the actual diff scope:

```text
feat: add a basemap source to the saved-region picker
fix: correct the tile budget check before a region download
docs: update installation instructions
test: add tests for the scroll-cache age sweep
chore: update dependencies
```

## License and attribution

By contributing, you agree your contributions are licensed under the MIT
License for the Node.js plugin and repository documentation, or Apache License 2.0 for the Rust
tile-cache workspace, according to the component changed.
