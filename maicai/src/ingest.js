#!/usr/bin/env node
// 抓取 CLI。
//
// 常用：
//   npm run ingest:sample                       用离线样本填一天数据（不需要凭证/浏览器）
//   npm run seed-history                        造 90 天历史，让真假促销判断立刻能用
//   npm run ingest                              抓所有店的真实数据
//   npm run ingest -- --stores=fred_meyer       只抓 Fred Meyer
//   npm run ingest -- --find-stores             查你家附近 Fred Meyer 的 locationId
//   npm run ingest -- --dump                    抓不到东西时把页面存下来方便调

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  db, ROOT, syncStores, loadCatalog, saveProducts, logRun, getStores, today, daysAgo,
} from './db.js';
import { scraperFor, sample, describeAll } from './scrapers/index.js';
import { dumpHistory, loadHistory } from './history-store.js';
import { findStores } from './scrapers/kroger.js';

/* ---------- .env 加载（不引第三方库） ---------- */
function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const out = { flags: new Set(), opts: {} };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v === undefined) out.flags.add(k);
    else out.opts[k] = v;
  }
  return out;
}

const log = (...a) => console.log(...a);

/* ---------- 主流程 ---------- */
async function main() {
  loadEnv();
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const cfg = syncStores();
  const items = loadCatalog();

  if (flags.has('help')) return printHelp();
  if (flags.has('list-scrapers')) return printScrapers();
  if (flags.has('find-stores')) return doFindStores(cfg);
  if (flags.has('load-history')) { loadHistory({ log }); return; }
  if (flags.has('dump-history')) { dumpHistory({ log }); return; }
  if (flags.has('seed-history') || opts['seed-history']) {
    const days = Number(opts['seed-history'] ?? 90);
    return seedHistory(items, days);
  }

  const source = opts.source ?? (flags.has('sample') ? 'sample' : 'real');
  const day = opts.day ?? today();
  const wanted = (opts.stores ?? 'all').toLowerCase();
  const stores = cfg.stores.filter((s) => wanted === 'all' || wanted.split(',').includes(s.id));

  if (stores.length === 0) {
    console.error(`没有匹配的门店。可用: ${cfg.stores.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  log(`\n抓取日期 ${day}，数据源 ${source === 'sample' ? '离线样本' : '真实站点'}\n`);

  let totalOk = 0;
  let totalFail = 0;

  for (const store of stores) {
    const label = `${store.nameZh || store.name}${store.branch ? ` (${store.branch})` : ''}`;
    log(`▶ ${label}`);
    const t0 = Date.now();
    try {
      const scraper = scraperFor(store.id, source);
      const products = await scraper.scrape({
        storeConfig: store,
        items,
        log,
        dump: flags.has('dump'),
        day,
      });
      const withDay = products.map((p) => ({ ...p, day: p.day ?? day }));
      const saved = saveProducts(store.id, withDay, { items, day });
      logRun(store.id, true, saved, `source=${source}`);
      log(`  ✓ 存入 ${saved} 条 (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
      totalOk++;
    } catch (e) {
      logRun(store.id, false, 0, e.message);
      log(`  ✗ 失败: ${e.message}\n`);
      totalFail++;
    }
  }

  summarize(day);
  log(`\n完成: ${totalOk} 家成功, ${totalFail} 家失败`);
  if (totalFail > 0 && source !== 'sample') {
    log('提示: 失败的店先看上面的错误。想先看网站效果就跑 `npm run ingest:sample`。');
  }
}

/* ---------- 造历史数据 ---------- */
function seedHistory(items, days) {
  log(`\n用离线样本造 ${days} 天历史价格 —— 有历史才能判断「今天这个促销是不是真便宜」。\n`);
  const storeIds = getStores().map((s) => s.id);
  let total = 0;
  for (let n = days; n >= 0; n--) {
    const day = daysAgo(n);
    for (const storeId of storeIds) {
      let products;
      try {
        products = sample.generate(storeId, { day, items });
      } catch (e) {
        // 只有「样本没配这家店」是预期情况，其它错误必须暴露出来，别静默跳过
        if (/没有配置门店/.test(e.message)) continue;
        throw e;
      }
      total += saveProducts(storeId, products.map((p) => ({ ...p, day })), { items, day });
    }
    if (n % 15 === 0) log(`  ... ${day} (剩 ${n} 天)`);
  }
  log(`\n✓ 写入 ${total} 条快照，覆盖 ${daysAgo(days)} ~ ${today()}`);
  summarize(today());
  log('\n现在跑 `npm start` 打开 http://localhost:5173 看效果。');
}

/* ---------- Kroger 门店查询 ---------- */
async function doFindStores(cfg) {
  const zip = cfg.home?.zip || '98155';
  log(`\n查 ${zip} 附近的 Fred Meyer ...\n`);
  try {
    const list = await findStores({ zip });
    if (list.length === 0) return log('没查到门店，试试把 stores.json 里的 home.zip 改一下。');
    for (const s of list) {
      log(`  locationId ${s.locationId}  ${s.name}`);
      log(`             ${s.address}\n`);
    }
    log(`把你家最近那家的 locationId 填进 data/stores.json 的 fred_meyer.krogerLocationId。`);
  } catch (e) {
    log(`查询失败: ${e.message}`);
  }
}

/* ---------- 汇总 ---------- */
function summarize(day) {
  const d = db();
  const rows = d.prepare(`
    SELECT p.store_id,
           COUNT(*) AS products,
           SUM(CASE WHEN m.item_id IS NOT NULL AND m.blocked = 0 THEN 1 ELSE 0 END) AS matched,
           SUM(CASE WHEN s.unit_price IS NOT NULL THEN 1 ELSE 0 END) AS comparable,
           SUM(CASE WHEN s.price_promo IS NOT NULL THEN 1 ELSE 0 END) AS on_promo
    FROM products p
    LEFT JOIN matches m ON m.product_id = p.id
    JOIN snapshots s ON s.product_id = p.id AND s.day = ?
    GROUP BY p.store_id
  `).all(day);

  if (rows.length === 0) return;
  log('\n本次汇总:');
  log('  门店            商品   已匹配   可比价   在促销');
  for (const r of rows) {
    log(
      `  ${r.store_id.padEnd(14)} ${String(r.products).padStart(4)} ` +
      `${String(r.matched).padStart(8)} ${String(r.comparable).padStart(8)} ${String(r.on_promo).padStart(8)}`
    );
  }

  // 你常买但一条都没抓到的东西 —— 这是最需要修的
  const missing = d.prepare(`
    SELECT i.item_id FROM (
      SELECT DISTINCT m.item_id FROM matches m
      JOIN snapshots s ON s.product_id = m.product_id AND s.day = ?
      WHERE m.item_id IS NOT NULL AND m.blocked = 0 AND s.unit_price IS NOT NULL
    ) i
  `).all(day).map((r) => r.item_id);
  const gaps = loadCatalog().filter((i) => i.weekly > 0 && !missing.includes(i.id));
  if (gaps.length) {
    log(`\n  没抓到可比价格的常买商品 (${gaps.length}): ${gaps.map((g) => g.name).join('、')}`);
    log('  -> 可能是关键词不匹配，去 data/catalog.json 调 match.any，或在网页「商品库」页手动纠正。');
  }
}

function printScrapers() {
  log('\n各店抓取方式:\n');
  for (const s of describeAll()) {
    log(`  ${s.storeId}`);
    log(`    ${s.label}`);
    log(`    需要凭证: ${s.needsCredentials ? '是' : '否'}   需要浏览器: ${s.needsBrowser ? '是' : '否'}`);
    log(`    验证状态: ${s.verified}\n`);
  }
}

function printHelp() {
  log(`
买菜比价 - 抓取工具

  --stores=all|<id>,<id>   要抓哪几家 (默认 all)
  --source=real|sample     真实站点 / 离线样本 (默认 real)
  --day=YYYY-MM-DD         按指定日期存快照 (默认今天)
  --seed-history[=90]      用样本造 N 天历史价
  --find-stores            查附近 Fred Meyer 的 locationId
  --list-scrapers          看每家店用什么方式抓、验证到什么程度
  --dump                   抓不到时把页面存到 data/debug/
  --load-history           把 data/history/ 里的历史价格灌进数据库（CI 用）
  --dump-history           把数据库里的历史价格导出到 data/history/（CI 用）
`);
}

main().catch((e) => {
  console.error('\n出错了:', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
