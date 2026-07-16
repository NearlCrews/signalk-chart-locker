# Chart Locker publish runbook

This is the maintained owner-run sequence for publishing the coordinated npm plugin and tile-cache
container image. Do not publish to npm or create a release tag without explicit final owner approval.

## 1. Prepare the release commit

1. Confirm the working tree contains only intended release changes.
2. Choose the release version and update `package.json` and `package-lock.json` together.
3. Convert the `CHANGELOG.md` Unreleased section into a dated version section and add its anchor.
4. Update the README What's new section and every maintained documentation surface affected by the
   release.
5. Confirm package metadata, requirements, repository links, keywords, screenshots, and App Store
   categories describe the current project.
6. If the configuration panel changed materially, update all three screenshots:
   `config-panel.png`, `config-panel-dark.png`, and `config-panel-night.png`.
7. If the panel's comparable production gzip total grew by more than 5 percent, record the baseline
   and current total, and obtain explicit owner approval for the exception.
8. Publish the backward-compatible Binnacle patch that accepts recovery-pending saved-region
   responses before Chart Locker 0.6.0. Record that published Binnacle version as the exact minimum
   in the README, and confirm it continues polling by region identifier after either HTTP 202 shape.

Any change under `container/` requires a plugin version bump. The plugin pins the image tag to its own
version, and `signalk-container` recreates the container only when that tag changes.

## 2. Run the complete local gates

