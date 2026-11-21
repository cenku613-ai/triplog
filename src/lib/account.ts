/**
 * 帳號登入（Google）的客戶端：session 的存放、`/api/auth/*` 的呼叫，以及 Google 那顆按鈕。
 *
 * 為什麼前端只經手一張 Google 簽發的 ID token：換 access token 那一套要把 client_secret
 * 放在某個地方，而瀏覽器裡放什麼都等於公開。後端（server/src/auth.js）直接驗 Google
 * 對這張 token 的簽章，所以這台伺服器不需要任何只有它知道的祕密，我們也不需要管回調網址
 * 以外的流程。
 *
 * 換回來的 `tls_…` 是 app 自己的憑證：完整值只在這一次回應裡出現，資料庫只留雜湊，
 * 因此它能在「設定 → 帳號」的裝置清單上被單獨撤銷。它同時也是同步用的 bearer，
 * 所以 `loadSyncConfig()` 在登入狀態下會直接把這條 session 當成金鑰交出去
 * （src/lib/sync.ts），舊的「貼主金鑰」那條路留給沒開帳號模式的部署。
 */
import type { Key } from '../i18n';
import { openAccountDb } from '../db/db';
import { loadSyncConfig, saveSyncConfig } from './sync';

export const ACCOUNT_STORAGE_KEY = 'triplog:account';
/** 上次問出來的模式記在這裡：離線開 app 時不必（也無法）重新問伺服器 */
export const AUTH_MODE_STORAGE_KEY = 'triplog:authmode';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export type AccountUser = {
  id: string;
  email: string;
  name: string;
  picture: string;
};

export type AccountState = {
  /** `tls_…`：這台裝置的登入憑證，放在 authorization: Bearer 裡用 */
  token: string;
  /** 登入的是哪台伺服器：換部署時不會拿著 A 的憑證去打 B */
  baseUrl: string;
  user: AccountUser;
  session: { id: string; expiresAt: string | null };
  signedInAt: string;
};

export type AuthConfig = {
  mode: 'account' | 'key';
  provider: string;
  clientId: string | null;
  sessionDays: number;
  keysAllowed: boolean;
};

export type SessionRow = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
};

export type AuthErrorCode = 'insecure' | 'network' | 'refused' | 'server' | 'config';

export class AuthError extends Error {
  code: AuthErrorCode;
  /** 登入被拒時後端附帶的說明（例如「這不是 Google 簽發的身分憑證」），直接顯示給使用者 */
  detail?: string;
  constructor(code: AuthErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ 存放 */

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 無痕模式下連存取都會拋錯：當成「沒有本機存放」，不讓整個 app 開不起來
    return null;
  }
}

export function loadAccount(): AccountState | null {
  const raw = store()?.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as AccountState;
    if (!a?.token || !a?.baseUrl || !a?.user?.id) return null;
    return a;
  } catch {
    return null;
  }
}

export function saveAccount(state: AccountState | null): void {
  const s = store();
  if (!s) return;
  try {
    if (state) s.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(state));
    else s.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    /* 寫不進去就當作沒登入，本機記錄不受影響 */
  }
}

/** 這條 session 還有效嗎（伺服器也會滑動續期，這裡只是不讓畫面顯示一個早就過期的假象） */
export function sessionLive(a: AccountState | null, now = Date.now()): boolean {
  if (!a?.token) return false;
  const exp = a.session?.expiresAt ? Date.parse(a.session.expiresAt) : NaN;
  return !Number.isFinite(exp) || exp > now;
}

export function rememberedMode(): AuthConfig['mode'] | null {
  const v = store()?.getItem(AUTH_MODE_STORAGE_KEY);
  return v === 'account' || v === 'key' ? v : null;
}

