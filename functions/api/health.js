// GET /api/health → { ok, live }. `live` is false until the aisstream.io key is set as a secret.
// GET /api/health?check=1 also opens a test connection to aisstream.io and reports what happened,
// which is the quickest way to see why the live feed does not work.
import { UPSTREAM, AIS_TYPES, json } from "../../lib/util.js";

export async function onRequestGet(ctx) {
  const key = (ctx.env.AISSTREAM_API_KEY || "").trim();
  const out = { ok: true, live: !!key };
  if (!key || !new URL(ctx.request.url).searchParams.has("check")) return json(out);
  out.keyLength = key.length;
  out.check = await probe(ctx.env.AISSTREAM_URL || UPSTREAM, key);
  return json(out);
}

async function probe(url, key) {
  let ws;
  try {
    const r = await fetch(url, { headers: { Upgrade: "websocket" } });
    ws = r.webSocket;
    if (!ws) return { result: "failed", detail: `aisstream.io answered HTTP ${r.status} instead of opening a WebSocket` };
  } catch (err) {
    return { result: "failed", detail: `could not reach aisstream.io: ${err.message}` };
  }
  ws.accept();
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); try { ws.close(1000, "check done"); } catch {} resolve(v); };
    const t = setTimeout(() => done({ result: "connected, but no ship message within 10 s" }), 10000);
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      let m = null;
      try { m = JSON.parse(text); } catch {}
      if (m && m.error) done({ result: "rejected", detail: m.error });
      else done({ result: "working", firstMessage: m ? m.MessageType : text.slice(0, 80) });
    });
    ws.addEventListener("close", (ev) => done({ result: "closed", detail: `code ${ev.code} ${ev.reason || ""}`.trim() }));
    // The English Channel is always busy, so a working feed answers within a second or two.
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[49.5, -2], [51.5, 2.5]]], FilterMessageTypes: AIS_TYPES }));
  });
}
