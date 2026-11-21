/**
 * TripLog 同步／Agent API（純 Node，無框架）。
 *
 * 定位：一個「單一基準檔」的同步儲存，不是多使用者後端。
 * 外界只透過 Caddy 的 https://<Domain>/api/* 進來（仍然只開 443），
 * 容器本身只綁 127.0.0.1。所有寫入都要 bearer token，且一律是新增／覆蓋，
 * 沒有刪除資料的 API——誤刪的風險留在本機（有備份檔），不留給伺服器。
 */
import http from 'node:http';
import { openStore, migrateJsonSnapshots, MAX_SNAPSHOT_BYTES } from './store.js';
import {
  ShareError,
  MAX_SHARE_DAYS,
  expiresAtFrom,
  partialOf,
  sanitizeExpense,
  sanitizeItem,
  sharePayload,
  shareStatus,
} from './share.js';
import { TOKEN_SCOPES, hashToken, looksLikeApiToken, newApiToken, scopeAllows, tokenLabel, tokenStatus } from './tokens.js';
import {
  DEFAULT_PAIR_MINUTES,
  MAX_PAIR_MINUTES,
  PAIR_CHARS,
  hashSecret,
  masterHint,
  matchesHash,
  newMasterKey,
  newPairingCode,
  normalizeCode,
  pairExpiresAt,
  pairingStatus,
} from './keys.js';
import { send, fail, tokenEquals, bearer, readJsonBody, rateLimiter, clientIp, applyCors } from './net.js';
import {
  AuthError,
  SESSION_TTL_DAYS,
  looksLikeSession,
  newSession,
  sessionExpiresAt,
  sessionStatus,
  verifyIdToken,
} from './auth.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? process.env.TRIPLOG_API_PORT ?? 8788);
const HOST = process.env.TRIPLOG_API_HOST ?? '0.0.0.0';
const DATA_DIR = process.env.TRIPLOG_DATA_DIR ?? '/data';
const WRITE_KEY = (process.env.TRIPLOG_API_KEY ?? '').trim();
const READ_KEY = (process.env.TRIPLOG_READ_KEY ?? WRITE_KEY).trim();
const MAX_BODY = Number(process.env.TRIPLOG_MAX_BODY ?? MAX_SNAPSHOT_BYTES * 2);
/** 分享頁只送文字欄位，64 KB 已經很闊氣；卡死在體積上比較不會被拿來灌資料庫 */
const MAX_SHARE_BODY = 64 * 1024;
const ALLOWED_ORIGIN = (process.env.TRIPLOG_ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * 帳號模式：登入成為唯一入口，每個 Google 帳號一份自己的基準檔。
 * 預設關——還沒配好 OAuth 的部署（以及現在的生產伺服器）行為跟以前一模一樣，
 * 所有資料都落在 '' 那個「單一基準」分帳。開啟時要有 Client ID，否則啟動就中止，
 * 所以我寧可在開機時就把話講清楚。
 */
const AUTH_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.TRIPLOG_AUTH ?? '').trim().toLowerCase());
const GOOGLE_CLIENT_ID = (process.env.TRIPLOG_GOOGLE_CLIENT_ID ?? '').trim();
/** 帳號模式下是否還讓主金鑰／tlk_ 憑證進得來（預設留著當救援與 agent 通道） */
const KEYS_ALLOWED = !['0', 'false', 'no', 'off'].includes(String(process.env.TRIPLOG_AUTH_ALLOW_KEYS ?? '').trim().toLowerCase());
/** 一條 session 的有效期（天）：常用裝置會滑動續期，所以它其實是「多久沒上線就要重新登入」 */
const SESSION_DAYS = Math.min(Math.max(Number(process.env.TRIPLOG_SESSION_DAYS ?? SESSION_TTL_DAYS) || SESSION_TTL_DAYS, 1), 365);

function die(msg) {
  console.error(`[triplog-api] ${msg}`);
  process.exit(1);
}

if (WRITE_KEY.length < 24) {
  die('TRIPLOG_API_KEY 沒設定或太短（至少 24 字元）。產生一把：openssl rand -hex 32');
}
if (READ_KEY.length < 16) {
  die('TRIPLOG_READ_KEY 太短，不適合當讀取金鑰。');
}
if (AUTH_MODE && !GOOGLE_CLIENT_ID) {
  die('TRIPLOG_AUTH 開了但沒給 TRIPLOG_GOOGLE_CLIENT_ID：拿不到 Google 的 Client ID 就沒人登得了入。');
}

const store = openStore(DATA_DIR);
const migrated = migrateJsonSnapshots(store, DATA_DIR);
if (migrated) console.log(`[triplog-api] 已把舊的 snapshot.json 搬進 SQLite（id=${migrated}）`);

const limitRead = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_READ ?? 600), windowMs: 60_000 });
const limitWrite = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_WRITE ?? 60), windowMs: 60_000 });
// 分享連結是「沒有金鑰也進得來」的路徑，所以另外計數：一把 token 加一個 IP 一個 key
const limitShareRead = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_SHARE_READ ?? 240), windowMs: 60_000 });
const limitShareWrite = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_SHARE_WRITE ?? 30), windowMs: 60_000 });
// 配對碼是 8 個字（約 40 位熵）的一次性憑證，要靠限流撐住猜的攻擊：一台一分鐘 8 次
const limitPair = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_PAIR ?? 8), windowMs: 60_000 });
// 登入端點拿到的是「別人簽的好憑證」，能猜的只有我們自己的實作瑕疵；限流是擋洪水不是擋破解
const limitAuth = rateLimiter({ max: Number(process.env.TRIPLOG_RATE_AUTH ?? 12), windowMs: 60_000 });

/* -------------------------------------------------------------- 資料視圖 */

function counts(snapshot) {
  const perTrip = {};
  const bump = (id, field) => {
    if (!id) return;
    perTrip[id] ??= { items: 0, expenses: 0, photos: 0 };
    perTrip[id][field] += 1;
  };
  for (const i of snapshot.dayItems ?? []) bump(i.tripId, 'items');
  for (const e of snapshot.expenses ?? []) bump(e.tripId, 'expenses');
  for (const p of snapshot.photos ?? []) bump(p.tripId, 'photos');
  for (const t of snapshot.trips ?? []) perTrip[t.id] ??= { items: 0, expenses: 0, photos: 0 };
  return perTrip;
}

/** 基準檔不帶照片 bytes，回 metadata 讓客戶端知道要抓幾張 */
function lite(snapshot) {
  const { photos = [], ...rest } = snapshot;
  return {
    ...rest,
    photos: photos.map(({ data, thumbData, ...p }) => p),
    photoBytes: photos.reduce((s, p) => s + (p.data?.length ?? 0), 0),
  };
}

function pickPhotos(snapshot, { ids, tripIds, limit = 150, includeData = true }) {
  let rows = snapshot.photos ?? [];
  if (Array.isArray(ids) && ids.length) rows = rows.filter((p) => ids.includes(p.id));
  else if (Array.isArray(tripIds) && tripIds.length) rows = rows.filter((p) => tripIds.includes(p.tripId));
  rows = rows.slice(0, limit);
  return includeData ? rows : rows.map(({ data, thumbData, ...p }) => p);
}

