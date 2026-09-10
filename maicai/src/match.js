// 把各家店五花八门的商品标题，归到 catalog.json 里的同一样东西上。
//
// 自动匹配永远做不到 100% 准，所以设计成：自动匹配打分 + 网页上可手动纠正/拉黑，
// 手动结果存数据库，之后抓取不覆盖。

export const MIN_SCORE = 0.30;
/** 低于这个分数在界面上提示「建议核对」，但仍然参与比价 */
export const WEAK_SCORE = 0.45;

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9%.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function includesPhrase(hay, needle) {
  const n = norm(needle);
  if (!n) return false;
  return ` ${hay} `.includes(` ${n} `) || hay.includes(n);
}

/**
 * 给单个商品标题打分，返回最合适的 catalog item。
 * @param {{title:string, brand?:string, size?:string}} product
 * @param {Array} items catalog.items
 * @returns {{itemId:string, score:number, hit:string}|null}
 */
// 打分时要把品牌和包装规格从标题里去掉再算「关键词覆盖了多少」。
// 不去掉的话 "Private Selection Blueberries, 32 oz" 这种正确匹配会因为标题长而被判低分。
const SIZE_TOKENS = /\b\d+(?:[.,]\d+)?\s*(?:lb|lbs|pound|pounds|oz|ounce|ounces|g|gr|gram|grams|kg|ml|l|liter|litre|fl\s*oz|gal|gallon|qt|quart|pt|pint|ct|count|pk|pack|pcs?|dozen)\b/g;

function cleanTitle(title, brand) {
  let t = norm(title);
  const b = norm(brand);
  if (b && b.length > 2) t = t.split(b).join(' ');
  return t.replace(SIZE_TOKENS, ' ').replace(/\b\d+\s*x\s*\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
}

export function matchProduct(product, items) {
  const hay = norm([product.title, product.brand, product.size].filter(Boolean).join(' '));
  if (!hay) return null;
  const core = cleanTitle(product.title, product.brand);

  let best = null;
  for (const item of items) {
    const m = item.match || {};
    if ((m.not || []).some((k) => includesPhrase(hay, k))) continue;
    if ((m.all || []).some((k) => !includesPhrase(hay, k))) continue;

    let hit = null;
    for (const k of m.any || []) {
      if (includesPhrase(hay, k) && (!hit || norm(k).length > norm(hit).length)) hit = k;
    }
    if (!hit) continue;

    // 打分三个信号：
    //   specificity 关键词本身够不够具体（"boneless skinless chicken breast" 比 "banana" 具体）
    //   coverage    关键词占了商品名主体多大比例。分母封顶 30 字符，否则
    //               "Seasoned Soy Sauce for Soup and Braising" 这种长描述会被过度惩罚
    //   head        关键词离标题开头多近。英文商品名把主体名词放前面、修饰语放后面，
    //               所以 "Vegetable Party Tray with Broccoli..." 里的 broccoli 位置很靠后，
    //               它是配料而不是商品本身 —— 这个信号专门用来区分这种情况
    const kw = norm(hit);
    const specificity = Math.min(1, kw.length / 22);
    const denom = Math.max(kw.length, Math.min(core.length || kw.length, 30));
    const coverage = kw.length / denom;
    const at = core.indexOf(kw);
    const head = at < 0 ? 0.5 : 1 - Math.min(1, at / 24);
    const score = Math.min(1, 0.30 * specificity + 0.40 * coverage + 0.30 * head);

    if (!best || score > best.score) best = { itemId: item.id, score, hit };
  }
  // 分数太低宁可不匹配。实测正确匹配都在 0.39 以上，而
  // "Banana Nut Muffin Mix"、"Chocolate Covered Banana Slices" 这类都在 0.28 以下。
  // 设个下限比无止境地往 catalog 的 not 列表里加关键词可靠 —— 漏了可以手动指定，
  // 但错的价格混进比价里会直接给出错的建议。
  if (best && best.score < MIN_SCORE) return null;
  return best;
}


/** 批量匹配，顺带统计每个 item 命中了多少商品，方便发现「某样东西一家店都没抓到」 */
export function matchAll(products, items) {
  const results = [];
  const coverage = new Map(items.map((i) => [i.id, 0]));
  for (const p of products) {
    const m = matchProduct(p, items);
    if (m) {
      results.push({ product: p, ...m });
      coverage.set(m.itemId, (coverage.get(m.itemId) || 0) + 1);
    }
  }
  return { results, coverage };
}
