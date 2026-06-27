# Offline geodata prep (Milestone 3B)

This tool builds one per-region GeoPackage that the runtime `LocalProvider`
(`container/localprovider/`) reads. It is the offline prep stage: GDAL lives here and only
here, so the runtime image stays free of GDAL, GEOS, PROJ, and SpatiaLite.

ENC and chart data are downloaded by the owner per region and are never bundled in this repo
or in any image. NOAA ENC is US-government public domain and free to download.

## What it produces

One `.gpkg` per region with the schema the reader expects:

- `enc_depth_areas(fid, geom, band, drval1, drval2)` from the S-57 DEPARE and DRGARE layers.
- `enc_land_areas(fid, geom, band)` from the S-57 LNDARE layer.
- `osm_water(fid, geom)` from an OSM water source (optional).
- `boundaries(fid, geom, country_id)` from an admin-0 source (optional).
- The standard GeoPackage metadata tables and one R-tree per feature table.

Coordinates are WGS84 (EPSG:4326). `drval1` is DRVAL1 (shallow depth, meters) and `drval2` is
DRVAL2 (deep depth). A negative DRVAL1 is a drying height and keeps its sign: the engine
treats `drval1 < 0` as land. The `band` is the cell's usage band, taken from the ENC cell name
(the third character: 1 overview, 2 general, 3 coastal, 4 approach, 5 harbour, 6 berthing).

## Owner workflow

1. Download the ENC cells for your region from the NOAA ENC download
   (`https://www.charts.noaa.gov/ENCs/<CELL>.zip`) and unzip them. Each zip contains an
   `ENC_ROOT/<CELL>/<CELL>.000` file and its update files.
2. Optionally stage an OSM water extract (for example the osmdata.openstreetmap.de split
   product, clipped to your region) and an admin-0 boundaries source.
3. Build the prep image once:

   ```
   podman build -t binnacle-prep container/prep
   ```

4. Run it, bind-mounting your data directory:

   ```
   podman run --rm -v /path/to/data:/work binnacle-prep \
     --enc-dir /work/enc \
     --out /work/region.gpkg \
     --boundaries /work/admin0.geojson --country-field ADM0_A3 \
     --osm /work/osm_water.gpkg
   ```

   `--boundaries` and `--osm` are optional. Border-aware routing needs `boundaries`, and
   `country_id` must use the same identifier scheme the caller passes as `homeCountryId`.

5. Place the resulting `region.gpkg` on the runtime NVMe and point the router at it with the
   `BINNACLE_REGION_STORE` environment variable.

## Validation

Before relying on a region, validate the prep output against the online NOAA ArcGIS ENC
service for sample points (the Milestone 3C data-parity harness). The load-bearing check is
that the local and online ENC agree on whether each sample is deep enough for the contour and
on the drying-as-land classification, because those drive the depth caveat.
