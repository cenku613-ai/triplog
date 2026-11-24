/**
 * 兩份 TripLog 備份物件的合併規則（純函式，瀏覽器與後端共用同一份）。
 *
 * 策略：以 id 取並集，同一筆兩邊都有時「更新時間較新者勝」，
 * 然後照刪除記號（tombstone）把已刪的那幾筆從結果裡拿掉。
 *
 * 為什麼要有刪除記號：「資料不在這次上傳裡」不等於「它被刪了」——離線裝置推上來的是
 * 它手上那份並集，少了某個 id 通常只是那台還沒拿到。所以刪除要當成一個**事件**傳下去：
 * 刪的時候在本地留一筆 `{id, kind, deletedAt}`，跟著每次同步走，合併完再照它把列濾掉。
 * 這樣伺服器仍不需要任何 DELETE 端點（刪不刪由客戶端決定，而且只在它自己的帳本裡發生）。
 *
 * 已知取捨（寫下來，避免以後驚訝）：
 * - 刪除採「刪除獲勝」（remove-wins）：一筆紀錄被刪掉之後，另一端在**更舊的時間點**上做的
 *   編輯不會讓它復活。要留同一段內容請重新建立（新的 id，不會撞回來）。
 * - 記號保留 `TOMBSTONE_DAYS` 天，之後不再壓制：超過一年沒同步的裝置仍可能把舊紀錄帶回來。
 * - 分類（categories）不參與：內建分類每台裝置各自 bootstrap，讓它被遠端刪除會生出
 *   「顏色不見了」這種更難解釋的現象。
 *
 * 本檔是 .js + .d.ts，不是 .ts：後端（server/）要直接 import 同一份邏輯，
 * 不想為了共用而幫後端也拉一套編譯流程。
 */

/** @typedef {'trips' | 'dayItems' | 'expenses' | 'categories' | 'photos' | 'checkItems'} MergeTable */

/** 會記刪除記號的表（categories/meta 刻意排除，理由見檔案頂端） */
/** @typedef {'trips' | 'dayItems' | 'expenses' | 'photos' | 'checkItems'} TombKind */

/** @typedef {{ id: string, kind: TombKind, deletedAt: string }} Tombstone */

/** @typedef {{ format?: string, version?: 1 | 2, exportedAt?: string, trips?: any[], dayItems?: any[], expenses?: any[], categories?: any[], photos?: any[], checkItems?: any[], meta?: any[], tombstones?: any[] }} BackupLike */

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
const TABLES = ['trips', 'dayItems', 'expenses', 'categories', 'photos', 'checkItems'];

/* -------------------------------------------------------------- 刪除記號 */

/** 記號保留多久：太舊的就放它過去，否則一台永不開動的裝置會永遠壓著別人刪掉的東西 */
export const TOMBSTONE_DAYS = 365;

/** id 前綴 → 表名。舊客戶端只送 id 沒送 kind 時靠這個補（newId 的前綴是穩定的） */
const KIND_BY_PREFIX = [
  ['trip_', 'trips'],
  ['item_', 'dayItems'],
  ['exp_', 'expenses'],
  ['photo_', 'photos'],
  ['check_', 'checkItems'],
];

/**
 * id 前綴 → 表名。舊客戶端只送 id 沒送 kind 時靠這個補（newId 的前綴是穩定的）。
 * 匯出給後端共用：兩端對同一個 id 一定要講出同一個 kind，
 * 否則客戶端簽好的記號會在伺服器那邊被当成亂碼丟掉。
 * @param {string} id @returns {TombKind | null}
 */
export function kindFromId(id) {
  for (const [prefix, kind] of KIND_BY_PREFIX) if (String(id ?? '').startsWith(prefix)) return kind;
  return null;
}

/**
 * 把各來源的 `tombstones` 收成一張 id → 記號的表。
 * 髒資料（缺 id、時間戳讀不懂）一律丟掉：寧可讓一筆已刪的紀錄多活一次，
 * 也不能讓它把整場合併弄壞。
 *
 * @param {BackupLike[]} sources
 * @param {{ now?: number, days?: number }} opts
 * @returns {{ byId: Map<string, Tombstone>, kinds: Map<string, TombKind>, list: Tombstone[] }}
 */
export function collectTombstones(sources, opts = {}) {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? TOMBSTONE_DAYS;
  const cutoff = now - days * 86_400_000;
  /** @type {Map<string, Tombstone>} */
  const byId = new Map();
  for (const src of sources) {
    for (const raw of src?.tombstones ?? []) {
      const id = typeof raw?.id === 'string' ? raw.id : '';
      if (!id) continue;
      const deletedAt =
        typeof raw?.deletedAt === 'string' && !Number.isNaN(Date.parse(raw.deletedAt))
          ? raw.deletedAt
          : '';
      if (!deletedAt) continue;
      const kind =
        raw?.kind === 'trips' || raw?.kind === 'dayItems' || raw?.kind === 'expenses' || raw?.kind === 'photos' || raw?.kind === 'checkItems'
          ? /** @type {TombKind} */ (raw.kind)
          : kindFromId(id);
      if (!kind) continue;
      const prev = byId.get(id);
      if (prev && prev.deletedAt >= deletedAt) continue;
      byId.set(id, { id, kind, deletedAt });
    }
  }
  // 過期清單只按「刪掉的時間」算，跟紀錄本身的 updatedAt 無關，這樣才講得出來也驗得了
  const list = [...byId.values()].filter((t) => Date.parse(t.deletedAt) >= cutoff);
  /** @type {Map<string, TombKind>} */
  const kinds = new Map(list.map((t) => [t.id, t.kind]));
  return { byId: new Map(list.map((t) => [t.id, t])), kinds, list };
}

