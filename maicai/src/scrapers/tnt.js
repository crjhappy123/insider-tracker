// T&T Supermarket (大统华) —— Bellevue 店。没有可自动抓取的价格源。
//
// 实测：tntsupermarket.com 每一个入口都被 Akamai 拒掉，403 "Access Denied" ——
// 首页 /en、搜索页 /en/search、促销单页 /en/flyer 和 /en/weekly-specials 全一样，
// 而且不是 curl 的问题：真实浏览器内核（有头 + 去掉自动化痕迹）跑出来还是 403。
// 再往下就得伪造 TLS 指纹或挂住宅代理去绕它的访问控制，这个不做。
//
// 还有一个额外的坑，手动录入时要留意：T&T 是加拿大连锁，Bellevue 是它在美国的
// 第一家店。它网站默认可能落到加拿大门店，那边标的是**加元**。
// 拿加元价格和另外几家的美元价格比是错的 —— 录入前确认一下是不是 USD。

import { makeFlyerStore } from './flyer-store.js';

export const scrape = makeFlyerStore({
  storeId: 'tnt',
  label: 'T&T',
  defaultDir: 'data/flyers/tnt',
  why: '官网所有入口都被 Akamai 拒（403，真实浏览器也一样）。注意它是加拿大连锁，录入前确认价格是美元不是加元。',
});

export const meta = {
  id: 'tnt',
  label: 'T&T (手动录入 / 促销单读图)',
  needsCredentials: 'anthropic',
  needsBrowser: false,
  verified: 'no-auto-source',
};
