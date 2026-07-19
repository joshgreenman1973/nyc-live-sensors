/* The instrumented city — live feed engine.
   Every feed is registered in FEEDS with its own fetch + render logic.
   CORS-open feeds are fetched straight from the browser; everything else
   arrives via data/snapshot.json, rebuilt every 15 minutes by GitHub Actions. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const board = $("#board");

const ET = "America/New_York";
const fmtInt = n => n.toLocaleString("en-US");
const fmt1 = n => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmtTimeET(d) {
  return d.toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" })
    .replace(" AM", " a.m.").replace(" PM", " p.m.");
}
function rel(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 55) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h === 1 ? "1 hr ago" : `${h} hrs ago`;
}
function asOfHTML(d) {
  if (!d || isNaN(d)) return "";
  return `as of ${fmtTimeET(d)} · ${rel(d)}`;
}
const cToF = c => c * 9 / 5 + 32;
const mToFt = m => m * 3.28084;
const kmhToMph = k => k * 0.621371;
const msToMph = ms => ms * 2.23694;

/* Parse a NOAA CO-OPS "yyyy-MM-dd HH:mm" local (ET) timestamp. */
function parseETLocal(t) {
  const now = new Date();
  const offMin = (new Date(now.toLocaleString("en-US", { timeZone: ET })).getTime()
    - new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 60000;
  const [date, time] = t.split(" ");
  const [y, mo, da] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, da, h, mi) - offMin * 60000);
}

async function getJSON(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise(res => setTimeout(res, 2500)); // one retry for transient failures
    }
  }
}

/* ---------- module scaffolding ---------- */

function makeModule(f) {
  const el = document.createElement("article");
  el.className = "mod" + (f.wide ? " wide" : "");
  el.dataset.domain = f.domain;
  el.dataset.state = "wait";
  el.id = "mod-" + f.id;
  el.innerHTML = `
    <div class="mod-head">
      <div>
        <div class="mod-title">${f.title}${f.badge ? `<span class="badge">${f.badge}</span>` : ""}</div>
        <div class="mod-instrument">${f.instrument}</div>
      </div>
      <div class="led" title="feed status"></div>
    </div>
    <div class="mod-body"><div class="big" style="font-size:16px;color:var(--faint)">awaiting signal…</div></div>
    <div class="mod-foot"><span class="src">${f.source}</span><span class="asof"></span></div>`;
  return el;
}

function setModule(f, state, bodyHTML, asOfDate) {
  const el = $("#mod-" + f.id);
  el.dataset.state = state;
  if (bodyHTML != null) $(".mod-body", el).innerHTML = bodyHTML;
  $(".asof", el).textContent = state === "err" ? "no signal" : (asOfDate ? `as of ${fmtTimeET(asOfDate)} · ${rel(asOfDate)}` : "");
  if (asOfDate) el.dataset.asof = asOfDate.getTime();
}

/* Decide ok vs stale from reading age. */
function stateFor(d, maxAgeMin) {
  if (!d || isNaN(d)) return "stale";
  return (Date.now() - d.getTime()) / 60000 <= maxAgeMin ? "ok" : "stale";
}

/* ---------- readings registry (feeds the ticker + masthead count) ---------- */

const readings = new Map(); // feedId -> {domain, text, ok}
function report(f, ok, tickerText) {
  readings.set(f.id, { domain: f.domain, text: tickerText, ok });
  updateMasthead();
  updateTicker();
}

function updateMasthead() {
  const total = FEEDS.length;
  const ok = [...readings.values()].filter(r => r.ok).length;
  $("#feed-status").textContent = `${ok} of ${total} feeds reporting`;
  $("#feed-status").style.color = ok >= total * 0.7 ? "var(--ok)" : "var(--stale)";
}

let tickerTimer = null;
function updateTicker() {
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => {
    const items = [...readings.values()].filter(r => r.ok && r.text)
      .map(r => `<span class="t-item"><span class="t-dom-${r.domain}">●</span> ${r.text}</span>`).join("");
    if (items) $("#ticker").innerHTML = items + items; // doubled for seamless crawl
  }, 400);
}

