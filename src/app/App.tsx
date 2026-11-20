import { useEffect, useRef, useState } from 'react';
import { HashRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
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

  const nav = [
    { to: '/', label: t('nav.trips'), icon: '🧳', end: true },
    { to: '/expenses', label: t('nav.expenses'), icon: '💸', end: false },
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
  return (
    <HashRouter>
      <UiProvider>
        <Shell />
      </UiProvider>
    </HashRouter>
  );
}
