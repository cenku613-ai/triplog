/**
 * Wikimedia Commons 圖來源：找不到自己拍的照片時（例如計畫中的景點）可用。
 * 下載的一定會連作者／授權一起記下來，相本牆與大圖都看得到出處。
 *
 * API 採 `origin=*`，回傳帶 Access-Control-Allow-Origin: *，可以直接從瀏覽器拉。
 * @see https://commons.wikimedia.org/w/api.php
 */

const API = 'https://commons.wikimedia.org/w/api.php';
/** 抓 1280 寬就夠了，原圖動不動 12 MB */
const PREFERRED_WIDTH = 1280;

export interface CommonsHit {
  key: string;
  title: string;
  pageUrl: string;
  thumbUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  artist: string;
  license: string;
}

type Meta = { value?: string };

type Raw = {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        imageinfo?: {
          width?: number;
          height?: number;
          url?: string;
          thumburl?: string;
          descriptionurl?: string;
          extmetadata?: Record<string, Meta>;
        }[];
      }
    >;
  };
};

/** <span property="dc:name">…</span> 之類的署名 HTML 只留文字 */
function textOf(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchCommons(
  query: string,
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<CommonsHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${q}`,
    gsrnamespace: '6',
    gsrlimit: String(opts.limit ?? 12),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: String(PREFERRED_WIDTH),
  });
  let res: Response;
  try {
    res = await fetch(`${API}?${params.toString()}`, { signal: opts.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new Error('offline');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Raw;
  const pages = data.query?.pages ?? {};
  const hits: CommonsHit[] = [];
  for (const [id, page] of Object.entries(pages)) {
    const info = page.imageinfo?.[0];
    if (!info?.url || !info.thumburl) continue;
    const meta = info.extmetadata ?? {};
    hits.push({
      key: id,
      title: (page.title ?? '').replace(/^File:/i, ''),
      pageUrl: info.descriptionurl ?? '',
      thumbUrl: info.thumburl,
      fullUrl: info.url,
      width: info.width ?? 0,
      height: info.height ?? 0,
      artist: textOf(meta.Artist?.value),
      license: textOf(meta.LicenseShortName?.value),
    });
  }
  // 檔案名稱比較短的通常比較「正題」，把太長串名的排後面
  return hits.sort((a, b) => a.title.length - b.title.length);
}

/** 下載縮圖而不是原圖，省流量也省裝置空間 */
export async function downloadCommons(hit: CommonsHit, signal?: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(hit.thumbUrl || hit.fullUrl, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new Error('offline');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
