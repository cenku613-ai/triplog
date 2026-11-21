import { useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Field, CategoryPicker, CurrencySelect } from '../../components/Controls';
import { useI18n } from '../../i18n';
import { builtinKindLabel, categoryLabel } from '../../lib/labels';
import { today } from '../../lib/dates';
import {
  describeShareError,
  pushShareExpense,
  pushShareItem,
  saveViewerName,
  type ShareView,
} from '../../lib/share';

/**
 * 同行者的兩個表單。
 *
 * 這裡不碰 IndexedDB，按下保存就是直接 POST 到 /api/share/<token>/...：
 * 伺服器會把 tripId 換成這一趟、自己算 baseAmount、用伺服器時間蓋時間戳，
 * 所以客戶端連「這筆屬於哪趟」都不必（也不該）說。
 */

type FormProps = {
  token: string;
  view: ShareView;
  who: string;
  /** 只有支出表單需要記住名字；行程表單把它寫進備註，所以這個是選填 */
  onWho?: (name: string) => void;
  onClose: () => void;
  onSaved: () => void;
};

/** 預設日期：今天落在這趟裡就用今天，不然用最後一天（超出範圍伺服器會擋） */
function defaultDate(view: ShareView): string {
  const now = today();
  return now >= view.trip.startDate && now <= view.trip.endDate ? now : view.trip.endDate;
}

const num = (s: string): number => Number(String(s).replace(/[,\s]/g, ''));

/** 伺服器只認這幾個類型（share.js 的 ITEM_KINDS）；擁有者若自訂了行程分類，清單以回傳的為準 */
const FALLBACK_KINDS = ['transport', 'stay', 'food', 'sight', 'activity', 'other'];

export function ExpenseForm({ token, view, who, onWho, onClose, onSaved }: FormProps) {
  const { t } = useI18n();
  const trip = view.trip;
  const cats = useMemo(() => view.categories.filter((c) => c.kind !== 'item'), [view]);
  const seen = useMemo(() => [...new Set(view.expenses.map((e) => e.currency))], [view]);
  const payees = useMemo(
    () => [...new Set(view.expenses.map((e) => e.payee).filter((x): x is string => !!x))],
    [view],
  );
  const [date, setDate] = useState(() => defaultDate(view));
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(trip.baseCurrency);
  const [rate, setRate] = useState('');
  const [category, setCategory] = useState(cats[0]?.id ?? '');
  const [payee, setPayee] = useState(who);
  const [note, setNote] = useState('');
  const [itemId, setItemId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const needsRate = currency !== trip.baseCurrency;

  const submit = async () => {
    const amt = num(amount);
    if (!(amt > 0)) return setErr(t('expense.amountRequired'));
    const r = needsRate ? num(rate) : 1;
    if (needsRate && !(r > 0)) return setErr(t('expense.rateMissing'));
    const name = payee.trim();
    setBusy(true);
    setErr('');
    try {
      onWho?.(name);
      saveViewerName(name);
      await pushShareExpense(token, {
        date,
        amount: amt,
        currency,
        rateToBase: needsRate ? r : undefined,
        category: category || undefined,
        payee: name || undefined,
        note: note.trim() || undefined,
        dayItemId: itemId || null,
      });
      onSaved();
    } catch (e) {
      setErr(describeShareError(e, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('expense.title')}
      onClose={onClose}
      footer={
        <div className="row">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <span className="grow" />
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('share.sending') : t('common.save')}
          </button>
        </div>
      }
    >
      <div className="stack" role="group" aria-label={t('share.formAria')}>
        <div className="row wrap">
          <Field label={t('common.date')}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('common.amount')}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoFocus
              placeholder={t('share.amountPlaceholder')}
            />
          </Field>
          <Field label={t('common.currency')}>
            <CurrencySelect value={currency} onChange={setCurrency} extra={seen} />
          </Field>
        </div>

        {needsRate ? (
          <Field label={t('expense.rateLabel', { code: currency, base: trip.baseCurrency })} hint={t('expense.rateMissing')}>
            <input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" aria-label={t('expense.rateAria')} />
          </Field>
        ) : null}

        {cats.length ? (
          <Field label={t('common.category')}>
            <CategoryPicker categories={cats} value={category} onChange={setCategory} />
          </Field>
        ) : null}

        <div className="row wrap">
          <Field label={t('expense.payee')} hint={t('share.yourNameHint')}>
            <input
              className="grow"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              maxLength={40}
              list="share-payees"
              placeholder={t('share.yourNamePlaceholder')}
            />
          </Field>
          <Field label={t('expense.linkedItem')}>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">{t('expense.noLink')}</option>
              {view.items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.date} {it.startTime ? `${it.startTime} ` : ''}
                  {it.title}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <datalist id="share-payees">
          {payees.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <Field label={t('expense.note')}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={120}
            placeholder={t('expense.notePlaceholder')}
          />
        </Field>

        {err ? (
          <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
            {err}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function ItemForm({ token, view, who, onClose, onSaved }: FormProps) {
  const { t } = useI18n();
  const kinds = useMemo(() => view.categories.filter((c) => c.kind === 'item'), [view]);
  const [date, setDate] = useState(() => defaultDate(view));
  const [kind, setKind] = useState(kinds[0]?.key ?? 'other');
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const name = who.trim();
    if (!title.trim()) return setErr(t('item.titleRequired'));
    setBusy(true);
    setErr('');
    try {
      await pushShareItem(token, {
        date,
        kind,
        title: title.trim(),
        startTime: startTime || null,
        endTime: endTime || null,
        location: location.trim() || undefined,
        note: note.trim() ? `${note.trim()}${name ? `（${name}）` : ''}` : name || undefined,
      });
      onSaved();
    } catch (e) {
      setErr(describeShareError(e, t));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('item.newTitle')}
      onClose={onClose}
      footer={
        <div className="row">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <span className="grow" />
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('share.sending') : t('common.save')}
          </button>
        </div>
      }
    >
      <div className="stack" role="group" aria-label={t('share.formAria')}>
        <div className="row wrap">
          <Field label={t('common.date')}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('item.kind')}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('item.kind')}>
              {kinds.map((c) => (
                <option key={c.id} value={c.key ?? c.id}>
                  {categoryLabel(c)}
                </option>
              ))}
              {kinds.length === 0
                ? FALLBACK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {builtinKindLabel('item', k)}
                    </option>
                  ))
                : null}
            </select>
          </Field>
        </div>

        <Field label={t('item.title')}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            autoFocus
            placeholder={t('item.titlePlaceholder')}
          />
        </Field>

        <div className="row wrap">
          <Field label={t('item.start')}>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </Field>
          <Field label={t('item.end')}>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </Field>
        </div>

        <Field label={t('item.location')}>
          <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder={t('item.locationPlaceholder')} />
        </Field>

        <Field label={t('expense.note')}>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={t('expense.notePlaceholder')} />
        </Field>

        {err ? (
          <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
            {err}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
