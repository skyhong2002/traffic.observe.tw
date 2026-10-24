# traffic.observe.tw 流量觀察

把 GeneHong「[Similar Web 新聞](https://docs.google.com/spreadsheets/d/1B5RsSVZSrjKSUFDFZ-2VVlU3-tpTN49J1YzLGOohalM/edit)」試算表做成自動更新的資料庫，同時是這台主機**唯一**對 `data.similarweb.com` 發請求的服務。tag.observe.tw、blog.observe.tw 等其他服務都把網域交給這裡，再讀結果，自己不打 Similarweb。

## 為什麼要獨立

- 主機只有一個對外 IP，Similarweb 大約連續 20 次就回 403（約 11 分鐘後解除）。所有請求必須由同一個排程、同一份預算送出。
- Similarweb 每次只回最近三個月的造訪量，以及**最新一個月**的導流（搜尋、AI…）、國家和排名。某個網域如果當月沒抓到，那個月的搜尋S／AI 就永遠沒了。所以每個網域每月至少要抓到一次，抓到的就永久保存。

## 組成

| 程式 | 用途 |
| --- | --- |
| `src/server.ts` | Fastify：網頁、公開唯讀 API、`/internal/*` 服務 API（`TRAFFIC_HOST:TRAFFIC_PORT`，預設 `127.0.0.1:18150`） |
| `src/worker.ts` | 每小時第 `TRAFFIC_RUN_MINUTE`（預設 35）分跑一輪 `runOnce`（`src/scheduler.ts`） |
| `src/similarweb.ts` | 請求與解析，從 tag `app/src/media-traffic/live.ts` 搬來 |
| `src/sheet.ts`、`src/sheet-domains.ts`、`tools/import-sheet.ts` | 讀試算表（各 `YYYYMM` 分頁）進 `sheet_rows`；`sheet-domains.ts` 是人工對照的「名稱 → 網域」表 |
| `src/metrics.ts`、`src/topics.ts` | 月排行、跨月份標籤彙整的計算 |
| `tools/import-tag.ts` | 一次性從 tag 資料庫複製歷史與 blog 的排隊請求 |
| `tools/backtest-sheet.ts` | 拿試算表數字核對 Similarweb 資料 |

資料庫是 tag-db（MariaDB，`127.0.0.1:13306`）裡獨立的 `traffic_observe`，帳號 `traffic_observe` 只能存取自己的資料庫；測試用 `traffic_observe_test`（測試會清空，絕不能指向正式庫）。`npm run db:migrate` 套用 `src/migrations/*.sql`。

## 抓取規則（`src/scheduler.ts`）

- 每輪最多 `TRAFFIC_RUN_BUDGET` 筆，間隔 3 秒，最長 5 分鐘。**預設 0，也就是完全不送**：tag 還在自己打 Similarweb 的期間必須維持 0。
- 任何 401／403／429：整輪立刻停，之後 `TRAFFIC_REFUSAL_COOLDOWN_MINUTES`（預設 50）分鐘內都不送，那個網域保留原本的順位。連續三次 HTTP 或網路錯誤也會停。
- 用 MariaDB 的 `GET_LOCK('traffic-similarweb')` 保證同一時間只有一輪在跑。
- 哪些網域到期：
  1. 一次性查詢（blog）在提交後還沒得到回應；
  2. 定期清單（tag 每 7 天、試算表每 30 天）距上次成功超過週期；
  3. 定期清單裡還缺上個月 profile 的網域，每 3 天重試一次，直到 Similarweb 給出上個月的資料。
- 順序依 `TRAFFIC_PRIORITY`（預設 `manual,tag,blog,sheet`；`manual` 是編輯在 `/watch/` 手動加入的），從沒抓過的優先，再來是最舊的。
- 失敗（沒有資料、錯誤）隔天重試；累積三次後改成每 30 天一次。

容量估算：每小時 15 筆 × 24 = 360 筆／天。tag 約 300 個網域每週一次，加上試算表約 670 個網域每月一次，大約 75 筆／天，餘裕足夠。

## Cloudflare Radar（`src/radar.ts`）

2026-10-21 從 tag 搬過來，token `CLOUDFLARE_RADAR_API_TOKEN` 只放在本服務。用的是官方 API，權限為 Account → Radar → Read，沒有 Similarweb 那種 IP 限制。

- 每天台北時間 `TRAFFIC_RADAR_HOUR`（預設 3）點、在 Similarweb 那輪之後跑一次，涵蓋所有追蹤中的網域（各請求者都算）。
- 順序：從沒抓到的先抓，再來是最舊的。20 小時內抓過的跳過。每筆間隔 1 秒，最長 25 分鐘。
- 401／403／429 時整批停止，連續三次錯誤也停止。
- 每一期都存進 `radar_ranks`（網域 × 資料日期），以較新的抓取為準；`radar_state` 記錄每個網域的抓取狀態，`radar_runs` 記錄每一批。
- 只有前 100 名有確切名次，其餘是級距（「前 20,000 名」）。`>200000` 存成 `bucket_lower_bound`，顯示為「未入前 200,000 名」。Radar 排名不能換算成造訪量。
- `POST /internal/v1/radar` `{ domains }` 回傳各網域的所有期別。tag 的 `media-radar` job 每天 05:15 從這裡鏡像。
- `tools/import-tag.ts` 會一併複製 tag 的 `media_radar_ranks`：2026-10-21 匯入 304 個網域、919 期。

## 試算表

`node --env-file=.env tools/import-sheet.ts` 會下載公開匯出的 xlsx，重寫各月份的 `sheet_rows`，並把最新兩個分頁的網域設成 `sheet` 的定期清單。來源表維持唯讀；只讀公式的快取結果，不執行公式。

- 欄位依標題名稱找，不依位置，因為各月份版面不同：202412 用「總流量」，2025 年用 SimilarWeb／Ahrefs，2026 年用 流量／搜尋S／AI，202510–202512 的流量欄標成「網站」或月份。
- 名稱結尾的 `/5` 這類除數，或流量欄是乘除公式，代表人工調整，記為 `adjusted`，**不當成造訪量**。
- 網址欄、名稱的超連結（包括多色文字的連結，如「cosmopolitan/10」），或名稱裡寫的網域（「元大理財 yuantafunds.com」）都會取成網域。
- 沒有流量也沒有網址、但 A／B 欄有標籤的列也會匯入，好讓標籤對得到網域。
- 只有名稱沒有網址時，先查 `src/sheet-domains.ts` 的人工對照（例如「BBC 中文」→ `bbc.com`、「台北市」→ `gov.taipei`），再用同名網站在其他月份的網域補上。對照表只收確定是同一個網站的名稱；新增時以網站實際被追蹤的網域為準。
- 表上的 **搜尋S＝流量 × 自然搜尋占比**（不含付費搜尋），**AI＝流量 × GenAI 占比**。2026-10-21 回測（`tools/backtest-sheet.ts`）：
  - 造訪量：202607 有 81/85、202608 有 95/98、202609 有 37/38 落在 1% 內；
  - 202609 搜尋占比：只算自然搜尋時 33/35 一致，加上付費時只有 12/35；
  - AI 占比 34/35 一致。
  - 例外：Similarweb 對 tw.news.yahoo.com 回 0，表上這個網域的數字是從別處來的。
- 2026-10-23 依上述規則重新匯入：18,181 列；202609 有流量的 1,039 個網站中，沒有標籤的從 643 個降到 457 個（其餘不在表上，或表上有列但沒填標籤，例如 gamer.com.tw、news.cn）。`sheet` 定期清單從 669 個網域增為 963 個（新增的是表上以連結或名稱寫出網域的網站）。
- 表上另一組「搜尋／搜尋排名」（2025 年分頁標為 **Ahrefs**），以及「A/S 比值」，都不是 Similarweb 的資料，本服務不提供。

## 頁面與公開 API

- `/` 流量總覽：一列工具列放搜尋、資料月份、比較月份（選項標出上個月、3 個月前、6 個月前、去年同月）、標籤與來源。欄位為排名、網站、標籤、造訪量、區間變化（含 64×24 迷你趨勢圖）、自然搜尋、AI 導流、台灣占比與 Radar；造訪量全站統一以四位有效數字顯示：未滿一千為整數，未滿百萬用 k，未滿一百億用 m，以上用 b（如 437、12.34k、757.3m、4031m、12.34b）；表格依實際數字排序，CSV 與 API 仍為原始數字。選取網站開啟詳情，選了標籤時下方顯示排名軌跡。篩選、搜尋與排序可透過網址分享。
- 網站頁 `/site/<domain>/` 的「流量組成」區塊列出 Similarweb 最新一個有估算月份的全部資料（`traffic_profiles`）：全球、國家與類別排名（類別譯成中文），平均停留、每次造訪頁數、跳出率，10 種導流來源的占比與換算造訪量（含一句說明），前 5 名訪客國家與其他合計，以及有資料時的相似網站；附「這些數字怎麼來的」說明。Similarweb 每次只回最新一個月的組成，2026-10-24 時有 1,293 個網域有 202609 的資料。`/api/v1/sites/<domain>` 同時回傳 `profile`、`category`、`similarSites`、`tags`。
- `/table/` 完整數據與 CSV 下載（篩選不需 JavaScript，選項改變即重新載入）、`/tag/` 跨月份標籤概況（舊網址 `/topics/` 以 301 轉到 `/tag/`，保留查詢字串）、`/site/<domain>/` 單一網站歷史、`/status/` 抓取狀態。
- `/tag/` 使用各網站目前的名稱與標籤，按網域去重統計所有網站，包含尚無流量的網站；累計造訪量加總所有已知月份，不提供月份選單或月成長欄。搜尋與 AI 占比分別只以有該項資料的網站月份為分母加權，缺值不補零。總覽有摘要卡、標籤雲（字級依累計造訪或網站數的排名，可切換）與標籤表（含每站平均與流量最大的三個網站）。`/tag/?topic=` 顯示該標籤的摘要、流量集中度（最大網站與前 5 大占比）、常一起出現的標籤，以及完整網站清單；清單有「月平均」欄，供資料月數不同的網站比較。
- API 說明在 `/api/`（照 tag.observe.tw/api 的格式：使用規則、快速開始、端點一覽，每個端點附參數、範例與回應欄位）。端點清單只寫在 `src/api-docs.ts` 一處，同時產生說明頁、`/api/v1/` 索引與 `/api/v1/openapi.json`（OpenAPI 3.1）。`/api/v1/*` 與 `/icon/*` 回應帶 `Access-Control-Allow-Origin: *`。
- 有 Similarweb 數字就用 Similarweb；沒有的月份或網域用試算表數字，並標「表」。Similarweb 回傳 0 表示該月沒有估算（2026-10-24 查 238 個網域有這種月份，大多是小部落格；tw.news.yahoo.com 三個月都是 0），原值照存，但頁面與 API 視同沒有 Similarweb 數字：改用試算表，沒有就不列入該月，該月的 Similarweb 搜尋、AI、台灣占比也不採用；網站頁的 Similarweb 欄顯示「無估算」。`/internal/v1/traffic` 仍回傳原始數字。
- 免費端點沒有估算的大網站，可以從 Similarweb 平台（pro.similarweb.com，免費帳號登入後只看得到最近一個月）手動補登（`src/manual.ts`，表 `manual_months`，每次異動寫進 `manual_months_log`）。補登數字排在 Similarweb 免費端點之後、試算表之前，頁面標「Pro」，`/api/v1/history` 的來源欄為 2。編輯在網站的「Pro 補登」分頁（`/site/<domain>/manual/`，會顯示免費資料最近三個月有沒有估算，已補登的月份會自動帶入原值）輸入月份（最近三個月）、月造訪量（可貼 `60.10M` 這種寫法）、自然搜尋、Gen AI 與台灣占比（百分比，可留空）。`/status/` 列出需要補登的網域：最近一次抓取每個月都是 0、且試算表曾記錄 100 萬次以上造訪，或已有補登紀錄。2026-10-24 確認 tw.news.yahoo.com 在平台上有資料（9 月 60.10M、自然搜尋 36.45%、Gen AI 0.37%、台灣 61.57%），與試算表數字相同；平台的內部 API 有 CloudFront 防護，直接呼叫會回 403，因此不做自動抓取。月排行的匯入標籤取試算表裡該網域截至該月最新一個月份的所有列（A、B 欄），網站資料覆寫優先；沒有標籤的網域不列入任何標籤，也不另設「未分類」。

2026-10-24 00:14（台北時間）跨月份標籤概況已重啟 web 上線。正式站列出 63 個標籤，對 1,429 個已知網域逐標籤核對成員數與累計流量一致；統計涵蓋 202412 至 202609 的 20 個有流量資料月份。舊 `/topics/?month=` 連結顯示相同的跨月份彙整；手機 390px 畫面無頁面溢出，標籤內網站數與實際清單一致。型別、lint、既有與新增測試通過。此次修改前的檔案備份與正式站核對結果在 `data/topics-aggregate-20261024/`；本次沒有改寫網站名稱、標籤或流量資料。

篩選 chip：標籤按一下只看、再按一下排除（紅色「−標籤」，可同時排除多個）、第三下取消；「全部標籤」清除所有標籤條件。流量總覽與完整數據預設排除「非台灣」（網址沒有 `exclude` 參數時），`exclude=` 留空代表不排除；`/api/v1/rankings` 與 CSV 不套預設，需明確傳 `exclude`。排除後名次在剩下的網站之間重新計算。

網站 icon（`src/icons.ts`）：`/icon/<網域>` 只回應本站已知的網域，第一次請求時由伺服器向 Google favicon 服務（`s2/favicons?sz=64`）抓一次，存在 `data/icons/`（可用 `TRAFFIC_ICON_DIR` 改位置），30 天後更新；Google 沒有圖示的網域記為 `.none`，7 天後再試。同時最多 6 個對外請求。訪客只連本站，不直接連到 Google；沒有圖示時顯示名稱的第一個字。

全站固定使用黑色主題，共用表格沿用 [tag.observe.tw/media/traffic](https://tag.observe.tw/media/traffic) 的緊湊樣式。版面參照 [tag.observe.tw/media](https://tag.observe.tw/media/)：頁首是「流量排行」「標籤概況」「抓取狀態」「追蹤網域」；流量排行的兩個檢視（流量總覽／完整數據）與網站的流量資料／名稱與標籤／Pro 補登，在標題上方以藥丸子選單切換。標題下一行是說明與「本頁的資料來源與計算方式」連結（開啟頁尾上方的收合說明），接著是摘要卡、搜尋與月份、篩選 chip 列（全部來源／各來源、全部標籤／各標籤附數量，標籤超過 15 個時其餘收在「更多」），最後是表格。網站與標籤管理、API 與資料來源放在頁尾。

表格（`src/tables.js`）：每列一行，名稱與網域同列顯示，相同時省略網域；橫向捲動時固定識別欄，垂直捲動頁面時表頭保持可見。伺服器產生的表格加 `data-sortable` 即可點表頭排序（數字先由大到小、名次與文字先由小到大，空值永遠排最後；顯示值與排序值不同時用 `data-v`），搜尋框用 `data-table-filter="<table id>"`。超過 50 列的表格先顯示 50 列，按「瀏覽更多」後隨捲動自動載入；排序、搜尋或篩選改變時回到前 50 列。首頁排行用同樣的規則。

2026-10-24 04:47（台北時間）重啟 web 上線介面改版：版面改照 tag.observe.tw/media（頁首兩個入口、標題上方子選單、摘要卡、篩選 chip 列，已選的 chip 再按一次即取消）、所有表格可排序並以 50 列為單位「瀏覽更多」、造訪量 k／m／b 四位有效數字、`/topics/` 改為 `/tag/`（301 轉址，sitemap 同步）、首頁點網站直接進網站頁、Similarweb 回傳 0 視為無估算、網站頁的「名稱與標籤」「Pro 補登」分頁。`0005_manual_months.sql` 已於同日先行套用（只新增兩張空表）。04:49 再上線 chip 取消選取的修正。型別、lint 與 45 項測試通過；本機與公開站的各頁、`/healthz`、`/api/v1/history`、`/sitemap.xml` 皆 200，`/topics/` 301 至 `/tag/`，HTML 引用新的 CSS 雜湊。上線前的檔案備份在 `data/ui-redesign-20261024/before/`（新增檔案列於 `NEW_FILES.txt`），chip 修正前的版本在 `before-chip-toggle/`；回復時把備份檔複製回原位、刪除新增檔案，再重啟 web 服務（兩張新表可保留，舊程式不會讀取）。上線後 202609 排行由 1,162 個網站變為約 980 個，差額是 Similarweb 回傳 0、又沒有試算表數字的網站。

2026-10-24 05:25（台北時間）重啟 web 上線：標籤 chip 改為「只看／排除／取消」三段、流量總覽與完整數據預設排除「非台灣」（API 不套預設）、修正排序或「瀏覽更多」時排除條件失效、網站 icon（`/icon/<網域>`，快取於 `data/icons/`）、頁首加入抓取狀態與追蹤網域、API 說明頁 `/api/` 與 `/api/v1/openapi.json`、公開 API 加 CORS。型別、lint 與 48 項測試通過；本機與公開站各頁及 API 皆 200，`/icon/` 對未追蹤網域回 404，完整數據預設為「排除 非台灣・916 個網站」，`/api/v1/rankings` 仍回 986 個網站。上線前的檔案在 `data/ui-redesign-20261024/before-exclude-icons-api/`（新增檔案列於 `NEW_FILES.txt`）；回復時把備份檔複製回原位、刪除新增檔案，再重啟 web 服務。

## 搜尋引擎（`src/seo.ts`）

公開與私人的界線不因 SEO 改變：公開頁面與 API 照舊不需登入，`/watch/` 的寫入、`/sites/`、編輯頁仍需登入，`/internal/*` 仍只接受本機加 token。

- 可索引：`/`、`/table/`、`/tag/`（附 description 與不含查詢字串的 canonical），以及有資料的 `/site/<domain>/`（canonical 為正規化後的網域）。
- 其他回應一律帶 `X-Robots-Tag: noindex`，HTML 另加 `<meta name="robots" content="noindex">`：`/status/`（抓取紀錄）、`/watch/`、`/login/`、`/sites/`、編輯頁、`/api/*`、錯誤與所有未知路由。未知路由維持 Fastify 原本的 404，不導向首頁。
- `/robots.txt` 只擋 `/internal/` 與 `/auth/`。`/api/` 不擋，因為 `/` 在瀏覽器端讀 `/api/v1/history`，擋掉會讓搜尋引擎算繪出空白頁；API 改以 noindex 標頭排除。
- `/sitemap.xml` 只列 `/`、`/table/`、`/tag/` 三頁；網站頁靠內部連結被發現，不列入。網址前綴取 `TRAFFIC_PUBLIC_ORIGIN`。
- `http://` 由 Cloudflare 規則 308 轉到 https 的同一路徑與查詢字串，本服務不處理（規則由 Codex 部署，不在本 repo）。
- `/watch/` 匿名可讀，表格會顯示加入者（`added_by`，編輯的 email）與備註。2026-10-23 檢查時手動清單為空，沒有露出 email；是否改成登入後才顯示加入者，需要另外決定。

2026-10-23 17:51（台北時間）以 `545f2c8` 重啟 web 服務上線（工作樹同時包含當時已上線、尚未提交的網站名稱與標籤管理改動）。公開站匿名實測：`/`、`/table/`、`/topics/`、`/site/udn.com/` 200 且 canonical 正確，帶查詢字串時 canonical 不含查詢字串；`/status/`、`/watch/`、`/login/`、`/api/v1/`、`/api/v1/history` 200 加 noindex；`/sites/`、編輯頁 303 到登入；`/nope-x1`、`/table`、`/index.html`、不存在的網站與 `/internal/*` 皆 404 加 noindex；`/robots.txt`、`/sitemap.xml` 200。可提交 Google 的 Sitemap：`https://traffic.observe.tw/sitemap.xml`，共 3 個網址。提交不代表已索引。回復方式：移除 `src/app.ts` 的 `registerSeo(app)` 與其 import，再重啟 web 服務。

2026-10-23 Google 與 Cloudflare 端（Codex 處理）：Search Console 新增 `https://traffic.observe.tw/` 資源並自動驗證，`sitemap.xml` 狀態 Success、讀到 3 個網址；18:12 實測 `GET http://traffic.observe.tw/table/?gsc_check=20261023` 回 308，轉到 https 的同一路徑與查詢字串。Sitemap 成功只代表 Google 讀得到，不代表頁面已被索引。

## 登入與手動追蹤（`/watch/`）

用 Google 登入（`src/login.ts`，從 tag 的 `app/src/auth/google-login.ts` 簡化而來），OAuth client 與 tag 共用。2026-10-24 起任何驗證過 email 的 Google 帳號都會拿到 session（30 天，cookie `traffic_session`，資料庫只存 SHA-256），用來對標籤投票；只有 `TRAFFIC_ADMIN_EMAILS` 名單上的帳號是編輯，可以管理網域、名稱、標籤清單與單一標籤的覆寫。名單每次請求都會重新比對，從名單移除後編輯權限立刻失效。非編輯開啟編輯頁會看到 403 說明。看公開頁面不需要登入。

| 變數 | 說明 |
| --- | --- |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 與 tag 相同。兩個都沒設時關閉登入。 |
| `TRAFFIC_PUBLIC_ORIGIN` | 預設 `https://traffic.observe.tw`。callback `$TRAFFIC_PUBLIC_ORIGIN/auth/google/callback` 必須登記在 OAuth client 的「已授權的重新導向 URI」。 |
| `TRAFFIC_ADMIN_EMAILS` | 逗號分隔，可以手動加入或移除網域的編輯。 |

`/watch/` 可以一次貼多行網域或網址，設定每 7 或 30 天更新一次，並附上備註。這些網域以請求者 `manual` 存進 `watches`，記下 `added_by`，每次加入或移除都寫進 `watch_log`。表單只接受本站 `Origin` 送出的 POST。移除只會停止抓取，已經抓到的資料會保留。

## 服務 API（`/internal/*`）

只接受直接連到 loopback、沒有 `cf-connecting-ip`、`x-forwarded-for`、`tailscale-user-login` 等轉送 header 的連線，並且要帶 `Authorization: Bearer <token>`。token 從 `TRAFFIC_TOKEN_<請求者>` 讀，至少 32 字元，token 決定請求者是誰。不符合一律回 404。

| 路由 | 用途 |
| --- | --- |
| `POST /internal/similarweb/requests`、`GET /internal/similarweb/results?domain=` | 一次性查詢。與 tag 原本提供給 blog 的格式相同（tag `docs/similarweb-requests.md`），blog 不用改程式 |
| `PUT /internal/v1/watch` | `{ domains: [...], refreshDays }`：用這份清單**取代**該請求者原本的定期清單 |
| `POST /internal/v1/watch/add` | `{ domains: [...], refreshDays, note? }`：把網域**加進**該請求者的定期清單，最多 200 個，清單其他部分不變 |
| `POST /internal/v1/watch/remove` | `{ domain }`：從該請求者的定期清單移除一個網域 |
| `POST /internal/v1/traffic` | `{ domains: [...] }`：回傳這些網域存下的所有月份與 profile，以及抓取狀態，給要鏡像資料的服務（tag）用 |
| `POST /internal/v1/tags` | `{ domains: [...], voter? }`：每個已知網域的所有標籤（含未顯示的）與來源、票數；帶 `voter`（讀者的 Google email）時另回該讀者的票與是否為管理員 |
| `POST /internal/v1/tags/vote`、`/propose`、`/admin` | `{ voter, domain, tag, vote: 1 \| -1 \| 0 }`、`{ voter, domain, tag }`、`{ voter, domain, tag, action: set \| hide \| release }`：代讀者投票、新增標籤、管理員覆寫；回傳該網域更新後的標籤 |
| `PUT /internal/v1/tags/ai` | `{ sites: [{ domain, tags: [標籤 \| { tag, reason? }], reason? }] }`（最多 500 個）：以這份清單**取代**該服務對這些網域的 AI 初判；每個標籤可以各帶理由，沒有時用網站的 `reason`；未知網域列在 `skipped`，政治傾向的標籤直接略過 |
| `POST /internal/v1/tags/voters` | `{ voters: [email...], via? }`（最多 500 個）：每位投票者目前有效的票數與最後投票時間；`via`（例如 `blog`）只算經該服務投的票 |

## 從 tag 接手（順序很重要，兩邊絕不能同時打 Similarweb）

1. 本服務先以 `TRAFFIC_RUN_BUDGET=0` 上線，跑 `tools/import-tag.ts` 和 `tools/import-sheet.ts`。（2026-10-21 已在本機完成匯入：tag 304 個網域、912 個月份、304 份 profile、blog 300 筆查詢，以及試算表 20 個月份共 10,662 列。）
2. 在 tag 的 `.env` 設定 `TAG_TRAFFIC_SERVICE_URL=http://127.0.0.1:18150` 和 `TAG_TRAFFIC_SERVICE_TOKEN`（值與本服務的 `TRAFFIC_TOKEN_TAG` 相同），部署含 `app/src/media-traffic/service.ts` 的版本：
   - tag 的 `media-traffic` job 改成登記網域並鏡像資料，不再送 Similarweb 請求；
   - tag 的 `/internal/similarweb/*` 原封轉送到這裡（blog 的 token 兩邊相同）。
3. 確認 tag worker 這一輪顯示 `via: traffic.observe.tw` 以後，才把本服務的 `TRAFFIC_RUN_BUDGET` 改成 15，重啟 worker。
4. 回滾：先把本服務的 budget 改回 0，再移除 tag 的兩個設定並重啟 tag。

2026-10-21 20:00（台北時間）已完成接手：tag `771a4ebc` 的 API、gateway、worker 都已上線，回滾腳本在 `~/tag-analysis-private/f1-release/traffic-service-771a4ebc-20261021/rollback.sh`；本服務 budget 為 15。blog worker 改為直接呼叫本服務（blog `b195eb8`，drop-in `blog-observe-worker.service.d/96-traffic-b195eb8.conf`）。blog gateway 的管理頁查詢仍經 tag 轉送，等 blog 下次發版就會改成直連。

## 部署

systemd user unit 在 `deploy/`（複製到 `~/.config/systemd/user/` 後 `systemctl --user enable --now`，2026-10-21 已啟用）。公開網址 `traffic.observe.tw` 經 Cloudflare Tunnel（observe-steamos）指到 `http://127.0.0.1:18150`；經 tunnel 進來的請求帶 `cf-connecting-ip`，所以 `/internal/*` 一律 404。

服務直接執行這份 checkout 的 TypeScript。UI 修改先跑 `npm run typecheck`、`npm run lint`、`npm test`（測試僅使用 `TRAFFIC_TEST_DB_URL` 指定的測試庫），並以另一個連接埠檢查畫面。`report.html` 與 `style.css` 在程序啟動時讀取，發布 UI 時執行 `systemctl --user restart traffic-observe-web.service`；不需重啟 worker 或套用資料庫 migration。部署後確認本機與公開站的 `/healthz`、`/api/v1/history` 及各頁面正常，並確認 HTML 引用新的 CSS 內容雜湊。若需回復，還原此次修改的 UI 檔案至部署前版本，再重啟 web 服務。

## 標籤投票（`src/crowd.ts`）

2026-10-24 起各觀察站的網站標籤統一在這裡管理與 crowdsource（政治傾向不屬於標籤，另外處理）。資料表 `tag_assignments`（AI 初判、讀者新增、管理員覆寫）、`tag_votes`（一個 Google 帳號對一個網站的一個標籤一票）、`tag_log`（每次異動），migration `0006_tag_votes.sql`。顯示規則沿用 blog 的部落格類型：

- 編輯清單（`site_metadata`，沒有時用試算表）的標籤一律顯示，不受投票影響；
- AI 初判在不同意比同意多 2 票時隱藏；
- 讀者新增的標籤立即顯示（新增者算一票同意），不同意追上同意時隱藏；
- 管理員對單一標籤「指定顯示」或「隱藏」優先於上述規則，「解除覆寫」交回投票。
- 管理員（`TRAFFIC_ADMIN_EMAILS`，2026-10-24 為 sky9109 與 genehong 兩個 Gmail 帳號，blog 與 tag 的管理員名單相同）不投票：在任何站按「同意」就是指定顯示、「不同意」就是隱藏、收回就是解除覆寫，新增標籤就是指定顯示。服務讀取管理員的 `votes` 時回傳覆寫狀態（顯示為 1、隱藏為 -1）。2026-10-24 把兩位管理員原本的 5 票（4 個網站的「新聞」不同意）轉成管理員隱藏，原票刪除，備份在 `data/admin-votes-to-overrides-20261024/`。

排行、標籤概況、網站頁與 API 的 `topics` 都是套用規則後顯示的標籤；`/site/<domain>/edit/` 與 `/sites/` 批次管理改的是編輯清單（`baseTopics`）。網站頁的「標籤」區塊列出每個標籤的來源與票數，登入後可同意、不同意、收回或新增，管理員另有覆寫按鈕；表單只接受本站 `Origin`。每個帳號每分鐘最多 30 次異動（網頁與服務合計）。公開 API `/api/v1/tags/<domain>` 只回票數，不回投票者。其他服務經 `/internal/v1/tags*` 代讀者投票，投票者是該服務登入的 Google email。

政治傾向不是標籤：「藍」「綠」「藍營」「綠營」「藍營傾向（媒體）」「綠營傾向（媒體）」不能由讀者新增、管理員指定顯示或 AI 初判送入（`RESERVED_TAGS`），由 tag.observe.tw 另外管理。2026-10-24 依使用者決定，從編輯清單移除「藍」（14 個網域）與「綠」（19 個網域），並把「內容」（13 個網域）原地併入「內容農場」，共 46 個網域、其他標籤與順序不變；「新聞 (Only)」「財經 (其他)」保留原寫法，「新聞」與「新聞 (Only)」不合併。備份與異動清單在 `data/tags-cleanup-20261024/`。

`tools/import-blog-tags.ts` 從 blog 資料庫複製部落格類型（類型代碼換成名稱，例如 food → 美食；網域取 `canonical_host`）、讀者新增與投票，可重複執行，只記錄新的列。2026-10-24 匯入 479 個已驗證部落格的 876 筆 AI 初判與 3 票，網域全部對得上。

## 網站名稱與標籤管理

登入 `TRAFFIC_ADMIN_EMAILS` 名單內帳號後，網站頁上方會出現「流量資料／名稱與標籤／Pro 補登」分頁，也可從 `/sites/` 批次管理。標籤編輯器把已選標籤列成可移除的標籤，輸入文字會列出符合的既有標籤（依使用次數排序）並可新增，下方列出最常用的標籤可一鍵加入；儲存後留在同一頁並顯示「已儲存」。單站支援名稱修改、多標籤新增與移除；管理頁可搜尋、依標籤篩選、勾選最多 200 個網域批次加減標籤。網域不在這個表單修改，以免接錯歷史流量。

人工值存入 `site_metadata`，原始 `sheet_rows` 保留不動。人工標籤取代該網站的匯入標籤（包含手動清空）；名稱留空時沿用表格名稱。人工值套用至網站各月份的標籤，表格原始逐月紀錄仍可查看。重新匯入不會蓋掉人工值。每次修改記錄於 `site_metadata_log`；單站儲存檢查版本，批次更新使用交易與資料列鎖，成功後清除排行及歷史 API 快取。

地區、主題與網站類型統一以一般標籤管理，沒有獨立地區欄位、互斥規則或自動地區判定。「台灣」「非台灣」與其他標籤採用相同的新增、移除和篩選流程；所有符合篩選條件的網站都按流量排名。台灣流量占比仍是原始流量指標，不用來判定標籤。

首次部署本功能須先執行 `npm run db:migrate` 套用 `0004_site_metadata.sql`，再重啟 web 服務。

2026-10-23 20:40–20:42（台北時間）完成 1,429 個網域的逐站名稱與標籤核對，寫入 1,415 筆 `site_metadata` 及同數量的異動紀錄；其中 1,237 個名稱、1,239 個網站的標籤有變更，14 筆身分無法確認的紀錄保留原值。只顯示網域的紀錄由 560 筆降為 9 筆，無標籤由 480 筆降為 4 筆。`taiwan.net` 實際為網域停放頁，已移除誤掛的觀光署名稱與標籤。網站不顯示編輯者類型標示。

逐站證據、更新清單、更新前備份、異動 CSV 與例外清單存於主機的 `data/site-review-20261023/`（未納入 Git）；入口為 `review-report.md`，交易備份為 `production-backup.json`。本次只更新網站資料，交易前後的 `traffic_months`、`traffic_profiles`、`sheet_rows`、`radar_ranks` 筆數與 SHA-256 均一致。重啟 web 後，本機與公開站皆通過健康及頁面檢查，1,404 個歷史網站、202609 的 1,084 個排行網站之名稱、標籤與流量逐筆比對一致。型別與 lint 檢查通過；測試初次遇到逾時，依序執行並延長逾時後 34 項全數通過。

2026-10-24 00:44（台北時間）依使用者指定的 Google Sheet `202609` 分頁重新套用 A、B 欄標籤；同網域所有列合併去重，保留原表標籤文字。有定義且可確認對應的 965 個網站中，777 個更新、188 個原本一致；其餘 464 個網站保留原值，其中 27 個是只有空白 A/B 的已對應網域。來源 1,530 個有標籤的列完整讀取，979 列已對應，另 547 列無可確認的既有網域、4 列有身分歧義，未強行套用或新增網域。修正「就是教不落」「小氣少年」「塔科女子」「布雷克」的對應，避免把標籤貼到同名或錯誤網址的網站。

這次只改目前標籤，所有名稱、歷史流量、試算表原始列、Radar 與追蹤清單保持不變，新增 777 筆異動紀錄。網站明細原表欄位改稱「標籤 A／標籤 B」，CSV 改稱「原表標籤 A」；標籤頁維持跨月份彙整。重啟 web 清除快取後，本機及正式站的 1,409 個歷史網站、202609 的 1,137 個排行網站、58 個標籤與 2,852 個標籤成員關係全部比對通過；非 metadata 資料表筆數與 SHA-256 不變。型別、lint 與 37 項測試通過，手機 390px 無頁面溢出。備份、逐列對應、異動 CSV、未套用列與驗證結果在 `data/sheet-tags-202609-20261024/`，入口 `report.md`。這次更新取代前述 2026-10-23 審閱的部分標籤，舊審閱驗證腳本不可直接重跑。

2026-10-24 00:55（台北時間）依使用者澄清，九月表的完整標籤「內容」代表「內容農場」；已只對九月已確認範圍內的 48 個網域更名，保留其他標籤與順序。先前保留原值的 464 個網域完全未動，其中 13 個繼續使用原來的「內容」；「生活內容」仍是原本的 243 個網域，不做子字串替換或額外性質判定。新增 48 筆異動紀錄，名稱、流量及原始試算表歷史不變。重啟 web 後，本機與正式站完整核對歷史網站、九月排行、標籤統計及三個相關標籤的成員，全部通過。備份、更新範圍與驗證紀錄在 `data/content-farm-label-20261024/`；先前九月同步 manifest 保留當時原值，驗證目前標籤時應包含本次後續更名。

2026-10-24 01:05（台北時間）依使用者最新命名指示，九月試算表明列「生活內容」的 77 個已確認網域改用「生活內容農場」；其餘 166 個使用「生活內容」的網域改為「生活」。這 166 個是前次保留名單中的網站，本次只簡化標籤名稱，沒有賦予農場標籤；前次保留名單的其他 298 個完全不變。只替換完整標籤，其他標籤、順序、名稱及流量歷史不變，既有「內容農場」48 個與「內容」13 個成員保留。新增 243 筆異動紀錄，其餘 1,186 個網域 metadata 不變。重啟 web 後，本機與正式站完整核對歷史、排行、彙整及相關標籤成員通過；原始資料表筆數與 SHA-256 不變。備份與驗證紀錄在 `data/lifestyle-tags-20261024/`，本次更名接續前述九月同步及「內容農場」澄清。
