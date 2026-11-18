// Presentation layer shared by every page: the app shell (top bar + a sidebar with
// the three sections — 美股 Insider, A股 Insider, 博主汇总), theme CSS, client-side
// enhancements, and the market-agnostic pieces of the AI leaderboard. Anything
// currency- or language-specific stays in the per-page module (`_query.js` for US,
// `_cn.js` for A-shares, `_yt.js` for the YouTuber pages), which passes in a `fmt`
// (formatters) and `L` (labels) object where needed.
//
// Files prefixed with "_" are not routed by Cloudflare Pages.

// Applied inline in <head> so the persisted theme lands before first paint.
export const THEME_BOOT =
  `<script>try{var t=localStorage.getItem('theme');` +
  `if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>`;

// Client-side enhancements (no framework): market clock, theme toggle, click-to-copy
// tickers, clickable column sorting, AI-detail disclosure rows, and zebra striping
// that survives sorting.
export const PAGE_SCRIPT = `<script>
(function(){
  // Market clock in the top bar: the page's market date and session. Weekends show
  // 休市; exchange holidays aren't known here, so they read as a normal weekday.
  var clk=document.getElementById('mclock');
  function tick(){
    if(!clk)return;
    var cn=clk.getAttribute('data-market')==='cn', p={};
    try{
      new Intl.DateTimeFormat('en-US',{timeZone:cn?'Asia/Shanghai':'America/New_York',
        weekday:'short',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'})
        .formatToParts(new Date()).forEach(function(x){p[x.type]=x.value;});
    }catch(e){return;}
    var m=(+p.hour%24)*60+(+p.minute), st, open=false;
    if(p.weekday==='Sat'||p.weekday==='Sun')st='休市';
    else if(cn){
      if(m>=555&&m<570)st='集合竞价';
      else if((m>=570&&m<690)||(m>=780&&m<900)){st='交易中';open=true;}
      else if(m>=690&&m<780)st='午间休市';
      else st='已收盘';
    }else{
      if(m>=240&&m<570)st='盘前';
      else if(m>=570&&m<960){st='交易中';open=true;}
      else if(m>=960&&m<1200)st='盘后';
      else st='已收盘';
    }
    clk.lastElementChild.textContent=(cn?'北京 ':'美东 ')+p.month+'/'+p.day+' · '+st;
    clk.classList.toggle('open',open);
  }
  tick(); setInterval(tick,30000);

  // Theme toggle (persisted; initial theme applied by the inline <head> script).
  var btn=document.getElementById('themeBtn');
  if(btn)btn.addEventListener('click',function(){
    var el=document.documentElement, cur=el.getAttribute('data-theme');
    if(!cur)cur=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
    var next=cur==='dark'?'light':'dark';
    el.setAttribute('data-theme',next);
    try{localStorage.setItem('theme',next);}catch(e){}
  });

  // Click a ticker to copy it. Delegated from the document (not the table) so the
  // same handler covers all three places a ticker renders: the table, the AI
  // report picks, and the leaderboard rows.
  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text);
    // Fallback for non-secure contexts / older browsers.
    return new Promise(function(resolve,reject){
      var ta=document.createElement('textarea');
      ta.value=text; ta.setAttribute('readonly','');
      ta.style.cssText='position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
      document.body.removeChild(ta);
      ok?resolve():reject();
    });
  }
  document.addEventListener('click',function(e){
    var el=e.target.closest('.ticker'); if(!el)return;
    // Drop any leftover ✓ BEFORE reading the text, or a rapid second click would
    // copy "600801✓".
    var old=el.querySelector('.copied'); if(old)old.remove();
    var text=(el.getAttribute('data-copy')||el.textContent||'').trim();
    if(!text||text==='\\u2014')return; // the "—" placeholder isn't a ticker
    copyText(text).then(function(){
      var tick=document.createElement('span');
      tick.className='copied'; tick.textContent='✓';
      el.appendChild(tick);
      // Re-read the node on cleanup: sorting can move the row in between.
      setTimeout(function(){ if(tick.parentNode)tick.remove(); },1200);
    }).catch(function(){});
  });

  var tbody=document.querySelector('table tbody');
  if(!tbody)return;

  // Pair each main row with its (optional) detail row so they move together.
  Array.prototype.forEach.call(tbody.querySelectorAll('tr.detail'),function(d){
    var prev=d.previousElementSibling; if(prev)prev._detail=d;
  });

  function mainRows(){
    return Array.prototype.filter.call(tbody.children,function(r){
      return !r.classList.contains('detail') && !r.querySelector('.empty');
    });
  }
  function stripe(){ mainRows().forEach(function(r,i){ r.classList.toggle('alt', i%2===1); }); }

  // Click an AI pill to expand/collapse its detail row.
  tbody.addEventListener('click',function(e){
    var pill=e.target.closest('.ai[data-detail]'); if(!pill)return;
    var d=pill.closest('tr')._detail;
    if(d){ d.hidden=!d.hidden; pill.classList.toggle('open',!d.hidden); }
  });

  // Sortable headers.
  var ths=[].slice.call(document.querySelectorAll('thead th[data-type]'));
  function val(tr,idx,type){
    var td=tr.children[idx]; if(!td)return type==='num'?-Infinity:'';
    if(type==='num'){
      var dv=td.getAttribute('data-v');
      var n=dv!==null?parseFloat(dv):parseFloat((td.textContent||'').replace(/[^0-9.\\-]/g,''));
      return isNaN(n)?-Infinity:n;
    }
    return (td.textContent||'').trim().toLowerCase();
  }
  ths.forEach(function(th){
    th.addEventListener('click',function(){
      var idx=[].indexOf.call(th.parentNode.children,th), type=th.dataset.type;
      var asc=th.dataset.dir!=='asc';
      ths.forEach(function(o){ if(o!==th)o.removeAttribute('data-dir'); });
      th.dataset.dir=asc?'asc':'desc';
      mainRows().sort(function(a,b){
        var x=val(a,idx,type),y=val(b,idx,type);
        return (x<y?-1:x>y?1:0)*(asc?1:-1);
      }).forEach(function(r){ tbody.appendChild(r); if(r._detail)tbody.appendChild(r._detail); });
      stripe();
    });
  });
  stripe();
})();
</script>`;

