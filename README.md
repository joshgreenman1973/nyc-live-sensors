# The city that sensors see (and hear and feel)

A live dashboard of what New York City's public real-time sensors are reporting right now: tide gauges, weather stations, stream gauges, wave buoys, traffic detectors, traffic cameras, weather radar, aircraft transponders, bike-dock telemetry, subway and ferry position feeds and the power grid.

**Live:** https://joshgreenman1973.github.io/nyc-live-sensors/

## How it works

- Static site, no server. CORS-open feeds (National Weather Service, NOAA tides, USGS gauges, NYC Open Data traffic speeds, Citi Bike, airplanes.live, Open-Meteo, radar tiles) are fetched live by the browser on per-feed timers.
- Feeds that block cross-origin requests (NYISO, the NDBC wave buoy, MTA subway feeds, NYC Ferry, the traffic-camera directory) are captured into `data/snapshot.json` by `scripts/build-snapshot.mjs`, rebuilt every 10 minutes by a long-running GitHub Actions job in `.github/workflows/snapshot.yml` that restarts itself every ~5.5 hours (GitHub's cron alone started only a few runs a day from October 2026).
- Full source-by-source documentation: [methodology.html](methodology.html) (also linked from the page).

## Run locally

Any static server, e.g. `python3 -m http.server` in this directory. To rebuild the snapshot locally: `npm install --no-save gtfs-realtime-bindings@1 && node scripts/build-snapshot.mjs`.
