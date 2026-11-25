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
import { useUi } from '../../app/ui';
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
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useUi();
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
    <div className="auth-page">
      <header className="auth-topbar">
        <a className="auth-brand" href="./" aria-label="TripLog">
          <BrandMark />
          <span>TripLog</span>
        </a>
        <div className="auth-top-actions">
          <button type="button" className="btn btn-sm" onClick={() => setLang(lang === 'en' ? 'zh-Hant' : 'en')}>
            {lang === 'en' ? '繁體' : 'EN'}
          </button>
          <button
            type="button"
            className="btn btn-icon btn-sm"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={t(theme === 'dark' ? 'auth.themeLight' : 'auth.themeDark')}
            title={t(theme === 'dark' ? 'auth.themeLight' : 'auth.themeDark')}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <main className="auth-layout">
        <section className="auth-story" aria-labelledby="auth-story-title">
          <div className="auth-story-copy">
            <span className="auth-kicker">
              <CompassIcon />
              {t('auth.storyBadge')}
            </span>
            <h1 id="auth-story-title">
              {t('auth.storyTitle')}
              <span>{t('auth.storyAccent')}</span>
            </h1>
            <p>{t('auth.storyBody')}</p>
          </div>

          <div className="auth-preview" aria-hidden="true">
            <RouteArt />
            <div className="auth-preview-head">
              <span className="auth-preview-brand"><BrandMark /> TripLog</span>
              <span className="auth-preview-status"><i /> OFFLINE FIRST</span>
            </div>
            <div className="auth-preview-route">
              <span>01</span><i /><span>02</span><i /><span>03</span>
            </div>
            <div className="auth-preview-note">
              <span className="auth-preview-note-icon"><NoteIcon /></span>
              <span>
                <small>{t('auth.previewLabel')}</small>
                <strong>{t('auth.previewNote')}</strong>
              </span>
              <span className="auth-preview-check"><CheckIcon /></span>
            </div>
          </div>

          <div className="auth-features">
            <div><RouteIcon /><strong>{t('auth.featurePlans')}</strong><span>{t('auth.featurePlansBody')}</span></div>
            <div><WalletIcon /><strong>{t('auth.featureMoney')}</strong><span>{t('auth.featureMoneyBody')}</span></div>
            <div><CloudIcon /><strong>{t('auth.featureOffline')}</strong><span>{t('auth.featureOfflineBody')}</span></div>
          </div>
        </section>

        <section className="auth-panel" aria-labelledby="auth-title">
          <div className="auth-card">
            <div className="auth-card-mark"><BrandMark /></div>
            <span className="auth-eyebrow">TRIPLOG ACCOUNT</span>
            <h2 id="auth-title">{t('auth.title')}</h2>
            <p className="auth-card-body">{t('auth.body')}</p>

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
            ) : (
              <div className="auth-server" title={server}>
                <GlobeIcon />
                <span className="grow"><small>{t('auth.server')}</small><strong>{server}</strong></span>
                <CheckIcon />
              </div>
            )}

            {phase === 'probing' ? (
              <p className="auth-status" role="status"><span className="spin" />{t('auth.probing')}</p>
            ) : null}

            {phase === 'other' ? (
              <div className="auth-key-mode">
                <KeyIcon />
                <div><strong>{t('auth.keyModeTitle')}</strong><p>{t('auth.keyMode')}</p></div>
              </div>
            ) : null}

            {phase === 'signin' ? (
              <div className="auth-signin">
                {cfg?.clientId ? (
                  <div className="auth-google-shell">
                    <div ref={host} className="auth-gsi" />
                  </div>
                ) : null}
                {busy ? <p className="auth-status" role="status"><span className="spin" />{t('auth.working')}</p> : null}
                {!server ? <p className="auth-help">{t('auth.needServer')}</p> : null}
                {server && !cfg && error ? <p className="auth-error" role="alert">{error}</p> : null}
                {cfg && error ? <div className="auth-error" role="alert">{error}</div> : null}
                <div className="auth-divider"><span>{t('auth.or')}</span></div>
                <button type="button" className="btn btn-block auth-skip" onClick={onSkip} disabled={busy}>
                  <OfflineIcon />
                  {skipLabel}
                </button>
              </div>
            ) : null}

            {phase === 'other' ? (
              <button type="button" className="btn btn-primary btn-block auth-continue" onClick={onSkip}>
                {skipLabel}
                <ArrowIcon />
              </button>
            ) : null}

            <div className="auth-local-note">
              <ShieldIcon />
              <p>{t('auth.localNote')}</p>
            </div>
          </div>
          <p className="auth-privacy">{t('auth.privacy')}</p>
        </section>
      </main>

      <footer className="auth-footer">{t('auth.footer')}</footer>
    </div>
  );
}

function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="10" fill="var(--brand)" />
      <path d="M16 7.5c-4.4 0-7.5 3.1-7.5 7.3 0 5 7.5 12 7.5 12s7.5-7 7.5-12c0-4.2-3.1-7.3-7.5-7.3Zm0 10a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z" fill="#fff" />
    </svg>
  );
}

function RouteArt() {
  return (
    <svg className="auth-route-art" viewBox="0 0 560 360" fill="none">
      <path d="M-20 88C86 18 142 143 246 74S436 42 590 132M-30 219c111-91 182-17 279-66s214-1 337 67M-10 343c117-71 216-24 306-67S460 206 590 265" stroke="currentColor" strokeWidth="1" />
      <path d="M-20 152c112-69 188 13 279-29s211-15 331 43M24 298c103-49 159-65 235-26s186 33 307-30" stroke="currentColor" strokeWidth="1" />
      <path d="M72 242c55-92 134-13 166-77s-5-90 78-102 87 91 155 54 48-66 91-55" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray="7 10" />
      <circle cx="72" cy="242" r="9" fill="var(--surface)" stroke="var(--accent)" strokeWidth="4" />
      <circle cx="238" cy="165" r="9" fill="var(--surface)" stroke="var(--accent)" strokeWidth="4" />
      <circle cx="316" cy="63" r="9" fill="var(--surface)" stroke="var(--accent)" strokeWidth="4" />
      <circle cx="471" cy="117" r="9" fill="var(--surface)" stroke="var(--accent)" strokeWidth="4" />
      <circle cx="562" cy="62" r="9" fill="var(--surface)" stroke="var(--accent)" strokeWidth="4" />
    </svg>
  );
}

function CompassIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>; }
function GlobeIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18-3-3.4-3-14.6 0-18Z" stroke="currentColor" strokeWidth="1.7"/></svg>; }
function RouteIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.7"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="M8.5 18h3a3 3 0 0 0 0-6h-3a3 3 0 0 1 0-6h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function WalletIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7V6a2 2 0 0 1 2-2h12v4M4 7h15a1 1 0 0 1 1 1v10H4V7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M15 11h5v4h-5a2 2 0 0 1 0-4Z" stroke="currentColor" strokeWidth="1.7"/></svg>; }
function CloudIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9H7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m9 13 2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function NoteIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h14v16H5V4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function KeyIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.7"/><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function OfflineIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4v10a3 3 0 0 0 3 3h10M8 8h10a2 2 0 0 1 2 2v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m3 3 18 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.8 8.1 7 10 4.2-1.9 7-5.5 7-10V6l-7-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ArrowIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function MoonIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/></svg>; }
function SunIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }

