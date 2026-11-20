import type { DayItem, ISODate } from '../db/types';
import { dayIndex } from './dates';
import { isValidLatLng } from './places';

/**
 * 地圖用的純函數：把「有座標的行程項」整理成畫圖要的形状。
 * 抽出來是因為 Leaflet 本體在 node 測試裡跑不起來，這層卻需要被驗證。
 */

/** 依天數輪替的顏色，第 1 天用品牌色，之後盡量拉開色相 */
const DAY_COLORS = [
  '#0f766e',
  '#c2410c',
  '#1d4ed8',
  '#7c3aed',
  '#15803d',
  '#b45309',
  '#be123c',
  '#0891b2',
];

export function dayColor(day: number): string {
  const i = (Math.max(1, Math.trunc(day)) - 1) % DAY_COLORS.length;
  return DAY_COLORS[i];
}

export interface GeoPoint {
  item: DayItem;
  lat: number;
  lng: number;
  /** 旅行第幾天（1 起）；日期跑出差錯時退回 1 */
  day: number;
}

/** 只有 lat/lng 都合法的行程項会上圖 */
export function geoPoints(items: DayItem[], tripStart: ISODate): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (const item of items) {
    if (!isValidLatLng(item.lat, item.lng)) continue;
    out.push({
      item,
      lat: item.lat as number,
      lng: item.lng as number,
      day: dayIndex(tripStart, item.date) ?? 1,
    });
  }
  return out.sort((a, b) => a.day - b.day || a.item.order - b.item.order);
}

export interface Box {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** 包住所有點的最小矩形；空集合回傳 null */
export function boundsOf(points: { lat: number; lng: number }[]): Box | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

export function centerOf(box: Box): { lat: number; lng: number } {
  return { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 };
}

/** 所有點重疊在同一處時 fitBounds 沒有面積可套，這種情況改走 setView（一條線還是給它 fit） */
export function isDegenerate(box: Box): boolean {
  return box.maxLat - box.minLat < 1e-6 && box.maxLng - box.minLng < 1e-6;
}
