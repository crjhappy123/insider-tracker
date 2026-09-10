// 前端。无构建步骤，原生 ES module。
// 数据来源见 data.js —— 本地跑打 /api/*，线上静态站读 snapshot.json 并在浏览器里算。

import { DATA, MODE } from './data.js';

const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');

// 6 家店 -> 6 个色位。这个顺序在浅色/深色两套下都通过了色盲分离度校验（相邻对比模式），
// 且图表始终带图例 + 末端直接标注，颜色不单独承载身份。
const STORE_COLOR = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)',
  'var(--series-4)', 'var(--series-5)', 'var(--series-6)',
];
const UNIT_ZH = { lb: '磅', oz: '盎司', gal: '加仑', floz: '液量盎司', each: '个', dozen: '打' };

const state = { summary: null, tab: 'today', basketEntries: null };

/* ---------- 工具 ---------- */
const money = (n, d = 2) => (Number.isFinite(n) ? `$${n.toFixed(d)}` : '—');
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(0)}%` : '—');
const unitZh = (u) => UNIT_ZH[u] ?? u;
const perUnit = (n, u) => (Number.isFinite(n) ? `${money(n)}/${unitZh(u)}` : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 很多店的标题里已经带了规格，别再重复贴一遍
function titleWithSize(title, size) {
  const t = String(title ?? '');
  if (!size) return esc(t);
  const s = String(size);
  return t.toLowerCase().includes(s.toLowerCase()) ? esc(t) : `${esc(t)} · ${esc(s)}`;
}
const WEAK_SCORE = 0.45; // 低于这个分数提示「建议核对」（低于 0.30 后端已经直接不匹配了）

function storeIndex(storeId) {
  return state.summary.stores.findIndex((s) => s.id === storeId);
}
function storeName(storeId) {
  const s = state.summary.stores.find((x) => x.id === storeId);
  return s ? (s.nameZh || s.name) : storeId;
}

function emptyState(title, hint) {
  return `<div class="empty"><p class="empty-title">${esc(title)}</p><p class="muted">${hint}</p></div>`;
}


const EMOJI_FALLBACK = '🛒';
function emojiFor(itemId) {
  return state.summary?.catalog.find((i) => i.id === itemId)?.emoji ?? EMOJI_FALLBACK;
}

/**
 * 商品缩略图。有真实商品图就用真图，没有（或加载失败）就露出底下的图标。
 * img 加载失败时浏览器不显示它，emoji 自然露出来，不需要 onerror 兜底。
 */
function thumb(imageUrl, emoji, cls = '') {
  const inner = imageUrl
    ? `<img src="${esc(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return `<div class="thumb ${cls}" data-emoji="${esc(emoji || EMOJI_FALLBACK)}">${inner}</div>`;
}

// 每种数据来源对应的说明。这个必须显著提示 —— 公开站点把编造的价格
// 不声不响地混在真实价格里，等于在骗人。
const SRC_LABEL = {
  sample: '样本价',
  estimate: '估算价',
  manual: '手动录入',
  flyer: '促销单读图',
  real: '实测抓取',
};

function sampleNotice() {
  const s = state.summary;
  if (!s?.dataSources) return '';
  const tally = {};
  for (const v of Object.values(s.dataSources)) {
    for (const [k, n] of Object.entries(v)) tally[k] = (tally[k] || 0) + n;
  }
  const soft = (tally.sample || 0) + (tally.estimate || 0);
  if (soft === 0) return '';

  const storesOf = (kind) => Object.entries(s.dataSources)
    .filter(([, v]) => v[kind]).map(([id]) => storeName(id));

  const lines = [];
  if (tally.sample) {
    lines.push(`<strong>${tally.sample} 条是样本数据</strong>（按各店定价习惯编的，用来验证功能）：${storesOf('sample').map(esc).join('、')}`);
  }
  if (tally.estimate) {
    lines.push(`<strong>${tally.estimate} 条是估算价</strong>（按常见货架价填的，没有实地核对）：${storesOf('estimate').map(esc).join('、')}`);
  }
  const trusted = (tally.real || 0) + (tally.manual || 0) + (tally.flyer || 0);

  return `<div class="notice">
    <span class="ico">⚠️</span>
    <div>
      <strong>这些价格里有 ${soft} 条不是实测价格，别拿来做真的购买决定。</strong>
      <br>${lines.join('<br>')}
      ${trusted ? `<br>另有 ${trusted} 条是实测抓取或你手动核对过的。` : ''}
      <br>每张卡片上都标着来源。抓取跑通后不可信的会被自动替换掉。
    </div>
  </div>`;
}

/* ---------- 启动 ---------- */
init();

