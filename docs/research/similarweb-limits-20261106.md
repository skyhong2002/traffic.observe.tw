# Similarweb Chrome 插件限制查核（2026-11-06）

查核時間：台北時間約 15:55。此次只讀取公開文件、官方插件套件及本機既有紀錄，沒有額外查詢 Similarweb 網域資料，也沒有變更正式設定或重啟服務。

## 結論

Chrome 插件確實有每週使用限制，但它先在插件端計數，不能直接證明本專案使用的公開資料端點會以相同數字拒絕。正式策略採低頻探查與回應驅動退避：不再把插件的 15/25 次直接當成後端固定週額度；若服務實際回傳 401/403/429 或明確 quota exceeded，立即停止並持久化冷卻。網站、既有資料、Radar 與技術偵測繼續運作。

## 可重查的來源

- [Chrome Web Store 官方插件](https://chromewebstore.google.com/detail/similarweb-traffic-rank-we/hoklmmgfnpapgjgcpechhaamimifchmp)：目前版本 6.12.26，頁面標示更新日 2026-10-19。
- [官方插件公開功能設定](https://cdn.growthbook.io/api/features/sdk-cztFSWBf0E8IfE2)：`features["rcn-1967-limit"].defaultValue` 為 `{"nonPayingLimit":25,"nonRegisteredLimit":15}`。這是插件讀取的正式環境設定；此回應的整份設定 `dateUpdated` 為 `2026-11-05T15:27:52.749Z`，不能把它解讀成這個特定功能的啟用時間。
- [官方插件產品頁](https://www.similarweb.com/corp/extension/)：說明不需帳號即可使用；頁面未提供可據以確認資料端點額度的數字。

官方套件經 Chrome 更新服務下載後，只解壓、未執行。研究副本在 `/tmp/similarweb-research-20261106/`，其中：

- `_locales/en/messages.json` 的 `limit_banner_text_tooltip`：`Your weekly limit resets every Monday`。
- 同檔的 `quota_reached_view_subtitle`：`You've consumed all your usage quota. It has daily and weekly limits, so please try again in a day or a week.`
- `panel/panel.js` 讀取 `rcn-1967-limit`，依登入與付費狀態選取額度，將查看次數存於 `chrome.storage.sync.weeklyDataViews`。計數以 UTC ISO week 換週，滿額顯示 blocker。
- 該面板先發出資料與身分請求，再在收到資料後計數、顯示限制視窗。故面板的每週限制，不能直接當成資料伺服器一定會以相同數字拒絕 HTTP 請求的證明。
- `background/background.js` 的資料來源正是本專案使用的 `https://data.similarweb.com/api/v1/data`；面板另外處理伺服器 429 為 quota reached。

因此兩件事可以同時成立：插件顯示每週限額；本機直接資料請求仍回 200。目前無法只靠公開設定確認後端每個身分/IP 的實際門檻、是否分批啟用，或今天哪個時間起生效。

## 本機實際狀態

查核資料來自 `sends`、`traffic_months`、`traffic_profiles` 與 systemd journal，沒有新增對外測試請求。

- 本機沒有使用者登入 Cookie，使用固定裝置 ID。
- 11/6 台北時間當天至 15:35，累計 16 次成功資料請求；14:35、15:35 也成功。這只能證明當時請求可用。
- 最後一次拒絕紀錄為 10/29 22:35 台北時間。
- 資料庫最新流量月份與組成月份均為 202609。沒有 202610；不能推論所有 Similarweb 產品都尚未發布 10 月。
- 正式每輪預算為 15，但因尚未收到上月資料，排程目前每小時只探查 1 個網域。每輪預算不等於每週上限。

## 應調整的範圍

1. **不需要完全停抓。** 若要人工暫停仍可將 `TRAFFIC_RUN_BUDGET=0`；正常策略使用低頻探查，避免把未證實的插件數字當成後端規格。
2. **恢復前加跨批次請求上限。** 依確認的端點授權與額度設定，而非把每輪 15 當成週限額。若暫採插件匿名額度作保守上限，需以每週 15 次計算，且計入探查、失敗與任何手動抓取；這是本機保守政策，不是已證實的後端 API 規格。所有入口沿用資料庫鎖與同一份計數。
3. **新月份未到時減少探查。** 不再每小時消耗一次；可改為每日最多一次並受週上限約束，或等待人工確認新月份後才恢復。人工確認僅表示有新資料，仍須遵守額度。每週少量額度無法支撐目前整份追蹤清單每月更新，需決定優先名單或使用合適的資料方案。
4. **429 改成持久化的長時間退避。** 現行 50 分鐘冷卻幾乎等於下個整點繼續試。應保存 `Retry-After`（如有）；否則採保守長時間退避或暫停等待人工確認。不要未確認就假設伺服器 429 與插件面板一樣在週一重置。HTTP 200 若明確回 `exceeded: true` 之類的限額物件，也應停止整體請求，不要當成該網站沒有估算。
5. **狀態頁區分停抓、限額、資料月份落後。** `/readyz` 現在對預算 0 一律回 ready，適合避免刻意停抓觸發故障，但狀態頁仍應明示停抓原因、最後收到的資料月份與可恢復時間，避免誤讀成資料已更新。

研究階段的產物只有本筆記；當時未變更正式設定。後續實施紀錄如下。

## 後續實施（2026-11-06 16:12 台北時間）

使用者接著要求協助修改，已完成程式、設定與部署：

- 先以 `TRAFFIC_RUN_BUDGET=0` 暫停，確認防護已部署；依後續判斷改回 `TRAFFIC_RUN_BUDGET=15`、`TRAFFIC_WEEKLY_BUDGET=auto`、`TRAFFIC_PROBE_INTERVAL_HOURS=24`。新月份未出現時每天最多探查 1 個網域，不因本週已有 106 筆歷史請求而鎖住；出現後恢復原本每輪最多 15 筆，仍依近一天收到新月份的比例限制補抓。
- 保留 `TRAFFIC_QUOTA_COOLDOWN_HOURS=168` 作為沒有 Retry-After 的 429 退避；有 Retry-After 時優先遵守。這是退避設定，不是宣稱伺服器每週一定重置。
- 套用 `0012_similarweb_retry.sql`，只新增退避欄位；同步重啟 worker 與 web。
- 送出前預留用量；所有結果、手動指定與並行執行共用週額度；429（含 HTTP 200 的 exceeded）會整體停止並持久化退避。額度等待批次保留 worker 心跳。
- 狀態頁與 API 明示停抓、額度、最早恢復時間及最新月份，不預告無法保證的隊列時間。
- 158 項測試、型別檢查、lint、diff 檢查通過。全套測試另修正首頁測試原本缺少的 `window.displayDomainText` 模擬，沒有改首頁產品邏輯。
- 正式與本機 `/healthz`、`/readyz`、`/status/`、`/api/v1/status`、`/api/v1/history` 均 200；恢復後狀態顯示自動探查與未確認週額度，並保留實際拒絕時的停手條件。
- 修正部署驗證期間不主動查詢 Similarweb；下一次探查依每日間隔計算，不為驗證額外消耗請求。

設定備份：`data/similarweb-limit-release-20261106T081155Z/env.before`（含敏感設定，僅限本機，權限 0600）。若回退程式，新增資料庫欄位可保留，並應維持抓取預算 0，避免恢復舊的高頻排程。
