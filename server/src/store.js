/**
 * 同步資料層：整個備份檔（triplog-backup）作為「基準快照」存進 SQLite。
 *
 * 為什麼是整檔而不是逐列存：客戶端本身就有合併好的並集，伺服器只需要
 * 「存最新並集 + 留歷史」，schema 就不會和 App 的欄位一起膨脹，
 * 也天生支援未來新增的欄位（JSON 直接進出）。
 *
 * 一人一份帳：snapshots.user_id 是分帳標籤（'' ＝帳號制度之前的那份單一基準），
 * 所有讀寫端點都帶著「這個請求屬於誰」進來（見 index.js 的 auth context）。
 * 身分辨識存在 users（Google sub）與 sessions（只存雜湊），邀請存在 grants；
 * 金鑰那條路（主金鑰／tlk_ 憑證）保留給救援與 agent，它們看的是 '' 那個分帳。
 *
 * 依然刻意不做任何刪除資料的 API：沒有 DELETE 端點，也沒有「撤銷邀請就順手刪資料」
 * 這種事——邀請只收權限，動不到內容。誤刪的風險留給本機（有備份檔）而不是伺服器。
 */
import { mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mergeSources } from '../../src/lib/merge-core.js';
import { newToken } from './share.js';

/** 基準檔上限：60 張照片約 15 MB，留一倍餘量 */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** 基準檔的 photos 欄位只保留 metadata（不帶 base64），超過這個數就裁掉最舊的 */
export const MAX_SNAPSHOT_PHOTOS = 120;
/** 保留幾份歷史快照 */
export const DEFAULT_KEEP = 20;

const TABLES = ['trips', 'dayItems', 'expenses', 'categories', 'photos'];
const ARRAY_FIELDS = [...TABLES, 'meta'];

export class PayloadTooLarge extends Error {}
export class BadPayload extends Error {}

/**
 * 檢查並標準化上傳的備份檔。回傳清洗過的副本，不修改輸入。
 * @param {any} body
 * @returns {{ backup: any, bytes: number, trimmedPhotos: number }}
 */
export function normalizeSnapshot(body) {
  if (!body || typeof body !== 'object') throw new BadPayload('body must be a JSON object');
  if (body.format !== 'triplog-backup') throw new BadPayload('format must be "triplog-backup"');
  for (const field of ['trips', 'dayItems', 'expenses']) {
    if (body[field] !== undefined && !Array.isArray(body[field])) {
      throw new BadPayload(`${field} must be an array`);
    }
  }
  if (!Array.isArray(body.trips)) throw new BadPayload('trips is required');

  /** @type {any} */
  const clean = { format: 'triplog-backup', version: 1 };
  for (const field of ARRAY_FIELDS) {
    const rows = Array.isArray(body[field]) ? body[field] : [];
    clean[field] = field === 'meta' ? rows.filter((r) => r && typeof r.key === 'string') : rows.filter((r) => r && typeof r.id === 'string');
  }
  clean.exportedAt =
    typeof body.exportedAt === 'string' && !Number.isNaN(Date.parse(body.exportedAt))
      ? body.exportedAt
      : new Date().toISOString();

  // 照片的 base64 是體積炸裂的來源：先按大小上限裁，再按張數上限裁
  let trimmedPhotos = 0;
  const photos = clean.photos;
  const withData = photos.filter((p) => typeof p.data === 'string' && p.data.length > 0);
  const totalBytes = jsonBytes(clean);
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    // 由新到舊保留，超過上限的就只留 metadata
    let budget = MAX_SNAPSHOT_BYTES - jsonBytes({ ...clean, photos: [] });
    const sorted = [...withData].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const keep = new Set();
    for (const p of sorted) {
      const cost = (p.data?.length ?? 0) + (p.thumbData?.length ?? 0);
      if (budget - cost < 0) break;
      budget -= cost;
      keep.add(p.id);
    }
    clean.photos = photos.map((p) => (keep.has(p.id) ? p : stripPhotoData(p)));
    trimmedPhotos = photos.length - keep.size;
  }
  if (clean.photos.length > MAX_SNAPSHOT_PHOTOS) {
    const over = clean.photos.length - MAX_SNAPSHOT_PHOTOS;
    clean.photos = clean.photos.slice(over);
    trimmedPhotos += over;
  }
  clean.version = clean.photos.some((p) => p.data) ? 2 : 1;

  return { backup: clean, bytes: jsonBytes(clean), trimmedPhotos };
}

function stripPhotoData(p) {
  const { data, thumbData, ...rest } = p;
  return rest;
}

