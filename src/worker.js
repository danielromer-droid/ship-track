// Ship Track Worker: serves the map page (./public) and the /api/* endpoints.
//
// GET /api/stream            WebSocket. The page sends {"boxes": [[[s, w], [n, e]], ...]} whenever the view
//                            changes; the Worker adds the aisstream.io key, subscribes for that area and relays
//                            every AIS message back untouched, so it spends almost no CPU per message.
// GET /api/health            { ok, live }: live is false until the AISSTREAM_API_KEY secret is set.
// GET /api/health?check=1    also opens a test connection to aisstream.io and says what happened.
// GET /api/search?q=genoa    ports and places matching a name (Photon / OpenStreetMap), to fly the map there.
// GET /api/where             the visitor's country, to open the map there.
// GET /api/extra?box=s,w,n,e ships from extra open feeds (Finland's Digitraffic, Baltic Sea) in that area,
//                            as aisstream.io-shaped messages so the page handles them the same way.
// GET /api/photo?imo=9811000&name=EVER%20GIVEN   a photo of the ship, with the photographer's credit when needed.
// GET /api/ship?imo=9811000  { mmsi, name, ships } of a ship known by its IMO number, to look for it worldwide.
// GET /api/ship?mmsi=235009590,209479000   { ships: [{ mmsi, name, imo, flag, callsign, kind, lengthM }] }, up to 40,
//                            to name and colour ships whose own name and type messages have not been heard (registry only).
// GET /api/ship?name=OSCAR%20WILDE   { ships: [{ mmsi, name, imo, flag }] } with that name.
//                            Global Fishing Watch's vessel identity registry when GFW_TOKEN is set, else Wikidata (IMO only).
//
// /api/stream also takes {"boxes": [...], "mmsi": [235000000]}: only those ships, used to find one anywhere.

const UPSTREAM = 'https://stream.aisstream.io/v0/stream';
const AIS_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/stream') return stream(request, env, ctx);
      if (url.pathname === '/api/health') return await health(url, env);
      if (url.pathname === '/api/search') return await search(url, ctx);
      if (url.pathname === '/api/where') return where(request);
      if (url.pathname === '/api/ship') return shipLookup(url, env);
      if (url.pathname === '/api/extra') return await extra(url, ctx);
      if (url.pathname === '/api/photo') return await photo(url, ctx);
      if (url.pathname === '/api/sailings') return await sailings(env);
      if (url.pathname === '/api/depth') return await depth(url);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

const keyOf = (env) => (env.AISSTREAM_API_KEY || '').trim();

// ---------- live AIS relay ----------

function stream(request, env, ctx) {
  const key = keyOf(env);
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return json({ error: 'connect with a WebSocket', live: Boolean(key) }, 426);
  }
  if (!key) return json({ error: 'AISSTREAM_API_KEY is not set' }, 503);

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let up = null, pending = null, connecting = false, closed = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason); } catch { /* already closed */ }
    try { up?.close(1000, 'viewer left'); } catch { /* already closed */ }
  };
  const tell = (msg) => { try { server.send(JSON.stringify(msg)); } catch { /* viewer gone */ } };

  async function connect() {
    connecting = true;
    let ws;
    try {
      // aisstream.io wants the subscription within 3 s of connecting, so connect only once one is ready.
      const res = await fetch(env.AISSTREAM_URL || UPSTREAM, { headers: { Upgrade: 'websocket' } });
      ws = res.webSocket;
      if (!ws) throw new Error(`upstream answered ${res.status}`);
    } catch (err) {
      tell({ error: `AIS feed unreachable: ${err.message}` });
      return close(1011, 'upstream unreachable');
    }
    if (closed) return;
    ws.accept();
    up = ws;
    ws.binaryType = 'arraybuffer'; // newer runtimes hand binary frames over as Blobs, which send() would stringify
    ws.send(pending);
    ws.addEventListener('message', async (ev) => {
      try { server.send(typeof ev.data === 'string' || ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer()); } catch { close(1011, 'viewer gone'); }
    });
    ws.addEventListener('close', (ev) => {
      tell({ error: `aisstream.io closed the feed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})` });
      close(1011, 'upstream closed');
    });
    ws.addEventListener('error', () => close(1011, 'upstream error'));
  }

  server.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; } // the page sends text
    const boxes = cleanBoxes(m?.boxes);
    if (!boxes) return;
    const mmsi = Array.isArray(m.mmsi) ? m.mmsi.map(String).filter((v) => /^\d{9}$/.test(v)).slice(0, 50) : [];
    pending = JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: AIS_TYPES, ...(mmsi.length ? { FiltersShipMMSI: mmsi } : {}) });
    if (up) {
      try { up.send(pending); } catch { close(1011, 'upstream gone'); }
    } else if (!connecting) {
      ctx.waitUntil(connect());
    }
  });
  server.addEventListener('close', () => close(1000, 'bye'));
  server.addEventListener('error', () => close(1011, 'viewer error'));

  return new Response(null, { status: 101, webSocket: client });
}

