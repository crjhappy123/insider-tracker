// D1 queries + HTML for the 博主汇总 pages, built from finance YouTubers' analyzed
// videos (scraper/yt_ingest.py) and the daily macro reports (scraper/yt_macro.py):
//   /yt          个股观点 — every stock call made on a day, one row per creator and stock
//   /yt/macro    宏观报告 — the day's AI macro report plus each creator's one-line view
//   /yt/heatmap  热力图   — which stocks creators called on a day or week, and which way
// Dates are yt_videos.publish_date (UTC), the same day key the macro reports use.
// Files prefixed with "_" are not routed by Cloudflare Pages.
import { esc, renderShell } from "./_shared.js";

export { serveCached } from "./_shared.js";

const STANCES = ["看多", "看空", "中性"];
const STANCE_CLASS = { 看多: "bull", 看空: "bear", 中性: "flat" };
const STANCE_RANK = { 看多: 2, 中性: 1, 看空: 0 };
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_DAYS = 7;
const DATE_LIMIT = 60; // days offered in the date picker
const VIDEO_LIMIT = 500; // videos read for one page; a week is ~100
const BOARD_MAX = 15; // per side of the recommendation board
const HEAT_MAX = 40; // tiles on the heat map

const YT_CSS = `
/* toolbar: date navigator + filters */
.toolbar{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center;margin-bottom:1rem}
.page-head .toolbar{margin:0 0 0 auto}
.datenav{display:flex;align-items:center;gap:.3rem}
.dn-btn{width:30px;height:40px;display:grid;place-items:center;color:var(--ink);border-radius:8px;text-decoration:none}
.dn-btn:hover{background:var(--hover)}
.dn-btn.off{color:var(--muted);opacity:.35}
.dn-select{width:10.5rem;height:40px;text-align:center;text-align-last:center;cursor:pointer;
  font-variant-numeric:tabular-nums}
.dn-empty{display:grid;place-items:center;color:var(--muted);border:1px solid var(--border);border-radius:10px;
  background:var(--surface);font-size:.85rem}
.tb-select,.tb-search{height:40px;flex:1 1 220px;min-width:0}
.seg{display:inline-flex;gap:.2rem;padding:.2rem;background:var(--surface);border:1px solid var(--border);border-radius:10px}
.seg a{padding:.42rem .9rem;border-radius:8px;font-size:.85rem;color:var(--ink2);text-decoration:none;white-space:nowrap}
.seg a.on{background:var(--accent);color:#fff;font-weight:600}
/* stance and score pills */
.stance{display:inline-block;padding:.1rem .45rem;border-radius:6px;font-size:.72rem;font-weight:700;white-space:nowrap}
.stance.bull{color:var(--buy);background:color-mix(in srgb,var(--buy) 14%,transparent)}
.stance.bear{color:var(--sell);background:color-mix(in srgb,var(--sell) 14%,transparent)}
.stance.flat{color:var(--muted);background:var(--glass)}
.ai.mid{color:var(--ink2);background:var(--glass)}
.ai.bear{color:var(--sell);background:color-mix(in srgb,var(--sell) 14%,transparent)}
/* day summary line */
.daystats{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem 1.1rem;margin:0 0 .8rem;font-size:.82rem;color:var(--ink2)}
.daystats b{color:var(--ink);font-size:.95rem}
.ds-mood{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.3rem}
.ds-link{margin-left:auto;color:var(--accent);font-weight:600;text-decoration:none}
.ds-link:hover{text-decoration:underline}
/* calls table */
table.calls td{vertical-align:top}
table.calls tr.alt td{background-image:none}
table.calls tr.alt{background-image:linear-gradient(var(--zebra),var(--zebra))}
td.stk .ticker{font-size:.95rem}
.stk-name{margin-right:.35rem;font-size:.74rem;color:var(--muted)}
.rec-cat{display:inline-block;margin-top:.2rem;padding:.04rem .4rem;border-radius:6px;font-size:.68rem;font-weight:600;
  color:var(--accent);background:var(--accent-soft)}
td.who a{color:var(--ink);font-weight:600;text-decoration:none}
td.who a:hover{color:var(--accent);text-decoration:underline}
td.why{white-space:normal;min-width:18rem;line-height:1.6;color:var(--ink2)}
.call-price{margin-right:.4rem;color:var(--accent);font-weight:700}
@media (max-width:700px){
  table.calls thead{display:none}
  table.calls,table.calls tbody{display:block}
  table.calls tr{display:grid;grid-template-columns:minmax(0,1fr) auto auto;
    grid-template-areas:"stk st sc" "who who who" "why why why";gap:.35rem .6rem;padding:.8rem .9rem;
    border-bottom:1px solid var(--border)}
  table.calls tr:last-child{border-bottom:none}
  table.calls tr.none{display:block}
  table.calls td{display:block;min-width:0;padding:0;border:none}
  td.stk{grid-area:stk} td.st{grid-area:st} td.sc{grid-area:sc}
  td.who{grid-area:who;font-size:.8rem} td.why{grid-area:why}
}
/* video cards */
.sec-title{display:flex;align-items:center;gap:.5rem;margin:1.5rem 0 .75rem;font-size:.98rem;font-weight:700}
.sec-title .dim{font-weight:500;color:var(--muted)}
.videos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr));gap:.8rem}
.video{padding:.95rem 1.1rem}
.video-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.35rem}
.channel{font-size:.8rem;font-weight:700;color:var(--ink2)}
.video-title{display:block;margin-bottom:.45rem;font-size:.95rem;font-weight:700;line-height:1.45;color:var(--ink);text-decoration:none}
.video-title:hover{color:var(--accent)}
.video-summary{margin-bottom:.35rem;font-size:.88rem;line-height:1.6;color:var(--ink)}
.video-views{font-size:.82rem;line-height:1.65;color:var(--ink2);white-space:pre-wrap}
/* macro report */
.macro-hero{padding:1.25rem 1.4rem;margin-bottom:1rem}
.mh-top{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.6rem}
.mh-meta{font-size:.8rem;color:var(--muted)}
.mh-headline{margin:0 0 1rem;font-size:1.35rem;line-height:1.45;font-weight:800;letter-spacing:-.01em}
.mh-pending{margin:0 0 1rem;font-size:.9rem;line-height:1.6;color:var(--ink2)}
.mh-mood{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}
.mh-label{font-size:.78rem;font-weight:600;color:var(--muted)}
.moodbar{flex:1 1 260px;display:flex;gap:2px;height:26px;border-radius:8px;overflow:hidden;font-size:.74rem;font-weight:700}
.moodbar span{display:flex;align-items:center;justify-content:center;min-width:3.2rem;padding:0 .4rem;
  white-space:nowrap;overflow:hidden}
.mb-bull{background:var(--buy);color:#fff}
.mb-bear{background:var(--sell);color:#fff}
.mb-flat{background:var(--thead);color:var(--ink2)}
.date-badge{padding:.18rem .6rem;border:1.5px solid var(--ink);border-radius:8px;font-size:.8rem;font-weight:700;
  font-variant-numeric:tabular-nums}
.macro-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-bottom:1rem}
.mblock{padding:1.05rem 1.25rem}
.mblock.wide{grid-column:1/-1}
.mblock h3,.voices h3,.board h3{margin:0 0 .65rem;font-size:.98rem;font-weight:700}
.mblock p{margin:0;font-size:.9rem;line-height:1.75;color:var(--ink2)}
.mblock ul{margin:0;padding-left:1.15rem;font-size:.88rem;line-height:1.7;color:var(--ink2)}
.mblock li+li{margin-top:.3rem}
.sectors{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:.6rem}
.sector{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .45rem;padding:.65rem .8rem;
  border:1px solid var(--border);border-radius:10px;font-size:.85rem;line-height:1.55}
.sector b{font-weight:700}
.sector-note{flex-basis:100%;color:var(--ink2)}
.voices{padding:1.05rem 1.25rem;margin-bottom:1rem}
.voice{display:flex;align-items:baseline;gap:.6rem;padding:.6rem 0;border-top:1px solid var(--border);
  font-size:.86rem;line-height:1.6}
.voice:first-of-type{border-top:none}
.voice-ch{flex:none;min-width:8em;font-weight:700;color:var(--ink);text-decoration:none}
.voice-ch:hover{color:var(--accent)}
.voice-sum{color:var(--ink2)}
.blank{display:grid;place-items:center;min-height:55vh;font-size:1.25rem;color:var(--muted);text-align:center}
@media (max-width:760px){
  .macro-grid{grid-template-columns:1fr}
  .voice{flex-wrap:wrap;gap:.3rem .6rem}
  .voice-ch{min-width:0}
  .voice-sum{flex-basis:100%}
  .mh-headline{font-size:1.15rem}
}
/* heat map (squarified treemap; one layout per orientation) */
.heat{padding:.45rem;margin-bottom:.7rem}
.heat-box{position:relative;width:100%;overflow:hidden;border-radius:10px}
.heat-box.wide{aspect-ratio:16/10}
.heat-box.tall{aspect-ratio:9/13;display:none}
@media (max-width:700px){.heat-box.wide{display:none}.heat-box.tall{display:block}}
.ht{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.12em;
  padding:.25em;border:2px solid var(--surface);border-radius:10px;color:var(--ink);text-decoration:none;
  text-align:center;line-height:1.15;overflow:hidden}
.ht.strong{color:#fff}
.ht:hover{filter:brightness(1.07) saturate(1.1)}
.ht-tk{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800}
.ht-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.9}
.ht-meta{max-width:100%;overflow:hidden;white-space:nowrap;font-size:11px;opacity:.85}
.heat-legend{display:flex;flex-wrap:wrap;gap:.4rem 1rem;margin-bottom:1.2rem;font-size:.76rem;color:var(--muted)}
.heat-legend span{display:inline-flex;align-items:center;gap:.35rem}
.heat-legend i{width:.8rem;height:.8rem;border-radius:3px}
/* recommendation board */
.board{padding:1.05rem 1.25rem;margin-bottom:1rem}
.board-range{margin-left:.4rem;font-size:.76rem;font-weight:500;color:var(--muted)}
.bside{margin:.9rem 0 .5rem;font-size:.88rem;font-weight:700}
.bside.bull{color:var(--buy)}
.bside.bear{color:var(--sell)}
.bside.split{color:var(--ink2)}
.rec{padding:.7rem .85rem;margin-bottom:.5rem;border:1px solid var(--border);border-radius:10px}
.rec-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem}
.rec-head .ticker{display:inline-block;font-size:1.02rem}
.rec-head .rec-cat{margin-top:0}
.rec-name{font-size:.78rem;color:var(--muted)}
.rec-count{margin-left:auto;font-size:.74rem;color:var(--muted)}
.call{font-size:.82rem;line-height:1.6;color:var(--ink2)}
.call b{color:var(--ink);font-weight:600}
`;

