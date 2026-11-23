/**
 * 「設定 → 金鑰與裝置」：金鑰的生命週期都在這裡，長金鑰不再需要人手抄。
 *
 * 三件事這張卡負責：
 * 1. 憑證（`tlk_…`）——要交給 agent 或另一台裝置時從這裡發，能設唯讀／可寫與效期，
 *    清單上看得到誰何時用過、動過幾筆，外流了就單獨撤銷那一把。
 *    「讓這台裝置改用這把」把本機存的金鑰換成憑證，裝置上就不再留主金鑰。
 * 2. 配對碼（8 個字）——新裝置不必貼任何長金鑰：這裡產生一組，另一台打這 8 個字
 *    就換到一把自己的憑證。一次性、幾分鐘沒用就自動失效，也能單獨作廢。
 * 3. 主金鑰輪換——`.env` 那把外流時唯一真正的補救。換完資料庫裡的雜湊就是唯一可信的
 *    主金鑰，舊的（含 `.env` 與只讀鑰）當場不被接受；要回退只能從伺服器 SSH 跑
 *    `node server/src/cli.js master-reset`。
 *
 * 這些呼叫要用**主金鑰**或**已登入裝置那條 session** 打 `/api/tokens`：主金鑰管全站，
 * 登入者只能動自己帳號那批（簽出來的憑證也自帶那個帳號）。唯獨拿已經簽發出去的 token
 * 叫它再發一把是 403，否則任何一把外流的 agent 憑證都能自己擴權。`/api/pair` 不需要金鑰，
 * 它靠配對碼授權，而且限流獨立（預設每 IP 每分鐘 8 次）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { Key } from '../../i18n';
import { Field } from '../../components/Controls';
import { copyText } from '../../lib/share';
import { loadSyncConfig, saveSyncConfig, type SyncConfig } from '../../lib/sync';
import {
  AGENT_TOKEN_PLACEHOLDER,
  activeTokens,
  agentConfig,
  createApiToken,
  createPairingCode,
  daysLeft,
  describeTokenError,
  DEVICE_TOKEN_SOON_DAYS,
  isCurrentDevice,
  isIssuedToken,
  isSessionToken,
  listApiTokens,
  listPairings,
  masterStatus,
  pairCodeProgress,
  pairingState,
  revokeApiToken,
  revokePairing,
  rotateMasterKey,
  tokenState,
  type ApiTokenRow,
  type MasterStatus,
  type Translate,
  type PairingRow,
  type TokenScope,
  type TokenState,
} from '../../lib/tokens';

/** 30/90/365 對應後端的期限上限（365 硬擋），不設限期留給「自己那台裝置」這種長期用途 */
const EXPIRY: { value: string; key: Key }[] = [
  { value: '30', key: 'tokens.expires30' },
  { value: '90', key: 'tokens.expires90' },
  { value: '365', key: 'tokens.expires365' },
  { value: 'never', key: 'tokens.expiresNever' },
];

/** 配對碼的存在時間：夠讓人當場打完，又不會讓一組碼躺在資料庫裡等人猜 */
const WINDOW: { value: number; key: Key }[] = [
  { value: 10, key: 'keys.pairMinutes10' },
  { value: 30, key: 'keys.pairMinutes30' },
  { value: 120, key: 'keys.pairMinutes120' },
];

const STATE_KEY: Record<TokenState, Key> = {
  active: 'tokens.stateActive',
  expired: 'tokens.stateExpired',
  revoked: 'tokens.stateRevoked',
};

const PAIR_STATE_KEY: Record<ReturnType<typeof pairingState>, Key> = {
  waiting: 'keys.pairStateWaiting',
  used: 'keys.pairStateUsed',
  revoked: 'keys.pairStateRevoked',
  expired: 'keys.pairStateExpired',
};

const SCOPE_KEY: Record<TokenScope, Key> = {
  read: 'tokens.scopeRead',
  write: 'tokens.scopeWrite',
};

/** 簽發那張卡下方的四步說明（順序有意義：最後一步「同步才看得到」是最多人漏的） */
const guideSteps: Key[] = ['tokens.guide1', 'tokens.guide2', 'tokens.guide3', 'tokens.guide4'];

