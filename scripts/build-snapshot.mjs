/* Builds data/snapshot.json — the readings a browser can't fetch directly
   (no CORS headers at the source): NYISO grid data, the harbor wave buoy,
   MTA subway train positions, NYC Ferry positions, the traffic-camera list
   and FloodNet street flood sensors. Runs every 15 minutes via GitHub Actions.
   Every section is independent: one failing feed never empties the others. */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const OUT = new URL("../data/snapshot.json", import.meta.url).pathname;
const ET = "America/New_York";
const now = () => new Date().toISOString();

const snapshot = { generated: now() };

/* Carry forward the previous snapshot so a transient source outage
   degrades to "stale" on the page instead of vanishing. */
let previous = {};
if (existsSync(OUT)) {
  try { previous = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
}

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000), ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function fetchJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function fetchProto(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
}

function etDateStamp(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: ET }).replaceAll("-", "");
}

/* Minimal CSV parser (NYISO files quote every field, no embedded commas). */
function parseCSV(text) {
  return text.trim().split(/\r?\n/).map(line =>
    line.split(",").map(c => c.replace(/^"|"$/g, "")));
}

/* ---------- NYISO: NYC-zone load + statewide fuel mix ---------- */
async function nyiso() {
  let palText;
  for (const off of [0, 1]) {
    try { palText = await fetchText(`https://mis.nyiso.com/public/csv/pal/${etDateStamp(off)}pal.csv`); break; }
    catch (e) { if (off === 1) throw e; }
  }
  const pal = parseCSV(palText);
  const header = pal[0];
  const iT = header.indexOf("Time Stamp"), iN = header.indexOf("Name"), iL = header.indexOf("Load");
  const rows = pal.slice(1).filter(r => r[iL] !== "" && r[iL] != null);
  const lastStamp = rows[rows.length - 1][iT];
  const latest = rows.filter(r => r[iT] === lastStamp);
  const nyc = latest.find(r => r[iN] === "N.Y.C.");
  const total = latest.reduce((a, r) => a + parseFloat(r[iL] || 0), 0);

  let fuelMix = null, fuelAsOf = null;
  try {
    const fm = parseCSV(await fetchText(`https://mis.nyiso.com/public/csv/rtfuelmix/${etDateStamp()}rtfuelmix.csv`));
    const fh = fm[0];
    const fT = fh.indexOf("Time Stamp"), fC = fh.indexOf("Fuel Category"), fG = fh.indexOf("Gen MW");
    const frows = fm.slice(1).filter(r => r[fG] !== "");
    const fLast = frows[frows.length - 1][fT];
    fuelMix = frows.filter(r => r[fT] === fLast)
      .map(r => ({ fuel: r[fC], mw: parseFloat(r[fG]) }))
      .filter(x => !isNaN(x.mw));
    fuelAsOf = etStampToISO(fLast);
  } catch (e) { console.error("fuelmix:", e.message); }

  let nycPriceMwh = null, priceAsOf = null;
  try {
    const pr = parseCSV(await fetchText(`https://mis.nyiso.com/public/csv/realtime/${etDateStamp()}realtime_zone.csv`));
    const ph = pr[0];
    const pT = ph.indexOf("Time Stamp"), pN = ph.indexOf("Name"), pL = ph.indexOf("LBMP ($/MWHr)");
    // the file blends actual prices with look-ahead projections — use the
    // latest N.Y.C. row that is not in the future
    const pnycRows = pr.slice(1).filter(r => r[pN] === "N.Y.C." && r[pL] !== "")
      .map(r => ({ iso: etStampToISO(r[pT]), price: parseFloat(r[pL]) }))
      .filter(r => Date.parse(r.iso) <= Date.now());
    const pLatest = pnycRows[pnycRows.length - 1];
    if (pLatest) { nycPriceMwh = pLatest.price; priceAsOf = pLatest.iso; }
  } catch (e) { console.error("lbmp:", e.message); }

  snapshot.nyiso = {
    nycLoadMw: nyc ? parseFloat(nyc[iL]) : null,
    isoLoadMw: total || null,
    asOf: etStampToISO(lastStamp),
    fuelMix, fuelAsOf,
    nycPriceMwh, priceAsOf
  };
}

