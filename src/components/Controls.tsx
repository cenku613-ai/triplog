import type { ReactNode } from 'react';
import { BUILTIN_CURRENCIES, currencyLabel } from '../db/currency';
import type { Category } from '../db/types';
import { useI18n } from '../i18n';
import { categoryLabel } from '../lib/labels';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="tiny" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function Empty({
  icon = '🧳',
  title,
  body,
  action,
}: {
  icon?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty card">
      <div className="big" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {body ? <p className="muted" style={{ marginTop: 6 }}>{body}</p> : null}
      {action ? <div style={{ marginTop: 'var(--sp-4)' }}>{action}</div> : null}
    </div>
  );
}

export function CurrencySelect({
  value,
  onChange,
  extra,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  /** 使用者自訂/用過的代碼，不在內建清單也要能顯示 */
  extra?: string[];
  id?: string;
}) {
  const { t } = useI18n();
  const codes = new Set<string>([...BUILTIN_CURRENCIES.map((c) => c.code), ...(extra ?? [])]);
  if (value) codes.add(value);
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('common.currency')}
    >
      {[...codes].map((code) => (
        <option key={code} value={code}>
          {code} {currencyLabel(code)}
        </option>
      ))}
    </select>
  );
}

export function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="cat-picker" role="group" aria-label={t('common.category')}>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          className="chip"
          aria-pressed={c.id === value}
          onClick={() => onChange(c.id)}
        >
          <span className="dot" style={{ color: c.color }} />
          {categoryLabel(c)}
        </button>
      ))}
    </div>
  );
}

export function TripSelect({
  trips,
  value,
  onChange,
  id,
}: {
  trips: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
}) {
  const { t } = useI18n();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('trip.selectAria')}>
      {!value ? <option value="">{t('trip.selectPlaceholder')}</option> : null}
      {trips.map((t2) => (
        <option key={t2.id} value={t2.id}>
          {t2.name}
        </option>
      ))}
    </select>
  );
}
