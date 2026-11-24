/**
 * Dexie 升級測試：已經用過 app 的裝置，資料庫是 v1（四張表）或 v2（加照片），
 * 這次要在它上面長出 v3 的 `tombstones`，而且**既有的資料一筆都不能不見**。
 *
 * fake-indexeddb 每支測試預設是乾淨的庫，所以這裡先用原生 IndexedDB API 手刻一個
 * 「舊版 app 留下來」的 v2 庫、塞幾筆資料進去，再交給 TripLogDB 開——
 * 走的是真裝置開機時同一條升級路徑（版本比較、stores 對照都在 Dexie 裡）。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { TripLogDB } from './db';

/** 舊 v2 庫的形狀：v1 那四張表＋索引，加上下 version(2) 的 photos */
function openLegacyV2(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => {
      const idb = req.result;
      const trips = idb.createObjectStore('trips', { keyPath: 'id' });
      for (const k of ['startDate', 'endDate', 'archived', 'updatedAt']) trips.createIndex(k, k);
      const dayItems = idb.createObjectStore('dayItems', { keyPath: 'id' });
      for (const k of ['tripId', 'date', 'updatedAt']) dayItems.createIndex(k, k);
      dayItems.createIndex('[tripId+date]', ['tripId', 'date']);
      const expenses = idb.createObjectStore('expenses', { keyPath: 'id' });
      for (const k of ['tripId', 'dayItemId', 'date', 'category', 'updatedAt']) expenses.createIndex(k, k);
      expenses.createIndex('[tripId+date]', ['tripId', 'date']);
      expenses.createIndex('[tripId+category]', ['tripId', 'category']);
      const categories = idb.createObjectStore('categories', { keyPath: 'id' });
      categories.createIndex('kind', 'kind');
      categories.createIndex('order', 'order');
      idb.createObjectStore('meta', { keyPath: 'key' });
      const photos = idb.createObjectStore('photos', { keyPath: 'id' });
      for (const k of ['tripId', 'dayItemId', 'createdAt']) photos.createIndex(k, k);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('舊庫被別人佔用，升不上去'));
  });
}

/** 用原生 API 塞幾筆「使用者已經記好的資料」，作為升級前的既有內容 */
function seedLegacy(idb: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(['trips', 'dayItems', 'expenses'], 'readwrite');
    tx.objectStore('trips').put({
      id: 'trip_old', name: '升級前就存在的旅行', startDate: '2026-10-01', endDate: '2026-10-03',
      baseCurrency: 'TWD', budget: 8000, color: '#0f766e', notes: '', archived: false,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    tx.objectStore('dayItems').put({
      id: 'item_old', tripId: 'trip_old', date: '2026-10-02', kind: 'food', title: '老店',
      lat: null, lng: null, order: 10, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    });
    tx.objectStore('expenses').put({
      id: 'exp_old', tripId: 'trip_old', dayItemId: 'item_old', date: '2026-10-02', amount: 700,
      currency: 'TWD', rateToBase: 1, baseAmount: 700, category: 'cat-food', payee: '', note: '',
      createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('資料庫升級到 v3（刪除記號）', () => {
  it('舊 v2 庫開起來多出 tombstones，而且原本的列一筆都在', async () => {
    const name = `triplog-upgrade-${Date.now()}`;
    const legacy = await openLegacyV2(name);
    await seedLegacy(legacy);
    legacy.close();

    const db = new TripLogDB(name);
    await db.open();

    // 版本要停在 3，tombstones 這張表要存在且能用
    expect(db.verno).toBe(3);
    expect(db.tombstones).toBeTruthy();
    expect(await db.tombstones.count()).toBe(0);

    // 升級不能動到使用者的資料：三張表都還要查得到
    expect(await db.trips.get('trip_old')).toHaveProperty('name', '升級前就存在的旅行');
    expect(await db.dayItems.get('item_old')).toHaveProperty('title', '老店');
    expect(await db.expenses.get('exp_old')).toHaveProperty('amount', 700);
    // 舊索引也要還在：日期區間與複合查詢是列表頁在用的
    expect(await db.dayItems.where('[tripId+date]').equals(['trip_old', '2026-10-02']).count()).toBe(1);
    expect(await db.trips.where('updatedAt').above('2026-01-01T00:00:00.000Z').count()).toBe(1);

    // 升級後的庫要能寫記號，刪除才有地方落地
    await db.tombstones.put({ id: 'exp_old', kind: 'expenses', deletedAt: '2026-11-24T00:00:00.000Z' });
    expect((await db.tombstones.get('exp_old'))?.kind).toBe('expenses');
    // kind 與 deletedAt 都要建索引，合併與過期清理靠它們過濾
    expect(await db.tombstones.where('kind').equals('expenses').count()).toBe(1);
    expect(await db.tombstones.where('deletedAt').above('2026-01-01T00:00:00.000Z').count()).toBe(1);

    db.close();
    await db.delete();
  });
});
