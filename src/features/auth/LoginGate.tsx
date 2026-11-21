/**
 * 登入畫面：伺服器跑在帳號模式、而這台裝置還沒有有效 session 時擋在最前面。
 *
 * 兩件事要交代清楚，否則這頁會讓人以為自己的資料不見了：
 * 1. 資料仍在這台裝置裡（IndexedDB 按帳號分庫，登入只是決定「現在開的是哪一份」）；
 * 2. 離線時有一條生路（`auth.skip`）——這是一個離線先用的記帳 app，沒網路就不給看
 *    自己的筆記，比多按一次登入嚴重太多。
 *
 * Google 那顆按鈕由官方腳本畫（自己畫一顆不能取用它的標誌），我們只接 callback 拿到
 * ID token，再交給後端驗簽換 session。整個過程 app 不經手任何 client_secret。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Field } from '../../components/Controls';
import { guessDeviceName } from '../../lib/tokens';
import { loadSyncConfig } from '../../lib/sync';
import {
  describeAuthError,
  fetchAuthConfig,
  finishLogin,
  loadAccount,
  loginWithGoogle,
  mountGoogleButton,
  sameOriginBase,
  type AuthConfig,
} from '../../lib/account';

type Phase = 'probing' | 'signin' | 'other';

export function LoginGate({ onSkip, skipLabel }: { onSkip: () => void; skipLabel: string }) {
  const { t, lang } = useI18n();
  const saved = loadAccount();
  const [server, setServer] = useState(saved?.baseUrl ?? loadSyncConfig()?.baseUrl ?? sameOriginBase());
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [phase, setPhase] = useState<Phase>(server ? 'probing' : 'signin');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const detach = useRef<(() => void) | null>(null);

  // 問一次這台部署的模式：只有它回「account」才有必要顯示 Google 按鈕
  useEffect(() => {
    if (!server) {
      setPhase('signin');
      return;
    }
    let cancelled = false;
    setPhase('probing');
    fetchAuthConfig(server)
      .then((c) => {
        if (cancelled) return;
        setCfg(c);
        setPhase(c.mode === 'account' ? 'signin' : 'other');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeAuthError(err, t));
        setPhase('signin');
      });
    return () => {
      cancelled = true;
    };
    // t 在換語系時會換掉，不該因此重打一次 /api/auth/config
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const signIn = useCallback(
    async (credential: string) => {
      setBusy(true);
      setError('');
      try {
        const { account } = await loginWithGoogle(server, credential, guessDeviceName());
        await finishLogin(account);
        // 換了本機庫就必須重載：舊畫面上那些 useLive 訂閱讀的是另一個帳號的庫
        window.location.hash = '#/';
        window.location.reload();
      } catch (err) {
        setError(describeAuthError(err, t));
        setBusy(false);
      }
    },
    [server, t],
  );

  // Client ID 到手才掛按鈕；卸掉時要把官方腳本塞進來的節點清乾淨
  useEffect(() => {
    if (phase !== 'signin' || !cfg?.clientId || !host.current) return;
    const node = host.current;
    let dead = false;
    mountGoogleButton(node, {
      clientId: cfg.clientId,
      locale: lang === 'en' ? 'en' : 'zh-TW',
      onCredential: (token) => void signIn(token),
    })
      .then((fn) => {
        if (dead) fn();
        else detach.current = fn;
      })
      .catch((err) => {
        if (!dead) setError(describeAuthError(err, t));
      });
    return () => {
      dead = true;
      detach.current?.();
      detach.current = null;
      node.replaceChildren();
    };
  }, [phase, cfg?.clientId, lang, signIn, t]);

  return (
    <div className="page">
      <div className="auth-gate card card-pad stack">
        <div className="row" style={{ gap: 10 }}>
          <span className="auth-logo" aria-hidden="true">
            🧳
          </span>
          <h2 style={{ margin: 0 }}>{t('auth.title')}</h2>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('auth.body')}
        </p>

        {!cfg ? (
          <Field label={t('auth.server')} hint={t('auth.serverHint')}>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder={t('sync.baseUrlPlaceholder')}
              autoComplete="url"
              inputMode="url"
              disabled={busy}
            />
          </Field>
        ) : null}

        {phase === 'probing' ? <p className="tiny" style={{ margin: 0 }}>{t('auth.probing')}</p> : null}

        {phase === 'other' ? (
          <>
            <div className="notice">{t('auth.keyMode')}</div>
            <button type="button" className="btn btn-primary" onClick={onSkip}>
              {skipLabel}
            </button>
          </>
        ) : null}

        {phase === 'signin' ? (
          <div className="stack-s">
            <div ref={host} className="auth-gsi" />
            {busy ? <p className="tiny" style={{ margin: 0 }}>{t('auth.working')}</p> : null}
            {!server ? <p className="tiny" style={{ margin: 0 }}>{t('auth.needServer')}</p> : null}
            {server && !cfg && error ? (
              <p className="tiny" style={{ margin: 0 }}>
                {error}
              </p>
            ) : null}
            {cfg && error ? <div className="notice">{error}</div> : null}
            <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={busy}>
              {skipLabel}
            </button>
          </div>
        ) : null}

        <p className="tiny" style={{ margin: 0 }}>
          {t('auth.localNote')}
        </p>
      </div>
    </div>
  );
}

