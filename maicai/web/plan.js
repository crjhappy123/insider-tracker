// 购物清单优化 —— 纯函数，不碰数据库不碰文件。
//
// 放在 web/ 下是为了只有一份代码：浏览器直接 import 它，Node 端 src/basket.js 也 import 同一个文件。
//   本地跑     src/basket.js 从 SQLite 取数据后调它
//   线上静态站  浏览器加载 snapshot.json 后直接调它
// 这样线上和本地算出来的方案一定一致，不会出现「本地推荐 A、线上推荐 B」。

/**
 * @param {object} o
 * @param {Array} o.rows      每个 (商品, 门店) 的当前价格
 *                            {itemId, storeId, storeName, unitPrice, packQty, title, size,
 *                             verdict, discount, url, productId}
 * @param {Array} o.entries   购物清单 [{itemId, qty}]，qty 单位 = 该商品的 unit
 * @param {Array} o.stores    [{id, name, driveMinutes}]
 * @param {Array} o.catalog   [{id, name, unit, weekly}]
 * @param {number} o.perMinute 每分钟车程折算成本($)
 */
export function planBasketFrom({ rows, entries, stores, catalog, perMinute = 0.35 }) {
  const items = new Map(catalog.map((i) => [i.id, i]));

  // (itemId, storeId) -> 单价最低的那个商品
  const bestPrice = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.unitPrice)) continue;
    const k = `${r.itemId}|${r.storeId}`;
    const prev = bestPrice.get(k);
    if (!prev || r.unitPrice < prev.unitPrice) bestPrice.set(k, r);
  }

  const wanted = entries
    .map((e) => ({ ...e, item: items.get(e.itemId) }))
    .filter((e) => e.item && e.qty > 0);

  const availableAnywhere = new Set();
  for (const e of wanted) {
    if (stores.some((s) => bestPrice.has(`${e.itemId}|${s.id}`))) availableAnywhere.add(e.itemId);
  }
  const unavailable = wanted
    .filter((e) => !availableAnywhere.has(e.itemId))
    .map((e) => ({ itemId: e.itemId, itemName: e.item.name, reason: '所有门店都没抓到可比价格' }));
  const shoppable = wanted.filter((e) => availableAnywhere.has(e.itemId));

  const tripCostOf = (subset) =>
    subset.reduce((sum, s) => sum + (s.driveMinutes || 0) * 2 * perMinute, 0);

  // 门店不多（6 家 -> 63 种非空组合），直接全枚举求精确最优解
  const plans = [];
  for (let mask = 1; mask < 1 << stores.length; mask++) {
    const subset = stores.filter((_, i) => mask & (1 << i));
    const lines = [];
    let goodsCost = 0;
    const missing = [];

    for (const e of shoppable) {
      let pick = null;
      for (const s of subset) {
        const r = bestPrice.get(`${e.itemId}|${s.id}`);
        if (r && (!pick || r.unitPrice < pick.unitPrice)) pick = r;
      }
      if (!pick) {
        missing.push({ itemId: e.itemId, itemName: e.item.name });
        continue;
      }
      const cost = pick.unitPrice * e.qty;
      goodsCost += cost;
      lines.push({
        itemId: e.itemId,
        itemName: e.item.name,
        qty: e.qty,
        unit: e.item.unit,
        storeId: pick.storeId,
        storeName: pick.storeName,
        title: pick.title,
        size: pick.size,
        unitPrice: pick.unitPrice,
        cost,
        packQty: pick.packQty,
        // 起买量超过需要量一倍以上就提醒 —— Costco 卖 4 磅装，你只要 1 磅，
        // 单价再低多出来的三磅吃不完还是浪费
        packOversized: Number.isFinite(pick.packQty) && pick.packQty > e.qty * 2 ? pick.packQty : null,
        verdict: pick.verdict,
        discount: pick.discount,
        url: pick.url,
      });
    }

    const trip = tripCostOf(subset);
    plans.push({
      storeIds: subset.map((s) => s.id),
      storeNames: subset.map((s) => s.name),
      lines,
      missing,
      goodsCost,
      tripCost: trip,
      totalCost: goodsCost + trip,
      complete: missing.length === 0,
    });
  }

  const complete = plans.filter((p) => p.complete);
  const pool = complete.length ? complete : plans;
  const ranked = [...pool].sort((a, b) => a.totalCost - b.totalCost);
  const bestPlan = ranked[0] ?? null;

  // 对照组：只去一家店最省事。单店往往买不全，所以先按覆盖多少样排、再按价格排；
  // 而且比价必须只比「两边都买得到」的那部分，否则单店会因为少买东西而假装便宜。
  const singles = plans
    .filter((p) => p.storeIds.length === 1)
    .sort((a, b) => b.lines.length - a.lines.length || a.totalCost - b.totalCost);
  const bestSingle = singles[0] ?? null;

  let oneStop = null;
  if (bestSingle && bestPlan && bestSingle.storeIds.join() !== bestPlan.storeIds.join()) {
    const sharedIds = new Set(bestSingle.lines.map((l) => l.itemId));
    const singleShared = bestSingle.lines.reduce((s, l) => s + l.cost, 0) + bestSingle.tripCost;
    const bestShared =
      bestPlan.lines.filter((l) => sharedIds.has(l.itemId)).reduce((s, l) => s + l.cost, 0) + bestPlan.tripCost;
    oneStop = {
      storeIds: bestSingle.storeIds,
      storeNames: bestSingle.storeNames,
      totalCost: bestSingle.totalCost,
      coveredCount: bestSingle.lines.length,
      missingCount: bestSingle.missing.length,
      missing: bestSingle.missing,
      extraCostVsBest: singleShared - bestShared,
    };
  }

  // 最差组合：每样都在最贵的店买（不含车程），用来算「这套建议帮你省了多少」
  let worstGoods = 0;
  for (const e of shoppable) {
    const prices = stores
      .map((s) => bestPrice.get(`${e.itemId}|${s.id}`)?.unitPrice)
      .filter((n) => Number.isFinite(n));
    if (prices.length) worstGoods += Math.max(...prices) * e.qty;
  }

  return {
    perMinute,
    unavailable,
    plan: bestPlan ? { ...bestPlan, byStore: groupByStore(bestPlan) } : null,
    alternatives: ranked.slice(0, 6).map((p) => ({
      storeIds: p.storeIds,
      storeNames: p.storeNames,
      goodsCost: p.goodsCost,
      tripCost: p.tripCost,
      totalCost: p.totalCost,
      complete: p.complete,
      missingCount: p.missing.length,
      deltaVsBest: bestPlan ? p.totalCost - bestPlan.totalCost : 0,
    })),
    oneStopOption: oneStop,
    savingVsWorst: bestPlan ? worstGoods - bestPlan.goodsCost : null,
    note: buildNote(bestPlan, oneStop),
  };
}

