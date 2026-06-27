# Decision: border-aware boundaries data source

- Date: 2026-06-27
- Status: Resolved
- Scope: Milestone 3 (the `boundaries` table) and Milestone 4 (the border-aware caller)

## Context

The engine's border-aware routing keeps a route in its own country's waters: it blocks the
foreign water the provider returns as `foreign_rings` (the `boundaries` table where
`country_id <> homeCountryId`), and if the in-country attempt then fails it falls back across
the border with `borderFallback: true`. The earlier plan sourced `boundaries` from Natural
Earth admin-0 with `country_id = ADM0_A3`.

Validating the full real-data path on a complete San Francisco Bay store surfaced that this is a
silent no-op: routing with `homeCountryId` USA versus CAN produced the identical route. Admin-0
polygons are LAND. The engine blocks foreign jurisdiction over WATER, and a land polygon covers
no navigable water, so nothing is ever blocked. Confirmed by point tests: the US admin-0 polygon
does not contain any open-water point, while a US EEZ polygon does.

## Options considered

- **A. Admin-0 land (the prior plan, `ADM0_A3`).** Rejected: land polygons cover no water, so
  border-aware blocks nothing. The feature is a silent no-op, which is the worst failure for a
  trust-boundary feature: a route could read as safe across a maritime border.
- **B. Territorial seas, 12 NM (Marine Regions).** Covers only the near-shore band. Beyond
  12 NM the water has no polygon, so "foreign" is undefined there and a route could cross the gap
  unblocked. Partial.
- **C. EEZ (Marine Regions World EEZ).** Tiles all ocean by country out to 200 NM, with ISO
  alpha-3 identifiers (`iso_sov1`). Foreign EEZ is exactly the water to block. Excludes internal
  waters (bays landward of the baseline), which is correct: those are unambiguously one state's,
  so border-aware is moot there anyway.

## Decision

**Option C: Marine Regions World EEZ, `country_id = iso_sov1`.** The `boundaries` table is built
from the EEZ polygons; `country_id` is the EEZ `iso_sov1` (the ISO 3166-1 alpha-3 sovereign).
`homeCountryId` stays ISO alpha-3 (for example `USA`), so the caller's identifier scheme is
unchanged; only the boundaries data source changes from admin-0 land to EEZ water.

## Rationale

- EEZ is the only one of the three that covers the water where coastal and offshore routes near
  a maritime border actually run, so it is the only one for which the engine's existing
  foreign-water block does anything.
- `iso_sov1` keeps the alpha-3 scheme the prior decision fixed for `homeCountryId`, so Milestone 4
  is unaffected: the caller still passes an alpha-3 code.
- The Marine Regions WFS (`geo.vliz.be/geoserver/MarineRegions/wfs`, layer `MarineRegions:eez`)
  serves the EEZ in EPSG:4326 with no download form, so the owner can fetch a regional extract
  programmatically, and prep clips it to the cell extent.

## Verification

- The US EEZ contains an offshore Pacific point and a point just seaward of the Golden Gate
  (`in_US_EEZ = True`) and excludes the inner bay (internal water); the US admin-0 land polygon
  contains none of those water points.
- The EEZ decodes through the Rust `LocalProvider`: `foreign_rings` returns the US polygon for a
  non-US home and empty for `USA`.
- A hermetic test (`border_aware_blocks_foreign_water_and_falls_back` in
  `container/localprovider/src/store.rs`) proves the mechanism: a foreign boundary covering the
  navigable water makes the route take the border fallback (`border_fallback: true`), while a
  matching home routes with no fallback. Admin-0 land never covers water, so it never triggers
  this, which is the no-op.
- Live border region: a store from NOAA cell US3WA1EF (Haro Strait, the US/Canada line) with the
  Marine Regions US and Canada EEZ. The EEZ partitions the strait: US-side deep points resolve to
  `USA`, Canada-side to `CAN`. The same US-side Haro Strait route stays in home water with
  `homeCountryId: USA` (`borderFallback: false`) and is blocked as foreign with
  `homeCountryId: CAN`, taking the border fallback (`borderFallback: true`). With admin-0 land
  both homes gave the identical route; the EEZ source makes border-aware work end to end.

## Consequences

- Prep's `--country-field` defaults to `iso_sov1`, and the README directs the owner to the Marine
  Regions EEZ for `--boundaries`. The flag still allows another source and field if needed.
- Border-aware is confirmed end to end on a real maritime border (the Haro Strait test under
  Verification), so it is ready for the Milestone 4 cutover. The all-US, internal-water SF Bay
  could not exercise it, which is why the Haro Strait cell was used.
- Internal-water routes are correctly unaffected by border-aware, since no EEZ covers them.
