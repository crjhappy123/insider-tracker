// D1 query + HTML rendering for the YouTuber views page (`/yt`): daily and weekly boards
// of the stocks tracked finance channels recommend, plus each video's extracted view
// (see scraper/yt_ingest.py).
// Files prefixed with "_" are not routed by Cloudflare Pages.
import { PAGE_CSS, PAGE_SCRIPT, THEME_BOOT, esc, marketSwitch, num, tile } from "./_shared.js";

export { serveCached } from "./_shared.js";

const STANCES = ["看多", "看空", "中性"];
const STANCE_CLASS = { 看多: "bull", 看空: "bear", 中性: "flat" };
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const BOARD_DAYS = 7;
const BOARD_MAX = 15; // per side
const BOARD_ROWS = 500;

const YT_CSS = `
.day{font-size:.82rem;font-weight:700;color:var(--ink2);margin:1.1rem 0 .5rem}
.videos{display:grid;gap:.7rem}
.video{padding:.9rem 1.05rem}
.video-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.35rem}
.channel{font-size:.78rem;font-weight:700;color:var(--ink2)}
.video-title{display:block;font-size:.95rem;font-weight:600;line-height:1.4;color:var(--ink);
  text-decoration:none;margin-bottom:.4rem}
.video-title:hover{color:var(--accent)}
.video-summary{font-size:.88rem;line-height:1.55;color:var(--ink);margin-bottom:.35rem}
.video-views{font-size:.82rem;line-height:1.6;color:var(--ink2);white-space:pre-wrap}
.stocks{display:grid;gap:.3rem;margin-top:.6rem}
.stock{display:flex;align-items:baseline;gap:.45rem;flex-wrap:wrap;font-size:.8rem;line-height:1.45}
.stock .ticker{display:inline-block}
.stock-why{color:var(--ink2)}
.stance{display:inline-block;padding:.08rem .4rem;border-radius:6px;font-size:.68rem;font-weight:700;white-space:nowrap}
.stance.bull{color:var(--buy);background:color-mix(in srgb,var(--buy) 18%,transparent)}
.stance.bear{color:var(--sell);background:color-mix(in srgb,var(--sell) 18%,transparent)}
.stance.flat{color:var(--muted);background:var(--glass)}
.board{padding:1.1rem 1.25rem;margin-bottom:1.1rem}
.board>input{position:absolute;opacity:0;pointer-events:none}
.board-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;
  font-size:.95rem;font-weight:700;margin-bottom:.4rem}
.board-tabs{display:flex;gap:.3rem}
.board-tab{flex-direction:row;font-size:.72rem;font-weight:600;letter-spacing:0;color:var(--muted);
  padding:.3rem .7rem;border:1px solid var(--border);border-radius:8px;cursor:pointer}
.board-tab:hover{color:var(--ink)}
#board-d:checked~.board-head .tab-d,#board-w:checked~.board-head .tab-w{
  color:#fff;background:var(--accent);border-color:transparent}
.board-panel{display:none}
#board-d:checked~.panel-d,#board-w:checked~.panel-w{display:block}
.board-range{font-size:.72rem;color:var(--muted);margin-bottom:.3rem}
.side{font-size:.85rem;font-weight:700;margin:.8rem 0 .45rem}
.side.bull{color:var(--buy)}
.side.bear{color:var(--sell)}
.side.split{color:var(--ink2)}
.rec{padding:.65rem .8rem;margin-bottom:.45rem;border:1px solid var(--border);border-radius:10px;background:var(--glass)}
.rec-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem}
.rec-head .ticker{display:inline-block;font-size:1.05rem}
.rec-name{font-size:.78rem;color:var(--muted)}
.rec-cat{font-size:.68rem;font-weight:600;color:var(--accent);padding:.08rem .4rem;border-radius:6px;
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.rec-count{margin-left:auto;font-size:.72rem;color:var(--muted)}
.call{font-size:.8rem;line-height:1.55;color:var(--ink2)}
.call b{color:var(--ink);font-weight:600}
.call-price{color:var(--accent);font-weight:600}
`;

