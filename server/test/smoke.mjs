/**
 * 後端冒煙測試：真的把服務跑起來，用 HTTP 打全部端點，驗證
 * 認證、合併、照片裁剪、歷史基準、重啟後仍可讀。
 *
 * 跑法：TRIPLOG_API_KEY=... node server/test/smoke.mjs（自己長一個臨時資料夾與隨機 port）
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
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

/** 跑救援指令列（同進程外的第二條路，走的是同一顆 SQLite），回傳 stdout＋stderr，並檢查結束碼 */
function runCli(args, expectCode = 0) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(here, '..', 'src', 'cli.js'), ...args], {
      env: { ...process.env, TRIPLOG_DATA_DIR: dir, TRIPLOG_API_KEY: KEY, TRIPLOG_READ_KEY: READ },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (out += String(d)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== expectCode) reject(new Error(`cli ${args.join(' ')} 結束碼 ${code}（期望 ${expectCode}）：\n${out}`));
      else resolve(out);
    });
  });
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
await check('內容相同的推送不再佔用一格歷史（只有寫檔時間不同）', async () => {
  const before = (await api('/api/history')).json.snapshots.length;
  const r = await api('/api/backup', { method: 'POST', body: { ...fixture(), exportedAt: iso(2) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.unchanged, true, `unchanged=${r.json.unchanged}`);
  const after = (await api('/api/history')).json.snapshots.length;
  assert.equal(after, before, `歷史從 ${before} 變成 ${after}`);
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

console.log('\n— 分享連結（token 授權，限一趟旅行）');
let shareToken = '';
let survivorToken = '';
let madeByShare = '';
let beforeShared = { expenses: 0, base: 0 };
await check('沒見過的 token：404，而且不用金鑰就能問', async () => {
  const r = await api('/api/share/abcDEF1234567890xyzXYZ--', { key: null });
  assert.equal(r.status, 404);
});
await check('建立連結要金鑰，read key 不夠', async () => {
  assert.equal((await api('/api/shares', { method: 'POST', key: null, body: { tripId: 'trip_a' } })).status, 401);
  assert.equal((await api('/api/shares', { method: 'POST', key: READ, body: { tripId: 'trip_a' } })).status, 403);
});
await check('還沒同步到伺服器的旅行不能分享', async () => {
  const r = await api('/api/shares', { method: 'POST', body: { tripId: 'trip_never_synced' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.need, 'sync');
});
await check('POST /api/shares 產生 22 字 token 與期限', async () => {
  const r = await api('/api/shares', { method: 'POST', body: { tripId: 'trip_a', expiresInDays: 30 } });
  assert.equal(r.status, 200);
  shareToken = r.json.share.token;
  assert.equal(shareToken.length, 22, `token=${shareToken}`);
  assert.equal(r.json.share.tripId, 'trip_a');
  // 標籤預設跟旅行同名（前面的合併測試把它改名成 'Kyoto · autumn' 了）
  const name = (await api('/api/base')).json.base.trips.find((t) => t.id === 'trip_a').name;
  assert.equal(r.json.share.label, name);
  assert.ok(Date.parse(r.json.share.expiresAt) > Date.now(), 'expiresAt 要在未來');
  survivorToken = (await api('/api/shares', { method: 'POST', body: { tripId: 'trip_b', expiresInDays: 0 } })).json.share.token;
});
await check('GET /api/share/:token 只回這一趟，也不帶照片內容', async () => {
  const r = await api(`/api/share/${shareToken}`, { key: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.trip.id, 'trip_a');
  assert.ok(r.json.items.length >= 1 && r.json.items.every((x) => x.tripId === 'trip_a'), '只該看到 trip_a 的行程');
  assert.ok(!r.json.items.some((x) => x.id === 'item_b1'), 'trip_b 的行程項不能漏出去');
  assert.ok(!r.json.expenses.some((e) => e.tripId !== 'trip_a'));
  assert.ok(r.json.categories.some((c) => c.id === 'cat-transport'), '同行者要知道分類叫什麼');
  assert.equal(r.json.photos, undefined, '回應裡不該出現照片欄位');
  beforeShared = { expenses: r.json.expenses.length, base: r.json.totals.baseAmount };
});
await check('分類清單送得完整：內建的讓同行者選得到，沒用過的自訂分類不外送', async () => {
  const seed = await api('/api/sync', {
    method: 'POST',
    body: {
      format: 'triplog-backup',
      trips: [],
      categories: [
        { id: 'cat-food', kind: 'expense', key: 'food', label: '餐飲', color: '#d97706', order: 10, builtin: true },
        { id: 'cat-kid', kind: 'expense', key: 'snack', label: '小孩零食', color: '#9333ea', order: 90, builtin: false },
      ],
    },
  });
  assert.equal(seed.status, 200, '部分文件該能被 sync 吃下');
  const r = await api(`/api/share/${shareToken}`);
  assert.ok(r.json.categories.some((c) => c.id === 'cat-food' && c.builtin === true), '這一趟還沒花過餐飲，但內建分類要選得到');
  assert.ok(!r.json.categories.some((c) => c.id === 'cat-kid'), '跟這趟無關的自訂分類不必給同行者看');
});
await check('同行者記一筆外幣支出：換算與 tripId 都由伺服器算', async () => {
  const r = await api(`/api/share/${shareToken}/expense`, {
    key: null,
    method: 'POST',
    body: { amount: 900, currency: 'jpy', rateToBase: 0.2, date: '2026-03-02', payee: 'ana', category: 'food', note:  '  晚餐   拉麵  ' },
  });
  assert.equal(r.status, 200, r.text);
  const e = r.json.expense;
  assert.equal(e.tripId, 'trip_a', 'tripId 一律用 token 對應的那一趟');
  assert.equal(e.currency, 'JPY');
  assert.equal(e.baseAmount, 180, `baseAmount=${e.baseAmount}`);
  assert.equal(e.payee, 'ana');
  assert.ok(/^exp_/.test(e.id), e.id);
  madeByShare = e.id;
});
await check('同幣別不用填匯率，主幣別金額就是原樣', async () => {
  const r = await api(`/api/share/${shareToken}/expense`, {
    key: null,
    method: 'POST',
    body: { amount: 1500, currency: 'TWD', date: '2026-03-03' },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.expense.rateToBase, 1);
  assert.equal(r.json.expense.baseAmount, 1500);
});
await check('外幣沒填匯率：拒絕，不偷偷用 1:1', async () => {
  const r = await api(`/api/share/${shareToken}/expense`, { key: null, method: 'POST', body: { amount: 500, currency: 'JPY' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /rateToBase/);
});
await check('日期超出行程範圍（含寬容三天）：拒絕', async () => {
  const ok = await api(`/api/share/${shareToken}/item`, { key: null, method: 'POST', body: { title: 'Early', date: '2026-02-26' } });
  assert.equal(ok.status, 200, ok.text);
  const bad = await api(`/api/share/${shareToken}/expense`, { key: null, method: 'POST', body: { amount: 10, date: '2026-12-01' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /date/);
});
await check('行程項要標題、類型範圍外退回 other、座標不完整就整個丟掉', async () => {
  const noTitle = await api(`/api/share/${shareToken}/item`, { key: null, method: 'POST', body: { date: '2026-03-02' } });
  assert.equal(noTitle.status, 400);
  const r = await api(`/api/share/${shareToken}/item`, {
    key: null,
    method: 'POST',
    body: { title: 'Fushimi Inari', kind: 'shrine', date: '2026-03-02', lat: 34.9671, lng: 135.7727, order: 999 },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.item.kind, 'other');
  assert.equal(r.json.item.lat, 34.9671);
  const half = await api(`/api/share/${shareToken}/item`, {
    key: null,
    method: 'POST',
    body: { title: 'No coords', date: '2026-03-02', lat: 12.3 },
  });
  assert.equal(half.json.item.lat, null);
});
await check('掛到別的趟的行程項：拒絕', async () => {
  const r = await api(`/api/share/${shareToken}/expense`, {
    key: null,
    method: 'POST',
    body: { amount: 100, date: '2026-03-02', dayItemId: 'item_b1' },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /dayItemId/);
});
await check('用別的趟的 id 覆寫：403', async () => {
  const r = await api(`/api/share/${shareToken}/item`, {
    key: null,
    method: 'POST',
    body: { id: 'item_b1', title: 'Hijacked', date: '2026-03-02' },
  });
  assert.equal(r.status, 403, r.text);
});
await check('同行者寫的會進基準檔，擁有者下次同步讀得到', async () => {
  const r = await api('/api/base');
  assert.equal(r.status, 200);
  const mine = r.json.base.expenses.find((e) => e.id === madeByShare);
  assert.ok(mine, '基準檔裡找不到那筆支出');
  assert.equal(mine.tripId, 'trip_a');
  assert.equal(mine.payee, 'ana');
  const shared = await api(`/api/share/${shareToken}`, { key: null });
  // 這一趟在之前的合併測試裡就有支出了，所以用增量而不是絕對值來驗
  assert.equal(shared.json.expenses.length, beforeShared.expenses + 2, `expenses=${shared.json.expenses.length}`);
  assert.equal(shared.json.totals.expenses, beforeShared.expenses + 2);
  assert.equal(shared.json.totals.baseAmount, Math.round((beforeShared.base + 180 + 1500) * 100) / 100);
});
await check('GET /api/shares 列出連結與開過/寫過的次數', async () => {
  const r = await api('/api/shares?tripId=trip_a');
  assert.equal(r.status, 200);
  const row = r.json.shares.find((s) => s.token === shareToken);
  assert.ok(row && row.hits >= 2, `hits=${row?.hits}`);
  assert.ok(row.writes >= 4, `writes=${row?.writes}`);
  assert.ok(r.json.shares.every((s) => s.tripId === 'trip_a'), 'tripId 過濾要準');
});
await check('沒金鑰不能管理連結', async () => {
  const r = await api('/api/shares/revoke', { key: null, method: 'POST', body: { token: shareToken } });
  assert.equal(r.status, 401);
});
await check('作廢後立刻讀不到（410），而且重試也不會復活', async () => {
  assert.equal((await api('/api/shares/revoke', { method: 'POST', body: { token: shareToken } })).status, 200);
  assert.equal((await api(`/api/share/${shareToken}`, { key: null })).status, 410);
  assert.equal((await api(`/api/share/${shareToken}/expense`, { key: null, method: 'POST', body: { amount: 1 } })).status, 410);
  const again = await api('/api/shares/revoke', { method: 'POST', body: { token: shareToken } });
  assert.equal(again.status, 200);
  assert.equal(again.json.changed, false, '第二次沒有真的改到東西');
});
await check('期限與生死的純函式', async () => {
  const { shareStatus: st, expiresAtFrom, partialOf: partial } = await import(pathToFileURL(path.join(here, '..', 'src', 'share.js')).href);
  assert.equal(st({ createdAt: iso(0) }).live, true, '沒設期限就長長久久');
  assert.equal(st({ expiresAt: iso(-1) }).live, false);
  assert.equal(st({ expiresAt: iso(-1), revokedAt: iso(0) }).reason, 'revoked', '作廢比過期優先講');
  assert.equal(st({ expiresAt: iso(1), revokedAt: iso(0) }).reason, 'revoked');
  assert.equal(expiresAtFrom(0), null);
  assert.equal(expiresAtFrom('never'), null);
  assert.ok(expiresAtFrom(undefined) > new Date().toISOString(), '不給值就預設 90 天');
  assert.throws(() => expiresAtFrom(9999), /365/);
  assert.deepEqual(Object.keys(partial('expenses', { id: 'exp_x' })), [
    'format', 'version', 'exportedAt', 'trips', 'dayItems', 'expenses', 'categories', 'photos', 'meta',
  ]);
  assert.equal(partial('dayItems', { id: 'item_x' }).expenses.length, 0);
});
await check('API token 的純函式：形勢判斷、層級、生死', async () => {
  const { newApiToken, hashToken, looksLikeApiToken, scopeAllows, tokenStatus: ts, tokenLabel } = await import(
    pathToFileURL(path.join(here, '..', 'src', 'tokens.js')).href
  );
  const a = newApiToken();
  const b = newApiToken();
  assert.ok(a.token.startsWith('tlk_') && a.token !== b.token, '每枚都要不一樣');
  assert.ok(a.hint.startsWith('tlk_') && a.hint.length < a.token.length, 'hint 要比原字串短');
  assert.ok(a.hint !== a.token && !a.hint.includes(a.token.slice(8, 20)), 'hint 不能拼回原字串');
  assert.equal(hashToken(a.token), a.hash);
  assert.notEqual(hashToken(b.token), a.hash);
  // 主金鑰與其他來源的字串不該去查資料庫
  assert.equal(looksLikeApiToken('smoke-write-key-0123456789abcdef'), false);
  assert.equal(looksLikeApiToken(''), false);
  assert.equal(looksLikeApiToken(a.token), true);
  assert.equal(scopeAllows('write', 'write'), true);
  assert.equal(scopeAllows('read', 'write'), false);
  assert.equal(scopeAllows('read', 'read'), true);
  assert.equal(ts({ createdAt: iso(0) }).live, true);
  assert.equal(ts({ expiresAt: iso(-1) }).live, false);
  assert.equal(ts({ expiresAt: iso(-1), revokedAt: iso(0) }).reason, 'revoked');
  assert.equal(tokenLabel('  agent\ncurl ', '未命名'), 'agent curl', '標籤要清掉控制字元');
  assert.equal(tokenLabel('   '), '未命名');
  assert.equal(tokenLabel('x'.repeat(200)).length, 60);
});
await check('沒被作廢的另一把連結還活著', async () => {
  const r = await api(`/api/share/${survivorToken}`, { key: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.trip.id, 'trip_b');
});

console.log('\n— API token 簽發（可撤銷的 bearer）');
let readToken = '';
let writeToken = '';
let readRow = null;
await check('主金鑰能簽一枚唯讀 token，原字串只出現在簽發回應裡', async () => {
  const r = await api('/api/tokens', { method: 'POST', body: { label: '唯讀 agent', scope: 'read', expiresInDays: 30 } });
  assert.equal(r.status, 200, r.text);
  readToken = String(r.json.secret ?? '');
  readRow = r.json.token;
  assert.ok(readToken.startsWith('tlk_') && readToken.length >= 30, `secret=${readToken.slice(0, 8)}`);
  assert.equal(readRow.scope, 'read');
  assert.equal(readRow.label, '唯讀 agent');
  assert.ok(readRow.expiresAt && Date.parse(readRow.expiresAt) > Date.now());
  assert.ok(!JSON.stringify(readRow).includes(readToken), '除了 secret 那一個欄位，清單結構不該再帶原字串');
});
await check('清單顯示 hint 而不是可用的憑證', async () => {
  const r = await api('/api/tokens');
  assert.equal(r.status, 200);
  const row = r.json.tokens.find((x) => x.id === readRow.id);
  assert.ok(row.hint.includes('tlk_') && row.hint.includes('…'), `hint=${row.hint}`);
  assert.ok(!('tokenHash' in row) && !('token_hash' in row), '雜湊不該出現在回應裡');
});
await check('唯讀 token 讀得到基準檔', async () => {
  const r = await api('/api/base', { key: readToken });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.base.trips.some((t) => t.id === 'trip_a'));
});
await check('唯讀 token 寫不進去（403，而且要講清楚要主金鑰）', async () => {
  const r = await api('/api/sync', { method: 'POST', key: readToken, body: { ...fixture(), trips: [], expenses: [] } });
  assert.equal(r.status, 403, r.text);
  assert.match(String(r.json.error), /TRIPLOG_API_KEY/);
});
await check('可寫 token 推得動部分文件', async () => {
  const mint = await api('/api/tokens', { method: 'POST', body: { label: '手機', scope: 'write', expiresInDays: 'never' } });
  assert.equal(mint.status, 200, mint.text);
  writeToken = String(mint.json.secret);
  assert.equal(mint.json.token.expiresAt, null, 'never 應該是不設限期');
  const push = await api('/api/sync', {
    method: 'POST',
    key: writeToken,
    body: { format: 'triplog-backup', version: 1, trips: [], dayItems: [{ id: 'item_tok1', tripId: 'trip_a', date: '2026-03-02', kind: 'sight', title: 'By token', order: 20, createdAt: iso(2), updatedAt: iso(2) }], expenses: [], categories: [], photos: [] },
  });
  assert.equal(push.status, 200, push.text);
  assert.ok((await api('/api/base')).json.base.dayItems.some((i) => i.id === 'item_tok1'));
});
await check('簽發出去的 token 不能發照，也不能清空伺服器', async () => {
  const mint = await api('/api/tokens', { method: 'POST', key: writeToken, body: { scope: 'write' } });
  assert.equal(mint.status, 403, mint.text);
  const list = await api('/api/tokens', { key: writeToken });
  assert.equal(list.status, 403, '唯讀清單也要擋：名單本身是情報');
  const wipe = await api('/api/admin/clear', { method: 'POST', key: writeToken, body: {}, headers: { 'x-triplog-confirm': 'wipe' } });
  assert.equal(wipe.status, 403, wipe.text);
});
await check('期限參數亂給會被擋', async () => {
  const r = await api('/api/tokens', { method: 'POST', body: { expiresInDays: 9999 } });
  assert.equal(r.status, 400, r.text);
});
await check('作廢某一把只壞那一把', async () => {
  const rev = await api('/api/tokens/revoke', { method: 'POST', body: { id: readRow.id } });
  assert.equal(rev.status, 200, rev.text);
  assert.equal(rev.json.changed, true);
  assert.ok(rev.json.token.revokedAt);
  assert.equal((await api('/api/base', { key: readToken })).status, 401, '作廢後應該立刻進不去');
  assert.equal((await api('/api/base', { key: writeToken })).status, 200, '別把另一個也弄壞了');
  assert.equal((await api('/api/base', { key: KEY })).status, 200, '主金鑰不受影響');
  const again = await api('/api/tokens/revoke', { method: 'POST', body: { id: readRow.id } });
  assert.equal(again.json.changed, false, '重複作廢不該報錯，也不能假稱改動過');
});
await check('使用狀況會被記下來', async () => {
  const rows = (await api('/api/tokens')).json.tokens;
  const revoked = rows.find((x) => x.id === readRow.id);
  const phone = rows.find((x) => x.label === '手機');
  assert.ok(revoked.hits >= 1, `hits=${revoked.hits}`);
  assert.ok(phone.writes >= 1, `writes=${phone.writes}`);
  assert.ok(phone.lastSeenAt, '用過就要有最後使用時間');
});

console.log('\n— 配對碼（新裝置免貼長金鑰）');
const keys = await import(pathToFileURL(path.join(here, '..', 'src', 'keys.js')).href);

await check('配對碼的純函式：形狀、正規化、生死', () => {
  const m = keys.newPairingCode();
  assert.equal(m.code.length, 8);
  assert.match(m.display, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(keys.normalizeCode(m.display), m.code, '橫線要能打、可打可不打');
  assert.equal(keys.normalizeCode(` ${m.code.toLowerCase()} `), m.code, '大小寫與空白都要吃掉');
  assert.notEqual(m.hash, m.code, '進資料庫的是雜湊');
  assert.equal(keys.hashSecret(m.code), m.hash, '同一組碼每次雜湊一致（查得到）');
  assert.equal(keys.normalizeCode('ABC'), null, '太短');
  assert.equal(keys.normalizeCode('ABCD-ILO0'), null, '字母表以外的字（I/L/O/0）不算輸入錯誤那麼便宜');
  assert.equal(keys.normalizeCode(null), null);
  assert.equal(keys.pairExpiresAt(10, Date.parse('2026-01-01T00:00:00Z')), '2026-01-01T00:10:00.000Z');
  assert.equal(keys.pairExpiresAt(9999).slice(0, 10), new Date().toISOString().slice(0, 10), '超長要夾到上限，不能變成永久');
  assert.throws(() => keys.pairExpiresAt(0), /expiresInMinutes/);
  assert.equal(keys.pairingStatus({ usedAt: 'x', expiresAt: '2000-01-01T00:00:00Z' }).reason, 'used', '用掉要講「用過」，不是「過期」');
  assert.equal(keys.pairingStatus({ revokedAt: 'x', expiresAt: '2999-01-01T00:00:00Z' }).reason, 'revoked');
  assert.equal(keys.pairingStatus({ expiresAt: '2000-01-01T00:00:00Z' }).reason, 'expired');
  assert.equal(keys.pairingStatus({ expiresAt: '2999-01-01T00:00:00Z' }).live, true);
  assert.equal(keys.matchesHash(keys.newMasterKey().key, keys.hashSecret('nope')), false);
});

let pairCode = '';
await check('主金鑰能產生配對碼，原字串只在產生時出現一次', async () => {
  const r = await api('/api/tokens/pairings', { method: 'POST', body: { label: '小美的手機', scope: 'write', expiresInMinutes: 30 } });
  assert.equal(r.status, 200, r.text);
  pairCode = r.json.code;
  assert.equal(r.json.pairing.label, '小美的手機');
  assert.equal(r.json.pairing.scope, 'write');
  assert.ok(r.json.display.includes('-'));
  assert.ok(!JSON.stringify(r.json.pairing).includes(pairCode), '清單用的那列不能含原字串');
  assert.ok(Date.parse(r.json.pairing.expiresAt) > Date.now() + 25 * 60_000);
});

await check('配對碼換憑證：不用 bearer，換出來的憑證能立刻用', async () => {
  const r = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode.toLowerCase(), device: '小美 iPhone' }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const j = JSON.parse(text);
  assert.ok(j.secret.startsWith('tlk_'), j.secret.slice(0, 4));
  assert.equal(j.token.scope, 'write');
  assert.ok(j.token.label.includes('小美的手機') && j.token.label.includes('小美 iPhone'), '清單上要看得出是哪台');
  assert.ok(!JSON.stringify(j.token).includes(j.secret), '列內部只留 hint');
  // 這把憑證真的能當 bearer 用
  assert.equal((await api('/api/base', { key: j.secret })).status, 200);
});

await check('配對碼是一次性的：同一組再用得到 409', async () => {
  const r = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /一次性/);
});

await check('配對清單標出用過與沒用過，而且看不到任何原字串', async () => {
  const rows = (await api('/api/tokens/pairings')).json.pairings;
  const used = rows.find((p) => p.label === '小美的手機');
  assert.ok(used.usedAt, '用掉要蓋時間');
  assert.match(used.usedLabel, /小美 iPhone/);
  assert.ok(!JSON.stringify(rows).includes(pairCode));
  assert.ok(!JSON.stringify(rows).includes('code_hash'));
});

await check('亂碼：形狀不對 400，對但沒這組 404', async () => {
  const bad = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ABCD' }),
  });
  assert.equal(bad.status, 400);
  const ghost = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ZZZZZZZZ' }),
  });
  assert.equal(ghost.status, 404);
});

await check('作廢中的配對碼：產生→作廢→打過去 410', async () => {
  const made = await api('/api/tokens/pairings', { method: 'POST', body: { label: '筆電' } });
  const code = made.json.code;
  const rev = await api('/api/tokens/pairings/revoke', { method: 'POST', body: { id: made.json.pairing.id } });
  assert.equal(rev.status, 200, rev.text);
  assert.equal(rev.json.changed, true);
  const r = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(r.status, 410);
  assert.match((await r.json()).error, /作廢/);
});

await check('過期的配對碼：410，訊息要教人重做一次', async () => {
  const made = await api('/api/tokens/pairings', { method: 'POST', body: { label: '借來的平板', expiresInMinutes: 30 } });
  // 過期只能靠時間，測試不等一分鐘：直接把那列的 expires_at 改到過去（同一顆 SQLite，WAL 容許第二個連線）
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'triplog.db'));
  raw.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), made.json.pairing.id);
  raw.close();
  const r = await fetch(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: made.json.code }),
  });
  assert.equal(r.status, 410);
  const j = await r.json();
  assert.equal(j.reason, 'expired');
  assert.match(j.error, /再產生一組/);
});

await check('配對與憑證管理只認主金鑰', async () => {
  for (const p of ['/api/tokens/pairings', '/api/tokens/master']) {
    assert.equal((await api(p, { key: READ })).status, 403, `${p} 不該讓只讀金鑰看`);
    assert.equal((await api(p, { key: writeToken })).status, 403, `${p} 不該讓簽發出去的 token 看`);
    assert.equal((await api(p, { key: null })).status, 401, `${p} 沒金鑰先 401`);
  }
  const mint = await api('/api/tokens/pairings', { method: 'POST', key: writeToken, body: { label: 'nope' } });
  assert.equal(mint.status, 403, 'token 不能自己發配對碼');
});

await check('主金鑰狀態：尚未輪換時講得清清楚楚', async () => {
  const r = await api('/api/tokens/master');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.master.rotated, false);
  assert.equal(r.json.master.bootstrapKeyActive, true);
  assert.ok(r.json.master.hint.includes('…'), '只給 hint');
  assert.equal(r.json.master.maxExpiryDays, 365);
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
await check('重啟後簽發過的 token 還能用（授權與資料一起存在 SQLite）', async () => {
  const r = await api('/api/base', { key: writeToken });
  assert.equal(r.status, 200, r.text);
  assert.equal((await api('/api/base', { key: readToken })).status, 401, '作廢的還是作廢');
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

console.log('\n— 主金鑰輪換（把 .env 那把關在門外）');
// 基準檔剛被清掉，/api/base 是 404；這裡只問「金鑰過得去嗎」，所以打一個一定要金鑰、但回 200 的讀端點
const probe = (key) => api('/api/trips?archived=1', key === undefined ? { key: null } : { key });
let master2 = '';

await check('沒確認不動鑰：confirm 缺失或寫錯都退回 400，舊鑰照樣能用', async () => {
  const r = await api('/api/tokens/master/rotate', { method: 'POST', body: {} });
  assert.equal(r.status, 400, r.text);
  const wrong = await api('/api/tokens/master/rotate', { method: 'POST', body: { confirm: 'yes' } });
  assert.equal(wrong.status, 400, 'confirm 要寫對字，不能隨便給一個 truthy');
  assert.equal((await probe(KEY)).status, 200, '輪換沒成功，.env 那把必須還能用');
});

let rescue = '';
let master1 = '';
await check('輪換後舊主金鑰與只讀鑰立刻失效，但簽發過的憑證繼續能用', async () => {
  const mint = await api('/api/tokens', { method: 'POST', body: { label: '救援用', scope: 'write', expiresInDays: 30 } });
  assert.equal(mint.status, 200, mint.text);
  rescue = mint.json.secret;
  const r = await api('/api/tokens/master/rotate', { method: 'POST', body: { confirm: 'rotate-master' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.master.liveTokens >= 1, '換鑰前要先數一數還有沒有活口');
  assert.ok(r.json.secret.startsWith('tlm_'), r.json.secret.slice(0, 4));
  assert.match(r.json.master.hint, /…/, '回應裡也要是 hint');
  assert.equal(JSON.stringify(r.json).includes(rescue), false, '不該把別人的憑證一起帶出來');
  master1 = r.json.secret;
  assert.equal((await probe(KEY)).status, 401, '.env 的主金鑰要立刻擋掉');
  assert.equal((await probe(READ)).status, 401, '只讀鑰也一起擋：輪換是整個重來');
  assert.equal((await probe(rescue)).status, 200, 'app 簽出來的憑證不受輪換影響');
  assert.equal((await probe(master1)).status, 200, '新主金鑰能用');
  assert.equal((await api('/api/tokens', { key: master1 })).status, 200, '新主金鑰還是主金鑰');
  const health = await fetch(`${BASE}/api/health`);
  assert.equal((await health.json()).masterRotated, true, 'health 要讓人自查這一台換過沒有');
  const st = await api('/api/tokens/master', { key: master1 });
  assert.equal(st.json.master.rotated, true);
  assert.equal(st.json.master.bootstrapKeyActive, false);
  assert.equal(JSON.stringify(st.json).includes(master1), false, '狀態回應不能把金鑰帶出去');
});

await check('一把生效憑證都沒有時先擋自鎖；硬要換就送無備份確認', async () => {
  const rows = (await api('/api/tokens', { key: master1 })).json.tokens;
  for (const row of rows) {
    if (!row.revokedAt && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now())) {
      const rev = await api('/api/tokens/revoke', { method: 'POST', key: master1, body: { id: row.id } });
      assert.equal(rev.status, 200, rev.text);
    }
  }
  const blocked = await api('/api/tokens/master/rotate', { method: 'POST', key: master1, body: { confirm: 'rotate-master' } });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json.liveTokens, 0);
  assert.match(blocked.json.error, /沒有任何生效中的憑證/);
  const again = await probe(master1);
  assert.equal(again.status, 200, '被擋下來時鑰不能壞掉');
  const forced = await api('/api/tokens/master/rotate', { method: 'POST', key: master1, body: { confirm: 'rotate-master-no-backup' } });
  assert.equal(forced.status, 200, forced.text);
  assert.equal(forced.json.master.liveTokens, 0);
  assert.ok(forced.json.secret.startsWith('tlm_'));
  assert.equal((await probe(master1)).status, 401, '上一把主金鑰也一起失效');
  assert.equal((await probe(forced.json.secret)).status, 200);
  master2 = forced.json.secret;
});

await check('重啟後輪換鎖還在（資料庫才是主金鑰的依據）', async () => {
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  child = boot();
  child.stdout.on('data', (d) => logs.push(String(d)));
  await waitUp();
  assert.equal((await probe(master2)).status, 200);
  assert.equal((await probe(KEY)).status, 401, '重啟不能把 .env 那把找回來');
});

await check('SSH 救援：cli.js master-reset 讓 .env 那把重回門內', async () => {
  const out = await runCli(['status']);
  assert.match(out, /已輪換/, 'status 要看得出換過');
  assert.equal(out.includes(master2), false, '指令列不能印出完整金鑰');
  const reset = await runCli(['master-reset', '--yes']);
  assert.match(reset, /已解掉輪換鎖/);
  assert.equal((await probe(KEY)).status, 200, '解鎖後 .env 那把重新被接受');
  assert.equal((await probe(master2)).status, 401, '輪換鑰就此失效');
  assert.equal((await api('/api/tokens/master')).json.master.rotated, false);
  assert.equal((await probe(READ)).status, 200, '只讀鑰也跟著回來');
  const nothing = await runCli(['master-reset', '--yes'], 1);
  assert.match(nothing, /沒有輪換鎖/, '沒鎖的時候要拒絕，不要假裝成功');
});

/* ============================================================ 帳號模式
 * 上面跑的都是「金鑰＝單一基準」的既有行為；這一段把同一顆 SQLite 換成
 * TRIPLOG_AUTH=1 重新開機，驗證 Google 登入、每人一份帳本，以及登入不過時
 * 各種壞 token 都要被擋在門外。
 *
 * Google 的公開金鑰在這裡是本地假的金鑰（自己生 RSA、自己開一個 JWKS 端點），
 * 但走的是同一條程式碼路徑：只是用 TRIPLOG_GOOGLE_JWKS_URL 把網址換掉，
 * 產線用的網址與驗簽邏輯一行都沒改。
 * ====================================================================== */

const AUTH_PORT = PORT + 100;
const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
const JWKS_PORT = PORT + 200;
const CLIENT_ID = 'smoke-client.apps.googleusercontent.com';

/** 兩把 RSA 私鑰：第二把用來模擬 Google 輪換 kid（快取裡沒有時要重抓） */
const jwtKeys = [0, 1].map(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) };
});
const KID = (i) => `smoke-key-${i}`;
let servedKeys = [0];

const jwksServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: servedKeys.map((i) => ({ kid: KID(i), use: 'sig', alg: 'RS256', ...jwtKeys[i].jwk })) }));
});
await new Promise((r) => jwksServer.listen(JWKS_PORT, '127.0.0.1', r));

