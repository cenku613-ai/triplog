import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa';
import { en } from './src/i18n/en';
import { zh } from './src/i18n/zh';

/**
 * 安裝後的主畫面名稱與說明走 manifest 本地化規格（Chrome / Edge 148+ 讀 *_localized，
 * 舊瀏覽器退回預設的繁中字串）。這裡直接抓兩本字典，避免和 App 標題走鐘。
 */
const manifest = {
  id: './',
  name: zh['app.title'],
  short_name: 'TripLog',
  description: zh['app.description'],
  name_localized: { 'zh-Hant': zh['app.title'], en: en['app.title'] },
  description_localized: { 'zh-Hant': zh['app.description'], en: en['app.description'] },
  lang: 'zh-Hant',
  dir: 'ltr',
  display: 'standalone',
  orientation: 'any',
  start_url: './',
  scope: './',
  theme_color: '#0f766e',
  background_color: '#f6f7f9',
  categories: ['travel', 'finance', 'productivity'],
  icons: [
    { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    {
      src: 'maskable-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
  shortcuts: [
    {
      name: '記一筆支出',
      short_name: '記支出',
      url: './#/quick-expense',
      description: '立即新增一筆旅行支出',
      name_localized: { 'zh-Hant': '記一筆支出', en: 'Log an expense' },
      description_localized: { 'zh-Hant': '立即新增一筆旅行支出', en: 'Add a trip expense right away' },
    },
    {
      name: '新旅行',
      short_name: '新旅行',
      url: './#/?new=1',
      description: '建立一筆新的旅行',
      name_localized: { 'zh-Hant': '新旅行', en: 'New trip' },
      description_localized: { 'zh-Hant': '建立一筆新的旅行', en: 'Start a new trip' },
    },
  ],
} as Partial<ManifestOptions>;

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'documents',
              networkTimeoutSeconds: 3,
            },
          },
          {
            // 地圖瓦片：同一區塊進出不該重複抓，30 天內直接給快取的（離線也能看底圖）
            urlPattern: ({ url, request }) =>
              url.hostname === 'tile.openstreetmap.org' && request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2019',
    sourcemap: false,
  },
  server: {
    host: true,
    port: 5173,
    /**
     * 分享頁打的是「跟頁面同來源」的 /api/*（正式環境由 Caddy 反代到後端），
     * 本機開發時把同一條路徑轉給 `npm run server:start`，
     * 否則在 5173 開分享連結只會拿到 vite 的 index.html。
     */
    proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: false } },
  },
});
