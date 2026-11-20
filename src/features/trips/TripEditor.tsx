import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { CurrencySelect, Field } from '../../components/Controls';
import { CompanionEditor } from '../../components/People';
import { createTrip, deleteTrip, updateTrip } from '../../db/repo';
import type { Trip } from '../../db/types';
import { today } from '../../lib/dates';
import { db } from '../../db/db';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';

const PALETTE = ['#0f766e', '#2f7ed8', '#7c5cd6', '#d64576', '#e07a3f', '#c9962b', '#17795c', '#5c6470'];

export function TripEditor({
  trip,
  initialStart,
  onClose,
  onSaved,
}: {
  trip?: Trip | null;
  initialStart?: string;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const [name, setName] = useState(trip?.name ?? '');
  const [startDate, setStartDate] = useState(trip?.startDate ?? initialStart ?? today());
  const [endDate, setEndDate] = useState(trip?.endDate ?? initialStart ?? today());
  const [baseCurrency, setBaseCurrency] = useState(
    trip?.baseCurrency ?? localStorage.getItem('triplog:lastBase') ?? 'TWD',
  );
  const [budget, setBudget] = useState(trip?.budget ? String(trip.budget) : '');
  const [color, setColor] = useState(trip?.color ?? PALETTE[0]);
  const [notes, setNotes] = useState(trip?.notes ?? '');
  const [companions, setCompanions] = useState<string[]>(trip?.companions ?? []);
  const [saving, setSaving] = useState(false);

  const endBeforeStart = endDate < startDate;

  async function save() {
    if (!name.trim()) {
      toast(t('trip.nameRequired'), { kind: 'error' });
      return;
    }
    if (endBeforeStart) {
      toast(t('trip.endBeforeStart'), { kind: 'error' });
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      startDate,
      endDate,
      baseCurrency,
      budget: budget ? Number(budget) : null,
      color,
      notes: notes.trim(),
      companions,
    };
    try {
      if (trip) {
        await updateTrip(trip.id, payload);
        toast(t('trip.updated'));
        onSaved?.(trip.id);
      } else {
        const id = await createTrip(payload);
        localStorage.setItem('triplog:lastBase', baseCurrency);
        toast(t('trip.created'));
        onSaved?.(id);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={trip ? t('trip.editTitle') : t('trip.newTitle')}
      onClose={onClose}
      footer={
        <div className="row-between">
          {trip ? (
            <button
              className="btn btn-danger btn-sm"
              onClick={async () => {
                const [items, exps] = await Promise.all([
                  db.dayItems.where('tripId').equals(trip.id).count(),
                  db.expenses.where('tripId').equals(trip.id).count(),
                ]);
                const ok = await ask(t('trip.deleteDetailQ', { name: trip.name, items, expenses: exps }), {
                  confirmLabel: t('trip.deleteForever'),
                  danger: true,
                });
                if (ok) {
                  await deleteTrip(trip.id);
                  toast(t('trip.deleted'));
                  onClose();
                }
              }}
            >
              {t('trip.delete')}
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {t('common.save')}
            </button>
          </div>
        </div>
      }
    >
      <div className="stack">
        <Field label={t('trip.name')}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('trip.namePlaceholder')}
            maxLength={50}
          />
        </Field>

        <div className="field-row">
          <Field label={t('trip.start')}>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (endDate < e.target.value) setEndDate(e.target.value);
              }}
            />
          </Field>
          <Field label={t('trip.end')} hint={endBeforeStart ? t('trip.endBeforeStart') : undefined}>
            <input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>

        <div className="field-row">
          <Field label={t('trip.baseCurrency')} hint={t('trip.baseCurrencyHint')}>
            <CurrencySelect value={baseCurrency} onChange={setBaseCurrency} />
          </Field>
          <Field label={t('trip.budget', { code: baseCurrency })}>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
        </div>

        <Field label={t('trip.color')}>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ background: c }}
                aria-pressed={c === color}
                aria-label={t('trip.colorAria', { color: c })}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </Field>

        <Field label={t('trip.notes')}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('trip.notesPlaceholder')}
            maxLength={1000}
          />
        </Field>

        <Field label={t('trip.companions')} hint={t('trip.companionsHint')}>
          <CompanionEditor value={companions} onChange={setCompanions} />
        </Field>
      </div>
    </Modal>
  );
}
