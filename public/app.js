// Ship Track: every ship broadcasting AIS in view, live.
// The Worker relays aisstream.io over a WebSocket for the area on screen; between two reports a
// moving ship is carried forward along its course, so the map moves smoothly once a second.
// Without the Worker or its key, the page runs a simulated demo so the interface can be tried.

const EXPIRE_MS = 30 * 60_000; // forget a ship 30 min after its last position
const STALE_MS = 12 * 60_000; // fade it after 12 min
const DR_MAX_MS = 10 * 60_000; // carry a moving ship forward for at most 10 min
const STATIC_KEEP_MS = 7 * 86_400_000; // names, types and sizes are remembered for a week
const NM = 1852;
const CATS = {
  cargo: { label: 'Cargo', light: '#2E9E46', dark: '#4CC266' },
  tanker: { label: 'Tanker', light: '#C42B1C', dark: '#F0635A' },
  passenger: { label: 'Passenger', light: '#1F6FEB', dark: '#4C8DFF' },
  fishing: { label: 'Fishing', light: '#E8890C', dark: '#F0A33A' },
  special: { label: 'Tug & service', light: '#0E9AA7', dark: '#2EC4CF' },
  pleasure: { label: 'Leisure', light: '#B23CC9', dark: '#D27BE3' },
  highspeed: { label: 'High-speed', light: '#C9A100', dark: '#E8C62E' },
  other: { label: 'Other', light: '#8A939E', dark: '#7D8794' },
};
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

// The dark base style paints land almost black. These lighten it to a slate grey
// (sea stays darker, borders and labels lighter), applied when the dark style loads.
const LAND = '#343B45';
const WATER = '#1B2129';
const DARK_MAP = {
  background: { 'background-color': LAND },
  water: { 'fill-color': WATER },
  waterway: { 'line-color': WATER },
  landcover_ice_shelf: { 'fill-color': LAND },
  landcover_glacier: { 'fill-color': '#3A414C' },
  landuse_residential: { 'fill-color': '#3A414C' },
  landcover_wood: { 'fill-color': '#333D38' },
  landuse_park: { 'fill-color': '#333D38' },
  building: { 'fill-color': '#2E343D', 'fill-outline-color': '#3E4651' },
  'aeroway-area': { 'fill-color': '#2E343D' },
  'aeroway-taxiway': { 'line-color': '#3F4651' },
  'aeroway-runway': { 'line-color': '#4A525E' },
  road_area_pier: { 'fill-color': LAND },
  road_pier: { 'line-color': LAND },
  highway_path: { 'line-color': '#3F4650' },
  highway_minor: { 'line-color': '#444C57' },
  highway_major_casing: { 'line-color': 'rgba(90, 98, 110, 0.8)' },
  highway_major_inner: { 'line-color': '#4B5360' },
  highway_major_subtle: { 'line-color': '#3F4651' },
  highway_motorway_casing: { 'line-color': 'rgba(90, 98, 110, 0.8)' },
  highway_motorway_inner: { 'line-color': '#555E6B' },
  highway_motorway_subtle: { 'line-color': '#3F4651' },
  railway_transit: { 'line-color': '#5A6370' },
  railway_transit_dashline: { 'line-color': LAND },
  railway_minor: { 'line-color': '#5A6370' },
  railway_minor_dashline: { 'line-color': LAND },
  railway: { 'line-color': '#5A6370' },
  railway_dashline: { 'line-color': LAND },
  boundary_state: { 'line-color': '#5E6774' },
  'boundary_country_z0-4': { 'line-color': '#8A94A3' },
  'boundary_country_z5-': { 'line-color': '#8A94A3' },
  water_name: { 'text-color': '#7F8B99', 'text-halo-color': WATER },
  highway_name_other: { 'text-color': '#8E97A3', 'text-halo-color': '#2A3038' },
  highway_name_motorway: { 'text-color': '#8E97A3' },
};
for (const id of ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large',
  'place_state', 'place_country_other', 'place_country_minor', 'place_country_major']) {
  DARK_MAP[id] = { 'text-color': '#C3CAD3', 'text-halo-color': 'rgba(20, 24, 30, 0.8)' };
}

