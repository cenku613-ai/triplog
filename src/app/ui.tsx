import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { t } from '../i18n';

/* ------------------------------------------------------------------ theme */

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'triplog:theme';

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

/* ------------------------------------------------------------------ toast */

export interface ToastItem {
  id: number;
  text: string;
  kind: 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}

interface UiApi {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toasts: ToastItem[];
  toast: (
    text: string,
    opts?: { kind?: 'info' | 'error'; actionLabel?: string; onAction?: () => void },
  ) => number;
  dismiss: (id: number) => void;
  ask: (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  pending: { message: string; confirmLabel: string; danger: boolean } | null;
  answer: (ok: boolean) => void;
}

const Ctx = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(
    () => (localStorage.getItem(THEME_KEY) as ThemeMode) ?? 'system',
  );
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(1);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [pending, setPending] = useState<UiApi['pending']>(null);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<UiApi['toast']>(
    (text, opts) => {
      const id = seq.current++;
      setToasts((prev) => [
        ...prev.slice(-2),
        { id, text, kind: opts?.kind ?? 'info', actionLabel: opts?.actionLabel, onAction: opts?.onAction },
      ]);
      window.setTimeout(() => dismiss(id), opts?.actionLabel ? 7000 : 3200);
      return id;
    },
    [dismiss],
  );

  const ask = useCallback<UiApi['ask']>((message, opts) => {
    setPending({
      message,
      confirmLabel: opts?.confirmLabel ?? t('common.confirm'),
      danger: opts?.danger ?? false,
    });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((ok: boolean) => {
    setPending(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const value = useMemo<UiApi>(
    () => ({
      theme,
      setTheme: setThemeState,
      toasts,
      toast,
      dismiss,
      ask,
      pending,
      answer,
    }),
    [theme, toasts, toast, dismiss, ask, pending, answer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
