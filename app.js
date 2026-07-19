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
  mapPush("floodnet"); mapPush("ferry");
}

/* ---------- shared state for the map ---------- */
const STATE = {};       // latest parsed data per feed
let stationsGeo = null; // data/stations.json — camera + flood-sensor locations
function mapPush(id) { if (window.MAP?.ready) MAP.refresh(id); }

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
      STATE.weather = rows; mapPush("weather");
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
      const radUrls = cells.map(c =>
        `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/${z}/${c.x}/${c.y}.png?${bucket}`);
      const rad = radUrls.map(u => `<img src="${u}" alt="" onerror="this.style.display='none'">`).join("");
      setModule(f, "ok",
        `<div class="tilebox" id="radar-box">
           <div class="tilegrid">${base}</div>
           <div class="tilegrid overlay">${rad}</div>
           <div class="scan"></div>
           <div class="sweep"></div>
           <div class="clearmsg"><b>Sky clear</b><span>no precipitation echoes — the antenna keeps scanning</span></div>
           <div class="maplabel" id="radar-label">NEXRAD composite · greater New York · refreshes every 5 min</div>
         </div>`, new Date());
      report(f, true, `RADAR <span class="t-val">LIVE</span>`);
      // A rain-free radar renders fully transparent, which reads as broken —
      // sample the tiles' pixels and, when the sky is genuinely quiet, show a
      // scanning sweep + "sky clear" so the panel never looks dead.
      radarEchoCheck(radUrls).then(hasEchoes => {
        const box = $("#radar-box"), lab = $("#radar-label");
        if (hasEchoes === false && box) {
          box.classList.add("clear");
          if (lab) lab.textContent = "radar live · refreshes every 5 min";
        }
      });
    }
  },

  {
    id: "satellite", domain: "sky", title: "Satellite view", wide: true,
    instrument: "Advanced Baseline Imager on the GOES-East geostationary weather satellite, 22,236 miles up — northeast sector",
    source: "NOAA National Environmental Satellite, Data and Information Service",
    every: 300,
    async run(f) {
      const bucket = Math.floor(Date.now() / 300000);
      // GOES-East is GOES-19; fall back to the GOES-16 path if the CDN moves
      const chain = [
        `https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ne/GEOCOLOR/600x600.jpg?${bucket}`,
        `https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ne/GEOCOLOR/latest.jpg?${bucket}`,
        `https://cdn.star.nesdis.noaa.gov/GOES16/ABI/SECTOR/ne/GEOCOLOR/600x600.jpg?${bucket}`
      ];
      const url = await new Promise(res => {
        let i = 0;
        const tryNext = () => {
          if (i >= chain.length) return res(null);
          const img = new Image();
          img.onload = () => res(chain[i]);
          img.onerror = () => { i++; tryNext(); };
          img.src = chain[i];
        };
        tryNext();
      });
      if (!url) throw new Error("no satellite frame");
      setModule(f, "ok",
        `<div class="tilebox">
           <img src="${url}" alt="GOES-East satellite view of the northeast" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
           <div class="scan"></div>
           <div class="maplabel">GOES-East GeoColor · northeast sector · new frame about every 5 min · night shows city lights</div>
         </div>`, new Date());
      report(f, true, `SATELLITE <span class="t-val">LIVE</span>`);
    }
  },

  {
    id: "polarsat", domain: "sky", title: "Low-orbit pass", wide: true,
    instrument: "Visible Infrared Imaging Radiometer Suite aboard the NOAA-20 polar orbiter, 512 miles up — a true-color look at the city itself, about 375 meters per pixel, one early-afternoon pass a day. Some days you get the city; some days you get the clouds.",
    source: "NASA Global Imagery Browse Services",
    every: 3600,
    async run(f) {
      const etISO = off => {
        const d = new Date(Date.now() - off * 86400000);
        return d.toLocaleDateString("en-CA", { timeZone: ET });
      };
      const base = d => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${d}/GoogleMapsCompatible_Level9/9`;
      let useDate = null, isToday = false;
      for (const off of [0, 1, 2]) {
        const d = etISO(off);
        try {
          const r = await fetch(`${base(d)}/192/150.jpg`, { method: "GET" });
          if (r.ok && (await r.blob()).size > 1000) { useDate = d; isToday = off === 0; break; }
        } catch {}
      }
      if (!useDate) throw new Error("no recent pass imagery");
      const cells = [191, 192, 193].map(y => [149, 150, 151].map(x => ({ x, y }))).flat();
      const imgs = cells.map(c => `<img src="${base(useDate)}/${c.y}/${c.x}.jpg" alt="">`).join("");
      const [, m, dd] = useDate.split("-");
      const dateTxt = new Date(+useDate.slice(0, 4), +m - 1, +dd).toLocaleDateString("en-US", { month: "long", day: "numeric" });
      setModule(f, "ok",
        `<div class="tilebox">
           <div class="tilegrid">${imgs}</div>
           <div class="scan"></div>
           <div class="maplabel">${isToday ? "today's" : dateTxt + "'s"} pass · NOAA-20 crosses the city around 1:30 p.m.; imagery lands a few hours later</div>
         </div>`, new Date());
      report(f, true, `LOW-ORBIT PASS <span class="t-val">${isToday ? "TODAY" : dateTxt.toUpperCase()}</span>`);
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
      STATE.aircraft = ac; mapPush("aircraft");
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
      STATE.battery = { lvl, next, tempF: wt?.data?.[0]?.v ? Math.round(parseFloat(wt.data[0].v)) : null, time: t };
      mapPush("noaa");
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
      STATE.kingspoint = { lvl: parseFloat(d.v), time: t }; mapPush("noaa");
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
        const geo = s.sourceInfo.geoLocation?.geogLocation;
        return last ? {
          name: s.sourceInfo.siteName,
          val: parseFloat(last.value),
          time: new Date(last.dateTime),
          lat: geo?.latitude, lon: geo?.longitude
        } : null;
      }).filter(Boolean).filter(s => !isNaN(s.val));
      if (!sites.length) throw new Error("no gauges");
      STATE.usgs = sites; mapPush("usgs");
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

  {
    id: "airgap", domain: "water", title: "Bridge clearance", wide: false,
    instrument: "Microwave air-gap sensors under the Verrazzano and Bayonne bridge decks, measuring clearance for ships",
    source: "NOAA Physical Oceanographic Real-Time System",
    every: 300,
    async run(f) {
      const base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=air_gap&date=latest&time_zone=lst_ldt&units=english&format=json";
      const [vz, bay] = await Promise.all([
        getJSON(`${base}&station=8517986`),
        getJSON(`${base}&station=8519461`).catch(() => null)
      ]);
      const d = vz?.data?.[0];
      if (!d) throw new Error("no air gap");
      const t = parseETLocal(d.t);
      const bd = bay?.data?.[0];
      STATE.airgap = { vz: parseFloat(d.v), bay: bd ? parseFloat(bd.v) : null, time: t };
      mapPush("noaa");
      setModule(f, stateFor(t, 40),
        `<div class="big">${fmt1(parseFloat(d.v))}<span class="unit">ft</span></div>
         <div class="big-label">of air between the water and the Verrazzano-Narrows Bridge right now — it breathes with the tide</div>
         <div class="rows">${bd ? `<div class="r"><span>Bayonne Bridge</span><b>${fmt1(parseFloat(bd.v))} ft</b></div>` : ""}</div>`, t);
      report(f, true, `VERRAZZANO CLEARANCE <span class="t-val">${fmt1(parseFloat(d.v))} FT</span>`);
    }
  },

  {
    id: "ships", domain: "water", title: "Ships in the harbor", wide: false,
    instrument: "Automatic Identification System transponders on every large vessel, heard by volunteer shore receivers around the harbor",
    source: "aisstream.io volunteer network, via the harbor relay",
    every: 300,
    async run(f) {
      const vessels = await listenAIS(25000);
      if (!vessels.length) throw new Error("no AIS traffic heard");
      STATE.ships = vessels; mapPush("ships");
      const moving = vessels.filter(x => (x.sog ?? 0) > 0.5);
      const fastest = [...moving].sort((a, b) => (b.sog ?? 0) - (a.sog ?? 0))[0];
      const now = new Date();
      setModule(f, "ok",
        `<div class="big">${vessels.length}</div>
         <div class="big-label">vessels transmitting on the water around the city</div>
         <div class="rows">
           <div class="r"><span>Underway right now</span><b>${moving.length}</b></div>
           ${fastest?.name ? `<div class="r"><span>Fastest: ${fastest.name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}</span><b>${fmt1(fastest.sog)} kt</b></div>` : ""}
         </div>`, now);
      report(f, true, `SHIPS TRANSMITTING <span class="t-val">${vessels.length}</span>`);
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
    instrument: "The city's network of about 950 traffic cameras — sit back for the tour, or click any dot on the little map to look through that lens",
    source: "NYC Department of Transportation traffic management center",
    every: 900, fromSnapshot: true,
    async run(f) {
      const cams = snapshot?.cameras;
      if (!cams?.list?.length) throw new Error("no camera list");
      if (!document.getElementById("camwrap")) {
        setModule(f, "ok",
          `<div class="camwrap" id="camwrap">
             <div class="camframe">
               <img id="camimg" src="" alt="live traffic camera">
               <div class="scan"></div>
               <button id="camresume">&#9654; resume tour</button>
               <div class="camlabel" id="camlabel"></div>
             </div>
             <div id="cammini" aria-label="every camera location — click one to view it"></div>
           </div>`,
          new Date(snapshot.generated));
        startCameraRotation(cams);
        buildCameraMiniMap();
      } else {
        setModule(f, "ok", null, new Date(snapshot.generated));
      }
      report(f, true, `TRAFFIC CAMERAS <span class="t-val">${fmtInt(cams.total || cams.list.length)}</span> ONLINE`);
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
      STATE.bikeStatus = st; mapPush("citibike");
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

  {
    id: "bikecounters", domain: "streets", title: "Bike + walk counters", wide: false,
    instrument: "Automated counters embedded in bridges and bike lanes, tallying riders and walkers in 15-minute bins",
    source: "NYC Department of Transportation, via NYC Open Data",
    every: 900,
    async run(f) {
      const sinceET = new Date(Date.now() - 24 * 3600000).toLocaleString("sv-SE", { timeZone: ET }).replace(" ", "T");
      const [byMode, bySensor] = await Promise.all([
        getJSON(`https://data.cityofnewyork.us/resource/ct66-47at.json?$select=travelmode,sum(counts) as total,max(timestamp) as latest&$where=timestamp>'${sinceET}'&$group=travelmode`),
        getJSON(`https://data.cityofnewyork.us/resource/ct66-47at.json?$select=sensor_id,sum(counts) as total&$where=timestamp>'${sinceET}' AND travelmode='bike'&$group=sensor_id`)
      ]);
      if (!byMode?.length) throw new Error("no counter data");
      const bikes = byMode.find(r => r.travelmode === "bike");
      const peds = byMode.find(r => (r.travelmode || "").startsWith("ped"));
      const latest = new Date(Math.max(...byMode.map(r => parseETLocal(r.latest.replace("T", " ").slice(0, 16)).getTime())));
      if (!this.sensorInfo) {
        const info = await getJSON("https://data.cityofnewyork.us/resource/6up2-gnw8.json?$select=id,name,lat,lon&$limit=500");
        this.sensorInfo = new Map(info.map(s => [s.id, s]));
      }
      STATE.bikeMap = bySensor.map(r => {
        const s = this.sensorInfo.get(r.sensor_id);
        return s?.lat ? { name: s.name, lat: +s.lat, lon: +s.lon, total: +r.total } : null;
      }).filter(Boolean);
      mapPush("bikecounters");
      setModule(f, stateFor(latest, 10 * 60), // counts reach the open-data portal hours behind
        `<div class="big">${fmtInt(Math.round(+(bikes?.total || 0)))}</div>
         <div class="big-label">bike trips counted in the last 24 hours across ${fmtInt(bySensor.length)} automated counters — the portal runs a few hours behind the street</div>
         <div class="rows">
           ${peds ? `<div class="r"><span>Pedestrians counted</span><b>${fmtInt(Math.round(+peds.total))}</b></div>` : ""}
         </div>`, latest);
      report(f, true, `BIKES COUNTED (24H) <span class="t-val">${fmtInt(Math.round(+(bikes?.total || 0)))}</span>`);
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
    id: "buses", domain: "transit", title: "Buses reporting", wide: false,
    instrument: "Satellite-positioning trackers on every bus in service, polled through the Bus Time feed",
    source: "MTA Bus Time",
    every: 180,
    async run(f) {
      // Public, rate-limited Bus Time key — the same one already published in
      // the nyc-bus-tracker project.
      const j = await getJSON("https://bustime.mta.info/api/siri/vehicle-monitoring-v2.json?key=5ecc401b-fc5b-4048-91bc-df104885f171&VehicleMonitoringDetailLevel=basic");
      const va = j?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
      if (!va.length) throw new Error("no buses in feed");
      const buses = va.map(v => {
        const m = v.MonitoredVehicleJourney || {};
        const line = Array.isArray(m.PublishedLineName) ? m.PublishedLineName[0] : m.PublishedLineName;
        return { line, lat: m.VehicleLocation?.Latitude, lon: m.VehicleLocation?.Longitude, t: v.RecordedAtTime };
      }).filter(b => b.lat != null && b.lon != null);
      const routes = new Set(buses.map(b => b.line).filter(Boolean));
      STATE.buses = buses; mapPush("buses");
      const t = new Date();
      setModule(f, "ok",
        `<div class="big">${fmtInt(buses.length)}</div>
         <div class="big-label">buses transmitting a position, across ${fmtInt(routes.size)} routes</div>`, t);
      report(f, true, `BUSES REPORTING <span class="t-val">${fmtInt(buses.length)}</span>`);
    }
  },

  {
    id: "elevators", domain: "transit", title: "Elevators + escalators", wide: false,
    instrument: "Status telemetry from the subway's elevator and escalator fleet — this feed lists what's broken right now",
    source: "Metropolitan Transportation Authority equipment outage feed",
    every: 300,
    async run(f) {
      const j = await getJSON("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json");
      if (!Array.isArray(j)) throw new Error("bad outage feed");
      const el = j.filter(o => o.equipmenttype === "EL").length;
      const es = j.filter(o => o.equipmenttype === "ES").length;
      const ada = j.filter(o => o.ADA === "Y").length;
      const t = new Date();
      setModule(f, "ok",
        `<div class="big">${fmtInt(j.length)}</div>
         <div class="big-label">subway elevators and escalators out of service right now</div>
         <div class="rows">
           <div class="r"><span>Elevators</span><b>${el}</b></div>
           <div class="r"><span>Escalators</span><b>${es}</b></div>
           <div class="r"><span>On accessible routes</span><b>${ada}</b></div>
         </div>`, t);
      report(f, true, `ELEVATORS/ESCALATORS OUT <span class="t-val">${fmtInt(j.length)}</span>`);
    }
  },

  {
    id: "rail", domain: "transit", title: "Commuter trains", wide: false,
    instrument: "Train-position and trip messages from the Long Island Rail Road and Metro-North feeds",
    source: "Metropolitan Transportation Authority, via snapshot",
    every: 900, fromSnapshot: true,
    async run(f) {
      const r = snapshot?.rail;
      if (!r || (!r.lirr && !r.mnr)) throw new Error("no rail data");
      const t = new Date(r.asOf);
      const total = (r.lirr?.trains || 0) + (r.mnr?.trains || 0);
      setModule(f, stateFor(t, 40),
        `<div class="big">${fmtInt(total)}</div>
         <div class="big-label">commuter trains reporting on the region's two railroads</div>
         <div class="rows">
           ${r.lirr ? `<div class="r"><span>Long Island Rail Road</span><b>${fmtInt(r.lirr.trains)}</b></div>` : ""}
           ${r.mnr ? `<div class="r"><span>Metro-North</span><b>${fmtInt(r.mnr.trains)}</b></div>` : ""}
         </div>`, t);
      report(f, true, `COMMUTER TRAINS <span class="t-val">${fmtInt(total)}</span>`);
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
    id: "quakes", domain: "ground", title: "Seismographs", wide: false,
    instrument: "The Lamont-Doherty cooperative seismographic network listens under the region; the United States Geological Survey catalogs what it hears",
    source: "USGS earthquake catalog",
    every: 1800,
    async run(f) {
      const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const j = await getJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=40.7128&longitude=-74.006&maxradiuskm=300&starttime=${start}`);
      const feats = j?.features;
      if (!Array.isArray(feats)) throw new Error("no catalog");
      const quakes = feats.map(q => ({
        mag: q.properties.mag, place: q.properties.place,
        time: new Date(q.properties.time),
        lat: q.geometry?.coordinates?.[1], lon: q.geometry?.coordinates?.[0]
      })).filter(q => q.mag != null);
      STATE.quakes = quakes; mapPush("quakes");
      const strongest = [...quakes].sort((a, b) => b.mag - a.mag)[0];
      const now = new Date();
      setModule(f, "ok",
        `<div class="big">${quakes.length}</div>
         <div class="big-label">earthquakes detected within 300 kilometers in the past 30 days${quakes.length === 0 ? " — the ground is quiet" : ""}</div>
         ${strongest ? `<div class="rows"><div class="r"><span>Strongest: ${strongest.place}</span><b>M${fmt1(strongest.mag)}</b></div></div>` : ""}`, now);
      report(f, true, `QUAKES DETECTED (30D) <span class="t-val">${quakes.length}</span>`);
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

/* Returns true if any radar tile has visible echoes, false if all are
   transparent, null if the check itself fails (tainted canvas, load error). */
async function radarEchoCheck(urls) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    for (const u of urls) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const ok = await new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = u; });
      if (!ok) continue;
      ctx.clearRect(0, 0, 32, 32);
      ctx.drawImage(img, 0, 0, 32, 32);
      const px = ctx.getImageData(0, 0, 32, 32).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 16) return true;
    }
    return false;
  } catch { return null; }
}

/* Listen to the harbor's Automatic Identification System relay for a spell
   and return every vessel heard. The stream key lives inside the Cloudflare
   Worker, so the page needs none. */
function listenAIS(ms) {
  return new Promise(resolve => {
    const v = new Map();
    let ws;
    try { ws = new WebSocket("wss://nyc-harbor-ais-relay.josh-greenman.workers.dev"); }
    catch { return resolve([]); }
    const done = () => {
      try { ws.close(); } catch {}
      resolve([...v.values()].filter(o => o.lat != null));
    };
    const timer = setTimeout(done, ms);
    ws.addEventListener("message", ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      let o = v.get(m.mmsi); if (!o) { o = {}; v.set(m.mmsi, o); }
      if (m.type === "pos") { o.lat = m.lat; o.lon = m.lon; o.sog = m.sog; if (m.name) o.name = m.name; }
      else if (m.type === "static") { if (m.name) o.name = m.name; o.st = m.shipType; }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); done(); });
  });
}

function coopsDate() {
  const p = new Date().toLocaleDateString("en-CA", { timeZone: ET }).split("-");
  return p[0] + p[1] + p[2];
}

/* ---------- camera tour + click-anywhere mini-map ---------- */
let camTimer = null, camTouring = true, camMini = null, camSelDot = null;

function showCamera(cam, manual) {
  const img = $("#camimg"), lab = $("#camlabel"), btn = $("#camresume");
  if (!img) return;
  img.src = `${cam.url}?t=${Date.now()}`;
  lab.textContent = cam.name;
  if (manual) {
    camTouring = false;
    if (btn) btn.style.display = "block";
  }
}

function startCameraRotation(cams) {
  clearInterval(camTimer);
  const list = cams.list || cams;
  let i = Math.floor(Math.random() * list.length);
  camTouring = true;
  const tick = () => {
    if (!$("#camimg")) return clearInterval(camTimer);
    if (!camTouring) return;
    showCamera(list[i % list.length], false);
    i++;
  };
  tick();
  camTimer = setInterval(tick, 9000);
  const btn = $("#camresume");
  if (btn) btn.addEventListener("click", () => {
    btn.style.display = "none";
    if (camSelDot) { camSelDot.setStyle({ radius: 3, fillOpacity: 0.55 }); camSelDot = null; }
    camTouring = true;
    tick();
  });
}

function buildCameraMiniMap() {
  if (typeof L === "undefined") return;
  const tryBuild = () => {
    const el = document.getElementById("cammini");
    if (!el || camMini) return;
    if (!stationsGeo?.cameras) { setTimeout(tryBuild, 1500); return; }
    camMini = L.map(el, {
      center: [40.69, -73.97], zoom: 9.5, zoomSnap: 0.5,
      renderer: L.canvas({ padding: 0.3 }),
      attributionControl: false, scrollWheelZoom: false
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(camMini);
    window._camDots = [];
    for (const [lat, lon, name, cid] of stationsGeo.cameras) {
      const d = L.circleMarker([lat, lon], { radius: 3, weight: 0, fillColor: "#ff6d3d", fillOpacity: 0.55 });
      d.on("click", () => {
        if (camSelDot) camSelDot.setStyle({ radius: 3, fillOpacity: 0.55 });
        d.setStyle({ radius: 6, fillOpacity: 1 });
        camSelDot = d;
        showCamera({ name, url: `https://webcams.nyctmc.org/api/cameras/${cid}/image` }, true);
      });
      d.addTo(camMini);
      window._camDots.push(d);
    }
    setTimeout(() => camMini.invalidateSize(), 300);
  };
  tryBuild();
}

