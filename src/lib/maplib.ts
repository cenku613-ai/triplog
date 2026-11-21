import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { isValidLatLng } from './places';

/**
 * Leaflet 的進入點集中在這裡：兩個地圖元件共用同一套底圖與圖釘樣式。
 *
 * 圖釘用 circleMarker 而不是內設 icon —— Leaflet 的 premake 圖示走相對 URL，
 * 打進 bundle 後一定 404，圓點既能著色又不需要額外圖檔。
 */

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** 沒座標也沒位置權限時的第一站：台北 */
export const DEFAULT_CENTER: [number, number] = [25.033, 121.565];

export interface MapOptions {
  center?: [number, number];
  zoom?: number;
  scrollWheelZoom?: boolean;
}

export function createMap(el: HTMLElement, opts: MapOptions = {}): L.Map {
  const map = L.map(el, {
    center: opts.center ?? DEFAULT_CENTER,
    zoom: opts.zoom ?? 13,
    // 表單裡的小地圖最怕滾輪誤觸，整頁地圖才開放
    scrollWheelZoom: opts.scrollWheelZoom ?? true,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    crossOrigin: true,
    attribution: TILE_ATTRIBUTION,
  }).addTo(map);
  return map;
}

export function pinAt(lat: number, lng: number, color: string, opts: { radius?: number } = {}): L.CircleMarker {
  return L.circleMarker([lat, lng], {
    radius: opts.radius ?? 9,
    color: '#ffffff',
    weight: 2,
    fillColor: color,
    fillOpacity: 0.95,
  });
}

/** 定位成功與否回傳座標，失敗讓呼叫端決定要說什麼 */
export function locate(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve(
          isValidLatLng(pos.coords.latitude, pos.coords.longitude)
            ? { lat: pos.coords.latitude, lng: pos.coords.longitude }
            : null,
        ),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

/** Leaflet 的 popup 是 HTML 字串，使用者打的字一定要逃脫 */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