const $ = (sel) => document.querySelector(sel);
const panel = $('#panel');
const statusEl = $('#status');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const store = {
  get(k, d) { try { const v = localStorage.getItem(`st:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`st:${k}`, JSON.stringify(v)); } catch { /* not remembered */ } },
};

// ---------- AIS vocabulary ----------

function catOf(t) {
  if (t === 30) return 'fishing';
  if ((t >= 31 && t <= 35) || (t >= 50 && t <= 59)) return 'special';
  if (t === 36 || t === 37) return 'pleasure';
  if (t >= 40 && t <= 49) return 'highspeed';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  return 'other';
}
const TYPE_NAMES = { 30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging', 34: 'Diving operations', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft',
  50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Non-combatant' };
function typeLabel(t) {
  if (!t) return 'Type not reported';
  if (TYPE_NAMES[t]) return TYPE_NAMES[t];
  const d = Math.floor(t / 10), x = t % 10;
  const base = { 2: 'Wing in ground', 4: 'High-speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker', 9: 'Other' }[d];
  if (!base) return `Type ${t}`;
  const haz = x >= 1 && x <= 4 ? ` · hazardous cat. ${'XABCD'[x]}` : '';
  return base + haz;
}
const NAV = ['Under way, engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught', 'Moored', 'Aground',
  'Engaged in fishing', 'Under way, sailing', null, null, 'Towing astern', 'Pushing ahead', null, 'AIS-SART active', null];

// Maritime Identification Digits (first 3 digits of a ship MMSI) → flag state.
const MID = {};
('AL201 AD202 AT203 PT204 BE205 BY206 BG207 VA208 CY209 CY210 DE211 CY212 GE213 MD214 MT215 AM216 DE218 DK219 DK220 ES224 ES225 FR226 FR227 FR228 MT229 FI230 FO231 ' +
 'GB232 GB233 GB234 GB235 GI236 GR237 HR238 GR239 GR240 GR241 MA242 HU243 NL244 NL245 NL246 IT247 MT248 MT249 IE250 IS251 LI252 LU253 MC254 PT255 MT256 NO257 NO258 NO259 ' +
 'PL261 ME262 PT263 RO264 SE265 SE266 SK267 SM268 CH269 CZ270 TR271 UA272 RU273 MK274 LV275 EE276 LT277 SI278 RS279 AI301 US303 AG304 AG305 CW306 AW307 BS308 BS309 BM310 ' +
 'BS311 BZ312 BB314 CA316 KY319 CR321 CU323 DM325 DO327 GP329 GD330 GL331 GT332 HN334 HT336 US338 JM339 KN341 LC343 MX345 MQ347 MS348 NI350 PA351 PA352 PA353 PA354 PA355 ' +
 'PA356 PA357 PR358 SV359 PM361 TT362 TC364 US366 US367 US368 US369 PA370 PA371 PA372 PA373 PA374 VC375 VC376 VC377 VG378 VI379 AF401 SA403 BD405 BH408 BT410 CN412 CN413 ' +
 'CN414 TW416 LK417 IN419 IR422 AZ423 IQ425 IL428 JP431 JP432 TM434 KZ436 UZ437 JO438 KR440 KR441 PS443 KP445 KW447 LB450 KG451 MO453 MV455 MN457 NP459 OM461 PK463 QA466 ' +
 'SY468 AE470 AE471 TJ472 YE473 YE475 HK477 BA478 AU503 MM506 BN508 FM510 PW511 NZ512 KH514 KH515 CX516 CK518 FJ520 CC523 ID525 KI529 LA531 MY533 MP536 MH538 NC540 NU542 ' +
 'NR544 PF546 PH548 TL550 PG553 PN555 SB557 AS559 WS561 SG563 SG564 SG565 SG566 TH567 TO570 TV572 VN574 VU576 VU577 WF578 ZA601 AO603 DZ605 BI609 BJ610 BW611 CF612 CM613 ' +
 'CG615 KM616 CV617 CI619 KM620 DJ621 EG622 ET624 ER625 GA626 GH627 GM629 GW630 GQ631 GN632 BF633 KE634 LR636 LR637 SS638 LY642 LS644 MU645 MG647 ML649 MZ650 MR654 MW655 ' +
 'NE656 NG657 NA659 RE660 RW661 SD662 SN663 SC664 SH665 SO666 SL667 ST668 SZ669 TD670 TG671 TN672 TZ674 UG675 CD676 TZ677 ZM678 ZW679 AR701 BR710 BO720 CL725 CO730 EC735 ' +
 'FK740 GF745 GY750 PY755 PE760 SR765 UY770 VE775').split(' ').forEach((x) => { MID[x.slice(2)] = x.slice(0, 2); });

function flagOf(mmsi) {
  const s = String(mmsi);
  if (s.length !== 9 || !/^[2-7]/.test(s)) return null;
  const iso = MID[s.slice(0, 3)];
  if (!iso) return null;
  let name = iso;
  try { name = new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) || iso; } catch { /* code only */ }
  return { iso, name };
}
// Emoji flags do not show on Windows, so the flags are small images.
const flagImg = (f) => (f ? `<img class="flag" src="https://flagcdn.com/48x36/${f.iso.toLowerCase()}.png" alt="" width="24" height="18">` : '');

// ---------- light / dark ----------

const THEMES = {
  auto: { next: 'dark', label: 'Theme: automatic',
    icon: '<path d="M12 3a9 9 0 1 0 0 18z" fill="currentColor"/><circle cx="12" cy="12" r="9"/>' },
  dark: { next: 'light', label: 'Theme: dark',
    icon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>' },
  light: { next: 'auto', label: 'Theme: light',
    icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
};
let theme = 'auto';
let mapStyle = null; // base style the map shows, set once the map exists
try { theme = THEMES[localStorage.getItem('theme')] ? localStorage.getItem('theme') : 'auto'; } catch { /* auto */ }

function isDark() {
  return theme === 'dark' || (theme === 'auto' && darkQuery.matches);
}
const catColor = (cat) => CATS[cat][isDark() ? 'dark' : 'light'];

function applyTheme() {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#theme-color').content = isDark() ? '#12161C' : '#FFFFFF';
  const btn = $('#theme');
  btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${THEMES[theme].icon}</svg>`;
  btn.setAttribute('aria-label', THEMES[theme].label);
  btn.title = THEMES[theme].label;
  document.querySelectorAll('.chips button').forEach((b) => b.style.setProperty('--c', catColor(b.dataset.cat)));
  const style = isDark() ? STYLES.dark : STYLES.light;
  if (mapStyle && mapStyle !== style) {
    mapStyle = style;
    map.setStyle(style, { diff: false }); // our layers are re-added on 'style.load'
  }
}

$('#theme').addEventListener('click', () => {
  theme = THEMES[theme].next;
  try { localStorage.setItem('theme', theme); } catch { /* not remembered */ }
  applyTheme();
  if (state.selected) renderPanel();
});

const state = {
  mode: null, // 'live' | 'demo'
  ships: new Map(), // mmsi -> ship
  statics: new Map(store.get('static', [])), // mmsi -> remembered name, type, size...
  positions: new Map(), // mmsi -> [lat, lon] drawn this second
  selected: null,
  following: false,
  show: { ...Object.fromEntries(Object.keys(CATS).map((k) => [k, true])), ...store.get('show', {}) },
  msgs: 0,
  rate: 0,
  counts: {},
  lastError: null,
};

const saved = store.get('view', null);
const map = new maplibregl.Map({
  container: 'map',
  style: isDark() ? STYLES.dark : STYLES.light,
  center: saved ? saved.c : [2, 50.5], // the Channel and the North Sea until we know the visitor's country
  zoom: saved ? saved.z : 5.5,
  // North always up: no rotating or tilting the map by accident.
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true, customAttribution: [
    'Ships: <a href="https://aisstream.io">aisstream.io</a>, <a href="https://www.digitraffic.fi/en/">Fintraffic / digitraffic.fi</a> (CC BY 4.0)',
    'Weather: <a href="https://open-meteo.com">Open-Meteo</a>, <a href="https://www.rainviewer.com">RainViewer</a>',
  ] },
});
mapStyle = isDark() ? STYLES.dark : STYLES.light;
// Bottom-right controls stack upwards in the order added: locate me, full screen, zoom, then the overlays.
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
const geolocate = new maplibregl.GeolocateControl({
  trackUserLocation: true, showUserLocation: true, positionOptions: { enableHighAccuracy: true }, fitBoundsOptions: { maxZoom: 10 },
});
map.addControl(geolocate, 'bottom-right');
// The whole app, panel included, fills the screen.
map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
// Two scale bars: nautical miles on top, kilometres below.
map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical', maxWidth: 120 }), 'bottom-left');
new ResizeObserver(() => map.resize()).observe($('#map'));
darkQuery.addEventListener('change', () => applyTheme());

// ---------- which way the phone points ----------
// Once located, a beam on the blue dot follows the phone's compass, and the pill names the
// nearest ship in that direction. iPhones only share the compass after a tap asks for it.

const me = { pos: null, heading: null, marker: null };
const pointingEl = $('#pointing');
geolocate.on('geolocate', (ev) => {
  me.pos = [ev.coords.latitude, ev.coords.longitude];
  if (me.marker) me.marker.setLngLat([me.pos[1], me.pos[0]]);
  if (!compassOn) startCompass();
  showHeading();
});
geolocate.on('error', () => { pointingEl.hidden = true; });

let compassOn = false;
function startCompass() {
  compassOn = true;
  const listen = () => {
    const absolute = 'ondeviceorientationabsolute' in window;
    addEventListener(absolute ? 'deviceorientationabsolute' : 'deviceorientation', onOrientation, true);
  };
  const ask = globalThis.DeviceOrientationEvent?.requestPermission;
  if (typeof ask === 'function') ask.call(DeviceOrientationEvent).then((r) => { if (r === 'granted') listen(); }).catch(() => { compassOn = false; });
  else listen();
}
// iPhones need the request inside the tap itself.
map.getContainer().querySelector('.maplibregl-ctrl-geolocate')?.addEventListener('click', () => { if (!compassOn) startCompass(); });

function onOrientation(ev) {
  let h = null;
  if (typeof ev.webkitCompassHeading === 'number' && ev.webkitCompassHeading >= 0) h = ev.webkitCompassHeading;
  else if (ev.absolute && ev.alpha != null) h = 360 - ev.alpha;
  if (h == null) return;
  h = (h + (screen.orientation?.angle ?? window.orientation ?? 0) + 360) % 360;
  // Smooth the jitter, going the short way round.
  me.heading = me.heading == null ? h : (me.heading + ((((h - me.heading) % 360) + 540) % 360 - 180) * 0.25 + 360) % 360;
  showHeadingSoon();
}

let headingFrame = 0;
function showHeadingSoon() {
  if (!headingFrame) headingFrame = requestAnimationFrame(() => { headingFrame = 0; showHeading(); });
}
let lastPointing = 0;
function showHeading() {
  if (!me.pos || me.heading == null) return;
  if (!me.marker) {
    const el = document.createElement('div');
    el.className = 'me-beam';
    el.innerHTML = `<svg viewBox="0 0 160 160" aria-hidden="true"><defs><radialGradient id="beam" cx="80" cy="80" r="78" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1B73E8" stop-opacity=".55"/><stop offset="1" stop-color="#1B73E8" stop-opacity="0"/></radialGradient></defs>
      <path d="M80 80 L52 6 A78 78 0 0 1 108 6 Z" fill="url(#beam)"/></svg>`;
    me.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' })
      .setLngLat([me.pos[1], me.pos[0]]).addTo(map);
  }
  me.marker.setRotation(me.heading);
  const now = Date.now();
  if (now - lastPointing < 500) return;
  lastPointing = now;
  const target = shipPointedAt();
  pointingEl.hidden = false;
  pointingEl.innerHTML = `Pointing <b>${compass(me.heading)} ${num(me.heading)}°</b>${target
    ? ` · ${esc(target.e.name || `MMSI ${target.e.mmsi}`)}, ${num(target.nm, target.nm < 10 ? 1 : 0)} nm` : ''}`;
  pointingEl.dataset.id = target ? target.e.mmsi : '';
  pointingEl.disabled = !target;
}

// The nearest ship on the map within 8° of where the phone points.
function shipPointedAt() {
  let best = null;
  for (const [id, [lat, lon]] of state.positions) {
    const e = state.ships.get(id);
    if (!e) continue;
    const off = Math.abs((((bearing(me.pos, [lat, lon]) - me.heading) % 360) + 540) % 360 - 180);
    if (off > 8) continue;
    const nm = km(me.pos[0], me.pos[1], lat, lon) / 1.852;
    if (!best || nm < best.nm) best = { e, nm };
  }
  return best;
}
pointingEl.addEventListener('click', () => {
  const id = Number(pointingEl.dataset.id);
  if (id) select(id);
});

// ---------- satellite and weather (map buttons above locate) ----------

const SATELLITE = {
  type: 'raster', tileSize: 256, maxzoom: 19,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
};
const RADAR_REFRESH_MS = 10 * 60_000;
const overlays = { satellite: false, weather: false };
try { Object.assign(overlays, JSON.parse(localStorage.getItem('overlays')) || {}); } catch { /* defaults */ }
let radar = null; // { url, time } of the latest RainViewer frame

const OVERLAY_BUTTONS = {
  satellite: { label: 'Satellite view',
    icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 15l5-5 4 4 3-3 6 6"/><circle cx="16" cy="8" r="1.5"/>' },
  weather: { label: 'Weather, waves and rain radar',
    icon: '<path d="M7 15a4 4 0 1 1 .9-7.9A5 5 0 0 1 17.6 9 3.5 3.5 0 0 1 17 16H7"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>' },
};
map.addControl({
  onAdd() {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group overlay-ctrl';
    for (const [key, b] of Object.entries(OVERLAY_BUTTONS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.overlay = key;
      btn.title = b.label;
      btn.setAttribute('aria-label', b.label);
      btn.setAttribute('aria-pressed', String(overlays[key]));
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${b.icon}</svg>`;
      btn.addEventListener('click', () => toggleOverlay(key));
      box.append(btn);
    }
    return box;
  },
  onRemove() {},
}, 'bottom-right');

// Elevation tiles: Mapzen Terrarium on AWS Open Data (free, no key).
const DEM = { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 13,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  attribution: 'Relief: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen Terrain Tiles</a>' };
const RELIEF = {
  light: { 'hillshade-exaggeration': 0.75, 'hillshade-shadow-color': '#4A4436', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#6B6250' },
  dark: { 'hillshade-exaggeration': 0.7, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#8A94A3', 'hillshade-accent-color': '#20252C' },
};

function toggleOverlay(key) {
  overlays[key] = !overlays[key];
  try { localStorage.setItem('overlays', JSON.stringify(overlays)); } catch { /* not remembered */ }
  document.querySelector(`[data-overlay="${key}"]`).setAttribute('aria-pressed', String(overlays[key]));
  if (key === 'weather' && overlays.weather) refreshRadar();
  addOverlays();
  updateWeather();
}

// Satellite goes under the base map's labels; radar over everything but our ships.
function addOverlays() {
  if (!map.getLayer('ships-still')) return; // style still loading; 'style.load' calls us again
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol' && !l.id.startsWith('ships'));
  const ours = 'track';
  // Relief shading so hills and mountains stand out (hidden under the satellite view, which has its own).
  if (!map.getSource('dem')) map.addSource('dem', DEM);
  if (!map.getLayer('relief')) {
    map.addLayer({ id: 'relief', type: 'hillshade', source: 'dem', paint: RELIEF[isDark() ? 'dark' : 'light'] }, firstLabel?.id || ours);
  }
  map.setLayoutProperty('relief', 'visibility', overlays.satellite ? 'none' : 'visible');
  if (overlays.satellite && !map.getLayer('satellite')) {
    if (!map.getSource('satellite')) map.addSource('satellite', SATELLITE);
    map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite' }, firstLabel?.id || ours);
  } else if (!overlays.satellite && map.getLayer('satellite')) {
    map.removeLayer('satellite');
  }
  const radarUrl = overlays.weather && radar ? radar.url : null;
  if (map.getSource('radar') && map.getSource('radar').url_ !== radarUrl) {
    if (map.getLayer('radar')) map.removeLayer('radar');
    map.removeSource('radar');
  }
  if (radarUrl && !map.getSource('radar')) {
    map.addSource('radar', { type: 'raster', tileSize: 256, maxzoom: 7, tiles: [radarUrl] });
    map.getSource('radar').url_ = radarUrl; // remembered to swap in the next frame
    map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.65 } }, ours);
  }
}

async function refreshRadar() {
  if (!overlays.weather) return;
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data = await res.json();
    const frame = data.radar.past[data.radar.past.length - 1];
    radar = { url: `${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, time: frame.time * 1000 };
  } catch { radar = null; }
  addOverlays();
  updateWeather();
}
setInterval(refreshRadar, RADAR_REFRESH_MS);

// Conditions at the map centre from Open-Meteo, with the wave height when the centre is at sea.
const WEATHER_CODES = [
  [0, '☀️', 'Clear'], [1, '🌤️', 'Mostly clear'], [2, '⛅', 'Partly cloudy'], [3, '☁️', 'Cloudy'],
  [48, '🌫️', 'Fog'], [57, '🌦️', 'Drizzle'], [67, '🌧️', 'Rain'], [77, '🌨️', 'Snow'],
  [82, '🌧️', 'Showers'], [86, '🌨️', 'Snow showers'], [99, '⛈️', 'Thunderstorm'],
];
const weatherEl = $('#weather');
const weatherCache = new Map();
let weatherTimer;

function updateWeather() {
  weatherEl.hidden = !overlays.weather;
  if (!overlays.weather) return;
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(async () => {
    const c = map.getCenter();
    const key = `${c.lat.toFixed(1)},${c.wrap().lng.toFixed(1)}`;
    let w = weatherCache.get(key);
    if (!w || Date.now() - w.at > RADAR_REFRESH_MS) {
      const [lat, lon] = key.split(',');
      try {
        const [cur, sea] = await Promise.all([
          fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`).then((r) => r.json()),
          fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height`).then((r) => r.json()).catch(() => null),
        ]);
        w = { at: Date.now(), temp: Math.round(cur.current.temperature_2m), code: cur.current.weather_code,
          wind: Math.round(cur.current.wind_speed_10m), dir: cur.current.wind_direction_10m, wave: sea?.current?.wave_height ?? null };
        weatherCache.set(key, w);
      } catch {
        weatherEl.textContent = 'Weather unavailable';
        return;
      }
    }
    const [, icon, text] = WEATHER_CODES.find(([max]) => w.code <= max) || WEATHER_CODES.at(-1);
    const wave = w.wave != null ? ` · waves ${w.wave.toFixed(1)} m` : '';
    const radarTime = radar ? ` · radar ${new Date(radar.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    weatherEl.innerHTML = `<span class="wx-icon" aria-hidden="true">${icon}</span><strong>${w.temp}°</strong><span>${text} · wind ${compass(w.dir)} ${w.wind} kn${wave}${radarTime}</span>`;
    weatherEl.title = 'Weather at the map centre';
  }, 400);
}
map.on('moveend', updateWeather);
refreshRadar();
updateWeather();

// ---------- map layers (re-added whenever the base style changes) ----------

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// A ship hull seen from above, drawn once as a signed distance field so MapLibre can
// tint it per ship, outline it and turn it to the ship's heading.
// Moving ships are filled, moored ones outlined.
function hullImage() {
  const pad = 8, hw = 22, hh = 60, w = hw + 2 * pad, h = hh + 2 * pad;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const l = pad, r = pad + hw, top = pad, bot = pad + hh, mid = w / 2, sh = hh * 0.36;
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(mid, top);
  g.bezierCurveTo(r - 1, top + sh * 0.3, r, top + sh * 0.65, r, top + sh);
  g.lineTo(r, bot - 5);
  g.quadraticCurveTo(r, bot, r - 5, bot);
  g.lineTo(l + 5, bot);
  g.quadraticCurveTo(l, bot, l, bot - 5);
  g.lineTo(l, top + sh);
  g.bezierCurveTo(l, top + sh * 0.65, l + 1, top + sh * 0.3, mid, top);
  g.closePath(); g.fill();
  const img = g.getImageData(0, 0, w, h), px = img.data;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  const R = 8;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const me = inside[y * w + x];
      let best = R;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          const other = yy < 0 || yy >= h || xx < 0 || xx >= w ? 0 : inside[yy * w + xx];
          if (other !== me) best = Math.min(best, Math.hypot(dx, dy));
        }
      }
      const d = me ? 0.5 - best : best - 0.5; // negative inside the hull
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = Math.max(0, Math.min(255, Math.round(255 * (0.75 - d / R))));
    }
  }
  return img;
}

map.on('style.load', () => {
  if (isDark()) {
    for (const [id, paint] of Object.entries(DARK_MAP)) {
      if (!map.getLayer(id)) continue;
      for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(id, prop, value);
    }
  }
  const ink = css('--ink');
  const ground = css('--surface');
  const color = ['match', ['get', 'cat'], ...Object.keys(CATS).flatMap((k) => [k, catColor(k)]), catColor('other')];
  const empty = { type: 'FeatureCollection', features: [] };
  // Sizes grow with the zoom; the selected ship is drawn bigger at every zoom.
  const bySel = (selected, ...stops) => ['interpolate', ['linear'], ['zoom'],
    ...stops.flatMap(([z, v]) => [z, ['case', ['==', ['get', 'sel'], 1], selected, v]])];
  if (!map.hasImage('hull')) map.addImage('hull', hullImage(), { sdf: true, pixelRatio: 2 });
  const hullSize = bySel(1.25, [2, 0.45], [5, 0.6], [8, 0.85], [11, 1.05], [14, 1.25]);

  map.addSource('track', { type: 'geojson', data: empty });
  map.addSource('route', { type: 'geojson', data: empty });
  map.addSource('hulls', { type: 'geojson', data: empty });
  map.addSource('ships', { type: 'geojson', data: empty });

  // Where the ship is still going (dashed), then where it has been since we saw it.
  map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ink, 'line-opacity': 0.7, 'line-width': 2.5, 'line-dasharray': [1.5, 2] } });
  map.addLayer({ id: 'route-end', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 7, 'circle-color': ground, 'circle-stroke-color': ink, 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'track', type: 'line', source: 'track',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ink, 'line-opacity': 0.45, 'line-width': 4 } });

  // Close in, ships that sent their size are drawn to scale.
  map.addLayer({ id: 'hulls', type: 'fill', source: 'hulls',
    paint: { 'fill-color': color, 'fill-opacity': ['case', ['==', ['get', 'mv'], 1], 0.9, 0.3] } });
  map.addLayer({ id: 'hulls-line', type: 'line', source: 'hulls',
    paint: { 'line-color': ['case', ['==', ['get', 'sel'], 1], ink, color], 'line-width': ['case', ['==', ['get', 'sel'], 1], 2.5, 1.5] } });

  map.addLayer({ id: 'ships-halo', type: 'circle', source: 'ships', filter: ['==', ['get', 'id'], -1],
    paint: { 'circle-radius': 22, 'circle-color': color, 'circle-opacity': 0.22 } });
  map.addLayer({ id: 'ships-dot', type: 'circle', source: 'ships', filter: ['all', ['==', ['get', 'mv'], 0], ['==', ['get', 'hk'], 0], ['==', ['get', 'big'], 0]],
    paint: {
      'circle-radius': bySel(8, [2, 2.5], [8, 4.5], [12, 6]),
      'circle-color': color,
      'circle-opacity': ['case', ['==', ['get', 'old'], 1], 0.45, 1],
      'circle-stroke-color': ground,
      'circle-stroke-width': bySel(3, [3, 0.5], [8, 1.5]),
    } });
  const hullLayout = {
    'icon-image': 'hull', 'icon-rotate': ['get', 'hdg'], 'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': hullSize, 'symbol-sort-key': ['get', 'sel'],
  };
  map.addLayer({ id: 'ships-still', type: 'symbol', source: 'ships', filter: ['all', ['==', ['get', 'mv'], 0], ['==', ['get', 'hk'], 1], ['==', ['get', 'big'], 0]],
    layout: hullLayout,
    paint: { 'icon-color': ground, 'icon-halo-color': color, 'icon-halo-width': 2.2, 'icon-halo-blur': 0,
      'icon-opacity': ['case', ['==', ['get', 'old'], 1], 0.45, 1] } });
  map.addLayer({ id: 'ships-moving', type: 'symbol', source: 'ships', filter: ['all', ['==', ['get', 'mv'], 1], ['==', ['get', 'big'], 0]],
    layout: hullLayout,
    paint: { 'icon-color': color, 'icon-halo-color': ground, 'icon-halo-width': 1.5, 'icon-halo-blur': 0,
      'icon-opacity': ['case', ['==', ['get', 'old'], 1], 0.45, 1] } });
  if (map.getStyle().glyphs) {
    map.addLayer({ id: 'ships-names', type: 'symbol', source: 'ships', minzoom: 11, filter: ['all', ['has', 'label'], ['==', ['get', 'sel'], 0]],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
        'text-offset': [1, 0], 'text-anchor': 'left', 'text-optional': true },
      paint: { 'text-color': css('--muted'), 'text-halo-color': ground, 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'ships-label', type: 'symbol', source: 'ships', filter: ['==', ['get', 'id'], -1],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
        'text-offset': [1.4, 0], 'text-anchor': 'left', 'text-allow-overlap': true },
      paint: { 'text-color': ink, 'text-halo-color': ground, 'text-halo-width': 2 } });
    map.addLayer({ id: 'route-name', type: 'symbol', source: 'route', filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
        'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': ink, 'text-halo-color': ground, 'text-halo-width': 2 } });
  }
  addOverlays();
  setSelectedFilters();
  draw();
});

// Taps are matched against where we drew each ship this second, not against the map's
// rendered features, which vanish for a moment every time the layer is re-indexed.
const TAP_RADIUS = 20; // px

function shipAt(point) {
  const hull = map.getLayer('hulls') && map.queryRenderedFeatures(point, { layers: ['hulls'] })[0];
  if (hull) return hull.properties.id;
  let best = null;
  let bestDist = TAP_RADIUS;
  for (const [id, pos] of state.positions) {
    const p = map.project([pos[1], pos[0]]);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestDist) { best = id; bestDist = d; }
  }
  return best;
}

map.on('click', (e) => {
  const id = shipAt(e.point);
  if (id != null) select(id);
  else deselect();
});
map.on('mousemove', (e) => {
  map.getCanvas().style.cursor = shipAt(e.point) != null ? 'pointer' : '';
});
map.on('dragstart', () => setFollowing(false));
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('view', { c: [+c.wrap().lng.toFixed(3), +c.lat.toFixed(3)], z: +map.getZoom().toFixed(2) });
  sendViewSoon();
  draw();
});

// ---------- ships ----------

function entry(mmsi) {
  let e = state.ships.get(mmsi);
  if (!e) {
    e = { mmsi, name: null, cs: null, imo: null, type: 0, cat: 'other', dim: null, dest: null, eta: null, draught: null,
      lat: null, lon: null, sog: null, cog: null, hdg: null, nav: null, cls: 'A', t: 0, born: Date.now(), trail: [] };
    const s = state.statics.get(mmsi);
    if (s) [e.name, e.type, e.cs, e.imo, e.dim, e.dest, e.draught, e.eta] = s;
    e.cat = catOf(e.type);
    state.ships.set(mmsi, e);
  }
  return e;
}
function remember(e) {
  state.statics.set(e.mmsi, [e.name, e.type, e.cs, e.imo, e.dim, e.dest, e.draught, e.eta, Date.now()]);
}
function setPos(e, lat, lon, sog, cog, hdg, t) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0) || t < e.t) return false;
  e.lat = lat; e.lon = lon; e.t = t;
  e.sog = sog != null && sog < 102.2 ? sog : null;
  e.cog = cog != null && cog < 360 ? cog : null;
  e.hdg = hdg != null && hdg < 360 ? hdg : null;
  const last = e.trail[e.trail.length - 1];
  if (!last || meters(last, [lat, lon]) > 40 || t - last[2] > 120_000) {
    e.trail.push([lat, lon, t]);
    if (e.trail.length > 600) e.trail.splice(0, e.trail.length - 600);
  }
  return true;
}
function setType(e, t) { if (t) { e.type = t; e.cat = catOf(t); e.regType = false; } }
function setDim(e, d) {
  if (!d) return;
  const v = [d.A, d.B, d.C, d.D].map((x) => +x || 0);
  if (v[0] + v[1] > 2 && v[2] + v[3] > 0.5 && v[0] < 511 && v[1] < 511) e.dim = v;
}
const clean = (s) => { s = String(s || '').replace(/@+$/, '').replace(/\s+/g, ' ').trim(); return s && !/^@+$/.test(s) ? s : null; };
function aisTime(s) {
  // "2024-05-01 12:34:56.789 +0000 UTC"
  const t = Date.parse(`${String(s || '').slice(0, 19).replace(' ', 'T')}Z`);
  const now = Date.now();
  return Number.isFinite(t) && t < now + 60_000 ? Math.min(t, now) : now;
}

function onAis(m) {
  const md = m.MetaData || {};
  const mmsi = md.MMSI, type = m.MessageType, body = m.Message?.[type];
  if (!mmsi || !body) return;
  const e = entry(mmsi);
  const t = aisTime(md.time_utc);
  if (!e.name) e.name = clean(md.ShipName);
  if (type === 'PositionReport') {
    e.cls = 'A';
    if (setPos(e, body.Latitude, body.Longitude, body.Sog, body.Cog, body.TrueHeading, t)) e.nav = body.NavigationalStatus;
  } else if (type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
    e.cls = 'B';
    setPos(e, body.Latitude, body.Longitude, body.Sog, body.Cog, body.TrueHeading, t);
    if (type === 'ExtendedClassBPositionReport') { e.name = clean(body.Name) || e.name; setType(e, body.Type); setDim(e, body.Dimension); remember(e); }
  } else if (type === 'ShipStaticData') {
    e.name = clean(body.Name) || e.name;
    e.cs = clean(body.CallSign) || e.cs;
    if (body.ImoNumber > 999_999 && body.ImoNumber < 10_000_000) e.imo = body.ImoNumber;
    setType(e, body.Type);
    setDim(e, body.Dimension);
    e.dest = clean(body.Destination);
    e.draught = body.MaximumStaticDraught > 0 ? body.MaximumStaticDraught : null;
    const a = body.Eta || {};
    e.eta = a.Month >= 1 && a.Month <= 12 && a.Day >= 1 && a.Hour < 24 && a.Minute < 60 ? [a.Month, a.Day, a.Hour, a.Minute] : null;
    remember(e);
  } else if (type === 'StaticDataReport') {
    const A = body.ReportA || {}, B = body.ReportB || {};
    if (A.Valid) e.name = clean(A.Name) || e.name;
    if (B.Valid) { setType(e, B.ShipType); e.cs = clean(B.CallSign) || e.cs; setDim(e, B.Dimension); }
    e.cls = 'B';
    remember(e);
  }
  if (e.mmsi === state.selected) panelDirty = true;
}

// Where a ship is now: its last report, carried forward along its course when under way.
function posNow(e, now) {
  const age = now - e.t;
  if (e.sog >= 0.5 && e.cog != null && age > 0 && age < DR_MAX_MS) return move([e.lat, e.lon], e.cog, e.sog * (NM / 3600) * (age / 1000));
  return [e.lat, e.lon];
}
const heading = (e) => (e.hdg != null ? e.hdg : e.cog);

// ---------- drawing, once a second ----------

let frame = 0;
function draw() {
  const now = Date.now();
  const b = map.getBounds();
  const lngC = map.getCenter().lng;
  const padLat = (b.getNorth() - b.getSouth()) * 0.05, padLng = (b.getEast() - b.getWest()) * 0.05;
  const S0 = b.getSouth() - padLat, N0 = b.getNorth() + padLat, W0 = b.getWest() - padLng, E0 = b.getEast() + padLng;
  const counts = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]));
  const labels = map.getZoom() >= 11;
  state.positions.clear();
  const features = [], hulls = [];
  const zoomScale = 40_075_016.686 / (512 * 2 ** map.getZoom());
  const mpp = (lat) => zoomScale * Math.cos((lat * Math.PI) / 180); // metres per screen pixel
  for (const e of state.ships.values()) {
    if (now - Math.max(e.t, e.born) > EXPIRE_MS) { if (e.mmsi !== state.selected) state.ships.delete(e.mmsi); continue; }
    if (e.lat == null) continue; // name or type known, position not yet
    let [lat, lon] = posNow(e, now);
    lon += 360 * Math.round((lngC - lon) / 360); // nearest copy of the world
    if (lat < S0 || lat > N0 || lon < W0 || lon > E0) continue;
    counts[e.cat]++;
    const sel = e.mmsi === state.selected;
    if (!state.show[e.cat] && !sel) continue;
    state.positions.set(e.mmsi, [lat, lon]);
    const h = heading(e);
    const mv = e.sog >= 0.5 && h != null ? 1 : 0;
    const dir = mv ? h : e.hdg; // a moored ship's course over ground means nothing
    // To scale once the real hull would look longer than the icon does.
    const big = dir != null && e.dim && (e.dim[0] + e.dim[1]) / mpp(lat) >= HULL_MIN_PX ? 1 : 0;
    const props = { id: e.mmsi, cat: e.cat, sel: sel ? 1 : 0, mv, hk: dir != null ? 1 : 0, hdg: dir ?? 0, big, old: now - e.t > STALE_MS ? 1 : 0 };
    if ((labels || sel) && e.name) props.label = e.name;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
    if (big) hulls.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [hullOutline(lat, lon, dir, e.dim)] },
      properties: { id: e.mmsi, cat: e.cat, sel: props.sel, mv } });
  }
  map.getSource('hulls')?.setData({ type: 'FeatureCollection', features: hulls });
  features.sort((a, c) => a.properties.sel - c.properties.sel); // selected ship on top
  map.getSource('ships')?.setData({ type: 'FeatureCollection', features });
  state.counts = counts;

  const cur = state.ships.get(state.selected);
  if (cur && cur.lat != null) {
    const p = posNow(cur, now);
    if (state.following) map.easeTo({ center: [p[1], p[0]], offset: sheetOffset(), duration: 900 });
    drawTrack(cur, p);
    planRoute(cur);
    drawRoute(cur, p);
    if (panelDirty || frame % 2 === 0) { panelDirty = false; tickPanel(cur); }
  }
  if (frame++ % 2 === 0) refreshChips();
  if (state.mode === 'live' && ws?.readyState === 1 && !statusEl.classList.contains('demo')) {
    statusEl.textContent = state.ships.size
      ? `${features.length.toLocaleString()} ships in view · ${state.rate.toLocaleString(undefined, { maximumFractionDigits: state.rate < 10 ? 1 : 0 })} reports/s`
      : 'Live · waiting for the first ships…';
  }
}

const HULL_MIN_PX = 34;

// The ship's outline in map coordinates. AIS sizes are distances from the GPS antenna
// (the reported position) to the bow, stern, port and starboard sides.
function hullOutline(lat, lon, hdg, [a, b, c, d]) {
  const len = a + b, beam = c + d, mid = (d - c) / 2;
  const bow = Math.min(len * 0.3, beam * 1.6), k = Math.min(beam * 0.18, len * 0.05);
  const local = [[-c, -b + k], [-c + k, -b], [d - k, -b], [d, -b + k], [d, a - bow]];
  for (let i = 1; i < 6; i++) {
    const t = (i / 6) * (Math.PI / 2);
    local.push([d - (d - mid) * (1 - Math.cos(t)), a - bow + bow * Math.sin(t)]);
  }
  local.push([mid, a]);
  for (let i = 5; i > 0; i--) {
    const t = (i / 6) * (Math.PI / 2);
    local.push([-c + (mid + c) * (1 - Math.cos(t)), a - bow + bow * Math.sin(t)]);
  }
  local.push([-c, a - bow], [-c, -b + k]);
  const r = (hdg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const mLat = 111_320, mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return local.map(([x, y]) => [lon + (x * cos + y * sin) / mLon, lat + (y * cos - x * sin) / mLat]);
}

function drawTrack(e, p) {
  const src = map.getSource('track');
  if (!src) return;
  const pts = e.trail.map((q) => [q[1], q[0]]);
  pts.push([p[1], p[0]]);
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  src.setData({ type: 'FeatureCollection', features: pts.length > 1
    ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }] : [] });
}

// ---------- where the ship is heading ----------
// AIS only says where a ship is going as free text, often a UN/LOCODE such as "NL RTM".
// We look that port up, then follow the world's shipping lanes to draw an approximate route.

const fetchJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${u} answered ${r.status}`))));
const norm = (s) => String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
// Words in destinations that are not part of a port name.
const DEST_NOISE = new Set(['ANCH', 'ANCHORAGE', 'ANCHOR', 'PILOT', 'PBG', 'NAB', 'OPL', 'ROADS', 'ROAD', 'FOR', 'ORDER', 'ORDERS',
  'PORT', 'OFF', 'ETA', 'VIA', 'TO', 'FROM', 'AND', 'BERTH', 'TERMINAL', 'ARRIVAL', 'WAITING', 'AREA', 'BOARDING', 'STATION']);

let portsP = null, seaP = null;
function portData() {
  return (portsP ||= fetchJson('data/ports.json').then((codes) => {
    const names = new Map();
    const add = (name, code) => {
      const k = norm(name);
      if (!k) return;
      if (!names.has(k)) names.set(k, []);
      if (!names.get(k).includes(code)) names.get(k).push(code);
    };
    for (const [cc, list] of Object.entries(codes)) {
      if (cc === '=') continue;
      for (const [loc, [name]] of Object.entries(list)) {
        add(name, cc + loc);
        for (const part of name.split(/[()]/)) add(part.replace(/^\s*ex\s+/i, ''), cc + loc); // "Saint Petersburg (ex Leningrad)"
      }
    }
    for (const [name, code] of Object.entries(codes['='] || {})) add(name, code);
    return { codes, names };
  }).catch((err) => { portsP = null; throw err; }));
}

// The shipping-lane network as a compact graph.
function seaData() {
  return (seaP ||= fetchJson('data/sea.json').then(({ nodes, edges }) => {
    const n = nodes.length / 2, lon = new Float64Array(n), lat = new Float64Array(n);
    for (let i = 0; i < n; i++) { lon[i] = nodes[2 * i]; lat[i] = nodes[2 * i + 1]; }
    const start = new Uint32Array(n + 1);
    for (const v of edges) start[v + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const adj = new Uint32Array(edges.length), fill = start.slice(0, n);
    for (let i = 0; i < edges.length; i += 2) {
      adj[fill[edges[i]]++] = edges[i + 1];
      adj[fill[edges[i + 1]]++] = edges[i];
    }
    return { n, lon, lat, start, adj };
  }).catch((err) => { seaP = null; throw err; }));
}

function km(lat1, lon1, lat2, lon2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Shortest distance along the lanes from every node to one node (Dijkstra); prev[] points the way there.
function lanesTo(g, goal) {
  const dist = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1);
  const heap = [[0, goal]];
  dist[goal] = 0;
  const push = (item) => {
    let i = heap.push(item) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up][0] <= item[0]) break;
      heap[i] = heap[up]; i = up;
    }
    heap[i] = item;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
        if (heap[c][0] >= last[0]) break;
        heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.adj[k], nd = d + km(g.lat[u], g.lon[u], g.lat[v], g.lon[v]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  return { dist, prev };
}

function nearestNode(g, lat, lon) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.n; i++) {
    const d = km(lat, lon, g.lat[i], g.lon[i]);
    if (d < bestD) { best = i; bestD = d; }
  }
  return [best, bestD];
}

// Free-text destination -> { name, cc, lat, lon }, or null when we can't place it.
const portCache = new Map();
function findPort(text, at) {
  const key = norm(text);
  if (!portCache.has(key)) portCache.set(key, lookUpPort(text, at).catch(() => { portCache.delete(key); return null; }));
  return portCache.get(key);
}
async function lookUpPort(text, at) {
  const P = await portData();
  const s = norm(String(text).split('>').pop()) || norm(text); // "FR LEH>GB SOU": where it goes next
  if (!s) return null;
  const nearest = (codes) => codes.map((c) => [c, P.codes[c.slice(0, 2)][c.slice(2)]])
    .sort((a, b) => (a[1][1] == null) - (b[1][1] == null)
      || (a[1][1] != null && b[1][1] != null ? km(at[0], at[1], a[1][1], a[1][2]) - km(at[0], at[1], b[1][1], b[1][2]) : 0))[0];
  const words = s.split(' ');
  const tried = [words.join(' ')];
  const clean = words.filter((w) => !DEST_NOISE.has(w));
  // Longest names first; among equal lengths the last one wins, as in "DOVER-DUNKERQUE".
  for (let len = clean.length; len >= 1; len--) {
    for (let i = clean.length - len; i >= 0; i--) tried.push(clean.slice(i, i + len).join(' '));
  }
  let hit = P.names.get(tried[0]) && nearest(P.names.get(tried[0]));
  if (!hit) {
    // The last code named is where it goes: "GBHRW-NLRTM" means Harwich to Rotterdam.
    for (const m of s.matchAll(/\b([A-Z]{2}) ?([A-Z0-9]{3})\b/g)) {
      const p = P.codes[m[1]]?.[m[2]];
      if (p) hit = [m[1] + m[2], p];
    }
  }
  if (!hit) {
    for (const t of tried.slice(1)) {
      if (t.length < 4 || !P.names.has(t)) continue;
      hit = nearest(P.names.get(t));
      break;
    }
  }
  if (!hit) {
    // A mistyped code, like "FRDNK" for Dunkerque (FRDKK): one letter off a port of that country near the ship.
    let best = 400;
    for (const m of s.matchAll(/\b([A-Z]{2}) ?([A-Z]{3})\b/g)) {
      for (const [c, p] of Object.entries(P.codes[m[1]] || {})) {
        if (p[1] == null || [...c].filter((ch, i) => ch !== m[2][i]).length !== 1) continue;
        const d = km(at[0], at[1], p[1], p[2]);
        if (d < best) { best = d; hit = [m[1] + c, p]; }
      }
    }
  }
  if (hit) {
    const [code, [name, lat, lon]] = hit;
    if (lat != null) return { name, cc: code.slice(0, 2), code, lat, lon };
    const { places = [] } = await fetchJson(`/api/search?q=${encodeURIComponent(name)}`);
    const p = places.find((q) => q.cc === code.slice(0, 2));
    return p ? { name, cc: code.slice(0, 2), code, lat: p.lat, lon: p.lon } : null;
  }
  // Not a port we know: ask the place search, and keep the answer closest to the ship.
  const { places = [] } = await fetchJson(`/api/search?q=${encodeURIComponent(clean.join(' ') || s)}`);
  // Free text matches all sorts of places ("FRANK" is a village), so only trust a port, or a place close to the ship.
  const p = places.filter((q) => q.port || km(at[0], at[1], q.lat, q.lon) < 300)
    .sort((a, b) => km(at[0], at[1], a.lat, a.lon) - km(at[0], at[1], b.lat, b.lon))[0];
  return p && km(at[0], at[1], p.lat, p.lon) < 8000 ? { name: p.name, cc: p.cc, lat: p.lat, lon: p.lon } : null;
}

// Ferries often type both ends of their run: "GBDVR <> FRDKK". Which one is next depends on where the ship heads.
const ROUND_TRIP = /<\s*[-=]*\s*>/;
function roundTrip(dest) {
  const ends = String(dest || '').split(ROUND_TRIP).map((t) => t.trim()).filter((t) => norm(t));
  return ends.length === 2 ? ends : null;
}

// Some crews also type where they came from: "FR LEH>DEHAM" or "GBHRW-NLRTM".
function originText(dest) {
  const raw = String(dest || '');
  if (roundTrip(raw)) return null;
  if (raw.includes('>')) {
    const first = raw.split('>')[0].replace(/[=\-\s]+$/, '');
    return norm(first) ? first : null;
  }
  const codes = [...norm(raw).matchAll(/\b([A-Z]{2}) ?([A-Z0-9]{3})\b/g)];
  return codes.length >= 2 && codes[0][0] !== codes[codes.length - 1][0] ? codes[0][0] : null;
}

// Scheduled crossings from the ferry operators' own open timetables (tools/make_ferries.py).
// Kept apart from AIS: they say when a crossing is due, never where a ship is.
let ferriesP = null, ferries = null;
function ferryData() {
  return (ferriesP ||= fetchJson('data/ferries.json').then((d) => (ferries = d)).catch(() => (ferries = { ports: {}, sailings: [] })));
}
const MIN = 60_000;
// The crossing this ship is most likely making: between the ports of its voyage, under way now,
// and as far along in time as the ship is along the way.
function timetableFor(e, p, now) {
  if (!ferries?.sailings?.length || p?.status !== 'ok') return null;
  const near = (key, place) => { const q = ferries.ports[key]; return q && place && km(q[1], q[2], place.lat, place.lon) < 15; };
  const at = posNow(e, now);
  let best = null, bestFit = 0.3;
  for (const s of ferries.sailings) {
    const dep = s[3] * MIN, arr = s[4] * MIN;
    if (dep > now + 30 * MIN) break;
    if (arr < now - 60 * MIN || !near(s[2], p.place) || (p.from && !near(s[1], p.from))) continue;
    const a = ferries.ports[s[1]], b = ferries.ports[s[2]];
    const sailed = km(a[1], a[2], at[0], at[1]), left = km(at[0], at[1], b[1], b[2]);
    const fit = Math.abs(Math.min(1, Math.max(0, (now - dep) / (arr - dep))) - sailed / (sailed + left || 1));
    if (fit < bestFit) { best = s; bestFit = fit; }
  }
  if (!best) return null;
  const nexts = ferries.sailings.filter((s) => s[1] === best[1] && s[2] === best[2] && s[3] * MIN > now).slice(0, 3);
  return { s: best, operator: ferries.operators[best[0]], from: ferries.ports[best[1]][0], to: ferries.ports[best[2]][0], nexts };
}

// One plan for the selected ship: its destination, and the lanes leading there.
let plan = null;
function planRoute(e) {
  // A ferry keeps "A <> B" both ways, so its plan is redone when it turns round.
  const dest = e.dest || '', turn = roundTrip(dest) && e.cog != null ? Math.round(e.cog / 90) % 4 : null;
  if (plan && plan.mmsi === e.mmsi && plan.dest === dest && plan.turn === turn) return;
  const mine = { mmsi: e.mmsi, dest, turn, status: dest ? 'loading' : 'none', place: null, g: null, tree: null, goal: -1, goalKm: 0 };
  plan = mine;
  if (!dest) return;
  const at = posNow(e, Date.now());
  const from = originText(dest);
  if (from) findPort(from, at).then((o) => { if (plan === mine && o) { mine.from = o; panelDirty = true; } });
  const ends = roundTrip(dest);
  const goal = !ends ? findPort(dest, at) : Promise.all(ends.map((t) => findPort(t, at))).then(([a, b]) => {
    if (!a || !b) return a || b;
    // Heading for the end its course points at; when stopped, the end it is not at.
    const off = (p) => Math.abs(((bearing(at, [p.lat, p.lon]) - e.cog + 540) % 360) - 180);
    const next = e.sog >= 1 && e.cog != null ? (off(a) <= off(b) ? a : b)
      : km(at[0], at[1], a.lat, a.lon) > km(at[0], at[1], b.lat, b.lon) ? a : b;
    mine.from = next === a ? b : a;
    return next;
  });
  Promise.all([goal, seaData()]).then(([place, g]) => {
    if (plan !== mine) return;
    if (!place) { mine.status = 'none'; panelDirty = true; return; }
    const [goal, goalKm] = nearestNode(g, place.lat, place.lon);
    Object.assign(mine, { status: 'ok', place, g, goal, goalKm, tree: goalKm < 400 ? lanesTo(g, goal) : null });
    panelDirty = true;
    draw();
  }).catch(() => { if (plan === mine) { mine.status = 'none'; panelDirty = true; } });
}

// The line from where the ship is now to its destination, and how far that is.
function routeLine(p) {
  const { place, g, tree, goal, goalKm } = plan;
  const [lat, lon] = p;
  const direct = km(lat, lon, place.lat, place.lon);
  let coords = [[lon, lat], [place.lon, place.lat]], total = direct;
  if (tree && direct > 40) {
    // Join the lanes where that makes the whole trip shortest, without long jumps over land.
    const d = new Float64Array(g.n);
    let near = Infinity;
    for (let i = 0; i < g.n; i++) { d[i] = km(lat, lon, g.lat[i], g.lon[i]); if (d[i] < near) near = d[i]; }
    const reach = Math.max(100, near * 1.5);
    let best = -1, score = Infinity;
    for (let i = 0; i < g.n; i++) {
      if (d[i] > reach || tree.dist[i] === Infinity) continue;
      const s = 6 * d[i] + tree.dist[i];
      if (s < score) { score = s; best = i; }
    }
    const lanes = best >= 0 ? d[best] + tree.dist[best] + goalKm : Infinity;
    // Close to port the lanes are coarse; go straight unless that is far shorter than sailing them.
    if (lanes < direct * 8 && !(direct < 100 && lanes > direct * 1.5)) {
      coords = [[lon, lat]];
      for (let v = best; v >= 0; v = v === goal ? -1 : tree.prev[v]) coords.push([g.lon[v], g.lat[v]]);
      coords.push([place.lon, place.lat]);
      total = lanes;
    }
  }
  for (let i = 1; i < coords.length; i++) { // keep the line continuous across the date line
    while (coords[i][0] - coords[i - 1][0] > 180) coords[i][0] -= 360;
    while (coords[i][0] - coords[i - 1][0] < -180) coords[i][0] += 360;
  }
  return { coords, nm: total / 1.852 };
}

function drawRoute(e, p) {
  const src = map.getSource('route');
  if (!src) return;
  if (!plan || plan.mmsi !== e.mmsi || plan.status !== 'ok') {
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const r = routeLine(p);
  plan.nm = r.nm;
  plan.coords = r.coords;
  const end = r.coords[r.coords.length - 1];
  src.setData({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } },
    { type: 'Feature', properties: { name: plan.place.name }, geometry: { type: 'Point', coordinates: end } },
  ] });
}

