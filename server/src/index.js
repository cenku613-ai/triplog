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
  notes: [
    'Write via POST /api/backup with a full triplog-backup document; the server merges by id and keeps the newest updatedAt.',
    'Prefer POST /api/sync with a partial document {trips: [], dayItems?, expenses?, categories?, photos?} so you never overwrite rows you did not read; the arrays you leave out must be [] (missing trips is treated as a malformed upload, not as an empty one).',
    'There is no delete endpoint by design. To archive a trip set archived=true.',
    'Amounts stay in the original currency; baseAmount is what statistics use.',
    'Sharing: POST /api/shares {tripId,expiresInDays} (needs the key) mints a trip-scoped token; GET /api/share/<token> reads that trip only and POST /api/share/<token>/expense|item appends to it without any key. POST /api/shares/revoke {token} kills a link; it revokes a grant, not data.',
    'API tokens: POST /api/tokens {label,scope:read|write,expiresInDays} mints a revocable bearer (shown once, stored hashed); GET /api/tokens lists them and POST /api/tokens/revoke {id} retires one. Minting, listing, revoking and POST /api/admin/clear all require the master TRIPLOG_API_KEY — an issued token can never mint or wipe.',
    'Pairing (no long key on the new device): POST /api/tokens/pairings {label,scope,expiresInMinutes<=120} (master only) returns an 8-char code shown once; the new device posts it to POST /api/pair {code,device} without any bearer and receives a fresh token (365 days). Codes are single-use, expire, and can be voided with POST /api/tokens/pairings/revoke {id}; GET /api/tokens/pairings lists them.',
    'Master key lifecycle: GET /api/tokens/master reports whether the key was rotated (once rotated, the .env TRIPLOG_API_KEY and TRIPLOG_READ_KEY stop being accepted). POST /api/tokens/master/rotate {confirm:"rotate-master"} returns the new key once; it refuses unless at least one live token exists (or confirm:"rotate-master-no-backup") so you cannot lock yourself out. Rolling back needs SSH: node server/src/cli.js master-reset.',
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
    const s = store.stats();
    // masterRotated 只是個布林：讓部署完的自查能看出「現在吃的是資料庫裡那把，不是 .env」
    return send(res, 200, { ok: true, version: VERSION, hasData: !!s.head, masterRotated: !!store.masterHash(), ...s });
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

  const key = bearer(req);
  /**
   * 主金鑰的定義權在資料庫：輪換過一次，就以存進去的雜湊為準，`.env` 那把（連同只讀鑰）
   * 當場失效。這樣「換鑰」才真的能把外流的舊鑰擋在門外；要退回 .env 只能從 SSH
   * （`node server/src/cli.js master-reset`），刻意不給 HTTP 路徑——否則拿到舊鑰的人
   * 也能把輪換取消。
   */
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
  const canRead = isMasterReadable || issued !== null;
  const canWrite = isMaster || (issued !== null && scopeAllows(issued.scope, 'write'));
  if (!canRead) {
    return fail(res, 401, 'missing or wrong bearer token', {
      need: 'TRIPLOG_API_KEY（主金鑰）、TRIPLOG_READ_KEY（只讀）或一把 tlk_ 開頭的憑證',
      rotated: !!storedMaster,
    });
  }

  const ip = clientIp(req);
  if (!limitRead(ip)) return fail(res, 429, 'too many requests', { retryAfterMs: 60_000 });
  // 通過限流才算一次真實使用，被擋掉的洪水不進統計；寫入在下面另外記一筆（含 writes）
  if (issued && req.method === 'GET') store.touchApiToken(issued.id);

  const { snapshot } = store.base();

  /* ------------------------------------------------------------- 讀取端 */
  if (req.method === 'GET') {
    if (resource === 'base') {
      const stats = store.stats();
      // 「還沒有基準」用 404 表達：客戶端第一次同步時會把它當成「本機就是基準」直接推上去
      if (!stats.head) return fail(res, 404, 'no snapshot yet');
      const base = lite(snapshot);
      return send(res, 200, { ok: true, base, bytes: Buffer.byteLength(JSON.stringify(base)), head: stats.head, counts: counts(snapshot) });
    }
    if (resource === 'history') {
      return send(res, 200, { ok: true, snapshots: store.list({ limit: Number(url.searchParams.get('limit') ?? 20) }) });
    }
    if (resource === 'trips' && parts.length === 2) {
      const trips = (snapshot.trips ?? [])
        .filter((x) => (url.searchParams.get('archived') === '1' ? true : !x.archived))
        .map(({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }) => ({ id, name, startDate, endDate, baseCurrency, color, archived, updatedAt }));
      return send(res, 200, { ok: true, trips, counts: counts(snapshot) });
    }
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
      return send(res, 200, { ok: true, shares: store.listShares(tripId || null) });
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
      const saved = store.put(body, { source: 'push' });
      return send(res, 200, { ok: true, ...saved, savedAt: saved.exportedAt });
    } catch (err) {
      return fail(res, err.message?.includes('too large') ? 413 : 400, String(err.message ?? err), {});
    }
  }

  if (resource === 'sync') {
    // 客戶端只送「它碰過的資料」，伺服器併進基準後回傳完整基準，避免整檔覆寫 race
    try {
      const saved = store.put({ ...body, format: 'triplog-backup', exportedAt: new Date().toISOString() }, { source: 'sync' });
      const merged = store.base().snapshot;
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
    return send(res, 200, { ok: true, share: store.createShare({ tripId, label, expiresAt }) });
  }

  if (resource === 'shares' && parts[2] === 'revoke') {
    const token = String(body?.token ?? '');
    const changed = store.revokeShare(token);
    const row = store.share(token);
    if (!row) return fail(res, 404, '找不到這個分享連結', {});
    // 已經作廢過再按一次也不算錯：按下去要的就是「這個連結沒了」的狀態
    return send(res, 200, { ok: true, revoked: true, changed, share: row });
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

  const { snapshot, head } = store.base();

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
    const trip = findTrip(snapshot, share.tripId);
    if (!trip) return fail(res, 404, '這趟旅行已經不在伺服器上（可能被清除，或還沒同步）', {});
    const rows = snapshotRows(snapshot, share.tripId);
    const ctx = { trip, existing: rows.existing, itemIds: rows.itemIds, maxOrder: rows.maxOrder, now: new Date().toISOString() };
    let row;
    let table;
    try {
      row = action === 'expense' ? sanitizeExpense(body, ctx) : sanitizeItem(body, ctx);
      table = action === 'expense' ? 'expenses' : 'dayItems';
    } catch (err) {
      return fail(res, err instanceof ShareError ? err.status : 400, String(err.message ?? err), {});
    }
    const saved = store.put(partialOf(table, row), { source: 'share' });
    store.touchShare(token, { write: true });
    return send(res, 200, { ok: true, [action]: row, saved: { id: saved.id, unchanged: saved.unchanged === true } });
  }

  return fail(res, 405, 'method not allowed', {});
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
  const stats = store.stats();
  console.log(`[triplog-api] listening on http://${HOST}:${PORT} · data=${DATA_DIR}`);
  console.log(`[triplog-api] snapshots=${stats.snapshots} bytes=${stats.totalBytes} head=${stats.head?.exportedAt ?? '(none)'} keep=${stats.keep}`);
  console.log('[triplog-api] 沒有 DELETE API：寫入只有新增與覆寫，刪除請在本機操作後再同步。');
  console.log('[triplog-api] 分享連結：/api/share/<token> 只用 token 授權，限一趟旅行、只能新增。');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