/* ---------- Con Edison outages (summary only) ---------- */
async function coned() {
  const meta = await fetchJSON("https://outagemap.coned.com/resources/data/external/interval_generation_data/metadata.json");
  const d = await fetchJSON(`https://outagemap.coned.com/resources/data/external/interval_generation_data/${meta.directory}/data.json`);
  const s = d.summaryFileData || {};
  if (s.total_cust_s == null) throw new Error("no outage summary");
  snapshot.coned = {
    customersOut: s.total_cust_a?.val ?? null,
    customersServed: s.total_cust_s,
    outages: s.total_outages ?? null,
    asOf: s.date_generated ? new Date(s.date_generated).toISOString() : now()
  };
}

/* ---------- PATH arrival board ---------- */
async function path() {
  const j = await fetchJSON("https://www.panynj.gov/bin/portauthority/ridepath.json");
  const results = j.results || [];
  if (!results.length) throw new Error("no PATH stations");
  let arrivals = 0;
  for (const st of results) for (const dest of st.destinations || []) for (const m of dest.messages || []) {
    const s = parseFloat(m.secondsToArrival);
    if (!isNaN(s) && s >= 0 && s <= 1800) arrivals++;
  }
  snapshot.path = { arrivals, stations: results.length, asOf: now() };
}

/* ---------- upstate reservoir levels (DEP page, updated daily) ---------- */
async function reservoirs() {
  const html = await fetchText("https://www.nyc.gov/site/dep/water/reservoir-levels.page", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" }
  });
  // The number sits in its own table cell after the label cell; markup in
  // between carries layout numbers, so require a decimal figure standing
  // alone in a text node and sanity-check the range.
  const grab = label => {
    const m = html.match(new RegExp(label + String.raw`:[\s\S]{0,400}?>\s*(\d{1,3}\.\d)\s*<`, "i"));
    const v = m ? parseFloat(m[1]) : null;
    return v != null && v >= 25 && v <= 100 ? v : null;
  };
  const current = grab("Current"), normal = grab("Normal");
  if (current == null) throw new Error("could not parse reservoir level");
  const dm = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
  snapshot.reservoirs = {
    pctFull: current,
    pctNormal: normal,
    pageDate: dm ? dm[0] : null,
    asOf: now()
  };
}

