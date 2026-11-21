import { describe, expect, it } from 'vitest';
import {
  activeShares,
  describeShareError,
  shareApiUrl,
  shareLink,
  type ShareRow,
} from './share';

const row = (over: Partial<ShareRow> = {}): ShareRow => ({
  token: 'tok_abc',
  tripId: 'trip_1',
  label: '阿雲',
  createdAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2027-01-30T00:00:00.000Z',
  revokedAt: null,
  hits: 0,
  writes: 0,
  lastSeenAt: null,
  ...over,
});

/**
 * 這裡只測「不需要網路的四件事」：連結長什麼樣、期限怎麼算、
 * 錯碼怎麼變成有人味的話。真正的 HTTP 行為由 server/test/smoke.mjs 覆蓋。
 */
describe('分享連結', () => {
  it('連結永遠指向同一個 origin 上的 hash 路由', () => {
    expect(shareLink('https://triplogmo.duckdns.org', 'tok_abc')).toBe(
      'https://triplogmo.duckdns.org/#/share/tok_abc',
    );
    // API 前綴與 port 都不該跟著跑進連結裡
    expect(shareLink('http://127.0.0.1:8788/api', 'tok_abc')).toBe('http://127.0.0.1:8788/#/share/tok_abc');
  });

  it('沒有瀏覽器環境時退回佔位 origin，不在匯入阶段就炸掉', () => {
    // vitest 預設跑在 node（沒有 location），這條就是那個守衛的證明
    expect(typeof location).toBe('undefined');
    expect(shareApiUrl('api/share/tok_abc')).toBe('http://localhost/api/share/tok_abc');
  });

  it('生效中的連結：已作廢與已過期都不算，沒設限期的永遠算', () => {
    const now = Date.parse('2026-11-21T00:00:00.000Z');
    const rows = [
      row(),
      row({ token: 'revoked', revokedAt: '2026-11-20T00:00:00.000Z' }),
      row({ token: 'expired', expiresAt: '2026-11-20T00:00:00.000Z' }),
      row({ token: 'forever', expiresAt: null }),
    ];
    expect(activeShares(rows, now).map((r) => r.token)).toEqual(['tok_abc', 'forever']);
  });

  it('錯碼各自有一句話，410 要分得清是被作廢還是到期', () => {
    const key = (k: string) => k;
    expect(describeShareError({ code: 'gone', reason: 'revoked' }, key)).toBe('share.errRevoked');
    expect(describeShareError({ code: 'gone', reason: 'expired' }, key)).toBe('share.errExpired');
    expect(describeShareError({ code: 'offline' }, key)).toBe('share.errOffline');
    // 同步那條路的錯（SyncError）也是同一套介面，分享對話框才不用各寫一份
    expect(describeShareError({ code: 'insecure' }, key)).toBe('share.errInsecure');
    // 認不出的錯碼也要給一句話，不能讓畫面出現空字串
    expect(describeShareError({ code: 'weird' }, key)).toBe('share.errServer');
    expect(describeShareError(new Error('boom'), key)).toBe('boom');
  });
});
