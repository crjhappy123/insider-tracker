import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();
let cap=null;
page.on('request', r => { if(r.url().includes('/be-api/search/web/products')) cap = {hdr:r.headers(), body:r.postData()}; });
await page.goto('https://www.99ranch.com/search?keyword=tofu',{waitUntil:'domcontentloaded'}).catch(()=>{});
await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(2000);
if(!cap){ console.log('没捕获到请求'); process.exit(0); }
console.log('=== 完整请求头 ===');
for(const [k,v] of Object.entries(cap.hdr)) console.log('  '+k+': '+String(v).slice(0,110));
console.log('=== body ===\n  '+cap.body);
console.log('=== cookies ===');
for(const c of await ctx.cookies()) console.log('  '+c.name+' = '+String(c.value).slice(0,60));
await b.close();
