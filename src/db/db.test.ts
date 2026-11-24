/**
 * Dexie 升級測試：已經用過 app 的裝置，資料庫是 v2（加照片）或 v3（加刪除記號），
 * 這次要在它上面長出 v4 的 `checkItems`，而且**既有的資料與刪除記號一筆都不能不見**。
 *
 * fake-indexeddb 每支測試預設是乾淨的庫，所以這裡先用原生 IndexedDB API 手刻一個
 * 「舊版 app 留下來」的庫、塞幾筆資料進去，再交給 TripLogDB 開——
 * 走的是真裝置開機時同一條升級路徑（版本比較、stores 對照都在 Dexie 裡）。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { TripLogDB } from './db';

/** 舊版庫的形狀：v1 四張表＋照片；v3 再多一張刪除記號 */
function openLegacy(name: string, version: 2 | 3): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Dexie 會把 schema version 乘以 10 寫進 IndexedDB；舊版 fixture 也要照同一規則，
    // 不然升級器會把 3 讀成 0.3，從第一個版本重跑。
    const req = indexedDB.open(name, version * 10);
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
      if (version >= 3) {
        const tombstones = idb.createObjectStore('tombstones', { keyPath: 'id' });
        tombstones.createIndex('kind', 'kind');
        tombstones.createIndex('deletedAt', 'deletedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('舊庫被別人佔用，升不上去'));
  });
}

/** 用原生 API 塞幾筆「使用者已經記好的資料」，作為升級前的既有內容 */
function seedLegacy(idb: IDBDatabase, version: 2 | 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(version >= 3 ? ['trips', 'dayItems', 'expenses', 'tombstones'] : ['trips', 'dayItems', 'expenses'], 'readwrite');
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
    if (version >= 3) tx.objectStore('tombstones').put({
      id: 'photo_gone', kind: 'photos', deletedAt: '2026-11-01T00:00:00.000Z',
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('資料庫升級到 v4（勾選清單）', () => {
  it('舊 v2 庫開起來多出 checkItems，而且原本的列一筆都在', async () => {
    const name = `triplog-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = await openLegacy(name, 2);
    await seedLegacy(legacy, 2);
    legacy.close();

    const db = new TripLogDB(name);
    await db.open();

    expect(db.verno).toBe(4);
    expect(db.checkItems).toBeTruthy();
    expect(await db.checkItems.count()).toBe(0);
    expect(await db.tombstones.count()).toBe(0);

    // 升級不能動到使用者的資料：三張表都還要查得到
    expect(await db.trips.get('trip_old')).toHaveProperty('name', '升級前就存在的旅行');
    expect(await db.dayItems.get('item_old')).toHaveProperty('title', '老店');
    expect(await db.expenses.get('exp_old')).toHaveProperty('amount', 700);
    // 舊索引也要還在：日期區間與複合查詢是列表頁在用的
    expect(await db.dayItems.where('[tripId+date]').equals(['trip_old', '2026-10-02']).count()).toBe(1);
    expect(await db.trips.where('updatedAt').above('2026-01-01T00:00:00.000Z').count()).toBe(1);

    // 新表不只是存在而已：清單的複合排序索引要真的能查
    await db.checkItems.put({
      id: 'check_old', tripId: 'trip_old', text: '帶護照', done: false, order: 10,
      createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
    });
    expect(await db.checkItems.where('[tripId+order]').equals(['trip_old', 10]).count()).toBe(1);

    db.close();
    await db.delete();
  });

  it('v3 升到 v4 會保留刪除記號，不會讓已刪的照片復活', async () => {
    const name = `triplog-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = await openLegacy(name, 3);
    await seedLegacy(legacy, 3);
    const seededTombstone = await new Promise<unknown>((resolve, reject) => {
      const req = legacy.transaction('tombstones').objectStore('tombstones').get('photo_gone');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(seededTombstone).toMatchObject({ kind: 'photos' });
    legacy.close();

    const db = new TripLogDB(name);
    await db.open();
    expect(db.verno).toBe(4);
    expect((await db.tombstones.get('photo_gone'))?.kind).toBe('photos');
    expect(await db.checkItems.count()).toBe(0);
    expect(await db.trips.count()).toBe(1);
    expect(await db.dayItems.count()).toBe(1);
    expect(await db.expenses.count()).toBe(1);
    db.close();
    await db.delete();
  });
});
