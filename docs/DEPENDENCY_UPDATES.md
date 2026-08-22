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

ESLint 10 requires Node.js 20.19 or newer and flat configuration, but compatibility also depends on
the peer ranges declared by neostandard and eslint-plugin-react. Keep ESLint on the latest 9.x
release while either peer range excludes 10.x, and re-evaluate the major upgrade when both packages
support it.

Every dependency, development ones included, must install on the lowest Node.js release
`engines.node` advertises. Audit the tree after a dependency refresh and raise the floor rather than
advertise a release the toolchain cannot use: `signalk-nearlcrews-ui` 0.8.0 requires 22.22.2, and
the Babel 8 and cspell 10 trees require 22.18.0, so the floor is 22.22.2. `@types/node` tracks that
same floor so nothing newer than the lowest supported runtime can typecheck.

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
- The `dtolnay/rust-toolchain` action source, `container/rust-toolchain.toml`, CI toolchain input, and
  Docker builder toolchain: advance them as one tested change.
- The explicitly selected npm, cargo-audit, cargo-about, Cosign, and Syft tool versions in release
  workflows and scripts. `scripts/rust-license-report.mjs` pins cargo-about 0.9.1 release archives by
  SHA-256 for the supported Linux runner architectures.

Use `git ls-remote` against the upstream repository to resolve a release tag to its commit. Annotated
tags must be pinned to the peeled commit, not the tag object. Run `actionlint`, parse every workflow as
YAML, run `npm run licenses:rust:check`, and exercise the focused release-tooling tests before accepting
the update.
