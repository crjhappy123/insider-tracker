import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();
const stores=[];
page.on('response', async r=>{ if(!/be-api/.test(r.url()))return;
  try{ const j=await r.json(); const t=JSON.stringify(j);
    if(/storeId|storeName|address/i.test(t)) stores.push({u:r.url(), j}); }catch{} });
await page.goto('https://www.99ranch.com/',{waitUntil:'domcontentloaded'}).catch(()=>{});
await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(2500);

// 直接在页面里问门店列表
const tryPaths = ['/be-api/store/web/list','/be-api/store/web/stores','/be-api/store/web/all','/be-api/store/web/nearby'];
for (const p of tryPaths) {
  const out = await page.evaluate(async (path)=>{
    try{ const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',accept:'application/json'},body:'{}',credentials:'include'});
      const j=await r.json(); return {ok:r.ok, code:j.code, n: Array.isArray(j.data)?j.data.length:(Array.isArray(j.data?.records)?j.data.records.length:null), sample: JSON.stringify(j).slice(0,220)};
    }catch(e){ return {err:e.message}; }
  }, p);
  console.log(p, '->', JSON.stringify(out).slice(0,260));
}
// 顺带看抓到的门店相关响应
for(const s of stores.slice(0,3)){
  console.log('\n捕获:', s.u.slice(0,90));
  console.log('  ', JSON.stringify(s.j).slice(0,400));
}
await b.close();
