/**
 * 共筆邀請的客戶端（帳號模式）。
 *
 * 跟分享連結最大的差別是「是誰在記」：連結那條路只認 token，誰拿到都一樣；
 * 這裡認的是登入者 Google 帳號裡那顆已驗證的信箱。所以：
 * - 邀請人這側用 session（存進 SyncConfig.apiKey 的那條 `tls_`）打 /api/invites。
 * - 受邀者那側打 /api/trips/<tripId>/shared*，讀寫的都是**邀請人那份帳本**。
 *
 * 刻意不把那一趟拉進本機 IndexedDB：同一個 trip id 若同時存在兩個人那份帳裡，
 * 之後各寫各的、同步時會交叉覆寫，誰也說不清哪一份是新的。真要看自己的行程，
 * 請邀請人把這一趟同步給你（走原本那條 sync），共筆只負責「當場補一筆」。
 */
import type { Category, DayItem, Expense, Trip } from '../db/types';
import type { Key } from '../i18n';
import type { SyncConfig } from './sync';

export type InviteRole = 'read' | 'write';

export type InviteRow = {
  id: string;
  tripId: string;
  owner: string;
  email: string;
  role: InviteRole;
  createdAt: string;
  revokedAt: string | null;
  /** 受邀者清單上才有：誰邀的 */
  ownerName?: string | null;
  /** 邀請送出時回來的那一趟的名字 */
  tripName?: string;
  landingUrl?: string;
};

export type InviteErrorCode =
  | 'login'
  | 'noInvite'
  | 'readonly'
  | 'notfound'
  | 'gone'
  | 'conflict'
  | 'tooMany'
  | 'network'
  | 'offline'
  | 'insecure'
  | 'server';

export class InviteError extends Error {
  code: InviteErrorCode;
  /** 403 的兩種原因要分開講：沒被邀請 vs 邀請是唯讀 */
  need?: string;
  constructor(code: InviteErrorCode, message: string, need?: string) {
    super(message);
    this.code = code;
    this.need = need;
  }
}

/* ------------------------------------------------------------------ 請求 */

type Init = { method?: 'GET' | 'POST'; body?: unknown };

/** 位址的規則集中在這裡：https（本機開發用的 http 除外），尾斜線收掉 */
export function apiUrlOf(cfg: SyncConfig, path: string): string {
  const origin = cfg.baseUrl.trim().replace(/\/+$/, '');
  if (!origin) throw new InviteError('insecure', '還沒有伺服器位址：先記著就好，等設定裡填好位址再共筆');
  const localHttp = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(origin);
  if (!origin.startsWith('https://') && !localHttp) {
    // 這一條路送出去的是登入憑證，比金鑰更要緊：非加密的位址一律不打
    throw new InviteError('insecure', '共筆要把這台裝置的登入憑證送出去，伺服器位址必須是 https');
  }
  return `${origin}${path}`;
}

async function call<T>(cfg: SyncConfig, path: string, init: Init = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrlOf(cfg, path), {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new InviteError('offline', (err as Error).message);
    }
    throw new InviteError('network', (err as Error).message);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* Caddy 之類的純文字錯誤頁：留空，按狀態碼說話 */
  }
  const msg = typeof json.error === 'string' ? json.error : '';
  if (res.status === 401) throw new InviteError('login', msg || '這台裝置的登入已失效，請到「設定 → 帳號」重新登入');
  if (res.status === 403) {
    // 伺服器把「沒邀請到你」與「那是唯讀邀請」分開講，這裡只做分流，不改寫它的句子
    if (json.need === 'invite') throw new InviteError('noInvite', msg, 'invite');
    if (/唯讀/.test(msg)) throw new InviteError('readonly', msg);
    throw new InviteError('server', msg || 'HTTP 403');
  }
  if (res.status === 404) throw new InviteError('notfound', msg);
  if (res.status === 409) throw new InviteError('conflict', msg);
  if (res.status === 410) throw new InviteError('gone', msg);
  if (res.status === 429) throw new InviteError('tooMany', msg);
  if (!res.ok) throw new InviteError('server', msg || `HTTP ${res.status}`);
  return json as T;
}

/* -------------------------------------------------------------- 邀請人側 */

export function listInvites(cfg: SyncConfig, tripId?: string): Promise<InviteRow[]> {
  const q = tripId ? `?tripId=${encodeURIComponent(tripId)}` : '';
  return call<{ invites: InviteRow[] }>(cfg, `/api/invites${q}`).then((r) => r.invites ?? []);
}

/**
 * 邀一個人一起記某一趟。信箱寫錯就讓人改名單，不在這裡兜底：
 * 那顆信箱之後就是他登入時的身分，猜不出來也不該猜。
 */
