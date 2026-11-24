#!/usr/bin/env node
/**
 * TripLog MCP server（stdio）
 *
 * 讓 AI agent 透過後端 API 讀寫旅行記錄。這個程式本體不碰資料庫，
 * 全部走 https://<你的網域>/api/*，所以：
 * - 手機／筆電／agent 看到的是同一份「基準檔」，不會各寫各的
 * - 沒有 TRIPLOG_API_KEY 就打不到任何東西
 * - 刻意不做刪除：所有寫入都是新增或覆寫，要刪請在使用者面前手動做
 *
 * 環境變數：
 *   TRIPLOG_URL        預設 https://triplogmo.duckdns.org
 *   TRIPLOG_API_KEY    必要（可寫入）；TRIPLOG_READ_KEY 只能讀
 *   TRIPLOG_ALLOW_WRITE 設 0 時連寫入工具都不註冊（唯讀 agent）
 *   TRIPLOG_TIMEOUT_MS 每個請求的逾時，預設 30000
 */
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.1.0';
const BASE_URL = (process.env.TRIPLOG_URL ?? 'https://triplogmo.duckdns.org').replace(/\/+$/, '');
const KEY = (process.env.TRIPLOG_API_KEY ?? process.env.TRIPLOG_READ_KEY ?? '').trim();
/**
 * 主金鑰算在哪一份帳上：帳號 id 或那顆已驗證的 Google 信箱。
 * 一台伺服器只有一個帳號時可以不填（後端自己認唯一那個）；多個人共用同一台時就填這裡，
 * 否則 agent 讀到的會是「帳號制度之前那份空基準」——第一次登入把舊資料認領走之後就一直如此。
 */
const ACCOUNT = (process.env.TRIPLOG_ACCOUNT ?? '').trim();
const ALLOW_WRITE = process.env.TRIPLOG_ALLOW_WRITE !== '0';
const TIMEOUT = Number(process.env.TRIPLOG_TIMEOUT_MS ?? 30_000);

/* ------------------------------------------------------------------ API */

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  if (!KEY) throw new ApiError(401, '沒有 TRIPLOG_API_KEY，這個 MCP server 無法存取後端。');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${KEY}`,
        // 主金鑰本身不認得帳號，靠這顆標頭指認要讀哪一份帳（後端只在主金鑰請求看它）
        ...(ACCOUNT ? { 'x-triplog-account': ACCOUNT } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
  } catch (err) {
    throw new ApiError(0, `連不到 ${BASE_URL}：${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error ?? '';
    } catch {
      /* 非 JSON 錯誤體 */
    }
    const hint =
      res.status === 401
        ? '（金鑰不對：檢查 TRIPLOG_API_KEY）'
        : res.status === 403
          ? '（這把金鑰只有讀取權，寫入需要 TRIPLOG_API_KEY）'
          : res.status === 404
            ? '（後端還沒有資料，先用 app 推送一次或建立旅行）'
            : '';
    throw new ApiError(res.status, `API ${res.status} ${path}：${detail || res.statusText}${hint}`);
  }
  return res.json();
}

/** 基準快照（照片只有 metadata，沒有 base64） */
async function base() {
  try {
    const r = await api('/api/base');
    return r.base;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return empty();
    throw err;
  }
}

function empty() {
  return { format: 'triplog-backup', version: 1, exportedAt: new Date().toISOString(), trips: [], dayItems: [], expenses: [], categories: [], photos: [], meta: [] };
}

/** 把動過的列送回去；後端以 id 併入基準，不覆蓋沒送的部分 */
async function push(doc: Record<string, unknown>) {
  if (!ALLOW_WRITE) throw new ApiError(403, 'TRIPLOG_ALLOW_WRITE=0，這個 MCP server 是唯讀模式。');
  return api('/api/sync', { method: 'POST', body: { ...doc, exportedAt: new Date().toISOString() } });
}

/* ------------------------------------------------------------- 小工具 */

