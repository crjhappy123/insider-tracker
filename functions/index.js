// GET / — server-rendered filterable table + AI daily report, backed by D1 (edge-cached).
import {
  parseFilters,
  queryTransactions,
  latestReport,
  renderPage,
  serveCached,
} from "./_query.js";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const filters = parseFilters(url);
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const [rows, report] = await Promise.all([
      queryTransactions(context.env.DB, filters),
      latestReport(context.env.DB),
    ]);
    return renderPage(rows, filters, report);
  });
}
