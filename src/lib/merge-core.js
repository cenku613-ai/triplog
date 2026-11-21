/**
 * 兩份 TripLog 備份物件的合併規則（純函式，瀏覽器與後端共用同一份）。
 *
 * 策略：以 id 取並集，同一筆兩邊都有時「更新時間較新者勝」。
 * 沒有任何刪除語意——這是併發式同步的已知取捨：一端刪掉的紀錄，
 * 另一端下次同步會把它帶回來。要真的刪，得另外記 tombstone（尚未做）。
 *
 * 本檔是 .js + .d.ts，不是 .ts：後端（server/）要直接 import 同一份邏輯，
 * 不想為了共用而幫後端也拉一套編譯流程。
 */

/** @typedef {'trips' | 'dayItems' | 'expenses' | 'categories' | 'photos'} MergeTable */

/** @typedef {{ format?: string, version?: 1 | 2, exportedAt?: string, trips?: any[], dayItems?: any[], expenses?: any[], categories?: any[], photos?: any[], meta?: any[] }} BackupLike */

/** 有 updatedAt 的表用 updatedAt，照片只有 createdAt；兩者都缺就當作最舊 */
/** @param {any} row @returns {string} */
function stampOf(row) {
  const v = row && (row.updatedAt || row.createdAt);
  return typeof v === 'string' ? v : '';
}

/** 同 id 兩邊都有時決定留哪一筆：時間較新者勝，平手時留已在庫裡的，避免重複同步把本機編輯蓋掉 */
function better(existing, incoming) {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  return stampOf(incoming) > stampOf(existing) ? incoming : existing;
}

/**
 * 分類沒有時間欄位（內建分類是不會變的常數），一律以「既有」為準，
 * 否則另一端 bootstrap() 剛長出來的預設分類會蓋掉使用者改過的顏色。
 */
function keepExisting(existing, incoming) {
  return existing === undefined ? incoming : existing;
}

/** @param {any} v */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * meta 的 value 常是物件（例如 rates：`TWD>JPY` → 匯率），
 * 整欄互相覆蓋會讓兩端各自記過的匯率消失，所以物件採淺合併。
 * @param {any[][]} rows
 */
function mergeMeta(rows) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const list of rows) {
    for (const entry of list ?? []) {
      if (!entry || typeof entry.key !== 'string') continue;
      const prev = out.get(entry.key);
      // out 存的是 value 本體（不是整列），所以這裡直接比 prev 自己
      if (prev !== undefined && isPlainObject(prev) && isPlainObject(entry.value)) {
        out.set(entry.key, { ...prev, ...entry.value });
      } else {
        out.set(entry.key, entry.value);
      }
    }
  }
  return [...out.entries()].map(([key, value]) => ({ key, value }));
}

/** @type {MergeTable[]} */
const TABLES = ['trips', 'dayItems', 'expenses', 'categories', 'photos'];

/**
 * 依序把 `sources` 併進一份新的備份物件（來源本身不會被修改）。
 * @param {BackupLike[]} sources
 * @returns {BackupLike}
 */
export function mergeSources(sources) {
  /** @type {Record<string, Map<string, any>>} */
  const acc = {};
  for (const name of TABLES) acc[name] = new Map();
  for (const src of sources) {
    for (const name of TABLES) {
      const pick = name === 'categories' ? keepExisting : better;
      const map = acc[name];
      for (const row of src[name] ?? []) {
        if (!row || typeof row.id !== 'string') continue;
        map.set(row.id, pick(map.get(row.id), row));
      }
    }
  }
  const photos = [...acc.photos.values()];
  return {
    format: 'triplog-backup',
    version: photos.length ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: [...acc.trips.values()],
    dayItems: [...acc.dayItems.values()],
    expenses: [...acc.expenses.values()],
    categories: [...acc.categories.values()],
    photos,
    meta: mergeMeta(sources.map((s) => s.meta ?? [])),
  };
}

/**
 * 兩份合併（第一份通常是本機／較舊的那端）。
 * @param {BackupLike} a
 * @param {BackupLike} b
 * @returns {BackupLike}
 */
export function mergeBackupObjects(a, b) {
  return mergeSources([a, b]);
}

/**
 * 抓出單一旅行的全部相關資料，供「只同步這趟」與 agent 讀取單一趟使用。
 * @param {BackupLike} src
 * @param {string} tripId
 * @returns {BackupLike}
 */
export function sliceTrip(src, tripId) {
  const dayItems = (src.dayItems ?? []).filter((r) => r.tripId === tripId);
  const itemIds = new Set(dayItems.map((r) => r.id));
  const expenses = (src.expenses ?? []).filter((e) => e.tripId === tripId);
  const photos = (src.photos ?? []).filter(
    (p) => p.tripId === tripId || (p.dayItemId && itemIds.has(p.dayItemId)),
  );
  const usedCats = new Set(expenses.map((e) => e.category));
  return {
    format: 'triplog-backup',
    version: photos.length ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: (src.trips ?? []).filter((t) => t.id === tripId),
    dayItems,
    expenses,
    categories: (src.categories ?? []).filter((c) => usedCats.has(c.id) || usedCats.has(c.key)),
    photos,
    meta: (src.meta ?? []).filter((m) => m.key === 'rates'),
  };
}

/**
 * 各表筆數，給同步結果與除錯訊息用。
 * @param {BackupLike} src
 */
export function countsOf(src) {
  return {
    trips: (src.trips ?? []).length,
    dayItems: (src.dayItems ?? []).length,
    expenses: (src.expenses ?? []).length,
    categories: (src.categories ?? []).length,
    photos: (src.photos ?? []).length,
  };
}
