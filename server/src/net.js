/** HTTP 工具：JSON 回應、常數時間比對、視窗限流、請求體上限。 */
import crypto from 'node:crypto';

export function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export function fail(res, status, error, extra = {}) {
  send(res, status, { ok: false, error, ...extra });
}

/** 金鑰比對：兩邊補零到同長度，避免用時間差洩漏長度以外的資訊 */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  const len = Math.max(ba.length, bb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb);
}

export function bearer(req) {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1].trim();
  const raw = req.headers['x-triplog-key'];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 粗暴但夠用的固定視窗限流（單進程、記憶體計數） */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const bucket = hits.get(key);
    if (!bucket || now > bucket.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    bucket.count += 1;
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    return bucket.count <= max;
  };
}

export function clientIp(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}

/** CORS：只有白名單內的來源才補標頭（同網域走反代時根本用不到） */
export function applyCors(req, res, allowed) {
  const origin = req.headers.origin;
  if (!origin || !allowed.length) return false;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-triplog-key, x-triplog-confirm');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    return true;
  }
  return false;
}
