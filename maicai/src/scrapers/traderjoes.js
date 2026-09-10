// Trader Joe's
//
// 实测：curl 直连 https://www.traderjoes.com/api/graphql 返回 403（机器人防护）。
// 办法是先用真实浏览器打开首页拿到 cookie，再在页面上下文里发同一个 GraphQL 请求 —— 这样能过。
//
// TJ 的站是 Magento 改的，商品接口是 products(search, filter, pageSize, currentPage)。
// 自定义字段 item_title / retail_price / sales_size / sales_uom_description 是 TJ 特有的；
// 如果他们改了 schema，GraphQL 会整条查询报错，所以这里准备了两套查询：
// 先试 TJ 自定义字段，失败就退回 Magento 标准字段，两套都失败再退回搜索页 DOM 抓取。
//
// 另外 TJ 有个特点：常年不打折，价格全国基本统一。所以它的价值不在「促销推送」，
// 而在比价的基准线 —— 有些东西 TJ 常年就是最便宜的，不用等促销。

import { withPage, fetchInPage } from './browser.js';
import { harvest } from './harvest.js';

const GQL = 'https://www.traderjoes.com/api/graphql';

const Q_TJ = `
query SearchProduct($search: String, $storeCode: String, $pageSize: Int, $currentPage: Int) {
  products(
    search: $search
    filter: { store_code: { eq: $storeCode } }
    pageSize: $pageSize
    currentPage: $currentPage
  ) {
    total_count
    items {
      sku
      item_title
      retail_price
      sales_size
      sales_uom_description
      url_key
      availability
    }
  }
}`;

const Q_MAGENTO = `
query SearchProduct($search: String, $pageSize: Int, $currentPage: Int) {
  products(search: $search, pageSize: $pageSize, currentPage: $currentPage) {
    total_count
    items {
      sku
      name
      url_key
      price_range { minimum_price { regular_price { value } final_price { value } } }
    }
  }
}`;

function fromTj(items) {
  const out = [];
  for (const it of items ?? []) {
    const price = Number(it.retail_price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const uom = String(it.sales_uom_description ?? '').toLowerCase();
    out.push({
      sku: String(it.sku),
      title: it.item_title,
      brand: "Trader Joe's",
      // sales_size 是数字，单位在 sales_uom_description 里，拼起来才能被规格解析器认出来
      size: it.sales_size != null ? `${it.sales_size} ${it.sales_uom_description ?? ''}`.trim() : null,
      priceUnit: /\b(lb|pound)\b/.test(uom) && it.sales_size == null ? 'lb' : null,
      priceRegular: price,
      pricePromo: null,
      promoText: null,
      url: it.url_key ? `https://www.traderjoes.com/home/products/pdp/${it.url_key}` : null,
      imageUrl: null,
      inStock: it.availability !== '0' && it.availability !== 0,
    });
  }
  return out;
}

function fromMagento(items) {
  const out = [];
  for (const it of items ?? []) {
    const reg = it.price_range?.minimum_price?.regular_price?.value;
    const fin = it.price_range?.minimum_price?.final_price?.value;
    const regular = Number(reg ?? fin);
    if (!Number.isFinite(regular) || regular <= 0) continue;
    const promo = Number.isFinite(Number(fin)) && Number(fin) < regular ? Number(fin) : null;
    out.push({
      sku: String(it.sku),
      title: it.name,
      brand: "Trader Joe's",
      size: null, // 标题里通常带规格，交给 units.js 从 title 解析
      priceUnit: null,
      priceRegular: regular,
      pricePromo: promo,
      promoText: promo ? 'Sale' : null,
      url: it.url_key ? `https://www.traderjoes.com/home/products/pdp/${it.url_key}` : null,
      imageUrl: null,
      inStock: true,
    });
  }
  return out;
}

export async function scrape({ storeConfig, items, log = console.log, dump = false }) {
  const storeCode = storeConfig?.storeCode || '701';
  const terms = items.map((i) => (i.match?.any ?? []).slice().sort((a, b) => b.length - a.length)[0] || i.nameEn);

  return withPage(async (page) => {
    // 先真实打开首页，拿到过防护的 cookie
    await page.goto('https://www.traderjoes.com/home', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    let mode = 'tj';
    const all = new Map();

    for (const term of terms) {
      const body = (query, vars) => JSON.stringify({ operationName: 'SearchProduct', query, variables: vars });

      let res = await fetchInPage(page, GQL, {
        method: 'POST',
        body: body(mode === 'tj' ? Q_TJ : Q_MAGENTO,
          mode === 'tj'
            ? { search: term, storeCode, pageSize: 20, currentPage: 1 }
            : { search: term, pageSize: 20, currentPage: 1 }),
      });

      // 自定义字段挂了就整体切到标准查询，不要每个词都试一遍
      if (mode === 'tj' && (!res.ok || res.json?.errors)) {
        log(`  [Trader Joe's] 自定义字段查询失败，切到 Magento 标准字段`);
        mode = 'magento';
        res = await fetchInPage(page, GQL, {
          method: 'POST',
          body: body(Q_MAGENTO, { search: term, pageSize: 20, currentPage: 1 }),
        });
      }

      if (!res.ok || res.json?.errors) {
        log(`  [Trader Joe's] "${term}" 失败 (${res.status}) ${JSON.stringify(res.json?.errors ?? '').slice(0, 160)}`);
        continue;
      }

      const list = res.json?.data?.products?.items ?? [];
      const parsed = mode === 'tj' ? fromTj(list) : fromMagento(list);
      for (const p of parsed) if (!all.has(p.sku)) all.set(p.sku, p);
      log(`  [Trader Joe's] "${term}" -> ${parsed.length} 个商品`);
      await page.waitForTimeout(400);
    }

    // GraphQL 完全不通，退回搜索页 DOM
    if (all.size === 0) {
      log(`  [Trader Joe's] GraphQL 没拿到数据，退回搜索页抓取`);
      const urls = terms.slice(0, 12).map((t) => `https://www.traderjoes.com/home/search?q=${encodeURIComponent(t)}&global=yes`);
      for (const p of await harvest(page, { storeId: 'trader_joes', urls, dump, log })) {
        if (!all.has(p.sku)) all.set(p.sku, { ...p, brand: p.brand ?? "Trader Joe's" });
      }
    }

    return [...all.values()];
  });
}

export const meta = {
  id: 'trader_joes',
  label: "Trader Joe's (浏览器 + GraphQL)",
  needsCredentials: false,
  needsBrowser: true,
  verified: 'blocked-by-curl', // 403 已实测；GraphQL 字段名按公开 schema 写，首次跑需要确认
};
