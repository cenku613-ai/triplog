import { defineConfig } from 'vite';

/**
 * 把 mcp/server.ts 打成單一檔的 Node CLI（mcp/dist/index.mjs）。
 *
 * 用 vite 而不是另外一套 tsc：repo 裡已經有 vite／esbuild，後端不想再多一套編譯鏈。
 * - ssr: 以 Node 為目標，不產生瀏覽器程式碼
 * - external node:*：內建模組保持原樣
 * - noExternal SDK：把 @modelcontextprotocol/sdk 一起打進單一檔，
 *   這樣 npm 全域安裝時就算依賴解析走樣也能跑
 */
export default defineConfig({
  build: {
    ssr: 'mcp/server.ts',
    outDir: 'mcp/dist',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: (id) => id.startsWith('node:'),
      output: {
        format: 'es',
        entryFileNames: 'index.mjs',
      },
    },
  },
  ssr: {
    noExternal: ['@modelcontextprotocol/sdk'],
  },
});
