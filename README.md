# TripLog 旅行記錄

離線優先的旅行行程與支出記錄 PWA。手機、平板、電腦都能安裝使用，所有資料存在裝置本機（IndexedDB）；雲端預設只負責送靜態檔案，要不要讓資料離開裝置由你決定（見「選裝：同步與 AI agent API」）。

## 功能

- **旅行管理**：建立、編輯、歸檔、刪除；起訖日期、主幣別、預算、代表色
- **雙語介面**：繁中／英文全介面切換，跟隨瀏覽器語系為預設，設定裡可手動鎖定；安裝後的應用程式名稱與說明也隨語言本地化
- **行程記錄**：依天數排時間軸，可設定類型（交通／住宿／餐飲／景點／活動）、起訖時間、地點、備註與手動排序
- **勾選清單**：每趟旅行可記行李、票券與待辦，支援完成狀態、手動排序與刪除同步
- **地點搜尋**：打關鍵字即時查 OpenStreetMap Nominatim，選了就回填座標與地名；離線時明確告知不可用，不假裝成功
- **地圖**：Leaflet + OSM 瓦片，行程項的座標依「第幾天」著色；右側按天分組的地點清單可跳點與直接編輯，表單裡另有點擊選點與「用我的位置」
- **行程照片**：裝置相機／選檔與 Wikimedia Commons 兩種來源，自動縮到 1600px 主圖＋400px 縮圖存進 IndexedDB，每趟上限 60 張；Commons 來源會一併保存作者與授權，時間軸上直接顯示縮圖與大圖檢視
- **隨行人員**：旅行可記多名同行者，支出標記「誰付的」，統計頁看得到各人代墊合計（不做分帳清算）
- **支出記錄**：一鍵記支出、可關聯到某個行程項、多幣別手動匯率、付款人與備註
- **統計**：預算進度、每日長條圖、分類占比環形圖、原始幣別合計、金額最大的幾筆
- **列印／PDF**：把一趟旅行輸出成 A4 列印頁——封面、每日時間軸、支出明細與圖表、照片牆、含路線點的地圖截圖，各區可單獨開關；先在 app 內預覽，再按文件上的「列印／儲存 PDF」由瀏覽器另存，不裝任何套件
- **跨裝置同步**（選裝）：自架的零依賴 API 當基準檔，手機記的錢筆電看得到；採「兩端各自推送、伺服器合併」，同一筆以 `updatedAt` 較新者勝，**刪掉的也會同步**（本機留下刪除記號，跟著每次推送走，另一端套用時真的清掉，見「設計決策」）沒有帳號系統，只靠金鑰——但新裝置不必抄長金鑰：在已同步好的裝置上產生一組 8 個字的一次性配對碼，這邊打進去就換到屬於自己的憑證；貼主金鑰那條路也不用事後自己跑去簽——第一次「測試連線」或「立即同步」成功，app 就順手幫這台裝置簽一把可讀可寫、90 天有效的憑證並改用之
- **AI agent 寫入**（選裝）：透過 MCP 讓 agent 讀行程、記支出、建旅行、操作勾選清單；18 個工具、可切唯讀，只能刪單筆勾選事項，不能刪旅行／行程／支出。要交給 agent 的金鑰可以在 app 裡簽發，還能從 app 輪換主金鑰、用 8 個字的配對碼讓新裝置免貼長金鑰（見「選裝：開啟同步與 AI agent API」末段），不必把主金鑰交出去
- **分享給同行者**（選裝）：每一趟旅行可產生一條只需要連結、不需要金鑰的分享網址。拿到網址的人看得到這一趟的行程與支出（**看不到照片，也看不到別的旅行**），也能幫你補一筆支出或加一個行程；寫進去的內容落在伺服器的基準檔，你下次同步就收得到，之後照樣能改能刪。連結可設效期（預設 90 天，最長 1 年，或不設限），隨時能作廢，作廢只收連結、不動已記錄的資料
- **備份**：全量 JSON 匯出／匯入（合併或覆寫），照片以 base64 一起帶走，還原後 Blob 完整讀回
- **PWA**：可安裝、完全離線可用、深色／淺色／跟隨系統主題、手機底部導覽列與桌面側欄自動切換；看過的地圖瓦片快取 30 天，離線仍能看底圖

## 開發

```bash
npm install
npm run dev         # 開發伺服器，http://localhost:5173
npm test            # 105 個單元測試（日期、金額換算、統計、備份與還原、合併規則、照片往來、座標與地圖邊界、雙語字典與分類標籤、PDF 文件、分享連結、API token、配對碼、主金鑰輪換與本裝置憑證自動簽發）
npm run typecheck   # TypeScript 檢查
npm run check:zh    # 繁中介面的字級檢查（抓簡體字，可 --fix）
npm run server:test # 後端 API 冒煙測試（75 項，真的起一個 SQLite）
npm run mcp:test    # 打包 MCP 並用 JSON-RPC 打進去（26 項）
npm run verify      # check:zh + typecheck + 單元測試 + 後端冒煙 + MCP 冒煙
npm run icons       # 產生 PWA 圖示（純 Node，無外部依賴）
npm run build       # icons → typecheck → vite build，輸出 dist/
npm run preview     # 以本地靜態伺服器預覽 dist/，PWA 與離線行為要在這裡測
```

