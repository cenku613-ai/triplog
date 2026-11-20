import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootstrap } from './db/db';
import { initI18n, t } from './i18n';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

initI18n();

async function start() {
  try {
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
