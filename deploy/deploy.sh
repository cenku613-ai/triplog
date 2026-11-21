#!/usr/bin/env bash
# TripLog 一鍵部署到 VPS（Docker）
#
#   從工作機推送：   SSH_TARGET=opc@203.0.113.10 bash deploy/deploy.sh
#   在 VPS 上執行：   LOCAL=1 bash deploy/deploy.sh
#
# 可用環境變數（也可以直接寫進專案根的 .env）：
#   SSH_TARGET        使用者@位址（必要，除非 LOCAL=1）
#   APP_DIR           VPS 上的專案目錄。預設 triplog 是相對路徑，落在該使用者家目錄，
#                     不需要 sudo；想放 /opt/triplog 請自己先建目錄並給寫入權限
#   COMPOSE           docker compose 指令；需要權限時填 "sudo docker compose"
#   TRIPLOG_DOMAIN    有值時啟動 Caddy（HTTPS）
#   DUCKDNS_SUBDOMAIN 與 TRIPLOG_DOMAIN 一起設定時，連 DuckDNS IP 更新容器一起啟動
#   DUCKDNS_TOKEN     DuckDNS 的 token
#
# 同步／agent API（選裝，要開就把金鑰寫進專案根的 .env，它會跟著同步過去）：
#   TRIPLOG_API_KEY   有值時才啟動 api 容器與 /api 反代；寫入金鑰，等於整個資料庫的密碼
#   TRIPLOG_READ_KEY  只讀金鑰，給只想看資料的 agent 用
#   TRIPLOG_KEEP      基準檔保留幾份歷史快照（預設 20）
#   TRIPLOG_ALLOWED_ORIGIN  只讓這個來源跨網讀 API（一般填 app 自己的網域）
#
# 金鑰一律走 .env，不透過指令列傳到遠端——寫在 ssh 參數裡會讓同機其他使用者用 ps 就看到。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 讀 .env：只填還沒設定的變數（指令列給的優先），且不執行裡面的內容
load_env() {
  local f="$REPO_DIR/.env" line key val
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < "$f"
}
load_env

SSH_TARGET="${SSH_TARGET:-}"
APP_DIR="${APP_DIR:-triplog}"
COMPOSE="${COMPOSE:-docker compose}"
LOCAL="${LOCAL:-0}"

# 由 TRIPLOG_DOMAIN / DUCKDNS_SUBDOMAIN 決定要掛哪些 compose 檔案與 profile
compose_args() {
  local args="-f docker-compose.yml"
  if [[ -n "${TRIPLOG_DOMAIN:-}" ]]; then
    args="$args --profile tls"
    if [[ -n "${DUCKDNS_SUBDOMAIN:-}" ]]; then
      args="$args -f deploy/compose.duckdns.yml"
    fi
  fi
  # 同步／agent API 是選裝的：沒有寫入金鑰就完全不啟動，靜態站跟以前一模一樣
  if [[ -n "${TRIPLOG_API_KEY:-}" ]]; then
    if [[ -z "${TRIPLOG_DOMAIN:-}" ]]; then
      # API 容器不綁 port，公網只能經 Caddy 的 443 進來；沒有 Caddy 時開了也沒人連得到
      echo "提醒：設了 TRIPLOG_API_KEY 但沒有 TRIPLOG_DOMAIN，這次不啟動同步 API（它只掛在 Caddy 後面）" >&2
    else
      args="$args -f deploy/compose.api.yml"
    fi
  fi
  printf '%s' "$args"
}

# ---- 在 VPS 上實際建置啟動 ----
if [[ "$LOCAL" == "1" ]]; then
  cd "$REPO_DIR"
  ARGS="$(compose_args)"

  # nginx 設定先驗一次，語法錯誤就不要把站點換掉
  echo "==> 建置映像"
  # shellcheck disable=SC2086
  $COMPOSE $ARGS build

  echo "==> 啟動 $ARGS"
  # shellcheck disable=SC2086
  $COMPOSE $ARGS up -d
  # shellcheck disable=SC2086
  $COMPOSE $ARGS ps

  echo
  if [[ -n "${TRIPLOG_DOMAIN:-}" ]]; then
    echo "完成：https://${TRIPLOG_DOMAIN}"
    echo "憑證檢查： curl -sI https://${TRIPLOG_DOMAIN}/ | head -5"
    echo "Caddy 簽憑證需要幾秒到幾分鐘，失敗會自動重試；看日誌： $COMPOSE $ARGS logs --tail=50 caddy"
    if [[ "${ARGS}" == *compose.api.yml* ]]; then
      # 只驗兩件事：API 活著（200）與沒金鑰真的進不去（401）。金鑰本身不進任何指令或日誌
      echo "==> 檢查同步 API"
      sleep 5
      if command -v curl >/dev/null 2>&1; then
        health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${TRIPLOG_DOMAIN}/api/health" || echo 000)"
        anon="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${TRIPLOG_DOMAIN}/api/base" || echo 000)"
        [[ "$health" == "200" ]] && echo "   /api/health → 200（agent 與跨裝置同步可用）" || echo "   /api/health → ${health}：憑證可能還在簽，稍後再 curl 一次；查日誌 $COMPOSE logs --tail=50 triplog-api"
        [[ "$anon" == "401" ]] && echo "   未帶金鑰 /api/base → 401（外部讀不到資料）" || echo "   未帶金鑰 /api/base → ${anon}，預期 401，請檢查 TRIPLOG_API_KEY 設定"
      else
        echo "   這台機器沒有 curl，跳過檢查：改從工作機跑 curl https://${TRIPLOG_DOMAIN}/api/health"
      fi
    fi
  else
    echo "完成：http://${TRIPLOG_BIND:-0.0.0.0}:${TRIPLOG_PORT:-8080}（TRIPLOG_BIND=127.0.0.1 代表只有本機可達，需搭配 Caddy）"
    echo "注意：HTTP 之下 Service Worker 不會註冊、PWA 也裝不了。要完整 PWA 請設 TRIPLOG_DOMAIN。"
  fi
  exit 0