/** shares 的 snake_case 欄位換成外部用的駝峰，路由層就不用記兩套名字 */
function shareView(r) {
  return {
    token: r.token,
    /** 這把連結隸屬哪個分帳：'' ＝帳號制度之前的單一基準（匿名開連結時靠它找到資料） */
    uid: r.user_id ?? '',
    tripId: r.trip_id,
    label: r.label ?? '',
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    hits: Number(r.hits ?? 0),
    writes: Number(r.writes ?? 0),
    lastSeenAt: r.last_seen_at ?? null,
    /** 唯讀連結看得到、按下去不會寫東西（Phase 4b 給「只想讓人看」的那組人） */
    canWrite: r.can_write !== 0,
    /** 有無訪客 PIN：只講有沒有，雜湊留在資料層，清單回應裡永遠看不到它 */
    hasPin: Boolean(r.pin_hash),
    /** 最後一個用這條連結記錄的人：邀請人在自己手機上就能看到「小美記了兩筆」 */
    lastWriter: r.last_writer ?? '',
  };
}

/**
 * api_tokens 的對外視圖。注意：不回傳 token_hash——清單與作廢都用 id，
 * 沒有理由讓雜湊出現在任何回應裡。
 */
function tokenView(r) {
  return {
    id: r.id,
    hint: r.hint ?? '',
    label: r.label ?? '',
    scope: r.scope === 'write' ? 'write' : 'read',
    /** 這把鑰打 API 時算誰的帳：'' ＝簽發時還不知道帳號（走預設帳號那條路） */
    uid: r.user_id ?? '',
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    hits: Number(r.hits ?? 0),
    writes: Number(r.writes ?? 0),
    lastSeenAt: r.last_seen_at ?? null,
  };
}

/**
 * pairings 的對外視圖：同樣不回傳 code_hash。原字串只在產生的那次回應裡出現，
 * 之後清單上只剩「誰要的、能幹嘛、幾點失效、有沒有被用掉」。
 */
function pairingView(r) {
  return {
    id: r.id,
    label: r.label ?? '',
    scope: r.scope === 'read' ? 'read' : 'write',
    /** 用這組配對碼換到的憑證會落在誰的帳上（跟簽發者一致，不會掉回空分帳） */
    uid: r.user_id ?? '',
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    usedAt: r.used_at ?? null,
    revokedAt: r.revoked_at ?? null,
    usedLabel: r.used_label ?? '',
  };
}
/**
 * 帳號的對外視圖。`google_sub` 不外傳：它是別家給的穩定識別碼，對我們的介面來說
 * 「這是誰」看 id 與 email 就夠了，少一個欄位就少一個能被拿去比對的把手。
 */
function userView(r) {
  return {
    id: r.id,
    email: r.email ?? '',
    name: r.name ?? '',
    picture: r.picture ?? '',
    createdAt: r.created_at ?? null,
    lastLoginAt: r.last_login_at ?? null,
    logins: Number(r.login_count ?? 0),
  };
}

/** session 的清單視圖：同樣不出現雜湊，完整值只在登入那次回應裡有 */
function sessionView(r) {
  return {
    id: r.id,
    label: r.label ?? '',
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    lastSeenAt: r.last_seen_at ?? null,
  };
}

function grantView(r) {
  return {
    id: r.id,
    tripId: r.trip_id,
    owner: r.owner_user_id,
    email: r.grantee_email,
    role: r.role === 'write' ? 'write' : 'read',
    createdAt: r.created_at,
    revokedAt: r.revoked_at ?? null,
  };
}

function jsonBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

/**
 * 內容指紋：先抹掉寫檔時間再雜湊，所以「同一份資料、不同時間推」會得到同一個值，
 * 而任何一列資料的變動（含照片的 base64 有無）都會讓它變。
 */
function fingerprint(backup) {
  const { exportedAt, ...rest } = backup;
  return crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
}

const emptySnapshot = () => ({
  format: 'triplog-backup',
  version: 1,
  exportedAt: new Date().toISOString(),
  trips: [],
  dayItems: [],
  expenses: [],
  categories: [],
  photos: [],
  meta: [],
});

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  return new Store(new DatabaseSync(path.join(dir, 'triplog.db'), { allowExtension: false }));
}

/** 舊版（v1）把整個備份拆成 <collection>.json 放在資料夾；開機時搬進 SQLite */
export function migrateJsonSnapshots(store, dir) {
  const file = path.join(dir, 'snapshot.json');
  if (!existsSync(file)) return null;
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const saved = store.put(body);
    renameSync(file, `${file}.migrated`);
    return saved.id;
  } catch (err) {
    console.warn('[triplog-api] snapshot.json 搬遷失敗，略過：', err?.message ?? err);
    return null;
  }
}

