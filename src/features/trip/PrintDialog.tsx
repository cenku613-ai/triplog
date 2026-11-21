import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { useI18n } from '../../i18n';
import { useUi } from '../../app/ui';
import { listPhotosOfTrip } from '../../db/repo';
import { blobToDataUrl } from '../../lib/images';
import { geoPoints } from '../../lib/geo';
import {
  DEFAULT_SECTIONS,
  buildPrintHtml,
  openPrintView,
  type PdfSections,
  type PrintPhoto,
} from '../../lib/pdf';
import type { Category, DayItem, Expense, Trip } from '../../db/types';
import type { TripSummary } from '../../lib/stats';

/**
 * 「產生 PDF」的選項面板：選完內容按一顆鈕，文件開在新分頁，
 * 存檔動作交給瀏覽器的列印對話框（所以不需要把整套 Chromium 打進 bundle）。
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
      const html = buildPrintHtml({
        trip,
        items,
        expenses,
        categories,
        summary,
        sections,
        photos,
        mapImage,
      });
      if (!openPrintView(html)) {
        toast(t('print.blocked'), { kind: 'error' });
        return;
      }
      onClose();
    } catch (err) {
      toast(`${t('print.working')}：${(err as Error)?.message ?? String(err)}`, { kind: 'error' });
    } finally {
      setBusy('');
    }
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
