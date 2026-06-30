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

The plugin pulls `ghcr.io/<owner>/signalk-chart-locker-tilecache:latest`. Pushing a `v*` tag to
`signalk-chart-locker` runs `.github/workflows/container-image.yml`, which builds linux/amd64 and
linux/arm64 and pushes that name. To publish the image without cutting a plugin release yet, dispatch the
workflow by hand instead:

```sh
gh workflow run container-image.yml --repo NearlCrews/signalk-chart-locker
```

After it succeeds, make the ghcr package public once (ghcr packages are private by default) so a fresh
install can pull it without credentials: GitHub package settings for
`signalk-chart-locker-tilecache`, change visibility to public.

## 4. Publish the plugin

Follow the standing SignalK plugin pre-push release checklist for `signalk-chart-locker`: bring deps
current, reach plugin compliance, bring docs current (version bump, dated CHANGELOG entry, README "What's
New"), prove the pipeline is green, confirm the npm publish credential, then tag and release. Tagging
`v*` also re-runs the image workflow, which is harmless (it republishes the same image).

## Reverse-proxy note

The basemap sprite URL is built server-side from the request scheme and host so MapLibre accepts an
absolute, same-origin sprite that the cache can serve offline. A reverse proxy that terminates TLS in
front of Signal K must set `x-forwarded-proto: https` (and `x-forwarded-host`), or the sprite URL is
built as `http://` on an `https` page and the browser mixed-content blocks it. Plain LAN http needs no
configuration.
