# 社群節點、技術補登與收集驗收

這份文件對應 issues #1、#2、#3 的程式交付。下列 fixture 與 backtest 是離線合成資料；正式連續 24 小時觀察須在部署後執行，不以測試結果代替。

## 啟動與資料契約

乾淨環境使用 Node 24、`npm ci`，本站先執行 `npm run db:migrate`（0016 contributor 原始紀錄／canonical／安全拒絕紀錄、0017 技術人工紀錄與異動 log、0018 canary 與預留決策）。節點不需要資料庫。

節點從 `--input` JSON 讀取已合法取得的 Similarweb 標準化結果，支援單筆或陣列。上游取得方式由貢獻者自行授權與實作，再定期更新此檔；節點不呼叫 Similarweb、不使用本站的裝置身分。範例 [observations.json](../examples/contributor/observations.json) 沒有憑證，可直接 dry-run：

```sh
node tools/contributor-node.ts --queue /tmp/contributor-queue.json \
  --input examples/contributor/observations.json --dry-run
```

必要 envelope：`domain`（公開裸網域）、`targetMonth`（已結束月份 YYYYMM）、`fetchedAt`（月份結束後的 ISO 時間）、`sourceNode`、`sourceVersion`、`responseStatus`、`payload`。未帶 `schemaVersion/fields/payloadHash` 時節點自動產生；完整 envelope 則驗證而不重算 hash 掩蓋錯誤。schemaVersion 為 1。2xx 必須有正整數 `visits`，單位是**次**；非 2xx 必須空 payload，永不成為 canonical。

`payload` 僅接受 visits、channels、countries、bounceRate、pagesPerVisit、timeOnSite。未知欄位全部拒絕；channels 只接受 `trafficChannels` 清單，share 為 0–1、合計不超過 1.001；countries 使用不重複的大寫二碼、同樣限制 share。缺欄位省略，明確的 0 保留。Hash 是遞迴依 key 排序的 JSON SHA-256；陣列順序保留。錯誤欄位、hash、不合理日期、來源不符與未追蹤網域都有安全錯誤碼；拒絕表不保存 request body。

本站設定至少 32 字元的隨機 `TRAFFIC_CONTRIBUTOR_SECRET`，維護者在本站環境執行：

```sh
node --env-file-if-exists=.env tools/contributor-token.ts node-a
```

把印出的 15 分鐘 token 安全交給該節點，寫入僅該使用者可讀的檔案；不交出簽章 secret。持續執行需要由維護者授權的發 token 流程定期更新該檔。node ID 必須符合輸入的 sourceNode（fixture 使用的 ID 見範例檔）：

```sh
CONTRIBUTOR_URL=https://site.observe.tw \
TRAFFIC_CONTRIBUTOR_TOKEN_FILE=/run/user/1000/contributor-token \
node tools/contributor-node.ts --queue /var/lib/contributor/queue.json \
  --input /var/lib/contributor/observations.json --interval-seconds 3600 --port 18151
```

`--once` 執行一次同步，排程模式每輪重新讀輸入及 token，`/health` 只綁 loopback，回傳最近同步時間、pending/sent/rejected 與安全錯誤碼。queue 以 0600 暫存檔 atomic rename 保存，持久保留 sent/rejected，重啟不重送成功紀錄。每次最多 100 筆；207 逐筆確認，network/5xx/429/401 退避重試，Retry-After 優先，永久驗證錯誤標 rejected。`.lock` 阻止同檔併發；異常退出後，確認舊程序已結束才移除 stale lock。dry-run 驗證但不寫 queue、不上傳。

## Canonical 與回滾

冪等鍵是 `node + domain + month + payloadHash`，transaction 加每月列鎖處理併發。所有來源原始紀錄保留。只有 `TRAFFIC_CONTRIBUTOR_TRUST=node-a:10,node-b:5` 明確正信任且成功的觀察可採用；依信任分數、可用欄位數、抓取時間、node/hash 穩定決勝，理由與 observation_id 持久保存。`GET /api/v1/contributors/:domain?month=YYYYMM` 顯示各來源、當前選擇規則與 trust；public payload 遵守既有兩位有效數字與欄位限制，hash 對應保存的原始值，不對應公開取整版本。

`TRAFFIC_COMMUNITY_ENABLED=1` 才把可信 canonical 納入流量，預設關閉。來源優先順序是本站自動 > 人工平台補登 > 可信社群 > 試算表；同月份紀錄並存，不把社群缺欄位用試算表默默填滿。網站頁、JSON 與排行標示來源和抓取時間；history 的來源碼新增 3（0 自動、1 試算表、2 人工）。信任表示管理者明確配置，並非第三方品質認證。

移除 trust 時讀取立即排除該 canonical；更改相對分數或新增 trust 後，重送原觀察可在不新增資料下重新選擇並保存 canonical。變更環境後重啟 web／worker以清除一分鐘資料快取。`TRAFFIC_COMMUNITY_ENABLED=0` 立即停止採用，原始資料不刪除。

## 覆蓋、時間與技術來源

同一個 coverage 契約用於首頁、完整表、history、rankings 與 CSV（前四欄及 X-Coverage-* headers，空結果仍有 headers）：`month/scope=tracked/tracked/withVisits/complete/lastUpdatedAt`。分母是 standing watches 與該月 collection_domains 聯集，不隨標籤或搜尋改變。withVisits 可包含試算表，complete 只用原始實際欄位，與 collection 相同，允許來源互補但不抹去來源。估算台灣占比不算完整欄位。預設選最新 complete/tracked >=80% 的月份，沒有達標月才選最新；明確 URL 選月保留。`generatedAt` 只表示回應組裝，資料時間使用真實異動時間。

