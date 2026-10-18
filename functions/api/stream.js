// GET /api/stream (WebSocket): live AIS messages for the area on screen, relayed from aisstream.io.
// The browser sends {"boxes": [[[s, w], [n, e]], ...]} whenever the view changes. The Worker adds the
// API key (a Cloudflare secret, never sent to the browser), passes the subscription on, and relays
// every message back untouched, so it spends almost no CPU per message.
import { UPSTREAM, AIS_TYPES, json, cleanBoxes } from "../../lib/util.js";

export async function onRequestGet(ctx) {
  const key = ctx.env.AISSTREAM_API_KEY;
  if ((ctx.request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "connect with a WebSocket", live: !!key }, { status: 426 });
  }
  if (!key) return json({ error: "AISSTREAM_API_KEY is not set" }, { status: 503 });

  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();

  let up = null, pending = null, connecting = false, closed = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason); } catch {}
    try { up && up.close(1000, "viewer left"); } catch {}
  };
  const tell = (msg) => { try { server.send(JSON.stringify(msg)); } catch {} };

  async function connect() {
    connecting = true;
    let ws;
    try {
      // aisstream.io must receive the subscription within 3 s of connecting, so connect only once one is ready.
      const r = await fetch(ctx.env.AISSTREAM_URL || UPSTREAM, { headers: { Upgrade: "websocket" } });
      ws = r.webSocket;
      if (!ws) throw new Error(`upstream answered ${r.status}`);
    } catch (err) {
      tell({ error: `AIS feed unreachable: ${err.message}` });
      return close(1011, "upstream unreachable");
    }
    if (closed) return;
    ws.accept();
    up = ws;
    ws.send(pending);
    ws.addEventListener("message", (ev) => {
      try { server.send(ev.data); } catch { close(1011, "viewer gone"); }
    });
    ws.addEventListener("close", (ev) => close(1011, `upstream closed ${ev.code}`));
    ws.addEventListener("error", () => close(1011, "upstream error"));
  }

  server.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
    const boxes = cleanBoxes(m && m.boxes);
    if (!boxes) return;
    pending = JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: AIS_TYPES });
    if (up) {
      try { up.send(pending); } catch { close(1011, "upstream gone"); }
    } else if (!connecting) {
      ctx.waitUntil(connect());
    }
  });
  server.addEventListener("close", () => close(1000, "bye"));
  server.addEventListener("error", () => close(1011, "viewer error"));

  return new Response(null, { status: 101, webSocket: client });
}