// Zoom out to show the whole way to the destination.
function showRoute() {
  if (!plan?.coords) return;
  const b = new maplibregl.LngLatBounds(plan.coords[0], plan.coords[0]);
  for (const c of plan.coords) b.extend(c);
  setFollowing(false);
  const pad = phone.matches ? { top: 140, bottom: panel.offsetHeight + 30, left: 30, right: 30 }
    : { top: 60, bottom: 60, left: 60, right: 60 };
  map.fitBounds(b, { padding: pad, maxZoom: 12, duration: 900 });
}

// ---------- live feed ----------

let ws = null, retry = 0, sentBoxes = '', viewTimer = 0, retryTimer = 0;
function boxesForView() {
  const b = map.getBounds();
  const padLat = (b.getNorth() - b.getSouth()) * 0.2, padLng = (b.getEast() - b.getWest()) * 0.2;
  const s = Math.max(-90, b.getSouth() - padLat), n = Math.min(90, b.getNorth() + padLat);
  let w = b.getWest() - padLng, e = b.getEast() + padLng;
  if (e - w >= 360) return [[[-90, -180], [90, 180]]];
  w = ((w + 540) % 360) - 180; e = ((e + 540) % 360) - 180;
  return w <= e ? [[[s, w], [n, e]]] : [[[s, w], [n, 180]], [[s, -180], [n, e]]];
}
function sendView(force) {
  if (ws?.readyState !== 1) return;
  const boxes = boxesForView().map((bx) => bx.map((c) => c.map((v) => +v.toFixed(2))));
  const k = JSON.stringify(boxes);
  if (!force && k === sentBoxes) return;
  sentBoxes = k;
  ws.send(JSON.stringify({ boxes }));
}
function sendViewSoon() { clearTimeout(viewTimer); viewTimer = setTimeout(() => sendView(false), 700); }
const decoder = new TextDecoder();
function connect() {
  clearTimeout(retryTimer);
  if (ws || document.hidden) return;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => { retry = 0; state.lastError = null; sentBoxes = ''; sendView(true); setStatus('Live · waiting for the first ships…'); };
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch { return; }
    if (m.error) { state.lastError = String(m.error); return; }
    state.msgs++;
    onAis(m);
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    if (!state.lastError && ev.reason && ev.reason !== 'bye') state.lastError = ev.reason;
    if (document.hidden) return;
    const keyBad = /key/i.test(state.lastError || '');
    const first = retry === 0 && !keyBad;
    const wait = keyBad ? 60_000 : first ? 500 : Math.min(30_000, 2000 * 2 ** retry);
    retry++;
    // A single drop (the site updating, a network blip) reconnects at once without an alarm.
    if (first) { setStatus('Live · reconnecting…'); retryTimer = setTimeout(connect, wait); return; }
    setStatus(keyBad ? 'aisstream.io rejected the API key · check the Cloudflare secret'
      : `Feed interrupted, reconnecting${state.lastError ? ` (${state.lastError})` : ''}`, 'error');
    retryTimer = setTimeout(connect, wait);
  };
}
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', kind === 'error');
  statusEl.classList.toggle('demo', kind === 'demo');
}
// Close the feed when the tab is hidden for a while: it saves the free upstream quota.
let hideTimer = 0;
document.addEventListener('visibilitychange', () => {
  if (state.mode !== 'live') return;
  clearTimeout(hideTimer);
  if (document.hidden) hideTimer = setTimeout(() => ws?.close(1000, 'hidden'), 60_000);
  else connect();
});
// Extra open feeds (the Baltic, from Finland's Digitraffic), asked for every 30 s while in view.
const EXTRA_AREAS = [[57, 15, 67, 34]];
let extraBusy = false;
async function pollExtra() {
  if (state.mode !== 'live' || document.hidden || extraBusy) return;
  const [[[s, w], [n, e]]] = boxesForView().length === 1 ? boxesForView() : [[[-90, -180], [90, 180]]];
  if (!EXTRA_AREAS.some(([as, aw, an, ae]) => n >= as && s <= an && e >= aw && w <= ae)) return;
  extraBusy = true;
  try {
    const { messages = [] } = await fetchJson(`/api/extra?box=${[s, w, n, e].map((v) => v.toFixed(2)).join(',')}`);
    for (const m of messages) { state.msgs++; onAis(m); }
  } catch { /* the main feed carries on */ } finally { extraBusy = false; }
}
setInterval(pollExtra, 30_000);

