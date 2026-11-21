/**
 * 簽發用的 API token（不同於「分享連結」的 token，也不同於 .env 裡的主金鑰）。
 *
 * 主金鑰一洩是整座資料庫能被讀寫，而且換鑰要動 .env、重啟容器、每台裝置重貼。
 * 要給 agent 或某台裝置一個「可以單獨收回去」的憑證時，就用這裡簽發的 token：
 * 自帶權限層級（read／write）與期限，作廢只動這一條，主金鑰與其他 token 不受影響。
 *
 * 資料庫裡只存 sha256(token)，不存原字串：SQLite 檔案或備份外洩時拿不到可用的憑證。
 * 代價是清單上只能顯示前後幾字（hint），完整值在簽發當時的回應裡出現一次，錯過就重發。
 */
import crypto from 'node:crypto';

/** 前綴讓人在設定檔與日誌一眼認出這是哪種憑證，也讓伺服器能先擋掉明顯不對的 bearer */
export const TOKEN_PREFIX = 'tlk_';
export const TOKEN_SCOPES = ['read', 'write'];
/** 顯示用的頭尾長度：湊得出「tlk_ab12…9wZx」這種樣子，夠認但不夠用 */
const HINT_HEAD = 4;
const HINT_TAIL = 4;

/** 形勢不對的一定不是本地簽發過的，先擋掉可以省掉每個亂碼請求的一次資料庫查詢 */
export function looksLikeApiToken(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length >= TOKEN_PREFIX.length + 16 && s.startsWith(TOKEN_PREFIX);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * 簽一枚新憑證。
 * @returns {{ token: string, id: string, hash: string, hint: string }}
 *   `token` 是要交給使用者貼的那一串，只出現在這一次的回應裡
 */
export function newApiToken() {
  const secret = crypto.randomBytes(24).toString('base64url'); // 192 位熵
  const token = `${TOKEN_PREFIX}${secret}`;
  return {
    token,
    // id 是清單與作廢用的把手，推不出原字串
    id: crypto.randomBytes(6).toString('hex'),
    hash: hashToken(token),
    hint: `${TOKEN_PREFIX}${secret.slice(0, HINT_HEAD)}…${secret.slice(-HINT_TAIL)}`,
  };
}

/** 權限判定：write 什麼都能做，read 只能讀 */
export function scopeAllows(scope, want) {
  return scope === 'write' || want === 'read';
}

/**
 * 與分享連結相同的生死規則（revoked 比過期優先，作廢立刻生效）。
 * @returns {{ live: boolean, reason?: 'revoked' | 'expired' }}
 */
export function tokenStatus(row, nowMs = Date.now()) {
  if (!row) return { live: false, reason: 'revoked' };
  if (row.revokedAt) return { live: false, reason: 'revoked' };
  if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) return { live: false, reason: 'expired' };
  return { live: true };
}

/** 標籤要去掉控制字元並限長，空白時給個中性預設值，清單才不會出現一排空白 */
export function tokenLabel(input, fallback = '未命名', max = 60) {
  if (typeof input !== 'string') return fallback;
  const s = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!s) return fallback;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
