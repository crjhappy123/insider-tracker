// 离线样本数据源。
//
// 作用：不用任何凭证、不用装浏览器，就能把整个网站跑起来看到真实效果 ——
// 比价、单价归一化、历史价、真假促销判断、分店建议全都能验证。
// 价格是按各店的真实定价习惯编的（TJ 贵但稳定、99 Ranch 中式菜便宜促销猛、
// Fred Meyer 大促幅度大、T&T 中间偏贵），但**它不是真实价格**，别拿来做真决策。
//
// 真实数据靠 kroger.js / traderjoes.js / ranch99.js / tnt.js / costco.js / boohan.js。

import { loadCatalog } from '../db.js';

/* 每个 canonical unit 的基准价（美元），大致对齐西雅图地区 2024-2025 的水平 */
const BASE_PRICE = {
  'milk-whole': 4.10,        // /gal
  'eggs-large': 4.20,        // /dozen
  'greek-yogurt': 0.22,      // /oz
  'tofu-firm': 0.13,         // /oz
  banana: 0.72,              // /lb
  avocado: 1.35,             // /each
  strawberry: 3.60,          // /lb
  blueberry: 0.42,           // /oz
  'baby-bok-choy': 1.75,     // /lb
  'napa-cabbage': 1.15,      // /lb
  'green-onion': 0.95,       // /bunch
  ginger: 3.20,              // /lb
  garlic: 4.50,              // /lb
  tomato: 2.40,              // /lb
  cucumber: 0.90,            // /each
  broccoli: 2.20,            // /lb
  potato: 1.05,              // /lb
  'onion-yellow': 1.20,      // /lb
  spinach: 1.35,             // /bunch
  shiitake: 6.50,            // /lb
  'chicken-breast': 4.30,    // /lb
  'chicken-thigh': 2.60,     // /lb
  'pork-belly': 5.40,        // /lb
  'ground-pork': 4.20,       // /lb
  'ground-beef': 5.60,       // /lb
  'beef-hotpot': 8.90,       // /lb
  'salmon-fillet': 11.50,    // /lb
  'shrimp-raw': 9.80,        // /lb
  'jasmine-rice': 1.35,      // /lb
  'wheat-noodle': 0.19,      // /oz
  'bread-loaf': 3.30,        // /each
  'soy-sauce': 0.28,         // /floz
  'sesame-oil': 0.62,        // /floz
  'cooking-oil': 0.13,       // /floz
  'coffee-beans': 0.78,      // /oz
};

/* 各店定价风格。asian=1 表示中式食材有明显价格优势 */
const STORES = {
  fred_meyer: {
    factor: 1.00, asianFactor: 1.30, brands: ['Kroger', 'Simple Truth Organic', 'Private Selection', 'Fred Meyer'],
    promoRate: 0.22, promoDepth: [0.15, 0.35], skipAsian: 0.45,
  },
  trader_joes: {
    factor: 1.06, asianFactor: 1.25, brands: ["Trader Joe's"],
    promoRate: 0.03, promoDepth: [0.05, 0.12], skipAsian: 0.6,
  },
  ranch99: {
    factor: 1.08, asianFactor: 0.72, brands: ['', 'Kimlan', 'Lee Kum Kee', 'Three Ladies', 'Pearl River Bridge'],
    promoRate: 0.30, promoDepth: [0.12, 0.40], skipAsian: 0.05,
  },
  tnt: {
    factor: 1.12, asianFactor: 0.82, brands: ['', 'T&T', 'Amoy', 'Golden Phoenix', 'Haday'],
    promoRate: 0.24, promoDepth: [0.10, 0.32], skipAsian: 0.05,
  },
  // Costco：单价便宜但包装巨大，几乎不打折（靠月度优惠册），中式/韩式食材选择少
  costco: {
    factor: 0.80, asianFactor: 1.10, brands: ['Kirkland Signature', ''],
    promoRate: 0.10, promoDepth: [0.08, 0.20], skipAsian: 0.62, skipWestern: 0.05,
  },
  // Boo Han：韩式食材和肉类明显便宜，周报促销力度大，但西式商品品类少
  boohan: {
    factor: 1.02, asianFactor: 0.75, brands: ['', 'CJ', 'Sempio', "O'Food", 'Nongshim', 'Assi'],
    promoRate: 0.35, promoDepth: [0.15, 0.42], skipAsian: 0.05, skipWestern: 0.30,
  },
};

/* 明显偏中式的品类，用 asianFactor 定价 */
const ASIAN_ITEMS = new Set([
  'baby-bok-choy', 'napa-cabbage', 'shiitake', 'ginger', 'green-onion',
  'tofu-firm', 'pork-belly', 'beef-hotpot', 'wheat-noodle', 'soy-sauce',
  'sesame-oil', 'jasmine-rice', 'shrimp-raw',
]);

