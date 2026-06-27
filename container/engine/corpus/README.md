# Channel-router parity corpus

Captured `(request, provider responses, result)` tuples from the crows-nest
TypeScript `routeChannel`, the oracle the Rust engine replays to prove parity.

## Why this is an exact oracle

With `deadlineMs` unset the router never reads `Date.now()` for any decision, so
`routeChannel` is a pure function of its request and the three provider responses.
Each case here was produced by running the real router over a self-contained test
scenario (synthetic ENC areas and tile water, no network) and recording every
provider call and its result alongside the final result.

## Layout

One directory per case, named with a stable kebab-case slug. INDEX.json lists the
case names. Each case directory holds three files.

### request.json

The `ChannelRouteRequest`, camelCase, with `signal`, `deadlineMs`, and the
function-valued `foreignRings` omitted. A boolean `borderAware` stands in for the
presence of `foreignRings`: when true, the engine blocks the foreign water the
provider returns for the route bbox. Optional fields (`corridor`, `bboxAnchors`,
`maxSnapMeters`) appear only when the case set them.

### calls.json

Every provider call the run made:

```
{
  "chartedAreas": [ { "band": <lowercase>, "bbox": {north,south,east,west}, "result": <ChartedAreas | null> } ],
  "tileWater": { "bbox": {north,south,east,west}, "result": <TileWater | null> } | null,
  "foreignRings": { "bbox": {north,south,east,west}, "result": [RingPolygon] } | null
}
```

- `chartedAreas` has one entry per band the router queried (one per case here).
- A `result` of `null` means that fetch rejected (the fetch-failed and
  ENC-fails-tile-covers cases). A top-level `tileWater` or `foreignRings` of
  `null` means the router never made that call: the antimeridian case declines
  before any fetch, and only the border cases call `foreignRings`.
- Every `bbox` carries the exact f64 the router passed; it is not rounded. The
  engine computes the same bbox from the same request, but its `route_bbox`
  projection can differ from the V8 reference by one or two ulp on some inputs,
  because the projection transcendentals are not correctly rounded across math
  libraries. So the FileProvider keys charted areas on the band, not on the exact
  bbox, and asserts the engine's bbox matches the captured one within a small ulp
  tolerance, so a real `route_bbox` divergence is still caught.
- ENC area polygons carry the raw `properties` bag the TypeScript query returns;
  the engine reads only `rings` and `depthRange.shallowMeters` and ignores it.

### result.json

The `ChannelRouteResult` exactly as `routeChannel` returned it:
`{ "ok": true, "waypoints": [...], "usedTileWater": <bool> }`, with
`"borderFallback": true` added only on a border fallback success, or
`{ "ok": false, "reason": <kebab-case> }`.

## Regenerate

From the crows-nest repo on the corpus branch:

```
node --import tsx scripts/build-channel-router-corpus.mts
```

The generator writes here by default (the sibling companion repo). Override the
destination with the `CORPUS_OUT` environment variable. The output is
deterministic: stable key order, no timestamps.
