/**
 * 跨裝置同步：把本機 IndexedDB 與後端的單一「基準檔」雙向往復。
 *
 * 後端存的是一份 triplog-backup（和「設定 → 匯出備份」同一個格式），
 * 合併規則放在 merge-core.js，瀏覽器與伺服器共用，所以兩端算法不會分岔。
 *
 * 關鍵取捨（寫下來，避免以後驚訝）：
 * - 刪除會同步：刪掉一列時本機留一筆刪除記號（tombstones），它跟著每次推送走，
 *   合併端照它把列從基準裡拿掉，本機則在套用時真的清掉（見 removeDeleted）。
 *   代碼裡「檔案沒有這一筆」永遠不等於「請刪掉它」——只有記號才算數。
 * - 記號保留一年（merge-core 的 TOMBSTONE_DAYS）：超過一年沒開的裝置仍可能把舊紀錄帶回來。
 * - 照片只在「本機還沒有」時才下載，而且一次最多 150 張，行動裝置才不會一口氣吃掉流量。
 * - 每次同步都會用本機資料把基準檔重寫一次，所以後端永遠是兩端的並集。
 */
import { db } from '../db/db';
import { exportBackup } from '../db/repo';
import type { BackupFile, Photo, TombKind, Trip } from '../db/types';
import { dataUrlToBlob } from './images';
import { collectTombstones, countsOf, mergeBackupObjects, type BackupLike } from './merge-core';

export const SYNC_STORAGE_KEY = 'triplog:sync';
/** 一次同步最多抓幾張照片（150 張約 15 MB） */
const MAX_PHOTO_FETCH = 150;

export type SyncConfig = {
  /** 例：https://triplogmo.duckdns.org 或 http://127.0.0.1:8788 */
  baseUrl: string;
  /** TRIPLOG_READ_KEY（只抓得上來）或 TRIPLOG_API_KEY（推得上去） */
  apiKey: string;
  /** 開啟後每次啟動嘗試同步一次 */
  auto: boolean;
};

export type SyncReport = {
  at: string;
  pulled: { trips: number; dayItems: number; expenses: number; photos: number; checkItems: number };
  pushed: { trips: number; dayItems: number; expenses: number; checkItems: number };
  photosDownloaded: number;
  remoteBytes: number;
  /** 這次照刪除記號從本機清掉幾列（包含連動刪掉的行程項／支出／照片／勾選清單） */
  deleted: number;
};