/* 各店对不同单位的包装习惯: [规格字符串, 目标单位数量, 是否按单位报价] */
const PACKS = {
  lb: {
    fred_meyer: [['per lb', 1, true], ['2 lb bag', 2, false], ['3 lb Bag', 3, false]],
    trader_joes: [['1 lb', 1, false], ['12 oz', 0.75, false], ['1.5 lb', 1.5, false]],
    ranch99: [['per lb', 1, true], ['per lb', 1, true], ['2 lb', 2, false]],
    tnt: [['per lb', 1, true], ['1.5 lb Tray', 1.5, false], ['per lb', 1, true]],
    costco: [['4 lb', 4, false], ['per lb', 1, true], ['3 lb Bag', 3, false]],
    boohan: [['per lb', 1, true], ['per lb', 1, true], ['2 lb', 2, false]],
  },
  oz: {
    fred_meyer: [['16 oz', 16, false], ['32 oz', 32, false], ['12 oz', 12, false]],
    trader_joes: [['16 oz', 16, false], ['10 oz', 10, false], ['24 oz', 24, false]],
    ranch99: [['14 oz', 14, false], ['16 oz', 16, false], ['2 x 16 oz', 32, false]],
    tnt: [['400 g', 14.11, false], ['16 oz', 16, false], ['500 g', 17.64, false]],
    costco: [['48 oz', 48, false], ['2 x 32 oz', 64, false], ['64 oz', 64, false]],
    boohan: [['450 g', 15.87, false], ['16 oz', 16, false], ['1 lb', 16, false]],
  },
  gal: {
    fred_meyer: [['1 gal', 1, false], ['1 gal', 1, false], ['0.5 gal', 0.5, false]],
    trader_joes: [['1 gal', 1, false], ['64 fl oz', 0.5, false], ['1 gal', 1, false]],
    ranch99: [['1 gal', 1, false], ['0.5 gal', 0.5, false], ['1 gal', 1, false]],
    tnt: [['4 L', 1.0567, false], ['2 L', 0.5283, false], ['1 gal', 1, false]],
    costco: [['2 x 1 gal', 2, false], ['1 gal', 1, false], ['2 gal', 2, false]],
    boohan: [['1 gal', 1, false], ['0.5 gal', 0.5, false], ['1 gal', 1, false]],
  },
  floz: {
    fred_meyer: [['15 fl oz', 15, false], ['48 fl oz', 48, false], ['33.8 fl oz', 33.8, false]],
    trader_joes: [['16.9 fl oz', 16.9, false], ['8.45 fl oz', 8.45, false], ['32 fl oz', 32, false]],
    ranch99: [['16.9 fl oz', 16.9, false], ['500 ml', 16.91, false], ['1.8 L', 60.87, false]],
    tnt: [['500 ml', 16.91, false], ['750 ml', 25.36, false], ['1 L', 33.81, false]],
    costco: [['101 fl oz', 101, false], ['2 x 48 fl oz', 96, false], ['128 fl oz', 128, false]],
    boohan: [['500 ml', 16.91, false], ['900 ml', 30.43, false], ['1.5 L', 50.72, false]],
  },
  each: {
    fred_meyer: [['each', 1, false], ['3 ct', 3, false], ['each', 1, false]],
    trader_joes: [['each', 1, false], ['4 ct', 4, false], ['each', 1, false]],
    ranch99: [['each', 1, false], ['each', 1, false], ['2 ct', 2, false]],
    tnt: [['each', 1, false], ['3 ct Pack', 3, false], ['each', 1, false]],
    costco: [['6 ct', 6, false], ['4 ct', 4, false], ['each', 1, false]],
    boohan: [['each', 1, false], ['each', 1, false], ['1 bunch', 1, false]],
  },
  dozen: {
    fred_meyer: [['12 ct', 1, false], ['18 ct', 1.5, false], ['12 ct', 1, false]],
    trader_joes: [['dozen', 1, false], ['12 ct', 1, false], ['6 ct', 0.5, false]],
    ranch99: [['12 ct', 1, false], ['30 ct', 2.5, false], ['12 ct', 1, false]],
    tnt: [['12 ct', 1, false], ['18 ct', 1.5, false], ['12 ct', 1, false]],
    costco: [['24 ct', 2, false], ['18 ct', 1.5, false], ['24 ct', 2, false]],
    boohan: [['12 ct', 1, false], ['30 ct', 2.5, false], ['12 ct', 1, false]],
  },
};

/* ---------- 确定性随机：同样的输入永远出同样的价，方便调试和复现 ---------- */
function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function rnd01(...parts) {
  const h = hash(parts.join('|'));
  // 必须 >>> 0 转回无符号：JS 的 ^ 返回有符号 int32，高位为 1 时会得到负数
  const mixed = ((h ^ (h >>> 15)) >>> 0);
  return (mixed % 100000) / 100000;
}

const round99 = (n) => {
  // 超市定价习惯：小数结尾偏向 .99 / .49 / .29
  const cents = Math.round(n * 100);
  if (cents < 100) return Math.max(0.19, Math.round(n * 100) / 100);
  const ends = [99, 49, 29, 79, 89];
  const dollars = Math.floor(cents / 100);
  const pick = ends[dollars % ends.length];
  const cand = dollars * 100 + pick;
  return (Math.abs(cand - cents) <= 30 ? cand : cents) / 100;
};

