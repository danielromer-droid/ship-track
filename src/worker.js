// Ship Track Worker: serves the map page (./public) and the /api/* endpoints.
//
// GET /api/stream            WebSocket. The page sends {"boxes": [[[s, w], [n, e]], ...]} whenever the view
//                            changes; the Worker adds the aisstream.io key, subscribes for that area and relays
//                            every AIS message back untouched, so it spends almost no CPU per message.
// GET /api/health            { ok, live }: live is false until the AISSTREAM_API_KEY secret is set.
// GET /api/health?check=1    also opens a test connection to aisstream.io and says what happened.
// GET /api/search?q=genoa    ports and places matching a name (Photon / OpenStreetMap), to fly the map there.
// GET /api/where             the visitor's country, to open the map there.
// GET /api/photo?imo=9811000&name=EVER%20GIVEN   a photo of the ship, with the photographer's credit when needed.

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
      if (url.pathname === '/api/photo') return await photo(url, ctx);
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
    pending = JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: AIS_TYPES });
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

// ---------- health check ----------

async function health(url, env) {
  const key = keyOf(env);
  const out = { ok: true, live: Boolean(key) };
  if (!key || !url.searchParams.has('check')) return json(out, 200, { 'Cache-Control': 'no-store' });
  out.keyLength = key.length;
  out.check = await probe(env.AISSTREAM_URL || UPSTREAM, key);
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
  const cacheKey = new Request(`https://cache.ship-track/photo/v2?imo=${imo}&name=${encodeURIComponent(name)}`);
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
  const author = stripTags(meta.Artist?.value);
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

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 80);
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
