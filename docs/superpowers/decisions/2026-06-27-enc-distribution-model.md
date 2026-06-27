# Decision: ENC distribution model (Milestone 3 gate)

- Date: 2026-06-27
- Status: Resolved
- Scope: Milestone 3 (local geodata pipeline and `LocalProvider`)

## Context

The offline router needs charted depth and water data. The locked sources are NOAA ENC
(S-57 `.000` cells, read through the GDAL S-57 driver in the offline prep stage), OSM water
polygons, and admin-0 country boundaries. The design spec flagged one open gate before the
local-ENC milestone could start: whether the companion bundles and redistributes the ENC
cells themselves, or ships only the prep pipeline and has the owner supply the cells.

The spec framing:

> NOAA ENC is public, but bundling or redistributing cells has terms to check. The owner most
> likely downloads cells per region; we ship the pipeline, not the data. This is a gate before
> the local-ENC milestone.

## Options considered

- **A. Pipeline-only.** The repo and image carry the GDAL S-57 to GeoPackage prep code. The
  owner downloads NOAA ENC cells per cruising region and runs prep locally on the Pi. No chart
  data ships with the companion.
- **B. Bundle pre-clipped regional stores.** The companion hosts, versions, and ships
  ready-to-use regional GeoPackages.

## Decision

**Option A, pipeline-only.** Ship the pipeline, not the data. ENC and chart data are never
bundled in the image or the repo. The owner fetches NOAA ENC cells per region and runs the
local prep stage.

## Rationale

- Zero redistribution-terms exposure. NOAA ENC is US-government public domain and free, so
  Option A sidesteps even the small task of confirming the current NOAA distribution agreement,
  and it avoids the stale-chart liability framing that bundling would invite.
- The runtime image stays near-static and small: the prep tooling and the multi-GB transient
  working set never enter the shipped artifact.
- Cells stay current. The owner pulls the latest cells at prep time rather than waiting on a
  re-hosted bundle to track the weekly ENC update cadence.
- The per-region owner download is a one-time step that fits the planned operator-workflow
  milestone.

## Consequences

- Milestone 3 scope includes an owner-facing fetch and prep path (per-region ENC download, then
  GDAL S-57 to GeoPackage), not a hosted data bundle.
- Safety wording is unaffected. The trust boundary stays in crows-nest, and the verdict still
  reads as unverified at sea regardless of how the data arrived.
- Option B remains a possible later convenience once the NOAA distribution terms and a versioned
  update cadence are settled. Revisit only if the owner download proves to be real friction.
