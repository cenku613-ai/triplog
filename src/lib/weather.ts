import type { DayItem, ISODate, Trip } from '../db/types';
import { addDays, dateRange, today } from './dates';
import { formatLatLng, isValidLatLng } from './places';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_KEY = 'triplog:weather:v1';
const CACHE_TTL = 60 * 60 * 1000;
const STALE_TTL = 7 * 86_400_000;
const CACHE_MAX = 120;
const BATCH_SIZE = 20;
const REQUEST_TIMEOUT = 12_000;
const PAST_DAYS = 92;
const FORECAST_DAYS = 16;
const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
  'precipitation_sum',
  'wind_speed_10m_max',
];

export interface WeatherLocation {
  key: string;
  name: string;
  lat: number;
  lng: number;
}

export interface WeatherDay {
  date: ISODate;
  code: number;
  tempMax: number | null;
  tempMin: number | null;
  rainChance: number | null;
  precipitation: number | null;
  windMax: number | null;
}

export interface WeatherForecast {
  timezone: string;
  days: WeatherDay[];
  fetchedAt: number;
}

export interface WeatherPlan {
  days: Array<{ date: ISODate; locations: WeatherLocation[] }>;
  locations: WeatherLocation[];
  activeLocations: WeatherLocation[];
  window: { start: ISODate; end: ISODate } | null;
}

export type WeatherErrorKind = 'offline' | 'rate' | 'http' | 'parse' | 'timeout' | 'aborted';

export class WeatherError extends Error {
  kind: WeatherErrorKind;
  constructor(kind: WeatherErrorKind) {
    super(kind);
    this.name = 'WeatherError';
    this.kind = kind;
  }
}

export type WeatherLocationState =
  | { status: 'loading' }
  | { status: 'ready' | 'stale'; forecast: WeatherForecast }
  | { status: 'error'; error: WeatherErrorKind };

export function forecastWindow(start: ISODate, end: ISODate, current = today()): WeatherPlan['window'] {
  const earliest = addDays(current, -PAST_DAYS);
  const latest = addDays(current, FORECAST_DAYS);
  const from = start > earliest ? start : earliest;
  const to = end < latest ? end : latest;
  return from <= to ? { start: from, end: to } : null;
}

export function buildWeatherPlan(trip: Trip, items: DayItem[], current = today()): WeatherPlan {
  const window = forecastWindow(trip.startDate, trip.endDate, current);
  const dates = dateRange(trip.startDate, trip.endDate);
  const validDates = new Set(dates);
  const locations = new Map<string, WeatherLocation>();
  const rows = [...items].sort(
    (a, b) => a.date.localeCompare(b.date) || a.order - b.order || (a.startTime ?? '99').localeCompare(b.startTime ?? '99'),
  );

  for (const item of rows) {
    if (!validDates.has(item.date) || !isValidLatLng(item.lat, item.lng)) continue;
    const lat = Math.round((item.lat as number) * 10_000) / 10_000;
    const lng = Math.round((item.lng as number) * 10_000) / 10_000;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!locations.has(key)) {
      locations.set(key, { key, name: item.location?.trim() || formatLatLng(lat, lng), lat, lng });
    }
  }

  const days = dates.map((date) => {
    const keys = new Set<string>();
    for (const item of rows) {
      if (item.date !== date || !isValidLatLng(item.lat, item.lng)) continue;
      const lat = Math.round((item.lat as number) * 10_000) / 10_000;
      const lng = Math.round((item.lng as number) * 10_000) / 10_000;
      keys.add(`${lat.toFixed(4)},${lng.toFixed(4)}`);
    }
    return { date, locations: [...keys].map((key) => locations.get(key)!) };
  });

  const activeKeys = new Set(
    days.filter((day) => window && day.date >= window.start && day.date <= window.end).flatMap((day) => day.locations.map((p) => p.key)),
  );
  const all = [...locations.values()];
  return { days, locations: all, activeLocations: all.filter((p) => activeKeys.has(p.key)), window };
}

