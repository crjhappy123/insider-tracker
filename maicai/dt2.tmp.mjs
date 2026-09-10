import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US', timezoneId:'America/Los_Angeles'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();

const urls = [
  ['T&T 首页','https://www.tntsupermarket.com/en'],
  ['T&T flyer','https://www.tntsupermarket.com/en/flyer'],
  ['T&T weekly','https://www.tntsupermarket.com/en/weekly-specials'],
  ["TJ 首页",'https://www.traderjoes.com/home'],
  ["TJ 搜索",'https://www.traderjoes.com/home/search?q=tofu&global=yes'],
];
for (const [label,u] of urls) {
  let st='ERR';
  try { const r=await page.goto(u,{waitUntil:'domcontentloaded',timeout:40000}); st=r?.status(); } catch(e){ st='ERR '+e.message.slice(0,40); }
  await page.waitForTimeout(2500);
  const t = await page.evaluate(()=>document.body.innerText.slice(0,300)).catch(()=>'');
  const denied = /access denied|permission to access/i.test(t);
  const prices = (t.match(/\$\d+\.\d{2}/g)||[]).slice(0,5);
  console.log(`${label.padEnd(12)} HTTP ${String(st).padEnd(8)} ${denied?'✗ 被拒':'✓'} 价格: ${prices.join(' ')||'无'}`);
  if(!denied && st===200) console.log('    正文:', t.replace(/\s+/g,' ').slice(0,130));
}
await b.close();
