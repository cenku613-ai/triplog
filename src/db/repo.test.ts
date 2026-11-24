import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES, db } from './db';
import {
  addPhotos,
  buildExpense,
  clearAll,
  createDayItem,
  createExpense,
  createTrip,
  deleteDayItem,
  deleteExpense,
  deleteTrip,
  exportBackup,
  importBackup,
  listCategories,
  listPhotosOfDayItem,
  nextOrder,
  parseBackup,
  removePhotos,
  setRate,
  lookupRate,
} from './repo';

async function reset() {
  await db.delete();
  await db.open();
  await db.categories.bulkPut(
    DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `cat-${c.kind}-${i}` })),
  );
}

const tripSeed = {
  name: '測試旅行',
  startDate: '2026-11-01',
  endDate: '2026-11-03',
  baseCurrency: 'TWD',
  budget: 10000,
  color: '#0f766e',
  notes: '',
};

beforeEach(async () => {
  await reset();
});

describe('支出寫入', () => {
  it('依匯率算出 baseAmount，並依幣別小數位四捨五入', () => {
    const e = buildExpense({
      tripId: 't1',
      date: '2026-11-01',
      amount: 1234,
      currency: 'JPY',
      rateToBase: 0.235,
      category: 'food',
    });
    expect(e.baseAmount).toBe(289.99); // 1234 * 0.235，保留 2 位
    expect(e.amount).toBe(1234);

    const usd = buildExpense({
      tripId: 't1',
      date: '2026-11-01',
      amount: 10.005,
      currency: 'USD',
      rateToBase: 32,
      category: 'food',
    });
    expect(usd.amount).toBe(10.01);
    expect(usd.baseAmount).toBe(320.32);
  });

  it('匯率可記憶與查回，同幣別固定為 1', async () => {
    await setRate('JPY', 'TWD', 0.24);
    expect(await lookupRate('JPY', 'TWD')).toBe(0.24);
    expect(await lookupRate('TWD', 'TWD')).toBe(1);
    expect(await lookupRate('THB', 'TWD')).toBeUndefined();
  });
});

describe('刪除的資料安全', () => {
  it('刪除行程項會保留支出，只解除關聯', async () => {
    const tripId = await createTrip(tripSeed);
    const itemId = await createDayItem({
      tripId,
      date: '2026-11-02',
      kind: 'food',
      title: '拉麵',
      startTime: null,
      endTime: null,
      location: '',
      note: '',
      order: await nextOrder(tripId, '2026-11-02'),
    });
    await createExpense({
      tripId,
      dayItemId: itemId,
      date: '2026-11-02',
      amount: 900,
      currency: 'JPY',
      rateToBase: 0.235,
      category: (await listCategories('expense'))[0].id,
    });
    expect(await db.expenses.count()).toBe(1);

    await deleteDayItem(itemId);
    const left = await db.expenses.toArray();
    expect(left).toHaveLength(1);
    expect(left[0].dayItemId).toBeNull();
    expect(left[0].baseAmount).toBe(211.5);
  });

  it('刪除旅行會連同行程與支出一起移除', async () => {
    const tripId = await createTrip(tripSeed);
    const other = await createTrip({ ...tripSeed, name: '另一趟' });
    const cat = (await listCategories('expense'))[0].id;
    await createDayItem({
      tripId,
      date: '2026-11-01',
      kind: 'other',
      title: 'a',
      order: 10,
    });
    await createExpense({
      tripId,
      date: '2026-11-01',
      amount: 100,
      currency: 'TWD',
      rateToBase: 1,
      category: cat,
    });
    await createExpense({
      tripId: other,
      date: '2026-11-01',
      amount: 50,
      currency: 'TWD',
      rateToBase: 1,
      category: cat,
    });

    await deleteTrip(tripId);
    expect(await db.trips.count()).toBe(1);
    expect(await db.dayItems.count()).toBe(0);
    const rest = await db.expenses.toArray();
    expect(rest).toHaveLength(1);
    expect(rest[0].tripId).toBe(other);
  });
});

describe('備份與還原', () => {
  it('匯出後可完整匯入（覆寫模式）', async () => {
    const tripId = await createTrip(tripSeed);
    const cat = (await listCategories('expense'))[0].id;
    await createExpense({
      tripId,
      date: '2026-11-02',
      amount: 42000,
      currency: 'JPY',
      rateToBase: 0.235,
      category: cat,
      note: '住宿',
    });
    const dump = await exportBackup();
    const text = JSON.stringify(dump);
    expect(parseBackup(text).trips).toHaveLength(1);

    await createTrip({ ...tripSeed, name: '要消失的' });
    const counts = await importBackup(parseBackup(text), 'replace');
    expect(counts.trips).toBe(1);
    const trips = await db.trips.toArray();
    expect(trips.map((t) => t.name)).toEqual(['測試旅行']);
    const exps = await db.expenses.toArray();
    expect(exps[0].baseAmount).toBe(9870);
    expect(exps[0].note).toBe('住宿');
  });

  it('合併模式不會重複插入同一 id', async () => {
    const tripId = await createTrip(tripSeed);
    const dump = await exportBackup();
    expect(dump.trips[0].id).toBe(tripId);
    const counts = await importBackup(dump, 'merge');
    expect(counts.trips).toBe(1); // 回報檔案內容量
    await importBackup(dump, 'merge');
    expect(await db.trips.count()).toBe(1);
  });

  it('拒絕不是備份檔的 JSON', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow(/TripLog/);
  });
});