function cacheKey(location: WeatherLocation, range: { start: ISODate; end: ISODate }): string {
  return `${location.key}:${range.start}:${range.end}`;
}

type CacheEntry = { at: number; forecast: WeatherForecast };
type CacheMap = Record<string, CacheEntry>;

function readCache(): CacheMap {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as CacheMap) : {};
  } catch {
    return {};
  }
}

function validForecast(value: unknown): value is WeatherForecast {
  if (!value || typeof value !== 'object') return false;
  const f = value as Partial<WeatherForecast>;
  return (
    typeof f.timezone === 'string' &&
    typeof f.fetchedAt === 'number' &&
    Number.isFinite(f.fetchedAt) &&
    Array.isArray(f.days) &&
    f.days.every(
      (day) =>
        day &&
        typeof day.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
        typeof day.code === 'number' &&
        Number.isFinite(day.code) &&
        [day.tempMax, day.tempMin, day.rainChance, day.precipitation, day.windMax].every(
          (n) => n === null || (typeof n === 'number' && Number.isFinite(n)),
        ),
    )
  );
}

function cached(location: WeatherLocation, range: WeatherPlan['window'], now: number): CacheEntry | null {
  if (!range) return null;
  const entry = readCache()[cacheKey(location, range)];
  if (!entry || !validForecast(entry.forecast) || now - entry.at > STALE_TTL) return null;
  return entry;
}

function saveCache(location: WeatherLocation, range: NonNullable<WeatherPlan['window']>, forecast: WeatherForecast): void {
  try {
    const all = readCache();
    all[cacheKey(location, range)] = { at: forecast.fetchedAt, forecast };
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 無痕或空間不足時仍可看本次結果，只是不留離線快取 */
  }
}

export function clearWeatherCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 測試環境可能沒有 Storage */
  }
}

export function weatherUrl(locations: WeatherLocation[], range: NonNullable<WeatherPlan['window']>): string {
  const params = new URLSearchParams({
    latitude: locations.map((p) => p.lat.toFixed(4)).join(','),
    longitude: locations.map((p) => p.lng.toFixed(4)).join(','),
    daily: DAILY_FIELDS.join(','),
    timezone: 'auto',
    start_date: range.start,
    end_date: range.end,
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
    timeformat: 'iso8601',
  });
  return `${API_URL}?${params.toString()}`;
}

type RawForecast = {
  timezone?: unknown;
  daily?: {
    time?: unknown;
    weather_code?: unknown;
    temperature_2m_max?: unknown;
    temperature_2m_min?: unknown;
    precipitation_probability_max?: unknown;
    precipitation_sum?: unknown;
    wind_speed_10m_max?: unknown;
  };
  error?: unknown;
};

