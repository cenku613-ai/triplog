import { DEFAULT_CATEGORIES } from '../db/db';
import type { Category, Expense } from '../db/types';
import { t, tRaw } from '../i18n';

type CatLike = Pick<Category, 'key' | 'label' | 'kind' | 'builtin'>;

/** 內建分類的預設文字（用來判斷使用者有沒有改過名字） */
const DEFAULT_LABEL = new Map<string, string>(
  DEFAULT_CATEGORIES.map((c) => [`${c.kind}:${c.key}`, c.label]),
);

/**
 * 內建分類跟著介面語言走；被改過名字的內建分類、以及使用者自訂分類，
 * 一律顯示存進資料庫的原樣——那是使用者的資料，不是我們的文案。
 */
export function categoryLabel(c: CatLike | undefined): string {
  if (!c) return t('common.uncategorized');
  if (!c.builtin) return c.label;
  const original = DEFAULT_LABEL.get(`${c.kind}:${c.key}`);
  if (original === undefined || c.label !== original) return c.label;
  return tRaw(`cat.${c.key}`);
}

/** 分類色塊上的首字（中文取「餐」、英文取「F」） */
export function categoryChar(c: CatLike | undefined): string {
  return (c ? categoryLabel(c) : t('common.expense')).slice(0, 1);
}

/**
 * 手邊只有一個 kind key、沒有分類列時要顯示什麼（分享連結最常見：
 * 擁有者還沒把分類推上伺服器，payload 的分類清單是空的）。
 * 內建的照介面語言翻成「景點」，翻不到的就原樣顯示，不要瞎猜。
 */
export function builtinKindLabel(kind: Category['kind'], key: string): string {
  const row = DEFAULT_CATEGORIES.find((c) => c.kind === kind && c.key === key);
  return row ? tRaw(`cat.${key}`) : key;
}

/** 一筆支出的顯示標題：備註 > 分類 > 「支出」 */
export function expenseLabel(e: Pick<Expense, 'note'>, c?: CatLike): string {
  return e.note?.trim() || (c ? categoryLabel(c) : '') || t('common.expense');
}
