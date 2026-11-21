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
  share: { label: string; createdAt: string; expiresAt: string | null };
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
  | 'tooMany'
  | 'conflict'
  | 'server'
  | 'network'
  | 'insecure';

export class ShareError extends Error {
  code: ShareErrorCode;
  /** 410 的兩種死因要分開講：被作廢 vs 到期 */
  reason?: string;
  constructor(code: ShareErrorCode, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
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

type FetchInit = { method?: 'GET' | 'POST'; body?: unknown; token?: string };

async function call<T>(url: string, init: FetchInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
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

export function fetchShare(token: string): Promise<ShareView> {
  return call<ShareView>(shareApiUrl(`api/share/${encodeURIComponent(token)}`));
}

/** 記一筆支出。id 自己產生：按兩下去才不會變兩筆 */
export function pushShareExpense(token: string, draft: ExpenseDraft): Promise<{ expense: Expense }> {
  return call(shareApiUrl(`api/share/${encodeURIComponent(token)}/expense`), {
    body: { id: newId('exp'), ...draft },
  });
}

export function pushShareItem(token: string, draft: ItemDraft): Promise<{ item: DayItem }> {
  return call(shareApiUrl(`api/share/${encodeURIComponent(token)}/item`), {
    body: { id: newId('item'), ...draft },
  });
}

/** 同行者的名字（誰付的／誰加的），記在本機 localStorage，不上伺服器 */
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
 */
export async function createShare(
  cfg: SyncConfig,
  input: { tripId: string; expiresInDays?: number | 'never'; label?: string },
): Promise<ShareRow> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/shares`;
  const body = { tripId: input.tripId, expiresInDays: input.expiresInDays ?? 90, label: input.label };
  try {
    const r = await call<{ share: ShareRow }>(url, { body, token: cfg.apiKey });
    return r.share;
  } catch (err) {
    if (!(err instanceof ShareError) || err.code !== 'conflict') throw err;
    await syncNow(cfg);
    const r = await call<{ share: ShareRow }>(url, { body, token: cfg.apiKey });
    return r.share;
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
