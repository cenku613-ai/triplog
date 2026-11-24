/**
 * 同步那條路的刪除記號測試。
 *
 * 合併規則本身在 merge-core.test.ts 驗過了，repo.test.ts 驗的是「本機刪除時有沒有留下記號」。
 * 這一檔要驗的是中間那段：伺服器的記號怎麼落到本機（把列真的清掉），
 * 以及本機的記號怎麼跟著推送回到伺服器——少了這一段，刪除就只在這台裝置上生效。
 *
 * 後端用一支假 fetch 代替：只認 /api/base、/api/backup、/api/photos/get 三條路，
 * 內容直接由測試擺進去（不經過去跑 server/，那是 smoke.mjs 的工作）。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATEGORIES, db } from '../db/db';
import { addPhotos, createCheckItem, createDayItem, createExpense, createTrip, deleteTrip, exportBackup } from '../db/repo';
import { pullFromServer, syncNow, type SyncConfig } from './sync';

const cfg: SyncConfig = { baseUrl: 'http://127.0.0.1:9999', apiKey: 'tlk_test', auto: false };

/** 假後端的狀態：base 是基準檔（null 代表還沒資料，要回 404），pushes 收每一次推上來的文件 */
const server: { base: Record<string, unknown> | null; pushes: Record<string, any>[] } = {
  base: null,
  pushes: [],
};

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
const gone = () => ({ ok: false, status: 404, json: async () => ({ error: 'empty' }) }) as unknown as Response;

function route(url: string, init?: RequestInit): Response {
  const path = new URL(url).pathname;
  if (path === '/api/base') {
    return server.base ? ok({ base: server.base, bytes: 4096 }) : gone();
  }
  if (path === '/api/photos/get') {
    // 基準檔不帶 base64，這裡也一律回空：照片下載另有用例驗
    return ok({ photos: [] });
  }
  if (path === '/api/backup') {
    server.pushes.push(JSON.parse(String(init?.body)) as Record<string, any>);
    return ok({ savedAt: new Date().toISOString(), bytes: 4096 });
  }
  throw new Error(`假後端不認得 ${path}`);
}

const tripSeed = {
  name: '刪除會同步',
  startDate: '2026-11-01',
  endDate: '2026-11-03',
  baseCurrency: 'TWD',
  budget: 5000,
  color: '#0f766e',
  notes: '',
};

const raster = {
  blob: new Blob(['原圖'], { type: 'image/jpeg' }),
  thumb: new Blob(['縮圖'], { type: 'image/jpeg' }),
  width: 1600,
  height: 900,
  mime: 'image/jpeg',
};

/** 造一趟有行程項／支出／照片／清單的旅行，回五個 id */
async function seeded() {
  const tripId = await createTrip(tripSeed);
  const itemId = await createDayItem({ tripId, date: '2026-11-02', kind: 'food', title: '拉麵', order: 10 });
  const expenseId = await createExpense({
    tripId,
    dayItemId: itemId,
    date: '2026-11-02',
    amount: 900,
    currency: 'JPY',
    rateToBase: 0.235,
    category: 'food',
  });
  const [photoId] = await addPhotos([{ tripId, dayItemId: itemId, raster, source: 'device' }]);
  const checkId = await createCheckItem(tripId, '帶護照');
  return { tripId, itemId, expenseId, photoId, checkId };
}

/** 把一份「伺服器的基準檔」擺成遠端樣子：只有列，沒有照片 base64 */
function remoteBase(rows: { trips?: unknown[]; dayItems?: unknown[]; expenses?: unknown[]; checkItems?: unknown[]; tombstones?: unknown[] }) {
  server.base = {
    format: 'triplog-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    trips: [],
    dayItems: [],
    expenses: [],
    categories: [],
    photos: [],
    checkItems: [],
    meta: [],
    tombstones: [],
    ...rows,
  };
}

