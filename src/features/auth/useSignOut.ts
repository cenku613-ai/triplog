/**
 * 「登出」的單一實作：設定頁那張帳號卡與頂部導覽都按這一支。
 *
 * 為什麼要抽出來：登出的收尾有三個步驟（退掉本機憑證、記住「這是帳號模式」、重新載入），
 * 少做任何一個都會留下半死不活的狀態——憑證還在、庫裡資料還是上一個人的。
 * 兩顆按鈕長在不同地方，但絕對不該各自實作一遍再慢慢分岔。
 *
 * 為什麼一定要 reload：本機庫的名字是 `triplog-<uid>`，Dexie 連線與所有 `useLive` 訂閱
 * 都還指向上一個帳號的庫；還在飛的請求回來時會寫進那個庫。換庫不是靠 state 就能扭轉的事。
 */
import { useCallback, useState } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { finishLogout, loadAccount, logout, rememberMode } from '../../lib/account';

export type SignOut = {
  /** true ＝正在登出，按鈕該停用，免得連按兩次跑出兩次 reload */
  busy: boolean;
  signOut: () => Promise<void>;
};

export function useSignOut(): SignOut {
  const { ask } = useUi();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    const account = loadAccount();
    if (!account || busy) return;
    const ok = await ask(t('auth.logoutQ'), { confirmLabel: t('auth.logout'), danger: true });
    if (!ok) return;
    setBusy(true);
    // 伺服器那邊退不掉也照樣脫離：斷線時若堅持要 200 才清本機，這台裝置會一直掛著別人的憑證。
    // 那條 session 之後仍可在「設定 → 帳號 → 登入紀錄」收掉，或由伺服器端輪換處理。
    await logout(account).catch(() => {
      /* account.ts 已經吞掉離線錯誤，這裡只是不讓任何意外擋住收尾 */
    });
    await finishLogout(account);
    // 記下「這個位址是帳號模式」：否則重載後又去探問一次，還以為自己該顯示金鑰登入
    rememberMode('account');
    window.location.reload();
  }, [ask, t, busy]);

  return { busy, signOut };
}
