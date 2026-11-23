/**
 * 分享連結的客戶端。
 *
 * 兩套身分，兩條路徑：
 * - 擁有者：用「設定 → 跨裝置同步」的金鑰打 /api/shares（產生、列出、作廢連結）。
 * - 同行者：只有連結，打 /api/share/<token>，不需要金鑰，也只能碰到這一趟。
 *
 * 分享頁刻意不碰 IndexedDB：來按連結的人可能是借用別人的手機，
 * 把這趟旅行種進那台裝置的瀏覽器裡、還不知道什麼時候會被清掉，
 * 不是我們該做的事。他加的記錄直接回到伺服器，擁有者下次同步就收到。
 */
import type { Category, DayItem, Expense, Trip } from '../db/types';
import type { Key } from '../i18n';
import { syncNow, type SyncConfig } from './sync';

export type ShareRow = {
  token: string;
  tripId: string;
  label: string;
  createdAt: string;
  /** null = 不設限期 */
  expiresAt: string | null;
  revokedAt: string | null;
  hits: number;
  writes: number;
  lastSeenAt: string | null;
  /** false ＝這把連結只能看（後端 POST 一律 403） */
  canWrite: boolean;
  /** 有沒有設訪客 PIN：伺服器永遠只回這個旗標，不會把雜湊傳出來 */
  hasPin: boolean;
  /** 最後一個用這條連結記錄的人（沒有任何記錄時是空字串） */
  lastWriter: string;
};

export type ShareView = {
  ok: true;
  trip: Trip;
  items: DayItem[];
  expenses: Expense[];
  categories: Category[];
  totals: {
    items: number;
    expenses: number;
    baseAmount: number;
    byCurrency: Record<string, { amount: number; count: number; baseAmount: number }>;
    lastWrite: string;
  };
  /**
   * 匿名訪客只拿得到這兩個旗標：hasPin 不在這裡——有無 PIN 由 GET 的回應碼自己說，
   * 把旗標傳出去等於是告訴拿到連結的人「這把鑰匙還有第二層」，沒意義。
   */
  share: { label: string; createdAt: string; expiresAt: string | null; canWrite: boolean };
  head: { id: string; exportedAt: string } | null;
};

export type ExpenseDraft = {
  id?: string;
  date: string;
  amount: number;
  currency: string;
  rateToBase?: number | null;
  category?: string;
  payee?: string;
  note?: string;
  dayItemId?: string | null;
};

export type ItemDraft = {
  id?: string;
  date: string;
  kind: string;
  title: string;
  startTime?: string | null;
  endTime?: string | null;
  location?: string;
  lat?: number | null;
  lng?: number | null;
  note?: string;
};

/** 409：伺服器上還沒有這一趟，先同步再試 */
export type ShareErrorCode =
  | 'offline'
  | 'gone'
  | 'notfound'
  | 'auth'
  /** 401＋needPin：要訪客 PIN（還沒填或填錯），跟身分不對是兩件事 */
  | 'pin'
  /** 403＋readOnly：這條連結只能看，寫入一律被擋 */
  | 'readonly'
  | 'tooMany'
  | 'conflict'
  | 'server'
  | 'network'
  | 'insecure';

export class ShareError extends Error {
  code: ShareErrorCode;
  /** 410 的兩種死因要分開講：被作廢 vs 到期 */
  reason?: string;
  /**
   * 401＋needPin 順帶回來的 canWrite：問 PIN 那張卡片要照它改口，
   * 否則唯讀連結會先叫人家「填了 PIN 就能記帳」，填完才被打第二次。
   */
  canWrite?: boolean;
  constructor(code: ShareErrorCode, message: string, reason?: string, canWrite?: boolean) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.canWrite = canWrite;
  }
}

/* ------------------------------------------------------------------ 位址 */

/**
 * 同行者那一側的 API 位址：跟頁面同來源，所以不用填伺服器位址、也不會打到別家。
 * 拿掉 hash 再解析相對路徑，這樣 app 放在子目錄時一樣對。
 */
