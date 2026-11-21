/**
 * 帳號層：拿 Google 簽發的 ID token 換一把本機 session。
 *
 * 為什麼走「ID token 直接驗簽」而不是 OAuth 授權碼＋server 端換 token：
 * 這條路只要後端會驗 Google 的公開金鑰，不用存 client_secret、不用管回調狀態機，
 * 也不用把第三方的 access token 留在我們資料庫裡。前端用 Google Identity Services
 * 取得 ID token（一組 RS256 JWT），打給我們；我們驗完簽章與 claims，之後這個
 * app 認的是自己簽的 session，Google 掛了或不發 token 都不影響已經登入的裝置。
 *
 * 信任邊界要講清楚：`sub`（Google 帳號的穩定識別碼）才是身分辨識，email 只是給
 * 人看的標籤，也是邀請時用的地址。使用者改頭像、改顯示名稱都不該生出第二個帳號，
 * 所以 users 表以 google_sub 為唯一鍵。
 *
 * 這個檔案只有「驗證」與「產生憑證」，不碰 HTTP、也不碰資料庫（session 落庫在 store.js）。
 */
import crypto from 'node:crypto';
import { hashSecret } from './keys.js';

/** 本機 session 的前綴：跟裝置憑證（tlk_）、主金鑰（tlm_）一眼分開 */
export const SESSION_PREFIX = 'tls_';
/** 登入一次給 30 天：出遠門沒有網路也能開，回來時再續期 */
export const SESSION_TTL_DAYS = 30;
/** 上限同 API token（365 天）：不給「永不過期」，遺失的裝置才有自然失效的一天 */
export const MAX_SESSION_DAYS = 365;
/** Google 的公鑰一天會換幾個 kid，但不會這麼快；10 分鐘是延遲與新鮮度的折衷 */
export const JWKS_TTL_MS = 10 * 60_000;
/** 時鐘差容許值：裝置沒對時也不該讓登入憑空失敗 */
export const CLOCK_SKEW_MS = 120_000;

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** @typedef {{ sub: string, email: string, name: string, picture: string, hd: string }} GoogleProfile */

export class AuthError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* -------------------------------------------------------------- JWKS 快取 */

/** @type {{ url: string, at: number, keys: Map<string, import('node:crypto').PublicKeyObject>, inflight: Promise<Map<string, any>> | null }} */
let cache = { url: '', at: 0, keys: new Map(), inflight: null };

/** 測試與「懷疑金鑰換掉了」時用：清掉快取，下次一定重新抓 */
export function resetKeyCache() {
  cache = { url: '', at: 0, keys: new Map(), inflight: null };
}

/**
 * 抓 Google 的公開金鑰，轉成 `kid → PublicKey`。
 *
 * 同時支援 x5c（Google 目前給的是 X.509 憑證）與裸 JWK（n/e）兩種格式，
 * 之後換 provider 也不用改呼叫端。解析不出來的金鑰直接跳過——寧可少一把，
 * 也不要拿錯的公鑰去驗簽。
 */
async function fetchKeys(url) {
  if (cache.url === url && cache.inflight) return cache.inflight;
  const work = (async () => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      // 連不上 Google 是「暫時做不到」，要講成 502 而不是讓 fetch failed 直接冒到路由層
      throw new AuthError(502, `連不上身分提供者的公鑰位置（${err?.name === 'TimeoutError' ? '逾時' : String(err?.message ?? '網路錯誤')}）`);
    }
    if (!res.ok) throw new AuthError(502, `讀取身分提供者公鑰失敗（HTTP ${res.status}）`);
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.keys) ? body.keys : [];
    const keys = new Map();
    for (const k of list) {
      try {
        if (typeof k?.kid !== 'string') continue;
        if (Array.isArray(k.x5c) && k.x5c[0]) {
          keys.set(k.kid, new crypto.X509Certificate(Buffer.from(k.x5c[0], 'base64')).publicKey);
        } else if (k.n && k.e) {
          keys.set(k.kid, crypto.createPublicKey({ key: { kty: k.kty || 'RSA', n: k.n, e: k.e }, format: 'jwk' }));
        }
      } catch {
        /* 單一金鑰壞掉不影響其他的 */
      }
    }
    if (!keys.size) throw new AuthError(502, '身分提供者沒有可用的公鑰');
    cache = { url, at: Date.now(), keys, inflight: null };
    return keys;
  })();
  cache = { ...cache, url, inflight: work };
  try {
    return await work;
  } catch (err) {
    cache = { ...cache, inflight: null };
    throw err;
  }
}

