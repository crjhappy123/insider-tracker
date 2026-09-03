// Shared D1 query + HTML rendering for the insider tracker.
// Files prefixed with "_" are not routed by Cloudflare Pages.

// Parse filter params from the request URL, coercing blanks to null.
export function parseFilters(url) {
  const g = (k) => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : null;
  };
  const parseNum = (k) => {
    const raw = g(k);
    if (raw === null) return null;
    const n = parseFloat(raw.replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  };
  const minValue = parseNum("min_value");
  const minMarketCap = parseNum("min_market_cap");
  let limit = parseInt(g("limit") || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 1000);
  return {
    ticker: g("ticker"),
    insider: g("insider"),
    code: g("code"),
    minValue,
    minMarketCap,
    limit,
  };
}

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
  if (f.minMarketCap !== null) {
    where.push("COALESCE(c.market_cap, t.market_cap) >= ?");
    binds.push(f.minMarketCap);
  }
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
  sql += " GROUP BY t.issuer_cik";
  if (having.length) {
    sql += " HAVING " + having.join(" AND ");
    binds.push(f.minValue);
  }
  sql += " ORDER BY MAX(t.filing_date) DESC, SUM(t.value) DESC LIMIT ?";
  binds.push(f.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return results || [];
}

// AI score leaderboards: daily (latest scored day) and weekly (whole window).
// Dedupe by ticker keeping its highest score; sum the ticker's buy value in scope.
export async function leaderboards(db) {
  try {
    const { results } = await db
      .prepare(
        "SELECT t.filing_date, t.ticker, t.company_name, t.value, " +
          "a.score, a.rating, a.comment " +
          "FROM ai_scores a " +
          "JOIN transactions t ON t.accession_no = a.accession_no AND t.line_no = a.line_no " +
          "WHERE a.score IS NOT NULL ORDER BY a.score DESC"
      )
      .all();
    const rows = results || [];
    if (!rows.length) return { daily: [], weekly: [] };
    const latest = rows.reduce((m, r) => (r.filing_date > m ? r.filing_date : m), "");
    return {
      daily: rankBoard(rows.filter((r) => r.filing_date === latest)),
      weekly: rankBoard(rows),
    };
  } catch {
    return { daily: [], weekly: [] };
  }
}