Node plugin and panel:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx --no-install playwright install --with-deps chromium firefox webkit
npm run test:browser:cross
npm run screenshots
npm run build
npm run check:package
npm run licenses:rust:check
npm audit
npm run prepublishOnly
npm run pack:release
npm run verify:release-tarball
```

Rust container:

```bash
cd container
cargo fmt --check
cargo test --locked --workspace --all-features
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo build --locked --release --bin tilecache --all-features
cargo install cargo-audit --version 0.22.2 --locked
cargo audit --file Cargo.lock
cd ..
TILECACHE_BIN="$PWD/container/target/release/tilecache" npm run test:node-rust-contract
docker build --file container/tilecache/Dockerfile --tag chart-locker-tilecache:verify .
```

Inspect the release tarball report and checksum under `package/`. The automated package check requires
the plugin entry point, types, panel remote, README, changelog, project licenses, generated locked Rust
dependency licenses, and notices, and rejects retired `dist/bridge`, `prewarm`, and `route-draft`
output plus development-only source, test, workflow, container, fixture, and script paths.
`prepublishOnly` is intentionally the full package-local direct-publish guard, not a build-only
shortcut. The release-binary Node and Rust contract remains in the Rust CI and image validation lanes,
where the binary exists.

## 3. Verify the user experience

1. Load the production federated panel in the standalone cross-browser fixture, then load it through
   the actual Signal K Admin host. `test:integration` executes the real Admin JavaScript in Chrome and
   asserts that the production remote mounts. CI pairs Signal K 2.24.0 with signalk-container 1.20.0,
   then tests the latest releases of both.
2. Check light, dark, and night-red themes at desktop and narrow widths.
3. Exercise cache refresh, retention changes, clear confirmation, chart rescan, validation errors,
   unsaved-change protection, and the Advanced disclosure.
4. Confirm the panel reports container unavailable, health pending, unconfigured, disk pressure, slow
   upstream, and ready states clearly.
5. Confirm the external cache path reports the correct filesystem or an explicit fallback warning.
6. On a test Signal K installation, verify PMTiles serving, saved-region creation, re-download,
   deletion, and recovery after a tile-cache database recreation.

## 4. Commit and push without publishing

Commit the complete release candidate and push its branch. Wait for all repository checks on that
commit:

- TypeScript type-check, ESLint, Node and browser tests, build, package-content check, and full npm audit
- Rust tests, strict Clippy, release build, and RustSec audit
- Signal K plugin compliance plus a real Admin mount on Signal K 2.24.0 and latest

Fix failures on the branch and repeat the local gates. Do not tag a different commit from the one that
passed CI.

## 5. Obtain final approval

Present the proposed version, release commit, changelog, local verification, CI result, npm package
contents, audit results, and container-image plan to the owner. Stop here until the owner explicitly
approves npm publication and creation of the version tag.

Before the first release, configure a GitHub tag ruleset for `refs/tags/v*` that restricts creation to
release maintainers and blocks tag updates and deletion. The image workflow independently refuses to
move an existing version tag to a different digest. It can move `latest` only during a stable version
tag push; manual runs and prereleases cannot change it. Image promotion is serialized across releases,
and a queued older release drops `latest` from its promotion when a higher stable version tag exists.

## 6. Publish the container image

The image must exist before the npm package reaches users. The tag must be exactly `v` plus the
`package.json` version.

```bash
version="$(node -p "require('./package.json').version")"
git tag "v${version}"
git push origin "v${version}"
```

The tag starts `.github/workflows/container-image.yml`. It runs the locked Rust gates, builds a
run-scoped staging image, starts both linux/amd64 and linux/arm64 images under their real architecture,
and waits for each healthcheck. It then signs the image index, generates and attests a separate SPDX
SBOM for each architecture, and publishes build provenance. Only after every preparation step passes
does it attach the immutable version tag. A stable tag push also advances `latest`; prerelease and
manual workflow runs do not. The serialized promotion step refreshes all repository version tags
immediately before promotion, so an older queued stable build cannot move `latest` backward. The
weekly container cleanup deletes only old package versions whose complete tag set consists of
run-scoped `build-<run_id>-<attempt>` tags. Untagged platform manifests and every version carrying a
release tag are ineligible for deletion.

For a stable release, the workflow publishes:

- `ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v${version}`
- `ghcr.io/nearlcrews/signalk-chart-locker-tilecache:latest`

The workflow retains the amd64 and arm64 SPDX SBOMs as workflow artifacts. Wait for it to finish, then
verify the versioned image is public and pullable:

```bash
podman pull "ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v${version}"
```

If the image workflow fails, do not publish the npm package. Fix the release on a new version rather
than moving an already-published version tag.

## 7. Publish the npm plugin

Before the first release through this workflow, configure npm trusted publishing for package
`signalk-chart-locker` with organization or user `NearlCrews`, repository `signalk-chart-locker`,
workflow `publish.yml`, GitHub environment `npm`, and the `npm publish` allowed action. The publish
job uses GitHub OIDC on a GitHub-hosted runner with Node 24 and npm 12.0.1. Once the first trusted
publish succeeds, revoke obsolete npm automation tokens and restrict token-based package publishing.
Do not add an `NPM_TOKEN` fallback.

After the image workflow succeeds, publish the GitHub release for the same version tag. The `release:
published` event starts `.github/workflows/publish.yml`, including when a prepared draft is made
public. It verifies the image architecture set, source revision labels, healthcheck, Cosign signature,
build provenance, and SPDX SBOM attestation. It builds one npm tarball, runs the full package and
browser gates, installs that exact tarball into Signal K 2.24.0 and latest, executes and mounts the
panel through the real Admin application, and publishes the same checksum-verified bytes through npm
trusted publishing.

Stable npm versions use the `latest` dist-tag. Prerelease versions use `next`, so a prerelease cannot
replace the package users receive from an unqualified install.

Wait for that workflow, then verify:

```bash
npm view signalk-chart-locker version
npm view signalk-chart-locker dist.tarball
npm view signalk-chart-locker dist.attestations
```

Install the published version in a clean Signal K test environment and confirm the plugin pulls the
matching image tag.

## 8. Complete the release

1. Confirm the GitHub release uses the versioned changelog section as its release notes, edited only
   for concise presentation.
2. Confirm both container-image architectures and all plugin CI checks passed on the published commit.
3. Confirm the npm package and GHCR image are publicly accessible, and retain links to the image SBOM,
   signature, and provenance results.
4. Confirm the App Store entry displays the current description, screenshots, version, and links.
5. Install the App Store package once its listing updates.
6. Start a new empty Unreleased section in `CHANGELOG.md` when further development begins.

## Rollback guidance

Do not replace an npm version or move a version tag. If a released plugin or image is defective:

1. Document the impact.
2. Prepare a new patch version.
3. Repeat every gate and approval step.
4. Publish the new image before the new npm package.

An npm package whose matching image is missing cannot start cleanly on a fresh install, so the
image-first ordering is mandatory.

## Reverse-proxy note

The vector-style sprite URL is built from the request scheme and host. A reverse proxy that terminates
TLS in front of Signal K must set `x-forwarded-proto: https` and `x-forwarded-host`. Without those
headers, an HTTPS browser can reject the generated HTTP sprite URL as mixed content.
