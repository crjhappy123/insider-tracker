// The whole site as one Markdown document (GET /digest), for AI agents and scheduled
// tasks: the 博主 macro report and stock calls first, then US and A-share insider
// buying. Same D1 data and filters as the pages, so it never disagrees with them;
// every section links back to its page.
// Files prefixed with "_" are not routed by Cloudflare Pages.
import * as cn from "./_cn.js";
import * as us from "./_query.js";
import * as yt from "./_yt.js";

const TOP_INSIDER = 25; // companies per insider table, by total bought
const TOP_CONSENSUS = 20; // stocks in the 7-day blogger consensus list
const COMMENT_MAX = 220; // characters of an AI comment kept per row

// The insider pages' default view: no filters, their own market-cap floors.
const NO_FILTERS = { ticker: null, insider: null, code: null, minValue: null, minMarketCap: null, limit: 200 };

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// One Markdown table cell: single line, no pipes, "—" when empty.
const cell = (v) => clip(v, 400).replace(/\|/g, "／") || "—";

function table(head, rows) {
  if (!rows.length) return "（暂无）";
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => " --- ").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

const bullets = (items) => (items || []).filter(Boolean).map((x) => `- ${clip(x, 600)}`).join("\n");

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw || "") ?? fallback;
  } catch {
    return fallback;
  }
}

function stanceCounts(videos) {
  const c = { 看多: 0, 中性: 0, 看空: 0 };
  for (const v of videos) if (v.stance in c) c[v.stance] += 1;
  return `看多 ${c.看多} / 中性 ${c.中性} / 看空 ${c.看空}（${videos.length} 个视频）`;
}

function macroSection(origin, day, report, videos) {
  const out = [`## 1. 博主宏观报告（${day}）`, `网页：${origin}/yt/macro?date=${day}`, ""];
  out.push(`博主大盘态度：${stanceCounts(videos)}`, "");
  if (!report) {
    out.push("当天的 AI 宏观报告还没生成（随博主视频每天更新两次）。各博主观点：");
  } else {
    const c = parseJson(report.content, {});
    out.push(`**整体：${report.stance || "中性"}** — ${report.headline || ""}`, "");
    if (c.market) out.push(`**大盘与指数**：${c.market}`, "");
    if (c.macro) out.push(`**宏观与政策**：${c.macro}`, "");
    if (c.sectors?.length) {
      out.push("**板块与主题**：", bullets(c.sectors.map((s) => `${s.name}（${s.stance}）：${s.note}`)), "");
    }
    for (const [key, title] of [
      ["consensus", "博主共识"],
      ["divergence", "主要分歧"],
      ["risks", "风险提示"],
      ["watch", "接下来关注"],
    ]) {
      if (c[key]?.length) out.push(`**${title}**：`, bullets(c[key]), "");
    }
    out.push(`（由 ${report.model || "AI"} 根据 ${report.video_count} 个视频汇总。）各博主观点：`);
  }
  out.push(bullets(videos.map((v) => `${v.channel_name}（${v.stance}）：${v.summary || v.title}`)));
  return out.join("\n");
}

function callsSection(origin, day, dayVideos, weekVideos) {
  const calls = yt.aggregate(dayVideos).flatMap((st) =>
    st.calls.map((c) => ({ ...c, label: st.label, name: st.name }))
  );
  calls.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const dayRows = calls.map((c) => [
    `${c.label}${c.name && c.name !== c.label ? ` ${c.name}` : ""}`,
    c.channel,
    c.stance,
    c.score ?? "—",
    c.price_note,
    c.reason,
  ]);
  const consensus = yt
    .aggregate(weekVideos)
    .filter((st) => st.bull || st.bear)
    .slice(0, TOP_CONSENSUS)
    .map((st) => [
      `${st.label}${st.name && st.name !== st.label ? ` ${st.name}` : ""}`,
      st.bull,
      st.bear,
      st.flat,
      st.avgScore ?? "—",
      st.calls.map((c) => `${c.channel}:${c.stance}`).join("、"),
    ]);
  return [
    `## 2. 博主个股观点（${day}）`,
    `网页：${origin}/yt?date=${day} · 热力图：${origin}/yt/heatmap?date=${day}&range=w`,
    "Score：0-100，博主对该股的看好程度（50 为中性）；早于评分上线的观点没有 Score。",
    "",
    "### 当日观点",
    table(["股票", "博主", "建议", "Score", "价位", "理由"], dayRows),
    "",
    `### 近 7 日共识（${yt.weekStart(day)} — ${day}，按表态博主数）`,
    table(["股票", "看多", "看空", "中性", "平均 Score", "博主"], consensus),
  ].join("\n");
}

