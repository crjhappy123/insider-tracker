// 包装规格解析 + 单价归一化。
//
// 这是比价能不能信的关键。同一样东西在四家店的卖法完全不同：
//   Fred Meyer  "Simple Truth Organic Bananas, 2 lb bag"   $2.49
//   99 Ranch    "Banana"  $0.79/lb
//   T&T         "Banana (Approx. 1.5 lb)"  $1.29
// 直接比标价是没有意义的，必须都换算成 $/lb 才能比。

// 基准单位：质量 = lb，体积 = floz，计数 = each
const MASS = {
  lb: 1, lbs: 1, pound: 1, pounds: 1, '#': 1,
  oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16,
  g: 0.00220462, gr: 0.00220462, gram: 0.00220462, grams: 0.00220462,
  kg: 2.20462, kgs: 2.20462, kilo: 2.20462, kilogram: 2.20462, kilograms: 2.20462,
};

const VOLUME = {
  floz: 1, 'fl oz': 1, 'fluid ounce': 1, 'fluid ounces': 1, 'fl. oz': 1, 'fl.oz': 1,
  gal: 128, gallon: 128, gallons: 128,
  qt: 32, quart: 32, quarts: 32,
  pt: 16, pint: 16, pints: 16,
  cup: 8, cups: 8,
  l: 33.814, liter: 33.814, liters: 33.814, litre: 33.814, litres: 33.814,
  ml: 0.033814, milliliter: 0.033814, milliliters: 0.033814, cc: 0.033814,
};

const COUNT = {
  each: 1, ea: 1, ct: 1, count: 1, pc: 1, pcs: 1, piece: 1, pieces: 1,
  pk: 1, pack: 1, packs: 1, package: 1, bunch: 1, head: 1, loaf: 1,
  bag: 1, box: 1, container: 1, jar: 1, bottle: 1, can: 1, tray: 1, clamshell: 1, block: 1,
  dozen: 12, doz: 12,
};

const DIMS = [
  ['mass', MASS, 'lb'],
  ['volume', VOLUME, 'floz'],
  ['count', COUNT, 'each'],
];

/** 单位 -> {dim, factor(转成基准单位), base} */
export function unitInfo(rawUnit) {
  if (!rawUnit) return null;
  const u = String(rawUnit).toLowerCase().trim().replace(/\./g, '').replace(/\s+/g, ' ');
  const compact = u.replace(/\s+/g, '');
  for (const [dim, table, base] of DIMS) {
    if (u in table) return { dim, factor: table[u], base, unit: u };
    if (compact in table) return { dim, factor: table[compact], base, unit: compact };
  }
  return null;
}

export function unitDim(rawUnit) {
  return unitInfo(rawUnit)?.dim ?? null;
}

// 所有已知单位词，按长度倒序，保证 "fl oz" 先于 "oz" 命中
const UNIT_WORDS = [...new Set(DIMS.flatMap(([, t]) => Object.keys(t)))]
  .filter((w) => w !== '#')
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const NUM = '\\d+(?:[.,]\\d+)?(?:\\s*/\\s*\\d+)?';
const UNIT_ALT = UNIT_WORDS.join('|');

// "2 x 16 oz" / "6 pk x 12 fl oz" 这类多件装
const RE_MULTI = new RegExp(
  `(${NUM})\\s*(?:${UNIT_ALT})?\\s*[x×*]\\s*(${NUM})\\s*(${UNIT_ALT})\\b`,
  'gi'
);
// "16 oz" / "1.5 L" / "3lb" / "12ct"
const RE_SINGLE = new RegExp(`(${NUM})\\s*-?\\s*(${UNIT_ALT})\\b`, 'gi');
// 单独一个 "Dozen" / "Bunch"，没有数字
const RE_BARE = /\b(dozen|bunch|head|loaf|each)\b/gi;

function num(s) {
  if (!s) return NaN;
  const t = String(s).replace(/,/g, '').trim();
  const frac = t.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(t);
}

/**
 * 从商品标题/规格字符串里找出所有可能的包装规格。
 * @returns {Array<{qty:number, unit:string, dim:string, baseQty:number}>}
 */
