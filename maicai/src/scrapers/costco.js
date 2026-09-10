// Costco —— 没有可自动抓取的价格源。
//
// 试过了，结论是明确的，写在这里免得以后再折腾一遍：
//
// 1. costco.com 拒绝一切自动访问。curl 拿首页 200，但搜索页和 warehouse-savings 都 403；
//    无头 Chromium 连 TLS 握手都过不去（ERR_HTTP2_PROTOCOL_ERROR）；
//    本机真实 Chrome + 有头模式也是 Akamai 的 "Access Denied"。
//
// 2. 更根本的问题：**Costco 的仓库店内价从来不在网上公开。**
//    costco.com 上的线上价含配送成本，比店内价高，商品编号也不一样。
//    就算能爬下来，拿它和 Fred Meyer 的店内价放一起比也是错的 —— 会让你以为
//    Costco 更贵而错过真正便宜的东西。宁可没有这个数据，不要错的数据。
//
// 另外 Costco 有个比价上的坑，比价页和购物清单会专门标出来：包装量大。
// 你想买 1 磅草莓，Costco 只卖 4 磅装 —— 每磅再便宜，多出来的三磅吃不完就是浪费。

import { makeFlyerStore } from './flyer-store.js';

export const scrape = makeFlyerStore({
  storeId: 'costco',
  label: 'Costco',
  defaultDir: 'data/flyers/costco',
  why: '官网封锁自动访问（Akamai，真实 Chrome 有头模式也被拒），且仓库店内价不在网上公开。',
});

export const meta = {
  id: 'costco',
  label: 'Costco (手动录入 / 优惠册读图)',
  needsCredentials: 'anthropic',
  needsBrowser: false,
  verified: 'no-auto-source',
};
