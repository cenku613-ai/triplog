/**
 * 後端冒煙測試：真的把服務跑起來，用 HTTP 打全部端點，驗證
 * 認證、合併、照片裁剪、歷史基準、重啟後仍可讀。
 *
 * 跑法：TRIPLOG_API_KEY=... node server/test/smoke.mjs（自己長一個臨時資料夾與隨機 port）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.js');
const mergeCore = path.join(here, '..', '..', 'src', 'lib', 'merge-core.js');
const { mergeBackupObjects } = await import(pathToFileURL(mergeCore).href);

const KEY = 'smoke-write-key-0123456789abcdef';
const READ = 'smoke-read-key-0123456789';
const PORT = 8790 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(os.tmpdir(), 'triplog-smoke-'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name} → ${err.message}`);
  }
}

function boot() {
  return spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TRIPLOG_API_KEY: KEY,
      TRIPLOG_READ_KEY: READ,
      TRIPLOG_DATA_DIR: dir,
      PORT: String(PORT),
      TRIPLOG_ALLOWED_ORIGIN: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const logs = [];
let child = boot();
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server 沒起來：\n${logs.join('')}`);
}

async function api(p, { method = 'GET', key = KEY, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 空體 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const iso = (n) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 86400000).toISOString();
const bigData = 'data:image/jpeg;base64,' + 'A'.repeat(4096);

function fixture() {
  return {
    format: 'triplog-backup',
    version: 2,
    exportedAt: iso(1),
    trips: [
      { id: 'trip_a', name: 'Kyoto', startDate: '2026-03-01', endDate: '2026-03-04', baseCurrency: 'TWD', budget: 30000, color: '#0f766e', companions: ['Me', 'Ana'], archived: false, createdAt: iso(0), updatedAt: iso(0) },
      { id: 'trip_b', name: 'Osaka', startDate: '2026-05-01', endDate: '2026-05-02', baseCurrency: 'TWD', budget: null, color: '#c2410c', archived: true, createdAt: iso(0), updatedAt: iso(0) },
    ],
    dayItems: [
      { id: 'item_a1', tripId: 'trip_a', date: '2026-03-01', kind: 'transport', title: 'Haruka', lat: 34.9857, lng: 135.7588, order: 10, createdAt: iso(0), updatedAt: iso(0) },
      { id: 'item_b1', tripId: 'trip_b', date: '2026-05-01', kind: 'food', title: 'Kuromon', order: 10, createdAt: iso(0), updatedAt: iso(0) },
    ],
    expenses: [
      { id: 'exp_a1', tripId: 'trip_a', dayItemId: 'item_a1', date: '2026-03-01', amount: 4200, currency: 'JPY', rateToBase: 0.21, baseAmount: 882, category: 'cat-transport', payee: 'Me', createdAt: iso(0), updatedAt: iso(0) },
    ],
    categories: [
      { id: 'cat-transport', kind: 'expense', key: 'transport', label: '交通', color: '#2f7ed8', order: 20, builtin: true },
    ],
    photos: [
      { id: 'photo_a1', tripId: 'trip_a', dayItemId: 'item_a1', width: 1600, height: 900, mime: 'image/jpeg', source: 'commons', artist: 'Someone', license: 'CC BY-SA 4.0', caption: 'Station', createdAt: iso(0), data: bigData, thumbData: bigData },
    ],
    meta: [{ key: 'rates', value: { 'TWD>JPY': 0.21 } }],
  };
}

await waitUp();

console.log('\n— 認證與探索');
await check('health 不需要金鑰', async () => {
  const r = await api('/api/health', { key: '' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.hasData, false);
});
await check('沒有 token → 401', async () => {
  const r = await api('/api/base', { key: '' });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /bearer token/);
});
await check('錯 token → 401', async () => api('/api/base', { key: 'nope' }).then((r) => assert.equal(r.status, 401)));
await check('空資料庫取 base → 404', async () => assert.equal((await api('/api/base')).status, 404));
await check('CORS 白名單', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

console.log('\n— 推送與讀取');
let saved;
await check('POST /api/backup 存整份備份', async () => {
  const r = await api('/api/backup', { method: 'POST', body: fixture() });
  assert.equal(r.status, 200, r.text);
  saved = r.json;
  assert.equal(r.json.trimmedPhotos, 0);
  assert.ok(r.json.bytes > 1000);
});
await check('GET /api/base 回基準（照片無 base64）', async () => {
  const r = await api('/api/base');
  assert.equal(r.status, 200);
  assert.equal(r.json.base.trips.length, 2);
  assert.equal(r.json.base.photos.length, 1);
  assert.equal(r.json.base.photos[0].data, undefined);
  assert.ok(r.json.base.photoBytes > 1000);
  assert.equal(r.json.counts.trip_a.items, 1);
});
await check('GET /api/trips 列表與計數', async () => {
  const r = await api('/api/trips');
  assert.equal(r.json.trips.length, 1, '預設不含已歸檔');
  const all = await api('/api/trips?archived=1');
  assert.equal(all.json.trips.length, 2);
});
await check('GET /api/trips/:id 明細', async () => {
  const r = await api('/api/trips/trip_a');
  assert.equal(r.json.trip.name, 'Kyoto');
  assert.equal(r.json.items.length, 1);
  assert.equal(r.json.expenses.length, 1);
  assert.equal(r.json.photos[0].artist, 'Someone');
});
await check('GET /api/trips/:id/export 含照片', async () => {
  const r = await api('/api/trips/trip_a/export');
  assert.equal(r.json.backup.photos[0].data.length, bigData.length);
  assert.equal(r.json.backup.version, 2);
});
await check('GET /api/summary 統計', async () => {
  const r = await api('/api/summary?tripId=trip_a');
  assert.equal(r.json.totalBase, 882);
  assert.equal(r.json.byPayee.Me, 882);
});
await check('404 找不到的旅行', async () => assert.equal((await api('/api/trips/trip_zzz')).status, 404));

console.log('\n— 合併語意（新者勝、不覆寫）');
await check('POST /api/sync 只送變動部分', async () => {
  const r = await api('/api/sync', {
    method: 'POST',
    body: {
      trips: [{ id: 'trip_a', name: 'Kyoto · autumn', startDate: '2026-03-01', endDate: '2026-03-04', baseCurrency: 'TWD', archived: false, createdAt: iso(0), updatedAt: iso(9) }],
      expenses: [{ id: 'exp_a2', tripId: 'trip_a', date: '2026-03-02', amount: 100, currency: 'TWD', rateToBase: 1, baseAmount: 100, category: 'cat-transport', payee: 'Ana', createdAt: iso(9), updatedAt: iso(9) }],
    },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.merged.trip_a.expenses, 2);
});
await check('較舊的 trip 更新不會蓋掉新的', async () => {
  const r = await api('/api/sync', {
    method: 'POST',
    body: {
      trips: [{ id: 'trip_a', name: 'STALE NAME', startDate: '2026-03-01', endDate: '2026-03-04', baseCurrency: 'TWD', archived: false, createdAt: iso(0), updatedAt: iso(1) }],
    },
  });
  assert.equal(r.status, 200);
  const base = await api('/api/base');
  const trip = base.json.base.trips.find((t) => t.id === 'trip_a');
  assert.equal(trip.name, 'Kyoto · autumn');
});
await check('合併保留兩端的照片與 meta', async () => {
  const base = await api('/api/base');
  assert.equal(base.json.base.photos.length, 1);
  assert.deepEqual(base.json.base.meta.find((m) => m.key === 'rates').value, { 'TWD>JPY': 0.21 });
});
await check('客戶端同一份 merge-core 得到相同結果', async () => {
  const local = fixture();
  local.trips[0].name = 'LOCAL';
  local.trips[0].updatedAt = iso(20);
  const merged = mergeBackupObjects((await api('/api/base')).json.base, local);
  assert.equal(merged.trips.find((t) => t.id === 'trip_a').name, 'LOCAL');
});
await check('拒絕非 TripLog 的 payload', async () => {
  const r = await api('/api/backup', { method: 'POST', body: { hello: 'world' } });
  assert.equal(r.status, 400);
});
await check('拒絕缺少 trips 的 payload', async () => {
  const r = await api('/api/backup', { method: 'POST', body: { format: 'triplog-backup' } });
  assert.equal(r.status, 400);
});

console.log('\n— 照片下載與裁剪');
await check('POST /api/photos/get 依 id 回 base64', async () => {
  const r = await api('/api/photos/get', { method: 'POST', body: { photoIds: ['photo_a1'] } });
  assert.equal(r.json.photos.length, 1);
  assert.equal(r.json.photos[0].data.length, bigData.length);
});
await check('POST /api/photos/get 依 tripIds', async () => {
  const r = await api('/api/photos/get', { method: 'POST', body: { tripIds: ['trip_b'] } });
  assert.equal(r.json.photos.length, 0);
});
await check('超過 120 張照片會被裁掉最舊的', async () => {
  const big = fixture();
  big.photos = Array.from({ length: 130 }, (_, i) => ({
    id: `photo_${i}`,
    tripId: 'trip_a',
    width: 10,
    height: 10,
    mime: 'image/jpeg',
    source: 'device',
    createdAt: iso(i / 1000),
    data: 'data:image/jpeg;base64,' + 'B'.repeat(500),
    thumbData: 'data:image/jpeg;base64,' + 'B'.repeat(120),
  }));
  const r = await api('/api/backup', { method: 'POST', body: big });
  assert.ok(r.json.trimmedPhotos >= 10, `trimmed=${r.json.trimmedPhotos}`);
  // 基準是「所有歷史的並集」，所以可能比單檔上限多幾張（之前推過的 id 還在）
  const base = await api('/api/base');
  assert.ok(base.json.base.photos.length <= 121, `base photos=${base.json.base.photos.length}`);
});
await check('超過大小上限的照片會被裁（只留 metadata）', async () => {
  const fat = 'D'.repeat(20 * 1024 * 1024);
  const huge = fixture();
  huge.photos = [
    { id: 'photo_new', tripId: 'trip_a', createdAt: iso(30), data: `data:image/jpeg;base64,${fat}`, thumbData: 'x' },
    { id: 'photo_old', tripId: 'trip_a', createdAt: iso(1), data: `data:image/jpeg;base64,${fat}`, thumbData: 'x' },
  ];
  const r = await api('/api/backup', { method: 'POST', body: huge });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.trimmedPhotos >= 1, `trimmed=${r.json.trimmedPhotos}`);
});

console.log('\n— 金鑰分級');
await check('read key 讀得到', async () => {
  const r = await api('/api/base', { key: READ });
  assert.equal(r.status, 200);
});
await check('read key 寫不進去', async () => {
  const r = await api('/api/sync', { method: 'POST', key: READ, body: { trips: [] } });
  assert.equal(r.status, 403);
});
await check('clear 需要確認標頭', async () => {
  const r = await api('/api/admin/clear', { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.equal((await api('/api/base')).status, 200, '資料還在');
});

console.log('\n— 歷史與重啟');
await check('保留多份歷史快照', async () => {
  const r = await api('/api/history');
  assert.ok(r.json.snapshots.length >= 4, `snapshots=${r.json.snapshots.length}`);
});
await check('重啟後資料還在', async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  child = boot();
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  await waitUp();
  const r = await api('/api/base');
  assert.equal(r.status, 200);
  assert.ok(r.json.base.trips.some((t) => t.id === 'trip_a'));
});
await check('舊版 snapshot.json 開機搬遷', async () => {
  const legacy = { ...fixture(), trips: [{ id: 'trip_legacy', name: 'Legacy', startDate: '2026-01-01', endDate: '2026-01-02', baseCurrency: 'TWD', archived: false, createdAt: iso(0), updatedAt: iso(0) }], dayItems: [], expenses: [], photos: [], meta: [] };
  writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(legacy));
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  child = boot();
  await waitUp();
  const r = await api('/api/trips?archived=1');
  assert.ok(r.json.trips.some((t) => t.id === 'trip_legacy'), 'legacy trip 應該被搬進基準');
  assert.ok(existsSync(path.join(dir, 'snapshot.json.migrated')));
  assert.ok(!existsSync(path.join(dir, 'snapshot.json')));
});
await check('清空基準（要標頭）', async () => {
  const r = await api('/api/admin/clear', { method: 'POST', body: {}, headers: { 'x-triplog-confirm': 'wipe' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.removed >= 1);
  assert.equal((await api('/api/base')).status, 404);
});

child.kill();
// Windows 上 WAL 檔會多鎖一下，清不掉不影響測試結果
await new Promise((r) => setTimeout(r, 800));
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
} catch (err) {
  console.log(`(cleanup skipped: ${err.code})`);
}
console.log(`\n${passed} 項通過，${failures.length} 項失敗${failures.length ? '：' + failures.join(', ') : ''}`);
if (failures.length) {
  console.log('\n--- server log ---\n' + logs.join(''));
  process.exit(1);
}