// ---------- filters & queries ----------

export function parseFilters(url) {
  const g = (k) => (url.searchParams.get(k) || "").trim() || null;
  const date = g("date");
  return {
    date: date && DATE_RE.test(date) ? date : null,
    channel: g("channel"),
    q: g("q"),
    range: g("range") === "w" ? "w" : "d",
  };
}

async function rows(db, sql, binds = []) {
  try {
    const stmt = db.prepare(sql);
    const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
    return results || [];
  } catch {
    return []; // table may not exist yet
  }
}

// Days with at least one analyzed video, newest first.
export async function queryDates(db) {
  const r = await rows(
    db,
    "SELECT DISTINCT publish_date AS d FROM yt_videos WHERE stance IS NOT NULL ORDER BY d DESC LIMIT ?",
    [DATE_LIMIT]
  );
  return r.map((x) => x.d);
}

// Days with a macro report, newest first. Reports outlive the 30-day video prune.
export async function queryMacroDates(db) {
  const r = await rows(
    db,
    "SELECT report_date AS d FROM yt_macro_reports ORDER BY d DESC LIMIT ?",
    [DATE_LIMIT]
  );
  return r.map((x) => x.d);
}

export function queryChannels(db) {
  return rows(
    db,
    "SELECT channel_id, MAX(channel_name) AS channel_name FROM yt_videos " +
      "WHERE stance IS NOT NULL GROUP BY channel_id ORDER BY channel_name"
  );
}