function findTrip(snapshot, id) {
  return (snapshot.trips ?? []).find((x) => x.id === id) ?? null;
}

/* ------------------------------------------------------------------ 路由 */

const SCHEMA_HINT = {
  format: 'triplog-backup',
  trip: {
    id: 'trip_<uuid>',
    name: 'string',
    startDate: 'YYYY-MM-DD',
    endDate: 'YYYY-MM-DD',
    baseCurrency: 'TWD',
    budget: 'number|null',
    color: '#rrggbb',
    notes: 'string',
    companions: ['string'],
    archived: 'boolean',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  dayItem: {
    id: 'item_<uuid>',
    tripId: 'string',
    date: 'YYYY-MM-DD',
    kind: 'transport|stay|food|sight|activity|other',
    title: 'string',
    startTime: 'HH:MM|null',
    endTime: 'HH:MM|null',
    location: 'string',
    lat: 'number|null',
    lng: 'number|null',
    note: 'string',
    order: 'number',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  expense: {
    id: 'exp_<uuid>',
    tripId: 'string',
    dayItemId: 'string|null',
    date: 'YYYY-MM-DD',
    amount: 'number',
    currency: 'string',
    rateToBase: 'number',
    baseAmount: 'number = amount * rateToBase',
    category: 'category id, or a builtin key: food|transport|stay|ticket|shopping|fun|misc',
    payee: 'string',
    note: 'string',
    createdAt: 'ISO',
    updatedAt: 'ISO',
  },
  shareWrite: {
    via: 'POST /api/share/<token>/expense  |  /api/share/<token>/item  (no bearer token needed)',
    expense: {
      id: 'exp_<uuid> (optional; send your own so retries merge)',
      date: 'YYYY-MM-DD (trip range +/- 3 days)',
      amount: 'number > 0',
      currency: 'ISO code, defaults to the trip base currency',
      rateToBase: 'required when currency differs from the base currency',
      category: 'category id or builtin key',
      payee: 'string (who paid)',
      note: 'string',
      dayItemId: 'optional, must be an item of this trip',
    },
    item: {
      id: 'item_<uuid> (optional)',
      date: 'YYYY-MM-DD',
      kind: 'transport|stay|food|sight|activity|other',
      title: 'string, required',
      startTime: 'HH:MM|null',
      endTime: 'HH:MM|null',
      location: 'string',
      lat: 'number|null',
      lng: 'number|null',
      note: 'string',
    },
    serverSets: 'tripId (always the shared trip), createdAt, updatedAt, baseAmount',
  },
  sharedByAccount: {
    via: 'GET /api/trips/<tripId>/shared  ·  POST /api/trips/<tripId>/shared/expense|item  (bearer = 你自己那條 tls_ session)',
    setup: 'POST /api/invites {tripId, email, role: read|write} · GET /api/invites · GET /api/invites/mine · POST /api/invites/revoke {id} · POST /api/invites/leave {tripId}',
    rules: '認的是受邀者 Google 帳號裡那顆已驗證信箱，不是連結上的祕密；讀的是邀請人那份帳本的這一趟（不含照片）；role=write 才追加得動，一樣改不了別人的記錄、沒有刪除入口。',
    dataLandsIn: '邀請人的分帳（snapshots.user_id），受邀者自己那份不會憑空多出一筆；他本機要看到這一趟就 GET /api/trips/<id>/shared 拉回來的確切副本。',
  },
  notes: [
    'Write via POST /api/backup with a full triplog-backup document; the server merges by id and keeps the newest updatedAt.',
    'Prefer POST /api/sync with a partial document {trips: [], dayItems?, expenses?, categories?, photos?} so you never overwrite rows you did not read; the arrays you leave out must be [] (missing trips is treated as a malformed upload, not as an empty one).',
    'There is no delete endpoint by design. To archive a trip set archived=true.',
    'Amounts stay in the original currency; baseAmount is what statistics use.',
    'Sharing: POST /api/shares {tripId,expiresInDays} (needs the key) mints a trip-scoped token; GET /api/share/<token> reads that trip only and POST /api/share/<token>/expense|item appends to it without any key. POST /api/shares/revoke {token} kills a link; it revokes a grant, not data.',
    'API tokens: POST /api/tokens {label,scope:read|write,expiresInDays} mints a revocable bearer (shown once, stored hashed); GET /api/tokens lists them and POST /api/tokens/revoke {id} retires one. Minting, listing, revoking and POST /api/admin/clear all require the master TRIPLOG_API_KEY — an issued token can never mint or wipe.',
    'Pairing (no long key on the new device): POST /api/tokens/pairings {label,scope,expiresInMinutes<=120} (master only) returns an 8-char code shown once; the new device posts it to POST /api/pair {code,device} without any bearer and receives a fresh token (365 days). Codes are single-use, expire, and can be voided with POST /api/tokens/pairings/revoke {id}; GET /api/tokens/pairings lists them.',
    'Master key lifecycle: GET /api/tokens/master reports whether the key was rotated (once rotated, the .env TRIPLOG_API_KEY and TRIPLOG_READ_KEY stop being accepted). POST /api/tokens/master/rotate {confirm:"rotate-master"} returns the new key once; it refuses unless at least one live token exists (or confirm:"rotate-master-no-backup") so you cannot lock yourself out. Rolling back needs SSH: node server/src/cli.js master-reset.',
    'Accounts (only when the server runs with TRIPLOG_AUTH=1): GET /api/auth/config tells you the Google OAuth client id; POST /api/auth/google {idToken} exchanges a Google ID token for a tls_ session (first login claims the pre-account data); GET /api/auth/me and /api/auth/sessions use it; POST /api/auth/logout {id?} retires one session. Bearer slot takes the tls_ session or a tlk_/master key alike.',
    'Sharing by identity (needs TRIPLOG_AUTH=1): POST /api/invites {tripId,email,role} binds one trip to a Google account\'s verified email; that person reads GET /api/trips/<tripId>/shared and, when role=write, appends with POST /api/trips/<tripId>/shared/expense|item into the inviter\'s ledger. Revoking the invite (or POST /api/invites/leave) cuts access at the next request; no rows are deleted in either direction.',
    'Tenancy: every read, write, stats and share call is scoped to the authenticated account. Sessions see that person\'s own ledger; the master key and tlk_ agent tokens see the legacy ledger (the one the app used before accounts existed), which is empty once somebody has claimed it. Check GET /api/health for auth.mode.',
  ],
};

async function route(req, res) {
  const url = new URL(req.url, 'http://internal');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','trips','trip_x','export']

  applyCors(req, res, ALLOWED_ORIGIN);

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (parts[0] !== 'api') return fail(res, 404, 'not found');

  const resource = parts[1] ?? '';

  if (resource === 'health') {
    const s = store.statsAll();
    // masterRotated 只是個布林：讓部署完的自查能看出「現在吃的是資料庫裡那把，不是 .env」
    return send(res, 200, {
      ok: true,
      version: VERSION,
      hasData: !!s.head,
      masterRotated: !!store.masterHash(),
      auth: { mode: AUTH_MODE ? 'account' : 'key', clientId: AUTH_MODE ? GOOGLE_CLIENT_ID : null, keysAllowed: !AUTH_MODE || KEYS_ALLOWED },
      ...s,
    });
  }
  if (resource === 'schema') {
    return send(res, 200, { ok: true, version: VERSION, schema: SCHEMA_HINT });
  }

  // 分享連結：token 本身就是授權，走不了下面的 bearer 檢查，必須先分流出去
  if (resource === 'share' && parts[2]) {
    return handleShare(req, res, parts[2], parts[3]);
  }
  // 配對碼同理：那 8 個字就是授權，換回來的是憑證，所以也走在 bearer 之前
  if (resource === 'pair') {
    return handlePair(req, res, clientIp(req));
  }
  // 登入相關：config 是公開的（前端要知道該不該顯示登入鈕），其餘自己判斷有無 session
  if (resource === 'auth' || resource === 'me') {
    const action = resource === 'me' ? 'me' : [parts[2], parts[3]].filter(Boolean).join('/');
    return handleAuth(req, res, action, clientIp(req));
  }

  const auth = resolveAuth(req);
  const { uid, isMaster, issued, canRead, canWrite, reason } = auth;
  if (!canRead) {
    // 「還沒登入」與「金鑰不對」要分開講：前者缺的是登入鈕，後者缺的是正確的憑證
    if (AUTH_MODE && reason !== 'bad-credential') {
      return fail(res, 401, '請先用 Google 登入', { login: true, reason, mode: 'account' });
    }
    return fail(res, 401, 'missing or wrong bearer token', {
      need: 'TRIPLOG_API_KEY（主金鑰）、TRIPLOG_READ_KEY（只讀）或一把 tlk_ 開頭的憑證',
      rotated: !!store.masterHash(),
      ...(AUTH_MODE ? { mode: 'account' } : {}),
    });
  }

  const ip = clientIp(req);
  if (!limitRead(ip)) return fail(res, 429, 'too many requests', { retryAfterMs: 60_000 });
  // 通過限流才算一次真實使用，被擋掉的洪水不進統計；寫入在下面另外記一筆（含 writes）
  if (issued && req.method === 'GET') store.touchApiToken(issued.id);

  const { snapshot } = store.base(uid);

  /* ------------------------------------------------------------- 讀取端 */
  if (req.method === 'GET') {
    if (resource === 'base') {
      const stats = store.stats(uid);
      // 「還沒有基準」用 404 表達：客戶端第一次同步時會把它當成「本機就是基準」直接推上去
      if (!stats.head) return fail(res, 404, 'no snapshot yet');
      const base = lite(snapshot);
      return send(res, 200, { ok: true, base, bytes: Buffer.byteLength(JSON.stringify(base)), head: stats.head, counts: counts(snapshot) });
    }
    if (resource === 'history') {
      return send(res, 200, { ok: true, snapshots: store.list({ uid, limit: Number(url.searchParams.get('limit') ?? 20) }) });
    }
    if (resource === 'trips' && parts.length === 2) {
      const trips = (snapshot.trips ?? [])
        .filter((x) => (url.searchParams.get('archived') === '1' ? true : !x.archived))
        .map(({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }) => ({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }));
      return send(res, 200, { ok: true, trips, counts: counts(snapshot) });
    }
    // 共筆：受邀者讀的是邀請人那份帳本裡的那一趟，所以要在下面讀自己 base 之前分流出去
    if (resource === 'trips' && parts[2] && parts[3] === 'shared') {
      const grant = grantForRequest(auth, parts[2]);
      if (!grant) return fail(res, 403, grantDenyReason(auth), { need: 'invite' });
      return sharedReadForGrant(res, grant);
    }
    if (resource === 'invites') return handleInvites(req, res, parts[2] === 'mine' ? 'mine' : '', auth, null);
    if (resource === 'trips' && parts[2]) {
      const id = parts[2];
      if (parts[3] === 'export') {
        const backup = slice(snapshot, id, { photos: url.searchParams.get('photos') !== '0' });
        if (!backup.trips.length) return fail(res, 404, 'trip not found', {});
        return send(res, 200, { ok: true, backup });
      }
      const trip = findTrip(snapshot, id);
      if (!trip) return fail(res, 404, 'trip not found', {});
      return send(
        res,
        200,
        {
          ok: true,
          trip,
          items: (snapshot.dayItems ?? []).filter((x) => x.tripId === id),
          expenses: (snapshot.expenses ?? []).filter((x) => x.tripId === id),
          photos: pickPhotos(snapshot, { tripIds: [id], limit: 400, includeData: false }),
          categories: snapshot.categories ?? [],
        },
      );
    }
    if (resource === 'expenses') {
      const tripId = url.searchParams.get('tripId');
      const expenses = (snapshot.expenses ?? []).filter((e) => !tripId || e.tripId === tripId);
      return send(res, 200, { ok: true, expenses, categories: snapshot.categories ?? [], totals: totalsByCurrency(expenses) });
    }
    if (resource === 'photos') {
      const tripIds = (url.searchParams.get('tripIds') ?? '').split(',').filter(Boolean);
      return send(res, 200, { ok: true, photos: pickPhotos(snapshot, { tripIds, limit: 400 }) });
    }
    if (resource === 'summary') {
      const trip = findTrip(snapshot, url.searchParams.get('tripId') ?? '');
      if (!trip) return fail(res, 404, 'trip not found', {});
      const expenses = (snapshot.expenses ?? []).filter((e) => e.tripId === trip.id);
      return send(
        res,
        200,
        {
          ok: true,
          trip,
          items: (snapshot.dayItems ?? []).filter((x) => x.tripId === trip.id).length,
          expenses: expenses.length,
          totalBase: round2(expenses.reduce((s, e) => s + (e.baseAmount ?? 0), 0)),
          budget: trip.budget ?? null,
          byCategory: groupSum(expenses, 'category'),
          byPayee: groupSum(expenses, 'payee'),
          byCurrency: groupSum(expenses, 'currency', 'amount'),
        },
      );
    }
    if (resource === 'shares') {
      const tripId = url.searchParams.get('tripId');
      return send(res, 200, { ok: true, shares: store.listShares({ tripId: tripId || null, uid }) });
    }
    if (resource === 'tokens' && parts[2] === 'pairings') {
      // 配對碼清單等于「誰還能換到憑證」的名單，同樣只給主金鑰看
      if (!isMaster) return fail(res, 403, '只有主金鑰看得到配對碼清單', {});
      return send(res, 200, { ok: true, pairings: store.listPairings() });
    }
    if (resource === 'tokens' && parts[2] === 'master') {
      if (!isMaster) return fail(res, 403, '只有主金鑰看得到主金鑰狀態', {});
      const info = store.masterInfo();
      return send(
        res,
        200,
        {
          ok: true,
          master: {
            // rotated:false 代表現在吃的還是 .env 裡那把（尚未輪換）
            rotated: !!info,
            hint: info?.hint ?? masterHint(WRITE_KEY),
            setAt: info?.setAt ?? null,
            bootstrapKeyActive: !info,
            envReadKeyActive: !info && !!READ_KEY && READ_KEY !== WRITE_KEY,
            maxExpiryDays: MAX_SHARE_DAYS,
          },
        },
      );
    }
    if (resource === 'tokens') {
      // 清單本身就是「誰還能進來」的名單，簽發出去的 token 不能看到它
      if (!isMaster) return fail(res, 403, '只有主金鑰（TRIPLOG_API_KEY）看得到 token 清單', {});
      return send(res, 200, { ok: true, tokens: store.listApiTokens() });
    }
    return fail(res, 404, 'not found', {});
  }

  /* ------------------------------------------------------------ 寫入端 */
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
  if (!canWrite) return fail(res, 403, 'read-only token: writes need TRIPLOG_API_KEY', {});
  if (!limitWrite(ip)) return fail(res, 429, 'too many writes', { retryAfterMs: 60_000 });
  if (issued) store.touchApiToken(issued.id, { write: true });

  let body = null;
  try {
    body = await readJsonBody(req, MAX_BODY);
  } catch (err) {
    return fail(res, err.status ?? 400, err.message, {});
  }

  if (resource === 'backup') {
    try {
      const saved = store.put(body, { uid, source: 'push' });
      return send(res, 200, { ok: true, ...saved, savedAt: saved.exportedAt });
    } catch (err) {
      return fail(res, err.message?.includes('too large') ? 413 : 400, String(err.message ?? err), {});
    }
  }

  if (resource === 'sync') {
    // 客戶端只送「它碰過的資料」，伺服器併進基準後回傳完整基準，避免整檔覆寫 race
    try {
      const saved = store.put({ ...body, format: 'triplog-backup', exportedAt: new Date().toISOString() }, { uid, source: 'sync' });
      const merged = store.base(uid).snapshot;
      return send(res, 200, { ok: true, saved, merged: counts(merged), base: lite(merged) });
    } catch (err) {
      return fail(res, 400, String(err.message ?? err), {});
    }
  }

  if (resource === 'photos' && parts[2] === 'get') {
    const ids = Array.isArray(body?.photoIds) ? body.photoIds.slice(0, 200) : [];
    const tripIds = Array.isArray(body?.tripIds) ? body.tripIds.slice(0, 20) : [];
    return send(res, 200, { ok: true, photos: pickPhotos(snapshot, { ids, tripIds, limit: 200 }) });
  }

  /* ------------------------------------------- API token 簽發（只認主金鑰） */

  if (resource === 'tokens' && !parts[2]) {
    // 這一段不用 canWrite：拿簽發出去的 write token 也能寫資料，
    // 但它不能再生一枚 token，否則洩一把就等於拿到整台伺服器的發照權
    if (!isMaster) return fail(res, 403, '簽發 token 要用主金鑰（.env 裡的 TRIPLOG_API_KEY）', {});
    const scope = TOKEN_SCOPES.includes(body?.scope) ? body.scope : 'read';
    let expiresAt = null;
    try {
      expiresAt = expiresAtFrom(body?.expiresInDays ?? 90);
    } catch (err) {
      return fail(res, err.status ?? 400, String(err.message ?? err), {});
    }
    const minted = newApiToken();
    const row = store.createApiToken({
      id: minted.id,
      hash: minted.hash,
      hint: minted.hint,
      label: tokenLabel(body?.label),
      scope,
      expiresAt,
    });
    // 原字串只在這次回應裡出現一次，之後清單上只有 hint
    return send(res, 200, { ok: true, token: row, secret: minted.token });
  }

  if (resource === 'tokens' && parts[2] === 'revoke') {
    if (!isMaster) return fail(res, 403, '撤銷 token 要用主金鑰（.env 裡的 TRIPLOG_API_KEY）', {});
    const id = String(body?.id ?? '');
    const changed = store.revokeApiToken(id);
    const row = store.apiToken(id);
    if (!row) return fail(res, 404, '找不到這個 token', {});
    // 已經撤過再按一次不算錯：按下去要的就是「這把沒了」的狀態
    return send(res, 200, { ok: true, revoked: true, changed, token: row });
  }

  /* ---------------------------------------- 配對碼（讓新裝置免貼長金鑰） */

  if (resource === 'tokens' && parts[2] === 'pairings' && !parts[3]) {
    if (!isMaster) return fail(res, 403, '產生配對碼要用主金鑰（TRIPLOG_API_KEY）', {});
    const scope = TOKEN_SCOPES.includes(body?.scope) ? body.scope : 'write';
    let expiresAt = null;
    try {
      expiresAt = pairExpiresAt(body?.expiresInMinutes ?? DEFAULT_PAIR_MINUTES);
    } catch (err) {
      return fail(res, err.status ?? 400, String(err.message ?? err), {});
    }
    const minted = newPairingCode();
    const pairing = store.createPairing({
      id: minted.id,
      hash: minted.hash,
      label: tokenLabel(body?.label, '新裝置'),
      scope,
      expiresAt,
    });
    // 原字串只在這一次回應出現；之後清單上只有狀態與用沒用掉
    return send(res, 200, { ok: true, pairing, code: minted.code, display: minted.display, expiresInMinutes: Math.min(Math.trunc(Number(body?.expiresInMinutes ?? DEFAULT_PAIR_MINUTES)), MAX_PAIR_MINUTES) });
  }

  if (resource === 'tokens' && parts[2] === 'pairings' && parts[3] === 'revoke') {
    if (!isMaster) return fail(res, 403, '作廢配對碼要用主金鑰（TRIPLOG_API_KEY）', {});
    const id = String(body?.id ?? '');
    const changed = store.revokePairing(id);
    const row = store.pairing(id);
    if (!row) return fail(res, 404, '找不到這組配對碼', {});
    return send(res, 200, { ok: true, revoked: true, changed, pairing: row });
  }

  /* ------------------------------------------------ 輪換主金鑰（不可逆） */

  if (resource === 'tokens' && parts[2] === 'master' && parts[3] === 'rotate') {
    if (!isMaster) return fail(res, 403, '輪換主金鑰要用現在的主金鑰', {});
    const ok = body?.confirm === 'rotate-master' || body?.confirm === 'rotate-master-no-backup';
    if (!ok) {
      return fail(res, 400, '要把話講明：重送一次並帶 confirm:"rotate-master"', {});
    }
    // 防自鎖：一把生效中的憑證都沒有就換鑰，換完連自己也進不來（只能 SSH 救）
    const liveTokens = store.listApiTokens().filter((r) => tokenStatus(r).live).length;
    if (!liveTokens && body?.confirm !== 'rotate-master-no-backup') {
      return fail(res, 409, '目前沒有任何生效中的憑證：先幫一台裝置簽一把並套用，再輪換；確定要直接換就送 confirm:"rotate-master-no-backup"', { liveTokens: 0 });
    }
    const minted = newMasterKey();
    store.setMasterHash(minted.hash, minted.hint);
    // 舊鑰（含 .env 那把與只讀鑰）從這一刻起不再被接受，所以只剩這一次機會
    return send(res, 200, {
      ok: true,
      master: { rotated: true, hint: minted.hint, setAt: new Date().toISOString(), liveTokens },
      secret: minted.key,
      warning: '舊的主金鑰與只讀金鑰已失效；還在用舊鑰的裝置要重新配對或貼上新主金鑰',
    });
  }

  /* -------------------------------------------- 共筆邀請（受邀者憑信箱認身） */

  if (resource === 'invites') return handleInvites(req, res, parts[2] ?? '', auth, body);

  // 受邀者代記：寫進邀請人那份帳本，走的是與匿名連結同一條驗證，只能追加
  if (resource === 'trips' && parts[2] && parts[3] === 'shared') {
    const action = parts[4];
    if (action !== 'expense' && action !== 'item') return fail(res, 404, '共筆只能追加 expense 或 item', {});
    const grant = grantForRequest(auth, parts[2]);
    if (!grant) return fail(res, 403, grantDenyReason(auth), { need: 'invite' });
    if (grant.role !== 'write') return fail(res, 403, '這張邀請是唯讀的：看得到這趟，但不能替它記帳', {});
    if (!limitShareWrite(`grant:${grant.id}|${ip}`)) return fail(res, 429, 'too many writes', { retryAfterMs: 60_000 });
    const { snapshot: ownerBase } = store.base(grant.owner);
    return sharedAppend(res, { snapshot: ownerBase, tripId: grant.tripId, uid: grant.owner, action, body });
  }

  /* ------------------------------------------------ 分享連結管理（要金鑰） */

  if (resource === 'shares' && !parts[2]) {
    const tripId = String(body?.tripId ?? '');
    const trip = findTrip(snapshot, tripId);
    // 還沒同步的趟在伺服器上根本不存在，連結開起來也是 404，就在這裡講清楚
    if (!trip) return fail(res, 409, '這趟旅行還沒有同步到伺服器，先同步再分享', { need: 'sync', tripId });
    let expiresAt = null;
    try {
      expiresAt = expiresAtFrom(body?.expiresInDays);
    } catch (err) {
      return fail(res, err.status ?? 400, String(err.message ?? err), {});
    }
    const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : trip.name;
    return send(res, 200, { ok: true, share: store.createShare({ tripId, label, expiresAt, uid }) });
  }

  if (resource === 'shares' && parts[2] === 'revoke') {
    const token = String(body?.token ?? '');
    const row = store.share(token);
    if (!row || row.uid !== uid) return fail(res, 404, '找不到這個分享連結', {});
    // 只能作廢自己帳本裡的連結：帳號模式下別人手拿同一把 token 也動不了它
    const changed = store.revokeShare(token, uid);
    // 已經作廢過再按一次也不算錯：按下去要的就是「這個連結沒了」的狀態
    return send(res, 200, { ok: true, revoked: true, changed, share: store.share(token) });
  }

  if (resource === 'admin' && parts[2] === 'clear') {
    // 清空是整台等級的動作：分享連結的 token 與簽發出去的 agent token 都碰不到它
    if (!isMaster) return fail(res, 403, '只有主金鑰（TRIPLOG_API_KEY）能清空伺服器', {});
    if (req.headers['x-triplog-confirm'] !== 'wipe') {
      return fail(res, 400, 'pass header x-triplog-confirm: wipe', {});
    }
    const removed = store.clear();
    return send(res, 200, { ok: true, ...removed });
  }

  return fail(res, 404, 'not found', {});
}

/**
 * 這個請求屬於誰的帳本。
 *
 * 兩種模式差的是「誰能進來」，不差「資料怎麼放」：
 * - 金鑰模式（TRIPLOG_AUTH 未開）：主金鑰／只讀鑰／tlk_ 憑證，全部讀寫 '' 那個分帳，
 *   行為跟帳號制度出現之前完全一樣。
 * - 帳號模式：只認自己簽的 session（tls_），每個人一份基準檔。主金鑰與憑證預設還進得來，
 *   但它們看到的仍是 '' 那份——那是救援與 agent 的通道，不是某個人的帳本；不想留這條路
 *   就設 TRIPLOG_AUTH_ALLOW_KEYS=0（屆時只能從 SSH 處理資料）。
 *
 * 主金鑰的定義權在資料庫：輪換過一次，就以存進去的雜湊為準，`.env` 那把（連同只讀鑰）
 * 當場失效。這樣「換鑰」才真的能把外流的舊鑰擋在門外；要退回 .env 只能從 SSH
 * （`node server/src/cli.js master-reset`），刻意不給 HTTP 路徑——否則拿到舊鑰的人
 * 也能把輪換取消。
 *
 * @returns {{ uid: string, canRead: boolean, canWrite: boolean, isMaster: boolean, issued: any, session: any, user: any, reason: 'ok' | 'no-credential' | 'bad-credential' | 'expired-session' | 'revoked-session' }}
 */
function resolveAuth(req) {
  const key = bearer(req);
  const storedMaster = store.masterHash();
  const isMaster = storedMaster ? matchesHash(key, storedMaster) : tokenEquals(key, WRITE_KEY);
  const isBootstrapReadable = !storedMaster && tokenEquals(key, READ_KEY);
  const isMasterReadable = isMaster || isBootstrapReadable;
  /** 從 app「設定 → 金鑰與裝置」簽發出來的那種：自帶層級與期限，能單獨作廢 */
  let issued = null;
  if (!isMasterReadable && looksLikeApiToken(key)) {
    const row = store.apiTokenByHash(hashToken(key));
    if (row && tokenStatus(row).live) issued = row;
  }
  const keysAllowed = !AUTH_MODE || KEYS_ALLOWED;
  const deny = (reason) => ({ uid: '', canRead: false, canWrite: false, isMaster: false, issued: null, session: null, user: null, reason });

  if (keysAllowed && (isMasterReadable || issued)) {
    return {
      uid: '',
      canRead: true,
      canWrite: isMaster || scopeAllows(issued?.scope, 'write'),
      isMaster,
      issued,
      session: null,
      user: null,
      reason: 'ok',
    };
  }

  if (AUTH_MODE && looksLikeSession(key)) {
    const row = store.sessionByHash(hashSecret(key));
    if (!row) return deny('bad-credential');
    const st = sessionStatus(row);
    if (st.live) {
      store.touchSession(row.id);
      // 滑動續期：過了一半就延一次，常用裝置不會在第 30 天當場被踢出登入
      if (st.renew) store.extendSession(row.id, sessionExpiresAt(SESSION_DAYS));
      const user = store.user(row.userId);
      if (!user) return deny('bad-credential');
      return { uid: user.id, canRead: true, canWrite: true, isMaster: false, issued: null, session: row, user, reason: 'ok' };
    }
    return deny(st.reason === 'revoked' ? 'revoked-session' : 'expired-session');
  }

  return deny(key ? 'bad-credential' : 'no-credential');
}

/**
 * 登入與「我是誰」：`/api/auth/*` 與 `/api/me`。
 *
 * 為什麼後端要自己再驗一次 Google 的 ID token：前端傳來的任何字串都不能直接當成身分。
 * 驗簽（auth.js）才是「這個 sub 真的由 Google 簽發」的依據，繞過它等於讓任何人憑空捏一個帳號。
 *
 * 第一次登入的帳號會把帳號制度之前的那份單一基準認領過來（claimLegacyBase）：
 * 沒有這一步，老使用者一登入就看到空帳本，舊資料變成沒人拿得到的孤兒。
 */
async function handleAuth(req, res, action, ip) {
  if (action === 'config') {
    // 公開：前端要知道這台部署該不該顯示登入鈕、拿哪個 Client ID 去叫 Google 的腳本
    return send(res, 200, {
      ok: true,
      mode: AUTH_MODE ? 'account' : 'key',
      provider: 'google',
      clientId: GOOGLE_CLIENT_ID || null,
      sessionDays: SESSION_DAYS,
      keysAllowed: !AUTH_MODE || KEYS_ALLOWED,
    });
  }

  const auth = resolveAuth(req);
  const user = auth.user;

  if (action === 'me' || !action) {
    if (user) {
      return send(res, 200, { ok: true, mode: 'account', user, session: { id: auth.session.id, expiresAt: auth.session.expiresAt } });
    }
    if (!AUTH_MODE) {
      // 金鑰模式下「我是誰」就是「這台吃的是單一基準」：讓客戶端能問得出模式
      return send(res, 200, { ok: true, mode: 'key', user: null, authenticated: auth.canRead });
    }
    return fail(res, 401, '請先用 Google 登入', { login: true, reason: auth.reason });
  }

  if (action === 'google') {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
    if (!AUTH_MODE) return fail(res, 404, '這台伺服器沒開帳號登入（用金鑰即可）', { mode: 'key' });
    if (!limitAuth(ip)) return fail(res, 429, '登入嘗試太多，請一分鐘後再試', { retryAfterMs: 60_000, login: true });
    let body = null;
    try {
      body = await readJsonBody(req, MAX_SHARE_BODY);
    } catch (err) {
      return fail(res, err.status ?? 400, err.message, {});
    }
    let profile;
    try {
      profile = await verifyIdToken(String(body?.idToken ?? ''), { clientId: GOOGLE_CLIENT_ID });
    } catch (err) {
      if (!(err instanceof AuthError)) console.error('[triplog-api] 登入時炸了：', err);
      return fail(res, err instanceof AuthError ? err.status : 502, String(err?.message ?? '登入失敗'), { login: true });
    }
    const known = store.userBySub(profile.sub);
    const firstAccount = !known && store.countUsers() === 0;
    let row = known ?? store.createUser(profile);
    row = store.touchLogin(row.id, profile) ?? row;
    if (firstAccount) {
      const { moved } = store.claimLegacyBase(row.id);
      if (moved) console.log(`[triplog-api] 舊基準已認領給 ${row.email}（${moved} 筆快照）`);
    }
    const sess = newSession(SESSION_DAYS);
    const session = store.insertSession({
      id: sess.id,
      hash: sess.hash,
      userId: row.id,
      label: tokenLabel(body?.device, '', 40),
      expiresAt: sess.expiresAt,
    });
    // 完整 token 只在這一次回應出現；之後資料庫只有雜湊，遺失裝置就在這裡單獨撤銷
    return send(res, 200, { ok: true, token: sess.secret, user: row, session, expiresInDays: SESSION_DAYS, created: !known });
  }

  // 下面都需要一條有效的 session
  if (!user) return fail(res, 401, '請先用 Google 登入', { login: true, reason: auth.reason });

  if (action === 'logout') {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
    const changed = store.revokeSession(auth.session.id, user.id);
    return send(res, 200, { ok: true, revoked: changed });
  }

  if (action === 'sessions') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed', {});
    return send(res, 200, { ok: true, sessions: store.listSessions(user.id) });
  }

  if (action === 'sessions/revoke') {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
    let body = null;
    try {
      body = await readJsonBody(req, MAX_SHARE_BODY);
    } catch (err) {
      return fail(res, err.status ?? 400, err.message, {});
    }
    if (body?.allExceptThis === true) {
      const removed = store.revokeOtherSessions(user.id, auth.session.id);
      return send(res, 200, { ok: true, revoked: true, removed });
    }
    const id = String(body?.id ?? '');
    const changed = store.revokeSession(id, user.id);
    // 不屬於自己的 id 與不存在的 id 都回 404：不拿別人的 session id 探測什麼存在
    const row = store.session(id);
    if (!row || row.userId !== user.id) return fail(res, 404, '找不到這條登入紀錄', {});
    return send(res, 200, { ok: true, revoked: true, changed, session: row });
  }

  return fail(res, 404, 'not found', {});
}

/**
 * 配對：新裝置在設定裡打 8 個字的配對碼，換回一把帶層級與期限的憑證。
 *
 * 這條路徑不需要 bearer（碼本身就是授權），所以要有自己的限流（每台 IP 一分鐘 8 次）。
 * 碼只存雜湊、一次性（`consumePairing` 用 UPDATE ... WHERE used_at IS NULL 搶先贏，
 * 兩台同時用同一組只會有一台拿到憑證），而且過期就作廢——留著不用也是攻擊面。
 */
async function handlePair(req, res, ip) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});
  if (!limitPair(ip)) return fail(res, 429, '配對嘗試太多，請一分鐘後再試', { retryAfterMs: 60_000 });
  let body = null;
  try {
    body = await readJsonBody(req, MAX_SHARE_BODY);
  } catch (err) {
    return fail(res, err.status ?? 400, err.message, {});
  }
  const code = normalizeCode(body?.code);
  if (!code) return fail(res, 400, `配對碼是 ${PAIR_CHARS} 個字（字母與數字，橫線打不打都可以）`, {});
  const row = store.pairingByHash(hashSecret(code));
  const st = pairingStatus(row);
  if (!row) return fail(res, 404, '這組配對碼不存在（或已被用掉）', {});
  if (!st.live) {
    const msg =
      st.reason === 'used'
        ? '這組配對碼已經用過了——它是一次性的，請在原來的裝置上再產生一組'
        : st.reason === 'revoked'
          ? '這組配對碼已被作廢'
          : '這組配對碼已過期，請在原來的裝置上再產生一組';
    return fail(res, st.reason === 'used' ? 409 : 410, msg, { reason: st.reason });
  }
  const device = tokenLabel(body?.device, '', 40);
  if (!store.consumePairing(row.id, device)) {
    return fail(res, 409, '這組配對碼剛剛已被用掉', { reason: 'used' });
  }
  const minted = newApiToken();
  const label = tokenLabel(device ? `${row.label} · ${device}` : row.label, '配對裝置');
  const token = store.createApiToken({
    id: minted.id,
    hash: minted.hash,
    hint: minted.hint,
    label,
    scope: row.scope,
    expiresAt: expiresAtFrom(MAX_SHARE_DAYS) ?? null,
  });
  // 這台裝置拿到的是普通憑證：之後在擁有者的清單裡看得到、能單獨撤銷
  return send(res, 200, { ok: true, secret: minted.token, token, scope: row.scope, expiresInDays: MAX_SHARE_DAYS });
}

