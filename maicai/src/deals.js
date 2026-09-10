// 促销识别 + 按你家消费习惯排序。
//
// 这里做了一个刻意的设计：**不相信店里挂的「Sale」标签**。
// 超市常年把某样东西标成促销，或者先把原价改高再打折。所以判断「便宜」只看一件事：
// 今天的单价 vs 这个商品过去 N 天的历史中位单价。
// 挂了促销标但没比历史便宜的，单独归到「假促销」里告诉你，别被骗。

import { latestSnapshots, priceHistory, loadCatalog, getStores, today } from './db.js';

const WINDOW_DAYS = 90;
const REAL_DEAL_MIN = 0.08;   // 比历史中位便宜 8% 以上才算真降价
const FAKE_DEAL_MAX = 0.03;   // 挂促销但便宜不到 3% -> 假促销
const MIN_HISTORY = 5;        // 少于这么多天历史，不做判断，只标「数据不足」

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function min(nums) {
  const a = nums.filter((n) => Number.isFinite(n) && n > 0);
  return a.length ? Math.min(...a) : null;
}

/**
 * 给每个「最新快照」附上历史基准和降价幅度。
 */
export function analyze({ day = null, windowDays = WINDOW_DAYS } = {}) {
  const items = new Map(loadCatalog().map((i) => [i.id, i]));
  const stores = new Map(getStores().map((s) => [s.id, s]));
  const rows = latestSnapshots({ day });
  const out = [];

  for (const r of rows) {
    const item = items.get(r.item_id);
    if (!item) continue;

    const eff = r.price_promo ?? r.price_regular;
    if (!Number.isFinite(eff)) continue;

    const hist = priceHistory(r.product_id, windowDays, r.day);
    const histUnit = hist.map((h) => h.unit_price);
    const medUnit = median(histUnit);
    const lowUnit = min(histUnit);

    const unitNow = r.unit_price;
    const hasHistory = hist.length >= MIN_HISTORY && medUnit != null && Number.isFinite(unitNow);

    const discount = hasHistory ? (medUnit - unitNow) / medUnit : null;
    const flaggedPromo = r.price_promo != null && r.price_promo < (r.price_regular ?? Infinity);

    let verdict;
    if (!hasHistory) verdict = 'unknown';
    else if (discount >= REAL_DEAL_MIN) verdict = 'real';
    else if (flaggedPromo && discount < FAKE_DEAL_MAX) verdict = 'fake';
    else verdict = 'normal';

    // 一周能省多少钱 = 单价降幅 × 你家一周买多少
    const weeklySaving = hasHistory ? Math.max(0, (medUnit - unitNow)) * (item.weekly || 0) : 0;
    const isLowestEver = hasHistory && lowUnit != null && unitNow <= lowUnit * 1.001;

    out.push({
      productId: r.product_id,
      storeId: r.store_id,
      storeName: stores.get(r.store_id)?.name_zh || stores.get(r.store_id)?.name || r.store_id,
      itemId: r.item_id,
      itemName: item.name,
      itemNameEn: item.nameEn,
      category: item.category,
      weekly: item.weekly,
      title: r.title,
      brand: r.brand,
      size: r.size,
      url: r.url,
      day: r.day,
      priceRegular: r.price_regular,
      pricePromo: r.price_promo,
      promoText: r.promo_text,
      unitPrice: unitNow,
      unit: r.unit || item.unit,
      unitBasis: r.unit_basis,
      packQty: r.pack_qty,
      matchScore: r.score,
      matchOrigin: r.origin,
      historyDays: hist.length,
      medianUnitPrice: medUnit,
      lowestUnitPrice: lowUnit,
      discount,
      flaggedPromo,
      isLowestEver,
      verdict,
      weeklySaving,
    });
  }
  return out;
}

/**
 * 今日推送用的分组结果。
 */