/** 取某個 kid 的公鑰；快取過期或沒見過這個 kid 時重抓一次（Google 輪換金鑰是常態） */
async function keyFor(kid, { force = false } = {}) {
  const url = process.env.TRIPLOG_GOOGLE_JWKS_URL || DEFAULT_JWKS_URL;
  const stale = cache.url !== url || Date.now() - cache.at >= JWKS_TTL_MS;
  let keys = !stale && !force ? cache.keys : await fetchKeys(url);
  if (!keys.has(kid) && !force) {
    keys = await fetchKeys(url);
  }
  return keys.get(kid);
}

/* ------------------------------------------------------------ JWT 解析 */

/**
 * base64url 段位拆解。
 *
 * `Buffer.from(x, 'base64url')` 遇到非法字元是「截斷」而不是丟錯，這正是 JWT 最經典的
 * 偽造入口（在尾部塞垃圾）。所以解完一定要 encode 回去逐字比對，對不上就是形狀有問題。
 */
function decodeSegment(seg, what) {
  if (typeof seg !== 'string' || !seg.length || !/^[A-Za-z0-9_-]+$/.test(seg)) {
    throw new AuthError(400, `${what} 的格式不對`);
  }
  const buf = Buffer.from(seg, 'base64url');
  if (buf.toString('base64url') !== seg) throw new AuthError(400, `${what} 的格式不對`);
  return buf;
}

