// 99 Ranch Market (大华) —— Edmonds 店
//
// 用它自己的内部 JSON API，字段干净，规格和促销价都齐：
//   POST /be-api/store/web/list       {zipCode, deliveryType:1}  -> 附近门店和 storeId
//   POST /be-api/search/web/products  {keyword, page, pageSize}  -> 商品，storeid 放请求头
//
// 为什么还要浏览器：站点前面挂着 Cloudflare 机器人防护，纯 fetch 直接调 API 会返回
// code 101002 TimeOut Error。先用真实浏览器打开首页拿到 __cf_bm cookie，之后在页面
// 上下文里连续调 API 就都通了 —— 一次页面加载 + N 次 API 调用，比爬页面快得多也稳得多。
//
// **storeid 这个头必须显式带上。** 默认是 8899，那是加州 Buena Park 的
// "Warehouse Savings" 仓库店。不带这个头抓到的是加州仓库价，
// 却会被当成 Edmonds 的价格用 —— 不报错、静默地给出错的比价结果。
// 所以下面拿不到本地 storeId 时宁可直接失败，也不用默认门店的价格。

import { withPage } from './browser.js';

const BASE = 'https://www.99ranch.com';
const PAGE_SIZE = 24;

/** 在页面上下文里调它的内部 API（带着 __cf_bm cookie 和真实指纹） */
async function callApi(page, path, body, storeId) {
  return page.evaluate(
    async ([p, b, sid]) => {
      const headers = { 'Content-Type': 'application/json', accept: 'application/json' };
      if (sid) headers.storeid = String(sid);
      try {
        const res = await fetch(p, { method: 'POST', headers, body: JSON.stringify(b), credentials: 'include' });
        return { ok: res.ok, status: res.status, json: await res.json() };
      } catch (e) {
        return { ok: false, status: 0, error: String(e && e.message) };
      }
    },
    [path, body, storeId ?? null]
  );
}

/** 按邮编查附近门店。deliveryType:1 = 到店自提，返回的才是实体店 */
export async function findStores(page, zipCode) {
  const r = await callApi(page, '/be-api/store/web/list', { zipCode: String(zipCode), deliveryType: 1 });
  if (r.json?.code !== 0) throw new Error(`门店查询失败: ${r.json?.message ?? r.status}`);
  const list = Array.isArray(r.json.data) ? r.json.data : (r.json.data?.records ?? []);
  return list.map((s) => ({
    storeId: String(s.storeId ?? s.id),
    name: s.storeName ?? s.name ?? '',
    address: [s.address, s.city, s.state, s.zipCode].filter(Boolean).join(', '),
    city: s.city ?? '',
  }));
}