## 安裝與離線驗證

1. `npm run build && npm run preview`，用瀏覽器開啟 preview 網址
2. 桌面版 Chrome/Edge：位址列右側的安裝圖示，或「設定 → 安裝與離線 → 安裝 TripLog」
3. Android Chrome：選單 →「新增至主螢幕」
4. iOS Safari：共享 →「新增至主畫面」（iOS 必須手動安裝）
5. 離線驗證：先開過一次網站，關閉網路後重新開啟，仍能進入並正常寫入

> iOS 若**沒有**安裝為主畫面應用程式，Safari 可能在 7 天未開啟後清掉本站的儲存空間。長期使用建議安裝，並定期匯出備份。

## 資料存放位置

| 內容 | 位置 |
| --- | --- |
| 旅行、行程、支出、分類、匯率 | IndexedDB，資料庫名稱 `triplog` |
| 行程照片（主圖與縮圖 Blob） | 同一個 IndexedDB 的 `photos` store（v2 起） |
| 主題偏好、語言、最後使用的旅行／分類／主幣別 | localStorage（`triplog:*`） |
| 看過的地圖瓦片 | Cache Storage `osm-tiles`（500 筆／30 天） |
| 同步位址與金鑰（有開同步時） | localStorage `triplog:sync`，只在本機，不會寫進備份檔 |

清除瀏覽器網站資料或「設定 → 清除所有資料」會不可逆地移除記錄，請先匯出備份。

## 設計決策

- **行程與支出共用同一條時間軸**：支出可掛在某個行程項下，刪行程項時支出只解除關聯、不會被連帶刪除（錢是重要資料）
- **金額永遠以記錄當下的原始幣別保存**，另存 `rateToBase` 與算好的 `baseAmount`；統計一律用主幣別，避免事後匯率變動影響歷史數字
- **資料一律留本機，但對外請求有四處**：地點搜尋打 Nominatim、底圖打 OSM 瓦片、Commons 選圖打 Wikimedia，這三個只送查詢字串，不帶任何旅行資料、名稱或座標紀錄；第四處是自己開通的同步 API——沒填金鑰時它完全不存在，填了也只有「同步、列印、agent 寫入」會用到。離線或擋掉時功能降級但 app 仍可用，匯率則完全由使用者輸入並記憶（無記憶值就留白強制輸入，避免偷偷用 1:1 記錯錢）
- **Nominatim 用得克制**：同一時間只讓一個請求出去、間隔 1.2 秒、結果快取 24 小時，並帶 `accept-language`，符合其使用政策
- **地圖用 circleMarker 而非預設圖示**：Leaflet 預設圖示的圖片路徑在打包後常斷掉，圓點自帶顏色還能順帶表達「第幾天」
- **PDF 用列印而不是 PDF 函式庫**：`src/lib/pdf.ts` 把一趟組成一頁自包含的 A4 HTML（含 inline SVG 圖表、地圖截圖與縮圖），在 app 內的全螢幕預覽顯示，文件自己帶一顆「列印／儲存 PDF」鈕叫出瀏覽器對話框。好處是零依賴、字型與分頁交給瀏覽器、預覽所見即所得；不靠 `window.open` 是因為彈窗權限被擋時整個功能會靜靜失敗，要分頁時預覽裡另有一顆鈕
- **同步合併的邏輯前後端共用一份**：`src/lib/merge-core.js` 是純 JS＋手寫 `.d.ts`，瀏覽器推送時算、後端落庫時也算同一套規則，不會出現兩端對「誰贏」認知不同的情形
- **刪除是資料，不是請求**：刪掉一筆時本機留一筆 `{id, kind, deletedAt}`（`tombstones`），它跟備份檔一起走出去；合併取完並集之後才照記號把那些列濾掉，並且往下連動（旅行沒了，它底下的行程項、支出、照片也不會留在結果裡）。所以「這一次推送裡沒有這一筆」永遠不等於「請刪掉它」——只有記號算數，伺服器也就不需要任何 DELETE 端點。採「刪除獲勝」：一筆被刪掉之後，另一端在更舊時間點上做的編輯不會讓它復活，要留同樣內容請重新建立（新的 id 不會撞回來）。記號保留 365 天（`TOMBSTONE_DAYS`），超過就放它過去，否則一台永不開動的裝置會永遠壓著別人刪掉的東西。分類與 meta 刻意不參與：內建分類每台裝置各自長出來，讓它被遠端刪除會生出「顏色不見了」這種更難解釋的現象。要整台裝置以某份檔案為準，用「匯入備份（取代）」，那個模式連本機記號一起清

