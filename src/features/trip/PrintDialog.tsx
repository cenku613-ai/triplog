import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { useUi } from '../../app/ui';
import { listPhotosOfTrip } from '../../db/repo';
import { blobToDataUrl } from '../../lib/images';
import { geoPoints } from '../../lib/geo';
import {
  DEFAULT_SECTIONS,
  buildPrintHtml,
  printableUrl,
  type PdfSections,
  type PrintPhoto,
} from '../../lib/pdf';
import type { Category, DayItem, Expense, Trip } from '../../db/types';
import type { TripSummary } from '../../lib/stats';

/**
 * 「產生 PDF」：選完內容 → 組一份 A4 可列印 HTML → 在 app 內的全螢幕預覽顯示，
 * 存檔動作交給文件裡那顆「列印」鈕（瀏覽器的列印對話框），所以不需要把
 * 整套 Chromium 打進 bundle。想換到別的分頁處理，再用「在新分頁開啟」。
 *
 * 地圖那一段才 dynamic import mapshot：沒勾「含地圖」就不該把 Leaflet 拉進來。
 */
export function PrintDialog({
  trip,
  items,
  expenses,
  categories,
  summary,
  onClose,
}: {
  trip: Trip;
  items: DayItem[];
  expenses: Expense[];
  categories: Category[];
  summary: TripSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useUi();
  const [sections, setSections] = useState<PdfSections>(DEFAULT_SECTIONS);
  const [busy, setBusy] = useState('');
  const [html, setHtml] = useState<string | null>(null);

  // 預覽是一份 Blob URL：關掉就釋放，不然照片的 base64 會跟著這份 HTML 一直留在記憶體
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!html) return;
    const next = printableUrl(html);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [html]);

  // 全螢幕預覽不是 Modal，Esc 與捲動鎖定自己在這裡補
  useEffect(() => {
    if (!html) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [html, onClose]);

  const toggles: { key: keyof PdfSections; label: string }[] = [
    { key: 'itinerary', label: t('print.opt.itinerary') },
    { key: 'expenses', label: t('print.opt.expenses') },
    { key: 'stats', label: t('print.opt.stats') },
    { key: 'photos', label: t('print.opt.photos') },
    { key: 'map', label: t('print.opt.map') },
  ];

  async function generate() {
    if (busy) return;
    try {
      let photos: PrintPhoto[] = [];
      if (sections.photos) {
        const rows = await listPhotosOfTrip(trip.id);
        for (let i = 0; i < rows.length; i++) {
          const p = rows[i];
          if (rows.length > 4) setBusy(t('print.photos', { i: i + 1, n: rows.length }));
          // 縮圖（最長邊 400）排進 3 欄約 42 mm，換算下來還有 240 dpi 左右，
          // 列印夠清楚，文件也不會撐到幾十 MB。
          photos.push({
            id: p.id,
            dayItemId: p.dayItemId ?? null,
            dataUrl: await blobToDataUrl(p.thumb),
            caption: p.caption,
            artist: p.artist,
            license: p.license,
            creditUrl: p.creditUrl,
          });
        }
      }

      let mapImage: string | null = null;
      if (sections.map) {
        setBusy(t('print.mapWorking'));
        const points = geoPoints(items, trip.startDate);
        if (points.length) {
          const { captureMap } = await import('../../lib/mapshot');
          mapImage = (await captureMap(points))?.dataUrl ?? null;
        }
      }

      setBusy(t('print.working'));
      setHtml(
        buildPrintHtml({ trip, items, expenses, categories, summary, sections, photos, mapImage }),
      );
    } catch (err) {
      toast(`${t('print.working')}：${(err as Error)?.message ?? String(err)}`, { kind: 'error' });
    } finally {
      setBusy('');
    }
  }

  if (html) {
    return (
      <div className="print-preview" role="dialog" aria-modal="true" aria-label={t('print.title')}>
        <div className="print-bar">
          <b>{t('print.previewTitle')}</b>
          <span className="grow" />
          <button
            className="btn btn-sm"
            onClick={() => {
              // 這一顆才是真的需要彈窗權限：按下去就是使用者的一擊，window.open 不會過期
              const win = url ? window.open(url, '_blank') : null;
              if (!win) toast(t('print.blocked'), { kind: 'error' });
            }}
          >
            {t('print.openTab')}
          </button>
          <button className="btn btn-sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        {url ? <iframe className="print-frame" src={url} title={t('print.previewTitle')} /> : null}
      </div>
    );
  }

  return (
    <Modal
      title={t('print.title')}
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary btn-block"
          onClick={() => void generate()}
          disabled={!!busy}
        >
          {busy || t('print.btn')}
        </button>
      }
    >
      <div className="stack">
        <div className="row wrap" role="group" aria-label={t('print.optionsAria')}>
          {toggles.map((x) => (
            <button
              key={x.key}
              type="button"
              className={`chip${sections[x.key] ? ' on' : ''}`}
              aria-pressed={sections[x.key]}
              onClick={() => setSections((s) => ({ ...s, [x.key]: !s[x.key] }))}
            >
              {x.label}
            </button>
          ))}
        </div>
        <p className="tiny">{t('print.tip')}</p>
        {sections.photos ? <p className="tiny">{t('print.photoHint')}</p> : null}
        {sections.map ? <p className="tiny">{t('print.mapHint')}</p> : null}
      </div>
    </Modal>
  );
}

export default PrintDialog;
