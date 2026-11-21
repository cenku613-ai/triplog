/**
 * TripLog 同步／Agent API（純 Node，無框架）。
 *
 * 定位：一個「單一基準檔」的同步儲存，不是多使用者後端。
 * 外界只透過 Caddy 的 https://<Domain>/api/* 進來（仍然只開 443），
 * 容器本身只綁 127.0.0.1。所有寫入都要 bearer token，且一律是新增／覆蓋，
 * 沒有刪除資料的 API——誤刪的風險留在本機（有備份檔），不留給伺服器。
 */
import http from 'node:http';
import { openStore, migrateJsonSnapshots, MAX_SNAPSHOT_BYTES } from './store.js';
import { send, fail, tokenEquals, bearer, readJsonBody, rateLimiter, clientIp, applyCors } from './net.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? process.env.TRIPLOG_API_PORT ?? 8788);
const HOST = process.env.TRIPLOG_API_HOST ?? '0.0.0.0';
const DATA_DIR = process.env.TRIPLOG_DATA_DIR ?? '/data';
const WRITE_KEY = (process.env.TRIPLOG_API_KEY ?? '').trim();
const READ_KEY = (process.env.TRIPLOG_READ_KEY ?? WRITE_KEY).trim();
const MAX_BODY = Number(process.env.TRIPLOG_MAX_BODY ?? MAX_SNAPSHOT_BYTES * 2);
const ALLOWED_ORIGIN = (process.env.TRIPLOG_ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function die(msg) {
  console.error(`[triplog-api] ${msg}`);
  process.exit(1);
}

if (WRITE_KEY.length < 24) {
  die('TRIPLOG_API_KEY 沒設定或太短（至少 24 字元）。產生一把：openssl rand -hex 32');
}
if (READ_KEY.length < 16) {
  die('TRIPLOG_READ_KEY 太短，不適合當讀取金鑰。');
}

const store = openStore(DATA_DIR);
const migrated = migrateJsonSnapshots(store, DATA_DIR);
if (migrated) console.log(`[triplog-api] 已把舊的 snapshot.json 搬進 SQLite（id=${migrated}）`);

const limitRead = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_READ ?? 600), windowMs: 60_000 });
const limitWrite = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_WRITE ?? 60), windowMs: 60_000 });

/* -------------------------------------------------------------- 資料視圖 */

function counts(snapshot) {
  const perTrip = {};
  const bump = (id, field) => {
    if (!id) return;
    perTrip[id] ??= { items: 0, expenses: 0, photos: 0 };
    perTrip[id][field] += 1;
  };
  for (const i of snapshot.dayItems ?? []) bump(i.tripId, 'items');
  for (const e of snapshot.expenses ?? []) bump(e.tripId, 'expenses');
  for (const p of snapshot.photos ?? []) bump(p.tripId, 'photos');
  for (const t of snapshot.trips ?? []) perTrip[t.id] ??= { items: 0, expenses: 0, photos: 0 };
  return perTrip;
}

/** 基準檔不帶照片 bytes，回 metadata 讓客戶端知道要抓幾張 */
function lite(snapshot) {
  const { photos = [], ...rest } = snapshot;
  return {
    ...rest,
    photos: photos.map(({ data, thumbData, ...p }) => p),
    photoBytes: photos.reduce((s, p) => s + (p.data?.length ?? 0), 0),
  };
}

function pickPhotos(snapshot, { ids, tripIds, limit = 150, includeData = true }) {
  let rows = snapshot.photos ?? [];
  if (Array.isArray(ids) && ids.length) rows = rows.filter((p) => ids.includes(p.id));
  else if (Array.isArray(tripIds) && tripIds.length) rows = rows.filter((p) => tripIds.includes(p.tripId));
  rows = rows.slice(0, limit);
  return includeData ? rows : rows.map(({ data, thumbData, ...p }) => p);
}

function findTrip(snapshot, id) {
  return (snapshot.trips ?? []).find((x) => x.id === id) ?? null;
}

/* ------------------------------------------------------------------ 路由 */