function idToken(claims, { kid = KID(0), keyIndex = 0, aud = CLIENT_ID, iss = 'https://accounts.google.com' } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss, aud, iat: now - 60, exp: now + 3600, email_verified: true, locale: 'zh-Hant', ...claims });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`, 'ascii'), jwtKeys[keyIndex].privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function authBoot({ port = AUTH_PORT, rate = '500' } = {}) {
  const p = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TRIPLOG_API_KEY: KEY,
      TRIPLOG_READ_KEY: READ,
      TRIPLOG_DATA_DIR: dir,
      PORT: String(port),
      TRIPLOG_AUTH: '1',
      // 這一段每個檢查都要登入一兩次，用預設的 12/分鐘會先打到限流而不是測到功能
      TRIPLOG_RATE_AUTH: rate,
      TRIPLOG_GOOGLE_CLIENT_ID: CLIENT_ID,
      TRIPLOG_GOOGLE_JWKS_URL: `http://127.0.0.1:${JWKS_PORT}/certs`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => logs.push(String(d)));
  p.stderr.on('data', (d) => logs.push(String(d)));
  return p;
}

/** 等某一個 port 起來（既有 waitUp 只認 BASE） */
async function waitUpAt(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server 沒起來：${base}\n${logs.join('')}`);
}

async function hit(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  return { status: res.status, json, text };
}

/** 登入並回 session；測試裡每個帳號都真的走一次 Google 驗簽，不是塞假 id */
async function login(claims, opts) {
  const r = await hit(AUTH_BASE, '/api/auth/google', { method: 'POST', body: { idToken: idToken(claims, opts), device: '冒煙測試' } });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  return r.json;
}

// 先在舊的那份基準裡留一趟旅行，才看得到「認領」有沒有發生
const legacy = await api('/api/backup', { method: 'POST', body: { ...fixture(), exportedAt: iso(30) } });
assert.equal(legacy.status, 200, legacy.text);

child.kill();
await new Promise((r) => setTimeout(r, 500));
child = authBoot();
await waitUpAt(AUTH_BASE);
const A2 = (...a) => hit(AUTH_BASE, ...a);
/** 後面好幾個檢查都要用同一組 session，所以放在外層 */
let sessionA = '';
let sessionB = '';

console.log('\n— 帳號模式（Google 登入＋每人一份帳本）');

await check('沒帶任何憑證時直接講「請先用 Google 登入」，不講金鑰那套話', async () => {
  const cfg = await A2('/api/auth/config');
  assert.equal(cfg.status, 200, cfg.text);
  assert.equal(cfg.json.mode, 'account');
  assert.equal(cfg.json.clientId, CLIENT_ID, '前端要知道該拿哪個 Client ID 叫 Google 的腳本');
  assert.equal(cfg.json.sessionDays, 30);
  const denied = await A2('/api/base');
  assert.equal(denied.status, 401, denied.text);
  assert.equal(denied.json.login, true);
  assert.equal(denied.json.reason, 'no-credential');
  assert.match(denied.json.error, /Google/);
  const me = await A2('/api/me');
  assert.equal(me.status, 401, me.text);
});

await check('Google ID token 換到 session，第一次登入把舊基準認領過來', async () => {
  const r = await login({ sub: '112233445566778899001', email: 'Ana@Example.com', name: '安娜', picture: 'https://example.com/a.png' });
  assert.match(r.token, /^tls_/, `session 前綴不對：${r.token}`);
  assert.equal(r.created, true);
  assert.equal(r.user.email, 'ana@example.com', '信箱一律洗成小寫，邀請才對得上');
  assert.equal(r.user.name, '安娜');
  assert.equal(r.user.id.startsWith('u_'), true);
  assert.equal(r.user.googleSub, undefined, '回應不要把 Google 的 sub 傳出去');
  sessionA = r.token;
  const base = await A2('/api/base', { token: r.token });
  assert.equal(base.status, 200, base.text);
  assert.ok(base.json.base.trips.some((t) => t.id === 'trip_a'), '舊資料要跟著人走，不能一登入就變空帳本');
  const me = await A2('/api/me', { token: r.token });
  assert.equal(me.json.user.id, r.user.id, me.text);
});

await check('認領之後，金鑰那條路不再看得到這個人的帳本', async () => {
  const gone = await A2('/api/base', { token: KEY });
  assert.equal(gone.status, 404, `基準已被認領，金鑰不該還看得到：${gone.status} ${gone.text}`);
  const admin = await A2('/api/tokens', { token: KEY });
  assert.equal(admin.status, 200, admin.text);
  assert.ok(Array.isArray(admin.json.tokens), '主金鑰仍保有管理端點（救援用）');
});

await check('第二個帳號有自己的空帳本，寫進去的東西不會出現別人的清單上', async () => {
  const b = await login({ sub: '998877665544332211009', email: 'bo@example.com', name: 'Bo' });
  sessionB = b.token;
  const empty = await A2('/api/base', { token: b.token });
  assert.equal(empty.status, 404, '新帳號不該看到 Ana 的資料');
  const push = await A2('/api/backup', { method: 'POST', token: b.token, body: { format: 'triplog-backup', exportedAt: iso(31), trips: [{ id: 'trip_z', name: 'Bo 的祕密行程', startDate: '2026-06-01', endDate: '2026-06-02', updatedAt: iso(31), createdAt: iso(31) }], dayItems: [], expenses: [], categories: [], photos: [], meta: [] } });
  assert.equal(push.status, 200, push.text);
  const mineB = await A2('/api/trips', { token: b.token });
  assert.deepEqual(mineB.json.trips.map((t) => t.id), ['trip_z'], mineB.text);
  const mineA = await A2('/api/trips', { token: sessionA });
  assert.equal(mineA.json.trips.some((t) => t.id === 'trip_z'), false, '跨帳號看到了別人的行程');
  assert.ok(mineA.json.trips.some((t) => t.id === 'trip_a'), mineA.text);
});

await check('同一個 Google 帳號再登入不會生出第二個帳本，也不會多一個 people 列', async () => {
  const again = await login({ sub: '112233445566778899001', email: 'ana@example.com', name: '安娜改的名' });
  assert.equal(again.created, false);
  assert.equal(again.user.id, (await A2('/api/me', { token: sessionA })).json.user.id, '同一個 sub 必須落在同一個帳號 id');
  assert.equal(again.user.name, '安娜改的名', '顯示名要跟著 Google 更新');
  const trips = await A2('/api/trips', { token: again.token });
  assert.ok(trips.json.trips.some((t) => t.id === 'trip_a'), '重新登入後還是要看得到自己的資料');
  const health = await A2('/api/health');
  assert.equal(health.json.auth.mode, 'account');
  assert.equal(health.json.users, 2, `不該多出第三個帳號：${JSON.stringify(health.json.users)}`);
});

await check('壞掉的 ID token 一律進不來：簽章、aud、iss、過期、alg none、亂塞', async () => {
  const good = { sub: '556677889900112233445', email: 'eve@example.com' };
  const tampered = (() => {
    const t = idToken(good);
    const [h, b, s] = t.split('.');
    const flipped = s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA');
    return `${h}.${b}.${flipped}`;
  })();
  const cases = [
    [tampered, 401, /簽章/],
    [idToken(good, { aud: 'someone-else.example' }), 401, /不是發給這個應用/],
    [idToken(good, { iss: 'https://evil.example.com' }), 401, /不是 Google 簽發/],
    [idToken({ ...good, exp: Math.floor(Date.now() / 1000) - 3600 }), 401, /已過期/],
    [idToken({ ...good, email_verified: false }), 403, /尚未驗證/],
    [idToken({ ...good, sub: '短' }), 401, /識別碼/],
    ['not-a-jwt', 400, /ID token|JWT|格式/],
    [`${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID(0) })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...good, iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.`, 401, /RS256/],
  ];
  for (const [token, status, re] of cases) {
    const r = await A2('/api/auth/google', { method: 'POST', body: { idToken: token } });
    assert.equal(r.status, status, `${String(token).slice(0, 24)}… → ${r.status} ${r.text}`);
    assert.match(r.json.error, re, r.text);
    assert.equal(r.json.login, true, '登入失敗要帶著 login 旗號，前端才知道要顯示登入鈕');
  }
  const noClient = await A2('/api/auth/google', { method: 'POST', body: {} });
  assert.equal(noClient.status, 400, noClient.text);
  const noEmail = await A2('/api/auth/google', { method: 'POST', body: { idToken: idToken({ sub: '112233445566778899007' }) } });
  assert.equal(noEmail.status, 400, noEmail.text);
  assert.match(noEmail.json.error, /信箱/);
});

await check('Google 輪換 kid：快取裡沒有這把時重抓一次，登入照樣過', async () => {
  servedKeys = [0, 1];
  const r = await login({ sub: '334455667788990011223', email: 'kid@example.com' }, { kid: KID(1), keyIndex: 1 });
  assert.match(r.token, /^tls_/);
  const gone = await A2('/api/auth/google', { method: 'POST', body: { idToken: idToken({ sub: '334455667788990011224', email: 'ghost@example.com' }, { kid: 'unknown-kid', keyIndex: 1 }) } });
  assert.equal(gone.status, 401, gone.text);
  assert.match(gone.json.error, /公鑰/, '查無公鑰要講得跟簽章錯不一樣');
});

await check('登出只斷這一條 session，其他裝置照常用', async () => {
  // 同一個帳號在「另一台裝置」上再登一次，才能看出登出是不是只斷手上這條
  await login({ sub: '998877665544332211009', email: 'bo@example.com', name: 'Bo' });
  const list = await A2('/api/auth/sessions', { token: sessionB });
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.sessions.length >= 2, `B 應該有兩條登入紀錄：${list.text}`);
  assert.equal(list.json.sessions[0].sessionHash, undefined, '清單不能出現雜湊');
  assert.equal(JSON.stringify(list.json).includes('tls_'), false, '回應裡不能出現任何完整 token');
  const mine = list.json.sessions[0];
  const out = await A2('/api/auth/logout', { method: 'POST', token: sessionB });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.revoked, true);
  const dead = await A2('/api/base', { token: sessionB });
  assert.equal(dead.status, 401, dead.text);
  assert.equal(dead.json.reason, 'revoked-session');
  const other = await login({ sub: '998877665544332211009', email: 'bo@example.com', name: 'Bo' });
  const stillWorks = await A2('/api/trips', { token: other.token });
  assert.equal(stillWorks.status, 200, stillWorks.text);
  assert.deepEqual(stillWorks.json.trips.map((t) => t.id), ['trip_z'], '新 login 的 session 要看得到 B 自己的帳本');
  const revokeOther = await A2('/api/auth/sessions/revoke', { method: 'POST', token: other.token, body: { allExceptThis: true } });
  assert.equal(revokeOther.status, 200, revokeOther.text);
  assert.ok(revokeOther.json.removed >= 1);
  const after = await A2('/api/auth/sessions', { token: other.token });
  assert.equal(after.json.sessions.filter((s) => !s.revokedAt).length, 1, '退出其他裝置後只剩手上這條');
  const gone2 = await A2('/api/base', { token: sessionB });
  assert.equal(gone2.status, 401, '已登出的那條不能因為別人重新登入就活回來');
  const stolen = await A2('/api/auth/sessions/revoke', { method: 'POST', token: sessionA, body: { id: after.json.sessions[0].id } });
  assert.equal(stolen.status, 404, '不能撤銷別人的 session');
});

await check('Google 的公鑰抓不到時是 502，絕不當成登入成功', async () => {
  servedKeys = [0, 1];
  const before = await login({ sub: '445566778899001122334', email: 'up@example.com' });
  assert.match(before.token, /^tls_/);
  jwksServer.close();
  await new Promise((r) => setTimeout(r, 200));
  const down = await A2('/api/auth/google', {
    method: 'POST',
    // 快取裡沒這個 kid，一定要出門抓公鑰才會知道伺服器掛了
    body: { idToken: idToken({ sub: '445566778899001122335', email: 'down@example.com' }, { kid: 'brand-new-kid' }) },
  });
  assert.equal(down.status, 502, down.text);
  assert.match(down.json.error, /公鑰/);
  const stillIn = await A2('/api/trips', { token: sessionA });
  assert.equal(stillIn.status, 200, 'Google 掛了不該把已登入的裝置一起擋在門外');
  const h = await A2('/api/health');
  assert.equal(h.status, 200, '抓不到公鑰不能把整個服務拖下水');
});

await check('登入限流：打爆就 429，而且發不出 token，已登入的裝置不受影響', async () => {
  // 另開一台（獨立的空資料夾）專測限流：預設那台給了 500/分鐘，功能檢查才不會先被擋
  const tightDir = mkdtempSync(path.join(os.tmpdir(), 'triplog-smoke-rate-'));
  const tightBase = `http://127.0.0.1:${AUTH_PORT + 50}`;
  const tight = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TRIPLOG_API_KEY: KEY,
      TRIPLOG_READ_KEY: READ,
      TRIPLOG_DATA_DIR: tightDir,
      PORT: String(AUTH_PORT + 50),
      TRIPLOG_AUTH: '1',
      TRIPLOG_RATE_AUTH: '3',
      TRIPLOG_GOOGLE_CLIENT_ID: CLIENT_ID,
      TRIPLOG_GOOGLE_JWKS_URL: `http://127.0.0.1:${JWKS_PORT}/certs`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tight.stdout.on('data', (d) => logs.push(String(d)));
  tight.stderr.on('data', (d) => logs.push(String(d)));
  try {
    await waitUpAt(tightBase);
    const tries = [];
    for (let i = 0; i < 4; i++) {
      // JWKS 已在上一個檢查關掉，這裡要斷的是「有沒有被限流」，不是登入成不成功
      tries.push(await hit(tightBase, '/api/auth/google', { method: 'POST', body: { idToken: idToken({ sub: `ratelimit${i}sub`, email: `r${i}@example.com` }) } }));
    }
    assert.equal(tries[3].status, 429, `第四次就該被擋：${tries[3].status} ${tries[3].text}`);
    assert.equal(tries[3].json.login, true, tries[3].text);
    assert.ok(!tries[3].json.token, '被限流時絕對不能發出 token');
    assert.match(tries[3].json.error, /一分鐘/);
    const data = await hit(tightBase, '/api/base', { token: sessionA });
    assert.notEqual(data.status, 429, '登入端點被洪水打，不該讓已登入的裝置連資料都讀不到');
  } finally {
    tight.kill();
    await new Promise((r) => setTimeout(r, 400));
    try {
      rmSync(tightDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows 的 WAL 鎖而已 */
    }
  }
});

