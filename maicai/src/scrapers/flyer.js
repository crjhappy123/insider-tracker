// 促销单读取管线（Costco 和 Boo Han 共用，其它店抓取失败时也能兜底）。
//
// 为什么需要它：不是所有超市都有能抓的价格接口。
//   - Boo Han 的周报是一整张设计好的大图，价格是美术字（$3⁷⁹ 这种分体数字），
//     普通 OCR 在这种排版上错得厉害，而错的价格比没有价格更糟 —— 会直接给出错的建议。
//   - Costco 官网拒绝一切自动访问，而且仓库店内价根本不在网上公开。
// 所以这两家都走「图 -> 视觉模型读成结构化数据」这条路，一周一张图，一次 API 调用。
//
// 没有 API key 也能用：把价格手记在 data/manual/<门店>.json 里，格式见 README。
//
// 提取结果会按图片内容哈希缓存在 <flyerDir>/.cache/ 下，同一张周报只花一次钱。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { ROOT } from '../db.js';

const MODEL = 'claude-opus-5';
const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/* ---------- 提取结果的结构 ---------- */
const SCHEMA = {
  type: 'object',
  properties: {
    adPeriod: { type: 'string', description: '促销单上印的有效期原文，例如 "9/4 (Friday) - 9/10 (Thursday)"，没印就空字符串' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '商品名，照促销单上印的英文原文写' },
          brand: { type: 'string', description: '品牌，没印就空字符串' },
          salePrice: { type: 'number', description: '促销价（大号数字），单位美元' },
          regularPrice: { type: 'number', description: '原价（通常印成 "Reg 5.99"）。没印原价就填 0' },
          priceBasis: {
            type: 'string',
            enum: ['per_lb', 'per_package'],
            description: '价格是按磅算(标 LB / per lb)还是按整份包装算(标 EA / BOX / PK / BUN / BAG)',
          },
          packSize: {
            type: 'string',
            description: '包装规格，规范成「数字+单位」，例如 "450 g" / "3 lb" / "1.5 kg" / "16 pk" / "1 bunch" / "500 ml"。促销单上常写成 EA(450G) 或 BAG(15LB) 这种，把里面的规格提出来。按磅卖的散货填空字符串。',
          },
          limit: { type: 'string', description: '限购说明，例如 "LIMIT"，没有就空字符串' },
        },
        required: ['name', 'brand', 'salePrice', 'regularPrice', 'priceBasis', 'packSize', 'limit'],
        additionalProperties: false,
      },
    },
  },
  required: ['adPeriod', 'products'],
  additionalProperties: false,
};

const PROMPT = `这是一张美国超市的每周促销单。把上面所有商品的价格提取成结构化数据。

要点：
1. 促销单上的大号价格常把美元和美分排成不同大小（例如 3 上面跟个小的 79，意思是 $3.79）。仔细看，别把 $3.79 读成 $379 或 $3.7。
2. "Reg 5.99" 这类小字是原价，填进 regularPrice。只有促销价没有原价时 regularPrice 填 0。
3. 单位很重要：标 LB 的是每磅价（priceBasis = per_lb）；标 EA(450G)、BAG(15LB)、BOX、PK、BUN 的是整份价（priceBasis = per_package），并把括号里的规格填进 packSize。
4. 只提取实际有价格的商品。装饰性图片、招聘广告、门店电话、免责声明都跳过。
5. 商品名照印的英文原文写，不要翻译、不要自己加词。
6. 看不清的价格宁可跳过这个商品，也不要猜 —— 错的价格会导致错的购买建议。`;

/* ---------- Anthropic 客户端 ---------- */
async function client() {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error(
      '要读促销单图片需要 Anthropic SDK，还没装。跑：npm install @anthropic-ai/sdk\n' +
      '不想用 API 的话，把价格手记进 data/manual/<门店id>.json（格式见 README）。'
    );
  }
  // 零参构造：会自动依次找 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` 的本地配置
  return new Anthropic();
}

