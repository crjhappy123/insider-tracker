// SQLite 存储。用 Node 22+ 内置的 node:sqlite，不需要装任何原生依赖。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchProduct as matchOne } from './match.js';
import { unitPrice } from './units.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.MAICAI_DB || join(ROOT, 'data', 'maicai.db');

let _db = null;

export function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_zh TEXT,
      branch TEXT,
      drive_minutes REAL DEFAULT 10,
      source TEXT,
      config TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      title TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      price_unit TEXT,          -- 店内按单位卖时的单位，例如散称水果的 'lb'
      url TEXT,
      image_url TEXT,
      first_seen TEXT,
      last_seen TEXT,
      UNIQUE(store_id, sku)
    );

    CREATE TABLE IF NOT EXISTS matches (
      product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      item_id TEXT,
      score REAL,
      hit TEXT,
      origin TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
      blocked INTEGER NOT NULL DEFAULT 0,    -- 手动拉黑，不参与比价
      updated_at TEXT
    );

    -- 每个商品每天一条价格快照。有历史才能判断「今天这个促销到底是不是真便宜」。
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      ts TEXT NOT NULL,
      price_regular REAL,
      price_promo REAL,
      promo_text TEXT,
      unit_price REAL,
      unit TEXT,
      unit_basis TEXT,
      pack_qty REAL,            -- 一份包装等于多少个目标单位（Costco 的 4 磅装 = 4）
      in_stock INTEGER DEFAULT 1,
      UNIQUE(product_id, day)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      store_id TEXT,
      ok INTEGER,
      product_count INTEGER,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS basket (
      item_id TEXT PRIMARY KEY,
      qty REAL NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snap_product_day ON snapshots(product_id, day DESC);
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_matches_item ON matches(item_id);
  `);

  // 老库平滑升级：SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查一下有没有
  const cols = d.prepare('PRAGMA table_info(snapshots)').all().map((c) => c.name);
  if (!cols.includes('pack_qty')) d.exec('ALTER TABLE snapshots ADD COLUMN pack_qty REAL');
}

export function today() {
  // 用本地日期，不是 UTC —— 否则西海岸下午抓的数据会记成第二天
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysAgo(n, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- 配置加载 ---------- */

export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

export function loadCatalog() {
  const c = loadJson('data/catalog.json');
  return c.items;
}

export function loadStoresConfig() {
  return loadJson('data/stores.json');
}

export function syncStores() {
  const cfg = loadStoresConfig();
  const stmt = db().prepare(`
    INSERT INTO stores (id, name, name_zh, branch, drive_minutes, source, config)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_zh=excluded.name_zh, branch=excluded.branch,
      drive_minutes=excluded.drive_minutes, source=excluded.source, config=excluded.config
  `);
  for (const s of cfg.stores) {
    stmt.run(s.id, s.name, s.nameZh ?? null, s.branch ?? null, s.driveMinutes ?? 10, s.source ?? null, JSON.stringify(s));
  }
  return cfg;
}

/* ---------- 写入 ---------- */

/**
 * 把一次抓取的结果写进库：upsert 商品 + 当天价格快照 + 自动匹配（不覆盖手动结果）。
 */
export function saveProducts(storeId, products, { items, day = today() } = {}) {
  const d = db();
  const now = new Date().toISOString();
  const catalog = items ?? loadCatalog();

  const upProduct = d.prepare(`
    INSERT INTO products (store_id, sku, title, brand, size, price_unit, url, image_url, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, sku) DO UPDATE SET
      title=excluded.title, brand=excluded.brand, size=excluded.size,
      price_unit=excluded.price_unit, url=excluded.url, image_url=excluded.image_url,
      last_seen=excluded.last_seen
  `);
  const getId = d.prepare('SELECT id FROM products WHERE store_id = ? AND sku = ?');
  const upSnap = d.prepare(`
    INSERT INTO snapshots (product_id, day, ts, price_regular, price_promo, promo_text, unit_price, unit, unit_basis, pack_qty, in_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, day) DO UPDATE SET
      ts=excluded.ts, price_regular=excluded.price_regular, price_promo=excluded.price_promo,
      promo_text=excluded.promo_text, unit_price=excluded.unit_price, unit=excluded.unit,
      unit_basis=excluded.unit_basis, pack_qty=excluded.pack_qty, in_stock=excluded.in_stock
  `);
  const getMatch = d.prepare('SELECT origin FROM matches WHERE product_id = ?');
  const upMatch = d.prepare(`
    INSERT INTO matches (product_id, item_id, score, hit, origin, updated_at)
    VALUES (?, ?, ?, ?, 'auto', ?)
    ON CONFLICT(product_id) DO UPDATE SET
      item_id=excluded.item_id, score=excluded.score, hit=excluded.hit, updated_at=excluded.updated_at
  `);

  let saved = 0;
  d.exec('BEGIN');
  try {
    for (const p of products) {
      if (!p.sku || !p.title) continue;
      upProduct.run(
        storeId, String(p.sku), p.title, p.brand ?? null, p.size ?? null,
        p.priceUnit ?? null, p.url ?? null, p.imageUrl ?? null, now, now
      );
      const row = getId.get(storeId, String(p.sku));
      if (!row) continue;
      const pid = row.id;

      // 匹配：只在没有手动结果时写自动匹配
      const existing = getMatch.get(pid);
      if (!existing || existing.origin !== 'manual') {
        const m = matchOne(p, catalog);
        upMatch.run(pid, m?.itemId ?? null, m?.score ?? null, m?.hit ?? null, now);
      }

      const u = unitPriceFor(p, pid, catalog, d);
      upSnap.run(
        pid, p.day ?? day, now,
        p.priceRegular ?? null, p.pricePromo ?? null, p.promoText ?? null,
        u?.unitPrice ?? null, u?.unit ?? null, u?.basis ?? null, u?.packQty ?? null,
        p.inStock === false ? 0 : 1
      );
      saved++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return saved;
}

function unitPriceFor(p, pid, catalog, d) {
  const row = d.prepare('SELECT item_id, blocked FROM matches WHERE product_id = ?').get(pid);
  if (!row?.item_id || row.blocked) return null;
  const item = catalog.find((i) => i.id === row.item_id);
  if (!item) return null;
  const price = p.pricePromo ?? p.priceRegular;
  return unitPrice({ price, priceUnit: p.priceUnit, size: p.size, title: p.title, targetUnit: item.unit, density: item.density });
}

/**
 * 清掉某家店的样本数据（sku 以 SAMPLE- 开头的）。
 *
 * 真实数据到位后必须做这一步。样本只是脚手架，留着它会出两种问题：
 *   1. 去重时按最低单价挑，编造的样本价往往比真实价低，会把真实价格挤掉
 *   2. 比价表上同一家店混着真价和假价，「哪家最便宜」的结论没有意义
 *
 * 副作用是这家店的 90 天历史一起没了，促销判断会退回「历史不足」——
 * 这是对的：我们确实还没有它的真实历史，不该拿编的历史装作有。
 */
export function purgeSample(storeId) {
  const d = db();
  const n = d.prepare("SELECT COUNT(*) c FROM products WHERE store_id = ? AND sku LIKE 'SAMPLE-%'").get(storeId).c;
  if (n === 0) return 0;
  // snapshots / matches 都有 ON DELETE CASCADE
  d.prepare("DELETE FROM products WHERE store_id = ? AND sku LIKE 'SAMPLE-%'").run(storeId);
  return n;
}

/** 清掉某家店当天没再抓到的旧商品（换了 sku 前缀、或商品下架） */
export function pruneUnseen(storeId, day, { olderThanDays = 7 } = {}) {
  const d = db();
  const cutoff = daysAgo(olderThanDays);
  const rows = d.prepare(`
    SELECT p.id FROM products p
    WHERE p.store_id = ?
      AND (SELECT MAX(day) FROM snapshots WHERE product_id = p.id) < ?
  `).all(storeId, cutoff);
  if (rows.length === 0) return 0;
  const del = d.prepare('DELETE FROM products WHERE id = ?');
  for (const r of rows) del.run(r.id);
  return rows.length;
}

export function logRun(storeId, ok, count, message) {
  db().prepare('INSERT INTO runs (ts, store_id, ok, product_count, message) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), storeId, ok ? 1 : 0, count ?? 0, message ?? null);
}

/**
 * 当某个商品的匹配被手动改动后，重算它历史快照的单价（否则单价还是按旧 item 的单位算的）。
 */
export function recomputeUnitPrices(productId) {
  const d = db();
  const catalog = loadCatalog();
  const p = d.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return 0;
  const m = d.prepare('SELECT item_id, blocked FROM matches WHERE product_id = ?').get(productId);
  const item = m?.item_id && !m.blocked ? catalog.find((i) => i.id === m.item_id) : null;
  const snaps = d.prepare('SELECT id, price_regular, price_promo FROM snapshots WHERE product_id = ?').all(productId);
  const up = d.prepare('UPDATE snapshots SET unit_price = ?, unit = ?, unit_basis = ?, pack_qty = ? WHERE id = ?');
  for (const s of snaps) {
    const u = item
      ? unitPrice({
          price: s.price_promo ?? s.price_regular,
          priceUnit: p.price_unit,
          size: p.size,
          title: p.title,
          targetUnit: item.unit,
          density: item.density,
        })
      : null;
    up.run(u?.unitPrice ?? null, u?.unit ?? null, u?.basis ?? null, u?.packQty ?? null, s.id);
  }
  return snaps.length;
}

/* ---------- 读取 ---------- */

export function getStores() {
  return db().prepare('SELECT * FROM stores ORDER BY drive_minutes').all();
}

// 一个商品最后一次被抓到超过这么多天，就不再拿它的价格参与比价。
//
// 为什么需要：latestSnapshots 取的是「每个商品自己的最后一天」。没有这个窗口的话，
// 某样东西下架了、或者关键词不再命中了，它最后那次的价格会永远留在页面上 ——
// 几个月前的价格看起来和今天的一样新，还会参与「哪家最便宜」的判断。
// 宁可这家店这样东西显示「没抓到」，也不要拿过期价格误导。
const MAX_STALE_DAYS = 7;

/** 每个商品的最新快照（含匹配到的 item）。超过 MAX_STALE_DAYS 没更新的商品会被排除。 */
export function latestSnapshots({ itemId = null, storeId = null, day = null, maxStaleDays = MAX_STALE_DAYS } = {}) {
  const where = [];
  const args = [];
  if (itemId) { where.push('m.item_id = ?'); args.push(itemId); }
  if (storeId) { where.push('p.store_id = ?'); args.push(storeId); }
  if (!day && maxStaleDays > 0) { where.push('s.day >= ?'); args.push(daysAgo(maxStaleDays)); }
  const clause = where.length ? `AND ${where.join(' AND ')}` : '';

  return db().prepare(`
    SELECT
      p.id AS product_id, p.store_id, p.sku, p.title, p.brand, p.size, p.url, p.image_url, p.price_unit,
      m.item_id, m.score, m.origin, m.blocked,
      s.day, s.price_regular, s.price_promo, s.promo_text, s.unit_price, s.unit, s.unit_basis, s.pack_qty, s.in_stock
    FROM products p
    JOIN matches m ON m.product_id = p.id
    JOIN snapshots s ON s.product_id = p.id
    WHERE m.item_id IS NOT NULL
      AND m.blocked = 0
      AND s.day = ${day ? '?' : '(SELECT MAX(day) FROM snapshots WHERE product_id = p.id)'}
      ${clause}
  `).all(...(day ? [day, ...args] : args));
}

/** 某商品过去 windowDays 天的有效单价序列（不含今天，用来算历史基准） */
export function priceHistory(productId, windowDays = 90, excludeDay = today()) {
  return db().prepare(`
    SELECT day, price_regular, price_promo, unit_price
    FROM snapshots
    WHERE product_id = ? AND day >= ? AND day <> ?
    ORDER BY day
  `).all(productId, daysAgo(windowDays), excludeDay);
}

export function fullHistory(productId, windowDays = 180) {
  return db().prepare(`
    SELECT day, price_regular, price_promo, unit_price
    FROM snapshots WHERE product_id = ? AND day >= ? ORDER BY day
  `).all(productId, daysAgo(windowDays));
}

export function lastRuns(limit = 20) {
  return db().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function getBasket() {
  return db().prepare('SELECT item_id, qty FROM basket ORDER BY item_id').all();
}

export function setBasket(entries) {
  const d = db();
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM basket');
    const st = d.prepare('INSERT INTO basket (item_id, qty, updated_at) VALUES (?,?,?)');
    for (const e of entries) {
      if (e.qty > 0) st.run(e.itemId, e.qty, new Date().toISOString());
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function setMatch(productId, itemId, blocked = false) {
  db().prepare(`
    INSERT INTO matches (product_id, item_id, score, hit, origin, blocked, updated_at)
    VALUES (?, ?, 1.0, 'manual', 'manual', ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      item_id=excluded.item_id, origin='manual', blocked=excluded.blocked,
      score=1.0, hit='manual', updated_at=excluded.updated_at
  `).run(productId, itemId, blocked ? 1 : 0, new Date().toISOString());
  return recomputeUnitPrices(productId);
}

/** 商品库页面用：某个 item 下所有店的商品，含被拉黑和未匹配上的候选 */
export function productsForItem(itemId) {
  return db().prepare(`
    SELECT p.id AS product_id, p.store_id, p.title, p.brand, p.size, p.url,
           m.item_id, m.score, m.origin, m.blocked,
           s.day, s.price_regular, s.price_promo, s.unit_price, s.unit, s.unit_basis, s.pack_qty
    FROM products p
    JOIN matches m ON m.product_id = p.id
    LEFT JOIN snapshots s ON s.product_id = p.id
      AND s.day = (SELECT MAX(day) FROM snapshots WHERE product_id = p.id)
    WHERE m.item_id = ?
    ORDER BY m.blocked, p.store_id, s.unit_price
  `).all(itemId);
}

export function searchProducts(q, limit = 40) {
  return db().prepare(`
    SELECT p.id AS product_id, p.store_id, p.title, p.size, m.item_id, m.origin, m.blocked,
           s.price_regular, s.price_promo, s.unit_price, s.unit
    FROM products p
    LEFT JOIN matches m ON m.product_id = p.id
    LEFT JOIN snapshots s ON s.product_id = p.id
      AND s.day = (SELECT MAX(day) FROM snapshots WHERE product_id = p.id)
    WHERE LOWER(p.title) LIKE ?
    ORDER BY p.store_id, p.title
    LIMIT ?
  `).all(`%${String(q).toLowerCase()}%`, limit);
}