## 部署（Docker）

預設部署出去的只有靜態檔案（HTML／JS／CSS／圖示／Service Worker），**沒有資料庫、沒有帳密、沒有 API**；旅行與支出仍然只存在每台裝置自己的 IndexedDB 裡。換句話說：雲端只是讓大家用同一個網址開啟 app，手機記的錢不會自動出現在筆電上——要跨裝置可以用「設定 → 匯出備份」，或把下面「選裝」的同步 API 開起來。

相關檔案：

| 檔案 | 用途 |
| --- | --- |
| `Dockerfile` | 多階段：`node:20-alpine` 跑 `npm ci && npm run build`，只把 `dist/` 放進 `nginx:1.27-alpine` |
| `deploy/nginx.conf`、`deploy/security-headers.conf` | 靜態檔案服務：`/assets/*` 一年 immutable 快取，`sw.js`／`workbox-*.js`／`index.html` 強制不快取（否則改版推不下去） |
| `docker-compose.yml` | `triplog`（必要）＋ `caddy`（`--profile tls` 才啟動） |
| `deploy/Caddyfile` | 有網域時自動簽發並續期 Let's Encrypt 憑證 |
| `deploy/Caddyfile.selfsigned`、`deploy/make-selfsigned.sh` | 只有裸 IP 時的自簽 HTTPS |
| `deploy/compose.duckdns.yml` | 用 DuckDNS 免費子域名取得正式憑證 |
| `server/`、`server/Dockerfile` | 選裝的同步／agent API：零依賴（`node:http` ＋內建 `node:sqlite`），映像只放 `server/src` 與共用的 `merge-core.js` |
| `server/src/keys.js`、`server/src/cli.js` | 配對碼與主金鑰輪換的純邏輯（形狀／雜湊／生死），以及 SSH 用的救援指令（`status`／`master-reset`／`master-set`） |
| `deploy/compose.api.yml`、`deploy/Caddyfile.api` | 選裝 API 的 compose 覆寫與反代：容器不綁 port，公網仍只有 443 |
| `mcp/` | 選裝的 MCP server，讓 AI agent 打上面的 API（見 `mcp/README.md`） |
| `docs/agent-setup.md` | 給**使用者**的 agent 接手教學：簽憑證 → 貼 MCP 設定 → 驗收 → 撤銷（不講實作） |
| `deploy/deploy.sh` | 一鍵推送＋建置＋啟動；`.env` 有金鑰時自動多掛 API |

### VPS 前置作業（Oracle Cloud 常見坑）

Oracle 的連線會被擋兩次，兩邊都要開：

1. **雲端層 VCN 安全清單**（只能在控制台改，SSH 進去改沒用）：Ingress Rules 加 `0.0.0.0/0 : 443 (TCP)`。
   只需要 443——Caddy 用 ACME 的 **TLS-ALPN-01** 挑戰簽憑證，不需要 80（`deploy/Caddyfile` 已設 `http_port -1`，完全不監聽 80）。想順便保留 `http://` 自動轉位址才另外開 80。
2. **OS 層防火牆**：Oracle 的映像會自己鎖 port，實測兩種狀況：
   - **Ubuntu 24.04 映像**：`iptables INPUT` 預設只放行 22，其餘 `REJECT`。要這樣開：
     ```bash
     for p in 443 80; do sudo iptables -I INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT; done
     sudo netfilter-persistent save      # 不存檔重開機會整個消失
     ```
   - **Platform Commander / OL 映像**：預設啟用 firewalld：
     ```bash
     sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
     ```
3. **Docker**：Oracle 的 Platform Commander 映像已內建；Ubuntu 映像沒有，跑 `curl -fsSL https://get.docker.com | sudo sh`，再把使用者加入群組 `sudo usermod -aG docker $USER`（之後要重新登入）。驗證：`docker compose version`。
4. **公網 IP 建議轉為 Reserved**：免費層的 ephemeral public IP 在實例停止超過 65 天後會被回收，網址會失效。控制台 → Networking → Public IPs → 轉成 reserved。

### 部署方式一：已有網域（推薦，PWA 完整可用）

把 A 記錄指到 VPS 公網 IP，然後在本機執行：

```bash
cp .env.example .env      # 填 TRIPLOG_DOMAIN=triplog.你的網域
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh
```

### 部署方式二：沒有網域，用 DuckDNS 拿正式憑證

到 <https://www.duckdns.org>（可用 GitHub/Google 帳號登入）建立一個子域名、複製 token，然後：

```bash
cp .env.example .env
# .env 內容：
#   DUCKDNS_SUBDOMAIN=你的名字
#   DUCKDNS_TOKEN=<token>
#   TRIPLOG_DOMAIN=你的名字.duckdns.org
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh
```