export function shareApiUrl(path: string): string {
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href.replace(/[#?].*$/, '');
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

/** 給同行者的連結：同一個 origin 上的 hash 路由 */
export function shareLink(baseUrl: string, token: string): string {
  const origin = new URL(baseUrl).origin;
  return `${origin}/#/share/${token}`;
}

/* ------------------------------------------------------------------ 請求 */

type FetchInit = { method?: 'GET' | 'POST'; body?: unknown; token?: string; pin?: string };

async function call<T>(url: string, init: FetchInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  // PIN 走標頭而不是塞進表單：要寫入的內容不該夾著一道入場關卡，
  // 除錯時複製那份 JSON 也不會連 PIN 一起傳出去
  if (init.pin) headers['x-triplog-pin'] = init.pin;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new ShareError('offline', (err as Error).message);
    }
    throw new ShareError('network', (err as Error).message);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON（例如 Caddy 的純文字錯誤頁）就當空體 */
  }
  const serverMsg = typeof json.error === 'string' ? json.error : '';
  if (res.status === 410) throw new ShareError('gone', serverMsg, String(json.reason ?? ''));
  if (res.status === 404) throw new ShareError('notfound', serverMsg);
  if (res.status === 409) throw new ShareError('conflict', serverMsg);
  // 需要訪客 PIN 的 401 不能混進「金鑰不對」那條：畫面上要問 PIN，不是叫人去檢查設定
  if (res.status === 401 && json.needPin === true) {
    const cw = typeof json.canWrite === 'boolean' ? json.canWrite : undefined;
    throw new ShareError('pin', serverMsg, undefined, cw);
  }
  // 唯讀連結的 403 同理：那是連結本身的權限，不是這位訪客搞錯身分
  if (res.status === 403 && json.readOnly === true) throw new ShareError('readonly', serverMsg);
  if (res.status === 401 || res.status === 403) throw new ShareError('auth', serverMsg);
  if (res.status === 429) throw new ShareError('tooMany', serverMsg);
  if (!res.ok) throw new ShareError('server', serverMsg || `HTTP ${res.status}`);
  return json as T;
}

const newId = (prefix: string): string =>
  `${prefix}_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;

/** 剪貼簿在非 https 或舊瀏覽器會被打回，失敗時呼叫方要留一條手動複製的路 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- 同行者側 */

/**
 * 讀這一趟。`pin` 是這把連結的訪客 PIN（有設才需要）；
 * 沒對的話伺服器只回「要 PIN」，不會把資料傳出來。
 */
export function fetchShare(token: string, pin = ''): Promise<ShareView> {
  return call<ShareView>(shareApiUrl(`api/share/${encodeURIComponent(token)}`), { pin });
}

/**
 * 記一筆支出。id 自己產生：按兩下去才不會變兩筆。
 * `who` 只是讓連結那側記住「最後是誰來記錄」，不會動到 payee／note 的寫法。
 */
export function pushShareExpense(
  token: string,
  draft: ExpenseDraft,
  pin = '',
  who = '',
): Promise<{ expense: Expense }> {
  return call(shareApiUrl(`api/share/${encodeURIComponent(token)}/expense`), {
    body: { id: newId('exp'), ...draft, ...(who ? { who } : {}) },
    pin,
  });
}

export function pushShareItem(token: string, draft: ItemDraft, pin = '', who = ''): Promise<{ item: DayItem }> {
  return call(shareApiUrl(`api/share/${encodeURIComponent(token)}/item`), {
    body: { id: newId('item'), ...draft, ...(who ? { who } : {}) },
    pin,
  });
}

/**
 * 同行者的名字（誰付的／誰加的）：存在本機 localStorage，重新開連結還填得回來。
 * 送出時它本來就在 payee／note 裡跟著上去，額外那欄 `who` 只讓連結記住最後是誰。
 */
const WHO_KEY = 'triplog:share:who';

export function loadViewerName(): string {
  try {
    return localStorage.getItem(WHO_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveViewerName(name: string): void {
  try {
    if (name) localStorage.setItem(WHO_KEY, name);
    else localStorage.removeItem(WHO_KEY);
  } catch {
    /* 無痕模式記不住名字，按了還是能送 */
  }
}

/**
 * 訪客 PIN 記在 sessionStorage，而且按 token 分開放。
 *
 * 用 sessionStorage 不是偷懶：同行者常常是借用別人的手機，
 * PIN 該跟著這個分頁一起消失，不該留在那台裝置上給下一個人用。
 * 分 token 是因為同一個分頁可能開兩條不一樣的連結，混在一起會互相蓋掉。
 * 名字（WHO_KEY）反而留 localStorage——那是「我是誰」，不是鑰匙。
 */
const PIN_KEY = 'triplog:share:pin';

function pinMap(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(PIN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    // 存過壞值（或被人動過）就當沒有，讀 PIN 不該把頁面弄崩
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadSharePin(token: string): string {
  const v = pinMap()[token];
  return typeof v === 'string' ? v : '';
}

/** 傳空字串＝忘記這條的 PIN（例如送出去被打回），下次就當沒填 */
export function saveSharePin(token: string, pin: string): void {
  try {
    const map = { ...pinMap() };
    if (pin) map[token] = pin;
    else delete map[token];
    sessionStorage.setItem(PIN_KEY, JSON.stringify(map));
  } catch {
    /* 無痕模式記不住 PIN：每次重新整理重填一次而已，功能不會壞 */
  }
}

/* -------------------------------------------------------------- 擁有者側 */

export function listShares(cfg: SyncConfig, tripId?: string): Promise<ShareRow[]> {
  const q = tripId ? `?tripId=${encodeURIComponent(tripId)}` : '';
  return call<{ shares: ShareRow[] }>(`${cfg.baseUrl.replace(/\/+$/, '')}/api/shares${q}`, { token: cfg.apiKey }).then(
    (r) => r.shares ?? [],
  );
}

/**
 * 產生連結。這趟還沒推上伺服器時後端回 409（連結開了會是一片空），
 * 所以這裡先補跑一次同步再試一次——使用者按的是「分享」，
 * 不該先學會「同步」。
 *
 * `pin` 的明文只在建立這一次的回應裡出現（伺服器那邊留的是雜湊），
 * 所以照原樣交回給對話框顯示一次；關掉之後就再也問不進了。
 */
export async function createShare(
  cfg: SyncConfig,
  input: { tripId: string; expiresInDays?: number | 'never'; label?: string; pin?: string; canWrite?: boolean },
): Promise<{ row: ShareRow; pin: string }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/shares`;
  // 形狀不對的 PIN 不送（後端只認 4–8 位數字）：對話框那關先擋，這裡算第二道，
  // 免得使用者貼了帶空白或型號的字串，只收到一句看不懂的回覆
  const digits = String(input.pin ?? '').replace(/[^\d]/g, '');
  const body = {
    tripId: input.tripId,
    expiresInDays: input.expiresInDays ?? 90,
    label: input.label,
    // 未設定時當做可記帳：跟沒有這個開關的舊行為一致
    canWrite: input.canWrite !== false,
    ...(digits.length >= 4 && digits.length <= 8 ? { pin: digits } : {}),
  };
  const send = () => call<{ share: ShareRow; pin?: string }>(url, { body, token: cfg.apiKey });
  try {
    const r = await send();
    return { row: r.share, pin: typeof r.pin === 'string' ? r.pin : '' };
  } catch (err) {
    if (!(err instanceof ShareError) || err.code !== 'conflict') throw err;
    await syncNow(cfg);
    const r = await send();
    return { row: r.share, pin: typeof r.pin === 'string' ? r.pin : '' };
  }
}

