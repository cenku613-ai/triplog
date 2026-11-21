/**
 * MCP 端點的冒煙測試：真的把 API server 與 MCP stdio server 兩個程序跑起來，
 * 用 JSON-RPC（換行分隔）打 initialize／tools/list／tools/call，再從 HTTP 那側
 * 確認 agent 寫進去的資料真的落在基準檔裡。
 *
 * 跑法：npm run mcp:build && node server/test/mcp-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const apiEntry = path.join(root, 'server', 'src', 'index.js');
const mcpEntry = path.join(root, 'mcp', 'dist', 'index.mjs');
if (!existsSync(mcpEntry)) {
  console.error(`找不到 ${path.relative(root, mcpEntry)}，先跑 npm run mcp:build`);
  process.exit(1);
}

const KEY = 'mcp-smoke-write-key-0123456789abcdef';
const READ = 'mcp-smoke-read-key-0123456789abc';
const PORT = 8850 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(os.tmpdir(), 'triplog-mcp-'));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ API 端 */

const apiLogs = [];
const api = spawn(process.execPath, [apiEntry], {
  env: {
    ...process.env,
    TRIPLOG_API_KEY: KEY,
    TRIPLOG_READ_KEY: READ,
    TRIPLOG_DATA_DIR: dir,
    PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
api.stdout.on('data', (d) => apiLogs.push(String(d)));
api.stderr.on('data', (d) => apiLogs.push(String(d)));

async function http(p, { method = 'GET', key = KEY, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* 還沒起來 */
    }
    await sleep(200);
  }
  throw new Error(`API 沒起來：\n${apiLogs.join('')}`);
}

/* ----------------------------------------------------------------- MCP 端 */

/** 一個非常小的 MCP stdio 客戶端：換行分隔的 JSON-RPC，id 遞增 */
function mcpClient(env) {
  const child = spawn(process.execPath, [mcpEntry], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += String(d);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let seq = 0;
  const rpc = async (method, params) => {
    const id = ++seq;
    const reply = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 逾時；stderr:\n${stderr.join('')}`));
      }, 15_000);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const msg = await reply;
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  };

  return {
    child,
    stderr,
    rpc,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    /** tools/call 的回覆是 content[]，這裡把裡面那坨 JSON 還原成物件 */
    async call(name, args) {
      const res = await rpc('tools/call', { name, arguments: args ?? {} });
      const text = (res.content ?? []).map((c) => c.text ?? '').join('');
      return { raw: res, data: (() => { try { return JSON.parse(text); } catch { return text; } })(), isError: !!res.isError };
    },
  };
}

async function start(env) {
  const c = mcpClient(env);
  const init = await c.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0' },
  });
  c.notify('notifications/initialized', {});
  return { client: c, init };
}

/* -------------------------------------------------------------------- 開跑 */

await waitUp();
console.log(`\n— MCP 交握（API ${BASE}）`);

const { client, init } = await start({ TRIPLOG_URL: BASE, TRIPLOG_API_KEY: KEY });

await check('initialize 回報 server 名稱與工具能力', () => {
  assert.equal(init.serverInfo.name, 'triplog');
  assert.ok(init.capabilities.tools, '沒有 tools capability');
  assert.ok(init.capabilities.resources, '沒有 resources capability');
  assert.ok(typeof init.instructions === 'string' && init.instructions.length > 40, 'instructions 太短，agent 會看不到使用慣例');
});

let toolNames = [];
await check('tools/list 列出全部讀寫工具', async () => {
  const { tools } = await client.rpc('tools/list', {});
  toolNames = tools.map((t) => t.name);
  for (const want of [
    'triplog_health',
    'triplog_list_trips',
    'triplog_get_trip',
    'triplog_summary',
    'triplog_create_trip',
    'triplog_add_items',
    'triplog_add_expenses',
    'triplog_archive_trip',
    'triplog_delete_help',
  ]) {
    assert.ok(toolNames.includes(want), `缺少 ${want}`);
  }
  assert.equal(tools.length, 14, `工具數對不上：${tools.length}`);
  // 每個工具都要有 description 與 object schema，否則 agent 不會用
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 10, `${t.name} 沒有說明`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} 的 inputSchema 不是 object`);
  }
});

let tripId = '';
await check('triplog_create_trip 建出來的旅行真的進到基準檔', async () => {
  const r = await client.call('triplog_create_trip', {
    name: '京都四天 · 楓葉季',
    startDate: '2026-11-20',
    endDate: '2026-11-23',
    baseCurrency: 'TWD',
    budget: 20000,
    companions: ['小安'],
  });
  assert.ok(!r.isError, r.raw.content?.[0]?.text);
  tripId = r.data.trip.id;
  assert.ok(tripId.startsWith('trip_'), `id 前綴不對：${tripId}`);
  const base = await http('/api/base');
  assert.equal(base.json.base.trips[0].id, tripId);
});

await check('triplog_add_items 會擋下日期超出旅程範圍的輸入', async () => {
  const r = await client.call('triplog_add_items', {
    tripId,
    items: [{ date: '2026-12-31', title: '不該存在的行程' }],
  });
  assert.ok(r.isError, '越界日期居然接受了');
  assert.match(String(r.data), /不在/);
});

await check('triplog_add_items 寫入行程項並自動排 order', async () => {
  const r = await client.call('triplog_add_items', {
    tripId,
    items: [
      { date: '2026-11-20', title: '關西機場 → 京都', kind: 'transport', startTime: '10:30', endTime: '12:00' },
      { date: '2026-11-20', title: '東本願寺', kind: 'sight', lat: 34.9934, lng: 135.7507 },
    ],
  });
  assert.ok(!r.isError, String(r.data));
  assert.equal(r.data.created.length, 2);
  const detail = await http(`/api/trips/${tripId}`);
  const orders = detail.json.items.map((i) => i.order);
  assert.ok(orders[1] > orders[0], `order 沒有往後排：${orders}`);
  assert.equal(detail.json.items.filter((i) => i.lat !== null).length, 1, '座標沒落地，PDF 地圖會少一個點');
});

await check('支出可以用內建 key 當分類，匯率由 agent 給', async () => {
  const r = await client.call('triplog_add_expenses', {
    tripId,
    expenses: [
      { date: '2026-11-20', amount: 1200, category: 'food', payee: '小安' },
      { date: '2026-11-20', amount: 800, currency: 'JPY', rateToBase: 0.21, category: 'transport', payee: '阿合' },
    ],
  });
  assert.ok(!r.isError, String(r.data));
  const detail = await http(`/api/expenses?tripId=${tripId}`);
  const cats = new Map(detail.json.categories.map((c) => [c.id, c]));
  const food = detail.json.expenses.find((e) => e.currency === 'TWD');
  assert.equal(cats.get(food.category)?.key, 'food', 'food 應該對到內建分類 id');
  const jpy = detail.json.expenses.find((e) => e.currency === 'JPY');
  assert.equal(jpy.baseAmount, 168, `baseAmount 應該是 800×0.21=168，收到 ${jpy.baseAmount}`);
});

await check('外幣沒給匯率時明確拒絕，而不是猜一個', async () => {
  const r = await client.call('triplog_add_expenses', {
    tripId,
    expenses: [{ date: '2026-11-21', amount: 100, currency: 'EUR' }],
  });
  assert.ok(r.isError);
  assert.match(String(r.data), /rateToBase/);
});

let customCatId = '';
await check('給一個新分類名會自動建自訂分類（app 端才不會顯示未分類）', async () => {
  const before = (await http('/api/trips/' + tripId)).json.categories.length;
  const r = await client.call('triplog_add_expenses', {
    tripId,
    expenses: [{ date: '2026-11-21', amount: 3000, category: '按摩' }],
  });
  assert.ok(!r.isError, String(r.data));
  customCatId = r.data.created[0].category;
  assert.ok(customCatId.startsWith('cat_'), `應該是新建的分類 id：${customCatId}`);
  assert.equal(r.data.created[0].categoryLabel, '按摩', '要讓 agent 看到這筆最後記在哪個分類');
  const after = (await http('/api/trips/' + tripId)).json.categories;
  assert.equal(after.length, before + 1, '自訂分類沒有進到基準檔');
  const created = after.find((c) => c.id === customCatId);
  assert.equal(created.label, '按摩');
  assert.equal(created.builtin, false);
  assert.equal(created.kind, 'expense');
});

await check('同名分類重複送不會長出第二張', async () => {
  const r = await client.call('triplog_add_expenses', {
    tripId,
    expenses: [{ date: '2026-11-22', amount: 900, category: '按摩' }],
  });
  assert.equal(r.data.created[0].category, customCatId, '第二次應該沿用同一個分類 id');
  const after = (await http('/api/trips/' + tripId)).json.categories;
  assert.equal(after.filter((c) => c.label === '按摩').length, 1);
});

await check('triplog_summary 的合計與後端統計一致', async () => {
  const r = await client.call('triplog_summary', { tripId });
  assert.ok(!r.isError, String(r.data));
  // 1200 + 168 + 3000 + 900 = 5268
  assert.equal(r.data.totalBase, 5268);
  assert.equal(r.data.budget, 20000);
  assert.equal(r.data.expenses, 4);
});

await check('triplog_list_trips 看得到 agent 自己寫的那趟', async () => {
  const r = await client.call('triplog_list_trips', {});
  const hit = r.data.trips.find((t) => t.id === tripId);
  assert.ok(hit, '列表裡找不到剛建的旅行');
  assert.equal(hit.items, 2);
  assert.equal(hit.expenses, 4);
});

await check('triplog_add_companions 同名會略過', async () => {
  const r = await client.call('triplog_add_companions', { tripId, names: ['小安', '小明'] });
  assert.deepEqual(r.data.added, ['小明']);
  assert.deepEqual(r.data.companions, ['小安', '小明']);
});

await check('triplog_archive_trip 歸檔後預設列表不再顯示它', async () => {
  const r = await client.call('triplog_archive_trip', { tripId, archived: true });
  assert.equal(r.data.trip.archived, true);
  const list = await client.call('triplog_list_trips', {});
  assert.ok(!list.data.trips.some((t) => t.id === tripId), '歸檔的旅行還出現在預設列表');
  const withArchived = await client.call('triplog_list_trips', { archived: true });
  assert.ok(withArchived.data.trips.some((t) => t.id === tripId), 'archived=1 應該要把它撿回來');
});

await check('triplog_delete_help 只給說明，不動任何資料', async () => {
  const r = await client.call('triplog_delete_help', { tripId });
  assert.equal(r.data.allowed, false);
  assert.match(String(r.data.doInstead), /triplog_archive_trip/);
  const still = await http(`/api/trips/${tripId}`);
  assert.equal(still.json.expenses.length, 4, '刪除說明這動作居然改到了資料');
});

await check('resources：schema 與旅行索引讀得到', async () => {
  const { resources } = await client.rpc('resources/list', {});
  assert.ok(resources.length >= 2, `資源太少：${resources.length}`);
  const schema = await client.rpc('resources/read', { uri: 'triplog://schema' });
  assert.ok(schema.contents[0].text.includes('triplog-backup'), 'schema 內容不對');
});

await check('HTTP 那側完全看不到 DELETE 路由（寫入只增不毀）', async () => {
  const res = await fetch(`${BASE}/api/trips/${tripId}`, { method: 'DELETE', headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 405);
});

client.child.kill();
await sleep(300);

console.log('\n— 唯讀模式');
const ro = await start({ TRIPLOG_URL: BASE, TRIPLOG_READ_KEY: READ, TRIPLOG_ALLOW_WRITE: '0' });
await check('TRIPLOG_ALLOW_WRITE=0 時不註冊寫入工具', async () => {
  const { tools } = await ro.client.rpc('tools/list', {});
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('triplog_list_trips'), '讀取工具應該還在');
  assert.ok(!names.includes('triplog_create_trip'), '唯讀模式還露出建立工具');
  assert.ok(!names.includes('triplog_add_expenses'), '唯讀模式還露出記帳工具');
  assert.equal(names.length, 7, `唯讀模式工具數不對：${names.length}`);
});
await check('唯讀金鑰仍能讀到資料', async () => {
  const r = await ro.client.call('triplog_list_trips', { archived: true });
  assert.ok(r.data.trips.some((t) => t.id === tripId));
});
await check('硬要叫寫入工具時得到清楚的拒絕訊息', async () => {
  const res = await ro.client.rpc('tools/call', { name: 'triplog_create_trip', arguments: { name: 'x', startDate: '2026-01-01', endDate: '2026-01-02' } });
  assert.ok(res.isError || res.content?.[0]?.text, JSON.stringify(res));
  assert.match(res.content?.[0]?.text ?? '', /triplog_create_trip|未知|not.*found|唯讀/i);
});
ro.client.child.kill();
await sleep(300);

console.log('\n— 沒設定金鑰');
const bad = mcpClient({ TRIPLOG_URL: BASE });
await check('沒有金鑰時initialize 仍能完成（讓 agent 看到錯誤說明）', async () => {
  const info = await bad.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0' },
  });
  assert.equal(info.serverInfo.name, 'triplog');
});
await check('沒金鑰時呼叫工具回可行動的錯誤', async () => {
  const r = await bad.call('triplog_health', {});
  assert.ok(r.isError, '應該要報錯');
  assert.match(String(r.data), /TRIPLOG_READ_KEY|TRIPLOG_API_KEY|金鑰/);
});
bad.child.kill();

api.kill();
await sleep(600);
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
} catch (err) {
  console.log(`(cleanup skipped: ${err.message})`);
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗${failures.length ? `：${failures.join('、')}` : ''}`);
if (!existsSync(dir)) process.exit(failures.length ? 1 : 0);
process.exit(failures.length ? 1 : 0);