`deploy/deploy.sh` 看到 `.env` 裡有 `DUCKDNS_SUBDOMAIN` 就會自動加上 DuckDNS 更新容器（每 5 分鐘把這台機器的公網 IP 寫進 DNS），並在啟動前檢查域名是否已解析。想手動操作的話：

```bash
docker compose -f docker-compose.yml -f deploy/compose.duckdns.yml --profile tls up -d --build
docker compose -f docker-compose.yml -f deploy/compose.duckdns.yml logs --tail=30 duckdns
```

### 部署方式三：只有 IP，用自簽憑證（最省事，但每台裝置要先信任）

```bash
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh        # 先部署 HTTP 版
ssh opc@<你的IP>
cd ~/triplog
bash deploy/make-selfsigned.sh <你的公網IP>
echo "TRIPLOG_IP=<你的公網IP>" >> .env
docker compose -f docker-compose.yml -f deploy/compose.selfsigned.yml --profile tls up -d
```

瀏覽器會先擋「連線不是私人連線」，選擇繼續後才會有 Service Worker；iOS 需要把 `deploy/certs/triplog.crt` 傳到手機並安裝描述檔、再到「設定 → 一般 → 關於本機 → 證書信任設定」開啟完全信任，否則 Safari 不給用。要長期在多台裝置安裝 PWA，請改用方式一或二。

### 選裝：開啟同步與 AI agent API

要跨裝置同步（或讓 agent 寫資料）時，在 `.env` 多加一把金鑰，其他什麼都不用改：

```bash
# .env
TRIPLOG_DOMAIN=你的名字.duckdns.org
TRIPLOG_API_KEY=<openssl rand -hex 32 的輸出>     # 至少 24 字元，太短容器會拒絕啟動
TRIPLOG_READ_KEY=<另一把，至少 16 字元>            # 選填：只讀金鑰，給不想給寫入權的場合
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh
```

`deploy.sh` 看到 `TRIPLOG_API_KEY` 就會多掛 `deploy/compose.api.yml`（啟動 `triplog-api` 容器與 SQLite volume，並把 Caddy 的設定換成多一條 `/api/*` 反代的 `deploy/Caddyfile.api`），佈署完會自己 curl 兩項檢查：

- `GET /api/health` 應為 200
- 不帶金鑰的 `GET /api/base` 應為 401

公網入口仍然只有 443：API 容器用 `expose` 只在 Docker 網路內可見，沒有綁任何 host port，防火牆不需要動靜。金鑰只放 `.env` 與 MCP 客戶端設定，不會透過指令列送到遠端（那樣會被同機其他使用者用 `ps` 看到）。

裝置端打開 app：**設定 → 跨裝置同步**，有兩條路——「用配對碼連線」（在已同步好的那台裝置的「金鑰與裝置」裡產生一組 8 個字的碼，這邊打進去就換到屬於這台裝置的憑證，長金鑰不必經手），或照原本「貼金鑰連線」貼入位址（`https://你的名字.duckdns.org`）與金鑰。選前者時按「配對」就會自己拉一次基準檔；選後者請按「測試連線」確認讀得到基準檔，再按「立即同步」。這兩顆鈕任何一顆成功時，只要本機放的是主金鑰，app 就會自動簽一把 90 天的本裝置憑證並寫回本機設定（主金鑰從此不在裝置上）；自動簽不動（例如貼的是 `.env` 的只讀鑰）就照舊用原本那把同步，只在卡片上留一句說明，不會丟錯誤、也不擋同步。之後可以打開自動開關，之後每次啟動 app 且線上時會自己拉一次同步並顯示結果。同一個卡片會列出伺服器上的旅行，可以只拉某一趟。

Agent 端（MCP）請看 [`mcp/README.md`](mcp/README.md)：打包 `npm run mcp:build`，把 `mcp/bin.mjs` 掛進 MCP 客戶端並給 `TRIPLOG_URL` ＋金鑰，就有 18 個讀寫工具；`TRIPLOG_ALLOW_WRITE=0` 是唯讀模式。要一份**照著做就行、不講實作**的版本給使用者，是 [`docs/agent-setup.md`](docs/agent-setup.md)（app 裡「設定 → 金鑰與裝置」下方那段四步說明就是從它縮出來的，按鈕能直接複製設定）。

**金鑰要怎麼拿出來、換掉了該怎麼辦**：金鑰只有 `.env` 裡那一份，沒有第二份副本，所以要用時從那裡讀（別把它貼進聊天、issue 或 commit）：

```bash
grep TRIPLOG_API_KEY .env     # 寫入金鑰：自己的裝置與要寫資料的 agent
grep TRIPLOG_READ_KEY .env    # 只讀金鑰：只想看的 agent
```