const AUTH_HELP = (storeId) =>
  '没有可用的 Anthropic 凭证，读不了促销单图片。三个办法任选一个：\n' +
  '  1. 去 https://console.anthropic.com 拿一个 key，写进 .env 的 ANTHROPIC_API_KEY\n' +
  '  2. 装了 ant CLI 的话跑 `ant auth login`，SDK 会自动认\n' +
  `  3. 完全不用 API：把常买的几样手记进 data/manual/${storeId}.json（照 data/manual/${storeId}.example.json 改）\n` +
  '第 3 条其实挺实用 —— 这些店价格一周才变一次，手记十几样花不了几分钟。';

function isAuthError(e) {
  if (e?.status === 401 || e?.status === 403) return true;
  return /resolve authentication method|apiKey|authToken|api key/i.test(e?.message ?? '');
}

/* ---------- 图片 / PDF 读取 ---------- */
function fileToBlock(path) {
  const ext = extname(path).toLowerCase();
  const data = readFileSync(path).toString('base64');
  if (ext === '.pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  const media = IMAGE_EXT[ext];
  if (!media) return null;
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

/** 目录里所有能读的促销单文件，按修改时间新的在前 */
export function flyerFiles(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => !f.startsWith('.') && (extname(f).toLowerCase() === '.pdf' || IMAGE_EXT[extname(f).toLowerCase()]))
    .map((f) => join(abs, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/* ---------- 缓存 ---------- */
function cacheKey(buffers) {
  const h = createHash('sha256');
  for (const b of buffers) h.update(b);
  return h.digest('hex').slice(0, 20);
}

function readCache(dir, key) {
  const p = join(ROOT, dir, '.cache', `${key}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function writeCache(dir, key, data) {
  const d = join(ROOT, dir, '.cache');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${key}.json`), JSON.stringify(data, null, 2));
}

/* ---------- 主入口 ---------- */
/**
 * 从促销单文件里读出商品价格。
 *
 * @param {object} o
 * @param {string} o.storeId
 * @param {string} o.flyerDir      缓存和本地文件所在目录（相对项目根）
 * @param {string[]} o.files       要读的文件绝对路径
 * @param {boolean} [o.refresh]    true = 忽略缓存重新读
 * @param {(m:string)=>void} [o.log]
 */
export async function extractFlyer({ storeId, flyerDir, files, refresh = false, log = console.log }) {
  if (files.length === 0) return { products: [], adPeriod: null, fromCache: false };

  const blocks = [];
  const buffers = [];
  for (const f of files) {
    const blk = fileToBlock(f);
    if (!blk) { log(`  [${storeId}] 跳过不认识的文件 ${basename(f)}`); continue; }
    blocks.push(blk);
    buffers.push(readFileSync(f));
  }
  if (blocks.length === 0) return { products: [], adPeriod: null, fromCache: false };

  const key = cacheKey(buffers);
  if (!refresh) {
    const hit = readCache(flyerDir, key);
    if (hit) {
      log(`  [${storeId}] 用缓存的提取结果（同一张促销单不重复花钱），${hit.products.length} 个商品`);
      return { ...hit, fromCache: true };
    }
  }

  log(`  [${storeId}] 用 ${MODEL} 读 ${blocks.length} 张促销单…`);
  let anthropic;
  try {
    anthropic = await client();
  } catch (e) {
    throw isAuthError(e) ? new Error(AUTH_HELP(storeId)) : e;
  }

  let res;
  try {
    res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high', // 读美术字价格容易出错，值得多花点算力
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: PROMPT }] }],
    });
  } catch (e) {
    if (isAuthError(e)) throw new Error(AUTH_HELP(storeId));
    throw e;
  }

  if (res.stop_reason === 'refusal') {
    throw new Error(`模型拒绝了这次提取（${res.stop_details?.category ?? '未知原因'}）`);
  }

  const parsed = pickJson(res);
  if (!parsed) throw new Error('模型没有返回可解析的 JSON');

  const out = { products: parsed.products ?? [], adPeriod: parsed.adPeriod || null, extractedAt: new Date().toISOString() };
  writeCache(flyerDir, key, out);
  log(`  [${storeId}] 读到 ${out.products.length} 个商品${out.adPeriod ? `，有效期 ${out.adPeriod}` : ''}`);
  return { ...out, fromCache: false };
}

