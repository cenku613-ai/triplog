import { useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import { createMap, locate, pinAt } from '../lib/maplib';
import { reversePlace } from '../lib/places';
import { useUi } from '../app/ui';
import { useI18n } from '../i18n';

const PIN = '#0f766e';
const round = (n: number) => Number(n.toFixed(6));

/**
 * 表單裡的小地圖：點一下放圖釘、可按「用我的位置」。
 * 反查地名是加分項，失敗就安靜放過，座標已經先填進表單了。
 */
export function MapPicker({
  lat,
  lng,
  onPick,
}: {
  lat: number | null;
  lng: number | null;
  /** 第二次呼叫（帶 name）是反查回來的地名，呼叫端自己決定要不要用 */
  onPick: (lat: number, lng: number, name?: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useUi();
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const dotRef = useRef<L.CircleMarker | null>(null);
  const pickRef = useRef(onPick);
  /** 目前選中的座標字串：反查回來時比對，避免慢到的結果蓋掉新點 */
  const clicked = useRef('');
  const [nearing, setNearing] = useState('');
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);

  async function nameOf(la: number, ln: number) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const place = await reversePlace(la, ln);
      const name = place?.name?.trim();
      if (!name || clicked.current !== `${la},${ln}`) return;
      setNearing(name);
      pickRef.current(la, ln, name);
    } catch {
      /* 反查不到就算了，表單裡已經有座標 */
    }
  }

  // 只建一次：依赖塞 lat/lng 的話，每選一個點地圖就重建，互動會斷
  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const hasPoint = lat !== null && lng !== null;
    const map = createMap(host.current, {
      center: hasPoint ? [lat as number, lng as number] : undefined,
      zoom: hasPoint ? 15 : 13,
      scrollWheelZoom: false,
    });
    map.on('click', (e) => {
      const la = round(e.latlng.lat);
      const ln = round(e.latlng.lng);
      clicked.current = `${la},${ln}`;
      setNearing('');
      pickRef.current(la, ln);
      void nameOf(la, ln);
    });
    mapRef.current = map;
    // Modal 剛開時容器寬度還不定，延一拍才量得準
    const tick = window.setTimeout(() => map.invalidateSize(), 120);
    return () => {
      window.clearTimeout(tick);
      map.remove();
      mapRef.current = null;
      dotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lat === null || lng === null) {
      dotRef.current?.remove();
      dotRef.current = null;
      return;
    }
    const at: [number, number] = [lat, lng];
    if (!dotRef.current) dotRef.current = pinAt(lat, lng, PIN).addTo(map);
    else dotRef.current.setLatLng(at);
    if (!map.getBounds().pad(-0.15).contains(at)) map.setView(at, Math.max(map.getZoom(), 15));
  }, [lat, lng]);

  async function useMyLocation() {
    setLocating(true);
    const pos = await locate();
    setLocating(false);
    if (!pos) {
      toast(t('map.locateFailed'), { kind: 'error' });
      return;
    }
    const la = round(pos.lat);
    const ln = round(pos.lng);
    clicked.current = `${la},${ln}`;
    setNearing('');
    pickRef.current(la, ln);
    mapRef.current?.setView([la, ln], 16);
    void nameOf(la, ln);
  }

  return (
    <div className="stack-s">
      <div
        ref={host}
        className="map-box map-pick"
        role="application"
        aria-label={t('map.pick')}
        title={t('map.pick')}
      />
      <div className="row wrap" style={{ gap: 'var(--sp-2)' }}>
        <button type="button" className="btn btn-sm" onClick={() => void useMyLocation()} disabled={locating}>
          📍 {locating ? t('map.locating') : t('map.locate')}
        </button>
        <span className="tiny">{nearing ? t('map.nearby', { name: nearing }) : t('map.pickHint')}</span>
      </div>
    </div>
  );
}
