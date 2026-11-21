/**
 * 金鑰的生命週期：配對碼（讓新裝置不必貼長金鑰）與主金鑰輪換。
 *
 * 為什麼需要這兩樣：原本主金鑰只存在 `.env`，要新增一台裝置就得 SSH 上伺服器把那串
 * 64 字複製下來貼過去，而「換一把」等於重跑部署＋每台裝置重貼。這裡把金鑰變成
 * app 裡管得到的東西：
 *
 *   配對碼——8 個好讀的字（沒有 I/L/O/0/1），預設 10 分鐘有效、用一次就作廢。
 *           持有主金鑰的人產生一組，新裝置在設定裡打這 8 個字就自動拿到一把
 *           帶名稱、層級與期限的憑證；長金鑰從頭到尾不需要經過任何人的手。
 *   輪換——換掉之後資料庫改以存進去的雜湊為準，`.env` 裡那把（含只讀鑰）立刻失效。
 *           這樣輪換才真的能把外流的舊鑰擋在門外；代價是所有還在用舊鑰的裝置都要
 *           重新配對，所以介面要把這句話講得很清楚。
 *
 * 跟 API token 一樣，這裡只產生與判斷，不碰 HTTP 也不碰資料庫。
 */
import crypto from 'node:crypto';

/** 輪換後的主金鑰前綴：跟簽發出去的憑證（tlk_）一眼分開，也避免被當成 agent token */
export const MASTER_PREFIX = 'tlm_';
/** 去掉 I、L、O、0、1 之後的 31 個字——要讓人用手機打得出來 */
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIR_CHARS = 8;
export const DEFAULT_PAIR_MINUTES = 10;
export const MAX_PAIR_MINUTES = 120;
/** 配對換出來的憑證預設給一年：裝置是長期用的，但要到期，才不會有永遠不收的鑰匙 */
export const PAIR_TOKEN_DAYS = 365;

export class KeyError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** sha256 十六進位：配對碼與主金鑰都只以這個形態進資料庫 */
export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * 把使用者輸入的配對碼洗成比對用的形狀：大寫、去掉分隔符與空白。
 * 不合法（長度不對、有 alphabet 外的字）回 null，讓路由層回 400，不要去查資料庫。
 */
export function normalizeCode(input) {
  const raw = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '') : '';
  if (raw.length !== PAIR_CHARS) return null;
  for (const ch of raw) if (!PAIR_ALPHABET.includes(ch)) return null;
  return raw;
}

/** 顯示用：每 4 個字加一條橫線，手機上核對比較不會看錯 */
export function formatCode(code) {
  const s = String(code ?? '');
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/**
 * 簽一組配對碼。`code` 是要顯示出來的原字串（只在這次回應裡出現），
 * 資料庫只留 `hash`；`id` 是清單上作廢用的把手。
 * @returns {{ code: string, display: string, id: string, hash: string }}
 */
export function newPairingCode() {
  const bytes = crypto.randomBytes(PAIR_CHARS);
  let code = '';
  for (let i = 0; i < PAIR_CHARS; i += 1) {
    // 256 % 31 !== 0，捨棄 248 之後的取樣值才不會偏向開頭幾個字
    let r = bytes[i];
    while (r >= PAIR_ALPHABET.length * Math.floor(256 / PAIR_ALPHABET.length)) {
      r = crypto.randomBytes(1)[0];
    }
    code += PAIR_ALPHABET[r % PAIR_ALPHABET.length];
  }
  return { code, display: formatCode(code), id: crypto.randomBytes(6).toString('hex'), hash: hashSecret(code) };
}

/** 配對碼的有效期：只給分鐘數，不給「不限時」——未使用的碼留著就是攻擊面 */
export function pairExpiresAt(minutes, nowMs = Date.now()) {
  const raw = minutes === undefined || minutes === null || minutes === '' ? DEFAULT_PAIR_MINUTES : Number(minutes);
  if (!Number.isFinite(raw) || raw <= 0) throw new KeyError(400, `expiresInMinutes 要是大於 0 的數字（上限 ${MAX_PAIR_MINUTES} 分鐘）`);
  const n = Math.min(Math.trunc(raw), MAX_PAIR_MINUTES);
  return new Date(nowMs + n * 60_000).toISOString();
}

/**
 * 配對碼的生死。順序有意義：用掉 > 作廢 > 過期，
 * 「用掉了」要講得比過期清楚，否則使用者會以為是自己按錯。
 * @returns {{ live: boolean, reason?: 'used' | 'revoked' | 'expired' }}
 */
export function pairingStatus(row, nowMs = Date.now()) {
  if (!row) return { live: false, reason: 'expired' };
  if (row.usedAt) return { live: false, reason: 'used' };
  if (row.revokedAt) return { live: false, reason: 'revoked' };
  if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) return { live: false, reason: 'expired' };
  return { live: true };
}

/**
 * 輪換用的新主金鑰。前綴 tlm_ 讓人在設定檔與日誌認得出這是哪種憑證，
 * 48 bytes 熵（384 bits）比 .env 那把 hex 更長，輪換後只會更難猜。
 * @returns {{ key: string, hash: string, hint: string }}
 */
export function newMasterKey() {
  const secret = crypto.randomBytes(48).toString('base64url');
  const key = `${MASTER_PREFIX}${secret}`;
  return { key, hash: hashSecret(key), hint: masterHint(key) };
}

/** 主金鑰的辨識用前後幾字：清單上讓人確定「哦是我輪換過的那把」，但反推不回去 */
export function masterHint(key) {
  const s = String(key ?? '');
  if (s.length <= 12) return s;
  return `${s.slice(0, MASTER_PREFIX.length + 4)}…${s.slice(-4)}`;
}

/** 形狀檢查：只用來在清單與提示裡辨認，不做任何安全判斷（判斷一律走雜湊比對） */
export function looksLikeMasterKey(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.startsWith(MASTER_PREFIX) && s.length >= MASTER_PREFIX.length + 32;
}

/**
 * 常數時間比對「送來的金鑰」與「存著的雜湊」。
 * 送來的字串要先過雜湊才能比，否則比對本身會洩漏長度；雜湊後兩邊等長，直接 timingSafeEqual。
 */
export function matchesHash(secret, hash) {
  if (typeof secret !== 'string' || !secret || typeof hash !== 'string' || !hash) return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
