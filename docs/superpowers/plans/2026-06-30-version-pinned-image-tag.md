# Version-pinned tilecache image tag: implementation plan

**Goal:** Pin the requested tilecache image tag to the plugin version so each plugin release forces a
signalk-container recreate, which is the only reliable way to ship container-side code to existing
installs.

**Why:** signalk-container's recreate diff compares the image by tag string only, never by image
content (`containers.js:1034`); the id-comparing path is off by default and depends on a registry
pull (`containers.js:1549-1581`). A floating `:latest` therefore never recreates on a content change.
A versioned tag bumps the string every release, landing in the same recreate-forcing diff as env,
volumes, and ports.

## Current state

- `DEFAULT_TILECACHE_TAG = 'latest'` (`src/runtime/tilecache-container.ts:11`).
- It is the fallback in `buildTilecacheConfig` (`:47`, `tag: opts.tag ?? DEFAULT_TILECACHE_TAG`) and
  the schema default for a user-editable tag field (`src/plugin/plugin.ts:220`).
- The image workflow pushes `:latest` and `:${github.ref_name}`, where the trigger is `tags: ['v*']`,
  so the versioned tag is `v<major>.<minor>.<patch>`.
- The plugin does not currently read its own version.

## Design

Derive the default tag from the package version at module load, formatted to match the image tag the
workflow publishes:

```
v${version}   // e.g. package version 0.3.0 -> tag "v0.3.0", which equals the v* git tag
```

This package emits CommonJS (no `"type": "module"`; `tsconfig` `module: NodeNext` defaults to CJS), so
`import.meta.url` does not compile (TS1470). Read with the CJS `__dirname` and `readFileSync` (the
existing read idiom in `src/shared/json-state.ts`), and throw a descriptive error naming the resolved
path if the read fails, so a packaging fault is diagnosable rather than an opaque ENOENT that takes
down plugin load:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function packageVersion (): string {
  const path = join(__dirname, '../../package.json')
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
  } catch (e) {
    throw new Error(`chart-locker: cannot read ${path} to derive the tilecache image tag: ${String(e)}`)
  }
}
export const DEFAULT_TILECACHE_TAG = `v${packageVersion()}`
```

`__dirname` is `dist/runtime/` at runtime, so `../../package.json` resolves to the package root, where
npm always places `package.json` (it ships regardless of the `files` array).

The user-editable schema default and `opts.tag` override are unchanged: a developer building locally
can point the schema `tilecacheImageTag` field back at `latest` or a hand-built tag. Pinning a
versioned (non-floating) tag bypasses signalk-container's `autoUpdateOnFloatingTag` path by design;
nothing wanted is lost, because that id-comparing path is off by default and never reliably recreated
on `:latest` content anyway, and the override restores floating behavior if a user wants it.

## Constraints and risks (folded from the two-agent review)

- The versioned image is born from the `v*` tag push, not from a `workflow_dispatch` (on dispatch
  `github.ref_name` is the branch, so it would push `:latest` and `:main`, never `:v${version}`). So
  the publish sequence is: push the `v*` tag, let the image workflow build and push `:v${version}`,
  verify it is pullable on ghcr, and only then publish the npm plugin. The plugin must not reach
  installs before its image exists.
- A tag-string change makes signalk-container remove the old container before creating the new one, so
  a missing or mis-tagged `:v${version}` leaves no running container (hard down, not a degraded
  fallback). The image-before-plugin ordering above is the guard; the plugin should also log a clear
  error on a failed container start.
- The tag string is now the only recreate trigger, so any container code change requires a plugin
  version bump or existing installs keep the stale image. This is release discipline and is documented
  in the runbook and enforced as far as practical by the workflow tag-version guard (Task 3).
- Match holds only when the git tag is exactly `v` + `package.json.version`. Divergence (a tag without
  the `v`, a version or tag bump slip, or a prerelease or build-metadata suffix) yields a pull failure
  or, worse, a silent stale image. The workflow guard (Task 3) asserts the equality at build time.
- Only Docker-tag-safe versions are supported. A plain prerelease suffix (`-rc.1`) is fine; a build
  metadata suffix (`+build.5`) is an invalid Docker reference and is unsupported.
- No silent fallback to `:latest`.

## Tasks

### Task 1: Derive the default tag from the package version

**Files:**
- Modify: `src/runtime/tilecache-container.ts` (the `DEFAULT_TILECACHE_TAG` constant, line 11; add the
  `node:fs` and `node:path` imports and the `packageVersion` helper)
- Test: `test/tilecache-container.test.ts`

- [ ] Step 1: Write a failing test: `buildTilecacheConfig().tag` matches `/^v\d+\.\d+\.\d+/` (it is a
  version tag, not `latest`), and `buildTilecacheConfig({ tag: 'latest' }).tag` is `latest` (override
  still wins). The pattern assertion avoids re-reading package.json and is robust to the version
  changing.
- [ ] Step 2: Implement the `packageVersion()` helper and the `DEFAULT_TILECACHE_TAG = \`v${...}\``
  export exactly as in Design (CJS `__dirname` + `readFileSync`, descriptive throw). Keep the export
  name and string type so `buildTilecacheConfig` (`:47`) and the schema default at `plugin.ts:220` are
  unchanged.