想換一把就改 `.env`、重跑 `bash deploy/deploy.sh`（容器重啟後舊金鑰立刻失效），然後在每台裝置的「設定 → 跨裝置同步」貼上新金鑰、MCP 設定也要一起改。注意這幾把東西的差別：主金鑰一洩是整座資料庫能被讀寫，只能靠換鑰補救；在 app 裡簽發的 token 能設唯讀或可寫、能設效期、能單獨撤銷；分享連結的 token 只綁一趟、只能新增，而且能在 app 裡單獨作廢。

**不想交出主金鑰：設定 → 金鑰與裝置**。`.env` 那把 `TRIPLOG_API_KEY` 等於整座資料庫的密碼，要給 AI agent、再添一台裝置、或把它換掉，都在這一張卡處理，不必再手動抄長金鑰（前提：上方「跨裝置同步」已填好位址與主金鑰，這張卡才動得了）：

- **簽發憑證**（`tlk_…`）：選「唯讀／可讀可寫」與效期（30／90／1 年／不設限期），按「產生 token」。完整值**只在那一刻顯示一次**，複製走之後資料庫裡只剩雜湊，忘了只能重發一把。按「讓這台裝置改用這把」就把它寫進本機同步設定——這台裝置之後拿的是能單獨撤銷的憑證，不再留主金鑰。清單列出每把的名稱、狀態（生效中／已過期／已撤銷）、讀過幾次、寫進幾筆、最後使用的時間，能單獨撤銷，也能「撤銷其他所有」（自己這把留著，不會把自己關在門外）。
- **產生配對碼**（8 個字，例：`KQ7T-M3XZ`）：新裝置打開「設定 → 跨裝置同步 → 用配對碼連線」，打這 8 個字（橫線打不打、大小寫都可）就換到一把屬於它的憑證，全程不經手任何長金鑰。配對碼**只用得了一次**，預設 10 分鐘有效（可選 30 分鐘／2 小時），用沒用都列在卡上，隨時能單獨作廢；已配好的裝置不受影響。
- **自動簽發本裝置憑證**：走「貼金鑰連線」時不必按任何按鈕——「測試連線」或「立即同步」一成功，app 就用主金鑰簽一把 `本機裝置 · <裝置名>`（可讀可寫、90 天）並立刻改用，清單上那列會標成「本裝置」；剩下的效期不到 14 天時卡片會提前提醒，過期那天同步會停，重簽一把並按「讓這台裝置改用這把」就好。
- **輪換主金鑰**：`.env` 那把外流時唯一真正的補救。按下去之後資料庫裡只存新鑰的雜湊，舊主金鑰與 `.env` 的只讀鑰**當場不再被接受**，app 簽發過的憑證則全部繼續可用（所以輪換前務必先幫至少一台裝置簽一把並套用，卡才會讓你按）。新值 `tlm_…` 也只顯示一次。

簽發出來的憑證直接填進 MCP 客戶端就能用（可寫的填 `TRIPLOG_API_KEY`，唯讀的另加 `TRIPLOG_ALLOW_WRITE=0`）；卡片下方的「把它接給 agent」那塊會照你選的權限生成一段 `mcpServers` 設定，按「複製 agent 設定」貼進客戶端就少打一串字。拿它打 `/api/sync` 寫資料，如果簽發時選的是唯讀，會得到 403。

邊界都在 `server/src/tokens.js`、`server/src/keys.js` 與 `server/src/index.js`：

- 簽發／列清單／撤銷要用**主金鑰**或**已登入裝置那條 session**：主金鑰管全站（`/api/tokens/pairings` 發配對碼、`/api/tokens/master` 狀態與輪換、`/api/admin/clear` 也只有它能用），登入者只能動自己帳號那批，簽出來的憑證也自帶那個帳號。拿簽發出去的 token 叫它再發一把會是 403，否則任何一把外流的 agent 憑證都能自己擴權或把整個庫清掉
- 資料庫存的都是 `sha256(...)`（憑證、配對碼、輪換後的主金鑰都一樣），不是原文；`hint` 只留頭尾幾字讓人認得出，反推不回去
- 層級只有兩檔：`read` 與 `write`，`write` 包含 `read`。沒有「只能動某一趟」這種細度——那由分享連結負責
- 撤銷與過期都是即時生效（`revokedAt` 比 `expiresAt` 優先判斷）；使用統計只在真的通過限流後才累加，被擋掉的洪水不進清單，寫入另記 `writes`
- 完整值只顯示一次、庫裡只有雜湊：代價是忘記就只能重發，好處是備份檔外洩也帶不走能用的憑證
- 期限最長 365 天（與分享連結同一條上限），要更久就重新簽一把
- `/api/pair` 是唯一不需要 bearer 的寫入路徑（跟分享連結一樣），獨立限流 `TRIPLOG_RATE_PAIR`（預設每 IP 每分鐘 8 次）；领取用「先抢先改 `used_at`」的方式，同一組碼同時打兩次只會成功一次，重複用得到 409、過期或被作廢得到 410
- 換好的裝置拿的是普通憑證，清單上標成「配對裝置 · 裝置名」，因此輪換主金鑰不會把已配好的裝置一起擋在門外

