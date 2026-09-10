// 数据层。两种模式共用同一套前端：
//
//   本地 (npm start)     -> 打 src/server.js 的 /api/*，数据来自 SQLite
//   线上 (rudystock/shop) -> 读构建期导出的 snapshot.json，全部计算在浏览器里做
//
// 静态模式返回的数据结构和 API 完全一致，所以页面渲染代码一行都不用改。
// 需要 90 天历史才能算的东西（历史中位价、真假促销判断）在构建期已经算完了，
// 浏览器只做分组、排序和购物清单组合优化。

import { planBasketFrom } from './plan.js';

const isStatic = document.body.dataset.mode === 'static';
export const MODE = isStatic ? 'static' : 'api';

/* ---------- 本地模式：直接打 API ---------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  const j = await res.json().catch(() => ({ error: '响应不是 JSON' }));
  if (!res.ok || j.error) throw new Error(j.error || `请求失败 ${res.status}`);
  return j;
}

const apiProvider = {
  summary: () => api('/api/summary'),
  today: () => api('/api/today'),
  compare: () => api('/api/compare'),
  item: (id) => api(`/api/item?id=${encodeURIComponent(id)}`),
  history: (pid, days) => api(`/api/history?productId=${pid}&days=${days}`),
  basket: () => api('/api/basket'),
  plan: (entries) =>
    api('/api/basket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
  search: (q) => api(`/api/search?q=${encodeURIComponent(q)}`),
  setMatch: (productId, itemId, blocked) =>
    api('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, itemId, blocked }),
    }),
  canEditMatches: true,
};

/* ---------- 静态模式：读 JSON，本地算 ---------- */
let snapPromise = null;
let histPromise = null;

