import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { searchCommons, type CommonsHit } from '../lib/commons';
import { useI18n } from '../i18n';

const DEBOUNCE = 550;

/**
 * Wikimedia Commons 選圖：先搜、勾選，再一次加入。
 * 這裡只回傳 hit，下載與壓縮由呼叫端做，因為要存進 IndexedDB 的是 Blob 而不是 URL。
 */
export function CommonsPicker({
  onPick,
  onClose,
}: {
  onPick: (hits: CommonsHit[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<CommonsHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'empty' | 'error'>('idle');
  const [picked, setPicked] = useState<string[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const query = q.trim();
    if (query.length < 2) {
      setStatus('idle');
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    setStatus('loading');
    const timer = window.setTimeout(() => {
      void searchCommons(query, { signal: ctrl.signal, limit: 16 })
        .then((rows) => {
          if (seq.current !== n) return;
          setHits(rows);
          setStatus(rows.length ? 'done' : 'empty');
        })
        .catch((err: unknown) => {
          if (seq.current !== n) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setHits([]);
          setStatus('error');
        });
    }, DEBOUNCE);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  const byKey = new Map(hits.map((h) => [h.key, h]));
  const chosen = picked.map((k) => byKey.get(k)).filter((h): h is CommonsHit => Boolean(h));

  return (
    <Modal
      title={t('commons.title')}
      onClose={onClose}
      wide
      footer={
        <div className="row-between">
          <span className="tiny">{t('commons.hint')}</span>
          <div className="row">
            {chosen.length ? <span className="badge">{t('commons.selected', { n: chosen.length })}</span> : null}
            <button className="btn btn-primary" disabled={chosen.length === 0} onClick={() => onPick(chosen)}>
              {t('commons.addSelected')}
            </button>
          </div>
        </div>
      }
    >
      <div className="stack-s">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('commons.placeholder')}
          aria-label={t('commons.aria')}
          autoComplete="off"
        />
        {status === 'loading' ? <div className="tiny spin">{t('commons.searching')}</div> : null}
        {status === 'empty' || status === 'error' ? (
          <p className="muted" style={{ fontSize: 14 }}>
            {t('commons.none')}
          </p>
        ) : null}

        {hits.length ? (
          <div className="commons-grid">
            {hits.map((h) => {
              const on = picked.includes(h.key);
              return (
                <button
                  type="button"
                  key={h.key}
                  className="commons-cell"
                  aria-pressed={on}
                  title={h.title}
                  onClick={() =>
                    setPicked((prev) => (on ? prev.filter((k) => k !== h.key) : [...prev, h.key]))
                  }
                >
                  <img src={h.thumbUrl} alt={h.title} loading="lazy" />
                  <span className="cap">{h.title}</span>
                  {h.license ? <span className="lic">{h.license}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