**萬一新鑰沒抄到**：只能從機器本身走 HTTP 之外的路（拿到 HTTP 端點就等于拿到發照權）。SSH 上伺服器後：

```bash
docker compose -f docker-compose.yml -f deploy/compose.api.yml exec triplog-api \
  node server/src/cli.js status                 # 只印 hint 與數量，不會印出完整金鑰
# 解掉輪換鎖，讓 .env 裡那把重新被接受：
docker compose -f docker-compose.yml -f deploy/compose.api.yml exec triplog-api \
  node server/src/cli.js master-reset --yes
# 或自己指定一把（用 "-" 從標準輸入讀，才不會留在 shell 歷史裡）：
docker compose -f docker-compose.yml -f deploy/compose.api.yml exec triplog-api \
  node server/src/cli.js master-set - --yes
```

**分享給同行者**用的就是同一台伺服器，所以開了 API 就自動有這個功能，不必另設定。app 裡打開一趟旅行，按「🔗 分享」→「產生連結」，把網址（`https://你的名字.duckdns.org/#/share/<token>`）傳給同行的人；他開頁就能看，按「＋ 記一筆支出」或「＋ 加一個行程」就直接寫進伺服器的基準檔（不需要金鑰、也沒有帳號）。同一個對話框列出還在效期內的連結與「開過幾次／補了幾筆」，隨時能作廢。這一趟還沒同步過時，按「產生連結」會先自動同步一次再產生。

分享路徑的邊界（`server/src/share.js` 裡都有對應檢查）：

- 一把 token 只認一趟旅行：讀只回那一趟，寫一律把 `tripId` 換成 token 對應的那一趟，別的趟的 id 拿來寫會得到 403
- 回應裡沒有照片，`/api/share/*` 也碰不到 `/api/photos`
- 金額的金鑰不在外頭：`baseAmount` 由伺服器依送來的匯率重算，外幣沒給匯率就 400 退回，時間戳一律用伺服器時間
- 有期限（預設 90 天，最長 365 天，可選不設限）與即時作廢；作廢收的是「授權」，已記錄的資料不動
- 限速獨立計算（`TRIPLOG_RATE_SHARE_READ` 預設 240/分鐘、`TRIPLOG_RATE_SHARE_WRITE` 預設 30/分鐘，以 token＋IP 為單位），避免一條連結被拿來灌基準檔
- 仍然沒有刪除端點：同行者只能新增與覆寫自己那幾筆，動不到既有記錄

**同行者不想（或沒辦法）登入時**，這條路就是替他準備的，三個開關在「🔗 分享」對話框裡：

- **能不能記**：預設可寫；關掉就是唯讀連結——他開得起來、看得完整趟，按下去會得到「這條分享連結是唯讀的」，伺服器和畫面同時守這條規則（前端只是不畫出按鈕，真正的門在後端）。
- **訪客 PIN**（4–8 位數字，選填）：設了之後沒對 PIN 連內容都看不到（`401` ＋ `needPin`），寫入同樣要帶；PIN 可以放標頭 `x-triplog-pin` 或表單的 `pin` 欄位，行動裝置只給一個欄位時也走得通。PIN 明文只在產生連結那一刻出現一次（庫裡只有雜湊，`shareView` 連雜湊都不出口，只給一個 `hasPin` 旗標），忘了只能重發一條。它是「LINE 群組以外的人按到連結也進不來」的程度，**不是密碼**——真遇到兇手，作廢連結才是對的手段。試錯另有獨立限流 `TRIPLOG_RATE_PIN`（預設每分鐘 10 次，以 token＋IP 為單位）。
- **誰記的**：同行者在表單上填的名字會照原本的方式進資料（支出的「誰付的」、行程項目備註），連結本身另外記一筆 `last_writer`，所以在主人的連結清單上看到的是「這條被開過 6 次、補了 3 筆、最後由小美記錄」。那只是顯示用的註記，不比對身分、也不能拿來當授權。

既有連結在新欄位下行為完全不變（`can_write` 預設 1、`pin_hash` 預設 NULL），兩個欄位都是啟動時 `ALTER TABLE` 補上，不用搬資料。

連結清單存在同一個 SQLite 的 `shares` 表（容器啟動時自動建表，不用搬資料）；`/api/admin/clear` 刻意不清這張表，免得把別人還在用的連結一起弄丟。

資料庫位置：`triplog_data` 這個 named volume 裡的 SQLite（基準檔保留 `TRIPLOG_KEEP` 份歷史快照，預設 20）。要備份整個雲端庫：

```bash
ssh opc@<你的IP> 'docker run --rm -v triplog_triplog_data:/d -v $PWD:/out alpine tar czf /out/triplog-data.tgz -C /d .'
```

### 選裝：帳號模式（Google 登入，每人一份帳本）

