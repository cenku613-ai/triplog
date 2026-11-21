import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootstrap, openAccountDb } from './db/db';
import { loadAccount } from './lib/account';
import { initI18n, t } from './i18n';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

initI18n();

async function start() {
  try {
    // 先決定「這台裝置現在是誰在用」，再補內建分類：順序反過來會讓分類落到舊庫裡。
    // 分庫看的是「上次登入的是誰」而不是「那條憑證還有效嗎」——憑證過期只是要重新登入，
    // 資料仍然是那個人的，不該在開機這一刻換成別人（或舊庫）。
    const account = loadAccount();
    await openAccountDb(account?.user.id ?? null);
    await bootstrap();
  } catch (err) {
    console.error('[triplog] 初始化資料庫失敗', err);
    document.getElementById('root')!.innerHTML =
      `<div style="padding:24px;font-family:system-ui"><h1>${t('boot.failed')}</h1><p>${t('boot.failedBody')}</p></div>`;
    return;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
