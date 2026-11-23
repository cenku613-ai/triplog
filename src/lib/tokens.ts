/**
 * 「設定 → 金鑰與裝置」用的客戶端。
 *
 * 主金鑰（.env 裡的 TRIPLOG_API_KEY）等於整座資料庫的密碼，弄丟要動到伺服器與
 * 每台裝置。所以要把存取交給 agent 或一台新裝置時，用這裡簽發的 token：
 * 自帶層級（唯讀／可寫）與期限，能在 app 裡單獨撤銷，而且資料庫裡只存雜湊，
 * 備份外洩也拿不到能用的字串（代價是完整值只在簽發當下顯示一次）。
 *
 * 金鑰的整個生命週期都在這個畫面裡：
 * - 簽發憑證（`createApiToken`）與套用到這台裝置（`saveSyncConfig`），裝置不必再放主金鑰
 * - 產生一次性配對碼（`createPairingCode`），新裝置只打 8 個字就換到一把憑證（`pairWithCode`）
 * - 輪換主金鑰（`rotateMasterKey`）：換完 `.env` 那把當場失效，只剩資料庫裡那把能用
 *
 * 這組介面用**主金鑰**或**已登入裝置那條 session** 打 `/api/tokens`：主金鑰管全站，
 * 登入者只能替自己的帳號簽發與撤銷。唯獨拿簽發出去的 `tlk_` 叫它是 403——那樣等於任何
 * 一把外流的 agent 憑證都能自己再發一把。唯一不需要金鑰的是 `/api/pair`，
 * 它靠配對碼本身授權，而且有獨立限流。
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

/**
 * 本機存的那把金鑰是不是「設定頁簽發出來的憑證」：前綴就夠了，客戶端拿不到雜湊，
 * 也不需要——我們只想知道裝置上放的是主金鑰（整座庫的密碼）還是可以單獨撤銷的憑證。
 */
export function isIssuedToken(key: string): boolean {
  return /^tlk_[A-Za-z0-9_-]{20,}$/.test(String(key ?? '').trim());
}

/**
 * 本機那把是不是「Google 登入換來的 session」（tls_）。
 *
 * 分開認是為了介面別說錯話：金鑰模式下「不放主金鑰」等於改用可撤銷的憑證，
 * 帳號模式下這台裝置拿的則是自己的登入憑證，它看的是自己的帳本，
 * 而且能替自己的帳號簽發 token（清單與撤銷也只看得見自己那批）。
 */
export function isSessionToken(key: unknown): boolean {
  return /^tls_[A-Za-z0-9_-]{20,}$/.test(String(key ?? '').trim());
}

/** 一把憑證是不是「這台裝置正在用的那把」：比對的是顯示用的 hint，不是雜湊，所以只是標籤用途 */
export function hintOf(key: string): string {
  const s = String(key ?? '').trim();
  if (!s.startsWith('tlk_')) return '';
  return `tlk_${s.slice(4, 8)}…${s.slice(-4)}`;
}

export function isCurrentDevice(row: ApiTokenRow, key: string): boolean {
  const hint = hintOf(key);
  return hint !== '' && row.hint === hint;
}

/* ------------------------------------------------- 本裝置憑證（自動簽發） */

/** 自動簽發用的預設值：裝置要能推檔案，所以給 write；90 天是「夠用又不會長到忘了它存在」 */
export const DEVICE_TOKEN_SCOPE: TokenScope = 'write';
export const DEVICE_TOKEN_DAYS = 90;
/** 剩幾天以內要開始勸人重簽：過期那天同步會整個停，不能讓它靜靜發生 */
export const DEVICE_TOKEN_SOON_DAYS = 14;

/**
 * 本機那把是不是「還該被換掉」的長金鑰。
 *
 * 貼上來的是主金鑰或 `.env` 的只讀鑰時才該自動簽一把：前綴 `tlk_` 的已經是憑證
 * （再簽一次只是多發一把），而太短的東西（還沒填、填到一半）根本不該拿去打伺服器。
 */
export function shouldMintDeviceToken(key: unknown): boolean {
  const s = String(key ?? '').trim();
  return s.length >= 24 && !isIssuedToken(s);
}

/**
 * 從 User-Agent 湊一個人在清單上認得出的裝置名。
 *
 * 只取「哪台機器＋哪顆瀏覽器」兩件事，不碰任何可識別資訊；湊不出來就留白，
 * 由簽發時的 label 自己收（伺服器的 `tokenLabel` 有長度上限）。
 */
export function guessDeviceName(userAgent?: string): string {
  const ua = String(userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : ''));
  if (!ua) return '';
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Windows NT/i.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macOS'
          : /CrOS/i.test(ua)
            ? 'ChromeOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : '';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /MicroMessenger/i.test(ua)
          ? 'WeChat'
          : /CriOS|Chrome\//i.test(ua)
            ? 'Chrome'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : '';
  if (os === 'iOS' && /iPad/i.test(ua)) return ['iPad', browser].filter(Boolean).join(' · ');
  if (os === 'Android' && !/Mobile/i.test(ua)) return ['Android 平板', browser].filter(Boolean).join(' · ');
  return [os, browser].filter(Boolean).join(' · ');
}