// Ships whose name and type messages have not been heard (they come every 6 minutes, and patchy reception
// misses many) are looked up in the ship registry, so they show their name and colour straight away.
const REG_TYPE = { passenger: 60, cargo: 70, tanker: 80, fishing: 30, service: 52, pleasure: 37 };
const asked = new Set();
let regBusy = false;
async function fillFromRegistry() {
  if (state.mode !== 'live' || document.hidden || regBusy) return;
  const b = map.getBounds();
  const ids = [];
  for (const e of state.ships.values()) {
    if (ids.length >= 40) break;
    if (e.type || e.lat == null || asked.has(e.mmsi) || !b.contains([e.lon, e.lat])) continue;
    ids.push(e.mmsi);
  }
  if (!ids.length) return;
  regBusy = true;
  ids.forEach((id) => asked.add(id));
  try {
    const { ships = [] } = await fetchJson(`/api/ship?mmsi=${ids.join(',')}`);
    for (const v of ships) {
      const e = state.ships.get(v.mmsi);
      if (!e) continue;
      if (!e.name && v.name) e.name = v.name;
      if (!e.imo && v.imo) e.imo = v.imo;
      if (!e.cs && v.callsign) e.cs = v.callsign;
      if (!e.type && REG_TYPE[v.kind]) { setType(e, REG_TYPE[v.kind]); e.regType = true; }
      if (e.mmsi === state.selected) panelDirty = true;
    }
    if (ships.length) draw();
  } catch { asked.clear(); /* try again later */ } finally { regBusy = false; }
}
setInterval(fillFromRegistry, 10_000);
map.on('moveend', () => { clearTimeout(fillFromRegistry.t); fillFromRegistry.t = setTimeout(fillFromRegistry, 3000); });
map.on('moveend', () => { clearTimeout(pollExtra.t); pollExtra.t = setTimeout(pollExtra, 1500); });

