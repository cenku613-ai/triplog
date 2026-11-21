import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmHost, ToastHost } from '../../components/Feedback';
import { Empty } from '../../components/Controls';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { DayItem } from '../../db/types';
import { builtinKindLabel, categoryChar, categoryLabel, expenseLabel } from '../../lib/labels';
import { formatAmount } from '../../db/currency';
import { dateRange, dayIndex, dayLabel, formatDuration, prettyDate } from '../../lib/dates';
import { ExpenseForm, ItemForm } from './ShareForms';
import {
  describeShareError,
  fetchShare,
  loadViewerName,
  type ShareView,
} from '../../lib/share';

/**
 * 同行者看到的頁面（#/share/<token>）。
 *
 * 這一頁不在 Shell 裡：沒有側欄、沒有別的旅行、不讀 IndexedDB。
 * 資料全部來自 /api/share/<token>，那一側已經把範圍鎖在一趟旅行、
 * 也把照片隔在外面，所以這裡拿到什麼就顯示什麼，不需要再做過濾。
 * 離線時會退回上次載入的副本（sessionStorage，關掉分頁就沒了），
 * 但連結被作廢或到期時一定顯示錯誤——那時候「還看得到舊內容」是漏洞不是善意。
 */

const CACHE_PREFIX = 'triplog:share:view:';
const STALE_CODES = new Set(['offline', 'network']);

function readCache(token: string): ShareView | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + token);
    return raw ? (JSON.parse(raw) as ShareView) : null;
  } catch {
    return null;
  }
}

function writeCache(token: string, view: ShareView): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + token, JSON.stringify(view));
  } catch {
    /* 塞不進去就當沒有備援，不影響頁面 */
  }
}

const shortWhen = (iso: string, locale: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
};

