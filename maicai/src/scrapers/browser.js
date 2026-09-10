// 无头浏览器封装。
//
// 为什么必须用浏览器：实测 traderjoes.com 和 tntsupermarket.com 对 curl 直接返回 403
// （Akamai/Cloudflare 一类的机器人防护），fredmeyer.com 更是直接不给建连接。
// 这类防护看的是 TLS 指纹、JS 挑战、cookie，不是 User-Agent，换 header 没用，
// 只能用真实浏览器内核跑一遍。
//
// playwright 是 optionalDependency，没装的话这里给出明确的安装提示而不是报一堆栈。

let _pw = null;

async function pw() {
  if (_pw) return _pw;
  try {
    _pw = await import('playwright');
  } catch {
    throw new Error(
      '需要无头浏览器但 playwright 没装。跑这两条：\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      '（只想先看效果的话，用 `npm run ingest:sample` 跑离线样本数据，不需要浏览器）'
    );
  }
  return _pw;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 开一个浏览器上下文跑 fn，结束自动关闭。
 * @param {(page: import('playwright').Page, ctx: any) => Promise<T>} fn
 * @template T
 */
export async function withPage(fn, { headless = true, timeout = 45_000 } = {}) {
  const { chromium } = await pw();
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    // 去掉最明显的自动化痕迹
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // 图片/字体不下载，快很多
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      return route.continue();
    });
    return await fn(page, context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 在已加载页面的上下文里发请求 —— 带着页面的 cookie 和真实指纹，
 * 这样 GraphQL / 内部 API 才不会被防护拦掉。
 */
export async function fetchInPage(page, url, init = {}) {
  return page.evaluate(
    async ([u, i]) => {
      const res = await fetch(u, {
        ...i,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(i.headers || {}) },
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON 就算了 */ }
      return { ok: res.ok, status: res.status, json, text: json ? null : text.slice(0, 2000) };
    },
    [url, init]
  );
}
