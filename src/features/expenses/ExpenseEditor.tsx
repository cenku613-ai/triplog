import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { CategoryPicker, CurrencySelect, Field, TripSelect } from '../../components/Controls';
import { PayerChips } from '../../components/People';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import {
  createExpense,
  deleteExpense,
  listCategories,
  lookupRate,
  rememberRate,
  updateExpense,
} from '../../db/repo';
import { formatAmount } from '../../db/currency';
import type { DayItem, Expense, Trip } from '../../db/types';
import { numericDate, today } from '../../lib/dates';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';

interface Props {
  trips: Trip[];
  /** 已知旅行時鎖定；未給則顯示選單 */
  trip?: Trip | null;
  expense?: Expense | null;
  defaultDate?: string;
  defaultDayItemId?: string | null;
  onClose: () => void;
}

export function ExpenseEditor({
  trips,
  trip,
  expense,
  defaultDate,
  defaultDayItemId,
  onClose,
}: Props) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const activeTrips = useMemo(() => trips.filter((x) => !x.archived), [trips]);
  const lastTripId = localStorage.getItem('triplog:lastTrip') ?? '';

  // 預設挑「上次記過的旅行」，沒有則用最近更新的那趟，而不是日期排序後的第一個
  function pickDefaultTrip(): string {
    const remembered = activeTrips.find((x) => x.id === lastTripId);
    if (remembered) return remembered.id;
    return [...activeTrips].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? '';
  }

  const [tripId, setTripId] = useState(() =>
    trip ? trip.id : expense ? expense.tripId : pickDefaultTrip(),
  );
  const target = trip ?? activeTrips.find((x) => x.id === tripId) ?? null;
  const base = target?.baseCurrency ?? 'TWD';

  const [date, setDate] = useState(expense?.date ?? defaultDate ?? today());
  const [currency, setCurrency] = useState(expense?.currency ?? base);
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [rateText, setRateText] = useState(expense ? String(expense.rateToBase) : '');
  const [category, setCategory] = useState(
    expense?.category ?? localStorage.getItem('triplog:lastCategory') ?? '',
  );
  const [dayItemId, setDayItemId] = useState<string>(expense?.dayItemId ?? defaultDayItemId ?? '');
  const [payee, setPayee] = useState(expense?.payee ?? '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [saving, setSaving] = useState(false);

  const categories = useLive(() => listCategories('expense'), [], []);
  const items = useLive<DayItem[]>(
    () => (tripId ? db.dayItems.where('tripId').equals(tripId).toArray() : Promise.resolve([])),
    [tripId],
    [],
  );

  // trips 是非同步載入的：從 PWA 快捷方式直接進來時，第一次渲染可能還是空清單，
  // 等旅行進來後補一次預設，否則表單會卡在「未選旅行」而保存不了。
  useEffect(() => {
    if (tripId || expense || trip || activeTrips.length === 0) return;
    const id = pickDefaultTrip();
    const x = activeTrips.find((y) => y.id === id);
    if (!x) return;
    setTripId(x.id);
    setCurrency(x.baseCurrency);
    setDate((d) => (d >= x.startDate && d <= x.endDate ? d : x.startDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, activeTrips]);

  // 換幣別時帶入記住的匯率；沒有記錄過就留白，強迫使用者輸入，避免偷偷用 1:1
  const skipRateEffect = useRef(Boolean(expense));
  useEffect(() => {
    if (skipRateEffect.current) {
      skipRateEffect.current = false;
      return;
    }
    if (currency === base) {
      setRateText('1');
      return;
    }
    let alive = true;
    void lookupRate(currency, base).then((r) => {
      if (alive) setRateText(r === undefined ? '' : String(r));
    });
    return () => {
      alive = false;
    };
  }, [currency, base]);

  useEffect(() => {
    if (!category && categories.length) setCategory(categories[0].id);
  }, [categories, category]);

  const rate = Number(rateText);
  const amt = Number(amount);
  const sameCurrency = currency === base;
  const rateValid = sameCurrency || (Number.isFinite(rate) && rate > 0);
  const amountValid = Number.isFinite(amt) && amt > 0;
  const baseAmount = amountValid && rateValid ? amt * (sameCurrency ? 1 : rate) : 0;

  async function save(again: boolean) {
    if (!tripId) {
      toast(t('expense.tripRequired'), { kind: 'error' });
      return;
    }
    if (!amountValid) {
      toast(t('expense.amountRequired'), { kind: 'error' });
      return;
    }
    if (!rateValid) {
      toast(t('expense.rateRequired', { code: currency, base }), { kind: 'error' });
      return;
    }
    setSaving(true);
    const draft = {
      tripId,
      dayItemId: dayItemId || null,
      date,
      amount: amt,
      currency,
      rateToBase: sameCurrency ? 1 : rate,
      category,
      payee,
      note,
    };
    try {
      if (expense) await updateExpense(expense.id, draft);
      else await createExpense(draft);
      await rememberRate(currency, base, sameCurrency ? 1 : rate);
      localStorage.setItem('triplog:lastTrip', tripId);
      localStorage.setItem('triplog:lastCategory', category);
      const where = (target ?? trips.find((x) => x.id === tripId))?.name;
      toast(
        expense
          ? t('expense.updated')
          : where && !trip
            ? t('expense.recordedTo', { amt: formatAmount(amt, currency), where })
            : t('expense.recorded', { amt: formatAmount(amt, currency) }),
      );
      if (again) {
        setAmount('');
        setNote('');
        setPayee('');
        setDayItemId('');
        setSaving(false);
        return;
      }
      onClose();
    } catch (err) {
      console.error(err);
      toast(t('expense.saveFailed'), { kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  if (activeTrips.length === 0 && !trip) {
    return (
      <Modal title={t('expense.title')} onClose={onClose}>
        <p className="muted">{t('expense.noTrips')}</p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-4)' }}>
          <button className="btn btn-primary" onClick={onClose}>
            {t('expense.goCreateTrip')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={expense ? t('expense.editTitle') : t('expense.title')}
      onClose={onClose}
      footer={
        <div className="row-between">
          {expense ? (
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                if (await ask(t('expense.deleteQ'), { confirmLabel: t('common.delete'), danger: true })) {
                  await deleteExpense(expense.id);
                  toast(t('expense.deleted'));
                  onClose();
                }
              }}
            >
              {t('common.delete')}
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            {!expense ? (
              <button className="btn" onClick={() => void save(true)} disabled={saving}>
                {t('expense.saveAndAnother')}
              </button>
            ) : null}
            <button className="btn btn-primary" onClick={() => void save(false)} disabled={saving}>
              {t('common.done')}
            </button>
          </div>
        </div>
      }
    >
      <div className="stack">
        {!trip ? (
          <Field label={t('expense.trip')}>
            <TripSelect
              trips={activeTrips}
              value={tripId}
              onChange={(id) => {
                setTripId(id);
                setDayItemId('');
                const x = activeTrips.find((y) => y.id === id);
                if (x) {
                  setDate((d) => (d >= x.startDate && d <= x.endDate ? d : x.startDate));
                  setCurrency(x.baseCurrency);
                }
              }}
            />
          </Field>
        ) : null}

        <div className="amount-input">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            aria-label={t('common.amount')}
            style={{ maxWidth: '45%' }}
          />
          <CurrencySelect value={currency} onChange={setCurrency} extra={[base]} />
        </div>

        {!sameCurrency ? (
          <div className="tile">
            <div className="field-row" style={{ alignItems: 'end' }}>
              <Field
                label={t('expense.rateLabel', { code: currency, base })}
                hint={rateValid ? undefined : t('expense.rateMissing')}
              >
                <input
                  value={rateText}
                  onChange={(e) => setRateText(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={t('expense.rateAria')}
                />
              </Field>
              <div className="right">
                <div className="tiny">{t('expense.converted')}</div>
                <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
                  {formatAmount(baseAmount, base)}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <Field label={t('common.category')}>
          <CategoryPicker categories={categories} value={category} onChange={setCategory} />
        </Field>

        <div className="field-row">
          <Field label={t('common.date')}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('expense.linkedItem')}>
            <select value={dayItemId} onChange={(e) => setDayItemId(e.target.value)}>
              <option value="">{t('expense.noLink')}</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {numericDate(i.date)} {i.title}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('expense.payee')}>
            <input
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
              placeholder={t('expense.payeePlaceholder')}
              maxLength={30}
            />
            <PayerChips companions={target?.companions ?? []} value={payee} onPick={setPayee} />
          </Field>
          <Field label={t('expense.note')}>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('expense.notePlaceholder')}
              maxLength={80}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