/**
 * 分享連結的公開路徑（不需要 bearer token）。
 *
 * 一個 token 只認一趟旅行：讀只回那一趟，寫一律把 tripId 換成 token 對應的那一趟，
 * 所以拿到連結的人動不到別的旅行，也沒有任何刪除的入口（要撤銷就作廢連結）。
 * 寫進基準檔走的是 store.put 同一條合併路徑，擁有者下次同步就會看到對方補的記錄。
 */
async function handleShare(req, res, tokenPart, action) {
  const token = String(tokenPart ?? '').slice(0, 64);
  const share = store.share(token);
  if (!share) return fail(res, 404, '找不到這個分享連結', {});
  const { live, reason } = shareStatus(share);
  if (!live) {
    return fail(res, 410, reason === 'revoked' ? '這個分享連結已被擁有者作廢' : '這個分享連結已過期', { reason });
  }
  const ip = clientIp(req);
  if (!limitShareRead(`${token}|${ip}`)) return fail(res, 429, 'too many requests', { retryAfterMs: 60_000 });

  // 連結屬於誰的帳本，就讀誰的基準檔：帳號模式下每個人的資料互不相通
  const { snapshot, head } = store.base(share.uid);

  if (req.method === 'GET' && !action) {
    store.touchShare(token);
    let payload;
    try {
      payload = sharePayload(snapshot, share.tripId, share);
    } catch (err) {
      return fail(res, err.status ?? 500, String(err.message ?? err), {});
    }
    return send(res, 200, { ok: true, scope: 'share', head, ...payload });
  }

  if (req.method === 'POST' && (action === 'expense' || action === 'item')) {
    if (!limitShareWrite(`${token}|${ip}`)) return fail(res, 429, 'too many writes', { retryAfterMs: 60_000 });
    let body = null;
    try {
      body = await readJsonBody(req, MAX_SHARE_BODY);
    } catch (err) {
      return fail(res, err.status ?? 400, err.message, {});
    }
    const out = sharedAppend(res, { snapshot, tripId: share.tripId, uid: share.uid, action, body, source: 'share' });
    if (out === true) store.touchShare(token, { write: true });
    return out;
  }

  return fail(res, 405, 'method not allowed', {});
}