/** 還剩幾天：已過期給 0，不設限期給 Infinity（介面要分開講「無限」而不是「很多天」） */
export function daysLeft(expiresAt: string | null | undefined, now = Date.now()): number {
  if (!expiresAt) return Infinity;
  const at = Date.parse(String(expiresAt));
  if (Number.isNaN(at)) return Infinity;
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

/** 這台裝置現在用的憑證是不是快到期（本機放的是主金鑰時回 false——那是另一件事） */
export function deviceTokenExpiringSoon(rows: ApiTokenRow[], key: string, now = Date.now()): boolean {
  if (!isIssuedToken(String(key ?? ''))) return false;
  const mine = rows.find((r) => isCurrentDevice(r, String(key ?? '')));
  if (!mine || tokenState(mine, now) !== 'active') return false;
  return daysLeft(mine.expiresAt, now) <= DEVICE_TOKEN_SOON_DAYS;
}

export type TokenErrorCode =
  | 'auth'
  | 'offline'
  | 'network'
  | 'notfound'
  | 'tooMany'
  | 'server'
  /** 配對碼：形狀不對或這組不存在 */
  | 'badCode'
  /** 配對碼：已被用掉（一次性） */
  | 'used'
  /** 配對碼：已被作廢或已過期 */
  | 'dead';

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

/** 範本裡留給你手改的兩格：token 與 bin.mjs 的絕對路徑（app 不知道 agent 跑在哪台電腦） */
export const AGENT_TOKEN_PLACEHOLDER = 'tlk_…';
export const AGENT_BIN_PLACEHOLDER = 'PATH/TO/triplog/mcp/bin.mjs';

/**
 * 產生一段能直接貼進 MCP 客戶端的設定（Qoder／Claude Desktop／Cursor 用的都是這個形狀）。
 *
 * 做成字串而不是物件，是因為呼叫端要的是「複製起來就能用」；格式由 `JSON.stringify`
 * 負責，人手打字打不出來的錯這裡擋在源頭。
 *
 * 唯讀那把故意放 `TRIPLOG_READ_KEY` 並補上 `TRIPLOG_ALLOW_WRITE=0`：後端已經只給讀，
 * 工具清單就別再留七個它一叫就 403 的寫入選項（這是 MCP server 認的兩個變數）。
 * 可寫的放 `TRIPLOG_API_KEY`，寫不寫得動由憑證自己的 scope 決定，不是由變數決定。
 */
export function agentConfig(baseUrl: string, secret: string, scope: TokenScope): string {
  const url = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const env =
    scope === 'read'
      ? { TRIPLOG_URL: url, TRIPLOG_READ_KEY: secret, TRIPLOG_ALLOW_WRITE: '0' }
      : { TRIPLOG_URL: url, TRIPLOG_API_KEY: secret };
  return JSON.stringify(
    { mcpServers: { triplog: { command: 'node', args: [AGENT_BIN_PLACEHOLDER], env } } },
    null,
    2,
  );
}

/* -------------------------------------------------------------- 配對碼 */

export type PairingRow = {
  id: string;
  label: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  usedLabel: string;
};

export type PairingState = 'waiting' | 'used' | 'revoked' | 'expired';

/** 配對碼的字母表：拿掉 I/L/O/0/1，手打不會看錯，所以正規化時也只認這 31 個字 */
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIR_CHARS = 8;

/**
 * 顯示用：每 4 個字加一條橫線。輸入端不必照格式打，`normalizePairCode` 會把橫線吃掉。
 */
export function formatPairCode(code: string): string {
  const s = normalizePairCode(code) ?? String(code ?? '').trim();
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** 大寫、去空白與橫線；形狀不對回 null（讓介面能即時講「還差幾個字」） */
export function normalizePairCode(input: unknown): string | null {
  const raw = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '';
  if (raw.length !== PAIR_CHARS) return null;
  for (const ch of raw) if (!PAIR_ALPHABET.includes(ch)) return null;
  return raw;
}

/** 還沒打完時也別立刻報錯：只判斷「目前這樣有沒有可能變成一組碼」 */
export function pairCodeIsPlausible(input: unknown): boolean {
  const raw = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '';
  if (!raw.length || raw.length > PAIR_CHARS) return false;
  for (const ch of raw) if (!PAIR_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * 輸入框旁邊那句即時提示用的：`left` 是還差幾個字、`bad` 是打到了不該出現的字、
 * `ready` 才是真的可以送出去。三個都算在同一個正規化結果上，介面上才不會自相矛盾。
 */
export function pairCodeProgress(input: unknown): { left: number; bad: boolean; ready: boolean } {
  const normalized = normalizePairCode(input);
  if (normalized) return { left: 0, bad: false, ready: true };
  const raw = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '';
  const bad = [...raw].some((ch) => !PAIR_ALPHABET.includes(ch));
  return { left: Math.max(0, PAIR_CHARS - raw.length), bad, ready: false };
}

export function pairingState(row: PairingRow, now = Date.now()): PairingState {
  if (row.usedAt) return 'used';
  if (row.revokedAt) return 'revoked';
  if (Date.parse(row.expiresAt) <= now) return 'expired';
  return 'waiting';
}

/** 清單上只有「還在等人來配對」的值得留著，其他都算歷史 */
export function waitingPairings(rows: PairingRow[], now = Date.now()): PairingRow[] {
  return rows.filter((r) => pairingState(r, now) === 'waiting');
}

export function createPairingCode(
  cfg: SyncConfig,
  input: { label: string; scope: TokenScope; expiresInMinutes?: number },
): Promise<{ code: string; display: string; expiresInMinutes: number; row: PairingRow }> {
  return request<{ code: string; display: string; expiresInMinutes: number; pairing: PairingRow }>(cfg, '/pairings', {
    label: input.label,
    scope: input.scope,
    ...(input.expiresInMinutes ? { expiresInMinutes: input.expiresInMinutes } : {}),
  }).then((r) => ({ code: r.code, display: r.display, expiresInMinutes: r.expiresInMinutes, row: r.pairing }));
}

export function listPairings(cfg: SyncConfig): Promise<PairingRow[]> {
  return request<{ pairings: PairingRow[] }>(cfg, '/pairings').then((r) => r.pairings ?? []);
}

export function revokePairing(cfg: SyncConfig, id: string): Promise<{ changed: boolean }> {
  return request<{ changed: boolean }>(cfg, '/pairings/revoke', { id });
}

/**
 * 新裝置那一側：只打一組配對碼，換回一把普通憑證（之後的權限、撤銷都跟憑證一樣）。
 * 這條路不需要 bearer，所以它自己組 URL，也不走 `request()`。
 */
export async function pairWithCode(
  baseUrl: string,
  code: string,
  device = '',
): Promise<{ secret: string; row: ApiTokenRow; expiresInDays: number }> {
  const normalized = normalizePairCode(code);
  if (!normalized) throw new TokenError('badCode');
  const url = `${String(baseUrl ?? '').replace(/\/+$/, '')}/api/pair`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: normalized, ...(device.trim() ? { device: device.trim() } : {}) }),
    });
  } catch (err) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new TokenError(offline ? 'offline' : 'network', (err as Error).message);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 反代的純文字錯誤頁 */
  }
  const msg = typeof json.error === 'string' ? json.error : '';
  if (res.status === 400) throw new TokenError('badCode', msg);
  if (res.status === 404) throw new TokenError('badCode', msg);
  if (res.status === 409) throw new TokenError('used', msg);
  if (res.status === 410) throw new TokenError('dead', msg);
  if (res.status === 429) throw new TokenError('tooMany', msg);
  if (!res.ok) throw new TokenError('server', msg || `HTTP ${res.status}`);
  const secret = String(json.secret ?? '');
  if (!secret) throw new TokenError('server', 'HTTP 200 卻沒有憑證');
  return { secret, row: json.token as ApiTokenRow, expiresInDays: Number(json.expiresInDays ?? 0) };
}

