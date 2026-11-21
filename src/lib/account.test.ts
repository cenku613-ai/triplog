import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_STORAGE_KEY,
  AuthError,
  describeAuthError,
  fetchAuthConfig,
  finishLogin,
  finishLogout,
  gateFor,
  loadAccount,
  loginWithGoogle,
  normalizeBase,
  rememberedMode,
  saveAccount,
  sessionLive,
  type AccountState,
} from './account';
import { LEGACY_DB_NAME, dbNameFor, db as activeDb, openAccountDb } from '../db/db';
import type { Expense, Trip } from '../db/types';
import { loadSyncConfig, saveSyncConfig, SYNC_STORAGE_KEY } from './sync';

const ana: AccountState = {
  token: `tls_${'a'.repeat(43)}`,
  baseUrl: 'https://triplogmo.duckdns.org',
  user: { id: 'u_ana', email: 'ana@example.com', name: 'Ana', picture: '' },
  session: { id: 'sess_1', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  signedInAt: new Date().toISOString(),
};

/** 夠用的 Storage 介面實作：node 環境沒有 localStorage，這類存放行為要有東西可測 */
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** 把「制度前那份庫」倒空並清掉認領標記：分庫的行為要靠它才有重複性 */
async function resetLegacyDb(): Promise<void> {
  await openAccountDb(null);
  await Promise.all([
    activeDb.trips.clear(),
    activeDb.dayItems.clear(),
    activeDb.expenses.clear(),
    activeDb.categories.clear(),
    activeDb.photos.clear(),
  ]);
  await activeDb.meta.delete('claimedBy');
}

/** 一次乾淨的本機存放：帳號、同步設定都重來 */
function resetStorage(): void {
  vi.stubGlobal('localStorage', new MemoryStorage());
  saveAccount(null);
  saveSyncConfig(null);
}

/** 只替換 fetch：account.ts 走的還是原本那套解析邏輯 */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const out = handler(String(url), init);
      return {
        ok: (out.status ?? 200) < 400,
        status: out.status ?? 200,
        json: async () => out.body,
      } as Response;
    }),
  );
}

function trip(id: string, name: string): Trip {
  const iso = new Date().toISOString();
  return {
    id,
    name,
    startDate: '2026-01-01',
    endDate: '2026-01-02',
    baseCurrency: 'TWD',
    color: '#0f766e',
    archived: false,
    createdAt: iso,
    updatedAt: iso,
  };
}

function expense(id: string, tripId: string): Expense {
  const iso = new Date().toISOString();
  return {
    id,
    tripId,
    dayItemId: null,
    date: '2026-01-01',
    amount: 100,
    currency: 'TWD',
    rateToBase: 1,
    baseAmount: 100,
    category: 'food',
    payee: '',
    note: '',
    createdAt: iso,
    updatedAt: iso,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals(); // 先收掉上一則的 fetch / localStorage，再放乾淨的進去
  resetStorage();
});

describe('該不擋在登入畫面前面', () => {
  it('金鑰模式或還沒問過伺服器：一律不擋', () => {
    expect(gateFor('key', null, true)).toBe('none');
    expect(gateFor(null, null, true)).toBe('none');
  });

  it('帳號模式沒登入時要登入', () => {
    expect(gateFor('account', null, true)).toBe('login');
    expect(gateFor('account', { ...ana, token: '' }, true)).toBe('login');
  });

  it('有效 session 放行，過期則再擋回來', () => {
    expect(gateFor('account', ana, true)).toBe('none');
    const stale: AccountState = {
      ...ana,
      session: { id: 'sess_1', expiresAt: new Date(Date.now() - 1000).toISOString() },
    };
    expect(gateFor('account', stale, true)).toBe('login');
    expect(sessionLive(ana)).toBe(true);
    expect(sessionLive(stale)).toBe(false);
    expect(sessionLive(null)).toBe(false);
  });

  it('離線時給一條生路：這是一個離線先用的 app', () => {
    expect(gateFor('account', null, false)).toBe('offline');
  });
});

