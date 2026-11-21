import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '../i18n';
import {
  TokenError,
  activeTokens,
  createApiToken,
  describeTokenError,
  listApiTokens,
  tokenState,
  type ApiTokenRow,
} from './tokens';

const NOW = Date.parse('2026-11-21T00:00:00.000Z');

const row = (over: Partial<ApiTokenRow> = {}): ApiTokenRow => ({
  id: 'tk_1',
  hint: 'tlk_ab12…9wZx',
  label: '筆電 agent',
  scope: 'read',
  createdAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2027-01-30T00:00:00.000Z',
  revokedAt: null,
  hits: 0,
  writes: 0,
  lastSeenAt: null,
  ...over,
});

const cfg = { baseUrl: 'https://triplogmo.duckdns.org', apiKey: 'master-key', auto: false };

afterEach(() => {
  setLang('zh-Hant');
  vi.unstubAllGlobals();
});

/**
 * 客戶端只測兩類東西：清單上的「生死」判斷（撤銷要贏過過期）與錯碼怎麼變成有人味的話。
 * 真正的鑑權行為由 server/test/smoke.mjs 用一顆真的 SQLite 覆蓋。
 */
describe('tokenState', () => {
  it('沒撤銷、沒過期就是生效中', () => {
    expect(tokenState(row(), NOW)).toBe('active');
  });

  it('過期的判斷含等號：到期那一刻就算死', () => {
    const atBoundary = row({ expiresAt: new Date(NOW).toISOString() });
    expect(tokenState(atBoundary, NOW)).toBe('expired');
    expect(tokenState(row({ expiresAt: null }), NOW)).toBe('active'); // 不設限期
  });

  it('撤銷比過期優先：那是擁有者主動做的事', () => {
    expect(tokenState(row({ expiresAt: '2020-01-01T00:00:00.000Z', revokedAt: '2026-01-01T00:00:00.000Z' }), NOW)).toBe('revoked');
  });

  it('activeTokens 只留生效中的，過濾掉過期與已撤銷', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', expiresAt: '2020-01-01T00:00:00.000Z' }),
      row({ id: 'c', revokedAt: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'd', expiresAt: null }),
    ];
    expect(activeTokens(rows, NOW).map((r) => r.id)).toEqual(['a', 'd']);
  });
});

describe('describeTokenError', () => {
  it('後端講得出原因時優先採用它的說法', () => {
    expect(describeTokenError(new TokenError('server', 'expiresInDays 不能超過 365'), t)).toBe(
      'expiresInDays 不能超過 365',
    );
  });

  it('401/403 只用本地文案：後端那種英文狀態說明對使用者沒幫忙', () => {
    setLang('zh-Hant');
    expect(describeTokenError(new TokenError('auth', 'missing or wrong bearer token'), t)).toContain('TRIPLOG_API_KEY');
    expect(describeTokenError(new TokenError('auth', '只有主金鑰能簽發 token'), t)).toContain('TRIPLOG_API_KEY');
    expect(describeTokenError(new TokenError('notfound', 'no such token'), t)).toContain('不認識');
    setLang('en');
    expect(describeTokenError(new TokenError('auth'), t)).toContain('master key');
  });

  it('沒訊息時依代碼翻成本地文案', () => {
    setLang('zh-Hant');
    expect(describeTokenError(new TokenError('notfound'), t)).toContain('不認識');
  });

  it('離線與塞太滿沿用分享那幾句，不要另造一套說法', () => {
    expect(describeTokenError(new TokenError('offline'), t)).toBe(t('share.errOffline'));
    expect(describeTokenError(new TokenError('tooMany'), t)).toBe(t('share.errTooMany'));
  });

  it('不是 TokenError 也要給出一句話，不能回傳空白', () => {
    expect(describeTokenError(new Error('boom'), t)).toBe('boom');
    expect(describeTokenError('nope', t)).toBe(t('share.errServer'));
  });
});

describe('呼叫 /api/tokens', () => {
  it('用主金鑰當 bearer，並把只顯示一次的 secret 拆出來', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ ok: true, secret: 'tlk_secret', token: row() });
      }),
    );

    const out = await createApiToken(cfg, { label: '手機', scope: 'write', expiresInDays: 30 });
    expect(out.secret).toBe('tlk_secret');
    // 列從後端的 token 來，不是從送出去的參數湊的（後端會蓋時間戳與 hint）
    expect(out.row.id).toBe('tk_1');
    expect(out.row.hint).toBe('tlk_ab12…9wZx');
    expect(calls[0].url).toBe('https://triplogmo.duckdns.org/api/tokens');
    const init = calls[0].init!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer master-key');
    expect(JSON.parse(String(init.body))).toEqual({ label: '手機', scope: 'write', expiresInDays: 30 });
  });

  it('位址結尾多一個 / 不會變成 //api', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return Response.json({ ok: true, tokens: [row()] });
      }),
    );
    await listApiTokens({ ...cfg, baseUrl: 'https://triplogmo.duckdns.org/' });
    expect(urls[0]).toBe('https://triplogmo.duckdns.org/api/tokens');
  });

  it('401 與 403 都收成 auth 代碼，讓介面能講「換主金鑰」而不是丟狀態碼', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
      await expect(listApiTokens(cfg)).rejects.toMatchObject({ code: 'auth' });
      vi.unstubAllGlobals();
    }
  });

  it('後端回非 JSON（Caddy 的純文字錯誤頁）時不要炸在解析，改回報狀態碼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const err = await listApiTokens(cfg).catch((e) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as TokenError).code).toBe('server');
    expect(describeTokenError(err, t)).toContain('502');
  });
});
