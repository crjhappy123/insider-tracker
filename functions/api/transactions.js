// GET /api/transactions — JSON, same filters as the homepage (edge-cached).
import { parseFilters, queryTransactions, serveCached } from "../_query.js";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const filters = parseFilters(url);
  return serveCached(context, "application/json; charset=utf-8", async () => {
    const rows = await queryTransactions(context.env.DB, filters);
    return JSON.stringify(rows);
  });
}
