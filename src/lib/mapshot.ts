import L from 'leaflet';
import { createMap, pinAt } from './maplib';
import { boundsOf, centerOf, dayColor, isDegenerate, type GeoPoint } from './geo';

/**
 * 把地圖壓成一張 PNG（data URL），供列印／存 PDF 用。
 *
 * 為什麼不用 html2canvas：列印文件裡只需要底圖＋圓點，而 Leaflet 的瓦片本來
 * 就是 `<img>`，自己照著瓦片在框裡的實際位置貼進 canvas 就好。一個依賴都不加，
 * 也不會把整個 DOM 柵格化（那會讓文字在 PDF 裡變模糊）。
 *
 * 前提：createMap() 的 tileLayer 有開 crossOrigin，否則 canvas 會被打汙，
 * toDataURL 直接拋 SecurityError——離線或瓦片沒標 CORS 就會走這條路，
 * 所以回傳 null 讓呼叫端改顯示「地圖無法擷取」。
 */

export type MapShot = {
  dataUrl: string;
  width: number;
  height: number;
  points: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function captureMap(
  points: GeoPoint[],
  opts: { width?: number; height?: number; timeoutMs?: number } = {},
): Promise<MapShot | null> {
  if (points.length === 0) return null;
  const width = opts.width ?? 900;
  const height = opts.height ?? 560;
  const timeoutMs = opts.timeoutMs ?? 12_000;

  const host = document.createElement('div');
  host.className = 'map-box mapshot';
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(host);

  let map: L.Map | null = null;
  try {
    map = createMap(host, { scrollWheelZoom: false });
    const layer = L.layerGroup().addTo(map);
    for (const p of points) layer.addLayer(pinAt(p.lat, p.lng, dayColor(p.day), { radius: 10 }));

    const box = boundsOf(points);
    if (box && !isDegenerate(box)) {
      map.fitBounds(
        [
          [box.minLat, box.minLng],
          [box.maxLat, box.maxLng],
        ],
        { padding: [40, 40], maxZoom: 15 },
      );
    } else if (box) {
      const c = centerOf(box);
      map.setView([c.lat, c.lng], 14);
    }
    map.invalidateSize();

    const deadline = Date.now() + timeoutMs;
    // 留 4 秒給瓦片收邊：moveend 如果沒觸發（例如視界沒變動），
    // 把整段 timeout 花在等待上就會讓後面的貼圖來不及執行。
    await waitSettled(map, Math.min(deadline - 4_000, Date.now() + 6_000));
    const shot = await stitch(map, width, height, deadline);
    return shot ? { ...shot, points: points.length } : null;
  } catch (err) {
    console.warn('[triplog] 地圖擷取失敗', err);
    return null;
  } finally {
    try {
      map?.remove();
    } catch {
      /* 已經被移除 */
    }
    host.remove();
  }
}

/** 等地圖停止移動，再等瓦片全部 load 完（或逾時） */
async function waitSettled(map: L.Map, deadline: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, Math.max(0, deadline - Date.now()));
    map.once('moveend', () => window.setTimeout(done, 400));
  });
  while (Date.now() < deadline) {
    const pending = [...map.getContainer().querySelectorAll<HTMLImageElement>('img.leaflet-tile')].filter(
      (img) => !img.complete,
    );
    if (pending.length === 0) return;
    await sleep(180);
  }
}

type TileInfo = {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  img: HTMLImageElement;
};

/** 依矩形實際位置貼圖：Retina 的 tileSize、縮放動畫後都照樣對得齊 */
async function stitch(
  map: L.Map,
  width: number,
  height: number,
  deadline: number,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const tiles = collectTiles(map);
  if (tiles.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#e8ecef';
  ctx.fillRect(0, 0, width, height);

  for (const tile of tiles) {
    if (tile.x > width || tile.y > height || tile.x + tile.w < 0 || tile.y + tile.h < 0) continue;
    try {
      ctx.drawImage(tile.img, tile.x, tile.y, tile.w, tile.h);
    } catch (err) {
      // 打汙過的圖片貼不上來：重新用 crossOrigin 抓一次（多數會命中 SW 快取）
      console.warn('[triplog] 瓦片貼不上去，改用 CORS 重抓', err);
      const img = await loadWithCors(tile.url, Math.max(600, deadline - Date.now()));
      if (!img) continue;
      try {
        ctx.drawImage(img, tile.x, tile.y, tile.w, tile.h);
      } catch {
        /* 這張留白，整體還是能出圖 */
      }
    }
  }

  try {
    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  } catch (err) {
    console.warn('[triplog] canvas 被打汙（瓦片沒有 CORS），跳過地圖', err);
    return null;
  }
}

/**
 * 把瓦片連同它在畫面框內的偏移收集起來。
 *
 * 用 `getBoundingClientRect` 而不是 Leaflet 私有的 `_panes.tiles`：那個鍵名從來就不存在
 * （實名是 `tilePane`），早先的寫法每次都拿到 undefined，於是「一張瓦片都沒有」，
 * 地圖就靜靜地不见了。量矩形還有一個好處：pane 位移、縮放動畫、Retina 的 tileSize
 * 都已經被算進去，不用自己還原 `_leaflet_pos`。
 */
function collectTiles(map: L.Map): TileInfo[] {
  const host = map.getContainer();
  const box = host.getBoundingClientRect();
  const out: TileInfo[] = [];
  for (const img of [...host.querySelectorAll<HTMLImageElement>('img.leaflet-tile')]) {
    if (!img.complete || !img.currentSrc) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      url: img.currentSrc,
      x: r.left - box.left,
      y: r.top - box.top,
      w: r.width,
      h: r.height,
      img,
    });
  }
  return out;
}

/** 降回方案：重新用 crossOrigin 抓一次瓦片（快取命中時幾乎不花流量） */
function loadWithCors(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}