export function rememberMode(mode: AuthConfig['mode']): void {
  try {
    store()?.setItem(AUTH_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/**
 * 該不該擋在登入畫面前面。
 *
 * 只有「伺服器是帳號模式」而且「這台裝置沒有有效 session」時才擋。離線時給一條生路
 * （`offline`）：這是一個離線先用的記帳 app，沒網路就完全不給看自己的資料，
 * 比多一個登入按鈕嚴重得多。
 */
export function gateFor(
  cfg: AuthConfig['mode'] | null,
  account: AccountState | null,
  online: boolean,
): 'none' | 'login' | 'offline' {
  if (cfg !== 'account') return 'none';
  if (sessionLive(account)) return 'none';
  return online ? 'login' : 'offline';
}

/* ------------------------------------------------------------ 伺服器位址 */

/**
 * 自己托管自己的部署（正式機就是這樣：app 與 /api 同一個 origin）在還沒填過
 * 「設定 → 跨裝置同步」時也問得到模式。沒有這條 fallback，新裝置第一次開 app 就永遠
 * 不會看到登入門——它必須先去貼金鑰，而那正是帳號制度想免掉的事。
 *
 * 只認 http(s)：檔開（file://）或 `origin === 'null'`（例如 about:blank）時回空字串，
 * 呼叫方就跳過探問，本機記錄照用。
 */
export function sameOriginBase(): string {
  if (typeof location === 'undefined') return '';
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return '';
  const origin = String(location.origin ?? '');
  return origin && origin !== 'null' ? origin.replace(/\/+$/, '') : '';
}

/** 去尾斜線＋檢查協定；https 以外只允許本機（開發時的 vite ↔ api） */
export function normalizeBase(input: string): string {
  const raw = String(input ?? '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthError('insecure', 'URL 格式不對');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthError('insecure', '只支援 http/https');
  }
  const local = url.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new AuthError(
      'insecure',
      typeof location !== 'undefined' && location.protocol === 'https:'
        ? 'HTTPS 頁面不能打非加密的網址（瀏覽器會擋 mixed content）'
        : '同步伺服器網址必須是 https',
    );
  }
  return raw;
}

type Raw = Record<string, unknown>;

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function userOf(raw: unknown): AccountUser {
  const u = (raw ?? {}) as Raw;
  return {
    id: str(u.id, 80),
    email: str(u.email, 200).toLowerCase(),
    name: str(u.name, 80),
    picture: str(u.picture, 500),
  };
}

function sessionOf(raw: unknown): { id: string; expiresAt: string | null } {
  const s = (raw ?? {}) as Raw;
  return { id: str(s.id, 64), expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : null };
}

/** 統一打 API：GET/POST 二選一，錯誤分級成 AuthError，讓介面能說人話 */
async function call<T extends Raw>(
  baseUrl: string,
  path: string,
  opts: { token?: string; method?: 'GET' | 'POST'; body?: Raw } = {},
): Promise<T> {
  const base = normalizeBase(baseUrl);
  const init: RequestInit = {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    throw new AuthError('network', `連不上 ${new URL(base).host}`, (err as Error)?.message);
  }
  let json: Raw = {};
  try {
    json = (await res.json()) as Raw;
  } catch {
    /* 非 JSON 的回覆（例如 Caddy 的 502 頁面）就只留狀態碼 */
  }
  if (res.ok) return json as T;
  const detail = str(json.error, 300);
  if (res.status === 401 || res.status === 403) {
    throw new AuthError('refused', detail || '登入不被接受', detail);
  }
  if (res.status === 429) throw new AuthError('refused', '登入嘗試太頻繁，請一分鐘後再試', detail);
  throw new AuthError('server', `伺服器回 ${res.status}${detail ? `：${detail}` : ''}`, detail);
}

/* ------------------------------------------------------------ 對後端的呼叫 */

/** 公開端點：前端靠它決定要不要顯示登入鈕，以及用哪個 Client ID 叫 Google 的腳本 */
export async function fetchAuthConfig(baseUrl: string): Promise<AuthConfig> {
  const json = await call<Raw>(baseUrl, '/api/auth/config');
  const mode = json.mode === 'account' ? 'account' : 'key';
  const cfg: AuthConfig = {
    mode,
    provider: str(json.provider, 20) || 'google',
    clientId: typeof json.clientId === 'string' && json.clientId ? json.clientId : null,
    sessionDays: Number.isFinite(Number(json.sessionDays)) ? Number(json.sessionDays) : 30,
    keysAllowed: json.keysAllowed !== false,
  };
  if (mode === 'account' && !cfg.clientId) {
    throw new AuthError('config', '伺服器開了帳號模式卻沒給 Client ID');
  }
  rememberMode(mode);
  return cfg;
}

/** 拿 Google 回傳的 credential（那張 ID token）換一條自己的 session，並存進本機 */
export async function loginWithGoogle(
  baseUrl: string,
  idToken: string,
  device = '',
): Promise<{ account: AccountState; created: boolean }> {
  if (!idToken) throw new AuthError('config', '沒拿到 Google 的身分憑證');
  const json = await call<Raw>(baseUrl, '/api/auth/google', {
    method: 'POST',
    body: { idToken, device: device.slice(0, 40) },
  });
  const token = str(json.token, 120);
  if (!token.startsWith('tls_')) throw new AuthError('config', '後端沒有回傳登入憑證');
  const account: AccountState = {
    token,
    baseUrl: normalizeBase(baseUrl),
    user: userOf(json.user),
    session: sessionOf(json.session),
    signedInAt: new Date().toISOString(),
  };
  if (!account.user.id) throw new AuthError('config', '後端沒有回傳帳號資料');
  saveAccount(account);
  return { account, created: json.created === true };
}

export async function fetchMe(account: AccountState): Promise<{ user: AccountUser; expiresAt: string | null }> {
  const json = await call<Raw>(account.baseUrl, '/api/auth/me', { token: account.token });
  const user = userOf(json.user);
  return { user: user.id ? user : account.user, expiresAt: sessionOf(json.session).expiresAt };
}

/** 刷新本機那條 session 的到期日（伺服器會滑動續期，清單上的數字要跟得上） */
export async function refreshAccount(account: AccountState): Promise<AccountState> {
  const me = await fetchMe(account);
  const next: AccountState = {
    ...account,
    user: me.user,
    session: { id: account.session.id, expiresAt: me.expiresAt ?? account.session.expiresAt },
  };
  saveAccount(next);
  return next;
}

export async function listMySessions(account: AccountState): Promise<SessionRow[]> {
  const json = await call<{ sessions?: Raw[] }>(account.baseUrl, '/api/auth/sessions', { token: account.token });
  return (json.sessions ?? []).map((r) => ({
    id: str(r.id, 64),
    label: str(r.label, 60),
    createdAt: str(r.createdAt, 40),
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
    revokedAt: typeof r.revokedAt === 'string' ? r.revokedAt : null,
    lastSeenAt: typeof r.lastSeenAt === 'string' ? r.lastSeenAt : null,
  }));
}

/** 撤銷：本機這條要連同登入狀態一起清掉，否則畫面會停在「已登出但還看得到清單」 */
export async function revokeMySession(
  account: AccountState,
  id: string,
  { allExceptThis = false }: { allExceptThis?: boolean } = {},
): Promise<{ removed?: number; self: boolean }> {
  const self = !allExceptThis && id === account.session.id;
  const json = await call<Raw>(account.baseUrl, '/api/auth/sessions/revoke', {
    token: account.token,
    method: 'POST',
    body: allExceptThis ? { allExceptThis: true } : { id },
  });
  return { removed: typeof json.removed === 'number' ? json.removed : undefined, self };
}

/** 只是斷開這台裝置：伺服器的資料與別的裝置都不動 */
export async function logout({ baseUrl, token }: Pick<AccountState, 'baseUrl' | 'token'>): Promise<void> {
  await call(baseUrl, '/api/auth/logout', { token, method: 'POST', body: {} }).catch(() => {
    /* 已經過期的憑證本來就撤不到東西：登出照樣完成 */
  });
}

/* -------------------------------------------------------- Google 那顆按鈕 */

type GsiCallback = (resp: { credential?: string }) => void;

interface GsiId {
  initialize: (o: {
    client_id: string;
    ux_mode: 'popup';
    callback: GsiCallback;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, string | number>) => void;
  prompt: (listener?: (state: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean }) => void) => void;
  dismissCancelPrompt: () => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiId } };
  }
}