function pickStore(stores, branch) {
  if (stores.length === 0) return null;
  // stores.json 里写的是 "Edmonds (Hwy 99)"，取第一个词去匹配门店名或城市
  const want = String(branch || '').split(/[\s(]/)[0].toLowerCase();
  if (want) {
    const hit = stores.find(
      (s) => s.name.toLowerCase().includes(want) || s.city.toLowerCase().includes(want)
    );
    if (hit) return hit;
  }
  return stores[0];
}

function toProduct(x) {
  const retail = Number(x.retailPrice ?? x.price);
  const sale = Number(x.salePrice ?? x.price);
  if (!Number.isFinite(retail) || retail <= 0) return null;

  const promo = Number.isFinite(sale) && sale > 0 && sale < retail ? sale : null;

  // 规格：netWeight + netWeightUom 是最可靠的（"14" + "OZ"）。
  // 缺的时候退回 variantNameEN，它长这样 "12.0000 oz/each"。
  let size = null;
  if (x.netWeight != null && x.netWeightUom) {
    size = `${x.netWeight} ${x.netWeightUom}`;
  } else if (typeof x.variantNameEN === 'string' && /\d/.test(x.variantNameEN)) {
    size = x.variantNameEN.replace(/\.0+(?=\s|$)/, '');   // "12.0000 oz/each" -> "12 oz/each"
  }

  // 散称按磅卖的商品没有净重，靠 saleUom 判断
  const uom = String(x.saleUom ?? '').toLowerCase();
  const byWeight = !size && /^(lb|lbs|pound|pounds)$/.test(uom);

  const sku = String(x.variantId ?? x.articleNumber ?? x.productId ?? '');
  if (!sku) return null;

  const title = x.productNameEN || x.productName;
  if (!title) return null;

  return {
    sku,
    title,
    brand: x.brandNameEN || x.brandName || null,
    size,
    priceUnit: byWeight ? 'lb' : null,
    priceRegular: retail,
    pricePromo: promo,
    promoText: promo ? 'Weekly Ad' : null,
    url: x.productId ? `${BASE}/product/${x.productId}` : null,
    imageUrl: typeof x.image === 'string' ? x.image : (x.productImage?.path ?? null),
    inStock: x.available == null ? true : Number(x.available) > 0,
  };
}

export async function scrape({ storeConfig, items, log = console.log, homeZip = '98155' }) {
  const terms = items.map((i) => (i.match?.any ?? []).slice().sort((a, b) => b.length - a.length)[0] || i.nameEn);

  return withPage(async (page) => {
    // 先真实打开首页，拿到过 Cloudflare 防护的 cookie
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const zip = storeConfig?.zipCode || homeZip;
    let storeId = storeConfig?.ranch99StoreId ?? null;

    if (!storeId) {
      const stores = await findStores(page, zip);
      log(`  [99 Ranch] ${zip} 附近 ${stores.length} 家店: ${stores.map((s) => `${s.name}(${s.storeId})`).join(', ')}`);
      const picked = pickStore(stores, storeConfig?.branch);
      if (!picked) {
        // 宁可没数据，也不要用默认门店（加州仓库）的价格冒充本地价
        throw new Error(
          `按邮编 ${zip} 没查到 99 Ranch 门店，拿不到本地 storeId。` +
          '不带 storeid 抓到的是加州 Buena Park 仓库店的价格，会静默给出错的比价结果，所以这里直接放弃。'
        );
      }
      storeId = picked.storeId;
      log(`  [99 Ranch] 用门店 ${picked.name} (storeId ${storeId}) — ${picked.address}`);
    }

    const all = new Map();
    let failed = 0;
    for (const term of terms) {
      const r = await callApi(page, '/be-api/search/web/products',
        { page: 1, pageSize: PAGE_SIZE, keyword: term, availability: 1 }, storeId);

      if (r.json?.code !== 0) {
        failed++;
        log(`  [99 Ranch] "${term}" 失败: ${r.json?.message ?? r.error ?? r.status}`);
        await page.waitForTimeout(800);   // 可能是限流，慢一点
        continue;
      }

      const list = r.json.data?.records ?? r.json.data?.list ?? (Array.isArray(r.json.data) ? r.json.data : []);
      let n = 0;
      for (const x of list) {
        const p = toProduct(x);
        if (!p || all.has(p.sku)) continue;
        all.set(p.sku, p);
        n++;
      }
      log(`  [99 Ranch] "${term}" -> ${n} 个`);
      await page.waitForTimeout(250);
    }

    if (all.size === 0) {
      throw new Error(`所有 ${terms.length} 个关键词都没拿到商品（${failed} 个请求失败），接口可能变了`);
    }
    log(`  [99 Ranch] 共 ${all.size} 个商品，storeId ${storeId}`);
    return [...all.values()];
  });
}

export const meta = {
  id: 'ranch99',
  label: '99 Ranch (内部 JSON API + 分店号)',
  needsCredentials: false,
  needsBrowser: true,
  verified: 'api-confirmed', // 门店查询和商品接口都已实测，返回 Edmonds 店真实价格
};
