import { db, newId, now } from './db';
import type {
  BackupFile,
  BackupPhoto,
  Category,
  ChecklistItem,
  DayItem,
  Expense,
  Photo,
  RateMap,
  TombKind,
  Trip,
} from './types';
import { currencyDef, rateKey, rememberCurrency, roundTo } from './currency';
import { t } from '../i18n';
import { blobToDataUrl, dataUrlToBlob, type Raster } from '../lib/images';
import { suppressDeleted, tombstone } from '../lib/merge-core';
import type { ISODate } from './types';

/* ------------------------------------------------------------- 刪除記號 */

/**
 * 記下「這幾列被刪了」，讓刪除變成會同步的資料，而不只是本機的一次消失。
 * 一定要在呼叫端的交易裡用：記號與列的消失要同一筆提交，
 * 否則中途關掉瀏覽器就會留下「列還在、記號也沒記」的狀態，下次同步又會把它復活。
 */
async function markDeleted(rows: { id: string; kind: TombKind }[]): Promise<void> {
  if (!rows.length) return;
  const at = now();
  await db.tombstones.bulkPut(rows.map((r) => tombstone(r.id, r.kind, at)));
}

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

/**
 * 刪掉一趟旅行，連同它底下的行程項、支出、照片與勾選清單。
 * 五張表都要記刪除記號：只有旅行記號的話，另一端推上來的並集仍會把那些列帶回來，
 * 變成「旅行不見了但它的支出又長出來」這種最難解釋的狀態。
 */
