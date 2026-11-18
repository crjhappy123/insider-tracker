// GET /yt — 博主汇总 · 个股观点: every stock call finance YouTubers made on one day,
// backed by the yt_videos D1 table (edge-cached).
import {
  parseFilters,
  queryChannels,
  queryDates,
  queryVideos,
  renderMainPage,
  serveCached,
} from "../_yt.js";

export function onRequestGet(context) {
  const f = parseFilters(new URL(context.request.url));
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const db = context.env.DB;
    const [dates, channels] = await Promise.all([queryDates(db), queryChannels(db)]);
    const sel = f.date || dates[0] || null;
    const videos = sel ? await queryVideos(db, sel, sel, f.channel) : [];
    return renderMainPage({ f, dates, sel, channels, videos });
  });
}
