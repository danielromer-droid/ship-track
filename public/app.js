/* Ship Track: live ships on a map.
   Live data arrives over a WebSocket from /api/stream (a Cloudflare Worker relaying aisstream.io).
   When the API is not reachable, or the AIS key is not set yet, the app switches to a simulated
   demo so the interface can still be tried. */
(function () {
  "use strict";
  if (!window.L) {
    document.getElementById("map").innerHTML = '<div class="nomap">The map library could not load. Check your connection and reload the page.</div>';
    return;
  }

  const EXPIRE_MS = 30 * 60e3; // forget a ship 30 min after its last position
  const STALE_MS = 12 * 60e3; // draw it faded after 12 min
  const DR_MAX_MS = 10 * 60e3; // dead reckoning: project a moving ship forward for at most 10 min
  const NM = 1852;
  const $ = (s) => document.querySelector(s);

  // ---------- small helpers ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("st:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("st:" + k, JSON.stringify(v)); } catch {} },
  };
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  function distM(a, b) {
    const R = 6371e3, p1 = rad(a[0]), p2 = rad(b[0]), dp = p2 - p1, dl = rad(b[1] - a[1]);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function move(p, brg, m) {
    const R = 6371e3, d = m / R, t = rad(brg), p1 = rad(p[0]), l1 = rad(p[1]);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [deg(p2), ((deg(l2) + 540) % 360) - 180];
  }
  const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const compass = (d) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(d / 45) % 8];
  const clean = (s) => { s = String(s || "").replace(/@+$/, "").replace(/\s+/g, " ").trim(); return s && !/^@+$/.test(s) ? s : null; };
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
  }
  function dms(v, pos, neg) {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${d}°${m.toFixed(2).padStart(5, "0")}′${v >= 0 ? pos : neg}`;
  }

  // ---------- AIS vocabulary ----------
  // Colour by ship type, close to the conventions of the big AIS sites so the map reads at a glance.
  const CATS = {
    cargo: { label: "Cargo", c: "#3fae49" },
    tanker: { label: "Tanker", c: "#e0453c" },
    passenger: { label: "Passenger", c: "#3b82e6" },
    highspeed: { label: "High speed", c: "#e6c229" },
    fishing: { label: "Fishing", c: "#f08a24" },
    special: { label: "Tug & service", c: "#1db5ae" },
    pleasure: { label: "Sailing & leisure", c: "#c252d4" },
    other: { label: "Other / unknown", c: "#98a4ad" },
  };
  function catOf(t) {
    if (t === 30) return "fishing";
    if ((t >= 31 && t <= 35) || (t >= 50 && t <= 59)) return "special";
    if (t === 36 || t === 37) return "pleasure";
    if (t >= 40 && t <= 49) return "highspeed";
    if (t >= 60 && t <= 69) return "passenger";
    if (t >= 70 && t <= 79) return "cargo";
    if (t >= 80 && t <= 89) return "tanker";
    return "other";
  }
  const TYPE_NAMES = { 30: "Fishing", 31: "Towing", 32: "Towing (large)", 33: "Dredging", 34: "Diving operations", 35: "Military", 36: "Sailing", 37: "Pleasure craft",
    50: "Pilot vessel", 51: "Search and rescue", 52: "Tug", 53: "Port tender", 54: "Anti-pollution", 55: "Law enforcement", 58: "Medical transport", 59: "Non-combatant" };
  function typeLabel(t) {
    if (!t) return "Type not reported";
    if (TYPE_NAMES[t]) return TYPE_NAMES[t];
    const d = Math.floor(t / 10), x = t % 10;
    const base = { 2: "Wing in ground", 4: "High-speed craft", 6: "Passenger", 7: "Cargo", 8: "Tanker", 9: "Other" }[d];
    if (!base) return `Type ${t}`;
    const haz = x >= 1 && x <= 4 ? ` · hazardous cat. ${"XABCD"[x]}` : "";
    return base + haz;
  }
  const NAV = ["Under way, engine", "At anchor", "Not under command", "Restricted manoeuvrability", "Constrained by draught", "Moored", "Aground",
    "Engaged in fishing", "Under way, sailing", null, null, "Towing astern", "Pushing ahead", null, "AIS-SART active", null];

  // Maritime Identification Digits (first 3 digits of a ship MMSI) → flag state.
  const MID = {};
  ("AL201 AD202 AT203 PT204 BE205 BY206 BG207 VA208 CY209 CY210 DE211 CY212 GE213 MD214 MT215 AM216 DE218 DK219 DK220 ES224 ES225 FR226 FR227 FR228 MT229 FI230 FO231 " +
   "GB232 GB233 GB234 GB235 GI236 GR237 HR238 GR239 GR240 GR241 MA242 HU243 NL244 NL245 NL246 IT247 MT248 MT249 IE250 IS251 LI252 LU253 MC254 PT255 MT256 NO257 NO258 NO259 " +
   "PL261 ME262 PT263 RO264 SE265 SE266 SK267 SM268 CH269 CZ270 TR271 UA272 RU273 MK274 LV275 EE276 LT277 SI278 RS279 AI301 US303 AG304 AG305 CW306 AW307 BS308 BS309 BM310 " +
   "BS311 BZ312 BB314 CA316 KY319 CR321 CU323 DM325 DO327 GP329 GD330 GL331 GT332 HN334 HT336 US338 JM339 KN341 LC343 MX345 MQ347 MS348 NI350 PA351 PA352 PA353 PA354 PA355 " +
   "PA356 PA357 PR358 SV359 PM361 TT362 TC364 US366 US367 US368 US369 PA370 PA371 PA372 PA373 PA374 VC375 VC376 VC377 VG378 VI379 AF401 SA403 BD405 BH408 BT410 CN412 CN413 " +
   "CN414 TW416 LK417 IN419 IR422 AZ423 IQ425 IL428 JP431 JP432 TM434 KZ436 UZ437 JO438 KR440 KR441 PS443 KP445 KW447 LB450 KG451 MO453 MV455 MN457 NP459 OM461 PK463 QA466 " +
   "SY468 AE470 AE471 TJ472 YE473 YE475 HK477 BA478 AU503 MM506 BN508 FM510 PW511 NZ512 KH514 KH515 CX516 CK518 FJ520 CC523 ID525 KI529 LA531 MY533 MP536 MH538 NC540 NU542 " +
   "NR544 PF546 PH548 TL550 PG553 PN555 SB557 AS559 WS561 SG563 SG564 SG565 SG566 TH567 TO570 TV572 VN574 VU576 VU577 WF578 ZA601 AO603 DZ605 BI609 BJ610 BW611 CF612 CM613 " +
   "CG615 KM616 CV617 CI619 KM620 DJ621 EG622 ET624 ER625 GA626 GH627 GM629 GW630 GQ631 GN632 BF633 KE634 LR636 LR637 SS638 LY642 LS644 MU645 MG647 ML649 MZ650 MR654 MW655 " +
   "NE656 NG657 NA659 RE660 RW661 SD662 SN663 SC664 SH665 SO666 SL667 ST668 SZ669 TD670 TG671 TN672 TZ674 UG675 CD676 TZ677 ZM678 ZW679 AR701 BR710 BO720 CL725 CO730 EC735 " +
   "FK740 GF745 GY750 PY755 PE760 SR765 UY770 VE775").split(" ").forEach((x) => { MID[x.slice(2)] = x.slice(0, 2); });
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch {}
  function flagOf(mmsi) {
    const s = String(mmsi);
    if (s.length !== 9 || !/^[2-7]/.test(s)) return null;
    const iso = MID[s.slice(0, 3)];
    if (!iso) return null;
    const emoji = String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
    let name = iso;
    try { name = regionNames ? regionNames.of(iso) : iso; } catch {}
    return { iso, emoji, name };
  }

  // ---------- state ----------
  const S = {
    mode: null, // "live" | "demo"
    ships: new Map(), // mmsi -> entry
    sel: null,
    follow: false,
    units: store.get("units", "nautical"),
    tags: store.get("tags", true),
    show: Object.assign(Object.fromEntries(Object.keys(CATS).map((k) => [k, true])), store.get("show", {})),
    msgs: 0, rate: 0, visible: 0, counts: {},
    lastError: null,
  };

  // ---------- map ----------
  const start = store.get("view", { c: [50.6, 1.8], z: 7 });
  const map = L.map("map", { zoomControl: false, worldCopyJump: true, attributionControl: true, minZoom: 2 }).setView(start.c, start.z);
  map.createPane("land").classList.add("leaflet-land-pane");
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  let land = null;
  fetch("land.json").then((r) => r.json()).then((g) => {
    land = L.geoJSON(g, { pane: "land", interactive: false, style: landStyle }).addTo(map);
  }).catch(() => {});
  function landStyle() { return { color: css("--coast"), weight: 1, fillColor: css("--land"), fillOpacity: 1 }; }

  const dark = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  let tiles = null;
  function setTiles() {
    if (tiles) map.removeLayer(tiles);
    tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark() ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, {
      subdomains: "abcd", maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · AIS <a href="https://aisstream.io">aisstream.io</a>',
    }).addTo(map);
  }
  setTiles();
  function onTheme() {
    setTiles();
    if (land) land.setStyle(landStyle);
    trailLine.setStyle({ color: css("--select") });
    requestDraw();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const trailLine = L.polyline([], { color: css("--select"), weight: 3, opacity: 0.9, interactive: false }).addTo(map);

  map.on("moveend", () => {
    const c = map.getCenter();
    store.set("view", { c: [+c.lat.toFixed(3), +c.lng.toFixed(3)], z: map.getZoom() });
    sendViewSoon();
  });
  map.on("move zoom resize zoomend viewreset", requestDraw);
  map.on("dragstart", () => { if (S.follow) setFollow(false); });

  // ---------- ships layer: one canvas, so tens of thousands of ships stay smooth ----------
  const canvas = document.createElement("canvas");
  canvas.className = "ships";
  map.getContainer().appendChild(canvas);
  const g = canvas.getContext("2d");
  let hits = []; // flat list of [x, y, entry] drawn in the last frame
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  // Where a ship is now: its last report, moved forward along its course when it is under way.
  function posNow(e, now) {
    const age = now - e.t;
    if (e.sog >= 0.5 && e.cog != null && age > 0 && age < DR_MAX_MS) return move([e.lat, e.lon], e.cog, e.sog * (NM / 3600) * (age / 1000));
    return [e.lat, e.lon];
  }
  const heading = (e) => (e.hdg != null ? e.hdg : e.cog);

  function draw() {
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size.x * dpr) || canvas.height !== Math.round(size.y * dpr)) {
      canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
      canvas.style.width = size.x + "px"; canvas.style.height = size.y + "px";
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.x, size.y);

    const z = map.getZoom(), now = Date.now();
    const b = map.getBounds(), cLng = map.getCenter().lng;
    const padLat = (b.getNorth() - b.getSouth()) * 0.03, padLng = (b.getEast() - b.getWest()) * 0.03;
    const S0 = b.getSouth() - padLat, N0 = b.getNorth() + padLat, W0 = b.getWest() - padLng, E0 = b.getEast() + padLng;
    const mpp = (40075016.686 * Math.cos(rad(map.getCenter().lat))) / (256 * 2 ** z); // metres per CSS pixel
    const icon = z < 5 ? 0 : z < 8 ? 6 : z < 11 ? 7.5 : 9;
    const stroke = css("--hull-stroke"), halo = css("--panel"), ink = css("--ink"), selC = css("--select");
    const counts = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]));
    const dots = {}; // category -> Path2D, used when zoomed far out
    const labels = [];
    let selDraw = null;
    hits = [];

    for (const e of S.ships.values()) {
      if (now - Math.max(e.t, e.born) > EXPIRE_MS) { if (e.mmsi !== S.sel) S.ships.delete(e.mmsi); continue; }
      if (e.lat == null) continue; // static data only, waiting for a position
      let [lat, lon] = posNow(e, now);
      lon += 360 * Math.round((cLng - lon) / 360);
      if (lat < S0 || lat > N0 || lon < W0 || lon > E0) continue;
      counts[e.cat]++;
      if (!S.show[e.cat] && e.mmsi !== S.sel) continue;
      const p = map.latLngToContainerPoint([lat, lon]);
      hits.push([p.x, p.y, e]);
      if (e.mmsi === S.sel) { selDraw = [p, e]; continue; }
      if (!icon) {
        (dots[e.cat] ||= new Path2D()).rect(p.x - 1.4, p.y - 1.4, 2.8, 2.8);
        continue;
      }
      g.globalAlpha = now - e.t > STALE_MS ? 0.4 : 1;
      shipShape(e, p, icon, mpp, CATS[e.cat].c, stroke);
      if (S.tags && z >= 10 && e.name && labels.length < 400) labels.push([p, e.name]);
    }
    g.globalAlpha = 1;
    for (const k in dots) { g.fillStyle = CATS[k].c; g.fill(dots[k]); }

    if (labels.length) {
      g.font = `600 11px ${css("--f-mono")}`;
      g.textBaseline = "middle";
      g.lineWidth = 3; g.strokeStyle = halo; g.fillStyle = ink; g.lineJoin = "round";
      for (const [p, t] of labels) { g.strokeText(t, p.x + 11, p.y); g.fillText(t, p.x + 11, p.y); }
    }
    if (selDraw) {
      const [p, e] = selDraw;
      shipShape(e, p, Math.max(icon, 7) + 2, mpp, CATS[e.cat].c, stroke);
      g.beginPath(); g.arc(p.x, p.y, Math.max(icon, 7) + 8, 0, Math.PI * 2);
      g.lineWidth = 2.5; g.strokeStyle = selC; g.stroke();
      if (e.name) {
        g.font = `700 12px ${css("--f-mono")}`; g.textBaseline = "middle"; g.lineWidth = 3; g.strokeStyle = halo; g.fillStyle = ink;
        g.strokeText(e.name, p.x + Math.max(icon, 7) + 13, p.y); g.fillText(e.name, p.x + Math.max(icon, 7) + 13, p.y);
      }
    }
    S.visible = hits.length; S.counts = counts;
  }

  function shipShape(e, p, s, mpp, fill, stroke) {
    const h = heading(e);
    const moving = e.sog >= 0.5 && h != null;
    g.fillStyle = fill; g.strokeStyle = stroke; g.lineWidth = 1;
    // Zoomed right in, a ship with known dimensions is drawn to scale around its GPS antenna.
    const L0 = e.dim ? e.dim[0] + e.dim[1] : 0;
    if (L0 && h != null && L0 / mpp > s * 2.4) {
      const [A, B, C, D] = e.dim.map((v) => v / mpp);
      const bowStart = A - Math.min((A + B) * 0.18, (C + D) * 1.2);
      const pts = [[-C, -B], [D, -B], [D, bowStart], [(D - C) / 2, A], [-C, bowStart]];
      const r = rad(h), cs = Math.cos(r), sn = Math.sin(r);
      g.beginPath();
      pts.forEach(([x, y], i) => { const X = p.x + x * cs + y * sn, Y = p.y + x * sn - y * cs; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.closePath(); g.fill(); g.stroke();
      return;
    }
    if (moving) {
      const r = rad(h), cs = Math.cos(r), sn = Math.sin(r);
      const pts = [[0, -1.3], [0.58, 0.8], [-0.58, 0.8]];
      g.beginPath();
      pts.forEach(([x, y], i) => { const X = p.x + (x * cs - y * sn) * s, Y = p.y + (x * sn + y * cs) * s; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.closePath(); g.fill(); g.stroke();
    } else {
      g.beginPath(); g.arc(p.x, p.y, s * 0.48, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }

  function hitTest(x, y, r) {
    let best = null, bd = r * r;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i], d = (h[0] - x) ** 2 + (h[1] - y) ** 2;
      if (d < bd) { bd = d; best = h[2]; }
    }
    return best;
  }
  map.on("click", (ev) => {
    const e = hitTest(ev.containerPoint.x, ev.containerPoint.y, L.Browser.mobile ? 18 : 12);
    select(e ? e.mmsi : null);
  });
  const tip = $("#tip");
  map.on("mousemove", (ev) => {
    const e = hitTest(ev.containerPoint.x, ev.containerPoint.y, 10);
    map.getContainer().style.cursor = e ? "pointer" : "";
    if (!e || e.mmsi === S.sel) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = e.name || `MMSI ${e.mmsi}`;
    tip.style.left = ev.containerPoint.x + "px"; tip.style.top = ev.containerPoint.y + "px";
  });
  map.on("mouseout", () => { tip.hidden = true; });

  // ---------- ingest (shared by live and demo) ----------
  function entry(mmsi) {
    let e = S.ships.get(mmsi);
    if (!e) {
      e = { mmsi, name: null, cs: null, imo: null, type: 0, cat: "other", dim: null, dest: null, eta: null, draught: null,
        lat: null, lon: null, sog: null, cog: null, hdg: null, nav: null, cls: "A", t: 0, born: Date.now(), trail: [] };
      S.ships.set(mmsi, e);
    }
    return e;
  }
  function setPos(e, lat, lon, sog, cog, hdg, t) {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return false;
    if (t < e.t) return false;
    e.lat = lat; e.lon = lon; e.t = t;
    e.sog = sog != null && sog < 102.2 ? sog : null;
    e.cog = cog != null && cog < 360 ? cog : null;
    e.hdg = hdg != null && hdg < 360 ? hdg : null;
    const last = e.trail[e.trail.length - 1];
    if (!last || distM(last, [lat, lon]) > 40 || t - last[2] > 120e3) {
      e.trail.push([lat, lon, t]);
      if (e.trail.length > 600) e.trail.splice(0, e.trail.length - 600);
    }
    return true;
  }
  function setType(e, t) { if (t) { e.type = t; e.cat = catOf(t); } }
  function setDim(e, d) {
    if (!d) return;
    const v = [d.A, d.B, d.C, d.D].map((x) => +x || 0);
    if (v[0] + v[1] > 2 && v[2] + v[3] > 0.5 && v[0] < 511 && v[1] < 511) e.dim = v;
  }
  function aisTime(s) {
    // "2024-05-01 12:34:56.789 +0000 UTC"
    const t = Date.parse(String(s || "").slice(0, 19).replace(" ", "T") + "Z");
    const now = Date.now();
    return Number.isFinite(t) && t < now + 60e3 ? Math.min(t, now) : now;
  }

  function onAis(m) {
    const md = m.MetaData || {};
    const mmsi = md.MMSI, type = m.MessageType, body = m.Message && m.Message[type];
    if (!mmsi || !body) return;
    const e = entry(mmsi);
    const t = aisTime(md.time_utc);
    if (!e.name) e.name = clean(md.ShipName);
    if (type === "PositionReport") {
      e.cls = "A";
      if (setPos(e, body.Latitude, body.Longitude, body.Sog, body.Cog, body.TrueHeading, t)) e.nav = body.NavigationalStatus;
    } else if (type === "StandardClassBPositionReport" || type === "ExtendedClassBPositionReport") {
      e.cls = "B";
      setPos(e, body.Latitude, body.Longitude, body.Sog, body.Cog, body.TrueHeading, t);
      if (type === "ExtendedClassBPositionReport") { e.name = clean(body.Name) || e.name; setType(e, body.Type); setDim(e, body.Dimension); }
    } else if (type === "ShipStaticData") {
      e.name = clean(body.Name) || e.name;
      e.cs = clean(body.CallSign) || e.cs;
      if (body.ImoNumber > 999999 && body.ImoNumber < 10000000) e.imo = body.ImoNumber;
      setType(e, body.Type); setDim(e, body.Dimension);
      e.dest = clean(body.Destination);
      e.draught = body.MaximumStaticDraught > 0 ? body.MaximumStaticDraught : null;
      const a = body.Eta || {};
      e.eta = a.Month >= 1 && a.Month <= 12 && a.Day >= 1 && a.Hour < 24 && a.Minute < 60 ? [a.Month, a.Day, a.Hour, a.Minute] : null;
    } else if (type === "StaticDataReport") {
      const A = body.ReportA || {}, B = body.ReportB || {};
      if (A.Valid) e.name = clean(A.Name) || e.name;
      if (B.Valid) { setType(e, B.ShipType); e.cs = clean(B.CallSign) || e.cs; setDim(e, B.Dimension); }
      e.cls = "B";
    }
    if (e.mmsi === S.sel) cardDirty = true;
  }

  // ---------- live feed ----------
  let ws = null, retry = 0, sentBoxes = "", viewTimer = 0, retryTimer = 0;
  function boxesForView() {
    const b = map.getBounds().pad(0.2);
    const s = Math.max(-90, b.getSouth()), n = Math.min(90, b.getNorth());
    let w = b.getWest(), e = b.getEast();
    if (e - w >= 360) return [[[-90, -180], [90, 180]]];
    w = ((w + 540) % 360) - 180; e = ((e + 540) % 360) - 180;
    return w <= e ? [[[s, w], [n, e]]] : [[[s, w], [n, 180]], [[s, -180], [n, e]]];
  }
  function sendView(force) {
    if (!ws || ws.readyState !== 1) return;
    const boxes = boxesForView().map((bx) => bx.map((c) => c.map((v) => +v.toFixed(2))));
    const k = JSON.stringify(boxes);
    if (!force && k === sentBoxes) return;
    sentBoxes = k;
    ws.send(JSON.stringify({ boxes }));
  }
  function sendViewSoon() { clearTimeout(viewTimer); viewTimer = setTimeout(() => sendView(false), 700); }
  const dec = new TextDecoder();
  function connect() {
    clearTimeout(retryTimer);
    if (ws || document.hidden) return;
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`);
    ws = sock;
    sock.binaryType = "arraybuffer";
    sock.onopen = () => { retry = 0; S.lastError = null; sentBoxes = ""; sendView(true); status("<b>Live</b> · waiting for ships…", "live"); };
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : dec.decode(ev.data)); } catch { return; }
      if (m.error) { S.lastError = String(m.error); return; }
      S.msgs++;
      onAis(m);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (document.hidden) return;
      const keyBad = /key/i.test(S.lastError || "");
      const wait = keyBad ? 60e3 : Math.min(30e3, 2000 * 2 ** retry++);
      status(keyBad ? "aisstream.io rejected the API key · check the Cloudflare secret" : `Feed interrupted, reconnecting${S.lastError ? ` (${esc(S.lastError)})` : ""}`, "demo");
      retryTimer = setTimeout(connect, wait);
    };
  }
  // Close the feed when the tab is hidden for a while: it saves the free upstream quota.
  let hideTimer = 0;
  document.addEventListener("visibilitychange", () => {
    if (S.mode !== "live") return;
    clearTimeout(hideTimer);
    if (document.hidden) hideTimer = setTimeout(() => { if (ws) ws.close(1000, "hidden"); }, 60e3);
    else connect();
  });

  // Ships seen recently are kept in the browser, so reopening the app shows the map at once
  // (moored ships only report every few minutes).
  function saveShips() {
    if (S.mode !== "live") return;
    const now = Date.now();
    const rows = [...S.ships.values()].filter((e) => e.lat != null && now - e.t < EXPIRE_MS).sort((a, b) => b.t - a.t).slice(0, 6000)
      .map((e) => [e.mmsi, +e.lat.toFixed(5), +e.lon.toFixed(5), e.sog, e.cog, e.hdg, e.nav, e.t, e.name, e.type, e.cs, e.imo, e.dim, e.dest, e.draught, e.eta, e.cls]);
    store.set("ships", rows);
  }
  function loadShips() {
    const now = Date.now();
    for (const r of store.get("ships", []) || []) {
      if (!Array.isArray(r) || now - r[7] > EXPIRE_MS) continue;
      const e = entry(r[0]);
      [, e.lat, e.lon, e.sog, e.cog, e.hdg, e.nav, e.t, e.name, , e.cs, e.imo, e.dim, e.dest, e.draught, e.eta, e.cls] = r;
      setType(e, r[9]);
      e.trail = [[e.lat, e.lon, e.t]];
    }
  }

  async function probe() {
    try {
      const r = await fetch("api/health", { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ---------- demo data ----------
  // Simplified sea lanes ([lat, lon] waypoints) with a port at each end.
  const LANES = [
    [["Ushant", "Elbe"], [[48.9, -6.2], [49.9, -3.0], [50.5, 0.2], [51.05, 1.6], [51.6, 2.6], [52.4, 3.6], [53.5, 5.0], [54.0, 7.4], [53.95, 8.4]]],
    [["Dover", "Rotterdam"], [[51.05, 1.6], [51.5, 2.9], [51.98, 3.95]]],
    [["Skagen", "Helsinki"], [[57.95, 10.75], [57.3, 11.4], [56.3, 12.3], [55.95, 12.7], [55.4, 12.95], [55.2, 14.2], [55.6, 16.0], [57.0, 19.0], [59.0, 21.0], [59.6, 23.5], [59.95, 24.9]]],
    [["Rotterdam", "Skagen"], [[51.98, 3.95], [53.6, 4.4], [56.0, 6.3], [57.6, 8.6], [57.95, 10.75]]],
    [["Ushant", "New York"], [[48.9, -6.2], [47.0, -25.0], [43.0, -50.0], [40.6, -67.0], [40.45, -73.85]]],
    [["Ushant", "Gibraltar"], [[48.9, -6.2], [45.0, -9.7], [43.2, -9.9], [37.0, -9.4], [36.2, -7.0], [35.95, -5.6], [36.05, -5.3]]],
    [["Gibraltar", "Port Said"], [[36.05, -5.3], [36.3, -2.0], [37.6, 1.0], [37.75, 8.2], [37.35, 11.3], [36.35, 13.2], [35.6, 16.0], [34.2, 22.0], [32.6, 28.0], [31.45, 32.3]]],
    [["Marseille", "Messina"], [[43.25, 5.3], [42.0, 6.6], [39.8, 8.0], [38.6, 8.05], [38.4, 9.5], [38.5, 13.5], [38.3, 15.3], [37.9, 15.45], [37.4, 15.35], [36.3, 16.2], [35.6, 16.0]]],
    [["Genoa", "Palermo"], [[44.35, 8.9], [43.4, 9.55], [42.9, 9.85], [40.6, 12.0], [38.25, 13.4]]],
    [["Naples", "Palermo"], [[40.75, 14.2], [40.2, 13.9], [38.25, 13.4]]],
    [["Piraeus", "Odesa"], [[37.9, 23.55], [37.6, 24.3], [38.6, 24.8], [39.6, 25.8], [40.05, 26.2], [40.45, 26.75], [40.85, 28.4], [41.05, 29.0], [41.25, 29.15], [42.8, 29.9], [46.35, 30.85]]],
    [["Port Said", "Bab-el-Mandeb"], [[31.45, 32.3], [31.2, 32.35], [30.1, 32.55], [29.6, 32.6], [28.0, 33.6], [24.0, 36.2], [20.0, 38.6], [15.0, 41.6], [12.6, 43.35], [12.0, 45.5]]],
    [["Bab-el-Mandeb", "Singapore"], [[12.0, 45.5], [12.6, 50.5], [10.0, 60.0], [7.0, 72.0], [5.6, 80.5], [5.9, 90.0], [5.95, 95.4], [5.2, 97.8], [3.2, 100.4], [2.0, 102.2], [1.18, 103.6], [1.22, 103.85]]],
    [["Arabian Sea", "Ras Tanura"], [[10.0, 60.0], [18.0, 60.0], [22.4, 60.5], [25.4, 57.4], [26.45, 56.5], [26.2, 54.8], [26.9, 51.8], [26.75, 50.3]]],
    [["Arabian Sea", "Mumbai"], [[10.0, 60.0], [16.0, 68.0], [18.9, 72.65]]],
    [["Singapore", "Hong Kong"], [[1.22, 103.85], [1.35, 104.4], [4.5, 106.5], [10.0, 110.0], [16.0, 113.3], [21.5, 114.4], [22.15, 114.2]]],
    [["Hong Kong", "Busan"], [[22.15, 114.2], [23.0, 117.2], [24.6, 119.6], [27.5, 121.8], [30.7, 123.0], [33.0, 126.4], [34.6, 129.0], [35.05, 129.1]]],
    [["Shanghai", "Tokyo"], [[30.9, 122.6], [31.5, 125.0], [32.5, 128.5], [31.0, 131.5], [33.4, 136.5], [34.6, 139.7], [35.2, 139.8]]],
    [["Singapore", "Jakarta"], [[1.22, 103.85], [0.2, 104.8], [-2.0, 106.6], [-3.5, 107.6], [-5.6, 106.9], [-6.05, 106.85]]],
    [["Sydney", "Melbourne"], [[-33.85, 151.35], [-36.0, 150.6], [-37.7, 150.3], [-39.2, 147.5], [-38.5, 145.0], [-38.2, 144.7]]],
    [["Ushant", "Cape Town"], [[45.0, -9.7], [36.0, -11.5], [30.5, -12.5], [21.0, -18.3], [12.0, -18.5], [4.0, -10.0], [-5.0, 5.0], [-20.0, 10.0], [-33.9, 18.1]]],
    [["Cape Town", "Durban"], [[-33.9, 18.1], [-34.9, 19.0], [-35.1, 21.5], [-34.1, 26.0], [-31.5, 30.4], [-29.95, 31.15]]],
    [["Santos", "Rio"], [[-24.05, -46.3], [-24.4, -45.0], [-23.3, -43.6], [-23.0, -43.15]]],
    [["New York", "Houston"], [[40.45, -73.85], [39.0, -73.3], [36.8, -75.2], [33.5, -77.4], [30.0, -79.8], [26.5, -79.85], [24.3, -81.0], [24.3, -82.4], [26.0, -85.0], [28.6, -90.0], [29.25, -94.6]]],
    [["Windward Passage", "Panama"], [[30.0, -79.8], [27.0, -76.0], [23.5, -74.0], [20.1, -73.8], [17.5, -75.0], [11.5, -78.0], [9.45, -79.9]]],
    [["Panama", "Callao"], [[8.8, -79.5], [7.0, -79.8], [3.0, -81.0], [-4.0, -81.6], [-12.05, -77.2]]],
    [["Los Angeles", "Vancouver"], [[33.65, -118.25], [34.2, -119.9], [34.4, -121.0], [36.5, -122.3], [37.75, -122.75], [42.0, -125.0], [48.35, -124.9], [48.3, -123.6], [49.25, -123.3]]],
  ];
  const PORTS = [[51.98, 3.85, "Rotterdam"], [1.2, 103.9, "Singapore"], [25.15, 56.5, "Fujairah"], [29.15, -94.5, "Houston"], [40.45, -73.95, "New York"],
    [33.6, -118.15, "Los Angeles"], [36.1, -5.38, "Gibraltar"], [31.4, 32.45, "Port Said"], [22.2, 114.25, "Hong Kong"], [-24.1, -46.25, "Santos"],
    [-29.95, 31.2, "Durban"], [35.0, 129.15, "Busan"], [37.85, 23.5, "Piraeus"], [37.2, 15.3, "Augusta"], [53.95, 8.3, "Cuxhaven"], [30.8, 122.75, "Shanghai"]];
  const NAMES = ["NORDIC STAR", "MAERSK HALDEN", "CMA CGM RIVOLI", "MSC GIULIA", "EVER LUCENT", "OCEAN PEARL", "ATLANTIC SPIRIT", "STENA NAVIGATOR", "BALTIC TRADER",
    "SEA HARMONY", "PACIFIC DAWN", "AURORA BOREALIS", "CAPE MERIDIAN", "GOLDEN HORIZON", "BLUE MARLIN", "IONIAN SKY", "NAVIGATOR ARIES", "ARCTIC FOX", "SILVER WAVE",
    "POLAR EXPLORER", "AEGEAN BREEZE", "CORAL SEA", "MISTRAL", "SIROCCO", "TRAMONTANA", "LIBECCIO", "VALLETTA EXPRESS", "ETNA", "STROMBOLI", "TAORMINA",
    "GRAND CASABLANCA", "NORTHERN LIGHT", "KOTA HARUM", "YANG MING UNITY", "ONE COMPETENCE", "HMM OSLO", "COSCO PRIDE", "HAPAG ESSEN", "SEASPAN ZEUS", "ZIM CHICAGO",
    "TORM HELENE", "FRONT ALTAIR", "EAGLE TACOMA", "MINERVA LISA", "SONANGOL KIZOMBA", "ADVANTAGE SUN", "GAS ENTERPRISE", "LNG ABUJA", "MOANA CHIEF", "ISLAND PRINCESS"];
  const FLAGS = ["351", "636", "538", "248", "563", "477", "241", "413", "257", "247", "211", "244", "232", "227", "366", "219", "309", "229", "273", "431"];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const laneData = LANES.map(([ends, pts]) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
    return { ends, pts, cum, len: cum[cum.length - 1] };
  });
  const totalLen = laneData.reduce((s, l) => s + l.len, 0);
  function lanePoint(l, d) {
    d = Math.max(0, Math.min(l.len, d));
    let i = 1;
    while (i < l.cum.length - 1 && l.cum[i] < d) i++;
    const a = l.pts[i - 1], b = l.pts[i], seg = l.cum[i] - l.cum[i - 1];
    const brg = bearing(a, b);
    return { p: move(a, brg, d - l.cum[i - 1]), brg, seg };
  }
  function demoType() {
    const r = Math.random();
    if (r < 0.42) return pick([70, 70, 70, 71, 79]);
    if (r < 0.68) return pick([80, 80, 81, 84]);
    if (r < 0.78) return pick([60, 60, 69]);
    if (r < 0.84) return 52;
    if (r < 0.9) return 30;
    if (r < 0.95) return pick([36, 37]);
    if (r < 0.97) return 40;
    return 0;
  }
  function demoDims(type) {
    const c = catOf(type);
    const L = c === "cargo" ? rnd(140, 400) : c === "tanker" ? rnd(120, 330) : c === "passenger" ? rnd(90, 300) : c === "special" ? rnd(22, 40) : c === "fishing" ? rnd(15, 45) : c === "pleasure" ? rnd(9, 30) : rnd(30, 120);
    const B = L / rnd(5.5, 7.5), a = L * rnd(0.7, 0.85);
    return [Math.round(a), Math.round(L - a), Math.round(B / 2), Math.round(B / 2)];
  }
  const demo = [];
  let demoMmsi = 0;
  function demoShip(kind) {
    const type = demoType();
    const id = +(pick(FLAGS) + String(100000 + demoMmsi++ * 7 + Math.floor(Math.random() * 7)).padStart(6, "0"));
    const cat = catOf(type);
    const sog = cat === "passenger" ? rnd(15, 22) : cat === "highspeed" ? rnd(25, 34) : cat === "tanker" ? rnd(10, 14) : cat === "fishing" ? rnd(2, 8) : cat === "pleasure" ? rnd(4, 9) : cat === "special" ? rnd(6, 11) : rnd(12, 18);
    const d = { mmsi: id, type, sog, dim: demoDims(type), name: Math.random() < 0.94 ? pick(NAMES) + (Math.random() < 0.4 ? " " + Math.ceil(Math.random() * 9) : "") : null,
      cs: Math.random() < 0.9 ? String.fromCharCode(65 + Math.floor(Math.random() * 26)) + String.fromCharCode(65 + Math.floor(Math.random() * 26)) + Math.floor(rnd(1000, 9999)) : null,
      imo: cat === "pleasure" || cat === "fishing" ? null : Math.floor(rnd(9100000, 9999999)) };
    if (kind === "anchor") {
      const [lat, lon, port] = pick(PORTS);
      Object.assign(d, { anchor: [lat + rnd(-0.04, 0.04), lon + rnd(-0.05, 0.05)], dest: port.toUpperCase(), nav: Math.random() < 0.7 ? 1 : 5, sog: rnd(0, 0.3), hdg: rnd(0, 360) });
    } else {
      let r = Math.random() * totalLen, l = laneData[0];
      for (const x of laneData) { if ((r -= x.len) <= 0) { l = x; break; } }
      Object.assign(d, { lane: l, dir: Math.random() < 0.5 ? 1 : -1, at: rnd(0, l.len), off: rnd(-2500, 2500), nav: cat === "fishing" ? 7 : cat === "pleasure" && type === 36 ? 8 : 0 });
      d.dest = (d.dir > 0 ? l.ends[1] : l.ends[0]).toUpperCase();
    }
    const etaD = new Date(Date.now() + rnd(6, 240) * 3600e3);
    d.eta = [etaD.getUTCMonth() + 1, etaD.getUTCDate(), etaD.getUTCHours(), Math.floor(etaD.getUTCMinutes() / 15) * 15];
    return d;
  }
  function demoPos(d) {
    if (d.anchor) return { lat: d.anchor[0], lon: d.anchor[1], cog: null };
    const q = lanePoint(d.lane, d.at), brg = d.dir > 0 ? q.brg : (q.brg + 180) % 360;
    const [lat, lon] = move(q.p, (q.brg + 90) % 360, d.off * d.dir);
    return { lat, lon, cog: brg };
  }
  function demoTick(dtS) {
    const now = Date.now();
    for (let i = 0; i < demo.length; i++) {
      const d = demo[i];
      if (!d.anchor) {
        d.at += d.dir * d.sog * (NM / 3600) * dtS;
        if (d.at < 0 || d.at > d.lane.len) { d.dir = -d.dir; d.at = Math.max(0, Math.min(d.lane.len, d.at)); d.dest = (d.dir > 0 ? d.lane.ends[1] : d.lane.ends[0]).toUpperCase(); }
      }
      const p = demoPos(d);
      const e = entry(d.mmsi);
      setPos(e, p.lat, p.lon, d.sog, p.cog, p.cog != null ? (p.cog + rnd(-2, 2) + 360) % 360 : d.hdg, now);
      Object.assign(e, { name: d.name, cs: d.cs, imo: d.imo, dim: d.dim, dest: d.dest, eta: d.eta, nav: d.nav, draught: d.dim ? Math.round((d.dim[0] + d.dim[1]) / 25) / 2 + 2 : null, cls: catOf(d.type) === "pleasure" ? "B" : "A" });
      setType(e, d.type);
    }
  }
  function seedTrail(e) {
    // demo ships get the last couple of hours of their lane as a trail
    const d = demo.find((x) => x.mmsi === e.mmsi);
    if (!d || d.anchor || e.trail.length > 3) return;
    const pts = [];
    for (let k = 40; k > 0; k--) {
      const at = d.at - d.dir * d.sog * (NM / 3600) * k * 180;
      if (at < 0 || at > d.lane.len) continue;
      const q = lanePoint(d.lane, at), [lat, lon] = move(q.p, (q.brg + 90) % 360, d.off * d.dir);
      pts.push([lat, lon, Date.now() - k * 180e3]);
    }
    e.trail = pts.concat(e.trail);
  }
  function startDemo(why) {
    S.mode = "demo";
    S.ships.clear();
    for (let i = 0; i < 520; i++) demo.push(demoShip("lane"));
    for (let i = 0; i < 150; i++) demo.push(demoShip("anchor"));
    demoTick(0);
    setInterval(() => demoTick(2), 2000);
    status(`<b>Demo data</b> · ${why}`, "demo");
  }

  // ---------- selection, trail and ship card ----------
  let cardDirty = false;
  function select(mmsi) {
    S.sel = mmsi;
    const e = mmsi != null && S.ships.get(mmsi);
    if (!e) {
      S.sel = null; S.follow = false;
      $("#card").hidden = true; $("#hint").hidden = false;
      trailLine.setLatLngs([]);
      requestDraw();
      return;
    }
    if (S.mode === "demo") seedTrail(e);
    tip.hidden = true;
    $("#hint").hidden = true;
    renderCard(e);
    $("#card").hidden = false;
    drawTrail(e);
    requestDraw();
  }
  function drawTrail(e) {
    const pts = e.trail.map((p) => [p[0], p[1]]);
    pts.push(posNow(e, Date.now()));
    for (let i = 1; i < pts.length; i++) {
      while (pts[i][1] - pts[i - 1][1] > 180) pts[i][1] -= 360;
      while (pts[i][1] - pts[i - 1][1] < -180) pts[i][1] += 360;
    }
    trailLine.setLatLngs(pts);
  }

  function speed(kn) {
    if (kn == null) return "–";
    return S.units === "metric" ? `${fmt(kn * 1.852, 1)} <small>km/h</small>` : `${fmt(kn, 1)} <small>kn</small>`;
  }
  function etaText(eta) {
    if (!eta) return null;
    const now = new Date();
    let y = now.getUTCFullYear();
    let t = Date.UTC(y, eta[0] - 1, eta[1], eta[2], eta[3]);
    if (t < now - 60 * 86400e3) t = Date.UTC(++y, eta[0] - 1, eta[1], eta[2], eta[3]); // AIS ETAs carry no year
    const d = new Date(t);
    const when = `${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
    const left = t - now;
    let rel = "";
    if (left > 0) { const h = Math.floor(left / 3600e3); rel = h >= 48 ? `in ${Math.floor(h / 24)} d ${h % 24} h` : `in ${h} h ${Math.floor((left % 3600e3) / 60e3)} min`; }
    else rel = "passed";
    return { when, rel };
  }
  function cardBody(e) {
    const now = Date.now(), [lat, lon] = posNow(e, now);
    const eta = etaText(e.eta), nav = NAV[e.nav] || null;
    const moving = e.sog >= 0.5;
    const len = e.dim ? e.dim[0] + e.dim[1] : null, beam = e.dim ? e.dim[2] + e.dim[3] : null;
    const brg = e.cog != null ? `${fmt(e.cog)}° <small>${compass(e.cog)}</small>` : "–";
    const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    return `
      <div class="voy ${e.dest ? "" : "unknown"}">
        <div><div class="k">Destination</div><div class="dest">${e.dest ? esc(e.dest) : "Not reported"}</div></div>
        <div class="eta">${eta ? `<small>ETA ${esc(eta.rel)}</small>${esc(eta.when)}` : ""}</div>
        <span class="pill ${moving ? "moving" : ""}">${esc(nav || (moving ? "Under way" : e.sog != null ? "Stopped" : "Status not reported"))}</span>
      </div>
      <div class="stats">
        ${stat("Speed", speed(e.sog))}
        ${stat("Course", brg)}
        ${stat("Heading", e.hdg != null ? `${fmt(e.hdg)}°` : "–")}
        ${stat("Size", len ? `${fmt(len)} × ${fmt(beam)} <small>m</small>` : "–")}
        ${stat("Draught", e.draught ? `${fmt(e.draught, 1)} <small>m</small>` : "–")}
        ${stat("AIS class", e.cls === "B" ? "B <small>small craft</small>" : "A")}
        ${stat("MMSI", e.mmsi)}
        ${stat("IMO", e.imo || "–")}
        ${stat("Call sign", e.cs ? esc(e.cs) : "–")}
        ${stat("Last report", ago(now - e.t))}
        <div class="stat" style="grid-column:1/-1;border-right:0">${`<div class="k">Position</div><div class="v">${dms(lat, "N", "S")} ${dms(lon, "E", "W")}</div>`}</div>
      </div>`;
  }
  function renderCard(e) {
    const f = flagOf(e.mmsi);
    const card = $("#card");
    card.style.setProperty("--c", CATS[e.cat].c);
    card.innerHTML = `
      <div class="card-h">
        <div class="sw"></div>
        <div><div class="nm">${esc(e.name || `MMSI ${e.mmsi}`)}</div>
        <div class="sub">${f ? `${f.emoji} ${esc(f.name)} · ` : ""}${esc(typeLabel(e.type))}</div></div>
        <button class="btn x" type="button" id="c-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div id="c-body">${cardBody(e)}</div>
      <div class="card-f">
        <button class="btn" type="button" id="c-follow" aria-pressed="${S.follow}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>${S.follow ? "Following" : "Follow"}</button>
        <button class="btn" type="button" id="c-zoom"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>Whole track</button>
      </div>
      ${S.mode === "demo" ? '<div class="note">Simulated ship. Real ships appear once the app runs on Cloudflare with an aisstream.io key.</div>' : '<div class="note">The track shows where this ship has been since you opened the map.</div>'}`;
    card.dataset.key = `${e.mmsi}|${e.name}|${e.type}`;
    $("#c-close").onclick = () => select(null);
    $("#c-follow").onclick = () => setFollow(!S.follow);
    $("#c-zoom").onclick = () => {
      const pts = trailLine.getLatLngs();
      setFollow(false);
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 13 });
      else map.setView(posNow(e, Date.now()), 13);
    };
  }
  function refreshCard() {
    const e = S.sel != null && S.ships.get(S.sel);
    if (!e) return;
    const card = $("#card");
    if (card.dataset.key !== `${e.mmsi}|${e.name}|${e.type}`) renderCard(e);
    else $("#c-body").innerHTML = cardBody(e);
    drawTrail(e);
    if (S.follow) panToShip(posNow(e, Date.now()));
  }
  function panToShip(ll, zoom) {
    const z = zoom ?? map.getZoom();
    const sheet = window.innerWidth <= 640 && !$("#card").hidden;
    if (!sheet) return map.setView(ll, z, { animate: true });
    const size = map.getSize();
    const pt = map.project(ll, z).add([0, size.y * 0.27]); // keep the ship above the bottom sheet
    map.setView(map.unproject(pt, z), z, { animate: true });
  }
  function setFollow(on) {
    S.follow = on;
    const b = $("#c-follow");
    if (b) { b.setAttribute("aria-pressed", on); b.lastChild.textContent = on ? "Following" : "Follow"; }
    const e = S.sel != null && S.ships.get(S.sel);
    if (on && e) panToShip(posNow(e, Date.now()), Math.max(map.getZoom(), 11));
  }

  // ---------- top bar and legend ----------
  function status(html, kind) {
    $("#status-t").innerHTML = html;
    $("#status").classList.toggle("demo", kind === "demo");
  }
  function legend() {
    const el = $("#legend");
    if (!el.childElementCount) {
      el.innerHTML = '<div class="lbl">Ship types</div>' + Object.entries(CATS).map(([k, c]) =>
        `<button type="button" data-k="${k}" style="--c:${c.c}" aria-pressed="${S.show[k]}"><i></i><span>${c.label}</span><small></small></button>`).join("");
      el.onclick = (ev) => {
        const b = ev.target.closest("button");
        if (!b) return;
        const k = b.dataset.k;
        S.show[k] = !S.show[k];
        b.setAttribute("aria-pressed", S.show[k]);
        store.set("show", S.show);
        requestDraw();
      };
    }
    for (const b of el.querySelectorAll("button")) b.lastElementChild.textContent = fmt(S.counts[b.dataset.k] || 0);
  }
  let listTimer = 0;
  function refreshSearchList() {
    if (Date.now() - listTimer < 10000) return;
    listTimer = Date.now();
    const opts = [];
    for (const e of S.ships.values()) {
      if (!e.name || e.lat == null) continue;
      opts.push(`<option value="${esc(e.name)}">${esc([typeLabel(e.type), e.mmsi].join(" · "))}</option>`);
      if (opts.length >= 500) break;
    }
    $("#q-list").innerHTML = opts.join("");
  }
  function find(q) {
    q = q.trim().toUpperCase().replace(/\s+/g, " ");
    if (!q) return null;
    const qd = q.replace(/^IMO\s*/, "");
    let best = null;
    for (const e of S.ships.values()) {
      if (e.lat == null) continue;
      const keys = [e.name, e.cs, String(e.mmsi), e.imo && String(e.imo)].filter(Boolean).map((k) => k.toUpperCase());
      if (keys.includes(q) || keys.includes(qd)) return e;
      if (!best && keys.some((k) => k.startsWith(q) || (q.length >= 3 && k.includes(q)))) best = e;
    }
    return best;
  }
  function goTo(e) {
    map.setView(posNow(e, Date.now()), Math.max(map.getZoom(), 11), { animate: false });
    select(e.mmsi);
  }
  $("#q").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const e = find(ev.target.value);
    if (e) { goTo(e); ev.target.blur(); }
    else status(`No ship matching “${esc(ev.target.value)}” among the ${fmt(S.ships.size)} on the map so far`, S.mode);
  });
  $("#q").addEventListener("change", (ev) => { const e = find(ev.target.value); if (e) goTo(e); });

  function applyTags() { $("#b-tags").setAttribute("aria-pressed", S.tags); requestDraw(); }
  $("#b-tags").onclick = () => { S.tags = !S.tags; store.set("tags", S.tags); applyTags(); };
  applyTags();
  function applyUnits() { $("#units-t").textContent = S.units === "metric" ? "Metric" : "Nautical"; }
  $("#b-units").onclick = () => {
    S.units = S.units === "metric" ? "nautical" : "metric";
    store.set("units", S.units); applyUnits(); refreshCard();
  };
  applyUnits();
  $("#b-locate").onclick = () => {
    if (!navigator.geolocation) return status("Location is not available in this browser", S.mode);
    navigator.geolocation.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 10),
      () => status("Location permission was not granted", S.mode),
      { timeout: 8000 }
    );
  };

  // ---------- clock ----------
  let lastMsgs = 0, lastRateAt = Date.now();
  setInterval(() => {
    requestDraw();
    if (cardDirty || S.sel != null) { cardDirty = false; refreshCard(); }
  }, 1000);
  setInterval(() => {
    const now = Date.now();
    S.rate = ((S.msgs - lastMsgs) * 1000) / (now - lastRateAt);
    lastMsgs = S.msgs; lastRateAt = now;
    legend();
    refreshSearchList();
    if (S.mode === "live" && ws && ws.readyState === 1 && (S.msgs || S.ships.size)) {
      status(`<b>Live</b> · ${fmt(S.visible)} ships in view · ${fmt(S.rate, S.rate < 10 ? 1 : 0)} msg/s`, "live");
    }
  }, 2000);
  setInterval(saveShips, 30000);
  addEventListener("pagehide", saveShips);
  legend();

  // ---------- boot ----------
  (async () => {
    const h = await probe();
    if (h && h.live) {
      S.mode = "live";
      loadShips();
      requestDraw();
      connect();
    } else startDemo(h ? "add your aisstream.io key on Cloudflare for real ships" : "deploy to Cloudflare for real ships");
  })();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
