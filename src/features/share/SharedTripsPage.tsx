import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../../components/Controls';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { categoryLabel } from '../../lib/labels';
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

/** 金額顯示：共筆只看這一趟，所以用旅行自己的帳號當預設單位 */
function money(v: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

function SharedTripView({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const { toast } = useUi();
  const { t, locale } = useI18n();
  const cfg = loadSyncConfig()!;
  const [view, setView] = useState<SharedTripView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('');

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

      {canWrite ? (
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
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
        <p className="tiny">{t('invite.errReadonly')}</p>
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
