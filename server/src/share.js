/**
 * 分享連結（給同行的親友）：一個 token 只對應一趟旅行。
 *
 * 為什麼不是把金鑰分給同行的人：TRIPLOG_API_KEY 一開就是整個資料庫的讀寫權，
 * 交出去等於讓對方看到你所有的旅行。「分享連結」要的是另一回事——
 * 只有這一趟、只能新增、而且隨時可以作廢，所以它是一條獨立的路徑：
 * 打 /api/share/<token> 不需要 bearer token，token 本身就是授權。
 *
 * 這個檔案只有純函式（產生 token、判生死、把送上來的資料裁成合法列），
 * 不碰 HTTP 也不碰資料庫，所以後端冒煙測試之外還能單獨驗。
 */
import crypto from 'node:crypto';

/** 行程類型：與 App 的 DayItem.kind 一致，範圍外的一律退回 other */
export const ITEM_KINDS = ['transport', 'stay', 'food', 'sight', 'activity', 'other'];
/** 期限上限：一年。要更久請重新產生連結——連結流傳越久越難追溯 */
export const MAX_SHARE_DAYS = 365;
export const DEFAULT_SHARE_DAYS = 90;
/** 同行者補的記錄可以落在起訖外幾天（出發前訂票、回程後補帳） */
const DATE_SLACK_DAYS = 3;
/** id 由客戶端產生，重複送才會合併成同一筆；只擋明顯不是 id 的東西，歸屬由 tripId 把關 */
const ID_RE = /^[A-Za-z0-9_-]{3,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ShareError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 22 個字的 URL-safe token（128 位熵），直接貼在連結後面，不必另外編碼 */
export function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * 有效期限：expiresInDays 給 1–365；0／null／''／'never' 是「不設限期」。
 * 不給值就預設 90 天——旅行結束一陣子後連結自己失效，比留著安心。
 * @returns {string | null} ISO 時間戳，null 代表不會到期
 */
export function expiresAtFrom(input) {
  const value = input === undefined ? DEFAULT_SHARE_DAYS : input;
  if (value === 0 || value === null || value === '' || value === 'never') return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new ShareError(400, 'expiresInDays 要是數字、0 或 never');
  if (n <= 0) return null;
  if (n > MAX_SHARE_DAYS) throw new ShareError(400, `expiresInDays 不能超過 ${MAX_SHARE_DAYS}`);
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

/**
 * token 的生死。revoked 比過期優先：作廢是立刻生效的，不用等到期限。
 * @returns {{ live: boolean, reason?: 'revoked' | 'expired' }}
 */
export function shareStatus(row, nowMs = Date.now()) {
  if (!row) return { live: false, reason: 'expired' };
  if (row.revokedAt) return { live: false, reason: 'revoked' };
  if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) return { live: false, reason: 'expired' };
  return { live: true };
}

/* ---------------------------------------------------------------- 欄位裁縫 */

/** 字串：去控制字元、去頭尾空白、限長。不是字串就給預設值 */
function text(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(n, 1_000_000_000) * 100) / 100;
}

function coord(v, limit) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 1e6) / 1e6;
}

/** 日期要在行程起訖的寬容範圍內；用 ISO 字串直接比大小即可 */
function tripDate(v, trip) {
  const d = typeof v === 'string' ? v.slice(0, 10) : '';
  if (!DATE_RE.test(d)) throw new ShareError(400, 'date 要用 YYYY-MM-DD');
  const floor = shiftDate(trip.startDate, -DATE_SLACK_DAYS);
  const ceil = shiftDate(trip.endDate, DATE_SLACK_DAYS);
  if (d < floor || d > ceil) {
    throw new ShareError(400, `date 要在 ${floor} 到 ${ceil} 之間（這趟旅行的日期外加 ${DATE_SLACK_DAYS} 天）`);
  }
  return d;
}

/** 純 UTC 的日期加減：只是挪天數來比範圍，不需要時區知識 */
function shiftDate(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

function idOf(body, prefix) {
  if (body?.id === undefined || body.id === null || body.id === '') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
    throw new ShareError(400, `id 要是一個 3–80 字的不重複代碼（客戶端產生，重複送才會合併成同一筆）`);
  }
  return body.id;
}

/** 同一個 id 已經掛在別趟旅行：這是越權，不是寫錯 */
function assertSameTrip(existing, tripId, kind) {
  if (existing && existing.tripId !== tripId) {
    throw new ShareError(403, `這個 id 屬於別的旅行，分享連結動不了${kind}`);
  }
}

/* ------------------------------------------------------------ 分享用的視圖 */

/**
 * 分享頁要的資料：只有這一趟，而且刻意不給照片的 base64。
 * 沒有帳號系統，所以「給誰看了什麼」要能被審計：回傳 share 的標籤與期限。
 */
