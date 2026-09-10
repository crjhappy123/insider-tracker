// T&T Supermarket (大统华) — Bellevue 店
//
// 实测：curl 直连 www.tntsupermarket.com 返回 403（机器人防护），必须用浏览器。
//
// T&T 有个特殊之处：它是加拿大连锁，Bellevue 是它在美国的第一家店，
// 站点默认可能落到加拿大门店（价格是加元！）。所以这里必须确认门店和币种，
// 币种不对就整批丢掉 —— 拿加元价格去和另外三家的美元价格比是错的，宁可没数据也不要错数据。

import { withPage } from './browser.js';
import { harvest } from './harvest.js';

const BASE = 'https://www.tntsupermarket.com';

export async function scrape({ storeConfig, items, log = console.log, dump = false }) {
  const terms = items.map((i) => (i.match?.any ?? []).slice().sort((a, b) => b.length - a.length)[0] || i.nameEn);

  return withPage(async (page) => {
    await page.goto(`${BASE}/en`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);

    const okStore = await selectBellevue(page, log);

    const urls = terms.map((t) => `${BASE}/en/search?q=${encodeURIComponent(t)}`);
    let products = await harvest(page, { storeId: 'tnt', urls, dump, log });

    if (products.length === 0) {
      log(`  [T&T] 搜索页没数据，试 flyer 页`);
      products = await harvest(page, {
        storeId: 'tnt',
        urls: [`${BASE}/en/flyer`, `${BASE}/en/weekly-specials`, `${BASE}/en/promotions`],
        dump,
        log,
      });
    }

    if (!okStore) {
      const currency = await detectCurrency(page);
      if (currency === 'CAD') {
        log(`  [T&T] 站点当前是加拿大门店，价格是加元 —— 全部丢弃，避免和美元价格混着比。`);
        log(`  [T&T] 请手动确认 T&T Bellevue 在站上的门店选择方式，或把这家店从 stores.json 里去掉。`);
        return [];
      }
      log(`  [T&T] 没能确认已切到 Bellevue 门店，价格可能不是这家店的，谨慎参考。`);
    }

    log(`  [T&T] 共 ${products.length} 个商品`);
    return products;
  });
}

async function selectBellevue(page, log) {
  try {
    // 关掉可能挡住的 cookie 提示
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', '[aria-label="close" i]']) {
      const b = page.locator(sel).first();
      if (await b.count()) await b.click({ timeout: 2500 }).catch(() => {});
    }

    const picker = page.locator(
      'button:has-text("Select Store"), button:has-text("Store"), [class*="store-select" i], [data-testid*="store" i]'
    ).first();
    if (await picker.count()) await picker.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const bellevue = page.locator('text=/bellevue/i').first();
    if (await bellevue.count()) {
      await bellevue.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      log('  [T&T] 已切到 Bellevue 门店');
      return true;
    }
  } catch { /* 落到下面的 false */ }
  return false;
}

async function detectCurrency(page) {
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => '');
  if (/\bCAD\b|C\$/.test(txt)) return 'CAD';
  if (/\bUSD\b/.test(txt)) return 'USD';
  // 页面上出现加拿大省份/城市，基本可以断定是加拿大门店
  if (/\b(Ontario|British Columbia|Alberta|Richmond|Markham|Scarborough|Burnaby)\b/.test(txt)) return 'CAD';
  return null;
}

export const meta = {
  id: 'tnt',
  label: 'T&T Supermarket (浏览器 + JSON 录制)',
  needsCredentials: false,
  needsBrowser: true,
  verified: 'blocked-by-curl', // 403 已实测；门店切换和字段首次跑时确认
};
