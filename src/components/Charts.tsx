import type { Bucket, DayBucket } from '../lib/stats';
import { formatAmount } from '../db/currency';
import { useI18n } from '../i18n';

export function BarChart({
  days,
  baseCurrency,
  onSelect,
}: {
  days: DayBucket[];
  baseCurrency: string;
  onSelect?: (date: string) => void;
}) {
  const { t } = useI18n();
  const max = Math.max(1, ...days.map((d) => d.amount));
  return (
    <div className="bars" role="img" aria-label={t('stats.dailyAria')}>
      {days.map((d) => {
        const h = Math.round((d.amount / max) * 100);
        const isMax = d.amount === max && d.amount > 0;
        const label = `${d.label} ${formatAmount(d.amount, baseCurrency)}`;
        return (
          <button
            key={d.date}
            className={`b${isMax ? ' has-max' : ''}`}
            style={{ background: 'transparent', border: 0, padding: 0, cursor: onSelect ? 'pointer' : 'default' }}
            onClick={() => onSelect?.(d.date)}
            title={label}
            aria-label={label}
          >
            <i style={{ height: `${d.amount > 0 ? Math.max(h, 2) : 0}%` }} />
            <u>{d.date.slice(8)}</u>
          </button>
        );
      })}
    </div>
  );
}

export function Donut({
  buckets,
  total,
  baseCurrency,
}: {
  buckets: Bucket[];
  total: number;
  baseCurrency: string;
}) {
  const { t } = useI18n();
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const safeTotal = total > 0 ? total : 1;
  return (
    <div className="donut">
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="18" />
        {buckets.slice(0, 12).map((b) => {
          const len = (b.amount / safeTotal) * c;
          const seg = (
            <circle
              key={b.key}
              cx="64"
              cy="64"
              r={r}
              fill="none"
              stroke={b.color}
              strokeWidth="18"
              strokeDasharray={`${Math.max(len - 1, 0)} ${c - Math.max(len - 1, 0)}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return seg;
        })}
      </svg>
      <div className="legend">
        {buckets.slice(0, 8).map((b) => (
          <div className="l" key={b.key}>
            <i style={{ background: b.color }} />
            <span className="grow">{b.label}</span>
            <span className="pct">
              {new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
                Math.round((b.amount / safeTotal) * 100),
              )}
              %
            </span>
            <span className="amt">{formatAmount(b.amount, baseCurrency)}</span>
          </div>
        ))}
        {buckets.length === 0 ? <span className="tiny">{t('stats.noData')}</span> : null}
      </div>
    </div>
  );
}

export function BudgetBar({
  spent,
  budget,
  baseCurrency,
}: {
  spent: number;
  budget: number | null;
  baseCurrency: string;
}) {
  const { t, locale } = useI18n();
  if (!budget) {
    return (
      <div className="stack-s">
        <div className="row-between">
          <span className="k tiny">{t('detail.spent')}</span>
          <span className="num" style={{ fontWeight: 800 }}>
            {formatAmount(spent, baseCurrency)}
          </span>
        </div>
        <div className="tiny">{t('stats.budgetNotSet')}</div>
      </div>
    );
  }
  const ratio = spent / budget;
  const over = ratio > 1;
  const pct = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(ratio * 100));
  return (
    <div className="stack-s">
      <div className="row-between">
        <span className="num" style={{ fontWeight: 800 }}>
          {formatAmount(spent, baseCurrency)}
        </span>
        <span className="tiny">{t('detail.budgetLine', { amt: formatAmount(budget, baseCurrency) })}</span>
      </div>
      <div className={`bar${over ? ' is-over' : ''}`}>
        <span style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </div>
      <div className="row-between">
        <span className="tiny">{pct}%</span>
        <span className="tiny" style={{ color: over ? 'var(--danger)' : undefined }}>
          {over
            ? t('stats.over', { amt: formatAmount(Math.abs(spent - budget), baseCurrency) })
            : t('stats.left', { amt: formatAmount(budget - spent, baseCurrency) })}
        </span>
      </div>
    </div>
  );
}
