// Shared D1 query + HTML rendering for the insider tracker.
// Files prefixed with "_" are not routed by Cloudflare Pages.

const CODE_LABELS = {
  P: "P · Purchase",
  S: "S · Sale",
  A: "A · Grant/Award",
  M: "M · Option Exercise",
  F: "F · Tax Withholding",
  G: "G · Gift",
};

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
    showSells: g("show_sells") !== null, // checkbox: absent = buys only (default)
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
  if (!f.showSells) {
    where.push("t.transaction_code = 'P'"); // open-market purchases only by default
  }
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

// Latest AI daily report (most recent report_date) plus its per-company picks.
export async function latestReport(db) {
  try {
    const row = await db
      .prepare("SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1")
      .first();
    if (!row) return null;
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

// Roll up the shown rows into headline stats.
function computeStats(rows) {
  let buyValue = 0,
    sellValue = 0,
    buys = 0,
    sells = 0;
  for (const r of rows) {
    const v = Number(r.value) || 0;
    if (r.acquired_disposed === "A") {
      buyValue += v;
      buys++;
    } else if (r.acquired_disposed === "D") {
      sellValue += v;
      sells++;
    }
  }
  return {
    count: rows.length,
    buys,
    sells,
    buyValue,
    sellValue,
    net: buyValue - sellValue,
  };
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
export function renderPage(rows, f, report) {
  const s = computeStats(rows);
  const flowTotal = s.buyValue + s.sellValue || 1;
  const buyPct = (s.buyValue / flowTotal) * 100;

  const codeOptions = Object.entries(CODE_LABELS)
    .map(
      ([c, lbl]) =>
        `<option value="${c}" ${f.code === c ? "selected" : ""}>${lbl}</option>`
    )
    .join("");

  const bodyRows = rows.length
    ? rows
        .map((r) => {
          let badge, rowClass;
          if (r.acquired_disposed === "A") {
            badge = `<span class="badge buy">▲ BUY</span>`;
            rowClass = "buy";
          } else if (r.acquired_disposed === "D") {
            badge = `<span class="badge sell">▼ SELL</span>`;
            rowClass = "sell";
          } else {
            badge = `<span class="badge neutral">${esc(r.transaction_code)}</span>`;
            rowClass = "";
          }
          return `<tr class="${rowClass}">
            <td class="dim">${esc(r.filing_date)}</td>
            <td class="dim">${esc(r.trade_date || "")}</td>
            <td class="tk">
              <span class="ticker">${esc(r.ticker || "—")}</span>
              <span class="mcap">${bcap(r.eff_mktcap)}</span>
            </td>
            <td>${badge}</td>
            <td class="co">${esc(r.company_name)}</td>
            <td>${esc(r.insider_name)}</td>
            <td class="dim">${esc(r.insider_title)}</td>
            <td class="dim">${esc(r.transaction_code)}</td>
            <td>${aiCell(r)}</td>
            <td class="n">${r.price != null ? "$" + Number(r.price).toFixed(2) : ""}</td>
            <td class="n">${num(r.shares)}</td>
            <td class="n val">${r.value != null ? money(r.value) : ""}</td>
            <td class="n dim">${num(r.shares_owned_after)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="13" class="empty">No transactions match your filters.</td></tr>`;

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
/* flow bar */
.flow{padding:1rem 1.15rem;margin-bottom:1.1rem}
.flow-head{display:flex;justify-content:space-between;font-size:.72rem;color:var(--ink2);margin-bottom:.5rem}
.flow-bar{height:12px;border-radius:99px;overflow:hidden;display:flex;background:var(--sell)}
.flow-bar>i{display:block;height:100%;background:var(--buy)}
.flow-legend{display:flex;gap:1.2rem;margin-top:.55rem;font-size:.74rem;color:var(--ink2)}
.chip{display:inline-flex;align-items:center;gap:.4rem}
.chip::before{content:"";width:.6rem;height:.6rem;border-radius:2px}
.chip.b::before{background:var(--buy)}.chip.s::before{background:var(--sell)}
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
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--glass)}
td.n{text-align:right;font-variant-numeric:tabular-nums}
td.dim{color:var(--muted)}
td.co{max-width:220px;overflow:hidden;text-overflow:ellipsis}
td.val{font-weight:600}
td.tk{line-height:1.2}
.ticker{display:block;font-weight:700;letter-spacing:.02em;color:var(--accent)}
.mcap{display:block;font-size:.68rem;color:var(--muted);font-variant-numeric:tabular-nums}
.code{color:var(--muted);font-size:.72rem}
tbody tr.buy td:first-child{box-shadow:inset 3px 0 0 var(--buy)}
tbody tr.sell td:first-child{box-shadow:inset 3px 0 0 var(--sell)}
.badge{display:inline-block;padding:.12rem .45rem;border-radius:6px;font-size:.68rem;font-weight:700;letter-spacing:.04em}
.badge.buy{color:var(--buy);background:color-mix(in srgb,var(--buy) 16%,transparent)}
.badge.sell{color:var(--sell);background:color-mix(in srgb,var(--sell) 16%,transparent)}
.badge.neutral{color:var(--ink2);background:var(--glass)}
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
.pick-comment{font-size:.85rem;line-height:1.45;color:var(--ink)}
.ai{display:inline-block;min-width:1.8rem;text-align:center;padding:.1rem .4rem;border-radius:6px;
  font-weight:700;font-size:.72rem;cursor:help}
.ai.hi{color:var(--buy);background:color-mix(in srgb,var(--buy) 18%,transparent)}
.ai.mid{color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent)}
.ai.lo{color:var(--muted);background:var(--glass)}
</style></head><body><div class="wrap">
<header>
  <div class="logo"><span class="dot"></span>Insider Tracker</div>
  <span class="tag">SEC Form 4 · insider buys &amp; sells</span>
</header>

${reportCard}

<section class="kpi">
  ${tile("Transactions", num(s.count), "--accent")}
  ${tile("Buy Volume", money(s.buyValue), "--buy", `${s.buys} purchase${s.buys === 1 ? "" : "s"}`)}
  ${tile("Sell Volume", money(s.sellValue), "--sell", `${s.sells} sale${s.sells === 1 ? "" : "s"}`)}
  ${tile("Net Flow", money(s.net), s.net >= 0 ? "--buy" : "--sell", s.net >= 0 ? "net buying" : "net selling")}
</section>

<section class="card flow">
  <div class="flow-head"><span>Buy vs Sell $ (shown rows)</span><span>${buyPct.toFixed(0)}% buys</span></div>
  <div class="flow-bar"><i style="width:${buyPct}%"></i></div>
  <div class="flow-legend"><span class="chip b">Buys ${money(s.buyValue)}</span><span class="chip s">Sells ${money(s.sellValue)}</span></div>
</section>

<form class="card" method="get" action="/">
  <label>Ticker<input name="ticker" value="${esc(f.ticker || "")}" placeholder="AAPL" size="8"></label>
  <label>Insider<input name="insider" value="${esc(f.insider || "")}" placeholder="name" size="14"></label>
  <label>Type<select name="code"><option value="">Any</option>${codeOptions}</select></label>
  <label>Min $ value<input name="min_value" value="${f.minValue ?? ""}" placeholder="100000" size="10"></label>
  <label>Min mkt cap<input name="min_market_cap" value="${f.minMarketCap ?? ""}" placeholder="100000000" size="12"></label>
  <label>Limit<input name="limit" value="${f.limit}" size="5"></label>
  <label class="check"><input type="checkbox" name="show_sells" value="1" ${f.showSells ? "checked" : ""}> Show all types (sells, grants…)</label>
  <button type="submit">Filter</button>
  <a class="reset" href="/">reset</a>
</form>

<div class="count">${num(s.count)} transaction(s)</div>
<div class="card tablecard"><table><thead><tr>
<th>Filed</th><th>Trade</th><th>Ticker / Mkt Cap</th><th>B/S</th><th>Company</th><th>Insider</th><th>Title</th>
<th>Code</th><th>AI</th><th class="n">Price</th><th class="n">Qty</th><th class="n">Value</th><th class="n">Owned After</th>
</tr></thead><tbody>${bodyRows}</tbody></table></div>
</div></body></html>`;
}
