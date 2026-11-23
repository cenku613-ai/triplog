import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeShares,
  createShare,
  describeShareError,
  fetchShare,
  loadSharePin,
  loadViewerName,
  pushShareExpense,
  saveSharePin,
  saveViewerName,
  shareApiUrl,
  shareLink,
  ShareError,
  type ShareRow,
} from './share';
import type { SyncConfig } from './sync';

/* vitest 跑在 node（沒有 jsdom），PIN／名字這些存放行為要自己借個 Storage 出來 */
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

/** 409 那條路要真的先同步一次：這裡把 syncNow 換成可觀察的假貨，不去碰 IndexedDB */
const { syncNow } = vi.hoisted(() => ({ syncNow: vi.fn(async () => ({})) }));
vi.mock('./sync', () => ({
  syncNow,
  loadSyncConfig: () => null,
  describeSyncError: () => '',
}));

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
  // 後端現行一律帶這三個欄位；測試用的樣本也照現行形狀給，才不會測到半套型別
  canWrite: true,
  hasPin: false,
  lastWriter: '',
  ...over,
});

/**
 * 這裡測的是「不需要真的伺服器也能證明」的部分：連結長什麼樣、期限怎麼算、
 * 錯碼怎麼變成有人味的話，以及訪客的 PIN／署名怎麼擺、請求怎麼成形。
 * 端到端的 HTTP 行為由 server/test/smoke.mjs 覆蓋。
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
    // 「要 PIN」與「這條只能看」是兩件事：混在「金鑰不對」裡，同行者會去翻自己的設定
    expect(describeShareError({ code: 'pin' }, key)).toBe('share.errPin');
    expect(describeShareError({ code: 'readonly' }, key)).toBe('share.errReadOnly');
  });
});

/* ------------------------------------------------------------------ 訪客側 */

type Call = { url: string; init: RequestInit };

/** 回一份假回應，同時把打出去的 URL／標頭／內容留下來看 */
function stubFetch(json: unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('navigator', { onLine: true });
  syncNow.mockClear();
});

describe('訪客的 PIN 與署名', () => {
  it('PIN 按連結分開記，換一條不會拿到上一條的數字', () => {
    saveSharePin('tok_a', '1234');
    saveSharePin('tok_b', '9999');
    expect(loadSharePin('tok_a')).toBe('1234');
    expect(loadSharePin('tok_b')).toBe('9999');
    expect(loadSharePin('tok_c')).toBe('');
  });

  it('主人換了新的 PIN（舊那組已經不管用了）時，能清乾淨重填', () => {
    saveSharePin('tok_a', '1234');
    saveSharePin('tok_a', '');
    expect(loadSharePin('tok_a')).toBe('');
  });

  it('存到壞值（被動過或上一版留的）就當沒填，頁面不該因此炸掉', () => {
    sessionStorage.setItem('triplog:share:pin', '{不是 JSON');
    expect(loadSharePin('tok_a')).toBe('');
    sessionStorage.setItem('triplog:share:pin', JSON.stringify({ tok_a: 1234 }));
    expect(loadSharePin('tok_a')).toBe('');
  });

  it('名字是「我是誰」，跟 PIN 相反，留在這台裝置上', () => {
    expect(loadViewerName()).toBe('');
    saveViewerName('小美');
    expect(loadViewerName()).toBe('小美');
    saveViewerName('');
    expect(loadViewerName()).toBe('');
  });

  it('PIN 走標頭、不夾在要寫入的內容裡', async () => {
    const calls = stubFetch({ ok: true, expense: { id: 'exp_1' } });
    await pushShareExpense('tok a', { date: '2026-11-01', amount: 100, currency: 'TWD' }, '1234', '小美');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-triplog-pin']).toBe('1234');
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    // 表單裡不該有 PIN：複製那份 JSON 除錯時才不會連帶把它傳出去
    expect(body.pin).toBeUndefined();
    expect(body.who).toBe('小美');
    // token 進網址前要 escape，空白這種東西不能直接拼進去
    expect(calls[0].url).toContain('/api/share/tok%20a/expense');
  });

  it('沒設 PIN 的舊連結：標頭整個不出現，行為跟以前一樣', async () => {
    const calls = stubFetch({ ok: true, trip: {}, items: [], expenses: [], categories: [], totals: {}, share: {}, head: null });
    await fetchShare('tok_old');
    expect((calls[0].init.headers as Record<string, string>)['x-triplog-pin']).toBeUndefined();
  });

  it('401＋needPin 是「問 PIN」，還會把這條能不能記一起帶回來', async () => {
    stubFetch({ error: '需要訪客 PIN', needPin: true, canWrite: false }, 401);
    const err = await fetchShare('tok_x').catch((e) => e);
    expect(err).toBeInstanceOf(ShareError);
    expect((err as ShareError).code).toBe('pin');
    expect((err as ShareError).canWrite).toBe(false);
  });

  it('403＋readOnly 不當身分錯：那是連結本身的權限', async () => {
    stubFetch({ error: '這條分享連結是唯讀的', readOnly: true }, 403);
    const err = await fetchShare('tok_x').catch((e) => e);
    expect((err as ShareError).code).toBe('readonly');
  });
});

