// 抓取器注册表。每家店一个适配器，加新超市只需要在这里加一行。

import * as sample from './sample.js';
import * as kroger from './kroger.js';
import * as traderjoes from './traderjoes.js';
import * as ranch99 from './ranch99.js';
import * as tnt from './tnt.js';
import * as costco from './costco.js';
import * as boohan from './boohan.js';

/** storeId -> 真实数据抓取器 */
export const SCRAPERS = {
  fred_meyer: kroger,
  trader_joes: traderjoes,
  ranch99,
  tnt,
  costco,
  boohan,
};

export { sample };

export function scraperFor(storeId, source) {
  if (source === 'sample') return sample;
  const s = SCRAPERS[storeId];
  if (!s) throw new Error(`没有 ${storeId} 的抓取器。可用: ${Object.keys(SCRAPERS).join(', ')}`);
  return s;
}

export function describeAll() {
  return Object.entries(SCRAPERS).map(([storeId, m]) => ({ storeId, ...m.meta }));
}