describe('伺服器位址', () => {
  it('尾部斜線去掉，之後拼路徑才不會出雙斜線', () => {
    expect(normalizeBase('https://triplogmo.duckdns.org///')).toBe('https://triplogmo.duckdns.org');
  });

  it('非加密的公網位址直接拒（瀏覽器也會拒）', () => {
    expect(() => normalizeBase('http://example.com')).toThrow(AuthError);
    expect(() => normalizeBase('not a url')).toThrow(AuthError);
    expect(normalizeBase('http://127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
  });
});

describe('本機存放與模式', () => {
  it('沒填過就沒有：不會憑空捏出一個登入狀態', () => {
    expect(loadAccount()).toBeNull();
    expect(rememberedMode()).toBeNull();
  });

  it('存的東西壞掉時當作沒登入，不讓 app 開不起來', () => {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, '{不是 JSON');
    expect(loadAccount()).toBeNull();
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify({ token: 'tls_x' }));
    expect(loadAccount()).toBeNull();
  });

  it('問過模式就記住：離線開 app 也知道該不該顯示登入鈕', async () => {
    stubFetch(() => ({
      body: { ok: true, mode: 'account', provider: 'google', clientId: 'cid.apps.googleusercontent.com', sessionDays: 45 },
    }));
    const cfg = await fetchAuthConfig('https://triplogmo.duckdns.org');
    expect(cfg).toMatchObject({ mode: 'account', clientId: 'cid.apps.googleusercontent.com', sessionDays: 45 });
    expect(rememberedMode()).toBe('account');
  });

  it('金鑰模式照樣問得出來，而且不會假裝有 Client ID', async () => {
    stubFetch(() => ({ body: { ok: true, mode: 'key', provider: 'google', clientId: null } }));
    expect(await fetchAuthConfig('https://triplogmo.duckdns.org')).toMatchObject({ mode: 'key', clientId: null });
    expect(rememberedMode()).toBe('key');
  });

  it('開了帳號卻沒 Client ID 是部署錯了，要講得能拿去修', async () => {
    stubFetch(() => ({ body: { ok: true, mode: 'account', clientId: null } }));
    await expect(fetchAuthConfig('https://triplogmo.duckdns.org')).rejects.toThrow(/Client ID/);
  });

  it('連不上時是 network，不是「登入失敗」這種廢話', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await fetchAuthConfig('https://triplogmo.duckdns.org').catch((e) => e as AuthError);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('network');
  });

  it('5xx 時把後端那句原話留著，介面才說得出「公鑰抓不到」', async () => {
    stubFetch(() => ({ status: 502, body: { error: '連不上身分提供者的公鑰位置' } }));
    const err = await fetchAuthConfig('https://triplogmo.duckdns.org').catch((e) => e as AuthError);
    expect((err as AuthError).code).toBe('server');
    expect((err as AuthError).detail).toContain('公鑰');
  });
});

describe('登入換來的憑證', () => {
  it('後端回 tls_ 才算成功，並立刻成為這台裝置的同步憑證', async () => {
    stubFetch((url, init) => {
      if (!url.endsWith('/api/auth/google')) throw new Error(`不該打別處：${url}`);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body)).idToken).toBe('google.id.token');
      return { body: { ok: true, token: ana.token, user: ana.user, session: ana.session, created: true } };
    });
    const { account, created } = await loginWithGoogle('https://triplogmo.duckdns.org/', 'google.id.token', 'Pixel 8');
    expect(created).toBe(true);
    expect(loadAccount()?.token).toBe(ana.token);
    await finishLogin(account);
    expect(loadSyncConfig()).toEqual({ baseUrl: account.baseUrl, apiKey: account.token, auto: true });
    expect(localStorage.getItem(SYNC_STORAGE_KEY)).toContain(account.token);
  });

  it('登入前填的自動同步開關要留著，別讓使用者重設一次', async () => {
    saveSyncConfig({ baseUrl: ana.baseUrl, apiKey: 'm'.repeat(64), auto: false });
    stubFetch(() => ({ body: { ok: true, token: ana.token, user: ana.user, session: ana.session } }));
    const { account } = await loginWithGoogle(ana.baseUrl, 'x'.repeat(30));
    await finishLogin(account);
    expect(loadSyncConfig()).toEqual({ baseUrl: ana.baseUrl, apiKey: ana.token, auto: false });
  });

  it('拿到的不是 session（前綴不對）就中止，不把垃圾存進本機', async () => {
    stubFetch(() => ({ body: { ok: true, token: 'tlk_abcdefghijabcdefghij', user: ana.user } }));
    await expect(loginWithGoogle('https://triplogmo.duckdns.org', 'x'.repeat(30))).rejects.toThrow(/登入憑證/);
    expect(loadAccount()).toBeNull();
  });

  it('空的 credential 不送去伺服器', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(loginWithGoogle('https://triplogmo.duckdns.org', '')).rejects.toBeInstanceOf(AuthError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('登出把這台裝置脫開，並清掉那條已經沒用的同步憑證', async () => {
    saveAccount(ana);
    saveSyncConfig({ baseUrl: ana.baseUrl, apiKey: ana.token, auto: true });
    await finishLogout(ana);
    expect(loadAccount()).toBeNull();
    expect(loadSyncConfig()).toBeNull();
    expect(activeDb.dbName).toBe(LEGACY_DB_NAME);
  });

  it('登出不會把別人的金鑰設定一起清掉', async () => {
    saveAccount(ana);
    saveSyncConfig({ baseUrl: ana.baseUrl, apiKey: 'tlk_keepme_keepme_keepme_keep', auto: true });
    await finishLogout(ana);
    expect(loadSyncConfig()?.apiKey).toBe('tlk_keepme_keepme_keepme_keep');
  });
});

describe('錯誤要說人話', () => {
  // 只關心「挑了哪句話」，所以 t 直接把鍵名當成文字回，斷言才看得懂
  const t = ((key: string) => key) as unknown as Parameters<typeof describeAuthError>[1];

  it('我們這端就決定的錯誤用本機字串，其餘沿用後端原話', () => {
    expect(describeAuthError(new AuthError('network', '連不上 host'), t)).toBe('auth.errNetwork');
    expect(
      describeAuthError(new AuthError('refused', '這不是 Google 簽發的身分憑證', '這不是 Google 簽發的身分憑證'), t),
    ).toBe('這不是 Google 簽發的身分憑證');
    expect(describeAuthError(new Error('隨便什麼'), t)).toBe('隨便什麼');
    expect(describeAuthError(undefined, t)).toBe('auth.errUnknown');
  });
});

describe('本機庫按帳號分', () => {
  it('沒登入就是原本那個名字，舊裝置升級後不會看到空 app', () => {
    expect(dbNameFor(null)).toBe(LEGACY_DB_NAME);
    expect(dbNameFor('')).toBe(LEGACY_DB_NAME);
    expect(dbNameFor('u_9f2c')).toBe('triplog-u_9f2c');
  });

  it('髒 id 不會變成奇怪的庫名', () => {
    expect(dbNameFor('u/../etc')).toBe('triplog-uetc');
    // 全被過濾掉的 id 視為「沒有帳號」，宁可回到舊庫，也不要開一個名字是空白後綴的庫
    expect(dbNameFor('中文')).toBe(LEGACY_DB_NAME);
  });

  it('第一次切進帳號庫時把舊資料接過來，而且舊庫留著', async () => {
    await resetLegacyDb();
    await activeDb.trips.bulkPut([trip('trip_old', '舊的東京行')]);
    await activeDb.expenses.bulkPut([expense('exp_old', 'trip_old')]);

    const first = await openAccountDb('u_first');
    expect(first.name).toBe('triplog-u_first');
    expect(first.moved).toBe(2);
    expect(await activeDb.trips.get('trip_old')).toBeTruthy();
    expect(await activeDb.expenses.get('exp_old')).toBeTruthy();

    // 第二次切過去（登出再登回來）不能再搬一次，否則清單會重複
    await openAccountDb(null);
    const again = await openAccountDb('u_first');
    expect(again.moved).toBe(0);
    expect(await activeDb.trips.count()).toBe(1);

    // 舊庫還在原地：登出之後看得到自己原本的記錄，退路沒被收走
    await openAccountDb(null);
    expect(await activeDb.trips.get('trip_old')).toBeTruthy();
  });

  it('舊庫只認領一次：共用裝置上第二個人拿不到前一個人的旅行', async () => {
    await resetLegacyDb();
    await activeDb.trips.bulkPut([trip('trip_shared', '只有先登入的人該看到')]);
    const first = await openAccountDb('u_a');
    expect(first.moved).toBe(1);
    await openAccountDb('u_b');
    expect(await activeDb.trips.get('trip_shared')).toBeFalsy();
    await openAccountDb('u_a');
    expect(await activeDb.trips.get('trip_shared')).toBeTruthy();
  });

  it('每個帳號各一份，切來切去不會互串', async () => {
    await resetLegacyDb();
    await openAccountDb('u_first');
    await activeDb.trips.bulkPut([trip('trip_mine', '我的')]);
    const second = await openAccountDb('u_second');
    expect(second.moved).toBe(0);
    expect(await activeDb.trips.get('trip_mine')).toBeFalsy();
    await openAccountDb('u_first');
    expect(await activeDb.trips.get('trip_mine')).toBeTruthy();
  });
});