// At most 4 boxes of [[south, west], [north, east]], rounded, so the key serves map views only.
function cleanBoxes(boxes) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const out = [];
  for (const b of boxes.slice(0, 4)) {
    if (!Array.isArray(b) || b.length !== 2) return null;
    const p = b.map((c) => (Array.isArray(c) ? [clamp(+c[0], -90, 90), clamp(+c[1], -180, 180)] : null));
    if (p.some((c) => !c || c.some(Number.isNaN))) return null;
    out.push(p.map((c) => c.map((v) => Math.round(v * 100) / 100)));
  }
  return out;
}

// ---------- a ship's MMSI from its IMO number ----------

const GFW = 'https://gateway.api.globalfishingwatch.org/v3/vessels/search';
// The secret is GFW_TOKEN; "GFW-TOKEN" is accepted too, as Cloudflare allows both spellings.
const gfwToken = (env) => String(env.GFW_TOKEN || env['GFW-TOKEN'] || env.GFW_API_TOKEN || '').trim() || null;

async function shipLookup(url, env) {
  const token = gfwToken(env);
  const imo = url.searchParams.get('imo') || '';
  const name = (url.searchParams.get('name') || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!token) return name || url.searchParams.has('mmsi') ? json({ ships: [], source: null }) : shipByImo(url);
  if (url.searchParams.has('mmsi')) return shipsByMmsi(url, token);
  if (imo && !/^\d{7}$/.test(imo)) return json({ error: 'imo must be 7 digits' }, 400);
  if (!imo && name.length < 3) return json({ error: 'give an imo number or a name' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ship-track/ship/gfw1?imo=${imo}&name=${encodeURIComponent(name)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const q = new URLSearchParams({ 'datasets[0]': 'public-global-vessel-identity:latest', limit: '20',
    ...(imo ? { where: `imo = '${imo}'` } : { query: name }) });
  const r = await fetch(`${GFW}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    if (imo) return shipByImo(url); // registry down or token refused: the old lookup still answers
    return json({ ships: [], error: `ship registry answered ${r.status}` });
  }
  // One row per MMSI, from what ships broadcast (and registries), newest transmission first.
  const seen = new Map();
  for (const entry of (await r.json()).entries || []) {
    for (const v of [...(entry.selfReportedInfo || []), ...(entry.registryInfo || [])]) {
      const mmsi = /^\d{9}$/.test(v.ssvid || '') ? +v.ssvid : null;
      if (!mmsi) continue;
      const row = { mmsi, name: v.shipname || null, imo: /^\d{7}$/.test(v.imo || '') ? +v.imo : null, flag: v.flag || null,
        last: v.transmissionDateTo || null };
      const old = seen.get(mmsi);
      if (!old || (row.last && (!old.last || row.last > old.last))) seen.set(mmsi, { ...old, ...Object.fromEntries(Object.entries(row).filter(([, x]) => x != null)) });
    }
  }
  let ships = [...seen.values()].sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  if (name) ships = ships.filter((v) => (v.name || '').toUpperCase().includes(name)).slice(0, 10);
  const res = json(imo ? { imo: +imo, mmsi: ships[0]?.mmsi || null, name: ships[0]?.name || null, ships, source: 'gfw' } : { ships, source: 'gfw' });
  res.headers.set('Cache-Control', `public, max-age=${ships.length ? 86_400 : 3600}`);
  await cache.put(cacheKey, res.clone());
  return res;
}

// Registry identity of up to 40 ships at once. Each ship is cached on its own for a week, so busy areas cost few calls.
const KINDS = [[/PASSENGER|FERRY|CRUISE/, 'passenger'], [/TANKER|BUNKER/, 'tanker'], [/FISH|TRAWL|LONGLINE|SEINE|SQUID|POT|GILL|TROLL/, 'fishing'],
  [/CARGO|CARRIER|CONTAINER|BULK|REEFER/, 'cargo'], [/TUG|SUPPORT|PILOT|DREDG|SEISMIC|RESEARCH|PATROL/, 'service'], [/PLEASURE|YACHT|SAIL/, 'pleasure']];
async function shipsByMmsi(url, token) {
  const want = [...new Set((url.searchParams.get('mmsi') || '').split(',').filter((v) => /^\d{9}$/.test(v)))].slice(0, 40);
  if (!want.length) return json({ error: 'give up to 40 MMSIs, comma separated' }, 400);
  const cache = caches.default;
  const key = (m) => new Request(`https://cache.ship-track/ship/mmsi/v1/${m}`);
  const ships = [], missing = [];
  await Promise.all(want.map(async (m) => {
    const hit = await cache.match(key(m));
    if (!hit) { missing.push(m); return; }
    const v = await hit.json();
    if (v.mmsi) ships.push(v);
  }));
  if (missing.length) {
    const q = new URLSearchParams({ 'datasets[0]': 'public-global-vessel-identity:latest', limit: '50',
      where: missing.map((m) => `ssvid = '${m}'`).join(' OR ') });
    const r = await fetch(`${GFW}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return json({ ships, error: `ship registry answered ${r.status}` });
    const found = new Map();
    for (const entry of (await r.json()).entries || []) {
      const self = (entry.selfReportedInfo || []).filter((v) => missing.includes(v.ssvid))
        .sort((a, b) => String(b.transmissionDateTo).localeCompare(String(a.transmissionDateTo)))[0];
      const reg = (entry.registryInfo || []).find((v) => missing.includes(v.ssvid));
      const m = self?.ssvid || reg?.ssvid;
      if (!m || found.has(m)) continue;
      const c = entry.combinedSourcesInfo?.[0] || {};
      const types = [...(c.shiptypes || []).map((t) => t.name), ...(reg?.geartypes || [])].join(' ');
      found.set(m, { mmsi: +m, name: self?.shipname || reg?.shipname || null, imo: +(self?.imo || reg?.imo) || null,
        flag: self?.flag || reg?.flag || null, callsign: self?.callsign || reg?.callsign || null,
        kind: KINDS.find(([re]) => re.test(types))?.[1] || null, lengthM: Math.round(c.bestLengthM?.[0]?.value || reg?.lengthM || 0) || null });
    }
    for (const m of missing) {
      const v = found.get(m) || { mmsi: null };
      if (v.mmsi) ships.push(v);
      // Unknown ships are asked again after a day, known ones after a week.
      await cache.put(key(m), json(v, 200, { 'Cache-Control': `public, max-age=${v.mmsi ? 7 * 86_400 : 86_400}` }));
    }
  }
  return json({ ships, source: 'gfw' });
}

async function shipByImo(url) {
  const imo = url.searchParams.get('imo') || '';
  if (!/^\d{7}$/.test(imo)) return json({ error: 'imo must be 7 digits' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ship-track/ship/v1?imo=${imo}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const sparql = `SELECT ?mmsi ?name WHERE { ?s wdt:P458 "${imo}". OPTIONAL { ?s wdt:P587 ?mmsi }
    OPTIONAL { ?s rdfs:label ?name FILTER(LANG(?name) = "en") } } LIMIT 1`;
  const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
    { headers: { 'User-Agent': WIKI_UA, Accept: 'application/sparql-results+json' } });
  if (!r.ok) return json({ error: `ship lookup answered ${r.status}` }, 502);
  const row = (await r.json()).results?.bindings?.[0] || {};
  const mmsi = /^\d{9}$/.test(row.mmsi?.value || '') ? +row.mmsi.value : null;
  const res = json({ imo: +imo, mmsi, name: row.name?.value || null });
  res.headers.set('Cache-Control', `public, max-age=${mmsi ? 86_400 : 3600}`);
  await cache.put(cacheKey, res.clone());
  return res;
}

// ---------- health check ----------

async function health(url, env) {
  const key = keyOf(env);
  const out = { ok: true, live: Boolean(key) };
  if (!key || !url.searchParams.has('check')) return json(out, 200, { 'Cache-Control': 'no-store' });
  out.keyLength = key.length;
  out.check = await probe(env.AISSTREAM_URL || UPSTREAM, key);
  // Ship registry: which secret names look like it (names only, never values) and whether it answers.
  out.gfw = { names: Object.keys(env).filter((k) => /gfw/i.test(k)), set: Boolean(gfwToken(env)) };
  if (out.gfw.set) {
    const r = await fetch(`${GFW}?datasets[0]=public-global-vessel-identity:latest&limit=1&query=EVER%20GIVEN`,
      { headers: { Authorization: `Bearer ${gfwToken(env)}` } }).catch((err) => ({ status: err.message }));
    out.gfw.status = r.status;
  }
  return json(out, 200, { 'Cache-Control': 'no-store' });
}

async function probe(target, key) {
  let ws;
  try {
    const res = await fetch(target, { headers: { Upgrade: 'websocket' } });
    ws = res.webSocket;
    if (!ws) return { result: 'failed', detail: `aisstream.io answered HTTP ${res.status} instead of opening a WebSocket` };
  } catch (err) {
    return { result: 'failed', detail: `could not reach aisstream.io: ${err.message}` };
  }
  ws.accept();
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve) => {
    let timer = 0;
    const done = (v) => { clearTimeout(timer); try { ws.close(1000, 'check done'); } catch { /* closed */ } resolve(v); };
    timer = setTimeout(() => done({ result: 'connected, but no ship message within 10 s' }), 10_000);
    ws.addEventListener('message', async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : await ev.data.text();
      let m = null;
      try { m = JSON.parse(text); } catch { /* not JSON */ }
      if (m?.error) done({ result: 'rejected', detail: m.error });
      else if (m?.MessageType === 'SubscriptionConfirmation') return; // key accepted; wait for a ship
      else done({ result: 'working', firstMessage: m ? m.MessageType : text.slice(0, 80) });
    });
    ws.addEventListener('close', (ev) => done({ result: 'closed', detail: `code ${ev.code} ${ev.reason || ''}`.trim() }));
    // The English Channel is always busy, so a working feed answers within a second or two.
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[49.5, -2], [51.5, 2.5]]], FilterMessageTypes: AIS_TYPES }));
  });
}

// ---------- place search ----------

async function search(url, ctx) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json({ places: [] });
  const upstream = `https://photon.komoot.io/api/?limit=6&lang=en&q=${encodeURIComponent(q)}`;
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ship-track/search?q=${encodeURIComponent(q.toLowerCase())}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = await fetch(upstream, { headers: { 'User-Agent': 'ship-track (Cloudflare Worker)' } });
  if (!res.ok) return json({ error: `search answered ${res.status}` }, 502);
  const data = await res.json();
  const places = (data.features || []).map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    const port = /harbour|port|marina|ferry|pier|dock/i.test(`${p.osm_value} ${p.osm_key} ${p.name}`);
    return { name: p.name, detail: [p.city !== p.name ? p.city : null, p.country].filter(Boolean).join(', '), cc: p.countrycode || null, lat, lon, port,
      extent: p.extent || null };
  }).filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const out = json({ places }, 200, { 'Cache-Control': 'public, max-age=86400' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// ---------- ship photos ----------
// Photos come from the free media library behind Wikipedia, which files ships by IMO number
// ("Category:IMO 9811000"); Wikidata also links many IMO numbers to a photo. Only real outside
// views of ships are kept, and only public-domain or Creative Commons BY / BY-SA ones: the
// latter need the photographer and licence named, which the page shows as plain text.
// Answers, found or not, are cached for a week.

const WIKI_UA = 'ship-track/1.0 (https://github.com/danielromer-droid/ship-track)';
const COMMONS = 'https://commons.wikimedia.org/w/api.php?format=json&formatversion=2&origin=*';
const IMAGE_INFO = '&prop=imageinfo|categories&clshow=!hidden&cllimit=max'
  + '&iiprop=url|mime|size|extmetadata&iiurlwidth=800&iiextmetadatafilter=Artist|LicenseShortName';
const SHIP_CATEGORY = /\bIMO \d{7}\b|ship|vessel|ferr(y|ies)|tanker|carrier|boat|tug|yacht|trawler|dredger|cruise|freighter|barge|liner|coaster|reefer|ro-ro|container|navy|naval/i;
const NOT_OUTSIDE_VIEW = /interior|inside|cabin|wheelhouse|engine|lounge|restaurant|plan\b|plans\b|map|logo|emblem|crest|badge|flag|crew|captain|menu|ticket|model|drawing|diagram|poster|stamp|coin|postcard|sign\b|plaque|bell|propeller|anchor|funnel|figurehead|lifeboat|corridor|stair|atrium|theat(er|re)|pool|spa\b|casino|suite|stateroom|toilet|kitchen|galley|ceremony|christening|portrait|people|museum|screenshot|document/i;
const NOT_OUTSIDE_CATEGORY = /interior|engine room|wheelhouse|ship bridges|bridges of ships|deck plan|cabins|crew|ship models|models of|drawings|diagrams|logos|maps\b|people/i;
const FREE = /^(public domain|pd\b|cc0)/i;
const CREDITED = /^cc[- ]by(-sa)?[- ]\d/i;

async function photo(url, ctx) {
  const imo = (url.searchParams.get('imo') || '').trim();
  const name = (url.searchParams.get('name') || '').toUpperCase().replace(/[^A-Z0-9 .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (imo && !/^\d{7}$/.test(imo)) return json({ error: 'imo must be 7 digits' }, 400);
  if (!imo && name.length < 5) return json({ error: 'give an imo number or a ship name' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ship-track/photo/v3?imo=${imo}&name=${encodeURIComponent(name)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const wiki = (u) => fetch(u, { headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`photo search answered ${r.status}`))));

  let match = 'imo';
  let pages = !imo ? [] : (await wiki(`${COMMONS}&action=query&generator=categorymembers&gcmtype=file&gcmlimit=20`
    + `&gcmtitle=${encodeURIComponent(`Category:IMO ${imo}`)}${IMAGE_INFO}`)).query?.pages || [];
  if (imo && !pages.some(isShipPhoto)) {
    const sparql = `SELECT ?img WHERE { ?ship wdt:P458 "${imo}"; wdt:P18 ?img } LIMIT 1`;
    const img = (await wiki(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`))
      .results?.bindings?.[0]?.img?.value;
    const file = img && decodeURIComponent(img.split('/Special:FilePath/')[1] || '');
    if (file) pages = (await wiki(`${COMMONS}&action=query&titles=${encodeURIComponent(`File:${file}`)}${IMAGE_INFO}`)).query?.pages || [];
  }
  // Most ships have no IMO category: look for photos whose file name carries the ship's name.
  if (!pages.some(isShipPhoto) && name.length >= 5) {
    match = 'name';
    const found = (await wiki(`${COMMONS}&action=query&generator=search&gsrnamespace=6&gsrlimit=20`
      + `&gsrsearch=${encodeURIComponent(`intitle:"${name}" filetype:bitmap`)}${IMAGE_INFO}`)).query?.pages || [];
    const words = new RegExp(`(^|[^A-Z0-9])${name.replace(/[.-]/g, '\\$&').replace(/ /g, '[ _-]+')}([^A-Z0-9]|$)`);
    pages = found.filter((pg) => words.test(pg.title.toUpperCase()));
  }
  const page = pages.filter(isShipPhoto)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.title.localeCompare(b.title))[0];
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  const license = meta.LicenseShortName?.value || '';
  const author = photographer(stripTags(meta.Artist?.value));
  const body = info ? {
    photo: info.thumburl || info.url,
    full: info.url,
    match,
    credit: FREE.test(license) ? null : [author, license].filter(Boolean).join(', '),
  } : { photo: null };
  const out = json(body, 200, { 'Cache-Control': 'public, max-age=604800' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// A photo of a ship seen from outside, under a licence the page can honour.
function isShipPhoto(page) {
  const info = page.imageinfo?.[0];
  if (!info || !/^image\/(jpeg|webp)$/.test(info.mime || '')) return false;
  if (info.width < 640 || info.width < info.height * 1.2) return false; // ships are photographed side on
  const license = info.extmetadata?.LicenseShortName?.value || '';
  if (!FREE.test(license) && !CREDITED.test(license)) return false;
  const cats = (page.categories || []).map((c) => c.title);
  if (!cats.some((c) => SHIP_CATEGORY.test(c))) return false;
  return !NOT_OUTSIDE_VIEW.test(page.title.replace(/^File:/, '')) && !cats.some((c) => NOT_OUTSIDE_CATEGORY.test(c));
}

// Just the photographer's name: credits often add who uploaded it, and where.
function photographer(text) {
  return text.split(/\b(?:uploaded|released|via|from (?:the )?\w*wiki|wiki\w*|commons|flickr)\b/i)[0]
    .replace(/\buser:/gi, '').replace(/^(?:work|photo|photograph)?\s*(?:from|by)\s+/i, '').replace(/^own work\b/i, '')
    .replace(/[\s,;:.(-]+$/, '').trim();
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ---------- extra open feeds ----------
// Fintraffic's Digitraffic publishes every ship its Baltic coast stations hear, free and without a
// key (CC BY 4.0). Positions are cached for 20 s and ship details for 10 min, for all visitors.

const DIGITRAFFIC = 'https://meri.digitraffic.fi/api/ais/v1';
const DIGITRAFFIC_AREA = [57, 15, 67, 34]; // s, w, n, e

async function cachedJson(ctx, url, seconds) {
  const cache = caches.default;
  const key = new Request(`https://cache.ship-track/extra?u=${encodeURIComponent(url)}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { 'Digitraffic-User': 'ship-track', 'Accept-Encoding': 'gzip' } });
  if (!res.ok) throw new Error(`Digitraffic answered ${res.status}`);
  const text = await res.text();
  ctx.waitUntil(cache.put(key, new Response(text, { headers: { 'Cache-Control': `public, max-age=${seconds}` } })));
  return JSON.parse(text);
}

// ---------- Ferry sailings by ship: P&O and Irish Ferries ----------
// Read from the schedules the operators show on their own sites, at most once an hour each, and
// returned in the shape of data/ferries.json plus the ship's name (and any delay) on each sailing.
const PO_ROUTES = [['DOCA', 'Europe/London', 'Europe/Paris'], ['CADO', 'Europe/Paris', 'Europe/London']];
const PO_PORTS = { DVR: ['Dover', 51.126, 1.329], CQF: ['Calais', 50.966, 1.864] };
const UA = 'ship-track (github.com/danielromer-droid/ship-track)';
const IF_PAGES = ['dover-calais', 'dublin-holyhead', 'rosslare-pembroke', 'ireland-france'];
const IF_PORTS = {
  Dover: [51.126, 1.329, 'Europe/London'], Calais: [50.966, 1.864, 'Europe/Paris'], Dublin: [53.347, -6.195, 'Europe/Dublin'],
  Holyhead: [53.311, -4.627, 'Europe/London'], Rosslare: [52.252, -6.334, 'Europe/Dublin'], Pembroke: [51.684, -4.949, 'Europe/London'],
  Cherbourg: [49.650, -1.617, 'Europe/Paris'], Roscoff: [48.720, -3.966, 'Europe/Paris'],
};
// Irish Ferries ships also appear in P&O's Dover–Calais schedule, which they share.
const IRISH_SHIP = /INISHMORE|OSCAR WILDE|ULYSSES|YEATS|JAMES JOYCE|INNISFREE|ISLE OF/i;

// "2026-10-25T17:20:00" in a time zone, as minutes since 1970.
function localMinutes(text, tz) {
  const guess = Date.parse(`${text}Z`);
  if (!Number.isFinite(guess)) return null;
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // right across a clock change
  return Math.round(t / 60000);
}

async function hourlyCached(key, load) {
  const req = new Request(`https://cache.ship-track/${key}&h=${Math.floor(Date.now() / 3600000)}`);
  const hit = await caches.default.match(req);
  if (hit) return hit.json();
  const data = await load();
  await caches.default.put(req, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
  return data;
}

async function poSailings() {
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
  const out = [];
  await Promise.all(PO_ROUTES.map(([route, depTz, arrTz]) => hourlyCached(`po?r=${route}`, async () => {
    const res = await fetch(`https://www.pofreight.com/api/sailings?route=${route}&start=${iso(hour - 6 * 3600000)}&end=${iso(hour + 72 * 3600000)}`,
      { headers: { Accept: 'application/json', 'User-Agent': UA } });
    const list = res.ok ? await res.json().catch(() => []) : [];
    if (!Array.isArray(list)) return [];
    return list.flatMap((v) => {
      const a = PO_PORTS[v.departurePortCode], b = PO_PORTS[v.arrivalPortCode];
      const dep = localMinutes(v.departureDateTimeLocalToPort, depTz), arr = localMinutes(v.arrivalDateTimeLocalToPort, arrTz);
      if (!a || !b || dep == null || arr == null || /cancel/i.test(v.status || '')) return [];
      return [[a[0], b[0], dep, arr, String(v.vesselName || ''), '']];
    });
  }).then((l) => out.push(...l)).catch(() => {}))); // one direction failing still returns the other
  return out;
}

// Irish Ferries list today's sailings per route as small tables: route, times, ship and status.
async function irishSailings() {
  const out = [];
  const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  await Promise.all(IF_PAGES.map((page) => hourlyCached(`if?p=${page}`, async () => {
    const res = await fetch(`https://www.irishferries.com/uk-en/sailing-updates/${page}/`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const html = await res.text();
    const rows = [];
    for (const chunk of html.split('tab-sailing-row').slice(1)) {
      const cell = (label) => { const m = chunk.match(new RegExp(`${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`)); return m ? text(m[1]) : ''; };
      const [from, to] = cell('Route').split(/\s+-\s+/);
      const dep = cell('Scheduled Departure').match(/(\d\d):(\d\d)/), arr = cell('Scheduled Arrival').match(/(\d\d):(\d\d)/);
      const status = text((chunk.match(/class="status[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '');
      const a = IF_PORTS[from], b = IF_PORTS[to];
      if (!a || !b || !dep || !arr || /cancel/i.test(status)) continue;
      // The page lists today's sailings, in each port's own time.
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: a[2] }).format(new Date());
      const d = localMinutes(`${day}T${dep[1]}:${dep[2]}:00`, a[2]);
      let r = localMinutes(`${day}T${arr[1]}:${arr[2]}:00`, b[2]);
      if (d == null || r == null) continue;
      while (r <= d) r += 1440; // arrives after midnight
      rows.push([from, to, d, r, cell('Ship'), /delay/i.test(status) ? 'Delayed' : '']);
    }
    return rows;
  }).then((l) => out.push(...l)).catch(() => {})));
  return out;
}

// DFDS publish every departure on their network, in UTC, without the ship's name. Port positions
// come from our own UN/LOCODE list. Dieppe–Newhaven is left out: its open timetable is already in.
let portList = null;
async function dfdsSailings(env) {
  portList ||= env.ASSETS.fetch('https://assets.local/data/ports.json').then((r) => r.json()).catch(() => ({}));
  const ports = await portList;
  const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const list = await hourlyCached('dfds?v=1', async () => {
    const res = await fetch(`https://api.hellman.oxygen.dfds.cloud/prod/servicesunifiedbff/api/v2/departures?fromdate=${day(0)}&todate=${day(3)}`,
      { headers: { Accept: 'application/json', 'User-Agent': UA } });
    const d = res.ok ? await res.json().catch(() => ({})) : {};
    return Array.isArray(d.departures) ? d.departures : [];
  }).catch(() => []);
  const where = (p) => {
    const lo = p?.unlocode || '', q = ports[lo.slice(0, 2)]?.[lo.slice(2)];
    if (q && q.length >= 3) return [p.name, q[1], q[2]];
    const ours = Object.values(PO_PORTS).find((x) => x[0] === p?.name) || (IF_PORTS[p?.name] && [p.name, IF_PORTS[p.name][0], IF_PORTS[p.name][1]]);
    return ours || null;
  };
  const out = [];
  for (const v of list) {
    const a = v.route?.departurePort, b = v.route?.arrivalPort;
    if (!a || !b || /^(NHN|DPP)$/.test(a.code) && /^(NHN|DPP)$/.test(b.code)) continue;
    const pa = where(a), pb = where(b);
    const dep = Date.parse(v.scheduledDepartureTime), arr = Date.parse(v.scheduledArrivalTime);
    if (!pa || !pb || !Number.isFinite(dep) || !Number.isFinite(arr)) continue;
    out.push([pa, pb, Math.round(dep / 60000), Math.round(arr / 60000)]);
  }
  return out;
}

async function sailings(env) {
  const [po, irish, dfds] = await Promise.all([poSailings(), irishSailings(), dfdsSailings(env)]);
  const key = (x) => `${x[4].toUpperCase().replace(/^(MS|MV)\s+/, '').replace(/^(P&O|ISLE OF)\s+/, '')}|${Math.round(x[2] / 10)}`;
  const seen = new Set(irish.map(key));
  const out = { operators: ['P&O Ferries', 'Irish Ferries', 'DFDS'], ports: {}, sailings: [] };
  const port = (name) => {
    const p = PO_PORTS[Object.keys(PO_PORTS).find((k) => PO_PORTS[k][0] === name)] || (IF_PORTS[name] && [name, IF_PORTS[name][0], IF_PORTS[name][1]]);
    out.ports[`live:${name}`] = p;
    return `live:${name}`;
  };
  for (const x of [...irish, ...po.filter((x) => !seen.has(key(x)))]) {
    out.sailings.push([IRISH_SHIP.test(x[4]) ? 1 : 0, port(x[0]), port(x[1]), x[2], x[3], `${x[0]} – ${x[1]}`, x[4], x[5]]);
  }
  for (const [a, b, dep, arr] of dfds) {
    out.ports[`dfds:${a[0]}`] = a;
    out.ports[`dfds:${b[0]}`] = b;
    out.sailings.push([2, `dfds:${a[0]}`, `dfds:${b[0]}`, dep, arr, `${a[0]} – ${b[0]}`]);
  }
  out.sailings.sort((x, y) => x[3] - y[3]);
  return json(out, 200, { 'Cache-Control': 'public, max-age=600' });
}

// Sea depth at a point, from the EMODnet Bathymetry model (European seas, CC BY 4.0).
async function depth(url) {
  const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return json({ error: 'lat and lon please' }, 400);
  const la = lat.toFixed(3), lo = lon.toFixed(3);
  const key = new Request(`https://cache.ship-track/depth?p=${la},${lo}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const d = 0.0005;
  const q = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo', LAYERS: 'emodnet:mean', QUERY_LAYERS: 'emodnet:mean',
    STYLES: '', SRS: 'EPSG:4326', BBOX: `${lo - d},${la - d},${+lo + d},${+la + d}`, WIDTH: '3', HEIGHT: '3', X: '1', Y: '1', INFO_FORMAT: 'application/json' });
  let metres = null;
  try {
    const res = await fetch(`https://ows.emodnet-bathymetry.eu/wms?${q}`, { headers: { 'User-Agent': UA } });
    const v = res.ok ? (await res.json()).features?.[0]?.properties?.Depth : null;
    if (Number.isFinite(v) && v < 0) metres = Math.round(-v * 10) / 10;
  } catch { /* unknown depth */ }
  const out = json({ depth: metres }, 200, { 'Cache-Control': 'public, max-age=2592000' });
  await caches.default.put(key, out.clone());
  return out;
}

async function extra(url, ctx) {
  const box = (url.searchParams.get('box') || '').split(',').map(Number);
  if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) return json({ error: 'box must be s,w,n,e' }, 400);
  const [s, w, n, e] = box;
  const [as, aw, an, ae] = DIGITRAFFIC_AREA;
  if (n < as || s > an || (w <= e && (e < aw || w > ae))) return json({ messages: [] }, 200, { 'Cache-Control': 'public, max-age=20' });
  const inside = (lat, lon) => lat >= s && lat <= n && (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
  const [locations, vessels] = await Promise.all([
    cachedJson(ctx, `${DIGITRAFFIC}/locations`, 20),
    cachedJson(ctx, `${DIGITRAFFIC}/vessels`, 600),
  ]);
  const details = new Map((Array.isArray(vessels) ? vessels : []).map((v) => [v.mmsi, v]));
  const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const messages = [];
  for (const f of locations.features || []) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!p.mmsi || !inside(lat, lon) || !p.timestampExternal) continue;
    const v = details.get(p.mmsi);
    const MetaData = { MMSI: p.mmsi, ShipName: v?.name || '', latitude: lat, longitude: lon, time_utc: utc(p.timestampExternal) };
    messages.push({ MessageType: 'PositionReport', MetaData, Message: { PositionReport: {
      Latitude: lat, Longitude: lon, Sog: p.sog, Cog: p.cog, TrueHeading: p.heading, NavigationalStatus: p.navStat } } });
    if (v) {
      const eta = v.eta || 0;
      messages.push({ MessageType: 'ShipStaticData', MetaData: { ...MetaData, time_utc: utc(v.timestamp || p.timestampExternal) }, Message: { ShipStaticData: {
        Name: v.name, CallSign: v.callSign, ImoNumber: v.imo, Type: v.shipType, Destination: v.destination,
        Dimension: { A: v.referencePointA, B: v.referencePointB, C: v.referencePointC, D: v.referencePointD },
        MaximumStaticDraught: v.draught ? v.draught / 10 : 0,
        Eta: { Month: (eta >> 16) & 15, Day: (eta >> 11) & 31, Hour: (eta >> 6) & 31, Minute: eta & 63 } } } });
    }
  }
  return json({ messages, source: 'Digitraffic' }, 200, { 'Cache-Control': 'public, max-age=20' });
}

function where(request) {
  const cf = request.cf || {};
  return json({
    country: cf.country || null,
    lat: cf.latitude ? Number(cf.latitude) : null,
    lon: cf.longitude ? Number(cf.longitude) : null,
  }, 200, { 'Cache-Control': 'private, no-store' });
}

// ---------- helpers ----------

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
