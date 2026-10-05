# Dependency and workflow updates

Chart Locker pins executable GitHub Actions and reusable workflows to reviewed commit SHAs. Dependabot
tracks npm, Cargo, Docker, and GitHub Actions updates each week. A version comment beside each action
SHA records the human-readable release that was reviewed.

Minor and patch npm, Cargo, and GitHub Actions updates are grouped by ecosystem. Major updates remain
separate so their migration work and compatibility impact are visible and can be reviewed
independently.

The TypeScript 7 native compiler does not yet expose the compiler API consumed by ESLint and other
JavaScript tools. Keep `@typescript/native` as the `tsc` provider and the `typescript` dependency
aliased to the maintained TypeScript 6 compiler API package until those tools support the native
API. Run every configured TypeScript project with `npm run typecheck` after changing either package.

The two packages coexist because they claim different binaries: `@typescript/native` owns `tsc`, so
`npm run typecheck` compiles with 7.x, while `@typescript/typescript6` ships `tsc6` and occupies
`node_modules/typescript`, which is what satisfies the `typescript` peer that typescript-eslint
resolves for type-aware linting. Sibling plugins declare a plain `typescript` dependency instead;
this repository is deliberately different, and the split is the reason. Verify after any change to
either package that `npx tsc --version` still reports 7.x and that `npm run lint:code` still runs.

ESLint 10 requires Node.js 20.19 or newer and flat configuration, but compatibility also depends on
the peer ranges declared by neostandard and eslint-plugin-react. Keep ESLint on the latest 9.x
release while either peer range excludes 10.x, and re-evaluate the major upgrade when both packages
support it. As of October 2026 both still block it: eslint-plugin-react 7.37.5, which the panel's
React rules use directly, declares `eslint: ^9.7` at the top of its range and its ESLint 10
compatibility change (jsx-eslint/eslint-plugin-react pull request 4022, tracked by issue 4027) is
unreleased, and neostandard's stable 0.13.0 declares `eslint: ^9.0.0` (its ESLint 10 support is
merged but published only as the 0.14.0 prerelease, neostandard issue 350). Installing ESLint 10
against either fails npm's peer resolution. Drop this hold when a stable eslint-plugin-react and a
stable neostandard both admit ESLint 10. ESLint 9 reached end of life on 2026-08-06 and npm marks its
releases deprecated, so the hold keeps an unmaintained linter in the development toolchain. It never
reaches the published package, which is why the hold is acceptable while the peers catch up.

`engines.node` states the runtime floor and nothing else. Derive it from the runtime-facing closure,
meaning `dependencies` plus `peerDependencies` walked transitively: today that is 9 packages topping
out at `>=22` from `signalk-chart-sources`, so the floor is `>=22.0.0`. `signalk-container` is not in
that closure: it is a companion plugin the operator installs from the App Store, declared in
`signalk.requires` rather than as a peer dependency, so npm never resolves it under this package.

A development-only package never raises that floor, however high its own `engines` reaches. Babel and
cspell run at build time and constrain the lowest workflow Node instead. `signalk-nearlcrews-ui`
constrains neither: webpack inlines it into the panel bundle, and the only Node that executes it is
the test suite, which loads its pure utilities through the package's `default` export condition under
the `devEngines` range. Its own `engines.node` is `>=22`, inside the runtime floor either way. The
toolchain floor belongs in `devEngines`, which is why that field carries the newer range.

`@types/node` tracks the `engines.node` major so nothing newer than the lowest supported runtime can
typecheck.

`npm run lint:docs` calls the `markdownlint` library from `scripts/check-markdown.mjs` instead of
running `markdownlint-cli2`. The command-line wrapper exists to expand globs, and its glob stack
(globby, fast-glob, and micromatch) pulls in a `braces` release with an unpatched advisory, while
the lint scope needs no glob. Keep the rules in `.markdownlint.json` and the file scope in the
script. The package carries no `overrides`: add one only for an advisory or a duplicate that a
direct dependency update cannot clear, record why in the commit, and drop it once the dependency
that required it moves on.

## Automated updates

For every Dependabot pull request:

1. Read the upstream release notes and security advisories between the old and new revisions.
2. Confirm the commit SHA belongs to the claimed upstream repository and release tag.
3. Review permission, runtime, input, output, and network changes in the action source.
4. Run the workflow syntax checks and the repository's complete affected test path.
5. Keep Docker base images digest-pinned when Dependabot refreshes them.

Do not replace a full action SHA with a floating branch or major-version tag.

## Manual pins

Dependabot cannot safely infer every branch-based pin. Review these at least monthly and during each
release:

- The Signal K reusable plugin workflow commit in `.github/workflows/plugin-ci.yml`: compare the old
  revision with upstream `SignalK/signalk-server` master, inspect the integration job and Admin loader
  assumptions, then update the SHA and dated comment together.
- The `dtolnay/rust-toolchain` action source (a master commit with a dated comment),
  `container/rust-toolchain.toml`, CI toolchain input, and Docker builder toolchain: advance them as
  one tested change.
- The explicitly selected npm, cargo-audit, cargo-about, Cosign, and Syft tool versions in release
  workflows and scripts. `scripts/rust-license-report.mjs` pins cargo-about 0.9.2 release archives by
  SHA-256 for the supported Linux runner architectures, and `container/about.hbs` names the same
  release in the report header. The image workflow and the publish workflow must select the same
  Cosign release, and `npm run ci:workflows` enforces that.

Dependabot holds every update for a 7-day cooldown after its release, and manual pins follow the same
wait by default. A pin may advance inside that window only when its complete source change between
the old and new revisions has been read, as with the plugin CI workflow and the Rust toolchain action,
which are small text sources. Prebuilt binaries and packages whose shipped bytes cannot be reviewed
that way, such as npm, Syft, Cosign, cargo-about, and release-built actions, always wait out the full
cooldown.

Use `git ls-remote` against the upstream repository to resolve a release tag to its commit. Annotated
tags must be pinned to the peeled commit, not the tag object. Run `actionlint`, parse every workflow as
YAML, run `npm run licenses:rust:check`, and exercise the focused release-tooling tests before accepting
the update.
