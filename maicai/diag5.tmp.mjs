import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();
await page.goto('https://www.99ranch.com/',{waitUntil:'domcontentloaded'}).catch(()=>{});
await page.waitForTimeout(2500);

const r = await page.evaluate(async ()=>{
  const res = await fetch('/be-api/store/web/list',{method:'POST',
    headers:{'Content-Type':'application/json',accept:'application/json'},
    body: JSON.stringify({zipCode:'98155', deliveryType:3}), credentials:'include'});
  return res.json();
});
console.log('code', r.code, r.message);
const list = Array.isArray(r.data)?r.data:(r.data?.records||[]);
console.log('门店数', list.length);
for(const s of list.slice(0,8)){
  const addr=[s.address,s.city,s.state,s.zipCode].filter(Boolean).join(', ');
  console.log('  storeId', String(s.storeId??s.id).padEnd(8), (s.storeName??s.name??'').slice(0,30).padEnd(32), addr.slice(0,60));
}
// 用 Edmonds/最近那家的 storeid 测商品接口
const target = list.find(s=>/edmonds/i.test((s.city||'')+(s.storeName||s.name||''))) || list[0];
if(target){
  const sid = String(target.storeId ?? target.id);
  console.log('\n用 storeid', sid, '('+(target.storeName??target.name)+') 测商品接口:');
  const p = await page.evaluate(async ([sid])=>{
    const res = await fetch('/be-api/search/web/products',{method:'POST',
      headers:{'Content-Type':'application/json',accept:'application/json',storeid:sid},
      body: JSON.stringify({page:1,pageSize:6,keyword:'tofu',availability:1}), credentials:'include'});
    return res.json();
  },[sid]);
  const items = p.data?.records ?? p.data?.list ?? p.data ?? [];
  console.log('  code', p.code, '| 商品', Array.isArray(items)?items.length:0);
  if(Array.isArray(items)) for(const x of items.slice(0,5))
    console.log('   ', ('$'+x.salePrice+'/'+x.retailPrice).padEnd(14), ((x.netWeight??'?')+' '+(x.netWeightUom??'')).padEnd(11), (x.productNameEN||'').slice(0,46));
}
await b.close();
