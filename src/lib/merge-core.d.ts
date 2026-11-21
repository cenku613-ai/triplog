import type { BackupFile } from '../db/types';

export type MergeTable = 'trips' | 'dayItems' | 'expenses' | 'categories' | 'photos';
export type BackupLike = Partial<BackupFile> & { format?: string };

export function mergeSources(sources: BackupLike[]): BackupFile;
export function mergeBackupObjects(a: BackupLike, b: BackupLike): BackupFile;
export function sliceTrip(src: BackupLike, tripId: string): BackupFile;
export function countsOf(src: BackupLike): {
  trips: number;
  dayItems: number;
  expenses: number;
  categories: number;
  photos: number;
};
