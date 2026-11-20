import { useCallback, useSyncExternalStore } from 'react';
import { zh, type Dict, type Key } from './zh';
import { en } from './en';

export type { Key } from './zh';
export type Lang = 'zh-Hant' | 'en';
export type Vars = Record<string, string | number | undefined | null>;

const LANG_KEY = 'triplog:lang';
const DICTS: Record<Lang, Dict> = { 'zh-Hant': zh, en };

function detect(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch {
    /* 無痕模式可能擋 localStorage，用預設值繼續 */
  }
  if (stored === 'zh-Hant' || stored === 'en') return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language ?? '' : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-Hant' : 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function lang(): Lang {
  return current;
}

export function isLang(v: unknown): v is Lang {
  return v === 'zh-Hant' || v === 'en';
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* 存不進去也只是下次開起來回到自動偵測 */
  }
  applyDocument();
  notify();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** zh 是來源：找不到英文時退回中文，再找不到就回傳鍵名，畫面不會出現 undefined */
export function lookup(key: string): string | undefined {
  const raw = (DICTS[current] as Record<string, string>)[key] ?? (zh as Record<string, string>)[key];
  return raw;
}

export function has(key: string): key is Key {
  return key in zh;
}

const PLURAL = /\{(\w+)\?([^|}]*)\|([^}]*)\}/g;
const VAR = /\{(\w+)\}/g;

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text
    .replace(PLURAL, (_m, name: string, one: string, other: string) => {
      const n = Number(vars[name]);
      return `${Number.isFinite(n) ? n : ''} ${Number.isFinite(n) && n === 1 ? one : other}`.trim();
    })
    .replace(VAR, (_m, name: string) => {
      const v = vars[name];
      return v === undefined || v === null ? '' : String(v);
    });
}

/** 靜態鍵：打錯字 tsc 會直接擋下來 */
export function t(key: Key, vars?: Vars): string {
  return interpolate(lookup(key) ?? key, vars);
}

/** 動態組出来的鍵（weekday.3、cat.food…）走這裡，找不到就退回鍵名本身 */
export function tRaw(key: string, vars?: Vars): string {
  return interpolate(lookup(key) ?? key, vars);
}

/** Intl 用的 locale：金額、百分比、日期都跟隨介面語言 */
export function intlLocale(): string {
  return current === 'en' ? 'en-US' : 'zh-TW';
}

/** 文件層級的東西（<html lang>、標題、描述）跟着語言換 */
export function applyDocument(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  document.title = t('app.title');
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', t('app.description'));
}

export function initI18n(): void {
  applyDocument();
}

export function useI18n(): {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Key, vars?: Vars) => string;
  locale: string;
} {
  const l = useSyncExternalStore(subscribe, lang, lang);
  // t 只在語言換掉時換身分，effect 依賴它才不會每次渲染都重跑
  const translate = useCallback((key: Key, vars?: Vars) => t(key, vars), [l]);
  return {
    lang: l,
    setLang,
    t: translate,
    locale: intlLocale(),
  };
}
