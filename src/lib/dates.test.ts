import { beforeAll, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { addDays, dateRange, dayIndex, daysBetween, isValidDate, prettyDate } from './dates';

describe('日期', () => {
  // 介面語言會影響日期文字，測試綁在繁中，才不会隨跑測試的主機語系變動
  beforeAll(() => setLang('zh-Hant'));

  it('跨月與跨年加減天數不位移', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01'); // 閏年
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('dateRange 含頭含尾', () => {
    expect(dateRange('2026-11-01', '2026-11-03')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(dateRange('2026-11-05', '2026-11-05')).toHaveLength(1);
    expect(dateRange('2026-11-05', '2026-11-01')).toHaveLength(1); // 反向時不炸
  });

  it('dayIndex 從 1 開始，範圍外回傳 null', () => {
    expect(dayIndex('2026-11-10', '2026-11-10')).toBe(1);
    expect(dayIndex('2026-11-10', '2026-11-13')).toBe(4);
    expect(dayIndex('2026-11-10', '2026-11-09')).toBeNull();
  });

  it('daysBetween 與星期顯示', () => {
    expect(daysBetween('2026-11-01', '2026-11-21')).toBe(20);
    expect(prettyDate('2026-11-21')).toBe('11/21 週六');
    expect(prettyDate('2026-11-21', { withYear: true })).toBe('2026/11/21 週六');
  });

  it('換成英文介面後日期與星期跟著換', () => {
    setLang('en');
    expect(prettyDate('2026-11-21')).toBe('11/21 Sat');
    expect(prettyDate('2026-11-21', { withYear: true })).toBe('11/21/2026 Sat');
    setLang('zh-Hant');
  });

  it('拒絕非法日期字串', () => {
    expect(isValidDate('2026-11-21')).toBe(true);
    expect(isValidDate('2026/11/21')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });
});
