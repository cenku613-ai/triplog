# 把 AI agent 接上 TripLog（使用者教學）

一句話：先在 app 裡簽發一把**能單獨撤銷**的憑證（開頭是 `tlk_`），把它貼進 agent 的 MCP 設定，agent 就能讀你的行程與支出、幫你記帳——而它**刪不掉任何資料**，那是設計出來的限制，不是設定沒調好。

全流程大約五分鐘：簽憑證（30 秒）→ 本機準備 MCP server（2 分鐘）→ 貼設定（1 分鐘）→ 驗收（1 分鐘）。

---

## 0. 先決條件（缺一樣就往下走會卡住）

1. **你的 TripLog 有開同步／agent API。** 打開 `https://你的位址/api/health`，看得到 `{"ok":true,...}` 才有；只有靜態檔案的部署沒有這支 API（開法見根目錄 `README.md` 的「選裝：開啟同步與 AI agent API」）。
2. **app 已經連上那台伺服器。** 設定 → 跨裝置同步，位址與金鑰填好、「測試連線」按得過。
3. **一台電腦、Node.js 20 以上、這份 repo。** MCP server 在你自己電腦上跑，它只是把 agent 的要求轉成 API 呼叫，不碰資料庫。

---

## 1. 在 app 裡產生一把 token

設定 → **金鑰與裝置** → 「憑證與簽發」那一段，填三個欄位就好：

| 欄位 | 建議怎麼選 |
| --- | --- |
| 名稱 | 寫得讓自己認得就行，例：`筆電上的 Claude`。這行字會存在伺服器上，之後清單靠它分辨哪把是誰。 |
| 權限 | 只想讓 agent 做報告、算錢：**唯讀**。要它幫你記帳、排行程：**可讀可寫**（仍然沒有刪除）。 |
| 效期 | 第一次給 agent 用建議 30 或 90 天。`不設限期` 留給你完全信任的自用裝置。 |

按下「產生 token」之後，完整值**只顯示這一次**（資料庫裡存的是雜湊，關掉就查不回來，只能重發一把），立刻按「複製」。

兩件事先講清楚，可以避免後面白繞一圈：

- **簽發要用「已登入 Google 的裝置」，或還放著主金鑰的那台。** 拿已經簽發出去的 `tlk_` 叫它再發一把會被 403 擋掉——否則任何一把外流的 agent 憑證都能自己擴權。
- **已登入的裝置簽出來的憑證自帶你的帳號**，agent 看到的就是你那份帳本。用主金鑰簽時，帳本歸屬要看優先順序（只有全站一個帳號時不用理會）；想知道現在算在哪份帳上，打 `GET /api/health` 看 `auth.keysSeeUid`。

千萬不要把 `.env` 裡的 `TRIPLOG_API_KEY` 貼給 agent：那把等於整座資料庫的密碼，外洩只能靠換鑰補救；這裡簽發的 token 可以在清單上單獨撤銷，別的裝置一把都不受影響。

---

## 2. 本機準備 MCP server（做一次就好）

```bash
git clone https://github.com/cenku613-ai/triplog.git
cd triplog
npm install
npm run mcp:build        # 產出 mcp/dist/index.mjs（建置產物不入版控）
```

之後所有 agent 都指向同一個進入點 `mcp/bin.mjs`。忘記跑 `npm run mcp:build` 時它不會丟一堆堆疊，會直接跟你說缺什麼。

---

## 3. 貼進 agent 的設定

下面是通用格式（`args` 換成你電腦上的絕對路徑，`TRIPLOG_URL` 換成你自己的位址）：

```json
{
  "mcpServers": {
    "triplog": {
      "command": "node",
      "args": ["/完整路徑/triplog/mcp/bin.mjs"],
      "env": {
        "TRIPLOG_URL": "https://triplogmo.duckdns.org",
        "TRIPLOG_API_KEY": "tlk_……（剛複製的那串）"
      }
    }
  }
}
```

**選了唯讀的話，`env` 裡要多加一行**：

```json
"TRIPLOG_ALLOW_WRITE": "0"
```

差別在於：沒加這行時 agent 還是看得到那 7 個寫入工具，叫用了才吃 403，它會一直重試或跟你抱怨；加上之後那些工具根本不會註冊，agent 的清單就只剩讀。

各家居家端 MCP 客戶端放哪裡：

