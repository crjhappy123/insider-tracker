import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const b = await chromium.launch();
const ctx = await b.newContext({userAgent:UA, locale:'en-US', timezoneId:'America/Los_Angeles', viewport:{width:1440,height:900}});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();

// ---------- 99 Ranch: 它的商品 JSON 到底长什么样 ----------
const blobs=[];
page.on('response', async r => {
  try { const ct=r.headers()['content-type']||''; if(!r.ok()||!ct.includes('json'))return;
    blobs.push({url:r.url(), json: await r.json()}); } catch {}
});
await page.goto('https://www.99ranch.com/search?keyword=tofu',{waitUntil:'domcontentloaded'}).catch(e=>console.log('goto err',e.message));
await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
await page.waitForTimeout(2500);
console.log('=== 99 Ranch 捕获到的 JSON 接口 ===');
for (const b2 of blobs) console.log('  ', b2.url.slice(0,110));

// 找出像商品数组的结构，打印一个样本的全部字段
function findProducts(node, depth=0, out=[]) {
  if(!node||typeof node!=='object'||depth>10) return out;
  if(Array.isArray(node)){
    if(node.length>2 && node.every(x=>x&&typeof x==='object')){
      const k=Object.keys(node[0]);
      if(k.some(x=>/price/i.test(x)) && k.some(x=>/name|title/i.test(x))) out.push(node);
    }
    for(const n of node) findProducts(n,depth+1,out);
    return out;
  }
  for(const v of Object.values(node)) findProducts(v,depth+1,out);
  return out;
}
for (const b2 of blobs) {
  const arrs = findProducts(b2.json);
  if(!arrs.length) continue;
  console.log('\n=== 商品数组来自', b2.url.slice(0,90));
  const sample = arrs[0][0];
  console.log('   数组长度', arrs[0].length, '| 字段:');
  for (const [k,v] of Object.entries(sample)) {
    const t = typeof v === 'object' ? JSON.stringify(v).slice(0,70) : String(v).slice(0,60);
    console.log('     ', k.padEnd(24), t);
  }
  break;
}
await b.close();