export function sharePayload(snapshot, tripId, share) {
  const trip = (snapshot.trips ?? []).find((t) => t.id === tripId);
  if (!trip) throw new ShareError(404, '這趟旅行已經不在伺服器上（可能還沒同步，或已被清除）');
  const items = (snapshot.dayItems ?? [])
    .filter((x) => x.tripId === tripId)
    .sort((a, b) => (a.date === b.date ? (a.order ?? 0) - (b.order ?? 0) : String(a.date).localeCompare(String(b.date))));
  const expenses = (snapshot.expenses ?? [])
    .filter((e) => e.tripId === tripId)
    .sort((a, b) => (a.date === b.date ? String(a.createdAt).localeCompare(String(b.createdAt)) : String(a.date).localeCompare(String(b.date))));
  const used = new Set(expenses.map((e) => e.category));
  return {
    trip,
    items,
    expenses,
    // 內建分類是共用的，送出去不洩漏什麼；擁有者自訂的分類只送這一趟用過的，
    // 不然同行者要選「餐飲」時會看到一張空清單（這一趟還沒有任何支出時）。
    categories: (snapshot.categories ?? []).filter(
      (c) => c.kind === 'item' || c.builtin === true || used.has(c.id) || used.has(c.key),
    ),
    totals: {
      items: items.length,
      expenses: expenses.length,
      baseAmount: Math.round(expenses.reduce((s, e) => s + Number(e.baseAmount ?? 0), 0) * 100) / 100,
      byCurrency: byCurrency(expenses),
      lastWrite: expenses.concat(items).reduce((m, r) => (String(r.updatedAt) > m ? String(r.updatedAt) : m), ''),
    },
    share: { label: share.label ?? '', createdAt: share.createdAt, expiresAt: share.expiresAt ?? null },
  };
}

function byCurrency(expenses) {
  const out = {};
  for (const e of expenses) {
    const c = String(e.currency ?? '');
    out[c] ??= { amount: 0, count: 0, baseAmount: 0 };
    out[c].amount = Math.round((out[c].amount + Number(e.amount ?? 0)) * 100) / 100;
    out[c].baseAmount = Math.round((out[c].baseAmount + Number(e.baseAmount ?? 0)) * 100) / 100;
    out[c].count += 1;
  }
  return out;
}

/* ---------------------------------------------------------------- 寫入端 */

/**
 * 把送來的支出裁成合法的一列。
 *
 * 三道鎖：tripId 一律用 token 對應的那趟（送什麼都不算）；主幣別的金額由伺服器
 * 自己算（不信任客戶端的 baseAmount，統計才會一致）；跨趟的 id 直接 403。
 * 時間戳由伺服器蓋，避免裝置時鐘跑太快，把基準檔裡「未來才改的資料」洗掉。
 */
export function sanitizeExpense(body, ctx) {
  const { trip, existing, itemIds, now } = ctx;
  const id = idOf(body, 'exp');
  assertSameTrip(existing?.expenses?.get(id), trip.id, '支出');
  const currency = /^[A-Z]{3,8}$/.test(String(body?.currency ?? '').toUpperCase())
    ? String(body.currency).toUpperCase()
    : trip.baseCurrency;
  const amount = money(body?.amount);
  if (amount === null) throw new ShareError(400, 'amount 要是大於 0 的數字');
  let rate = 1;
  if (currency !== trip.baseCurrency) {
    rate = Number(body?.rateToBase);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000_000) {
      throw new ShareError(400, `rateToBase：1 ${currency} 換多少 ${trip.baseCurrency}？請填大於 0 的數字`);
    }
    rate = Math.round(rate * 1e6) / 1e6;
  }
  const dayItemId = body?.dayItemId ? String(body.dayItemId) : null;
  if (dayItemId && !itemIds.has(dayItemId)) throw new ShareError(400, 'dayItemId 不是這趟旅行的行程項');
  const prev = existing?.expenses?.get(id);
  return {
    id,
    tripId: trip.id,
    dayItemId,
    date: tripDate(body?.date ?? trip.startDate, trip),
    amount,
    currency,
    rateToBase: rate,
    baseAmount: Math.round(amount * rate * 100) / 100,
    category: text(body?.category, 60),
    payee: text(body?.payee, 60),
    note: text(body?.note, 500),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

/** 把送來的行程項裁成合法的一列，規則同上 */
export function sanitizeItem(body, ctx) {
  const { trip, existing, maxOrder, now } = ctx;
  const id = idOf(body, 'item');
  assertSameTrip(existing?.items?.get(id), trip.id, '行程');
  const title = text(body?.title, 160);
  if (!title) throw new ShareError(400, 'title 不能空著');
  const lat = coord(body?.lat, 90);
  const lng = coord(body?.lng, 180);
  const startTime = TIME_RE.test(String(body?.startTime ?? '')) ? String(body.startTime) : null;
  const endTime = TIME_RE.test(String(body?.endTime ?? '')) ? String(body.endTime) : null;
  const order = Number.isFinite(Number(body?.order)) ? Math.trunc(Number(body.order)) : maxOrder + 10;
  const prev = existing?.items?.get(id);
  return {
    id,
    tripId: trip.id,
    date: tripDate(body?.date ?? trip.startDate, trip),
    kind: ITEM_KINDS.includes(body?.kind) ? body.kind : 'other',
    title,
    startTime,
    endTime,
    location: text(body?.location, 200),
    lat: lat !== null && lng !== null ? lat : null,
    lng: lat !== null && lng !== null ? lng : null,
    note: text(body?.note, 2000),
    order,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

/** 寫進基準檔的最小文件：只帶這列，其餘欄位留空陣列，合併交給 merge-core */
export function partialOf(table, row) {
  return {
    format: 'triplog-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    trips: [],
    dayItems: table === 'dayItems' ? [row] : [],
    expenses: table === 'expenses' ? [row] : [],
    categories: [],
    photos: [],
    meta: [],
  };
}
