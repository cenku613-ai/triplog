import { db, newId, now } from './db';
import type {
  BackupFile,
  BackupPhoto,
  Category,
  DayItem,
  Expense,
  Photo,
  RateMap,
  Trip,
} from './types';
import { currencyDef, rateKey, rememberCurrency, roundTo } from './currency';
import { t } from '../i18n';
import { blobToDataUrl, dataUrlToBlob, type Raster } from '../lib/images';
import type { ISODate } from './types';

/* ------------------------------------------------------------------ trips */

export type TripInput = Omit<Trip, 'id' | 'createdAt' | 'updatedAt' | 'archived'> & {
  archived?: boolean;
};

export async function createTrip(input: TripInput): Promise<string> {
  const id = newId('trip');
  const ts = now();
  const trip: Trip = { ...input, archived: input.archived ?? false, id, createdAt: ts, updatedAt: ts };
  await db.transaction('rw', db.trips, async () => db.trips.add(trip));
  return id;
}

export async function updateTrip(id: string, patch: Partial<Trip>): Promise<void> {
  await db.transaction('rw', db.trips, async () =>
    db.trips.update(id, { ...patch, updatedAt: now() }),
  );
}

export async function deleteTrip(id: string): Promise<void> {
  await db.transaction('rw', [db.trips, db.dayItems, db.expenses, db.photos], async () => {
    await db.dayItems.where('tripId').equals(id).delete();
    await db.expenses.where('tripId').equals(id).delete();
    await db.photos.where('tripId').equals(id).delete();
    await db.trips.delete(id);
  });
}

/* -------------------------------------------------------------- day items */

export type DayItemInput = Omit<DayItem, 'id' | 'createdAt' | 'updatedAt'>;

export async function createDayItem(input: DayItemInput): Promise<string> {
  const id = newId('item');
  const ts = now();
  await db.dayItems.add({ ...input, id, createdAt: ts, updatedAt: ts });
  return id;
}

export async function updateDayItem(id: string, patch: Partial<DayItem>): Promise<void> {
  await db.dayItems.update(id, { ...patch, updatedAt: now() });
}

/** 刪行程項，但保留掛在它下面的支出（降為只屬於這趟旅行）；照片跟著刪，不留孤兒 Blob */
export async function deleteDayItem(id: string): Promise<void> {
  await db.transaction('rw', [db.dayItems, db.expenses, db.photos], async () => {
    await db.expenses
      .where('dayItemId')
      .equals(id)
      .modify({ dayItemId: null, updatedAt: now() });
    await db.photos.where('dayItemId').equals(id).delete();
    await db.dayItems.delete(id);
  });
}

export async function moveDayItem(id: string, direction: -1 | 1): Promise<void> {
  const item = await db.dayItems.get(id);
  if (!item) return;
  const siblings = await db.dayItems
    .where('[tripId+date]')
    .equals([item.tripId, item.date])
    .sortBy('order');
  const idx = siblings.findIndex((s) => s.id === id);
  const swapWith = siblings[idx + direction];
  if (!swapWith) return;
  const order = item.order;
  await db.dayItems.bulkPut([
    { ...item, order: swapWith.order, updatedAt: now() },
    { ...swapWith, order, updatedAt: now() },
  ]);
}

export async function nextOrder(tripId: string, date: ISODate): Promise<number> {
  const rows = await db.dayItems.where('[tripId+date]').equals([tripId, date]).toArray();
  return rows.reduce((max, r) => Math.max(max, r.order), 0) + 10;
}

/* ------------------------------------------------------------------ photos */

export type PhotoInput = {
  tripId: string;
  dayItemId?: string | null;
  /** images.ts 壓縮過的結果：原圖 + 縮圖 */
  raster: Raster;
  source: Photo['source'];
  creditUrl?: string;
  artist?: string;
  license?: string;
  caption?: string;
};

/** 存一張（或一批）照片，回傳新的 id */
export async function addPhotos(inputs: PhotoInput[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const startedAt = Date.now();
  const rows: Photo[] = inputs.map((input, i) => ({
    id: newId('photo'),
    tripId: input.tripId,
    dayItemId: input.dayItemId ?? null,
    blob: input.raster.blob,
    thumb: input.raster.thumb,
    width: input.raster.width,
    height: input.raster.height,
    mime: input.raster.mime,
    source: input.source,
    creditUrl: input.creditUrl,
    artist: input.artist,
    license: input.license,
    caption: input.caption,
    // 連拍時錯開 1 ms，相本牆的順序才跟選檔順序一致
    createdAt: new Date(startedAt + i).toISOString(),
  }));
  await db.transaction('rw', db.photos, async () => {
    await db.photos.bulkAdd(rows);
  });
  return rows.map((r) => r.id);
}

export async function removePhotos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.photos.bulkDelete(ids);
}

