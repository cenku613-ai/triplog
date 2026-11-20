import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { PlaceError, searchPlaces, type Place, type PlaceErrorKind } from '../lib/places';

type Status = 'idle' | 'loading' | 'done' | 'empty' | 'error';

/**
 * 上網找地點（OpenStreetMap Nominatim）。
 * 只送搜尋字出去，選了才寫進本機資料庫；離線時顯示提示而不是偷偷壞掉。
 */
export function PlaceSearch({ onPick }: { onPick: (place: Place) => void }) {
  const { t, lang } = useI18n();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Place[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [errorKind, setErrorKind] = useState<PlaceErrorKind>('offline');
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setStatus('idle');
      return;
    }
    const mine = ++seq.current;
    setStatus('loading');
    const timer = setTimeout(() => {
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      void searchPlaces(q, { lang, signal: ac.signal })
        .then((rows) => {
          if (mine !== seq.current) return;
          setHits(rows);
          setStatus(rows.length ? 'done' : 'empty');
        })
        .catch((err: unknown) => {
          if (mine !== seq.current) return;
          if (err instanceof PlaceError && err.kind === 'aborted') return;
          setErrorKind(err instanceof PlaceError ? err.kind : 'http');
          setStatus('error');
        });
    }, 550);
    return () => clearTimeout(timer);
  }, [query, lang]);

  // 關掉彈窗時把還在飞的請求斷掉
  useEffect(() => () => void ctrl.current?.abort(), []);

  const errorText =
    errorKind === 'offline'
      ? t('item.searchOffline')
      : errorKind === 'rate'
        ? t('item.searchRate')
        : t('item.searchFailed');

  return (
    <div className="stack-s">
      <div className="row">
        <input
          className="grow"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('item.placeSearchPlaceholder')}
          aria-label={t('item.placeSearchAria')}
          autoComplete="off"
          enterKeyHint="search"
        />
        {status === 'loading' ? <span className="tiny spin">⋯</span> : null}
      </div>

      {status === 'error' ? (
        <p className="tiny" role="status" style={{ color: 'var(--danger)' }}>
          {errorText}
        </p>
      ) : null}
      {status === 'empty' ? (
        <p className="tiny" role="status">
          {t('item.noResult', { q: query.trim() })}
        </p>
      ) : null}
      {status === 'loading' && hits.length === 0 ? (
        <p className="tiny" role="status">
          {t('item.searching')}
        </p>
      ) : null}

      {hits.length ? (
        <>
          <ul className="place-list">
            {hits.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="place"
                  title={p.label}
                  aria-label={t('item.useResult')}
                  onClick={() => {
                    onPick(p);
                    setHits([]);
                    setStatus('idle');
                    setQuery('');
                  }}
                >
                  <span className="nm">{p.name}</span>
                  <span className="rg">{p.region || p.type}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="tiny">{t('item.attribution')}</p>
        </>
      ) : null}
    </div>
  );
}
