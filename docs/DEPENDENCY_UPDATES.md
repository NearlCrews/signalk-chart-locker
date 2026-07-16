# Dependency and workflow updates

Chart Locker pins executable GitHub Actions and reusable workflows to reviewed commit SHAs. Dependabot
tracks npm, Cargo, Docker, and GitHub Actions updates each week. A version comment beside each action
SHA records the human-readable release that was reviewed.

Minor and patch npm, Cargo, and GitHub Actions updates are grouped by ecosystem. Major updates remain
separate so their migration work and compatibility impact are visible and can be reviewed
independently.

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
