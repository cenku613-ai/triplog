import { useEffect, useRef, useState } from 'react';
import Dexie from 'dexie';

type Listener = () => void;

const listeners = new Set<Listener>();
let hookInstalled = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Dexie 在交易提交後會發出 storagemutated（實測存在於 Dexie.on，不在 db.on）。
 * 這裡 debounce 30ms，避免同一個操作觸發多次重查。
 */
function installHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  try {
    Dexie.on('storagemutated', () => schedule());
  } catch (err) {
    console.warn('[triplog] 無法監聽資料庫變動，畫面需手動重新整理', err);
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    listeners.forEach((l) => l());
  }, 30);
}

export function invalidate(): void {
  schedule();
}

/** deps 變動或任何表被寫入後重跑 `fn`，回傳查詢結果 */
export function useLive<T>(fn: () => T | Promise<T>, deps: readonly unknown[], initial: T): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [data, setData] = useState<T>(initial);

  useEffect(() => {
    installHook();
    let alive = true;
    const run = async () => {
      try {
        const value = await fnRef.current();
        if (alive) setData(value);
      } catch (err) {
        if (alive) console.error('[useLive] 查詢失敗', err);
      }
    };
    void run();
    const listener = () => void run();
    listeners.add(listener);
    return () => {
      alive = false;
      listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return data;
}