// Collapse score-desc rows to one entry per ticker (best score wins), sum value.
function rankBoard(rows) {
  const byTicker = new Map();
  for (const r of rows) {
    const key = r.ticker || r.company_name;
    if (!byTicker.has(key)) {
      byTicker.set(key, {
        ticker: r.ticker,
        company_name: r.company_name,
        score: r.score,
        rating: r.rating,
        comment: r.comment,
        value: 0,
        buys: 0,
      });
    }
    const e = byTicker.get(key);
    e.value += Number(r.value) || 0;
    e.buys += 1;
  }
  return [...byTicker.values()].sort((a, b) => b.score - a.score).slice(0, 15);
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

// Serve GETs from Cloudflare's edge cache when possible, so repeated/burst
// traffic is absorbed at the edge and never reaches D1. Data changes ~daily, so
// a short TTL is plenty fresh. This is the main app-level DDoS mitigation.
export async function serveCached(context, contentType, build) {
  const { request } = context;
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const body = await build();
  const resp = new Response(body, {
    headers: {
      "content-type": contentType,
      // s-maxage: edge cache TTL; max-age: browser TTL.
      "cache-control": "public, max-age=60, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
  context.waitUntil(cache.put(request, resp.clone()));
  return resp;
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function num(v, digits = 0) {
  if (v === null || v === undefined) return "";
  return Number(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Market cap, always in billions: $45.31B, $0.22B.
function bcap(v) {
  if (v === null || v === undefined) return "—";
  return `$${(Number(v) / 1e9).toFixed(2)}B`;
}

// Market-cap tier → CSS class, so larger companies stand out visually.
// mega ≥ $200B, large ≥ $10B, mid ≥ $2B, small ≥ $300M, else micro/unknown.
function mcapTier(v) {
  if (v === null || v === undefined) return "mc-unknown";
  const n = Number(v);
  if (n >= 200e9) return "mc-mega";
  if (n >= 10e9) return "mc-large";
  if (n >= 2e9) return "mc-mid";
  if (n >= 300e6) return "mc-small";
  return "mc-micro";
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

// One leaderboard row: rank, ticker, company, score pill, total bought.
function boardRow(r, i) {
  const s = Number(r.score);
  const cls = s >= 70 ? "hi" : s >= 40 ? "mid" : "lo";
  return `<div class="lb-row">
    <span class="lb-rank">${i + 1}</span>
    <span class="ticker">${esc(r.ticker || "—")}</span>
    <span class="lb-co">${esc(r.company_name || "")}</span>
    <span class="ai ${cls}" title="${esc(r.rating || "")}: ${esc(
    r.comment || ""
  )}">${s}</span>
    <span class="lb-val">${money(r.value)}</span>
  </div>`;
}

// Daily/weekly AI leaderboards as a pure-CSS tabbed card (no client JS).
function renderBoards(boards) {
  if (!boards || (!boards.daily.length && !boards.weekly.length)) return "";
  const list = (rows) =>
    rows.length
      ? rows.map(boardRow).join("")
      : `<div class="empty">No scored buys yet.</div>`;
  return `<section class="card lb">
    <input type="radio" name="lbtab" id="lb-daily" checked>
    <input type="radio" name="lbtab" id="lb-weekly">
    <div class="lb-head">
      🏆 AI Leaderboard
      <div class="lb-tabs">
        <label for="lb-daily" class="lb-tab lb-tab-d">Daily</label>
        <label for="lb-weekly" class="lb-tab lb-tab-w">Weekly</label>
      </div>
    </div>
    <div class="lb-panel lb-panel-d">${list(boards.daily)}</div>
    <div class="lb-panel lb-panel-w">${list(boards.weekly)}</div>
  </section>`;
}

// AI score pill (color by conviction) + comment on hover.
function aiCell(r) {
  if (r.ai_score == null) return `<span class="dim">—</span>`;
  const s = Number(r.ai_score);
  const cls = s >= 70 ? "hi" : s >= 40 ? "mid" : "lo";
  return `<span class="ai ${cls}" title="${esc(r.ai_rating || "")}: ${esc(
    r.ai_comment || ""
  )}">${s}</span>`;
}

function tile(label, value, accentVar, sub) {
  return `<div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value" style="color:var(${accentVar})">${value}</div>
    ${sub ? `<div class="tile-sub">${sub}</div>` : ""}
  </div>`;
}

// Render the full HTML page.
export function renderPage(rows, f, report, boards) {
  const s = computeStats(rows);

  const bodyRows = rows.length
    ? rows
        .map((r) => {
          return `<tr class="buy ${mcapTier(r.eff_mktcap)}">
            <td class="dim">${esc(r.filing_date)}</td>
            <td class="tk">
              <span class="ticker">${esc(r.ticker || "—")}</span>
              <span class="mcap">${bcap(r.eff_mktcap)}</span>
            </td>
            <td class="co">${esc(r.company_name)}</td>
            <td class="n">${num(r.insider_count)}</td>
            <td class="n">${num(r.buy_count)}</td>
            <td>${aiCell(r)}</td>
            <td class="n">${r.avg_price != null ? "$" + Number(r.avg_price).toFixed(2) : ""}</td>
            <td class="n">${num(r.shares)}</td>
            <td class="n val">${r.value != null ? money(r.value) : ""}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">No transactions match your filters.</td></tr>`;

  const pickBlocks = (report && report.picks ? report.picks : [])
    .map((p) => {
      const sc = p.score == null ? "" : Number(p.score);
      const cls = sc >= 70 ? "hi" : sc >= 40 ? "mid" : "lo";
      return `<div class="pick">
        <div class="pick-head">
          <span class="ticker">${esc(p.ticker || "—")}</span>
          <span class="pick-co">${esc(p.company_name || "")}</span>
          ${sc === "" ? "" : `<span class="ai ${cls}">${sc}</span>`}
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

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Insider Tracker · SEC Form 4</title>
<style>
:root{
  color-scheme:dark;
  --plane:#0d0d0d; --surface:#1a1a19; --glass:rgba(255,255,255,.04);
  --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --border:rgba(255,255,255,.10);
  --buy:#0ca30c; --sell:#d03b3b; --accent:#3987e5;
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --plane:#f4f4f1; --surface:#fcfcfb; --glass:rgba(11,11,11,.03);
    --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --border:rgba(11,11,11,.10);
    --buy:#0a850a; --sell:#c02525; --accent:#2a78d6;
  }
}
*{box-sizing:border-box}
body{
  margin:0; font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--ink); background:
    radial-gradient(1200px 500px at 15% -10%, rgba(57,135,229,.14), transparent 60%),
    radial-gradient(900px 500px at 100% 0%, rgba(12,163,12,.08), transparent 55%),
    var(--plane);
  min-height:100vh; padding:1.5rem clamp(1rem,4vw,2.5rem) 3rem;
}
.wrap{max-width:1280px;margin:0 auto}
header{display:flex;align-items:baseline;gap:.8rem;flex-wrap:wrap;margin-bottom:1.4rem}
.logo{display:flex;align-items:center;gap:.55rem;font-size:1.45rem;font-weight:700;letter-spacing:-.02em}
.dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--accent);
  box-shadow:0 0 0 4px rgba(57,135,229,.18),0 0 16px 2px var(--accent)}
.tag{color:var(--muted);font-size:.82rem}
.card{background:var(--glass);border:1px solid var(--border);border-radius:16px;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
/* KPI tiles */
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.9rem;margin-bottom:1.1rem}
.tile{padding:1rem 1.15rem}
.tile-label{font-size:.68rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:.35rem}
.tile-value{font-size:1.7rem;font-weight:700;letter-spacing:-.02em;line-height:1}
.tile-sub{font-size:.72rem;color:var(--ink2);margin-top:.4rem}
/* filters */
form{display:flex;flex-wrap:wrap;gap:.7rem;align-items:end;padding:1rem 1.15rem;margin-bottom:1.1rem}
label{display:flex;flex-direction:column;font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);gap:.35rem}
label.check{flex-direction:row;align-items:center;gap:.4rem;text-transform:none;font-size:.8rem;color:var(--ink2);padding-bottom:.35rem}
label.check input{width:auto}
input,select{padding:.5rem .65rem;font-size:.9rem;color:var(--ink);background:var(--surface);
  border:1px solid var(--border);border-radius:10px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(57,135,229,.25)}
button{padding:.55rem 1.1rem;font-size:.9rem;font-weight:600;cursor:pointer;color:#fff;
  background:var(--accent);border:none;border-radius:10px}
button:hover{filter:brightness(1.08)}
.reset{align-self:center;font-size:.78rem;color:var(--muted);text-decoration:none}
.reset:hover{color:var(--ink)}
/* table */
.tablecard{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.82rem}
th,td{padding:.55rem .7rem;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)}
thead th{position:sticky;top:0;background:var(--surface);z-index:1;color:var(--muted);
  font-size:.68rem;letter-spacing:.07em;text-transform:uppercase;font-weight:600}
tbody tr{transition:filter .12s}
tbody tr:hover{filter:brightness(1.22)}
td.n{text-align:right;font-variant-numeric:tabular-nums}
td.dim{color:var(--muted)}
td.co{max-width:220px;overflow:hidden;text-overflow:ellipsis}
td.val{font-weight:600}
td.tk{line-height:1.2}
.ticker{display:block;font-weight:700;letter-spacing:.02em;color:var(--accent)}
.mcap{display:block;font-size:.68rem;color:var(--muted);font-variant-numeric:tabular-nums}
.code{color:var(--muted);font-size:.72rem}
tbody tr.buy td:first-child{box-shadow:inset 3px 0 0 var(--buy)}
.empty{text-align:center;padding:2.5rem;color:var(--muted)}
.count{font-size:.78rem;color:var(--muted);margin:.2rem 0 .6rem}
.report{padding:1.1rem 1.25rem;margin-bottom:1.1rem;border-left:3px solid var(--accent)}
.report-head{font-size:.95rem;font-weight:700;margin-bottom:.5rem}
.report-body{font-size:.9rem;line-height:1.5;color:var(--ink2);white-space:pre-wrap;margin-bottom:.4rem}
.report-foot{font-size:.68rem;color:var(--muted);margin-top:.6rem}
.picks{display:grid;gap:.55rem;margin-top:.4rem}
.pick{padding:.6rem .75rem;border:1px solid var(--border);border-radius:10px;background:var(--glass)}
.pick-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem}
.pick-co{font-size:.82rem;color:var(--ink2)}
.pick-rating{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.pick-comment{font-size:.85rem;line-height:1.5;color:var(--ink);white-space:pre-wrap}
.ai{display:inline-block;min-width:1.8rem;text-align:center;padding:.1rem .4rem;border-radius:6px;
  font-weight:700;font-size:.72rem;cursor:help}
.ai.hi{color:var(--buy);background:color-mix(in srgb,var(--buy) 18%,transparent)}
.ai.mid{color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent)}
.ai.lo{color:var(--muted);background:var(--glass)}
/* AI leaderboard (pure-CSS tabs) */
.lb{padding:1.1rem 1.25rem;margin-bottom:1.1rem}
.lb>input{position:absolute;opacity:0;pointer-events:none}
.lb-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;font-size:.95rem;font-weight:700;margin-bottom:.7rem;flex-wrap:wrap}
.lb-tabs{display:flex;gap:.3rem}
.lb-tab{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
  padding:.3rem .7rem;border:1px solid var(--border);border-radius:8px;cursor:pointer}
.lb-tab:hover{color:var(--ink)}
#lb-daily:checked~.lb-head .lb-tab-d,#lb-weekly:checked~.lb-head .lb-tab-w{
  color:#fff;background:var(--accent);border-color:transparent}
.lb-panel{display:none;flex-direction:column;gap:.35rem}
#lb-daily:checked~.lb-panel-d,#lb-weekly:checked~.lb-panel-w{display:flex}
.lb-row{display:grid;grid-template-columns:1.6rem auto 1fr auto auto;align-items:center;gap:.6rem;
  padding:.4rem .5rem;border-radius:8px}
.lb-row:hover{background:var(--glass)}
.lb-rank{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.8rem;text-align:right}
.lb-co{color:var(--ink2);font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb-val{font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* Market-cap tiers: whole-row background tint so big caps jump out. */
:root{--mc-mega:#e0a92e;--mc-large:var(--accent);--mc-mid:#2bb3a3;--mc-small:#8a8a8a;--mc-micro:var(--border)}
tbody tr.mc-mega  td{background:color-mix(in srgb,var(--mc-mega) 26%,transparent)}
tbody tr.mc-large td{background:color-mix(in srgb,var(--mc-large) 18%,transparent)}
tbody tr.mc-mid   td{background:color-mix(in srgb,var(--mc-mid) 10%,transparent)}
tbody tr.mc-micro,tbody tr.mc-unknown{opacity:.5}
tbody tr.mc-mega  td:first-child{box-shadow:inset 3px 0 0 var(--mc-mega)}
tbody tr.mc-large td:first-child{box-shadow:inset 3px 0 0 var(--mc-large)}
tbody tr.mc-mid   td:first-child{box-shadow:inset 3px 0 0 var(--mc-mid)}
tbody tr.mc-small td:first-child{box-shadow:inset 3px 0 0 var(--mc-small)}
tbody tr.mc-micro td:first-child,tbody tr.mc-unknown td:first-child{box-shadow:inset 3px 0 0 var(--mc-micro)}
tbody tr.mc-mega  .mcap{color:var(--mc-mega);font-weight:700}
tbody tr.mc-large .mcap{color:var(--mc-large);font-weight:600}
tbody tr.mc-mid   .mcap{color:var(--mc-mid)}
.legend{display:flex;gap:.9rem;flex-wrap:wrap;font-size:.68rem;color:var(--muted);margin:.2rem 0 .6rem}
.legend .k{display:inline-flex;align-items:center;gap:.3rem}
.legend .sw{width:.7rem;height:.7rem;border-radius:2px;display:inline-block}
</style></head><body><div class="wrap">
<header>
  <div class="logo"><span class="dot"></span>Insider Tracker</div>
  <span class="tag">SEC Form 4 · insider open-market purchases</span>
</header>

${reportCard}

${renderBoards(boards)}

<section class="kpi">
  ${tile("Companies", num(s.companies), "--accent", "distinct tickers")}
  ${tile("Total Bought", money(s.buyValue), "--buy", num(s.buys) + " buys (code P)")}
  ${tile("Avg / Company", money(s.companies ? s.buyValue / s.companies : 0), "--accent")}
  ${tile("Top Ticker Buy", money(s.maxBuy), "--buy", s.maxTicker || "")}
</section>


<form class="card" method="get" action="/">
  <label>Ticker<input name="ticker" value="${esc(f.ticker || "")}" placeholder="AAPL" size="8"></label>
  <label>Insider<input name="insider" value="${esc(f.insider || "")}" placeholder="name" size="14"></label>
  <label>Min $ value<input name="min_value" value="${f.minValue ?? ""}" placeholder="100000" size="10"></label>
  <label>Min mkt cap<input name="min_market_cap" value="${f.minMarketCap ?? ""}" placeholder="100000000" size="12"></label>
  <label>Limit<input name="limit" value="${f.limit}" size="5"></label>
  <button type="submit">Filter</button>
  <a class="reset" href="/">reset</a>
</form>

<div class="count">${num(s.companies)} companies · ${num(s.buys)} buys</div>
<div class="legend">
  <span class="k"><span class="sw" style="background:var(--mc-mega)"></span>Mega ≥$200B</span>
  <span class="k"><span class="sw" style="background:var(--mc-large)"></span>Large ≥$10B</span>
  <span class="k"><span class="sw" style="background:var(--mc-mid)"></span>Mid ≥$2B</span>
  <span class="k"><span class="sw" style="background:var(--mc-small)"></span>Small ≥$300M</span>
  <span class="k"><span class="sw" style="background:var(--mc-micro)"></span>Micro / —</span>
</div>
<div class="card tablecard"><table><thead><tr>
<th>Latest Filed</th><th>Ticker / Mkt Cap</th><th>Company</th>
<th class="n">Insiders</th><th class="n">Buys</th><th>AI</th>
<th class="n">Avg Price</th><th class="n">Total Qty</th><th class="n">Total Value</th>
</tr></thead><tbody>${bodyRows}</tbody></table></div>
</div></body></html>`;
}