/**
 * 共筆寫入的共用核心：匿名連結與身分邀請最後都走到這裡，規則完全相同——
 * 只能追加一筆支出或一筆行程項目，改不了別人的記錄，也沒有任何刪除的入口。
 * 回傳 true 代表「回應已送出而且寫成了」，讓呼叫端決定要不要記一筆最後使用時間。
 */
function sharedAppend(res, { snapshot, tripId, uid, action, body, source = 'shared' }) {
  const trip = findTrip(snapshot, tripId);
  if (!trip) return fail(res, 404, '這趟旅行已經不在伺服器上（可能被清除，或還沒同步）', {});
  const rows = snapshotRows(snapshot, tripId);
  const ctx = { trip, existing: rows.existing, itemIds: rows.itemIds, maxOrder: rows.maxOrder, now: new Date().toISOString() };
  let row;
  let table;
  try {
    row = action === 'expense' ? sanitizeExpense(body, ctx) : sanitizeItem(body, ctx);
    table = action === 'expense' ? 'expenses' : 'dayItems';
  } catch (err) {
    return fail(res, err instanceof ShareError ? err.status : 400, String(err.message ?? err), {});
  }
  const saved = store.put(partialOf(table, row), { uid, source });
  send(res, 200, { ok: true, [action]: row, saved: { id: saved.id, unchanged: saved.unchanged === true } });
  return true;
}