function numberAt(values: unknown, index: number): number | null {
  if (!Array.isArray(values)) return null;
  const value = values[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseForecast(raw: RawForecast, range: NonNullable<WeatherPlan['window']>, fetchedAt: number): WeatherForecast {
  const daily = raw.daily;
  if (!daily || !Array.isArray(daily.time) || typeof raw.timezone !== 'string') throw new WeatherError('parse');
  const days: WeatherDay[] = [];
  for (let i = 0; i < daily.time.length; i += 1) {
    const value = daily.time[i];
    if (typeof value !== 'string') continue;
    const date = value.slice(0, 10);
    const code = numberAt(daily.weather_code, i);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < range.start || date > range.end || code === null) continue;
    days.push({
      date,
      code,
      tempMax: numberAt(daily.temperature_2m_max, i),
      tempMin: numberAt(daily.temperature_2m_min, i),
      rainChance: numberAt(daily.precipitation_probability_max, i),
      precipitation: numberAt(daily.precipitation_sum, i),
      windMax: numberAt(daily.wind_speed_10m_max, i),
    });
  }
  if (!days.length) throw new WeatherError('parse');
  return { timezone: raw.timezone, days, fetchedAt };
}

interface PendingRequest {
  promise: Promise<unknown>;
  controller: AbortController;
  users: number;
  settled: boolean;
}

const pending = new Map<string, PendingRequest>();

async function waitForRequest(entry: PendingRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new WeatherError('aborted');
  entry.users += 1;
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new WeatherError('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([entry.promise, cancelled]);
  } finally {
    signal?.removeEventListener('abort', abort);
    entry.users -= 1;
    if (!entry.users && !entry.settled) {
      queueMicrotask(() => {
        if (!entry.users && !entry.settled) entry.controller.abort();
      });
    }
  }
}

async function requestJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const existing = pending.get(url);
  if (existing) return waitForRequest(existing, signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  let entry!: PendingRequest;
  const job = (async () => {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (error) {
      if (timedOut) throw new WeatherError('timeout');
      if (error instanceof DOMException && error.name === 'AbortError') throw new WeatherError('aborted');
      throw new WeatherError('offline');
    }
    if (!response.ok) throw new WeatherError(response.status === 429 ? 'rate' : 'http');
    try {
      return await response.json();
    } catch {
      throw new WeatherError('parse');
    }
  })().finally(() => {
    clearTimeout(timer);
    entry.settled = true;
    if (pending.get(url) === entry) pending.delete(url);
  });
  entry = { promise: job, controller, users: 0, settled: false };
  pending.set(url, entry);
  return waitForRequest(entry, signal);
}

async function loadBatch(
  locations: WeatherLocation[],
  range: NonNullable<WeatherPlan['window']>,
  signal?: AbortSignal,
  force = false,
): Promise<Array<{ location: WeatherLocation; state: WeatherLocationState }>> {
  const now = Date.now();
  const fresh = new Map<string, WeatherForecast>();
  const stale = new Map<string, WeatherForecast>();
  const missing: WeatherLocation[] = [];
  for (const location of locations) {
    const hit = cached(location, range, now);
    if (hit && !force && now - hit.at <= CACHE_TTL) fresh.set(location.key, hit.forecast);
    else {
      if (hit) stale.set(location.key, hit.forecast);
      missing.push(location);
    }
  }
  if (!missing.length) {
    return locations.map((location) => ({
      location,
      state: fresh.has(location.key)
        ? { status: 'ready', forecast: fresh.get(location.key)! }
        : { status: 'stale', forecast: stale.get(location.key)! },
    }));
  }

  try {
    const data = await requestJson(weatherUrl(missing, range), signal);
    const list = Array.isArray(data) ? data : [data];
    if (list.length !== missing.length) throw new WeatherError('parse');
    const fetchedAt = Date.now();
    return locations.map((location) => {
      const hit = fresh.get(location.key) ?? stale.get(location.key);
      if (!missing.includes(location)) {
        return { location, state: { status: fresh.has(location.key) ? 'ready' : 'stale', forecast: hit! } };
      }
      const forecast = parseForecast(list[missing.indexOf(location)] as RawForecast, range, fetchedAt);
      saveCache(location, range, forecast);
      return { location, state: { status: 'ready' as const, forecast } };
    });
  } catch (error) {
    if (error instanceof WeatherError && error.kind === 'aborted') throw error;
    return locations.map((location) => {
      const hit = fresh.get(location.key) ?? stale.get(location.key);
      return {
        location,
        state: hit
          ? { status: 'stale' as const, forecast: hit }
          : { status: 'error' as const, error: error instanceof WeatherError ? error.kind : 'offline' },
      };
    });
  }
}

export async function loadWeather(
  locations: WeatherLocation[],
  range: WeatherPlan['window'],
  signal?: AbortSignal,
  force = false,
): Promise<Record<string, WeatherLocationState>> {
  if (!range || !locations.length) return {};
  const batches: Array<{ location: WeatherLocation; state: WeatherLocationState }> = [];
  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    batches.push(...(await loadBatch(locations.slice(i, i + BATCH_SIZE), range, signal, force)));
  }
  return Object.fromEntries(batches.map((row) => [row.location.key, row.state]));
}
