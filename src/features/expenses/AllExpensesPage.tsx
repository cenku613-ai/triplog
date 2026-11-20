import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import { listCategories } from '../../db/repo';
import type { Category, Expense, Trip } from '../../db/types';
import { formatAmount } from '../../db/currency';
import { prettyDate } from '../../lib/dates';
import { Empty } from '../../components/Controls';
import { ExpenseEditor } from './ExpenseEditor';
import { useI18n } from '../../i18n';
import { categoryChar, categoryLabel, expenseLabel } from '../../lib/labels';

/** 跨旅行的支出總覽：用來找「這季度花在哪」與補匯率 */
export function AllExpensesPage({ trips }: { trips: Trip[] }) {
  const { t } = useI18n();
  const expenses = useLive<Expense[]>(() => db.expenses.toArray(), [], []);
  const categories = useLive<Category[]>(() => listCategories('expense'), [], []);
  const [tripId, setTripId] = useState('');
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<Expense | null>(null);

  const tripById = useMemo(() => new Map(trips.map((x) => [x.id, x])), [trips]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return expenses
      .filter((e) => (!tripId || e.tripId === tripId) && (!cat || e.category === cat))
      .filter((e) => {
        if (!q) return true;
        const name = tripById.get(e.tripId)?.name ?? '';
        return `${e.note ?? ''} ${e.payee ?? ''} ${name} ${e.amount}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }, [expenses, tripId, cat, text, tripById]);

  // 沒有主幣別概念，這裡以各旅行自己的 baseCurrency 顯示，另給一個各趟小計的提示
  const baseByTrip = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of rows) map[e.tripId] = (map[e.tripId] ?? 0) + e.baseAmount;
    return map;
  }, [rows]);

  return (
    <>
      <div className="row-between wrap" style={{ marginBottom: 'var(--sp-4)' }}>
        <div>
          <h1>{t('expense.allTitle')}</h1>
          <p className="muted" style={{ fontSize: 14 }}>
            {t('expense.allSummary', { n: rows.length })}
          </p>
        </div>
      </div>

      <div className="row wrap card card-pad" style={{ marginBottom: 'var(--sp-4)', gap: 'var(--sp-3)' }}>
        <select
          value={tripId}
          onChange={(e) => setTripId(e.target.value)}
          aria-label={t('expense.allTripAria')}
          style={{ width: 'auto', minWidth: 160 }}
        >
          <option value="">{t('expense.allTrips')}</option>
          {trips.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          aria-label={t('expense.allCatAria')}
          style={{ width: 'auto', minWidth: 130 }}
        >
          <option value="">{t('expense.allCats')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        <input
          className="grow"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('expense.allSearchPlaceholder')}
          aria-label={t('expense.searchAria')}
          style={{ minWidth: 180 }}
        />
      </div>

      {Object.keys(baseByTrip).length > 0 ? (
        <div className="row wrap tiny" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
          {Object.entries(baseByTrip).map(([id, sum]) => (
            <span className="chip" key={id}>
              {tripById.get(id)?.name ?? t('expense.tripDeleted')}
              <strong>{formatAmount(sum, tripById.get(id)?.baseCurrency ?? 'TWD')}</strong>
            </span>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty
          icon="💸"
          title={expenses.length === 0 ? t('expense.noneAtAll') : t('expense.noMatch')}
          body={expenses.length === 0 ? t('expense.noneAtAllBody') : t('expense.noMatchBody')}
          action={
            expenses.length === 0 ? (
              <Link className="btn btn-primary" to="/">
                {t('expense.createTripFirst')}
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {rows.slice(0, 300).map((e) => {
            const c = catById.get(e.category);
            const tr = tripById.get(e.tripId);
            return (
              <button
                key={e.id}
                className="exp-row"
                style={{
                  width: '100%',
                  border: 0,
                  borderBottom: '1px solid var(--line)',
                  background: 'transparent',
                  textAlign: 'left',
                }}
                onClick={() => setEditing(e)}
              >
                <span className="cat" style={{ background: c?.color ?? 'var(--brand)' }} aria-hidden="true">
                  {categoryChar(c)}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{expenseLabel(e, c)}</span>
                  <span className="tiny" style={{ display: 'block' }}>
                    {prettyDate(e.date, { withYear: true })} ·{' '}
                    {tr?.name ?? t('expense.tripGone')} · {categoryLabel(c)}
                  </span>
                </span>
                <span className="money">
                  <span className="base">{formatAmount(e.baseAmount, tr?.baseCurrency ?? e.currency)}</span>
                  {tr && e.currency !== tr.baseCurrency ? (
                    <span className="orig">{formatAmount(e.amount, e.currency)}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {editing ? (
        <ExpenseEditor
          trips={trips}
          expense={editing}
          trip={tripById.get(editing.tripId) ?? null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