function pickJson(res) {
  // 用了 output_config.format 时正常会走 parsed_output；兜底再从 text 块里解析一次
  if (res.parsed_output) return res.parsed_output;
  for (const b of res.content ?? []) {
    if (b.type === 'text') {
      try { return JSON.parse(b.text); } catch { /* 继续找 */ }
    }
  }
  return null;
}

/* ---------- 转成本项目的商品结构 ---------- */
export function flyerToProducts(extracted, storeId) {
  const out = [];
  const seen = new Set();
  for (const p of extracted.products ?? []) {
    const sale = Number(p.salePrice);
    if (!Number.isFinite(sale) || sale <= 0) continue;

    const reg = Number(p.regularPrice);
    const hasReg = Number.isFinite(reg) && reg > sale;

    const title = [p.brand, p.name].filter((s) => s && s.trim()).join(' ').trim();
    if (!title) continue;

    const size = (p.packSize || '').trim() || null;
    const sku = `FLYER-${storeId}-${createHash('sha1').update(`${title}|${size ?? ''}`).digest('hex').slice(0, 12)}`;
    if (seen.has(sku)) continue;
    seen.add(sku);

    out.push({
      sku,
      title,
      brand: p.brand?.trim() || null,
      size,
      priceUnit: p.priceBasis === 'per_lb' ? 'lb' : null,
      priceRegular: hasReg ? reg : sale,
      pricePromo: hasReg ? sale : null,
      promoText: ['Weekly Ad', p.limit?.trim(), extracted.adPeriod].filter(Boolean).join(' · ') || 'Weekly Ad',
      url: null,
      imageUrl: null,
      inStock: true,
    });
  }
  return out;
}

/* ---------- 手动录入兜底 ---------- */
/**
 * data/manual/<storeId>.json:
 * {
 *   "products": [
 *     { "title": "Organic Strawberries", "size": "4 lb", "priceRegular": 12.99, "pricePromo": 9.99 },
 *     { "title": "Ribeye Steak", "priceUnit": "lb", "priceRegular": 13.99 }
 *   ]
 * }
 */
export function loadManual(storeId, log = console.log) {
  const p = join(ROOT, 'data', 'manual', `${storeId}.json`);
  if (!existsSync(p)) return [];
  let j;
  try {
    j = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    log(`  [${storeId}] data/manual/${storeId}.json 不是合法 JSON: ${e.message}`);
    return [];
  }
  const out = [];
  for (const [i, r] of (j.products ?? []).entries()) {
    const reg = Number(r.priceRegular ?? r.price);
    if (!r.title || !Number.isFinite(reg) || reg <= 0) {
      log(`  [${storeId}] 手动录入第 ${i + 1} 条缺 title 或 priceRegular，跳过`);
      continue;
    }
    const promo = Number(r.pricePromo);
    out.push({
      sku: r.sku || `MANUAL-${storeId}-${createHash('sha1').update(`${r.title}|${r.size ?? ''}`).digest('hex').slice(0, 12)}`,
      title: r.title,
      brand: r.brand ?? null,
      size: r.size ?? null,
      priceUnit: r.priceUnit ?? null,
      priceRegular: reg,
      pricePromo: Number.isFinite(promo) && promo > 0 && promo < reg ? promo : null,
      promoText: r.promoText ?? (Number.isFinite(promo) && promo < reg ? '手动录入 · 促销' : null),
      url: null,
      imageUrl: null,
      inStock: r.inStock !== false,
    });
  }
  if (out.length) log(`  [${storeId}] 手动录入 ${out.length} 条`);
  return out;
}