/** 時間戳跨年時年份要看得到，否則「2/19」會被讀成今年 */
function when(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

/** 只顯示一次的東西（憑證、配對碼、新主金鑰）都用這一塊，收起來就再也查不回來 */
function Once({
  title,
  body,
  value,
  mono,
  onDismiss,
  children,
}: {
  title: string;
  body: string;
  value: string;
  mono?: boolean;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const { toast } = useUi();
  const { t } = useI18n();
  return (
    <div className="stack-s" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}>
      <strong>{title}</strong>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
        style={mono ? { textAlign: 'center', fontSize: 26, letterSpacing: '0.12em', fontFamily: 'ui-monospace, monospace' } : undefined}
      />
      <p className="tiny" style={{ margin: 0, color: 'var(--danger)' }}>
        {body}
      </p>
      <div className="row wrap">
        <button
          className="btn btn-sm btn-primary"
          onClick={async () => {
            const ok = await copyText(value);
            toast(ok ? t('tokens.copied') : t('tokens.copyFail'), ok ? undefined : { kind: 'error' });
          }}
        >
          {t('tokens.copy')}
        </button>
        {children}
        <button className="btn btn-sm" onClick={onDismiss}>
          {t('tokens.dismiss')}
        </button>
      </div>
    </div>
  );
}

type FreshToken = { secret: string; row: ApiTokenRow };
type FreshPair = { display: string; code: string };
type FreshMaster = { secret: string };

export function KeyDeviceCard() {
  const { toast, ask } = useUi();
  const { t, locale } = useI18n();
  /** 這組介面用的就是同步那台伺服器與那把金鑰，不另存一份設定 */
  const [cfg, setCfg] = useState<SyncConfig | null>(() => loadSyncConfig());
  const [rows, setRows] = useState<ApiTokenRow[] | null>(null);
  const [pairs, setPairs] = useState<PairingRow[] | null>(null);
  const [master, setMaster] = useState<MasterStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [expiry, setExpiry] = useState('90');
  const [pairLabel, setPairLabel] = useState('');
  const [pairScope, setPairScope] = useState<TokenScope>('write');
  const [pairWindow, setPairWindow] = useState('30');
  const [freshToken, setFreshToken] = useState<FreshToken | null>(null);
  const [freshPair, setFreshPair] = useState<FreshPair | null>(null);
  const [freshMaster, setFreshMaster] = useState<FreshMaster | null>(null);

  useEffect(() => {
    setCfg(loadSyncConfig());
  }, []);

  const reload = useCallback(async () => {
    if (!cfg) return;
    setError('');
    try {
      // 三張清單各自獨立：配對與主金鑰狀態只有主金鑰看得到，用憑證進來時會 403，
      // 但憑證清單本身還是該顯示（撤銷別的裝置要用到它）
      const [tokens, pairings, status] = await Promise.all([
        listApiTokens(cfg),
        listPairings(cfg).catch(() => null),
        masterStatus(cfg).catch(() => null),
      ]);
      setRows(tokens);
      setPairs(pairings);
      setMaster(status);
    } catch (err) {
      setRows([]);
      setError(describeTokenError(err, t));
    }
  }, [cfg, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 生效中的排前面，其餘依發出時間從新到舊（撤銷記錄留著，才能看出什麼時候收手過）
  const ordered = useMemo(() => {
    const all = rows ?? [];
    const live = activeTokens(all);
    const rest = all
      .filter((r) => !live.includes(r))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return [...live.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), ...rest];
  }, [rows]);

  const orderedPairs = useMemo(() => {
    const all = pairs ?? [];
    const waiting = all.filter((p) => pairingState(p) === 'waiting');
    const rest = all
      .filter((p) => pairingState(p) !== 'waiting')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return [...waiting.sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt))), ...rest];
  }, [pairs]);

  /** 這台裝置自己那把（用本機金鑰的 hint 對照）；撤銷其他所有時要留著它 */
  const selfId = useMemo(() => {
    const mine = (rows ?? []).find((r) => isCurrentDevice(r, cfg?.apiKey ?? ''));
    return mine ? mine.id : '';
  }, [rows, cfg]);

  /**
   * 本機這把還剩幾天。自動簽發給的是 90 天，到期那天同步會整個停，
   * 所以剩下不到兩週就要在清單上講明，讓人在停掉之前重簽一張。
   */
  const selfDaysLeft = useMemo(() => {
    const mine = (rows ?? []).find((r) => isCurrentDevice(r, cfg?.apiKey ?? ''));
    if (!mine || tokenState(mine) !== 'active') return Infinity;
    return daysLeft(mine.expiresAt);
  }, [rows, cfg]);

  const fail = (err: unknown) => setError(describeTokenError(err, t));

  const make = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setError('');
    try {
      const minted = await createApiToken(cfg, {
        label: label.trim(),
        scope,
        expiresInDays: expiry === 'never' ? 'never' : Number(expiry),
      });
      setFreshToken(minted);
      setLabel('');
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const makePair = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setError('');
    try {
      const made = await createPairingCode(cfg, {
        label: pairLabel.trim(),
        scope: pairScope,
        expiresInMinutes: Number(pairWindow),
      });
      setFreshPair({ code: made.code, display: made.display });
      setPairLabel('');
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** 把完整值塞進本機同步設定：裝置上從此不留主金鑰，只留一把能單獨撤銷的憑證 */
  const applyToThisDevice = async (secret: string, readOnly: boolean) => {
    if (!cfg) return;
    if (readOnly && !(await ask(t('tokens.applyReadOnlyWarn'), { confirmLabel: t('common.confirm') }))) return;
    const next = { ...cfg, apiKey: secret };
    saveSyncConfig(next);
    setCfg(next);
    setFreshToken(null);
    toast(t('tokens.applied'));
    void reload();
  };

  /**
   * 把 MCP 那段設定複製走。帶剛簽發的 secret 時就真的是「複製完就能用」，
   * 沒有 secret（已被收起來）時給佔位符，讓人自己貼——完整值我們也存不了，
   * 資料庫裡只有雜湊，這一格本來就查不回來。
   */
  const copyAgentConfig = async (secret: string, which: TokenScope) => {
    if (!cfg) return;
    const ok = await copyText(agentConfig(cfg.baseUrl, secret, which));
    toast(ok ? t('tokens.configCopied') : t('tokens.copyFail'), ok ? undefined : { kind: 'error' });
  };

  const drop = async (row: ApiTokenRow) => {
    if (!cfg || busy) return;
    const name = row.label || row.hint;
    if (!(await ask(t('tokens.revokeQ'), { confirmLabel: t('tokens.revoke'), danger: true }))) return;
    setBusy(true);
    setError('');
    try {
      await revokeApiToken(cfg, row.id);
      if (freshToken?.row.id === row.id) setFreshToken(null);
      toast(t('tokens.revoked', { label: name }));
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const dropPair = async (row: PairingRow) => {
    if (!cfg || busy) return;
    if (!(await ask(t('keys.pairRevokeQ'), { confirmLabel: t('keys.pairRevoke'), danger: true }))) return;
    setBusy(true);
    setError('');
    try {
      await revokePairing(cfg, row.id);
      setFreshPair(null);
      toast(t('keys.pairRevoked'));
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** 一鍵收掉其他所有：自己這把留著，否則按下去就把自己關在門外 */
  const dropOthers = async () => {
    if (!cfg || busy) return;
    const targets = (rows ?? []).filter((r) => tokenState(r) === 'active' && r.id !== selfId);
    if (!targets.length) {
      toast(t('tokens.revokeAllNone'));
      return;
    }
    if (!(await ask(t('tokens.revokeAllQ'), { confirmLabel: t('tokens.revokeAll'), danger: true }))) return;
    setBusy(true);
    setError('');
    try {
      let done = 0;
      for (const row of targets) {
        await revokeApiToken(cfg, row.id);
        done += 1;
      }
      toast(t('tokens.revokeAllDone', { n: done }));
      await reload();
    } catch (err) {
      fail(err);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (forced = false) => {
    if (!cfg || busy) return;
    const ok = await ask(t('keys.masterRotateQ'), { confirmLabel: t('keys.masterRotate'), danger: true });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const res = await rotateMasterKey(cfg, forced ? 'rotate-master-no-backup' : 'rotate-master');
      setFreshMaster({ secret: res.secret });
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return (
      <section className="card card-pad stack">
        <h3>{t('keys.title')}</h3>
        <div className="notice">{t('tokens.needSync')}</div>
      </section>
    );
  }

  const localIsSession = isSessionToken(cfg.apiKey);
  const localIsMaster = !isIssuedToken(cfg.apiKey) && !localIsSession;
  const noBackupCredentials = activeTokens(rows ?? []).length === 0;

  return (
    <section className="card card-pad stack">
      <h3>{t('keys.title')}</h3>

      {/* ------------------------------------------------- 這台裝置用的金鑰 */}
      <div className="stack-s">
        <strong style={{ fontSize: 14 }}>{t('tokens.local')}</strong>
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>
          {localIsSession ? t('keys.localSession') : localIsMaster ? t('tokens.localMaster') : t('tokens.localToken')}
        </p>
        {master ? (
          <p className="tiny" style={{ margin: 0 }}>
            {localIsMaster ? t('keys.masterHint', { hint: master.hint }) : ''}
          </p>
        ) : null}
      </div>

      {localIsSession ? <div className="notice">{t('keys.sessionNote')}</div> : null}

      {/* ----------------------------------------------------- 憑證與簽發 */}
      <div className="stack-s">
        <Field label={t('tokens.label')} hint={t('tokens.labelHint')}>
          <input
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('tokens.labelPlaceholder')}
            autoComplete="off"
          />
        </Field>

        <Field
          label={t('tokens.scope')}
          hint={scope === 'write' ? t('tokens.scopeWriteHint') : t('tokens.scopeReadHint')}
        >
          <div className="row wrap" role="group" aria-label={t('tokens.scope')}>
            {(['read', 'write'] as TokenScope[]).map((s) => (
              <label className="row" key={s} style={{ gap: 8 }}>
                <input type="radio" name="token-scope" checked={scope === s} onChange={() => setScope(s)} />
                <span style={{ fontSize: 14 }}>{t(SCOPE_KEY[s])}</span>
              </label>
            ))}
          </div>
        </Field>

        <Field label={t('tokens.expires')}>
          <div className="row wrap">
            <select
              className="grow"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-label={t('tokens.expires')}
            >
              {EXPIRY.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.key)}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={() => void make()} disabled={busy}>
              {busy ? t('tokens.creating') : t('tokens.create')}
            </button>
          </div>
        </Field>
      </div>

      {freshToken ? (
        <Once
          title={t('tokens.created')}
          body={t('tokens.once')}
          value={freshToken.secret}
          onDismiss={() => setFreshToken(null)}
        >
          <button
            className="btn btn-sm"
            onClick={() => void copyAgentConfig(freshToken.secret, freshToken.row.scope)}
          >
            {t('tokens.copyConfig')}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void applyToThisDevice(freshToken.secret, freshToken.row.scope === 'read')}
          >
            {t('tokens.apply')}
          </button>
        </Once>
      ) : null}

      {freshMaster ? (
        <Once title={t('keys.masterNew')} body={t('keys.masterRotateDone')} value={freshMaster.secret} onDismiss={() => setFreshMaster(null)} />
      ) : null}

      {freshPair ? (
        <Once
          title={freshPair.display}
          body={t('keys.pairOnce')}
          value={freshPair.code}
          mono
          onDismiss={() => setFreshPair(null)}
        />
      ) : null}

      {/* agent 那一側的接法。存在是為了「env 名字讓人記」一定會記錯，乾脆把整段給他複製 */}
      <div className="stack-s" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}>
        <strong style={{ fontSize: 14 }}>{t('tokens.guideTitle')}</strong>
        <ol className="tiny" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          {(guideSteps as Key[]).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ol>
        <p className="tiny" style={{ margin: 0 }}>
          {t('tokens.mcpHint', { url: cfg.baseUrl })}
        </p>
        <div
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            lineHeight: 1.5,
            padding: 10,
            borderRadius: 10,
            background: 'var(--bg)',
            overflowWrap: 'anywhere',
          }}
        >
          {agentConfig(cfg.baseUrl, AGENT_TOKEN_PLACEHOLDER, scope)}
        </div>
        <div className="row wrap">
          <button className="btn btn-sm" onClick={() => void copyAgentConfig(AGENT_TOKEN_PLACEHOLDER, scope)}>
            {t('tokens.copyConfig')}
          </button>
        </div>
      </div>

      {error ? (
        <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {/* ------------------------------------------------- 生效中的憑證 */}
      <div className="stack-s" role="group" aria-label={t('keys.devices')}>
        <div className="row">
          <strong className="grow">{t('keys.devices')}</strong>
          <button className="btn btn-sm btn-ghost" onClick={() => void reload()} disabled={busy}>
            {t('tokens.refresh')}
          </button>
        </div>
        {rows === null ? <span className="tiny">{t('tokens.loading')}</span> : null}
        {rows !== null && ordered.length === 0 ? <span className="tiny">{t('tokens.empty')}</span> : null}
        {ordered.map((row) => {
          const state = tokenState(row);
          const mine = row.id === selfId;
          return (
            <div
              className="row wrap"
              key={row.id}
              style={{ gap: 8 }}
              aria-label={t('tokens.rowAria', { label: row.label || row.hint })}
            >
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {row.label || row.hint}
                  {row.label ? <span className="tiny"> · {row.hint}</span> : null}
                </div>
                <div className="tiny">
                  {t('tokens.usage', { hits: row.hits, writes: row.writes })} ·{' '}
                  {row.lastSeenAt
                    ? t('tokens.lastSeen', { when: when(row.lastSeenAt, locale) })
                    : t('tokens.neverUsed')}
                </div>
                <div className="tiny">
                  {row.expiresAt ? t('tokens.expiresAt', { when: when(row.expiresAt, locale) }) : t('tokens.noExpiry')}
                </div>
                {mine && Number.isFinite(selfDaysLeft) && selfDaysLeft <= DEVICE_TOKEN_SOON_DAYS ? (
                  <div className="tiny" style={{ color: 'var(--danger)' }}>
                    {t('keys.autoSoon', { n: selfDaysLeft })}
                  </div>
                ) : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {mine ? <span className="badge">{t('tokens.thisDevice')}</span> : null}
                <span className="badge" aria-label={t('tokens.scopeAria', { scope: t(SCOPE_KEY[row.scope]) })}>
                  {t(STATE_KEY[state])}
                </span>
                <span className="badge">{t(SCOPE_KEY[row.scope])}</span>
              </div>
              {state === 'active' && !mine ? (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void drop(row)}
                  disabled={busy}
                  aria-label={t('tokens.revokeAria', { label: row.label || row.hint })}
                >
                  {t('tokens.revoke')}
                </button>
              ) : null}
            </div>
          );
        })}
        {ordered.some((r) => tokenState(r) === 'active' && r.id !== selfId) ? (
          <button className="btn btn-sm btn-danger" onClick={() => void dropOthers()} disabled={busy}>
            {t('tokens.revokeAll')}
          </button>
        ) : null}
      </div>

      {/* ----------------------------------------------------- 配對碼 */}
      <div className="stack-s">
        <strong style={{ fontSize: 14 }}>{t('keys.pairTitle')}</strong>
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>
          {t('keys.pairBody')}
        </p>
        {pairs === null ? (
          <div className="notice">{t('keys.masterNeedMaster')}</div>
        ) : (
          <>
            <Field label={t('keys.pairLabel')}>
              <input
                value={pairLabel}
                maxLength={60}
                onChange={(e) => setPairLabel(e.target.value)}
                placeholder={t('keys.pairLabelPlaceholder')}
                autoComplete="off"
              />
            </Field>
            <Field label={t('tokens.scope')} hint={pairScope === 'write' ? t('tokens.scopeWriteHint') : t('tokens.scopeReadHint')}>
              <div className="row wrap" role="group" aria-label={t('tokens.scope')}>
                {(['write', 'read'] as TokenScope[]).map((s) => (
                  <label className="row" key={s} style={{ gap: 8 }}>
                    <input type="radio" name="pair-scope" checked={pairScope === s} onChange={() => setPairScope(s)} />
                    <span style={{ fontSize: 14 }}>{t(SCOPE_KEY[s])}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label={t('keys.pairMinutes')}>
              <div className="row wrap">
                <select
                  className="grow"
                  value={pairWindow}
                  onChange={(e) => setPairWindow(e.target.value)}
                  aria-label={t('keys.pairMinutes')}
                >
                  {WINDOW.map((o) => (
                    <option key={o.value} value={String(o.value)}>
                      {t(o.key)}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary" onClick={() => void makePair()} disabled={busy}>
                  {busy ? t('keys.pairCreating') : t('keys.pairCreate')}
                </button>
              </div>
            </Field>
            <div className="stack-s" role="group" aria-label={t('keys.pairList')}>
              <strong style={{ fontSize: 14 }}>{t('keys.pairList')}</strong>
              {orderedPairs.length === 0 ? <span className="tiny">{t('keys.pairEmpty')}</span> : null}
              {orderedPairs.map((row) => {
                const state = pairingState(row);
                return (
                  <div
                    className="row wrap"
                    key={row.id}
                    style={{ gap: 8 }}
                    aria-label={t('keys.pairRowAria', { label: row.label || row.id })}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{row.label || t('keys.pairLabel')}</div>
                      <div className="tiny">
                        {t('keys.pairExpiresAt', { when: when(row.expiresAt, locale) })}
                        {row.usedLabel ? ` · ${t('keys.pairUsedBy', { who: row.usedLabel })}` : ''}
                      </div>
                    </div>
                    <span className="badge">{t(PAIR_STATE_KEY[state])}</span>
                    <span className="badge">{t(SCOPE_KEY[row.scope === 'write' ? 'write' : 'read'])}</span>
                    {state === 'waiting' ? (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => void dropPair(row)}
                        disabled={busy}
                        aria-label={t('keys.pairRevokeAria', { label: row.label || row.id })}
                      >
                        {t('keys.pairRevoke')}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* --------------------------------------------------- 主金鑰輪換 */}
      <div className="stack-s">
        <strong style={{ fontSize: 14 }}>{t('keys.masterTitle')}</strong>
        {master ? (
          <p className="muted" style={{ fontSize: 14, margin: 0 }}>
            {master.rotated
              ? t('keys.masterRotated', { when: when(master.setAt, locale) })
              : t('keys.masterBootstrap')}
          </p>
        ) : (
          <p className="tiny" style={{ margin: 0 }}>
            {t('keys.masterNeedMaster')}
          </p>
        )}
        {noBackupCredentials ? (
          <div className="notice" style={{ color: 'var(--danger)' }}>
            {t('keys.masterRotateWarn')}
          </div>
        ) : null}
        {master && localIsMaster ? (
          <div className="row wrap">
            <button
              className="btn btn-danger"
              onClick={() => void rotate(false)}
              disabled={busy || noBackupCredentials}
            >
              {busy ? t('keys.masterRotating') : t('keys.masterRotate')}
            </button>
            {noBackupCredentials ? (
              <button className="btn btn-sm" onClick={() => void rotate(true)} disabled={busy}>
                {t('keys.masterRotateForced')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 輸入框旁邊的即時提示：還差幾個字、有沒有打到 I/L/O/0。真正的判斷在 `pairCodeProgress`，
 * 這裡只負責把它翻成人話——新裝置那一側也是同一條規則，兩邊不會各說各話。
 */
export function pairCodeHint(input: string, t: Translate): string {
  const { left, bad, ready } = pairCodeProgress(input);
  if (ready || !input.trim()) return '';
  if (bad) return t('keys.codeBadChars');
  return t('keys.codeIncomplete', { n: left });
}