export function todayDeals(opts = {}) {
  const rows = analyze(opts);

  // 同一个 item 在同一家店可能匹配到多个商品（不同品牌/规格），只留单价最低的那个
  const bestPerItemStore = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.unitPrice)) continue;
    const k = `${r.itemId}|${r.storeId}`;
    const prev = bestPerItemStore.get(k);
    if (!prev || r.unitPrice < prev.unitPrice) bestPerItemStore.set(k, r);
  }
  const best = [...bestPerItemStore.values()];

  // 每个 item 全局最便宜的那家店
  const cheapestByItem = new Map();
  for (const r of best) {
    const prev = cheapestByItem.get(r.itemId);
    if (!prev || r.unitPrice < prev.unitPrice) cheapestByItem.set(r.itemId, r);
  }

  const deals = best
    .filter((r) => r.verdict === 'real' && r.weekly > 0)
    .map((r) => ({ ...r, isCheapestNow: cheapestByItem.get(r.itemId)?.productId === r.productId }))
    .sort((a, b) => b.weeklySaving - a.weeklySaving || b.discount - a.discount);

  const fake = best
    .filter((r) => r.verdict === 'fake')
    .sort((a, b) => (b.weekly || 0) - (a.weekly || 0));

  // 你常买但一家店都没抓到价的东西 —— 说明匹配规则或抓取需要修
  const covered = new Set(best.map((r) => r.itemId));
  const missing = loadCatalog()
    .filter((i) => !covered.has(i.id) && i.weekly > 0)
    .map((i) => ({ itemId: i.id, itemName: i.name, unit: i.unit }));

  return {
    day: opts.day || today(),
    deals,
    fakeDeals: fake,
    missing,
    totalWeeklySaving: deals.reduce((s, d) => s + d.weeklySaving, 0),
    stats: {
      products: rows.length,
      comparable: best.length,
      withHistory: best.filter((r) => r.historyDays >= MIN_HISTORY).length,
    },
  };
}

/**
 * 单品比价：一样东西在各家店分别多少钱，谁最便宜。
 */
export function compareItem(itemId, opts = {}) {
  const rows = analyze(opts).filter((r) => r.itemId === itemId);
  const stores = getStores();

  const byStore = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.unitPrice)) continue;
    const prev = byStore.get(r.storeId);
    if (!prev || r.unitPrice < prev.unitPrice) byStore.set(r.storeId, r);
  }

  const options = stores.map((s) => ({
    storeId: s.id,
    storeName: s.name_zh || s.name,
    branch: s.branch,
    driveMinutes: s.drive_minutes,
    best: byStore.get(s.id) ?? null,
    alternatives: rows
      .filter((r) => r.storeId === s.id && r.productId !== byStore.get(s.id)?.productId)
      .sort((a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity)),
  }));

  const priced = options.filter((o) => o.best);
  const cheapest = priced.reduce((a, b) => (!a || b.best.unitPrice < a.best.unitPrice ? b : a), null);
  const dearest = priced.reduce((a, b) => (!a || b.best.unitPrice > a.best.unitPrice ? b : a), null);

  const item = loadCatalog().find((i) => i.id === itemId);
  const spread = cheapest && dearest ? dearest.best.unitPrice - cheapest.best.unitPrice : null;

  return {
    item,
    options,
    cheapestStoreId: cheapest?.storeId ?? null,
    spread,
    spreadPct: spread && dearest ? spread / dearest.best.unitPrice : null,
    weeklySavingVsWorst: spread != null && item ? spread * (item.weekly || 0) : null,
    // 无法比价的（解析不出规格）单独列出来，不要偷偷丢掉
    uncomparable: rows.filter((r) => !Number.isFinite(r.unitPrice)),
  };
}

/** 所有 item 的比价总览，比价页的表格 */
export function compareAll(opts = {}) {
  const rows = analyze(opts);
  const items = loadCatalog();
  const stores = getStores();

  const grid = new Map(); // itemId -> storeId -> row
  for (const r of rows) {
    if (!Number.isFinite(r.unitPrice)) continue;
    if (!grid.has(r.itemId)) grid.set(r.itemId, new Map());
    const m = grid.get(r.itemId);
    const prev = m.get(r.storeId);
    if (!prev || r.unitPrice < prev.unitPrice) m.set(r.storeId, r);
  }

  return {
    stores: stores.map((s) => ({ id: s.id, name: s.name_zh || s.name, driveMinutes: s.drive_minutes })),
    rows: items.map((item) => {
      const m = grid.get(item.id) ?? new Map();
      const prices = stores.map((s) => m.get(s.id) ?? null);
      const valid = prices.filter(Boolean);
      const lowest = valid.length ? Math.min(...valid.map((v) => v.unitPrice)) : null;
      return {
        itemId: item.id,
        itemName: item.name,
        nameEn: item.nameEn,
        category: item.category,
        unit: item.unit,
        weekly: item.weekly,
        lowest,
        cells: stores.map((s, i) => {
          const r = prices[i];
          if (!r) return null;
          return {
            storeId: s.id,
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
          };
        }),
      };
    }),
  };
}

export const CONFIG = { WINDOW_DAYS, REAL_DEAL_MIN, FAKE_DEAL_MAX, MIN_HISTORY };