/**
 * 受邀者憑身分能碰到哪一趟：比對的是他 Google 帳號裡那顆已驗證的信箱，
 * 不是連結上的某個祕密。金鑰模式下 auth.user 是空的（那個世界裡沒有「人」），
 * 沒有信箱可以比對，就當他沒被邀請過。
 */
function grantForRequest(auth, tripId) {
  if (!AUTH_MODE || !auth?.user?.email) return null;
  const grant = store.grantFor(String(tripId ?? '').slice(0, 64), auth.user.email);
  return grant && !grant.revokedAt ? grant : null;
}

/** 為什麼這個人碰不到這趟：三種原因要分開講，否則使用者會去翻設定頁找一把根本不需要的金鑰 */
function grantDenyReason(auth) {
  if (!AUTH_MODE) return '這台伺服器還是金鑰模式，沒有身分邀請這回事：要同行代記就用分享連結';
  if (!auth?.user?.email) return '共筆認的是 Google 帳號裡那顆已驗證的信箱，金鑰與 agent token 沒有身分可比對';
  return `這趟旅行沒有邀請到 ${auth.user.email}，請邀請人在「同行與分享」裡加你的信箱`;
}

/** 邀請清單上那一趟的名字：同一個人的基準檔只解析一次，清單才不會被反覆讀檔拖慢 */
function tripNameOf(cache, uid, tripId) {
  if (!cache.has(uid)) {
    try {
      cache.set(uid, store.base(uid).snapshot);
    } catch {
      cache.set(uid, null);
    }
  }
  const snap = cache.get(uid);
  return snap ? findTrip(snap, tripId)?.name ?? null : null;
}