// Analyzed videos published from `start` to `end` (inclusive), newest first.
export function queryVideos(db, start, end, channel = null) {
  const where = ["stance IS NOT NULL", "publish_date BETWEEN ? AND ?"];
  const binds = [start, end];
  if (channel) {
    where.push("channel_id = ?");
    binds.push(channel);
  }
  binds.push(VIDEO_LIMIT);
  return rows(
    db,
    `SELECT * FROM yt_videos WHERE ${where.join(" AND ")} ORDER BY published_at DESC LIMIT ?`,
    binds
  );
}

export async function queryMacro(db, date) {
  try {
    return await db.prepare("SELECT * FROM yt_macro_reports WHERE report_date = ?").bind(date).first();
  } catch {
    return null;
  }
}

// ---------- shared helpers ----------

// First day of the week-long window that ends on `d`.
export function weekStart(d) {
  return shiftDate(d, -(WEEK_DAYS - 1));
}

export function shiftDate(d, days) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const dayLabel = (d) => `${d.slice(5)} ${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}`;
const monthDay = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const videoUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

function href(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const ARROW = {
  prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 3 5 12l12 9z"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 3l12 9-12 9z"/></svg>',
};

// ◀ [date ▾] ▶ — sits inside the page's GET form, so picking a date resubmits the
// other filters with it. The arrows step to the previous / next day that has data.
function dateNav(path, dates, sel, keep = {}) {
  if (!sel) {
    return `<div class="datenav"><span class="dn-btn off">${ARROW.prev}</span>` +
      `<span class="dn-select dn-empty">暂无数据</span><span class="dn-btn off">${ARROW.next}</span></div>`;
  }
  const older = dates.find((d) => d < sel);
  const newer = dates.filter((d) => d > sel).pop();
  const arrow = (d, dir, label) =>
    d
      ? `<a class="dn-btn" href="${esc(href(path, { ...keep, date: d }))}" aria-label="${label}" title="${label}">${ARROW[dir]}</a>`
      : `<span class="dn-btn off" aria-hidden="true">${ARROW[dir]}</span>`;
  const options = (dates.includes(sel) ? dates : [...dates, sel].sort().reverse())
    .map((d) => `<option value="${d}"${d === sel ? " selected" : ""}>${dayLabel(d)}</option>`)
    .join("");
  return `<div class="datenav">${arrow(older, "prev", "前一天")}` +
    `<select name="date" class="dn-select" aria-label="日期" onchange="this.form.submit()">${options}</select>` +
    `${arrow(newer, "next", "后一天")}</div>`;
}

function parseStocks(raw) {
  try {
    const stocks = JSON.parse(raw || "[]");
    return Array.isArray(stocks) ? stocks.filter((s) => s && (s.ticker || s.name)) : [];
  } catch {
    return [];
  }
}

// A stock call's 0-100 score, or null for calls analyzed before scores existed.
function scoreOf(s) {
  const n = s.score === "" || s.score == null ? NaN : Number(s.score);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function stanceTag(stance, text) {
  const s = STANCES.includes(stance) ? stance : "中性";
  return `<span class="stance ${STANCE_CLASS[s]}">${esc(text ?? s)}</span>`;
}

function scorePill(score) {
  if (score == null) return `<span class="dim">—</span>`;
  const cls = score >= 60 ? "hi" : score <= 40 ? "bear" : "mid";
  return `<span class="ai ${cls}" title="博主看好程度 ${score}/100">` +
    `<span class="ai-n">${score}</span><span class="ai-bar"><span style="width:${score}%"></span></span></span>`;
}

function stanceCounts(videos) {
  const c = { 看多: 0, 看空: 0, 中性: 0 };
  for (const v of videos) if (v.stance in c) c[v.stance] += 1;
  return c;
}

function moodBar(c) {
  if (!c.看多 && !c.看空 && !c.中性) return "";
  const seg = (k, cls) =>
    c[k] ? `<span class="mb-${cls}" style="flex:${c[k]}" title="${k} ${c[k]}">${k} ${c[k]}</span>` : "";
  return `<div class="moodbar" role="img" aria-label="看多 ${c.看多}，中性 ${c.中性}，看空 ${c.看空}">` +
    `${seg("看多", "bull")}${seg("中性", "flat")}${seg("看空", "bear")}</div>`;
}

const DISCLAIMER = `<footer class="card disclaimer">
  <b>免责声明</b>
  <p>本页内容由 AI 根据公开的 YouTube 视频自动整理，宏观报告由 AI 汇总这些整理结果生成；Score 与价位均来自博主本人的表态，可能存在理解错误或遗漏，请以视频原文为准。观点归博主本人所有，不代表本站立场。</p>
  <p>本站所有内容均不构成投资建议、推荐或任何证券的买卖要约。投资有风险，决策请自行研究并独立判断。</p>
</footer>`;

function page(active, title, body) {
  return renderShell({ active, title, market: "us", css: YT_CSS, body: body + DISCLAIMER });
}

// ---------- /yt 个股观点 ----------

function callRow(c) {
  const v = c.video;
  const label = c.ticker || c.name;
  return `<tr>
    <td class="stk"><span class="ticker">${esc(label)}</span>${
      c.name && c.name !== label ? `<span class="stk-name">${esc(c.name)}</span>` : ""
    }${c.category ? `<span class="rec-cat">${esc(c.category)}</span>` : ""}</td>
    <td class="who"><a href="${esc(videoUrl(v.video_id))}" target="_blank" rel="noopener" title="${esc(v.title)}">${esc(v.channel_name)}</a></td>
    <td class="why">${c.price_note ? `<span class="call-price">${esc(c.price_note)}</span>` : ""}${esc(c.reason || "")}</td>
    <td class="st" data-v="${STANCE_RANK[c.stance] ?? 1}">${stanceTag(c.stance)}</td>
    <td class="sc" data-v="${c.score ?? -1}">${scorePill(c.score)}</td>
  </tr>`;
}

function renderVideo(v) {
  return `<article class="card video">
    <div class="video-head"><span class="channel">${esc(v.channel_name)}</span>${stanceTag(v.stance)}</div>
    <a class="video-title" href="${esc(videoUrl(v.video_id))}" target="_blank" rel="noopener">${esc(v.title)}</a>
    ${v.summary ? `<div class="video-summary">${esc(v.summary)}</div>` : ""}
    ${v.views ? `<div class="video-views">${esc(v.views)}</div>` : ""}
  </article>`;
}

export function renderMainPage({ f, dates, sel, channels, videos }) {
  const needle = (f.q || "").toLowerCase();
  const matches = (s) => !needle || `${s.ticker || ""} ${s.name || ""}`.toLowerCase().includes(needle);

  const calls = [];
  for (const v of videos) {
    for (const s of parseStocks(v.stocks)) if (matches(s)) calls.push({ ...s, score: scoreOf(s), video: v });
  }
  // Highest score first; calls without a score fall back to stance order.
  calls.sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) || (STANCE_RANK[b.stance] ?? 1) - (STANCE_RANK[a.stance] ?? 1)
  );
  const shown = needle ? videos.filter((v) => parseStocks(v.stocks).some(matches)) : videos;
  const counts = stanceCounts(videos);
  const creators = new Set(videos.map((v) => v.channel_id)).size;

  const channelOptions = channels
    .map(
      (c) =>
        `<option value="${esc(c.channel_id)}"${c.channel_id === f.channel ? " selected" : ""}>${esc(c.channel_name)}</option>`
    )
    .join("");

  const stats = videos.length
    ? `<div class="daystats">
        <span><b>${videos.length}</b> 个视频</span>
        <span><b>${creators}</b> 位博主</span>
        <span><b>${calls.length}</b> 条个股观点</span>
        <span class="ds-mood">大盘态度 ${stanceTag("看多", `看多 ${counts.看多}`)}${stanceTag("中性", `中性 ${counts.中性}`)}${stanceTag("看空", `看空 ${counts.看空}`)}</span>
        <a class="ds-link" href="${esc(href("/yt/macro", { date: sel }))}">当日宏观报告 →</a>
      </div>`
    : "";

  const body = `
<form class="toolbar" method="get" action="/yt">
  ${dateNav("/yt", dates, sel, { channel: f.channel, q: f.q })}
  <select name="channel" class="tb-select" aria-label="博主" onchange="this.form.submit()">
    <option value="">所有博主</option>${channelOptions}
  </select>
  <input type="search" name="q" class="tb-search" value="${esc(f.q || "")}" placeholder="搜索股票" aria-label="搜索股票">
</form>
${stats}
<div class="card tablecard"><table class="calls"><thead><tr>
  <th data-type="text">股票</th><th data-type="text">博主</th><th>博主分析总结</th>
  <th data-type="num">建议</th><th data-type="num">Score</th>
</tr></thead><tbody>${
    calls.length
      ? calls.map(callRow).join("")
      : `<tr class="none"><td colspan="5" class="empty">暂无数据</td></tr>`
  }</tbody></table></div>
${
  shown.length
    ? `<div class="sec-title">当日视频 <span class="dim">${shown.length}</span></div>
       <div class="videos">${shown.map(renderVideo).join("")}</div>`
    : ""
}`;
  return page("yt", "个股观点", body);
}

