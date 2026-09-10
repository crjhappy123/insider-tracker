#!/usr/bin/env node
// 导出静态站点数据。
//
// 线上跑在 Cloudflare Pages 上，Workers 运行时没有 node:sqlite、没有文件系统、
// 跑不了 Playwright，所以线上不可能有后端。做法是：
//   构建期（本地或 GitHub Actions）把「需要历史才能算」的东西全算完 —— 历史中位价、
//   降价幅度、真假促销判断 —— 导出成 JSON；浏览器只负责展示 + 购物清单组合优化
//   （63 种组合，纯计算，在浏览器里是零成本的）。
//
// 产出两个文件：
//   snapshot.json  当前价格 + 已算好的促销判断（~60KB）
//   history.json   价格走势，画图用（只导出每个「商品×门店」里最便宜的那个，控制体积）
//
// 用法：
//   npm run export                     导出到 dist/shop/
//   npm run export -- --out=<目录>      导出到别处（部署时指向 stock 仓库的 public/shop）

import { mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadCatalog, loadStoresConfig, getStores, syncStores, fullHistory, today, lastRuns } from './db.js';
import { analyze, CONFIG } from './deals.js';
import { describeAll } from './scrapers/index.js';

const HISTORY_DAYS = 120;

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    o[k] = v === undefined ? true : v;
  }
  return o;
}

export function buildSnapshot() {
  syncStores();
  const cfg = loadStoresConfig();
  const catalog = loadCatalog();
  const stores = getStores();
  const rows = analyze();

  // 每个「商品 × 门店」只留单价最低的那个，和网页上的展示口径一致
  const bestPerItemStore = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.unitPrice)) continue;
    const k = `${r.itemId}|${r.storeId}`;
    const prev = bestPerItemStore.get(k);
    if (!prev || r.unitPrice < prev.unitPrice) bestPerItemStore.set(k, r);
  }

  // 解析不出规格、没法比价的也要导出，否则用户会以为「这家店没有这样东西」
  const uncomparable = rows
    .filter((r) => !Number.isFinite(r.unitPrice))
    .map((r) => ({
      itemId: r.itemId, storeId: r.storeId, productId: r.productId,
      title: r.title, size: r.size,
      priceRegular: r.priceRegular, pricePromo: r.pricePromo,
    }));

  const compact = [...bestPerItemStore.values()].map((r) => ({
    productId: r.productId,
    itemId: r.itemId,
    storeId: r.storeId,
    storeName: r.storeName,
    title: r.title,
    brand: r.brand,
    size: r.size,
    url: r.url,
    unitPrice: round(r.unitPrice, 5),
    unit: r.unit,
    unitBasis: r.unitBasis,
    packQty: round(r.packQty, 3),
    priceRegular: round(r.priceRegular, 2),
    pricePromo: round(r.pricePromo, 2),
    promoText: r.promoText,
    // 下面这些靠 90 天历史算出来，浏览器算不了，必须构建期算好
    medianUnitPrice: round(r.medianUnitPrice, 5),
    lowestUnitPrice: round(r.lowestUnitPrice, 5),
    discount: round(r.discount, 4),
    verdict: r.verdict,
    flaggedPromo: r.flaggedPromo,
    isLowestEver: r.isLowestEver,
    weeklySaving: round(r.weeklySaving, 4),
    historyDays: r.historyDays,
    matchScore: round(r.matchScore, 3),
    matchOrigin: r.matchOrigin,
  }));

  const runs = lastRuns(12).map((r) => ({
    ts: r.ts, storeId: r.store_id, ok: !!r.ok, count: r.product_count, message: r.message,
  }));

  return {
    generatedAt: new Date().toISOString(),
    day: today(),
    home: cfg.home,
    tripCost: cfg.tripCost,
    dealConfig: CONFIG,
    stores: stores.map((s) => ({
      id: s.id, name: s.name, nameZh: s.name_zh, branch: s.branch,
      driveMinutes: s.drive_minutes, source: s.source,
    })),
    catalog: catalog.map((i) => ({
      id: i.id, name: i.name, nameEn: i.nameEn, category: i.category,
      unit: i.unit, weekly: i.weekly, density: i.density,
    })),
    categories: [...new Set(catalog.map((i) => i.category))],
    scrapers: describeAll(),
    runs,
    rows: compact,
    uncomparable,
  };
}

export function buildHistory(snapshot) {
  // 只导出快照里出现的那些商品的走势 —— 全导会大一个量级，而图表只画这些
  const out = {};
  for (const r of snapshot.rows) {
    const pts = fullHistory(r.productId, HISTORY_DAYS)
      .filter((p) => Number.isFinite(p.unit_price))
      // 紧凑格式 [日, 单价]，比 {day:..., unit_price:...} 小一半多
      .map((p) => [p.day, round(p.unit_price, 5)]);
    if (pts.length >= 2) out[r.productId] = pts;
  }
  return out;
}

function round(n, d) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ? join(ROOT, String(args.out)) : join(ROOT, 'dist', 'shop');

  const snapshot = buildSnapshot();
  if (snapshot.rows.length === 0) {
    console.error('\n没有可比价的数据，不导出空站点。先跑 `npm run ingest` 或 `npm run seed-history`。');
    process.exit(1);
  }
  const history = buildHistory(snapshot);

  mkdirSync(join(outDir, 'data'), { recursive: true });

  // 静态资源：index.html / app.js / style.css 直接抄过去
  for (const f of ['index.html', 'app.js', 'style.css', 'data.js', 'plan.js']) {
    cpSync(join(ROOT, 'web', f), join(outDir, f));
  }
  // 静态模式的标记：app.js 靠它决定读 JSON 还是打 API
  patchHtml(join(outDir, 'index.html'));

  const snapPath = join(outDir, 'data', 'snapshot.json');
  const histPath = join(outDir, 'data', 'history.json');
  writeFileSync(snapPath, JSON.stringify(snapshot));
  writeFileSync(histPath, JSON.stringify(history));

  const kb = (p) => (readFileSync(p).length / 1024).toFixed(1);
  console.log(`\n导出到 ${outDir.replace(ROOT + '/', '')}/`);
  console.log(`  snapshot.json  ${kb(snapPath)} KB  (${snapshot.rows.length} 条价格, ${snapshot.stores.length} 家店)`);
  console.log(`  history.json   ${kb(histPath)} KB  (${Object.keys(history).length} 个商品的走势)`);
  console.log(`  index.html / app.js / style.css / data.js / plan.js`);
  const real = snapshot.rows.filter((r) => r.verdict === 'real').length;
  const fake = snapshot.rows.filter((r) => r.verdict === 'fake').length;
  console.log(`\n数据日期 ${snapshot.day}：真降价 ${real} 个，假促销 ${fake} 个`);
}

/** 在 <body> 上打个静态模式标记，并把绝对路径改成相对路径（站点挂在 /shop/ 子路径下） */
function patchHtml(path) {
  let html = readFileSync(path, 'utf8');
  html = html
    .replace('<body ', '<body data-mode="static" ')
    .replace('href="/style.css"', 'href="./style.css"')
    .replace('src="/app.js"', 'src="./app.js"');
  writeFileSync(path, html);
}

// 用 pathToFileURL 比拼 `file://${argv[1]}` 可靠：项目路径含中文时后者会因为
// import.meta.url 里是百分号编码而永远不相等，脚本会静默什么都不做。
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
