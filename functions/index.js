// GET / — server-rendered filterable table + AI daily report, backed by D1 (edge-cached).
import {
  parseFilters,
  queryTickerRollup,
  latestReport,
  leaderboards,
  renderPage,
  serveCached,
} from "./_query.js";

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
