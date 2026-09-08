// GET /cn — server-rendered A-share 董监高增持 table + AI report, backed by the
// cn_* D1 tables (edge-cached). The US page lives in functions/index.js.
import {
  parseFilters,
  queryTickerRollup,
  latestReport,
  leaderboards,
  renderPage,
  serveCached,
} from "./_cn.js";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const filters = parseFilters(url);
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const [rows, report, boards] = await Promise.all([
      queryTickerRollup(context.env.DB, filters),
      latestReport(context.env.DB),
      leaderboards(context.env.DB),
    ]);
    return renderPage(rows, filters, report, boards);
  });
}