/* -------------------------------------------- 共筆邀請（身分就是那顆信箱） */

// Bo 在「登出只斷這一條 session」那條檢查裡把手上那條斷了，這裡重新登一次拿一條活的
sessionB = (await login({ sub: '998877665544332211009', email: 'bo@example.com', name: 'Bo' })).token;

let inviteBo = null;

await check('邀請記的是信箱：雙方都列得到，而且這條路上不需要任何連結', async () => {
  const r = await A2('/api/invites', { method: 'POST', token: sessionA, body: { tripId: 'trip_a', email: 'Bo@Example.com' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.invite.email, 'bo@example.com', '信箱要洗成小寫，才比得上 Google 回傳的那顆');
  assert.equal(r.json.invite.role, 'write', '沒指定就是可記帳');
  assert.match(r.json.invite.tripName, /Kyoto/);
  assert.equal(r.json.invite.landingUrl, '/#/shared/trip_a');
  inviteBo = r.json.invite;
  const mine = await A2('/api/invites', { token: sessionA });
  assert.ok(mine.json.invites.some((g) => g.id === inviteBo.id), mine.text);
  const forBo = await A2('/api/invites/mine', { token: sessionB });
  assert.equal(forBo.json.email, 'bo@example.com', forBo.text);
  const got = forBo.json.invites.find((g) => g.tripId === 'trip_a');
  assert.ok(got, `受邀者要看到別人邀他的那一趟：${forBo.text}`);
  assert.ok(typeof got.tripName === 'string' && got.tripName.length > 0, `受邀者的清單要寫得出那一趟的名字：${JSON.stringify(got)}`);
  assert.ok(typeof got.ownerName === 'string' && got.ownerName.length > 0, `清單要講得出是誰邀的：${JSON.stringify(got)}`);
});

await check('信箱形狀不對、邀自己、或那一趟不在你帳本裡，都不算邀請', async () => {
  const bad = await A2('/api/invites', { method: 'POST', token: sessionA, body: { tripId: 'trip_a', email: 'bo-at-example' } });
  assert.equal(bad.status, 400, bad.text);
  const self = await A2('/api/invites', { method: 'POST', token: sessionA, body: { tripId: 'trip_a', email: 'ana@example.com' } });
  assert.equal(self.status, 400, self.text);
  const steal = await A2('/api/invites', { method: 'POST', token: sessionA, body: { tripId: 'trip_z', email: 'bo@example.com' } });
  assert.equal(steal.status, 404, `trip_z 是 Bo 的行程，安娜邀不了人：${steal.text}`);
  const noKey = await A2('/api/invites', { method: 'POST', token: KEY, body: { tripId: 'trip_a', email: 'x@y.tw' } });
  assert.equal(noKey.status, 403, `金鑰沒有身分可比對，邀不了人：${noKey.text}`);
  const noLogin = await A2('/api/invites', { method: 'POST', body: { tripId: 'trip_a', email: 'x@y.tw' } });
  assert.equal(noLogin.status, 401, noLogin.text);
});

await check('受邀者讀的是邀請人那一趟：看不到別的旅行，也拿不到照片', async () => {
  const r = await A2('/api/trips/trip_a/shared', { token: sessionB });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.scope, 'grant');
  assert.equal(r.json.trip.id, 'trip_a');
  assert.ok(r.json.items.length > 0 && r.json.expenses.length > 0, `要能看到這一趟已有的項目與支出：${r.text}`);
  assert.equal(r.json.photos, undefined, '共筆讀取不含照片');
  assert.equal(JSON.stringify(r.json).includes('trip_z'), false, '不能把別人的別的趟漏出去');
  const notYours = await A2('/api/trips/trip_z/shared', { token: sessionA });
  assert.equal(notYours.status, 403, notYours.text);
  assert.equal(notYours.json.need, 'invite');
  assert.match(notYours.json.error, /ana@example\.com/, '要點名是哪顆信箱沒被邀請，使用者才聽得懂');
});

await check('代記寫進邀請人那份帳本，受邀者自己那裡不會憑空多出一筆', async () => {
  const r = await A2('/api/trips/trip_a/shared/expense', {
    method: 'POST',
    token: sessionB,
    body: { amount: 700, currency: 'JPY', rateToBase: 0.2, date: '2026-03-02', payee: 'Bo', category: 'food', note: '共筆拉麵' },
  });
  assert.equal(r.status, 200, r.text);
  const id = r.json.expense.id;
  const inAna = await A2('/api/expenses?tripId=trip_a', { token: sessionA });
  assert.ok(inAna.json.expenses.some((e) => e.id === id), `那筆要落在安娜的帳本裡：${inAna.text}`);
  const inBo = await A2('/api/base', { token: sessionB });
  assert.equal(inBo.status, 200, inBo.text);
  assert.equal(JSON.stringify(inBo.json.base).includes(id), false, 'Bo 那份帳本不該出現安娜的支出');
  const item = await A2('/api/trips/trip_a/shared/item', {
    method: 'POST',
    token: sessionB,
    body: { title: '共筆景點', date: '2026-03-03', type: 'sight' },
  });
  assert.equal(item.status, 200, item.text);
  const outside = await A2('/api/trips/trip_a/shared/expense', {
    method: 'POST',
    token: sessionB,
    body: { amount: 10, date: '2026-12-01' },
  });
  assert.equal(outside.status, 400, `日期超出這一趟還是要擋：${outside.text}`);
});

await check('唯讀邀請看得到、記不下去；撤銷之後連看都不給看', async () => {
  const c = await login({ sub: '445566778899001122334', email: 'carol@example.com', name: 'Carol' });
  const invite = await A2('/api/invites', { method: 'POST', token: sessionA, body: { tripId: 'trip_a', email: 'carol@example.com', role: 'read' } });
  assert.equal(invite.status, 200, invite.text);
  assert.equal(invite.json.invite.role, 'read');
  const peek = await A2('/api/trips/trip_a/shared', { token: c.token });
  assert.equal(peek.status, 200, peek.text);
  const write = await A2('/api/trips/trip_a/shared/expense', { method: 'POST', token: c.token, body: { amount: 10, date: '2026-03-02' } });
  assert.equal(write.status, 403, write.text);
  assert.match(write.json.error, /唯讀/);
  const gone = await A2('/api/invites/revoke', { method: 'POST', token: sessionA, body: { id: invite.json.invite.id } });
  assert.equal(gone.status, 200, gone.text);
  assert.equal(gone.json.changed, true);
  const after = await A2('/api/trips/trip_a/shared', { token: c.token });
  assert.equal(after.status, 403, `撤銷邀請要立刻失效：${after.text}`);
  const again = await A2('/api/invites/revoke', { method: 'POST', token: sessionA, body: { id: invite.json.invite.id } });
  assert.equal(again.json.changed, false, '撤過再一次不算錯，但要講清楚這次沒變動');
  const steal = await A2('/api/invites/revoke', { method: 'POST', token: sessionB, body: { id: inviteBo.id } });
  assert.equal(steal.status, 404, `不是自己發的邀請不能撤，也不能讓人家探測到它存在：${steal.text}`);
});

await check('受邀者能自己退出，而退出只砍邀請、不動邀請人的資料', async () => {
  const before = await A2('/api/expenses?tripId=trip_a', { token: sessionA });
  const leave = await A2('/api/invites/leave', { method: 'POST', token: sessionB, body: { tripId: 'trip_a' } });
  assert.equal(leave.status, 200, leave.text);
  assert.equal(leave.json.changed, true);
  const mine = await A2('/api/invites/mine', { token: sessionB });
  assert.equal(mine.json.invites.some((g) => g.tripId === 'trip_a'), false, '已退出的邀請不該還列在清單上');
  const blocked = await A2('/api/trips/trip_a/shared', { token: sessionB });
  assert.equal(blocked.status, 403, blocked.text);
  const after = await A2('/api/expenses?tripId=trip_a', { token: sessionA });
  assert.equal(after.json.expenses.length, before.json.expenses.length, '退出共筆不能刪掉任何一筆記錄');
});

await check('共筆沒有刪除的入口：DELETE 一律 405，資料只能追加', async () => {
  const del = await A2('/api/trips/trip_a/shared/expense', { method: 'DELETE', token: sessionA });
  assert.equal(del.status, 405, del.text);
  const delOwn = await A2('/api/trips/trip_a/shared/item', { method: 'DELETE', token: sessionA });
  assert.equal(delOwn.status, 405, delOwn.text);
});

child.kill();
await new Promise((r) => setTimeout(r, 500));
child = boot();
child.stdout.on('data', (d) => logs.push(String(d)));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
await check('切回金鑰模式後，帳號寫進去的那份資料不會變相公開', async () => {
  const r = await api('/api/base');
  assert.equal(r.status, 404, `金鑰看到的是空的 '' 分帳，不該撿到帳號的資料：${r.status} ${r.text}`);
});

child.kill();
// Windows 上 WAL 檔會多鎖一下，清不掉不影響測試結果
await new Promise((r) => setTimeout(r, 800));try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
} catch (err) {
  console.log(`(cleanup skipped: ${err.code})`);
}
console.log(`\n${passed} 項通過，${failures.length} 項失敗${failures.length ? '：' + failures.join(', ') : ''}`);
if (failures.length) {
  console.log('\n--- server log ---\n' + logs.join(''));
  process.exit(1);
}
