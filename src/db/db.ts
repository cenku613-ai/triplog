import Dexie, { type Table } from 'dexie';
import type {
  Category,
  DayItem,
  Expense,
  MetaEntry,
  Photo,
  Tombstone,
  Trip,
} from './types';

/** 帳號制度之前的本機庫名稱，也是「沒登入」時用的那一份 */
export const LEGACY_DB_NAME = 'triplog';

export class TripLogDB extends Dexie {
  trips!: Table<Trip, string>;
  dayItems!: Table<DayItem, string>;
  expenses!: Table<Expense, string>;
  categories!: Table<Category, string>;
  meta!: Table<MetaEntry, string>;
  photos!: Table<Photo, string>;
  /** 刪除記號：id 是「被刪掉的那一列」的 id，跨表唯一（前綴 trip_/item_/exp_/photo_ 已分開） */
  tombstones!: Table<Tombstone, string>;
  /** 自己記一份名字：切換帳號時要知道現在開的是誰的庫，不去依賴 Dexie 內部的 name 欄位 */
  readonly dbName: string;

  constructor(name = LEGACY_DB_NAME) {
    super(name);
    this.dbName = name;
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
    // v3：刪除記號。只記「刪了哪一列、何時刪」，內容一個 byte 都不留，
    // 免得備份檔外洩時連同使用者已經刪掉的紀錄一起被讀出來。
    this.version(3).stores({
      tombstones: 'id, kind, deletedAt',
    });
  }
}

/**
 * 帳號 id → 本機庫名稱。
 *
 * 為什麼要分庫：同一台手機可能輪流給兩個人記帳，共用一份 IndexedDB 等於互相看得到
 * 對方的旅行。伺服器那端已經按人分帳（snapshots.user_id），本機也要一分為二，否則
 * 「只拉自己那份」這件事在離開網路後就破了。
 *
 * id 是伺服器給的 `u_<hex>`，這裡仍收一次字元：髒字串不該變成奇怪庫名，
 * IndexedDB 的名稱一旦寫錯，之後每次開都要靠同一個演算法還原。
 */
export function dbNameFor(userId?: string | null): string {
  const id = String(userId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return id ? `${LEGACY_DB_NAME}-${id}` : LEGACY_DB_NAME;
}

/**
 * 現在生效的那個庫。用 `export let` 是故意的：ESM 的即時繫結讓所有 `import { db }`
 * 的人在切換帳號後自動拿到新實例，不必把每一處呼叫點都改成取得函式。
 * 切帳號之後頁面會重新載入一次（見 src/lib/account.ts 的 reload），所以不會出現
 * 「半個畫面讀舊庫、半個讀新庫」。
 */
export let db: TripLogDB = new TripLogDB(LEGACY_DB_NAME);

const instances = new Map<string, TripLogDB>([[LEGACY_DB_NAME, db]]);
const bootstrapped = new Map<string, Promise<void>>();

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

/** 冪等：這個庫第一次使用時補上內建分類與預設值（每個帳號各有一份，所以快取以庫名為鍵） */
export function bootstrap(): Promise<void> {
  const name = db.dbName;
  let p = bootstrapped.get(name);
  if (!p) {
    p = (async () => {
      const existing = await db.categories.count();
      if (existing === 0) {
        await db.categories.bulkAdd(
          DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${c.kind}-${i + 1}` })),
        );
      }
      await db.meta.put({
        key: 'app',
        value: { schemaVersion: 3, installedAt: new Date().toISOString() },
      });
    })().catch((err) => {
      bootstrapped.delete(name);
      throw err;
    });
    bootstrapped.set(name, p);
  }
  return p;
}

/** 只在測試與切帳號重載之間用得到：把某個庫的「已初始化」紀錄清掉 */
export function forgetBootstrap(name?: string): void {
  if (name) bootstrapped.delete(name);
  else bootstrapped.clear();
}

function allTables(d: TripLogDB) {
  return [d.trips, d.dayItems, d.expenses, d.categories, d.meta, d.photos, d.tombstones];
}

/** 舊庫被誰接走的標記：同一份「制度前的資料」只認領一次 */
export const CLAIMED_KEY = 'claimedBy';

/**
 * 第一次在這台裝置登入時，把帳號制度之前的本機資料搬進帳號庫。
 *
 * 搬而不是搬完就刪：舊庫 `triplog` 留在原處，登出後還會看到它。這是刻意留的退路——
 * 使用者本來就有權利決定要不要登出，把舊庫一起抹掉等於把退路收走。
 *
 * 兩個條件要一起成立才搬：目標庫是空的（這台裝置之前沒替這個帳號開過帳），
 * 而且舊庫還沒被人認領過（`claimedBy`）。第二個條件是為了共用裝置：
 * 舊資料只屬於先認領它的那個人，第二個帳號登進來不該拿到前一個人的旅行。
 * @returns 搬了幾列實際記錄（分類與 meta 不計）
 */
async function copyLegacyInto(target: TripLogDB, legacy: TripLogDB, userId: string): Promise<number> {
  if (target === legacy) return 0;
  if ((await target.trips.count()) + (await target.expenses.count()) > 0) return 0;
  if (await legacy.meta.get(CLAIMED_KEY)) return 0;
  const [trips, dayItems, expenses, categories, photos, meta, tombstones] = await Promise.all([
    legacy.trips.toArray(),
    legacy.dayItems.toArray(),
    legacy.expenses.toArray(),
    legacy.categories.toArray(),
    legacy.photos.toArray(),
    legacy.meta.toArray(),
    legacy.tombstones.toArray(),
  ]);
  const moved = trips.length + dayItems.length + expenses.length + photos.length;
  if (!moved) return 0;
  await target.transaction('rw', allTables(target), async () => {
    if (categories.length) await target.categories.bulkPut(categories);
    const rows = meta.filter((m) => m.key !== 'app');
    if (rows.length) await target.meta.bulkPut(rows);
    if (trips.length) await target.trips.bulkPut(trips);
    if (dayItems.length) await target.dayItems.bulkPut(dayItems);
    if (expenses.length) await target.expenses.bulkPut(expenses);
    if (photos.length) await target.photos.bulkPut(photos);
    // 刪除記號也要搬過去：它們指的列本來就不在搬移清單裡，留下的用意只有一個——
    // 新帳號第一次推送時別把使用者在舊庫刪掉的東西又帶回伺服器。
    if (tombstones.length) await target.tombstones.bulkPut(tombstones);
    // 認領標記也要寫進目標庫，但絕對不能寫在別人的交易裡：Dexie 的交易只認自己那個實例，
    // 跨實例寫入會讓它「太早提交」（PrematureCommitError），資料狀態就會開始不一致。
    await target.meta.put({ key: CLAIMED_KEY, value: userId });
  });
  await legacy.meta.put({ key: CLAIMED_KEY, value: userId });
  return moved;
}

/**
 * 把本機庫切到某個帳號名下（傳 null／空字串＝回到「沒登入」那份）。
 *
 * 回傳搬移量讓呼叫端能講一句「已把舊資料接過來」，這件事一定要讓使用者知道：
 * 不然他會以為自己的行程在那一刻憑空消失了。
 */
export async function openAccountDb(userId?: string | null): Promise<{ name: string; moved: number }> {
  const name = dbNameFor(userId);
  const legacy = instances.get(LEGACY_DB_NAME) ?? db;
  let target = instances.get(name);
  if (!target) {
    target = new TripLogDB(name);
    instances.set(name, target);
    await target.open();
  }
  db = target;
  const moved = userId ? await copyLegacyInto(target, legacy, userId) : 0;
  await bootstrap();
  return { name, moved };
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
