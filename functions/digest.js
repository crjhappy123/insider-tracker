// GET /digest — every section of the site as one Markdown document, for AI agents and
// scheduled tasks (edge-cached like the pages). See _digest.js.
import { buildDigest } from "./_digest.js";
import { serveCached } from "./_shared.js";

export function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  return serveCached(context, "text/markdown; charset=utf-8", () =>
    buildDigest(context.env.DB, origin)
  );
}