const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID()}`;
const ZERO_DP = new Set(['JPY', 'VND', 'KRW', 'IDR', 'CLP', 'ISK']);
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number, cur: string) => (ZERO_DP.has(cur) ? Math.round(n) : round2(n));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ApiError(400, msg);
}

function iso(v: string, what: string): string {
  need(DATE_RE.test(v), `${what} 必須是 YYYY-MM-DD（收到「${v}」）`);
  return v;
}

function time(v: string | undefined | null, what: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  need(TIME_RE.test(v), `${what} 必須是 HH:MM 24 小時制（收到「${v}」）`);
  return v;
}

function findTrip(doc: any, tripId: string) {
  const trip = (doc.trips ?? []).find((t: any) => t.id === tripId);
  need(trip, `找不到旅行 ${tripId}。先跑 triplog_list_trips 看有哪些 id。`);
  return trip;
}

/** 寫入任何子項時順手把該趟的 updatedAt 推一推，app 端的排序才會更新 */
function touched(doc: any, tripId: string) {
  const trip = (doc.trips ?? []).find((t: any) => t.id === tripId);
  if (trip) return { ...trip, updatedAt: now() };
  return null;
}

/**
 * 同一天下一筆的排序值。`extra` 是這一批已經排進去、但基準檔裡還沒有的行程項，
 * 少了它一批兩筆會拿到同一個 order（app 上兩筆的先後就變成看 id 心情）。
 */
function nextOrder(doc: any, tripId: string, date: string, extra: any[] = []): number {
  return [...(doc.dayItems ?? []), ...extra].reduce(
    (max: number, i: any) => (i.tripId === tripId && i.date === date ? Math.max(max, i.order ?? 0) : max),
    0,
  ) + 10;
}

/**
 * 支出分類可以給三種寫法：分類 id、內建 key（food）、或一個全新的名字。
 * 全新的就順手建一張自訂分類放進同一次同步——agent 不該為了記一筆「按摩」
 * 而先去查分類清單，但 app 端一定要拿到一個能對應的 id，否則會顯示成未分類。
 */
const CAT_COLORS = ['#e07a3f', '#2f7ed8', '#7c5cd6', '#0f9d8f', '#d64576', '#c9962b', '#6b7280'];

function slugKey(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  return s || 'custom';
}

function resolveCategory(doc: any, value: unknown, fresh: Map<string, any>): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const pool = [...(doc.categories ?? []), ...fresh.values()];
  const hit = pool.find((c: any) => c.id === raw || c.key === raw || c.label === raw);
  if (hit) return hit.id;
  const cat = {
    id: rid('cat'),
    kind: 'expense',
    key: slugKey(raw),
    label: raw.slice(0, 24),
    color: CAT_COLORS[fresh.size % CAT_COLORS.length],
    order: 900 + fresh.size * 10,
    builtin: false,
  };
  fresh.set(cat.id, cat);
  return cat.id;
}

function buildExpense(doc: any, tripId: string, input: any, id?: string, fresh?: Map<string, any>) {
  const trip = findTrip(doc, tripId);
  const base = trip.baseCurrency;
  const currency = (input.currency ?? base).toUpperCase();
  const amountRaw = Number(input.amount);
  need(Number.isFinite(amountRaw) && amountRaw > 0, 'amount 必須是大於 0 的數字');
  let rate = input.rateToBase === undefined || input.rateToBase === null ? undefined : Number(input.rateToBase);
  if (currency === base) rate = 1;
  if (rate === undefined) {
    const remembered = (doc.meta ?? []).find((m: any) => m.key === 'rates')?.value?.[`${base}>${currency}`];
    need(false, `1 ${currency} = ? ${base} 沒給匯率，後端也沒有記憶值（${remembered ? `上次是 ${remembered}` : '第一次出現'}）。請帶 rateToBase 再送一次。`);
  }
  need(Number.isFinite(rate) && (rate as number) > 0, 'rateToBase 必須是大於 0 的數字');
  const date = iso(input.date ?? trip.startDate, 'date');
  need(date >= trip.startDate && date <= trip.endDate, `date ${date} 不在 ${trip.name} 的 ${trip.startDate}～${trip.endDate} 之間`);
  const amt = money(amountRaw, currency);
  return {
    id: id ?? rid('exp'),
    tripId,
    dayItemId: input.dayItemId ?? null,
    date,
    amount: amt,
    currency,
    rateToBase: round2(rate as number),
    baseAmount: money(amt * (rate as number), base),
    category: resolveCategory(doc, input.category, fresh ?? new Map()),
    payee: input.payee ?? '',
    note: input.note ?? '',
    createdAt: now(),
    updatedAt: now(),
  };
}

function buildItem(doc: any, tripId: string, input: any, id?: string, createdAt?: string, earlier: any[] = []) {
  const trip = findTrip(doc, tripId);
  const date = iso(input.date, 'date');
  // 行程頁的天是照旅行日期區間長的，落在區間外的行程項會「寫得進去但看不到」，所以在這裡就擋掉
  need(
    date >= trip.startDate && date <= trip.endDate,
    `date ${date} 不在 ${trip.name} 的 ${trip.startDate}～${trip.endDate} 之間；要加那天的行程請先拉長旅行日期`,
  );
  const title = String(input.title ?? '').trim();
  need(title.length > 0, 'title 不能是空字串');
  if (input.lat !== undefined && input.lat !== null) {
    need(Number.isFinite(Number(input.lat)) && Math.abs(Number(input.lat)) <= 90, 'lat 必須在 -90～90');
    need(Number.isFinite(Number(input.lng)) && Math.abs(Number(input.lng)) <= 180, 'lng 必須在 -180～180');
  }
  return {
    id: id ?? rid('item'),
    tripId,
    date,
    kind: input.kind ?? 'other',
    title,
    startTime: time(input.startTime, 'startTime'),
    endTime: time(input.endTime, 'endTime'),
    location: input.location ?? '',
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    note: input.note ?? '',
    order: input.order ?? nextOrder(doc, tripId, date, earlier),
    createdAt: createdAt ?? now(),
    updatedAt: now(),
  };
}

/* ------------------------------------------------------------ 工具定義 */

const TRIP_PROPS = {
  name: { type: 'string', description: '旅行名稱，例：京都四天 · 楓葉季' },
  startDate: { type: 'string', description: 'YYYY-MM-DD' },
  endDate: { type: 'string', description: 'YYYY-MM-DD，可以等於 startDate' },
  baseCurrency: { type: 'string', description: '統計用主幣別，預設 TWD' },
  budget: { type: 'number', description: '預算（以主幣別計），選填' },
  color: { type: 'string', description: '#rrggbb，預設 #0f766e' },
  notes: { type: 'string' },
  companions: { type: 'array', items: { type: 'string' }, description: '同行者名單' },
  archived: { type: 'boolean' },
};

const ITEM_PROPS = {
  date: { type: 'string', description: 'YYYY-MM-DD，必須落在旅行期間' },
  title: { type: 'string' },
  kind: { type: 'string', enum: ['transport', 'stay', 'food', 'sight', 'activity', 'other'] },
  startTime: { type: 'string', description: 'HH:MM' },
  endTime: { type: 'string', description: 'HH:MM' },
  location: { type: 'string' },
  lat: { type: 'number' },
  lng: { type: 'number' },
  note: { type: 'string' },
  order: { type: 'number', description: '同日排序，小的在前；不給就排最後' },
};

const EXPENSE_PROPS = {
  date: { type: 'string' },
  amount: { type: 'number', description: '以原始幣別計' },
  currency: { type: 'string', description: '不給＝主幣別' },
  rateToBase: { type: 'number', description: '1 currency = ? baseCurrency；外幣必填' },
  category: {
    type: 'string',
    description:
      '分類 id、內建 key（food/transport/stay/ticket/shopping/fun/misc）或一個新名字；給新名字會自動建一張自訂分類。',
  },
  dayItemId: { type: 'string', description: '關聯的行程項' },
  payee: { type: 'string', description: '誰付的／誰代墊' },
  note: { type: 'string' },
};

const TOOLS = [
  {
    name: 'triplog_health',
    description: '確認後端連得通，並回傳快照數量與佔用空間。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => api('/api/health'),
  },
  {
    name: 'triplog_list_trips',
    description: '列出伺服器上所有旅行（含每趟的行程項／支出／照片數量）。寫入前請先叫這個拿到 tripId。',
    inputSchema: {
      type: 'object',
      properties: { archived: { type: 'boolean', description: 'true=只列歸檔的；預設只列未歸檔' } },
      additionalProperties: false,
    },
    handler: async ({ archived }) => {
      // 直接從基準快照數出每趟的規模：agent 多半是要找「要寫到哪一趟」，
      // 只給 id 與名字的話它還得一趟一趟 get_trip，多三倍請求。
      const doc = await base();
      const want = archived === true;
      const trips = (doc.trips ?? [])
        .filter((t: any) => !!t.archived === want)
        .map((t: any) => {
          const itemIds = new Set((doc.dayItems ?? []).filter((i: any) => i.tripId === t.id).map((i: any) => i.id));
          const mine = (doc.expenses ?? []).filter((e: any) => e.tripId === t.id);
          return {
            id: t.id,
            name: t.name,
            startDate: t.startDate,
            endDate: t.endDate,
            baseCurrency: t.baseCurrency,
            budget: t.budget ?? null,
            archived: !!t.archived,
            items: itemIds.size,
            expenses: mine.length,
            photos: (doc.photos ?? []).filter((p: any) => p.tripId === t.id || (p.dayItemId && itemIds.has(p.dayItemId))).length,
            totalBase: round2(mine.reduce((s: number, e: any) => s + (e.baseAmount ?? 0), 0)),
          };
        });
      return { trips, count: trips.length };
    },
  },
  {
    name: 'triplog_get_trip',
    description: '讀一趟旅行完整內容：行程項、支出、分類（照片只給 metadata，不含 base64）。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' } },
      required: ['tripId'],
      additionalProperties: false,
    },
    handler: async ({ tripId }) => api(`/api/trips/${encodeURIComponent(String(tripId))}`),
  },
  {
    name: 'triplog_summary',
    description: '一趟旅行的支出統計：合計、預算、依分類／付款人／幣別分組。要報告數字就讀這個，不要自己加。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' } },
      required: ['tripId'],
      additionalProperties: false,
    },
    handler: async ({ tripId }) => api(`/api/summary?tripId=${encodeURIComponent(String(tripId))}`),
  },
  {
    name: 'triplog_list_expenses',
    description: '列支出，可依旅行、日期區間、付款人、分類篩選。',
    inputSchema: {
      type: 'object',
      properties: {
        tripId: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD 含當日' },
        to: { type: 'string', description: 'YYYY-MM-DD 含當日' },
        payee: { type: 'string' },
        category: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async ({ tripId, from, to, payee, category }) => {
      const r = await api(`/api/expenses${tripId ? `?tripId=${encodeURIComponent(String(tripId))}` : ''}`);
      const rows = (r.expenses ?? []).filter((e: any) => {
        if (from && e.date < from) return false;
        if (to && e.date > to) return false;
        if (payee && String(e.payee ?? '') !== String(payee)) return false;
        if (category && e.category !== category) return false;
        return true;
      });
      return { count: rows.length, totalBase: round2(rows.reduce((s: number, e: any) => s + e.baseAmount, 0)), expenses: rows, categories: r.categories };
    },
  },
  {
    name: 'triplog_create_trip',
    description: '建立一趟旅行。日期、主幣別、預算、同行者都在這裡決定；之後的支出都要落在這個日期區間內。',
    inputSchema: {
      type: 'object',
      properties: TRIP_PROPS,
      required: ['name', 'startDate', 'endDate'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const ts = now();
      const trip = {
        id: rid('trip'),
        name: String(a.name).trim(),
        startDate: iso(String(a.startDate), 'startDate'),
        endDate: iso(String(a.endDate), 'endDate'),
        baseCurrency: String(a.baseCurrency ?? 'TWD').toUpperCase(),
        budget: a.budget === undefined || a.budget === null ? null : Number(a.budget),
        color: a.color ?? '#0f766e',
        notes: a.notes ?? '',
        companions: Array.isArray(a.companions) ? a.companions.map(String) : [],
        archived: a.archived === true,
        createdAt: ts,
        updatedAt: ts,
      };
      need(trip.endDate >= trip.startDate, 'endDate 不能早於 startDate');
      need(trip.name.length > 0, 'name 不能是空字串');
      const saved = await push({ trips: [trip] });
      return { trip, saved };
    },
  },
  {
    name: 'triplog_add_items',
    description: '批次新增行程項（交通／住宿／餐飲／景點／活動）。座標選填，給了就會出現在地圖與 PDF 裡。',
    inputSchema: {
      type: 'object',
      properties: {
        tripId: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: ITEM_PROPS, required: ['date', 'title'], additionalProperties: false }, minItems: 1 },
      },
      required: ['tripId', 'items'],
      additionalProperties: false,
    },
    handler: async ({ tripId, items }) => {
      const doc = await base();
      findTrip(doc, String(tripId));
      // 一批裡的每一筆都要看到前面那些，否則同一天兩筆會拿到同一個 order
      const created: any[] = [];
      for (const input of items as any[]) created.push(buildItem(doc, String(tripId), input, undefined, undefined, created));
      const saved = await push({ trips: [touched(doc, String(tripId))].filter(Boolean), dayItems: created });
      return { created: created.map((i) => ({ id: i.id, date: i.date, title: i.title, order: i.order })), saved };
    },
  },
  {
    name: 'triplog_update_item',
    description: '改一個行程項的欄位（只蓋有送的欄位）。要改日期請一併送新的 date。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string', description: '選填，送了就少讀一次基準' }, itemId: { type: 'string' }, patch: { type: 'object', properties: ITEM_PROPS, additionalProperties: false } },
      required: ['itemId', 'patch'],
      additionalProperties: false,
    },
    handler: async ({ tripId, itemId, patch }) => {
      const doc = await base();
      const existing = (doc.dayItems ?? []).find((i: any) => i.id === itemId);
      need(existing, `找不到行程項 ${itemId}`);
      const merged = { ...existing, ...patch };
      const next = buildItem(doc, existing.tripId, merged, String(itemId), existing.createdAt);
      const saved = await push({ trips: [touched(doc, existing.tripId)].filter(Boolean), dayItems: [next] });
      return { item: next, saved };
    },
  },
  {
    name: 'triplog_add_expenses',
    description: '批次記支出。金額以原始幣別存，外幣必須給 rateToBase（1 外幣 = ? 主幣別）；不會自己查匯率。',
    inputSchema: {
      type: 'object',
      properties: {
        tripId: { type: 'string' },
        expenses: { type: 'array', items: { type: 'object', properties: EXPENSE_PROPS, required: ['amount'], additionalProperties: false }, minItems: 1 },
      },
      required: ['tripId', 'expenses'],
      additionalProperties: false,
    },
    handler: async ({ tripId, expenses }) => {
      const doc = await base();
      findTrip(doc, String(tripId));
      const fresh = new Map<string, any>();
      const created = (expenses as any[]).map((input) => buildExpense(doc, String(tripId), input, undefined, fresh));
      const saved = await push({
        trips: [touched(doc, String(tripId))].filter(Boolean),
        expenses: created,
        categories: [...fresh.values()],
      });
      const pool = [...(doc.categories ?? []), ...fresh.values()];
      return {
        created: created.map((e) => ({
          id: e.id,
          date: e.date,
          amount: e.amount,
          currency: e.currency,
          baseAmount: e.baseAmount,
          // 同時給 id 與名稱：id 是真正存進欄位的那個，名稱讓 agent 看得出
          // 自己送的 category 落到哪（含自動新建的），不會以為記了「未分類」
          category: e.category,
          categoryLabel: pool.find((c: any) => c.id === e.category)?.label ?? '未分類',
        })),
        totalBase: round2(created.reduce((s, e) => s + e.baseAmount, 0)),
        saved,
      };
    },
  },
  {
    name: 'triplog_update_expense',
    description: '改一筆支出（含補匯率：送 currency + rateToBase 就會重算 baseAmount）。',
    inputSchema: {
      type: 'object',
      properties: { expenseId: { type: 'string' }, patch: { type: 'object', properties: EXPENSE_PROPS, additionalProperties: false } },
      required: ['expenseId', 'patch'],
      additionalProperties: false,
    },
    handler: async ({ expenseId, patch }) => {
      const doc = await base();
      const existing = (doc.expenses ?? []).find((e: any) => e.id === expenseId);
      need(existing, `找不到支出 ${expenseId}`);
      const fresh = new Map<string, any>();
      const next = buildExpense(doc, existing.tripId, { ...existing, ...patch }, String(expenseId), fresh);
      next.createdAt = existing.createdAt;
      const saved = await push({
        trips: [touched(doc, existing.tripId)].filter(Boolean),
        expenses: [next],
        categories: [...fresh.values()],
      });
      return { expense: next, saved };
    },
  },
  {
    name: 'triplog_add_companions',
    description: '幫旅行加同行者名單（記支出時當付款人選項用）。已存在的名字會略過。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' }, names: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tripId', 'names'],
      additionalProperties: false,
    },
    handler: async ({ tripId, names }) => {
      const doc = await base();
      const trip = findTrip(doc, String(tripId));
      const current = Array.isArray(trip.companions) ? [...trip.companions] : [];
      const added: string[] = [];
      for (const raw of names as string[]) {
        const name = String(raw).trim();
        if (name && !current.includes(name)) {
          current.push(name);
          added.push(name);
        }
      }
      if (!added.length) return { added: [], companions: current, note: '名單裡已經有這些人了，沒有變更。' };
      const saved = await push({ trips: [{ ...trip, companions: current, updatedAt: now() }] });
      return { added, companions: current, saved };
    },
  },
  {
    name: 'triplog_history',
    description: '後端保留了幾份歷史快照（誰在什麼時候推的、多大）。用來確認同步有沒有發生過。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '預設 10，最多 100' } }, additionalProperties: false },
    handler: async ({ limit }) => api(`/api/history?limit=${Math.min(100, Math.max(1, Number(limit ?? 10)))}`),
  },
  {
    name: 'triplog_delete_help',
    description: '沒有刪除工具。叫這個會拿到「該怎麼刪」的說明（歸檔取代刪除、以及要在 app 端刪的理由）。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' } },
      required: ['tripId'],
      additionalProperties: false,
    },
    handler: async ({ tripId }) => {
      const doc = await base();
      const trip = findTrip(doc, String(tripId));
      return {
        allowed: false,
        reason: 'MCP 端刻意不提供刪除：刪除在這一系統是會跟著同步的資料（刪除記號），不該由 agent 替每一台裝置決定。',
        doInstead:
          '用 triplog_archive_trip 把這趟歸檔（資料留著、清單裡收起來），或由使用者自己在 app 裡刪除——app 刪掉會留下 tombstone，別台裝置下次同步就跟著清掉。',
        trip: { id: trip.id, name: trip.name },
      };
    },
  },
  {
    name: 'triplog_archive_trip',
    description: '歸檔／取消歸檔一趟旅行。這是「結束旅程」的正規做法，不會移除任何資料。',
    inputSchema: {
      type: 'object',
      properties: { tripId: { type: 'string' }, archived: { type: 'boolean' } },
      required: ['tripId', 'archived'],
      additionalProperties: false,
    },
    handler: async ({ tripId, archived }) => {
      const doc = await base();
      const trip = findTrip(doc, String(tripId));
      const next = { ...trip, archived: archived === true, updatedAt: now() };
      const saved = await push({ trips: [next] });
      return { trip: { id: next.id, name: next.name, archived: next.archived }, saved };
    },
  },
];

const WRITE_TOOLS = new Set([
  'triplog_create_trip',
  'triplog_add_items',
  'triplog_update_item',
  'triplog_add_expenses',
  'triplog_update_expense',
  'triplog_add_companions',
  'triplog_archive_trip',
]);

/* -------------------------------------------------------------- Resources */

const RESOURCES = [
  {
    uri: 'triplog://schema',
    name: 'TripLog 資料模型',
    description: '欄位定義與寫入規則；第一次操作前先讀這個。',
    mime: 'application/json',
    load: async () => api('/api/schema'),
  },
  {
    uri: 'triplog://trips',
    name: '旅行索引',
    description: '所有旅行與數量統計（不含明細）。',
    mime: 'application/json',
    load: async () => api('/api/trips?archived=1'),
  },
];

/* ---------------------------------------------------------------- 啟動 */

function visibleTools() {
  return TOOLS.filter((t) => ALLOW_WRITE || !WRITE_TOOLS.has(t.name));
}

const server = new Server(
  { name: 'triplog', version: VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: [
      'TripLog 是一個離線優先的旅行記錄 app，這裡是它的同步後端。',
      '寫入流程：triplog_list_trips → triplog_get_trip（看既有 id 與分類）→ triplog_add_items / triplog_add_expenses。',
      '金額一律以原始幣別記錄，外幣一定要使用者確認匯率（rateToBase），不要猜。',
      '沒有刪除 API。結束的旅行用 triplog_archive_trip 歸檔。',
      '寫進去後，使用者的裝置要在 app「設定 → 跨裝置同步」按一次同步才會看到。',
    ].join(' '),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: visibleTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = visibleTools().find((t) => t.name === name);
  // 找不到工具時回 tool error（而不是讓 JSON-RPC 整個報錯）：agent 讀得到這段文字才可能自己改用別的做法和 app 端
  if (!tool) {
    const why = !ALLOW_WRITE && TOOLS.some((t) => t.name === name) ? '這個 MCP server 跑在唯讀模式（TRIPLOG_ALLOW_WRITE=0）' : '這裡沒有這個工具';
    return {
      isError: true,
      content: [{ type: 'text', text: `${name} 無法執行：${why}。寫入請用 triplog_add_items／triplog_add_expenses，結束的旅行請用 triplog_archive_trip 歸檔；本 MCP 不提供刪除。` }],
    };
  }
  try {
    const result = await tool.handler(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `${name} 失敗：${message}` }],
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map(({ uri, name, description, mime }) => ({ uri, name, description, mimeType: mime })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const found = RESOURCES.find((r) => r.uri === request.params.uri);
  if (!found) throw new Error(`unknown resource: ${request.params.uri}`);
  const payload = await found.load();
  return { contents: [{ uri: found.uri, mimeType: found.mime, text: JSON.stringify(payload, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
// 金鑰層級跟工具註冊是兩件事：只給讀取金鑰時就算沒設 ALLOW_WRITE=0，寫入也會被後端 403。
// 這行是佈署時唯一看得到狀態的地方，就別只報「寫得進去」的假象
const MODE = !ALLOW_WRITE ? 'read-only' : KEY === (process.env.TRIPLOG_READ_KEY ?? '').trim() ? 'read-only（只給了讀取金鑰）' : 'read+write';
console.error(`[triplog-mcp] ready · ${BASE_URL} · ${MODE} · ${visibleTools().length} tools`);
