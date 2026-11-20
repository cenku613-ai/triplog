import { useUi } from '../app/ui';
import { useI18n } from '../i18n';

export function ToastHost() {
  const { toasts, dismiss } = useUi();
  const { t } = useI18n();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t2) => (
        <div key={t2.id} className={`toast${t2.kind === 'error' ? ' error' : ''}`}>
          <span className="grow">{t2.text}</span>
          {t2.actionLabel ? (
            <button
              onClick={() => {
                t2.onAction?.();
                dismiss(t2.id);
              }}
            >
              {t2.actionLabel}
            </button>
          ) : null}
          <button onClick={() => dismiss(t2.id)} aria-label={t('common.closeToast')}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmHost() {
  const { pending, answer } = useUi();
  const { t } = useI18n();
  if (!pending) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div
        className="modal"
        style={{ maxWidth: 420 }}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('common.confirmAria')}
      >
        <div className="grip" />
        <p style={{ marginBottom: 'var(--sp-4)' }}>{pending.message}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={() => answer(false)}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => answer(true)}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