覺得「一把金鑰＝整個資料庫」太粗，想換成一人一個帳號、各看各的帳本時，多設兩個環境變數就開得起來：

```bash
# .env
TRIPLOG_AUTH=1
TRIPLOG_GOOGLE_CLIENT_ID=<Google Cloud 的 OAuth 用戶端 ID>
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh
```

用戶端 ID 在 Google Cloud Console →「API 與服務」→「憑證」→ 建立 OAuth 用戶端 ID，類型選「網頁應用程式」，兩處都填同一個網址：已授權的 JavaScript 來源填 `https://你的網域`（**不含**尾端的 `/`，也不能是 `http`），重新導向 URI 填同一個。這一把是公開資訊（本來就會出現在瀏覽器裡），而且**不需要 `client_secret`**——伺服器驗的是 Google 簽給瀏覽器的那張 ID token，不是拿 code 去換 token，所以少一個要藏的祕密，也少一個會外流的東西。伺服器只需要能連外（抓 Google 公鑰），入站照舊只有 443，防火牆不用動。

開起來之後的規則：

- 沒登入就打資料端點會拿到 `401` 與 `login: true`，app 據此決定要顯示登入鈕而不是「金鑰錯了」；Google 登入是讀寫資料的唯一入口。
- **第一次登入會把帳號制度之前的那份基準認領過來**（`store.claimLegacyBase`）：你原本的行程、支出、分享連結全部跟著你的帳號走，不會憑空多出一個空帳本。之後第二個人登入看到的是他自己那一份，兩人互看不見，歷史保留上限也各算各的。
- 登入換回的是自家憑證 `tls_…`（資料庫一樣只存雜湊），預設 30 天，常用裝置會自動滑動續期，所以它的實際意義是「連續這麼多天沒上線才要重新登入」。設定頁能列出每條 session 並單獨撤銷，撤銷只砍那一台，不會把自己關在門外。
- 主金鑰與 app 簽發的 `tlk_` 憑證預設還進得來（`TRIPLOG_AUTH_ALLOW_KEYS` 沒設＝1），留著當救援通道與 agent 出入口。**它們看的是哪一份帳，有一個明確的順序**（`server/src/index.js` 的 `resolveAuth`）：這把憑證簽發時綁定的帳號 → 主金鑰請求帶的 `x-triplog-account: <帳號 id 或已驗證信箱>` → 環境變數 `TRIPLOG_DEFAULT_UID` → 全站只有一個帳號時就落在那個帳號 → 都不是則退回「制度前那份基準」（`''`）。這條規矩是為了堵一個真實事故：第一次登入會認領舊基準，而金鑰沒有身分可比對，於是認領之後主金鑰與 MCP 打 `/api/base` 直接 404、看到一座空庫。現在**從 app 或 API 簽發的 `tlk_` 憑證與配對碼都自帶簽發者的帳號**，之後那台裝置不必再登一次；只有 `.env` 裡那把主金鑰本身仍不認得任何人，要用上面那顆標頭或 `TRIPLOG_DEFAULT_UID` 指認。當前落地在哪個帳號，`GET /api/health` 的 `auth.keysSeeUid` 會直接講出來（空字串＝沒預設帳號）。只讀金鑰不認 `x-triplog-account`——那顆標頭只對主金鑰有效，否則一把外洩的只讀鑰就能換人看帳。
- 多人共用同一台時設 `TRIPLOG_DEFAULT_UID=<那個人已驗證的信箱或帳號 id>`，主金鑰與 MCP 就固定看他那一份；只有一個人時不用設，第二個人登入之後「唯一帳號」這條自動失效，改由標頭或環境變數決定。MCP 端對應的設定是 `TRIPLOG_ACCOUNT`（會自動加那顆標頭），寫法見 [`mcp/README.md`](mcp/README.md)。
- **要收緊成帳號唯一入口**（`TRIPLOG_AUTH_ALLOW_KEYS=0`）的順序別弄反：先在每台還在用金鑰的裝置上登入一次 Google（本機帳本會跟著認領進 `triplog-<uid>`），再確認 `curl -s -H "authorization: Bearer $(grep TRIPLOG_API_KEY .env | cut -d= -f2) https://<網址>/api/base` 已經是你看得見的資料，才把 `TRIPLOG_AUTH_ALLOW_KEYS=0` 放進 `.env` 重跑部署。反過來的話，還沒登入的裝置會直接被鎖在自己那份本機資料裡（資料還在，但要靠 SSH 才救得出來）。
- 分享連結在帳號模式下屬於擁有者的分帳：同行者開匿名連結、代記一筆，資料仍然寫進你那一份，不會跑到他自己的帳號裡。
- **共筆邀請**認的是信箱而不是連結：`POST /api/invites {tripId, email, role}` 把某一趟綁到對方的 Google 已驗證信箱，他登入後在「一起記的行程」就會看到那一趟，讀的是 `GET /api/trips/<id>/shared`、記的是 `POST /api/trips/<id>/shared/expense|item`，一律寫進**邀請人那份帳本**。`role=read` 只看不能記；撤銷邀請（`POST /api/invites/revoke`）或受邀者自己退出（`POST /api/invites/leave`）都是下一筆就失效，而兩邊都沒有刪除的入口——資料只能追加。這一條路不寄信、不再產生第二套 token，連結只是讓他來著陸用的，本身不帶授權。