export async function listPhotosOfDayItem(dayItemId: string): Promise<Photo[]> {
  const rows = await db.photos.where('dayItemId').equals(dayItemId).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listPhotosOfTrip(tripId: string): Promise<Photo[]> {
  const rows = await db.photos.where('tripId').equals(tripId).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 行程項 -> 照片，列表頁一次抓好，免得每項開一次查詢 */
export async function photosByItem(tripId: string): Promise<Map<string, Photo[]>> {
  const rows = await db.photos.where('tripId').equals(tripId).toArray();
  const map = new Map<string, Photo[]>();
  for (const p of rows) {
    if (!p.dayItemId) continue;
    const arr = map.get(p.dayItemId) ?? [];
    arr.push(p);
    map.set(p.dayItemId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return map;
}

/* --------------------------------------------------------------- expenses */

export type ExpenseDraft = {
  tripId: string;
  dayItemId?: string | null;
  date: ISODate;
  amount: number;
  currency: string;
  /** 1 currency = ? baseCurrency */
  rateToBase: number;
  category: string;
  payee?: string;
  note?: string;
};

export function buildExpense(draft: ExpenseDraft): Expense {
  const ts = now();
  const decimals = currencyDef(draft.currency).decimals;
  const amount = roundTo(draft.amount, decimals);
  return {
    id: newId('exp'),
    tripId: draft.tripId,
    dayItemId: draft.dayItemId ?? null,
    date: draft.date,
    amount,
    currency: draft.currency,
    rateToBase: draft.rateToBase,
    // 以「顯示用的原幣金額」換算，確保原幣 × 匯率 = 主幣金額不會對不上
    baseAmount: roundTo(amount * draft.rateToBase, 2),
    category: draft.category,
    payee: draft.payee ?? '',
    note: draft.note ?? '',
    createdAt: ts,
    updatedAt: ts,
  };
}

export async function createExpense(draft: ExpenseDraft): Promise<string> {
  const row = buildExpense(draft);
  await db.expenses.add(row);
  await touchTrip(row.tripId);
  return row.id;
}

export async function updateExpense(id: string, draft: ExpenseDraft): Promise<void> {
  const existing = await db.expenses.get(id);
  if (!existing) return;
  const row = { ...buildExpense(draft), id, createdAt: existing.createdAt };
  await db.expenses.put(row);
  await touchTrip(row.tripId);
}

export async function deleteExpense(id: string): Promise<void> {
  const row = await db.expenses.get(id);
  await db.expenses.delete(id);
  if (row) await touchTrip(row.tripId);
}

export async function touchTrip(tripId: string): Promise<void> {
  await db.trips.update(tripId, { updatedAt: now() });
}

/* ------------------------------------------------------------------ rates */

const RATES_KEY = 'rates';

export async function getRates(): Promise<RateMap> {
  const row = await db.meta.get(RATES_KEY);
  return (row?.value as RateMap) ?? {};
}

export async function setRate(from: string, to: string, value: number): Promise<void> {
  const rates = await getRates();
  rates[rateKey(from, to)] = value;
  await db.meta.put({ key: RATES_KEY, value: rates });
}

/** 記一筆時記住用過的匯率，下次同幣別自動帶入 */
export async function rememberRate(
  from: string,
  to: string,
  value: number,
): Promise<void> {
  rememberCurrency(from);
  if (from === to) return;
  await setRate(from, to, value);
}

export async function lookupRate(from: string, to: string): Promise<number | undefined> {
  if (from === to) return 1;
  const rates = await getRates();
  return rates[rateKey(from, to)];
}

/* ------------------------------------------------------------- categories */

export async function listCategories(kind: Category['kind']): Promise<Category[]> {
  const rows = await db.categories.where('kind').equals(kind).toArray();
  return rows.sort((a, b) => a.order - b.order);
}

export async function addCategory(
  kind: Category['kind'],
  label: string,
  color: string,
): Promise<string> {
  const rows = await listCategories(kind);
  const id = newId('cat');
  await db.categories.add({
    id,
    kind,
    key: id,
    label,
    color,
    order: (rows[rows.length - 1]?.order ?? 0) + 10,
    builtin: false,
  });
  return id;
}

export async function renameCategory(id: string, patch: Partial<Category>): Promise<void> {
  await db.categories.update(id, patch);
}

export async function removeCategory(id: string): Promise<void> {
  const cat = await db.categories.get(id);
  if (!cat) return;
  const fallback = (await listCategories(cat.kind)).find((c) => c.id !== id);
  await db.transaction('rw', [db.categories, db.expenses], async () => {
    if (cat.kind === 'expense' && fallback) {
      await db.expenses.where('category').equals(cat.id).modify({ category: fallback.id });
    }
    await db.categories.delete(id);
  });
}

/* ------------------------------------------------------------------- meta */

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return (row?.value as T) ?? fallback;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await db.meta.put({ key, value });
}

/* ------------------------------------------------------- backup / restore */

export async function exportBackup(): Promise<BackupFile> {
  const [trips, dayItems, expenses, categories, metaRows, photoRows] = await Promise.all([
    db.trips.toArray(),
    db.dayItems.toArray(),
    db.expenses.toArray(),
    db.categories.toArray(),
    db.meta.toArray(),
    db.photos.toArray(),
  ]);
  // Blob 進不了 JSON，逐張轉 base64。照片多時會慢幾秒，但只在按匯出時跑一次。
  const photos: BackupPhoto[] = [];
  for (const p of photoRows) {
    const { blob, thumb, ...rest } = p;
    photos.push({
      ...rest,
      data: await blobToDataUrl(blob),
      thumbData: await blobToDataUrl(thumb),
    });
  }
  return {
    format: 'triplog-backup',
    version: photos.length ? 2 : 1,
    exportedAt: now(),
    trips,
    dayItems,
    expenses,
    categories,
    photos,
    meta: metaRows.filter((m) => m.key !== 'app'),
  };
}

/** 備份檔里的照片 → 本機 Photo（把 base64 還原成 Blob） */
function photoFromBackup(p: BackupPhoto): Photo {
  const { data, thumbData, ...rest } = p;
  return { ...rest, blob: dataUrlToBlob(data ?? ''), thumb: dataUrlToBlob(thumbData ?? '') };
}
export function parseBackup(text: string): BackupFile {
  const data = JSON.parse(text) as BackupFile;
  if (data?.format !== 'triplog-backup' || !Array.isArray(data.trips)) {
    throw new Error(t('backup.notTriplog'));
  }
  return data;
}

export type ImportMode = 'merge' | 'replace';

export async function importBackup(
  data: BackupFile,
  mode: ImportMode,
): Promise<{ trips: number; expenses: number; items: number; photos: number }> {
  const counts = {
    trips: data.trips.length,
    expenses: data.expenses?.length ?? 0,
    items: data.dayItems?.length ?? 0,
    photos: data.photos?.length ?? 0,
  };
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.meta, db.photos],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.trips.clear(),
          db.dayItems.clear(),
          db.expenses.clear(),
          db.photos.clear(),
          db.categories.clear(),
          db.meta.where('key')
            .notEqual('app')
            .primaryKeys()
            .then((keys) => db.meta.bulkDelete(keys as string[])),
        ]);
      }
      if (data.categories?.length) await db.categories.bulkPut(data.categories);
      if (data.meta?.length) await db.meta.bulkPut(data.meta);
      let photos = (data.photos ?? []).map(photoFromBackup);
      if (mode === 'merge') {
        const known = new Set((await db.trips.toArray()).map((t) => t.id));
        data.trips = data.trips.filter((t) => !known.has(t.id));
        const knownItems = new Set((await db.dayItems.toArray()).map((i) => i.id));
        data.dayItems = (data.dayItems ?? []).filter((i) => !knownItems.has(i.id));
        const knownExp = new Set((await db.expenses.toArray()).map((e) => e.id));
        data.expenses = (data.expenses ?? []).filter((e) => !knownExp.has(e.id));
        const knownPhotos = new Set((await db.photos.toArray()).map((p) => p.id));
        photos = photos.filter((p) => !knownPhotos.has(p.id));
      }
      await db.trips.bulkPut(data.trips);
      await db.dayItems.bulkPut(data.dayItems ?? []);
      await db.expenses.bulkPut(data.expenses ?? []);
      if (photos.length) await db.photos.bulkPut(photos);
    },
  );
  return counts;
}

export async function clearAll(): Promise<void> {
  await db.transaction('rw', [db.trips, db.dayItems, db.expenses, db.photos], async () => {
    await db.expenses.clear();
    await db.dayItems.clear();
    await db.photos.clear();
    await db.trips.clear();
  });
}
