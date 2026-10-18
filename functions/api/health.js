// GET /api/health → { ok, live }. `live` is false until the aisstream.io key is set as a secret.
import { json } from "../../lib/util.js";

export async function onRequestGet(ctx) {
  return json({ ok: true, live: !!ctx.env.AISSTREAM_API_KEY });
}