/** 讀給受邀者看的那一趟：讀的是邀請人那份帳本，不含照片，也不碰別的旅行 */
function sharedReadForGrant(res, grant) {
  const { snapshot } = store.base(grant.owner);
  let payload;
  try {
    payload = sharePayload(snapshot, grant.tripId, { createdAt: grant.createdAt });
  } catch (err) {
    return fail(res, err.status ?? 500, String(err.message ?? err), {});
  }
  return send(res, 200, { ok: true, scope: 'grant', grant: { role: grant.role, tripId: grant.tripId }, ...payload });
}

/* ------------------------------------------------------------------ 邀請 */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * 共筆邀請：身分就是那顆信箱，所以這裡不寄信、也不生出第二套 token。
 *
 * 邀請人記下「a@b.com 可以動這趟」，那個人用同一個信箱的 Google 帳號登入之後，
 * 資料端點自己就認得出來；他換了信箱、或邀請被撤銷，權限跟著失效。連結在這條路上
 * 只是「請他來著陸」的方便物，本身不帶任何授權，被轉傳十次也不會多出一個權限。
 *
 * 能邀的對象只有已驗證信箱：後端在登入那關就要求 `email_verified`（否則 403），
 * 所以這裡不需要再假設「也許那顆信箱不是他的」。
 */