fi

# ---- 工作機端：同步 + 觸發遠端 ----
if [[ -z "$SSH_TARGET" ]]; then
  echo "用法：SSH_TARGET=使用者@IP bash deploy/deploy.sh" >&2
  echo "  （或在 VPS 上：LOCAL=1 bash deploy/deploy.sh）" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.env" && -n "${TRIPLOG_DOMAIN:-}" ]]; then
  echo "提醒：專案根目錄沒有 .env，這次只靠環境變數帶設定。" >&2
fi

echo "==> 同步 $REPO_DIR → $SSH_TARGET:$APP_DIR"
ssh "$SSH_TARGET" "mkdir -p $APP_DIR"

TAR_EXCLUDES="--exclude=.git --exclude=node_modules --exclude=dist --exclude=.vite --exclude=deploy/certs"

if command -v rsync >/dev/null 2>&1; then
  # .env 一起推上去（VPS 上的 compose 需要它）；.git/node_modules/dist 在映像內重建，不同步
  rsync -az --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude .vite \
    --exclude deploy/certs \
    "$REPO_DIR/" "$SSH_TARGET:$APP_DIR/"
else
  # Windows/Git Bash 通常沒有 rsync：改用 tar 透過 ssh pipe，先解到暫存目錄再切換，
  # 中途失敗不會把線上目錄切成一半
  echo "   （本機沒有 rsync，改用 tar-over-ssh）"
  TMP_DIR="$APP_DIR.tmp"
  ssh "$SSH_TARGET" "rm -rf $TMP_DIR && mkdir -p $TMP_DIR"
  tar -C "$REPO_DIR" $TAR_EXCLUDES -czf - . | ssh "$SSH_TARGET" "tar -xzf - -C $TMP_DIR"
  ssh "$SSH_TARGET" "rm -rf $APP_DIR.old; if [ -d $APP_DIR ]; then mv $APP_DIR $APP_DIR.old; fi; mv $TMP_DIR $APP_DIR"
fi

# ---- HTTPS 需要先確認網域名稱已解析到這台 VPS，否則 Let's Encrypt 簽不出憑證 ----
if [[ -n "${TRIPLOG_DOMAIN:-}" ]]; then
  echo "==> 檢查 DNS：$TRIPLOG_DOMAIN"
  RESOLVED=""
  for _ in 1 2 3 4 5 6; do
    RESOLVED="$(ssh "$SSH_TARGET" "getent hosts ${TRIPLOG_DOMAIN} | awk '{print \$1; exit}'" 2>/dev/null || true)"
    [[ -n "$RESOLVED" ]] && break
    echo "   尚未解析，15 秒後重試（DuckDNS 更新容器啟動後約 1 分鐘會寫入）..."
    sleep 15
  done
  if [[ -z "$RESOLVED" ]]; then
    echo "   無法解析 $TRIPLOG_DOMAIN。請確認 DuckDNS 子域名與 token 正確，" >&2
    echo "   且 VPS 能對外連線。Caddy 仍會啟動並在背後重試簽憑證。" >&2
  else
    echo "   $TRIPLOG_DOMAIN → $RESOLVED"
    echo "   請確認這個 IP 就是你的 VPS 公網 IP"
    echo "   Caddy 用 TLS-ALPN-01 簽憑證：驗證走 443 本身，不需要開 80 port"
    echo "   （Oracle 要在 VCN 安全清單開放 443，不是只在作業系統開防火牆；80 保持關閉）"
  fi
fi

echo "==> 遠端建置並啟動"
REMOTE_ENV="LOCAL=1 COMPOSE=$(printf '%q' "$COMPOSE")"
for var in TRIPLOG_DOMAIN TRIPLOG_PORT DUCKDNS_SUBDOMAIN DUCKDNS_TOKEN; do
  val="${!var:-}"
  [[ -n "$val" ]] && REMOTE_ENV="$REMOTE_ENV $var=$(printf '%q' "$val")"
done
ssh -t "$SSH_TARGET" "cd $APP_DIR && $REMOTE_ENV bash deploy/deploy.sh"