export function SharePage({ token }: { token: string }) {
  const { toast } = useUi();
  const { t, lang, setLang, locale } = useI18n();
  const [view, setView] = useState<ShareView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  /** 顯示的是上次載入的副本：讓人家知道這可能不是最新 */
  const [stale, setStale] = useState(false);
  const [tab, setTab] = useState<'plan' | 'money'>('plan');
  const [form, setForm] = useState<null | 'item' | 'expense'>(null);
  const [who, setWho] = useState(() => loadViewerName());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setStatus('loading');
      try {
        const next = await fetchShare(token);
        setView(next);
        setStale(false);
        setStatus('ready');
        writeCache(token, next);
        return next;
      } catch (err) {
        const code = (err as { code?: string })?.code ?? 'server';
        const cached = STALE_CODES.has(code) ? readCache(token) : null;
        if (cached) {
          setView(cached);
          setStale(true);
          setStatus('ready');
        } else {
          setView(null);
          setError(describeShareError(err, t));
          setStatus('error');
        }
        return null;
      }
    },
    [token, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const set = (v: boolean) => () => setOnline(v);
    const up = set(true);
    const down = set(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const days = useMemo(() => {
    if (!view) return [];
    const set = new Set<string>(dateRange(view.trip.startDate, view.trip.endDate));
    for (const it of view.items) set.add(it.date);
    for (const e of view.expenses) set.add(e.date);
    return [...set].sort();
  }, [view]);

  const byDate = useMemo(() => {
    const map = new Map<string, DayItem[]>();
    if (!view) return map;
    for (const it of [...view.items].sort(
      (a, b) => a.order - b.order || (a.startTime ?? '99').localeCompare(b.startTime ?? '99'),
    )) {
      const arr = map.get(it.date) ?? [];
      arr.push(it);
      map.set(it.date, arr);
    }
    return map;
  }, [view]);

  const kindRows = useMemo(() => (view?.categories ?? []).filter((c) => c.kind === 'item'), [view]);
  const catById = useMemo(() => new Map((view?.categories ?? []).map((c) => [c.id, c])), [view]);
  const kindColor = (key: string) => kindRows.find((c) => c.key === key)?.color ?? 'var(--brand)';
  const kindLabel = (key: string) => {
    const c = kindRows.find((x) => x.key === key);
    // 擁有者還沒把分類推上伺服器時清單是空的，這時照介面語言翻成「景點」，
    // 別讓同行者看到 sight 這種 key
    return c ? categoryLabel(c) : builtinKindLabel('item', key);
  };

  const payees = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of view?.expenses ?? []) {
      const name = (e.payee ?? '').trim();
      if (name) map.set(name, (map.get(name) ?? 0) + e.baseAmount);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [view]);

  const afterSaved = async () => {
    setForm(null);
    toast(t('share.sent'));
    await load({ silent: true });
  };

  const toggleLang = () => setLang(lang === 'en' ? 'zh-Hant' : 'en');

  return (
    <>
      <header className="topbar">
        <span className="title">{t('share.pageTitle')}</span>
        {!online ? <span className="badge">{t('net.offline')}</span> : null}
        <div className="actions">
          <button className="btn btn-sm" onClick={toggleLang}>
            {lang === 'en' ? '繁體' : 'EN'}
          </button>
          <button className="btn btn-sm" onClick={() => void load()}>
            ⟳ {t('share.refresh')}
          </button>
        </div>
      </header>

      <main className="page share-page">
        {status === 'loading' ? (
          <div className="card card-pad">
            <span className="tiny">{t('share.sending')}</span>
          </div>
        ) : null}

        {status === 'error' ? (
          <Empty
            icon="🔒"
            title={t('share.pageTitle')}
            body={error}
            action={
              <button className="btn btn-primary" onClick={() => void load()}>
                {t('share.refresh')}
              </button>
            }
          />
        ) : null}

        {view && status === 'ready' ? (
          <div className="stack">
            <section className="card card-pad stack-s">
              <div className="row-between">
                <h1 style={{ margin: 0, fontSize: '1.2rem' }}>{view.trip.name}</h1>
                <span className="badge" style={{ color: view.trip.color }}>
                  {t('share.pageTitle')}
                </span>
              </div>
              <div className="tiny">
                {prettyDate(view.trip.startDate, { withYear: true })} – {prettyDate(view.trip.endDate, { withYear: true })}
                {' · '}
                {t('share.summary', {
                  items: view.totals.items,
                  expenses: view.totals.expenses,
                  amt: formatAmount(view.totals.baseAmount, view.trip.baseCurrency),
                })}
              </div>
              {view.totals.lastWrite ? (
                <div className="tiny">{t('share.updatedAt', { when: shortWhen(view.totals.lastWrite, locale) })}</div>
              ) : null}
              {stale ? <span className="badge">{t('share.stale')}</span> : null}
              <div className="row wrap" style={{ marginTop: 'var(--sp-2)' }}>
                <button className="btn btn-sm btn-primary" onClick={() => setForm('expense')}>
                  {t('share.addSpend')}
                </button>
                <button className="btn btn-sm" onClick={() => setForm('item')}>
                  {t('share.addItem')}
                </button>
              </div>
            </section>

            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'plan'} onClick={() => setTab('plan')}>
                {t('tab.plan')}
              </button>
              <button role="tab" aria-selected={tab === 'money'} onClick={() => setTab('money')}>
                {t('tab.money')}
              </button>
            </div>

            {tab === 'plan' ? (
              <div className="stack">
                {view.items.length === 0 ? <p className="muted">{t('share.noItems')}</p> : null}
                {days.map((date) => {
                  const rows = byDate.get(date) ?? [];
                  if (rows.length === 0) return null;
                  const idx = dayIndex(view.trip.startDate, date);
                  return (
                    <section className="day-group" key={date} aria-label={t('day.aria', { date: prettyDate(date) })}>
                      <div className="day-head">
                        <span className="d">
                          {idx ? dayLabel(idx) : ''} · {prettyDate(date)}
                        </span>
                      </div>
                      <div className="timeline">
                        {rows.map((it) => (
                          <article className="tl-item" key={it.id} style={{ ['--item-color' as string]: kindColor(it.kind) }}>
                            <div className="time">{it.startTime || '—'}</div>
                            <div className="body">
                              <div className="t">{it.title}</div>
                              <div className="sub">
                                <span className="chip" style={{ color: kindColor(it.kind) }}>
                                  {kindLabel(it.kind)}
                                </span>
                                {formatDuration(it.startTime, it.endTime)
                                  ? ` ${formatDuration(it.startTime, it.endTime)}`
                                  : ''}
                                {it.location ? ` · ${it.location}` : ''}
                                {it.note ? ` · ${it.note}` : ''}
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="stack">
                {view.expenses.length === 0 ? (
                  <p className="muted">{t('share.noSpend')}</p>
                ) : (
                  <div className="stack-s">
                    {view.expenses.map((e) => {
                      const c = catById.get(e.category);
                      return (
                        <div className="exp-row" key={e.id}>
                          <span
                            className="cat"
                            style={{ ['--cat-color' as string]: c?.color ?? 'var(--brand)', background: c?.color }}
                          >
                            {categoryChar(c)}
                          </span>
                          <div className="grow" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{expenseLabel(e, c)}</div>
                            <div className="tiny">
                              {prettyDate(e.date)} · {categoryLabel(c)}
                              {e.payee ? ` · ${t('expense.payeeBy', { name: e.payee })}` : ''}
                            </div>
                          </div>
                          <div className="money">
                            <span className="base">{formatAmount(e.baseAmount, view.trip.baseCurrency)}</span>
                            {e.currency !== view.trip.baseCurrency ? (
                              <span className="orig">{formatAmount(e.amount, e.currency)}</span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {payees.length > 0 ? (
                  <section className="card card-pad stack-s">
                    <strong>{t('share.payeesTitle')}</strong>
                    {payees.map(([name, amt]) => (
                      <div className="row-between" key={name}>
                        <span>{name}</span>
                        <span className="money">
                          <span className="base">{formatAmount(amt, view.trip.baseCurrency)}</span>
                        </span>
                      </div>
                    ))}
                    <p className="tiny" style={{ margin: 0 }}>
                      {t('stats.payerNote')}
                    </p>
                  </section>
                ) : null}
              </div>
            )}

            <p className="tiny" style={{ margin: 0 }}>
              {t('share.noteMerge')}
            </p>
          </div>
        ) : null}
      </main>

      {view && form === 'expense' ? (
        <ExpenseForm
          token={token}
          view={view}
          who={who}
          onWho={setWho}
          onClose={() => setForm(null)}
          onSaved={() => void afterSaved()}
        />
      ) : null}
      {view && form === 'item' ? (
        <ItemForm
          token={token}
          view={view}
          who={who}
          onClose={() => setForm(null)}
          onSaved={() => void afterSaved()}
        />
      ) : null}

      <ToastHost />
      <ConfirmHost />
    </>
  );
}
