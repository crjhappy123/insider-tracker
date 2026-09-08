// GET /api/cn/transactions — JSON, same filters as /cn (edge-cached).
import { parseFilters, queryTransactions, serveCached } from "../../_cn.js";

export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const filters = parseFilters(url);
  return serveCached(context, "application/json; charset=utf-8", async () => {
    const rows = await queryTransactions(context.env.DB, filters);
    // Expose one market_cap: the effective (company-level, else per-row) value
    // the page renders. Dropping the raw column avoids two conflicting fields.
    return JSON.stringify(
      rows.map(({ eff_mktcap, ...r }) => ({ ...r, market_cap: eff_mktcap }))
    );
  });
}