let gsiPromise: Promise<GsiId> | null = null;

/** Google 的腳本只載一次；載不進來（離線或被擋）時回一個清楚的錯誤，不要讓按鈕靜靜消失 */
export function loadGsi(): Promise<GsiId> {
  if (typeof document === 'undefined') return Promise.reject(new AuthError('network', '這個環境沒有 DOM'));
  const existing = window.google?.accounts?.id;
  if (existing) return Promise.resolve(existing);
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<GsiId>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = () => {
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else reject(new AuthError('network', 'Google 的登入腳本載進來了但找不到物件'));
    };
    script.onerror = () => {
      gsiPromise = null;
      script.remove();
      reject(new AuthError('network', '載入不了 Google 的登入腳本（檢查網路或廣告阻擋）'));
    };
    document.head.appendChild(script);
  });
  return gsiPromise;
}

/** 測試與開發用：把已快取的腳本.promise 忘掉，下次重新載 */
export function forgetGsi(): void {
  gsiPromise = null;
}

/**
 * 畫出 Google 那一顆官方按鈕（自己畫一顆不能取用 Google 的標誌，而且官方按鈕會跟著
 * Google 的規範更新）。回傳一個清理函式：換 Client ID 時要重新 initialize。
 */
export async function mountGoogleButton(
  parent: HTMLElement,
  opts: { clientId: string; locale: string; onCredential: (token: string) => void },
): Promise<() => void> {
  const gsi = await loadGsi();
  gsi.initialize({
    client_id: opts.clientId,
    ux_mode: 'popup',
    callback: (resp) => {
      if (resp?.credential) opts.onCredential(resp.credential);
    },
  });
  gsi.renderButton(parent, { theme: 'filled_black', size: 'large', width: 260, text: 'signin_with', shape: 'pill' });
  return () => {
    parent.replaceChildren();
  };
}

