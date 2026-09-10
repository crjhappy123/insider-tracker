# 买菜比价 · Shoreline WA 98155

监控你常去那几家超市的菜价，按你家消费习惯推当日促销，跨店比价，并算出「今天去哪几家、每家买什么」。

线上：**https://www.rudystock.com/shop/**（Cloudflare Pages 静态站，GitHub Actions 每天早上 7 点自动更新）

本地开发：

```bash
npm run seed-history     # 灌 90 天离线样本数据（不需要任何凭证，立刻能看全部功能）
npm start                # 打开 http://localhost:5173
npm run ingest           # 抓真实数据
```

线上是纯静态站：Cloudflare Workers 没有 node:sqlite、没有文件系统、跑不了 Playwright，
所以构建期把需要历史的东西全算完导出成 JSON，浏览器只做展示 + 购物清单组合优化。

---

## 它解决的三件事

**1. 比价必须归一化才可信。** 同一样东西各店卖法完全不同：Fred Meyer 是 `2 lb bag`、99 Ranch 是 `$0.79/lb`、T&T 是 `400 g`、Costco 是 `4 lb`、Boo Han 是 `450 g`。直接比标价没有意义。系统把所有价格换算成同一单位（每磅 / 每盎司 / 每加仑 / 每个…）再比。调料这类「有的按毫升卖、有的按克卖」的，可以在 catalog 里给个密度做跨单位换算——**没给密度就不换算，绝不自己猜**。

**2. 不相信店里挂的「Sale」标。** 超市常年把东西标成促销，或先抬原价再打折。判断便宜只看一件事：今天的单价 vs 这个商品过去 90 天的历史中位单价。挂了促销标却没比平时便宜的，单独归到「假促销」告诉你。

**3. 排序按「你家一周能省多少钱」，不是按折扣百分比。** 你每周买 1 加仑牛奶，牛奶降 10% 比你半年买一次的香油降 40% 更值得推。这靠 `data/catalog.json` 里的 `weekly`（你家每周买几个单位）——**这是唯一需要你按实际情况调的东西**。

---

## 六家店的数据从哪来

每一条都是实测结论，不是猜的：

| 超市 | 车程 | 能不能自动抓 | 怎么拿数据 |
|---|---|---|---|
| **Fred Meyer** | 8 分 | ✅ 官方 API | Kroger 开放 API，分店真实价 + 促销价。需免费凭证 |
| **Costco** | 10 分 | ❌ 全站封锁 | 手动录入 / 月度优惠册读图 |
| **Trader Joe's** | 12 分 | ❌ 全站封锁 | 手动录入（全国统一价，录一次能用很久） |
| **99 Ranch** | 14 分 | ✅ 内部 JSON API | 已跑通：217 个商品，规格和图片 100% 齐 |
| **Boo Han** | 15 分 | ✅ 周报图自动下载 | 图 → 视觉模型读成价格 |
| **T&T** | 32 分 | ❌ 全站封锁 | 手动录入 / 促销单读图 |

### 99 Ranch：走它自己的 JSON API

```
POST /be-api/store/web/list       {zipCode:'98155', deliveryType:1}  -> 门店和 storeId
POST /be-api/search/web/products  {keyword, page, pageSize}          -> 商品（storeid 放请求头）
```

字段很干净：`productNameEN`、`brandNameEN`、`netWeight`+`netWeightUom`（规格）、`retailPrice`/`salePrice`、`image`。
站点前面挂着 Cloudflare 防护，纯 fetch 会被拒，所以先用浏览器打开首页拿 cookie，之后在页面上下文里连续调 API。

**`storeid` 这个请求头必须显式带上。** 默认值 8899 是加州 Buena Park 的 "Warehouse Savings" 仓库店 ——
不带这个头抓到的是加州仓库价，却会被当成 Edmonds 的价格用，不报错、静默给出错的比价结果。
按邮编查不到本地门店时，代码宁可直接失败也不用默认门店。

### Costco / Trader Joe's / T&T：确认过没有自动数据源

三家撞在同一堵墙上：Akamai 边缘节点返回 `Access Denied`，**真实 Chrome 有头模式也一样**，
每个入口（首页、搜索页、促销单页）全 403。再往下就得伪造 TLS 指纹、挂住宅代理去绕它们的
访问控制 —— 这个没做。

Costco 还有第二层更根本的问题：**仓库店内价从来不在网上公开。** costco.com 的线上价含配送成本、
比店内高、商品编号也不一样。就算能爬下来，和 Fred Meyer 的店内价放一起比也是**错的**。

所以这三家走手动录入 / 促销单读图：

```bash
cp data/manual/costco.example.json      data/manual/costco.json       # 照着改
cp data/manual/trader_joes.example.json data/manual/trader_joes.json
cp data/manual/tnt.example.json         data/manual/tnt.json
# 或者把促销单截图/PDF 丢进 data/flyers/<门店>/，跑抓取时用视觉模型读
```

这不算凑合。这几家价格变化频率很低（TJ 全国统一价常年不变、Costco 一个月更一次优惠册），
买完照着小票录一次十几样花几分钟，比每天跑一次不可靠的爬虫靠得住。

**T&T 录入前先确认价格是美元** —— 它是加拿大连锁，网站默认可能落到加拿大门店，那边标加元。

### Fred Meyer：用官方 API，别爬网页

