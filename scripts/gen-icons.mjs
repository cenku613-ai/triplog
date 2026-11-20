#!/usr/bin/env node
/**
 * 產生 PWA 圖示（無外部依賴）。
 * 用 SDF + 3x3 supersampling 畫出圓角方形底色與定位圖釘，直接輸出 RGBA PNG。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- drawing ------------------------------- */

const BRAND = [15, 118, 110]; // #0f766e
const BRAND_2 = [20, 184, 166]; // #14b8a6

const lerp = (a, b, t) => a + (b - a) * t;

function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** 定位圖釘：圓形頭 + 三角形尾，中間挖一個洞 */
function pinSdf(px, py, cx, cy, scale) {
  const x = (px - cx) / scale;
  const y = (py - cy) / scale;
  const head = sdCircle(x, y, 0, -0.16, 0.62);
  // 三角形 (0,0.86) (-0.42,0.1) (0.42,0.1)
  const a = [0, 0.86];
  const b = [-0.42, 0.12];
  const c = [0.42, 0.12];
  const sign = (p1, p2, p3) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([x, y], a, b);
  const d2 = sign([x, y], b, c);
  const d3 = sign([x, y], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  const inside = !(hasNeg && hasPos);
  const edge = Math.min(
    distSeg(x, y, a[0], a[1], b[0], b[1]),
    distSeg(x, y, b[0], b[1], c[0], c[1]),
    distSeg(x, y, c[0], c[1], a[0], a[1]),
  );
  const tri = inside ? -edge : edge;
  return Math.min(head, tri);
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const cov = (d) => Math.min(1, Math.max(0, 0.5 - d));

function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const half = 0.5;
  const boxR = maskable ? 0 : 0.22; // maskable 要填滿，不做圓角
  const boxH = maskable ? 0.5 : 0.47;
  const pinScale = maskable ? 0.30 : 0.34;
  const aa = 1.1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;
      const N = 3;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const u = (x + (sx + 0.5) / N) / size - half;
          const v = (y + (sy + 0.5) / N) / size - half;

          const bgD = sdRoundBox(u, v, boxH, boxH, boxR);
          const bgA = cov(bgD / aa);
          if (bgA === 0) continue;

          // 背景：由上到下的品牌漸層
          const tt = (v + half) * 0.9;
          let br = lerp(BRAND[0], BRAND_2[0], tt);
          let bg = lerp(BRAND[1], BRAND_2[1], tt);
          let bb = lerp(BRAND[2], BRAND_2[2], tt);

          // 圖釘
          const pinD = pinSdf(u, v, 0, 0.012, pinScale);
          const pinA = cov(pinD / aa);
          const holeD = sdCircle(u, v, 0, 0.012 - pinScale * 0.16, pinScale * 0.23);
          const holeA = cov(holeD / aa);
          const pinFinal = Math.max(0, pinA - holeA);
          if (pinFinal > 0) {
            br = lerp(br, 255, pinFinal);
            bg = lerp(bg, 255, pinFinal);
            bb = lerp(bb, 255, pinFinal);
          }

          rAcc += br * bgA;
          gAcc += bg * bgA;
          bAcc += bb * bgA;
          aAcc += bgA;
        }
      }
      const i = (y * size + x) * 4;
      const inv = 1 / (N * N);
      const a = aAcc * inv;
      px[i] = a > 0 ? Math.round(rAcc / aAcc) : 0;
      px[i + 1] = a > 0 ? Math.round(gAcc / aAcc) : 0;
      px[i + 2] = a > 0 ? Math.round(bAcc / aAcc) : 0;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

const targets = [
  ['pwa-192x192.png', 192, {}],
  ['pwa-512x512.png', 512, {}],
  ['maskable-512x512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of targets) {
  const buf = drawIcon(size, opts);
  writeFileSync(join(outDir, name), buf);
  console.log(`${name}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
