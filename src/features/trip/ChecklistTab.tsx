import { useState, type FormEvent } from 'react';
import {
  createCheckItem,
  deleteCheckItem,
  moveCheckItem,
  updateCheckItem,
} from '../../db/repo';
import type { ChecklistItem } from '../../db/types';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';

const MAX_TEXT = 300;

export function ChecklistTab({ tripId, items }: { tripId: string; items: ChecklistItem[] }) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const done = items.filter((item) => item.done).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;

  const run = async (id: string, action: () => Promise<void>, success?: string) => {
    if (busy) return;
    setBusy(id);
    try {
      await action();
      if (success) toast(success);
    } catch {
      toast(t('checklist.saveFailed'), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) {
      toast(t('checklist.required'), { kind: 'error' });
      return;
    }
    await run('new', async () => {
      await createCheckItem(tripId, text);
      setDraft('');
    }, t('checklist.added'));
  };

  const saveEdit = async (e: FormEvent, item: ChecklistItem) => {
    e.preventDefault();
    const text = editText.trim();
    if (!text) {
      toast(t('checklist.required'), { kind: 'error' });
      return;
    }
    await run(item.id, async () => {
      await updateCheckItem(item.id, { text });
      setEditingId(null);
      setEditText('');
    }, t('checklist.updated'));
  };

  return (
    <section className="card card-pad checklist" aria-labelledby="checklist-title">
      <div className="stack">
        <div className="row-between wrap" style={{ gap: 'var(--sp-3)' }}>
          <div>
            <h3 id="checklist-title">{t('checklist.title')}</h3>
            <p className="tiny" style={{ marginBottom: 0 }}>{t('checklist.description')}</p>
          </div>
          {items.length ? (
            <span className="badge" role="status">{t('checklist.progress', { done, total: items.length })}</span>
          ) : null}
        </div>

        {items.length ? (
          <div
            className="bar checklist-progress"
            role="progressbar"
            aria-label={t('checklist.progress', { done, total: items.length })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        <form className="check-add" onSubmit={(e) => void add(e)}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('checklist.placeholder')}
            aria-label={t('checklist.add')}
            maxLength={MAX_TEXT}
            autoComplete="off"
          />
          <button className="btn btn-primary" type="submit" disabled={busy !== null}>
            {t('checklist.add')}
          </button>
        </form>

        {items.length === 0 ? (
          <div className="empty checklist-empty">
            <div className="big" aria-hidden="true">✓</div>
            <h4>{t('checklist.emptyTitle')}</h4>
            <p className="tiny">{t('checklist.emptyBody')}</p>
          </div>
        ) : (
          <ul className="check-list">
            {items.map((item, i) => (
              <li key={item.id} className={`check-row${item.done ? ' is-done' : ''}`}>
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={busy !== null}
                  aria-label={t(item.done ? 'checklist.markOpen' : 'checklist.markDone', { text: item.text })}
                  onChange={() => void run(item.id, () => updateCheckItem(item.id, { done: !item.done }))}
                />
                {editingId === item.id ? (
                  <form className="check-edit" onSubmit={(e) => void saveEdit(e, item)}>
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      aria-label={t('checklist.editAria', { text: item.text })}
                      maxLength={MAX_TEXT}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" type="submit" disabled={busy !== null}>
                      {t('common.save')}
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setEditingId(null);
                        setEditText('');
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="check-text">{item.text}</span>
                    <div className="check-tools">
                      <button
                        className="icon-btn"
                        type="button"
                        title={t('item.moveUp')}
                        aria-label={t('item.moveUp')}
                        disabled={i === 0 || busy !== null}
                        onClick={() => void run(item.id, () => moveCheckItem(item.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        title={t('item.moveDown')}
                        aria-label={t('item.moveDown')}
                        disabled={i === items.length - 1 || busy !== null}
                        onClick={() => void run(item.id, () => moveCheckItem(item.id, 1))}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        title={t('common.edit')}
                        aria-label={t('checklist.editAria', { text: item.text })}
                        disabled={busy !== null}
                        onClick={() => {
                          setEditingId(item.id);
                          setEditText(item.text);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        title={t('common.delete')}
                        aria-label={t('checklist.deleteAria', { text: item.text })}
                        disabled={busy !== null}
                        onClick={async () => {
                          if (!await ask(t('checklist.deleteQ', { text: item.text }), {
                            confirmLabel: t('common.delete'),
                            danger: true,
                          })) return;
                          await run(item.id, () => deleteCheckItem(item.id), t('checklist.deleted'));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