`fredmeyer.com` 连 TCP 都建不起来，但 `api.kroger.com` 是官方公开 API，返回指定门店的真实价格和促销价。

```bash
# 去 https://developer.kroger.com 免费注册 → Add Product → 拿 Client ID / Secret
cp .env.example .env
npm run ingest -- --find-stores    # 查门店号，填进 data/stores.json
```

### Boo Han：周报图自动抓，视觉模型读

`boohan.com` 是 Wix 站，没有机器人防护。但周报页里 **0 个价格文字**，价格全在一张 2.3MB 大图上，
而且是美术字（`$3⁷⁹` 这种美元美分分体排版）。普通 OCR 在这种排版上错得厉害，错的价格比没价格更糟，
所以用视觉模型读图。一周一张图 = 一次 API 调用，按图片哈希缓存，同期不重复花钱。

## 数据可信度分档

页面上每个价格都标着来源，顶部还有汇总提示。这不是装饰 —— 公开站点把编造的价格
不声不响混在真实价格里，等于在骗人。

| 档 | 含义 |
|---|---|
| **实测抓取** | 从店里接口真实抓到的 |
| **促销单读图** | 视觉模型从促销单图上读出来的 |
| **手动录入** | 你自己核对过后填的 |
| **估算价** | 按常见货架价填的参考值，**没有实地核对** |
| **样本价** | 编造的，只为验证功能，**绝对不能用来做购买决定** |

同一家店同一样商品有多个来源时，按可信度挑，**不按价格低挑** —— 编造的样本价往往比真实价低，
按价格挑会让假数据把真数据挤掉。真实数据到位后，那家店的样本数据会被自动清掉。

---

## 常用命令

```bash
npm start                              # 网页
npm run ingest                         # 抓所有店
npm run ingest -- --stores=fred_meyer  # 只抓一家
npm run ingest:flyers                  # 只跑促销单那几家
npm run export                         # 导出静态站到 dist/shop
npm run history:dump / :load           # 价格历史导出/灌入（CI 用）
npm run ingest -- --list-scrapers      # 看每家店用什么方式抓、验证到什么程度
npm run ingest -- --find-stores        # 查附近 Fred Meyer 门店号
npm run seed-history                   # 灌 90 天样本历史
npm run reset                          # 清库
```

每天自动跑一次（价格历史越长，真假促销判断越准）：

```bash
crontab -e
# 每天早上 7 点
0 7 * * * cd /Users/ruijiche/Desktop/买菜网站 && /usr/local/bin/npm run ingest >> /tmp/maicai-cron.log 2>&1
```

---

## 五个页面

- **今日促销** — 跨店筛真降价，按「一周能省多少」排序；折叠区里是假促销和没抓到价的常买商品
- **打折专区** — 按超市分块看每家挂了哪些促销（逛店视角）。不过滤，但标出真降价 / 假促销 / 起买量
- **比价** — 全部商品 × 全部门店，同一单位对照，最低价标绿，起买量偏大的标黄
- **购物清单** — 勾选和数量，实时算「去哪几家、每家买什么」。车程按 `$0.35/分钟` 折成钱算进总成本，所以为了省两块钱专程跑远店不会被推荐
- **商品库** — 每样东西匹配到了哪些具体商品、自动匹配的置信分；认错了点「这个不算」拉黑，改动存库不被覆盖

---

## 需要你调的东西

**`data/catalog.json`** — 你家常买清单，35 样。改 `weekly` 成真实每周购买量，这直接决定促销推荐排序。
加新商品就加一条：`match.any` 写商品标题里会出现的英文关键词、`match.not` 写要排除的、
`priceRange` 写合理单价区间（挡数量级错误）、`emoji` 是没有真实商品图时的图标。

**`data/stores.json`** — 门店地址和 `driveMinutes`（单程分钟）请自己核对一次，我按 98155 附近最可能的门店填了默认值。`tripCost.perMinute` 调大 = 更不愿意多跑店，调小 = 更愿意为省钱跑。

---

## 已知限制

- **样本数据不是真实价格。** `npm run seed-history` 灌的是按各店定价习惯编的假数据，用来验证功能。真数据要 `npm run ingest`。
- **视觉模型读促销单这一步没有实测过。** 这台机器上没有 Anthropic 凭证（`ANTHROPIC_API_KEY` 未设、`ant` CLI 未装），所以从周报图到结构化价格那一次 API 调用我没跑成。周报图的自动下载、提取结果→商品→单价的整条后续管线都用真实周报价格验证过了，但读图准确率你第一次跑完要自己核对一遍——特别是美术字价格。
- **Costco / Trader Joe's / T&T 没有自动数据源**，靠手动录入或促销单读图。这是实测确认的封锁，不是没试。
- **99 Ranch 的 `storeid` 一定要对。** 不带这个头会静默拿到加州仓库价。
- **匹配不可能全对。** 三道防线：关键词黑名单、匹配分数下限（低于 0.30 宁可不匹配）、
  catalog 里的合理单价区间（挡住「Pocky 草莓棒当草莓」「白菜种子当白菜」这种数量级错误）。
  真实抓取跑通后仍会冒出新的误配，商品库页面可以手动纠正。
- **一个商品超过 7 天没再抓到就不参与比价。** 否则下架商品会带着旧价格永远显示下去。
- **单店包装量差异只做提醒，没进优化目标。** 购物清单的最优解按单价算，起买量只是标出来让你自己判断。
