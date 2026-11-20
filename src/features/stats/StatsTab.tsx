import { useMemo } from 'react';
import type { Category, DayItem, Expense, Trip } from '../../db/types';
import { summarize } from '../../lib/stats';
import { BarChart, BudgetBar, Donut } from '../../components/Charts';
import { formatAmount } from '../../db/currency';
import { numericDate, prettyDate } from '../../lib/dates';
import { useI18n } from '../../i18n';
import { expenseLabel } from '../../lib/labels';

export function StatsTab({
  trip,
  expenses,
  items,
  categories,
}: {
  trip: Trip;
  expenses: Expense[];
  items: DayItem[];
  categories: Category[];
}) {
  const { t, lang } = useI18n();
  // 語言切換後 summary 裡的 label（分類名、日期）要重算
  const s = useMemo(
    () => summarize(trip, expenses, categories, items),
    [trip, expenses, categories, items, lang],
  );
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const top = useMemo(
    () => [...expenses].sort((a, b) => b.baseAmount - a.baseAmount).slice(0, 5),
    [expenses],
  );

  const itemNames = useMemo(() => new Map(items.map((i) => [i.id, i.title])), [items]);

  if (expenses.length === 0) {
    return (
      <div className="empty card">
        <div className="big">📊</div>
        <h3>{t('stats.empty')}</h3>
        <p className="muted" style={{ marginTop: 6 }}>
          {t('stats.emptyBody')}
        </p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--sp-4)' }}>
      <div className="card card-pad">
        <div className="row-between" style={{ marginBottom: 'var(--sp-3)' }}>
          <h3>{t('stats.budget')}</h3>
          <span className="tiny">{t('stats.countDays', { n: s.expenseCount, days: s.days.length })}</span>
        </div>
        <BudgetBar spent={s.totalBase} budget={s.budget} baseCurrency={trip.baseCurrency} />
        <div className="grid2" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="tile">
            <div className="k">{t('stats.perDay')}</div>
            <div className="v">{formatAmount(s.perDayAverage, trip.baseCurrency)}</div>
          </div>
          <div className="tile">
            <div className="k">{t('stats.maxDay')}</div>
            <div className="v">
              {formatAmount(s.maxDay?.amount ?? 0, trip.baseCurrency)}
              <div className="tiny" style={{ fontWeight: 500 }}>
                {s.maxDay && s.maxDay.count > 0 ? numericDate(s.maxDay.date) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--sp-2)' }}>{t('stats.daily')}</h3>
        <BarChart days={s.days} baseCurrency={trip.baseCurrency} />
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>{t('stats.byCategory')}</h3>
        <Donut buckets={s.byCategory} total={s.totalBase} baseCurrency={trip.baseCurrency} />
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>{t('stats.byPayer')}</h3>
        {s.byPayer.length ? (
          <div className="legend">
            {s.byPayer.map((p) => (
              <div className="l" key={p.key}>
                <i style={{ background: 'var(--brand)' }} />
                <span className="grow">
                  {p.key}
                  <span className="tiny"> · {t('common.count', { n: p.count })}</span>
                </span>
                <span className="amt">{formatAmount(p.amount, trip.baseCurrency)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>
            {t('stats.payerEmpty')}
          </p>
        )}
        {s.byPayer.length ? (
          <p className="tiny" style={{ marginTop: 'var(--sp-2)' }}>
            {t('stats.payerNote')}
          </p>
        ) : null}
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>{t('stats.byCurrency')}</h3>
        <table>
          <thead>
            <tr className="tiny" style={{ textAlign: 'left' }}>
              <th>{t('stats.colCurrency')}</th>
              <th>{t('stats.colCount')}</th>
              <th className="right">{t('stats.colOriginal')}</th>
              <th className="right">{t('stats.colBase', { code: trip.baseCurrency })}</th>
            </tr>
          </thead>
          <tbody>
            {s.byCurrency.map((b) => {
              const baseSum = expenses
                .filter((e) => e.currency === b.key)
                .reduce((sum, e) => sum + e.baseAmount, 0);
              return (
                <tr key={b.key}>
                  <td>
                    <strong>{b.key}</strong>
                  </td>
                  <td className="muted">{b.count}</td>
                  <td className="right num">{formatAmount(b.amount, b.key)}</td>
                  <td className="right num">{formatAmount(baseSum, trip.baseCurrency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {s.byCurrency.some((b) => b.key !== trip.baseCurrency) ? (
          <p className="tiny" style={{ marginTop: 'var(--sp-2)' }}>
            {t('stats.rateNote')}
          </p>
        ) : null}
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 'var(--sp-3)' }}>{t('stats.top5')}</h3>
        <div className="legend">
          {top.map((e) => (
            <div className="l" key={e.id}>
              <i style={{ background: catById.get(e.category)?.color ?? 'var(--brand)' }} />
              <span className="grow">
                {prettyDate(e.date)} ·{' '}
                {expenseLabel(e, catById.get(e.category))}
                {e.dayItemId && itemNames.get(e.dayItemId) ? (
                  <span className="tiny"> → {itemNames.get(e.dayItemId)}</span>
                ) : null}
              </span>
              <span className="amt">{formatAmount(e.baseAmount, trip.baseCurrency)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
