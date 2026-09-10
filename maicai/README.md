# 买菜比价 · Shoreline WA 98155

监控你常去那几家超市的菜价，按你家消费习惯推当日促销，跨店比价，并算出「今天去哪几家、每家买什么」。

本地跑，数据存本机 SQLite，不上传任何东西。

```bash
npm run seed-history     # 灌 90 天离线样本数据（不需要任何凭证，立刻能看全部功能）
npm start                # 打开 http://localhost:5173
```

---

## 它解决的三件事

**1. 比价必须归一化才可信。** 同一样东西各店卖法完全不同：Fred Meyer 是 `2 lb bag`、99 Ranch 是 `$0.79/lb`、T&T 是 `400 g`、Costco 是 `4 lb`、Boo Han 是 `450 g`。直接比标价没有意义。系统把所有价格换算成同一单位（每磅 / 每盎司 / 每加仑 / 每个…）再比。调料这类「有的按毫升卖、有的按克卖」的，可以在 catalog 里给个密度做跨单位换算——**没给密度就不换算，绝不自己猜**。

**2. 不相信店里挂的「Sale」标。** 超市常年把东西标成促销，或先抬原价再打折。判断便宜只看一件事：今天的单价 vs 这个商品过去 90 天的历史中位单价。挂了促销标却没比平时便宜的，单独归到「假促销」告诉你。

**3. 排序按「你家一周能省多少钱」，不是按折扣百分比。** 你每周买 1 加仑牛奶，牛奶降 10% 比你半年买一次的香油降 40% 更值得推。这靠 `data/catalog.json` 里的 `weekly`（你家每周买几个单位）——**这是唯一需要你按实际情况调的东西**。

---

## 六家店的数据从哪来

数据可获取性差别很大。下面每一条都是实测结论，不是猜的：

| 超市 | 车程 | 数据源 | 状态 |
|---|---|---|---|
| **Fred Meyer** | 8 分 | Kroger 官方 API，含**分店真实价 + 促销价** | 端点已实测可达，需免费凭证 |
| **Costco** | 10 分 | 月度优惠册读图 / 手动录入 | 已确认**无法自动抓取** |
| **Trader Joe's** | 12 分 | 官网 GraphQL（需无头浏览器） | curl 返回 403 已实测 |
| **99 Ranch** | 14 分 | 站点 JSON 录制（需无头浏览器） | 站点可达已实测 |
| **Boo Han** | 15 分 | 周报大图 → 视觉模型读图 | 周报图已实测下载成功 |
| **T&T** | 32 分 | 站点 JSON 录制（需无头浏览器） | curl 返回 403 已实测 |

### Fred Meyer：用官方 API，别爬网页

`fredmeyer.com` 连 TCP 都建不起来（被彻底挡），但 `api.kroger.com` 是官方公开 API，返回指定门店的真实价格和促销价，比爬网页准且稳定。

```bash
# 1. 去 https://developer.kroger.com 免费注册 → Add Product → 拿 Client ID / Secret
cp .env.example .env      # 填进 KROGER_CLIENT_ID / KROGER_CLIENT_SECRET
# 2. 查你家最近那家的门店号，填进 data/stores.json 的 krogerLocationId
npm run ingest -- --find-stores
```

配额每天 10,000 次，我们一天用几十次。

### Costco：没有自动数据源，这是确认过的

两个独立的原因，都不是「再试试就能行」：

1. **官网拒绝一切自动访问。** curl 拿首页 200 但搜索页 403；无头 Chromium 连 TLS 握手都过不去（`ERR_HTTP2_PROTOCOL_ERROR`）；本机真实 Chrome + 有头模式也是 Akamai 的 `Access Denied`。再往下就得伪造指纹 / 挂住宅代理去绕它的访问控制，这个没做。
2. **更根本：Costco 的仓库店内价从来不在网上公开。** costco.com 的线上价含配送成本、比店内高、商品编号也不一样。就算能爬下来，和 Fred Meyer 的店内价放一起比也是**错的**——会让你以为 Costco 更贵而错过真正便宜的东西。宁可没数据，不要错数据。

所以 Costco 走这两条路（可以只用第二条）：

```bash
# a) 把月度 Coupon Book 的截图或 PDF 丢进 data/flyers/costco/，然后
npm run ingest -- --stores=costco        # 用视觉模型读出来
# b) 手动录入（不需要 API key）
cp data/manual/costco.example.json data/manual/costco.json   # 照着改
```

