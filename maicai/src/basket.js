// 购物清单 -> 「今天去哪几家、每家买什么」。
//
// 这是你说的「选择去哪家超市买什么简单一点」那个功能。光知道哪家便宜没用 ——
// T&T 在 Bellevue，单程 32 分钟，为了省 $3 专程跑一趟是亏的。
// 所以把车程折算成钱，算总成本（商品钱 + 跑腿成本）最低的方案。
//
// 真正的算法在 lib/plan.js（纯函数）。线上静态站的浏览器端用的是同一份代码，
// 保证线上和本地算出来的方案完全一致。这里只负责从 SQLite 取数据喂给它。

import { analyze } from './deals.js';
import { loadCatalog, getStores, loadStoresConfig } from './db.js';
import { planBasketFrom } from '../web/plan.js';

/**
 * @param {Array<{itemId:string, qty:number}>} entries 清单，qty 单位 = catalog 里该 item 的 unit
 * @param {object} [opts]
 * @param {number} [opts.perMinute] 每分钟车程折算成本($)，覆盖 stores.json 的默认值
 * @param {string[]} [opts.onlyStores] 限定只考虑这几家店
 */
export function planBasket(entries, opts = {}) {
  const cfg = loadStoresConfig();
  const perMinute = opts.perMinute ?? cfg.tripCost?.perMinute ?? 0.35;

  let stores = getStores();
  if (opts.onlyStores?.length) stores = stores.filter((s) => opts.onlyStores.includes(s.id));

  return planBasketFrom({
    rows: analyze(),
    entries,
    stores: stores.map((s) => ({ id: s.id, name: s.name_zh || s.name, driveMinutes: s.drive_minutes })),
    catalog: loadCatalog(),
    perMinute,
  });
}

/** 没自定义清单时，用 catalog 里的 weekly 当默认一周的量 */
export function defaultBasket() {
  return loadCatalog()
    .filter((i) => (i.weekly || 0) > 0)
    .map((i) => ({ itemId: i.id, qty: i.weekly }));
}
