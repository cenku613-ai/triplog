import { describe, expect, it } from 'vitest';
import { googleMapsDirectionsUrl } from './navigation';

describe('Google Maps 導航網址', () => {
  it('使用官方 Directions URL，只帶目的地座標', () => {
    const url = new URL(googleMapsDirectionsUrl(25.033, 121.5654)!);
    expect(url.origin).toBe('https://www.google.com');
    expect(url.pathname).toBe('/maps/dir/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('25.033,121.5654');
    expect([...url.searchParams.keys()]).toEqual(['api', 'destination']);
  });

  it.each([
    [90, 180],
    [-90, -180],
    [0, 0],
    [-33.8688, 151.2093],
  ])('接受合法邊界與南半球座標 %s, %s', (lat, lng) => {
    const url = new URL(googleMapsDirectionsUrl(lat, lng)!);
    expect(url.searchParams.get('destination')).toBe(`${lat},${lng}`);
  });

  it.each([
    [null, 121.5],
    [25, undefined],
    ['25', 121.5],
    [NaN, 121.5],
    [25, Infinity],
    [90.001, 0],
    [-90.001, 0],
    [0, 180.001],
    [0, -180.001],
  ])('拒絕缺少或超出範圍的座標 %s, %s', (lat, lng) => {
    expect(googleMapsDirectionsUrl(lat, lng)).toBeNull();
  });
});
