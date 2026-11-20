import Dexie, { type Table } from 'dexie';
import type {
  Category,
  DayItem,
  Expense,
  MetaEntry,
  Photo,
  Trip,
} from './types';

export class TripLogDB extends Dexie {
  trips!: Table<Trip, string>;
  dayItems!: Table<DayItem, string>;
  expenses!: Table<Expense, string>;
  categories!: Table<Category, string>;
  meta!: Table<MetaEntry, string>;
  photos!: Table<Photo, string>;

  constructor(name = 'triplog') {
    super(name);
    this.version(1).stores({
      trips: 'id, startDate, endDate, archived, updatedAt',
      dayItems: 'id, tripId, date, [tripId+date], updatedAt',
      expenses: 'id, tripId, dayItemId, date, category, [tripId+date], [tripId+category], updatedAt',
      categories: 'id, kind, order',
      meta: 'key',
    });
    // v2：行程照片。Blob 不進索引，只讓 id/tripId/dayItemId 可查。
    this.version(2).stores({
      photos: 'id, tripId, dayItemId, createdAt',
    });
  }
}

export const db = new TripLogDB();

export const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  // 支出分類
  { kind: 'expense', key: 'food', label: '餐飲', color: '#e07a3f', order: 10, builtin: true },
  { kind: 'expense', key: 'transport', label: '交通', color: '#2f7ed8', order: 20, builtin: true },
  { kind: 'expense', key: 'stay', label: '住宿', color: '#7c5cd6', order: 30, builtin: true },
  { kind: 'expense', key: 'ticket', label: '門票', color: '#0f9d8f', order: 40, builtin: true },
  { kind: 'expense', key: 'shopping', label: '購物', color: '#d64576', order: 50, builtin: true },
  { kind: 'expense', key: 'fun', label: '娛樂', color: '#c9962b', order: 60, builtin: true },
  { kind: 'expense', key: 'misc', label: '雜支', color: '#6b7280', order: 70, builtin: true },
  // 行程類型
  { kind: 'item', key: 'transport', label: '交通', color: '#2f7ed8', order: 10, builtin: true },
  { kind: 'item', label: '住宿', key: 'stay', color: '#7c5cd6', order: 20, builtin: true },
  { kind: 'item', key: 'food', label: '餐飲', color: '#e07a3f', order: 30, builtin: true },
  { kind: 'item', key: 'sight', label: '景點', color: '#0f9d8f', order: 40, builtin: true },
  { kind: 'item', key: 'activity', label: '活動', color: '#d64576', order: 50, builtin: true },
  { kind: 'item', key: 'other', label: '其他', color: '#6b7280', order: 60, builtin: true },
];

let bootPromise: Promise<void> | null = null;

/** 冪等：首次使用時補上內建分類與預設值 */
export function bootstrap(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const existing = await db.categories.count();
      if (existing === 0) {
        await db.categories.bulkAdd(
          DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${c.kind}-${i + 1}` })),
        );
      }
      await db.meta.put({
        key: 'app',
        value: { schemaVersion: 2, installedAt: new Date().toISOString() },
      });
    })().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

export function newId(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rnd}`;
}

export function now(): string {
  return new Date().toISOString();
}
