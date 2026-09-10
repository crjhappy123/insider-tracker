import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US', timezoneId:'America/Los_Angeles'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();

const reqs=[];
page.on('request', r => { const u=r.url();
  if(/api|search|product|graphql/i.test(u) && !/\.(js|css|png|jpg|svg|woff)/i.test(u))
    reqs.push({m:r.method(), u, body:(r.postData()||'').slice(0,320), hdr:r.headers()}); });

await page.goto('https://www.99ranch.com/search?keyword=tofu',{waitUntil:'domcontentloaded'}).catch(()=>{});
await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(2000);

console.log('=== 99 Ranch 相关请求 ===');
for(const r of reqs.slice(0,12)){
  console.log(`  ${r.m} ${r.u.slice(0,130)}`);
  if(r.body) console.log(`      body: ${r.body}`);
}
// 门店相关的头
const h = reqs.find(r=>/product|search/i.test(r.u))?.hdr || {};
console.log('\n=== 请求头里跟门店/租户有关的 ===');
for(const [k,v] of Object.entries(h)) if(/store|tenant|shop|region|zip|lang|x-/i.test(k)) console.log('  ', k, '=', String(v).slice(0,70));
await b.close();
