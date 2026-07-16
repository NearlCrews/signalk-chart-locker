# Security Policy

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported |
| ------- | --------- |
| 0.6.x   | Yes       |
| < 0.6   | No        |

## Reporting a Vulnerability

We take the security of Chart Locker seriously. If you discover a security
vulnerability, please follow these guidelines.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of these methods:

1. **GitHub Security Advisory**: Use the [GitHub Security Advisory](https://github.com/NearlCrews/signalk-chart-locker/security/advisories/new) feature (preferred).
2. **GitHub Issues**: For non-sensitive security concerns, open an [issue](https://github.com/NearlCrews/signalk-chart-locker/issues).

### What to Include

Please include the following information in your report:

- **Description** of the vulnerability
- **Steps to reproduce** the issue
- **Potential impact** of the vulnerability
- **Suggested fix** (if you have one)
- **Your contact information** for follow-up

### Response Timeline

- **Initial Response**: within 48 hours of report
- **Status Update**: within 7 days with a preliminary assessment
- **Fix Timeline**: depends on severity, typically within 30 days

## Security Best Practices

When using this plugin:

1. **Keep Updated**: always use the latest supported 0.6 release.
2. **Review Dependencies**: regularly update dependencies and run both documented audits.
3. **Network Security**: ensure your Signal K server is properly secured and do not expose the
   internal tile-cache container port directly.
4. **Access Control**: limit access to your Signal K admin interface. The
   regions, geocode, cache, and chart-management API endpoints share one admin
   gate that fails closed, so an ungatable server leaves them unmounted. Keep
   server access control enabled.
5. **Host Paths**: configure an external cache drive only with an absolute path you control. The
   plugin rejects relative paths, and local chart paths cannot escape the Signal K configuration
   directory.
6. **Monitor Logs**: watch for unusual activity and repeated `warm_rejected`,
   `cache_write_failed`, `cache_eviction_failed`, or `cache_database_recreating` events.

## Dependency Security

This project uses:

- `npm audit` for vulnerability scanning of the published runtime and the panel build toolchain
- RustSec advisories through `cargo-audit` for the Rust tilecache container
- Automated dependency updates via Dependabot for security patches

Run a security audit:

```bash
npm audit
cd container
cargo install cargo-audit --version 0.22.2 --locked
cargo audit --file Cargo.lock
```

## Data Handling

Chart Locker runs an egress-isolated Rust container (the tilecache service)
alongside the Signal K server. The container fetches and caches map tiles from
the allowlisted raster overlay sources and the vector basemap, glyphs, and
sprite configured for the boat. These requests carry only tile coordinates and
standard HTTP cache headers; the plugin sends no personal data, no credentials,
and no account login of any kind.

Saved-region naming can use a guarded `/api/geocode` proxy to the OpenStreetMap Nominatim service.
When enabled, that request carries only the region box center rounded to five decimal places. The
Advanced geocoding control disables the route and provider egress for operators who do not want that
coordinate disclosed. The service enforces one application-wide request per second and caches up to
256 successful lookups in memory for 24 hours.

The container is Signal K agnostic, and only the in-process plugin is intended to talk to it. At
startup, the plugin creates a private, persistent 32-byte control token and passes it to the
container. Container endpoints that change configuration, delete cached data, start a warm, or
cancel a warm require that token in the `x-tilecache-token` header. The token file is mode 0600 and
is never exposed through the plugin HTTP API or logs. Local `.pmtiles` chart files are served by the
Node plugin itself, never mounted into or served by the egress container, so the Signal K
configuration tree, including `security.json`, is never exposed to the internet-egress container.
The runtime image carries no GDAL, GEOS, PROJ, or SpatiaLite: the tilecache binary links only against
libc, libm, libgcc, and the loader.

The source allowlist and cache budgets are pushed by the plugin after startup. Until that push
completes, the panel and plugin status report the container as unconfigured. Container health is
database-aware and returns an error if SQLite cannot be queried. The container also reserves 256 MiB
of filesystem headroom and degrades cache writes when that reserve would be consumed.

Plugin-owned JSON state is written to a mode-0600 temporary file, flushed, and atomically renamed.
The cache database is disposable. If it must be recreated, durable saved-region metadata survives,
but regions with no remaining pinned bytes are marked for re-download.

## Signal K Security

This plugin operates within the Signal K server environment. Please also refer
to the [Signal K documentation](https://signalk.org/documentation/) and Signal
K server security best practices.

## Marine Safety Notice

This plugin caches and serves chart data for marine navigation systems. While
we strive for security and reliability:

- **Not for Safety-Critical Use**: this software should not be relied upon as
  the sole means of navigation.
- **Professional Equipment**: always maintain certified navigation equipment.
- **Regular Verification**: cached tiles and local chart files are provided "as
  is"; verify all navigation data against official charts and notices to
  mariners.
- **Test Thoroughly**: test in non-critical conditions before relying on this
  plugin.

## Disclosure Policy

- We will coordinate disclosure timing with the reporter.
- Public disclosure will occur after a fix is available.
- Credit will be given to reporters (if desired).
- A security advisory will be published on GitHub.
