// D1 query + HTML rendering for the A-share page (`/cn`): 董监高增持 (mainland
// China directors/supervisors/senior-management share purchases, from 东方财富).
//
// Reads its own `cn_*` tables and owns its own CNY formatting + Chinese copy, so
// nothing here can change what the US page (`/`) shows. Only the theme/CSS and
// the market-agnostic leaderboard machinery are shared, via _shared.js.
// Files prefixed with "_" are not routed by Cloudflare Pages.
import {
  PAGE_CSS,
  PAGE_SCRIPT,
  THEME_BOOT,
  aiCell,
  aiPill,
  esc,
  loadBoards,
  marketSwitch,
  mcapTier,
  num,
  renderBoards,
  tile,
} from "./_shared.js";

export { parseFilters, serveCached } from "./_shared.js";

// Baseline market-cap floor for the table: hide companies below this (or with no
// cap). The 最小市值 filter can only raise it, never lower it. ¥50亿 ≈ $700M —
// scaled to the A-share cap distribution rather than copying the US $1B.
const MIN_DISPLAY_MKTCAP = 5e9; // ¥50亿

// Descending [threshold, tier class]. Thresholds are the US ones converted at a
// rough ¥7/$ and rounded to the round numbers A-share investors actually use:
// 超大 ≥¥1万亿, 大 ≥¥500亿, 中 ≥¥100亿, 小 ≥¥30亿, else 微型/未知.
const MCAP_TIERS = [
  [1e12, "mc-mega"],
  [5e10, "mc-large"],
  [1e10, "mc-mid"],
  [3e9, "mc-small"],
];