const stamp = (daysAgo = 1) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => route(url, init)));
  server.base = null;
  server.pushes.length = 0;
  await db.delete();
  await db.open();
  await db.categories.bulkPut(
    DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${c.kind}-${i}` })),
  );
});

describe('同步套用刪除記號', () => {
  it('遠端那一筆已刪：本機連它底下的列一起清掉', async () => {
    const { tripId } = await seeded();
    remoteBase({ tombstones: [{ id: tripId, kind: 'trips', deletedAt: stamp() }] });

    const r = await pullFromServer(cfg);
    // 記號只寫了旅行那一筆，但連動要把行程項、支出、照片與清單一起算進去
    expect(r.deleted).toBe(5);
    expect(await db.trips.count()).toBe(0);
    expect(await db.dayItems.count()).toBe(0);
    expect(await db.expenses.count()).toBe(0);
    expect(await db.photos.count()).toBe(0);
    expect(await db.checkItems.count()).toBe(0);
    // 記號本身要落地：之後每次推送都帶著它，別人才不會又長回來
    expect((await db.tombstones.toArray()).map((m) => m.id)).toEqual([tripId]);
  });

  it('遠端清單會拉進本機，完成狀態與排序一起帶過來', async () => {
    const { tripId } = await seeded();
    await db.checkItems.clear();
    remoteBase({
      checkItems: [
        { id: 'check_remote', tripId, text: '買票', done: true, order: 20, createdAt: stamp(2), updatedAt: stamp() },
        { id: 'check_first', tripId, text: '帶護照', done: false, order: 10, createdAt: stamp(2), updatedAt: stamp() },
      ],
    });

    const r = await pullFromServer(cfg);
    expect(r.pulled.checkItems).toBe(2);
    expect((await db.checkItems.where('tripId').equals(tripId).sortBy('order')).map((c) => [c.text, c.done])).toEqual([
      ['帶護照', false],
      ['買票', true],
    ]);
  });

  it('遠端單筆清單記號只刪那一筆，同一趟的其他事項照留', async () => {
    const { tripId, checkId } = await seeded();
    const keepId = await createCheckItem(tripId, '確認機票');
    remoteBase({ tombstones: [{ id: checkId, kind: 'checkItems', deletedAt: stamp() }] });

    const r = await pullFromServer(cfg);
    expect(r.deleted).toBe(1);
    expect((await db.checkItems.where('tripId').equals(tripId).primaryKeys()).map(String)).toEqual([keepId]);
  });

  it('遠端「沒有這一筆」不等於要刪：本機資料照留', async () => {
    await seeded();
    // 離線裝置推上來的並集常常少了別人的列，那只代表它還沒拿到
    remoteBase({});

    const r = await pullFromServer(cfg);
    expect(r.deleted).toBe(0);
    expect(await db.trips.count()).toBe(1);
    expect(await db.dayItems.count()).toBe(1);
    expect(await db.expenses.count()).toBe(1);
    expect(await db.photos.count()).toBe(1);
  });

  it('本機刪掉的那一趟，會跟著立即同步推回基準檔', async () => {
    const { tripId } = await seeded();
    remoteBase({
      trips: [{ ...tripSeed, id: tripId, updatedAt: stamp(9) }],
      dayItems: [],
      expenses: [],
    });
    await deleteTrip(tripId);

    const r = await syncNow(cfg);
    // 遠端那份舊基準還帶著那一趟，合併完要照本機記號把它壓掉
    expect(await db.trips.count()).toBe(0);
    expect(r.pushed.trips).toBe(0);
    expect(r.pushed.checkItems).toBe(0);
    const pushed = server.pushes[server.pushes.length - 1];
    expect(pushed).toBeTruthy();
    expect(pushed?.trips.map((t: { id: string }) => t.id)).not.toContain(tripId);
    expect(pushed?.tombstones?.map((m: { id: string }) => m.id)).toContain(tripId);
    // 推上去的那份也要有記號，否則下一台裝置的歷史快照又能把那筆帶回來
    expect((await exportBackup({ excludePhotos: true })).tombstones?.map((m) => m.id)).toContain(tripId);
  });

  it('一般雙向同步會把本機清單推到伺服器', async () => {
    const { tripId, checkId } = await seeded();
    remoteBase({ trips: [{ ...tripSeed, id: tripId, updatedAt: stamp(9) }] });

    const r = await syncNow(cfg);
    expect(r.pushed.checkItems).toBe(1);
    const pushed = server.pushes[server.pushes.length - 1];
    expect(pushed?.checkItems.map((c: { id: string }) => c.id)).toEqual([checkId]);
  });

  it('只推不拉的那顆鈕不會清任何東西：本機列照樣留著', async () => {
    const { tripId } = await seeded();
    remoteBase({ tombstones: [{ id: tripId, kind: 'trips', deletedAt: stamp() }] });

    // pushToServer 不走 applySnapshot，所以遠端的記號這次不生效（要拉下來纔會套）
    const { pushToServer } = await import('./sync');
    const r = await pushToServer(cfg);
    expect(r.deleted).toBe(0);
    expect(await db.trips.count()).toBe(1);
  });
});
