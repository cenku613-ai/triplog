import { useState } from 'react';
import { useI18n } from '../i18n';

const MAX_COMPANIONS = 20;
const MAX_NAME = 20;

function normalise(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().slice(0, MAX_NAME);
    if (!name) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= MAX_COMPANIONS) break;
  }
  return out;
}

/**
 * 隨行人員名單編輯器。
 * 名單只是 Trip 上的一個字串陣列，動到它不會影響已記錄的支出（那些存的是付款人文字）。
 */
export function CompanionEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  function add() {
    const name = draft.trim();
    if (!name) return;
    if (normalise([...value, name]).length !== value.length + 1) {
      setDraft('');
      return; // 重複的就當它加好了，不另外打擾
    }
    onChange(normalise([...value, name]));
    setDraft('');
  }

  return (
    <div className="stack-s">
      {value.length ? (
        <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
          {value.map((name) => (
            <span className="chip" key={name}>
              {name}
              <button
                type="button"
                className="chip-x"
                aria-label={t('trip.companionRemoveAria', { name })}
                onClick={() => onChange(value.filter((x) => x !== name))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 14 }}>
          {t('trip.companionsEmpty')}
        </p>
      )}
      <div className="row">
        <input
          className="grow"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('trip.companionPlaceholder')}
          maxLength={MAX_NAME}
          aria-label={t('trip.companionPlaceholder')}
          disabled={value.length >= MAX_COMPANIONS}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!draft.trim() || value.length >= MAX_COMPANIONS}>
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

/** 記支出時從名單快點付款人；仍可自己打字（名單外的人也能記） */
export function PayerChips({
  companions,
  value,
  onPick,
}: {
  companions: string[];
  value: string;
  onPick: (name: string) => void;
}) {
  const { t } = useI18n();
  const names = companions.filter((n) => n !== value.trim());
  if (!names.length) return null;
  return (
    <div className="row wrap" style={{ gap: 'var(--sp-2)', marginTop: 6 }}>
      <span className="tiny">{t('expense.payeePick')}</span>
      {names.map((n) => (
        <button type="button" className="chip" key={n} onClick={() => onPick(n)}>
          {n}
        </button>
      ))}
    </div>
  );
}
