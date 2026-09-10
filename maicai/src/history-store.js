// 价格历史的持久化 —— 给 GitHub Actions 用。
//
// 问题：Actions 的 runner 是一次性的，跑完就销毁，SQLite 文件留不下来。
// 而这个项目最核心的判断（这个促销是不是真便宜）完全依赖 90 天历史价格。
// 没有历史，每天跑出来的结果都是「数据不足」，整个功能等于没有。
//
// 方案：把历史价格按天存成一个个 JSON 文件提交回仓库。
//   data/history/products.json     商品元数据（标题/规格/单位），会变，每次覆盖
//   data/history/2026-09-09.json   某一天的价格，写完就再也不动
//
// 为什么按天一个文件而不是一个大文件：一天一个文件写完就不再改动，git 只存一次；
// 单个大文件每天重写的话，git 每次都要存一份完整副本，一年能把仓库撑到 GB 级。
//
// 键用 `storeId|sku` 而不是数据库自增 id —— 自增 id 每次重建都会变，跨运行对不上。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, db, loadCatalog, syncStores, saveProducts, daysAgo } from './db.js';

const DIR = join(ROOT, 'data', 'history');
const META = join(DIR, 'products.json');
const KEEP_DAYS = 180;

const dayFile = (day) => join(DIR, `${day}.json`);

/** 把当前数据库里的价格历史导出成按天的 JSON（供提交回仓库） */
export function dumpHistory({ log = console.log } = {}) {
  mkdirSync(DIR, { recursive: true });
  const d = db();

  const products = d.prepare(`
    SELECT p.store_id, p.sku, p.title, p.brand, p.size, p.price_unit
    FROM products p
  `).all();

  const meta = {};
  for (const p of products) {
    meta[`${p.store_id}|${p.sku}`] = {
      t: p.title,
      b: p.brand || undefined,
      s: p.size || undefined,
      u: p.price_unit || undefined,
    };
  }
  writeFileSync(META, JSON.stringify(meta, null, 0));

  const rows = d.prepare(`
    SELECT s.day, p.store_id, p.sku, s.price_regular, s.price_promo, s.promo_text
    FROM snapshots s JOIN products p ON p.id = s.product_id
    WHERE s.day >= ?
    ORDER BY s.day
  `).all(daysAgo(KEEP_DAYS));

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, {});
    // 紧凑格式 [原价, 促销价, 促销文案]
    byDay.get(r.day)[`${r.store_id}|${r.sku}`] = [
      r.price_regular ?? null,
      r.price_promo ?? null,
      r.promo_text || undefined,
    ];
  }

  let written = 0;
  for (const [day, data] of byDay) {
    const f = dayFile(day);
    const next = JSON.stringify(data, null, 0);
    // 已存在且内容相同就不重写 —— 避免在 git 里产生无意义的改动
    if (existsSync(f) && readFileSync(f, 'utf8') === next) continue;
    writeFileSync(f, next);
    written++;
  }

  log(`  历史已导出: ${byDay.size} 天在库, 本次写入/更新 ${written} 个文件, ${products.length} 个商品`);
  return { days: byDay.size, written, products: products.length };
}

/** 把仓库里的历史 JSON 灌回一个空数据库（Actions 每次开跑时做） */
export function loadHistory({ log = console.log } = {}) {
  if (!existsSync(META)) {
    log('  没有历史文件（data/history/），这是第一次跑 —— 促销判断要等攒够天数才准');
    return { days: 0, rows: 0 };
  }
  syncStores();
  const items = loadCatalog();
  const meta = JSON.parse(readFileSync(META, 'utf8'));

  const days = readdirSync(DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .filter((day) => day >= daysAgo(KEEP_DAYS))
    .sort();

  let rows = 0;
  for (const day of days) {
    const data = JSON.parse(readFileSync(dayFile(day), 'utf8'));
    // 按门店分组，一次 saveProducts 一家店
    const byStore = new Map();
    for (const [key, v] of Object.entries(data)) {
      const i = key.indexOf('|');
      const storeId = key.slice(0, i);
      const sku = key.slice(i + 1);
      const m = meta[key];
      if (!m) continue;   // 元数据里没有就跳过，缺标题算不出单价
      if (!byStore.has(storeId)) byStore.set(storeId, []);
      byStore.get(storeId).push({
        sku,
        title: m.t,
        brand: m.b ?? null,
        size: m.s ?? null,
        priceUnit: m.u ?? null,
        priceRegular: v[0],
        pricePromo: v[1] ?? null,
        promoText: v[2] ?? null,
        day,
      });
    }
    for (const [storeId, products] of byStore) {
      rows += saveProducts(storeId, products, { items, day });
    }
  }

  log(`  历史已灌入: ${days.length} 天, ${rows} 条快照 (${days[0] ?? '-'} ~ ${days[days.length - 1] ?? '-'})`);
  return { days: days.length, rows };
}
