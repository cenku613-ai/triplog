/**
 * 照片處理：一律在本機壓縮後才入庫。
 * 手機原圖常 6–8 MB，直接塞 IndexedDB 很快就會把瀏覽器配的容量吃光，
 * 所以存「最長邊 1600 的 JPEG」＋「400 的縮圖」兩份，相本牆只讀縮圖。
 */

const MAX_EDGE = 1600;
const THUMB_EDGE = 400;
const QUALITY = 0.82;

export interface Raster {
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
  mime: string;
}

type Drawable = ImageBitmap | HTMLImageElement;

function sizeOf(img: Drawable): { w: number; h: number } {
  return 'naturalWidth' in img
    ? { w: img.naturalWidth, h: img.naturalHeight }
    : { w: img.width, h: img.height };
}

async function decode(src: Blob): Promise<{ img: Drawable; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image：Handy 拍出來的直式照片帶有 EXIF 旋轉，靠它才不會躺平
      const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
      return { img: bmp, release: () => bmp.close() };
    } catch {
      /* Safari 舊版或某些 HEIC 走下面的路 */
    }
  }
  const url = URL.createObjectURL(src);
  const img = new Image();
  img.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  // 畫完才回收 URL：太早撤掉 Safari 可能畫出空圖
  return { img, release: () => URL.revokeObjectURL(url) };
}

function draw(img: Drawable, edge: number, quality: number): Promise<Blob | null> {
  const { w, h } = sizeOf(img);
  const scale = Math.min(1, edge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  // JPEG 沒有透明通道，先鋪白底，否則 PNG -transparent 的圖會變全黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

/** 把任何來源的圖片壓成一組要入庫的 Blob */
export async function rasterize(src: Blob): Promise<Raster> {
  const { img, release } = await decode(src);
  try {
    const { w, h } = sizeOf(img);
    const [blob, thumb] = await Promise.all([draw(img, MAX_EDGE, QUALITY), draw(img, THUMB_EDGE, 0.72)]);
    if (!blob) throw new Error('canvas export failed');
    return {
      blob,
      // 縮圖出不來時就退回放原圖，相本牆還是看得懂
      thumb: thumb ?? blob,
      width: w,
      height: h,
      mime: 'image/jpeg',
    };
  } finally {
    release();
  }
}

/** 產生一個記憶體中的佔位圖（找不到圖時用，避免每次都重畫） */
export function previewUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error ?? new Error('read failed'));
      fr.readAsDataURL(blob);
    });
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body = ''] = dataUrl.split(',');
  // mime 在 data: 與 ; 或 , 之間，少了這段就會把非 base64 的 URN 也當成圖
  const mime = /^data:([^;,]+)/.exec(head)?.[1] || 'image/jpeg';
  if (!head.includes(';base64')) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  // 交 ArrayBuffer 本體：TS 5.9 的 BlobPart 不認得泛型化的 Uint8Array
  return new Blob([buf.buffer], { type: mime });
}

/** 「4.2 MB」這種給人看的單位 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
