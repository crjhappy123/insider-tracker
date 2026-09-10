// 「没有可自动抓取的价格源」那类门店的共用实现。
//
// Costco、T&T、Trader Joe's 三家都撞在同一堵墙上：Akamai 边缘节点直接返回
// Access Denied，真实 Chrome 有头模式也一样，每个入口（首页、搜索、促销单页）全 403。
// 再往下就得伪造 TLS 指纹、挂住宅代理去绕它们的访问控制 —— 这个不做。
//
// 所以这三家的价格从两个地方来，优先级从高到低：
//   1. data/manual/<门店>.json      手动录入，最可靠，也不需要任何凭证
//   2. data/flyers/<门店>/          促销单截图或 PDF，用视觉模型读出来
//
// 手动录入优先于读图：手记的东西是你确认过的，读图有识别错的可能。
//
// 这不算凑合。这几家的价格变化频率很低（Trader Joe's 全国统一价、常年不变；
// Costco 一个月更一次优惠册），买完照着小票录一次十几样，花几分钟，比每天跑一次
// 不可靠的爬虫更靠得住。

import { extractFlyer, flyerToProducts, loadManual, flyerFiles } from './flyer.js';

/**
 * @param {object} cfg
 * @param {string} cfg.storeId
 * @param {string} cfg.label       日志里显示的名字
 * @param {string} cfg.defaultDir  默认促销单目录
 * @param {string} cfg.why         为什么没法自动抓 —— 出错时要讲清楚，免得以后再折腾一遍
 */
export function makeFlyerStore({ storeId, label, defaultDir, why }) {
  return async function scrape({ storeConfig, log = console.log, refresh = false }) {
    const flyerDir = storeConfig?.flyerDir || defaultDir;
    const files = flyerFiles(flyerDir);
    const manual = loadManual(storeId, log);

    if (files.length === 0 && manual.length === 0) {
      throw new Error(
        `${label} 没有可自动抓取的价格源。${why}\n` +
        `两个办法：\n` +
        `  1. 把常买的几样手记进 data/manual/${storeId}.json（照 ${storeId}.example.json 改，不需要任何凭证）\n` +
        `  2. 把促销单的截图或 PDF 放进 ${flyerDir}/，跑抓取时会用视觉模型读出来\n` +
        `在此之前这家店不参与比价，其它店照常。`
      );
    }

    if (files.length === 0) {
      log(`  [${label}] ${flyerDir}/ 里没有促销单，只用手动录入的 ${manual.length} 条`);
      return manual;
    }

    log(`  [${label}] ${flyerDir}/ 里有 ${files.length} 份促销单`);

    // 读图失败（没凭证、模型出错、限流…）时，只要有手动录入就用它顶上 ——
    // 有一部分价格远好过整家店没数据
    let fromFlyer = [];
    try {
      const extracted = await extractFlyer({ storeId, flyerDir, files, refresh, log });
      fromFlyer = flyerToProducts(extracted, storeId);
    } catch (e) {
      if (manual.length === 0) throw e;
      log(`  [${label}] 读图失败（${e.message.split('\n')[0]}），改用手动录入的 ${manual.length} 条`);
    }

    // 同一个 sku 时手动录入优先：手记的是你确认过的，读图可能认错
    const manualSkus = new Set(manual.map((m) => m.sku));
    return [...fromFlyer.filter((p) => !manualSkus.has(p.sku)), ...manual];
  };
}
