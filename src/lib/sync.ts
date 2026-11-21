/**
 * 跨裝置同步：把本機 IndexedDB 與後端的單一「基準檔」雙向往復。
 *
 * 後端存的是一份 triplog-backup（和「設定 → 匯出備份」同一個格式），
 * 合併規則放在 merge-core.js，瀏覽器與伺服器共用，所以兩端算法不會分岔。
 *
 * 關鍵取捨（寫下來，避免以後驚訝）：
 * - 沒有刪除語意：一端刪掉的東西，下次同步會被另一端帶回來。
 * - 照片只在「本機還沒有」時才下載，而且一次最多 150 張，行動裝置才不會一口氣吃掉流量。
 * - 每次同步都會用本機資料把基準檔重寫一次，所以後端永遠是兩端的並集。
 */
import { db } from '../db/db';
import { exportBackup } from '../db/repo';
import type { BackupFile, Photo, Trip } from '../db/types';
import { dataUrlToBlob } from './images';
import { countsOf, mergeBackupObjects, type BackupLike } from './merge-core';

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
  pulled: { trips: number; dayItems: number; expenses: number; photos: number };
  pushed: { trips: number; dayItems: number; expenses: number };
  photosDownloaded: number;
  remoteBytes: number;
};

export class SyncError extends Error {
  code: 'insecure' | 'auth' | 'notfound' | 'network' | 'server' | 'badpayload';
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
  if (res.status === 401 || res.status === 403) throw new SyncError('auth', '金鑰不對或沒有寫入權限');
  if (res.status === 404) throw new SyncError('notfound', '後端還沒有任何資料');
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* 非 JSON 錯誤體就略過 */
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
    meta: data.meta ?? [],
  };
}

/** 把合併後的快照寫回 IndexedDB（只覆寫同 id，不做任何刪除） */
async function applySnapshot(snap: BackupFile): Promise<void> {
  const meta = snap.meta.filter((m) => m.key !== 'app');
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.meta],
    async () => {
      if (snap.categories.length) await db.categories.bulkPut(snap.categories);
      if (meta.length) await db.meta.bulkPut(meta);
      if (snap.trips.length) await db.trips.bulkPut(snap.trips);
      if (snap.dayItems.length) await db.dayItems.bulkPut(snap.dayItems);
      if (snap.expenses.length) await db.expenses.bulkPut(snap.expenses);
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
  await applySnapshot(merged);
  const at = new Date().toISOString();
  setLastSyncAt(at);
  return {
    at,
    pulled: countsOf(remote.base),
    pushed: { trips: 0, dayItems: 0, expenses: 0 },
    photosDownloaded: photosWritten,
    remoteBytes: remote.bytes ?? 0,
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
    pulled: { trips: 0, dayItems: 0, expenses: 0, photos: 0 },
    pushed: {
      trips: local.trips.length,
      dayItems: local.dayItems.length,
      expenses: local.expenses.length,
    },
    photosDownloaded: 0,
    remoteBytes: res.bytes ?? 0,
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
  await applySnapshot(merged);
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
    },
    photosDownloaded,
    remoteBytes: res.bytes ?? remote.bytes ?? 0,
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
export async function pullTrip(cfg: SyncConfig, tripId: string): Promise<{ name: string; items: number; expenses: number; photos: number }> {
  const res = await api<{ backup: BackupFile }>(cfg, `/api/trips/${encodeURIComponent(tripId)}/export`);
  const snap = res.backup;
  const trip = snap.trips[0] as Trip | undefined;
  const photos = (snap.photos ?? []).map(toPhoto);
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.photos],
    async () => {
      if (snap.categories.length) await db.categories.bulkPut(snap.categories);
      if (snap.trips.length) await db.trips.bulkPut(snap.trips);
      if (snap.dayItems.length) await db.dayItems.bulkPut(snap.dayItems);
      if (snap.expenses.length) await db.expenses.bulkPut(snap.expenses);
      if (photos.length) await db.photos.bulkPut(photos);
    },
  );
  setLastSyncAt(new Date().toISOString());
  return {
    name: trip?.name ?? '',
    items: snap.dayItems.length,
    expenses: snap.expenses.length,
    photos: photos.length,
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
): Promise<{ id: string; name: string; startDate: string; endDate: string; items: number; expenses: number }[]> {
  const res = await api<{ trips: { id: string; name: string; startDate: string; endDate: string }[]; counts: Record<string, { items: number; expenses: number }> }>(
    cfg,
    '/api/trips',
  );
  return res.trips.map((t) => ({ ...t, ...(res.counts?.[t.id] ?? { items: 0, expenses: 0 }) }));
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