/**
 * 照刪除記號過濾一份文件（**不改動傳進去的那份**，回傳新的陣列）。
 * 除了記號本身指向的那一列，還會往下連動：旅行沒了，它底下的行程項／支出／照片／勾選清單也不會有人看到，
 * 留在文件裡只是孤兒資料（統計與 `/api/trips/<id>` 仍會讀到它們）。
 *
 * @param {BackupLike} src
 * @param {Map<string, TombKind>} kinds
 */
function dropDeleted(src, kinds) {
  if (!kinds.size) return src;
  const trips = (src.trips ?? []).filter((r) => r && !kinds.has(r.id));
  const keep = (rows, table) =>
    (rows ?? []).filter(
      (r) =>
        r &&
        !kinds.has(r.id) &&
        !(r.tripId && kinds.get(r.tripId) === 'trips') &&
        !(table === 'photos' && r.dayItemId && kinds.get(r.dayItemId) === 'dayItems'),
    );
  return {
    ...src,
    trips,
    dayItems: keep(src.dayItems, 'dayItems'),
    expenses: keep(src.expenses, 'expenses'),
    photos: keep(src.photos, 'photos'),
    checkItems: keep(src.checkItems, 'checkItems'),
  };
}

/**
 * 用刪除記號清一份文件，不需要先合併也能用（匯入備份、單趟匯出都走這裡）。
 * `extra` 是給「本機還有一些記號是這份文件沒帶」的場合：把兩邊湊起來看，
 * 才不會因為檔案裡少寫了一筆，就把使用者刪掉的東西又匯進回來。
 *
 * @param {BackupLike} src
 * @param {BackupLike[]} extra
 * @returns {BackupLike}
 */
export function suppressDeleted(src, extra = []) {
  const { kinds } = collectTombstones([src, ...extra]);
  return dropDeleted(src, kinds);
}

/**
 * 建立一筆刪除記號（給客戶端刪資料時用）。
 * `kind` 省略時由 id 前綴推——`newId()` 的前綴是穩定的，但呼叫端能確定就傳進來，
 * 這樣將來若有人改了前綴，也不會靜靜記錯表。
 *
 * @param {string} id
 * @param {TombKind} [kind]
 * @param {string} [deletedAt]
 * @returns {Tombstone}
 */
export function tombstone(id, kind, deletedAt = new Date().toISOString()) {
  const k = kind ?? kindFromId(String(id ?? ''));
  if (!k) throw new Error(`tombstone：不認得的 id「${id}」`);
  return { id: String(id), kind: k, deletedAt };
}

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
  // 各表取完並集之後，才照刪除記號把已刪的拿掉（順序很重要：記號要能蓋到所有來源）
  const { kinds, list } = collectTombstones(sources);
  const alive = dropDeleted(
    {
      trips: [...acc.trips.values()],
      dayItems: [...acc.dayItems.values()],
      expenses: [...acc.expenses.values()],
      photos: [...acc.photos.values()],
      checkItems: [...acc.checkItems.values()],
    },
    kinds,
  );
  const photos = alive.photos;
  return {
    format: 'triplog-backup',
    version: photos.length ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: alive.trips,
    dayItems: alive.dayItems,
    expenses: alive.expenses,
    categories: [...acc.categories.values()],
    photos,
    checkItems: alive.checkItems,
    tombstones: list,
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
  // 先照記號清一遍：這趟被刪過時，連同它底下的列都不該出現在單趟匯出裡
  const clean = suppressDeleted(src);
  const dayItems = (clean.dayItems ?? []).filter((r) => r.tripId === tripId);
  const itemIds = new Set(dayItems.map((r) => r.id));
  const expenses = (clean.expenses ?? []).filter((e) => e.tripId === tripId);
  const checkItems = (clean.checkItems ?? []).filter((c) => c.tripId === tripId);
  const photos = (clean.photos ?? []).filter(
    (p) => p.tripId === tripId || (p.dayItemId && itemIds.has(p.dayItemId)),
  );
  const usedCats = new Set(expenses.map((e) => e.category));
  // 記號清單要從「還沒清掉的那份」取 id：被記號壓掉的列（例如剛刪的 i2）正是收端最需要
  // 認識的那幾個 id，若只從清乾淨的結果推，等於把刪除訊息在單趟匯出裡丟掉。
  const sliceIds = new Set([
    tripId,
    ...(src.dayItems ?? []).filter((r) => r && r.tripId === tripId).map((r) => r.id),
    ...(src.expenses ?? []).filter((r) => r && r.tripId === tripId).map((r) => r.id),
    ...(src.checkItems ?? []).filter((r) => r && r.tripId === tripId).map((r) => r.id),
    ...(src.photos ?? []).filter((r) => r && (r.tripId === tripId || (r.dayItemId && (src.dayItems ?? []).some((i) => i.id === r.dayItemId && i.tripId === tripId)))).map((r) => r.id),
  ]);
  const tombstones = (clean.tombstones ?? []).filter((t) => t && sliceIds.has(t.id));
  return {
    format: 'triplog-backup',
    version: photos.length ? 2 : 1,
    exportedAt: new Date().toISOString(),
    trips: (clean.trips ?? []).filter((t) => t.id === tripId),
    dayItems,
    expenses,
    categories: (clean.categories ?? []).filter((c) => usedCats.has(c.id) || usedCats.has(c.key)),
    photos,
    checkItems,
    tombstones,
    meta: (clean.meta ?? []).filter((m) => m.key === 'rates'),
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
    checkItems: (src.checkItems ?? []).length,
  };
}
