// Boo Han Market (부한마켓) —— Edmonds 韩国超市
//
// 实测情况：
//   - boohan.com 是 Wix 站，curl 直连返回 200，没有机器人防护，不需要浏览器
//   - 周报页 /weeklyad-eng 里 0 个价格文字、没有 PDF，价格全在一张大图上
//   - 那张图在页面 HTML 里就能正则找到（static.wixstatic.com/media/...），实测拿到 2.28 MB 原图
//   - 图片文件名是内容哈希，每周换，所以每次都要重新解析页面找当前那张
//
// 所以流程是：解析周报页 -> 挑出最大的那张图（就是周报，其它是 logo / 装饰图）
//            -> 存到本地 -> 交给 flyer.js 用视觉模型读成结构化价格
//
// 周报底部印着 "Sale prices apply to in-store purchases only"，正是店内价，符合我们的需求。

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../db.js';
import { extractFlyer, flyerToProducts, loadManual, flyerFiles } from './flyer.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 怎么从页面上一堆图里认出周报：
// 光按绝对体积筛不行 —— 实测页面上有张 0.35MB 的装饰性库存照片（推购物车的手），
// 比 logo 大得多，会被误当成周报送进模型，白花钱还可能干扰提取。
// 周报各页的体积是同一个量级（都是密密麻麻的商品图），装饰图小一个量级，
// 所以用「相对最大那张的比例」来筛，比绝对阈值稳。
const MIN_AD_BYTES = 600_000;      // 绝对下限：周报整页扫描件不可能比这还小
const AD_RATIO_OF_LARGEST = 0.6;   // 只留体积达到最大图 60% 以上的，装饰图会被这条挡掉

/** 从周报页里找出候选图片 URL（去掉 Wix 的裁剪/缩放参数，取原图） */
function extractImageUrls(html) {
  const urls = new Set();
  const re = /https:\/\/static\.wixstatic\.com\/media\/[A-Za-z0-9_~%.-]+\.(?:jpg|jpeg|png)/gi;
  for (const m of html.matchAll(re)) {
    // Wix 的 /v1/fill/... 后缀是缩略图变换，去掉才是原始分辨率
    urls.add(m[0]);
  }
  return [...urls];
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`打开 ${url} 返回 ${res.status}`);
  return res.text();
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 抓当前那张周报图，存到 data/flyers/boohan/ 下。
 * @returns {Promise<string[]>} 本地文件路径
 */
export async function fetchWeeklyAd({ storeConfig, log = console.log }) {
  const page = storeConfig?.flyerPage || 'https://www.boohan.com/weeklyad-eng';
  const dir = join(ROOT, storeConfig?.flyerDir || 'data/flyers/boohan');
  mkdirSync(dir, { recursive: true });

  const html = await fetchText(page);
  const candidates = extractImageUrls(html);
  log(`  [Boo Han] 周报页里 ${candidates.length} 张候选图`);
  if (candidates.length === 0) return [];

  // 全下下来，按体积挑 —— 周报是整页大图，明显比 logo 大一个量级
  const downloaded = [];
  for (const url of candidates.slice(0, 12)) {
    const buf = await download(url).catch(() => null);
    if (buf) downloaded.push({ url, buf });
  }
  downloaded.sort((a, b) => b.buf.length - a.buf.length);

  const largest = downloaded[0]?.buf.length ?? 0;
  const ads = downloaded.filter(
    (d) => d.buf.length >= MIN_AD_BYTES && d.buf.length >= largest * AD_RATIO_OF_LARGEST
  );
  if (ads.length === 0) {
    log(`  [Boo Han] 没找到像周报的大图（最大的一张只有 ${(largest / 1e6).toFixed(2)}MB，` +
        `低于 ${(MIN_AD_BYTES / 1e6).toFixed(1)}MB 下限）。可能这周还没更新，或者页面改版了。`);
    return [];
  }
  const skipped = downloaded.length - ads.length;
  if (skipped > 0) log(`  [Boo Han] 跳过 ${skipped} 张装饰图/logo，只留 ${ads.length} 张周报`);

  // 周报通常 1-2 页（正反面）
  const files = [];
  for (const [i, ad] of ads.slice(0, 2).entries()) {
    const ext = ad.url.match(/\.(jpg|jpeg|png)$/i)?.[1]?.toLowerCase() ?? 'jpg';
    const p = join(dir, `weeklyad-${i + 1}.${ext}`);
    // 内容没变就别重写，免得白白刷新 mtime、也保住提取缓存
    if (!existsSync(p) || !readFileSync(p).equals(ad.buf)) {
      writeFileSync(p, ad.buf);
      log(`  [Boo Han] 存下 ${(ad.buf.length / 1e6).toFixed(2)}MB -> ${p.replace(ROOT + '/', '')}`);
    } else {
      log(`  [Boo Han] 周报没变，沿用本地已有的 ${p.replace(ROOT + '/', '')}`);
    }
    files.push(p);
  }
  return files;
}

export async function scrape({ storeConfig, log = console.log, refresh = false }) {
  const flyerDir = storeConfig?.flyerDir || 'data/flyers/boohan';

  let files = [];
  try {
    files = await fetchWeeklyAd({ storeConfig, log });
  } catch (e) {
    log(`  [Boo Han] 抓周报失败: ${e.message}`);
    // 网络失败就用本地已经存过的那张，总比什么都没有好
    files = flyerFiles(flyerDir);
    if (files.length) log(`  [Boo Han] 改用本地已存的 ${files.length} 张`);
  }

  const manual = loadManual('boohan', log);

  if (files.length === 0) {
    if (manual.length) return manual;
    throw new Error(
      '没拿到周报图。可以自己去 https://www.boohan.com/weeklyad-eng 存一张图片放进 ' +
      `${flyerDir}/，再跑一次；或者把常买的几样手记进 data/manual/boohan.json。`
    );
  }

  // 读图失败（没凭证、模型出错、限流…）时，只要有手动录入的数据就用它顶上 ——
  // 有一部分价格远好过整家店没数据
  let fromFlyer = [];
  try {
    const extracted = await extractFlyer({ storeId: 'boohan', flyerDir, files, refresh, log });
    fromFlyer = flyerToProducts(extracted, 'boohan');
  } catch (e) {
    if (manual.length === 0) throw e;
    log(`  [Boo Han] 读图失败（${e.message.split('\n')[0]}），改用手动录入的 ${manual.length} 条`);
  }
  // 同一个 sku 时手动录入优先
  const manualSkus = new Set(manual.map((m) => m.sku));
  return [...fromFlyer.filter((p) => !manualSkus.has(p.sku)), ...manual];
}

export const meta = {
  id: 'boohan',
  label: 'Boo Han (周报图 + 视觉模型读图)',
  needsCredentials: 'anthropic',
  needsBrowser: false,
  verified: 'flyer-confirmed', // 周报图 URL 和内容已实测下载确认；提取质量首次跑时核对
};