| 客戶端 | 怎麼加 |
| --- | --- |
| Qoder | 設定 → MCP 連接器 → 新增，內容就是上面那段 `mcpServers` |
| Claude Desktop | `claude_desktop_config.json`（設定 → Developer → Edit Config），改完重啟 |
| Claude Code | `claude mcp add triplog -e TRIPLOG_URL=https://… -e TRIPLOG_API_KEY=tlk_… -- node /完整路徑/triplog/mcp/bin.mjs` |
| Cursor / Windsurf | 專案根的 `.cursor/mcp.json`，格式同上 |

Windows 的路徑寫成正斜線比較不容易出事，例：`"C:/Users/你/triplog/mcp/bin.mjs"`。

變數總表（全部選填，除了 URL 與金鑰）：

| 變數 | 作用 |
| --- | --- |
| `TRIPLOG_URL` | API 位址，結尾不用加 `/` |
| `TRIPLOG_API_KEY` | 可讀可寫的那把（`tlk_…` 也可以用主金鑰，但請用 `tlk_`） |
| `TRIPLOG_READ_KEY` | 只有讀權限的金鑰；配 `TRIPLOG_ALLOW_WRITE=0` 用 |
| `TRIPLOG_ACCOUNT` | **只有多人共用的部署要設**：主金鑰不認得任何人，填那個人的帳號 id 或已驗證信箱。用 app 簽發的 `tlk_` 憑證就不用設，它自己知道算在哪份帳 |
| `TRIPLOG_ALLOW_WRITE` | 設 `0` 時連寫入工具都不註冊 |
| `TRIPLOG_TIMEOUT_MS` | 單一請求逾時，預設 30000 |

---

## 4. 驗收（30 秒）

重啟 agent 客戶端，然後對它說：

> 叫一下 triplog_health，再用 triplog_list_trips 列我的旅行

健康檢查通、清單列得出你的名字，就接上了。接著回 app 的「設定 → 金鑰與裝置」，那把 token 在清單上會變成「讀 N 次 · 最後使用 …」——**這格會跳數字**，代表 agent 用的確實是你剛給的那把，而不是它手上舊設定。

想確認寫入也通，就請它：

> 幫我在〈那一趟〉今天加一筆餐飲支出，金額 …，幣別 …

叫 `triplog_add_expenses`，它會先確認日期落在旅行期間、外幣有匯率才寫（這兩個是故意設計的門檻，見下面第 6 節）。

---

## 5. agent 寫的東西什麼時候會在手機上出現？

**不會自己出現。** 這套同步是「兩端各自推送、伺服器合併」，agent 推上去不等於你的裝置已經拉下來。

要看到：設定 → **跨裝置同步** → 按一次「立即同步」（或把「自動同步」開著）。PDF 列印與統計圖讀的都是本機資料庫，同一件事：先同步，再列印。

---

## 6. 請先讀這段，再決定給不給寫入權限

- **沒有刪除，任何途徑都沒有。** 七個寫入工具全是新增或依 id 覆寫；真要叫它刪除，它只會拿到一份「該怎麼歸檔」的說明。替代做法是 `triplog_archive_trip`（歸檔／取消歸檔）。請知道兩件事：你在 app 裡刪掉的記錄現在**會**同步（本機留下一筆刪除記號，合併時照它把列濾掉）；而記號這件事，MCP 那七個寫入工具一輩子生不出來，只有拿可寫金鑰直接打 `POST /api/sync` 送 `tombstones` 才做得到——那個人本來就有權覆寫這份帳本的任何一列，權限等級跟推送一樣，所以別把可寫金鑰交給不打算讓他改資料的物件。
- **日期一定要落在旅行期間。** 超出 `startDate`～`endDate` 的行程項或支出會被直接拒絕——app 的天是照日期區間長的，越界的記錄會「寫得進去但看不到」。要加那天的，先請 agent 拉長旅行日期。
- **匯率要由你確認。** 外幣支出沒給匯率時會報錯，並把後端記過的上一筆一起回給 agent 參考；正確做法是它來問你，而不是自己猜。主幣別一律 1。
- **照片會離開裝置、進到 VPS。** 這跟純靜態部署時「資料只留本機」不一樣，而且歷史快照也含照片。不想讓照片出去就給唯讀 token，並留意 `TRIPLOG_KEEP`（基準檔留幾份）。
- **分享連結是另一套權限。** agent 拿不到同行的分享連結，也生不出來；那條路不經過金鑰。
- **token 就是鑰匙。** 別貼進聊天室、issue 或 commit。用壞了就回第 1 節那張卡按「撤銷」。