// Theme tokens. Light is the default (it follows the OS), dark via the OS or the
// toggle; both palettes are declared once and applied in all four places.
const LIGHT = `color-scheme:light;
  --plane:#f5f6fa; --surface:#fff; --side:#fafbfd; --glass:rgba(15,23,42,.03);
  --hover:rgba(15,23,42,.045); --thead:#f1f3f8;
  --ink:#1c1f26; --ink2:#4a4f5a; --muted:#8b909b;
  --border:#e5e7ee; --zebra:rgba(15,23,42,.022);
  --buy:#16a34a; --sell:#dc2626; --accent:#3b6cf6; --accent-soft:rgba(59,108,246,.1);
  --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.03);`;
const DARK = `color-scheme:dark;
  --plane:#0e1014; --surface:#161920; --side:#12151b; --glass:rgba(255,255,255,.035);
  --hover:rgba(255,255,255,.05); --thead:#1c2029;
  --ink:#eceef3; --ink2:#b4b9c4; --muted:#7d8390;
  --border:rgba(255,255,255,.08); --zebra:rgba(255,255,255,.022);
  --buy:#22c55e; --sell:#ef4444; --accent:#5b8cff; --accent-soft:rgba(91,140,255,.15);
  --shadow:none;`;

// The full stylesheet, shared by every page so they read as one site. Market-cap
// *tier thresholds* differ per market (see each module's mcapTier), but the tier
// class names — and therefore these styles — are the same.
export const PAGE_CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root{${DARK}}}
/* explicit theme override (toggle button); beats the media query by specificity */
html[data-theme="light"]{${LIGHT}}
html[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;line-height:1.45;color:var(--ink);background:var(--plane);
  font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
/* ---- app shell: top bar + sidebar ---- */
.topbar{position:sticky;top:0;z-index:30;height:60px;display:flex;align-items:center;gap:1rem;
  padding:0 clamp(.9rem,2vw,1.5rem);background:var(--surface);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:.6rem;font-size:1.2rem;font-weight:800;letter-spacing:-.01em;
  color:var(--ink);text-decoration:none;white-space:nowrap}
.brand-mark{width:32px;height:32px;flex:none;border-radius:10px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(135deg,var(--accent),#8b5cf6)}
.top-right{margin-left:auto;display:flex;align-items:center;gap:.75rem}
.mclock{display:flex;align-items:center;gap:.45rem;font-size:.8rem;color:var(--muted);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.mclock i{width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.6}
.mclock.open i{background:var(--buy);opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--buy) 22%,transparent)}
.theme-btn{width:36px;height:36px;flex:none;display:grid;place-items:center;padding:0;border-radius:50%;
  background:var(--plane);color:var(--ink2);border:1px solid var(--border);cursor:pointer}
.theme-btn:hover{color:var(--accent);border-color:var(--accent);filter:none}
.layout{display:grid;grid-template-columns:212px minmax(0,1fr);min-height:calc(100vh - 60px)}
.side{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow-y:auto;
  padding:1rem .75rem;background:var(--side);border-right:1px solid var(--border)}
.nav-item{display:flex;align-items:center;gap:.7rem;padding:.62rem .85rem;margin-bottom:.2rem;border-radius:10px;
  font-size:.92rem;font-weight:500;color:var(--ink2);text-decoration:none;white-space:nowrap}
.nav-item svg{flex:none}
.nav-item:hover{background:var(--hover);color:var(--ink)}
.nav-item.on{background:var(--accent-soft);color:var(--accent);font-weight:700}
.nav-sub{display:flex;flex-direction:column;gap:.1rem;margin:.1rem 0 .5rem 1.45rem;padding-left:.6rem;
  border-left:1px solid var(--border)}
.nav-sub a{padding:.42rem .7rem;border-radius:8px;font-size:.85rem;color:var(--muted);text-decoration:none}
.nav-sub a:hover{color:var(--ink);background:var(--hover)}
.nav-sub a.on{color:var(--accent);font-weight:600;background:var(--accent-soft)}
.subnav{display:none}
.main{min-width:0;padding:1.25rem clamp(.9rem,2.4vw,1.75rem) 3rem}
.main>*{max-width:1320px}
.page-head{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin:.1rem 0 1.1rem}
.page-head h1{margin:0;font-size:1.45rem;font-weight:800;letter-spacing:-.01em}
.page-head .tag{color:var(--muted);font-size:.82rem}
@media (max-width:860px){
  .layout{grid-template-columns:1fr}
  .side{top:60px;z-index:25;height:auto;display:flex;gap:.3rem;overflow-x:auto;padding:.45rem .7rem;
    border-right:none;border-bottom:1px solid var(--border);background:var(--surface)}
  .nav-item{margin:0;padding:.45rem .8rem;font-size:.86rem}
  .nav-sub{display:none}
  .subnav{display:flex;gap:.3rem;width:fit-content;max-width:100%;overflow-x:auto;margin-bottom:1rem;
    padding:.25rem;background:var(--surface);border:1px solid var(--border);border-radius:12px}
  .subnav a{padding:.38rem .8rem;border-radius:9px;font-size:.84rem;color:var(--ink2);text-decoration:none;white-space:nowrap}
  .subnav a.on{background:var(--accent);color:#fff;font-weight:600}
}
@media (max-width:520px){
  .topbar{gap:.5rem}
  .brand{font-size:1.05rem}
  .mclock{font-size:.72rem}
  .side{scrollbar-width:none;justify-content:space-between}
  .nav-item svg{display:none}
}
/* ---- components ---- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
.tag{color:var(--muted);font-size:.82rem}
/* KPI tiles */
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.9rem;margin-bottom:1.1rem}
.kpi .tile{padding:1rem 1.15rem;background:var(--surface);border:1px solid var(--border);border-radius:14px;
  box-shadow:var(--shadow)}
.tile-label{font-size:.72rem;letter-spacing:.04em;color:var(--muted);margin-bottom:.4rem;font-weight:600}
.tile-value{font-size:1.65rem;font-weight:800;letter-spacing:-.02em;line-height:1}
.tile-sub{font-size:.74rem;color:var(--ink2);margin-top:.45rem}
/* filters */
form.filters{display:flex;flex-wrap:wrap;gap:.7rem;align-items:end;padding:1rem 1.15rem;margin-bottom:1.1rem}
.filters label{display:flex;flex-direction:column;font-size:.72rem;font-weight:600;color:var(--muted);gap:.35rem}
input,select{padding:.5rem .7rem;font-size:.9rem;color:var(--ink);background:var(--surface);
  border:1px solid var(--border);border-radius:10px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
button{padding:.55rem 1.1rem;font-size:.9rem;font-weight:600;cursor:pointer;color:#fff;
  background:var(--accent);border:none;border-radius:10px;font-family:inherit}
button:hover{filter:brightness(1.08)}
.reset{align-self:center;font-size:.8rem;color:var(--muted);text-decoration:none}
.reset:hover{color:var(--ink)}
/* table */
.tablecard{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.84rem}
th,td{padding:.6rem .7rem;text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)}
thead th{position:sticky;top:0;background:var(--thead);z-index:1;color:var(--ink2);
  font-size:.8rem;font-weight:700}
thead th[data-type]{cursor:pointer;user-select:none}
thead th[data-type]:hover{color:var(--ink)}
thead th[data-type]::after{content:"⇅";margin-left:.3rem;opacity:.45;font-size:.72rem}
thead th[data-dir=asc]::after{content:"▲";opacity:.9}
thead th[data-dir=desc]::after{content:"▼";opacity:.9}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--hover)}
/* zebra striping (JS-tagged so it survives sorting & detail rows) */
tbody tr.alt td{background-image:linear-gradient(var(--zebra),var(--zebra))}
td.n{text-align:right;font-variant-numeric:tabular-nums}
td.dim{color:var(--muted)}
td.co{max-width:200px;overflow:hidden;text-overflow:ellipsis}
/* With the sidebar, a 1280px laptop has ~1000px for the 9-column insider tables:
   share count is the column that can go. */
