# The offline geodata prep image. GDAL lives here and only here: it reads NOAA ENC S-57 cells
# and OSM and admin-0 sources and writes the per-region GeoPackage that the runtime
# LocalProvider reads. The runtime image carries none of this. This image is run by the owner
# per region, never resident alongside the Signal K server.
#
# Pinned to a stable GDAL release on glibc Ubuntu. The rolling "latest" and the Alpine builds
# of the S-57 driver have segfaulted on valid NOAA cells, so this stays on a known-good tag.
# The osgeo/gdal images are multi-architecture, so this runs on amd64 and arm64 alike.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.10.3

# Python drives the ogr2ogr calls and completes the store schema through the sqlite3 stdlib
# module. No extra Python packages are needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY prep_region.py data_parity.py /opt/prep/

# Default entry builds a region store. The Milestone 3C parity check is run with an entrypoint
# override: `--entrypoint python3 ... /opt/prep/data_parity.py`.
ENTRYPOINT ["python3", "/opt/prep/prep_region.py"]