// ---------- /yt/macro 宏观报告 ----------

export function renderMacroPage({ dates, sel, report, videos }) {
  let content = {};
  try {
    content = JSON.parse((report && report.content) || "{}") || {};
  } catch {
    content = {};
  }
  const counts = stanceCounts(videos);
  const creators = new Set(videos.map((v) => v.channel_id)).size;

  const head = `<div class="page-head">
  <h1>宏观总结</h1>
  ${sel ? `<span class="date-badge">${monthDay(sel)}</span>` : ""}
  <form class="toolbar" method="get" action="/yt/macro">${dateNav("/yt/macro", dates, sel)}</form>
</div>`;

  if (!report && !videos.length) {
    return page("yt-macro", "宏观报告", `${head}<div class="blank">这一天暂无博主观点</div>`);
  }

  const para = (t) => (t ? `<p>${esc(t)}</p>` : "");
  const list = (a) =>
    Array.isArray(a) && a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const block = (title, inner, wide = false) =>
    inner ? `<section class="card mblock${wide ? " wide" : ""}"><h3>${title}</h3>${inner}</section>` : "";
  const sectors =
    Array.isArray(content.sectors) && content.sectors.length
      ? `<div class="sectors">${content.sectors
          .map(
            (s) =>
              `<div class="sector">${stanceTag(s.stance)}<b>${esc(s.name)}</b>` +
              `${s.note ? `<span class="sector-note">${esc(s.note)}</span>` : ""}</div>`
          )
          .join("")}</div>`
      : "";

  const meta = videos.length ? `${videos.length} 个视频 · ${creators} 位博主` : "";
  const hero = `<section class="card macro-hero">
  <div class="mh-top">${report ? stanceTag(report.stance, `整体${report.stance || "中性"}`) : ""}<span class="mh-meta">${meta}</span></div>
  ${
    report && report.headline
      ? `<h2 class="mh-headline">${esc(report.headline)}</h2>`
      : `<p class="mh-pending">这一天的 AI 宏观报告还没生成（每天随博主视频更新两次），下面先列出各博主的观点。</p>`
  }
  ${videos.length ? `<div class="mh-mood"><span class="mh-label">博主大盘态度</span>${moodBar(counts)}</div>` : ""}
</section>`;

  const grid = report
    ? `<div class="macro-grid">
  ${block("📈 大盘与指数", para(content.market))}
  ${block("🏦 宏观与政策", para(content.macro))}
  ${block("🧭 板块与主题", sectors, true)}
  ${block("🤝 博主共识", list(content.consensus))}
  ${block("⚖️ 主要分歧", list(content.divergence))}
  ${block("⚠️ 风险提示", list(content.risks))}
  ${block("📅 接下来关注", list(content.watch))}
</div>`
    : "";

  const voices = videos.length
    ? `<section class="card voices"><h3>博主观点一览</h3>${videos
        .map(
          (v) => `<div class="voice">${stanceTag(v.stance)}
          <a class="voice-ch" href="${esc(videoUrl(v.video_id))}" target="_blank" rel="noopener" title="${esc(v.title)}">${esc(v.channel_name)}</a>
          <span class="voice-sum">${esc(v.summary || v.title)}</span></div>`
        )
        .join("")}</section>`
    : "";

  const late = report && videos.length > report.video_count ? videos.length - report.video_count : 0;
  const foot = report
    ? `<div class="report-foot">由 ${esc(report.model || "Gemini")} 根据当天 ${report.video_count} 个视频的观点汇总生成${
        late ? `；之后新增的 ${late} 个视频会在下次更新时并入` : ""
      } · 仅供参考，非投资建议</div>`
    : "";

  return page("yt-macro", "宏观报告", head + hero + grid + voices + foot);
}

