// Fred Meyer —— 走 Kroger 官方 API。
//
// 为什么不爬 fredmeyer.com：实测 curl 直连 fredmeyer.com 连 TCP 都建不起来（被彻底挡），
// 但 api.kroger.com 是官方公开 API，返回**指定门店的真实价格 + 促销价**，比爬网页准且稳定。
// Fred Meyer 是 Kroger 旗下，chain 代码 = FRED。
//
// 准备工作（免费，5 分钟）：
//   1. 去 https://developer.kroger.com 注册，Add Product 建一个 app
//   2. 拿到 Client ID / Client Secret，填进项目根目录的 .env
//   3. 跑 `npm run ingest -- --find-stores` 查出你家附近的 locationId，填进 data/stores.json
//
// 配额：默认每天 10,000 次调用，我们一天用几十次，完全够。

const TOKEN_URL = 'https://api.kroger.com/v1/connect/oauth2/token';
const API = 'https://api.kroger.com/v1';

let cachedToken = null; // { token, expiresAt }

async function getToken() {
  const id = process.env.KROGER_CLIENT_ID;
  const secret = process.env.KROGER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'KROGER_CLIENT_ID / KROGER_CLIENT_SECRET 没设置。' +
      '去 https://developer.kroger.com 免费注册一个 app，把凭证写进 .env（参考 .env.example）。'
    );
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kroger 取 token 失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  cachedToken = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 1800) * 1000 };
  return cachedToken.token;
}

async function api(path, params = {}) {
  const token = await getToken();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 429) throw new Error('Kroger API 限流(429)，等一会儿再跑');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kroger ${path} 返回 ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 查你家附近的 Fred Meyer 门店，把 locationId 填回 data/stores.json */
export async function findStores({ zip = '98155', chain = 'FRED', radiusMiles = 15, limit = 10 } = {}) {
  const j = await api('/locations', {
    'filter.zipCode.near': zip,
    'filter.chain': chain,
    'filter.radiusInMiles': radiusMiles,
    'filter.limit': limit,
  });
  return (j.data ?? []).map((l) => ({
    locationId: l.locationId,
    name: l.name,
    chain: l.chain,
    address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode]
      .filter(Boolean)
      .join(', '),
    phone: l.phone,
  }));
}

function toProduct(d) {
  const it = d.items?.[0];
  if (!it) return null;
  const regular = it.price?.regular ?? null;
  const promoRaw = it.price?.promo ?? null;
  // Kroger 在没有促销时把 promo 返回成 0，不是 null，直接用会算出免费
  const promo = promoRaw && promoRaw > 0 && regular && promoRaw < regular ? promoRaw : null;
  if (!regular || regular <= 0) return null;

  return {
    sku: d.productId,
    title: d.description,
    brand: d.brand ?? null,
    size: it.size ?? null,
    // soldBy=WEIGHT 表示散称，price 是每磅价
    priceUnit: it.soldBy === 'WEIGHT' ? 'lb' : null,
    priceRegular: regular,
    pricePromo: promo,
    promoText: promo ? 'Kroger Sale' : null,
    url: d.productId ? `https://www.fredmeyer.com/p/-/${d.productId}` : null,
    imageUrl: d.images?.find((i) => i.perspective === 'front')?.sizes?.find((s) => s.size === 'medium')?.url ?? null,
    inStock: it.inventory?.stockLevel ? it.inventory.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK' : true,
  };
}

/**
 * 抓取。按 catalog 里每样东西的关键词分别搜，而不是拉全站商品 ——
 * 我们只关心你家常买的 30 来样东西，精准搜索比全量爬取快得多也友好得多。
 *
 * @param {object} ctx
 * @param {object} ctx.storeConfig data/stores.json 里这家店的配置
 * @param {Array} ctx.items catalog.items
 */
export async function scrape({ storeConfig, items, log = console.log }) {
  const locationId = storeConfig?.krogerLocationId || process.env.KROGER_LOCATION_ID;
  if (!locationId) {
    throw new Error(
      'Fred Meyer 的 krogerLocationId 还没填。先跑 `npm run ingest -- --find-stores`，' +
      '把你家最近那家的 locationId 填进 data/stores.json。'
    );
  }

  const seen = new Set();
  const out = [];

  for (const item of items) {
    // 用最具体的那个关键词去搜，命中率最高
    const term = (item.match?.any ?? []).slice().sort((a, b) => b.length - a.length)[0] || item.nameEn;
    try {
      const j = await api('/products', {
        'filter.term': term,
        'filter.locationId': locationId,
        'filter.limit': 30,
      });
      let n = 0;
      for (const d of j.data ?? []) {
        const p = toProduct(d);
        if (!p || seen.has(p.sku)) continue;
        seen.add(p.sku);
        out.push(p);
        n++;
      }
      log(`  [Fred Meyer] "${term}" -> ${n} 个商品`);
    } catch (e) {
      log(`  [Fred Meyer] "${term}" 失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120)); // 温和一点，别打太快
  }

  return out;
}

export const meta = {
  id: 'kroger',
  label: 'Kroger 官方 API (Fred Meyer)',
  needsCredentials: true,
  verified: 'endpoint',   // 端点已实测可达(401=只缺凭证)，字段映射按官方文档写，拿到凭证后需跑一次确认
  docs: 'https://developer.kroger.com/reference/api/product-api-public',
};