let lastMsgs = 0, lastRateAt = Date.now();
setInterval(() => {
  const now = Date.now();
  state.rate = ((state.msgs - lastMsgs) * 1000) / (now - lastRateAt);
  lastMsgs = state.msgs; lastRateAt = now;
}, 3000);

// Ships seen recently, and the names and types of every ship seen this week, stay in the
// browser: reopening the app shows the map at once (moored ships report every 3 minutes,
// names and types only every 6).
function saveShips() {
  if (state.mode !== 'live') return;
  const now = Date.now();
  const rows = [...state.ships.values()].filter((e) => e.lat != null && now - e.t < EXPIRE_MS).sort((a, b) => b.t - a.t).slice(0, 6000)
    .map((e) => [e.mmsi, +e.lat.toFixed(5), +e.lon.toFixed(5), e.sog, e.cog, e.hdg, e.nav, e.t, e.cls]);
  store.set('ships', rows);
  const statics = [...state.statics].filter(([, s]) => now - s[8] < STATIC_KEEP_MS).sort((a, b) => b[1][8] - a[1][8]).slice(0, 15000);
  state.statics = new Map(statics);
  store.set('static', statics);
}
function loadShips() {
  const now = Date.now();
  for (const r of store.get('ships', []) || []) {
    if (!Array.isArray(r) || now - r[7] > EXPIRE_MS) continue;
    const e = entry(r[0]);
    [, e.lat, e.lon, e.sog, e.cog, e.hdg, e.nav, e.t, e.cls] = r;
    e.trail = [[e.lat, e.lon, e.t]];
  }
}
setInterval(saveShips, 30_000);
addEventListener('pagehide', saveShips);

// ---------- selecting a ship ----------

let panelDirty = false;
function select(id) {
  const e = state.ships.get(id);
  if (!e) return;
  state.selected = id;
  if (state.mode === 'demo') seedTrail(e);
  setSelectedFilters();
  renderPanel();
  draw();
  keepShipVisible();
}

const phone = matchMedia('(max-width: 720px)');

// On a phone the sheet covers the bottom of the map. The map itself never shifts
// when the sheet opens or closes; it only pans when the ship would be hidden.
function sheetOffset() {
  return [0, phone.matches && !panel.hidden ? -panel.offsetHeight / 2 : 0];
}

function keepShipVisible() {
  const cur = state.positions.get(state.selected);
  if (!phone.matches || panel.hidden || !cur) return;
  const p = map.project([cur[1], cur[0]]);
  const top = 150; // below the search bar and chips
  const bottom = map.getContainer().clientHeight - panel.offsetHeight - 40;
  if (p.y >= top && p.y <= bottom && p.x >= 20 && p.x <= map.getContainer().clientWidth - 20) return;
  map.easeTo({ center: [cur[1], cur[0]], offset: sheetOffset(), duration: 500 });
}

function deselect() {
  if (state.selected == null) return;
  state.selected = null;
  setFollowing(false);
  setSelectedFilters();
  renderPanel();
  map.getSource('track')?.setData({ type: 'FeatureCollection', features: [] });
  map.getSource('route')?.setData({ type: 'FeatureCollection', features: [] });
  plan = null;
  draw();
}

function setSelectedFilters() {
  const f = ['==', ['get', 'id'], state.selected ?? -1];
  if (map.getLayer('ships-halo')) map.setFilter('ships-halo', f);
  if (map.getLayer('ships-label')) map.setFilter('ships-label', f);
}

function setFollowing(on) {
  state.following = on && state.selected != null;
  $('#following').hidden = !state.following;
  const e = state.ships.get(state.selected);
  $('#following-name').textContent = e?.name || (e ? `MMSI ${e.mmsi}` : '');
  const btn = $('#follow');
  if (btn) btn.querySelector('span').textContent = state.following ? 'Stop following' : 'Follow';
  const cur = state.positions.get(state.selected);
  if (state.following && cur) map.flyTo({ center: [cur[1], cur[0]], offset: sheetOffset(), zoom: Math.max(map.getZoom(), 11) });
}
$('#unfollow').addEventListener('click', () => setFollowing(false));

// ---------- panel ----------

const fmtTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const num = (n, d = 0) => (n == null || Number.isNaN(n) ? '–' : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const compass = (d) => (d == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8]);
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}
function dms(v, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
  return `${d}°${m.toFixed(2).padStart(5, '0')}′${v >= 0 ? pos : neg}`;
}
// AIS ETAs carry month, day and time in UTC but no year.
function etaMs(eta) {
  if (!eta) return null;
  const now = Date.now();
  let y = new Date(now).getUTCFullYear();
  let t = Date.UTC(y, eta[0] - 1, eta[1], eta[2], eta[3]);
  if (t < now - 60 * 86_400_000) t = Date.UTC(++y, eta[0] - 1, eta[1], eta[2], eta[3]);
  return t;
}
function until(ms) {
  const left = ms - Date.now();
  if (left <= 0) return 'passed';
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000);
  return h >= 48 ? `in ${Math.floor(h / 24)} d ${h % 24} h` : h ? `in ${h} h ${m} min` : `in ${m} min`;
}