/* ---------- snapshot (non-CORS feeds, rebuilt every 15 min) ---------- */

let snapshot = null;
async function loadSnapshot() {
  const bucket = Math.floor(Date.now() / 300000);
  snapshot = await getJSON(`data/snapshot.json?t=${bucket}`);
}

/* =====================================================================
   FEED DEFINITIONS
   ===================================================================== */

const FEEDS = [

  /* ---------------- SKY ---------------- */
  {
    id: "weather", domain: "sky", title: "Surface weather", wide: false,
    instrument: "Automated surface observing stations — Central Park, LaGuardia, Kennedy",
    source: "National Weather Service api.weather.gov",
    every: 300,
    async run(f) {
      const st = ["KNYC", "KLGA", "KJFK"];
      const names = { KNYC: "Central Park", KLGA: "LaGuardia", KJFK: "Kennedy Airport" };
      const obs = await Promise.all(st.map(s =>
        getJSON(`https://api.weather.gov/stations/${s}/observations/latest`).catch(() => null)));
      const rows = [];
      let lead = null;
      obs.forEach((o, i) => {
        if (!o?.properties) return;
        const p = o.properties;
        const t = p.temperature?.value;
        if (t == null) return;
        const entry = {
          station: names[st[i]],
          tempF: cToF(t),
          wind: p.windSpeed?.value != null ? kmhToMph(p.windSpeed.value) : null,
          windDir: p.windDirection?.value,
          rh: p.relativeHumidity?.value,
          desc: (p.textDescription || "").toLowerCase(),
          time: new Date(p.timestamp)
        };
        rows.push(entry);
        if (!lead || st[i] === "KNYC") lead = lead && lead.station === "Central Park" ? lead : entry;
      });
      if (!rows.length) throw new Error("no observations");
      const dirTxt = d => d == null ? "" : ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(d / 22.5) % 16];
      const others = rows.filter(r => r !== lead).map(r =>
        `<div class="r"><span>${r.station}</span><b>${Math.round(r.tempF)}°F</b></div>`).join("");
      setModule(f, stateFor(lead.time, 100),
        `<div class="big">${Math.round(lead.tempF)}<span class="unit">°F</span></div>
         <div class="big-label">${lead.station}${lead.desc ? " · " + lead.desc : ""}${lead.wind != null ? ` · wind ${dirTxt(lead.windDir)} ${Math.round(lead.wind)} mph` : ""}${lead.rh != null ? ` · ${Math.round(lead.rh)}% humidity` : ""}</div>
         <div class="rows">${others}</div>`, lead.time);
      report(f, true, `CENTRAL PARK <span class="t-val">${Math.round(lead.tempF)}°F</span>${lead.wind != null ? ` WIND ${Math.round(lead.wind)} MPH` : ""}`);
    }
  },

  {
    id: "radar", domain: "sky", title: "Weather radar", wide: true,
    instrument: "NEXRAD Doppler radar KOKX, Upton NY — base reflectivity composite",
    source: "NOAA via Iowa Environmental Mesonet tiles",
    every: 300,
    async run(f) {
      const z = 9, xs = [149, 150, 151], ys = [191, 192, 193];
      const bucket = Math.floor(Date.now() / 300000);
      const cells = ys.map(y => xs.map(x => ({ x, y }))).flat();
      const base = cells.map(c =>
        `<img src="https://a.basemaps.cartocdn.com/dark_all/${z}/${c.x}/${c.y}.png" alt="">`).join("");
      const rad = cells.map(c =>
        `<img src="https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${c.x}/${c.y}.png?${bucket}" alt="" onerror="this.style.display='none'">`).join("");
      setModule(f, "ok",
        `<div class="tilebox">
           <div class="tilegrid">${base}</div>
           <div class="tilegrid overlay">${rad}</div>
           <div class="scan"></div>
           <div class="maplabel">NEXRAD composite · greater New York · refreshes every 5 min</div>
         </div>`, new Date());
      report(f, true, `RADAR <span class="t-val">LIVE</span>`);
    }
  },

  {
    id: "aircraft", domain: "sky", title: "Aircraft overhead", wide: false,
    instrument: "ADS-B transponder receivers — every aircraft within 30 nautical miles of City Hall",
    source: "airplanes.live community receiver network",
    every: 120,
    async run(f) {
      const j = await getJSON("https://api.airplanes.live/v2/point/40.7128/-74.0060/30");
      const ac = (j.ac || []).filter(a => a.alt_baro !== "ground");
      const helis = ac.filter(a => a.category === "A7").length;
      const low = ac.filter(a => typeof a.alt_baro === "number" && a.alt_baro < 3000).length;
      const now = new Date();
      setModule(f, "ok",
        `<div class="big">${fmtInt(ac.length)}</div>
         <div class="big-label">aircraft airborne in a 30-nautical-mile circle</div>
         <div class="rows">
           <div class="r"><span>Helicopters</span><b>${helis}</b></div>
           <div class="r"><span>Below 3,000 ft</span><b>${low}</b></div>
         </div>`, now);
      report(f, true, `AIRCRAFT OVERHEAD <span class="t-val">${ac.length}</span> · HELICOPTERS <span class="t-val">${helis}</span>`);
    }
  },

  {
    id: "airquality", domain: "sky", title: "Air quality", badge: "MODEL", wide: false,
    instrument: "Not a physical sensor: Copernicus atmosphere model estimate for Lower Manhattan",
    source: "Open-Meteo air-quality API",
    every: 900,
    async run(f) {
      const j = await getJSON("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=40.7128&longitude=-74.006&current=us_aqi,pm2_5,ozone&timezone=America%2FNew_York");
      const c = j.current;
      if (c?.us_aqi == null) throw new Error("no aq");
      const cat = c.us_aqi <= 50 ? "good" : c.us_aqi <= 100 ? "moderate" : c.us_aqi <= 150 ? "unhealthy for sensitive groups" : "unhealthy";
      const t = new Date(c.time);
      setModule(f, stateFor(t, 130),
        `<div class="big">${Math.round(c.us_aqi)}<span class="unit">AQI</span></div>
         <div class="big-label">${cat} — modeled estimate, not a monitor reading</div>
         <div class="rows">
           <div class="r"><span>Fine particles (PM2.5)</span><b>${fmt1(c.pm2_5)} µg/m³</b></div>
           <div class="r"><span>Ozone</span><b>${Math.round(c.ozone)} µg/m³</b></div>
         </div>`, t);
      report(f, true, `AIR QUALITY (MODEL) <span class="t-val">${Math.round(c.us_aqi)} AQI</span>`);
    }
  },

  /* ---------------- WATER ---------------- */
  {
    id: "battery", domain: "water", title: "Harbor tide — the Battery", wide: false,
    instrument: "Microwave water-level sensor, station 8518750, in continuous service since 1920",
    source: "NOAA tides and currents",
    every: 300,
    async run(f) {
      const base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8518750&time_zone=lst_ldt&units=english&format=json";
      const [wl, wt, pred] = await Promise.all([
        getJSON(`${base}&product=water_level&datum=MLLW&date=latest`),
        getJSON(`${base}&product=water_temperature&date=latest`).catch(() => null),
        getJSON(`${base}&product=predictions&datum=MLLW&interval=hilo&range=36&begin_date=${coopsDate()}`).catch(() => null)
      ]);
      const d = wl?.data?.[0];
      if (!d) throw new Error("no water level");
      const t = parseETLocal(d.t);
      const lvl = parseFloat(d.v);
      let next = "";
      if (pred?.predictions) {
        const up = pred.predictions.map(p => ({ ...p, dt: parseETLocal(p.t) })).filter(p => p.dt > new Date())[0];
        if (up) next = `next ${up.type === "H" ? "high" : "low"} ${fmtTimeET(up.dt)} (${fmt1(parseFloat(up.v))} ft)`;
      }
      const temp = wt?.data?.[0]?.v ? `<div class="r"><span>Water temperature</span><b>${Math.round(parseFloat(wt.data[0].v))}°F</b></div>` : "";
      setModule(f, stateFor(t, 40),
        `<div class="big">${fmt1(lvl)}<span class="unit">ft</span></div>
         <div class="big-label">above mean lower low water${next ? " · " + next : ""}</div>
         <div class="rows">${temp}</div>`, t);
      report(f, true, `BATTERY TIDE <span class="t-val">${fmt1(lvl)} FT</span>`);
    }
  },

  {
    id: "kingspoint", domain: "water", title: "Harbor tide — Kings Point", wide: false,
    instrument: "Water-level station 8516945 on the western Long Island Sound side",
    source: "NOAA tides and currents",
    every: 300,
    async run(f) {
      const j = await getJSON("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8516945&product=water_level&datum=MLLW&date=latest&time_zone=lst_ldt&units=english&format=json");
      const d = j?.data?.[0];
      if (!d) throw new Error("no data");
      const t = parseETLocal(d.t);
      setModule(f, stateFor(t, 40),
        `<div class="big">${fmt1(parseFloat(d.v))}<span class="unit">ft</span></div>
         <div class="big-label">above mean lower low water — the Sound often runs a beat apart from the harbor</div>`, t);
      report(f, true, `KINGS POINT TIDE <span class="t-val">${fmt1(parseFloat(d.v))} FT</span>`);
    }
  },

  {
    id: "usgs", domain: "water", title: "Stream + tide gauges", wide: false,
    instrument: "United States Geological Survey gauges in the five boroughs' streams and creeks",
    source: "USGS instantaneous values service",
    every: 600,
    async run(f) {
      const j = await getJSON("https://waterservices.usgs.gov/nwis/iv/?format=json&countyCd=36005,36047,36061,36081,36085&parameterCd=00065&siteStatus=active");
      const ts = j?.value?.timeSeries || [];
      const sites = ts.map(s => {
        const vals = s.values?.[0]?.value || [];
        const last = vals[vals.length - 1];
        return last ? {
          name: s.sourceInfo.siteName,
          val: parseFloat(last.value),
          time: new Date(last.dateTime)
        } : null;
      }).filter(Boolean).filter(s => !isNaN(s.val));
      if (!sites.length) throw new Error("no gauges");
      const newest = sites.reduce((a, b) => a.time > b.time ? a : b).time;
      const short = n => n.replace(/\b(AT|NEAR|NR)\b.*$/i, "").replace(/,?\s*NY.*/i, "").trim().toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());
      const rows = sites.sort((a, b) => b.time - a.time).slice(0, 4).map(s =>
        `<div class="r"><span>${short(s.name)}</span><b>${fmt1(s.val)} ft</b></div>`).join("");
      setModule(f, stateFor(newest, 180),
        `<div class="big">${sites.length}</div>
         <div class="big-label">gauges reporting water height right now</div>
         <div class="rows">${rows}</div>`, newest);
      report(f, true, `USGS GAUGES REPORTING <span class="t-val">${sites.length}</span>`);
    }
  },

  {
    id: "buoy", domain: "water", title: "Wave buoy — harbor entrance", wide: false,
    instrument: "NOAA buoy 44065, moored 15 miles south of Breezy Point in 82 ft of water",
    source: "National Data Buoy Center, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const b = snapshot?.buoy;
      if (!b || b.waveHeightM == null) throw new Error("no buoy data");
      const t = new Date(b.asOf);
      const rows = [
        b.domPeriodS != null ? `<div class="r"><span>Dominant wave period</span><b>${Math.round(b.domPeriodS)} sec</b></div>` : "",
        b.waterTempC != null ? `<div class="r"><span>Water temperature</span><b>${Math.round(cToF(b.waterTempC))}°F</b></div>` : "",
        b.windMs != null ? `<div class="r"><span>Wind</span><b>${Math.round(msToMph(b.windMs))} mph</b></div>` : ""
      ].join("");
      setModule(f, stateFor(t, 150),
        `<div class="big">${fmt1(mToFt(b.waveHeightM))}<span class="unit">ft</span></div>
         <div class="big-label">significant wave height at the approach to the harbor</div>
         <div class="rows">${rows}</div>`, t);
      report(f, true, `HARBOR WAVES <span class="t-val">${fmt1(mToFt(b.waveHeightM))} FT</span>`);
    }
  },

  {
    id: "floodnet", domain: "water", title: "Street flood sensors", wide: false,
    instrument: "FloodNet ultrasonic depth sensors mounted over flood-prone streets",
    source: "FloodNet (NYU + CUNY), via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const fl = snapshot?.floodnet;
      if (!fl || fl.sensors == null) throw new Error("no floodnet data");
      const t = new Date(fl.asOf);
      const wet = fl.flooding ?? 0;
      setModule(f, stateFor(t, 60),
        `<div class="big">${wet}</div>
         <div class="big-label">of ${fmtInt(fl.sensors)} street sensors currently measuring water on the roadway</div>
         ${wet > 0 && fl.wettest ? `<div class="rows"><div class="r"><span>${fl.wettest.name}</span><b>${fmt1(fl.wettest.depthIn)} in</b></div></div>` : ""}`, t);
      report(f, true, `STREET FLOOD SENSORS WET <span class="t-val">${wet}/${fl.sensors}</span>`);
    }
  },

  /* ---------------- STREETS ---------------- */
  {
    id: "traffic", domain: "streets", title: "Traffic speed sensors", wide: false,
    instrument: "Roadway sensors and E-ZPass readers on highways and bridges, run by the city Department of Transportation",
    source: "NYC Open Data real-time traffic speeds",
    every: 300,
    async run(f) {
      const j = await getJSON("https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$select=speed,borough,data_as_of&$order=data_as_of%20DESC&$limit=1500");
      const all = j.map(r => ({ s: parseFloat(r.speed), b: r.borough, t: parseETLocal(r.data_as_of.replace("T", " ").slice(0, 16)) }))
        .filter(r => !isNaN(r.s) && r.s > 0);
      if (!all.length) throw new Error("no sensors");
      const newest = new Date(Math.max(...all.map(r => r.t.getTime())));
      // keep only the latest transmission batch (sensors reporting within 30 min of the newest)
      const rows = all.filter(r => newest - r.t < 30 * 60000);
      const avg = rows.reduce((a, r) => a + r.s, 0) / rows.length;
      const byB = {};
      rows.forEach(r => { (byB[r.b] = byB[r.b] || []).push(r.s); });
      const bRows = Object.entries(byB)
        .map(([b, arr]) => [b, arr.reduce((a, v) => a + v, 0) / arr.length])
        .sort((a, b) => a[1] - b[1])
        .map(([b, v]) => `<div class="r"><span>${b}</span><b>${fmt1(v)} mph</b></div>`).join("");
      const fresh = stateFor(newest, 45) === "ok";
      setModule(f, stateFor(newest, 45),
        `<div class="big">${fmt1(avg)}<span class="unit">mph</span></div>
         <div class="big-label">average across ${fmtInt(rows.length)} highway sensors in the network's most recent transmission${fresh ? "" : " — the public feed is lagging right now"}</div>
         <div class="rows">${bRows}</div>`, newest);
      report(f, fresh, `HIGHWAY SPEED AVG <span class="t-val">${fmt1(avg)} MPH</span> · ${rows.length} SENSORS`);
    }
  },

  {
    id: "cameras", domain: "streets", title: "Traffic cameras", wide: true,
    instrument: "A rotating eye from the city's network of about 950 traffic cameras",
    source: "NYC Department of Transportation traffic management center",
    every: 900, fromSnapshot: true,
    async run(f) {
      const cams = snapshot?.cameras;
      if (!cams?.list?.length) throw new Error("no camera list");
      setModule(f, "ok",
        `<div class="camframe"><img id="camimg" src="" alt="live traffic camera"><div class="scan"></div><div class="camlabel" id="camlabel"></div></div>`,
        new Date(snapshot.generated));
      startCameraRotation(cams);
      report(f, true, `TRAFFIC CAMERAS <span class="t-val">${fmtInt(cams.total || cams.length)}</span> ONLINE`);
    }
  },

  {
    id: "citibike", domain: "streets", title: "Citi Bike docks", wide: false,
    instrument: "Dock telemetry from every station in the system, refreshed about once a minute",
    source: "Citi Bike general bikeshare feed specification",
    every: 180,
    async run(f) {
      const j = await getJSON("https://gbfs.citibikenyc.com/gbfs/en/station_status.json");
      const st = j?.data?.stations || [];
      if (!st.length) throw new Error("no stations");
      let bikes = 0, ebikes = 0, docks = 0, renting = 0;
      st.forEach(s => {
        bikes += s.num_bikes_available || 0;
        ebikes += s.num_ebikes_available || 0;
        docks += s.num_docks_available || 0;
        if (s.is_renting) renting++;
      });
      const t = new Date((j.last_updated || 0) * 1000);
      setModule(f, stateFor(t, 15),
        `<div class="big">${fmtInt(bikes)}</div>
         <div class="big-label">bikes ready to ride across ${fmtInt(renting)} active stations</div>
         <div class="rows">
           <div class="r"><span>Electric bikes</span><b>${fmtInt(ebikes)}</b></div>
           <div class="r"><span>Open docks</span><b>${fmtInt(docks)}</b></div>
         </div>`, t);
      report(f, true, `CITI BIKES AVAILABLE <span class="t-val">${fmtInt(bikes)}</span>`);
    }
  },

  /* ---------------- TRANSIT ---------------- */
  {
    id: "subway", domain: "transit", title: "Subway trains reporting", wide: false,
    instrument: "Train-position messages from the eight real-time subway feeds",
    source: "Metropolitan Transportation Authority, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const s = snapshot?.subway;
      if (!s || s.trains == null) throw new Error("no subway data");
      const t = new Date(s.asOf);
      setModule(f, stateFor(t, 40),
        `<div class="big">${fmtInt(s.trains)}</div>
         <div class="big-label">trains transmitting a position on the tracks right now</div>
         <div class="rows">
           ${s.alerts != null ? `<div class="r"><span>Active service alerts</span><b>${fmtInt(s.alerts)}</b></div>` : ""}
         </div>`, t);
      report(f, true, `SUBWAY TRAINS REPORTING <span class="t-val">${fmtInt(s.trains)}</span>`);
    }
  },

  {
    id: "ferry", domain: "transit", title: "NYC Ferry vessels", wide: false,
    instrument: "Boat-position messages from the ferry system's vehicle feed",
    source: "NYC Ferry real-time feed, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const s = snapshot?.ferry;
      if (!s || s.vessels == null) throw new Error("no ferry data");
      const t = new Date(s.asOf);
      setModule(f, stateFor(t, 40),
        `<div class="big">${s.vessels}</div>
         <div class="big-label">ferries transmitting a position on the water</div>`, t);
      report(f, true, `FERRIES ON THE WATER <span class="t-val">${s.vessels}</span>`);
    }
  },

  /* ---------------- POWER ---------------- */
  {
    id: "load", domain: "power", title: "Electric demand", wide: false,
    instrument: "Metered load on the grid, New York City zone of the state system",
    source: "New York Independent System Operator, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const g = snapshot?.nyiso;
      if (!g || g.nycLoadMw == null) throw new Error("no grid data");
      const t = new Date(g.asOf);
      setModule(f, stateFor(t, 45),
        `<div class="big">${fmtInt(Math.round(g.nycLoadMw))}<span class="unit">MW</span></div>
         <div class="big-label">being drawn by New York City right now</div>
         <div class="rows">
           ${g.isoLoadMw != null ? `<div class="r"><span>New York State total</span><b>${fmtInt(Math.round(g.isoLoadMw))} MW</b></div>` : ""}
         </div>`, t);
      report(f, true, `NYC ELECTRIC LOAD <span class="t-val">${fmtInt(Math.round(g.nycLoadMw))} MW</span>`);
    }
  },

  {
    id: "fuelmix", domain: "power", title: "What's making the power", wide: false,
    instrument: "Generation by fuel type across the state grid, updated about every 5 minutes at the source",
    source: "New York Independent System Operator, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const g = snapshot?.nyiso;
      if (!g?.fuelMix?.length) throw new Error("no fuel mix");
      const t = new Date(g.fuelAsOf || g.asOf);
      const total = g.fuelMix.reduce((a, x) => a + x.mw, 0);
      const rows = [...g.fuelMix].sort((a, b) => b.mw - a.mw).slice(0, 5).map(x =>
        `<div class="r"><span>${x.fuel}</span><b>${Math.round(x.mw / total * 100)}%</b></div>`).join("");
      const top = [...g.fuelMix].sort((a, b) => b.mw - a.mw)[0];
      setModule(f, stateFor(t, 45),
        `<div class="big">${Math.round(top.mw / total * 100)}<span class="unit">%</span></div>
         <div class="big-label">of the state's electricity is coming from ${top.fuel.toLowerCase()} right now</div>
         <div class="rows">${rows}</div>`, t);
      report(f, true, `TOP FUEL ${top.fuel.toUpperCase()} <span class="t-val">${Math.round(top.mw / total * 100)}%</span>`);
    }
  }
];

