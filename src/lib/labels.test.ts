import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { builtinKindLabel, categoryLabel } from './labels';

/**
 * 分享連結的同行者常常拿到一份「沒有分類」的 payload（擁有者用 agent 建旅行、
 * 或還沒推上伺服器），這時頁面只能靠 key 翻名。這些測試鎖住兩件事：
 * 內建的 key 要跟著介面語言，翻不到的 key 要原樣顯示、不要變成「未分類」。
 */

afterEach(() => setLang('zh-Hant'));

describe('builtinKindLabel', () => {
  it('內建行程類型照介面語言顯示', () => {
    setLang('zh-Hant');
    expect(builtinKindLabel('item', 'sight')).toBe('景點');
    setLang('en');
    expect(builtinKindLabel('item', 'sight')).toBe('Sights');
    expect(builtinKindLabel('expense', 'transport')).toBe('Transport');
  });

  it('不是內建的 key 就原樣回傳', () => {
    setLang('zh-Hant');
    expect(builtinKindLabel('item', 'kami-kura')).toBe('kami-kura');
    // 支出有 food、行程沒有 sight 以外的亂碼也不會被翻成別的
    expect(builtinKindLabel('item', 'food')).toBe('餐飲');
    expect(builtinKindLabel('expense', 'sight')).toBe('sight');
  });
});

describe('categoryLabel', () => {
  it('用一個假的分類列當 key 翻譯是錯的：label 對不上原字串會被當成改過名', () => {
    setLang('zh-Hant');
    // 這一筆就是 SharePage 修掉之前的寫法，它會顯示 sight 而不是「景點」
    expect(categoryLabel({ key: 'sight', label: 'sight', kind: 'item', builtin: true })).toBe('sight');
    // 真正的內建列（label 是預設字串）才會跟著語言走
    expect(categoryLabel({ key: 'sight', label: '景點', kind: 'item', builtin: true })).toBe('景點');
  });

  it('擁有者改過名字的內建分類，顯示他改的那個名字', () => {
    setLang('en');
    expect(categoryLabel({ key: 'food', label: 'Eat & Drink', kind: 'expense', builtin: true })).toBe('Eat & Drink');
  });
});