// ---------- /yt/heatmap 热力图 ----------

// Every stock called in `rows` (newest first), with one call per creator — their
// newest — so posting twice can't double a creator's weight. Most creators first;
// ties go to the most recent call.
export function aggregate(rows) {
  const byStock = new Map();
  for (const r of rows) {
    for (const s of parseStocks(r.stocks)) {
      const key = String(s.ticker || s.name).toUpperCase();
      if (!byStock.has(key)) {
        byStock.set(key, { key, label: s.ticker || s.name, name: s.name, category: s.category, calls: [] });
      }
      const stock = byStock.get(key);
      stock.category ||= s.category;
      if (stock.calls.some((c) => c.channel === r.channel_name)) continue;
      stock.calls.push({ ...s, score: scoreOf(s), channel: r.channel_name, date: r.publish_date });
    }
  }
  const stocks = [...byStock.values()].map((st) => {
    const count = (k) => st.calls.filter((c) => c.stance === k).length;
    st.bull = count("看多");
    st.bear = count("看空");
    st.flat = st.calls.length - st.bull - st.bear;
    const scores = st.calls.map((c) => c.score).filter((x) => x != null);
    st.avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    st.latest = st.calls.reduce((m, c) => (c.date > m ? c.date : m), "");
    return st;
  });
  return stocks.sort((a, b) => b.calls.length - a.calls.length || b.latest.localeCompare(a.latest));
}

