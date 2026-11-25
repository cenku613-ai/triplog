import { useMemo, useState } from 'react';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import { deleteExpense, moveDayItem, photosByItem } from '../../db/repo';
import type { Category, DayItem, Expense, Photo, Trip } from '../../db/types';
import { PhotoViewer, Thumb, savedShots, type Shot } from '../../components/Photos';
import { formatAmount } from '../../db/currency';
import { dateRange, dayIndex, dayLabel, formatDuration, prettyDate } from '../../lib/dates';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { categoryChar, categoryLabel, expenseLabel } from '../../lib/labels';
import { NavigationLink } from '../../components/NavigationLink';

const NO_PHOTOS: Photo[] = [];
const EMPTY_MAP = new Map<string, Photo[]>();

export function ItineraryTab({
  trip,
  items,
  expenses,
  categories,
  onAddItem,
  onEditItem,
  onAddExpense,
}: {
  trip: Trip;
  items: DayItem[];
  expenses: Expense[];
  categories: Category[];
  onAddItem: (opts: { date?: string }) => void;
  onEditItem: (opts: { item: DayItem; date?: string }) => void;
  onAddExpense: (itemId: string | null, date: string) => void;
}) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  /** 行程項 -> 照片，一次抓好，列表里就不必每項開一次查詢 */
  const photoMap = useLive<Map<string, Photo[]>>(() => photosByItem(trip.id), [trip.id], EMPTY_MAP);
  const [viewer, setViewer] = useState<{ shots: Shot[]; index: number } | null>(null);
  const itemCategories = useLive(() => db.categories.where('kind').equals('item').toArray(), [], []);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const kindColor = (key: string) =>
    itemCategories.find((c) => c.key === key)?.color ?? 'var(--brand)';
  const kindLabel = (key: string) => {
    const c = itemCategories.find((x) => x.key === key);
    return c ? categoryLabel(c) : key;
  };

  const days = useMemo(() => dateRange(trip.startDate, trip.endDate), [trip.startDate, trip.endDate]);
  const byDate = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    for (const it of [...items].sort(
      (a, b) => a.order - b.order || (a.startTime ?? '99').localeCompare(b.startTime ?? '99'),
    )) {
      const arr = map.get(it.date) ?? [];
      arr.push(it);
      map.set(it.date, arr);
    }
    return map;
  }, [items]);

  const dayTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) map.set(e.date, (map.get(e.date) ?? 0) + e.baseAmount);
    return map;
  }, [expenses]);

  const itemTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) {
      if (e.dayItemId) map.set(e.dayItemId, (map.get(e.dayItemId) ?? 0) + e.baseAmount);
    }
    return map;
  }, [expenses]);

  const linked = (itemId: string) => expenses.filter((e) => e.dayItemId === itemId);

  return (
    <div>
      {days.map((date) => {
        const rows = byDate.get(date) ?? [];
        const total = dayTotals.get(date) ?? 0;
        const idx = dayIndex(trip.startDate, date) ?? 1;
        return (
          <section className="day-group" key={date} aria-label={t('day.aria', { date: prettyDate(date) })}>
            <div className="day-head">
              <span className="d">
                {dayLabel(idx)} · {prettyDate(date)}
              </span>
              <span className="sum">{total > 0 ? formatAmount(total, trip.baseCurrency) : t('item.dayEmpty')}</span>
              <button className="btn btn-sm" onClick={() => onAddItem({ date })}>
                {t('item.addBtn')}
              </button>
            </div>

            {rows.length === 0 ? (
              <button
                className="btn btn-block"
                style={{ borderStyle: 'dashed', color: 'var(--text-3)', background: 'transparent' }}
                onClick={() => onAddItem({ date })}
              >
                {t('item.emptyDay')}
              </button>
            ) : (
              <div className="timeline">
                {rows.map((it, i) => (
                  <article
                    className="tl-item"
                    key={it.id}
                    style={{ ['--item-color' as string]: kindColor(it.kind) }}
                  >
                    <div className="time">{it.startTime || '—'}</div>
                    <div className="body">
                      <div className="t">{it.title}</div>
                      <div className="sub">
                        <span className="chip" style={{ color: kindColor(it.kind) }}>
                          {kindLabel(it.kind)}
                        </span>
                        {formatDuration(it.startTime, it.endTime) ? ` ${formatDuration(it.startTime, it.endTime)}` : ''}
                        {it.location ? ` · ${it.location}` : ''}
                        {it.note ? ` · ${it.note}` : ''}
                      </div>
                      <NavigationLink lat={it.lat} lng={it.lng} title={it.title} />
                      {linked(it.id).length > 0 ? (
                        <div className="sub">
                          <span className="badge" style={{ color: 'var(--brand-strong)' }}>
                            {t('item.linkedBadge', {
                              n: linked(it.id).length,
                              amt: formatAmount(itemTotals.get(it.id) ?? 0, trip.baseCurrency),
                            })}
                          </span>
                        </div>
                      ) : null}
                      <ItemPhotos
                        photos={photoMap.get(it.id) ?? NO_PHOTOS}
                        onOpen={(shots, index) => setViewer({ shots, index })}
                      />
                    </div>
                    <div className="tools">
                      <button
                        className="icon-btn"
                        title={t('item.expenseForTitle')}
                        aria-label={t('item.expenseForAria', { title: it.title })}
                        onClick={() => onAddExpense(it.id, it.date)}
                      >
                        $
                      </button>
                      <button
                        className="icon-btn"
                        title={t('common.edit')}
                        aria-label={t('item.editAria')}
                        onClick={() => onEditItem({ item: it })}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        title={t('item.moveUp')}
                        aria-label={t('item.moveUp')}
                        disabled={i === 0}
                        onClick={() => void moveDayItem(it.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn"
                        title={t('item.moveDown')}
                        aria-label={t('item.moveDown')}
                        disabled={i === rows.length - 1}
                        onClick={() => void moveDayItem(it.id, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {/* 這天沒關聯到任何行程項的支出 */}
            <div className="stack-s" style={{ marginTop: 'var(--sp-2)' }}>
              {expenses
                .filter((e) => e.date === date && !e.dayItemId)
                .slice(0, 6)
                .map((e) => {
                  const c = catById.get(e.category);
                  return (
                    <div
                      className="exp-row"
                      key={e.id}
                      style={{ border: 0, background: 'transparent', paddingInline: 0 }}
                    >
                      <span
                        className="cat"
                        style={{
                          ['--cat-color' as string]: c?.color ?? 'var(--brand)',
                          background: c?.color,
                        }}
                      >
                        {categoryChar(c)}
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{expenseLabel(e, c)}</div>
                        <div className="tiny">
                          {categoryLabel(c)} · {t('item.unlinked')}
                        </div>
                      </div>
                      <div className="money">
                        <span className="base">{formatAmount(e.baseAmount, trip.baseCurrency)}</span>
                        {e.currency !== trip.baseCurrency ? (
                          <span className="orig">{formatAmount(e.amount, e.currency)}</span>
                        ) : null}
                      </div>
                      <button
                        className="icon-btn"
                        title={t('expense.deleteQ')}
                        aria-label={t('common.delete')}
                        onClick={async () => {
                          if (await ask(t('expense.deleteQ'), { confirmLabel: t('common.delete'), danger: true })) {
                            await deleteExpense(e.id);
                            toast(t('expense.deleted'));
                          }
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
            </div>
          </section>
        );
      })}

      {viewer ? (
        <PhotoViewer
          shots={viewer.shots}
          index={viewer.index}
          onIndex={(n) => setViewer((v) => (v ? { ...v, index: n } : v))}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  );
}

/** 行程項下面那一排縮圖；點開就是大圖檢視 */
function ItemPhotos({
  photos,
  onOpen,
}: {
  photos: Photo[];
  onOpen: (shots: Shot[], index: number) => void;
}) {
  const { t } = useI18n();
  if (photos.length === 0) return null;
  const shots = savedShots(photos);
  return (
    <div className="thumb-row">
      {photos.slice(0, 5).map((p, i) => (
        <button
          type="button"
          key={p.id}
          className="thumb-btn"
          aria-label={t('photo.openAria')}
          title={p.caption ?? ''}
          onClick={() => onOpen(shots, i)}
        >
          <Thumb blob={p.thumb} alt="" />
        </button>
      ))}
      <span className="tiny">{t('photo.count', { n: photos.length })}</span>
    </div>
  );
}