- [ ] Step 3: Run the plugin gates (`npm run typecheck && npm run lint && npm test && npm run build`).
  Build matters specifically here: tests run under tsx (ESM) and would hide a CJS-only compile error,
  so the `tsc` build is the real gate for this change.
- [ ] Step 4: Commit `feat(plugin): pin the tilecache image tag to the plugin version so updates recreate`.

### Task 2: Guard the tag-version match in the image workflow

**Files:**
- Modify: `.github/workflows/container-image.yml`

- [ ] Step 1: Add a step, after checkout and before login and build, that runs only on a tag push and
  asserts the pushed tag equals `v` + `package.json.version`, failing the build otherwise. Pass the
  values through env (never interpolate a context value straight into a run shell):

```yaml
      - name: Assert the tag matches the plugin version
        if: startsWith(github.ref, 'refs/tags/')
        env:
          REF_NAME: ${{ github.ref_name }}
        run: |
          want="v$(node -p "require('./package.json').version")"
          if [ "$REF_NAME" != "$want" ]; then
            echo "tag $REF_NAME does not match package version ($want); aborting" >&2
            exit 1
          fi
```

- [ ] Step 2: Parse the YAML to validate, then commit `ci: assert the image tag matches the plugin version`.

### Task 3: Rewrite the runbook image and release steps

**Files:**
- Modify: `docs/superpowers/2026-06-30-publish-runbook.md`

- [ ] Step 1: Replace the image step so it does not claim a `workflow_dispatch` pre-stages the versioned
  image. Document the real sequence: push the `v*` tag (the only source of `:v${version}`), let the
  image workflow finish, verify `docker manifest inspect ghcr.io/<owner>/signalk-chart-locker-tilecache:v${version}`
  (or a `podman pull`) succeeds, and only then publish the npm plugin. State the hard-down risk (a
  missing image leaves no running container), the rule that any container change requires a version
  bump, the git-tag-equals-`v`-plus-version requirement, the Docker-tag-safe version constraint, and
  the developer override (`tilecacheImageTag` schema field) for unpublished local versions.
- [ ] Step 2: Commit `docs: sequence the image publish before the plugin and pin the tag to the version`.

## Self-review

- The code change is one constant plus a helper, a test, a workflow guard, and a runbook rewrite; no
  interface or schema shape change.
- The override path (`opts.tag`, schema field) is preserved, so local development is unaffected.
- The build gate (not just tests) is called out because the CJS compile error would otherwise hide.
- The residual risk is release discipline (version bump per container change), documented and guarded
  as far as a build-time check allows.
