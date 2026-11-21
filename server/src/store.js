/**
 * 同步資料層：整個備份檔（triplog-backup）作為「基準快照」存進 SQLite。
 *
 * 為什麼是整檔而不是逐列存：客戶端本身就有合併好的並集，伺服器只需要
 * 「存最新並集 + 留歷史」，schema 就不會和 App 的欄位一起膨脹，
 * 也天生支援未來新增的欄位（JSON 直接進出）。
 *
 * 沒有帳號系統，只有一把 bearer token（外加「分享連結」用的 trip 級 token，
 * 見 share.js）。因此這裡刻意不做任何刪除資料的 API，也不把金鑰存進資料庫——
 * 誤刪的風險留給本機（有備份檔）而不是伺服器。
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
    tripId: r.trip_id,
    label: r.label ?? '',
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    hits: Number(r.hits ?? 0),
    writes: Number(r.writes ?? 0),
    lastSeenAt: r.last_seen_at ?? null,
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
    `);
    // 舊資料庫補上內容指紋欄位；SQLite 沒有 ADD COLUMN IF NOT EXISTS，重複執行就當它已經有了
    try {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN fp TEXT');
    } catch {
      /* 欄位已存在 */
    }
    this._insert = this.db.prepare(
      'INSERT INTO snapshots (id, exported_at, created_at, source, bytes, fp, payload) VALUES (@id, @exportedAt, @createdAt, @source, @bytes, @fp, @payload)',
    );
    this._latest = this.db.prepare('SELECT * FROM snapshots ORDER BY exported_at DESC, created_at DESC LIMIT 1');
    this._byId = this.db.prepare('SELECT * FROM snapshots WHERE id = ?');
    this._count = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM snapshots');
    this._list = this.db.prepare(
      'SELECT id, exported_at, created_at, source, bytes FROM snapshots ORDER BY exported_at DESC LIMIT ? OFFSET ?',
    );
    this._prune = this.db.prepare(
      'DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY exported_at DESC, created_at DESC LIMIT ?)',
    );
    this._metaGet = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this._metaSet = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this._shareInsert = this.db.prepare(
      'INSERT INTO shares (token, trip_id, label, created_at, expires_at) VALUES (@token, @tripId, @label, @createdAt, @expiresAt)',
    );
    this._shareGet = this.db.prepare('SELECT * FROM shares WHERE token = ?');
    this._shareList = this.db.prepare('SELECT * FROM shares WHERE trip_id = ? ORDER BY created_at DESC');
    this._shareAll = this.db.prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT 200');
    this._shareRevoke = this.db.prepare('UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL');
    this._shareHit = this.db.prepare(
      'UPDATE shares SET hits = hits + @read, writes = writes + @write, last_seen_at = @at WHERE token = @token',
    );
  }

  /* ------------------------------------------------------------ 分享連結 */

  /** @returns {{ token: string, tripId: string, label: string, createdAt: string, expiresAt: string|null }} */
  createShare({ tripId, label = '', expiresAt = null }) {
    const token = newToken();
    const createdAt = new Date().toISOString();
    this._shareInsert.run({ token, tripId, label: String(label ?? '').slice(0, 60), createdAt, expiresAt });
    return { token, tripId, label: String(label ?? '').slice(0, 60), createdAt, expiresAt, revokedAt: null, hits: 0, writes: 0, lastSeenAt: null };
  }

  /** 回傳 undefined 代表這個 token 根本沒存在過 */
  share(token) {
    const row = this._shareGet.get(String(token ?? ''));
    return row ? shareView(row) : undefined;
  }

  listShares(tripId = null) {
    const rows = tripId ? this._shareList.all(String(tripId)) : this._shareAll.all();
    return rows.map(shareView);
  }

  /** 作廢：只有 revoked_at 是 NULL 的會被打上時間戳，回傳有沒有真的改到 */
  revokeShare(token) {
    return this._shareRevoke.run(new Date().toISOString(), String(token ?? '')).changes > 0;
  }

  /** 開一次連結算一筆 hit，代記一筆算一筆 write；擁有者才需要知道這些數字 */
  touchShare(token, { write = false } = {}) {
    this._shareHit.run({ token: String(token ?? ''), read: 1, write: write ? 1 : 0, at: new Date().toISOString() });
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
   * @returns {{ id: string, exportedAt: string, bytes: number, trimmedPhotos: number, unchanged?: boolean }}
   */
  put(body, { source = 'push' } = {}) {
    const { backup, bytes, trimmedPhotos } = normalizeSnapshot(body);
    const fp = fingerprint(backup);
    const head = this._latest.get();
    // 舊資料列還沒有 fp（補欄位之前的快照），退回用 payload 算一次
    if (head && (head.fp ?? fingerprint(JSON.parse(head.payload))) === fp) {
      return { id: head.id, exportedAt: head.exported_at, bytes: head.bytes, unchanged: true, trimmedPhotos };
    }
    const createdAt = new Date().toISOString();
    let id = backup.exportedAt;
    if (this._byId.get(id)) id = `${backup.exportedAt}#${crypto.randomBytes(3).toString('hex')}`;
    this._insert.run({ id, exportedAt: backup.exportedAt, createdAt, source, bytes, fp, payload: JSON.stringify(backup) });
    this._prune.run(this.keep);
    return { id, exportedAt: backup.exportedAt, bytes, trimmedPhotos };
  }

  /** 基準快照：最新一筆 + 所有歷史的並集，重複推送不會把別人的資料洗掉 */
  base() {
    const head = this._latest.get();
    if (!head) return { snapshot: emptySnapshot(), head: null, history: 0 };
    const all = this.db
      .prepare('SELECT payload FROM snapshots ORDER BY exported_at DESC, created_at DESC LIMIT ?')
      .all(this.keep)
      .map((r) => JSON.parse(r.payload));
    // 由新到舊合併：時間戳較新者勝、平手偏向第一份，所以最新快照自然成為基準
    const snapshot = mergeSources(all);
    return {
      snapshot,
      head: { id: head.id, exportedAt: head.exported_at, createdAt: head.created_at, bytes: head.bytes },
      history: all.length,
    };
  }

  get(id) {
    const row = this._byId.get(id);
    return row ? { ...JSON.parse(row.payload), id: row.id } : null;
  }

  list({ limit = 20, offset = 0 } = {}) {
    return this._list.all(Math.min(100, limit), offset).map((r) => ({
      id: r.id,
      exportedAt: r.exported_at,
      createdAt: r.created_at,
      source: r.source,
      bytes: r.bytes,
    }));
  }

  stats() {
    const row = this._count.get();
    const head = this._latest.get();
    return {
      snapshots: row.n,
      totalBytes: row.bytes,
      head: head ? { id: head.id, exportedAt: head.exported_at, bytes: head.bytes } : null,
      keep: this.keep,
      maxSize: MAX_SNAPSHOT_BYTES,
    };
  }

  clear() {
    const info = this.db.prepare('DELETE FROM snapshots').run();
    return { removed: info.changes };
  }
}