/* ---------------------------------------------------------------- 主人側 */

describe('產生分享連結', () => {
  const cfg: SyncConfig = { baseUrl: 'https://triplog.example/', apiKey: 'tlm_master', auto: false };

  it('沒選 PIN 就不送這個欄位，預設是可記帳', async () => {
    const calls = stubFetch({ ok: true, share: row() });
    const r = await createShare(cfg, { tripId: 'trip_1' });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toEqual({ tripId: 'trip_1', expiresInDays: 90, canWrite: true });
    // 沒設 PIN 時伺服器不會多回一個 pin；統一成空字串，對話框才不用寫兩種判斷
    expect(r).toEqual({ row: row(), pin: '' });
  });

  it('貼進來的 PIN 先只留數字，形狀不對就整個不送', async () => {
    const calls = stubFetch({ ok: true, share: row(), pin: '1234' });
    const r = await createShare(cfg, { tripId: 'trip_1', pin: ' 12-34 房 ' });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.pin).toBe('1234');
    // 明文只在建立這一刻回來一次，對話框要靠它提醒主人抄走
    expect(r.pin).toBe('1234');

    calls.length = 0;
    await createShare(cfg, { tripId: 'trip_1', pin: '12' });
    expect(JSON.parse(String(calls[0].init.body)).pin).toBeUndefined();
  });

  it('關掉「能不能記」時這條規則跟著出去，伺服器那側才擋得住', async () => {
    const calls = stubFetch({ ok: true, share: row({ canWrite: false }) });
    await createShare(cfg, { tripId: 'trip_1', canWrite: false });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ canWrite: false });
  });

  it('這一趟還沒推上去過（409）：先自己同步一次再重試，不必叫使用者去學「同步」', async () => {
    let hits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hits += 1;
        return hits === 1
          ? ({ ok: false, status: 409, json: async () => ({ error: '伺服器上還沒有這一趟' }) } as Response)
          : ({ ok: true, status: 200, json: async () => ({ ok: true, share: row() }) } as Response);
      }),
    );
    const r = await createShare(cfg, { tripId: 'trip_1' });
    expect(hits).toBe(2);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith(cfg);
    expect(r.row.token).toBe('tok_abc');
  });

  it('其他錯不該觸發同步：金鑰不對時狂推只會多挨一次 401', async () => {
    stubFetch({ error: '金鑰不對' }, 401);
    const err = await createShare(cfg, { tripId: 'trip_1' }).catch((e) => e);
    expect((err as ShareError).code).toBe('auth');
    expect(syncNow).not.toHaveBeenCalled();
  });
});