const ICONS = {
  speed: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l4-4"/><circle cx="12" cy="12" r="1.5"/>',
  course: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 6-5 1 2-6z"/>',
  draught: '<rect x="8" y="3" width="8" height="18" rx="1.5"/><path d="M8 7h3M8 11h4M8 15h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (k) => `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const TABS = [['voyage', 'Current voyage'], ['position', 'Current position'], ['ship', 'Ship']];
let panelTab = 'voyage';
const fmtUtc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const spaced = (code) => (code ? `${code.slice(0, 2)} ${code.slice(2)}` : '');

function renderPanel() {
  const e = state.ships.get(state.selected);
  document.body.classList.toggle('has-panel', Boolean(e));
  if (!e) {
    panel.hidden = true;
    return;
  }
  const expanded = panel.classList.contains('expanded');
  const f = flagOf(e.mmsi);
  panel.hidden = false;
  panel.style.setProperty('--c', catColor(e.cat));
  panel.innerHTML = `
    <button type="button" class="handle" id="handle" aria-label="${expanded ? 'Collapse' : 'Expand'} details"></button>
    <button type="button" class="close" id="close" aria-label="Close">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div>
      <h2 class="title">${esc(e.name || `MMSI ${e.mmsi}`)}</h2>
      <div class="subtitle">${flagImg(f)}<span>${esc(typeLabel(e.type))}${e.regType ? ' <small class="muted">(registry)</small>' : ''}${e.imo ? ` <i>|</i> IMO ${e.imo}` : ''}</span><span class="badges" id="badges"></span></div>
    </div>
    <figure class="photo" id="photo" hidden><div class="frame"><img alt=""></div><figcaption></figcaption></figure>
    <div class="tabs" role="tablist">${TABS.map(([k, label]) =>
      `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === panelTab}">${label}</button>`).join('')}</div>
    <section class="pane" data-pane="voyage" ${panelTab === 'voyage' ? '' : 'hidden'}>
      <div class="voyage">
        <div class="end"><small id="from-name"></small><b id="from-code"></b></div>
        <div class="leg" id="leg"><span class="done"></span><svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4l18 8-18 8 5-8z"/></svg><span class="todo"></span></div>
        <div class="end to"><small id="to-name"></small><b id="to-code"></b></div>
      </div>
      <div class="times">
        <div><small id="dep-label">Tracked since</small><span id="dep"></span></div>
        <div class="to"><small>Estimated time of arrival</small><span id="eta"></span><em id="countdown"></em></div>
      </div>
      <div class="timetable" id="timetable" hidden></div>
      <div class="stats">
        <div>${icon('speed')}<span><small>Speed</small><b id="speed">–</b></span></div>
        <div>${icon('course')}<span><small>Course</small><b id="course">–</b></span></div>
        <div>${icon('draught')}<span><small>Draught</small><b id="draught">–</b></span></div>
      </div>
      <button type="button" class="route-btn" id="dest-box"><span id="dest-to"></span></button>
    </section>
    <section class="pane details" data-pane="position" ${panelTab === 'position' ? '' : 'hidden'}><dl id="pos-facts"></dl></section>
    <section class="pane details" data-pane="ship" ${panelTab === 'ship' ? '' : 'hidden'}><dl id="facts"></dl></section>
    <div class="updated">${icon('clock')}<span>Last update <b id="updated"></b></span></div>
    <div class="actions">
      <button type="button" class="btn primary" id="follow">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
        <span>${state.following ? 'Stop following' : 'Follow'}</span>
      </button>
      <button type="button" class="btn more" id="more">${expanded ? 'Less' : 'More'}</button>
    </div>
    ${state.mode === 'live' ? `<a class="photos-link" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${e.mmsi}" target="_blank" rel="noopener">More photos and voyage details on MarineTraffic ↗</a>` : ''}
    <p class="note">${state.mode === 'demo' ? 'Simulated ship: real ships appear once the app runs on Cloudflare with an aisstream.io key.'
      : 'AIS data from <a href="https://aisstream.io">aisstream.io</a> and, in the Baltic, Fintraffic / digitraffic.fi (CC BY 4.0). Ferry timetables from Brittany Ferries, DFDS and Corsica Linea via transport.data.gouv.fr (Licence Ouverte 2.0). Ships do not broadcast where a voyage began unless the crew types it; the solid line is where the ship went since you opened the map, the dashed line an estimated sea route to its destination.'}</p>`;

  $('#close').onclick = deselect;
  $('#dest-box').onclick = showRoute;
  $('#follow').onclick = () => setFollowing(!state.following);
  for (const b of panel.querySelectorAll('.tabs button')) {
    b.onclick = () => {
      panelTab = b.dataset.tab;
      for (const t of panel.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t === b));
      for (const s of panel.querySelectorAll('.pane')) s.hidden = s.dataset.pane !== panelTab;
      tickPanel(e);
    };
  }
  const toggle = () => { panel.classList.toggle('expanded'); renderPanel(); keepShipVisible(); };
  $('#more').onclick = toggle;
  $('#handle').onclick = toggle;
  panel.dataset.key = `${e.mmsi}|${e.name}|${e.type}|${e.imo}`;
  showPhoto(e);
  tickPanel(e);
}

// A photo of the ship, looked up by IMO number, else by name.
const photos = new Map();
function showPhoto(e) {
  const fig = $('#photo');
  if (!fig || state.mode !== 'live') return;
  const name = (e.name || '').trim();
  if (!e.imo && name.length < 5) return; // its details have not arrived yet
  const key = `${e.imo || ''}|${name}`;
  if (!photos.has(key)) {
    const q = new URLSearchParams({ ...(e.imo ? { imo: e.imo } : {}), ...(name ? { name } : {}) });
    photos.set(key, fetchJson(`/api/photo?${q}`).catch(() => { photos.delete(key); return { photo: null, failed: true }; }));
  }
  photos.get(key).then((p) => {
    if (state.selected !== e.mmsi || !fig.isConnected) return;
    const img = fig.querySelector('img'), cap = fig.querySelector('figcaption');
    const none = () => {
      fig.hidden = false;
      fig.classList.add('none');
      cap.hidden = false;
      cap.textContent = p.failed ? 'The photo could not be loaded right now.' : 'No photo of this ship yet.';
    };
    if (!p.photo) { none(); return; }
    img.onload = () => { fig.hidden = false; fig.classList.remove('none'); };
    img.onerror = () => { if (p.full && img.src !== p.full) img.src = p.full; else none(); };
    img.referrerPolicy = 'no-referrer';
    img.src = p.photo;
    img.alt = `Photo of ${e.name || 'the ship'}`;
    const notes = [p.match === 'name' ? 'Found by name, may show a namesake' : '', p.credit ? `Photo: ${p.credit}` : ''];
    cap.textContent = notes.filter(Boolean).join(' · ');
    cap.hidden = !cap.textContent;
  });
}

// Live numbers in the panel, refreshed without re-rendering it.
function tickPanel(e) {
  if (panel.hidden || !$('#speed')) return;
  if (panel.dataset.key !== `${e.mmsi}|${e.name}|${e.type}|${e.imo}`) { renderPanel(); return; }
  const now = Date.now();
  const age = now - e.t;
  const live = state.mode === 'live' ? age < STALE_MS : true;
  $('#badges').innerHTML = state.mode === 'demo' ? '<span class="badge planned">Demo</span>'
    : live ? '<span class="badge live">Live</span>' : '<span class="badge planned">Not heard lately</span>';
  $('#speed').textContent = e.sog != null ? `${num(e.sog, 1)} kn` : '–';
  $('#course').textContent = e.cog != null ? `${num(e.cog, 1)}°` : '–';
  $('#draught').textContent = e.draught ? `${num(e.draught, 1)} m` : '–';
  $('#updated').textContent = ago(age);

  // Voyage: where from (only when the crew typed it), where to, and how far along.
  const t = etaMs(e.eta);
  const p = plan?.mmsi === e.mmsi ? plan : null;
  const ok = p?.status === 'ok' && p.nm != null;
  const from = p?.from;
  $('#from-name').textContent = from ? from.name.toUpperCase() : 'Departure';
  $('#from-code').textContent = from ? spaced(from.code) || from.name : 'not broadcast';
  $('#from-code').classList.toggle('muted', !from);
  // Names and destinations come in a separate message every 6 minutes, so a ship can be on the map before them.
  $('#to-name').textContent = ok ? p.place.name.toUpperCase() : 'Destination';
  $('#to-code').textContent = ok ? spaced(p.place.code) || p.place.name : e.dest || (e.name ? 'not reported' : 'not received yet');
  $('#to-code').classList.toggle('muted', !e.dest);
  const [lat, lon] = posNow(e, now);
  let done = 0.12;
  if (ok && from) {
    const sailed = km(from.lat, from.lon, lat, lon) / 1.852;
    done = Math.min(0.92, Math.max(0.08, sailed / (sailed + p.nm)));
  } else if (ok) done = 0.5;
  $('#leg').style.setProperty('--done', `${Math.round(done * 100)}%`);
  const first = e.trail[0]?.[2];
  $('#dep-label').textContent = 'Tracked since';
  $('#dep').textContent = first ? fmtUtc(first) : '–';
  // Without an ETA from the crew, estimate one from the distance left at the current speed.
  const guess = !t && ok && e.sog >= 1 ? now + (p.nm / e.sog) * 3_600_000 : null;
  $('#eta').textContent = t ? fmtUtc(t) : guess ? `≈ ${fmtUtc(guess)}` : 'Not reported';
  $('#countdown').textContent = t ? until(t) : guess ? `${until(guess)} at this speed` : '';
  $('#dest-to').textContent = !e.dest ? (e.name ? 'The crew left the destination blank, so no route' : 'Ships send their destination every 6 minutes')
    : ok ? `Show route on the map · ${num(p.nm)} nm to go · crew typed “${e.dest}”`
    : p?.status === 'loading' ? 'Finding the port…' : p?.status === 'none' ? `“${e.dest}” is not a port we know, so no route` : '';
  $('#dest-box').disabled = !ok;
  // The operator's timetable, for passenger ships on a route that publishes one.
  if (e.cat === 'passenger' && ok && !ferries) ferryData().then(() => { panelDirty = true; });
  const tt = e.cat === 'passenger' ? timetableFor(e, p, now) : null;
  const ttEl = $('#timetable');
  ttEl.hidden = !tt;
  if (tt) {
    const hm = (m) => new Date(m * MIN).toISOString().slice(11, 16);
    const day = (m) => new Date(m * MIN).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
    ttEl.innerHTML = `<small>Timetable · ${esc(tt.operator)}</small>
      <span>${esc(tt.from)} ${hm(tt.s[3])} → ${esc(tt.to)} ${hm(tt.s[4])} UTC</span>
      ${tt.nexts.length ? `<em>Next: ${tt.nexts.map((n) => `${day(n[3])} ${hm(n[3])}`).join(' · ')} UTC</em>` : ''}
      <p>From the operator’s published timetable, not from the ship’s signal.</p>`;
  }

  const nav = NAV[e.nav] || (e.sog >= 0.5 ? 'Under way' : e.sog != null ? 'Stopped' : null);
  const len = e.dim ? e.dim[0] + e.dim[1] : null, beam = e.dim ? e.dim[2] + e.dim[3] : null;
  const f = flagOf(e.mmsi);
  const list = (rows) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v == null || v === '' ? '–' : esc(v)}</dd>`).join('');
  $('#pos-facts').innerHTML = list([
    ['Latitude', dms(lat, 'N', 'S')], ['Longitude', dms(lon, 'E', 'W')], ['Status', nav],
    ['Speed', e.sog != null ? `${num(e.sog, 1)} kn (${num(e.sog * 1.852, 0)} km/h)` : null],
    ['Course', e.cog != null ? `${num(e.cog, 1)}° ${compass(e.cog)}` : null], ['Heading', e.hdg != null ? `${num(e.hdg)}°` : null],
    ['Last report', ago(age)],
  ]);
  $('#facts').innerHTML = list([
    ['Name', e.name], ['Type', typeLabel(e.type)], ['Flag', f?.name], ['Size', len ? `${num(len)} × ${num(beam)} m` : null],
    ['Draught', e.draught ? `${num(e.draught, 1)} m` : null], ['IMO', e.imo], ['MMSI', e.mmsi], ['Call sign', e.cs],
    ['AIS class', e.cls],
  ]);
}

// ---------- swipe the sheet down to close it (phone) ----------

let drag = null;
panel.addEventListener('touchstart', (e) => {
  if (!phone.matches || e.touches.length !== 1) return;
  if (panel.scrollTop > 0 && !e.target.closest('.handle')) return; // let the details scroll
  drag = { y: e.touches[0].clientY, dy: 0 };
  panel.style.transition = 'none';
}, { passive: true });
panel.addEventListener('touchmove', (e) => {
  if (!drag) return;
  drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
  if (drag.dy > 0) e.preventDefault(); // no page bounce while dragging
  panel.style.transform = drag.dy ? `translateY(${drag.dy}px)` : '';
}, { passive: false });
panel.addEventListener('touchend', () => {
  if (!drag) return;
  const { dy } = drag;
  drag = null;
  panel.style.transition = 'transform .2s ease-out';
  if (dy < 80) { panel.style.transform = ''; return; }
  if (panel.classList.contains('expanded') && dy < 250) {
    // A short pull on the full sheet folds it back to the summary.
    panel.style.transform = '';
    panel.classList.remove('expanded');
    renderPanel();
    return;
  }
  panel.style.transform = 'translateY(100%)';
  setTimeout(() => {
    panel.style.transition = '';
    panel.style.transform = '';
    panel.classList.remove('expanded');
    deselect();
  }, 200);
});
panel.addEventListener('touchcancel', () => {
  drag = null;
  panel.style.transform = '';
});

// ---------- search: ships the app knows, then ports and places ----------