async function init() {
  $('#themeToggle').addEventListener('click', toggleTheme);
  applyStoredTheme();

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) location.hash = b.dataset.tab;
  });
  window.addEventListener('hashchange', route);

  for (const el of document.querySelectorAll('#drawer [data-close]')) {
    el.addEventListener('click', closeDrawer);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  try {
    state.summary = await DATA.summary();
  } catch (e) {
    main.innerHTML = `<div class="empty"><p class="empty-title err">连不上后端</p><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const gen = state.summary.generatedAt
    ? `（数据更新于 ${new Date(state.summary.generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`
    : '';
  $('#homeLabel').textContent = `${state.summary.home?.label ?? ''} · ${state.summary.today} ${gen}`;
  route();
}

function route() {
  const tab = (location.hash.slice(1) || 'today');
  state.tab = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  main.innerHTML = '<div class="loading">加载中…</div>';
  const fn = { today: renderToday, deals: renderDeals, compare: renderCompare, basket: renderBasket, library: renderLibrary }[tab] ?? renderToday;
  fn().catch((e) => { main.innerHTML = `<div class="empty"><p class="empty-title err">出错了</p><p class="muted">${esc(e.message)}</p></div>`; });
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('maicai-theme', next);
}
function applyStoredTheme() {
  const saved = localStorage.getItem('maicai-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  else document.documentElement.removeAttribute('data-theme'); // 跟随系统
}

/* ================= 今日促销 ================= */
async function renderToday() {
  const d = await DATA.today();

  if (d.stats.comparable === 0) {
    main.innerHTML = emptyState(
      '还没有任何价格数据',
      '先在终端跑 <code>npm run seed-history</code>（造 90 天样本历史，立刻能看全部功能），' +
      '或者 <code>npm run ingest</code> 抓真实数据。'
    );
    return;
  }

  const realCount = d.deals.length;
  const lowestCount = d.deals.filter((x) => x.isLowestEver).length;

  const tiles = `
    <div class="tiles">
      <div class="tile">
        <div class="label">真降价商品</div>
        <div class="value num">${realCount}</div>
        <div class="foot">比历史中位价便宜 ${pct(state.summary.dealConfig.REAL_DEAL_MIN)} 以上</div>
      </div>
      <div class="tile">
        <div class="label">按你家用量，一周能省</div>
        <div class="value num">${money(d.totalWeeklySaving)}</div>
        <div class="foot">全部趁降价买的话</div>
      </div>
      <div class="tile">
        <div class="label">跌到历史最低</div>
        <div class="value num">${lowestCount}</div>
        <div class="foot">该囤货了</div>
      </div>
      <div class="tile">
        <div class="label">有历史可判断的商品</div>
        <div class="value num">${d.stats.withHistory}<span class="muted" style="font-size:15px">/${d.stats.comparable}</span></div>
        <div class="foot">其余的攒够天数才能判断</div>
      </div>
    </div>`;

  const dealsHtml = realCount === 0
    ? emptyState('今天没有值得跑一趟的降价', '这就是有历史价格的好处 —— 店里挂的促销标不代表真便宜。下面「假促销」里可以看到今天有哪些是虚的。')
    : `<div class="deal-list">${d.deals.map(dealCard).join('')}</div>`;

  const fake = d.fakeDeals.length ? `
    <details class="fold">
      <summary>假促销 ${d.fakeDeals.length} 个 —— 挂着促销标，但没比平时便宜</summary>
      <div class="deal-list" style="margin-top:8px">${d.fakeDeals.map(dealCard).join('')}</div>
    </details>` : '';

  const missing = d.missing.length ? `
    <details class="fold">
      <summary>你常买但没抓到价的 ${d.missing.length} 样 —— 需要修匹配规则</summary>
      <div class="card" style="margin-top:8px">
        <p class="muted" style="margin-top:0">这些东西四家店都没抓到可比价格。可能是关键词没对上，或者那家店的抓取失败了。
        去「商品库」页手动纠正，或改 <code>data/catalog.json</code> 里的 <code>match.any</code>。</p>
        <div class="rowflex">${d.missing.map((m) => `<span class="badge">${esc(m.itemName)}</span>`).join('')}</div>
      </div>
    </details>` : '';

  main.innerHTML = `
    <section class="block">
      <h2>今日促销</h2>
      <p class="subtitle">按「你家一周能省多少钱」排序，不是按折扣百分比 —— 每周都买的东西降 10% 比半年买一次的降 40% 更值得关注。</p>
      ${sampleNotice()}
      ${tiles}
      ${dealsHtml}
      ${fake}
      ${missing}
    </section>`;

  for (const el of main.querySelectorAll('.deal[data-item]')) {
    el.addEventListener('click', () => openItem(el.dataset.item));
  }
}

function dealCard(r) {
  const badges = [];
  if (r.verdict === 'real') {
    badges.push(`<span class="badge good"><span class="dot"></span>比平时便宜 ${pct(r.discount)}</span>`);
  } else if (r.verdict === 'fake') {
    badges.push(`<span class="badge warn"><span class="dot"></span>假促销：只便宜 ${pct(Math.max(0, r.discount ?? 0))}</span>`);
  }
  if (r.isLowestEver) badges.push(`<span class="badge good"><span class="dot"></span>历史最低价</span>`);
  if (r.isCheapestNow) badges.push(`<span class="badge">四家店里最便宜</span>`);
  if (r.promoText) badges.push(`<span class="badge">${esc(r.promoText)}</span>`);
  if (r.matchOrigin === 'auto' && r.matchScore != null && r.matchScore < WEAK_SCORE) {
    badges.push(`<span class="badge warn"><span class="dot"></span>匹配可能不准，建议核对</span>`);
  }

  const save = r.weeklySaving > 0.01
    ? `<div class="save">一周省 ${money(r.weeklySaving)}</div>`
    : '';

  return `
    <article class="deal" data-item="${esc(r.itemId)}" tabindex="0">
      <div style="display:flex;gap:11px;align-items:flex-start;min-width:0">
        ${thumb(r.imageUrl, emojiFor(r.itemId))}
        <div style="min-width:0">
        <div class="name">${esc(r.itemName)}</div>
        <div class="where">${esc(r.storeName)} · 每周约买 ${r.weekly} ${esc(unitZh(r.unit))}</div>
        <div class="title-en">${titleWithSize(r.title, r.size)}</div>
        <div class="badges">${badges.join('')}</div>
        </div>
      </div>
      <div class="right">
        <div class="unit-now num">${perUnit(r.unitPrice, r.unit)}</div>
        <div class="unit-was num">平时 ${perUnit(r.medianUnitPrice, r.unit)}</div>
        ${save}
      </div>
    </article>`;
}


/* ================= 打折专区 ================= */
// 按超市分组看「这家店今天在打折什么」。和「今日促销」的区别：
//   今日促销 = 跨店筛出真降价，按你家一周能省多少排序（决定「今天该买什么」）
//   打折专区 = 逛店视角，一家一家看它挂了哪些促销（决定「去这家店顺手买点什么」）
// 所以这里把店里挂的促销全列出来，但明确标出哪些是真降价、哪些是假促销。
async function renderDeals() {
  const [p, cmp] = await Promise.all([DATA.promos(), DATA.compare()]);
  const snap = state.summary;

  // 用比价数据算出每样东西当前哪家最便宜，卡片上标「全场最低」
  const cheapest = new Map();
  for (const row of cmp.rows) {
    const lo = row.cells.filter(Boolean).find((c) => c.isLowest);
    if (lo) cheapest.set(row.itemId, lo.storeId);
  }

  // 店里挂了促销标的全部商品，按店分组
  const promos = p.promos;
  const byStore = new Map();
  for (const r of promos) {
    if (!byStore.has(r.storeId)) byStore.set(r.storeId, []);
    byStore.get(r.storeId).push(r);
  }

  const others = new Map();
  for (const o of p.otherPromos ?? []) {
    if (!others.has(o.storeId)) others.set(o.storeId, []);
    others.get(o.storeId).push(o);
  }

  const stores = snap.stores.filter((s) => (byStore.get(s.id)?.length || others.get(s.id)?.length));
  if (stores.length === 0) {
    main.innerHTML = emptyState('今天各店都没有促销', '或者还没抓到数据。跑 <code>npm run ingest</code> 试试。');
    return;
  }

  const active = state.dealStore ?? 'all';
  const chips = [
    `<button class="chip ${active === 'all' ? 'on' : ''}" data-store="all">全部 <span class="n">${promos.length}</span></button>`,
    ...stores.map((s) => {
      const n = (byStore.get(s.id)?.length || 0) + (others.get(s.id)?.length || 0);
      return `<button class="chip ${active === s.id ? 'on' : ''}" data-store="${esc(s.id)}">${esc(s.nameZh || s.name)} <span class="n">${n}</span></button>`;
    }),
  ].join('');

  const shown = active === 'all' ? stores : stores.filter((s) => s.id === active);

  const blocks = shown.map((s) => {
    const list = (byStore.get(s.id) ?? []).slice().sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    const real = list.filter((r) => r.verdict === 'real');
    const save = real.reduce((a, r) => a + (r.weeklySaving || 0), 0);
    const off = others.get(s.id) ?? [];

    return `
      <section class="store-block">
        <header>
          <h3>${esc(s.nameZh || s.name)}</h3>
          <span class="meta">单程 ${s.driveMinutes} 分${s.branch ? ` · ${esc(s.branch)}` : ''}</span>
          <span class="meta">在打折 ${list.length} 样，其中真降价 ${real.length} 样</span>
          ${save > 0.01 ? `<span class="tot">按你家用量一周省 ${money(save)}</span>` : ''}
        </header>
        ${list.length ? `<div class="deal-grid">${list.map((r) => dealTile(r, cheapest.get(r.itemId) === r.storeId)).join('')}</div>`
                      : '<p class="muted" style="margin:0">常买清单里的东西这家今天没打折。</p>'}
        ${off.length ? `
          <details class="fold">
            <summary>清单外还有 ${off.length} 样在打折 —— 顺手看看</summary>
            <div class="deal-grid" style="margin-top:8px">${off.slice(0, 24).map(offTile).join('')}</div>
          </details>` : ''}
      </section>`;
  }).join('');

  main.innerHTML = `
    <section class="block">
      <h2>打折专区</h2>
      <p class="subtitle">按超市分开看，每家今天挂了哪些促销。<strong>挂促销标不等于真便宜</strong> —— 和过去 90 天的中位价比过之后，真降价的标绿、只是虚标的标黄。</p>
      ${sampleNotice()}
      <div class="store-filter">${chips}</div>
      ${blocks}
    </section>`;

  for (const c of main.querySelectorAll('.chip[data-store]')) {
    c.addEventListener('click', () => { state.dealStore = c.dataset.store; renderDeals(); });
  }
  for (const el of main.querySelectorAll('.dcard[data-item]')) {
    el.addEventListener('click', () => openItem(el.dataset.item));
  }
}

function dealTile(r, isCheapest) {
  const badges = [];
  if (r.verdict === 'real') badges.push(`<span class="badge good"><span class="dot"></span>比平时便宜 ${pct(r.discount)}</span>`);
  else if (r.verdict === 'fake') badges.push(`<span class="badge warn"><span class="dot"></span>假促销，只便宜 ${pct(Math.max(0, r.discount ?? 0))}</span>`);
  else badges.push(`<span class="badge">历史不足，判断不了</span>`);
  if (r.isLowestEver) badges.push(`<span class="badge good"><span class="dot"></span>历史最低</span>`);
  if (isCheapest) badges.push(`<span class="badge">全场最低</span>`);
  // 起买量提醒：Costco 在打折专区里最显眼，但「单价最低」常常是以整箱起买为代价的
  if (Number.isFinite(r.packQty) && r.packQty > (r.weekly || 0) * 2) {
    badges.push(`<span class="badge warn"><span class="dot"></span>整包 ${+r.packQty.toFixed(1)} ${esc(unitZh(r.unit))}</span>`);
  }
  if (r.src === 'sample' || r.src === 'estimate') {
    badges.push(`<span class="badge warn"><span class="dot"></span>${SRC_LABEL[r.src]}</span>`);
  }

  const eff = r.pricePromo ?? r.priceRegular;
  return `
    <article class="dcard" data-item="${esc(r.itemId)}" tabindex="0">
      ${thumb(r.imageUrl, emojiFor(r.itemId))}
      <div class="body">
        <div class="nm">${esc(r.itemName)}</div>
        <div class="sub">${titleWithSize(r.title, r.size)}</div>
        <div class="prices">
          <span class="now">${money(eff)}</span>
          ${r.pricePromo != null && r.priceRegular ? `<span class="was">${money(r.priceRegular)}</span>` : ''}
          <span class="per">${perUnit(r.unitPrice, r.unit)}</span>
        </div>
        <div class="badges">${badges.join('')}</div>
      </div>
    </article>`;
}

/** 清单外的打折商品：没有单价、不参与比价，只显示店里的标价 */
function offTile(o) {
  return `
    <article class="dcard plain">
      ${thumb(o.imageUrl, EMOJI_FALLBACK)}
      <div class="body">
        <div class="nm" style="font-size:13px">${esc(o.title)}</div>
        <div class="sub">${o.size ? esc(o.size) : ''}${o.promoText ? ` · ${esc(o.promoText)}` : ''}</div>
        <div class="prices">
          <span class="now">${money(o.pricePromo)}</span>
          <span class="was">${money(o.priceRegular)}</span>
          <span class="per">降 ${pct(o.discount)}</span>
        </div>
        <div class="badges"><span class="badge">不在常买清单，没算单价</span></div>
      </div>
    </article>`;
}

/* ================= 比价 ================= */
async function renderCompare() {
  const d = await DATA.compare();
  const withData = d.rows.filter((r) => r.cells.some(Boolean));

  if (withData.length === 0) {
    main.innerHTML = emptyState('还没有可比价的数据', '先跑 <code>npm run seed-history</code> 或 <code>npm run ingest</code>。');
    return;
  }

  // 按品类分组，方便逛
  const cats = [...new Set(withData.map((r) => r.category))];
  const body = cats.map((cat) => {
    const rows = withData.filter((r) => r.category === cat);
    return `
      <tr class="cat-row"><td colspan="${d.stores.length + 2}">${esc(cat)}</td></tr>
      ${rows.map(compareRow).join('')}`;
  }).join('');

  main.innerHTML = `
    <section class="block">
      <h2>比价</h2>
      <p class="subtitle">所有价格都换算成同一个单位再比，包装规格不同也能直接对照。点任意一行看明细和价格走势。</p>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>商品</th>
              <th>单位</th>
              ${d.stores.map((s) => `<th class="price">${esc(s.name)}<br><span class="muted" style="font-weight:400">单程 ${s.driveMinutes} 分</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="subtitle" style="margin-top:10px">
        标「最低」的是当前最便宜的店。空白表示那家店没抓到这样东西，或者规格解析不出来没法比 —— 后者在明细里会说明。<br>Costco 这类大包装店要留意起买量：单价最低但只卖整箱，买回来吃不完就不算省 —— 明细和购物清单里会标出来。
      </p>
    </section>`;

  for (const tr of main.querySelectorAll('tr[data-item]')) {
    tr.addEventListener('click', () => openItem(tr.dataset.item));
  }
}

function compareRow(r) {
  const cells = r.cells.map((c) => {
    if (!c) return `<td class="price none">—</td>`;
    const cls = ['price'];
    if (c.isLowest) cls.push('lowest');
    const promo = c.verdict === 'real' ? `<br><span class="badge good" style="font-size:10px"><span class="dot"></span>降 ${pct(c.discount)}</span>` : '';
    // 起买量提醒：单价最低但只卖整箱的话，这个「最低」是有条件的
    const bulk = Number.isFinite(c.packQty) && c.packQty > (r.weekly || 0) * 2
      ? `<br><span class="badge warn" style="font-size:10px"><span class="dot"></span>整包 ${+c.packQty.toFixed(1)}${esc(unitZh(r.unit))}</span>`
      : '';
    return `<td class="${cls.join(' ')}">${money(c.unitPrice, c.unitPrice < 1 ? 3 : 2)}${promo}${bulk}</td>`;
  }).join('');

  return `
    <tr class="clickable" data-item="${esc(r.itemId)}">
      <td><span style="display:inline-flex;align-items:center;gap:8px">${thumb(null, r.emoji ?? emojiFor(r.itemId), 'sm')}<span><strong>${esc(r.itemName)}</strong><br><span class="muted" style="font-size:11px">${esc(r.nameEn)}</span></span></span></td>
      <td class="muted">每${esc(unitZh(r.unit))}</td>
      ${cells}
    </tr>`;
}

/* ================= 购物清单 ================= */
async function renderBasket() {
  const d = await DATA.basket();
  state.basketEntries = new Map(d.entries.map((e) => [e.itemId, e.qty]));

  main.innerHTML = `
    <section class="block">
      <h2>购物清单</h2>
      <p class="subtitle">
        勾选要买的东西和数量，算出去哪几家、每家买什么最划算。
        车程按 ${money(d.perMinute)}/分钟折成钱算进总成本 —— 所以为了省两块钱专程跑一趟远店，这里不会推荐。
      </p>
      <div class="basket-grid">
        <div class="card picker" id="picker">${pickerHtml()}</div>
        <div id="planPane">${planHtml(d)}</div>
      </div>
    </section>`;

  bindPicker();
}

function pickerHtml() {
  const cats = [...new Set(state.summary.catalog.map((i) => i.category))];
  return cats.map((cat) => `
    <div class="pick-cat">${esc(cat)}</div>
    ${state.summary.catalog.filter((i) => i.category === cat).map((i) => {
      const qty = state.basketEntries.get(i.id);
      const on = qty != null && qty > 0;
      return `
        <div class="pick-row">
          <label>
            <input type="checkbox" data-item="${esc(i.id)}" ${on ? 'checked' : ''}>
            <span>${esc(i.name)}</span>
          </label>
          <input type="number" min="0" step="0.25" data-qty="${esc(i.id)}"
                 value="${on ? qty : (i.weekly || 1)}" ${on ? '' : 'disabled'}
                 title="单位：${esc(unitZh(i.unit))}">
        </div>`;
    }).join('')}`).join('');
}

function bindPicker() {
  const picker = $('#picker');
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(submitBasket, 350); };

  picker.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-item]');
    if (cb) {
      const qtyInput = picker.querySelector(`input[data-qty="${cb.dataset.item}"]`);
      qtyInput.disabled = !cb.checked;
      schedule();
      return;
    }
    if (e.target.closest('input[data-qty]')) schedule();
  });
  picker.addEventListener('input', (e) => { if (e.target.closest('input[data-qty]')) schedule(); });
}

async function submitBasket() {
  const picker = $('#picker');
  const entries = [];
  for (const cb of picker.querySelectorAll('input[type="checkbox"][data-item]')) {
    if (!cb.checked) continue;
    const qty = Number(picker.querySelector(`input[data-qty="${cb.dataset.item}"]`).value);
    if (qty > 0) entries.push({ itemId: cb.dataset.item, qty });
  }
  const pane = $('#planPane');
  pane.style.opacity = '0.5';
  try {
    const d = await DATA.plan(entries);
    pane.innerHTML = planHtml(d);
  } catch (e) {
    pane.innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  } finally {
    pane.style.opacity = '1';
  }
}

function planHtml(d) {
  if (!d.plan) {
    return `<div class="card">${emptyState('算不出方案', '清单是空的，或者还没有价格数据。')}</div>`;
  }
  const p = d.plan;

  const groups = p.byStore.map((g) => {
    const s = state.summary.stores.find((x) => x.id === g.storeId);
    return `
      <div class="store-group">
        <header>
          <h3>${esc(g.storeName)} <span class="muted" style="font-weight:400">${s ? `· 单程 ${s.driveMinutes} 分` : ''}</span></h3>
          <span class="num">${money(g.subtotal)}</span>
        </header>
        ${g.lines.map((l) => `
          <div class="line-item">
            <span>${esc(l.itemName)}
              ${l.verdict === 'real' ? `<span class="badge good" style="font-size:10px"><span class="dot"></span>正在降价</span>` : ''}
              ${l.packOversized ? `<span class="badge warn" style="font-size:10px"><span class="dot"></span>只卖 ${l.packOversized} ${esc(unitZh(l.unit))} 整包</span>` : ''}
              <br><span class="muted" style="font-size:11px">${esc(l.title)}</span>
            </span>
            <span class="qty">${l.qty} ${esc(unitZh(l.unit))} × ${money(l.unitPrice, l.unitPrice < 1 ? 3 : 2)}</span>
            <span class="cost">${money(l.cost)}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  const alts = d.alternatives.filter((a) => a.storeIds.join() !== p.storeIds.join()).slice(0, 5);

  return `
    <div class="tiles">
      <div class="tile">
        <div class="label">今天这么买，总共</div>
        <div class="value num">${money(p.totalCost)}</div>
        <div class="foot">商品 ${money(p.goodsCost)} + 车程折算 ${money(p.tripCost)}</div>
      </div>
      <div class="tile">
        <div class="label">跑几家</div>
        <div class="value num">${p.storeIds.length}</div>
        <div class="foot">${esc(p.storeNames.join(' + '))}</div>
      </div>
      <div class="tile">
        <div class="label">比每样都买贵的那家省</div>
        <div class="value num">${money(d.savingVsWorst)}</div>
        <div class="foot">同样的东西，选贵的店买的话</div>
      </div>
    </div>

    <div class="plan-note">${esc(d.note)}</div>

    ${groups}

    ${d.unavailable.length ? `
      <details class="fold">
        <summary>清单里有 ${d.unavailable.length} 样没价格，没算进来</summary>
        <div class="card" style="margin-top:8px">
          <div class="rowflex">${d.unavailable.map((u) => `<span class="badge warn"><span class="dot"></span>${esc(u.itemName)}</span>`).join('')}</div>
          <p class="muted" style="margin-bottom:0">这些去「商品库」页看看是不是匹配没对上。</p>
        </div>
      </details>` : ''}

    ${alts.length ? `
      <details class="fold">
        <summary>其它组合怎么样</summary>
        <div class="tablewrap" style="margin-top:8px">
          <table>
            <thead><tr><th>组合</th><th class="price">商品</th><th class="price">车程</th><th class="price">总计</th><th class="price">比推荐方案</th></tr></thead>
            <tbody>${alts.map((a) => `
              <tr>
                <td>${esc(a.storeNames.join(' + '))}${a.complete ? '' : ` <span class="badge warn"><span class="dot"></span>缺 ${a.missingCount} 样</span>`}</td>
                <td class="price">${money(a.goodsCost)}</td>
                <td class="price">${money(a.tripCost)}</td>
                <td class="price">${money(a.totalCost)}</td>
                <td class="price">${a.deltaVsBest > 0.005 ? `贵 ${money(a.deltaVsBest)}` : '—'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>` : ''}`;
}

/* ================= 商品库 ================= */
async function renderLibrary() {
  const s = state.summary;
  const runsHtml = s.runs.length ? `
    <div class="tablewrap">
      <table>
        <thead><tr><th>时间</th><th>门店</th><th>结果</th><th class="price">条数</th><th>备注</th></tr></thead>
        <tbody>${s.runs.map((r) => `
          <tr>
            <td class="muted">${esc(new Date(r.ts).toLocaleString('zh-CN'))}</td>
            <td>${esc(storeName(r.storeId))}</td>
            <td>${r.ok ? '<span class="badge good"><span class="dot"></span>成功</span>' : '<span class="badge crit"><span class="dot"></span>失败</span>'}</td>
            <td class="price">${r.count}</td>
            <td class="muted" style="max-width:340px">${esc(r.message ?? '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<p class="muted">还没有抓取记录。</p>';

  main.innerHTML = `
    <section class="block">
      <h2>商品库</h2>
      <p class="subtitle">这里能看到每样东西在各店匹配到了哪些具体商品。自动匹配不可能全对 —— 发现认错了就在这里改，改动会存进数据库，之后抓取不会覆盖。${
        DATA.canEditMatches ? '' : '<br><strong>当前是线上静态站，只能看不能改。</strong>要纠正匹配请在本地 <code>npm start</code> 里改，改完重新发布就会同步上来。'
      }</p>
      <div class="rowflex" style="margin-bottom:12px">
        <input type="text" id="libSearch" placeholder="搜商品名（英文）…" style="min-width:260px">
        <span class="muted" id="libHint"></span>
      </div>
      <div id="libList"></div>
    </section>

    <section class="block">
      <h2>各店抓取方式</h2>
      <p class="subtitle">四家店的数据可获取性差别很大，这里是实际情况。</p>
      <div class="tablewrap">
        <table>
          <thead><tr><th>门店</th><th>方式</th><th>需要凭证</th><th>需要浏览器</th><th>验证状态</th></tr></thead>
          <tbody>${s.scrapers.map((x) => `
            <tr>
              <td>${esc(storeName(x.storeId))}</td>
              <td>${esc(x.label)}</td>
              <td>${credZh(x.needsCredentials)}</td>
              <td>${x.needsBrowser ? '是' : '否'}</td>
              <td class="muted">${esc(verdictZh(x.verified))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <section class="block">
      <h2>抓取记录</h2>
      ${runsHtml}
    </section>`;

  renderLibList('');
  let t = null;
  $('#libSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value;
    t = setTimeout(() => renderLibList(q), 250);
  });
}

function credZh(c) {
  if (c === 'anthropic') return 'Anthropic API（也可改手动录入）';
  return c ? '是' : '否';
}

function verdictZh(v) {
  return {
    true: '已验证',
    endpoint: '端点已实测可达，字段待首次跑确认',
    'blocked-by-curl': '已确认需浏览器（curl 返回 403），字段待首次跑确认',
    reachable: '站点可达，搜索路由待首次跑确认',
    'flyer-confirmed': '周报图已实测抓到，读图准确率待首次跑核对',
    'no-auto-source': '已确认无法自动抓取（官网封锁 + 店内价不公开），走促销单/手动录入',
  }[String(v)] ?? String(v);
}

async function renderLibList(q) {
  const box = $('#libList');
  if (q.trim().length >= 2) {
    const d = await DATA.search(q.trim());
    $('#libHint').textContent = `${d.results.length} 个结果`;
    box.innerHTML = d.results.length ? `
      <div class="card">
        ${d.results.map((r) => `
          <div class="match-row ${r.blocked ? 'blocked' : ''}">
            <span>${esc(r.title)}<br><span class="muted" style="font-size:11px">${esc(storeName(r.store_id))}${r.size ? ` · ${esc(r.size)}` : ''}</span></span>
            <span class="num">${money(r.price_promo ?? r.price_regular)}</span>
            <span>${r.item_id ? `<span class="badge">${esc(itemName(r.item_id))}</span>` : '<span class="badge warn"><span class="dot"></span>未归类</span>'}</span>
          </div>`).join('')}
      </div>` : '<p class="muted">没找到。</p>';
    return;
  }
  $('#libHint').textContent = '按品类列出你的常买清单，点进去看匹配到的具体商品';
  const cats = [...new Set(state.summary.catalog.map((i) => i.category))];
  box.innerHTML = cats.map((cat) => `
    <div class="card" style="margin-bottom:10px">
      <h3>${esc(cat)}</h3>
      <div class="rowflex">
        ${state.summary.catalog.filter((i) => i.category === cat).map((i) =>
          `<button class="ghost" data-item="${esc(i.id)}">${esc(i.name)} <span class="muted">每${esc(unitZh(i.unit))}</span></button>`
        ).join('')}
      </div>
    </div>`).join('');
  for (const b of box.querySelectorAll('button[data-item]')) {
    b.addEventListener('click', () => openItem(b.dataset.item));
  }
}

function itemName(itemId) {
  return state.summary.catalog.find((i) => i.id === itemId)?.name ?? itemId;
}

/* ================= 商品详情抽屉 ================= */
async function openItem(itemId) {
  const drawer = $('#drawer');
  drawer.hidden = false;
  $('#drawerTitle').innerHTML =
    `<span style="display:inline-flex;align-items:center;gap:10px">${thumb(null, emojiFor(itemId), 'lg')}<span>${esc(itemName(itemId))}</span></span>`;
  $('#drawerBody').innerHTML = '<div class="loading">加载中…</div>';

  let d;
  try {
    d = await DATA.item(itemId);
  } catch (e) {
    $('#drawerBody').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }

  const item = d.item;
  const priced = d.options.filter((o) => o.best);

  const head = `
    <p class="subtitle">${esc(item.nameEn)} · 比价单位：每${esc(unitZh(item.unit))} · 你家每周约 ${item.weekly} ${esc(unitZh(item.unit))}</p>
    ${d.spread != null ? `
      <div class="tiles">
        <div class="tile">
          <div class="label">最便宜的店</div>
          <div class="value" style="font-size:19px">${esc(storeName(d.cheapestStoreId))}</div>
          <div class="foot">${perUnit(priced.find((o) => o.storeId === d.cheapestStoreId)?.best.unitPrice, item.unit)}</div>
        </div>
        <div class="tile">
          <div class="label">最贵和最便宜差</div>
          <div class="value num">${pct(d.spreadPct)}</div>
          <div class="foot">差 ${perUnit(d.spread, item.unit)}</div>
        </div>
        <div class="tile">
          <div class="label">买对店一周省</div>
          <div class="value num">${money(d.weeklySavingVsWorst)}</div>
          <div class="foot">相对买最贵那家</div>
        </div>
      </div>` : ''}`;

  const rows = d.options.map((o) => {
    if (!o.best) {
      return `<tr><td>${esc(o.storeName)}</td><td class="price none" colspan="2">没抓到</td></tr>`;
    }
    const b = o.best;
    const badge = b.verdict === 'real'
      ? `<span class="badge good"><span class="dot"></span>降 ${pct(b.discount)}</span>`
      : b.verdict === 'fake' ? `<span class="badge warn"><span class="dot"></span>假促销</span>` : '';
    return `
      <tr>
        <td>${esc(o.storeName)} <span class="muted" style="font-size:11px">单程 ${o.driveMinutes} 分</span>
          <br><span class="muted" style="font-size:11px">${titleWithSize(b.title, b.size)}</span>
          ${badge ? `<br>${badge}` : ''}
        </td>
        <td class="price ${b.storeId === d.cheapestStoreId ? 'lowest' : ''}">${money(b.unitPrice, b.unitPrice < 1 ? 3 : 2)}</td>
        <td class="price muted">标价 ${money(b.pricePromo ?? b.priceRegular)}<br><span style="font-size:11px">${esc(b.unitBasis ?? '')}</span>${
          Number.isFinite(b.packQty) && b.packQty > (item.weekly || 0) * 2
            ? `<br><span class="badge warn" style="font-size:10px"><span class="dot"></span>起买 ${b.packQty} ${esc(unitZh(item.unit))}</span>`
            : ''
        }</td>
      </tr>`;
  }).join('');

  const uncomp = d.uncomparable.length ? `
    <details class="fold">
      <summary>${d.uncomparable.length} 个商品没法比价（规格解析不出来）</summary>
      <div class="card" style="margin-top:8px">
        ${d.uncomparable.map((u) => `<div class="match-row"><span>${esc(u.title)}<br><span class="muted" style="font-size:11px">${esc(storeName(u.storeId))} · 规格 ${esc(u.size ?? '无')}</span></span><span class="num">${money(u.pricePromo ?? u.priceRegular)}</span></div>`).join('')}
        <p class="muted" style="margin-bottom:0">标题里没有能识别的包装规格，所以算不出单价。可以在 <code>data/catalog.json</code> 里换个 <code>unit</code>，或者忽略这些。</p>
      </div>
    </details>` : '';

  const matches = `
    <details class="fold">
      <summary>匹配到这一项的全部商品 (${d.products.length}) —— 认错了在这里改</summary>
      <div class="card" style="margin-top:8px" id="matchBox">
        ${d.products.map((p) => `
          <div class="match-row ${p.blocked ? 'blocked' : ''}">
            <span>${titleWithSize(p.title, p.size)}<br><span class="muted" style="font-size:11px">${esc(storeName(p.store_id))} · ${p.origin === 'manual' ? '手动指定' : `自动匹配 ${(p.score ?? 0).toFixed(2)}`}</span></span>
            <span class="num">${p.unit_price != null ? perUnit(p.unit_price, p.unit) : money(p.price_promo ?? p.price_regular)}</span>
            ${DATA.canEditMatches
              ? `<button class="ghost" data-block="${p.product_id}" data-on="${p.blocked ? 1 : 0}">${p.blocked ? '恢复' : '这个不算'}</button>`
              : `<span class="muted" style="font-size:11px">只读</span>`}
          </div>`).join('')}
      </div>
    </details>`;

  $('#drawerBody').innerHTML = `
    ${head}
    <h3 style="margin-top:16px">各店对比</h3>
    <div class="tablewrap">
      <table>
        <thead><tr><th>门店</th><th class="price">每${esc(unitZh(item.unit))}</th><th class="price">原始标价</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${uncomp}
    <h3 style="margin-top:20px">价格走势</h3>
    <div id="chartBox"><p class="muted">加载中…</p></div>
    ${matches}`;

  for (const b of $('#drawerBody').querySelectorAll('button[data-block]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await DATA.setMatch(Number(b.dataset.block), itemId, b.dataset.on !== '1');
        openItem(itemId);
      } catch (e) {
        alert(e.message);
        b.disabled = false;
      }
    });
  }

  drawChart(itemId, priced, item);
}

function closeDrawer() { $('#drawer').hidden = true; }

/* ---------- 价格走势折线图 ---------- */
async function drawChart(itemId, priced, item) {
  const box = $('#chartBox');
  if (priced.length === 0) { box.innerHTML = '<p class="muted">没有价格数据。</p>'; return; }

  const series = [];
  for (const o of priced) {
    try {
      const h = await DATA.history(o.best.productId, 120);
      const points = h.points.filter((p) => Number.isFinite(p.unit_price)).map((p) => ({ day: p.day, v: p.unit_price }));
      if (points.length >= 2) {
        series.push({ name: storeName(o.storeId), storeId: o.storeId, points, color: STORE_COLOR[storeIndex(o.storeId) % STORE_COLOR.length] });
      }
    } catch { /* 某家店没历史就跳过 */ }
  }

  if (series.length === 0) {
    box.innerHTML = '<p class="muted">历史数据不够画趋势（至少要两天）。跑 <code>npm run seed-history</code> 可以造样本历史。</p>';
    return;
  }

  box.innerHTML = lineChart(series, item);
  bindChartHover(box, series, item);
}

// mr 要留够中文店名的宽度，否则末端直接标注会被裁掉
const CHART = { w: 620, h: 200, ml: 46, mr: 112, mt: 12, mb: 24 };
const LABEL_MAX = 7;

function lineChart(series, item) {
  const { w, h, ml, mr, mt, mb } = CHART;
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort();
  const xOf = (day) => ml + (days.indexOf(day) / Math.max(1, days.length - 1)) * (w - ml - mr);

  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padY = (hi - lo) * 0.12 || hi * 0.1 || 1;
  lo = Math.max(0, lo - padY); hi = hi + padY;
  const yOf = (v) => mt + (1 - (v - lo) / (hi - lo)) * (h - mt - mb);

  const ticks = 4;
  const gridY = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);

  const paths = series.map((s) => {
    const d = s.points
      .slice()
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.day).toFixed(1)},${yOf(p.v).toFixed(1)}`)
      .join(' ');
    return `<path class="series-line" d="${d}" stroke="${s.color}"></path>`;
  }).join('');

  // 直接标注每条线的末端 —— 身份不靠颜色单独承载（浅色模式下部分店色对比度偏低）。
  // 几家店价格接近时标签会叠在一起，所以按 y 排序后强制拉开最小间距。
  const LABEL_GAP = 11;
  const ends = series.map((s) => {
    const last = s.points.reduce((a, b) => (b.day > a.day ? b : a));
    return { name: s.name, color: s.color, x: xOf(last.day) + 7, y: yOf(last.v) };
  }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < LABEL_GAP) ends[i].y = ends[i - 1].y + LABEL_GAP;
  }
  // 整体上推，避免被挤出画布底部
  const overflow = ends.length ? ends[ends.length - 1].y - (h - mb) : 0;
  if (overflow > 0) for (const e of ends) e.y -= overflow;

  const endLabels = ends.map((e) => {
    const short = e.name.length > LABEL_MAX ? `${e.name.slice(0, LABEL_MAX)}…` : e.name;
    return `<text class="end-label" x="${e.x.toFixed(1)}" y="${(e.y + 3.5).toFixed(1)}" fill="${e.color}">${esc(short)}</text>`;
  }).join('');

  const xLabels = [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((day) => `<text x="${xOf(day).toFixed(1)}" y="${h - 6}" text-anchor="middle">${day.slice(5)}</text>`)
    .join('');

  const legend = `<div class="legend">${series.map((s) =>
    `<span class="key"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`
  ).join('')}</div>`;

  return `
    ${legend}
    <svg class="chart" viewBox="0 0 ${w} ${h}" role="img"
         aria-label="各店每${esc(unitZh(item.unit))}价格走势">
      ${gridY.map((v) => `<line class="grid-line" x1="${ml}" x2="${w - mr}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}"></line>
        <text x="${ml - 6}" y="${(yOf(v) + 3.5).toFixed(1)}" text-anchor="end">${money(v, v < 1 ? 2 : 1)}</text>`).join('')}
      <line class="axis-line" x1="${ml}" x2="${w - mr}" y1="${(h - mb).toFixed(1)}" y2="${(h - mb).toFixed(1)}"></line>
      ${paths}
      ${endLabels}
      ${xLabels}
      <line class="crosshair" x1="0" x2="0" y1="${mt}" y2="${h - mb}" style="display:none"></line>
      <g class="hover-dots"></g>
      <rect x="${ml}" y="${mt}" width="${w - ml - mr}" height="${h - mt - mb}" fill="transparent" class="hit"></rect>
    </svg>
    <p class="muted" style="font-size:12px;margin:4px 0 0">
      每${esc(unitZh(item.unit))}的价格，过去 ${days.length} 天。促销价会体现在这条线上。
    </p>`;
}

function bindChartHover(box, series, item) {
  const svg = box.querySelector('svg.chart');
  if (!svg) return;
  const { w, h, ml, mr, mt, mb } = CHART;
  const days = [...new Set(series.flatMap((s) => s.points.map((p) => p.day)))].sort();
  const cross = svg.querySelector('.crosshair');
  const dots = svg.querySelector('.hover-dots');

  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const padY = (hi - lo) * 0.12 || hi * 0.1 || 1;
  lo = Math.max(0, lo - padY); hi = hi + padY;
  const yOf = (v) => mt + (1 - (v - lo) / (hi - lo)) * (h - mt - mb);
  const xOf = (day) => ml + (days.indexOf(day) / Math.max(1, days.length - 1)) * (w - ml - mr);

  let tip = null;
  const hide = () => {
    cross.style.display = 'none';
    dots.innerHTML = '';
    if (tip) { tip.remove(); tip = null; }
  };

  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * w;
    if (sx < ml || sx > w - mr) return hide();

    const frac = (sx - ml) / (w - ml - mr);
    const day = days[Math.max(0, Math.min(days.length - 1, Math.round(frac * (days.length - 1))))];
    const x = xOf(day);

    cross.setAttribute('x1', x.toFixed(1));
    cross.setAttribute('x2', x.toFixed(1));
    cross.style.display = '';

    const hits = [];
    dots.innerHTML = series.map((s) => {
      const p = s.points.find((q) => q.day === day);
      if (!p) return '';
      hits.push({ name: s.name, color: s.color, v: p.v });
      return `<circle class="hover-dot" cx="${x.toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="4.5" fill="${s.color}"></circle>`;
    }).join('');

    if (hits.length === 0) return;
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
    tip.innerHTML = `<div class="tt-day">${day}</div>` + hits
      .sort((a, b) => a.v - b.v)
      .map((x2) => `<div class="tt-row"><span class="k"><span class="swatch" style="width:8px;height:8px;border-radius:2px;background:${x2.color};display:inline-block"></span>${esc(x2.name)}</span><span>${perUnit(x2.v, item.unit)}</span></div>`)
      .join('');
    tip.style.left = `${Math.min(window.innerWidth - 170, e.clientX + 14)}px`;
    tip.style.top = `${Math.max(8, e.clientY - 20)}px`;
  });

  svg.addEventListener('mouseleave', hide);
}