describe('照片', () => {
  const raster = {
    blob: new Blob(['原圖'], { type: 'image/jpeg' }),
    thumb: new Blob(['縮圖'], { type: 'image/jpeg' }),
    width: 1600,
    height: 900,
    mime: 'image/jpeg',
  };

  async function newTrip(name = '有照片的旅行') {
    return createTrip({ ...tripSeed, name });
  }

  async function newItem(tripId: string) {
    return createDayItem({ tripId, date: '2026-11-02', kind: 'other', title: '清水寺', order: 10 });
  }

  it('行程項刪掉後不留孤兒 Blob', async () => {
    const tripId = await newTrip();
    const itemId = await newItem(tripId);
    const ids = await addPhotos([
      { tripId, dayItemId: itemId, raster, source: 'device', caption: '寺門' },
      { tripId, dayItemId: itemId, raster, source: 'device' },
    ]);
    expect(ids).toHaveLength(2);
    const rows = await listPhotosOfDayItem(itemId);
    expect(rows.map((p) => p.caption ?? '')).toEqual(['寺門', '']); // 順序照選檔順序
    expect(rows[0].dayItemId).toBe(itemId);

    await deleteDayItem(itemId);
    expect(await db.photos.count()).toBe(0);
    expect(await db.dayItems.count()).toBe(0);
  });

  it('刪除旅行只清掉這趟的照片', async () => {
    const a = await newTrip('A');
    const b = await newTrip('B');
    await addPhotos([{ tripId: a, dayItemId: await newItem(a), raster, source: 'device' }]);
    await addPhotos([{ tripId: b, dayItemId: await newItem(b), raster, source: 'device' }]);

    await deleteTrip(a);
    const rest = await db.photos.toArray();
    expect(rest).toHaveLength(1);
    expect(rest[0].tripId).toBe(b);
  });

  it('備份會把照片轉成 base64，還原後 Blob 讀得回來', async () => {
    const tripId = await newTrip();
    const itemId = await newItem(tripId);
    await addPhotos([
      {
        tripId,
        dayItemId: itemId,
        raster,
        source: 'commons',
        creditUrl: 'https://commons.wikimedia.org/wiki/File:Kiyomizu-dera.jpg',
        artist: '某作者',
        license: 'CC BY-SA 4.0',
      },
    ]);

    const dump = await exportBackup();
    expect(dump.version).toBe(2);
    expect(dump.photos?.[0].data).toMatch(/^data:image\/jpeg;base64,/);

    await clearAll();
    expect(await db.photos.count()).toBe(0);

    const counts = await importBackup(dump, 'replace');
    expect(counts.photos).toBe(1);
    const rows = await db.photos.toArray();
    expect(await rows[0].blob.text()).toBe('原圖');
    expect(await rows[0].thumb.text()).toBe('縮圖');
    expect(rows[0].artist).toBe('某作者');
    expect(rows[0].source).toBe('commons');
    // 照片要能重新掛回原本的行程項
    expect(await listPhotosOfDayItem(rows[0].dayItemId as string)).toHaveLength(1);
  });
});

const raster = {
  blob: new Blob(['原圖'], { type: 'image/jpeg' }),
  thumb: new Blob(['縮圖'], { type: 'image/jpeg' }),
  width: 1600,
  height: 900,
  mime: 'image/jpeg',
};

/** 湊一趟有行程項、支出與照片的旅行，回四個 id，刪除記號的測試全靠它 */
async function seeded() {
  const tripId = await createTrip(tripSeed);
  const itemId = await createDayItem({
    tripId,
    date: '2026-11-02',
    kind: 'food',
    title: '拉麵',
    order: 10,
  });
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
  return { tripId, itemId, expenseId, photoId };
}

