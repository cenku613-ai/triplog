import { useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Field, CategoryPicker, CurrencySelect } from '../../components/Controls';
import { useI18n } from '../../i18n';
import type { Key, Vars } from '../../i18n';
import { builtinKindLabel, categoryLabel } from '../../lib/labels';
import { today } from '../../lib/dates';
import {
  describeShareError,
  fetchShare,
  loadSharePin,
  pushShareExpense,
  pushShareItem,
  saveSharePin,
  saveViewerName,
  type ShareView,
} from '../../lib/share';

/**
 * 同行者的兩個表單，加上一張問 PIN 的卡片。
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
  /**
   * 送出時才被要求 PIN（分頁開太久、擁有者換過一組之類）：
   * 表單留著也沒用，叫分享頁把畫面換回問 PIN 那張卡。
   */
  onNeedPin?: () => void;
  /** 送出時才發現這條是唯讀連結：叫分享頁把「記一筆」「加行程」收起來 */
  onReadOnly?: () => void;
};

/** 預設日期：今天落在這趟裡就用今天，不然用最後一天（超出範圍伺服器會擋） */
function defaultDate(view: ShareView): string {
  const now = today();
  return now >= view.trip.startDate && now <= view.trip.endDate ? now : view.trip.endDate;
}

const num = (s: string): number => Number(String(s).replace(/[,\s]/g, ''));

/**
 * 寫入被打回的三種去向，兩個表單共用：
 * 回傳要顯示在表單下方的字，空字串代表這事已經交給分享頁（換卡片、收按鈕），
 * 表單自己不該再多講一句。
 */
function rejectedWrite(
  err: unknown,
  token: string,
  t: (key: Key, vars?: Vars) => string,
  onNeedPin?: () => void,
  onReadOnly?: () => void,
): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'pin') {
    // 這組 PIN 已被伺服器認定不對：留著它，之後每次重新整理都只是多挨一次 401
    saveSharePin(token, '');
    onNeedPin?.();
    return '';
  }
  if (code === 'readonly') onReadOnly?.();
  return describeShareError(err, t);
}

/** 伺服器只認這幾個類型（share.js 的 ITEM_KINDS）；擁有者若自訂了行程分類，清單以回傳的為準 */
const FALLBACK_KINDS = ['transport', 'stay', 'food', 'sight', 'activity', 'other'];

/**
 * 問訪客 PIN 的卡片。
 *
 * 它不是表單，但放在同一個檔案：分享頁要載入的輸入就這一處，
 * 而且它跟兩個表單一樣——不寫 IndexedDB，成敗都由伺服器說了算。
 * 這裡沒有「忘記 PIN」的按鈕：伺服器只存雜湊，連擁有者本人都想不起來，
 * 要換一組只能請他作廢這條連結、再產生一條。
 */
export function PinForm({
  token,
  readOnly,
  error = '',
  onUnlocked,
}: {
  token: string;
  /** 這條連結同時是唯讀的：先說清楚，別讓人家以為填完 PIN 就能記帳 */
  readOnly: boolean;
  /** 分享頁那側已經知道的事（例如分頁存的 PIN 被換過）：卡片自己講一次就夠 */
  error?: string;
  onUnlocked: (view: ShareView) => void;
}) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const code = pin.trim();
    // 形狀不對就在這裡擋：不必跑一趟伺服器，而且亂填也會算進 PIN 的限流
    if (!/^\d{4,8}$/.test(code)) return setErr(t('share.pinBad'));
    setBusy(true);
    setErr('');
    try {
      const next = await fetchShare(token, code);
      // 解開了才記住：錯的數字留在分頁裡，之後每次重新整理都要再錯一次
      saveSharePin(token, code);
      onUnlocked(next);
    } catch (e) {
      setErr(describeShareError(e, t));
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad stack-s" aria-label={t('share.pinTitle')}>
      <strong>{t('share.pinTitle')}</strong>
      <p className="tiny" style={{ margin: 0 }}>
        {t('share.pinIntro')}
      </p>
      {readOnly ? (
        <p className="tiny" style={{ margin: 0 }}>
          {t('share.pinReadonly')}
        </p>
      ) : null}
      <div className="row wrap">
        <input
          className="grow"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          autoFocus
          placeholder={t('share.pinPlaceholder')}
          aria-label={t('share.pinLabel')}
        />
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? t('share.sending') : t('share.pinGo')}
        </button>
      </div>
      {err || error ? (
        <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
          {err || error}
        </p>
      ) : null}
    </section>
  );
}

export function ExpenseForm({ token, view, who, onWho, onClose, onSaved, onNeedPin, onReadOnly }: FormProps) {
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
      await pushShareExpense(
        token,
        {
          date,
          amount: amt,
          currency,
          rateToBase: needsRate ? r : undefined,
          category: category || undefined,
          payee: name || undefined,
          note: note.trim() || undefined,
          dayItemId: itemId || null,
        },
        loadSharePin(token),
        // 最後那一欄只給連結那邊記「誰用這條記錄過」；署名照舊寫進 payee
        name,
      );
      onSaved();
    } catch (e) {
      setErr(rejectedWrite(e, token, t, onNeedPin, onReadOnly));
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

export function ItemForm({ token, view, who, onClose, onSaved, onNeedPin, onReadOnly }: FormProps) {
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
      await pushShareItem(
        token,
        {
          date,
          kind,
          title: title.trim(),
          startTime: startTime || null,
          endTime: endTime || null,
          location: location.trim() || undefined,
          note: note.trim() ? `${note.trim()}${name ? `（${name}）` : ''}` : name || undefined,
        },
        loadSharePin(token),
        name,
      );
      onSaved();
    } catch (e) {
      setErr(rejectedWrite(e, token, t, onNeedPin, onReadOnly));
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