function decodeJsonSegment(seg, what) {
  try {
    const obj = JSON.parse(decodeSegment(seg, what).toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch {
    throw new AuthError(400, `${what} 讀不起來`);
  }
}

/** 只解出不驗簽，給日誌與「這組 token 是哪個 kid 簽的」除錯用；安全判斷一律用 verifyIdToken */
export function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw new AuthError(400, 'token 不是一組 JWT');
  return { header: decodeJsonSegment(parts[0], 'header'), payload: decodeJsonSegment(parts[1], 'payload'), signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

/**
 * 驗一組 Google ID token，回傳可信的 claims。
 *
 * 檢查順序是「先便宜後昂貴」：形狀 → 演算法 → 簽章 → iss/aud/exp。
 * 任何一步不過就丟 AuthError（401 居多），呼叫端不要自己猜原因。
 *
 * @returns {Promise<GoogleProfile>}
 */
export async function verifyIdToken(raw, { clientId, now = Date.now() } = {}) {
  const expected = String(clientId ?? process.env.TRIPLOG_GOOGLE_CLIENT_ID ?? '').trim();
  if (!expected) throw new AuthError(500, '伺服器還沒設定 TRIPLOG_GOOGLE_CLIENT_ID');
  const parts = String(raw ?? '').trim().split('.');
  if (parts.length !== 3) throw new AuthError(400, '請提供 Google 的 ID token');
  const header = decodeJsonSegment(parts[0], 'header');
  if (header.alg !== 'RS256') throw new AuthError(401, '只接受 RS256 簽章的身分憑證');
  if (typeof header.kid !== 'string' || !header.kid) throw new AuthError(401, '憑證沒有標示簽發金鑰');

  const payload = decodeJsonSegment(parts[1], 'payload');
  const key = await keyFor(header.kid);
  if (!key) throw new AuthError(401, '找不到這張憑證對應的公鑰');

  let signature;
  try {
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    throw new AuthError(400, '簽章格式不對');
  }
  // 不寫死長度（Google 目前是 RSA 2048，換位元數不該讓登入掛掉）；驗不過就是 401
  if (!signature.length) throw new AuthError(400, '簽章格式不對');
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError(401, '身分憑證的簽章不正確');

  if (!ALLOWED_ISSUERS.has(String(payload.iss))) throw new AuthError(401, '這不是 Google 簽發的身分憑證');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expected)) throw new AuthError(401, '這組憑證不是發給這個應用的');
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) throw new AuthError(401, '身分憑證沒有效期');
  if (exp * 1000 + CLOCK_SKEW_MS <= now) throw new AuthError(401, '身分憑證已過期，請重新登入 Google');
  const sub = String(payload.sub ?? '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(sub)) throw new AuthError(401, '身分憑證缺少帳號識別碼');

  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new AuthError(400, 'Google 沒有回傳信箱，無法建立帳號');
  if (payload.email_verified === false) throw new AuthError(403, '這個 Google 帳號的信箱尚未驗證');

  // 選填：設定了就只開放該 Google Workspace 網域（私人部署想縮小範圍用）
  const allowedDomain = String(process.env.TRIPLOG_GOOGLE_HOSTED_DOMAIN ?? '').trim().toLowerCase();
  if (allowedDomain && String(payload.hd ?? '').toLowerCase() !== allowedDomain) {
    throw new AuthError(403, '這個應用只開放指定網域的帳號');
  }

  return {
    sub,
    email,
    name: String(payload.name ?? payload.given_name ?? '').trim().slice(0, 80),
    picture: /^https:\/\//.test(String(payload.picture ?? '')) ? String(payload.picture).slice(0, 500) : '',
    hd: String(payload.hd ?? '').toLowerCase().slice(0, 120),
  };
}

/* --------------------------------------------------------------- session */

/**
 * 產生一把新的本機 session。資料庫只存 `hash`，回應只給 `secret`：
 * 外洩備檔拿到一堆 hex 也用不了，這跟 api_tokens 是同一套規矩。
 * @returns {{ id: string, secret: string, hash: string, expiresAt: string }}
 */
export function newSession(days = SESSION_TTL_DAYS, now = Date.now()) {
  const secret = `${SESSION_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return {
    id: crypto.randomBytes(8).toString('hex'),
    secret,
    hash: hashSecret(secret),
    expiresAt: sessionExpiresAt(days, now),
  };
}

/** session 的到期時間：逾 365 天一律壓到上限，不給「永不過期」 */
export function sessionExpiresAt(days = SESSION_TTL_DAYS, now = Date.now()) {
  const raw = days === undefined || days === null || days === '' ? SESSION_TTL_DAYS : Number(days);
  if (!Number.isFinite(raw) || raw <= 0) throw new AuthError(400, `days 要是大於 0 的數字（上限 ${MAX_SESSION_DAYS} 天）`);
  const n = Math.min(Math.trunc(raw), MAX_SESSION_DAYS);
  return new Date(now + n * 86_400_000).toISOString();
}

/** 形狀檢查（純提示用）：真正的判斷是拿雜湊去查資料庫 */
export function looksLikeSession(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.startsWith(SESSION_PREFIX) && s.length >= SESSION_PREFIX.length + 32;
}

/**
 * session 的生死。續期判斷也放這裡：還剩不到一半的有效期，就讓路由層換一張新的，
 * 常用裝置才不會在第 30 天被踢出登入。
 * @returns {{ live: boolean, reason?: 'revoked' | 'expired', renew?: boolean }}
 */
export function sessionStatus(row, now = Date.now()) {
  if (!row) return { live: false, reason: 'expired' };
  if (row.revokedAt) return { live: false, reason: 'revoked' };
  const exp = Date.parse(String(row.expiresAt ?? ''));
  if (!Number.isFinite(exp) || exp <= now) return { live: false, reason: 'expired' };
  const created = Date.parse(String(row.createdAt ?? ''));
  const total = Number.isFinite(created) ? exp - created : 0;
  return { live: true, renew: total > 0 && exp - now < total / 2 };
}