/* =====================================================================
   THE MAP — every sensor with a location, one Leaflet canvas.
   Fixed instruments render as dots; live things (aircraft, ferries,
   wet flood sensors) re-render as their feeds refresh.
   ===================================================================== */

const MAP = window.MAP = {
  ready: false, map: null, layers: {},

  DEFS: [
    { id: "floodnet", label: "Flood sensors", color: "#53d7f0", on: true },
    { id: "noaa",     label: "Tide gauges + buoy", color: "#53d7f0", on: true },
    { id: "usgs",     label: "Stream gauges", color: "#8fe3f5", on: true },
    { id: "weather",  label: "Weather stations", color: "#ffb454", on: true },
    { id: "aircraft", label: "Aircraft", color: "#ffb454", on: true },
    { id: "traffic",  label: "Traffic speed", color: "#ff6d3d", on: true },
    { id: "cameras",  label: "Cameras", color: "#ff6d3d", on: true },
    { id: "bikecounters", label: "Bike counters", color: "#ffa07a", on: true },
    { id: "buses",    label: "Buses", color: "#c08ae8", on: true },
    { id: "citibike", label: "Citi Bike docks", color: "#ef7fd4", on: false },
    { id: "ferry",    label: "Ferries", color: "#ef7fd4", on: true },
    { id: "ships",    label: "Ships", color: "#6fe0c8", on: true },
    { id: "quakes",   label: "Quake epicenters, 30 days", color: "#d2a06a", on: true }
  ],

  init() {
    if (typeof L === "undefined" || !document.getElementById("map")) return;
    this.map = L.map("map", {
      center: [40.72, -73.94], zoom: 11, zoomSnap: 0.5,
      renderer: L.canvas({ padding: 0.4 }),
      attributionControl: false, scrollWheelZoom: false
    });
    L.control.attribution({ prefix: false })
      .addAttribution('&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap')
      .addTo(this.map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(this.map);

    const chips = document.getElementById("map-chips");
    for (const d of this.DEFS) {
      this.layers[d.id] = { ...d, group: L.layerGroup(), count: null };
      if (d.on) this.layers[d.id].group.addTo(this.map);
      const b = document.createElement("button");
      b.className = "map-chip" + (d.on ? " on" : "");
      b.style.setProperty("--chip", d.color);
      b.dataset.layer = d.id;
      b.innerHTML = `<span class="dot"></span>${d.label}<span class="n"></span>`;
      b.addEventListener("click", () => this.toggle(d.id, b));
      chips.appendChild(b);
      this.layers[d.id].chip = b;
    }
    this.ready = true;
    for (const id of Object.keys(this.layers)) this.refresh(id);
  },

  toggle(id, btn) {
    const l = this.layers[id];
    l.on = !l.on;
    btn.classList.toggle("on", l.on);
    if (l.on) { l.group.addTo(this.map); this.refresh(id); }
    else l.group.remove();
  },

  setCount(id, n) {
    const l = this.layers[id];
    if (l?.chip) l.chip.querySelector(".n").textContent = n == null ? "" : ` · ${fmtInt(n)}`;
  },

  dot(lat, lon, opts) {
    return L.circleMarker([lat, lon], {
      radius: 4, weight: 1, color: opts.color, fillColor: opts.fill || opts.color,
      fillOpacity: opts.fillOpacity ?? 0.75, opacity: opts.opacity ?? 0.95, ...opts
    });
  },

  pop(html) { return `<div class="mpop">${html}</div>`; },

  refresh(id) {
    if (!this.ready) return;
    const l = this.layers[id];
    if (!l || !l.on) return;
    try { this["draw_" + id](l); } catch (e) { console.warn("map", id, e.message); }
  },

  /* ---- fixed water instruments: NOAA tide stations + wave buoy ---- */
  draw_noaa(l) {
    l.group.clearLayers();
    const items = [
      { lat: 40.7006, lon: -74.0142, name: "The Battery tide gauge",
        body: () => STATE.battery ? `water level <b>${fmt1(STATE.battery.lvl)} ft</b>${STATE.battery.tempF ? ` · water ${STATE.battery.tempF}°F` : ""}${STATE.battery.next ? `<br>${STATE.battery.next}` : ""}` : "awaiting reading" },
      { lat: 40.8103, lon: -73.7649, name: "Kings Point tide gauge",
        body: () => STATE.kingspoint ? `water level <b>${fmt1(STATE.kingspoint.lvl)} ft</b>` : "awaiting reading" },
      { lat: 40.369, lon: -73.703, name: "Buoy 44065 — harbor entrance",
        body: () => {
          const b = snapshot?.buoy;
          return b?.waveHeightM != null ? `waves <b>${fmt1(mToFt(b.waveHeightM))} ft</b> every ${Math.round(b.domPeriodS ?? 0)} sec · water ${Math.round(cToF(b.waterTempC ?? 0))}°F` : "awaiting reading";
        } },
      { lat: 40.6062, lon: -74.0448, name: "Verrazzano-Narrows air gap",
        body: () => STATE.airgap ? `<b>${fmt1(STATE.airgap.vz)} ft</b> of clearance under the deck` : "awaiting reading" },
      { lat: 40.642, lon: -74.1421, name: "Bayonne Bridge air gap",
        body: () => STATE.airgap?.bay != null ? `<b>${fmt1(STATE.airgap.bay)} ft</b> of clearance under the deck` : "awaiting reading" }
    ];
    for (const it of items) {
      const m = this.dot(it.lat, it.lon, { color: "#53d7f0", radius: 6 });
      m.bindPopup(() => this.pop(`<h5>${it.name}</h5>${it.body()}`));
      l.group.addLayer(m);
    }
    this.setCount("noaa", items.length);
  },

  /* ---- USGS stream gauges ---- */
  draw_usgs(l) {
    if (!STATE.usgs) return;
    l.group.clearLayers();
    for (const s of STATE.usgs) {
      if (s.lat == null) continue;
      const m = this.dot(s.lat, s.lon, { color: "#8fe3f5", radius: 5 });
      m.bindPopup(this.pop(`<h5>${s.name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}</h5>gauge height <b>${fmt1(s.val)} ft</b><br>as of ${fmtTimeET(s.time)}`));
      l.group.addLayer(m);
    }
    this.setCount("usgs", STATE.usgs.length);
  },

  /* ---- FloodNet: all sensors dim, wet ones bright ---- */
  draw_floodnet(l) {
    if (!stationsGeo?.floodnet) return;
    l.group.clearLayers();
    const wet = new Map((snapshot?.floodnet?.wet || []).map(w => [w.id, w]));
    for (const [lat, lon, name, sid] of stationsGeo.floodnet) {
      const w = wet.get(sid);
      const m = this.dot(lat, lon, w
        ? { color: "#53d7f0", radius: 7, fillOpacity: 0.95 }
        : { color: "#2e6b7d", radius: 2.5, weight: 0, fillOpacity: 0.55 });
      m.bindPopup(this.pop(`<h5>${name}</h5>${w ? `<b>${fmt1(w.depthIn)} in of water on the street</b>` : "street flood sensor — currently dry"}`));
      l.group.addLayer(m);
    }
    this.setCount("floodnet", stationsGeo.floodnet.length);
  },

  /* ---- weather stations ---- */
  draw_weather(l) {
    l.group.clearLayers();
    const coords = { "Central Park": [40.7789, -73.9692], "LaGuardia": [40.7794, -73.8803], "Kennedy Airport": [40.6386, -73.7622] };
    let n = 0;
    for (const [name, [lat, lon]] of Object.entries(coords)) {
      const r = STATE.weather?.find(x => x.station === name);
      const m = this.dot(lat, lon, { color: "#ffb454", radius: 6 });
      m.bindPopup(() => this.pop(`<h5>${name} weather station</h5>${r ? `<b>${Math.round(r.tempF)}°F</b>${r.desc ? ` · ${r.desc}` : ""}${r.wind != null ? ` · wind ${Math.round(r.wind)} mph` : ""}` : "awaiting observation"}`));
      l.group.addLayer(m); n++;
    }
    this.setCount("weather", n);
  },

  /* ---- aircraft (live) ---- */
  draw_aircraft(l) {
    if (!STATE.aircraft) return;
    l.group.clearLayers();
    let n = 0;
    for (const a of STATE.aircraft) {
      if (a.lat == null || a.lon == null) continue;
      const heli = a.category === "A7";
      const m = this.dot(a.lat, a.lon, { color: heli ? "#ffe08a" : "#ffb454", radius: heli ? 5 : 3.5, fillOpacity: 0.9 });
      const alt = typeof a.alt_baro === "number" ? `${fmtInt(a.alt_baro)} ft` : a.alt_baro || "—";
      m.bindPopup(this.pop(`<h5>${(a.flight || a.r || "aircraft").trim()}${heli ? " · helicopter" : ""}</h5>altitude <b>${alt}</b>${a.gs ? ` · ${Math.round(a.gs)} kt` : ""}${a.t ? ` · ${a.t}` : ""}`));
      l.group.addLayer(m); n++;
    }
    this.setCount("aircraft", n);
  },

  /* ---- traffic sensors as speed-colored road segments ---- */
  trafficCache: { t: 0, rows: null },
  async draw_traffic(l) {
    if (Date.now() - this.trafficCache.t > 10 * 60000) {
      this.trafficCache.t = Date.now(); // set before await so concurrent calls don't double-fetch
      const j = await getJSON("https://data.cityofnewyork.us/resource/i4gi-tjb9.json?$select=id,speed,link_name,link_points,data_as_of&$order=data_as_of%20DESC&$limit=1500");
      const seen = new Set();
      this.trafficCache.rows = j.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id); return true;
      });
    }
    if (!this.trafficCache.rows) return;
    l.group.clearLayers();
    const ramp = s => s < 10 ? "#ff5d5d" : s < 20 ? "#ff8a4d" : s < 35 ? "#ffc14d" : "#57b890";
    let n = 0;
    for (const r of this.trafficCache.rows) {
      const spd = parseFloat(r.speed);
      if (isNaN(spd) || !r.link_points) continue;
      // the feed's coordinate strings are dirty: truncated pairs, dropped
      // minus signs. Keep only plausible NYC-area points and split the line
      // wherever consecutive points jump implausibly far.
      const pts = r.link_points.trim().split(/\s+/).map(p => {
        const [la, lo] = p.split(",").map(Number);
        return la > 40 && la < 41.6 && lo > -75.5 && lo < -71.5 ? [la, lo] : null;
      }).filter(Boolean);
      if (pts.length < 2) continue;
      const segs = [[pts[0]]];
      for (let i = 1; i < pts.length; i++) {
        const [pa, po] = pts[i - 1], [ca, co] = pts[i];
        if (Math.abs(ca - pa) > 0.03 || Math.abs(co - po) > 0.03) segs.push([pts[i]]);
        else segs[segs.length - 1].push(pts[i]);
      }
      let drew = false;
      for (const seg of segs) {
        if (seg.length < 2) continue;
        const line = L.polyline(seg, { color: ramp(spd), weight: 3, opacity: 0.75 });
        line.bindPopup(this.pop(`<h5>${r.link_name || "road segment"}</h5><b>${fmt1(spd)} mph</b> in the latest transmission`));
        l.group.addLayer(line); drew = true;
      }
      if (drew) n++;
    }
    this.setCount("traffic", n);
  },

  /* ---- traffic cameras: click for the live frame ---- */
  draw_cameras(l) {
    if (!stationsGeo?.cameras) return;
    l.group.clearLayers();
    for (const [lat, lon, name, cid] of stationsGeo.cameras) {
      const m = this.dot(lat, lon, { color: "#ff6d3d", radius: 2.5, weight: 0, fillOpacity: 0.6 });
      m.bindPopup(this.pop(`<h5>${name}</h5><img class="campop" alt="live camera frame" src="https://webcams.nyctmc.org/api/cameras/${cid}/image?t=${Math.floor(Date.now() / 30000)}">`), { minWidth: 290 });
      l.group.addLayer(m);
    }
    this.setCount("cameras", stationsGeo.cameras.length);
  },

  /* ---- automated bike + pedestrian counters ---- */
  draw_bikecounters(l) {
    if (!STATE.bikeMap) return;
    l.group.clearLayers();
    for (const s of STATE.bikeMap) {
      const m = this.dot(s.lat, s.lon, { color: "#ffa07a", radius: 5 });
      m.bindPopup(this.pop(`<h5>${s.name}</h5><b>${fmtInt(s.total)} bike trips</b> counted in the last 24 hours`));
      l.group.addLayer(m);
    }
    this.setCount("bikecounters", STATE.bikeMap.length);
  },

  /* ---- buses (live positions) ---- */
  draw_buses(l) {
    if (!STATE.buses) return;
    l.group.clearLayers();
    for (const b of STATE.buses) {
      const m = this.dot(b.lat, b.lon, { color: "#c08ae8", radius: 2, weight: 0, fillOpacity: 0.65 });
      m.bindPopup(this.pop(`<h5>${b.line || "bus"}</h5>position as of ${b.t ? fmtTimeET(new Date(b.t)) : "the latest poll"}`));
      l.group.addLayer(m);
    }
    this.setCount("buses", STATE.buses.length);
  },

  /* ---- Citi Bike docks (off by default: 2,000+ dots) ---- */
  bikeInfo: null,
  async draw_citibike(l) {
    if (!this.bikeInfo) {
      const j = await getJSON("https://gbfs.citibikenyc.com/gbfs/en/station_information.json");
      this.bikeInfo = new Map((j?.data?.stations || []).map(s => [s.station_id, s]));
    }
    if (!STATE.bikeStatus) return;
    l.group.clearLayers();
    let n = 0;
    for (const s of STATE.bikeStatus) {
      const info = this.bikeInfo.get(s.station_id);
      if (!info) continue;
      const bikes = s.num_bikes_available || 0;
      const m = this.dot(info.lat, info.lon, {
        color: bikes ? "#ef7fd4" : "#5a3550", radius: 2, weight: 0,
        fillOpacity: bikes ? 0.7 : 0.45
      });
      m.bindPopup(this.pop(`<h5>${info.name}</h5><b>${bikes} bikes</b> (${s.num_ebikes_available || 0} electric) · ${s.num_docks_available || 0} open docks`));
      l.group.addLayer(m); n++;
    }
    this.setCount("citibike", n);
  },

  /* ---- ships heard on the AIS relay ---- */
  draw_ships(l) {
    if (!STATE.ships) return;
    l.group.clearLayers();
    const TYPES = { 3: "fishing/towing", 5: "special craft", 6: "passenger vessel", 7: "cargo ship", 8: "tanker", 9: "other vessel" };
    for (const s of STATE.ships) {
      const moving = (s.sog ?? 0) > 0.5;
      const m = this.dot(s.lat, s.lon, { color: "#6fe0c8", radius: moving ? 5 : 3, fillOpacity: moving ? 0.9 : 0.5 });
      const kind = s.st != null ? TYPES[Math.floor(s.st / 10)] : null;
      m.bindPopup(this.pop(`<h5>${s.name ? s.name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : "Unnamed vessel"}</h5>${kind ? kind + " · " : ""}${s.sog != null ? `<b>${fmt1(s.sog)} kt</b>` : "speed unknown"}`));
      l.group.addLayer(m);
    }
    this.setCount("ships", STATE.ships.length);
  },

  /* ---- earthquake epicenters, past 30 days ---- */
  draw_quakes(l) {
    if (!STATE.quakes) return;
    l.group.clearLayers();
    for (const q of STATE.quakes) {
      if (q.lat == null) continue;
      const m = this.dot(q.lat, q.lon, { color: "#d2a06a", radius: 4 + Math.max(0, q.mag) * 2, fillOpacity: 0.5 });
      m.bindPopup(this.pop(`<h5>M${fmt1(q.mag)} earthquake</h5>${q.place}<br>${q.time.toLocaleDateString("en-US", { month: "long", day: "numeric" })} at ${fmtTimeET(q.time)}`));
      l.group.addLayer(m);
    }
    this.setCount("quakes", STATE.quakes.length);
  },

  /* ---- ferries (positions from the snapshot) ---- */
  draw_ferry(l) {
    l.group.clearLayers();
    const boats = snapshot?.ferry?.positions || [];
    for (const b of boats) {
      const m = this.dot(b.lat, b.lon, { color: "#ef7fd4", radius: 6 });
      m.bindPopup(this.pop(`<h5>NYC Ferry ${b.label}</h5>position as of the last snapshot (up to 15 min old)`));
      l.group.addLayer(m);
    }
    this.setCount("ferry", boats.length);
  }
};

/* ---------- sections + boot ---------- */

const SECTIONS = [
  ["sky", "Sky", "radar · weather stations · transponders"],
  ["water", "Water", "tide gauges · stream gauges · buoys · flood sensors"],
  ["streets", "Streets", "speed sensors · cameras · counters · dock telemetry"],
  ["transit", "Transit", "trains · buses · boats · broken elevators"],
  ["power", "Power", "grid load + generation"],
  ["ground", "Ground", "seismographs"]
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

async function loadStationsGeo() {
  const bucket = Math.floor(Date.now() / 3600000);
  stationsGeo = await getJSON(`data/stations.json?t=${bucket}`);
  mapPush("floodnet"); mapPush("cameras");
}

async function boot() {
  build();
  try { await loadSnapshot(); } catch (e) { console.warn("snapshot", e.message); }
  MAP.init();
  loadStationsGeo().catch(e => console.warn("stations", e.message));
  setInterval(() => loadStationsGeo().catch(() => {}), 3600 * 1000);
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
