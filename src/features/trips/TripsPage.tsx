import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import type { Expense, Trip } from '../../db/types';
import { formatAmount } from '../../db/currency';
import { Empty } from '../../components/Controls';
import { TripEditor } from './TripEditor';
import { dayIndex, prettyDate, today } from '../../lib/dates';
import { useI18n } from '../../i18n';

export function TripsPage() {
  const nav = useNavigate();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const creating = params.get('new') === '1';
  const savedRef = useRef('');

  const openNew = () => {
    const next = new URLSearchParams(params);
    next.set('new', '1');
    setParams(next, { replace: true });
  };

  const trips = useLive<Trip[]>(() => db.trips.toArray(), [], []);
  const expenses = useLive<Expense[]>(() => db.expenses.toArray(), [], []);
  const itemCounts = useLive<Record<string, number>>(
    async () => {
      const rows = await db.dayItems.toArray();
      return rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.tripId] = (acc[r.tripId] ?? 0) + 1;
        return acc;
      }, {});
    },
    [],
    {},
  );

  const totals = useMemo(() => {
    const map: Record<string, { spent: number; count: number; lastDate: string }> = {};
    for (const e of expenses) {
      const s = (map[e.tripId] ??= { spent: 0, count: 0, lastDate: '' });
      s.spent += e.baseAmount;
      s.count += 1;
      if (e.date > s.lastDate) s.lastDate = e.date;
    }
    return map;
  }, [expenses]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return trips
      .filter((x) => (showArchived ? x.archived : !x.archived))
      .filter(
        (x) =>
          !q ||
          x.name.toLowerCase().includes(q) ||
          (x.notes ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) =>
        showArchived
          ? b.updatedAt.localeCompare(a.updatedAt)
          : b.startDate.localeCompare(a.startDate),
      );
  }, [trips, query, showArchived]);

  const status = (x: Trip): { label: string; tone: string } => {
    const now = today();
    if (x.archived) return { label: t('trips.statusArchived'), tone: 'var(--text-3)' };
    if (now < x.startDate)
      return { label: t('trips.statusUpcoming', { n: diff(x.startDate, now) }), tone: 'var(--brand)' };
    if (now > x.endDate) return { label: t('trips.statusEnded'), tone: 'var(--text-3)' };
    return {
      label: t('trips.statusOngoing', { n: dayIndex(x.startDate, now) ?? 1 }),
      tone: 'var(--accent)',
    };
  };

  return (
    <>
      <div className="row-between wrap" style={{ marginBottom: 'var(--sp-4)' }}>
        <div>
          <h1>{t('trips.title')}</h1>
          <p className="muted" style={{ fontSize: 14 }}>
            {t('trips.summary', {
              active: trips.filter((x) => !x.archived).length,
              expenses: expenses.length,
            })}
          </p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>
          {t('trips.new')}
        </button>
      </div>

      {trips.length > 0 ? (
        <div className="row wrap" style={{ marginBottom: 'var(--sp-4)', gap: 'var(--sp-3)' }}>
          <div className="grow" style={{ maxWidth: 320 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('trips.searchPlaceholder')}
              aria-label={t('trips.searchAria')}
            />
          </div>
          <button
            className="chip"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            <span className="dot" />
            {t('trips.showArchived', { n: trips.filter((x) => x.archived).length })}
          </button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <Empty
          title={showArchived ? t('trips.emptyArchived') : t('trips.empty')}
          body={showArchived ? t('trips.emptyArchivedBody') : t('trips.emptyBody')}
          action={
            showArchived ? null : (
              <button className="btn btn-primary" onClick={openNew}>
                {t('trips.createFirst')}
              </button>
            )
          }
        />
      ) : (
        <div className="trips-grid">
          {visible.map((x) => {
            const sum = totals[x.id];
            const st = status(x);
            return (
              <Link
                key={x.id}
                to={`/t/${x.id}`}
                className="trip-card"
                style={{ ['--trip-color' as string]: x.color }}
              >
                <div className="row-between">
                  <span className="name">{x.name}</span>
                  <span className="badge" style={{ color: st.tone }}>
                    {st.label}
                  </span>
                </div>
                <div className="meta">
                  <span>
                    {prettyDate(x.startDate, { withYear: true })} –{' '}
                    {prettyDate(x.endDate, { withYear: true })}
                  </span>
                  <span>{t('trips.itemCount', { n: itemCounts[x.id] ?? 0 })}</span>
                  <span>{t('trips.expenseCount', { n: sum?.count ?? 0 })}</span>
                  {x.companions?.length ? (
                    <span>{t('trip.companionCount', { n: x.companions.length })}</span>
                  ) : null}
                </div>
                <div className="amount">
                  {formatAmount(sum?.spent ?? 0, x.baseCurrency)}
                  {x.budget ? (
                    <span className="tiny" style={{ fontWeight: 500 }}>
                      {'  /  '}
                      {formatAmount(x.budget, x.baseCurrency)}
                    </span>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {creating ? (
        <TripEditor
          onClose={() => {
            const saved = savedRef.current;
            savedRef.current = '';
            const next = new URLSearchParams(params);
            next.delete('new');
            setParams(next, { replace: true });
            if (saved) nav(`/t/${saved}`);
          }}
          onSaved={(id) => {
            savedRef.current = id;
          }}
        />
      ) : null}
    </>
  );
}

function diff(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((a - b) / 86_400_000));
}
