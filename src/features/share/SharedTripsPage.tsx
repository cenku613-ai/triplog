import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../../components/Controls';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { DayItem, Trip } from '../../db/types';
import { builtinKindLabel, categoryLabel } from '../../lib/labels';
import { today } from '../../lib/dates';
import { loadSyncConfig } from '../../lib/sync';
import { loadAccount } from '../../lib/account';
import { isSessionToken } from '../../lib/tokens';
import {
  describeInviteError,
  fetchSharedTrip,
  leaveInvite,
  myInvites,
  pushSharedExpense,
  pushSharedItem,
  type InviteRow,
  type SharedTripView,
} from '../../lib/invites';

/**
 * 受邀者那一側：別人邀我一起記的旅行。
 *
 * 這一頁不讀 IndexedDB，也不往本機寫任何一筆。共筆的資料只有一個家——邀請人那份帳本，
 * 在這裡看到的就是那一趟現在的樣子；按下去記的那一筆也是直接寫進他的帳本，
 * 他下次同步就收到。這樣兩個人不會各持一份同名的旅行，也免掉了合併的糾結。
 */
export function SharedTripsPage() {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const cfg = useMemo(() => loadSyncConfig(), []);
  const [email, setEmail] = useState('');
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!cfg || !isSessionToken(cfg.apiKey)) {
      setError(t('invite.off'));
      return;
    }
    try {
      const r = await myInvites(cfg);
      setEmail(r.email);
      // 撤過的不列：邀請人反悔時，這台不該還顯示一個點得開的入口
      setRows((r.invites ?? []).filter((g) => !g.revokedAt));
      setError('');
    } catch (err) {
      setError(describeInviteError(err, t));
      setRows([]);
    }
  }, [cfg, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!cfg || !isSessionToken(cfg.apiKey)) {
    return (
      <div className="card">
        <h3>{t('invite.mineTitle')}</h3>
        <p className="tiny">{error || t('invite.needCfg')}</p>
        <Link className="btn btn-sm" to="/settings">
          {t('share.needSyncCta')}
        </Link>
      </div>
    );
  }

  if (openId) {
    return (
      <SharedTripView
        tripId={openId}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="card">
      <h3>{t('invite.mineTitle')}</h3>
      <p className="tiny">{t('invite.mineIntro', { email })}</p>
      {error ? <p className="tiny">{error}</p> : null}
      {rows === null ? (
        <p className="tiny">{t('share.sending')}</p>
      ) : rows.length === 0 ? (
        <p className="tiny">{t('invite.empty')}</p>
      ) : (
        <ul className="list">
          {rows.map((row) => (
            <li key={row.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <strong>{row.tripName || row.tripId}</strong>
                <div className="tiny">
                  {row.ownerName ? t('invite.byOwner', { name: row.ownerName }) : row.owner} ·{' '}
                  {row.role === 'read' ? t('invite.readonlyTag') : t('invite.roleWrite')}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-sm btn-primary" onClick={() => setOpenId(row.tripId)}>
                  {t('invite.open')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (!(await ask(t('invite.leaveQ'), { confirmLabel: t('invite.leave'), danger: true }))) return;
                    try {
                      await leaveInvite(cfg, row.tripId);
                      toast(t('invite.left'));
                      await reload();
                    } catch (err) {
                      toast(describeInviteError(err, t), { kind: 'error' });
                    }
                  }}
                >
                  {t('invite.leave')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny">{t('invite.sharedNote')}</p>
      <div className="row" style={{ marginTop: 8 }}>
        <Link className="btn btn-sm" to="/">
          {t('nav.trips')}
        </Link>
      </div>
    </div>
  );
}

/** 金額顯示：共筆只看這一趟，所以用這趟自己的基準幣別當預設單位 */
function money(v: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

/** 內建行程類型（伺服器 share.js 的 ITEM_KINDS）：邀請人還沒推分類清單時用這組兜底 */
const FALLBACK_KIND_KEYS = ['transport', 'stay', 'food', 'sight', 'activity', 'other'];

/** 共筆表單的預設日期：今天落在這趟裡就用今天，否則回到第一天（就算填了範圍外，伺服器也會自己夾回來） */
function sharedDate(trip: Trip): string {
  const now = today();
  return now >= trip.startDate && now <= trip.endDate ? now : trip.startDate;
}

/** 行程清單：伺服器的 items 已按「日期＋order」排好，這裡只把同一天併成一組 */
function groupByDay(items: DayItem[]): Array<{ date: string; list: DayItem[] }> {
  const days: Array<{ date: string; list: DayItem[] }> = [];
  for (const it of items) {
    const last = days[days.length - 1];
    if (last && last.date === it.date) last.list.push(it);
    else days.push({ date: it.date, list: [it] });
  }
  return days;
}

function SharedTripView({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const { toast } = useUi();
  const { t, locale } = useI18n();
  // 只讀一次：loadSyncConfig() 每次回的是新解析出來的物件，放進 useEffect 的依賴迴圈
  // 就變成「渲染 → fetch → setView → 渲染」的無限迴路（實測把 /shared 打到 429）。
  const cfg = useMemo(() => loadSyncConfig()!, []);
  const [view, setView] = useState<SharedTripView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('');
  // 行程表單收在一個按鈕後面：手機上五個欄位同時展開，這一頁就變成一長條輸入框
  const [addingItem, setAddingItem] = useState(false);
  const [itemBusy, setItemBusy] = useState(false);
  const [iDate, setIDate] = useState('');
  const [iKind, setIKind] = useState('');
  const [iTitle, setITitle] = useState('');
  const [iStart, setIStart] = useState('');
  const [iLoc, setILoc] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await fetchSharedTrip(cfg, tripId));
      setError('');
    } catch (err) {
      setError(describeInviteError(err, t));
    }
  }, [cfg, tripId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view) {
    return (
      <div className="card">
        <h3>{t('invite.mineTitle')}</h3>
        <p className="tiny">{error || t('share.sending')}</p>
        <div className="row">
          <button className="btn btn-sm" onClick={() => void load()}>
            {t('share.refresh')}
          </button>
          <button className="btn btn-sm" onClick={onBack}>
            {t('nav.backToList')}
          </button>
        </div>
      </div>
    );
  }

  const canWrite = view.grant?.role !== 'read';
  const expenseCategories = view.categories.filter((c) => c.kind === 'expense');
  const itemCategories = view.categories.filter((c) => c.kind === 'item');
  const kindOptions = itemCategories.length
    ? itemCategories.map((c) => ({ value: String(c.key ?? c.id), label: categoryLabel(c) }))
    : FALLBACK_KIND_KEYS.map((k) => ({ value: k, label: builtinKindLabel('item', k) }));
  const kindDefault = kindOptions[0]?.value ?? 'other';
  /** 一個行程項的類型該怎麼唸：有分類列就用它（含擁有者改過的名字），否則回到內建文案 */
  const kindLabel = (it: DayItem): string => {
    const c = itemCategories.find((x) => x.key === it.kind || x.id === it.kind);
    return c ? categoryLabel(c) : builtinKindLabel('item', it.kind);
  };
  const days = groupByDay(view.items);

  async function save() {
    const value = Number(amount.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      toast(t('expense.amountRequired'), { kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      await pushSharedExpense(cfg, tripId, {
        date: today(),
        amount: value,
        currency: view!.trip.baseCurrency,
        category: category || undefined,
        note: note.trim() || undefined,
        payee: loadAccount()?.user.name || undefined,
      });
      toast(t('share.sent'));
      setAmount('');
      setNote('');
      await load();
    } catch (err) {
      toast(describeInviteError(err, t), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function saveItem() {
    const title = iTitle.trim();
    if (!title) {
      toast(t('item.titleRequired'), { kind: 'error' });
      return;
    }
    const acct = loadAccount()?.user;
    const who = acct?.name || acct?.email || '';
    setItemBusy(true);
    try {
      await pushSharedItem(cfg, tripId, {
        date: iDate || sharedDate(view!.trip),
        kind: iKind || kindDefault,
        title,
        startTime: iStart || null,
        location: iLoc.trim() || undefined,
        // 備註是這一趟裡「誰排的」唯一留痕的地方：支出有代墊人可填，行程項沒有那個欄位
        note: who ? t('invite.addedBy', { name: who }) : undefined,
      });
      toast(t('share.sent'));
      setITitle('');
      setIStart('');
      setILoc('');
      setAddingItem(false);
      await load();
    } catch (err) {
      toast(describeInviteError(err, t), { kind: 'error' });
    } finally {
      setItemBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>{view.trip.name}</h3>
      <p className="tiny">
        {t('invite.summary', {
          items: view.totals.items,
          expenses: view.totals.expenses,
          amt: money(view.totals.baseAmount, view.trip.baseCurrency, locale),
        })}
      </p>
      <p className="tiny">{t('invite.sharedNote')}</p>

      {/* ------------------------------------------------------------ 行程 */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginTop: 16, gap: 8 }}>
        <h4 style={{ margin: 0 }}>{t('invite.itineraryTitle')}</h4>
        {canWrite ? (
          <button className="btn btn-sm" onClick={() => setAddingItem((v) => !v)} aria-expanded={addingItem}>
            {t('invite.addItem')}
          </button>
        ) : null}
      </div>

      {canWrite && addingItem ? (
        <div className="stack-s" style={{ marginTop: 8 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label={t('common.date')}>
              <input type="date" value={iDate || sharedDate(view.trip)} onChange={(e) => setIDate(e.target.value)} />
            </Field>
            <Field label={t('item.kind')}>
              <select value={iKind || kindDefault} onChange={(e) => setIKind(e.target.value)}>
                {kindOptions.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('item.start')}>
              <input type="time" value={iStart} onChange={(e) => setIStart(e.target.value)} />
            </Field>
          </div>
          <Field label={t('item.title')}>
            <input
              value={iTitle}
              onChange={(e) => setITitle(e.target.value)}
              maxLength={160}
              autoFocus
              placeholder={t('item.titlePlaceholder')}
            />
          </Field>
          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label={t('item.location')}>
              <input className="grow" value={iLoc} onChange={(e) => setILoc(e.target.value)} maxLength={200} placeholder={t('item.locationPlaceholder')} />
            </Field>
            <button className="btn btn-primary btn-sm" onClick={() => void saveItem()} disabled={itemBusy}>
              {itemBusy ? t('share.sending') : t('invite.addItemSave')}
            </button>
          </div>
        </div>
      ) : null}

      {days.length === 0 ? (
        <p className="tiny">{t('invite.itemEmpty')}</p>
      ) : (
        days.map((day) => (
          <div key={day.date} style={{ marginTop: 8 }}>
            <p className="tiny" style={{ margin: '0 0 2px' }}>
              <strong>{day.date}</strong> · {t('invite.dayCount', { n: day.list.length })}
            </p>
            <ul className="list">
              {day.list.map((it) => (
                <li key={it.id}>
                  <span className="tiny" style={{ display: 'inline-block', minWidth: '3.6em', marginRight: 6 }}>
                    {it.startTime || '—'}
                  </span>
                  {it.title}
                  <span className="tiny">
                    {' · '}
                    {kindLabel(it)}
                    {it.location ? ` · ${it.location}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {/* ------------------------------------------------------------ 支出 */}
      {canWrite ? (
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end', marginTop: 16 }}>
          <Field label={t('common.amount')} hint={view.trip.baseCurrency}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={t('share.amountPlaceholder')} />
          </Field>
          <Field label={t('common.category')}>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('common.uncategorized')}</option>
              {expenseCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('expense.note')}>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
            {busy ? t('share.sending') : t('invite.addSpend')}
          </button>
        </div>
      ) : (
        <p className="tiny" style={{ marginTop: 16 }}>{t('invite.errReadonly')}</p>
      )}

      <h4 style={{ marginTop: 16 }}>{t('invite.recentTitle')}</h4>
      <ul className="list">
        {view.expenses
          .slice()
          .reverse()
          .slice(0, 30)
          .map((e) => (
            <li key={e.id} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span>
                {e.date} · {e.note || categoryLabel(expenseCategories.find((c) => c.id === e.category || c.key === e.category))}
                {e.payee ? ` · ${e.payee}` : ''}
              </span>
              <span>{money(e.amount, e.currency, locale)}</span>
            </li>
          ))}
        {view.expenses.length === 0 ? <li className="tiny">{t('invite.sharedEmpty')}</li> : null}
      </ul>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => void load()}>
          {t('share.refresh')}
        </button>
        <button className="btn btn-sm" onClick={onBack}>
          {t('invite.mineTitle')}
        </button>
      </div>
    </div>
  );
}
