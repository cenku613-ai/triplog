import type { Category, DayItem, Expense, Trip } from '../db/types';
import { currencyDef, roundTo } from '../db/currency';
import { dateRange, prettyDate } from './dates';
import { categoryLabel } from './labels';

export interface Bucket {
  key: string;
  label: string;
  color: string;
  amount: number;
  count: number;
}

/** 代墊統計：key = 付款人文字 */
export interface PayerBucket {
  key: string;
  amount: number;
  count: number;
}

export interface DayBucket {
  date: string;
  label: string;
  amount: number;
  count: number;
}

export interface TripSummary {
  totalBase: number;
  budget: number | null;
  remaining: number | null;
  usedRatio: number | null;
  expenseCount: number;
  days: DayBucket[];
  byCategory: Bucket[];
  byCurrency: Bucket[];
  byPayer: PayerBucket[];
  byDayItem: Record<string, number>;
  perDayAverage: number;
  maxDay: DayBucket | null;
}

export function summarize(
  trip: Trip,
  expenses: Expense[],
  categories: Category[],
  dayItems: DayItem[] = [],
): TripSummary {
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const byCategory = new Map<string, Bucket>();
  const byCurrency = new Map<string, Bucket>();
  const byPayer = new Map<string, PayerBucket>();
  const dayMap = new Map<string, DayBucket>();

  for (const date of dateRange(trip.startDate, trip.endDate)) {
    dayMap.set(date, { date, label: prettyDate(date), amount: 0, count: 0 });
  }

  let totalBase = 0;
  for (const e of expenses) {
    totalBase += e.baseAmount;

    const c = byCategory.get(e.category) ?? {
      key: e.category,
      label: categoryLabel(catMap.get(e.category)),
      color: catMap.get(e.category)?.color ?? '#9aa0a6',
      amount: 0,
      count: 0,
    };
    c.amount = roundTo(c.amount + e.baseAmount, 2);
    c.count += 1;
    byCategory.set(e.category, c);

    const cur = byCurrency.get(e.currency) ?? {
      key: e.currency,
      label: e.currency,
      color: currencyDef(e.currency).symbol === e.currency ? '#2f7ed8' : '#0f9d8f',
      amount: 0,
      count: 0,
    };
    cur.amount = roundTo(cur.amount + e.amount, currencyDef(e.currency).decimals);
    cur.count += 1;
    byCurrency.set(e.currency, cur);

    const payer = e.payee?.trim();
    if (payer) {
      const p = byPayer.get(payer) ?? { key: payer, amount: 0, count: 0 };
      p.amount = roundTo(p.amount + e.baseAmount, 2);
      p.count += 1;
      byPayer.set(payer, p);
    }

    const d = dayMap.get(e.date);
    if (d) {
      d.amount = roundTo(d.amount + e.baseAmount, 2);
      d.count += 1;
    } else {
      dayMap.set(e.date, {
        date: e.date,
        label: prettyDate(e.date),
        amount: roundTo(e.baseAmount, 2),
        count: 1,
      });
    }
  }

  const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const nonZeroDays = days.filter((d) => d.count > 0).length;
  const maxDay = days.reduce<DayBucket | null>(
    (best, d) => (!best || d.amount > best.amount ? d : best),
    null,
  );

  const budget = trip.budget && trip.budget > 0 ? trip.budget : null;
  return {
    totalBase: roundTo(totalBase, 2),
    budget,
    remaining: budget === null ? null : roundTo(budget - totalBase, 2),
    usedRatio: budget === null ? null : totalBase / budget,
    expenseCount: expenses.length,
    days,
    byCategory: [...byCategory.values()].sort((a, b) => b.amount - a.amount),
    byCurrency: [...byCurrency.values()].sort((a, b) => b.amount - a.amount),
    byPayer: [...byPayer.values()].sort((a, b) => b.amount - a.amount),
    byDayItem: dayItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.id] = roundTo(
        expenses.filter((e) => e.dayItemId === item.id).reduce((s, e) => s + e.baseAmount, 0),
        2,
      );
      return acc;
    }, {}),
    perDayAverage:
      nonZeroDays === 0 ? 0 : roundTo(totalBase / days.length, 2),
    maxDay,
  };
}

export function filterExpenses(
  expenses: Expense[],
  q: { tripId?: string; category?: string; from?: string; to?: string; text?: string; payee?: string },
): Expense[] {
  const text = q.text?.trim().toLowerCase();
  const payee = q.payee?.trim();
  return expenses.filter((e) => {
    if (q.tripId && e.tripId !== q.tripId) return false;
    if (q.category && e.category !== q.category) return false;
    if (payee && e.payee?.trim() !== payee) return false;
    if (q.from && e.date < q.from) return false;
    if (q.to && e.date > q.to) return false;
    if (text) {
      const hay = `${e.note ?? ''} ${e.payee ?? ''} ${e.amount}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}