/* ---------------------------------------------------------- 主金鑰輪換 */

export type MasterStatus = {
  /** true＝資料庫裡那把才是主金鑰，`.env` 的已經不被接受 */
  rotated: boolean;
  hint: string;
  setAt: string | null;
  bootstrapKeyActive: boolean;
  envReadKeyActive: boolean;
  maxExpiryDays: number;
};

export function masterStatus(cfg: SyncConfig): Promise<MasterStatus> {
  return request<{ master: MasterStatus }>(cfg, '/master').then((r) => r.master);
}

/** 完整值只在這一次回應裡出現，拿到就要立刻讓使用者複製走 */
export function rotateMasterKey(
  cfg: SyncConfig,
  confirm: 'rotate-master' | 'rotate-master-no-backup',
): Promise<{ secret: string; hint: string; setAt: string; liveTokens: number; warning: string }> {
  return request<{ secret: string; master: { hint: string; setAt: string; liveTokens: number }; warning: string }>(
    cfg,
    '/master/rotate',
    { confirm },
  ).then((r) => ({
    secret: r.secret,
    hint: r.master.hint,
    setAt: r.master.setAt,
    liveTokens: r.master.liveTokens,
    warning: r.warning,
  }));
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
  badCode: 'keys.errShape',
  used: 'keys.errUsed',
  dead: 'keys.errDead',
};

export type Translate = (key: Key, vars?: Record<string, string | number | undefined | null>) => string;

/**
 * 這幾種情況一律講我們自己的話：後端的 401/403 訊息是狀態說明（「missing or wrong bearer
 * token」），繁中介面上出現它對使用者毫無幫助；本地文案直接點名「要換主金鑰」。
 * 配對碼的三種失敗也一樣——英文介面不該看到後端的中文說明，反之亦然。
 */
const LOCAL_FIRST: TokenErrorCode[] = ['auth', 'notfound', 'badCode', 'used', 'dead'];

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