/* ------------------------------------------------------------ 登入與登出 */

/**
 * 登入成功後依序要做的事：本機庫換到這個帳號名下、把同步用的憑證換成這條 session，
 * 然後由呼叫端重新載入頁面。
 *
 * 為什麼同步設定要跟著換：登入之前裝置上可能放著主金鑰（或 .env 的只讀鑰）。帳號模式
 * 一旦開起來，那把看的是「制度前的空白」，繼續用它同步只會讓畫面看起來在同步、
 * 實際上推的是另一個分帳。session 才是這台裝置現在的身分。
 *
 * 為什麼要 reload：全 app 的查詢都掛在同一個 Dexie 實例上，換庫之後舊的 useLive
 * 訂閱、已經抓在記憶體裡的旅行清單全都屬於另一個人的帳本。登入不是每分鐘做的事，
 * 重新載入一次比在每個 hook 裡處理帳號切換可靠。
 *
 * @returns moved：從「沒登入」那份庫接過來的記錄筆數（0 表示這台裝置本來就是空的）
 */
export async function finishLogin(account: AccountState): Promise<{ moved: number }> {
  const { moved } = await openAccountDb(account.user.id);
  const prev = loadSyncConfig();
  saveSyncConfig({ baseUrl: account.baseUrl, apiKey: account.token, auto: prev?.auto ?? true });
  return { moved };
}

/**
 * 登出：斷開這台裝置，本機庫切回「沒登入」那份。
 *
 * 刻意不做的事：不刪本機資料、不動伺服器的帳本、也不動別的裝置。帳號庫留在裝置上，
 * 同一個人再登回來時那些離線期間寫的記錄還在（下一次同步會把它們推上去）。
 */
export async function finishLogout(account: AccountState | null): Promise<void> {
  saveAccount(null);
  await openAccountDb(null);
  const cfg = loadSyncConfig();
  if (account && cfg?.apiKey === account.token) saveSyncConfig(null);
}

/* ------------------------------------------------------------ 錯誤要說人話 */

type Translate = (key: Key, vars?: Record<string, string | number | undefined | null>) => string;

const AUTH_ERR_KEYS: Record<AuthErrorCode, Key> = {
  insecure: 'auth.errInsecure',
  network: 'auth.errNetwork',
  refused: 'auth.errRefused',
  server: 'auth.errServer',
  config: 'auth.errConfig',
};

/**
 * 這幾種錯誤是「我們這端就決定的」，伺服器講了也不會更對；
 * 其餘（登入被拒、5xx）就把後端那句原話端出來——它會寫「這不是 Google 簽發的身分憑證」
 * 這種具體原因，比一句「登入失敗」有用得多。
 */
const AUTH_LOCAL_FIRST: AuthErrorCode[] = ['insecure', 'network', 'config'];

export function describeAuthError(err: unknown, t: Translate): string {
  if (err instanceof AuthError) {
    if (AUTH_LOCAL_FIRST.includes(err.code)) return t(AUTH_ERR_KEYS[err.code]);
    return err.detail || err.message || t(AUTH_ERR_KEYS[err.code]);
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return t('auth.errUnknown');
}
