import { lang as uiLang, type Lang } from '../i18n';

/**
 * OpenStreetMap Nominatim 查詢。
 *
 * 这是 App 唯一會外連的地方：只把「搜尋字串」送出去，查到的結果存進本機 IndexedDB，
 * 旅程與支出本身仍然不會離開裝置。
 *
 * Nominatim 使用規範要求每來源每秒不超過 1 個請求，所以這裡用一條 promise 鏈排隊，
 * 並把相同字串的結果快取 24 小時，避免反覆打字一直打爆對方。
 * @see https://operations.osmfoundation.org/policies/nominatim/
 */

const HOST = 'https://nominatim.openstreetmap.org';
const MIN_INTERVAL = 1_200;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 60;

export interface Place {
  /** Nominatim 的 place_id，當作 key 用 */
  id: string;
  /** 簡短名稱（display_name 的第一段） */
  name: string;
  /** 完整地址文字 */
  label: string;
  lat: number;
  lng: number;
  /** 類型，例如 restaurant、hotel、historic */
  type: string;
  /** 城市/國家等後綴，用來分辨同名地點 */
  region: string;
}

export type PlaceErrorKind = 'offline' | 'rate' | 'http' | 'aborted' | 'parse';

export class PlaceError extends Error {
  kind: PlaceErrorKind;
  constructor(kind: PlaceErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'PlaceError';
    this.kind = kind;
  }
}

const ACCEPT_LANG: Record<Lang, string> = {
  'zh-Hant': 'zh-TW,zh-Hant,zh',
  en: 'en',
};

type Raw = {
  place_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  type?: string;
  addresstype?: string;
  category?: string;
  name?: string;
};

function toPlace(r: Raw): Place | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  const label = (r.display_name ?? '').trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !label) return null;
  const parts = label.split(',').map((s) => s.trim());
  return {
    id: r.place_id ? String(r.place_id) : `${lat},${lng}`,
    name: (r.name && r.name.trim()) || parts[0] || label,
    label,
    lat,
    lng,
    type: r.addresstype || r.type || r.category || '',
    region: parts.slice(-2).join(', '),
  };
}

/* --------------------------------------------------------------- 节流 + 快取 */

let lastAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastAt + MIN_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return job();
  });
  // 前一個失敗不能卡住後面
  queue = run.catch(() => undefined);
  return run;
}

const cache = new Map<string, { at: number; hits: Place[] }>();

function cacheGet(key: string): Place[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // 碰過就挪到最後，實作 LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit.hits;
}

function cacheSet(key: string, hits: Place[]): void {
  cache.set(key, { at: Date.now(), hits });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 測試或換語言时可以清掉，避免拿到另一種語言的地址 */
export function clearPlaceCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ 查詢 */

async function call(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<Place[]> {
  const url = `${HOST}/${path}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new PlaceError('aborted');
    throw new PlaceError('offline', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new PlaceError(res.status === 429 ? 'rate' : 'http', `HTTP ${res.status}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new PlaceError('parse');
  }
  if (!Array.isArray(data)) throw new PlaceError('parse');
  return (data as Raw[]).map(toPlace).filter((p): p is Place => p !== null);
}

/** 地點搜尋；結果依 importance 順序（Nominatim 已排好）回傳 */
export async function searchPlaces(
  query: string,
  opts: { lang?: Lang; signal?: AbortSignal; limit?: number; viewbox?: string } = {},
): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const language = opts.lang ?? uiLang();
  const key = `${language}\u0000${q.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    'accept-language': ACCEPT_LANG[language],
    limit: String(opts.limit ?? 8),
  });
  if (opts.viewbox) params.set('viewbox', opts.viewbox);
  const hits = await queued(() => call('search', params, opts.signal));
  if (hits.length) cacheSet(key, hits);
  return hits;
}

/** 反查座標成地址，地圖上點一下就知道那是哪裡 */
export async function reversePlace(
  lat: number,
  lng: number,
  opts: { lang?: Lang; signal?: AbortSignal } = {},
): Promise<Place | null> {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lon: lng.toFixed(6),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '16',
    'accept-language': ACCEPT_LANG[opts.lang ?? uiLang()],
  });
  const hits = await queued(() => call('reverse', params, opts.signal));
  return hits[0] ?? null;
}

/** 「25.03,121.56」這種精簡座標，給表單與圖示用 */
export function formatLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}