function groupByStore(plan) {
  const m = new Map();
  for (const l of plan.lines) {
    if (!m.has(l.storeId)) m.set(l.storeId, { storeId: l.storeId, storeName: l.storeName, lines: [], subtotal: 0 });
    const g = m.get(l.storeId);
    g.lines.push(l);
    g.subtotal += l.cost;
  }
  return [...m.values()].sort((a, b) => b.subtotal - a.subtotal);
}

function buildNote(best, oneStop) {
  if (!best) return '还没有可比价的数据，先跑一次抓取。';
  if (best.storeIds.length === 1) return `一家店就够了：${best.storeNames[0]}，不用多跑。`;
  if (!oneStop) return `建议跑 ${best.storeNames.join(' + ')}。`;

  const s = oneStop.storeNames[0];
  const parts = [`推荐跑 ${best.storeNames.join(' + ')}。`];

  if (oneStop.missingCount > 0) {
    parts.push(
      `只去 ${s} 一家最省事，但清单里有 ${oneStop.missingCount} 样买不到（` +
      `${oneStop.missing.slice(0, 4).map((m) => m.itemName).join('、')}${oneStop.missingCount > 4 ? '等' : ''}）。`
    );
  } else {
    parts.push(`只去 ${s} 一家也能买全。`);
  }

  const extra = oneStop.extraCostVsBest;
  if (extra > 3) {
    parts.push(`同样这些东西只在 ${s} 买要多花 $${extra.toFixed(2)}（已扣掉多跑一趟的车程成本），值得分开买。`);
  } else if (extra > 0) {
    parts.push(`不过同样这些东西只在 ${s} 买也只多花 $${extra.toFixed(2)}，图省事就一家买完算了。`);
  } else {
    parts.push(`同样这些东西在 ${s} 反而更便宜 $${(-extra).toFixed(2)}，是为了买齐才需要多跑一家。`);
  }
  return parts.join('');
}