---

## 7. 日常照護

清單上每一把都看得到：狀態（生效中／已過期／已撤銷）、權限、到期日、最後使用時間、讀了幾次寫了幾筆。

- 不讓它動了 → 對那一把按「撤銷」；懷疑某把外流但分不清 → 「撤銷其他所有」會收掉除本機這把以外全部的憑證。
- **輪換主金鑰不影響已簽發的憑證**，agent 照常用；反過來說，撤銷 agent 那把也不需要動主金鑰。
- 到期那天同步與 agent 會一起停。這台裝置自己那把，剩下不到 14 天時清單上會紅字提醒你重簽；agent 那把請自己盯著「到期 …」那一格。
- 換新裝置不必貼長金鑰：同一張卡產生一組 8 個字的配對碼，新裝置打完就換到自己一把憑證。

---

## 8. 連不上時怎麼看

| 現象 | 意思與做法 |
| --- | --- |
| `沒有 TRIPLOG_API_KEY…` | 客戶端 env 沒帶到金鑰，或帶錯了欄位位置 |
| `API 401 …` | 這把憑證不對：已被撤銷、已過期，或貼到半截（完整值只顯示一次，重發一把比較快） |
| `API 403 …只有讀取權` | 拿唯讀 token 叫它寫東西。要寫就重簽一把「可讀可寫」，或撤掉 `TRIPLOG_ALLOW_WRITE=0` |
| `API 404 …後端還沒有資料` | 這份帳是空的：先用 app 推送一次，或叫 `triplog_create_trip` |
| 連得上、健康檢查 200，但清單永遠是空的 | 伺服器開了帳號模式而金鑰不認得任何人：改填 app 簽發的 `tlk_…`（簽發時綁了帳號），或設 `TRIPLOG_ACCOUNT`。答案在 `GET /api/health` 的 `auth.keysSeeUid` |
| `unknown tool`／唯讀拒絕 | 這組工具跑在 `TRIPLOG_ALLOW_WRITE=0`，符合預期 |
| `[triplog-mcp] 找不到 …/mcp/dist/index.mjs` | 忘了 `npm run mcp:build` |
| `連不到 https://…` | DNS 還沒指過來、Caddy 還在簽憑證，或防火牆沒開 443（這套部署只開 443，80 是關的） |

---

## 9. 不想用 MCP？直接打 API 也一樣

同一把 `tlk_` 憑證就是 HTTP 的 bearer，任何會打網路的 agent（或一支 shell script）都接得起來：

```bash
K=tlk_你的憑證
U=https://triplogmo.duckdns.org

curl -s -H "Authorization: Bearer $K" $U/api/trips      # 所有旅行
curl -s -H "Authorization: Bearer $K" $U/api/summary    # 支出統計
curl -s -H "Authorization: Bearer $K" $U/api/base       # 整份基準快照
curl -s $U/api/schema                                   # 欄位定義（不需要金鑰）
```

要寫資料就 `POST /api/sync`，送**部分**文件（`{"trips":[],"dayItems":[],"expenses":[]}` 這種），沒打算動的那個陣列要留 `[]` 而不是省略，伺服器依 id 合併、取較新的 `updatedAt`。沒有刪除端點：要讓某一筆消失，是在文件裡加一筆 `tombstones`（`{"id":"trip_…","kind":"trips","deletedAt":"2026-11-24T00:00:00.000Z"}`），合併端照它把那列連同它底下的行程項、支出、照片一起濾掉；「這次沒把那筆放進文件裡」完全不代表刪除，別人在別的裝置上推的並集本來就會少了幾筆。一般請用 `archived=true` 隐藏，真要刪讓使用者在 app 裡動手。讓 agent 先讀一次 `/api/schema`（或 MCP 的 `triplog://schema`）再動手，比較不會填錯欄位。

---

要改程式或想知道背後怎麼跑的，看 [../mcp/README.md](../mcp/README.md)（實作與 14 個工具的細節、除錯）與 [../README.md](../README.md)（部署、帳號模式、金鑰生命週期）。
