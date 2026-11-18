// GET /yt/macro — 博主汇总 · 宏观报告: the day's AI macro report (yt_macro_reports)
// and every creator's one-line view from yt_videos (edge-cached).
import {
  parseFilters,
  queryDates,
  queryMacro,
  queryMacroDates,
  queryVideos,
  renderMacroPage,
  serveCached,
} from "../_yt.js";

export function onRequestGet(context) {
  const f = parseFilters(new URL(context.request.url));
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const db = context.env.DB;
    const [videoDates, reportDates] = await Promise.all([queryDates(db), queryMacroDates(db)]);
    const dates = [...new Set([...videoDates, ...reportDates])].sort().reverse();
    const sel = f.date || dates[0] || null;
    const [report, videos] = sel
      ? await Promise.all([queryMacro(db, sel), queryVideos(db, sel, sel)])
      : [null, []];
    return renderMacroPage({ dates, sel, report, videos });
  });
}