function handleInvites(req, res, action, auth, body) {
  if (!AUTH_MODE) {
    return fail(res, 403, '邀請是帳號模式才有的東西：現在這台伺服器只認金鑰，沒有可比的信箱', {});
  }
  if (!auth.user?.email) {
    return fail(res, 403, '這要把你的 Google 帳號當身分，請先用 Google 登入（金鑰與 agent token 辦不到）', {});
  }
  const me = auth.user.email;

  if (req.method === 'GET') {
    if (action === 'mine') {
      // 別人邀我的：撤掉的不算，那代表邀請人已經反悔
      const names = new Map();
      const invites = store.listGrantsFor(me).map((g) => ({
        ...g,
        ownerName: store.user(g.owner)?.name ?? null,
        // 受邀者這側沒有這一趟的本機副本，清單要認得出來靠的就是這個名字
        tripName: tripNameOf(names, g.owner, g.tripId),
      }));
      return send(res, 200, { ok: true, email: me, invites });
    }
    if (!action) {
      return send(res, 200, { ok: true, invites: store.listGrants(auth.uid) });
    }
    return fail(res, 404, 'not found', {});
  }

  if (req.method !== 'POST') return fail(res, 405, 'method not allowed', {});

  if (!action) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const role = body?.role === 'read' ? 'read' : 'write';
    const tripId = String(body?.tripId ?? '').slice(0, 64);
    if (!EMAIL_SHAPE.test(email) || email.length > 320) {
      return fail(res, 400, '那顆信箱的形狀不對：邀請要用完整的電子郵件地址', {});
    }
    if (email === me) {
      return fail(res, 400, '不用邀自己，那趟本來就在你的帳本裡', {});
    }
    const trip = findTrip(store.base(auth.uid).snapshot, tripId);
    if (!trip) return fail(res, 404, '這趟旅行不在你的帳本裡，邀不了人', {});
    const grant = store.upsertGrant({ tripId, owner: auth.uid, email, role });
    // 回來的東西要能直接複製給人：那趟的名字與受邀信箱都回出來，
    // app 才講得出「已邀請 alice@example.com 一起記〈日本關西 5 日〉」這種完整的話。
    return send(res, 200, {
      ok: true,
      invite: { ...grant, tripName: trip.name, landingUrl: `/#/shared/${tripId}` },
    });
  }

  if (action === 'revoke') {
    const id = String(body?.id ?? '').slice(0, 64);
    const row = store.grant(id);
    // 不是自己發的邀請，就當作不存在：這張表不該讓任何人探測到別人的合作關係
    if (!row || row.owner !== auth.uid) return fail(res, 404, '找不到這張邀請', {});
    const changed = store.revokeGrant(id, auth.uid);
    return send(res, 200, { ok: true, changed, invite: store.grant(id) });
  }

  if (action === 'leave') {
    const tripId = String(body?.tripId ?? '').slice(0, 64);
    const changed = store.leaveGrant(tripId, me);
    return send(res, 200, { ok: true, changed });
  }

  return fail(res, 404, 'not found', {});
}

