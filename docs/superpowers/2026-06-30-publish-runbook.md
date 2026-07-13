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

Any change under `container/` requires a plugin version bump. The plugin pins the image tag to its own
version, and `signalk-container` recreates the container only when that tag changes.

## 2. Run the complete local gates

Node plugin and panel:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run check:package
npm audit --omit=dev
```

Rust container:

```bash
cd container
cargo fmt -- --check
cargo test --workspace --all-features
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo build --release --bin tilecache
cargo install cargo-audit --locked
cargo audit --file Cargo.lock
cd ..
```

Inspect the release tarball report from `npm pack --dry-run --json --ignore-scripts`. The automated
package check requires the plugin entry point, types, panel remote, README, and changelog, and rejects
retired `dist/bridge`, `prewarm`, and `route-draft` output.

## 3. Verify the user experience

1. Load the actual federated configuration panel in a real browser.
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

- TypeScript type-check, ESLint, Node tests, build, package-content check, and npm runtime audit
- Rust tests, strict Clippy, release build, and RustSec audit
- Signal K plugin compliance and install simulation

Fix failures on the branch and repeat the local gates. Do not tag a different commit from the one that
passed CI.

## 5. Obtain final approval

Present the proposed version, release commit, changelog, local verification, CI result, npm package
contents, audit results, and container-image plan to the owner. Stop here until the owner explicitly
approves npm publication and creation of the version tag.

## 6. Publish the container image

The image must exist before the npm package reaches users. The tag must be exactly `v` plus the
`package.json` version.

```bash
version="$(node -p "require('./package.json').version")"
git tag "v${version}"
git push origin "v${version}"
```

The tag starts `.github/workflows/container-image.yml`, which builds the linux/amd64 and linux/arm64
images and publishes:

- `ghcr.io/NearlCrews/signalk-chart-locker-tilecache:v${version}`
- `ghcr.io/NearlCrews/signalk-chart-locker-tilecache:latest`

Wait for the workflow to finish, then verify the versioned image is public and pullable:

```bash
podman pull "ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v${version}"
```

If the image workflow fails, do not publish the npm package. Fix the release on a new version rather
than moving an already-published version tag.

## 7. Publish the npm plugin

After the image is pullable, create the GitHub release for the same version tag. The `release:
created` event starts `.github/workflows/publish.yml`, verifies the tag against `package.json`, repeats
the package gates, and publishes to npm with provenance.

Wait for that workflow, then verify:

```bash
npm view signalk-chart-locker version
npm view signalk-chart-locker dist.tarball
```

Install the published version in a clean Signal K test environment and confirm the plugin pulls the
matching image tag.

## 8. Complete the release

1. Confirm the GitHub release uses the versioned changelog section as its release notes, edited only
   for concise presentation.
2. Confirm both container-image architectures and all plugin CI checks passed on the published commit.
3. Confirm the npm package and GHCR image are publicly accessible.
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
