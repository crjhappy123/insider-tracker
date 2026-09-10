// Trader Joe's —— 没有可自动抓取的价格源。
//
// 实测过两条路，都不通：
//   1. 官网 GraphQL (/api/graphql)：curl 403。用真实浏览器打开首页拿 cookie 后再从
//      页面上下文里发同一个请求，还是 403 —— 防护不是看 cookie。
//   2. 搜索页 DOM：/home 和 /home/search 本身就返回 403 "Access Denied"（Akamai）。
// 再往下就得伪造指纹或挂代理绕它的访问控制，这个不做。
//
// 好消息是这家最适合手动录入：
//   - Trader Joe's 全国统一定价，而且常年不变，录一次能用很久
//   - 它基本不搞促销，所以「今日促销」这块本来就没它什么事
//   - 它在这个项目里的价值是当比价基准线 —— 有些东西 TJ 常年就是最便宜的，
//     不用等打折，这个靠手动录入完全能体现
//
// 想更新的时候看一眼 Fearless Flyer 或者货架标价，改 data/manual/trader_joes.json 就行。

import { makeFlyerStore } from './flyer-store.js';

export const scrape = makeFlyerStore({
  storeId: 'trader_joes',
  label: "Trader Joe's",
  defaultDir: 'data/flyers/trader_joes',
  why: 'GraphQL 和搜索页都被 Akamai 拒（403，浏览器上下文里发也一样）。不过 TJ 全国统一价且常年不变，手动录一次能用很久。',
});

export const meta = {
  id: 'trader_joes',
  label: "Trader Joe's (手动录入 / 促销单读图)",
  needsCredentials: 'anthropic',
  needsBrowser: false,
  verified: 'no-auto-source',
};
