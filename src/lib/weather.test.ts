import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayItem, Trip } from '../db/types';
import {
  buildWeatherPlan,
  clearWeatherCache,
  forecastWindow,
  loadWeather,
  weatherUrl,
  type WeatherLocation,
} from './weather';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const trip: Trip = {
  id: 't1',
  name: '京都',
  startDate: '2026-11-24',
  endDate: '2026-11-26',
  baseCurrency: 'TWD',
  color: '#0f766e',
  archived: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function item(over: Partial<DayItem> = {}): DayItem {
  return {
    id: 'i1',
    tripId: 't1',
    date: '2026-11-24',
    kind: 'sight',
    title: '清水寺',
    location: '京都',
    order: 10,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function location(key = '35.0000,135.7600'): WeatherLocation {
  const [lat, lng] = key.split(',').map(Number);
  return { key, lat, lng, name: key };
}

function rawForecast(dates: string[], code = 2) {
  return {
    timezone: 'Asia/Tokyo',
    daily: {
      time: dates,
      weather_code: dates.map(() => code),
      temperature_2m_max: dates.map((_, i) => 20 + i),
      temperature_2m_min: dates.map((_, i) => 10 + i),
      precipitation_probability_max: dates.map(() => 30),
      precipitation_sum: dates.map(() => 1.5),
      wind_speed_10m_max: dates.map(() => 12),
    },
  };
}

function stubFetch(data: unknown, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  clearWeatherCache();
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearWeatherCache();
});

describe('行程天氣計畫', () => {
  it('只取旅行範圍內的合法座標，同一天同一地點只出現一次', () => {
    const plan = buildWeatherPlan(
      trip,
      [
        item({ id: 'a', location: '清水寺', lat: 34.99486, lng: 135.785 }),
        item({ id: 'b', location: '另一個名字', lat: 34.99491, lng: 135.78496, order: 20 }),
        item({ id: 'c', date: '2026-11-25', location: '嵐山', lat: 35.0146, lng: 135.6733 }),
        item({ id: 'd', date: '2026-11-26', lat: null, lng: null }),
        item({ id: 'e', date: '2026-11-23', lat: 1, lng: 1 }),
        item({ id: 'f', date: '2026-11-25', lat: 91, lng: 1 }),
      ],
      '2026-11-25',
    );
    expect(plan.window).toEqual({ start: '2026-11-24', end: '2026-11-26' });
    expect(plan.days.map((day) => day.locations.length)).toEqual([1, 1, 0]);
    expect(plan.days[0].locations[0]).toMatchObject({ key: '34.9949,135.7850', name: '清水寺' });
    expect(plan.activeLocations).toHaveLength(2);
  });

  it('沒有座標時仍保留每天，但不會產生請求地點', () => {
    const plan = buildWeatherPlan(trip, [item({ lat: null, lng: null })], '2026-11-25');
    expect(plan.days).toHaveLength(3);
    expect(plan.locations).toEqual([]);
    expect(plan.activeLocations).toEqual([]);
  });

  it('把長旅行限制在過去 92 天與未來 16 天內', () => {
    expect(forecastWindow('2026-08-01', '2027-01-01', '2026-11-25')).toEqual({
      start: '2026-08-25',
      end: '2026-12-11',
    });
    expect(forecastWindow('2025-01-01', '2025-01-03', '2026-11-25')).toBeNull();
    expect(forecastWindow('2027-01-01', '2027-01-03', '2026-11-25')).toBeNull();
  });

  it('請求 URL 包含當地時區、日期範圍與每日氣象欄位', () => {
    const url = new URL(weatherUrl([location()], { start: '2026-11-24', end: '2026-11-26' }));
    expect(url.hostname).toBe('api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('35.0000');
    expect(url.searchParams.get('longitude')).toBe('135.7600');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('start_date')).toBe('2026-11-24');
    expect(url.searchParams.get('end_date')).toBe('2026-11-26');
    expect(url.searchParams.get('daily')).toContain('precipitation_probability_max');
    expect(url.searchParams.has('apikey')).toBe(false);
  });
});

describe('天氣 API 與離線快取', () => {
  const range = { start: '2026-11-24' as const, end: '2026-11-25' as const };

  it('解析多地點回應，並把數值與日期一一對應', async () => {
    stubFetch([
      rawForecast(['2026-11-24', '2026-11-25'], 2),
      rawForecast(['2026-11-24', '2026-11-25'], 61),
    ]);
    const result = await loadWeather([location(), location('35.0100,135.6700')], range);
    expect(result['35.0000,135.7600']).toMatchObject({
      status: 'ready',
      forecast: {
        timezone: 'Asia/Tokyo',
        days: [
          { date: '2026-11-24', code: 2, tempMax: 20, rainChance: 30 },
          { date: '2026-11-25', code: 2 },
        ],
      },
    });
    expect(result['35.0100,135.6700']).toMatchObject({
      status: 'ready',
      forecast: { days: [{ code: 61 }, { code: 61 }] },
    });
  });

  it('一小時內重用快取，不重複打 API', async () => {
    const fetchMock = stubFetch(rawForecast(['2026-11-24', '2026-11-25']));
    await loadWeather([location()], range);
    const second = await loadWeather([location()], range);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[location().key].status).toBe('ready');
  });

  it('手動重新整理會重抓快取，失敗時仍保留可用的舊預報', async () => {
    stubFetch(rawForecast(['2026-11-24', '2026-11-25'], 2));
    await loadWeather([location()], range);
    const fetchMock = stubFetch(rawForecast(['2026-11-24', '2026-11-25'], 61));
    const refreshed = await loadWeather([location()], range, undefined, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed[location().key]).toMatchObject({ status: 'ready', forecast: { days: [{ code: 61 }, { code: 61 }] } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await loadWeather([location()], range, undefined, true)).toMatchObject({
      [location().key]: { status: 'stale', forecast: { days: [{ code: 61 }, { code: 61 }] } },
    });
  });

  it('快取過期但離線時仍回傳舊資料，並標成 stale', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    stubFetch(rawForecast(['2026-11-24', '2026-11-25']));
    await loadWeather([location()], range);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 60 * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const result = await loadWeather([location()], range);
    expect(result[location().key]).toMatchObject({
      status: 'stale',
      forecast: { days: [{ code: 2 }, { code: 2 }] },
    });
  });

  it('恢復上網後會更新過期快取', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    stubFetch(rawForecast(['2026-11-24', '2026-11-25'], 2));
    await loadWeather([location()], range);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 60 * 1000);
    stubFetch(rawForecast(['2026-11-24', '2026-11-25'], 61));
    const result = await loadWeather([location()], range);
    expect(result[location().key]).toMatchObject({
      status: 'ready',
      forecast: { days: [{ code: 61 }, { code: 61 }] },
    });
  });

  it('超過七天的快取不會當成離線答案', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    stubFetch(rawForecast(['2026-11-24', '2026-11-25']));
    await loadWeather([location()], range);
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86_400_000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const result = await loadWeather([location()], range);
    expect(result[location().key]).toEqual({ status: 'error', error: 'offline' });
  });

  it('429 與格式錯誤分開回報，壞快取不會讓畫面炸掉', async () => {
    stubFetch({ error: true, reason: 'rate limit' }, 429);
    expect(await loadWeather([location()], range)).toEqual({ [location().key]: { status: 'error', error: 'rate' } });
    stubFetch({ timezone: 'Asia/Tokyo', daily: { time: [] } });
    expect(await loadWeather([location()], range)).toEqual({ [location().key]: { status: 'error', error: 'parse' } });
    localStorage.setItem('triplog:weather:v1', '{壞 JSON');
    stubFetch(rawForecast(['2026-11-24']));
    expect((await loadWeather([location()], range))[location().key].status).toBe('ready');
  });

  it('相同請求共用一次連線，避免 React Strict Mode 重複查詢', async () => {
    let resolve!: (value: Response) => void;
    const response = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);
    const first = loadWeather([location()], range);
    const second = loadWeather([location()], range);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolve(new Response(JSON.stringify(rawForecast(['2026-11-24', '2026-11-25']))));
    expect((await first)[location().key].status).toBe('ready');
    expect((await second)[location().key].status).toBe('ready');
  });

  it('Strict Mode 取消第一個 effect 時，不會連帶取消第二個共用請求', async () => {
    let resolve!: (value: Response) => void;
    const response = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const first = loadWeather([location()], range, controller.signal);
    const second = loadWeather([location()], range);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(first).rejects.toMatchObject({ kind: 'aborted' });
    resolve(new Response(JSON.stringify(rawForecast(['2026-11-24', '2026-11-25']))));
    expect((await second)[location().key].status).toBe('ready');
  });

  it('超過 20 個地點會分批，且每批不超過 API 建議負擔', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const count = new URL(String(input)).searchParams.get('latitude')!.split(',').length;
      return new Response(JSON.stringify(Array.from({ length: count }, () => rawForecast(['2026-11-24', '2026-11-25']))));
    });
    vi.stubGlobal('fetch', fetchMock);
    const points = Array.from({ length: 21 }, (_, i) => location(`${(35 + i / 100).toFixed(4)},135.7600`));
    const result = await loadWeather(points, range);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(result)).toHaveLength(21);
  });

  it('取消請求會拋出 aborted，不顯示成一般錯誤', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));
    const controller = new AbortController();
    const job = loadWeather([location()], range, controller.signal);
    controller.abort();
    await expect(job).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('沒有可用日期範圍時完全不上網', async () => {
    const fetchMock = stubFetch(rawForecast(['2026-11-24']));
    expect(await loadWeather([location()], null)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