const q = $('#q');
const results = $('#results');
let searchTimer;
const qClear = $('#q-clear');
q.addEventListener('input', () => {
  qClear.hidden = !q.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 250);
});
qClear.addEventListener('click', () => {
  q.value = '';
  qClear.hidden = true;
  results.hidden = true;
  q.focus();
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { results.hidden = true; q.blur(); }
  if (e.key === 'Enter') results.querySelector('button')?.click();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

async function search() {
  const text = q.value.trim();
  if (text.length < 2) { results.hidden = true; return; }
  const needle = text.toUpperCase().replace(/^(IMO|MMSI)[\s:#]*/, '').replace(/\s+/g, ' ');
  const ships = [];
  for (const e of state.ships.values()) {
    if (e.lat == null) continue;
    const keys = [e.name, e.cs, String(e.mmsi), e.imo && String(e.imo)].filter(Boolean).map((k) => k.toUpperCase());
    const exact = keys.includes(needle);
    if (exact || keys.some((k) => k.includes(needle))) ships.push([exact ? 0 : keys[0]?.startsWith(needle) ? 1 : 2, e]);
  }
  ships.sort((a, b) => a[0] - b[0]);
  const top = ships.slice(0, 6).map(([, e]) => e);
  // Ships this browser heard this week but not in view now: they can be looked for worldwide.
  const away = [];
  for (const [mmsi, st] of state.statics) {
    if (away.length >= 4 || state.ships.get(mmsi)?.lat != null) continue;
    const keys = [st[0], st[2], String(mmsi), st[3] && String(st[3])].filter(Boolean).map((k) => k.toUpperCase());
    if (keys.some((k) => k.includes(needle))) away.push({ mmsi, name: st[0], imo: st[3] });
  }
  const digits = needle.replace(/\D/g, '');
  const byNumber = /^\d+$/.test(needle) && (digits.length === 7 || digits.length === 9);
  const hunt = top.length || away.length ? null
    : byNumber ? (digits.length === 7 ? { imo: +digits } : { mmsi: +digits })
    : /[A-Z]/.test(needle) && needle.length >= 4 ? { text: needle } : null;
  let places = [];
  if (!/^\d{5,}$/.test(needle)) {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`);
      if (res.ok) places = (await res.json()).places;
    } catch { /* ships still show */ }
  }
  if (q.value.trim() !== text) return;

  results.innerHTML = [
    ...top.map((e, i) => `<li><button type="button" data-ship="${i}"><span class="dot" style="background:${catColor(e.cat)}"></span>
      <span><strong class="mono">${esc(e.name || `MMSI ${e.mmsi}`)}</strong> ${esc(e.dest ? `→ ${e.dest}` : typeLabel(e.type))}</span><span class="kind">${esc(CATS[e.cat].label)}</span></button></li>`),
    ...away.map((a, i) => `<li><button type="button" data-away="${i}"><span class="dot"></span>
      <span><strong class="mono">${esc(a.name || `MMSI ${a.mmsi}`)}</strong> not in view</span><span class="kind">Find it</span></button></li>`),
    ...(hunt ? [`<li><button type="button" data-hunt><svg class="pin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>
      <span><strong class="mono">${esc(hunt.text || (hunt.imo ? `IMO ${hunt.imo}` : `MMSI ${hunt.mmsi}`))}</strong> ${hunt.text ? 'is not in view' : 'is not on the map yet'}</span><span class="kind">Look worldwide</span></button></li>`] : []),
    ...places.map((p, i) => `<li><button type="button" data-place="${i}">
      <svg class="pin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${p.port
        ? '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13a7 7 0 0 0 14 0M8 11h8"/>' : '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'}</svg>
      <span>${esc(p.name)}</span><span class="kind">${esc(p.detail || (p.port ? 'Port' : 'Place'))}</span></button></li>`),
  ].join('') || '<li class="empty">No ship or place matches. The map only knows ships in or near the view; type an IMO or MMSI number to look worldwide.</li>';
  results.hidden = false;
  results.querySelectorAll('[data-ship]').forEach((b) => {
    b.onclick = () => {
      const e = top[b.dataset.ship];
      results.hidden = true;
      const p = posNow(e, Date.now());
      map.jumpTo({ center: [p[1], p[0]], zoom: Math.max(map.getZoom(), 11) });
      select(e.mmsi);
    };
  });
  results.querySelectorAll('[data-away]').forEach((b) => {
    b.onclick = () => { results.hidden = true; findShip(away[b.dataset.away]); };
  });
  results.querySelector('[data-hunt]')?.addEventListener('click', () => { results.hidden = true; findShip(hunt); });
  results.querySelectorAll('[data-place]').forEach((b) => {
    b.onclick = () => {
      const p = places[b.dataset.place];
      results.hidden = true;
      q.value = p.name;
      if (p.extent) map.fitBounds([[p.extent[0], p.extent[3]], [p.extent[2], p.extent[1]]], { padding: 40, maxZoom: 13 });
      else map.flyTo({ center: [p.lon, p.lat], zoom: 12 });
    };
  });
}

// ---------- find one ship anywhere ----------
// The main feed only covers the view, so a ship elsewhere is asked for by MMSI on a second feed for the whole world.
// It shows up at its next position report: seconds for a ship under way near a shore station, minutes when moored,
// never when it is out of reach of shore stations (the free feed has no satellite reception).

const huntEl = $('#hunt');
let hunting = null;
function stopHunt(text) {
  if (!hunting) return;
  clearTimeout(hunting.timer);
  try { hunting.sock.close(1000, 'bye'); } catch { /* already closed */ }
  hunting = null;
  if (text) { huntEl.querySelector('span').textContent = text; setTimeout(() => { if (!hunting) huntEl.hidden = true; }, 9000); } else huntEl.hidden = true;
}
$('#hunt-stop').addEventListener('click', () => stopHunt());
async function findShip({ mmsi, imo, name, text }) {
  stopHunt();
  if (state.mode !== 'live') return;
  if (text) { findByName(text); return; }
  const label = name || (imo ? `IMO ${imo}` : `MMSI ${mmsi}`);
  const say = (text) => { huntEl.hidden = false; huntEl.querySelector('span').textContent = text; };
  if (!mmsi && imo) {
    for (const [m, st] of state.statics) if (st[3] === imo) mmsi = m;
    if (!mmsi) {
      say(`Looking up ${label}…`);
      const r = await fetchJson(`/api/ship?imo=${imo}`).catch(() => null);
      mmsi = r?.mmsi;
      if (!mmsi) { say(`No MMSI is published for ${label}, so it can only be found once it is in view. Try its name or MMSI.`); setTimeout(() => { if (!hunting) huntEl.hidden = true; }, 12000); return; }
    }
  }
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
  sock.binaryType = 'arraybuffer';
  hunting = { mmsi, sock };
  hunting.timer = setTimeout(() => stopHunt(`${label} did not report in 5 minutes. It may be out of reach of shore stations.`), 5 * 60_000);
  say(`Looking for ${label} worldwide…`);
  sock.onopen = () => sock.send(JSON.stringify({ boxes: [[[-90, -180], [90, 180]]], mmsi: [mmsi] }));
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch { return; }
    if (m.error || m.MetaData?.MMSI !== mmsi) return;
    onAis(m);
    const e = state.ships.get(mmsi);
    if (e?.lat == null) return;
    stopHunt();
    map.jumpTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 10) });
    select(mmsi);
  };
  sock.onclose = () => { if (hunting?.sock === sock) stopHunt(`The search for ${label} was cut off. Try again.`); };
}

// A name can't be filtered upstream, so listen to the whole world for a minute and keep the ships whose name matches.
// Every position report carries the ship's name, so a ship under way near a shore station shows up within seconds.
async function findByName(text) {
  const say = (t) => { huntEl.hidden = false; huntEl.querySelector('span').textContent = t; };
  // With the ship registry, a name gives MMSIs, and only those ships are asked for.
  say(`Looking up ships named “${text}”…`);
  const reg = await fetchJson(`/api/ship?name=${encodeURIComponent(text)}`).catch(() => null);
  const ids = (reg?.ships || []).map((v) => v.mmsi).filter(Boolean).slice(0, 10);
  if (ids.length) { huntMany(text, ids); return; }
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
  sock.binaryType = 'arraybuffer';
  const found = new Set();
  const done = () => {
    const ids = [...found].filter((id) => state.ships.get(id)?.lat != null);
    if (!ids.length) { stopHunt(`No ship named “${text}” reported in a minute. It may be out of reach of shore stations.`); return; }
    stopHunt();
    if (ids.length === 1) {
      const e = state.ships.get(ids[0]);
      map.jumpTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 10) });
      select(e.mmsi);
    } else {
      q.value = text;
      qClear.hidden = false;
      search(); // the matches are now known ships, so the list offers each of them
    }
  };
  hunting = { sock, timer: setTimeout(done, 60_000) };
  say(`Looking worldwide for ships named “${text}”…`);
  sock.onopen = () => sock.send(JSON.stringify({ boxes: [[[-90, -180], [90, 180]]] }));
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch { return; }
    const id = m.MetaData?.MMSI;
    if (!id || !(clean(m.MetaData.ShipName) || '').toUpperCase().includes(text)) return;
    onAis(m);
    if (!found.has(id) && state.ships.get(id)?.lat != null) {
      found.add(id);
      say(`Found ${found.size} named “${text}”, still listening…`);
      // Give namesakes a little longer to report, then stop.
      clearTimeout(hunting.timer);
      hunting.timer = setTimeout(done, 15_000);
    }
  };
  sock.onclose = () => { if (hunting?.sock === sock) done(); };
}

// Several MMSIs at once, anywhere: stop a little after the first one reports.
function huntMany(text, ids) {
  stopHunt();
  const say = (t) => { huntEl.hidden = false; huntEl.querySelector('span').textContent = t; };
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stream`);
  sock.binaryType = 'arraybuffer';
  const found = new Set();
  const done = () => {
    const got = [...found].filter((id) => state.ships.get(id)?.lat != null);
    if (!got.length) { stopHunt(`No ship named “${text}” reported in 5 minutes. It may be out of reach of shore stations.`); return; }
    stopHunt();
    if (got.length === 1) {
      const e = state.ships.get(got[0]);
      map.jumpTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 10) });
      select(e.mmsi);
    } else { q.value = text; qClear.hidden = false; search(); }
  };
  hunting = { sock, timer: setTimeout(done, 5 * 60_000) };
  say(`Looking worldwide for ${ids.length} ship${ids.length > 1 ? 's' : ''} named “${text}”…`);
  sock.onopen = () => sock.send(JSON.stringify({ boxes: [[[-90, -180], [90, 180]]], mmsi: ids }));
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch { return; }
    const id = m.MetaData?.MMSI;
    if (!ids.includes(id)) return;
    onAis(m);
    if (!found.has(id) && state.ships.get(id)?.lat != null) {
      found.add(id);
      if (found.size === ids.length) { done(); return; }
      say(`Found ${found.size} named “${text}”, still listening…`);
      clearTimeout(hunting.timer);
      hunting.timer = setTimeout(done, 20_000);
    }
  };
  sock.onclose = () => { if (hunting?.sock === sock) done(); };
}

// ---------- filters ----------

