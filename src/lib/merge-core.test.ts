import { describe, expect, it } from 'vitest';
import {
  countsOf,
  kindFromId,
  mergeBackupObjects,
  mergeSources,
  sliceTrip,
  TOMBSTONE_DAYS,
  tombstone,
  type BackupLike,
} from './merge-core';

/**
 * 合併只看 id 與時間戳，測試 fixtures 不需要湊出完整的 Trip/Expense 欄位，
 * 所以這裡用 Loose 寫，只在傳入 merge-core 的邊界轉一次型別。
 */
type Loose = Record<string, unknown>;
type LooseBackup = {
  format?: string;
  version?: number;
  exportedAt?: string;
  trips?: Loose[];
  dayItems?: Loose[];
  expenses?: Loose[];
  categories?: Loose[];
  photos?: Loose[];
  checkItems?: Loose[];
  tombstones?: Loose[];
  meta?: Loose[];
};

/** 建立一筆有時間戳的列，省掉測試裡成片的 createdAt/updatedAt */
function row(id: string, updatedAt: string, extra: Loose = {}): Loose {
  return { id, updatedAt, createdAt: updatedAt, ...extra };
}

function backup(partial: LooseBackup): BackupLike {
  return {
    format: 'triplog-backup',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as unknown as BackupLike;
}

describe('merge-core 合併規則', () => {
  it('不同 id 取並集', () => {
    const merged = mergeBackupObjects(
      backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z', { name: '京都' })] }),
      backup({ trips: [row('t2', '2026-01-02T00:00:00.000Z', { name: '台北' })] }),
    );
    expect(merged.trips?.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('同 id 時 updatedAt 較新者勝（兩個方向都一樣）', () => {
    const old = row('t1', '2026-01-01T00:00:00.000Z', { name: '舊名' });
    const fresh = row('t1', '2026-03-01T00:00:00.000Z', { name: '新名' });
    expect(mergeBackupObjects(backup({ trips: [old] }), backup({ trips: [fresh] })).trips?.[0].name).toBe('新名');
    expect(mergeBackupObjects(backup({ trips: [fresh] }), backup({ trips: [old] })).trips?.[0].name).toBe('新名');
  });

  it('時間相同時留排在前面的來源，重複同步不會互相蓋來蓋去', () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    const a = row('t1', stamp, { name: 'A' });
    const b = row('t1', stamp, { name: 'B' });
    expect(mergeBackupObjects(backup({ trips: [a] }), backup({ trips: [b] })).trips?.[0].name).toBe('A');
  });

  it('照片沒有 updatedAt 就用 createdAt 比較', () => {
    const p1 = { id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', tripId: 't1', v: 1 };
    const p2 = { id: 'p1', createdAt: '2026-02-01T00:00:00.000Z', tripId: 't1', v: 2 };
    const merged = mergeBackupObjects(backup({ photos: [p1] }), backup({ photos: [p2] }));
    expect(merged.photos).toHaveLength(1);
    expect((merged.photos?.[0] as unknown as { v: number }).v).toBe(2);
    expect(merged.version).toBe(2);
  });

  it('分類一律保留既有那筆，另一端剛長出的內建分類不能蓋掉改過的顏色', () => {
    const mine = row('c-food', '2026-01-01T00:00:00.000Z', { key: 'food', label: '吃掉', color: '#ff0000' });
    const bootstrap = row('c-food', '2026-09-09T00:00:00.000Z', { key: 'food', label: '飲食', color: '#0f766e' });
    const merged = mergeBackupObjects(backup({ categories: [mine] }), backup({ categories: [bootstrap] }));
    expect(merged.categories?.[0].color).toBe('#ff0000');
    expect(merged.categories?.[0].label).toBe('吃掉');
  });

  it('meta 的物件欄位採淺合併，兩端各自記過的匯率都留得住', () => {
    const merged = mergeBackupObjects(
      backup({ meta: [{ key: 'rates', value: { 'TWD>JPY': 0.22 } }] }),
      backup({ meta: [{ key: 'rates', value: { 'TWD>USD': 32 } }] }),
    );
    expect(merged.meta).toEqual([{ key: 'rates', value: { 'TWD>JPY': 0.22, 'TWD>USD': 32 } }]);
  });

  it('清單同樣取並集，同 id 由 updatedAt 較新者勝', () => {
    const older = row('check_a', '2026-01-01T00:00:00.000Z', { tripId: 't1', text: '帶護照', done: false });
    const newer = row('check_a', '2026-03-01T00:00:00.000Z', { tripId: 't1', text: '帶護照', done: true });
    const merged = mergeBackupObjects(
      backup({ checkItems: [older] }),
      backup({ checkItems: [newer, row('check_b', '2026-03-02T00:00:00.000Z', { tripId: 't1', text: '買票' })] }),
    );
    expect(merged.checkItems).toHaveLength(2);
    expect(merged.checkItems?.find((c) => c.id === 'check_a')?.done).toBe(true);
  });

  it('沒有 id 的髒資料直接丟掉，不會讓合併炸掉', () => {
    const merged = mergeBackupObjects(
      backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z')] }),
      backup({ trips: [{ name: '沒有 id' }, null, 3] as unknown as Loose[] }),
    );
    expect(merged.trips).toHaveLength(1);
  });

  it('mergeSources 接受多份，且由新到舊傳入時最新那份當基準', () => {
    const merged = mergeSources([
      backup({ trips: [row('t1', '2026-03-01T00:00:00.000Z', { name: '最新' })] }),
      backup({ trips: [row('t1', '2026-02-01T00:00:00.000Z', { name: '中間' })] }),
      backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z', { name: '最舊' })] }),
    ]);
    expect(merged.trips?.[0].name).toBe('最新');
  });

  it('不會動到傳進來的來源物件', () => {
    const a = backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z', { name: 'A' })] });
    const b = backup({ trips: [row('t2', '2026-01-02T00:00:00.000Z', { name: 'B' })] });
    mergeBackupObjects(a, b);
    expect(a.trips).toHaveLength(1);
    expect(b.trips).toHaveLength(1);
  });

  it('sliceTrip 只留那一趟，並附上用得到的分類與匯率', () => {
    const src = backup({
      trips: [row('t1', '2026-01-01T00:00:00.000Z'), row('t2', '2026-01-01T00:00:00.000Z')],
      dayItems: [
        row('i1', '2026-01-01T00:00:00.000Z', { tripId: 't1' }),
        row('i2', '2026-01-01T00:00:00.000Z', { tripId: 't2' }),
      ],
      expenses: [
        row('e1', '2026-01-01T00:00:00.000Z', { tripId: 't1', category: 'c-food' }),
        row('e2', '2026-01-01T00:00:00.000Z', { tripId: 't2', category: 'c-stay' }),
      ],
      categories: [
        { id: 'c-food', key: 'food', label: '飲食' },
        { id: 'c-stay', key: 'stay', label: '住宿' },
      ],
      photos: [
        { id: 'p1', tripId: 't1', dayItemId: 'i1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'p2', tripId: 't2', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      checkItems: [
        row('check_1', '2026-01-01T00:00:00.000Z', { tripId: 't1', text: '帶護照' }),
        row('check_2', '2026-01-01T00:00:00.000Z', { tripId: 't2', text: '別帶' }),
      ],
      meta: [
        { key: 'rates', value: { 'TWD>JPY': 0.22 } },
        { key: 'app', value: { lang: 'zh-Hant' } },
      ],
    });
    const slice = sliceTrip(src, 't1');
    expect(slice.trips?.map((t) => t.id)).toEqual(['t1']);
    expect(slice.dayItems?.map((i) => i.id)).toEqual(['i1']);
    expect(slice.expenses?.map((e) => e.id)).toEqual(['e1']);
    expect(slice.categories?.map((c) => c.id)).toEqual(['c-food']);
    expect(slice.photos?.map((p) => p.id)).toEqual(['p1']);
    expect(slice.checkItems?.map((c) => c.id)).toEqual(['check_1']);
    expect(slice.meta).toEqual([{ key: 'rates', value: { 'TWD>JPY': 0.22 } }]);
    expect(slice.version).toBe(2);
  });

  it('countsOf 給出各表筆數', () => {
    expect(countsOf(backup({ trips: [{ id: 't1' }], expenses: [{ id: 'e1' }, { id: 'e2' }], checkItems: [{ id: 'check_1' }] }))).toEqual({
      trips: 1,
      dayItems: 0,
      expenses: 2,
      categories: 0,
      photos: 0,
      checkItems: 1,
    });
  });
});

/** recent(n)：n 天前的 ISO，用來造「還在保存期內」的刪除記號 */
const recent = (daysAgo = 1): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe('merge-core 刪除記號（tombstone）', () => {
  it('一端刪掉的旅行，不會被另一端舊快照帶回來', () => {
    const before = backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z', { name: '名古屋' })] });
    const after = backup({
      trips: [],
      tombstones: [{ id: 't1', kind: 'trips', deletedAt: recent() }],
    });
    const merged = mergeBackupObjects(before, after);
    expect(merged.trips).toEqual([]);
    // 記號本身要留在結果裡：下一台裝置推上來的並集還要靠它壓住
    expect(merged.tombstones).toEqual([{ id: 't1', kind: 'trips', deletedAt: after.tombstones?.[0]?.deletedAt }]);
  });

  it('刪除獲勝：記號之後另一端才改的那一筆也不會回來', () => {
    const killer = backup({ tombstones: [{ id: 't1', kind: 'trips', deletedAt: '2026-05-01T00:00:00.000Z' }] });
    const staleEdit = backup({ trips: [row('t1', '2026-04-30T00:00:00.000Z', { name: '改過標題' })] });
    expect(mergeBackupObjects(killer, staleEdit).trips).toEqual([]);
  });

  it('刪掉旅行時連同底下的行程項、支出、照片與清單一起消失', () => {
    const merged = mergeSources([
      backup({
        trips: [row('t1', '2026-01-01T00:00:00.000Z')],
        dayItems: [row('i1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })],
        expenses: [row('e1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })],
        photos: [row('p1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })],
        checkItems: [row('check_1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })],
      }),
      backup({ trips: [], tombstones: [{ id: 't1', kind: 'trips', deletedAt: recent() }] }),
      // 另一台還帶著那些列（它還沒同步），以及另一趟的資料要毫髮無傷
      backup({
        trips: [row('t2', '2026-01-02T00:00:00.000Z')],
        dayItems: [row('i9', '2026-01-02T00:00:00.000Z', { tripId: 't2' })],
        expenses: [row('e9', '2026-01-02T00:00:00.000Z', { tripId: 't2' })],
        photos: [row('p9', '2026-01-02T00:00:00.000Z', { tripId: 't2' })],
        checkItems: [row('check_9', '2026-01-02T00:00:00.000Z', { tripId: 't2' })],
      }),
    ]);
    expect(merged.trips?.map((t) => t.id)).toEqual(['t2']);
    expect(merged.dayItems?.map((i) => i.id)).toEqual(['i9']);
    expect(merged.expenses?.map((e) => e.id)).toEqual(['e9']);
    expect(merged.photos?.map((p) => p.id)).toEqual(['p9']);
    expect(merged.checkItems?.map((c) => c.id)).toEqual(['check_9']);
  });

  it('單筆清單的記號會壓過舊快照，缺 kind 時也能由 check_ 前綴補上', () => {
    const merged = mergeBackupObjects(
      backup({ checkItems: [row('check_1', '2026-01-01T00:00:00.000Z', { tripId: 't1', text: '帶護照' })] }),
      backup({ tombstones: [{ id: 'check_1', deletedAt: recent() }] }),
    );
    expect(merged.checkItems).toEqual([]);
    expect(merged.tombstones).toEqual([{ id: 'check_1', kind: 'checkItems', deletedAt: expect.any(String) }]);
  });

  it('行程項的記號只帶走它的照片，改掛到旅行的照樣活', () => {
    const merged = mergeBackupObjects(
      backup({
        dayItems: [row('i1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })],
        // deleteDayItem() 會把支出改成 dayItemId: null，這裡就是那之後的樣子
        expenses: [row('e1', '2026-01-02T00:00:00.000Z', { tripId: 't1', dayItemId: null })],
        photos: [row('p1', '2026-01-01T00:00:00.000Z', { tripId: 't1', dayItemId: 'i1' })],
      }),
      backup({ dayItems: [], tombstones: [{ id: 'i1', kind: 'dayItems', deletedAt: recent() }] }),
    );
    expect(merged.dayItems).toEqual([]);
    expect(merged.photos).toEqual([]);
    expect(merged.expenses?.map((e) => e.id)).toEqual(['e1']);
  });

  it('kindFromId：五種前綴都推得出來，字串長度不一樣也不影響', () => {
    expect(kindFromId('trip_a1')).toBe('trips');
    expect(kindFromId('item_a1')).toBe('dayItems');
    expect(kindFromId('exp_a1')).toBe('expenses');
    expect(kindFromId('photo_a1')).toBe('photos');
    expect(kindFromId('check_a1')).toBe('checkItems');
    expect(kindFromId('c-food')).toBeNull();
    expect(kindFromId('')).toBeNull();
    expect(kindFromId(undefined as unknown as string)).toBeNull();
  });

  it('沒送 kind 時由 id 前綴推（newId 的前綴是穩定的）', () => {
    const merged = mergeBackupObjects(
      backup({
        trips: [row('trip_aaa', '2026-01-01T00:00:00.000Z')],
        expenses: [row('exp_bbb', '2026-01-01T00:00:00.000Z', { tripId: 'trip_aaa' })],
      }),
      backup({
        tombstones: [
          { id: 'trip_aaa', deletedAt: recent() },
          { id: 'exp_bbb', deletedAt: recent() },
        ],
      }),
    );
    expect(merged.trips).toEqual([]);
    expect(merged.expenses).toEqual([]);
    expect(merged.tombstones?.map((t) => t.kind)).toEqual(['trips', 'expenses']);
  });

  it('超過保存期的記號放手，也不再跟著輸出', () => {
    const ancient = new Date(Date.now() - (TOMBSTONE_DAYS + 5) * 86_400_000).toISOString();
    const merged = mergeBackupObjects(
      backup({ trips: [row('t1', '2020-01-01T00:00:00.000Z')] }),
      backup({ tombstones: [{ id: 't1', kind: 'trips', deletedAt: ancient }] }),
    );
    expect(merged.trips?.map((t) => t.id)).toEqual(['t1']);
    expect(merged.tombstones).toEqual([]);
  });

  it('沒有 tombstones 欄位的舊文件照常合併', () => {
    const merged = mergeBackupObjects(
      backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z')] }),
      backup({ trips: [row('t2', '2026-01-02T00:00:00.000Z')] }),
    );
    expect(merged.trips?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(merged.tombstones).toEqual([]);
  });

  it('髒記號（缺時間、不認得的 id）忽略，不會讓合併出錯', () => {
    const merged = mergeBackupObjects(
      backup({ trips: [row('t1', '2026-01-01T00:00:00.000Z')], expenses: [row('e1', '2026-01-01T00:00:00.000Z', { tripId: 't1' })] }),
      backup({
        tombstones: [
          { id: 't1', kind: 'trips' }, // 沒有 deletedAt
          { kind: 'trips', deletedAt: recent() }, // 沒有 id
          { id: 'zzz_1', kind: 'wat', deletedAt: recent() }, // 推不出表名
          ('not-an-object' as unknown as Loose),
        ],
      }),
    );
    expect(merged.trips?.map((t) => t.id)).toEqual(['t1']);
    expect(merged.expenses?.map((e) => e.id)).toEqual(['e1']);
    expect(merged.tombstones).toEqual([]);
  });

  it('分類的記號不參與：內建分類每台裝置自己長出來，不能被遠端抹掉', () => {
    const merged = mergeBackupObjects(
      backup({ categories: [{ id: 'c1', key: 'food', label: '餐飲', color: '#f00' }] }),
      backup({ tombstones: [{ id: 'c1', kind: 'categories', deletedAt: recent() }] }),
    );
    expect(merged.categories?.map((c) => c.id)).toEqual(['c1']);
    expect(merged.tombstones).toEqual([]);
  });

  it('同一 id 的多份記號留較新的 deletedAt', () => {
    const merged = mergeBackupObjects(
      backup({ tombstones: [{ id: 't1', kind: 'trips', deletedAt: '2026-02-01T00:00:00.000Z' }] }),
      backup({ tombstones: [{ id: 't1', kind: 'trips', deletedAt: '2026-03-01T00:00:00.000Z' }] }),
    );
    expect(merged.tombstones).toEqual([{ id: 't1', kind: 'trips', deletedAt: '2026-03-01T00:00:00.000Z' }]);
  });

  it('tombstone() 建記號：給 kind 就用它，不給就推前綴，推不出就丟錯', () => {
    expect(tombstone('trip_x', undefined, '2026-01-01T00:00:00.000Z')).toEqual({
      id: 'trip_x',
      kind: 'trips',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(tombstone('photo_x', 'photos').kind).toBe('photos');
    expect(tombstone('check_x', undefined, '2026-01-01T00:00:00.000Z').kind).toBe('checkItems');
    expect(() => tombstone('c1')).toThrow();
  });

  it('sliceTrip 照記號清乾淨，並把這一趟的記號一起帶走', () => {
    const src = backup({
      trips: [row('t1', '2026-01-01T00:00:00.000Z'), row('t2', '2026-01-01T00:00:00.000Z')],
      dayItems: [
        row('i1', '2026-01-01T00:00:00.000Z', { tripId: 't1' }),
        row('i2', '2026-01-01T00:00:00.000Z', { tripId: 't1' }),
      ],
      expenses: [row('e1', '2026-01-01T00:00:00.000Z', { tripId: 't1', category: 'food' })],
      photos: [row('p1', '2026-01-01T00:00:00.000Z', { tripId: 't1', dayItemId: 'i1' })],
      checkItems: [
        row('check_1', '2026-01-01T00:00:00.000Z', { tripId: 't1', text: '保留' }),
        row('check_2', '2026-01-01T00:00:00.000Z', { tripId: 't1', text: '刪掉' }),
        row('check_9', '2026-01-01T00:00:00.000Z', { tripId: 't2', text: '別趟' }),
      ],
      categories: [{ id: 'c-food', key: 'food' }],
      meta: [{ key: 'rates', value: {} }],
      tombstones: [
        { id: 'i2', kind: 'dayItems', deletedAt: recent() },
        { id: 'check_2', kind: 'checkItems', deletedAt: recent() },
        { id: 't9', kind: 'trips', deletedAt: recent() },
      ],
    });
    const slice = sliceTrip(src, 't1');
    expect(slice.dayItems?.map((i) => i.id)).toEqual(['i1']);
    expect(slice.photos?.map((p) => p.id)).toEqual(['p1']);
    expect(slice.checkItems?.map((c) => c.id)).toEqual(['check_1']);
    expect(slice.tombstones?.map((t) => t.id)).toEqual(['i2', 'check_2']);
    // 整趟被刪時，單趟匯出不會把它復活
    expect(sliceTrip(src, 't9').trips).toEqual([]);
  });
});