// Per-transaction rows for the JSON API. `ticker` here is the 6-digit 股票代码.
export async function queryTransactions(db, f) {
  const where = [];
  const binds = [];
  if (f.ticker) {
    where.push("t.code = ?");
    binds.push(f.ticker);
  }
  if (f.insider) {
    where.push("t.insider_name LIKE ?");
    binds.push(`%${f.insider}%`);
  }
  if (f.minValue !== null) {
    where.push("t.value >= ?");
    binds.push(f.minValue);
  }
  if (f.minMarketCap !== null) {
    where.push("COALESCE(c.market_cap, t.market_cap) >= ?");
    binds.push(f.minMarketCap);
  }
  let sql =
    "SELECT t.*, COALESCE(c.market_cap, t.market_cap) AS eff_mktcap, " +
    "a.score AS ai_score, a.rating AS ai_rating, a.comment AS ai_comment " +
    "FROM cn_transactions t " +
    "LEFT JOIN cn_companies c ON c.code = t.code " +
    "LEFT JOIN cn_ai_scores a ON a.change_id = t.change_id";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY t.change_date DESC, t.value DESC LIMIT ?";
  binds.push(f.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return results || [];
}

// Per-company rollup for the HTML table: one row per 股票代码, summing 增持金额
// and 增持笔数 across the retention window (mirrors the US page's rolled-up view).
export async function queryTickerRollup(db, f) {
  const where = [];
  const having = [];
  const binds = [];
  if (f.ticker) {
    // Accept a code fragment or a company-name fragment — A-share users search
    // by name at least as often as by code.
    where.push("(t.code LIKE ? OR t.company_name LIKE ?)");
    binds.push(`%${f.ticker}%`, `%${f.ticker}%`);
  }
  if (f.insider) {
    where.push("t.insider_name LIKE ?");
    binds.push(`%${f.insider}%`);
  }
  const mcapFloor = Math.max(MIN_DISPLAY_MKTCAP, f.minMarketCap ?? 0);
  having.push("COALESCE(c.market_cap, MAX(t.market_cap)) >= ?");
  if (f.minValue !== null) having.push("SUM(t.value) >= ?");

  // Best AI pick per company (highest score) drives the score pill + detail row.
  const bestPick =
    "(SELECT a2.%COL% FROM cn_ai_scores a2 " +
    "JOIN cn_transactions t2 ON t2.change_id = a2.change_id " +
    "WHERE t2.code = t.code ORDER BY a2.score DESC LIMIT 1)";
  let sql =
    "SELECT MAX(t.change_date) AS change_date, " +
    "t.code AS code, MAX(t.company_name) AS company_name, MAX(t.exchange) AS exchange, " +
    "COUNT(*) AS buy_count, COUNT(DISTINCT t.insider_name) AS insider_count, " +
    "SUM(t.shares) AS shares, SUM(t.value) AS value, " +
    "CASE WHEN SUM(t.shares) > 0 THEN SUM(t.value) / SUM(t.shares) END AS avg_price, " +
    "COALESCE(c.market_cap, MAX(t.market_cap)) AS eff_mktcap, " +
    "MAX(a.score) AS ai_score, " +
    bestPick.replace("%COL%", "rating") + " AS ai_rating, " +
    bestPick.replace("%COL%", "comment") + " AS ai_comment " +
    "FROM cn_transactions t " +
    "LEFT JOIN cn_companies c ON c.code = t.code " +
    "LEFT JOIN cn_ai_scores a ON a.change_id = t.change_id";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " GROUP BY t.code HAVING " + having.join(" AND ");
  binds.push(mcapFloor); // matches the first HAVING condition
  if (f.minValue !== null) binds.push(f.minValue);
  sql += " ORDER BY MAX(t.change_date) DESC, SUM(t.value) DESC LIMIT ?";
  binds.push(f.limit);

  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return results || [];
}

export function leaderboards(db) {
  return loadBoards(db, "cn_leaderboard");
}

// A report older than this many days behind the freshest data day is dropped, so a
// prolonged AI outage shows nothing rather than stale commentary. One day of slack
// is needed regardless: the pre-open run's freshest 变动日期 is usually yesterday's.
const REPORT_MAX_AGE_DAYS = 3;
const REPORT_MAX_PICKS = 12;

// Latest AI daily report, with the best-scored pick per company as its picks.
//
// The picks span the whole retained window rather than the report's own day:
// scoring is windowed (see scraper/cn_ai_report.py), so a record disclosed late is
// scored under a later report_date than its 变动日期 — keying the picks to
// report_date would hide exactly those records.
export async function latestReport(db) {
  try {
    const row = await db
      .prepare("SELECT * FROM cn_daily_reports ORDER BY report_date DESC LIMIT 1")
      .first();
    if (!row) return null;
    const latest = await db
      .prepare("SELECT MAX(change_date) AS d FROM cn_transactions")
      .first();
    if (latest && latest.d) {
      const ageDays = (Date.parse(latest.d) - Date.parse(row.report_date)) / 864e5;
      if (ageDays > REPORT_MAX_AGE_DAYS) return null; // stale
    }
    const { results } = await db
      .prepare(
        "SELECT t.code, t.company_name, t.insider_name, t.value, t.change_date, " +
          "a.score, a.rating, a.comment " +
          "FROM cn_ai_scores a " +
          "JOIN cn_transactions t ON t.change_id = a.change_id " +
          "WHERE a.score IS NOT NULL " +
          "ORDER BY a.score DESC, t.change_date DESC, t.value DESC"
      )
      .all();
    // One block per company (dedupe by code; rows are score-desc ordered).
    const seen = new Set();
    row.picks = (results || [])
      .filter((p) => {
        if (seen.has(p.code)) return false;
        seen.add(p.code);
        return true;
      })
      .slice(0, REPORT_MAX_PICKS);
    return row;
  } catch {
    return null; // tables may not exist yet
  }
}

// 市值: ¥1.53万亿 / ¥56.70亿. Always 亿元 or above, matching A-share convention.
function bcap(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (Math.abs(n) >= 1e12) return `¥${(n / 1e12).toFixed(2)}万亿`;
  return `¥${(n / 1e8).toFixed(2)}亿`;
}

// 金额: ¥7.71亿 / ¥1234.5万 / ¥7,710.
function money(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}¥${(abs / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${sign}¥${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}¥${(abs / 1e4).toFixed(1)}万`;
  return `${sign}¥${num(abs)}`;
}

function px(v) {
  return v == null ? "—" : `¥${Number(v).toFixed(2)}`;
}

const FMT = { money, px };
const LABELS = {
  boardTitle: "🏆 AI 榜单",
  boardEmpty: "暂无评分的增持记录。",
  tabs: { daily: "日", weekly: "周", quarterly: "季", yearly: "年" },
  colTicker: "代码 / 名称",
  colEntry: "入选价 / 日期",
  colNow: "现价",
  colGain: "涨幅",
  colBought: "增持额",
};

// Headline stats over the rolled-up (per-company) rows.
function computeStats(rows) {
  let buyValue = 0,
    buys = 0,
    maxBuy = 0,
    maxCode = "";
  for (const r of rows) {
    const v = Number(r.value) || 0;
    buyValue += v;
    buys += Number(r.buy_count) || 0;
    if (v > maxBuy) {
      maxBuy = v;
      maxCode = r.company_name || r.code || "";
    }
  }
  return { companies: rows.length, buys, buyValue, maxBuy, maxCode };
}

// Render the full A-share page.
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
            <td class="dim">${esc(r.change_date)}</td>
            <td class="tk" data-v="${r.eff_mktcap ?? -1}">
              <span class="ticker">${esc(r.code || "—")}</span>
              <span class="mcap">${bcap(r.eff_mktcap)}</span>
            </td>
            <td class="co">${esc(r.company_name)}</td>
            <td class="n" data-v="${r.insider_count ?? 0}">${num(r.insider_count)}</td>
            <td class="n" data-v="${r.buy_count ?? 0}">${num(r.buy_count)}</td>
            <td data-v="${r.ai_score ?? -1}">${aiCell(r)}</td>
            <td class="n" data-v="${r.avg_price ?? -1}">${r.avg_price != null ? "¥" + Number(r.avg_price).toFixed(2) : ""}</td>
            <td class="n" data-v="${r.shares ?? -1}">${num(r.shares)}</td>
            <td class="n val" data-v="${r.value ?? -1}">${r.value != null ? money(r.value) : ""}</td>
          </tr>${detail}`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">没有符合筛选条件的增持记录。</td></tr>`;

  const pickBlocks = (report && report.picks ? report.picks : [])
    .map(
      (p) => `<div class="pick">
        <div class="pick-head">
          <span class="ticker">${esc(p.code || "—")}</span>
          <span class="pick-co">${esc(p.company_name || "")}</span>
          ${aiPill(p.score, { rating: p.rating, comment: p.comment })}
          ${p.rating ? `<span class="pick-rating">${esc(p.rating)}</span>` : ""}
          ${p.change_date ? `<span class="dim">${esc(p.change_date)}</span>` : ""}
        </div>
        <div class="pick-comment">${esc(p.comment || "")}</div>
      </div>`
    )
    .join("");

  const reportCard = report && (report.summary || pickBlocks)
    ? `<section class="card report">
        <div class="report-head">🤖 AI 每日复盘 <span class="dim">· ${esc(
          report.report_date
        )}</span></div>
        ${report.summary ? `<div class="report-body">${esc(report.summary)}</div>` : ""}
        ${pickBlocks ? `<div class="picks">${pickBlocks}</div>` : ""}
        <div class="report-foot">由 ${esc(
          report.model || "Gemini"
        )} 生成 · 仅供参考，非投资建议</div>
      </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A股董监高增持追踪</title>
${THEME_BOOT}
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<header>
  <div class="logo"><span class="dot"></span>A股增持追踪</div>
  <span class="tag">董监高二级市场增持 · 数据来源东方财富</span>
  ${marketSwitch("cn")}
  <button class="theme-btn" id="themeBtn" type="button" aria-label="切换深浅色主题" title="切换主题">🌗</button>
</header>

${reportCard}

${renderBoards(boards, FMT, LABELS)}

<section class="kpi">
  ${tile("公司数", num(s.companies), "--accent", "不同股票代码")}
  ${tile("增持总额", money(s.buyValue), "--buy", num(s.buys) + " 笔增持")}
  ${tile("户均增持", money(s.companies ? s.buyValue / s.companies : 0), "--accent")}
  ${tile("单公司最高", money(s.maxBuy), "--buy", esc(s.maxCode || ""))}
</section>


<form class="card" method="get" action="/cn">
  <label>代码 / 名称<input name="ticker" value="${esc(f.ticker || "")}" placeholder="600826 或 兰生" size="12"></label>
  <label>增持人<input name="insider" value="${esc(f.insider || "")}" placeholder="姓名" size="10"></label>
  <label>最小金额<input name="min_value" value="${f.minValue ?? ""}" placeholder="1000000 (100万)" size="12"></label>
  <label>最小市值<input name="min_market_cap" value="${f.minMarketCap ?? ""}" placeholder="5000000000 (50亿)" size="14"></label>
  <label>条数<input name="limit" value="${f.limit}" size="5"></label>
  <button type="submit">筛选</button>
  <a class="reset" href="/cn">重置</a>
</form>

<div class="count">${num(s.companies)} 家公司 · ${num(s.buys)} 笔增持${
  rows.length
    ? ` · 数据截至 ${esc(
        rows.reduce((m, r) => (r.change_date > m ? r.change_date : m), rows[0].change_date)
      )}`
    : ""
} · 每日更新</div>
<div class="legend">
  <span class="k"><span class="sw" style="background:var(--mc-mega)"></span>超大 ≥¥1万亿</span>
  <span class="k"><span class="sw" style="background:var(--mc-large)"></span>大盘 ≥¥500亿</span>
  <span class="k"><span class="sw" style="background:var(--mc-mid)"></span>中盘 ≥¥100亿</span>
  <span class="k"><span class="sw" style="background:var(--mc-small)"></span>小盘 ≥¥30亿</span>
  <span class="k"><span class="sw" style="background:var(--mc-micro)"></span>微盘 / —</span>
</div>
<div class="card tablecard"><table><thead><tr>
<th data-type="text">最近变动</th><th data-type="num">代码 / 市值</th><th data-type="text">公司</th>
<th class="n" data-type="num">增持人数</th><th class="n" data-type="num">笔数</th><th data-type="num">AI</th>
<th class="n" data-type="num">均价</th><th class="n" data-type="num">总股数</th><th class="n" data-type="num">增持总额</th>
</tr></thead><tbody>${bodyRows}</tbody></table></div>

<footer class="card disclaimer">
  <b>免责声明</b>
  <p>本页数据来自公开的 A 股上市公司<strong>董监高持股变动</strong>披露（经东方财富数据接口聚合），仅供信息参考。此类披露是依法定要求公开的信息，不属于任何内幕信息。</p>
  <p>本站所有内容——包括 AI 生成的评分、评级与点评——均不构成投资建议、推荐或任何证券的买卖要约，也不代表本站观点。市值等数据为估算值，可能存在延迟或误差，本站不对其准确性、完整性或及时性作任何保证。</p>
  <p>投资有风险，决策请自行研究并独立判断。本站与中国证监会、交易所及任何券商均无关联，不对因使用本站信息而产生的任何损失承担责任。</p>
</footer>
${PAGE_SCRIPT}
</div></body></html>`;
}
