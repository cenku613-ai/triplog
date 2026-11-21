import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '../i18n';
import {
  TokenError,
  activeTokens,
  createApiToken,
  createPairingCode,
  describeTokenError,
  formatPairCode,
  hintOf,
  isCurrentDevice,
  isIssuedToken,
  listApiTokens,
  listPairings,
  masterStatus,
  normalizePairCode,
  pairCodeProgress,
  pairWithCode,
  pairingState,
  rotateMasterKey,
  tokenState,
  type ApiTokenRow,
  type PairingRow,
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

const pair = (over: Partial<PairingRow> = {}): PairingRow => ({
  id: 'pr_1',
  label: '小美的手機',
  scope: 'write',
  createdAt: '2026-11-20T00:00:00.000Z',
  expiresAt: '2026-11-21T00:30:00.000Z',
  usedAt: null,
  revokedAt: null,
  usedLabel: '',
  ...over,
});

/**
 * 配對碼是「8 個字換一把憑證」，所以客戶端這邊要自己擋掉明顯打錯的輸入：
 * 讓使用者在送出之前就聽到「還差幾個字」或「這幾個字不會出現」，比拿 400 回來好得多。
 */
describe('配對碼的輸入處理', () => {
  it('正規化吃掉大小寫、空白與橫線', () => {
    expect(normalizePairCode('kq7t-m3xz')).toBe('KQ7TM3XZ');
    expect(normalizePairCode(' KQ7T M3XZ ')).toBe('KQ7TM3XZ');
    expect(normalizePairCode('KQ7TM3XZ')).toBe('KQ7TM3XZ');
  });

  it('長度與字母表不對就是不對（I/L/O/0 不會出現在碼裡）', () => {
    expect(normalizePairCode('KQ7T')).toBeNull();
    expect(normalizePairCode('KQ7TM3XZZ')).toBeNull();
    expect(normalizePairCode('KQ7T-M3X0')).toBeNull();
    expect(normalizePairCode('KQ7T-M3X!')).toBeNull();
    expect(normalizePairCode(null)).toBeNull();
    expect(normalizePairCode(undefined)).toBeNull();
  });

  it('顯示時每 4 個字一條橫線', () => {
    expect(formatPairCode('kq7t-m3xz')).toBe('KQ7T-M3XZ');
    expect(formatPairCode('KQ7T')).toBe('KQ7T');
  });

  it('即時提示分三種狀況：還沒打完、打到不該出現的字、可以送出', () => {
    expect(pairCodeProgress('KQ7TM3XZ')).toEqual({ left: 0, bad: false, ready: true });
    expect(pairCodeProgress('KQ7T')).toEqual({ left: 4, bad: false, ready: false });
    expect(pairCodeProgress('KQ7L')).toEqual({ left: 4, bad: true, ready: false });
    expect(pairCodeProgress('')).toEqual({ left: 8, bad: false, ready: false });
  });

  it('生死判斷：用掉最优先，再來是作廢，最後才是過期', () => {
    expect(pairingState(pair(), NOW)).toBe('waiting');
    expect(pairingState(pair({ usedAt: '2026-11-21T00:01:00Z' }), NOW)).toBe('used');
    expect(pairingState(pair({ revokedAt: '2026-11-21T00:01:00Z' }), NOW)).toBe('revoked');
    expect(pairingState(pair({ expiresAt: '2026-11-20T23:00:00Z' }), NOW)).toBe('expired');
    // 到期那一刻就算死：留一分鐘的模糊只會讓介面上的數字跟後端對不起來
    expect(pairingState(pair({ expiresAt: new Date(NOW).toISOString() }), NOW)).toBe('expired');
  });

  it('本機那把是不是憑證，決定了要不要勸人改用 token', () => {
    expect(isIssuedToken('tlk_Aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(isIssuedToken('smoke-write-key-0123456789abcdef')).toBe(false);
    expect(isIssuedToken('tlk_short')).toBe(false);
    expect(isIssuedToken('')).toBe(false);
    expect(hintOf('tlk_ABCD1234567890XYZW')).toBe('tlk_ABCD…XYZW');
    expect(hintOf('master-key')).toBe('');
    expect(isCurrentDevice(row({ hint: 'tlk_ABCD…XYZW' }), 'tlk_ABCD1234567890XYZW')).toBe(true);
    expect(isCurrentDevice(row(), 'tlk_ABCD1234567890XYZW')).toBe(false);
  });

  it('產生配對碼走 /api/tokens/pairings，原字串只出現在回應裡', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({
          ok: true,
          code: 'KQ7TM3XZ',
          display: 'KQ7T-M3XZ',
          expiresInMinutes: 30,
          pairing: pair(),
        });
      }),
    );
    const out = await createPairingCode(cfg, { label: '小美的手機', scope: 'write', expiresInMinutes: 30 });
    expect(out.code).toBe('KQ7TM3XZ');
    expect(out.display).toBe('KQ7T-M3XZ');
    expect(out.row.id).toBe('pr_1');
    expect(calls[0].url).toBe('https://triplogmo.duckdns.org/api/tokens/pairings');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ label: '小美的手機', scope: 'write', expiresInMinutes: 30 });
  });

  it('清單讀的是後端那兩列，客戶端不自己編時間', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, pairings: [pair(), pair({ id: 'pr_2' })] })));
    const rows = await listPairings(cfg);
    expect(rows.map((r) => r.id)).toEqual(['pr_1', 'pr_2']);
  });
});