@media (max-width:1360px){th.qty,td.qty{display:none}}
td.val{font-weight:600}
td.tk{line-height:1.2}
/* Tickers are click-to-copy. width:fit-content so the hover underline hugs the
   text instead of spanning the whole cell. */
.ticker{display:block;width:fit-content;font-weight:700;letter-spacing:.02em;
  color:var(--accent);cursor:pointer}
.ticker:hover{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
/* The "copied" ✓: zero width + visible overflow, so it draws beside the ticker
   without widening the column — a 1-char reflow mid-click reads as a jump. */
.copied{display:inline-block;width:0;overflow:visible;position:relative;left:.28rem;
  white-space:nowrap;color:var(--buy);font-weight:700;animation:copied-in .12s ease-out}
@keyframes copied-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
.mcap{display:block;font-size:.68rem;color:var(--muted);font-variant-numeric:tabular-nums}
.code{color:var(--muted);font-size:.72rem}
tbody tr.buy td:first-child{box-shadow:inset 3px 0 0 var(--buy)}
.empty{text-align:center;padding:2.5rem;color:var(--muted)}
.count{font-size:.78rem;color:var(--muted);margin:.2rem 0 .6rem}
.report{padding:1.1rem 1.25rem;margin-bottom:1.1rem;border-left:3px solid var(--accent)}
.report-head{font-size:.95rem;font-weight:700;margin-bottom:.5rem}
.report-body{font-size:.9rem;line-height:1.5;color:var(--ink2);white-space:pre-wrap;margin-bottom:.4rem}
.report-foot{font-size:.68rem;color:var(--muted);margin-top:.6rem}
.picks{display:grid;gap:.55rem;margin-top:.4rem}
.pick{padding:.6rem .75rem;border:1px solid var(--border);border-radius:10px;background:var(--glass)}
.pick-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem}
.pick-co{font-size:.82rem;color:var(--ink2)}
.pick-rating{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.pick-comment{font-size:.85rem;line-height:1.5;color:var(--ink);white-space:pre-wrap}
.ai{display:inline-flex;align-items:center;gap:.35rem;padding:.12rem .45rem;border-radius:6px;
  font-weight:700;font-size:.72rem;cursor:help;vertical-align:middle}
.ai .ai-n{min-width:1.3rem;text-align:center;font-variant-numeric:tabular-nums}
.ai .ai-bar{width:2.1rem;height:.32rem;border-radius:3px;background:color-mix(in srgb,currentColor 22%,transparent);overflow:hidden}
.ai .ai-bar>span{display:block;height:100%;background:currentColor;border-radius:3px}
.ai.hi{color:var(--buy);background:color-mix(in srgb,var(--buy) 18%,transparent)}
.ai.mid{color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent)}
.ai.lo{color:var(--muted);background:var(--glass)}
/* clickable AI pill that expands a detail row (mobile-friendly, no hover needed) */
.ai[data-detail]{cursor:pointer}
.ai[data-detail]::after{content:"›";opacity:.55;transition:transform .15s;display:inline-block}
.ai[data-detail].open::after{transform:rotate(90deg)}
tr.detail>td{white-space:normal;background:var(--surface);color:var(--ink2);
  font-size:.8rem;line-height:1.5;padding:.55rem .95rem}