首頁手機預設收合月份／標籤，保留搜尋；主要四欄可容納 390px，其他欄由「顯示所有欄位」展開。首頁標籤依序切換包含（OR）→ 排除 → 未選取；包含多個標籤時符合任一即可，排除仍生效。點「全部標籤」清除標籤篩選（含預設非台灣排除），點「全部來源」清除來源篩選；aria-pressed 標示已套用的標籤篩選。首頁資料與 CSV 使用 topicMode=or，API 未指定時維持 AND。

編輯可由 `/tech/:domain/` 的「人工確認技術」填入既有技術代碼、公開 HTTPS 佐證和觀察日期。需登入管理員且同來源 POST；會新增 audit，不改 tech_scans 或將阻擋改成成功。人工紀錄獨立顯示於總覽、網站頁及 API，未知版本維持未知。遇 WAF／429 不再用 browser 重試；一般排程最早 30 天後重新檢查，人工即時檢查仍受既有 cache 限制。network/timeout 可維持既有 browser fallback，不加入反偵測或換出口。

## 排程回放、canary 與 24 小時驗收

`TRAFFIC_QUEUE_OPTIMIZATION=0` 保留現行 baseline（priority、稀有 tag x10、CrUX、每五次保留 retry）。稀有 tag 仍是至多 20 個收集網站使用且排除「其他／非台灣」。回放共用 baseline 排序，不更動上游節流：

```sh
node tools/queue-backtest.ts examples/queue/synthetic-history.json /tmp/replay.json 8 2026-11-17T00:00:00Z
diff -u examples/queue/synthetic-report.json /tmp/replay.json
```

報告比較 baseline、rare-tag、traffic、fair，列完成數、稀有 tag／台灣流量覆蓋、平均資料年齡、priority、拒絕數與選擇順序。輸入可帶 `observations` 歷史 domain/at/saved/complete/refused；各策略依該網域的實際逐次結果回放，不把拒絕算成功。這是假設回應不隨請求時間改變的反事實比較，無 observations 時明確標示每次完整成功的假設；不宣稱吞吐量改善已在正式站量測。

啟用 `TRAFFIC_QUEUE_OPTIMIZATION=1` 並指定固定 `TRAFFIC_QUEUE_CANARY` ID。worker 首次同步才建立最長 24 小時 canary，讀 API 不開始實驗。四 lane cycle 為 missing/partial/missing/retry/refresh，空 lane 讓出名額，ordinal 取持久 sends（含 pending reservation）。七天未嘗試的網域在自身 lane 優先於新高流量資料，先服務最老者；同批同時加入時仍按優先級、價值分數決勝，避免退化成網域字母排序。有限待辦下有界名額，不在供應端拒絕或額度為零時承諾牆鐘時間。重試等待及最大嘗試數繼續有效。

完整資料只在自動來源超過 `TRAFFIC_COLLECTION_REFRESH_HOURS`（預設 720、至少 24 小時）且沒有較新月份時考慮 refresh。每次 sends 預留保存 policy 分數組件、目標月與缺欄位；所有入口仍共用原有 named lock／quota。遇拒絕立即標記 canary 回 baseline，原 403/429、Retry-After、adaptive backoff 照常執行；到期不自動重開。設 flag=0 可回滾；不要為反覆被拒絕而更換 canary ID。

狀態 API 的 throughput 計算目標月已確認保存的 distinct domain，包含最近 24h／7d、完整數、每小時／日分布、lane／retry 占用與拒絕。HTTP200、舊月份或舊診斷沒有 targetMonthSaved/Complete 的紀錄不當成功。ETA 假設未來速度維持最近七天 distinct 成功數 /7；零成功且仍有缺口時為 null，不用配額上限冒充實際速度。

部署後用本機 DB 唯讀快照（不向上游送請求）保留驗收資料：

```sh
node --env-file-if-exists=.env tools/collection-diagnostics.ts /secure/before.json
# 保留原節流與退避，讓 worker 正常執行至少 24 小時後：
node --env-file-if-exists=.env tools/collection-diagnostics.ts /secure/after.json /secure/before.json
```

快照含小時／日成功、完整域、priority／tag 覆蓋、refusal、重試占比與可還原的決策。comparison 用前次七日完整速率推算進度，對照實際淨完整數，列 ETA 進度誤差（域）；月份或 cohort 改變時設 null，避免拿不同母體比較。`atLeast24Hours` 才表示時間足夠；仍需維護者核對同 cohort、無新增拒絕／starvation，再決定採用。正式 24 小時觀察尚未由本 PR 執行。

## Issue #2 評估取捨

採用：覆蓋率、真實時間、手機篩選、明確排除、HTML 404、匿名隱藏管理連結、兩秒 readiness、獨立 liveness、web／worker 固定 commit 發布。保留既有中文分類名稱與完整表欄位，以免改動既有 taxonomy 及 CSV 使用者的意義；手機提供可展開其餘欄位。

本次資料存取決策是人工公開佐證與經授權的標準化觀察，不加入 stealth、身分或出口輪換，不調高節流。既有出口比較程式維持預設關閉；本次不啟動它。此決策不等同宣稱已取得第三方再散布授權；是否接受外部節點仍由部署者核實其來源授權。公開狀態保留必要的成功／拒絕／退避，歷史實驗保留在診斷 JSON，不在 UI 推薦跨出口探查。
