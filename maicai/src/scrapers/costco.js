// Costco —— 只能走促销单 / 手动录入，没有自动抓取。
//
// 这家我试过了，结论是明确的，写在这里免得以后再折腾一遍：
//
// 1. costco.com 拒绝一切自动访问。curl 拿首页 200，但搜索页和 warehouse-savings 都是 403；
//    无头 Chromium 连 TLS 握手都过不去（ERR_HTTP2_PROTOCOL_ERROR）；
//    本机真实 Chrome + 有头模式也是 Akamai 的 "Access Denied"。
//    再往下就得伪造指纹 / 挂住宅代理去绕它的访问控制了，这个我没做。
//
// 2. 更根本的问题：**Costco 的仓库店内价从来不在网上公开。**
//    costco.com 上的线上价含配送成本，比店内价高，而且商品编号都不一样。
//    就算能爬下来，拿它和 Fred Meyer 的店内价放一起比也是错的 —— 会让你以为
//    Costco 更贵而错过真正便宜的东西。宁可没有这个数据，不要错的数据。
//
// 所以 Costco 的价格从这两个地方来：
//   a) 月度 Coupon Book / 仓库优惠单：从 costco.com 或 app 里存成截图或 PDF，
//      丢进 data/flyers/costco/，跑 `npm run ingest -- --stores=costco` 让视觉模型读
//   b) 手动录入：data/manual/costco.json，记你家常买的那十几样。买完看小票录一次，
//      Costco 的价格很稳，一个月更一次就够
//
// 另外 Costco 有个比价上的坑，比价页会专门标出来：包装量大。
// 你想买 1 磅草莓，Costco 只卖 4 磅装 —— 每磅再便宜，多出来的三磅吃不完就是浪费。

import { extractFlyer, flyerToProducts, loadManual, flyerFiles } from './flyer.js';

export async function scrape({ storeConfig, log = console.log, refresh = false }) {
  const flyerDir = storeConfig?.flyerDir || 'data/flyers/costco';
  const files = flyerFiles(flyerDir);
  const manual = loadManual('costco', log);

  if (files.length === 0 && manual.length === 0) {
    throw new Error(
      'Costco 没有可自动抓取的价格源（官网封锁自动访问，且店内价不在网上公开）。两个办法：\n' +
      `  1. 把月度优惠单的截图或 PDF 放进 ${flyerDir}/，再跑一次 —— 会用视觉模型读出来\n` +
      '  2. 把常买的几样手记进 data/manual/costco.json（格式见 README）\n' +
      '在此之前 Costco 不参与比价，其它店照常。'
    );
  }

  if (files.length === 0) {
    log(`  [Costco] ${flyerDir}/ 里没有促销单，只用手动录入的数据`);
    return manual;
  }

  log(`  [Costco] ${flyerDir}/ 里有 ${files.length} 份促销单`);

  // 读图失败时只要有手动录入就用它顶上，别让整家店没数据
  let fromFlyer = [];
  try {
    const extracted = await extractFlyer({ storeId: 'costco', flyerDir, files, refresh, log });
    fromFlyer = flyerToProducts(extracted, 'costco');
  } catch (e) {
    if (manual.length === 0) throw e;
    log(`  [Costco] 读图失败（${e.message.split('\n')[0]}），改用手动录入的 ${manual.length} 条`);
  }

  // 手动录入优先级更高：同一个 sku 时手动的覆盖促销单读出来的
  const manualSkus = new Set(manual.map((m) => m.sku));
  return [...fromFlyer.filter((p) => !manualSkus.has(p.sku)), ...manual];
}

export const meta = {
  id: 'costco',
  label: 'Costco (促销单读图 + 手动录入)',
  needsCredentials: 'anthropic',
  needsBrowser: false,
  verified: 'no-auto-source', // 已实测确认无法自动抓取，不是没试
};