function buildChips() {
  $('#chips').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<button type="button" data-cat="${k}" aria-pressed="${state.show[k]}"><i></i>${c.label}<small></small></button>`).join('');
  document.querySelectorAll('.chips button').forEach((b) => {
    b.style.setProperty('--c', catColor(b.dataset.cat));
    b.addEventListener('click', () => {
      const k = b.dataset.cat;
      state.show[k] = !state.show[k];
      b.setAttribute('aria-pressed', String(state.show[k]));
      store.set('show', state.show);
      draw();
    });
  });
}
function refreshChips() {
  document.querySelectorAll('.chips button').forEach((b) => {
    const n = state.counts[b.dataset.cat] || 0;
    b.lastElementChild.textContent = n ? n.toLocaleString() : '';
  });
}

// ---------- geometry ----------

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
function meters(a, b) {
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
  const y = rad(b[0] - a[0]);
  return Math.hypot(x, y) * 6_371_000;
}
function bearing(a, b) {
  const p1 = rad(a[0]), p2 = rad(b[0]), dl = rad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function move(p, brg, m) {
  const d = m / 6_371_000, t = rad(brg), p1 = rad(p[0]), l1 = rad(p[1]);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

// ---------- demo: simulated ships on the main sea lanes ----------

const LANES = [
  [['Ushant', 'Elbe'], [[48.9, -6.2], [49.9, -3.0], [50.5, 0.2], [51.05, 1.6], [51.6, 2.6], [52.4, 3.6], [53.5, 5.0], [54.0, 7.4], [53.95, 8.4]]],
  [['Dover', 'Rotterdam'], [[51.05, 1.6], [51.5, 2.9], [51.98, 3.95]]],
  [['Skagen', 'Helsinki'], [[57.95, 10.75], [57.3, 11.4], [56.3, 12.3], [55.95, 12.7], [55.4, 12.95], [55.2, 14.2], [55.6, 16.0], [57.0, 19.0], [59.0, 21.0], [59.6, 23.5], [59.95, 24.9]]],
  [['Rotterdam', 'Skagen'], [[51.98, 3.95], [53.6, 4.4], [56.0, 6.3], [57.6, 8.6], [57.95, 10.75]]],
  [['Ushant', 'New York'], [[48.9, -6.2], [47.0, -25.0], [43.0, -50.0], [40.6, -67.0], [40.45, -73.85]]],
  [['Ushant', 'Gibraltar'], [[48.9, -6.2], [45.0, -9.7], [43.2, -9.9], [37.0, -9.4], [36.2, -7.0], [35.95, -5.6], [36.05, -5.3]]],
  [['Gibraltar', 'Port Said'], [[36.05, -5.3], [36.3, -2.0], [37.6, 1.0], [37.75, 8.2], [37.35, 11.3], [36.35, 13.2], [35.6, 16.0], [34.2, 22.0], [32.6, 28.0], [31.45, 32.3]]],
  [['Marseille', 'Messina'], [[43.25, 5.3], [42.0, 6.6], [39.8, 8.0], [38.6, 8.05], [38.4, 9.5], [38.5, 13.5], [38.3, 15.3], [37.9, 15.45], [37.4, 15.35], [36.3, 16.2], [35.6, 16.0]]],
  [['Genoa', 'Palermo'], [[44.35, 8.9], [43.4, 9.55], [42.9, 9.85], [40.6, 12.0], [38.25, 13.4]]],
  [['Naples', 'Palermo'], [[40.75, 14.2], [40.2, 13.9], [38.25, 13.4]]],
  [['Piraeus', 'Odesa'], [[37.9, 23.55], [37.6, 24.3], [38.6, 24.8], [39.6, 25.8], [40.05, 26.2], [40.45, 26.75], [40.85, 28.4], [41.05, 29.0], [41.25, 29.15], [42.8, 29.9], [46.35, 30.85]]],
  [['Port Said', 'Bab-el-Mandeb'], [[31.45, 32.3], [31.2, 32.35], [30.1, 32.55], [29.6, 32.6], [28.0, 33.6], [24.0, 36.2], [20.0, 38.6], [15.0, 41.6], [12.6, 43.35], [12.0, 45.5]]],
  [['Bab-el-Mandeb', 'Singapore'], [[12.0, 45.5], [12.6, 50.5], [10.0, 60.0], [7.0, 72.0], [5.6, 80.5], [5.9, 90.0], [5.95, 95.4], [5.2, 97.8], [3.2, 100.4], [2.0, 102.2], [1.18, 103.6], [1.22, 103.85]]],
  [['Arabian Sea', 'Ras Tanura'], [[10.0, 60.0], [18.0, 60.0], [22.4, 60.5], [25.4, 57.4], [26.45, 56.5], [26.2, 54.8], [26.9, 51.8], [26.75, 50.3]]],
  [['Arabian Sea', 'Mumbai'], [[10.0, 60.0], [16.0, 68.0], [18.9, 72.65]]],
  [['Singapore', 'Hong Kong'], [[1.22, 103.85], [1.35, 104.4], [4.5, 106.5], [10.0, 110.0], [16.0, 113.3], [21.5, 114.4], [22.15, 114.2]]],
  [['Hong Kong', 'Busan'], [[22.15, 114.2], [23.0, 117.2], [24.6, 119.6], [27.5, 121.8], [30.7, 123.0], [33.0, 126.4], [34.6, 129.0], [35.05, 129.1]]],
  [['Shanghai', 'Tokyo'], [[30.9, 122.6], [31.5, 125.0], [32.5, 128.5], [31.0, 131.5], [33.4, 136.5], [34.6, 139.7], [35.2, 139.8]]],
  [['Singapore', 'Jakarta'], [[1.22, 103.85], [0.2, 104.8], [-2.0, 106.6], [-3.5, 107.6], [-5.6, 106.9], [-6.05, 106.85]]],
  [['Sydney', 'Melbourne'], [[-33.85, 151.35], [-36.0, 150.6], [-37.7, 150.3], [-39.2, 147.5], [-38.5, 145.0], [-38.2, 144.7]]],
  [['Ushant', 'Cape Town'], [[45.0, -9.7], [36.0, -11.5], [30.5, -12.5], [21.0, -18.3], [12.0, -18.5], [4.0, -10.0], [-5.0, 5.0], [-20.0, 10.0], [-33.9, 18.1]]],
  [['Cape Town', 'Durban'], [[-33.9, 18.1], [-34.9, 19.0], [-35.1, 21.5], [-34.1, 26.0], [-31.5, 30.4], [-29.95, 31.15]]],
  [['Santos', 'Rio'], [[-24.05, -46.3], [-24.4, -45.0], [-23.3, -43.6], [-23.0, -43.15]]],
  [['New York', 'Houston'], [[40.45, -73.85], [39.0, -73.3], [36.8, -75.2], [33.5, -77.4], [30.0, -79.8], [26.5, -79.85], [24.3, -81.0], [24.3, -82.4], [26.0, -85.0], [28.6, -90.0], [29.25, -94.6]]],
  [['Windward Passage', 'Panama'], [[30.0, -79.8], [27.0, -76.0], [23.5, -74.0], [20.1, -73.8], [17.5, -75.0], [11.5, -78.0], [9.45, -79.9]]],
  [['Panama', 'Callao'], [[8.8, -79.5], [7.0, -79.8], [3.0, -81.0], [-4.0, -81.6], [-12.05, -77.2]]],
  [['Los Angeles', 'Vancouver'], [[33.65, -118.25], [34.2, -119.9], [34.4, -121.0], [36.5, -122.3], [37.75, -122.75], [42.0, -125.0], [48.35, -124.9], [48.3, -123.6], [49.25, -123.3]]],
];
const PORTS = [[51.98, 3.85, 'Rotterdam'], [1.2, 103.9, 'Singapore'], [25.15, 56.5, 'Fujairah'], [29.15, -94.5, 'Houston'], [40.45, -73.95, 'New York'],
  [33.6, -118.15, 'Los Angeles'], [36.1, -5.38, 'Gibraltar'], [31.4, 32.45, 'Port Said'], [22.2, 114.25, 'Hong Kong'], [-24.1, -46.25, 'Santos'],
  [-29.95, 31.2, 'Durban'], [35.0, 129.15, 'Busan'], [37.85, 23.5, 'Piraeus'], [37.2, 15.3, 'Augusta'], [53.95, 8.3, 'Cuxhaven'], [30.8, 122.75, 'Shanghai']];
const NAMES = ['NORDIC STAR', 'MAERSK HALDEN', 'CMA CGM RIVOLI', 'MSC GIULIA', 'EVER LUCENT', 'OCEAN PEARL', 'ATLANTIC SPIRIT', 'STENA NAVIGATOR', 'BALTIC TRADER',
  'SEA HARMONY', 'PACIFIC DAWN', 'AURORA BOREALIS', 'CAPE MERIDIAN', 'GOLDEN HORIZON', 'BLUE MARLIN', 'IONIAN SKY', 'NAVIGATOR ARIES', 'ARCTIC FOX', 'SILVER WAVE',
  'POLAR EXPLORER', 'AEGEAN BREEZE', 'CORAL SEA', 'MISTRAL', 'SIROCCO', 'TRAMONTANA', 'LIBECCIO', 'VALLETTA EXPRESS', 'ETNA', 'STROMBOLI', 'TAORMINA',
  'GRAND CASABLANCA', 'NORTHERN LIGHT', 'KOTA HARUM', 'YANG MING UNITY', 'ONE COMPETENCE', 'HMM OSLO', 'COSCO PRIDE', 'HAPAG ESSEN', 'SEASPAN ZEUS', 'ZIM CHICAGO',
  'TORM HELENE', 'FRONT ALTAIR', 'EAGLE TACOMA', 'MINERVA LISA', 'SONANGOL KIZOMBA', 'ADVANTAGE SUN', 'GAS ENTERPRISE', 'LNG ABUJA', 'MOANA CHIEF', 'ISLAND PRINCESS'];
const FLAGS = ['351', '636', '538', '248', '563', '477', '241', '413', '257', '247', '211', '244', '232', '227', '366', '219', '309', '229', '273', '431'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const laneData = LANES.map(([ends, pts]) => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + meters(pts[i - 1], pts[i]));
  return { ends, pts, cum, len: cum[cum.length - 1] };
});
const totalLen = laneData.reduce((s, l) => s + l.len, 0);
function lanePoint(l, d) {
  d = Math.max(0, Math.min(l.len, d));
  let i = 1;
  while (i < l.cum.length - 1 && l.cum[i] < d) i++;
  const a = l.pts[i - 1], b = l.pts[i];
  const brg = bearing(a, b);
  return { p: move(a, brg, d - l.cum[i - 1]), brg };
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
  const L = c === 'cargo' ? rnd(140, 400) : c === 'tanker' ? rnd(120, 330) : c === 'passenger' ? rnd(90, 300) : c === 'special' ? rnd(22, 40)
    : c === 'fishing' ? rnd(15, 45) : c === 'pleasure' ? rnd(9, 30) : rnd(30, 120);
  const B = L / rnd(5.5, 7.5), a = L * rnd(0.7, 0.85);
  return [Math.round(a), Math.round(L - a), Math.round(B / 2), Math.round(B / 2)];
}
const demo = [];
let demoMmsi = 0;
function demoShip(kind) {
  const type = demoType();
  const cat = catOf(type);
  const mmsi = +(pick(FLAGS) + String(100000 + demoMmsi++ * 7 + Math.floor(Math.random() * 7)).padStart(6, '0'));
  const sog = cat === 'passenger' ? rnd(15, 22) : cat === 'highspeed' ? rnd(25, 34) : cat === 'tanker' ? rnd(10, 14) : cat === 'fishing' ? rnd(2, 8)
    : cat === 'pleasure' ? rnd(4, 9) : cat === 'special' ? rnd(6, 11) : rnd(12, 18);
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const d = { mmsi, type, sog, dim: demoDims(type), name: Math.random() < 0.94 ? pick(NAMES) + (Math.random() < 0.4 ? ` ${Math.ceil(Math.random() * 9)}` : '') : null,
    cs: `${letter()}${letter()}${Math.floor(rnd(1000, 9999))}`, imo: cat === 'pleasure' || cat === 'fishing' ? null : Math.floor(rnd(9_100_000, 9_999_999)) };
  if (kind === 'anchor') {
    const [lat, lon, port] = pick(PORTS);
    Object.assign(d, { anchor: [lat + rnd(-0.04, 0.04), lon + rnd(-0.05, 0.05)], dest: port.toUpperCase(), nav: Math.random() < 0.7 ? 1 : 5, sog: rnd(0, 0.3), hdg: rnd(0, 360) });
  } else {
    let r = Math.random() * totalLen, l = laneData[0];
    for (const x of laneData) { if ((r -= x.len) <= 0) { l = x; break; } }
    Object.assign(d, { lane: l, dir: Math.random() < 0.5 ? 1 : -1, at: rnd(0, l.len), off: rnd(-2500, 2500), nav: cat === 'fishing' ? 7 : type === 36 ? 8 : 0 });
    d.dest = (d.dir > 0 ? l.ends[1] : l.ends[0]).toUpperCase();
  }
  const etaD = new Date(Date.now() + rnd(6, 240) * 3_600_000);
  d.eta = [etaD.getUTCMonth() + 1, etaD.getUTCDate(), etaD.getUTCHours(), Math.floor(etaD.getUTCMinutes() / 15) * 15];
  return d;
}
function demoPos(d, at = d.at) {
  if (d.anchor) return { lat: d.anchor[0], lon: d.anchor[1], cog: null };
  const q = lanePoint(d.lane, at);
  const [lat, lon] = move(q.p, (q.brg + 90) % 360, d.off * d.dir);
  return { lat, lon, cog: d.dir > 0 ? q.brg : (q.brg + 180) % 360 };
}
function demoTick(dtS) {
  const now = Date.now();
  for (const d of demo) {
    if (!d.anchor) {
      d.at += d.dir * d.sog * (NM / 3600) * dtS;
      if (d.at < 0 || d.at > d.lane.len) {
        d.dir = -d.dir;
        d.at = Math.max(0, Math.min(d.lane.len, d.at));
        d.dest = (d.dir > 0 ? d.lane.ends[1] : d.lane.ends[0]).toUpperCase();
      }
    }
    const p = demoPos(d);
    const e = entry(d.mmsi);
    setPos(e, p.lat, p.lon, d.sog, p.cog, p.cog != null ? (p.cog + rnd(-2, 2) + 360) % 360 : d.hdg, now);
    Object.assign(e, { name: d.name, cs: d.cs, imo: d.imo, dim: d.dim, dest: d.dest, eta: d.eta, nav: d.nav,
      draught: Math.round((d.dim[0] + d.dim[1]) / 25) / 2 + 2, cls: catOf(d.type) === 'pleasure' ? 'B' : 'A' });
    setType(e, d.type);
  }
}
// Demo ships get the last two hours of their lane as a track.
function seedTrail(e) {
  const d = demo.find((x) => x.mmsi === e.mmsi);
  if (!d || d.anchor || e.trail.length > 3) return;
  const pts = [];
  for (let k = 40; k > 0; k--) {
    const at = d.at - d.dir * d.sog * (NM / 3600) * k * 180;
    if (at < 0 || at > d.lane.len) continue;
    const p = demoPos(d, at);
    pts.push([p.lat, p.lon, Date.now() - k * 180_000]);
  }
  e.trail = pts.concat(e.trail);
}
function startDemo(why) {
  state.mode = 'demo';
  state.ships.clear();
  state.statics.clear();
  for (let i = 0; i < 520; i++) demo.push(demoShip('lane'));
  for (let i = 0; i < 150; i++) demo.push(demoShip('anchor'));
  demoTick(0);
  setInterval(() => demoTick(1), 1000);
  setStatus(`Demo data · ${why}`, 'demo');
}

// ---------- first view: the visitor's country ----------

// [west, south, east, north] of the coasts most visitors will want to see first.
const COUNTRY_BOUNDS = {
  BE: [2.0, 50.8, 4.6, 51.8], DE: [5.5, 53.2, 14.5, 55.1], DK: [8.0, 54.5, 12.7, 57.8], EE: [21.8, 57.5, 28.2, 59.7],
  ES: [-9.4, 36.0, 3.3, 43.8], FI: [20.5, 59.6, 27.5, 63.0], FR: [-5.2, 42.3, 8.3, 51.1], GB: [-8.2, 49.9, 1.8, 58.7],
  GR: [19.4, 34.8, 28.3, 41.8], HR: [13.5, 42.4, 18.5, 45.7], IE: [-10.5, 51.4, -6.0, 55.4], IT: [6.6, 36.6, 18.5, 45.8],
  NL: [3.3, 51.3, 7.2, 53.6], NO: [4.6, 57.9, 12.0, 63.5], PL: [14.1, 53.8, 19.8, 55.0], PT: [-9.8, 36.9, -7.0, 42.2],
  SE: [11.0, 55.3, 19.5, 60.0], TR: [26.0, 36.0, 32.0, 41.5], US: [-80.0, 37.5, -70.0, 42.5], CA: [-70.0, 43.0, -59.0, 48.0],
  SG: [103.4, 1.0, 104.3, 1.5], JP: [134.0, 33.0, 141.0, 36.0], CN: [119.5, 29.5, 123.5, 32.5], AU: [150.0, -35.0, 153.5, -32.5],
  MA: [-7.5, 33.0, -5.0, 36.0], TN: [9.5, 35.0, 11.5, 37.5], MT: [13.9, 35.7, 14.7, 36.2], CY: [32.0, 34.4, 34.7, 35.8],
};

// Cloudflare knows the visitor's country from their connection (no location
// prompt). Zoom to it unless the visitor has already moved the map or has a saved view.
async function startOnVisitorCountry() {
  if (saved) return;
  let where;
  try {
    const res = await fetch('/api/where');
    if (!res.ok) return;
    where = await res.json();
  } catch {
    return;
  }
  if (moved) return;
  const bounds = COUNTRY_BOUNDS[where.country];
  if (bounds) map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 24, maxZoom: 8, duration: 0 });
}

let moved = false;
map.once('dragstart', () => { moved = true; });
map.once('zoomstart', (e) => { if (e.originalEvent) moved = true; });

// iPhone ignores the viewport's no-zoom setting in places; stop page pinch and
// double-tap zoom outside the map (the map handles its own gestures).
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => {
  if (!e.target.closest('#map')) e.preventDefault();
}, { passive: false });

// ---------- start ----------

buildChips();
applyTheme();
setInterval(draw, 1000);
(async () => {
  let health = null;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) health = await res.json();
  } catch { /* not on Cloudflare */ }
  if (health?.live) {
    state.mode = 'live';
    loadShips();
    const go = () => { connect(); pollExtra(); };
    if (map.loaded()) go(); else map.once('load', go);
  } else {
    startDemo(health ? 'add your aisstream.io key on Cloudflare for real ships' : 'deploy to Cloudflare for real ships');
  }
  draw();
})();
startOnVisitorCountry();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- about, terms, privacy, contact ----------

const menuBtn = $('#menu-btn'), menu = $('#menu');
const showMenu = (on) => { menu.hidden = !on; menuBtn.setAttribute('aria-expanded', String(on)); };
menuBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showMenu(menu.hidden); });
document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-wrap')) showMenu(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') showMenu(false); });
for (const b of menu.querySelectorAll('[data-info]')) {
  b.addEventListener('click', () => { showMenu(false); $(`#info-${b.dataset.info}`).showModal(); });
}
// A click on the dark backdrop closes the window too.
for (const d of document.querySelectorAll('dialog.info')) d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });

// ---------- live webcams on the coast ----------

const camBox = $('#cam');
function openCam(c) {
  $('#cam-name').textContent = c.name;
  $('#cam-about').textContent = c.about || '';
  const link = $('#cam-link'), still = $('#cam-still'), frame = $('#cam-frame');
  link.href = c.youtube ? `https://www.youtube.com/watch?v=${c.youtube}` : c.page;
  link.textContent = `${c.youtube ? 'Open on YouTube' : c.image ? `Watch live on ${c.site}` : `Open on ${c.site}`} ↗`;
  $('#cam-kind').textContent = c.image ? 'Latest' : 'Live';
  // Some webcam sites refuse to play inside other pages; those show their latest picture instead.
  still.hidden = !c.image;
  frame.hidden = !!c.image;
  if (c.image) {
    still.href = c.page;
    still.firstChild.src = `${c.image}?t=${Date.now()}`;
    still.firstChild.alt = `Latest picture from the ${c.name} webcam`;
    frame.src = 'about:blank';
  } else {
    // Muted so browsers allow it to start on its own; the player's own button turns the sound on.
    frame.src = c.youtube ? `https://www.youtube-nocookie.com/embed/${c.youtube}?autoplay=1&mute=1&playsinline=1&rel=0` : c.embed;
  }
  camBox.hidden = false;
}
function closeCam() {
  camBox.hidden = true;
  $('#cam-frame').src = 'about:blank'; // stops the video and its download
}
$('#cam-close').addEventListener('click', closeCam);
// Camera spots show once the nautical scale bar reads 5 nm or less, so they don't crowd the
// coast when zoomed out.
function showCams() {
  const lat = map.getCenter().lat * Math.PI / 180;
  const metresPerPx = 40075016.7 * Math.cos(lat) / (512 * 2 ** map.getZoom());
  map.getContainer().classList.toggle('cams-far', metresPerPx * 120 >= 10 * 1852);
}
map.on('zoom', showCams);
fetchJson('data/webcams.json').then((cams) => {
  for (const c of cams) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cam-marker';
    el.title = `Live webcam: ${c.name}`;
    el.setAttribute('aria-label', `Live webcam: ${c.name}`);
    el.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3z"/></svg>';
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openCam(c); });
    new maplibregl.Marker({ element: el }).setLngLat([c.lon, c.lat]).addTo(map);
    el.setAttribute('aria-label', `Live webcam: ${c.name}`); // the marker replaces it with "Map marker"
  }
  showCams();
}).catch(() => { /* no webcams, the map works without them */ });