export async function deleteTrip(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.photos, db.checkItems, db.tombstones],
    async () => {
      const [itemIds, expenseIds, photoIds, checkIds] = await Promise.all([
        db.dayItems.where('tripId').equals(id).primaryKeys(),
        db.expenses.where('tripId').equals(id).primaryKeys(),
        db.photos.where('tripId').equals(id).primaryKeys(),
        db.checkItems.where('tripId').equals(id).primaryKeys(),
      ]);
      await db.dayItems.where('tripId').equals(id).delete();
      await db.expenses.where('tripId').equals(id).delete();
      await db.photos.where('tripId').equals(id).delete();
      await db.checkItems.where('tripId').equals(id).delete();
      await db.trips.delete(id);
      await markDeleted([
        { id, kind: 'trips' },
        ...itemIds.map((i) => ({ id: String(i), kind: 'dayItems' as const })),
        ...expenseIds.map((e) => ({ id: String(e), kind: 'expenses' as const })),
        ...photoIds.map((p) => ({ id: String(p), kind: 'photos' as const })),
        ...checkIds.map((c) => ({ id: String(c), kind: 'checkItems' as const })),
      ]);
    },
  );
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
  await db.transaction('rw', [db.dayItems, db.expenses, db.photos, db.tombstones], async () => {
    const photoIds = await db.photos.where('dayItemId').equals(id).primaryKeys();
    await db.expenses
      .where('dayItemId')
      .equals(id)
      .modify({ dayItemId: null, updatedAt: now() });
    await db.photos.where('dayItemId').equals(id).delete();
    await db.dayItems.delete(id);
    // 改掛出去的支出並沒有被刪，不記刪除記號；只有真的消失的（這一項與它的照片）才記
    await markDeleted([
      { id, kind: 'dayItems' },
      ...photoIds.map((p) => ({ id: String(p), kind: 'photos' as const })),
    ]);
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

/** 刪照片（相本牆與單張都走這裡）：Blob 跟著列一起清掉，記號讓它不會被別台帶回來 */
export async function removePhotos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction('rw', [db.photos, db.tombstones], async () => {
    await db.photos.bulkDelete(ids);
    await markDeleted(ids.map((id) => ({ id, kind: 'photos' as const })));
  });
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

/* ----------------------------------------------------------- checklists */

function checkText(text: string): string {
  const value = text.trim();
  if (!value) throw new Error('Checklist text is required');
  return value;
}

export async function listCheckItems(tripId: string): Promise<ChecklistItem[]> {
  const rows = await db.checkItems.where('tripId').equals(tripId).toArray();
  return rows.sort(
    (a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export async function createCheckItem(tripId: string, text: string): Promise<string> {
  const rows = await listCheckItems(tripId);
  const id = newId('check');
  const ts = now();
  await db.checkItems.add({
    id,
    tripId,
    text: checkText(text),
    done: false,
    order: rows.reduce((max, row) => Math.max(max, row.order), 0) + 10,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

export type CheckItemPatch = Partial<Pick<ChecklistItem, 'text' | 'done' | 'order'>>;

export async function updateCheckItem(id: string, patch: CheckItemPatch): Promise<void> {
  const clean: CheckItemPatch = { ...patch };
  if (patch.text !== undefined) clean.text = checkText(patch.text);
  await db.checkItems.update(id, { ...clean, updatedAt: now() });
}

export async function deleteCheckItem(id: string): Promise<void> {
  await db.transaction('rw', [db.checkItems, db.tombstones], async () => {
    await db.checkItems.delete(id);
    await markDeleted([{ id, kind: 'checkItems' }]);
  });
}

export async function moveCheckItem(id: string, direction: -1 | 1): Promise<void> {
  const item = await db.checkItems.get(id);
  if (!item) return;
  const siblings = await listCheckItems(item.tripId);
  const idx = siblings.findIndex((row) => row.id === id);
  const swapWith = siblings[idx + direction];
  if (!swapWith) return;
  const ts = now();
  await db.checkItems.bulkPut([
    { ...item, order: swapWith.order, updatedAt: ts },
    { ...swapWith, order: item.order, updatedAt: ts },
  ]);
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
  await db.transaction('rw', [db.expenses, db.tombstones], async () => {
    await db.expenses.delete(id);
    await markDeleted([{ id, kind: 'expenses' }]);
  });
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

/**
 * 匯出備份。
 * `excludePhotos` 給同步用：基準檔每次都要整個送出去，60 張照片的 base64
 * 會讓請求膨到幾 MB，所以照片改由 `/api/photos` 單獨按需下載。
 */
export async function exportBackup(opts: { excludePhotos?: boolean } = {}): Promise<BackupFile> {
  const [trips, dayItems, expenses, categories, metaRows, photoRows, checkItems, tombstones] = await Promise.all([
    db.trips.toArray(),
    db.dayItems.toArray(),
    db.expenses.toArray(),
    db.categories.toArray(),
    db.meta.toArray(),
    opts.excludePhotos ? Promise.resolve([] as Photo[]) : db.photos.toArray(),
    db.checkItems.toArray(),
    db.tombstones.toArray(),
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
    checkItems,
    // 記號要跟著每次匯出走（同步推的也是這份），否則另一端下次推並集就又長回來
    tombstones,
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

/**
 * 匯入備份檔。
 *
 * 刪除記號在這裡有兩件事要做，缺一不可：
 * 1. 照記號把「檔內已刪」的列擋在門外——否則還原一份舊檔等於把使用者刪掉的東西又請回來。
 * 2. 把記號存進本機——之後的推送要繼續帶著它們。
 * 「取代」模式額外清掉本機記號：那份檔案就是新的全部事實，留著舊記號會去壓到新資料。
 */
export async function importBackup(
  data: BackupFile,
  mode: ImportMode,
): Promise<{ trips: number; expenses: number; items: number; photos: number; checkItems: number }> {
  const counts = { trips: 0, expenses: 0, items: 0, photos: 0, checkItems: 0 };
  await db.transaction(
    'rw',
    [db.trips, db.dayItems, db.expenses, db.categories, db.meta, db.photos, db.checkItems, db.tombstones],
    async () => {
      const markers = data.tombstones ?? [];
      // 本機那些記號也要算進來（merge 模式）：它們代表這台已經刪掉、而舊檔還不知道的事
      const localMarkers = mode === 'replace' ? [] : await db.tombstones.toArray();
      // 一律用下面的區域變數，不要把結果寫回 data：那會動到呼叫端那份文件
      // （例如測試或 UI 想拿同一份匯入檔跑兩次，第二次就只剩空陣列）
      const clean = suppressDeleted(data, [{ tombstones: localMarkers }]) as BackupFile;
      let trips = clean.trips ?? [];
      let dayItems = clean.dayItems ?? [];
      let expenses = clean.expenses ?? [];
      let photos = (clean.photos ?? []).map(photoFromBackup);
      let checkItems = clean.checkItems ?? [];
      counts.trips = trips.length;
      counts.items = dayItems.length;
      counts.expenses = expenses.length;
      counts.photos = photos.length;
      counts.checkItems = checkItems.length;
      if (mode === 'replace') {
        await Promise.all([
          db.trips.clear(),
          db.dayItems.clear(),
          db.expenses.clear(),
          db.photos.clear(),
          db.checkItems.clear(),
          db.categories.clear(),
          db.tombstones.clear(),
          db.meta.where('key')
            .notEqual('app')
            .primaryKeys()
            .then((keys) => db.meta.bulkDelete(keys as string[])),
        ]);
      }
      if (markers.length) await db.tombstones.bulkPut(markers);
      if (clean.categories?.length) await db.categories.bulkPut(clean.categories);
      if (clean.meta?.length) await db.meta.bulkPut(clean.meta);
      if (mode === 'merge') {
        const known = new Set((await db.trips.toArray()).map((t) => t.id));
        trips = trips.filter((t) => !known.has(t.id));
        const knownItems = new Set((await db.dayItems.toArray()).map((i) => i.id));
        dayItems = dayItems.filter((i) => !knownItems.has(i.id));
        const knownExp = new Set((await db.expenses.toArray()).map((e) => e.id));
        expenses = expenses.filter((e) => !knownExp.has(e.id));
        const knownPhotos = new Set((await db.photos.toArray()).map((p) => p.id));
        photos = photos.filter((p) => !knownPhotos.has(p.id));
        const knownChecks = new Set((await db.checkItems.toArray()).map((c) => c.id));
        checkItems = checkItems.filter((c) => !knownChecks.has(c.id));
      }
      await db.trips.bulkPut(trips);
      await db.dayItems.bulkPut(dayItems);
      await db.expenses.bulkPut(expenses);
      if (photos.length) await db.photos.bulkPut(photos);
      if (checkItems.length) await db.checkItems.bulkPut(checkItems);
    },
  );
  return counts;
}

/**
 * 清空這台裝置的記錄。
 *
 * 刻意**不動**刪除記號：它們代表使用者明確刪過的東西，清掉就等於把那些紀錄的死刑改成緩刑，
 * 下次同步會被歷史快照帶回來。真的想全部要回來請用「匯入備份（取代）」，
 * 那個模式會連記號一起清（見 importBackup）。
 */
export async function clearAll(): Promise<void> {
  await db.transaction('rw', [db.trips, db.dayItems, db.expenses, db.photos, db.checkItems], async () => {
    await db.expenses.clear();
    await db.dayItems.clear();
    await db.photos.clear();
    await db.checkItems.clear();
    await db.trips.clear();
  });
}
