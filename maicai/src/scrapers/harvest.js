// 通用商品抓取器。
//
// 设计思路：不去猜某家店的 CSS class（改版就全废），而是打开搜索页、
// 把页面自己发出的所有 JSON 请求录下来，再从里面找「长得像商品列表」的结构。
// 现代电商站点（99 Ranch 是 Next.js，T&T 是 SPA）价格一定是走 XHR 拿的，
// 这个办法比 DOM 选择器耐用得多，也不用我瞎猜字段名。
//
// 实在录不到 JSON 才退回 DOM 启发式解析。
// 两条路都失败时会把页面 dump 到 data/debug/ 让你（或我）看一眼再调。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../db.js';

const TITLE_KEYS = [
  'item_title', 'itemTitle', 'productName', 'product_name', 'displayName',
  'name', 'title', 'description', 'itemName', 'label',
];
const SKU_KEYS = ['sku', 'productId', 'product_id', 'id', 'itemCode', 'item_code', 'upc', 'code', 'entity_id', 'slug'];
const SIZE_KEYS = [
  'sales_size', 'salesSize', 'packSize', 'pack_size', 'unitSize', 'unit_size',
  'size', 'weight', 'netWeight', 'net_weight', 'volume', 'specification', 'spec',
];
const REGULAR_KEYS = [
  'retail_price', 'retailPrice', 'regularPrice', 'regular_price', 'listPrice', 'list_price',
  'originalPrice', 'original_price', 'msrp', 'wasPrice', 'basePrice', 'base_price', 'price',
];
const PROMO_KEYS = [
  'salePrice', 'sale_price', 'promoPrice', 'promo_price', 'specialPrice', 'special_price',
  'discountPrice', 'discount_price', 'final_price', 'finalPrice', 'memberPrice', 'dealPrice',
];
const UNIT_KEYS = ['sales_uom_description', 'salesUom', 'uom', 'unitOfMeasure', 'priceUnit', 'unitLabel', 'sellBy', 'soldBy'];
const IMAGE_KEYS = ['image', 'imageUrl', 'image_url', 'primary_image', 'thumbnail', 'imageSrc'];

/** 从可能嵌套的值里挖出一个数字价格。{value:3.99} / "3.99" / "$3.99" 都能吃 */
function numFrom(v, depth = 0) {
  if (v == null || depth > 3) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof v === 'object') {
    for (const k of ['value', 'amount', 'price', 'final_price', 'regularPrice', 'currentPrice', 'min', 'minimum_price']) {
      if (k in v) {
        const n = numFrom(v[k], depth + 1);
        if (n != null) return n;
      }
    }
    // 兜底：对象里第一个正数
    for (const val of Object.values(v)) {
      const n = numFrom(val, depth + 1);
      if (n != null) return n;
    }
  }
  return null;
}

function firstKey(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function looksLikeProduct(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const title = firstKey(o, TITLE_KEYS);
  if (typeof title !== 'string' || title.length < 3 || title.length > 200) return false;
  const reg = numFrom(firstKey(o, REGULAR_KEYS));
  const pro = numFrom(firstKey(o, PROMO_KEYS));
  return (reg != null || pro != null);
}

function toProduct(o, storeId) {
  const title = String(firstKey(o, TITLE_KEYS));
  let regular = numFrom(firstKey(o, REGULAR_KEYS));
  let promo = numFrom(firstKey(o, PROMO_KEYS));

  // 有的站点只有一个 price 字段就是现价；有的 promo 字段在没促销时等于原价
  if (regular == null && promo != null) { regular = promo; promo = null; }
  if (promo != null && regular != null && promo >= regular) promo = null;
  if (regular == null) return null;

  const uom = firstKey(o, UNIT_KEYS);
  const uomStr = typeof uom === 'string' ? uom.toLowerCase() : '';
  const byWeight = /\b(lb|pound|per lb|\/lb|weight)\b/.test(uomStr);

  const sku = firstKey(o, SKU_KEYS);
  return {
    sku: sku != null ? String(sku) : `H-${storeId}-${hashStr(title)}`,
    title,
    brand: typeof o.brand === 'string' ? o.brand : (o.brand?.name ?? null),
    size: (() => {
      const s = firstKey(o, SIZE_KEYS);
      if (s == null) return null;
      return typeof s === 'object' ? (numFrom(s) != null ? `${numFrom(s)}` : null) : String(s);
    })(),
    priceUnit: byWeight ? 'lb' : null,
    priceRegular: regular,
    pricePromo: promo,
    promoText: promo != null ? 'Weekly Special' : null,
    url: typeof o.url === 'string' ? o.url : (typeof o.url_key === 'string' ? o.url_key : null),
    imageUrl: (() => {
      const im = firstKey(o, IMAGE_KEYS);
      if (!im) return null;
      if (typeof im === 'string') return im;
      if (Array.isArray(im)) return typeof im[0] === 'string' ? im[0] : (im[0]?.url ?? null);
      return im.url ?? im.src ?? null;
    })(),
    inStock: o.inStock ?? o.in_stock ?? o.available ?? o.stock_status !== 'OUT_OF_STOCK',
  };
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0).toString(36);
}