tr.detail .r{color:var(--ink);font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  font-size:.68rem;margin-right:.5rem}
/* AI leaderboard (pure-CSS tabs) */
.lb{padding:1.1rem 1.25rem;margin-bottom:1.1rem;overflow-x:auto}
.lb>input{position:absolute;opacity:0;pointer-events:none}
.lb-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;font-size:.95rem;font-weight:700;margin-bottom:.7rem;flex-wrap:wrap}
.lb-tabs{display:flex;gap:.3rem}
.lb-tab{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);
  padding:.3rem .7rem;border:1px solid var(--border);border-radius:8px;cursor:pointer}
.lb-tab:hover{color:var(--ink)}
#lb-d:checked~.lb-head .lb-tab-d,#lb-w:checked~.lb-head .lb-tab-w,
#lb-q:checked~.lb-head .lb-tab-q,#lb-y:checked~.lb-head .lb-tab-y{
  color:#fff;background:var(--accent);border-color:transparent}
.lb-panel{display:none;flex-direction:column;gap:.2rem;min-width:34rem}
#lb-d:checked~.lb-panel-d,#lb-w:checked~.lb-panel-w,
#lb-q:checked~.lb-panel-q,#lb-y:checked~.lb-panel-y{display:flex}
.lb-row{display:grid;
  grid-template-columns:1.4rem minmax(6rem,1fr) auto 5.5rem 4.5rem 4rem 4.75rem;
  align-items:center;gap:.6rem;padding:.4rem .5rem;border-radius:8px}