邊界都寫在 `server/src/auth.js`：簽章只收 RS256；`kid` 對不上就重抓公鑰（快取 10 分鐘）；`iss`／`aud`／`exp` 必須全對，`sub` 形狀不對也直接拒；`email_verified` 是 false 給 403；可以再用 `TRIPLOG_GOOGLE_HOSTED_DOMAIN` 把登入限死在某個 Workspace 網域。連不上 Google 時登入回 502，不會「假裝成功」，而已經登入的裝置完全不受影響。登入端點另有每 IP 每分鐘 `TRIPLOG_RATE_AUTH`（預設 12）次上限，專門擋「拿別人的 token 一直試」。

**開啟之前先把雲端庫備一份**（上面那條 `tar czf` 指令）。認領本身只改一欄分帳標籤、內容一個 byte 都不動，但這是這專案到目前最大的一次資料模型變動，退路要留著。要退回金鑰模式就把 `TRIPLOG_AUTH` 清空再重跑部署，並先 `node server/src/cli.js status` 看一眼資料現在落在誰的分帳下。

app 端也接上了。啟動時先問公開端點 `/api/auth/config`（不需要憑證），拿到 `mode: account` 就把畫面擋在登入頁前面，只留一條「先在本機記錄」的退路；點 Google 按鈕走官方 GIS 腳本，ID token 交給 `/api/auth/google`，換回的 `tls_…` 存在本機，同時寫進「設定 → 同步」的金鑰欄位，所以同步、照片、分享連結沿用同一條登入，不必再貼第二次金鑰。

本機庫也跟著帳號分開：登入後資料寫進 `triplog-<帳號 id>` 這份 IndexedDB，同一台手機輪流給兩個人記帳時互相看不見；帳號制度之前那份 `triplog` 會被第一次登入的人認領過來，而且認領只做一次——舊庫留在原處，登出後仍然看得到，這是刻意留的退路。登出、別處撤銷、憑證過期都只把人送回登入頁，本機帳本一個 byte 都不刪；沒網路時帳號模式會給一個「先記著，等連線再同步」的選項，金鑰模式照舊直接進。要查現在有哪幾台裝置還帶著登入，看「設定 → 帳號」那張卡片，逐條撤銷也在同一處。

**登出**有兩顆鈕（桌面在側欄底、手機在頂部導覽），按的是同一支 `src/features/auth/useSignOut.ts`：先問一次，再退掉伺服器上**這一條** session、清掉本機憑證、把畫面重新載入回登入頁。重新載入是必要的——本機庫的名字跟著帳號走，Dexie 連線與所有即時訂閱還指向上一個人的庫，光改 state 扭不過來。它刻意**不**動其他裝置：借出去的手機、遺忘的 iPad 要在「設定 → 帳號 → 登入紀錄」裡逐條收掉（或一次「撤銷其他所有裝置」）。伺服器退不掉（斷線）時仍然會把這台裝置脫離登入狀態，否則人走了憑證還留在瀏覽器裡。

### 更新與日常操作

```bash
SSH_TARGET=opc@<你的IP> bash deploy/deploy.sh        # 改完程式碼再跑一次即可
ssh opc@<你的IP> 'cd ~/triplog && sudo docker compose logs -f triplog caddy'
ssh opc@<你的IP> 'cd ~/triplog && sudo docker compose ps'
```

上線後自我檢查：

```bash
curl -I https://<網址>/              # Cache-Control 應為 no-cache
curl -I https://<網址>/sw.js         # 不應有 max-age
curl -s https://<網址>/manifest.webmanifest | head -5

# 有開同步／agent API 時再多驗這三項
curl -s -o /dev/null -w '%{http_code}\n' https://<網址>/api/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://<網址>/api/base     # 401（沒帶金鑰就讀不到資料）
curl -s -o /dev/null -w '%{http_code}\n' https://<網址>/api/share/nope   # 404（不認識的分享 token 什麼都拿不到）
```

## 尚未做（第二期候補）

其餘：同行者分帳清算（目前只記「誰付的」與各人代墊合計，不出「誰該給誰多少」）、純連結分享的退場（帳號模式與共筆邀請都上線之後，匿名連結仍留著給不登入的同行者，要收到什麼程度還沒定）、CSV 匯出、行程項之間的路線連線與距離、照片的地點／時間 EXIF 解析、PDF 的多趟合併與直排版面。