function insiderSection({ n, title, url, rows, report, dateKey, codeKey, fmt, note }) {
  const top = [...rows].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)).slice(0, TOP_INSIDER);
  const dates = rows.map((r) => r[dateKey]).filter(Boolean).sort();
  const span = dates.length ? `${dates[0]} — ${dates[dates.length - 1]}` : "暂无数据";
  const out = [`## ${n}. ${title}（${span}）`, `网页：${url}`, note, ""];
  if (report?.summary) out.push(`**AI 日报（${report.report_date}）**：${clip(report.summary, 1500)}`, "");
  out.push(
    table(
      ["最近日期", "代码", "公司", "市值", "内部人数", "笔数", "总金额", "AI 评分", "AI 点评"],
      top.map((r) => [
        r[dateKey],
        r[codeKey],
        r.company_name,
        fmt.bcap(r.eff_mktcap),
        r.insider_count,
        r.buy_count,
        fmt.money(r.value),
        r.ai_score ?? "—",
        clip(`${r.ai_rating ? `${r.ai_rating}：` : ""}${r.ai_comment || ""}`, COMMENT_MAX),
      ])
    )
  );
  return out.join("\n");
}

export async function buildDigest(db, origin) {
  const ytDates = await yt.queryDates(db);
  const day = ytDates[0] || null;
  const [usRows, usReport, cnRows, cnReport, macro, dayVideos, weekVideos] = await Promise.all([
    us.queryTickerRollup(db, NO_FILTERS).catch(() => []),
    us.latestReport(db),
    cn.queryTickerRollup(db, NO_FILTERS).catch(() => []),
    cn.latestReport(db),
    day ? yt.queryMacro(db, day) : null,
    day ? yt.queryVideos(db, day, day) : [],
    day ? yt.queryVideos(db, yt.weekStart(day), day) : [],
  ]);

  const parts = [
    "# RudyStock 数据摘要",
    "",
    `生成时间：${new Date().toISOString()}（UTC）。数据每天更新两次；本页内容与 ${origin} 各页面一致。`,
    "板块：① 财经 YouTube 博主的宏观报告与个股观点 ② 美股内部人公开市场买入（SEC Form 4）③ A股董监高二级市场增持。",
    "",
  ];
  if (day) {
    parts.push(macroSection(origin, day, macro, dayVideos), "", callsSection(origin, day, dayVideos, weekVideos));
  } else {
    parts.push("## 1-2. 博主观点", "（暂无数据）");
  }
  parts.push(
    "",
    insiderSection({
      n: 3,
      title: "美股 Insider 买入",
      url: `${origin}/`,
      rows: usRows,
      report: usReport,
      dateKey: "filing_date",
      codeKey: "ticker",
      fmt: us,
      note: `按公司汇总近 7 天的 Form 4 公开市场买入（交易代码 P），市值 ≥ $1B，按总金额取前 ${TOP_INSIDER}。`,
    }),
    "",
    insiderSection({
      n: 4,
      title: "A股 Insider 增持",
      url: `${origin}/cn`,
      rows: cnRows,
      report: cnReport,
      dateKey: "change_date",
      codeKey: "code",
      fmt: cn,
      note: `按公司汇总近 7 天的董监高二级市场增持（主板，不含创业板/科创板），总市值 ≥ ¥50亿，按总金额取前 ${TOP_INSIDER}。`,
    }),
    "",
    "---",
    "免责声明：以上内容由公开披露数据与 AI 对公开视频的整理生成，可能有误，不构成投资建议。"
  );
  return parts.join("\n") + "\n";
}
