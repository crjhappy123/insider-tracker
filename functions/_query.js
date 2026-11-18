// D1 query + HTML rendering for the US page (`/`): SEC Form 4 insider buys.
// Presentation shared with the A-share page lives in _shared.js; this module owns
// the US SQL, USD formatting, and English copy.
// Files prefixed with "_" are not routed by Cloudflare Pages.
import {
  aiCell,
  aiPill,
  esc,
  loadBoards,
  mcapTier,
  num,
  renderBoards,
  renderShell,
  tile,
} from "./_shared.js";

export { parseFilters, serveCached } from "./_shared.js";

// Baseline market-cap floor for the table: hide companies with no market cap
// or below this. The "Min mkt cap" filter can only raise it, never lower it.
const MIN_DISPLAY_MKTCAP = 1e9; // $1B

// Descending [threshold, tier class]: mega ≥$200B, large ≥$10B, mid ≥$2B,
// small ≥$300M, else micro/unknown.
const MCAP_TIERS = [
  [200e9, "mc-mega"],
  [10e9, "mc-large"],
  [2e9, "mc-mid"],
  [300e6, "mc-small"],
];

// Run the filtered query against D1; returns an array of row objects.
export async function queryTransactions(db, f) {
  const where = [];
  const binds = [];
  if (f.ticker) {
    where.push("t.ticker = ?");
    binds.push(f.ticker.toUpperCase());
  }
  if (f.insider) {
    where.push("t.insider_name LIKE ?");
    binds.push(`%${f.insider}%`);
  }
  if (f.code) {
    where.push("t.transaction_code = ?");
    binds.push(f.code.toUpperCase());
  }
  if (f.minValue !== null) {
    where.push("t.value >= ?");
    binds.push(f.minValue);
  }
  if (f.minMarketCap !== null) {
    // Filter on the effective (company-level, else per-row) market cap.
    where.push("COALESCE(c.market_cap, t.market_cap) >= ?");
    binds.push(f.minMarketCap);
  }
  // The DB only holds open-market purchases (see scraper INGEST_CODES).
  // Prefer the weekly company-level market cap; fall back to the per-row estimate.
  // Also attach the AI score/comment when present.
  let sql =
    "SELECT t.*, COALESCE(c.market_cap, t.market_cap) AS eff_mktcap, " +
    "a.score AS ai_score, a.rating AS ai_rating, a.comment AS ai_comment " +
    "FROM transactions t " +
    "LEFT JOIN companies c ON c.cik = t.issuer_cik " +
    "LEFT JOIN ai_scores a ON a.accession_no = t.accession_no AND a.line_no = t.line_no";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY t.filing_date DESC, t.id DESC LIMIT ?";
  binds.push(f.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return results || [];
}

// Aggregated ticker-rollup for the HTML table: one row per company (issuer_cik),
// summing buy value and buy count across the retention window. The JSON API
// stays per-transaction (queryTransactions); the page shows this rolled-up view.
export async function queryTickerRollup(db, f) {
  const where = [];
  const having = [];
  const binds = [];
  if (f.ticker) {
    where.push("t.ticker = ?");
    binds.push(f.ticker.toUpperCase());
  }
  if (f.insider) {
    where.push("t.insider_name LIKE ?");
    binds.push(`%${f.insider}%`);
  }
  if (f.code) {
    where.push("t.transaction_code = ?");
    binds.push(f.code.toUpperCase());
  }
  // Effective (company-level) market-cap floor: baseline $1B, raised by the
  // filter if higher. Applied on the aggregate so no-cap companies drop out too.
  const mcapFloor = Math.max(MIN_DISPLAY_MKTCAP, f.minMarketCap ?? 0);
  having.push("COALESCE(c.market_cap, MAX(t.market_cap)) >= ?");
  // min_value filters on the company's *total* bought here (rolled-up view).
  if (f.minValue !== null) {
    having.push("SUM(t.value) >= ?");
  }

  // Best AI pick per company (highest score) drives the score pill + hover.
  const bestPick =
    "(SELECT a2.%COL% FROM ai_scores a2 " +
    "JOIN transactions t2 ON t2.accession_no = a2.accession_no AND t2.line_no = a2.line_no " +
    "WHERE t2.issuer_cik = t.issuer_cik ORDER BY a2.score DESC LIMIT 1)";
  let sql =
    "SELECT MAX(t.filing_date) AS filing_date, MAX(t.trade_date) AS trade_date, " +
    "t.ticker AS ticker, MAX(t.company_name) AS company_name, t.issuer_cik AS issuer_cik, " +
    "COUNT(*) AS buy_count, COUNT(DISTINCT t.insider_name) AS insider_count, " +
    "SUM(t.shares) AS shares, SUM(t.value) AS value, " +
    "CASE WHEN SUM(t.shares) > 0 THEN SUM(t.value) / SUM(t.shares) END AS avg_price, " +
    "COALESCE(c.market_cap, MAX(t.market_cap)) AS eff_mktcap, " +
    "MAX(a.score) AS ai_score, " +
    bestPick.replace("%COL%", "rating") + " AS ai_rating, " +
    bestPick.replace("%COL%", "comment") + " AS ai_comment " +
    "FROM transactions t " +
    "LEFT JOIN companies c ON c.cik = t.issuer_cik " +
    "LEFT JOIN ai_scores a ON a.accession_no = t.accession_no AND a.line_no = t.line_no";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " GROUP BY t.issuer_cik HAVING " + having.join(" AND ");
  binds.push(mcapFloor); // matches the first HAVING condition
  if (f.minValue !== null) binds.push(f.minValue);
  sql += " ORDER BY MAX(t.filing_date) DESC, SUM(t.value) DESC LIMIT ?";
  binds.push(f.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return results || [];
}

// AI leaderboards over four windows (daily / weekly / quarterly / yearly), read
// from the durable `leaderboard` table so quarterly/yearly survive the prune.
export function leaderboards(db) {
  return loadBoards(db, "leaderboard");
}

// Latest AI daily report — but ONLY if it covers the most recent data day.
// Otherwise (e.g. today ingested but the report was skipped) we hide it rather
// than fall back to a stale prior-day report.
export async function latestReport(db) {
  try {
    const row = await db
      .prepare("SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1")
      .first();
    if (!row) return null;
    const latest = await db
      .prepare("SELECT MAX(filing_date) AS d FROM transactions")
      .first();
    if (latest && latest.d && row.report_date !== latest.d) return null; // stale
    const { results } = await db
      .prepare(
        "SELECT t.ticker, t.company_name, t.insider_name, t.value, " +
          "a.score, a.rating, a.comment " +
          "FROM ai_scores a " +
          "JOIN transactions t ON t.accession_no = a.accession_no AND t.line_no = a.line_no " +
          "WHERE t.filing_date = ? ORDER BY a.score DESC"
      )
      .bind(row.report_date)
      .all();
    // One block per company (dedupe by ticker; rows are score-desc ordered).
    const seen = new Set();
    row.picks = (results || []).filter((p) => {
      if (seen.has(p.ticker)) return false;
      seen.add(p.ticker);
      return true;
    });
    return row;
  } catch {
    return null; // tables may not exist yet
  }
}

// Market cap, always in billions: $45.31B, $0.22B.
function bcap(v) {
  if (v === null || v === undefined) return "—";
  return `$${(Number(v) / 1e9).toFixed(2)}B`;
}

// Compact currency: $9.9M, $270K, $540.
function money(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function px(v) {
  return v == null ? "—" : `$${Number(v).toFixed(2)}`;
}

const FMT = { money, px };
const LABELS = {
  boardTitle: "🏆 AI Leaderboard",
  boardEmpty: "No scored buys yet.",
  tabs: { daily: "Daily", weekly: "Weekly", quarterly: "Quarterly", yearly: "Yearly" },
  colTicker: "Ticker",
  colEntry: "Entry / Date",
  colNow: "Now",
  colGain: "Gain",
  colBought: "Bought",
};

// Headline stats over the rolled-up (per-company) rows.
function computeStats(rows) {
  let buyValue = 0,
    buys = 0,
    maxBuy = 0,
    maxTicker = "";
  for (const r of rows) {
    const v = Number(r.value) || 0;
    buyValue += v;
    buys += Number(r.buy_count) || 0;
    if (v > maxBuy) {
      maxBuy = v;
      maxTicker = r.ticker || "";
    }
  }
  return { companies: rows.length, buys, buyValue, maxBuy, maxTicker };
}

// Render the full HTML page.
export function renderPage(rows, f, report, boards) {
  const s = computeStats(rows);

  const bodyRows = rows.length
    ? rows
        .map((r) => {
          const detail =
            r.ai_score != null && r.ai_comment
              ? `<tr class="detail" hidden><td colspan="9">` +
                `<span class="r">${esc(r.ai_rating || "AI")}</span>${esc(r.ai_comment)}</td></tr>`
              : "";
          return `<tr class="buy ${mcapTier(r.eff_mktcap, MCAP_TIERS)}">
            <td class="dim">${esc(r.filing_date)}</td>
            <td class="tk" data-v="${r.eff_mktcap ?? -1}">
              <span class="ticker">${esc(r.ticker || "—")}</span>
              <span class="mcap">${bcap(r.eff_mktcap)}</span>
            </td>
            <td class="co">${esc(r.company_name)}</td>
            <td class="n" data-v="${r.insider_count ?? 0}">${num(r.insider_count)}</td>
            <td class="n" data-v="${r.buy_count ?? 0}">${num(r.buy_count)}</td>
            <td data-v="${r.ai_score ?? -1}">${aiCell(r)}</td>
            <td class="n" data-v="${r.avg_price ?? -1}">${r.avg_price != null ? "$" + Number(r.avg_price).toFixed(2) : ""}</td>
            <td class="n qty" data-v="${r.shares ?? -1}">${num(r.shares)}</td>
            <td class="n val" data-v="${r.value ?? -1}">${r.value != null ? money(r.value) : ""}</td>
          </tr>${detail}`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">No transactions match your filters.</td></tr>`;

  const pickBlocks = (report && report.picks ? report.picks : [])
    .map((p) => {
      return `<div class="pick">
        <div class="pick-head">
          <span class="ticker">${esc(p.ticker || "—")}</span>
          <span class="pick-co">${esc(p.company_name || "")}</span>
          ${aiPill(p.score, { rating: p.rating, comment: p.comment })}
          ${p.rating ? `<span class="pick-rating">${esc(p.rating)}</span>` : ""}
        </div>
        <div class="pick-comment">${esc(p.comment || "")}</div>
      </div>`;
    })
    .join("");

  const reportCard = report && (report.summary || pickBlocks)
    ? `<section class="card report">
        <div class="report-head">🤖 AI Daily Report <span class="dim">· ${esc(
          report.report_date
        )}</span></div>
        ${report.summary ? `<div class="report-body">${esc(report.summary)}</div>` : ""}
        ${pickBlocks ? `<div class="picks">${pickBlocks}</div>` : ""}
        <div class="report-foot">Generated by ${esc(
          report.model || "Gemini"
        )} · informational only, not financial advice</div>
      </section>`
    : "";

  const body = `
<div class="page-head">
  <h1>美股 Insider</h1>
  <span class="tag">SEC Form 4 · insider open-market purchases</span>
</div>

${reportCard}

${renderBoards(boards, FMT, LABELS)}

<section class="kpi">
  ${tile("Companies", num(s.companies), "--accent", "distinct tickers")}
  ${tile("Total Bought", money(s.buyValue), "--buy", num(s.buys) + " buys (code P)")}
  ${tile("Avg / Company", money(s.companies ? s.buyValue / s.companies : 0), "--accent")}
  ${tile("Top Ticker Buy", money(s.maxBuy), "--buy", s.maxTicker || "")}
</section>


<form class="card filters" method="get" action="/">
  <label>Ticker<input name="ticker" value="${esc(f.ticker || "")}" placeholder="AAPL" size="8"></label>
  <label>Insider<input name="insider" value="${esc(f.insider || "")}" placeholder="name" size="14"></label>
  <label>Min $ value<input name="min_value" value="${f.minValue ?? ""}" placeholder="100000" size="10"></label>
  <label>Min mkt cap<input name="min_market_cap" value="${f.minMarketCap ?? ""}" placeholder="1000000000 ($1B)" size="12"></label>
  <label>Limit<input name="limit" value="${f.limit}" size="5"></label>
  <button type="submit">Filter</button>
  <a class="reset" href="/">reset</a>
</form>

<div class="count">${num(s.companies)} companies · ${num(s.buys)} buys${
  rows.length ? ` · data through ${esc(rows.reduce((m, r) => (r.filing_date > m ? r.filing_date : m), rows[0].filing_date))}` : ""
} · updated 2×/day from SEC EDGAR</div>
<div class="legend">
  <span class="k"><span class="sw" style="background:var(--mc-mega)"></span>Mega ≥$200B</span>
  <span class="k"><span class="sw" style="background:var(--mc-large)"></span>Large ≥$10B</span>
  <span class="k"><span class="sw" style="background:var(--mc-mid)"></span>Mid ≥$2B</span>
  <span class="k"><span class="sw" style="background:var(--mc-small)"></span>Small ≥$300M</span>
  <span class="k"><span class="sw" style="background:var(--mc-micro)"></span>Micro / —</span>
</div>
<div class="card tablecard"><table><thead><tr>
<th data-type="text">Latest Filed</th><th data-type="num">Ticker / Mkt Cap</th><th data-type="text">Company</th>
<th class="n" data-type="num">Insiders</th><th class="n" data-type="num">Buys</th><th data-type="num">AI</th>
<th class="n" data-type="num">Avg Price</th><th class="n qty" data-type="num">Total Qty</th><th class="n" data-type="num">Total Value</th>
</tr></thead><tbody>${bodyRows}</tbody></table></div>

<footer class="card disclaimer">
  <b>Disclaimer</b>
  <p>Data is sourced from public <strong>Form 4</strong> filings on the U.S. SEC EDGAR system and is provided for informational purposes only. Form 4 filings are lawful, publicly required disclosures of insider transactions — not confidential or illegal insider information.</p>
  <p>Nothing on this site — including AI-generated scores, ratings, or commentary — constitutes investment advice, a recommendation, or an offer to buy or sell any security, and does not represent the views of this site. Market caps and other figures are estimates and may be delayed or inaccurate; we make no warranty as to their accuracy, completeness, or timeliness.</p>
  <p>Investing involves risk. Do your own research and make your own decisions. This site is not affiliated with the SEC or any brokerage, and is not liable for any losses arising from use of the information provided here.</p>
</footer>`;
  return renderShell({ active: "us", title: "美股 Insider", lang: "en", market: "us", body });
}
