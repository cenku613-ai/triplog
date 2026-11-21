#!/usr/bin/env node
/**
 * MCP 進入點的殼：真正伺服的是 vite 打包出來的 mcp/dist/index.mjs。
 * 分開寫是因為 build 產物不入版控，直接將 bin 指過去時，
 * 忘記 build 的場景要能得到一句人話，而不是 ERR_MODULE_NOT_FOUND 堆疊。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'dist', 'index.mjs');

try {
  await import(pathToFileURL(target).href);
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(`[triplog-mcp] 找不到 ${target}\n請先在專案根目錄跑： npm run mcp:build`);
    process.exit(1);
  }
  throw err;
}