describe('pairWithCode（新裝置那一側）', () => {
  it('不需要 bearer，送出去的是正規化後的 8 個字與裝置名', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ ok: true, secret: 'tlk_newone', token: row(), scope: 'write', expiresInDays: 365 });
      }),
    );
    const out = await pairWithCode('https://triplogmo.duckdns.org/', 'kq7t-m3xz', '小美 iPhone');
    expect(out.secret).toBe('tlk_newone');
    expect(out.expiresInDays).toBe(365);
    expect(calls[0].url).toBe('https://triplogmo.duckdns.org/api/pair');
    const init = calls[0].init!;
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({ code: 'KQ7TM3XZ', device: '小美 iPhone' });
  });

  it('沒填裝置名就不要把空字串送出去', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return Response.json({ ok: true, secret: 'tlk_x', token: row(), expiresInDays: 365 });
    }));
    await pairWithCode('https://a.b', 'KQ7TM3XZ', '   ');
    expect(body).toEqual({ code: 'KQ7TM3XZ' });
  });

  it('形狀不對時根本不發請求：在本地就擋下來', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(pairWithCode('https://a.b', 'KQ7T')).rejects.toMatchObject({ code: 'badCode' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409/410/400/404/429 各自一種代碼，訊息要能翻成有人味的話', async () => {
    const cases: [number, string][] = [
      [409, 'used'],
      [410, 'dead'],
      [400, 'badCode'],
      [404, 'badCode'],
      [429, 'tooMany'],
    ];
    for (const [status, reason] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: `server said ${reason}`, reason }, { status })));
      await expect(pairWithCode('https://a.b', 'KQ7TM3XZ')).rejects.toMatchObject({ code: reason });
      vi.unstubAllGlobals();
    }
  });

  it('配對失敗一律講自己的話：後端那幾句是繁中狀態說明，英文介面不該看到它', () => {
    setLang('en');
    expect(describeTokenError(new TokenError('used', '這組配對碼已經用過了'), t)).toContain('already used');
    expect(describeTokenError(new TokenError('dead', '這組配對碼已過期'), t)).toContain('expired');
    expect(describeTokenError(new TokenError('badCode', '形狀不對'), t)).toContain('8 characters');
    setLang('zh-Hant');
    expect(describeTokenError(new TokenError('used'), t)).toContain('一次性');
  });

  it('200 但沒有憑證也算失敗，不要讓介面上出現undefined 的金鑰', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, token: row() })));
    await expect(pairWithCode('https://a.b', 'KQ7TM3XZ')).rejects.toMatchObject({ code: 'server' });
  });
});

describe('主金鑰狀態與輪換', () => {
  it('masterStatus 讀 /api/tokens/master 的 master 物件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, master: { rotated: true, hint: 'tlm_abcd…wxyz', setAt: '2026-11-21T00:00:00Z', bootstrapKeyActive: false, envReadKeyActive: false, maxExpiryDays: 365 } }),
      ),
    );
    const st = await masterStatus(cfg);
    expect(st.rotated).toBe(true);
    expect(st.bootstrapKeyActive).toBe(false);
  });

  it('輪換要把確認字送對，回應裡的 secret 是唯一一次', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({
          ok: true,
          secret: 'tlm_fresh',
          master: { hint: 'tlm_fres…resh', setAt: '2026-11-21T00:00:00Z', liveTokens: 2 },
          warning: '舊的主金鑰與只讀金鑰已失效',
        });
      }),
    );
    const res = await rotateMasterKey(cfg, 'rotate-master-no-backup');
    expect(res.secret).toBe('tlm_fresh');
    expect(res.liveTokens).toBe(2);
    expect(res.warning).toContain('失效');
    expect(calls[0].url).toBe('https://triplogmo.duckdns.org/api/tokens/master/rotate');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ confirm: 'rotate-master-no-backup' });
  });
});
