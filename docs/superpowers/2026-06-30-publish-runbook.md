# Publish runbook: chart-sources, the container image, and the plugin

The repos build and test locally against a `file:` link to the shared package, which cannot ship. This
runbook is the ordered, owner-run sequence to publish. Run the steps in order; each depends on the one
before it.

## 0. Preconditions

- Working trees clean, gates green in all three repos (`signalk-chart-sources`, `signalk-chart-locker`,
  `signalk-binnacle`).
- Logged in to npm as the publishing account (`npm whoami`).
- The `signalk-chart-locker` repo on GitHub has a `GITHUB_TOKEN` with `packages: write` (the default
  Actions token already has it through the workflow `permissions` block), and the npm publish
  credential for the plugin is set per the standing SignalK release checklist.

## 1. Publish the shared package

The shared package `signalk-chart-sources` is currently unpublished (`npm view signalk-chart-sources
version` returns E404), and both consumers depend on it through `file:../signalk-chart-sources`.

```sh
cd ~/src/signalk-chart-sources
npm publish --access public
```

Confirm it resolves: `npm view signalk-chart-sources version` returns `0.1.0`.

## 2. Pin both consumers to the published version

Until this flip the consumer `package.json` files keep the `file:` link so local development works; they
are not publishable as-is, because a published package cannot carry a `file:` dependency.

In `~/src/signalk-chart-locker/package.json` and `~/src/signalk-binnacle/package.json`, change the
dependency value from the local link to the published range. The ready-to-paste line for both:

```json
    "signalk-chart-sources": "^0.1.0",
```

(In `signalk-chart-locker` the entry has no trailing comma if it is the last dependency; keep the file
valid JSON.)

Then refresh each lockfile and re-run the gates:

```sh
cd ~/src/signalk-chart-locker && npm install && npm run typecheck && npm run lint && npm test && npm run build
cd ~/src/signalk-binnacle && npm install && npm run check && npm run lint && npm test && npm run build
```

Commit the dependency and lockfile change in each repo.

## 3. Publish the container image

The plugin requests `ghcr.io/<owner>/signalk-chart-locker-tilecache:v${version}`, pinned to the plugin
version, so each release changes the requested tag and forces signalk-container to recreate the
container with the new binary. That makes the image-before-plugin ordering mandatory.

Rules that follow from the pinned tag:

- The image is born from the `v*` tag push, not from a `workflow_dispatch`. On a manual dispatch
  `github.ref_name` is the branch, so it would push `:latest` and `:main`, never `:v${version}`. Push
  the tag to get the versioned image.
- The git tag must be exactly `v` + the `package.json` version (for example version `0.3.0` and tag
  `v0.3.0`). The workflow asserts this and fails on a mismatch, but get it right so the build is not
  wasted.
- Only Docker-tag-safe versions work: a prerelease suffix like `-rc.1` is fine, a build-metadata
  suffix like `+build.5` is not.
- Any container code change requires a plugin version bump. The tag string is the only recreate
  trigger, so a container fix shipped without a version bump never reaches existing installs.
- A failed pull of a missing or mis-tagged image leaves no running container (the recreate removes the
  old one first), so the image must be live on ghcr before the plugin reaches installs.

Sequence:

1. Push the version tag, which runs `.github/workflows/container-image.yml` and builds and pushes
   `:v${version}` (and `:latest`) for linux/amd64 and linux/arm64:

   ```sh
   git tag "v$(node -p "require('./package.json').version")"
   git push origin "v$(node -p "require('./package.json').version")"
   ```

2. Wait for the workflow to finish, then verify the image is pullable:

   ```sh
   podman pull ghcr.io/<owner>/signalk-chart-locker-tilecache:v${version}
   ```

3. On the first publish only, make the ghcr package public (ghcr packages are private by default), so a
   fresh install can pull without credentials: GitHub package settings for
   `signalk-chart-locker-tilecache`, change visibility to public. New tags under an already-public
   package stay public.

A developer running an unpublished local version sets the schema field `tilecacheImageTag` back to
`latest` (or a hand-built tag) so the plugin does not try to pull a `:v${version}` that was never
published.

## 4. Publish the plugin

Only after the image for this version is live and pullable on ghcr (step 3 above), follow the standing
SignalK plugin pre-push release checklist for `signalk-chart-locker`: bring deps current, reach plugin
compliance, bring docs current (version bump, dated CHANGELOG entry, README "What's New"), prove the
pipeline is green, confirm the npm publish credential, then publish. Do not let the npm publish race
ahead of the image: a plugin on npm whose `:v${version}` image is not yet on ghcr fails to start on
fresh installs.

## Reverse-proxy note

The basemap sprite URL is built server-side from the request scheme and host so MapLibre accepts an
absolute, same-origin sprite that the cache can serve offline. A reverse proxy that terminates TLS in
front of Signal K must set `x-forwarded-proto: https` (and `x-forwarded-host`), or the sprite URL is
built as `http://` on an `https` page and the browser mixed-content blocks it. Plain LAN http needs no
configuration.