export function revokeShare(cfg: SyncConfig, token: string): Promise<{ revoked: boolean }> {
  return call(`${cfg.baseUrl.replace(/\/+$/, '')}/api/shares/revoke`, { body: { token }, token: cfg.apiKey });
}

/** 還活著的連結（過期與已作廢的不算） */
export function activeShares(rows: ShareRow[], now = Date.now()): ShareRow[] {
  return rows.filter((r) => !r.revokedAt && (!r.expiresAt || Date.parse(r.expiresAt) > now));
}

/** 詞典函數：components 直接把 useI18n 的 t 交進來 */
type Translate = (key: Key, vars?: Record<string, string | number>) => string;

const ERROR_KEYS: Record<string, Key> = {
  expired: 'share.errExpired',
  revoked: 'share.errRevoked',
  gone: 'share.errExpired',
  offline: 'share.errOffline',
  network: 'share.errNetwork',
  insecure: 'share.errInsecure',
  notfound: 'share.errNotFound',
  auth: 'share.errAuth',
  pin: 'share.errPin',
  readonly: 'share.errReadOnly',
  tooMany: 'share.errTooMany',
  conflict: 'share.errConflict',
  server: 'share.errServer',
  badpayload: 'share.errServer',
};

/** 錯誤要講人話：同行的人不懂什麼叫 410，也不該去背 SyncError 的代碼 */
export function describeShareError(err: unknown, t: Translate): string {
  // ShareError 與 sync.ts 的 SyncError 都帶一個 code，這裡一起處理
  const code = (err as { code?: string })?.code ?? '';
  // 410 另有 reason（被作廢 vs 到期），優先按它分
  const reason = (err as { reason?: string })?.reason ?? '';
  const key = ERROR_KEYS[reason] ?? ERROR_KEYS[code];
  if (key) return t(key);
  return (err as Error)?.message ?? t('share.errServer');
}
