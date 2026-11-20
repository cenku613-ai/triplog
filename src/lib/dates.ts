import type { ISODate } from '../db/types';
import { t, tRaw } from '../i18n';

const MS_DAY = 86_400_000;

export function toKey(d: Date): ISODate {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(): ISODate {
  return toKey(new Date());
}

/** 只吃 YYYY-MM-DD，一律走 UTC 算術，避免 DST/時區位移 */
export function parse(key: ISODate): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

export function addDays(key: ISODate, n: number): ISODate {
  return toKeyFromUtc(parse(key).getTime() + n * MS_DAY);
}

function toKeyFromUtc(ms: number): ISODate {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / MS_DAY);
}

/** 含頭含尾的日期清單 */
export function dateRange(from: ISODate, to: ISODate): ISODate[] {
  const n = Math.max(0, daysBetween(from, to)) + 1;
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

/** 0=日 … 6=六，依介面語言回傳「週六」或「Sat」 */
export function weekdayIndex(key: ISODate): number {
  return parse(key).getUTCDay();
}

export function weekday(key: ISODate): string {
  return tRaw(`weekday.${weekdayIndex(key)}`);
}

export function prettyDate(key: ISODate, opts: { withYear?: boolean } = {}): string {
  const d = parse(key);
  const vars = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: weekday(key) };
  return t(opts.withYear ? 'date.prettyYear' : 'date.pretty', vars);
}

/** 只有數字日期，給圖表提示與精簡版面用 */
export function numericDate(key: ISODate, opts: { withYear?: boolean } = {}): string {
  const d = parse(key);
  const vars = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  return t(opts.withYear ? 'date.numeric' : 'date.monthDay', vars);
}

/** 「第 3 天」/「Day 3」 */
export function dayLabel(n: number): string {
  return t('day.n', { n });
}

/** 第幾天（1 起）；不在範圍內回傳 null */
export function dayIndex(tripStart: ISODate, key: ISODate): number | null {
  const i = daysBetween(tripStart, key);
  return i < 0 ? null : i + 1;
}

export function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return '';
  if (!end) return start;
  return `${start} – ${end}`;
}

export function isValidDate(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(parse(key).getTime());
}
