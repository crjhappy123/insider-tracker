// GET /yt/heatmap — 博主汇总 · 热力图: which stocks creators called on a day (or the
// week ending on it) and which way, plus the 看多 / 看空 / 分歧 board (edge-cached).
import { parseFilters, queryDates, queryVideos, renderHeatPage, serveCached, weekStart } from "../_yt.js";

export function onRequestGet(context) {
  const f = parseFilters(new URL(context.request.url));
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const db = context.env.DB;
    const dates = await queryDates(db);
    const sel = f.date || dates[0] || null;
    const start = sel && f.range === "w" ? weekStart(sel) : sel;
    const videos = sel ? await queryVideos(db, start, sel) : [];
    return renderHeatPage({ f, dates, sel, start, videos });
  });
}