export class Store {
  constructor(db) {
    this.db = db;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        exported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'push',
        bytes INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(exported_at DESC);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      /* 分享連結：token → 某一趟旅行。這是「授權」，不是資料，
         所以 /api/admin/clear 不清它（作廢要明確按，見 revokeShare）。 */
      CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS shares_trip ON shares(trip_id);
      /* 簽發出去的 API token（給 agent 或某台裝置）。這裡刻意只存雜湊：
         備份檔外洩時拿到的是一堆用不了的 hex。撤銷與清單都靠 id，不需要原字串。 */
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        hint TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'read',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS api_tokens_hash ON api_tokens(token_hash);
      /* 配對碼：新裝置打這 8 個字就換到一把憑證，長金鑰不必經過任何人的手。
         跟 api_tokens 一樣只存雜湊，而且一次性（used_at 一填就作廢）。 */
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'write',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        used_label TEXT
      );
      /* 輪換過的主金鑰只存雜湊與 hint：存進去之後 .env 那把就不再接受，
         輪換才真的能把外流的舊鑰擋在門外。要回退只能從 SSH（server/src/cli.js）。 */
      CREATE TABLE IF NOT EXISTS server_keys (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      /* 帳號：身分辨識是 Google 的 sub（穩定不變），email 只是給人看的標籤與邀請地址。
         這裡刻意不存任何 Google 的 token——登入只用來確認身分，之後吃自己的 session。 */
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_sub TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        picture TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        login_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS users_email ON users(email);
      /* 本機 session：跟 api_tokens 同一套規矩，庫裡只有雜湊，完整值只出現在登入那次回應。
         可單獨撤銷（裝置遺失），到期由 auth.js 判斷。 */
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      /* 邀請／共筆：把某一趟行程授給另一個帳號。資料仍在擁有者的分帳裡，
         這張表只決定「誰讀得到、誰補得了」。 */
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        grantee_email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'read',
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(trip_id, grantee_email)
      );
      CREATE INDEX IF NOT EXISTS grants_grantee ON grants(grantee_email);
      CREATE INDEX IF NOT EXISTS grants_owner ON grants(owner_user_id);
    `);
    // 舊資料庫補上內容指紋欄位；SQLite 沒有 ADD COLUMN IF NOT EXISTS，重複執行就當它已經有了
    try {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN fp TEXT');
    } catch {
      /* 欄位已存在 */
    }
    /**
     * 分帳欄位：'' 是「帳號出現之前那份單一基準」，登入後每個帳號一個自己的 id。
     * 用預設空字串而不是 NULL，舊列搬遷時不用寫任何資料——它們本來就屬於還沒有帳號時的那位
     * 使用者，第一次登入時用 claimLegacyBase() 整個認領過來（見 auth 路由的說明）。
     */
    try {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 欄位已存在 */
    }
    // 分享連結也要知道自己在誰的帳本裡：匿名開連結時靠這個欄位找到擁有者的基準檔
    try {
      this.db.exec("ALTER TABLE shares ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 欄位已存在 */
    }
    /**
     * 簽出去的憑證與配對碼同樣要認得帳號。理由有一個真實事故：第一次登入會把舊基準
     * 認領進那個帳號（claimLegacyBase），而金鑰與 `tlk_` requests 向來解析成 `''` 分帳，
     * 於是「認領之後」主金鑰打 /api/base 直接 404、MCP 看到的是空帳本。
     * 從這版起新簽的都帶簽發者帳號；舊的（'' ）照舊走預設帳號那條路（見 index.js defaultAccountUid）。
     */
    try {
      this.db.exec("ALTER TABLE api_tokens ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 欄位已存在 */
    }
    try {
      this.db.exec("ALTER TABLE pairings ADD COLUMN user_id TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 欄位已存在 */
    }
    /**
     * 訪客共筆的三個開關（Phase 4b）：這條連結能不能記、要不要 PIN、最後是誰用它記的。
     * `pin_hash` 存雜湊、`can_write` 預設 1（既有的連結行為完全不變），
     * `last_writer` 是顯示用的名字——真正的付錢者已经在 expenses.payee 裡，這裡只是讓
     * 主人知道「這把連結有人用過、是小美」。
     */
    try {
      this.db.exec('ALTER TABLE shares ADD COLUMN can_write INTEGER NOT NULL DEFAULT 1');
    } catch {
      /* 欄位已存在 */
    }
    try {
      this.db.exec('ALTER TABLE shares ADD COLUMN pin_hash TEXT');
    } catch {
      /* 欄位已存在 */
    }
    try {
      this.db.exec("ALTER TABLE shares ADD COLUMN last_writer TEXT NOT NULL DEFAULT ''");
    } catch {
      /* 欄位已存在 */
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS snapshots_user ON snapshots(user_id, exported_at DESC, created_at DESC)');
    this._insert = this.db.prepare(
      'INSERT INTO snapshots (id, user_id, exported_at, created_at, source, bytes, fp, payload) VALUES (@id, @uid, @exportedAt, @createdAt, @source, @bytes, @fp, @payload)',
    );
    this._latest = this.db.prepare(
      'SELECT * FROM snapshots WHERE user_id = ? ORDER BY exported_at DESC, created_at DESC LIMIT 1',
    );
    this._headAny = this.db.prepare('SELECT * FROM snapshots ORDER BY exported_at DESC, created_at DESC LIMIT 1');
    this._byId = this.db.prepare('SELECT * FROM snapshots WHERE id = ? AND user_id = ?');
    this._count = this.db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM snapshots WHERE (? IS NULL OR user_id = ?)',
    );
    this._list = this.db.prepare(
      'SELECT id, exported_at, created_at, source, bytes FROM snapshots WHERE user_id = ? ORDER BY exported_at DESC LIMIT ? OFFSET ?',
    );
    this._prune = this.db.prepare(
      'DELETE FROM snapshots WHERE user_id = ? AND id NOT IN (SELECT id FROM snapshots WHERE user_id = ? ORDER BY exported_at DESC, created_at DESC LIMIT ?)',
    );
    this._payloads = this.db.prepare(
      'SELECT payload FROM snapshots WHERE user_id = ? ORDER BY exported_at DESC, created_at DESC LIMIT ?',
    );
    this._claim = this.db.prepare("UPDATE snapshots SET user_id = ? WHERE user_id = ''");
    this._userCount = this.db.prepare('SELECT COUNT(*) AS n FROM users');
    this._metaGet = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this._metaSet = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this._shareInsert = this.db.prepare(
      'INSERT INTO shares (token, user_id, trip_id, label, created_at, expires_at, can_write, pin_hash) VALUES (@token, @uid, @tripId, @label, @createdAt, @expiresAt, @canWrite, @pinHash)',
    );
    this._shareGet = this.db.prepare('SELECT * FROM shares WHERE token = ?');
    this._shareList = this.db.prepare('SELECT * FROM shares WHERE user_id = ? AND trip_id = ? ORDER BY created_at DESC');
    this._shareListUser = this.db.prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC LIMIT 200');
    this._shareAll = this.db.prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT 200');
    this._shareRevoke = this.db.prepare('UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL');
    this._shareRevokeOwn = this.db.prepare(
      'UPDATE shares SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL',
    );
    this._shareHit = this.db.prepare(
      'UPDATE shares SET hits = hits + @read, writes = writes + @write, last_seen_at = @at, last_writer = COALESCE(NULLIF(@who, \'\'), last_writer) WHERE token = @token',
    );
    this._tokInsert = this.db.prepare(
      'INSERT INTO api_tokens (id, token_hash, hint, label, scope, user_id, created_at, expires_at) VALUES (@id, @hash, @hint, @label, @scope, @uid, @createdAt, @expiresAt)',
    );
    this._tokByHash = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
    this._tokById = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?');
    this._tokList = this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC LIMIT 200');
    this._tokListUser = this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 200');
    this._tokRevoke = this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
    this._tokRevokeOwn = this.db.prepare(
      'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    );
    this._tokHit = this.db.prepare(
      'UPDATE api_tokens SET hits = hits + @read, writes = writes + @write, last_seen_at = @at WHERE id = @id',
    );
    this._pairInsert = this.db.prepare(
      'INSERT INTO pairings (id, code_hash, label, scope, user_id, created_at, expires_at) VALUES (@id, @hash, @label, @scope, @uid, @createdAt, @expiresAt)',
    );
    this._pairByHash = this.db.prepare('SELECT * FROM pairings WHERE code_hash = ?');
    this._pairById = this.db.prepare('SELECT * FROM pairings WHERE id = ?');
    this._pairList = this.db.prepare('SELECT * FROM pairings ORDER BY created_at DESC LIMIT 100');
    this._pairListUser = this.db.prepare('SELECT * FROM pairings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100');
    this._pairUse = this.db.prepare('UPDATE pairings SET used_at = ?, used_label = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL');
    this._pairRevoke = this.db.prepare('UPDATE pairings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL');
    this._pairRevokeOwn = this.db.prepare(
      'UPDATE pairings SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND used_at IS NULL',
    );
    this._keyGet = this.db.prepare('SELECT value FROM server_keys WHERE key = ?');
    this._keySet = this.db.prepare('INSERT INTO server_keys (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this._keyDel = this.db.prepare('DELETE FROM server_keys WHERE key = ?');
    this._userInsert = this.db.prepare(
      'INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login_at, login_count) VALUES (@id, @sub, @email, @name, @picture, @createdAt, @createdAt, 1)',
    );
    this._userBySub = this.db.prepare('SELECT * FROM users WHERE google_sub = ?');
    this._userById = this.db.prepare('SELECT * FROM users WHERE id = ?');
    this._userByEmail = this.db.prepare('SELECT * FROM users WHERE email = ? ORDER BY created_at ASC LIMIT 1');
    this._userList = this.db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200');
    this._userLogin = this.db.prepare(
      'UPDATE users SET email = @email, name = @name, picture = @picture, last_login_at = @at, login_count = login_count + 1 WHERE id = @id',
    );
    this._sessInsert = this.db.prepare(
      'INSERT INTO sessions (id, session_hash, user_id, label, created_at, expires_at) VALUES (@id, @hash, @userId, @label, @createdAt, @expiresAt)',
    );
    this._sessByHash = this.db.prepare('SELECT * FROM sessions WHERE session_hash = ?');
    this._sessById = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    this._sessList = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100');
    this._sessRevoke = this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL');
    this._sessRevokeOthers = this.db.prepare(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    );
    this._sessExpire = this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?');
    this._sessHit = this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
    this._grantInsert = this.db.prepare(
      'INSERT INTO grants (id, trip_id, owner_user_id, grantee_email, role, created_at) VALUES (@id, @tripId, @owner, @email, @role, @createdAt) ON CONFLICT(trip_id, grantee_email) DO UPDATE SET role = excluded.role, owner_user_id = excluded.owner_user_id, created_at = excluded.created_at, revoked_at = NULL',
    );
    this._grantListOwned = this.db.prepare('SELECT * FROM grants WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200');
    this._grantListFor = this.db.prepare("SELECT * FROM grants WHERE grantee_email = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200");
    this._grantById = this.db.prepare('SELECT * FROM grants WHERE id = ?');
    this._grantRevoke = this.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL');
    this._grantFind = this.db.prepare('SELECT * FROM grants WHERE trip_id = ? AND grantee_email = ?');
    // 受邀者「不想再幫忙」：走的是（行程, 信箱）這組鍵，不需要知道邀請人的 id
    this._grantLeave = this.db.prepare('UPDATE grants SET revoked_at = ? WHERE trip_id = ? AND grantee_email = ? AND revoked_at IS NULL');
  }

  /* ------------------------------------------------------ 輪換過的主金鑰 */

  /** @returns {string | null} 存過就回 sha256（hex），沒輪換過回 null（這時以 .env 為準） */
  masterHash() {
    const row = this._keyGet.get('master_hash');
    return row ? String(row.value) : null;
  }

  /** 一次寫入雜湊與顯示用的 hint，兩邊同生同滅才不會出現「有 hint 卻查不到雜湊」 */
  setMasterHash(hash, hint) {
    this._keySet.run('master_hash', String(hash));
    this._keySet.run('master_hint', String(hint ?? ''));
    this._keySet.run('master_set_at', new Date().toISOString());
  }

  /** 只給 SSH 救援用（cli.js）：刪掉之後 .env 那把重新被接受 */
  clearMasterHash() {
    this._keyDel.run('master_hash');
    this._keyDel.run('master_hint');
    this._keyDel.run('master_set_at');
  }

  masterInfo() {
    const hash = this._keyGet.get('master_hash');
    if (!hash) return null;
    const hint = this._keyGet.get('master_hint');
    const at = this._keyGet.get('master_set_at');
    return { rotated: true, hint: hint ? String(hint.value) : '', setAt: at ? String(at.value) : null };
  }

  /* ---------------------------------------------------------- 帳號與登入 */

  /** 第一次登入就生出帳號；同一個 Google =sub 再來只會回到同一列 */
  createUser({ sub, email, name = '', picture = '' }) {
    const id = `u_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = new Date().toISOString();
    this._userInsert.run({ id, sub: String(sub), email: String(email), name: String(name ?? ''), picture: String(picture ?? ''), createdAt });
    return userView(this._userById.get(id));
  }

  userBySub(sub) {
    const row = this._userBySub.get(String(sub ?? ''));
    return row ? userView(row) : undefined;
  }

  user(id) {
    const row = this._userById.get(String(id ?? ''));
    return row ? userView(row) : undefined;
  }

  /** 邀請用：同一個信箱若有多個帳號（幾乎不可能，除非有人換過 Google 帳號），認最早那個 */
  userByEmail(email) {
    const row = this._userByEmail.get(String(email ?? '').trim().toLowerCase());
    return row ? userView(row) : undefined;
  }

  listUsers() {
    return this._userList.all().map(userView);
  }

  countUsers() {
    return Number(this._userCount.get().n ?? 0);
  }

  /**
   * 每次登入都順手更新顯示名、頭像與信箱：改頭像不該生出第二個帳號，也不該在介面上留舊的。
   * Google 那次沒給的欄位（空字串）保留原本的值，不要把資料擦掉。
   */
  touchLogin(id, profile = {}) {
    const row = this._userById.get(String(id ?? ''));
    if (!row) return undefined;
    this._userLogin.run({
      id: row.id,
      email: String(profile.email || row.email),
      name: String(profile.name || row.name),
      picture: String(profile.picture || row.picture),
      at: new Date().toISOString(),
    });
    return userView(this._userById.get(id));
  }

  insertSession({ id, hash, userId, label = '', expiresAt }) {
    const createdAt = new Date().toISOString();
    this._sessInsert.run({ id, hash, userId, label: String(label ?? '').slice(0, 60), createdAt, expiresAt });
    return sessionView(this._sessById.get(id));
  }

  /** 拿 bearer 的雜湊查；查不到回 undefined，讓路由層回到 401 */
  sessionByHash(hash) {
    const row = this._sessByHash.get(String(hash ?? ''));
    return row ? { ...sessionView(row), userId: row.user_id } : undefined;
  }

  session(id) {
    const row = this._sessById.get(String(id ?? ''));
    return row ? { ...sessionView(row), userId: row.user_id } : undefined;
  }

  listSessions(userId) {
    return this._sessList.all(String(userId ?? '')).map(sessionView);
  }

  revokeSession(id, userId = null) {
    const row = this._sessById.get(String(id ?? ''));
    if (!row) return false;
    if (userId && row.user_id !== String(userId)) return false;
    return this._sessRevoke.run(new Date().toISOString(), String(id ?? '')).changes > 0;
  }

  /** 「退出其他裝置」：留著手上這條，其餘全斷 */
  revokeOtherSessions(userId, exceptId) {
    return this._sessRevokeOthers.run(new Date().toISOString(), String(userId ?? ''), String(exceptId ?? '')).changes;
  }

  /** 滑動續期：到期前換一個新的 expires_at，不換 secret，客戶端不用處理輪換 */
  extendSession(id, expiresAt) {
    return this._sessExpire.run(String(expiresAt), String(id ?? '')).changes > 0;
  }

  touchSession(id) {
    this._sessHit.run(new Date().toISOString(), String(id ?? ''));
  }

  /* ------------------------------------------------------------------ 邀請 */

  /** 同一組（行程, 信箱）再邀一次就當更新權限，不會生出兩條 */
  upsertGrant({ tripId, owner, email, role = 'read' }) {
    const id = `g_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = new Date().toISOString();
    this._grantInsert.run({
      id,
      tripId: String(tripId ?? ''),
      owner: String(owner ?? ''),
      email: String(email ?? '').trim().toLowerCase(),
      role: role === 'write' ? 'write' : 'read',
      createdAt,
    });
    return grantView(this._grantFind.get(String(tripId ?? ''), String(email ?? '').trim().toLowerCase()));
  }

  grant(id) {
    const row = this._grantById.get(String(id ?? ''));
    return row ? grantView(row) : undefined;
  }

  /** 擁有者看自己發出去的邀請（含已撤銷的，清單要能交代歷史） */
  listGrants(ownerUserId) {
    return this._grantListOwned.all(String(ownerUserId ?? '')).map(grantView);
  }

  /** 受邀者看「別人給我的」：已作廢的不算，那代表邀請人已經反悔 */
  listGrantsFor(email) {
    return this._grantListFor.all(String(email ?? '').trim().toLowerCase()).map(grantView);
  }

  grantFor(tripId, email) {
    const row = this._grantFind.get(String(tripId ?? ''), String(email ?? '').trim().toLowerCase());
    return row ? grantView(row) : undefined;
  }

  revokeGrant(id, ownerUserId) {
    return this._grantRevoke.run(new Date().toISOString(), String(id ?? ''), String(ownerUserId ?? '')).changes > 0;
  }

  /**
   * 受邀者自己退出一趟共筆。
   *
   * 這只砍邀請，不動資料：那趟旅行連同對方記下的每一筆都還在邀請人那份帳本裡。
   * 方向也要分開——邀請人撤銷用 revokeGrant（認 id），這裡認的是（行程, 信箱），
   * 因為受邀者不該知道自己拿到的是哪一條 grant id，更不該碰得到別人的邀請。
   */
  leaveGrant(tripId, email) {
    return this._grantLeave.run(new Date().toISOString(), String(tripId ?? ''), String(email ?? '').trim().toLowerCase()).changes > 0;
  }

  /* ------------------------------------------------------------ 配對碼 */

  createPairing({ id, hash, label, scope, expiresAt, uid = '' }) {
    const createdAt = new Date().toISOString();
    this._pairInsert.run({ id, hash, label, scope, uid: String(uid ?? ''), createdAt, expiresAt });
    return pairingView(this._pairById.get(id));
  }

  /** 只給路由層判斷「這組碼存不存在」；比對雜湊本身在呼叫端做（要常數時間） */
  pairingByHash(hash) {
    const row = this._pairByHash.get(String(hash ?? ''));
    return row ? pairingView(row) : undefined;
  }

  pairing(id) {
    const row = this._pairById.get(String(id ?? ''));
    return row ? pairingView(row) : undefined;
  }

  /**
   * `uid` 傳 null（預設）是「整台伺服器的配對碼」，只有主金鑰該這樣查；
   * 登入者查自己的那份清單，所以傳帳號 id。注意 `''` 是有意義的分帳（帳號制度之前那筆），
   * 因此判斷用 `=== null`，不能用 `uid || null`。
   */
  listPairings(uid = null) {
    if (uid === null) return this._pairList.all().map(pairingView);
    return this._pairListUser.all(String(uid)).map(pairingView);
  }

  /** 用掉就蓋時間戳；回 false 代表已經被用過或已被作廢（防重放） */
  consumePairing(id, usedLabel = '') {
    return this._pairUse.run(new Date().toISOString(), String(usedLabel ?? '').slice(0, 60), String(id ?? '')).changes > 0;
  }

  revokePairing(id, uid = null) {
    const at = new Date().toISOString();
    if (uid === null) return this._pairRevoke.run(at, String(id ?? '')).changes > 0;
    return this._pairRevokeOwn.run(at, String(id ?? ''), String(uid)).changes > 0;
  }

  /* -------------------------------------------------- 簽發出去的 API token */

  /** 原字串不在這裡出現，傳進來的已經是雜湊 */
  createApiToken({ id, hash, hint, label, scope, expiresAt = null, uid = '' }) {
    const createdAt = new Date().toISOString();
    this._tokInsert.run({ id, hash, hint, label, scope, uid: String(uid ?? ''), createdAt, expiresAt });
    return tokenView(this._tokById.get(id));
  }

  /** 拿 bearer 的雜湊查：查不到就是沒這回事（回 undefined，讓路由層回到 401） */
  apiTokenByHash(hash) {
    const row = this._tokByHash.get(String(hash ?? ''));
    return row ? tokenView(row) : undefined;
  }

  /** 清單與撤銷都按分帳收口：`uid === null` 才是「整台」（只有主金鑰該這樣看） */
  apiToken(id, uid = null) {
    const row = this._tokById.get(String(id ?? ''));
    if (!row) return undefined;
    const view = tokenView(row);
    return uid === null || view.uid === String(uid) ? view : undefined;
  }

  listApiTokens(uid = null) {
    if (uid === null) return this._tokList.all().map(tokenView);
    return this._tokListUser.all(String(uid)).map(tokenView);
  }

  revokeApiToken(id, uid = null) {
    const at = new Date().toISOString();
    if (uid === null) return this._tokRevoke.run(at, String(id ?? '')).changes > 0;
    return this._tokRevokeOwn.run(at, String(id ?? ''), String(uid)).changes > 0;
  }

  /** 用一次算一筆，擁有者才需要知道哪把還在被使用 */
  touchApiToken(id, { write = false } = {}) {
    this._tokHit.run({ id: String(id ?? ''), read: 1, write: write ? 1 : 0, at: new Date().toISOString() });
  }

  /* ------------------------------------------------------------ 分享連結 */

  createShare({ tripId, label = '', expiresAt = null, uid = '', canWrite = true, pinHash = null }) {
    const token = newToken();
    const createdAt = new Date().toISOString();
    const owner = String(uid ?? '');
    const writable = canWrite === false ? 0 : 1;
    this._shareInsert.run({
      token,
      uid: owner,
      tripId,
      label: String(label ?? '').slice(0, 60),
      createdAt,
      expiresAt,
      canWrite: writable,
      pinHash,
    });
    return {
      token,
      uid: owner,
      tripId,
      label: String(label ?? '').slice(0, 60),
      createdAt,
      expiresAt,
      revokedAt: null,
      hits: 0,
      writes: 0,
      lastSeenAt: null,
      canWrite: writable === 1,
      hasPin: Boolean(pinHash),
      lastWriter: '',
    };
  }

  /** 回傳 undefined 代表這個 token 根本沒存在過 */
  share(token) {
    const row = this._shareGet.get(String(token ?? ''));
    return row ? shareView(row) : undefined;
  }

  /**
   * 清單永遠以分帳為單位：`uid` 傳 null 才是「整台都有誰發過連結」（給 SSH 救援看）。
   * 帳號模式下不帶 uid 就查，等於讓任何人看到別人的邀請名單，所以預設是 ''。
   */
  listShares({ tripId = null, uid = '' } = {}) {
    if (uid === null) return this._shareAll.all().map(shareView);
    const rows = tripId ? this._shareList.all(String(uid), String(tripId)) : this._shareListUser.all(String(uid));
    return rows.map(shareView);
  }

  /** 作廢：只有 revoked_at 是 NULL 的會被打上時間戳，回傳有沒有真的改到 */
  revokeShare(token, uid = null) {
    const at = new Date().toISOString();
    if (uid === null) return this._shareRevoke.run(at, String(token ?? '')).changes > 0;
    return this._shareRevokeOwn.run(at, String(token ?? ''), String(uid)).changes > 0;
  }

  /** 開一次連結算一筆 hit，代記一筆算一筆 write；擁有者才需要知道這些數字 */
  touchShare(token, { write = false, who = '' } = {}) {
    const name = String(who ?? '').trim().slice(0, 24);
    this._shareHit.run({ token: String(token ?? ''), read: 1, write: write ? 1 : 0, who: name, at: new Date().toISOString() });
  }

  /**
   * 訪客 PIN 的比對留在資料層：雜湊不進 `shareView`，路由層就拿不到、也不可能誤回給前端。
   * 沒設 PIN 的連結一律算過——那是絕大多數（「丟到 LINE Grupo 就能記」）的路徑。
   */
  sharePinOk(token, pin) {
    const row = this._shareGet.get(String(token ?? ''));
    if (!row) return false;
    if (!row.pin_hash) return true;
    const want = Buffer.from(String(row.pin_hash), 'hex');
    const got = crypto.createHash('sha256').update(String(pin ?? ''), 'utf8').digest();
    return want.length === 32 && crypto.timingSafeEqual(want, got);
  }

  get keep() {
    const row = this._metaGet.get('keep');
    const n = Number(row?.value ?? process.env.TRIPLOG_KEEP ?? DEFAULT_KEEP);
    return Number.isFinite(n) && n >= 1 ? Math.min(200, Math.trunc(n)) : DEFAULT_KEEP;
  }

  setKeep(n) {
    this._metaSet.run('keep', String(n));
  }

  /**
   * 寫一筆快照，回傳它的位置與大小。
   *
   * 內容和基準一模一樣時（只有寫檔時間不同）直接回傳既有那筆：「立即同步」與開機
   * 自動同步每次都會推，不擋的話 keep 那 20 格一下就被同一份資料塞滿，真的要回頭
   * 找舊版本時反而找不到。
   *
   * `uid` 決定這筆落在誰的分帳：'' 是帳號制度之前的那份單一基準（金鑰模式也寫這裡），
   * 登入後的裝置傳自己的帳號 id。歷史保留上限（keep）是分帳各自算的，
   * 誰推得頻繁都不會把別人的歷史擠掉。
   *
   * @returns {{ id: string, exportedAt: string, bytes: number, trimmedPhotos: number, unchanged?: boolean }}
   */
  put(body, { uid = '', source = 'push' } = {}) {
    const owner = String(uid ?? '');
    const { backup, bytes, trimmedPhotos } = normalizeSnapshot(body);
    const fp = fingerprint(backup);
    const head = this._latest.get(owner);
    // 舊資料列還沒有 fp（補欄位之前的快照），退回用 payload 算一次
    if (head && (head.fp ?? fingerprint(JSON.parse(head.payload))) === fp) {
      return { id: head.id, exportedAt: head.exported_at, bytes: head.bytes, unchanged: true, trimmedPhotos };
    }
    const createdAt = new Date().toISOString();
    let id = backup.exportedAt;
    if (this._byId.get(id, owner)) id = `${backup.exportedAt}#${crypto.randomBytes(3).toString('hex')}`;
    this._insert.run({ id, uid: owner, exportedAt: backup.exportedAt, createdAt, source, bytes, fp, payload: JSON.stringify(backup) });
    this._prune.run(owner, owner, this.keep);
    return { id, exportedAt: backup.exportedAt, bytes, trimmedPhotos };
  }

  /** 基準快照：這個分帳的最新一筆 + 所有歷史的並集，重複推送不會把別人的資料洗掉 */
  base(uid = '') {
    const owner = String(uid ?? '');
    const head = this._latest.get(owner);
    if (!head) return { snapshot: emptySnapshot(), head: null, history: 0 };
    const all = this._payloads
      .all(owner, this.keep)
      .map((r) => JSON.parse(r.payload));
    // 由新到舊合併：時間戳較新者勝、平手偏向第一份，所以最新快照自然成為基準
    const snapshot = mergeSources(all);
    return {
      snapshot,
      head: { id: head.id, exportedAt: head.exported_at, createdAt: head.created_at, bytes: head.bytes },
      history: all.length,
    };
  }

  get(id, uid = '') {
    const row = this._byId.get(String(id ?? ''), String(uid ?? ''));
    return row ? { ...JSON.parse(row.payload), id: row.id } : null;
  }

  list({ uid = '', limit = 20, offset = 0 } = {}) {
    return this._list.all(String(uid ?? ''), Math.min(100, limit), offset).map((r) => ({
      id: r.id,
      exportedAt: r.exported_at,
      createdAt: r.created_at,
      source: r.source,
      bytes: r.bytes,
    }));
  }

  /** 某個分帳的體況（給 /api/base 與客戶端的「伺服器上有多大」） */
  stats(uid = '') {
    const owner = String(uid ?? '');
    const row = this._count.get(owner, owner);
    const head = this._latest.get(owner);
    return {
      snapshots: Number(row.n),
      totalBytes: Number(row.bytes),
      head: head ? { id: head.id, exportedAt: head.exported_at, bytes: head.bytes } : null,
      keep: this.keep,
      maxSize: MAX_SNAPSHOT_BYTES,
    };
  }

  /** 整台伺服器的統計：只給 /api/health 與開機日誌，用來判斷「有沒有爆盤」，不分帳 */
  statsAll() {
    const row = this._count.get(null, null);
    const head = this._headAny.get();
    return {
      snapshots: Number(row.n),
      totalBytes: Number(row.bytes),
      head: head ? { id: head.id, exportedAt: head.exported_at, bytes: head.bytes } : null,
      keep: this.keep,
      maxSize: MAX_SNAPSHOT_BYTES,
      users: this.countUsers(),
    };
  }

  /**
   * 把帳號制度之前的那份單一基準認領給某個帳號（只在第一次登入時做）。
   *
   * 這是「舊資料跟著人走」的關鍵：沒有這一步，使用者一登入就會看到一個空帳本，
   * 而原本的資料變成誰也拿不到的孤兒。移動的是分帳標籤，內容一個 byte 都不改。
   * @returns {{ moved: number }}
   */
  claimLegacyBase(userId) {
    const info = this._claim.run(String(userId ?? ''));
    return { moved: info.changes };
  }

  clear() {
    const info = this.db.prepare('DELETE FROM snapshots').run();
    return { removed: info.changes };
  }
}
