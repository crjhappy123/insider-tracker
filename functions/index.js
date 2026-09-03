// GET / — server-rendered filterable table, backed by D1 (edge-cached).
import {
  parseFilters,
  queryTransactions,
  renderPage,
  serveCached,
} from "./_query.js";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const filters = parseFilters(url);
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const rows = await queryTransactions(context.env.DB, filters);
    return renderPage(rows, filters);
  });
}
