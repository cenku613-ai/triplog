import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { CommonsPicker } from './CommonsPicker';
import { downloadCommons, type CommonsHit } from '../lib/commons';
import { previewUrl, rasterize, type Raster } from '../lib/images';
import type { Photo } from '../db/types';
import { useUi } from '../app/ui';
import { useI18n } from '../i18n';

/** 一趟旅行最多存幾張：以壓縮後約 300 KB 計，60 張大概 20 MB，瀏覽器還撐得住 */
export const MAX_TRIP_PHOTOS = 60;

export type Credit = { url?: string; artist?: string; license?: string };

/** local = 還沒按「完成」的暫存圖；saved = 已在 IndexedDB 的照片 */
export type Shot =
  | { id: string; kind: 'local'; raster: Raster; caption?: string; credit?: Credit }
  | { id: string; kind: 'saved'; photo: Photo };

export type LocalShot = Extract<Shot, { kind: 'local' }>;

export const shotImage = (s: Shot): Blob => (s.kind === 'local' ? s.raster.blob : s.photo.blob);
export const shotThumb = (s: Shot): Blob => (s.kind === 'local' ? s.raster.thumb : s.photo.thumb);

export function shotCredit(s: Shot): Credit {
  if (s.kind === 'local') return s.credit ?? {};
  return { url: s.photo.creditUrl, artist: s.photo.artist, license: s.photo.license };
}

export const savedShots = (rows: Photo[]): Shot[] => rows.map((p) => ({ id: p.id, kind: 'saved', photo: p }));

/** Blob → 可顯示的 URL，元件卸載時回收，否則每次重開相本牆就多留一張圖在記憶體 */
export function Thumb({
  blob,
  alt,
  className,
  onClick,
}: {
  blob: Blob;
  alt?: string;
  className?: string;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = previewUrl(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return <span className={`thumb ${className ?? ''} thumb-skel`} aria-hidden="true" />;
  return (
    <img
      src={url}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className={`thumb ${className ?? ''}`}
      onClick={onClick}
    />
  );
}

/* ------------------------------------------------------------ 相本牆（表單內） */

export function PhotoWall({
  shots,
  remaining,
  onAdd,
  onRemove,
  onOpen,
}: {
  shots: Shot[];
  /** 這趟旅行還塞得下幾張 */
  remaining: number;
  onAdd: (raster: Raster, credit: Credit, caption?: string) => void;
  onRemove: (shot: Shot) => void;
  onOpen: (index: number) => void;
}) {
  const { toast } = useUi();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [showCommons, setShowCommons] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  async function ingest(files: File[]): Promise<void> {
    const room = Math.min(files.length, Math.max(0, remaining));
    if (room === 0) {
      toast(t('photo.limit', { n: MAX_TRIP_PHOTOS }), { kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      for (const f of files.slice(0, room)) {
        const raster = await rasterize(f);
        onAdd(raster, {}, f.name.replace(/\.[^.]+$/, '').slice(0, 60));
      }
    } catch {
      toast(t('photo.readFailed'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = [...(e.target.files ?? [])].filter((f) => f.type.startsWith('image/'));
    e.target.value = ''; // 同一張圖連按兩次也要能重試
    if (list.length) void ingest(list);
  };

  async function addCommons(list: CommonsHit[]) {
    setShowCommons(false);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const h of list.slice(0, Math.max(0, remaining))) {
        const blob = await downloadCommons(h);
        onAdd(await rasterize(blob), { url: h.pageUrl, artist: h.artist, license: h.license }, h.title.slice(0, 60));
      }
    } catch (err) {
      const offline = err instanceof Error && (err.message === 'offline' || err.name === 'TypeError');
      toast(t(offline ? 'photo.offline' : 'photo.failed'), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-s">
      <div className="photo-grid">
        {shots.map((s, i) => (
          <div className="photo-cell" key={s.id}>
            <button
              type="button"
              className="photo-open"
              onClick={() => onOpen(i)}
              aria-label={t('photo.openAria')}
              title={s.kind === 'local' ? s.caption ?? '' : s.photo.caption ?? ''}
            >
              <Thumb blob={shotThumb(s)} alt="" />
            </button>
            <button
              type="button"
              className="photo-x"
              onClick={() => onRemove(s)}
              aria-label={t('photo.removeAria')}
              title={t('common.delete')}
            >
              ✕
            </button>
            {shotCredit(s).license ? <span className="photo-lic">{shotCredit(s).license}</span> : null}
          </div>
        ))}
      </div>

      <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
        <input
          ref={pickerRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={onFiles}
          aria-hidden="true"
          tabIndex={-1}
        />
        {/* capture 讓 Android 直接開後鏡頭；iOS 支援選單裡含相機 */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFiles}
          aria-hidden="true"
          tabIndex={-1}
        />
        <button type="button" className="btn btn-sm" onClick={() => cameraRef.current?.click()} disabled={busy}>
          📷 {t('photo.addCamera')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => pickerRef.current?.click()} disabled={busy}>
          {t('photo.addDevice')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setShowCommons(true)} disabled={busy}>
          {t('photo.addCommons')}
        </button>
        {busy ? <span className="tiny spin">{t('photo.busy')}</span> : null}
        {shots.length ? <span className="tiny" style={{ marginLeft: 'auto' }}>{t('photo.count', { n: shots.length })}</span> : null}
      </div>

      <p className="tiny">{t('photo.hint')}</p>

      {showCommons ? <CommonsPicker onPick={(list) => void addCommons(list)} onClose={() => setShowCommons(false)} /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- 大圖檢視 */

export function PhotoViewer({
  shots,
  index,
  onIndex,
  onClose,
}: {
  shots: Shot[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const shot = shots[index];
  const credit = shot ? shotCredit(shot) : {};
  const caption = shot ? (shot.kind === 'local' ? shot.caption : shot.photo.caption) : '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < shots.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [index, shots.length, onIndex, onClose]);

  if (!shot) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('photo.viewAria')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lb-top">
        <span className="badge">
          {t('photo.counter', { i: index + 1, n: shots.length })}
        </span>
        <button className="icon-btn lb-close" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="lb-stage">
        {index > 0 ? (
          <button className="lb-nav" onClick={() => onIndex(index - 1)} aria-label={t('photo.prev')}>
            ‹
          </button>
        ) : (
          <span />
        )}
        <Thumb blob={shotImage(shot)} alt={caption ?? ''} className="lb-img" />
        {index < shots.length - 1 ? (
          <button className="lb-nav" onClick={() => onIndex(index + 1)} aria-label={t('photo.next')}>
            ›
          </button>
        ) : (
          <span />
        )}
      </div>

      <div className="lb-foot">
        {caption ? <div className="lb-cap">{caption}</div> : null}
        <div className="row wrap" style={{ gap: 'var(--sp-3)', justifyContent: 'center' }}>
          {credit.artist ? (
            <span className="tiny">
              {t('photo.credit', { artist: credit.artist, license: credit.license ?? '' })}
            </span>
          ) : null}
          {credit.url ? (
            <a className="tiny" href={credit.url} target="_blank" rel="noreferrer noopener" title={t('photo.creditAria')}>
              Wikimedia
            </a>
          ) : null}
          <DownloadLink shot={shot} />
        </div>
      </div>
    </div>
  );
}

function DownloadLink({ shot }: { shot: Shot }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = previewUrl(shotImage(shot));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [shot]);
  return (
    <a className="tiny" href={url} download={`triplog-${shot.id}.jpg`}>
      {t('photo.download')}
    </a>
  );
}
