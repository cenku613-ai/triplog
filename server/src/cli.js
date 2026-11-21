/**
 * 伺服器端的救援指令（SSH 用，不開任何 HTTP 入口）。
 *
 * 為什麼需要它：主金鑰輪換之後，資料庫裡那把雜湊就是唯一可信的主金鑰，`.env` 那把當場失效。
 * 萬一你把新鑰弄丟（它只顯示一次），或換了手機又忘了配對，就必須有一條「不靠舊鑰也能重回門內」
 * 的路。這條路刻意只能從機器本身走——拿到 HTTP 端點就等于拿到發照權，那是我們不願意的。
 *
 * 在 VPS 上這樣跑（容器不用停，但要確認沒有別人同時在改金鑰）：
 *
 *   cd ~/triplog
 *   docker compose -f docker-compose.yml -f deploy/compose.api.yml exec triplog-api \
 *     node server/src/cli.js status
 *
 *   # 把輪換鎖解掉，讓 .env 裡那把重新可用：
 *   ... node server/src/cli.js master-reset --yes
 *   # 或直接指定一把（例：把 .env 那把塞回去）：
 *   ... node server/src/cli.js master-set <金鑰> --yes
 *
 * 這裡只印 hint，永遠不印完整金鑰；`master-set` 的參數會留在 shell 歷史裡，
 * 用完記得 `history -c`，或改用 `master-set -` 從標準輸入讀。
 */
import { openStore } from './store.js';
import { hashSecret, looksLikeMasterKey, masterHint } from './keys.js';

const DATA_DIR = process.env.TRIPLOG_DATA_DIR ?? '/data';
const flags = process.argv.slice(2);
// --yes 可以出現在任何位置：先把它抽掉，剩下的才是指令與參數
const confirmed = flags.includes('--yes');
const [cmd, arg] = flags.filter((a) => a !== '--yes');

function out(...lines) {
  console.log(lines.join('\n'));
}

function die(msg) {
  console.error(`[triplog-cli] ${msg}`);
  process.exit(1);
}

const store = openStore(DATA_DIR);

/** 從標準輸入讀一把，避免金鑰進到指令列與 shell 歷史 */
async function readSecret() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const live = (rows) => rows.filter((r) => !r.revokedAt && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()));

if (!cmd || cmd === 'help' || cmd === '--help') {
  out(
    '用法：node server/src/cli.js <status|master-reset|master-set> [參數] --yes',
    '  status              目前金鑰與憑證的狀態（只印 hint，不印完整值）',
    '  master-reset        解掉輪換鎖，讓 .env 的 TRIPLOG_API_KEY 重新被接受',
    '  master-set <鑰>     直接指定主金鑰（給 "-" 就從標準輸入讀，較安全）',
  );
  process.exit(0);
}

if (cmd === 'status') {
  const info = store.masterInfo();
  const tokens = store.listApiTokens();
  const pairings = store.listPairings();
  out(
    `主金鑰：${info ? `已輪換（${info.setAt ?? '時間不明'}）hint ${info.hint}` : `尚未輪換，現在吃 .env 的 TRIPLOG_API_KEY`}`,
    `.env 那把：${info ? '已失效（資料庫為準）' : '有效'}；hint ${masterHint((process.env.TRIPLOG_API_KEY ?? '').trim() || '(未設定)')}`,
    `簽發過的憑證：${tokens.length} 把，其中生效中 ${live(tokens).length} 把（可寫 ${live(tokens).filter((r) => r.scope === 'write').length} 把）`,
    `配對碼：${pairings.length} 組，未用且未過期 ${live(pairings.filter((p) => !p.usedAt)).length} 組`,
    `分享連結：${store.listShares({ uid: null }).length} 條`,
    `帳號：${store.countUsers()} 個（登入紀錄只列最近 100 條，撤銷要從 app 裡按）`,
  );
  process.exit(0);
}

if (cmd === 'master-reset') {
  if (!confirmed) die('這是改變登入鑰的操作，加 --yes 表示你確實要解掉輪換鎖');
  const info = store.masterInfo();
  if (!info) die('目前沒有輪換鎖（主金鑰還是 .env 那把），不需要解');
  store.clearMasterHash();
  out('已解掉輪換鎖：.env 裡的 TRIPLOG_API_KEY 重新被接受。簽發過的憑證不受影響。');
  out('容器若還在跑，下一句請求就會生效，不需要重啟。');
  process.exit(0);
}

if (cmd === 'master-set') {
  if (!arg) die('要給一把金鑰，或給 "-" 從標準輸入讀');
  if (!confirmed) die('這是改變登入鑰的操作，加 --yes 確認');
  const key = arg === '-' ? await readSecret() : String(arg).trim();
  if (key.length < 24) die('金鑰太短（至少 24 字元）');
  if (!looksLikeMasterKey(key)) {
    out(`提醒：這把不是 tlm_ 開頭的輪換鑰格式（hint ${masterHint(key)}），照樣接受，但請記得名稱由你自己對照。`);
  }
  store.setMasterHash(hashSecret(key), masterHint(key));
  out(`已把主金鑰設成 hint ${masterHint(key)} 的那把；舊的（含 .env 那把）立刻失效。`);
  out('別忘了在每台裝置重新貼上或在 MCP 設定裡換掉，否則它們會開始收到 401。');
  process.exit(0);
}

die(`不認識的指令：${cmd}（看：node server/src/cli.js help）`);
