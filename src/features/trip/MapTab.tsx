import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { createMap, esc, pinAt } from '../../lib/maplib';
import { boundsOf, centerOf, dayColor, geoPoints, isDegenerate, type GeoPoint } from '../../lib/geo';
import { dayLabel, formatDuration, prettyDate } from '../../lib/dates';
import { Empty } from '../../components/Controls';
import type { DayItem, Trip } from '../../db/types';
import { useI18n } from '../../i18n';
import { NavigationLink } from '../../components/NavigationLink';

/**
 * 旅行地圖：把有座標的行程項畫在同一張圖上，同一天同一色。
 * 資料全從本機 IndexedDB 來，只有底圖瓦片會向 OpenStreetMap 拿（Workbox 會快取）。
 */
export function MapTab({
  trip,
  items,
  onOpen,
}: {
  trip: Trip;
  items: DayItem[];
  onOpen: (item: DayItem) => void;
}) {
  const { t, lang } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const dots = useRef(new Map<string, L.CircleMarker>());
  const fitted = useRef('');

  const points = useMemo(() => geoPoints(items, trip.startDate), [items, trip.startDate]);
  const byDay = useMemo(() => {
    const map = new Map<number, GeoPoint[]>();
    for (const p of points) {
      const arr = map.get(p.day) ?? [];
      arr.push(p);
      map.set(p.day, arr);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [points]);

  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const map = createMap(host.current, { scrollWheelZoom: true });
    const layer = L.layerGroup();
    layerRef.current = layer;
    layer.addTo(map);
    mapRef.current = map;
    const tick = window.setTimeout(() => map.invalidateSize(), 80);
    return () => {
      window.clearTimeout(tick);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      dots.current.clear();
    };
  }, []);

  // 語言換掉時 popup 裡的日期文案也要跟著換，所以重畫一次圖釘
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    dots.current.clear();
    for (const p of points) {
      const dot = pinAt(p.lat, p.lng, dayColor(p.day));
      const when = formatDuration(p.item.startTime, p.item.endTime);
      dot.bindPopup(
        `<div class="map-pop"><strong>${esc(p.item.title)}</strong>` +
          `<span>${esc(dayLabel(p.day))} · ${esc(prettyDate(p.item.date))}${when ? ` · ${esc(when)}` : ''}</span>` +
          `${p.item.location ? `<span>${esc(p.item.location)}</span>` : ''}</div>`,
        { closeButton: true },
      );
      dot.addTo(layer);
      dots.current.set(p.item.id, dot);
    }
    const sig = points.map((p) => `${p.item.id}:${p.lat},${p.lng}`).join('|');
    if (sig && sig !== fitted.current) {
      fitted.current = sig;
      const box = boundsOf(points);
      if (box && !isDegenerate(box)) {
        map.fitBounds(
          [
            [box.minLat, box.minLng],
            [box.maxLat, box.maxLng],
          ],
          { padding: [36, 36], maxZoom: 15 },
        );
      } else if (box) {
        const c = centerOf(box);
        map.setView([c.lat, c.lng], 15);
      }
    }
  }, [points, lang]);

  function jumpTo(p: GeoPoint) {
    const map = mapRef.current;
    if (!map) return;
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
    dots.current.get(p.item.id)?.openPopup();
  }

  if (points.length === 0) {
    return (
      <Empty
        icon="🗺️"
        title={t('map.empty')}
        body={t('map.emptyBody')}
        action={
          items.length ? (
            <button className="btn btn-primary" onClick={() => onOpen(items[0])}>
              {t('detail.addItem')}
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="map-tab">
      <div ref={host} className="map-box" role="application" aria-label={t('tab.map')} />
      <aside className="card card-pad map-side">
        <div className="row-between" style={{ marginBottom: 'var(--sp-2)' }}>
          <h3>{t('tab.map')}</h3>
          <span className="tiny">{t('map.count', { n: points.length })}</span>
        </div>
        <div className="stack-s" role="list" aria-label={t('map.listAria')}>
          {byDay.map(([day, rows]) => (
            <div key={day}>
              <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 4 }}>
                <i className="legend-dot" style={{ background: dayColor(day) }} aria-hidden="true" />
                <span className="tiny" style={{ fontWeight: 700 }}>
                  {dayLabel(day)} · {prettyDate(rows[0].item.date)}
                </span>
              </div>
              {rows.map((p) => (
                <div className="row map-row" key={p.item.id} style={{ gap: 'var(--sp-2)' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm grow"
                    style={{ textAlign: 'left' }}
                    onClick={() => jumpTo(p)}
                  >
                    {p.item.title}
                  </button>
                  <NavigationLink lat={p.lat} lng={p.lng} title={p.item.title} compact />
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('map.openItem')}
                    aria-label={t('map.openItem')}
                    onClick={() => onOpen(p.item)}
                  >
                    ✎
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="tiny" style={{ marginTop: 'var(--sp-3)' }}>
          {t('map.attribution')}
        </p>
      </aside>
    </div>
  );
}