function snapshot() {
  snapPromise ??= fetch('./data/snapshot.json').then((r) => {
    if (!r.ok) throw new Error(`读不到 data/snapshot.json (${r.status})`);
    return r.json();
  });
  return snapPromise;
}
function histories() {
  histPromise ??= fetch('./data/history.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));   // 走势图没了不影响主功能
  return histPromise;
}

const storeMeta = (s, id) => s.stores.find((x) => x.id === id);
const storeLabel = (s, id) => { const x = storeMeta(s, id); return x ? (x.nameZh || x.name) : id; };
const itemMeta = (s, id) => s.catalog.find((x) => x.id === id);

const staticProvider = {
  async summary() {
    const s = await snapshot();
    return {
      home: s.home,
      stores: s.stores,
      catalog: s.catalog,
      categories: s.categories,
      tripCost: s.tripCost,
      dealConfig: s.dealConfig,
      scrapers: s.scrapers,
      runs: s.runs,
      today: s.day,
      generatedAt: s.generatedAt,
    };
  },

  async today() {
    const s = await snapshot();

    // 每样东西当前最便宜的那家店
    const cheapest = new Map();
    for (const r of s.rows) {
      const prev = cheapest.get(r.itemId);
      if (!prev || r.unitPrice < prev.unitPrice) cheapest.set(r.itemId, r);
    }

    const deals = s.rows
      .filter((r) => r.verdict === 'real' && (itemMeta(s, r.itemId)?.weekly ?? 0) > 0)
      .map((r) => decorate(s, r, { isCheapestNow: cheapest.get(r.itemId)?.productId === r.productId }))
      .sort((a, b) => b.weeklySaving - a.weeklySaving || b.discount - a.discount);

    const fakeDeals = s.rows
      .filter((r) => r.verdict === 'fake')
      .map((r) => decorate(s, r))
      .sort((a, b) => (b.weekly || 0) - (a.weekly || 0));

    const covered = new Set(s.rows.map((r) => r.itemId));
    const missing = s.catalog
      .filter((i) => !covered.has(i.id) && (i.weekly || 0) > 0)
      .map((i) => ({ itemId: i.id, itemName: i.name, unit: i.unit }));

    return {
      day: s.day,
      deals,
      fakeDeals,
      missing,
      totalWeeklySaving: deals.reduce((a, d) => a + d.weeklySaving, 0),
      stats: {
        products: s.rows.length + s.uncomparable.length,
        comparable: s.rows.length,
        withHistory: s.rows.filter((r) => r.historyDays >= s.dealConfig.MIN_HISTORY).length,
      },
    };
  },

  async compare() {
    const s = await snapshot();
    const grid = new Map();
    for (const r of s.rows) {
      if (!grid.has(r.itemId)) grid.set(r.itemId, new Map());
      grid.get(r.itemId).set(r.storeId, r);
    }
    return {
      stores: s.stores.map((x) => ({ id: x.id, name: x.nameZh || x.name, driveMinutes: x.driveMinutes })),
      rows: s.catalog.map((item) => {
        const m = grid.get(item.id) ?? new Map();
        const picks = s.stores.map((x) => m.get(x.id) ?? null);
        const valid = picks.filter(Boolean);
        const lowest = valid.length ? Math.min(...valid.map((v) => v.unitPrice)) : null;
        return {
          itemId: item.id,
          itemName: item.name,
          nameEn: item.nameEn,
          category: item.category,
          unit: item.unit,
          weekly: item.weekly,
          lowest,
          cells: picks.map((r) =>
            r
              ? {
                  storeId: r.storeId,
                  unitPrice: r.unitPrice,
                  isLowest: lowest != null && r.unitPrice <= lowest * 1.0001,
                  verdict: r.verdict,
                  discount: r.discount,
                  title: r.title,
                  productId: r.productId,
                  priceRegular: r.priceRegular,
                  pricePromo: r.pricePromo,
                  size: r.size,
                  unitBasis: r.unitBasis,
                  packQty: r.packQty,
                }
              : null
          ),
        };
      }),
    };
  },

  async item(id) {
    const s = await snapshot();
    const item = itemMeta(s, id);
    const mine = s.rows.filter((r) => r.itemId === id).map((r) => decorate(s, r));

    const byStore = new Map(mine.map((r) => [r.storeId, r]));
    const options = s.stores.map((x) => ({
      storeId: x.id,
      storeName: x.nameZh || x.name,
      branch: x.branch,
      driveMinutes: x.driveMinutes,
      best: byStore.get(x.id) ?? null,
      // 静态导出时每家店只留了最便宜的那个，所以没有「同店其它规格」可列
      alternatives: [],
    }));

    const priced = options.filter((o) => o.best);
    const lo = priced.reduce((a, b) => (!a || b.best.unitPrice < a.best.unitPrice ? b : a), null);
    const hi = priced.reduce((a, b) => (!a || b.best.unitPrice > a.best.unitPrice ? b : a), null);
    const spread = lo && hi ? hi.best.unitPrice - lo.best.unitPrice : null;

    return {
      item,
      options,
      cheapestStoreId: lo?.storeId ?? null,
      spread,
      spreadPct: spread && hi ? spread / hi.best.unitPrice : null,
      weeklySavingVsWorst: spread != null && item ? spread * (item.weekly || 0) : null,
      uncomparable: s.uncomparable
        .filter((u) => u.itemId === id)
        .map((u) => ({ ...u, storeId: u.storeId })),
      products: mine.map((r) => ({
        product_id: r.productId,
        store_id: r.storeId,
        title: r.title,
        size: r.size,
        item_id: r.itemId,
        score: r.matchScore,
        origin: r.matchOrigin,
        blocked: 0,
        unit_price: r.unitPrice,
        unit: r.unit,
        price_regular: r.priceRegular,
        price_promo: r.pricePromo,
      })),
    };
  },

  async history(productId) {
    const h = await histories();
    const pts = h[productId] ?? h[String(productId)] ?? [];
    return { productId, points: pts.map(([day, v]) => ({ day, unit_price: v })) };
  },

  async basket() {
    const s = await snapshot();
    const entries = s.catalog.filter((i) => (i.weekly || 0) > 0).map((i) => ({ itemId: i.id, qty: i.weekly }));
    return { entries, isDefault: true, ...(await this.plan(entries)) };
  },

  async plan(entries) {
    const s = await snapshot();
    return planBasketFrom({
      rows: s.rows,
      entries,
      stores: s.stores.map((x) => ({ id: x.id, name: x.nameZh || x.name, driveMinutes: x.driveMinutes })),
      catalog: s.catalog,
      perMinute: s.tripCost?.perMinute ?? 0.35,
    });
  },

  async search(q) {
    const s = await snapshot();
    const needle = q.toLowerCase();
    const results = [...s.rows, ...s.uncomparable]
      .filter((r) => (r.title || '').toLowerCase().includes(needle))
      .slice(0, 40)
      .map((r) => ({
        product_id: r.productId,
        store_id: r.storeId,
        title: r.title,
        size: r.size,
        item_id: r.itemId,
        origin: r.matchOrigin ?? 'auto',
        blocked: 0,
        price_regular: r.priceRegular,
        price_promo: r.pricePromo,
        unit_price: r.unitPrice ?? null,
        unit: r.unit ?? null,
      }));
    return { results };
  },

  setMatch() {
    throw new Error('线上是静态站点，改不了匹配。在本地跑 npm start 改，改完重新发布就会同步上来。');
  },

  canEditMatches: false,
};

export const DATA = isStatic ? staticProvider : apiProvider;

/** 把导出格式补齐成页面需要的字段（店名、商品名、每周用量这些） */
function decorate(s, r, extra = {}) {
  const item = itemMeta(s, r.itemId);
  return {
    ...r,
    storeName: r.storeName || storeLabel(s, r.storeId),
    itemName: item?.name ?? r.itemId,
    itemNameEn: item?.nameEn,
    category: item?.category,
    weekly: item?.weekly ?? 0,
    unit: r.unit || item?.unit,
    ...extra,
  };
}