describe('刪除記號（tombstone）', () => {
  it('刪掉旅行會替四張表各留一筆記號，並跟著匯出檔走出去', async () => {
    const { tripId, itemId, expenseId, photoId } = await seeded();
    await deleteTrip(tripId);

    const markers = await db.tombstones.toArray();
    const byId = new Map(markers.map((m) => [m.id, m.kind]));
    expect([...byId.keys()].sort()).toEqual([expenseId, itemId, photoId, tripId].sort());
    expect(byId.get(tripId)).toBe('trips');
    expect(byId.get(itemId)).toBe('dayItems');
    expect(byId.get(expenseId)).toBe('expenses');
    expect(byId.get(photoId)).toBe('photos');
    for (const m of markers) expect(Date.parse(m.deletedAt)).not.toBeNaN();

    // 匯出（同步推的就是這份）要帶著記號，否則另一端下次推並集就又長回來
    const dump = await exportBackup();
    expect(dump.tombstones?.map((m) => m.id).sort()).toEqual([...byId.keys()].sort());
    // 只推不含照片的那份也要有
    expect((await exportBackup({ excludePhotos: true })).tombstones).toHaveLength(4);
  });

  it('刪行程項只替「真的消失的」記號：改掛到旅行的支出不算', async () => {
    const { tripId, itemId, expenseId, photoId } = await seeded();
    await deleteDayItem(itemId);

    const markers = await db.tombstones.toArray();
    expect(markers.map((m) => m.id).sort()).toEqual([itemId, photoId].sort());
    expect(markers.find((m) => m.id === itemId)?.kind).toBe('dayItems');
    expect(markers.find((m) => m.id === photoId)?.kind).toBe('photos');
    // 支出還在、而且不記刪除記號：它只是改掛到那趟旅行下面
    expect(await db.expenses.get(expenseId)).toBeTruthy();
    expect(await db.expenses.get(expenseId)).toHaveProperty('dayItemId', null);
    expect(await db.trips.get(tripId)).toBeTruthy();
  });

  it('刪單筆支出與刪照片都留下對應記號', async () => {
    const { expenseId, photoId } = await seeded();
    await deleteExpense(expenseId);
    await removePhotos([photoId]);

    const markers = await db.tombstones.toArray();
    expect(markers.map((m) => `${m.kind}:${m.id}`).sort()).toEqual(
      [`expenses:${expenseId}`, `photos:${photoId}`].sort(),
    );
  });

  it('合併匯入時，本機已有的記號會擋住備份檔帶回來的舊紀錄', async () => {
    const { tripId } = await seeded();
    const before = await exportBackup(); // 刪之前先存一份「舊檔」
    await deleteTrip(tripId);
    expect(await db.trips.count()).toBe(0);

    // 拿舊檔合併回來：那一趟與它的行程項不該復活
    await importBackup(JSON.parse(JSON.stringify({ ...before, tombstones: [] })) as typeof before, 'merge');
    expect(await db.trips.count()).toBe(0);
    expect(await db.dayItems.count()).toBe(0);
  });

  it('檔案自己帶著記號時，換一台什麼都還沒記的裝置也擋得住', async () => {
    const { tripId } = await seeded();
    // 另一台裝置推上來的文件：那一趟還寫在列裡，但它已經記下這筆被刪了
    const withMarker = {
      ...(await exportBackup()),
      tombstones: [{ id: tripId, kind: 'trips' as const, deletedAt: new Date().toISOString() }],
    };
    await reset(); // 本機假裝是剛拿到的新裝置：沒那些列，也沒有記號
    await importBackup(withMarker, 'merge');
    expect(await db.trips.count()).toBe(0);
    expect(await db.dayItems.count()).toBe(0); // 連動：旅行沒了，它底下的列也不會進來
    expect(await db.expenses.count()).toBe(0);
    expect(await db.photos.count()).toBe(0);
    expect((await db.tombstones.toArray()).map((m) => m.id)).toEqual([tripId]);
  });

  it('取代模式以檔案為全部事實：連本機記號一起清掉，資料回得來', async () => {
    const { tripId } = await seeded();
    const dump = await exportBackup();
    await deleteTrip(tripId);

    // 檔案裡那一趟還在、記號卻不在：靠本機那四筆記號把它擋在門外
    await importBackup(dump, 'merge');
    expect(await db.trips.count()).toBe(0);

    // 換成「取代」：這台裝置決定以那份檔案為全部事實，記號一併清空，資料就回來了
    await importBackup(dump, 'replace');
    expect(await db.trips.count()).toBe(1);
    expect(await db.dayItems.count()).toBe(1);
    expect(await db.tombstones.count()).toBe(0); // 那份檔案是刪除之前存的，裡面本來就沒有記號
  });

  it('清空裝置不會把刪除記號一起清掉', async () => {
    const { tripId } = await seeded();
    await deleteTrip(tripId);
    const n = await db.tombstones.count();
    expect(n).toBe(4);

    await clearAll();
    expect(await db.trips.count()).toBe(0);
    // 記號留著：不然下次同步會把使用者刪過的東西從歷史快照裡帶回來
    expect(await db.tombstones.count()).toBe(n);
  });
});
