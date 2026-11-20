import { describe, expect, it } from 'vitest';
import type { Category, Expense, Trip } from '../db/types';
import { setLang } from '../i18n';
import { filterExpenses, summarize } from './stats';

// 分類標籤會隨介面語言變；這裡綁在繁中，且要在 summarize 跑之前設定
setLang('zh-Hant');

const trip: Trip = {
  id: 't1',
  name: '京都',
  startDate: '2026-11-01',
  endDate: '2026-11-03',
  baseCurrency: 'TWD',
  budget: 5000,
  color: '#0f766e',
  archived: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const cats: Category[] = [
  { id: 'c-food', kind: 'expense', key: 'food', label: '餐飲', color: '#e07a3f', order: 1, builtin: true },
  { id: 'c-stay', kind: 'expense', key: 'stay', label: '住宿', color: '#7c5cd6', order: 2, builtin: true },
];

function exp(p: Partial<Expense>): Expense {
  return {
    id: 'e',
    tripId: 't1',
    dayItemId: null,
    date: '2026-11-01',
    amount: 100,
    currency: 'TWD',
    rateToBase: 1,
    baseAmount: 100,
    category: 'c-food',
    payee: '',
    note: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...p,
  };
}

describe('summarize', () => {
  const rows = [
    exp({ id: 'a', date: '2026-11-01', amount: 1000, baseAmount: 1000, payee: '我' }),
    exp({
      id: 'b',
      date: '2026-11-01',
      amount: 42000,
      currency: 'JPY',
      rateToBase: 0.235,
      baseAmount: 9870,
      category: 'c-stay',
      payee: '小美',
    }),
    exp({ id: 'c', date: '2026-11-03', amount: 500, baseAmount: 500, payee: '我' }),
  ];
  const s = summarize(trip, rows, cats);

  it('加總與預算進度', () => {
    expect(s.totalBase).toBe(11370);
    expect(s.budget).toBe(5000);
    expect(s.remaining).toBe(-6370);
    expect(s.usedRatio).toBeCloseTo(2.274, 3);
  });

  it('每日分布會補齊沒有花費的天，並含行程外的日期', () => {
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(s.days[1]).toMatchObject({ amount: 0, count: 0 });
    expect(s.days[0].amount).toBe(10870);
  });

  it('分類占比依主幣別、原始幣別依原幣合計', () => {
    expect(s.byCategory[0]).toMatchObject({ key: 'c-stay', label: '住宿', amount: 9870, count: 1 });
    expect(s.byCategory[1]).toMatchObject({ key: 'c-food', amount: 1500, count: 2 });
    const jpy = s.byCurrency.find((b) => b.key === 'JPY');
    expect(jpy?.amount).toBe(42000);
    expect(s.byCurrency.find((b) => b.key === 'TWD')?.amount).toBe(1500);
  });

  it('代墊統計依付款人彙總，由多到少', () => {
    expect(s.byPayer).toEqual([
      { key: '小美', amount: 9870, count: 1 },
      { key: '我', amount: 1500, count: 2 },
    ]);
  });

  it('沒有填付款人時不會憑空長出筆數', () => {
    const s5 = summarize(trip, rows.map((r) => ({ ...r, payee: '  ' })), cats);
    expect(s5.byPayer).toEqual([]);
  });

  it('單日最高與平均', () => {
    expect(s.maxDay?.date).toBe('2026-11-01');
    expect(s.perDayAverage).toBe(3790); // 11370 / 3
  });

  it('沒有預算時不產生進度比', () => {
    const s2 = summarize({ ...trip, budget: null }, rows, cats);
    expect(s2.budget).toBeNull();
    expect(s2.usedRatio).toBeNull();
    expect(s2.remaining).toBeNull();
  });

  it('空清單不炸', () => {
    const s3 = summarize(trip, [], cats);
    expect(s3.totalBase).toBe(0);
    expect(s3.maxDay?.amount).toBe(0);
    expect(s3.perDayAverage).toBe(0);
  });

  it('超出旅行日期範圍的支出仍然入帳（補一列）', () => {
    const s4 = summarize(trip, [...rows, exp({ id: 'd', date: '2026-11-05', baseAmount: 200 })], cats);
    expect(s4.days).toHaveLength(4);
    expect(s4.totalBase).toBe(11570);
  });
});

describe('filterExpenses', () => {
  const rows = [
    exp({ id: 'a', category: 'c-food', note: '一蘭拉麵', date: '2026-11-01' }),
    exp({ id: 'b', category: 'c-stay', note: '東急 Stay', date: '2026-11-02', payee: '小美' }),
  ];

  it('依分類、日期區間與文字搜尋', () => {
    expect(filterExpenses(rows, { category: 'c-stay' }).map((r) => r.id)).toEqual(['b']);
    expect(filterExpenses(rows, { from: '2026-11-02', to: '2026-11-03' }).map((r) => r.id)).toEqual(['b']);
    expect(filterExpenses(rows, { text: '小美' }).map((r) => r.id)).toEqual(['b']);
    expect(filterExpenses(rows, { text: '拉麵' }).map((r) => r.id)).toEqual(['a']);
    expect(filterExpenses(rows, { tripId: 'nope' })).toEqual([]);
  });

  it('依付款人篩選（前後空白不影響）', () => {
    expect(filterExpenses(rows, { payee: '小美' }).map((r) => r.id)).toEqual(['b']);
    expect(filterExpenses(rows, { payee: '  小美  ' }).map((r) => r.id)).toEqual(['b']);
    expect(filterExpenses(rows, { payee: '路人' })).toEqual([]);
  });
});
