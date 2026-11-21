# TripLog MCP server

讓 AI agent（Qoder、Claude Desktop 或任何 MCP 客戶端）透過已佈署的同步 API 讀寫 TripLog 的旅行資料。

這個程式**不碰資料庫**，全部走 `https://<你的網域>/api/*`，所以 agent、手機、筆電看到的是同一份基準快照，不會各寫各的。代價是：**佈署時要先有帶金鑰的 API**（見 `deploy/compose.api.yml` 與根目錄 `.env.example`）。

## 1. 先備好兩件事

```bash
# 專案根目錄
npm install
npm run mcp:build          # 打包成單一檔 mcp/dist/index.mjs（不入版控）
```

`mcp/bin.mjs` 只是進入點的殼，忘了 build 時它會給一句人話而不是模組找不到堆疊。所有 MCP 客戶端都指這個 `bin.mjs`。

後端那邊要有一把寫入金鑰：`.env` 裡填 `TRIPLOG_API_KEY`（`openssl rand -hex 32` 產生），再跑一次 `bash deploy/deploy.sh`。API 沒起來時 `triplog_health` 會直接告訴你連不到哪裡。

## 2. 掛進 Qoder

設定 → MCP 連接器 → 新增，內容相當於：

```json
{
  "mcpServers": {
    "triplog": {
      "command": "node",
      "args": ["D:/workspace/tripest/mcp/bin.mjs"],
      "env": {
        "TRIPLOG_URL": "https://triplogmo.duckdns.org",
        "TRIPLOG_API_KEY": "貼上你的寫入金鑰"
      }
    }
  }
}
```

路徑請換成你本機的絕對路徑。金鑰寫在客戶端的 MCP 設定裡，不會進 repo，也不會進任何一筆備份檔。

## 3. 環境變數

| 變數 | 預設 | 作用 |
| --- | --- | --- |
| `TRIPLOG_URL` | `https://triplogmo.duckdns.org` | API 位置結尾不用加 `/` |
| `TRIPLOG_API_KEY` | 空 | 可讀可寫。沒給就完全打不到後端 |
| `TRIPLOG_READ_KEY` | 空 | 只讀金鑰；當你不打算讓 agent 動資料時給這個 |
| `TRIPLOG_ALLOW_WRITE` | `1` | 設 `0` 時**連寫入工具都不註冊**，agent 看不到也叫不到 |
| `TRIPLOG_TIMEOUT_MS` | `30000` | 單一請求逾時 |

唯讀 agent 的建議組合是 `TRIPLOG_READ_KEY` + `TRIPLOG_ALLOW_WRITE=0`：既然後端金鑰只有讀權限，工具列表也別再留一堆它用不到的寫入選項。

## 4. 14 個工具

讀（7 個，唯讀模式會全留）：

| 工具 | 用途 |
| --- | --- |
| `triplog_health` | 連通性、快照數量與體積 |
| `triplog_list_trips` | 所有旅行與每趟的行程項／支出／照片數、主幣別合計 |
| `triplog_get_trip` | 一趟的完整內容（照片只有 metadata，不會拖 base64） |
| `triplog_summary` | 支出統計：合計、預算、依分類／付款人／幣別分組 |
| `triplog_list_expenses` | 列支出，可按日期區間、付款人、分類篩 |
| `triplog_history` | 後端留了哪幾份歷史快照、誰在何時推的 |
| `triplog_delete_help` | 沒有刪除工具；叫它會拿到「該怎麼刪」的說明 |

寫（7 個，`TRIPLOG_ALLOW_WRITE=0` 時不註冊）：

| 工具 | 用途 |
| --- | --- |
| `triplog_create_trip` | 建立旅行（名稱、日期區間、主幣別、預算、同行者） |
| `triplog_add_items` | 批次加行程項，同一天會自動往後排 order |
| `triplog_update_item` | 改行程項，只蓋有送的欄位 |
| `triplog_add_expenses` | 批次記支出，外幣要自己給匯率 |
| `triplog_update_expense` | 改支出，含事後補匯率重算 |
| `triplog_add_companions` | 加同行者名單（付款人選項用） |
| `triplog_archive_trip` | 歸檔／取消歸檔，取代刪除 |

另有兩個 resources：`triplog://schema`（欄位定義與寫入規則，建議 agent 第一次操作前先讀）與 `triplog://trips`（旅行索引）。

