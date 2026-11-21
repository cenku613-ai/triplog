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