// Split into 看多 / 看空 / 分歧 by which side more creators took. Stocks with only
// 中性 calls aren't recommendations either way, so they're left off.
export function buildBoard(stocks) {
  const board = { bull: [], bear: [], split: [] };
  for (const st of stocks) {
    if (!st.bull && !st.bear) continue;
    const side = st.bull > st.bear ? "bull" : st.bear > st.bull ? "bear" : "split";
    if (board[side].length < BOARD_MAX) board[side].push(st);
  }
  return board;
}

// Squarified treemap (Bruls, Huizing & van Wijk): lays `weights`, sorted descending,
// out in a W×H box with tiles as close to square as possible. Returns [{x, y, w, h}].
export function squarify(weights, W, H) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return [];
  const out = [];
  let x = 0, y = 0, w = W, h = H, row = [];
  const worst = (r, side) => {
    const sum = r.reduce((a, b) => a + b, 0);
    return Math.max(...r.map((a) => Math.max((side * side * a) / (sum * sum), (sum * sum) / (side * side * a))));
  };
  const place = () => {
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const cw = sum / h;
      let cy = y;
      for (const a of row) {
        out.push({ x, y: cy, w: cw, h: a / cw });
        cy += a / cw;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const a of row) {
        out.push({ x: cx, y, w: a / rh, h: rh });
        cx += a / rh;
      }
      y += rh;
      h -= rh;
    }
    row = [];
  };
  for (const a of weights.map((v) => (v / total) * W * H)) {
    if (row.length && worst([...row, a], Math.min(w, h)) > worst(row, Math.min(w, h))) place();
    row.push(a);
  }
  if (row.length) place();
  return out;
}

