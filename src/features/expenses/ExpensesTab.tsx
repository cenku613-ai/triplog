import { useMemo, useState } from 'react';
import type { Category, DayItem, Expense, Trip } from '../../db/types';
import { formatAmount } from '../../db/currency';
import { prettyDate } from '../../lib/dates';
import { filterExpenses } from '../../lib/stats';
import { useI18n } from '../../i18n';
import { categoryChar, categoryLabel, expenseLabel } from '../../lib/labels';

export function ExpensesTab({
  trip,
  expenses,
  items,
  categories,
  onEdit,
}: {
  trip: Trip;
  expenses: Expense[];
  items: DayItem[];
  categories: Category[];
  onEdit: (expense: Expense) => void;
}) {
  const { t } = useI18n();
  const [cat, setCat] = useState('');
  const [payer, setPayer] = useState('');
  const [text, setText] = useState('');
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});

  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  /** 這趟旅行出現過的付款人（含名單外手打的名字） */
  const payers = useMemo(() => {
    const set = new Set<string>();
    for (const e of expenses) {
      const p = e.payee?.trim();
      if (p) set.add(p);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [expenses]);

  const filtered = useMemo(
    () =>
      filterExpenses(expenses, {
        category: cat || undefined,
        text: text || undefined,
        payee: payer || undefined,
      }),
    [expenses, cat, text, payer],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const e of [...filtered].sort(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
    )) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  const filteredTotal = filtered.reduce((s, e) => s + e.baseAmount, 0);

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 'var(--sp-3)' }}>
        <div className="grow" style={{ maxWidth: 260 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('expense.searchPlaceholder')}
            aria-label={t('expense.searchAria')}
          />
        </div>
        <div className="tiny" style={{ marginLeft: 'auto' }} role="status">
          {payer
            ? t('expense.payerTotal', { name: payer, amt: formatAmount(filteredTotal, trip.baseCurrency) })
            : t('expense.filteredTotal', { n: filtered.length, amt: formatAmount(filteredTotal, trip.baseCurrency) })}
        </div>
      </div>

      <div className="cat-picker">
        <button className="chip" aria-pressed={cat === ''} onClick={() => setCat('')}>
          {t('common.all')}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            className="chip"
            aria-pressed={cat === c.id}
            onClick={() => setCat((prev) => (prev === c.id ? '' : c.id))}
          >
            <span className="dot" style={{ color: c.color }} />
            {categoryLabel(c)}
          </button>
        ))}
      </div>

      {payers.length > 1 ? (
        <div className="cat-picker" role="group" aria-label={t('expense.payerAria')}>
          <button className="chip" aria-pressed={payer === ''} onClick={() => setPayer('')}>
            {t('expense.payerAll')}
          </button>
          {payers.map((p) => (
            <button
              key={p}
              className="chip"
              aria-pressed={payer === p}
              onClick={() => setPayer((prev) => (prev === p ? '' : p))}
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}

      {grouped.length === 0 ? (
        <div className="empty card">
          <div className="big">💸</div>
          <h3>{expenses.length === 0 ? t('expense.empty') : t('expense.noMatch')}</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            {expenses.length === 0 ? t('expense.emptyBody') : t('expense.noMatchBody')}
          </p>
        </div>
      ) : (
        <div className="stack-s">
          {grouped.map(([date, rows]) => {
            const dayTotal = rows.reduce((s, e) => s + e.baseAmount, 0);
            const expanded = openDays[date] === true && rows.length > 6;
            const shown = expanded ? rows : rows.slice(0, 6);
            return (
              <div className="card" key={date} style={{ overflow: 'hidden' }}>
                <div
                  className="row-between"
                  style={{
                    padding: '10px var(--sp-3)',
                    background: 'var(--surface-2)',
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  <span>{prettyDate(date)}</span>
                  <span className="num">{formatAmount(dayTotal, trip.baseCurrency)}</span>
                </div>
                {shown.map((e) => {
                  const c = catById.get(e.category);
                  const linkedItem = e.dayItemId ? itemById.get(e.dayItemId) : undefined;
                  return (
                    <button
                      key={e.id}
                      onClick={() => onEdit(e)}
                      className="exp-row"
                      style={{
                        width: '100%',
                        border: 0,
                        borderBottom: '1px solid var(--line)',
                        background: 'transparent',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        className="cat"
                        style={{ ['--cat-color' as string]: c?.color, background: c?.color ?? 'var(--brand)' }}
                        aria-hidden="true"
                      >
                        {categoryChar(c)}
                      </span>
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 600 }}>{expenseLabel(e, c)}</span>
                        <span className="tiny" style={{ display: 'block' }}>
                          {categoryLabel(c)}
                          {linkedItem ? ` · ${linkedItem.title}` : ''}
                          {e.payee ? ` · ${e.payee}` : ''}
                        </span>
                      </span>
                      <span className="money">
                        <span className="base">{formatAmount(e.baseAmount, trip.baseCurrency)}</span>
                        {e.currency !== trip.baseCurrency ? (
                          <span className="orig">
                            {formatAmount(e.amount, e.currency)} @ {e.rateToBase}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {rows.length > 6 && !expanded ? (
                  <button
                    className="btn btn-ghost btn-block"
                    style={{ borderRadius: 0, color: 'var(--brand)' }}
                    onClick={() => setOpenDays((p) => ({ ...p, [date]: true }))}
                  >
                    {t('expense.showAll', { n: rows.length })}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
