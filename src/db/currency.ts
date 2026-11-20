import type { CurrencyDef } from './types';
import { intlLocale, lookup } from '../i18n';

/** 內建常用幣別；使用者可在設定裡補充自己的代碼 */
export const BUILTIN_CURRENCIES: CurrencyDef[] = [
  { code: 'TWD', label: '新台幣', symbol: 'NT$', decimals: 0 },
  { code: 'JPY', label: '日圓', symbol: '¥', decimals: 0 },
  { code: 'KRW', label: '韓元', symbol: '₩', decimals: 0 },
  { code: 'USD', label: '美元', symbol: '$', decimals: 2 },
  { code: 'EUR', label: '歐元', symbol: '€', decimals: 2 },
  { code: 'GBP', label: '英鎊', symbol: '£', decimals: 2 },
  { code: 'CNY', label: '人民幣', symbol: '¥', decimals: 2 },
  { code: 'HKD', label: '港幣', symbol: 'HK$', decimals: 2 },
  { code: 'THB', label: '泰銖', symbol: '฿', decimals: 2 },
  { code: 'SGD', label: '新加坡幣', symbol: 'S$', decimals: 2 },
  { code: 'MYR', label: '令吉', symbol: 'RM', decimals: 2 },
  { code: 'VND', label: '越南盾', symbol: '₫', decimals: 0 },
  { code: 'PHP', label: '菲律賓披索', symbol: '₱', decimals: 2 },
  { code: 'AUD', label: '澳洲元', symbol: 'A$', decimals: 2 },
  { code: 'CAD', label: '加拿大元', symbol: 'C$', decimals: 2 },
  { code: 'MOP', label: '澳門元', symbol: 'MOP$', decimals: 1 },
];

const registry = new Map<string, CurrencyDef>(
  BUILTIN_CURRENCIES.map((c) => [c.code, c]),
);

export function currencyDef(code: string): CurrencyDef {
  return (
    registry.get(code) ?? {
      code,
      label: code,
      symbol: code,
      decimals: 2,
    }
  );
}

export function rememberCurrency(code: string, label?: string): void {
  if (!code || registry.has(code)) return;
  registry.set(code, {
    code,
    label: label ?? code,
    symbol: code,
    decimals: 2,
  });
}

export function rateKey(from: string, to: string): string {
  return `${from}>${to}`;
}

/** 內建幣別跟著介面語言；自訂代碼就顯示代碼本身 */
export function currencyLabel(code: string): string {
  return lookup(`cur.${code}`) ?? currencyDef(code).label;
}

export function formatAmount(
  value: number,
  code: string,
  opts: { withSymbol?: boolean; sign?: boolean } = {},
): string {
  const def = currencyDef(code);
  const withSymbol = opts.withSymbol !== false;
  const safe = Number.isFinite(value) ? value : 0;
  const body = new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  }).format(Math.abs(safe));
  const sign = safe < 0 ? '-' : opts.sign && safe > 0 ? '+' : '';
  return `${sign}${withSymbol ? def.symbol : ''}${body}`;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}
