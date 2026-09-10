#!/usr/bin/env node
// 本地 HTTP 服务：静态页面 + JSON API。用 node:http，不引框架。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import {
  ROOT, syncStores, loadCatalog, loadStoresConfig, getStores, lastRuns,
  getBasket, setBasket, setMatch, productsForItem, searchProducts, fullHistory, today,
} from './db.js';
import { todayDeals, compareAll, compareItem, CONFIG } from './deals.js';
import { planBasket, defaultBasket } from './basket.js';
import { describeAll } from './scrapers/index.js';

const PORT = Number(process.env.PORT || 5173);
const WEB = join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

async function serveStatic(res, urlPath) {
  // 防目录穿越：normalize 后必须还在 WEB 目录内
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB, rel);
  if (!file.startsWith(WEB)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
}

const routes = {
  'GET /api/summary': () => {
    const cfg = loadStoresConfig();
    const catalog = loadCatalog();
    const runs = lastRuns(12);
    return {
      home: cfg.home,
      stores: getStores().map((s) => ({
        id: s.id, name: s.name, nameZh: s.name_zh, branch: s.branch,
        driveMinutes: s.drive_minutes, source: s.source,
      })),
      catalog: catalog.map((i) => ({
        id: i.id, name: i.name, nameEn: i.nameEn, category: i.category, unit: i.unit, weekly: i.weekly,
      })),
      categories: [...new Set(catalog.map((i) => i.category))],
      tripCost: cfg.tripCost,
      dealConfig: CONFIG,
      scrapers: describeAll(),
      runs: runs.map((r) => ({ ts: r.ts, storeId: r.store_id, ok: !!r.ok, count: r.product_count, message: r.message })),
      today: today(),
    };
  },

  'GET /api/today': (q) => todayDeals({ day: q.get('day') || null }),

  'GET /api/compare': () => compareAll(),

  'GET /api/item': (q) => {
    const id = q.get('id');
    if (!id) throw new Error('缺少 id');
    return { ...compareItem(id), products: productsForItem(id) };
  },

  'GET /api/history': (q) => {
    const pid = Number(q.get('productId'));
    if (!pid) throw new Error('缺少 productId');
    return { productId: pid, points: fullHistory(pid, Number(q.get('days') || 180)) };
  },

  'GET /api/basket': () => {
    const saved = getBasket();
    const entries = saved.length ? saved.map((r) => ({ itemId: r.item_id, qty: r.qty })) : defaultBasket();
    return { entries, isDefault: saved.length === 0, ...planBasket(entries) };
  },

  'GET /api/search': (q) => ({ results: searchProducts(q.get('q') || '', Number(q.get('limit') || 40)) }),

  'POST /api/basket': (q, body) => {
    const entries = (body.entries ?? []).map((e) => ({ itemId: String(e.itemId), qty: Number(e.qty) }));
    setBasket(entries);
    return { ok: true, entries, ...planBasket(entries, { perMinute: body.perMinute, onlyStores: body.onlyStores }) };
  },

  'POST /api/plan': (q, body) => {
    const entries = (body.entries ?? defaultBasket()).map((e) => ({ itemId: String(e.itemId), qty: Number(e.qty) }));
    return planBasket(entries, { perMinute: body.perMinute, onlyStores: body.onlyStores });
  },

  'POST /api/match': (q, body) => {
    const pid = Number(body.productId);
    if (!pid) throw new Error('缺少 productId');
    const n = setMatch(pid, body.itemId ?? null, !!body.blocked);
    return { ok: true, recomputedSnapshots: n };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  const key = `${req.method} ${url.pathname.replace(/\/$/, '')}`;
  const handler = routes[key];
  if (!handler) return json(res, { error: `没有这个接口: ${key}` }, 404);

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    json(res, await handler(url.searchParams, body));
  } catch (e) {
    console.error(`${key} 出错:`, e.message);
    json(res, { error: e.message }, 400);
  }
});

syncStores();
server.listen(PORT, () => {
  console.log(`\n买菜比价已启动: http://localhost:${PORT}\n`);
  const runs = lastRuns(1);
  if (runs.length === 0) {
    console.log('数据库还是空的，先跑一次：');
    console.log('  npm run seed-history     # 造 90 天样本历史，立刻能看到完整效果');
    console.log('  npm run ingest           # 抓真实数据\n');
  }
});