export function parseFilters(url) {
  const g = (k) => (url.searchParams.get(k) || "").trim() || null;
  const stance = g("stance");
  const limit = parseInt(g("limit") || "", 10);
  return {
    channel: g("channel"),
    stance: STANCES.includes(stance) ? stance : null,
    q: g("q"),
    limit: limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

export async function queryVideos(db, f) {
  const where = ["stance IS NOT NULL"];
  const binds = [];
  if (f.channel) {
    where.push("channel_id = ?");
    binds.push(f.channel);
  }
  if (f.stance) {
    where.push("stance = ?");
    binds.push(f.stance);
  }
  if (f.q) {
    where.push("(title LIKE ? OR summary LIKE ? OR stocks LIKE ?)");
    binds.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  }
  binds.push(f.limit);
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM yt_videos WHERE ${where.join(" AND ")} ` +
          "ORDER BY published_at DESC LIMIT ?"
      )
      .bind(...binds)
      .all();
    return results || [];
  } catch {
    return []; // table may not exist yet
  }
}

// Analyzed videos in the board window, ending on the newest analyzed day. Queried
// apart from the list below so the page's filters don't change the boards.
export async function queryBoardRows(db) {
  try {
    const { results } = await db
      .prepare(
        "SELECT channel_name, publish_date, published_at, stocks FROM yt_videos " +
          "WHERE stance IS NOT NULL AND publish_date >= date(" +
          "(SELECT MAX(publish_date) FROM yt_videos WHERE stance IS NOT NULL), ?) " +
          "ORDER BY published_at DESC LIMIT ?"
      )
      .bind(`-${BOARD_DAYS - 1} days`, BOARD_ROWS)
      .all();
    return results || [];
  } catch {
    return [];
  }
}

export async function queryChannels(db) {
  try {
    const { results } = await db
      .prepare(
        "SELECT channel_id, MAX(channel_name) AS channel_name FROM yt_videos " +
          "WHERE stance IS NOT NULL GROUP BY channel_id ORDER BY channel_name"
      )
      .all();
    return results || [];
  } catch {
    return [];
  }
}

function parseStocks(raw) {
  try {
    const stocks = JSON.parse(raw || "[]");
    return Array.isArray(stocks) ? stocks : [];
  } catch {
    return [];
  }
}

// Group the stock calls in `rows` (newest first) by stock, then split into 看多 / 看空
// / 分歧 by how many creators hold each side. A creator counts once per stock, with
// their newest call, so posting twice in a week can't double their weight. Stocks
// with only 中性 calls aren't recommendations either way, so they're dropped.
export function buildBoard(rows) {
  const byStock = new Map();
  for (const r of rows) {
    for (const s of parseStocks(r.stocks)) {
      const key = String(s.ticker || s.name || "").toUpperCase();
      if (!key) continue;
      if (!byStock.has(key)) {
        byStock.set(key, { key, label: s.ticker || s.name, name: s.name, calls: [] });
      }
      const stock = byStock.get(key);
      stock.category ||= s.category;
      if (stock.calls.some((c) => c.channel === r.channel_name)) continue;
      stock.calls.push({ ...s, channel: r.channel_name, date: r.publish_date });
    }
  }
  const board = { bull: [], bear: [], split: [] };
  for (const stock of byStock.values()) {
    const count = (stance) => stock.calls.filter((c) => c.stance === stance).length;
    stock.bull = count("看多");
    stock.bear = count("看空");
    if (!stock.bull && !stock.bear) continue;
    const side = stock.bull > stock.bear ? "bull" : stock.bear > stock.bull ? "bear" : "split";
    board[side].push(stock);
  }
  // Most creators first; ties go to the most recent call.
  const rank = (a, b) =>
    b.calls.length - a.calls.length || b.calls[0].date.localeCompare(a.calls[0].date);
  for (const side of Object.keys(board)) board[side] = board[side].sort(rank).slice(0, BOARD_MAX);
  return board;
}

const monthDay = (d) => String(d).slice(5).replace("-", "/");

function stanceTag(stance) {
  return `<span class="stance ${STANCE_CLASS[stance] || "flat"}">${esc(stance || "中性")}</span>`;
}

function renderRec(stock) {
  const calls = stock.calls
    .map(
      (c) => `<div class="call">
        ${stanceTag(c.stance)}
        <b>${esc(c.channel)} (${esc(monthDay(c.date))})</b>
        ${c.price_note ? `<span class="call-price">${esc(c.price_note)}</span>` : ""}
        ${esc(c.reason)}
      </div>`
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

function renderPanel(cls, range, rows) {
  const board = buildBoard(rows);
  const side = (key, title) =>
    board[key].length
      ? `<div class="side ${key}">${title}</div>${board[key].map(renderRec).join("")}`
      : "";
  const body = side("bull", "🟢 看多") + side("bear", "🔴 看空") + side("split", "⚖️ 分歧");
  return `<div class="board-panel ${cls}">
    <div class="board-range">${esc(range)}</div>
    ${body || `<div class="empty">这段时间没有博主明确推荐股票。</div>`}
  </div>`;
}

function renderBoards(boardRows) {
  if (!boardRows.length) return "";
  const day = boardRows.reduce((m, r) => (r.publish_date > m ? r.publish_date : m), "");
  const start = new Date(Date.parse(day) - (BOARD_DAYS - 1) * 864e5).toISOString().slice(0, 10);
  const daily = boardRows.filter((r) => r.publish_date === day);
  return `<section class="card board">
    <input type="radio" name="board" id="board-d" checked>
    <input type="radio" name="board" id="board-w">
    <div class="board-head">
      <span>🏆 博主推荐榜</span>
      <span class="board-tabs">
        <label class="board-tab tab-d" for="board-d">日榜</label>
        <label class="board-tab tab-w" for="board-w">周榜</label>
      </span>
    </div>
    ${renderPanel("panel-d", `统计日期：${day}`, daily)}
    ${renderPanel("panel-w", `统计周期：${start} — ${day}`, boardRows)}
  </section>`;
}

function renderVideo(r) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(r.video_id)}`;
  const stocks = parseStocks(r.stocks)
    .map(
      (s) => `<div class="stock">
        ${stanceTag(s.stance)}
        <span class="ticker">${esc(s.ticker || s.name)}</span>
        ${s.price_note ? `<span class="call-price">${esc(s.price_note)}</span>` : ""}
        <span class="stock-why">${esc(s.reason)}</span>
      </div>`
    )
    .join("");
  return `<article class="card video">
    <div class="video-head">
      <span class="channel">${esc(r.channel_name)}</span>
      ${stanceTag(r.stance)}
    </div>
    <a class="video-title" href="${esc(url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
    ${r.summary ? `<div class="video-summary">${esc(r.summary)}</div>` : ""}
    ${r.views ? `<div class="video-views">${esc(r.views)}</div>` : ""}
    ${stocks ? `<div class="stocks">${stocks}</div>` : ""}
  </article>`;
}

export function renderPage(rows, boardRows, channels, f) {
  const counts = { 看多: 0, 看空: 0, 中性: 0 };
  for (const r of rows) if (r.stance in counts) counts[r.stance] += 1;

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.publish_date)) byDay.set(r.publish_date, []);
    byDay.get(r.publish_date).push(r);
  }
  const body = rows.length
    ? [...byDay]
        .map(
          ([day, videos]) =>
            `<div class="day">${esc(day)} · ${num(videos.length)} 个视频</div>` +
            `<div class="videos">${videos.map(renderVideo).join("")}</div>`
        )
        .join("")
    : `<div class="card empty">暂无视频观点。</div>`;

  const channelOptions = channels
    .map(
      (c) =>
        `<option value="${esc(c.channel_id)}"${c.channel_id === f.channel ? " selected" : ""}>${esc(c.channel_name)}</option>`
    )
    .join("");
  const stanceOptions = STANCES.map(
    (s) => `<option value="${s}"${s === f.stance ? " selected" : ""}>${s}</option>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>YouTube 博主观点追踪</title>
${THEME_BOOT}
<style>${PAGE_CSS}${YT_CSS}</style></head><body><div class="wrap">
<header>
  <div class="logo"><span class="dot"></span>博主观点追踪</div>
  <span class="tag">财经 YouTube 博主每日视频 · AI 提取观点</span>
  ${marketSwitch("yt")}
  <button class="theme-btn" id="themeBtn" type="button" aria-label="切换深浅色主题" title="切换主题">🌗</button>
</header>

${renderBoards(boardRows)}

<section class="kpi">
  ${tile("视频数", num(rows.length), "--accent", num(channels.length) + " 位博主")}
  ${tile("看多", num(counts["看多"]), "--buy", "对大盘的整体态度")}
  ${tile("看空", num(counts["看空"]), "--sell")}
  ${tile("中性", num(counts["中性"]), "--muted")}
</section>

<form class="card" method="get" action="/yt">
  <label>博主<select name="channel"><option value="">全部</option>${channelOptions}</select></label>
  <label>态度<select name="stance"><option value="">全部</option>${stanceOptions}</select></label>
  <label>关键词<input name="q" value="${esc(f.q || "")}" placeholder="NVDA 或 降息" size="14"></label>
  <button type="submit">筛选</button>
  <a class="reset" href="/yt">重置</a>
</form>

${body}

<footer class="card disclaimer">
  <b>免责声明</b>
  <p>本页内容由 AI 根据公开的 YouTube 视频自动整理，榜单仅统计博主的公开表态，价位均为博主本人所述，可能存在理解错误或遗漏，请以视频原文为准。观点归博主本人所有，不代表本站立场。</p>
  <p>本站所有内容均不构成投资建议、推荐或任何证券的买卖要约。投资有风险，决策请自行研究并独立判断。</p>
</footer>
${PAGE_SCRIPT}
</div></body></html>`;
}