const SCHEMA_HINT = {
  format: 'triplog-backup',
  trip: {
    id: 'trip_<uuid>',
    name: 'string',
    startDate: 'YYYY-MM-DD',
    endDate: 'YYYY-MM-DD',
    baseCurrency: 'TWD',
    budget: 'number|null',
    color: '#rrggbb',
    notes: 'string',
    companions: ['string'],
    archived: 'boolean',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  dayItem: {
    id: 'item_<uuid>',
    tripId: 'string',
    date: 'YYYY-MM-DD',
    kind: 'transport|stay|food|sight|activity|other',
    title: 'string',
    startTime: 'HH:MM|null',
    endTime: 'HH:MM|null',
    location: 'string',
    lat: 'number|null',
    lng: 'number|null',
    note: 'string',
    order: 'number',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  expense: {
    id: 'exp_<uuid>',
    tripId: 'string',
    dayItemId: 'string|null',
    date: 'YYYY-MM-DD',
    amount: 'number',
    currency: 'string',
    rateToBase: 'number',
    baseAmount: 'number = amount * rateToBase',
    category: 'category id, or a builtin key: food|transport|stay|ticket|shopping|fun|misc',
    payee: 'string',
    note: 'string',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  notes: [
    'Write via POST /api/backup with a full triplog-backup document; the server merges by id and keeps the newest updatedAt.',
    'Prefer POST /api/sync with a partial document {trips?,dayItems?,expenses?,categories?,photos?} so you never overwrite rows you did not read.',
    'There is no delete endpoint by design. To archive a trip set archived=true.',
    'Amounts stay in the original currency; baseAmount is what statistics use.',
  ],
};

async function route(req, res) {
  const url = new URL(req.url, 'http://internal');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','trips','trip_x','export']

  applyCors(req, res, ALLOWED_ORIGIN);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (parts[0] !== 'api') return fail(res, 404, 'not found');

  const resource = parts[1] ?? '';

  if (resource === 'health') {
    const s = store.stats();
    return send(res, 200, { ok: true, version: VERSION, hasData: !!s.head, ...s });
  }
  if (resource === 'schema') {
    return send(res, 200, { ok: true, version: VERSION, schema: SCHEMA_HINT });
  }

  const key = bearer(req);
  const canRead = tokenEquals(key, READ_KEY) || tokenEquals(key, WRITE_KEY);
  const canWrite = tokenEquals(key, WRITE_KEY);
  if (!canRead) {
    return fail(res, 401, 'missing or wrong bearer token', { need: 'TRIPLOG_READ_KEY or TRIPLOG_API_KEY' });
  }

  const ip = clientIp(req);
  if (!limitRead(ip)) return fail(res, 429, 'too many requests', { retryAfterMs: 60_000 });

  const { snapshot } = store.base();

  /* ------------------------------------------------------------- 讀取端 */
  if (req.method === 'GET') {
    if (resource === 'base') {
      const stats = store.stats();
      // 「還沒有基準」用 404 表達：客戶端第一次同步時會把它當成「本機就是基準」直接推上去
      if (!stats.head) return fail(res, 404, 'no snapshot yet');
      const base = lite(snapshot);
      return send(res, 200, { ok: true, base, bytes: Buffer.byteLength(JSON.stringify(base)), head: stats.head, counts: counts(snapshot) });
    }
    if (resource === 'history') {
      return send(res, 200, { ok: true, snapshots: store.list({ limit: Number(url.searchParams.get('limit') ?? 20) }) });
    }
    if (resource === 'trips' && parts.length === 2) {
      const trips = (snapshot.trips ?? [])
        .filter((x) => (url.searchParams.get('archived') === '1' ? true : !x.archived))
        .map(({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }) => ({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }));
      return send(res, 200, { ok: true, trips, counts: counts(snapshot) });
    }
    if (resource === 'trips' && parts[2]) {
      const id = parts[2];
      if (parts[3] === 'export') {
        const backup = slice(snapshot, id, { photos: url.searchParams.get('photos') !== '0' });
        if (!backup.trips.length) return fail(res, 404, 'trip not found', {});
        return send(res, 200, { ok: true, backup });
      }
      const trip = findTrip(snapshot, id);
      if (!trip) return fail(res, 404, 'trip not found', {});
      return send(
        res,
        200,
        {
          ok: true,
          trip,
          items: (snapshot.dayItems ?? []).filter((x) => x.tripId === id),
          expenses: (snapshot.expenses ?? []).filter((x) => x.tripId === id),
          photos: pickPhotos(snapshot, { tripIds: [id], limit: 400, includeData: false }),
          categories: snapshot.categories ?? [],
        },
      );
    }
    if (resource === 'expenses') {
      const tripId = url.searchParams.get('tripId');
      const expenses = (snapshot.expenses ?? []).filter((e) => !tripId || e.tripId === tripId);
      return send(res, 200, { ok: true, expenses, categories: snapshot.categories ?? [], totals: totalsByCurrency(expenses) });
    }
    if (resource === 'photos') {
      const tripIds = (url.searchParams.get('tripIds') ?? '').split(',').filter(Boolean);
      return send(res, 200, { ok: true, photos: pickPhotos(snapshot, { tripIds, limit: 400 }) });
    }
    if (resource === 'summary') {
      const trip = findTrip(snapshot, url.searchParams.get('tripId') ?? '');
      if (!trip) return fail(res, 404, 'trip not found', {});
      const expenses = (snapshot.expenses ?? []).filter((e) => e.tripId === trip.id);
      return send(
        res,
        200,
        {
          ok: true,
          trip,
          items: (snapshot.dayItems ?? []).filter((x) => x.tripId === trip.id).length,
          expenses: expenses.length,
          totalBase: round2(expenses.reduce((s, e) => s + (e.baseAmount ?? 0), 0)),
          budget: trip.budget ?? null,
          byCategory: groupSum(expenses, 'category'),
          byPayee: groupSum(expenses, 'payee'),
          byCurrency: groupSum(expenses, 'currency', 'amount'),
        },
      );
    }
    return fail(res, 404, 'not found', {});
  }

  /* ------------------------------------------------------------ 寫入端 */
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
  if (!canWrite) return fail(res, 403, 'read-only token: writes need TRIPLOG_API_KEY', {});
  if (!limitWrite(ip)) return fail(res, 429, 'too many writes', { retryAfterMs: 60_000 });

  let body = null;
  try {
    body = await readJsonBody(req, MAX_BODY);
  } catch (err) {
    return fail(res, err.status ?? 400, err.message, {});
  }

  if (resource === 'backup') {
    try {
      const saved = store.put(body, { source: 'push' });
      return send(res, 200, { ok: true, ...saved, savedAt: saved.exportedAt });
    } catch (err) {
      return fail(res, err.message?.includes('too large') ? 413 : 400, String(err.message ?? err), {});
    }
  }

  if (resource === 'sync') {
    // 客戶端只送「它碰過的資料」，伺服器併進基準後回傳完整基準，避免整檔覆寫 race
    try {
      const saved = store.put({ ...body, format: 'triplog-backup', exportedAt: new Date().toISOString() }, { source: 'sync' });
      const merged = store.base().snapshot;
      return send(res, 200, { ok: true, saved, merged: counts(merged), base: lite(merged) });
    } catch (err) {
      return fail(res, 400, String(err.message ?? err), {});
    }
  }

  if (resource === 'photos' && parts[2] === 'get') {
    const ids = Array.isArray(body?.photoIds) ? body.photoIds.slice(0, 200) : [];
    const tripIds = Array.isArray(body?.tripIds) ? body.tripIds.slice(0, 20) : [];
    return send(res, 200, { ok: true, photos: pickPhotos(snapshot, { ids, tripIds, limit: 200 }) });
  }

  if (resource === 'admin' && parts[2] === 'clear') {
    if (req.headers['x-triplog-confirm'] !== 'wipe') {
      return fail(res, 400, 'pass header x-triplog-confirm: wipe', {});
    }
    const removed = store.clear();
    return send(res, 200, { ok: true, ...removed });
  }

  return fail(res, 404, 'not found', {});
}

function slice(snapshot, tripId, { photos = true } = {}) {
  const items = (snapshot.dayItems ?? []).filter((x) => x.tripId === tripId);
  const itemIds = new Set(items.map((x) => x.id));
  const expenses = (snapshot.expenses ?? []).filter((e) => e.tripId === tripId);
  const used = new Set(expenses.map((e) => e.category));
  const rows = pickPhotos(snapshot, { tripIds: [tripId], limit: 400 });
  return {
    format: 'triplog-backup',
    version: photos && rows.some((p) => p.data) ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: (snapshot.trips ?? []).filter((t) => t.id === tripId),
    dayItems: items,
    expenses,
    categories: (snapshot.categories ?? []).filter((c) => used.has(c.id) || used.has(c.key)),
    photos: photos ? rows : rows.map(({ data, thumbData, ...p }) => p),
    meta: (snapshot.meta ?? []).filter((m) => m.key === 'rates'),
    relatedItemIds: [...itemIds],
  };
}

function totalsByCurrency(expenses) {
  const out = {};
  for (const e of expenses) {
    out[e.currency] ??= { amount: 0, count: 0, baseAmount: 0 };
    out[e.currency].amount = round2(out[e.currency].amount + (e.amount ?? 0));
    out[e.currency].baseAmount = round2(out[e.currency].baseAmount + (e.baseAmount ?? 0));
    out[e.currency].count += 1;
  }
  return out;
}

function groupSum(rows, field, valueField = 'baseAmount') {
  const out = {};
  for (const r of rows) {
    const key = String(r[field] ?? '') || '(none)';
    out[key] = round2((out[key] ?? 0) + Number(r[valueField] ?? 0));
  }
  return out;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[triplog-api] 請求炸了：', err);
    if (!res.headersSent) fail(res, 500, 'internal error');
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const stats = store.stats();
  console.log(`[triplog-api] listening on http://${HOST}:${PORT} · data=${DATA_DIR}`);
  console.log(`[triplog-api] snapshots=${stats.snapshots} bytes=${stats.totalBytes} head=${stats.head?.exportedAt ?? '(none)'} keep=${stats.keep}`);
  console.log('[triplog-api] 沒有 DELETE API：寫入只有新增與覆寫，刪除請在本機操作後再同步。');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