## 5. 寫入時的三個行為，值得先知道

**日期一定要落在旅行期間。** `triplog_add_items`／`triplog_add_expenses` 收到超出 `startDate`～`endDate` 的日期會直接拒絕，因為 app 的天是照日期區間長的，越界的記錄會「寫得進去但看不到」。要加那天的行程，先拉長旅行日期。

**匯率一定要使用者確認。** 外幣支出沒給 `rateToBase` 時會報錯，並把後端記過的上一筆匯率一起告訴你，讓 agent 拿去問人而不是自己猜。主幣別一律 1。

**分類可以給三種寫法。** 分類 id、內建 key（`food`／`transport`／`stay`／`ticket`／`shopping`／`fun`／`misc`），或一個全新的名字。全新的名字會自動建一張自訂分類並在同一次同步送回，回傳裡會同時給 `category`（id）與 `categoryLabel`（名稱），agent 才看得出最後記到哪。

## 6. 寫進去之後，使用者的裝置要看得到

API 是「兩端各自推送、伺服器合併」，agent 推完不等於裝置那邊已經更新。手機／筆電要到 **設定 → 跨裝置同步** 按一次「立即同步」（或打開自動同步開關）才會把 agent 寫的那幾筆拉下來。PDF 列印與統計讀的都是本機 IndexedDB，所以同一件事：先同步，再列印。

## 7. 安全邊界

刪除不存在。所有寫入都是新增或依 id 覆寫，`triplog_delete_help` 之外沒有任何路徑能移除資料；要真的刪，請在使用者面前於 app 內手動做。這也代表兩端刪過的東西，另一端下次同步會把它帶回來（尚未實作 tombstone）。

金鑰就是資料庫密碼。`TRIPLOG_API_KEY` 洩了等於整個資料庫可被讀寫，請只放在 `.env` 與 MCP 客戶端設定，不要貼進 issue、chat 或 commit。後端只對 443 開放，API 容器不綁 port，公網看不到它；沒帶金鑰的請求一律 401。

不想把主金鑰貼進 MCP 設定時，改用 app 簽發的憑證：打開「設定 → 金鑰與裝置」（上面「跨裝置同步」要先填主金鑰），選「唯讀」或「可讀可寫」與效期，按「產生 token」，把那串 `tlk_…` 填進 `TRIPLOG_API_KEY`——唯讀那把請同時設 `TRIPLOG_ALLOW_WRITE=0`，免得 agent 一路撞 403。完整值只顯示一次，資料庫只存雜湊；用壞了或外流了就回同一張卡按「撤銷」（或一次「撤銷其他所有」），主金鑰與別把憑證都不受影響，卡上也看得得到它被讀過幾次、寫進幾筆。真要連主金鑰一起換掉，同一張卡有「輪換主金鑰」：換完 `.env` 那把與只讀鑰當場失效，已經簽發給 agent 的憑證照常用。

分享連結走另一條路：`/api/share/<token>` 不需要金鑰，token 只綁一趟旅行、只能新增該趟的行程與支出，回傳內容一律不含照片，也沒有刪除介面。它跟上面的金鑰是分開的兩種權限，agent 拿不到 token，也生不出連結。

照片會進到 VPS。這跟純靜態佈署時「資料只存在各裝置」不一樣，不想讓照片離開裝置就別給寫入金鑰，並把 `TRIPLOG_KEEP` 留意一下（歷史快照也含照片 base64）。

## 8. 除錯

| 現象 | 意思 |
| --- | --- |
| `沒有 TRIPLOG_API_KEY…` | 客戶端 env 沒帶金鑰（或帶錯位置） |
| `API 401 …（金鑰不對）` | 金鑰跟後端不一致，檢查兩邊 `.env` |
| `API 403 …只有讀取權` | 拿讀取金鑰做寫入，改用 `TRIPLOG_API_KEY` |
| `API 404 …後端還沒有資料` | 先用 app 推送一次，或叫 `triplog_create_trip` |
| `連不到 https://…` | DNS 還沒指過來、Caddy 憑證還在簽，或防火牆沒開 443 |
| `unknown tool`／唯讀拒絕 | 這組工具跑在 `TRIPLOG_ALLOW_WRITE=0` |

驗收（會自己起一個暫存資料庫的 API，再真的用 JSON-RPC 打過去）：

```bash
npm run mcp:test     # = mcp:build + 21 項 MCP 檢查
```
