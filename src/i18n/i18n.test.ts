import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../db/db';
import { en } from './en';
import { categoryLabel } from '../lib/labels';
import { setLang, t, tRaw } from './index';
import { zh, type Key } from './zh';

const zhKeys = Object.keys(zh) as Key[];
const enKeys = Object.keys(en);

afterEach(() => setLang('zh-Hant'));

describe('字典', () => {
  it('英文與繁中鍵名完全對應，沒有漏譯也沒有多出來的鍵', () => {
    const missing = zhKeys.filter((k) => !(k in en));
    const extra = enKeys.filter((k) => !(k in zh));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(enKeys.length).toBe(zhKeys.length);
  });

  it('每條都有實際文字，不會是空字串或鍵名本身', () => {
    for (const k of zhKeys) {
      expect(zh[k].trim(), `zh.${k}`).not.toBe('');
      expect(en[k].trim(), `en.${k}`).not.toBe('');
      expect(en[k], `en.${k}`).not.toBe(k);
    }
  });

  it('繁中字典不該混入英文單詞佔位（抓還沒翻的中文鍵）', () => {
    // 範例網址（sync.baseUrlPlaceholder 那種）本來就是拉丁字，不算漏譯
    const isUrlLike = (v: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
    const untranslated = zhKeys.filter(
      (k) => /^[a-z0-9 .,:;/?()&%#-]+$/.test(zh[k]) && !/\d/.test(zh[k]) && !isUrlLike(zh[k]),
    );
    expect(untranslated).toEqual([]);
  });
});

describe('t()', () => {
  it('依目前語言取字，切換後立即生效', () => {
    setLang('zh-Hant');
    expect(t('nav.trips')).toBe('旅行');
    setLang('en');
    expect(t('nav.trips')).toBe('Trips');
  });

  it('動態鍵走 tRaw，缺鍵時退回鍵名而不是 undefined', () => {
    expect(tRaw('weekday.6')).toBe('六');
    expect(tRaw('nope.missing')).toBe('nope.missing');
  });

  it('插值取代 {var}，缺的變數留空', () => {
    expect(t('expense.rateLabel', { code: 'JPY', base: 'TWD' })).toBe('匯率：1 JPY = ? TWD');
    expect(t('expense.rateLabel', { code: 'JPY' })).toBe('匯率：1 JPY = ? ');
  });

  it('英文用 {n?s|p} 處理單複數，繁中不受影響', () => {
    setLang('en');
    expect(t('stats.countDays', { n: 1, days: 1 })).toBe('1 entry · 1 day long');
    expect(t('stats.countDays', { n: 8, days: 3 })).toBe('8 entries · 3 days long');
    expect(t('settings.exported', { n: 0 })).toBe('Exported 0 trips');
    setLang('zh-Hant');
    expect(t('stats.countDays', { n: 8, days: 3 })).toBe('8 筆 · 共 3 天');
  });
});

describe('內建分類標籤', () => {
  it('用戶沒改過就跟著介面語言', () => {
    const stay = DEFAULT_CATEGORIES.find((c) => c.key === 'stay')!;
    expect(categoryLabel(stay)).toBe('住宿');
    setLang('en');
    expect(categoryLabel(stay)).toBe('Stay');
  });

  it('自訂分類與改過名字的內建分類保留原判別', () => {
    expect(categoryLabel({ kind: 'expense', key: 'mycat', label: '按摩', builtin: false })).toBe('按摩');
    setLang('en');
    const renamed = { ...DEFAULT_CATEGORIES.find((c) => c.key === 'stay')!, label: '旅宿' };
    expect(categoryLabel(renamed)).toBe('旅宿');
  });
});