/** 這一趟現有的列：拿來擋跨趟覆寫、驗證 dayItemId 歸屬，以及決定新行程項的排序 */
function snapshotRows(snapshot, tripId) {
  const expenses = (snapshot.expenses ?? []).filter((e) => e.tripId === tripId);
  const items = (snapshot.dayItems ?? []).filter((i) => i.tripId === tripId);
  return {
    existing: {
      // 歸屬檢查要看得到別的趟，所以這裡用全庫的 id → 列
      expenses: new Map((snapshot.expenses ?? []).map((e) => [e.id, e])),
      items: new Map((snapshot.dayItems ?? []).map((i) => [i.id, i])),
    },
    itemIds: new Set(items.map((i) => i.id)),
    maxOrder: items.reduce((m, i) => Math.max(m, Number(i.order) || 0), 0),
    expenses,
  };
}

function slice(snapshot, tripId, { photos = true } = {}) {
  const items = (snapshot.dayItems ?? []).filter((x) => x.tripId === tripId);
  const itemIds = new Set(items.map((x) => x.id));
  const expenses = (snapshot.expenses ?? []).filter((e) => e.tripId === tripId);
  const used = new Set(expenses.map((e) => e.category));
  const rows = pickPhotos(snapshot, { tripIds: [tripId], limit: 400 });
  return {
    format: 'triplog-backup',
    version: photos && rows.some((p) => p.data) ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: (snapshot.trips ?? []).filter((t) => t.id === tripId),
    dayItems: items,
    expenses,
    categories: (snapshot.categories ?? []).filter((c) => used.has(c.id) || used.has(c.key)),
    photos: photos ? rows : rows.map(({ data, thumbData, ...p }) => p),
    meta: (snapshot.meta ?? []).filter((m) => m.key === 'rates'),
    relatedItemIds: [...itemIds],
  };
}

function totalsByCurrency(expenses) {
  const out = {};
  for (const e of expenses) {
    out[e.currency] ??= { amount: 0, count: 0, baseAmount: 0 };
    out[e.currency].amount = round2(out[e.currency].amount + (e.amount ?? 0));
    out[e.currency].baseAmount = round2(out[e.currency].baseAmount + (e.baseAmount ?? 0));
    out[e.currency].count += 1;
  }
  return out;
}

function groupSum(rows, field, valueField = 'baseAmount') {
  const out = {};
  for (const r of rows) {
    const key = String(r[field] ?? '') || '(none)';
    out[key] = round2((out[key] ?? 0) + Number(r[valueField] ?? 0));
  }
  return out;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[triplog-api] 請求炸了：', err);
    if (!res.headersSent) fail(res, 500, 'internal error');
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const stats = store.statsAll();
  console.log(`[triplog-api] listening on http://${HOST}:${PORT} · data=${DATA_DIR}`);
  console.log(
    `[triplog-api] 模式=${AUTH_MODE ? '帳號（Google 登入為唯一入口）' : '金鑰（單一基準）'} · snapshots=${stats.snapshots} bytes=${stats.totalBytes} head=${stats.head?.exportedAt ?? '(none)'} keep=${stats.keep} users=${stats.users}`,
  );
  if (AUTH_MODE) {
    console.log(`[triplog-api] Client ID=${GOOGLE_CLIENT_ID.slice(0, 22)}… · session=${SESSION_DAYS} 天 · 金鑰通道=${KEYS_ALLOWED ? '開（救援／agent）' : '關'}`);
    if (stats.users === 0 && stats.head) {
      console.log('[triplog-api] 提示：資料庫裡還有帳號制度之前的基準，第一個登入的帳號會把它認領過去。');
    }
  }
  console.log('[triplog-api] 沒有 DELETE API：寫入只有新增與覆寫，刪除請在本機操作後再同步。');
  console.log('[triplog-api] 分享連結：/api/share/<token> 只用 token 授權，限一趟旅行、只能新增。');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
