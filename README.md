# TripLog 旅行記錄

離線優先的旅行行程與支出記錄 PWA。手機、平板、電腦都能安裝使用，所有資料保存在裝置本機（IndexedDB），不會上傳到任何伺服器。

## 功能

- **旅行管理**：建立、編輯、歸檔、刪除；起訖日期、主幣別、預算、代表色
- **雙語介面**：繁中／英文全介面切換，跟隨瀏覽器語系為預設，設定裡可手動鎖定；安裝後的應用程式名稱與說明也隨語言本地化
- **行程記錄**：依天數排時間軸，可設定類型（交通／住宿／餐飲／景點／活動）、起訖時間、地點、備註與手動排序
- **地點搜尋**：打關鍵字即時查 OpenStreetMap Nominatim，選了就回填座標與地名；離線時明確告知不可用，不假装成功
- **地圖**：Leaflet + OSM 瓦片，行程項的座標依「第幾天」著色；右側按天分組的地點清單可跳點與直接編輯，表單裡另有點擊選點與「用我的位置」
- **行程照片**：裝置相機／選檔與 Wikimedia Commons 兩種來源，自動縮到 1600px 主圖＋400px 縮圖存進 IndexedDB，每趟上限 60 張；Commons 來源會一併保存作者與授權，時間軸上直接顯示縮圖與大圖檢視
- **隨行人員**：旅行可記多名同行者，支出標記「誰付的」，統計頁看得到各人代墊合計（不做分帳清算）
- **支出記錄**：一鍵記支出、可關聯到某個行程項、多幣別手動匯率、付款人與備註
- **統計**：預算進度、每日長條圖、分類占比環形圖、原始幣別合計、金額最大的幾筆
- **備份**：全量 JSON 匯出／匯入（合併或覆寫），照片以 base64 一起帶走，還原後 Blob 完整讀回
- **PWA**：可安裝、完全離線可用、深色／淺色／跟隨系統主題、手機底部導覽列與桌面側欄自動切換；看過的地圖瓦片快取 30 天，離線仍能看底圖

## 開發

```bash
npm install
npm run dev        # 開發伺服器，http://localhost:5173
npm test           # 44 個單元測試（日期、金額換算、統計、備份與還原、照片往來、座標與地圖邊界、雙語字典）
npm run typecheck  # TypeScript 檢查
npm run icons      # 產生 PWA 圖示（純 Node，無外部依賴）
npm run build      # icons → typecheck → vite build，輸出 dist/
npm run preview    # 以本地靜態伺服器預覽 dist/，PWA 與離線行為要在這裡測
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
| 看过的地圖瓦片 | Cache Storage `osm-tiles`（500 筆／30 天） |

清除瀏覽器網站資料或「設定 → 清除所有資料」會不可逆地移除記錄，請先匯出備份。

## 設計決策

- **行程與支出共用同一條時間軸**：支出可掛在某個行程項下，刪行程項時支出只解除關聯、不會被連帶刪除（錢是重要資料）
- **金額永遠以記錄當下的原始幣別保存**，另存 `rateToBase` 與算好的 `baseAmount`；統計一律用主幣別，避免事後匯率變動影響歷史數字
- **資料一律留本機，但對外請求有三處**：地點搜尋打 Nominatim、底圖打 OSM 瓦片、Commons 選圖打 Wikimedia。三者都只送查詢字串，不帶任何旅行資料、名稱或座標紀錄；離線或擋掉時功能降級但 app 仍可用，匯率則完全由使用者輸入並記憶（無記憶值就留白強制輸入，避免偷偷用 1:1 記錯錢）
- **Nominatim 用得克制**：同一時間只讓一個請求出去、間隔 1.2 秒、結果快取 24 小時，並帶 `accept-language`，符合其使用政策
- **地圖用 circleMarker 而非預設圖示**：Leaflet 預設圖示的圖片路徑在打包後常斷掉，圓點自帶顏色还能順帶表達「第幾天」
- **不含帳密與後端**：跨裝置同步靠匯出／匯入 JSON，之後要接後端時 `updatedAt` 欄位已預留

## 部署（Docker）

部署出去的只有靜態檔案（HTML／JS／CSS／圖示／Service Worker），**沒有資料庫、沒有帳密、沒有 API**；旅行與支出仍然只存在每台裝置自己的 IndexedDB 裡。換句話說：雲端只是讓大家用同一個網址開啟 app，手機記的錢不會自動出現在筆電上——要跨裝置請用「設定 → 匯出備份」。

相關檔案：

| 檔案 | 用途 |
| --- | --- |
| `Dockerfile` | 多階段：`node:20-alpine` 跑 `npm ci && npm run build`，只把 `dist/` 放進 `nginx:1.27-alpine` |
| `deploy/nginx.conf`、`deploy/security-headers.conf` | 靜態檔案服務：`/assets/*` 一年 immutable 快取，`sw.js`／`workbox-*.js`／`index.html` 強制不快取（否則改版推不下去） |
| `docker-compose.yml` | `triplog`（必要）＋ `caddy`（`--profile tls` 才啟動） |
| `deploy/Caddyfile` | 有網域時自動簽發並續期 Let's Encrypt 憑證 |
| `deploy/Caddyfile.selfsigned`、`deploy/make-selfsigned.sh` | 只有裸 IP 時的自簽 HTTPS |
| `deploy/compose.duckdns.yml` | 用 DuckDNS 免費子域名取得正式憑證 |
| `deploy/deploy.sh` | 一鍵推送＋建置＋啟動 |

### VPS 前置作業（Oracle Cloud 常見坑）

Oracle 的連線會被擋兩次，兩邊都要開：

1. **雲端層 VCN 安全清單**（只能在控制台改，SSH 進去改沒用）：Ingress Rules 加 `0.0.0.0/0 : 443 (TCP)`。
   只需要 443——Caddy 用 ACME 的 **TLS-ALPN-01** 挑戰簽憑證，不需要 80（`deploy/Caddyfile` 已設 `http_port -1`，完全不監聽 80）。想順便保留 `http://` 自動轉位址才另外開 80。
2. **OS 層防火牆**：Oracle 的映像會自己鎖 port，實測兩種狀況：
   - **Ubuntu 24.04 映像**：`iptables INPUT` 預設只放行 22，其餘 `REJECT`。要这样開：
     ```bash
     for p in 443 80; do sudo iptables -I INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT; done
     sudo netfilter-persistent save      # 不存檔重開機會整個消失
     ```
   - **Platform Commander / OL 映像**：預設啟用 firewalld：
     ```bash
     sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
     ```
3. **Docker**：Oracle 的 Platform Commander 映像已內建；Ubuntu 映像沒有，跑 `curl -fsSL https://get.docker.com | sudo sh`，再把使用者加入群組 `sudo usermod -aG docker $USER`（之後要重新登入）。驗證：`docker compose version`。
4. **公網 IP 建議轉為 Reserved**：免費層的 ephemeral public IP 在实例停止超過 65 天後會被回收，網址會失效。控制台 → Networking → Public IPs → 轉成 reserved。

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
```

## 尚未做（第二期候補）

跨裝置同步與帳號、同行者分帳清算（目前只記「誰付的」與各人代墊合計）、CSV 匯出、共用唯讀連結、行程項之間的路線連線與距離、照片的地點／時間 EXIF 解析。