.lb-row:hover{background:var(--glass)}
.lb-colhead{color:var(--muted);font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;
  padding-bottom:.15rem;border-bottom:1px solid var(--border);border-radius:0}
.lb-colhead:hover{background:none}
.lb-rank{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.8rem;text-align:right}
.lb-tk{display:flex;flex-direction:column;line-height:1.15;overflow:hidden}
.lb-co{color:var(--ink2);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb-entry{display:flex;flex-direction:column;line-height:1.15;text-align:right}
.lb-px{font-size:.8rem;font-variant-numeric:tabular-nums;text-align:right}
.lb-date{font-size:.64rem;color:var(--muted)}
.lb-gain{font-size:.8rem;font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.lb-gain.up{color:var(--buy)}
.lb-gain.down{color:var(--sell)}
.lb-gain.dim{color:var(--muted);font-weight:400}
.lb-val{font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* Market-cap tiers: whole-row background tint so big caps jump out. */
:root{--mc-mega:#e0a92e;--mc-large:var(--accent);--mc-mid:#2bb3a3;--mc-small:#8a8a8a;--mc-micro:var(--border)}
tbody tr.mc-mega  td{background:color-mix(in srgb,var(--mc-mega) 26%,transparent)}
tbody tr.mc-large td{background:color-mix(in srgb,var(--mc-large) 18%,transparent)}
tbody tr.mc-mid   td{background:color-mix(in srgb,var(--mc-mid) 10%,transparent)}
tbody tr.mc-micro,tbody tr.mc-unknown{opacity:.5}
tbody tr.mc-mega  td:first-child{box-shadow:inset 3px 0 0 var(--mc-mega)}
tbody tr.mc-large td:first-child{box-shadow:inset 3px 0 0 var(--mc-large)}
tbody tr.mc-mid   td:first-child{box-shadow:inset 3px 0 0 var(--mc-mid)}
tbody tr.mc-small td:first-child{box-shadow:inset 3px 0 0 var(--mc-small)}
tbody tr.mc-micro td:first-child,tbody tr.mc-unknown td:first-child{box-shadow:inset 3px 0 0 var(--mc-micro)}
tbody tr.mc-mega  .mcap{color:var(--mc-mega);font-weight:700}
tbody tr.mc-large .mcap{color:var(--mc-large);font-weight:600}
tbody tr.mc-mid   .mcap{color:var(--mc-mid)}
.legend{display:flex;gap:.9rem;flex-wrap:wrap;font-size:.68rem;color:var(--muted);margin:.2rem 0 .6rem}
.legend .k{display:inline-flex;align-items:center;gap:.3rem}
.legend .sw{width:.7rem;height:.7rem;border-radius:2px;display:inline-block}
.disclaimer{margin-top:1.4rem;padding:1.1rem 1.25rem;font-size:.72rem;line-height:1.6;color:var(--muted)}
.disclaimer b{color:var(--ink2);display:block;text-transform:uppercase;letter-spacing:.08em;font-size:.68rem;margin-bottom:.4rem}
.disclaimer p{margin:0 0 .5rem}
.disclaimer p:last-child{margin:0}
`;

// Stroke icons (Feather-style), drawn in currentColor.
const ICONS = {
  us: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  cn: '<path d="M3 3v18h18"/><path d="M8 16v-5"/><path d="M13 16V7"/><path d="M18 16v-3"/>',
  yt:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
    '<path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};

function icon(name, size = 18, width = 1.8) {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${ICONS[name]}</svg>`
  );
}

// The site's three sections. 博主汇总 has sub-pages, listed under it in the sidebar
// (and as a segmented control on narrow screens, where the sidebar is a tab strip).
const YT_PAGES = [
  { key: "yt", href: "/yt", label: "个股观点" },
  { key: "yt-macro", href: "/yt/macro", label: "宏观报告" },
  { key: "yt-heat", href: "/yt/heatmap", label: "热力图" },
];
const NAV = [
  { key: "us", href: "/", label: "美股 Insider", icon: "us" },
  { key: "cn", href: "/cn", label: "A股 Insider", icon: "cn" },
  { key: "yt", href: "/yt", label: "博主汇总", icon: "yt", sub: YT_PAGES },
];

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="8" fill="#3b6cf6"/>' +
      '<path d="M7 21l6-6 4 4 8-8" fill="none" stroke="#fff" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  );

// A full page: top bar (brand, market clock, theme toggle), sidebar, and `body` in
// the main column. `active` is a NAV key or a YT_PAGES key; `market` picks the
// clock's exchange ("us" or "cn").
export function renderShell({ active, title, body, css = "", lang = "zh-CN", market = "us" }) {
  const group = active.split("-")[0];
  const subLinks = (cls) =>
    YT_PAGES.map(
      (p) =>
        `<a href="${p.href}"${p.key === active ? ` class="${cls}" aria-current="page"` : ""}>${p.label}</a>`
    ).join("");
  const nav = NAV.map((n) => {
    const on = n.key === group;
    const current = on && !n.sub ? ' aria-current="page"' : "";
    const sub = n.sub ? `<div class="nav-sub">${subLinks("on")}</div>` : "";
    return (
      `<a class="nav-item${on ? " on" : ""}" href="${n.href}"${current}>` +
      `${icon(n.icon)}<span>${n.label}</span></a>${sub}`
    );
  }).join("");
  const subnav = group === "yt" ? `<nav class="subnav" aria-label="博主汇总">${subLinks("on")}</nav>` : "";
  return `<!DOCTYPE html>
<html lang="${lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · RudyStock</title>
<link rel="icon" href="${FAVICON}">
${THEME_BOOT}
<style>${PAGE_CSS}${css}</style></head><body>
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark">${icon("us", 18, 2.4)}</span>RudyStock</a>
  <div class="top-right">
    <span class="mclock" id="mclock" data-market="${market === "cn" ? "cn" : "us"}"><i></i><span>${
      market === "cn" ? "北京" : "美东"
    }</span></span>
    <button class="theme-btn" id="themeBtn" type="button" aria-label="切换深浅色" title="切换深浅色">${icon("moon")}</button>
  </div>
</header>
<div class="layout">
  <nav class="side" aria-label="板块">${nav}</nav>
  <main class="main">${subnav}${body}</main>
</div>
${PAGE_SCRIPT}
</body></html>`;
}

export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

export function num(v, digits = 0) {
  if (v === null || v === undefined) return "";
  return Number(v).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Market-cap tier → CSS class, so larger companies stand out visually.
// `tiers` is a descending [threshold, class] list supplied by the market module.
export function mcapTier(v, tiers) {
  if (v === null || v === undefined) return "mc-unknown";
  const n = Number(v);
  for (const [floor, cls] of tiers) if (n >= floor) return cls;
  return "mc-micro";
}

// AI score pill: color by conviction + a mini progress bar (score/100).
// `detail` makes it a clickable disclosure (caret) for the table's expand row.
export function aiPill(score, { rating, comment, detail } = {}) {
  if (score == null || score === "") return `<span class="dim">—</span>`;
  const s = Number(score);
  const cls = s >= 70 ? "hi" : s >= 40 ? "mid" : "lo";
  const w = Math.max(0, Math.min(100, s));
  const title = esc(`${rating || ""}${rating ? ": " : ""}${comment || ""}`);
  return `<span class="ai ${cls}"${detail ? " data-detail" : ""} title="${title}">` +
    `<span class="ai-n">${s}</span>` +
    `<span class="ai-bar"><span style="width:${w}%"></span></span></span>`;
}

// Table AI cell: pill + click-to-expand detail (rendered as a sibling row).
export function aiCell(r) {
  return aiPill(r.ai_score, {
    rating: r.ai_rating,
    comment: r.ai_comment,
    detail: r.ai_score != null && !!r.ai_comment,
  });
}

export function tile(label, value, accentVar, sub) {
  return `<div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value" style="color:var(${accentVar})">${value}</div>
    ${sub ? `<div class="tile-sub">${sub}</div>` : ""}
  </div>`;
}

// Signed percent gain, colored (green up / red down). "—" when unknown.
export function gainCell(g) {
  if (g == null || !isFinite(g)) return `<span class="lb-gain dim">—</span>`;
  const cls = g >= 0 ? "up" : "down";
  const sign = g >= 0 ? "+" : "";
  return `<span class="lb-gain ${cls}">${sign}${g.toFixed(1)}%</span>`;
}

// AI leaderboards over four windows, as a pure-CSS tabbed card. `fmt` supplies
// the market's currency formatters ({money, px}); `L` supplies its labels.
const BOARD_TABS = [
  ["daily", "d"],
  ["weekly", "w"],
  ["quarterly", "q"],
  ["yearly", "y"],
];

export function renderBoards(boards, fmt, L) {
  if (!boards || !BOARD_TABS.some(([k]) => boards[k] && boards[k].length)) return "";
  const header = `<div class="lb-row lb-colhead">
    <span class="lb-rank">#</span><span class="lb-tk">${esc(L.colTicker)}</span>
    <span>AI</span><span class="lb-entry">${esc(L.colEntry)}</span>
    <span class="lb-px">${esc(L.colNow)}</span><span class="lb-gain">${esc(L.colGain)}</span>
    <span class="lb-val">${esc(L.colBought)}</span></div>`;
  const row = (r, i) => `<div class="lb-row">
    <span class="lb-rank">${i + 1}</span>
    <span class="lb-tk"><span class="ticker">${esc(r.ticker || "—")}</span>
      <span class="lb-co">${esc(r.company_name || "")}</span></span>
    ${aiPill(r.score, { rating: r.rating, comment: r.comment })}
    <span class="lb-entry"><span class="lb-px">${fmt.px(r.entry_price)}</span>
      <span class="lb-date">${esc(r.first_added || "")}</span></span>
    <span class="lb-px">${fmt.px(r.current_price)}</span>
    ${gainCell(r.gain)}
    <span class="lb-val">${fmt.money(r.value)}</span>
  </div>`;
  const list = (rows) =>
    rows && rows.length
      ? header + rows.map(row).join("")
      : `<div class="empty">${esc(L.boardEmpty)}</div>`;
  const inputs = BOARD_TABS.map(
    ([, s], i) => `<input type="radio" name="lbtab" id="lb-${s}"${i === 0 ? " checked" : ""}>`
  ).join("");
  const labels = BOARD_TABS.map(
    ([k, s]) => `<label for="lb-${s}" class="lb-tab lb-tab-${s}">${esc(L.tabs[k])}</label>`
  ).join("");
  const panels = BOARD_TABS.map(
    ([k, s]) => `<div class="lb-panel lb-panel-${s}">${list(boards[k])}</div>`
  ).join("");
  return `<section class="card lb">
    ${inputs}
    <div class="lb-head">
      ${esc(L.boardTitle)}
      <div class="lb-tabs">${labels}</div>
    </div>
    ${panels}
  </section>`;
}

// Rank leaderboard rows by best score (top 15) and compute gain since entry.
// Shared by both markets: the `leaderboard`/`cn_leaderboard` tables are identical
// in shape, so windowing and ranking are market-agnostic.
const BOARD_WINDOWS = { daily: 0, weekly: 7, quarterly: 90, yearly: 365 };

export function rankBoard(rows) {
  return [...rows]
    .sort((a, b) => (b.best_score || 0) - (a.best_score || 0))
    .slice(0, 15)
    .map((r) => {
      const entry = r.entry_price != null ? Number(r.entry_price) : null;
      const cur = r.current_price != null ? Number(r.current_price) : null;
      const gain = entry && cur ? (cur / entry - 1) * 100 : null;
      return {
        ticker: r.ticker,
        company_name: r.company_name,
        score: r.best_score,
        rating: r.best_rating,
        comment: r.best_comment,
        value: r.total_value,
        first_added: r.first_added_date,
        entry_price: entry,
        current_price: cur,
        gain,
      };
    });
}

// Read a durable leaderboard table and split it into the four windowed boards.
export async function loadBoards(db, table) {
  try {
    const { results } = await db
      .prepare(`SELECT * FROM ${table} WHERE best_score IS NOT NULL`)
      .all();
    const rows = results || [];
    if (!rows.length) return { daily: [], weekly: [], quarterly: [], yearly: [] };

    // Anchor windows to the most recent day any pick was seen (data day, not now).
    const latest = rows.reduce(
      (m, r) => (r.last_seen_date > m ? r.last_seen_date : m),
      ""
    );
    const cutoff = (days) => {
      const d = new Date(latest + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const board = (days) =>
      rankBoard(
        days === 0
          ? rows.filter((r) => r.last_seen_date === latest)
          : rows.filter((r) => r.last_seen_date >= cutoff(days))
      );
    return {
      daily: board(BOARD_WINDOWS.daily),
      weekly: board(BOARD_WINDOWS.weekly),
      quarterly: board(BOARD_WINDOWS.quarterly),
      yearly: board(BOARD_WINDOWS.yearly),
    };
  } catch {
    return { daily: [], weekly: [], quarterly: [], yearly: [] };
  }
}

// Parse filter params from the request URL, coercing blanks to null.
export function parseFilters(url) {
  const g = (k) => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : null;
  };
  const parseNum = (k) => {
    const raw = g(k);
    if (raw === null) return null;
    const n = parseFloat(raw.replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  };
  const minValue = parseNum("min_value");
  const minMarketCap = parseNum("min_market_cap");
  let limit = parseInt(g("limit") || "200", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 1000);
  return {
    ticker: g("ticker"),
    insider: g("insider"),
    code: g("code"),
    minValue,
    minMarketCap,
    limit,
  };
}

// Serve GETs from Cloudflare's edge cache when possible, so repeated/burst
// traffic is absorbed at the edge and never reaches D1. Data changes ~daily, so
// a short TTL is plenty fresh. This is the main app-level DDoS mitigation.
export async function serveCached(context, contentType, build) {
  const { request } = context;
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const body = await build();
  const resp = new Response(body, {
    headers: {
      "content-type": contentType,
      // s-maxage: edge cache TTL; max-age: browser TTL.
      "cache-control": "public, max-age=60, s-maxage=300",
      "access-control-allow-origin": "*",
    },
  });
  context.waitUntil(cache.put(request, resp.clone()));
  return resp;
}