export function parseSizes(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  const push = (qty, unit) => {
    if (!Number.isFinite(qty) || qty <= 0) return;
    const info = unitInfo(unit);
    if (!info) return;
    out.push({ qty, unit: info.unit, dim: info.dim, baseQty: qty * info.factor });
  };

  for (const m of s.matchAll(RE_MULTI)) push(num(m[1]) * num(m[2]), m[3]);
  for (const m of s.matchAll(RE_SINGLE)) push(num(m[1]), m[2]);
  if (out.length === 0) for (const m of s.matchAll(RE_BARE)) push(1, m[1]);

  // 去重，同一 dim 下保留信息量最大的（多件装优先）
  const seen = new Set();
  return out.filter((c) => {
    const k = `${c.dim}:${c.baseQty.toFixed(6)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 在解析结果里挑一个和目标单位同量纲的规格 */
export function pickSize(candidates, targetUnit) {
  const target = unitInfo(targetUnit);
  if (!target) return null;
  const same = candidates.filter((c) => c.dim === target.dim);
  if (same.length === 0) return null;
  // 多件装(baseQty 最大)通常才是真实总量，例如 "2 x 16 oz" 应取 32 oz
  return same.reduce((a, b) => (b.baseQty > a.baseQty ? b : a));
}

/**
 * 算出「每个目标单位多少钱」。
 *
 * @param {object} p
 * @param {number} p.price        标价（促销价或原价，调用方决定传哪个）
 * @param {string} [p.priceUnit]  如果店里本来就是按单位卖的（散称水果 $0.79/lb），传 'lb'
 * @param {string} [p.size]       店里给的规格字段，比 title 可靠，优先用
 * @param {string} [p.title]      商品标题，size 缺失时从这里猜
 * @param {string} p.targetUnit   catalog 里定的归一化单位
 * @param {number} [p.density]    可选，g/ml。只有给了才做质量<->体积换算
 * @returns {{unitPrice:number, unit:string, packQty:number|null, basis:string}|null}
 */
export function unitPrice({ price, priceUnit, size, title, targetUnit, density }) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const target = unitInfo(targetUnit);
  if (!target) return null;

  // 情况一：店里已经按单位报价
  if (priceUnit) {
    const from = unitInfo(priceUnit);
    if (from && from.dim === target.dim) {
      // price 是「每 1 个 from 单位」，换算成「每 1 个 target 单位」
      const perBase = price / from.factor;
      return {
        unitPrice: perBase * target.factor,
        unit: target.unit,
        packQty: null,
        basis: `店内按 ${from.unit} 报价`,
      };
    }
  }

  // 情况二：从规格字段/标题解析包装量，再用总价除
  for (const [src, text] of [['规格字段', size], ['标题', title]]) {
    const pick = pickSize(parseSizes(text), targetUnit);
    if (pick) {
      const qtyInTarget = pick.baseQty / target.factor;
      if (qtyInTarget > 0) {
        return {
          unitPrice: price / qtyInTarget,
          unit: target.unit,
          packQty: qtyInTarget,
          basis: `${src}解析出 ${pick.qty}${pick.unit}`,
        };
      }
    }
  }

  // 情况三：量纲不同但 catalog 给了密度 —— 例如生抽按 450 g 卖，要比 $/液量盎司
  if (density > 0) {
    for (const [src, text] of [['规格字段', size], ['标题', title]]) {
      for (const cand of parseSizes(text)) {
        if (cand.dim === target.dim || cand.dim === 'count') continue;
        const qtyInTarget = crossDim(cand.baseQty, cand.dim, target, density);
        if (qtyInTarget && qtyInTarget > 0) {
          return {
            unitPrice: price / qtyInTarget,
            unit: target.unit,
            packQty: qtyInTarget,
            basis: `${src}的 ${cand.qty}${cand.unit} 按密度 ${density}g/ml 折算`,
          };
        }
      }
    }
  }

  // 情况四：目标单位就是「个」，且没解析出规格 —— 当成 1 个卖
  if (target.dim === 'count' && target.factor === 1) {
    return { unitPrice: price, unit: target.unit, packQty: 1, basis: '按单件计（未解析出规格）' };
  }

  return null;
}

/**
 * 质量 <-> 体积 的跨量纲换算。
 *
 * 为什么需要：调料两种卖法都有。Boo Han 的生抽标 450 g，Fred Meyer 的标 15 fl oz，
 * 没有密度这两个数字没法比。所以 catalog 里可以给这类商品加一个 density（g/ml），
 * **只有显式给了才换算** —— 绝不自己猜密度，猜错了单价就错，比不比更糟。
 */
const ML_PER_FLOZ = 29.5735;
const G_PER_LB = 453.592;

function crossDim(baseQty, fromDim, targetInfo, density) {
  if (!density || density <= 0) return null;
  if (fromDim === 'mass' && targetInfo.dim === 'volume') {
    const grams = baseQty * G_PER_LB;          // baseQty 单位是 lb
    const floz = grams / density / ML_PER_FLOZ;
    return floz / targetInfo.factor;
  }
  if (fromDim === 'volume' && targetInfo.dim === 'mass') {
    const grams = baseQty * ML_PER_FLOZ * density;  // baseQty 单位是 floz
    return grams / G_PER_LB / targetInfo.factor;
  }
  return null;
}

export function fmtUnit(unit) {
  const map = { lb: '磅', oz: '盎司', gal: '加仑', floz: '液量盎司', each: '个', dozen: '打' };
  return map[unitInfo(unit)?.unit] ?? unit;
}
