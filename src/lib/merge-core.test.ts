import { describe, expect, it } from 'vitest';
import { countsOf, mergeBackupObjects, mergeSources, sliceTrip, type BackupLike } from './merge-core';

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
    expect(slice.meta).toEqual([{ key: 'rates', value: { 'TWD>JPY': 0.22 } }]);
    expect(slice.version).toBe(2);
  });

  it('countsOf 給出各表筆數', () => {
    expect(countsOf(backup({ trips: [{ id: 't1' }], expenses: [{ id: 'e1' }, { id: 'e2' }] }))).toEqual({
      trips: 1,
      dayItems: 0,
      expenses: 2,
      categories: 0,
      photos: 0,
    });
  });
});
