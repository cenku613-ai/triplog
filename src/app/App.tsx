import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { HashRouter, Link, NavLink, Route, Routes, useMatch } from 'react-router-dom';
import { UiProvider, useUi } from './ui';
import { ToastHost, ConfirmHost } from '../components/Feedback';
import { TripsPage } from '../features/trips/TripsPage';
import { TripDetailPage } from '../features/trip/TripDetailPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { ExpenseEditor } from '../features/expenses/ExpenseEditor';
import { AllExpensesPage } from '../features/expenses/AllExpensesPage';
import { useLive } from '../db/live';
import { db } from '../db/db';
import type { Trip } from '../db/types';
import { usePwaUpdate } from './pwa';
import { useI18n } from '../i18n';
import { describeSyncError, loadSyncConfig, syncNow } from '../lib/sync';
import { isSessionToken } from '../lib/tokens';
import { fetchAuthConfig, gateFor, loadAccount, rememberedMode, sameOriginBase } from '../lib/account';
import { LoginGate } from '../features/auth/LoginGate';

/**
 * 分享頁不在 Shell 裡：來按連結的人可能用別人的裝置，不該看到本機別的旅行，
 * 也不該觸發這台裝置的自動同步。它有自己的標頭與語系切換，
 * 所以整包（含表單邏輯）只有走到 /share/ 時才載。
 */
const SharePage = lazy(() => import('../features/share/SharePage').then((m) => ({ default: m.SharePage })));

/**
 * 「一起記的行程」是受邀者那一側的入口，只在有登入憑證時才掛進側欄：
 * 金鑰模式下沒有可比對的身分，列出來只是一個按下去會報錯的選項。
 * 整包跟分享頁一樣是 lazy——用不到的人不必多載共筆的表單邏輯。
 */
const SharedTripsPage = lazy(() => import('../features/share/SharedTripsPage').then((m) => ({ default: m.SharedTripsPage })));

