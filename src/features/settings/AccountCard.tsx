/**
 * 「設定 → 帳號」：這台裝置登入的是誰、還有幾點到期、以及在伺服器上留了哪幾條登入。
 *
 * 為什麼這張卡要存在：登入憑證（`tls_…`）跟金鑰一樣會留在裝置上，差別是它能單獨撤銷。
 * 換手機、把裝置借人、或單純忘了 iPad 還在背包裡——都在這裡收掉，不必回伺服器動資料庫。
 *
 * 帳號模式開起來之後，主金鑰與 `tlk_` 憑證看的仍然是「帳號制度之前那份基準」，
 * 所以「金鑰與裝置」那張卡照舊有用（給 agent 簽憑證、發配對碼）；兩張卡各管各的，
 * 這裡不重複列。
 */
import { useCallback, useEffect, useState } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { guessDeviceName } from '../../lib/tokens';
import { loadSyncConfig } from '../../lib/sync';
import {
  describeAuthError,
  fetchAuthConfig,
  finishLogin,
  finishLogout,
  listMySessions,
  loadAccount,
  loginWithGoogle,
  logout,
  mountGoogleButton,
  refreshAccount,
  rememberMode,
  rememberedMode,
  revokeMySession,
  sameOriginBase,
  sessionLive,
  type AccountState,
  type AuthConfig,
  type SessionRow,
} from '../../lib/account';

/** 時間戳換成本機格式：清單上要看的是「什麼時候用過」，精確到分鐘就夠了 */
function shown(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

/** 還剩幾天：到期日是滑動續期的，講「剩幾天」比講那個時間戳好讀 */
function daysLeft(expiresAt: string | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

type Busy = '' | 'refresh' | 'sessions' | 'revoke' | 'revokeAll' | 'logout' | 'login';

export function AccountCard() {
  const { toast, ask } = useUi();
  const { t, locale } = useI18n();
  const [account, setAccount] = useState<AccountState | null>(() => loadAccount());
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const signedIn = sessionLive(account) ? account : null;

  const fail = useCallback(
    (err: unknown) => {
      const msg = describeAuthError(err, t);
      setError(msg);
      toast(msg, { kind: 'error' });
    },
    [t, toast],
  );

  // 沒登入時也要知道這台部署到底開沒開帳號模式，否則這張卡只能說「不知道」
  useEffect(() => {
    if (signedIn) return;
    const server = loadSyncConfig()?.baseUrl ?? sameOriginBase();
    if (!server) {
      setCfg(null);
      return;
    }
    let cancelled = false;
    fetchAuthConfig(server)
      .then((c) => !cancelled && setCfg(c))
      .catch(() => {
        if (!cancelled) setCfg({ mode: rememberedMode() ?? 'key', provider: 'google', clientId: null, sessionDays: 30, keysAllowed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const reloadSessions = useCallback(async () => {
    if (!signedIn) return;
    setBusy('sessions');
    try {
      setRows(await listMySessions(signedIn));
      setError('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  }, [signedIn, fail]);

  useEffect(() => {
    if (signedIn && rows === null && !busy) void reloadSessions();
    // 只在「登入了但還沒抓過清單」這一次抓，之後都靠按鈕
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // 未登入且有 Client ID：掛官方按鈕（按下去彈 Google 的帳號選擇視窗）
  useEffect(() => {
    if (signedIn || !cfg?.clientId || !host) return;
    let dead = false;
    let detach: (() => void) | null = null;
    mountGoogleButton(host, {
      clientId: cfg.clientId,
      locale: locale.startsWith('en') ? 'en' : 'zh-TW',
      onCredential: (token) => {
        void (async () => {
          setBusy('login');
          setError('');
          try {
            const server = loadSyncConfig()?.baseUrl ?? sameOriginBase();
            const { account: next } = await loginWithGoogle(server, token, guessDeviceName());
            await finishLogin(next);
            window.location.hash = '#/';
            window.location.reload();
          } catch (err) {
            fail(err);
            setBusy('');
          }
        })();
      },
    })
      .then((fn) => {
        if (dead) fn();
        else detach = fn;
      })
      .catch(fail);
    return () => {
      dead = true;
      detach?.();
      host.replaceChildren();
    };
  }, [signedIn, cfg?.clientId, host, locale, fail]);

  const refresh = async () => {
    if (!signedIn) return;
    setBusy('refresh');
    try {
      setAccount(await refreshAccount(signedIn));
      setError('');
      await reloadSessions();
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  };

  const revoke = async (row: SessionRow) => {
    if (!signedIn) return;
    const self = row.id === signedIn.session.id;
    const ok = await ask(self ? t('auth.revokeSelfQ') : t('auth.revokeQ', { label: row.label || t('auth.unknownDevice') }), {
      confirmLabel: t('auth.revoke'),
      danger: true,
    });
    if (!ok) return;
    setBusy('revoke');
    try {
      const { self: wasSelf } = await revokeMySession(signedIn, row.id);
      if (wasSelf) {
        await finishLogout(signedIn);
        window.location.reload();
        return;
      }
      toast(t('auth.revoked'));
      setRows(await listMySessions(signedIn));
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  };

  const revokeAll = async () => {
    if (!signedIn) return;
    const ok = await ask(t('auth.revokeOthersQ'), { confirmLabel: t('auth.revokeOthers'), danger: true });
    if (!ok) return;
    setBusy('revokeAll');
    try {
      const { removed } = await revokeMySession(signedIn, '', { allExceptThis: true });
      toast(t('auth.revokedN', { n: removed ?? 0 }));
      setRows(await listMySessions(signedIn));
    } catch (err) {
      fail(err);
    } finally {
      setBusy('');
    }
  };

  const signOut = async () => {
    if (!account) return;
    const ok = await ask(t('auth.logoutQ'), { confirmLabel: t('auth.logout'), danger: true });
    if (!ok) return;
    setBusy('logout');
    try {
      await logout(account);
      await finishLogout(account);
      rememberMode('account');
      window.location.reload();
    } catch (err) {
      // 斷線也要讓這台裝置先脫離登入狀態，否則畫面會卡在「已登入但什麼都讀不到」
      await finishLogout(account);
      window.location.reload();
      fail(err);
    }
  };

  /* ------------------------------------------------------------- 未登入 */

  if (!signedIn) {
    const server = loadSyncConfig()?.baseUrl ?? sameOriginBase();
    return (
      <section className="card card-pad stack">
        <h3>{t('auth.title')}</h3>
        {!server ? <div className="notice">{t('auth.needSyncFirst')}</div> : null}
        {server && cfg?.mode !== 'account' ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('auth.serverNotAccount', { server })}
          </p>
        ) : null}
        {server && cfg?.mode === 'account' ? (
          <>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('auth.signedOutHint', { server })}
            </p>
            <div ref={setHost} className="auth-gsi" />
            {busy === 'login' ? <p className="tiny" style={{ margin: 0 }}>{t('auth.working')}</p> : null}
          </>
        ) : null}
        {error ? <div className="notice">{error}</div> : null}
      </section>
    );
  }

  /* ------------------------------------------------------------- 已登入 */

  const left = daysLeft(signedIn.session.expiresAt);
  const live = (rows ?? []).filter((r) => !r.revokedAt && !r.expiresAt || Date.parse(r.expiresAt ?? '') > Date.now());
  const others = live.filter((r) => r.id !== signedIn.session.id).length;

  return (
    <section className="card card-pad stack">
      <h3>{t('auth.title')}</h3>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        {signedIn.user.picture ? (
          <img className="auth-avatar" src={signedIn.user.picture} alt="" width={40} height={40} referrerPolicy="no-referrer" />
        ) : (
          <span className="auth-avatar auth-avatar-fallback" aria-hidden="true">
            {(signedIn.user.name || signedIn.user.email || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="grow" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{signedIn.user.name || signedIn.user.email}</strong>
          <div className="tiny" style={{ overflowWrap: 'anywhere' }}>
            {signedIn.user.email}
          </div>
        </div>
      </div>

      <p className="tiny" style={{ margin: 0 }}>
        {t('auth.onServer', { server: signedIn.baseUrl })}
        {' · '}
        {left === null ? t('auth.noExpiry') : t('auth.daysLeft', { n: left })}
      </p>
      <div className="notice">{t('auth.partitionNote')}</div>

      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy !== ''}>
          {busy === 'refresh' ? t('auth.working') : t('auth.refresh')}
        </button>
        <button type="button" className="btn btn-sm" onClick={signOut} disabled={busy !== ''}>
          {t('auth.logout')}
        </button>
      </div>

      <div className="stack-s">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 14 }}>{t('auth.devices')}</strong>
          {others > 0 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={revokeAll} disabled={busy !== ''}>
              {busy === 'revokeAll' ? t('auth.working') : t('auth.revokeOthers')}
            </button>
          ) : null}
        </div>
        <p className="tiny" style={{ margin: 0 }}>
          {t('auth.devicesHint')}
        </p>

        {rows === null ? (
          <p className="tiny" style={{ margin: 0 }}>{t('auth.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="tiny" style={{ margin: 0 }}>{t('auth.noDevices')}</p>
        ) : (
          <ul className="auth-sessions">
            {rows.map((r) => {
              const expired = !!r.expiresAt && Date.parse(r.expiresAt) <= Date.now();
              const dead = !!r.revokedAt || expired;
              return (
                <li key={r.id} className={dead ? 'is-dead' : undefined}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 14 }}>
                      {r.id === signedIn.session.id ? t('auth.thisDevice') : r.label || t('auth.unknownDevice')}
                    </span>
                    <span className="tiny">
                      {r.revokedAt ? t('auth.stateRevoked') : expired ? t('auth.stateExpired') : t('auth.stateLive')}
                    </span>
                  </div>
                  <div className="tiny">
                    {t('auth.createdOn', { at: shown(r.createdAt, locale) })}
                    {r.lastSeenAt ? ` · ${t('auth.lastSeenOn', { at: shown(r.lastSeenAt, locale) })}` : ''}
                    {r.expiresAt ? ` · ${t('auth.expiresOn', { at: shown(r.expiresAt, locale) })}` : ''}
                  </div>
                  {!dead ? (
                    <div className="row" style={{ marginTop: 4 }}>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => revoke(r)} disabled={busy !== ''}>
                        {r.id === signedIn.session.id ? t('auth.revokeSelf') : t('auth.revoke')}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error ? <div className="notice">{error}</div> : null}
    </section>
  );
}