// 亚洲超市的散称蔬果肉类基本不带品牌，只有瓶装调料和米面才有 ——
// 不区分的话会生成「Lee Kum Kee 全脂牛奶」这种不像话的标题
const BRANDED_CATEGORIES = new Set(['调料', '主食', '饮品']);
const STORE_OWN_BRAND = new Set(['fred_meyer', 'trader_joes', 'costco']); // 自有品牌覆盖全品类

function titleFor(item, brand, size, storeId) {
  const base = item.nameEn;
  const parts = [];
  if (brand) parts.push(brand);
  parts.push(base);
  let t = parts.join(' ');
  if (size && size !== 'per lb' && size !== 'each') t += `, ${size}`;
  if (storeId === 'ranch99' && ASIAN_ITEMS.has(item.id) && rnd01(item.id, storeId, 'zh') > 0.5) {
    t += ' (Asian Grocery)';
  }
  return t;
}

/**
 * 生成一家店某一天的商品价格列表。
 * @param {string} storeId
 * @param {{day?:string, items?:Array}} opts
 */
export function generate(storeId, { day, items } = {}) {
  const cfg = STORES[storeId];
  if (!cfg) throw new Error(`样本数据没有配置门店 ${storeId}`);
  const catalog = items ?? loadCatalog();
  const out = [];

  // 用天数做缓慢的季节性/通胀漂移，让历史价有真实的波动
  const dayIndex = day ? Math.floor(Date.parse(`${day}T12:00:00`) / 86400000) : 0;

  for (const item of catalog) {
    const base = BASE_PRICE[item.id];
    if (base == null) continue;

    const isAsian = ASIAN_ITEMS.has(item.id);
    // 中式食材在美式超市可能干脆不卖
    if (isAsian && rnd01(storeId, item.id, 'stock') < cfg.skipAsian) continue;
    // TJ 不卖生姜大蒜以外的散称中式菜之类，用同一个机制表达
    if (!isAsian && rnd01(storeId, item.id, 'stock2') < (cfg.skipWestern ?? 0.04)) continue;

    const packOptions = PACKS[item.unit]?.[storeId];
    if (!packOptions || packOptions.length === 0) continue;

    // 每家店可能有 1-2 个不同规格的同类商品
    const variantCount = rnd01(storeId, item.id, 'variants') > 0.62 ? 2 : 1;

    for (let v = 0; v < variantCount; v++) {
      const [size, qty, byUnit] = packOptions[Math.floor(rnd01(storeId, item.id, `pack${v}`) * packOptions.length) % packOptions.length];
      const useBrand = STORE_OWN_BRAND.has(storeId) || BRANDED_CATEGORIES.has(item.category);
      const brand = useBrand
        ? cfg.brands[Math.floor(rnd01(storeId, item.id, `brand${v}`) * cfg.brands.length) % cfg.brands.length]
        : '';

      const storeFactor = isAsian ? cfg.asianFactor : cfg.factor;
      const itemNoise = 0.90 + rnd01(storeId, item.id, `noise${v}`) * 0.22;
      // 大包装略有折扣
      const bulk = qty > 1.6 ? 0.93 : 1;
      // 缓慢漂移 ±6%
      const drift = 1 + 0.06 * Math.sin((dayIndex + hash(item.id) % 90) / 14);

      const perUnit = base * storeFactor * itemNoise * bulk * drift;
      const regular = round99(byUnit ? perUnit : perUnit * qty);

      // 促销：按周为周期，某些周整周促销
      const week = Math.floor(dayIndex / 7);
      const onPromo = rnd01(storeId, item.id, `promo${v}`, String(week)) < cfg.promoRate;
      let promo = null;
      let promoText = null;
      if (onPromo) {
        const [lo, hi] = cfg.promoDepth;
        const depth = lo + rnd01(storeId, item.id, `depth${v}`, String(week)) * (hi - lo);
        promo = round99(regular * (1 - depth));
        if (promo >= regular) promo = Math.round(regular * 0.9 * 100) / 100;
        promoText = depth > 0.28 ? 'Weekly Ad — Big Save' : 'Weekly Ad';
      }

      // 少量商品挂着「Sale」但其实没便宜多少 —— 用来验证假促销识别
      if (!onPromo && rnd01(storeId, item.id, `fake${v}`, String(week)) < 0.06) {
        promo = round99(regular * 0.99);
        promoText = 'Everyday Low Price';
      }

      out.push({
        sku: `SAMPLE-${storeId}-${item.id}-${v}`,
        title: titleFor(item, brand, size, storeId),
        brand: brand || null,
        size,
        priceUnit: byUnit ? 'lb' : null,
        priceRegular: regular,
        pricePromo: promo,
        promoText,
        url: null,
        inStock: rnd01(storeId, item.id, `oos${v}`, day || '') > 0.02,
        day,
      });
    }
  }
  return out;
}

export const meta = {
  id: 'sample',
  label: '离线样本数据',
  needsCredentials: false,
  verified: true,
};