export function createInvite(
  cfg: SyncConfig,
  input: { tripId: string; email: string; role?: InviteRole },
): Promise<InviteRow> {
  return call<{ invite: InviteRow }>(cfg, '/api/invites', {
    body: { tripId: input.tripId, email: input.email.trim().toLowerCase(), role: input.role ?? 'write' },
  }).then((r) => r.invite);
}

export function revokeInvite(cfg: SyncConfig, id: string): Promise<{ changed: boolean }> {
  return call<{ changed: boolean }>(cfg, '/api/invites/revoke', { body: { id } });
}

/* -------------------------------------------------------------- 受邀者側 */

export function myInvites(cfg: SyncConfig): Promise<{ email: string; invites: InviteRow[] }> {
  return call<{ email: string; invites: InviteRow[] }>(cfg, '/api/invites/mine');
}

export function leaveInvite(cfg: SyncConfig, tripId: string): Promise<{ changed: boolean }> {
  return call<{ changed: boolean }>(cfg, '/api/invites/leave', { body: { tripId } });
}

/**
 * 那一趟在受邀者眼裡的樣子。形狀與分享頁相同（同一套表單才不用寫兩遍），
 * 但它是自己一型：伺服器的共筆回應裡沒有 `head`，也沒有連結的 label／期限。
 */
export type SharedTripView = {
  ok: true;
  scope: 'grant';
  grant: { role: InviteRole; tripId: string };
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
};

export function fetchSharedTrip(cfg: SyncConfig, tripId: string): Promise<SharedTripView> {
  return call<SharedTripView>(cfg, `/api/trips/${encodeURIComponent(tripId)}/shared`);
}

const newId = (prefix: string): string =>
  `${prefix}_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;

/** 代記一筆：寫的是邀請人那份帳本，本機不留底（見檔首那段說明） */
export function pushSharedExpense(
  cfg: SyncConfig,
  tripId: string,
  draft: { date: string; amount: number; currency: string; rateToBase?: number | null; category?: string; payee?: string; note?: string },
): Promise<{ expense: Expense }> {
  return call<{ expense: Expense }>(cfg, `/api/trips/${encodeURIComponent(tripId)}/shared/expense`, { body: { id: newId('exp'), ...draft } });
}

/**
 * 代排一個行程項。時間與備註留空就是不填——伺服器自己認 `HH:MM` 形狀、
 * 把日期夾進這趟的範圍、order 接在最後面，所以客戶端不需要知道現有的排序。
 */
export function pushSharedItem(
  cfg: SyncConfig,
  tripId: string,
  draft: {
    date: string;
    kind: string;
    title: string;
    startTime?: string | null;
    endTime?: string | null;
    location?: string;
    note?: string;
  },
): Promise<{ item: DayItem }> {
  return call<{ item: DayItem }>(cfg, `/api/trips/${encodeURIComponent(tripId)}/shared/item`, { body: { id: newId('item'), ...draft } });
}

/* ------------------------------------------------------------------ 文案 */

/** 清單上只留還算數的邀請：撤過的不該繼續出現在「共筆中」裡 */
export function liveInvites(rows: InviteRow[]): InviteRow[] {
  return rows.filter((r) => !r.revokedAt);
}

/** 信箱形狀的輕檢查：真正的把關在伺服器（那顆信箱要等於他 Google 帳號的已驗證信箱） */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 320;
}

export type SharedTripSummary = {
  trip: Trip;
  items: DayItem[];
  expenses: Expense[];
  categories: Category[];
};

/** 頁面只要這四樣，其他（totals/head/grant）留在回應裡給別的地方用 */
export function summaryOf(view: SharedTripView): SharedTripSummary {
  return { trip: view.trip, items: view.items ?? [], expenses: view.expenses ?? [], categories: view.categories ?? [] };
}

const ERROR_KEYS: Partial<Record<InviteErrorCode, Key>> = {
  login: 'invite.errLogin',
  noInvite: 'invite.errNoInvite',
  readonly: 'invite.errReadonly',
  notfound: 'invite.errNotFound',
  gone: 'invite.errGone',
  conflict: 'invite.errConflict',
  tooMany: 'invite.errTooMany',
  network: 'invite.errNetwork',
  offline: 'invite.errOffline',
  insecure: 'invite.errInsecure',
};

/** 講人話：401 缺的是登入鈕，403 缺的是邀請，兩者不該都寫成「權限不足」 */
export function describeInviteError(err: unknown, t: Translate): string {
  const code = (err as { code?: InviteErrorCode })?.code;
  const key = code ? ERROR_KEYS[code] : undefined;
  if (key) return t(key);
  return (err as Error)?.message ?? t('invite.errServer');
}

type Translate = (key: Key, vars?: Record<string, string | number>) => string;