export class SyncError extends Error {
  code: 'insecure' | 'auth' | 'login' | 'notfound' | 'network' | 'server' | 'badpayload';
  constructor(code: SyncError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ 設定 */

export function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as SyncConfig;
    if (!cfg.baseUrl || !cfg.apiKey) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveSyncConfig(cfg: SyncConfig | null): void {
  try {
    if (cfg) localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(SYNC_STORAGE_KEY);
  } catch {
    /* 無痕模式下寫不進去，不影響本機記錄 */
  }
}

/** 最近一次同步成功的時間（ISO），沒有則 null */
export function lastSyncAt(): string | null {
  try {
    return localStorage.getItem(`${SYNC_STORAGE_KEY}:last`);
  } catch {
    return null;
  }
}

function setLastSyncAt(iso: string): void {
  try {
    localStorage.setItem(`${SYNC_STORAGE_KEY}:last`, iso);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ 用戶端 */

function assertSecureOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SyncError('badpayload', 'URL 格式不對');
  }
  const pageSecure = typeof location !== 'undefined' && location.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new SyncError(
      'insecure',
      pageSecure
        ? 'HTTPS 頁面不能打非加密的同步網址（瀏覽器會擋 mixed content），請改用 https'
        : '同步伺服器網址必須是 https（PWA 需要安全內容才能註冊 Service Worker）',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SyncError('badpayload', '只支援 http/https');
}

type ApiOpts = { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal };

async function api<T>(cfg: SyncConfig, path: string, opts: ApiOpts = {}): Promise<T> {
  assertSecureOrigin(cfg.baseUrl);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}${path}`;
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${cfg.apiKey}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new SyncError('network', `連不到 ${new URL(url).host}：${(err as Error).message}`);
  }
  if (res.status === 404) throw new SyncError('notfound', '後端還沒有任何資料');
  if (!res.ok) {
    let detail = '';
    let wantsLogin = false;
    try {
      const body = (await res.json()) as { error?: string; login?: boolean };
      detail = body.error ?? '';
      wantsLogin = body.login === true;
    } catch {
      /* 非 JSON 錯誤體就略過 */
    }
    // 帳號模式下的 401 缺的是「重新登入」，不是「換一把金鑰」：兩句話要分開講，
    // 否則使用者會跑去設定頁貼主金鑰，而那把現在看到的是另一個分帳。
    if (res.status === 401 || res.status === 403) {
      throw new SyncError(
        wantsLogin ? 'login' : 'auth',
        wantsLogin ? '這台裝置的登入已失效，請到「設定 → 帳號」重新用 Google 登入' : '金鑰不對或沒有寫入權限',
      );
    }
    throw new SyncError('server', `後端回 ${res.status}${detail ? `：${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

/* -------------------------------------------------------------- 本機 ↔ 快照 */

/** 不含照片 base64 的本機快照——每次同步都要傳這份，所以照片絕對不能跟著進來 */
export async function localSnapshot(): Promise<BackupFile> {
  return exportBackup({ excludePhotos: true });
}

function snapshotOf(data: BackupLike): BackupFile {
  return {
    format: 'triplog-backup',
    version: 1,
    exportedAt: data.exportedAt ?? new Date().toISOString(),
    trips: data.trips ?? [],
    dayItems: data.dayItems ?? [],
    expenses: data.expenses ?? [],
    categories: data.categories ?? [],
    photos: [],
    checkItems: data.checkItems ?? [],
    tombstones: data.tombstones ?? [],
    meta: data.meta ?? [],
  };
}

/**
 * 照刪除記號把本機那幾列真的清掉，回傳清了幾列。
 *
 * 傳進來的通常是合併後的基準：裡面那些列已經由 merge-core 濾掉了，所以「檔案裡沒有」這件事
 * 在本機推不出任何東西——離線裝置推來的一份舊並集同樣子會少了別人的紀錄。
 * 只有 tombstones 寫著的那幾個 id 才算已刪，並且往下連動（旅行沒了，它的列也不會留在本機）。
 */
async function removeDeleted(doc: BackupLike): Promise<number> {
  const { kinds } = collectTombstones([doc]);
  if (!kinds.size) return 0;
  const idsOf = (kind: TombKind): string[] =>
    [...kinds.entries()].filter(([, k]) => k === kind).map(([id]) => id);
  const trips = idsOf('trips');
  const items = idsOf('dayItems');
  let removed = 0;
  removed += await db.trips.where('id').anyOf(idsOf('trips')).count();
  removed += await db.expenses.where('id').anyOf(idsOf('expenses')).count();
  removed += await db.photos.where('id').anyOf(idsOf('photos')).count();
  removed += await db.dayItems.where('id').anyOf(items).count();
  removed += await db.checkItems.where('id').anyOf(idsOf('checkItems')).count();
  await db.trips.bulkDelete(idsOf('trips'));
  await db.expenses.bulkDelete(idsOf('expenses'));
  await db.photos.bulkDelete(idsOf('photos'));
  await db.dayItems.bulkDelete(items);
  await db.checkItems.bulkDelete(idsOf('checkItems'));
  if (trips.length) {
    // 連動：本機可能還留著那一趟的子列（它們在基準裡已被濾掉，不會出現在 doc 中）
    removed += await db.dayItems.where('tripId').anyOf(trips).count();
    removed += await db.expenses.where('tripId').anyOf(trips).count();
    removed += await db.photos.where('tripId').anyOf(trips).count();
    removed += await db.checkItems.where('tripId').anyOf(trips).count();
    await db.dayItems.where('tripId').anyOf(trips).delete();
    await db.expenses.where('tripId').anyOf(trips).delete();
    await db.photos.where('tripId').anyOf(trips).delete();
    await db.checkItems.where('tripId').anyOf(trips).delete();
  }
  if (items.length) {
    removed += await db.photos.where('dayItemId').anyOf(items).count();
    await db.photos.where('dayItemId').anyOf(items).delete();
  }
  return removed;
}

/** 把合併後的快照寫回 IndexedDB：同 id 覆寫，並照刪除記號清掉已刪的那些 */
async function applySnapshot(snap: BackupFile): Promise<number> {
  const meta = snap.meta.filter((m) => m.key !== 'app');
  const markers = snap.tombstones ?? [];
  return db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.meta, db.photos, db.checkItems, db.tombstones],
    async () => {
      // 記號先落地：之後的推送要繼續帶著它們，別人才不會把同一筆又長回來
      if (markers.length) await db.tombstones.bulkPut(markers);
      if (snap.categories.length) await db.categories.bulkPut(snap.categories);
      if (meta.length) await db.meta.bulkPut(meta);
      if (snap.trips.length) await db.trips.bulkPut(snap.trips);
      if (snap.dayItems.length) await db.dayItems.bulkPut(snap.dayItems);
      if (snap.expenses.length) await db.expenses.bulkPut(snap.expenses);
      if (snap.checkItems?.length) await db.checkItems.bulkPut(snap.checkItems);
      return removeDeleted(snap);
    },
  );
}

type RemotePhoto = {
  id: string;
  tripId: string;
  dayItemId?: string | null;
  width: number;
  height: number;
  mime: string;
  source: 'device' | 'commons';
  creditUrl?: string;
  artist?: string;
  license?: string;
  caption?: string;
  createdAt: string;
  data: string;
  thumbData: string;
};

function toPhoto(row: RemotePhoto): Photo {
  const { data, thumbData, ...rest } = row;
  return {
    ...rest,
    dayItemId: rest.dayItemId ?? null,
    blob: dataUrlToBlob(data),
    thumb: dataUrlToBlob(thumbData || data),
  };
}

/* ----------------------------------------------------------------- 同步流程 */

/** 只把伺服器上的資料拉下來合併進本機，不推送（新裝置入門用） */
export async function pullFromServer(cfg: SyncConfig): Promise<SyncReport> {
  const remote = await api<{ base: BackupLike; bytes: number }>(cfg, '/api/base');
  const local = await localSnapshot();
  const merged = mergeBackupObjects(local, remote.base);
  const photosWritten = await fetchMissingPhotos(cfg, merged);
  const deleted = await applySnapshot(merged);
  const at = new Date().toISOString();
  setLastSyncAt(at);
  return {
    at,
    pulled: countsOf(remote.base),
    pushed: { trips: 0, dayItems: 0, expenses: 0, checkItems: 0 },
    photosDownloaded: photosWritten,
    remoteBytes: remote.bytes ?? 0,
    deleted,
  };
}

/** 把本機整包推上去（後端以 id 覆寫基準檔） */
export async function pushToServer(cfg: SyncConfig): Promise<SyncReport> {
  const local = await exportBackup(); // 含照片 base64：這是唯一會把照片送上伺服器的動作
  const res = await api<{ savedAt: string; bytes: number; trimmedPhotos?: number }>(
    cfg,
    '/api/backup',
    { method: 'POST', body: local },
  );
  const at = new Date().toISOString();
  setLastSyncAt(at);
  return {
    at,
    pulled: { trips: 0, dayItems: 0, expenses: 0, photos: 0, checkItems: 0 },
    pushed: {
      trips: local.trips.length,
      dayItems: local.dayItems.length,
      expenses: local.expenses.length,
      checkItems: local.checkItems?.length ?? 0,
    },
    photosDownloaded: 0,
    remoteBytes: res.bytes ?? 0,
    // 只推不拉，本機自然不會清掉任何東西
    deleted: 0,
  };
}

/** 雙向往返：拉基準 → 併進本機 → 再把並集推回基準 */
export async function syncNow(cfg: SyncConfig): Promise<SyncReport> {
  const remote = await api<{ base: BackupLike; bytes: number }>(cfg, '/api/base').catch((err) => {
    // 後端還空著（404）時，本機就是基準，直接推上去
    if (err instanceof SyncError && err.code === 'notfound') return { base: snapshotOf({}), bytes: 0 };
    throw err;
  });
  const local = await localSnapshot();
  const merged = mergeBackupObjects(remote.base, local);
  const photosDownloaded = await fetchMissingPhotos(cfg, merged);
  const deleted = await applySnapshot(merged);
  const push = await exportBackup();
  const res = await api<{ savedAt: string; bytes: number }>(cfg, '/api/backup', {
    method: 'POST',
    body: push,
  });
  const at = new Date().toISOString();
  setLastSyncAt(at);
  return {
    at,
    pulled: countsOf(remote.base),
    pushed: {
      trips: push.trips.length,
      dayItems: push.dayItems.length,
      expenses: push.expenses.length,
      checkItems: push.checkItems?.length ?? 0,
    },
    photosDownloaded,
    remoteBytes: res.bytes ?? remote.bytes ?? 0,
    deleted,
  };
}

/** 基準檔裡列了、但本機沒有 Blob 的照片，才下載回來（基準檔本身不含照片資料） */
async function fetchMissingPhotos(cfg: SyncConfig, merged: BackupFile): Promise<number> {
  const listed = merged.photos ?? [];
  if (!listed.length) return 0;
  const present = new Set<string>();
  const ids = listed.map((p) => p.id);
  // 分批查，避免一次把整張清單塞進 IDB 查詢
  for (const chunk of chunked(ids, 200)) {
    const rows = await db.photos.where('id').anyOf(chunk).primaryKeys();
    for (const k of rows) present.add(String(k));
  }
  const missing = ids.filter((id) => !present.has(id));
  if (!missing.length) return 0;
  const wanted = missing.slice(0, MAX_PHOTO_FETCH);
  const res = await api<{ photos: RemotePhoto[] }>(cfg, '/api/photos/get', {
    method: 'POST',
    body: { photoIds: wanted },
  });
  const rows = (res.photos ?? []).filter((p) => p.data).map(toPhoto);
  if (rows.length) {
    await db.transaction('rw', db.photos, async () => db.photos.bulkPut(rows));
  }
  return rows.length;
}

/** 只抓某一趟（含照片）併進本機，不動其他旅行 */
export async function pullTrip(cfg: SyncConfig, tripId: string): Promise<{ name: string; items: number; expenses: number; photos: number; checkItems: number }> {
  const res = await api<{ backup: BackupFile }>(cfg, `/api/trips/${encodeURIComponent(tripId)}/export`);
  const snap = res.backup;
  const trip = snap.trips[0] as Trip | undefined;
  const photos = (snap.photos ?? []).map(toPhoto);
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.photos, db.checkItems, db.tombstones],
    async () => {
      const markers = snap.tombstones ?? [];
      if (markers.length) await db.tombstones.bulkPut(markers);
      if (snap.categories.length) await db.categories.bulkPut(snap.categories);
      if (snap.trips.length) await db.trips.bulkPut(snap.trips);
      if (snap.dayItems.length) await db.dayItems.bulkPut(snap.dayItems);
      if (snap.expenses.length) await db.expenses.bulkPut(snap.expenses);
      if (snap.checkItems?.length) await db.checkItems.bulkPut(snap.checkItems);
      if (photos.length) await db.photos.bulkPut(photos);
      // 這趟的刪除記號也要落到本機：對方在別台刪掉的行程項，不能因為「只拉這趟」而留著
      await removeDeleted(snap);
    },
  );
  setLastSyncAt(new Date().toISOString());
  return {
    name: trip?.name ?? '',
    items: snap.dayItems.length,
    expenses: snap.expenses.length,
    photos: photos.length,
    checkItems: snap.checkItems?.length ?? 0,
  };
}

/** 測試連線用：只讀基準檔的 metadata，不抓內容（後端空著時回 0） */
export async function testConnection(
  cfg: SyncConfig,
): Promise<{ bytes: number; trips: number; head: string | null }> {
  const res = await api<{ bytes: number; counts: Record<string, unknown>; head?: { exportedAt?: string } }>(
    cfg,
    '/api/base',
  ).catch((err) => {
    if (err instanceof SyncError && err.code === 'notfound') return { bytes: 0, counts: {}, head: undefined };
    throw err;
  });
  return { bytes: res.bytes ?? 0, trips: Object.keys(res.counts ?? {}).length, head: res.head?.exportedAt ?? null };
}

export async function listRemoteTrips(
  cfg: SyncConfig,
): Promise<{ id: string; name: string; startDate: string; endDate: string; items: number; expenses: number; checkItems: number }[]> {
  const res = await api<{ trips: { id: string; name: string; startDate: string; endDate: string }[]; counts: Record<string, { items: number; expenses: number; checkItems?: number }> }>(
    cfg,
    '/api/trips',
  );
  return res.trips.map((t) => ({
    ...t,
    items: res.counts?.[t.id]?.items ?? 0,
    expenses: res.counts?.[t.id]?.expenses ?? 0,
    checkItems: res.counts?.[t.id]?.checkItems ?? 0,
  }));
}

export function describeSyncError(err: unknown): string {
  if (err instanceof SyncError) return err.message;
  if ((err as Error)?.name === 'AbortError') return '同步已取消';
  return (err as Error)?.message ?? '同步失敗';
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
