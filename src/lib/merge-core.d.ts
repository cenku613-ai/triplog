import type { BackupFile, TombKind, Tombstone } from '../db/types';

export type MergeTable = 'trips' | 'dayItems' | 'expenses' | 'categories' | 'photos' | 'checkItems';
export type BackupLike = Partial<BackupFile> & { format?: string };

/** 刪除記號保留多久（超過就放手，讓一年沒開的裝置不會永遠壓著別人刪掉的東西） */
export const TOMBSTONE_DAYS: number;

/** 由 id 前綴推表名（舊客戶端只送 id 時用）；推不出來回 null。前後端共用同一張對照表 */
export function kindFromId(id: string): TombKind | null;

/** 建立一筆刪除記號；不給 kind 時由 id 前綴推，推不出來就丟錯 */
export function tombstone(id: string, kind?: TombKind, deletedAt?: string): Tombstone;

/** 把多份文件的刪除記號收成一張表（含過期清理），合併與客戶端套用都用它 */
export function collectTombstones(
  sources: BackupLike[],
  opts?: { now?: number; days?: number },
): { byId: Map<string, Tombstone>; kinds: Map<string, TombKind>; list: Tombstone[] };

/** 照記號清一份文件（不合併也能用）；`extra` 是本機另外知道的那些記號 */
export function suppressDeleted<T extends BackupLike>(src: T, extra?: BackupLike[]): T;

export function mergeSources(sources: BackupLike[]): BackupFile;
export function mergeBackupObjects(a: BackupLike, b: BackupLike): BackupFile;
export function sliceTrip(src: BackupLike, tripId: string): BackupFile;
export function countsOf(src: BackupLike): {
  trips: number;
  dayItems: number;
  expenses: number;
  categories: number;
  photos: number;
  checkItems: number;
};