function coopsDate() {
  const p = new Date().toLocaleDateString("en-CA", { timeZone: ET }).split("-");
  return p[0] + p[1] + p[2];
}

/* ---------- camera rotation ---------- */
let camTimer = null;
function startCameraRotation(cams) {
  clearInterval(camTimer);
  const list = cams.list || cams;
  let i = Math.floor(Math.random() * list.length);
  const show = () => {
    const c = list[i % list.length];
    const img = $("#camimg"), lab = $("#camlabel");
    if (!img) return clearInterval(camTimer);
    img.src = `${c.url}?t=${Date.now()}`;
    lab.textContent = c.name;
    i++;
  };
  show();
  camTimer = setInterval(show, 9000);
}

/* ---------- sections + boot ---------- */

const SECTIONS = [
  ["sky", "Sky", "radar · weather stations · transponders"],
  ["water", "Water", "tide gauges · stream gauges · buoys · flood sensors"],
  ["streets", "Streets", "speed sensors · cameras · dock telemetry"],
  ["transit", "Transit", "train + boat position feeds"],
  ["power", "Power", "grid load + generation"]
];

function build() {
  SECTIONS.forEach(([dom, label, sub]) => {
    const h = document.createElement("div");
    h.className = "section-head";
    h.dataset.domain = dom;
    h.innerHTML = `<h2>${label}</h2><div class="rule"></div><span class="sub">${sub}</span>`;
    board.appendChild(h);
    FEEDS.filter(f => f.domain === dom).forEach(f => board.appendChild(makeModule(f)));
  });
}

