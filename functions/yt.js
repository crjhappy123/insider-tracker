// GET /yt — server-rendered finance YouTubers' recommended-stock boards and views,
// backed by the yt_videos D1 table (edge-cached).
import {
  parseFilters,
  queryBoardRows,
  queryChannels,
  queryVideos,
  renderPage,
  serveCached,
} from "./_yt.js";

export function onRequestGet(context) {
  const filters = parseFilters(new URL(context.request.url));
  return serveCached(context, "text/html; charset=utf-8", async () => {
    const [rows, boardRows, channels] = await Promise.all([
      queryVideos(context.env.DB, filters),
      queryBoardRows(context.env.DB),
      queryChannels(context.env.DB),
    ]);
    return renderPage(rows, boardRows, channels, filters);
  });
}