// Rough rendered width of `s` in units of the font size, for bold text: CJK glyphs
// are 1em, M/W about 0.95em, other capitals and digits 0.74em, the rest 0.6em.
const glyphEm = (ch) =>
  ch.charCodeAt(0) > 255 ? 1 : "MW".includes(ch) ? 0.95 : /[A-Z0-9]/.test(ch) ? 0.74 : 0.6;
const textEm = (s) => [...String(s)].reduce((a, ch) => a + glyphEm(ch), 0);

// One treemap tile. `boxPx` is the box's typical rendered width, so text can be
// sized to the tile and the name / tally lines left out where they wouldn't fit.
function heatTile(st, r, W, H, boxPx) {
  const tw = (r.w / W) * boxPx;
  const th = (r.h / W) * boxPx;
  const net = (st.bull - st.bear) / st.calls.length;
  let bg = "var(--thead)";
  let strong = false;
  if (st.bull && net === 0) {
    bg = "color-mix(in srgb,#e0a92e 45%,var(--thead))";
  } else if (net !== 0) {
    const pct = Math.round(35 + 55 * Math.abs(net));
    bg = `color-mix(in srgb,var(${net > 0 ? "--buy" : "--sell"}) ${pct}%,var(--thead))`;
    strong = pct >= 60;
  }
  const pct = (v, of) => ((v / of) * 100).toFixed(3);
  const pos = `left:${pct(r.x, W)}%;top:${pct(r.y, H)}%;width:${pct(r.w, W)}%;height:${pct(r.h, H)}%`;
  const tally = `看多 ${st.bull} · 看空 ${st.bear}${st.flat ? ` · 中性 ${st.flat}` : ""}`;
  const meta = tally + (st.avgScore != null ? ` · ${st.avgScore}分` : "");
  const named = st.name && st.name !== st.label;
  const fs = Math.round(Math.max(11, Math.min(40, (tw - 18) / textEm(st.label), th * 0.34)));
  const showName = named && tw - 12 >= textEm(st.name) * 12 && th >= fs + 34;
  const showMeta = tw - 12 >= textEm(meta) * 11 && th >= fs + (showName ? 18 : 0) + 30;
  const title = [
    `${st.label}${named ? ` ${st.name}` : ""}`,
    tally + (st.avgScore != null ? ` · 平均 Score ${st.avgScore}` : ""),
    ...st.calls.map((c) => `${c.channel}：${c.stance}${c.price_note ? `（${c.price_note}）` : ""}`),
  ].join("\n");
  return `<a class="ht${strong ? " strong" : ""}" href="${esc(href("/yt", { date: st.latest, q: st.label }))}"
    style="${pos};background:${bg}" title="${esc(title)}">
    <span class="ht-tk" style="font-size:${fs}px">${esc(st.label)}</span>${
      showName ? `<span class="ht-name">${esc(st.name)}</span>` : ""
    }${showMeta ? `<span class="ht-meta">${esc(meta)}</span>` : ""}</a>`;
}

