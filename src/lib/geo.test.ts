import { describe, expect, it } from 'vitest';
import type { DayItem } from '../db/types';
import { boundsOf, centerOf, dayColor, geoPoints, isDegenerate } from './geo';

/** 只測純函數：Leaflet 要 DOM，node 環境裡叫不起來 */

function item(over: Partial<DayItem> = {}): DayItem {
  return {
    id: 'i1',
    tripId: 't1',
    date: '2026-11-02',
    kind: 'sight',
    title: '清水寺',
    location: '',
    order: 10,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

describe('地圖資料整理', () => {
  it('只有座標合法的行程項會上圖，並依天數與排序排出', () => {
    const points = geoPoints(
      [
        item({ id: 'a', date: '2026-11-03', lat: 35.01, lng: 135.77, order: 20 }),
        item({ id: 'b', date: '2026-11-02', lat: 35.0, lng: 135.7, order: 30 }),
        item({ id: 'c', date: '2026-11-02', lat: 35.0, lng: 135.7, order: 10 }),
        item({ id: 'no-coords' }),
        item({ id: 'nulls', lat: null, lng: null }),
        item({ id: 'bad', lat: 12345, lng: 0 }),
      ],
      '2026-11-01',
    );
    expect(points.map((p) => p.item.id)).toEqual(['c', 'b', 'a']);
    expect(points.map((p) => p.day)).toEqual([2, 2, 3]);
  });

  it('同一天同一色，隔天才換色，色票用完會輪回來', () => {
    expect(dayColor(1)).toBe(dayColor(1));
    expect(dayColor(2)).not.toBe(dayColor(1));
    expect(dayColor(9)).toBe(dayColor(1)); // 8 天一輪
    expect(dayColor(0)).toBe(dayColor(1)); // 不應出現第 0 天， defensively 退回第一天
  });

  it('外接矩形與中心點', () => {
    const box = boundsOf([
      { lat: 25.0, lng: 121.5 },
      { lat: 25.2, lng: 121.7 },
    ]);
    expect(box).toEqual({ minLat: 25.0, maxLat: 25.2, minLng: 121.5, maxLng: 121.7 });
    expect(centerOf(box!)).toEqual({ lat: 25.1, lng: 121.6 });
  });

  it('沒有任何點時回傳 null，同一點不會讓 fitBounds 炸掉', () => {
    expect(boundsOf([])).toBeNull();
    const one = boundsOf([{ lat: 25.03, lng: 121.56 }]);
    expect(isDegenerate(one!)).toBe(true);
    expect(isDegenerate(boundsOf([{ lat: 25.03, lng: 121.56 }, { lat: 25.04, lng: 121.56 }])!)).toBe(
      false,
    );
  });
});
