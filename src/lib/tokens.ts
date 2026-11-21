/**
 * 「設定 → API token」用的客戶端。
 *
 * 主金鑰（.env 裡的 TRIPLOG_API_KEY）等於整座資料庫的密碼，弄丟要動到伺服器與
 * 每台裝置。所以要把存取交給 agent 或一台新裝置時，用這裡簽發的 token：
 * 自帶層級（唯讀／可寫）與期限，能在 app 裡單獨撤銷，而且資料庫裡只存雜湊，
 * 備份外洩也拿不到能用的字串（代價是完整值只在簽發當下顯示一次）。
 *
 * 這組介面一律用主金鑰打 /api/tokens；拿簽發出去的 token 叫它是 403，
 * 那樣等於任何一把外流的 agent 憑證都能自己再發一把。
 */
import type { Key } from '../i18n';
import type { SyncConfig } from './sync';

export type TokenScope = 'read' | 'write';

export type ApiTokenRow = {
  id: string;
  /** 給人在清單上認用的頭尾幾字，例如 tlk_ab12…9wZx */
  hint: string;
  label: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  hits: number;
  writes: number;
  lastSeenAt: string | null;
};

export type TokenState = 'active' | 'revoked' | 'expired';

export type TokenErrorCode = 'auth' | 'offline' | 'network' | 'notfound' | 'tooMany' | 'server';

export class TokenError extends Error {
  code: TokenErrorCode;
  constructor(code: TokenErrorCode, message = '') {
    super(message);
    this.code = code;
  }
}

const endpoint = (cfg: SyncConfig, path = ''): string =>
  `${cfg.baseUrl.replace(/\/+$/, '')}/api/tokens${path}`;

async function request<T>(cfg: SyncConfig, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(endpoint(cfg, path), {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new TokenError(offline ? 'offline' : 'network', (err as Error).message);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* Caddy 的純文字錯誤頁也要能講出人話，不要在這裡炸一個 JSON parse 錯 */
  }
  const msg = typeof json.error === 'string' ? json.error : '';
  if (res.status === 401 || res.status === 403) throw new TokenError('auth', msg);
  if (res.status === 404) throw new TokenError('notfound', msg);
  if (res.status === 429) throw new TokenError('tooMany', msg);
  if (!res.ok) throw new TokenError('server', msg || `HTTP ${res.status}`);
  return json as T;
}

export function listApiTokens(cfg: SyncConfig): Promise<ApiTokenRow[]> {
  return request<{ tokens: ApiTokenRow[] }>(cfg, '').then((r) => r.tokens ?? []);
}

/** 回傳的 `secret` 是這輩子唯一一次看得到完整值，呼叫方要用一次性的方式顯示 */
export function createApiToken(
  cfg: SyncConfig,
  input: { label: string; scope: TokenScope; expiresInDays: number | 'never' },
): Promise<{ secret: string; row: ApiTokenRow }> {
  return request<{ secret: string; token: ApiTokenRow }>(cfg, '', {
    label: input.label,
    scope: input.scope,
    expiresInDays: input.expiresInDays,
  }).then((r) => ({ secret: r.secret, row: r.token }));
}

export function revokeApiToken(cfg: SyncConfig, id: string): Promise<{ changed: boolean }> {
  return request<{ changed: boolean }>(cfg, '/revoke', { id });
}

/** 清單上的狀態：作廢比過期優先講，那是擁有者主動做的事 */
export function tokenState(row: ApiTokenRow, now = Date.now()): TokenState {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return 'expired';
  return 'active';
}

export function activeTokens(rows: ApiTokenRow[], now = Date.now()): ApiTokenRow[] {
  return rows.filter((r) => tokenState(r, now) === 'active');
}

const ERR_KEYS: Record<TokenErrorCode, Key> = {
  auth: 'tokens.errAuth',
  offline: 'share.errOffline',
  network: 'share.errNetwork',
  notfound: 'tokens.errNotFound',
  tooMany: 'share.errTooMany',
  server: 'share.errServer',
};

type Translate = (key: Key, vars?: Record<string, string | number | undefined | null>) => string;

/**
 * 這兩種情況一律講我們自己的話：後端的 401/403 訊息是狀態說明（「missing or wrong bearer
 * token」），繁體介面上出現它對使用者毫無幫助；本地文案直接點名「要換主金鑰」。
 */
const LOCAL_FIRST: TokenErrorCode[] = ['auth', 'notfound'];

/** 後端打得清楚時就用它的話（例如「expiresInDays 不能超過 365」），否則用我們的語系字串 */
export function describeTokenError(err: unknown, t: Translate): string {
  if (err instanceof TokenError) {
    const serverSaid = err.message.trim();
    if (LOCAL_FIRST.includes(err.code)) return t(ERR_KEYS[err.code]);
    return serverSaid || t(ERR_KEYS[err.code]);
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return t('share.errServer');
}