function Shell() {
  const { toast } = useUi();
  const { t } = useI18n();
  const [quick, setQuick] = useState(false);
  const { needRefresh, offlineReady, reload } = usePwaUpdate();
  const [online, setOnline] = useState(navigator.onLine);
  const trips = useLive<Trip[]>(() => db.trips.toArray(), [], []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // 啟動自動同步：一個 session 只跑一次，失敗只輕輕說一聲，不打斷本機記錄
  const autoSynced = useRef(false);
  useEffect(() => {
    const cfg = loadSyncConfig();
    if (!cfg?.auto || autoSynced.current || !navigator.onLine) return;
    autoSynced.current = true;
    syncNow(cfg)
      .then((r) =>
        toast(
          r.pulled.trips || r.pulled.dayItems || r.photosDownloaded
            ? `${t('sync.autoDone')} · ${t('sync.report', {
                pTrips: r.pulled.trips,
                pItems: r.pulled.dayItems,
                pExp: r.pulled.expenses,
                nTrips: r.pushed.trips,
                photos: r.photosDownloaded,
              })}`
            : t('sync.autoDone'),
        ),
      )
      .catch((err) => toast(t('sync.autoFailed', { msg: describeSyncError(err) }), { kind: 'error' }));
  }, [toast, t]);

  const told = useRef({ refresh: false, ready: false });
  useEffect(() => {
    if (needRefresh && !told.current.refresh) {
      told.current.refresh = true;
      toast(t('pwa.updateReady'), { actionLabel: t('pwa.reload'), onAction: reload });
    } else if (offlineReady && !told.current.ready) {
      told.current.ready = true;
      toast(t('pwa.offlineReady'));
    }
  }, [needRefresh, offlineReady, reload, toast, t]);

  // 共筆的入口只在「這台裝置是用 Google 登入的」時出現：金鑰模式沒有可比對的身分
  const shared = loadSyncConfig();
  const nav = [
    { to: '/', label: t('nav.trips'), icon: '🧳', end: true },
    { to: '/expenses', label: t('nav.expenses'), icon: '💸', end: false },
    ...(shared && isSessionToken(shared.apiKey)
      ? [{ to: '/shared', label: t('invite.mineTitle'), icon: '🤝', end: false }]
      : []),
    { to: '/settings', label: t('nav.settings'), icon: '⚙', end: false },
  ];

  // 桌面快速鍵
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        setQuick(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fab = (
    <button
      className="fab"
      onClick={() => setQuick(true)}
      aria-label={t('expense.quickAria')}
      title={t('expense.quickHint')}
    >
      ＋
    </button>
  );

  return (
    <div className="shell">
      <nav className="sidenav" aria-label={t('nav.main')}>
        <div className="side-brand">
          <Logo />
          <span>TripLog</span>
        </div>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <span aria-hidden="true">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
        <div style={{ marginTop: 'var(--sp-4)' }}>{fab}</div>
        <div className="side-foot tiny">
          {online ? t('net.offlineCanRecord') : t('net.offlineSaving')}
          <br />
          {t('net.shortcutBefore')} <kbd>n</kbd> {t('net.shortcutAfter')}
        </div>
      </nav>

      <header className="topbar">
        <Link to="/" className="brand" aria-label={t('nav.backToList')}>
          <Logo />
          <span className="title">TripLog</span>
        </Link>
        {!online ? <span className="badge">{t('net.offline')}</span> : null}
        <div className="actions">
          {/* 手機沒有側欄，共筆的入口就掛在標頭上；金鑰模式下這顆不出現 */}
          {shared && isSessionToken(shared.apiKey) ? (
            <Link to="/shared" className="btn btn-sm">
              {t('invite.mineTitle')}
            </Link>
          ) : null}
          <button className="btn btn-sm" onClick={() => setQuick(true)}>
            {t('expense.quickBtn')}
          </button>
        </div>
      </header>

      <main className="page wide">
        <Routes>
          <Route path="/" element={<TripsPage />} />
          <Route path="/t/:tripId" element={<TripDetailPage />} />
          <Route path="/expenses" element={<AllExpensesPage trips={trips} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/shared"
            element={
              <Suspense fallback={<div className='page' />}>
                <SharedTripsPage />
              </Suspense>
            }
          />
          <Route
            path="/quick-expense"
            element={<TripsLaunch onReady={() => setQuick(true)} />}
          />
          <Route
            path="*"
            element={
              <div className="empty card">
                <h3>{t('nav.notFound')}</h3>
                <Link className="btn btn-primary" to="/">
                  {t('nav.backToList')}
                </Link>
              </div>
            }
          />
        </Routes>
      </main>

      <nav className="tabbar" aria-label={t('nav.main')}>
        <NavLink to="/" end>
          <span aria-hidden="true">🧳</span>
          {t('nav.trips')}
        </NavLink>
        <span className="fab-host">{fab}</span>
        <NavLink to="/settings">
          <span aria-hidden="true">⚙</span>
          {t('nav.settings')}
        </NavLink>
      </nav>

      {quick ? <ExpenseEditor trips={trips} onClose={() => setQuick(false)} /> : null}

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}

function TripsLaunch({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    onReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <TripsPage />;
}

function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--brand)" />
      <path
        d="M12 5.6c-2.4 0-4.3 1.9-4.3 4.3 0 3 4.3 8.1 4.3 8.1s4.3-5.1 4.3-8.1c0-2.4-1.9-4.3-4.3-4.3Zm0 6a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z"
        fill="#fff"
      />
    </svg>
  );
}

export function App() {
  // useMatch 要在 Router 裡面跑，所以分流交給 RouteGate
  return (
    <HashRouter>
      <UiProvider>
        <RouteGate />
      </UiProvider>
    </HashRouter>
  );
}

function RouteGate() {
  const share = useMatch('/share/:token');
  if (share?.params.token) {
    return (
      <Suspense fallback={<div className="page" />}>
        <SharePage token={share.params.token} />
      </Suspense>
    );
  }
  // 分享頁刻意排在登入閘門之前：開連結來的同行者可能用別人的手機，
  // 那台裝置登沒登入跟他要記的這一筆支出沒有關係。
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

/**
 * 帳號模式的閘門：只擋「這台裝置沒有有效 session、而伺服器只認帳號」這一種情況。
 *
 * 判斷順序是「本機有沒有憑證 → 這台部署是不是帳號模式」。模式先問本機記過的值，
 * 沒記過（或記的是舊的金鑰模式）時補打一次公開的 /api/auth/config：位址取自已存的同步
 * 設定，沒有就退回同一個 origin（正式機是 app 與 API 同站，新裝置不該為了看到登入鈕
 * 而先去貼金鑰）。金鑰模式改成帳號模式部署時，老裝置因此不會靜靜地一直 401。
 */
function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [account] = useState(() => loadAccount());
  const [mode, setMode] = useState(() => rememberedMode());
  const [skipped, setSkipped] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    if (account || mode === 'account' || !navigator.onLine) return;
    const server = loadSyncConfig()?.baseUrl ?? sameOriginBase();
    if (!server) return;
    let cancelled = false;
    fetchAuthConfig(server)
      .then((c) => !cancelled && setMode(c.mode))
      .catch(() => {
        /* 問不到就当沒這回事：本機記錄照用，同步失敗自有 toast 講 */
      });
    return () => {
      cancelled = true;
    };
  }, [account, mode]);

  const gate = gateFor(mode, account, online);
  if (gate === 'none' || skipped) return <>{children}</>;
  return (
    <LoginGate
      onSkip={() => setSkipped(true)}
      skipLabel={t(gate === 'offline' ? 'auth.skipOffline' : 'auth.skip')}
    />
  );
}
