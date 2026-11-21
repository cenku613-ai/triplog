import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import { listCategories } from '../../db/repo';
import type { Category, DayItem, Expense, Trip } from '../../db/types';
import { ItineraryTab } from '../itinerary/ItineraryTab';
import { ExpensesTab } from '../expenses/ExpensesTab';
import { StatsTab } from '../stats/StatsTab';
/** Leaflet 約 40 KB gzip，沒開地圖頁就不必跟著首頻一起載 */
const MapTab = lazy(() => import('./MapTab').then((m) => ({ default: m.MapTab })));
/** PDF 文件會順帶拉進地圖擷取（Leaflet），所以連對話框一起延後載入 */
const PrintDialog = lazy(() => import('./PrintDialog').then((m) => ({ default: m.PrintDialog })));
import { ExpenseEditor } from '../expenses/ExpenseEditor';
import { DayItemEditor } from '../itinerary/DayItemEditor';
import { TripEditor } from '../trips/TripEditor';
import { Empty } from '../../components/Controls';
import { deleteTrip, updateTrip } from '../../db/repo';
import { formatAmount } from '../../db/currency';
import { numericDate, prettyDate, today } from '../../lib/dates';
import { summarize } from '../../lib/stats';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';

type Tab = 'plan' | 'money' | 'stats' | 'map';

export function TripDetailPage() {
  const { tripId = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'plan';
  const { toast, ask } = useUi();
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState<null | 'trip' | 'item' | 'expense'>(null);
  const [targetItem, setTargetItem] = useState<DayItem | null>(null);
  const [targetExpense, setTargetExpense] = useState<Expense | null>(null);
  const [presetDate, setPresetDate] = useState<string>('');
  const [presetItemId, setPresetItemId] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  const TABS: { id: Tab; label: string }[] = [
    { id: 'plan', label: t('tab.plan') },
    { id: 'money', label: t('tab.money') },
    { id: 'stats', label: t('tab.stats') },
    { id: 'map', label: t('tab.map') },
  ];

  const trip = useLive<Trip | undefined>(() => db.trips.get(tripId), [tripId], undefined);
  const items = useLive<DayItem[]>(
    () => db.dayItems.where('tripId').equals(tripId).sortBy('date'),
    [tripId],
    [],
  );
  const expenses = useLive<Expense[]>(
    () => db.expenses.where('tripId').equals(tripId).toArray(),
    [tripId],
    [],
  );
  const categories = useLive<Category[]>(() => listCategories('expense'), [], []);
  const trips = useLive<Trip[]>(() => db.trips.toArray(), [], []);

  const summary = useMemo(
    () => (trip ? summarize(trip, expenses, categories, items) : null),
    // 語言換掉時 labels 要重算，否則圖表提示會留著上一種語言
    [trip, expenses, categories, items, lang],
  );

  if (!trip) {
    return (
      <Empty
        icon="🧭"
        title={t('trip.notFound')}
        body={t('trip.notFoundBody')}
        action={
          <Link className="btn btn-primary" to="/">
            {t('trip.backToList')}
          </Link>
        }
      />
    );
  }

  const openExpense = (opts: { expense?: Expense | null; date?: string; itemId?: string | null } = {}) => {
    setTargetExpense(opts.expense ?? null);
    setPresetDate(opts.date ?? (today() >= trip.startDate && today() <= trip.endDate ? today() : trip.startDate));
    setPresetItemId(opts.itemId ?? null);
    setEditing('expense');
  };

  const openItem = (opts: { item?: DayItem | null; date?: string } = {}) => {
    setTargetItem(opts.item ?? null);
    setPresetDate(opts.date ?? trip.startDate);
    setEditing('item');
  };

  return (
    <>
      <div className="row-between wrap" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <div className="row" style={{ minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{ width: 10, height: 34, borderRadius: 6, background: trip.color, flex: '0 0 10px' }}
          />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {trip.name}
            </h1>
            <div className="tiny">
              {prettyDate(trip.startDate, { withYear: true })} –{' '}
              {prettyDate(trip.endDate, { withYear: true })}
              {' · '}
              {formatAmount(summary?.totalBase ?? 0, trip.baseCurrency)}
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => setPrinting(true)} title={t('print.title')}>
            🖨 {t('print.menu')}
          </button>
          <button className="btn btn-sm" onClick={() => setEditing('trip')}>
            {t('common.edit')}
          </button>
          <button
            className="btn btn-sm"
            onClick={async () => {
              const next = !trip.archived;
              await updateTrip(trip.id, { archived: next });
              toast(next ? t('trip.archived') : t('trip.unarchived'));
            }}
          >
            {trip.archived ? t('trip.unarchive') : t('trip.archive')}
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={async () => {
              if (
                await ask(t('trip.deleteQ', { name: trip.name }), {
                  confirmLabel: t('trip.deleteForever'),
                  danger: true,
                })
              ) {
                await deleteTrip(trip.id);
                toast(t('trip.deleted'));
                nav('/');
              }
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist" style={{ marginBottom: 'var(--sp-4)' }}>
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('tab', x.id);
              setParams(next, { replace: true });
            }}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="trip-cols">
        <div style={{ minWidth: 0 }}>
          {tab === 'plan' ? (
            <ItineraryTab
              trip={trip}
              items={items}
              expenses={expenses}
              categories={categories}
              onAddItem={openItem}
              onEditItem={openItem}
              onAddExpense={(itemId, date) => openExpense({ itemId, date })}
            />
          ) : null}
          {tab === 'money' ? (
            <ExpensesTab
              trip={trip}
              expenses={expenses}
              items={items}
              categories={categories}
              onEdit={(e) => openExpense({ expense: e })}
            />
          ) : null}
          {tab === 'stats' ? (
            <StatsTab trip={trip} expenses={expenses} items={items} categories={categories} />
          ) : null}
          {tab === 'map' ? (
            <Suspense fallback={<div className="tiny">{t('map.loading')}</div>}>
              <MapTab trip={trip} items={items} onOpen={(it) => openItem({ item: it })} />
            </Suspense>
          ) : null}
        </div>

        <aside className="card card-pad" aria-label={t('detail.summaryAria')}>
          <div className="stack">
            <div className="row-between">
              <h3>{t('detail.summaryTitle')}</h3>
              <span className="badge">{trip.baseCurrency}</span>
            </div>
            {trip.companions?.length ? (
              <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
                <span className="tiny">{t('trip.companionCount', { n: trip.companions.length })}</span>
                {trip.companions.map((n) => (
                  <span className="chip" key={n}>
                    {n}
                  </span>
                ))}
              </div>
            ) : null}
            <div>
              <div className="k tiny">{t('detail.spent')}</div>
              <div className="v" style={{ fontSize: 26, fontWeight: 800 }} role="status">
                {formatAmount(summary?.totalBase ?? 0, trip.baseCurrency)}
              </div>
            </div>
            {summary?.budget ? (
              <div>
                <div className="bar" style={{ marginTop: 6 }}>
                  <span
                    style={{
                      width: `${Math.min(1, summary.totalBase / summary.budget) * 100}%`,
                      background:
                        summary.totalBase > summary.budget ? 'var(--danger)' : 'var(--brand)',
                    }}
                  />
                </div>
                <div className="tiny">
                  {t('detail.budgetLine', { amt: formatAmount(summary.budget, trip.baseCurrency) })}
                  {summary.remaining !== null && summary.remaining < 0
                    ? ` · ${t('detail.over', { amt: formatAmount(-summary.remaining, trip.baseCurrency) })}`
                    : summary.remaining !== null
                      ? ` · ${t('detail.left', { amt: formatAmount(summary.remaining, trip.baseCurrency) })}`
                      : ''}
                </div>
              </div>
            ) : null}
            <div className="grid2">
              <div className="tile">
                <div className="k">{t('detail.itemsTile')}</div>
                <div className="v">{items.length}</div>
              </div>
              <div className="tile">
                <div className="k">{t('detail.expensesTile')}</div>
                <div className="v">{expenses.length}</div>
              </div>
              <div className="tile">
                <div className="k">{t('detail.perDayTile')}</div>
                <div className="v" style={{ fontSize: 16 }}>
                  {formatAmount(summary?.perDayAverage ?? 0, trip.baseCurrency)}
                </div>
              </div>
              <div className="tile">
                <div className="k">{t('detail.maxDayTile')}</div>
                <div className="v" style={{ fontSize: 16 }}>
                  {summary?.maxDay && summary.maxDay.count > 0 ? numericDate(summary.maxDay.date) : '—'}
                </div>
              </div>
            </div>
            <div className="stack-s">
              <button className="btn btn-primary btn-block" onClick={() => openExpense()}>
                {t('detail.addExpense')}
              </button>
              <button className="btn btn-block" onClick={() => openItem()}>
                {t('detail.addItem')}
              </button>
            </div>
            {trip.notes ? (
              <p className="tiny" style={{ whiteSpace: 'pre-wrap' }}>
                {trip.notes}
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      {editing === 'expense' ? (
        <ExpenseEditor
          trips={trips}
          trip={trip}
          expense={targetExpense}
          defaultDate={presetDate}
          defaultDayItemId={presetItemId}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing === 'item' ? (
        <DayItemEditor
          trip={trip}
          item={targetItem}
          defaultDate={presetDate || trip.startDate}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {editing === 'trip' ? (
        <TripEditor trip={trip} onClose={() => setEditing(null)} />
      ) : null}
      {printing ? (
        <Suspense fallback={null}>
          <PrintDialog
            trip={trip}
            items={items}
            expenses={expenses}
            categories={categories}
            summary={summary!}
            onClose={() => setPrinting(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