/* NYISO stamps are "MM/DD/YYYY HH:MM:SS" Eastern local time. */
function etStampToISO(stamp) {
  const [d, t] = stamp.split(" ");
  const [mo, da, y] = d.split("/").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const ref = new Date();
  const offMin = (new Date(ref.toLocaleString("en-US", { timeZone: ET })).getTime()
    - new Date(ref.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 60000;
  return new Date(Date.UTC(y, mo - 1, da, h, mi, s || 0) - offMin * 60000).toISOString();
}

/* ---------- NDBC wave buoy 44065 ---------- */
async function buoy() {
  const text = await fetchText("https://www.ndbc.noaa.gov/data/realtime2/44065.txt");
  const lines = text.trim().split(/\r?\n/);
  const cols = lines[0].replace(/^#/, "").trim().split(/\s+/);
  // Rows are newest-first; not every row carries every field (waves report
  // hourly, met data every 10 minutes). For each field take the newest
  // non-missing value from the last ~4 hours.
  const rows = lines.filter(l => !l.startsWith("#")).slice(0, 24).map(l => l.trim().split(/\s+/));
  const pick = name => {
    const i = cols.indexOf(name);
    if (i < 0) return { v: null, row: null };
    for (const r of rows) {
      if (r[i] !== "MM" && !isNaN(parseFloat(r[i]))) return { v: parseFloat(r[i]), row: r };
    }
    return { v: null, row: null };
  };
  const rowTime = r => r ? Date.UTC(+r[0], +r[1] - 1, +r[2], +r[3], +r[4]) : null;
  const wave = pick("WVHT");
  const anchor = wave.row || rows[0];
  snapshot.buoy = {
    waveHeightM: wave.v,
    domPeriodS: pick("DPD").v,
    waterTempC: pick("WTMP").v,
    windMs: pick("WSPD").v,
    airTempC: pick("ATMP").v,
    pressureHpa: pick("PRES").v,
    asOf: new Date(rowTime(anchor)).toISOString()
  };
}

/* ---------- MTA subway: trains transmitting positions + alerts ---------- */
async function subway() {
  const base = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs";
  const suffixes = ["", "-ace", "-bdfm", "-g", "-jz", "-nqrw", "-l", "-si"];
  const results = await Promise.allSettled(suffixes.map(s => fetchProto(base + s)));
  let trains = 0, feedsOk = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    feedsOk++;
    trains += r.value.entity.filter(e => e.vehicle).length;
  }
  if (!feedsOk) throw new Error("all subway feeds failed");

  let alerts = null;
  try {
    const a = await fetchJSON("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json");
    const nowSec = Date.now() / 1000;
    alerts = (a.entity || []).filter(e => {
      const ap = e.alert?.["active_period"] || e.alert?.activePeriod || [];
      if (!ap.length) return true;
      return ap.some(p => (p.start == null || p.start <= nowSec) && (p.end == null || p.end >= nowSec));
    }).length;
  } catch (e) { console.error("alerts:", e.message); }

  snapshot.subway = { trains, feedsOk, feeds: suffixes.length, alerts, asOf: now() };
}

/* ---------- LIRR + Metro-North: commuter trains reporting ---------- */
async function rail() {
  const feeds = {
    lirr: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr",
    mnr: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr"
  };
  const out = {};
  const nowSec = Date.now() / 1000;
  for (const [k, url] of Object.entries(feeds)) {
    try {
      const f = await fetchProto(url);
      // Only trust vehicle entities with a fresh timestamp — LIRR's feed keeps
      // stale ghosts around. Fall back to active trip updates.
      const freshVehicles = f.entity.filter(e =>
        e.vehicle?.timestamp && Math.abs(nowSec - Number(e.vehicle.timestamp)) < 600).length;
      const trips = f.entity.filter(e => e.tripUpdate).length;
      out[k] = { trains: freshVehicles || trips, viaVehicles: freshVehicles > 0 };
    } catch (e) { console.error(`rail ${k}:`, e.message); }
  }
  if (!Object.keys(out).length) throw new Error("both commuter feeds failed");
  snapshot.rail = { ...out, asOf: now() };
}

/* ---------- NYC Ferry vessel positions ---------- */
async function ferry() {
  const feed = await fetchProto("http://nycferry.connexionz.net/rtt/public/utility/gtfsrealtime.aspx/vehicleposition");
  const boats = feed.entity.filter(e => e.vehicle?.position);
  snapshot.ferry = {
    vessels: feed.entity.filter(e => e.vehicle).length,
    positions: boats.map(e => ({
      lat: +e.vehicle.position.latitude.toFixed(5),
      lon: +e.vehicle.position.longitude.toFixed(5),
      label: e.vehicle.vehicle?.label || e.vehicle.vehicle?.id || "ferry"
    })),
    asOf: now()
  };
}

/* ---------- DOT traffic cameras: a spread of online cameras ---------- */
let allCameras = null; // stashed for the daily stations file
async function cameras() {
  const list = await fetchJSON("https://webcams.nyctmc.org/api/cameras");
  const online = list.filter(c => String(c.isOnline).toLowerCase() === "true");
  allCameras = online;
  // round-robin across boroughs/areas for geographic spread
  const byArea = {};
  online.forEach(c => (byArea[c.area || "other"] = byArea[c.area || "other"] || []).push(c));
  const areas = Object.values(byArea);
  areas.forEach(a => a.sort(() => 0.5 - Math.random()));
  const picked = [];
  let i = 0;
  while (picked.length < 18 && areas.some(a => a.length > i)) {
    for (const a of areas) if (a[i] && picked.length < 18) picked.push(a[i]);
    i++;
  }
  snapshot.cameras = {
    total: online.length,
    list: picked.map(c => ({
      name: String(c.name || "").replace(/\s*-\s*quad.*$/i, "").replace(/\s*@\s*/g, " @ ").trim(),
      url: c.imageUrl || `https://webcams.nyctmc.org/api/cameras/${c.id}/image`
    })),
    asOf: now()
  };
}

/* ---------- FloodNet street flood sensors (via the FieldKit platform) ----------
   FloodNet's own dataviz runs on FieldKit; project 174 is "NYC FloodNet".
   We list the project's stations, then pull each recently-updated station's
   latest depth reading. */
let fnStations = null; // stashed for the daily stations file
async function floodnet() {
  const j = await fetchJSON("https://api.fieldkit.org/projects/174/stations");
  const stations = j.stations || [];
  if (!stations.length) throw new Error("no FloodNet stations");
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const active = stations.filter(s => (s.updatedAt || 0) > cutoff);
  if (!active.length) throw new Error("no recently-updated FloodNet stations");
  fnStations = active;

  /* Sensor 44 is wh.floodnet.depth; per FloodNet's published schema, depth is
     in millimeters. The tail endpoint returns the last few buckets per station. */
  const DEPTH_SENSOR = 44;
  const names = new Map(active.map(s => [s.id, s.name]));
  let latest = new Map(); // stationId -> {time, mm}
  const chunks = [];
  for (let i = 0; i < active.length; i += 60) chunks.push(active.slice(i, i + 60));
  for (const chunk of chunks) {
    const ids = chunk.map(s => s.id).join(",");
    let rec;
    try { rec = await fetchJSON(`https://api.fieldkit.org/sensors/data?stations=${encodeURIComponent(ids)}&tail=1`); }
    catch (e) { console.error("floodnet chunk:", e.message); continue; }
    for (const row of rec.data || []) {
      if (row.sensorId !== DEPTH_SENSOR) continue;
      const val = [row.last, row.avg, row.max].find(v => typeof v === "number" && !isNaN(v));
      if (val == null) continue;
      const prev = latest.get(row.stationId);
      if (!prev || row.time > prev.time) latest.set(row.stationId, { time: row.time, mm: val });
    }
  }
  // only count stations whose latest depth bucket is from the last 6 hours
  const locs = new Map(active.map(s => [s.id, s.location?.precise])); // [lon, lat]
  const cutoffRead = Date.now() - 6 * 3600 * 1000;
  let reporting = 0, flooding = 0, wettest = null, newestMs = 0;
  const wet = [];
  for (const [id, r] of latest) {
    if (r.time < cutoffRead) continue;
    reporting++;
    newestMs = Math.max(newestMs, r.time);
    if (r.mm > 25.4) { // more than an inch of water
      flooding++;
      const p = locs.get(id);
      wet.push({ id, name: names.get(id) || "sensor", mm: r.mm, depthIn: r.mm / 25.4, lat: p?.[1], lon: p?.[0] });
      if (!wettest || r.mm > wettest.mm) wettest = { name: names.get(id) || "sensor", mm: r.mm, depthIn: r.mm / 25.4 };
    }
  }
  if (!reporting) throw new Error("FloodNet stations listed but no fresh depth readings");
  snapshot.floodnet = { sensors: reporting, flooding, wettest, wet, asOf: new Date(newestMs).toISOString() };
}

/* ---------- daily positions file for the map ----------
   Camera and FloodNet sensor locations barely move, so they live in
   data/stations.json, rewritten at most once a day to keep the
   every-15-minutes commits small. */
function stationsFile() {
  const path = new URL("../data/stations.json", import.meta.url).pathname;
  let prev = null;
  if (existsSync(path)) { try { prev = JSON.parse(readFileSync(path, "utf8")); } catch {} }
  if (prev?.generated && Date.now() - Date.parse(prev.generated) < 20 * 3600 * 1000) return;
  if (!allCameras || !fnStations) { console.error("stations file skipped (source lists unavailable)"); return; }
  const out = {
    generated: now(),
    // compact rows: [lat, lon, name, id]
    cameras: allCameras
      .filter(c => c.latitude && c.longitude)
      .map(c => [+(+c.latitude).toFixed(5), +(+c.longitude).toFixed(5),
        String(c.name || "").replace(/\s*-\s*quad.*$/i, "").trim(), c.id]),
    floodnet: fnStations
      .filter(s => s.location?.precise)
      .map(s => [+s.location.precise[1].toFixed(5), +s.location.precise[0].toFixed(5), s.name, s.id])
  };
  writeFileSync(path, JSON.stringify(out));
  console.log("wrote", path, `(${out.cameras.length} cameras, ${out.floodnet.length} flood sensors)`);
}

/* ---------- run everything, carry stale sections forward ---------- */
const jobs = { nyiso, buoy, subway, rail, ferry, cameras, floodnet, coned, path, reservoirs };
const carry = { nyiso: "nyiso", buoy: "buoy", subway: "subway", rail: "rail", ferry: "ferry", cameras: "cameras", floodnet: "floodnet", coned: "coned", path: "path", reservoirs: "reservoirs" };

for (const [name, job] of Object.entries(jobs)) {
  try {
    await job();
    console.log(`ok: ${name}`);
  } catch (e) {
    console.error(`FAILED ${name}: ${e.message}`);
    if (previous[carry[name]]) snapshot[carry[name]] = previous[carry[name]];
  }
}

mkdirSync(new URL("../data/", import.meta.url).pathname, { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 1));
console.log("wrote", OUT);
stationsFile();
