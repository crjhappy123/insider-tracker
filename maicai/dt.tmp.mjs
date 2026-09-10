import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US', timezoneId:'America/Los_Angeles'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();
const api=[];
page.on('request', r=>{ const u=r.url();
  if(/api|graphql|search|product/i.test(u) && !/\.(js|css|png|jpe?g|svg|woff|gif|ico)/i.test(u) && !/google|doubleclick|hubspot|analytics|facebook|stripe/i.test(u))
    api.push({m:r.method(), u, body:(r.postData()||'').slice(0,200)}); });

console.log('=== T&T ===');
const r1 = await page.goto('https://www.tntsupermarket.com/en/search?q=tofu',{waitUntil:'domcontentloaded'}).catch(e=>({status:()=>'ERR '+e.message.slice(0,50)}));
console.log('  HTTP', r1.status?.() ?? '?');
await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(3000);
const txt = await page.evaluate(()=>document.body.innerText.slice(0,400)).catch(()=>'');
console.log('  正文:', txt.replace(/\s+/g,' ').slice(0,200));
console.log('  可见价格:', (txt.match(/\$\d+\.\d{2}/g)||[]).slice(0,6).join(' ')||'无');
console.log('  相关请求:');
for(const x of api.slice(0,10)) console.log('    '+x.m+' '+x.u.slice(0,120)+(x.body?'\n         body: '+x.body:''));
await b.close();