/** 深度遍历任意 JSON，把所有「像商品」的对象挖出来 */
export function extractProducts(blob, storeId, maxDepth = 12) {
  const found = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (looksLikeProduct(node)) {
      const p = toProduct(node, storeId);
      if (p && !seen.has(p.sku)) { seen.add(p.sku); found.push(p); }
      // 商品对象内部还可能有 variants，继续走
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(blob, 0);
  return found;
}

/**
 * 打开一批 URL，录下所有 JSON 响应 + 页面内嵌 JSON，挖出商品。
 *
 * @param {import('playwright').Page} page
 * @param {object} o
 * @param {string} o.storeId
 * @param {string[]} o.urls        要访问的搜索/分类页
 * @param {boolean} [o.dump]       抓不到时把响应存到 data/debug/ 方便调
 * @param {(m:string)=>void} [o.log]
 */
export async function harvest(page, { storeId, urls, dump = false, log = console.log }) {
  const blobs = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!res.ok() || !ct.includes('json')) return;
      const len = Number(res.headers()['content-length'] || 0);
      if (len > 8_000_000) return;
      const j = await res.json();
      blobs.push({ url: res.url(), json: j });
    } catch { /* 响应体读不到就跳过 */ }
  });

  const all = new Map();
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // 等 XHR 打完；networkidle 在长轮询的站上会超时，所以宽容处理
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(1200);

      // 页面里内嵌的 JSON（Next.js 的 __NEXT_DATA__、Nuxt 的 __NUXT__ 等）
      const inline = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('script')) {
          const t = el.textContent || '';
          if (t.length < 40 || t.length > 4_000_000) continue;
          const type = el.getAttribute('type') || '';
          if (type.includes('json') || el.id === '__NEXT_DATA__') { out.push(t); continue; }
          const m = t.match(/^\s*(?:window\.\w+\s*=\s*|self\.__next_f\.push\()?(\{[\s\S]*\}|\[[\s\S]*\])\s*\)?;?\s*$/);
          if (m) out.push(m[1]);
        }
        return out;
      }).catch(() => []);
      for (const t of inline) {
        try { blobs.push({ url: `${url}#inline`, json: JSON.parse(t) }); } catch { /* 不是合法 JSON */ }
      }
    } catch (e) {
      log(`  [${storeId}] 打开 ${url} 失败: ${e.message}`);
      continue;
    }

    for (const b of blobs.splice(0)) {
      for (const p of extractProducts(b.json, storeId)) {
        if (!all.has(p.sku)) all.set(p.sku, p);
      }
    }

    // JSON 一无所获，退回 DOM 启发式
    if (all.size === 0) {
      for (const p of await domHarvest(page, storeId)) {
        if (!all.has(p.sku)) all.set(p.sku, p);
      }
    }
  }

  if (all.size === 0 && dump) {
    const dir = join(ROOT, 'data', 'debug');
    mkdirSync(dir, { recursive: true });
    const html = await page.content().catch(() => '');
    writeFileSync(join(dir, `${storeId}-page.html`), html);
    log(`  [${storeId}] 什么都没抓到，页面已存到 data/debug/${storeId}-page.html`);
  }

  return [...all.values()];
}

/** DOM 兜底：找同时含商品名和 $价格 的卡片 */
async function domHarvest(page, storeId) {
  const raw = await page.evaluate(() => {
    const PRICE = /\$\s*(\d+(?:\.\d{1,2})?)/;
    const cards = document.querySelectorAll(
      '[class*="product" i], [class*="Product" i], [data-testid*="product" i], li, article'
    );
    const out = [];
    for (const c of cards) {
      const text = (c.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6 || text.length > 400) continue;
      const prices = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
      if (prices.length === 0) continue;
      // 卡片里不该再嵌套别的卡片，否则会把整个列表当成一个商品
      if (c.querySelectorAll('[class*="product" i]').length > 1) continue;
      const nameEl =
        c.querySelector('h1,h2,h3,h4,[class*="name" i],[class*="title" i],a[href]') || null;
      const name = (nameEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (name.length < 3) continue;
      const href = c.querySelector('a[href]')?.href || null;
      out.push({ name, prices, href, text });
    }
    return out;
  }).catch(() => []);

  const seen = new Set();
  const products = [];
  for (const r of raw) {
    const sorted = [...r.prices].sort((a, b) => a - b);
    const promo = sorted.length > 1 ? sorted[0] : null;
    const regular = sorted.length > 1 ? sorted[sorted.length - 1] : sorted[0];
    const sku = `DOM-${storeId}-${hashStr(r.name)}`;
    if (seen.has(sku)) continue;
    seen.add(sku);
    // 从卡片文字里找规格，例如 "16 oz" / "per lb"
    const sizeM = r.text.match(/(\d+(?:\.\d+)?\s*(?:lb|lbs|oz|fl\s*oz|g|kg|ml|l|ct|pk|gal|qt)\b)/i);
    const perLb = /\/\s*lb|per lb/i.test(r.text);
    products.push({
      sku,
      title: r.name,
      brand: null,
      size: sizeM ? sizeM[1] : null,
      priceUnit: perLb ? 'lb' : null,
      priceRegular: regular,
      pricePromo: promo,
      promoText: promo ? 'Weekly Special' : null,
      url: r.href,
      imageUrl: null,
      inStock: true,
    });
  }
  return products;
}