// `boxPx`: the box's typical rendered width (desktop main column / phone screen).
function heatBox(stocks, W, H, cls, boxPx) {
  const rects = squarify(stocks.map((s) => s.calls.length), W, H);
  return `<div class="heat-box ${cls}">${stocks
    .map((s, i) => heatTile(s, rects[i], W, H, boxPx))
    .join("")}</div>`;
}

function renderRec(stock) {
  const calls = stock.calls
    .map(
      (c) => `<div class="call">${stanceTag(c.stance)}
        <b>${esc(c.channel)} (${esc(monthDay(c.date))})</b>
        ${c.price_note ? `<span class="call-price">${esc(c.price_note)}</span>` : ""}${esc(c.reason || "")}</div>`
    )
    .join("");
  return `<div class="rec">
    <div class="rec-head">
      <span class="ticker">${esc(stock.label)}</span>
      ${stock.name && stock.name !== stock.label ? `<span class="rec-name">${esc(stock.name)}</span>` : ""}
      ${stock.category ? `<span class="rec-cat">${esc(stock.category)}</span>` : ""}
      <span class="rec-count">看多 ${stock.bull} · 看空 ${stock.bear}</span>
    </div>
    ${calls}
  </div>`;
}

export function renderHeatPage({ f, dates, sel, start, videos }) {
  const stocks = aggregate(videos);
  const tiles = stocks.slice(0, HEAT_MAX);
  const board = buildBoard(stocks);
  const range = start === sel ? `${sel}` : `${start} — ${sel}`;

  const seg = (r, label) =>
    `<a href="${esc(href("/yt/heatmap", { date: sel, range: r === "w" ? "w" : null }))}"${
      f.range === r ? ' class="on" aria-current="true"' : ""
    }>${label}</a>`;
  const toolbar = `<form class="toolbar" method="get" action="/yt/heatmap">
  ${dateNav("/yt/heatmap", dates, sel, { range: f.range === "w" ? "w" : null })}
  ${f.range === "w" ? '<input type="hidden" name="range" value="w">' : ""}
  <div class="seg">${seg("d", "当日")}${seg("w", `近 ${WEEK_DAYS} 日`)}</div>
</form>`;
  const head = `<div class="page-head"><h1>热力图</h1><span class="tag">博主点名的个股 · 面积看人数，颜色看多空</span></div>`;

  if (!tiles.length) {
    return page("yt-heat", "热力图", `${head}${toolbar}<div class="blank">当前日期无数据</div>`);
  }

  const side = (key, title) =>
    board[key].length ? `<div class="bside ${key}">${title}</div>${board[key].map(renderRec).join("")}` : "";
  const sides = side("bull", "🟢 看多") + side("bear", "🔴 看空") + side("split", "⚖️ 分歧");

  const body = `${head}${toolbar}
<div class="card heat">${heatBox(tiles, 160, 100, "wide", 1000)}${heatBox(tiles, 90, 130, "tall", 320)}</div>
<div class="heat-legend">
  <span><i style="background:var(--buy)"></i>看多居多</span>
  <span><i style="background:var(--sell)"></i>看空居多</span>
  <span><i style="background:color-mix(in srgb,#e0a92e 45%,var(--thead))"></i>多空各半</span>
  <span><i style="background:var(--thead);border:1px solid var(--border)"></i>仅中性</span>
  <span>面积 = 表态的博主数 · 点格子看观点 · ${esc(range)}</span>
</div>
<section class="card board"><h3>🏆 博主推荐榜<span class="board-range">${esc(range)}</span></h3>
  ${sides || `<div class="empty">这段时间没有博主明确看多或看空个股。</div>`}
</section>`;
  return page("yt-heat", "热力图", body);
}
