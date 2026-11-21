import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiUrlOf,
  createInvite,
  describeInviteError,
  fetchSharedTrip,
  listInvites,
  liveInvites,
  looksLikeEmail,
  myInvites,
  pushSharedExpense,
  revokeInvite,
  InviteError,
  type InviteRow,
} from './invites';
import type { SyncConfig } from './sync';

/* vitest 跑在 node 環境（沒有 jsdom），所以要自己把 localStorage 與 fetch 借給它 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}
vi.stubGlobal('localStorage', new MemoryStorage());
vi.stubGlobal('navigator', { onLine: true });

const cfg: SyncConfig = { baseUrl: 'https://triplog.example/', apiKey: 'tls_sessionabc', auto: false };

type Call = { url: string; init: RequestInit };
function stubFetch(json: unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
      } as Response;
    }),
  );
  return calls;
}

const invite = (over: Partial<InviteRow> = {}): InviteRow => ({
  id: 'g_1',
  tripId: 'trip_a',
  owner: 'u_ana',
  email: 'bo@example.com',
  role: 'write',
  createdAt: '2026-11-01T00:00:00.000Z',
  revokedAt: null,
  ...over,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('navigator', { onLine: true });
});

describe('共筆的位址', () => {
  it('沒填伺服器位址時不去亂打，直接講該做什麼', () => {
    expect(() => apiUrlOf({ baseUrl: '   ', apiKey: 'tls_x', auto: false }, '/api/invites')).toThrow(InviteError);
    try {
      apiUrlOf({ baseUrl: '', apiKey: 'tls_x', auto: false }, '/api/invites');
    } catch (err) {
      expect((err as InviteError).code).toBe('insecure');
    }
  });

  it('非加密的位址一律不通，只有本機 http 例外', () => {
    expect(() => apiUrlOf({ baseUrl: 'http://example.com', apiKey: 'tls_x', auto: false }, '/api/invites')).toThrow(/https/);
    expect(apiUrlOf({ baseUrl: 'http://127.0.0.1:8788', apiKey: 'tls_x', auto: false }, '/api/invites')).toBe(
      'http://127.0.0.1:8788/api/invites',
    );
    // 尾斜線要收掉，不然會打成 //api
    expect(apiUrlOf(cfg, '/api/invites')).toBe('https://triplog.example/api/invites');
  });
});

describe('邀請的呼叫', () => {
  it('信箱先洗成小寫，沒指定權限就是可記帳', async () => {
    const calls = stubFetch({ invite: invite({ email: 'bo@example.com' }) });
    const row = await createInvite(cfg, { tripId: 'trip_a', email: '  Bo@Example.COM ' });
    expect(row.email).toBe('bo@example.com');
    expect(calls[0].url).toBe('https://triplog.example/api/invites');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ tripId: 'trip_a', email: 'bo@example.com', role: 'write' });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tls_sessionabc');
  });

  it('清單可以只看某一趟', async () => {
    const calls = stubFetch({ invites: [invite()] });
    const rows = await listInvites(cfg, 'trip_a');
    expect(rows[0].id).toBe('g_1');
    expect(calls[0].url).toBe('https://triplog.example/api/invites?tripId=trip_a');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
  });

  it('撤銷是把 id 送出去，不是把整張邀請重寫一次', async () => {
    const calls = stubFetch({ changed: true });
    await expect(revokeInvite(cfg, 'g_1')).resolves.toEqual({ changed: true });
    expect(calls[0].url).toBe('https://triplog.example/api/invites/revoke');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: 'g_1' });
  });

  it('受邀者那一側用 mine 問「誰邀过我」', async () => {
    const calls = stubFetch({ email: 'bo@example.com', invites: [invite()] });
    const r = await myInvites(cfg);
    expect(r.email).toBe('bo@example.com');
    expect(calls[0].url).toBe('https://triplog.example/api/invites/mine');
  });

  it('代記自帶 id：連按兩下不該變兩筆', async () => {
    const calls = stubFetch({ expense: { id: 'exp_x' } });
    await pushSharedExpense(cfg, 'trip_a', { date: '2026-03-02', amount: 120, currency: 'TWD' });
    expect(calls[0].url).toBe('https://triplog.example/api/trips/trip_a/shared/expense');
    const body = JSON.parse(String(calls[0].init.body)) as { id: string; amount: number };
    expect(body.id.startsWith('exp_')).toBe(true);
    expect(body.amount).toBe(120);
  });

  it('共筆讀取走的是邀請人那一趟的路徑', async () => {
    const calls = stubFetch({ ok: true, scope: 'grant', grant: { role: 'write', tripId: 'trip_a' }, trip: {}, items: [], expenses: [], categories: [], totals: {} });
    const view = await fetchSharedTrip(cfg, 'trip 中文/');
    expect(view.scope).toBe('grant');
    expect(calls[0].url).toBe(`https://triplog.example/api/trips/${encodeURIComponent('trip 中文/')}/shared`);
  });
});

describe('錯誤要講人話', () => {
  const t = (key: string) => `‹${key}›`;

  it('401 是登入問題，403 分「沒邀請到你」與「那是唯讀」', async () => {
    stubFetch({ error: '請先用 Google 登入', login: true }, 401);
    await expect(myInvites(cfg)).rejects.toMatchObject({ code: 'login' });

    stubFetch({ error: '這趟沒有邀請到你的信箱', need: 'invite' }, 403);
    let noInvite: InviteError | null = null;
    try {
      await myInvites(cfg);
    } catch (e) {
      noInvite = e as InviteError;
    }
    expect(noInvite?.code).toBe('noInvite');
    // 伺服器標的 need 要留下來：前端才分得出缺的是邀請還是登入
    expect(noInvite?.need).toBe('invite');

    stubFetch({ error: '這張邀請是唯讀的：看得到這趟，但不能替它記帳' }, 403);
    await expect(fetchSharedTrip(cfg, 'trip_a')).rejects.toMatchObject({ code: 'readonly' });
  });

  it('404／409／429 各有各的說法', async () => {
    for (const [status, code] of [[404, 'notfound'], [409, 'conflict'], [410, 'gone'], [429, 'tooMany']] as const) {
      stubFetch({ error: 'x' }, status);
      await expect(myInvites(cfg)).rejects.toMatchObject({ code });
    }
  });

  it('連不出去是網路，瀏覽器明說離線就是離線', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('boom');
    }));
    await expect(myInvites(cfg)).rejects.toMatchObject({ code: 'network' });

    vi.stubGlobal('navigator', { onLine: false });
    await expect(myInvites(cfg)).rejects.toMatchObject({ code: 'offline' });
  });

  it('文案對應：沒被邀請與登入失效不能是同一句', () => {
    expect(describeInviteError(new InviteError('noInvite', ''), t)).toBe('‹invite.errNoInvite›');
    expect(describeInviteError(new InviteError('login', ''), t)).toBe('‹invite.errLogin›');
    expect(describeInviteError(new InviteError('readonly', ''), t)).toBe('‹invite.errReadonly›');
    // 伺服器自己那句話（例如 403 沒分類的場合）要原封不動傳出去，不要一律蓋成「伺服器錯誤」
    expect(describeInviteError(new Error('後端說：邀請已結束'), t)).toBe('後端說：邀請已結束');
    expect(describeInviteError(undefined, t)).toBe('‹invite.errServer›');
  });
});

describe('清單上的邀請', () => {
  it('撤過的不算：那代表邀請人已經反悔', () => {
    const rows = [invite(), invite({ id: 'g_2', revokedAt: '2026-11-02T00:00:00.000Z' })];
    expect(liveInvites(rows).map((r) => r.id)).toEqual(['g_1']);
  });

  it('信箱形狀的輕檢查只做形狀，真正的比對在伺服器', () => {
    expect(looksLikeEmail('Ayun@Gmail.com ')).toBe(true);
    expect(looksLikeEmail('ayun-at-gmail')).toBe(false);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('a b@c.com')).toBe(false);
    expect(looksLikeEmail(`${'x'.repeat(318)}@c.com`)).toBe(false);
  });
});
