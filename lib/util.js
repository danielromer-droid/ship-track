// Shared helpers for the API (Cloudflare Pages Functions).
export const UPSTREAM = "https://stream.aisstream.io/v0/stream";

// Message types the map uses; everything else aisstream offers is filtered out upstream.
export const AIS_TYPES = ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

// Bounding boxes from the browser: [[[south, west], [north, east]], ...], at most 4, rounded so the key cannot be abused
// for anything but map views.
export function cleanBoxes(boxes) {
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

export function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