Costco 价格很稳，买完看小票录一次，一个月更一次就够。

**另外 Costco 有个比价上的坑**：包装量大。你想买 1 磅草莓，它只卖 4 磅装——每磅再便宜，多出来的三磅吃不完就是浪费。比价页、商品明细、购物清单都会标出「整包 N 磅」，购物清单里超过你需要量一倍就提醒。

### Boo Han：周报图能自动抓，但要读图

`boohan.com` 是 Wix 站，没有机器人防护，不用浏览器。但周报页里 **0 个价格文字、没有 PDF**——价格全在一张 2.3MB 的大图上，而且是美术字（`$3⁷⁹` 这种美元和美分分体排版）。普通 OCR 在这种排版上错得厉害，而错的价格比没有价格更糟。所以用视觉模型读图。

```bash
npm run ingest -- --stores=boohan    # 自动找当前那张周报图并读出来
```

一周一张图 = 一次 API 调用。提取结果按图片内容哈希缓存在 `data/flyers/boohan/.cache/`，同一期周报不重复花钱。周报底部印着 *sale prices apply to in-store purchases only*，正是店内价。

没有 `ANTHROPIC_API_KEY` 也能用：

```bash
cp data/manual/boohan.example.json data/manual/boohan.json
```

那个示例文件里的价格是从 9/4–9/10 那期周报上真实抄下来的，可以直接用。

### 需要浏览器的三家

```bash
npx playwright install chromium    # 已经装好了
npm run ingest -- --stores=trader_joes,ranch99,tnt
```

这三家的字段映射按公开结构写的，首次跑要核对一下（`--dump` 会在抓不到时把页面存进 `data/debug/`）。

---

## 常用命令

```bash
npm start                              # 网页
npm run ingest                         # 抓所有店
npm run ingest -- --stores=fred_meyer  # 只抓一家
npm run ingest:flyers                  # 只跑 Costco + Boo Han 的促销单
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

## 四个页面

- **今日促销** — 真降价按「一周能省多少」排序；折叠区里是假促销和没抓到价的常买商品
- **比价** — 全部商品 × 全部门店，同一单位对照，最低价标绿，起买量偏大的标黄
- **购物清单** — 勾选和数量，实时算「去哪几家、每家买什么」。车程按 `$0.35/分钟` 折成钱算进总成本，所以为了省两块钱专程跑远店不会被推荐
- **商品库** — 每样东西匹配到了哪些具体商品、自动匹配的置信分；认错了点「这个不算」拉黑，改动存库不被覆盖

---

## 需要你调的东西

**`data/catalog.json`** — 你家常买清单，35 样。改 `weekly` 成真实每周购买量，这直接决定促销推荐排序。加新商品就加一条，`match.any` 写商品标题里会出现的英文关键词，`match.not` 写要排除的（挡掉「燕麦奶」混进「牛奶」这种）。

**`data/stores.json`** — 门店地址和 `driveMinutes`（单程分钟）请自己核对一次，我按 98155 附近最可能的门店填了默认值。`tripCost.perMinute` 调大 = 更不愿意多跑店，调小 = 更愿意为省钱跑。

---

## 已知限制

- **样本数据不是真实价格。** `npm run seed-history` 灌的是按各店定价习惯编的假数据，用来验证功能。真数据要 `npm run ingest`。
- **视觉模型读促销单这一步没有实测过。** 这台机器上没有 Anthropic 凭证（`ANTHROPIC_API_KEY` 未设、`ant` CLI 未装），所以从周报图到结构化价格那一次 API 调用我没跑成。周报图的自动下载、提取结果→商品→单价的整条后续管线都用真实周报价格验证过了，但读图准确率你第一次跑完要自己核对一遍——特别是美术字价格。
- **三家浏览器抓取的字段映射未实测。** 403 和站点可达性是实测的，但具体选择器/字段名首次跑要确认。
- **匹配不可能全对。** 自动匹配有分数下限（低于 0.30 宁可不匹配，也不让错价格进比价），但仍会有漏和错。商品库页面可以手动纠正。
- **单店包装量差异只做提醒，没进优化目标。** 购物清单的最优解按单价算，起买量只是标出来让你自己判断。
