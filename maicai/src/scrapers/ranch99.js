// 99 Ranch Market (大华)
//
// 实测：curl 直连 www.99ranch.com 返回 200，是 Next.js 站，没有强机器人防护。
// 但价格是分店的、要走 XHR，而且它的线上商城和门店周报(weekly ad)是两套数据，
// 所以还是用浏览器 + 通用 JSON 录制的办法（见 harvest.js），比猜 CSS class 耐用。
//
// 99 Ranch 是这四家里中式食材最便宜的，而且促销力度大，是「今日促销」的主力来源。

import { withPage } from './browser.js';
import { harvest } from './harvest.js';

const BASE = 'https://www.99ranch.com';

function searchUrls(terms) {
  // 同一个搜索意图给几种可能的路由，哪个通用哪个 —— 站点改版时不至于全废
  const paths = ['/search?keyword=', '/search?q=', '/shop/search?keyword='];
  const urls = [];
  for (const t of terms) {
    urls.push(`${BASE}${paths[0]}${encodeURIComponent(t)}`);
  }
  return { urls, fallbackPaths: paths.slice(1) };
}

export async function scrape({ storeConfig, items, log = console.log, dump = false }) {
  const terms = items.map((i) => (i.match?.any ?? []).slice().sort((a, b) => b.length - a.length)[0] || i.nameEn);
  const { urls, fallbackPaths } = searchUrls(terms);

  return withPage(async (page) => {
    // 先进首页，让它把门店 cookie / session 建起来（价格是分店的）
    await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);

    // 如果有选店的弹窗，尽量选到 Edmonds 那家
    const branch = storeConfig?.branch || 'Edmonds';
    await selectStore(page, branch, log);

    let products = await harvest(page, { storeId: 'ranch99', urls, dump, log });

    // 主路由没数据，换备用路由再试几个词
    if (products.length === 0) {
      for (const path of fallbackPaths) {
        const alt = terms.slice(0, 8).map((t) => `${BASE}${path}${encodeURIComponent(t)}`);
        log(`  [99 Ranch] 换路由重试 ${path}`);
        products = await harvest(page, { storeId: 'ranch99', urls: alt, dump, log });
        if (products.length) break;
      }
    }

    // 再试周报页 —— 门店促销主要挂在这里
    if (products.length === 0) {
      log(`  [99 Ranch] 搜索页没数据，试试 weekly ad`);
      products = await harvest(page, {
        storeId: 'ranch99',
        urls: [`${BASE}/weekly-ad`, `${BASE}/weeklyAd`, `${BASE}/promotion`],
        dump,
        log,
      });
    }

    log(`  [99 Ranch] 共 ${products.length} 个商品`);
    return products;
  });
}

async function selectStore(page, branch, log) {
  try {
    const kw = branch.split(/[\s(]/)[0];
    // 常见形态：弹窗里搜门店名再点选中
    const input = page.locator('input[placeholder*="store" i], input[placeholder*="zip" i], input[placeholder*="city" i]').first();
    if (await input.count()) {
      await input.fill(kw, { timeout: 4000 });
      await page.waitForTimeout(1500);
      const opt = page.locator(`text=${kw}`).first();
      if (await opt.count()) {
        await opt.click({ timeout: 4000 });
        await page.waitForTimeout(1500);
        log(`  [99 Ranch] 已选门店: ${kw}`);
      }
    }
  } catch {
    // 选不到就用默认门店，价格可能是别的店的 —— 会在抓取日志里体现出来
    log(`  [99 Ranch] 没能自动选门店，用站点默认门店的价格`);
  }
}

export const meta = {
  id: 'ranch99',
  label: '99 Ranch Market (浏览器 + JSON 录制)',
  needsCredentials: false,
  needsBrowser: true,
  verified: 'reachable', // 站点 200 已实测；具体搜索路由和字段首次跑时确认
};