async function runFeed(f) {
  try {
    await f.run(f);
  } catch (e) {
    console.warn(`[${f.id}]`, e.message);
    setModule(f, "err", `<div class="big" style="font-size:15px;color:var(--faint)">no signal — feed unreachable or empty</div>`);
    report(f, false, null);
  }
}

async function boot() {
  build();
  try { await loadSnapshot(); } catch (e) { console.warn("snapshot", e.message); }
  FEEDS.forEach((f, i) => {
    setTimeout(() => {
      runFeed(f);
      setInterval(async () => {
        if (f.fromSnapshot) { try { await loadSnapshot(); } catch {} }
        runFeed(f);
      }, f.every * 1000);
    }, i * 350); // stagger initial burst
  });
  // refresh relative "x min ago" labels
  setInterval(() => {
    document.querySelectorAll(".mod[data-asof]").forEach(el => {
      const d = new Date(+el.dataset.asof);
      const span = $(".asof", el);
      if (span && el.dataset.state !== "err") span.textContent = `as of ${fmtTimeET(d)} · ${rel(d)}`;
    });
  }, 30000);
}

/* ---------- clock ---------- */
setInterval(() => {
  const now = new Date();
  $("#clock").textContent = now.toLocaleTimeString("en-US", { timeZone: ET, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#clock-date").textContent = now.toLocaleDateString("en-US", { timeZone: ET, weekday: "long", month: "long", day: "numeric", year: "numeric" }) + " · Eastern";
}, 1000);

/* ---------- AI popover ---------- */
$("#ai-btn").addEventListener("click", e => {
  e.stopPropagation();
  $("#ai-pop").classList.toggle("open");
});
document.addEventListener("click", e => {
  if (!$("#ai-pop").contains(e.target)) $("#ai-pop").classList.remove("open");
});

boot();
