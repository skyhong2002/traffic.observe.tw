# 網站雷達 site.observe.tw

把 GeneHong「[Similar Web 新聞](https://docs.google.com/spreadsheets/d/1B5RsSVZSrjKSUFDFZ-2VVlU3-tpTN49J1YzLGOohalM/edit)」試算表做成自動更新的資料庫，同時是這台主機**唯一**對 `data.similarweb.com` 發請求的服務。tag.observe.tw、blog.observe.tw 等其他服務都把網域交給這裡，再讀結果，自己不打 Similarweb。各網站首頁用了哪些技術（`/tech/`）也由這裡抓取與偵測，blog 只讀結果。

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
| `src/tech.ts`、`src/wappalyzer.ts`、`src/tech-scan.ts`、`src/tech-pages.ts` | 網站技術：技術清單與偵測、Wappalyzer 規則比對、抓首頁與排程、頁面 |
| `tools/fetch-wappalyzer-rules.ts`、`tools/import-blog-tech.ts` | 安裝釘選的 Wappalyzer 規則；一次性從 blog 資料庫匯入它的偵測結果 |

資料庫是 tag-db（MariaDB，`127.0.0.1:13306`）裡獨立的 `traffic_observe`，帳號 `traffic_observe` 只能存取自己的資料庫；測試用 `traffic_observe_test`（測試會清空，絕不能指向正式庫）。`npm run db:migrate` 套用 `src/migrations/*.sql`。

## 抓取規則（`src/scheduler.ts`）

- 每輪最多 `TRAFFIC_RUN_BUDGET` 筆，間隔 3 秒，最長 5 分鐘。**預設 0，也就是完全不送**：tag 還在自己打 Similarweb 的期間必須維持 0。
- 任何 401／403／429：整輪立刻停，之後 `TRAFFIC_REFUSAL_COOLDOWN_MINUTES`（預設 50）分鐘內都不送，那個網域保留原本的順位。連續三次 HTTP 或網路錯誤也會停。
- 用 MariaDB 的 `GET_LOCK('traffic-similarweb')` 保證同一時間只有一輪在跑。
- 哪些網域到期：
  1. 一次性查詢（blog）在提交後還沒得到回應；
  2. 定期清單（tag、試算表、手動等所有來源）本月 1 日（UTC，台北 08:00）之後還沒成功抓過：每個月初全部一起到期、一起排隊，沒有各自的週期；
  3. 定期清單裡還缺上個月 profile 的網域，每 3 天重試一次，直到 Similarweb 給出上個月的資料。
- 順序依 `TRAFFIC_PRIORITY`（預設 `tag,blog,sheet,manual`；`manual` 是編輯在 `/watch/` 手動加入的），抓過但還缺上個月資料的最優先（Similarweb 只給最新一個月的管道與國家，過了就抓不到），再來是從沒抓過的，最後是其他到期的；每組內依來源排序，再依最舊的成功時間。Similarweb 不一定同時給出每個網站的新月份，所以缺上個月的網域每輪只補抓「每輪上限 × 近一天（本月內）有流量回應的網域中已有上個月的比例」個，至少 1 個：月初還沒給出時每輪只抽查 1 個，給出的網站越多補抓越多，剩下還沒給出的網站不會佔滿額度。單次查詢的網域若 30 天內已抓過，直接以現有資料回覆，不再重抓。
- 失敗（沒有資料、錯誤）隔天重試；累積三次後等到下個月 1 日跟大家一起重抓。

容量估算：每小時 15 筆 × 24 = 360 筆／天。所有定期清單約 2,000 個網域每月各一次，月初一起排隊，大約 6 天排完；Similarweb 還沒給出上個月的網站會先少量抽查，給出後才加速。

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
- 「網址對照表」（`src/domain-sheet.ts`）是另一張 Google Sheet，取代程式裡的 `src/sheet-domains.ts`。版面照抄試算表最新的月份分頁（分頁名「YYYYMM 網址」，標籤 A／B、名次、網站名、網址、流量…，欄寬、顏色、凍結與隱藏欄不變），只把原本空白的「網址」格補上網域：淡黃底是 AI 查到並核對的（儲存格附註寫查證依據），橘底是 AI 也不確定的，紅底是還沒有網址的；網址寫「不追蹤」代表不對應任何網域（也不借用同名其他月份的網域）。只出現在更早月份的網站名放在「更早月份」分頁，另有「說明」分頁。系統只讀每個分頁的「網站名 → 網址」，其他欄與標籤改了不會有作用，標籤仍在本服務修改。匯入時對照順序為：月份分頁本身的網址 → 網址對照表 → `src/sheet-domains.ts` → 同名其他月份。設定 `TRAFFIC_DOMAIN_SHEET_ID`（表需開放「知道連結的人可檢視」）後，`tools/import-sheet.ts` 會一併讀取，也可用 `--domains file.xlsx` 讀本機檔；看不懂的網址會列出、不採用，並列出最新兩個月仍沒有網域的名稱數。`node tools/export-domain-sheet.ts --out 檔名.xlsx` 依目前的對照產生初版。2026-10-24 的初版：原表 1,414 個只有名稱的網站名中，854 個沒有網域，由 gpt-6.1-sol 分四輪查找（逐輪只重查前一輪不確定或查不到的），再經人工決定 25 筆，結果為已對應 1,391、不追蹤 21、待填 2（Findit、Misoro 康鮮）；202609 分頁就地補了 768 個，646 個在「更早月份」。以此表試匯入，原表本身有網址的列網域全部不變，最新兩個月有網域的網站由 964 個增為 1,516 個。查證紀錄（`review.csv`、`ai/`）、人工決定（`ai/decisions.json`）與合併腳本 `merge.mjs` 在 `data/domain-sheet-20261024/`。原表「Ambassador」對國賓影城，國賓飯店 `ambassador-hotels.com` 另以 `/watch/` 手動追蹤。
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
- 2026-10-24 起 `/table/` 有「比較」月份（`from`，預設前一個有資料的月份；成長、前期名次與各占比都和它比較）與兩個切換鈕：「數值」%／次數（`unit=count`：流量 × 比例換算的造訪次數）、「顯示」當月／差距（`show=change`：與比較月份相差幾個百分點或幾次造訪，排序也依差距）。流量之後依序是搜尋、AI、台灣，以及 Similarweb 的直接、社群、社群廣告、其他網站、郵件、展示廣告、搜尋廣告、聯盟八種來源（網頁表格不再另列搜尋S、AI 兩欄，切到「次數」即是；說明文字放在表格下方）；有當月組成但缺某來源時視為 0，沒有組成則留空。CSV 另含十種來源的占比、比較月份與差距；`/api/v1/rankings` 回傳 `from`、`channels`、`prevChannels`、`prevTaiwanShare`。跨網站比較只用表格；折線圖只在單一網站頁。
- `/table/` 完整數據與 CSV 下載（篩選不需 JavaScript，選項改變即重新載入）、`/tag/` 跨月份標籤概況（舊網址 `/topics/` 以 301 轉到 `/tag/`，保留查詢字串）、`/site/<domain>/` 單一網站歷史、`/status/` 抓取狀態。
- `/tag/` 使用各網站目前的名稱與標籤，按網域去重統計所有網站，包含尚無流量的網站；累計造訪量加總所有已知月份，不提供月份選單或月成長欄。搜尋與 AI 占比分別只以有該項資料的網站月份為分母加權，缺值不補零。總覽有摘要卡、標籤雲（字級依累計造訪或網站數的排名，可切換）與標籤表（含每站平均與流量最大的三個網站）。`/tag/?topic=` 顯示該標籤的摘要、流量集中度（最大網站與前 5 大占比）、常一起出現的標籤，以及完整網站清單；清單有「月平均」欄，供資料月數不同的網站比較。
- API 說明在 `/api/`（照 tag.observe.tw/api 的格式：使用規則、快速開始、端點一覽，每個端點附參數、範例與回應欄位）。端點清單只寫在 `src/api-docs.ts` 一處，同時產生說明頁、`/api/v1/` 索引與 `/api/v1/openapi.json`（OpenAPI 3.1）。`/api/v1/*` 與 `/icon/*` 回應帶 `Access-Control-Allow-Origin: *`。
- 有 Similarweb 數字就用 Similarweb；沒有的月份或網域用試算表數字，並標「表」。Similarweb 回傳 0 表示該月沒有估算（2026-10-24 查 238 個網域有這種月份，大多是小部落格；tw.news.yahoo.com 三個月都是 0），原值照存，但頁面與 API 視同沒有 Similarweb 數字：改用試算表，沒有就不列入該月，該月的 Similarweb 搜尋、AI、台灣占比也不採用；網站頁的 Similarweb 欄顯示「無估算」。`/internal/v1/traffic` 仍回傳原始數字。
- 免費端點沒有估算的大網站，可以從 Similarweb 平台（pro.similarweb.com，免費帳號登入後只看得到最近一個月）手動補登（`src/manual.ts`，表 `manual_months`，每次異動寫進 `manual_months_log`）。補登數字排在 Similarweb 免費端點之後、試算表之前，頁面標「人工」，`/api/v1/history` 的來源欄為 2。編輯在網站的「人工補登」分頁（`/site/<domain>/manual/`，會顯示免費資料最近三個月有沒有估算，已補登的月份會自動帶入原值）輸入月份（最近三個月）、月造訪量（可貼 `60.10M` 這種寫法）、自然搜尋、Gen AI 與台灣占比（百分比，可留空）。`/status/` 列出需要補登的網域：最近一次抓取每個月都是 0、且試算表曾記錄 100 萬次以上造訪，或已有補登紀錄。2026-10-24 確認 tw.news.yahoo.com 在平台上有資料（9 月 60.10M、自然搜尋 36.45%、Gen AI 0.37%、台灣 61.57%），與試算表數字相同；平台的內部 API 有 CloudFront 防護，直接呼叫會回 403，因此不做自動抓取。月排行的匯入標籤取試算表裡該網域截至該月最新一個月份的所有列（A、B 欄），網站資料覆寫優先；沒有標籤的網域不列入任何標籤，也不另設「未分類」。

2026-10-24 00:14（台北時間）跨月份標籤概況已重啟 web 上線。正式站列出 63 個標籤，對 1,429 個已知網域逐標籤核對成員數與累計流量一致；統計涵蓋 202412 至 202609 的 20 個有流量資料月份。舊 `/topics/?month=` 連結顯示相同的跨月份彙整；手機 390px 畫面無頁面溢出，標籤內網站數與實際清單一致。型別、lint、既有與新增測試通過。此次修改前的檔案備份與正式站核對結果在 `data/topics-aggregate-20261024/`；本次沒有改寫網站名稱、標籤或流量資料。

篩選 chip：標籤按一下只看、再按一下排除（紅色「−標籤」，可同時排除多個）、第三下取消；「全部標籤」清除所有標籤條件。流量總覽與完整數據預設排除「非台灣」（網址沒有 `exclude` 參數時），`exclude=` 留空代表不排除；`/api/v1/rankings` 與 CSV 不套預設，需明確傳 `exclude`。排除後名次在剩下的網站之間重新計算。

網站 icon（`src/icons.ts`）：`/icon/<網域>` 只回應本站已知的網域，第一次請求時由伺服器向 Google favicon 服務（`s2/favicons?sz=64`）抓一次，存在 `data/icons/`（可用 `TRAFFIC_ICON_DIR` 改位置），30 天後更新；Google 沒有圖示的網域記為 `.none`，7 天後再試。同時最多 6 個對外請求。訪客只連本站，不直接連到 Google；沒有圖示時顯示名稱的第一個字。

全站固定使用黑色主題，共用表格沿用 [tag.observe.tw/media/traffic](https://tag.observe.tw/media/traffic) 的緊湊樣式。版面參照 [tag.observe.tw/media](https://tag.observe.tw/media/)：頁首是「流量排行」「標籤概況」「抓取狀態」「追蹤網域」；流量排行的兩個檢視（流量總覽／完整數據）與網站的流量資料／名稱與標籤／人工補登，在標題上方以藥丸子選單切換。標題下一行是說明與「本頁的資料來源與計算方式」連結（開啟頁尾上方的收合說明），接著是摘要卡、搜尋與月份、篩選 chip 列（全部來源／各來源、全部標籤／各標籤附數量，標籤超過 15 個時其餘收在「更多」），最後是表格。網站與標籤管理、API 與資料來源放在頁尾。

表格（`src/tables.js`）：每列一行，名稱與網域同列顯示，相同時省略網域；橫向捲動時固定識別欄，垂直捲動頁面時表頭保持可見。伺服器產生的表格加 `data-sortable` 即可點表頭排序（數字先由大到小、名次與文字先由小到大，空值永遠排最後；顯示值與排序值不同時用 `data-v`），搜尋框用 `data-table-filter="<table id>"`。超過 50 列的表格先顯示 50 列，按「瀏覽更多」後隨捲動自動載入；排序、搜尋或篩選改變時回到前 50 列。首頁排行用同樣的規則。

2026-10-24 04:47（台北時間）重啟 web 上線介面改版：版面改照 tag.observe.tw/media（頁首兩個入口、標題上方子選單、摘要卡、篩選 chip 列，已選的 chip 再按一次即取消）、所有表格可排序並以 50 列為單位「瀏覽更多」、造訪量 k／m／b 四位有效數字、`/topics/` 改為 `/tag/`（301 轉址，sitemap 同步）、首頁點網站直接進網站頁、Similarweb 回傳 0 視為無估算、網站頁的「名稱與標籤」「人工補登」分頁。`0005_manual_months.sql` 已於同日先行套用（只新增兩張空表）。04:49 再上線 chip 取消選取的修正。型別、lint 與 45 項測試通過；本機與公開站的各頁、`/healthz`、`/api/v1/history`、`/sitemap.xml` 皆 200，`/topics/` 301 至 `/tag/`，HTML 引用新的 CSS 雜湊。上線前的檔案備份在 `data/ui-redesign-20261024/before/`（新增檔案列於 `NEW_FILES.txt`），chip 修正前的版本在 `before-chip-toggle/`；回復時把備份檔複製回原位、刪除新增檔案，再重啟 web 服務（兩張新表可保留，舊程式不會讀取）。上線後 202609 排行由 1,162 個網站變為約 980 個，差額是 Similarweb 回傳 0、又沒有試算表數字的網站。

2026-10-24 05:25（台北時間）重啟 web 上線：標籤 chip 改為「只看／排除／取消」三段、流量總覽與完整數據預設排除「非台灣」（API 不套預設）、修正排序或「瀏覽更多」時排除條件失效、網站 icon（`/icon/<網域>`，快取於 `data/icons/`）、頁首加入抓取狀態與追蹤網域、API 說明頁 `/api/` 與 `/api/v1/openapi.json`、公開 API 加 CORS。型別、lint 與 48 項測試通過；本機與公開站各頁及 API 皆 200，`/icon/` 對未追蹤網域回 404，完整數據預設為「排除 非台灣・916 個網站」，`/api/v1/rankings` 仍回 986 個網站。上線前的檔案在 `data/ui-redesign-20261024/before-exclude-icons-api/`（新增檔案列於 `NEW_FILES.txt`）；回復時把備份檔複製回原位、刪除新增檔案，再重啟 web 服務。

## 搜尋引擎（`src/seo.ts`）

公開與私人的界線不因 SEO 改變：公開頁面與 API 照舊不需登入，`/watch/` 的寫入、`/sites/`、編輯頁仍需登入，`/internal/*` 仍只接受本機加 token。

- 可索引：`/`、`/table/`、`/tag/`（附 description 與不含查詢字串的 canonical），以及有資料的 `/site/<domain>/`（canonical 為正規化後的網域）。
- 其他回應一律帶 `X-Robots-Tag: noindex`，HTML 另加 `<meta name="robots" content="noindex">`：`/status/`（抓取紀錄）、`/watch/`、`/login/`、`/sites/`、編輯頁、`/api/*`、錯誤與所有未知路由。未知路由維持 Fastify 原本的 404，不導向首頁。
- `/robots.txt` 只擋 `/internal/` 與 `/auth/`。`/api/` 不擋，因為 `/` 在瀏覽器端讀 `/api/v1/history`，擋掉會讓搜尋引擎算繪出空白頁；API 改以 noindex 標頭排除。
- `/sitemap.xml` 只列 `/`、`/table/`、`/tag/` 三頁；網站頁靠內部連結被發現，不列入。網址前綴取 `TRAFFIC_PUBLIC_ORIGIN`。
- `http://` 由 Cloudflare 規則 308 轉到 https 的同一路徑與查詢字串，本服務不處理（規則由 Codex 部署，不在本 repo）。
- `/watch/` 匿名可讀，表格顯示網域、備註與加入時間；加入者（`added_by`，編輯的 email）2026-10-25 起只顯示給登入的編輯。

2026-10-23 17:51（台北時間）以 `545f2c8` 重啟 web 服務上線（工作樹同時包含當時已上線、尚未提交的網站名稱與標籤管理改動）。公開站匿名實測：`/`、`/table/`、`/topics/`、`/site/udn.com/` 200 且 canonical 正確，帶查詢字串時 canonical 不含查詢字串；`/status/`、`/watch/`、`/login/`、`/api/v1/`、`/api/v1/history` 200 加 noindex；`/sites/`、編輯頁 303 到登入；`/nope-x1`、`/table`、`/index.html`、不存在的網站與 `/internal/*` 皆 404 加 noindex；`/robots.txt`、`/sitemap.xml` 200。可提交 Google 的 Sitemap：`https://traffic.observe.tw/sitemap.xml`，共 3 個網址。提交不代表已索引。回復方式：移除 `src/app.ts` 的 `registerSeo(app)` 與其 import，再重啟 web 服務。

2026-10-23 Google 與 Cloudflare 端（Codex 處理）：Search Console 新增 `https://traffic.observe.tw/` 資源並自動驗證，`sitemap.xml` 狀態 Success、讀到 3 個網址；18:12 實測 `GET http://traffic.observe.tw/table/?gsc_check=20261023` 回 308，轉到 https 的同一路徑與查詢字串。Sitemap 成功只代表 Google 讀得到，不代表頁面已被索引。

## 登入與手動追蹤（`/watch/`）

用 Google 登入（`src/login.ts`，從 tag 的 `app/src/auth/google-login.ts` 簡化而來），OAuth client 與 tag 共用。2026-10-24 起任何驗證過 email 的 Google 帳號都會拿到 session（30 天，cookie `traffic_session`，資料庫只存 SHA-256），用來對標籤投票；只有 `TRAFFIC_ADMIN_EMAILS` 名單上的帳號是編輯，可以管理網域、名稱、標籤清單與單一標籤的覆寫。名單每次請求都會重新比對，從名單移除後編輯權限立刻失效。非編輯開啟編輯頁會看到 403 說明。看公開頁面不需要登入。

| 變數 | 說明 |
| --- | --- |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 與 tag 相同。兩個都沒設時關閉登入。 |
| `TRAFFIC_PUBLIC_ORIGIN` | 預設 `https://site.observe.tw`。callback `$TRAFFIC_PUBLIC_ORIGIN/auth/google/callback` 必須登記在 OAuth client 的「已授權的重新導向 URI」。 |
| `TRAFFIC_ADMIN_EMAILS` | 逗號分隔，可以手動加入或移除網域的編輯。 |

`/watch/` 可以一次貼多行網域或網址，並附上備註；和其他定期清單一樣每月更新。這些網域以請求者 `manual` 存進 `watches`，記下 `added_by`，每次加入或移除都寫進 `watch_log`。表單只接受本站 `Origin` 送出的 POST。移除只會停止抓取，已經抓到的資料會保留。

## 網站技術（`/tech/`）

2026-10-25 從 blog.observe.tw 的 `/tech/` 搬過來，範圍擴大到所有網域。blog 以前只看自己爬蟲已經拿到的頁面；這裡改成自己去抓每個網域的首頁，blog 不再自己偵測，改讀 `POST /internal/v1/tech`。

- **範圍**：各服務的定期清單（`watches` 的 `kind = 'watch'`）加上試算表的網域，2026-10-25 共約 1,950 個。其他網域可以在 `/tech/` 查詢；登入的人可以在 `/tech/<domain>/` 按「立即檢查」（每個帳號每小時 10 次，同一網域 10 分鐘內不重抓），結果會保存，但不會進入排程。
- **排程**（`runTech`）：worker 每小時跑完 Similarweb（和 Radar）那輪之後，最多抓 `TRAFFIC_TECH_BUDGET`（預設 60，0 為關閉）個首頁，一次一個、間隔 1 秒，最長 8 分鐘，`GET_LOCK('traffic-tech')`。順序是從沒檢查過的、從 blog 匯入但我們還沒抓過的，再來是最舊的。成功的結果 30 天後重抓；失敗依次等 1、2、4…天，最多 30 天。worker 收到停止訊號時會在下一個網域前停下。
- **怎麼抓**：一個首頁一個 GET，user agent 和 tag 的爬蟲一樣是桌面版 Chrome，**不讀 robots.txt**（2026-10-25 使用者決定：第一輪 60 個首頁裡有 7 個被防火牆擋下，一個月抓一次公開首頁也和讀者用瀏覽器打開一樣；在那之前抓的紀錄可能有 `robots` 錯誤碼）；依序試 `https://<網域>/`、`https://www.<網域>/`、`http://` 兩個，連不上才換下一個（網域存的是去掉 www 的名稱，gov.taipei、hilife.com.tw 這類只有 www 有 DNS）；回應標頭上限放寬到 64 KiB（hk.finance.yahoo.com 超過 Node 預設的 16 KiB）。最多轉址 5 次。每個連線的 DNS 結果都必須是公開位址（私有、loopback、link-local、CGNAT 等一律拒絕），只用 80／443 埠。每頁最多讀 512 KiB，每次請求 15 秒逾時，每個網域總共 40 秒。依 `Content-Type` 或 `<meta charset>` 解碼（含 Big5）。
- **被擋時改用瀏覽器**（`src/tech-browser.ts`）：首頁回防火牆驗證頁或 429 時，用 Playwright 的 Chromium headless shell（`playwright-core` 1.64.1，對應 `~/.cache/ms-playwright/chromium_headless_shell-1248`）再試一次，讓驗證頁的 JavaScript 跑完；拿到頁面就用這次的結果。頁面發出的每個請求都要通過同樣的公開位址檢查，圖片、影音、字型與 CSS 不載入。瀏覽器只在需要時啟動，worker 每輪結束、`/tech/<domain>/` 每次檢查完就關掉。2026-10-25 第一輪被擋的 9 個網域裡，這樣讀到了 7 個（另外發現 Cloudflare 會在一般頁面也放 `/cdn-cgi/challenge-platform/` script，之前把它誤判成驗證頁，104.com.tw、94i.in 其實讀得到）；25sprout.com、allabout-japan.com 仍然被擋。
- **偵測**（`src/tech.ts`）：比對 Wappalyzer 規則裡 `VOCABULARY` 列出的 143 項技術；blog 原本的 36 項 id 不變。實作沿用 blog 的作法：規則資料（GPL-3.0，enthec/webappanalyzer）不進 repo，`data/wappalyzer-pin.json` 記下 commit 與每個檔案的 SHA-256，`node tools/fetch-wappalyzer-rules.ts` 下載到 `TRAFFIC_WAPPALYZER_RULES_DIR`（預設 `~/.local/share/traffic-observe/wappalyzer/<commit>/`），雜湊不符就拒絕載入；`--check` 列出規則資料已經沒有的技術名稱，`--update` 抓最新版並印出新的 pin。比對器是自己寫的（MIT），不評估 js、css、cookies、xhr、dns、implies／excludes 與 dom 文字。每頁有 250 ms 的比對預算，長字串分段比對，`test/tech.spec.ts` 會拿所有編譯後的規則跑惡意輸入。**規則沒裝好時排程不抓**，以免每個網站都被記成「未辨識」。
- **結果**（`tech_scans`，migration `0007_tech.sql`）：每個網域一列。`status`、`error_code`、`http_status`、`last_attempt_at` 描述最近一次嘗試；`observed_at`、`source_url`、`rule_version`、`detections` 是最近一次成功的結果，之後失敗也保留。較舊的嘗試不會蓋掉較新的。`origin` 是 `traffic`（自己抓的）或 `blog`（匯入的）。版本只從 `meta generator` 來，互相矛盾時是 `unknown`；CDN 與主機的信心最多 0.4；依據只寫規則類別（例如 `script URL rule`），不存頁面內容。每輪的統計在 `tech_runs`。
- **頁面與 API**：`/tech/`（依來源、類別、結果篩選，技術排行與網站清單）、`/tech/<domain>/`（單一網域，任何網域都可查）、網站頁的「網站技術」區塊、`/api/v1/tech`、`/api/v1/tech/{domain}`。
- **匯入 blog**：`node --env-file=.env --env-file=$HOME/.config/blog-observe.env tools/import-blog-tech.ts [--dry-run]` 唯讀複製 blog `blog_tech_scans` 裡已驗證部落格的最後一次成功結果，以 `canonical_host` 為網域、`origin = 'blog'`；已經被我們自己抓過的網域不動，不在清單裡的技術會丟掉。可重複執行。

## 服務 API（`/internal/*`）

只接受直接連到 loopback、沒有 `cf-connecting-ip`、`x-forwarded-for`、`tailscale-user-login` 等轉送 header 的連線，並且要帶 `Authorization: Bearer <token>`。token 從 `TRAFFIC_TOKEN_<請求者>` 讀，至少 32 字元，token 決定請求者是誰。不符合一律回 404。

| 路由 | 用途 |
| --- | --- |
| `POST /internal/similarweb/requests`、`GET /internal/similarweb/results?domain=` | 一次性查詢。與 tag 原本提供給 blog 的格式相同（tag `docs/similarweb-requests.md`），blog 不用改程式 |
| `PUT /internal/v1/watch` | `{ domains: [...] }`：用這份清單**取代**該請求者原本的定期清單（定期清單一律每月更新；舊版送來的 `refreshDays` 會被忽略） |
| `POST /internal/v1/watch/add` | `{ domains: [...], note? }`：把網域**加進**該請求者的定期清單，最多 200 個，清單其他部分不變 |
| `POST /internal/v1/watch/remove` | `{ domain }`：從該請求者的定期清單移除一個網域 |
| `POST /internal/v1/traffic` | `{ domains: [...] }`：回傳這些網域存下的所有月份與 profile，以及抓取狀態，給要鏡像資料的服務（tag）用 |
| `POST /internal/v1/tags` | `{ domains: [...], voter? }`：每個已知網域的所有標籤（含未顯示的）與來源、票數；帶 `voter`（讀者的 Google email）時另回該讀者的票與是否為管理員 |
| `POST /internal/v1/tags/vote`、`/propose`、`/admin` | `{ voter, domain, tag, vote: 1 \| -1 \| 0 }`、`{ voter, domain, tag }`、`{ voter, domain, tag, action: set \| hide \| release }`：代讀者投票、新增標籤、管理員覆寫；回傳該網域更新後的標籤 |
| `PUT /internal/v1/tags/ai` | `{ sites: [{ domain, tags: [標籤 \| { tag, reason? }], reason? }] }`（最多 500 個）：以這份清單**取代**該服務對這些網域的 AI 初判；每個標籤可以各帶理由，沒有時用網站的 `reason`；未知網域列在 `skipped`，政治傾向的標籤直接略過 |
| `POST /internal/v1/tech` | `{ domains: [...] }`（最多 2,000 個）：每個檢查過的網域的技術紀錄（`sites`，與 `/api/v1/tech/{domain}` 相同），沒檢查過的列在 `notChecked`，另附目前的規則版本 `rules` 與最近一輪 `lastRun` |
| `POST /internal/v1/tags/voters` | `{ voters: [email...], via? }`（最多 500 個）：每位投票者目前有效的票數與最後投票時間；`via`（例如 `blog`）只算經該服務投的票 |

## 從 tag 接手（順序很重要，兩邊絕不能同時打 Similarweb）

1. 本服務先以 `TRAFFIC_RUN_BUDGET=0` 上線，跑 `tools/import-tag.ts` 和 `tools/import-sheet.ts`。（2026-10-21 已在本機完成匯入：tag 304 個網域、912 個月份、304 份 profile、blog 300 筆查詢，以及試算表 20 個月份共 10,662 列。）
2. 在 tag 的 `.env` 設定 `TAG_TRAFFIC_SERVICE_URL=http://127.0.0.1:18150` 和 `TAG_TRAFFIC_SERVICE_TOKEN`（值與本服務的 `TRAFFIC_TOKEN_TAG` 相同），部署含 `app/src/media-traffic/service.ts` 的版本：
   - tag 的 `media-traffic` job 改成登記網域並鏡像資料，不再送 Similarweb 請求；
   - tag 的 `/internal/similarweb/*` 原封轉送到這裡（blog 的 token 兩邊相同）。
3. 確認 tag worker 這一輪顯示 `via: traffic.observe.tw` 以後，才把本服務的 `TRAFFIC_RUN_BUDGET` 改成 15，重啟 worker。
4. 回滾：先把本服務的 budget 改回 0，再移除 tag 的兩個設定並重啟 tag。

2026-10-21 20:00（台北時間）已完成接手：tag `771a4ebc` 的 API、gateway、worker 都已上線，回滾腳本在 `~/tag-analysis-private/f1-release/traffic-service-771a4ebc-20261021/rollback.sh`；本服務 budget 為 15。blog worker 改為直接呼叫本服務（blog `b195eb8`，drop-in `blog-observe-worker.service.d/96-traffic-b195eb8.conf`）。blog gateway 的管理頁查詢仍經 tag 轉送，等 blog 下次發版就會改成直連。

## 流量查看權限

登入 `TRAFFIC_ADMIN_EMAILS` 名單中的管理員（sky9109@gmail.com、genehong@gmail.com）可查看完整精確度、所有國家與導流來源，筆數不受限制。其他使用者不論是否登入，均只提供兩位有效數字、台灣占比與自然搜尋／直接／連入／社群／AI 五項來源；每次篩選最多 30 個網站，不提供載入更多。頁面、JSON API、CSV 使用相同規則，回應不共用快取。

## 部署

systemd user unit 在 `deploy/`（複製到 `~/.config/systemd/user/` 後 `systemctl --user enable --now`，2026-10-21 已啟用）。公開網址 `site.observe.tw`（舊址 `traffic.observe.tw` 轉址）經 Cloudflare Tunnel（observe-steamos）指到 `http://127.0.0.1:18150`；經 tunnel 進來的請求帶 `cf-connecting-ip`，所以 `/internal/*` 一律 404。

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

登入 `TRAFFIC_ADMIN_EMAILS` 名單內帳號後，網站頁上方會出現「流量資料／名稱與標籤／人工補登」分頁，也可從 `/sites/` 批次管理。標籤編輯器把已選標籤列成可移除的標籤，輸入文字會列出符合的既有標籤（依使用次數排序）並可新增，下方列出最常用的標籤可一鍵加入；儲存後留在同一頁並顯示「已儲存」。單站支援名稱修改、多標籤新增與移除；管理頁可搜尋、依標籤篩選、勾選最多 200 個網域批次加減標籤。網域不在這個表單修改，以免接錯歷史流量。

人工值存入 `site_metadata`，原始 `sheet_rows` 保留不動。人工標籤取代該網站的匯入標籤（包含手動清空）；名稱留空時沿用表格名稱。人工值套用至網站各月份的標籤，表格原始逐月紀錄仍可查看。重新匯入不會蓋掉人工值。每次修改記錄於 `site_metadata_log`；單站儲存檢查版本，批次更新使用交易與資料列鎖，成功後清除排行及歷史 API 快取。

地區、主題與網站類型統一以一般標籤管理，沒有獨立地區欄位、互斥規則或自動地區判定。「台灣」「非台灣」與其他標籤採用相同的新增、移除和篩選流程；所有符合篩選條件的網站都按流量排名。台灣流量占比仍是原始流量指標，不用來判定標籤。

首次部署本功能須先執行 `npm run db:migrate` 套用 `0004_site_metadata.sql`，再重啟 web 服務。

2026-10-23 20:40–20:42（台北時間）完成 1,429 個網域的逐站名稱與標籤核對，寫入 1,415 筆 `site_metadata` 及同數量的異動紀錄；其中 1,237 個名稱、1,239 個網站的標籤有變更，14 筆身分無法確認的紀錄保留原值。只顯示網域的紀錄由 560 筆降為 9 筆，無標籤由 480 筆降為 4 筆。`taiwan.net` 實際為網域停放頁，已移除誤掛的觀光署名稱與標籤。網站不顯示編輯者類型標示。

逐站證據、更新清單、更新前備份、異動 CSV 與例外清單存於主機的 `data/site-review-20261023/`（未納入 Git）；入口為 `review-report.md`，交易備份為 `production-backup.json`。本次只更新網站資料，交易前後的 `traffic_months`、`traffic_profiles`、`sheet_rows`、`radar_ranks` 筆數與 SHA-256 均一致。重啟 web 後，本機與公開站皆通過健康及頁面檢查，1,404 個歷史網站、202609 的 1,084 個排行網站之名稱、標籤與流量逐筆比對一致。型別與 lint 檢查通過；測試初次遇到逾時，依序執行並延長逾時後 34 項全數通過。

2026-10-24 00:44（台北時間）依使用者指定的 Google Sheet `202609` 分頁重新套用 A、B 欄標籤；同網域所有列合併去重，保留原表標籤文字。有定義且可確認對應的 965 個網站中，777 個更新、188 個原本一致；其餘 464 個網站保留原值，其中 27 個是只有空白 A/B 的已對應網域。來源 1,530 個有標籤的列完整讀取，979 列已對應，另 547 列無可確認的既有網域、4 列有身分歧義，未強行套用或新增網域。修正「就是教不落」「小氣少年」「塔科女子」「布雷克」的對應，避免把標籤貼到同名或錯誤網址的網站。

這次只改目前標籤，所有名稱、歷史流量、試算表原始列、Radar 與追蹤清單保持不變，新增 777 筆異動紀錄。網站明細原表欄位改稱「標籤 A／標籤 B」，CSV 改稱「原表標籤 A」；標籤頁維持跨月份彙整。重啟 web 清除快取後，本機及正式站的 1,409 個歷史網站、202609 的 1,137 個排行網站、58 個標籤與 2,852 個標籤成員關係全部比對通過；非 metadata 資料表筆數與 SHA-256 不變。型別、lint 與 37 項測試通過，手機 390px 無頁面溢出。備份、逐列對應、異動 CSV、未套用列與驗證結果在 `data/sheet-tags-202609-20261024/`，入口 `report.md`。這次更新取代前述 2026-10-23 審閱的部分標籤，舊審閱驗證腳本不可直接重跑。

2026-10-24 00:55（台北時間）依使用者澄清，九月表的完整標籤「內容」代表「內容農場」；已只對九月已確認範圍內的 48 個網域更名，保留其他標籤與順序。先前保留原值的 464 個網域完全未動，其中 13 個繼續使用原來的「內容」；「生活內容」仍是原本的 243 個網域，不做子字串替換或額外性質判定。新增 48 筆異動紀錄，名稱、流量及原始試算表歷史不變。重啟 web 後，本機與正式站完整核對歷史網站、九月排行、標籤統計及三個相關標籤的成員，全部通過。備份、更新範圍與驗證紀錄在 `data/content-farm-label-20261024/`；先前九月同步 manifest 保留當時原值，驗證目前標籤時應包含本次後續更名。

2026-10-24 01:05（台北時間）依使用者最新命名指示，九月試算表明列「生活內容」的 77 個已確認網域改用「生活內容農場」；其餘 166 個使用「生活內容」的網域改為「生活」。這 166 個是前次保留名單中的網站，本次只簡化標籤名稱，沒有賦予農場標籤；前次保留名單的其他 298 個完全不變。只替換完整標籤，其他標籤、順序、名稱及流量歷史不變，既有「內容農場」48 個與「內容」13 個成員保留。新增 243 筆異動紀錄，其餘 1,186 個網域 metadata 不變。重啟 web 後，本機與正式站完整核對歷史、排行、彙整及相關標籤成員通過；原始資料表筆數與 SHA-256 不變。備份與驗證紀錄在 `data/lifestyle-tags-20261024/`，本次更名接續前述九月同步及「內容農場」澄清。

2026-10-26 依使用者指示做了兩項調整。一，網頁排行可同時選多個標籤，需同時符合（AND）；`topic` 參數（網頁網址與 API）以逗號分隔多個標籤。二，標籤「生活內容農場」更名為「生活內容」、「內容農場」更名為「內容」，共 126 個網域，紀錄在 `data/tag-rename-20261026/`。三，名次與預設排序改依「台灣造訪量」（造訪量 × 台灣占比）：網頁表格與 `/table/` 新增「台灣造訪」欄，API 與 CSV 新增 `taiwanVisits`；沒有台灣占比的網站（九月約 139 個）排在最後，彼此仍依造訪量排序。標籤概況（`/tag/`）的累計造訪量排序不變。


## 品牌標誌（2026-10-26）

「臺灣流量觀察站」（2026-10-27 更名為「網站雷達」）採觀測環、流量刻度與橘色訊號點，中文字標為 Noto Serif CJK TC SemiBold，延續 tag.observe.tw、blog.observe.tw 的宋體風格。橫式、直式、深淺底、單色 SVG 與透明 PNG、favicon、Apple／應用程式圖示在 `assets/brand/`，使用規範與字型授權同目錄；離線展示與整套 ZIP 在 `docs/brand/`。`tools/brand-assets.py` 可重產素材。

頁首頁尾共用 `src/brand.ts` 的字標，所有頁面及 API 文件統一名稱。`/brand/:name` 僅提供固定清單中的素材；字標、SVG／ICO favicon 與 Apple 圖示均使用內容雜湊網址，避免 CDN 或瀏覽器沿用舊版本。另保留 `/favicon.ico` 與 `/apple-touch-icon.png` 慣例路徑。

2026-10-26 15:19（台北時間）已重啟 web 服務上線。型別、lint 與 81 項測試通過；本機及公開站各 12 個路由（含健康、歷史 API 與各主要頁面）、24 份圖像素材與兩個圖示慣例網址核對通過，頁面品牌與 CSS 雜湊一致。正式站 1280px 桌面及 390px 手機版無頁面溢出，頁首／頁尾字標載入正常。未執行資料庫 migration 或重啟 worker。

部署前版本、檔案清單、線上核對結果及桌面／手機截圖在 `data/brand-release-20261026-151656/`；回復時將 `before/` 內檔案複製回對應位置、移除新增的 `src/brand.ts`，再重啟 web 服務。


2026-10-26 15:38（台北時間）依使用者選定的 C 版再次上線：橫式字標移除網址，中文為 30px、依實際字形垂直置中，整組約 274×54px；320px 手機自動縮至 244px 寬。直式同步移除網址並放大中文，深淺底及單色 SVG、透明 PNG、離線展示與 ZIP 全部更新。最終橫式 PNG 與選定的 C 預覽逐像素一致。原 A／B／C 預覽存於 `docs/brand/previews/` 作為設計紀錄。

型別、lint 與 81 項測試通過；320px、390px、1024px（含登入列）及 1280px 版面無溢出，正式站頁首頁尾載入新的 Logo 與 CSS 雜湊。備份與發布核對在 `data/brand-c-release-20261026-153633/`；還原其 `before/` 內檔案並重啟 web 可回復前一版。

2026-10-26 台灣占比估算（`src/taiwan-estimate.ts`）：Similarweb 沒有台灣占比的網站，名次與排序依序採用 ①編輯者在試算表名稱尾巴寫的「/N」（1/N，取最近一個月；這些列的流量仍不當造訪量）②該站較早月份的占比 ③Similarweb 前 5 大國家推出的上限（台灣不在前 5 名，所以不超過第 5 名，也不超過 100% 減前 5 名）。①②若高於上限（含 10% 容許）視為與 Similarweb 自己的國家資料矛盾，改用上限並標 `taiwanCapped`。表格以「≈」標估算、「<」標上限，游標停上去看依據；API／CSV 有 `taiwanShareUsed`、`taiwanBasis`（measured／manual／history／bound）、`taiwanShareMax`，`/api/v1/history` 每月陣列增為九格。Similarweb 的國家資料目前只存在最新一個月，所以上限只有該月算得出來。以上限排序是刻意的保守選擇：它不低估台灣流量，但外國大站（msn.com、bbc.com）會比實際高。九月結果：實測 1,379、上限 84、較早月份 28、編輯者 1/N 7、都沒有 43（合計造訪量 0.6m，排最後）；有兩個編輯者估算被上限蓋掉（news.yahoo.co.jp、xinhuanet.com）。

補登渠道：表單支援 Direct、Referral、Organic/Paid Social、Paid Search、Email、Display Ads、Affiliate，加上原有 Organic Search 與 Gen AI。渠道皆選填，空白是未知，0 是明確填寫的零；補登月份的渠道提供給完整數據排行、API 與 CSV，免費估算仍優先。`0008_manual_channels.sql` 新增可為 NULL 的 JSON 欄位，保留既有補登及稽核紀錄；部署前先執行 `npm run db:migrate`，再重啟 web。Redirect 不作為獨立流量渠道。

平台補登亦支援跳出率、每次造訪頁數、停留秒數（或時:分:秒）、全球/國家/分類排名及國家占比；平台明細含 Social、Referral 來源網站/產業、連出目的地/廣告主、Display 刊登網站。列表每行 `名稱 | 占比 | Change（選填）`，`?` 表示平台未公開名稱；保留 `<0.01%`、`>5000%`、`New`，各列表依其分母保存，不與全站渠道比例混用。Social 總占比獨立，不推定為自然社群。明細儲存在 manual_months.details JSON，修改前後值亦留在 manual_months_log。網站 API 的 manualProfiles 保留全部補登月份，免費資料仍優先使用，但不會遮掉平台獨有明細；未授權訪客不回傳 manualProfiles/breakdowns。

2026-10-26 23:02:55（台北時間）完成平台完整補登與協作標籤 UI 上線：套用 `0008_manual_channels.sql`，重啟 web（worker 不需重啟）。typecheck、lint、119 tests、diff --check 通過；1280px/390px 補登表單與平台明細無橫向溢出，全部新欄位切換月份可還原。正式及本機首頁/健康/網站頁/網站API皆200，未登入補登頁303至登入；重啟後無錯誤。正式 manual_months/log 上線前後皆0列，未代填示例資料。發布程式快照及空表備份：`data/manual-full-release-2026-10-26T15-02-31-993Z/`。

2026-10-26 23:12（台北時間）人工補登版面更新：全站名稱/來源標記由 Pro 改為人工補登/人工，說明使用個人 Similarweb 帳號即可，不暗示付費方案。補登表單及狀態說明移除卡片底色/外框，表單使用全寬；桌面來源/排名4欄、平台明細2欄，手機單欄。typecheck、lint、119 tests與diff檢查通過；1440px/390px預覽無溢出，正式站健康與新CSS正常。回復檔案位於 `data/manual-flat-20261026T151030Z/before/`，還原src檔案再重啟web即可，無資料庫異動。

2026-10-26 23:24:50（台北時間）可互動標籤統一膠囊樣式：單站/批次picker、投票/管理員顯示隱藏、各頁連結標籤與共現/標籤雲沿用篩選chip的灰底/橘色選取/紅色負向狀態。投票以標籤及同意/不同意票數為一組膠囊，保留AJAX與撤回；未選灰色，批次移除使用紅色及減號。typecheck、lint通過；首次全套119項中的DB初始化遇到主機負載逾時，延長hookTimeout至60秒重跑DB16項全部通過，其餘103項通過。桌面1280/手機390實測選取、批次移除、同意→不同意→撤回、admin狀態色皆正常且無溢出。正式首頁/網站頁/標籤概況/health皆200並載入新CSS；備份 `data/tag-pills-20261026T151936Z/before/`，還原src檔案並重啟web即可回復。

2026-10-26 23:55（台北時間）表格標籤欄改為獨立橫向捲動，提供細捲軸、鍵盤焦點及無障礙標示；保留單列膠囊與連結。390px/1280px 驗證可捲到末端且外層表格位置不變、頁面無溢出。typecheck、lint、123 tests 與 diff 檢查通過，重啟 web 後正式站 CSS/JS 及 healthz 核對正常；未執行 migration。變更前 CSS/JS 在 data/tag-scroll-before/。


## 網站雷達更名與網域切換（2026-10-27）

品牌改為「網站雷達」，正式網址 `https://site.observe.tw`，涵蓋網站技術、流量、相似網站及協作分類。Logo 延用 C 版宋體與圖形，四字橫式為 182.9×54px，中文字仍為 30px；新素材包為 `docs/brand/site-radar-logo-kit.zip`，舊素材包與 A/B/C 預覽保留為歷史紀錄。展示頁由 `python tools/brand-showcase.py` 重產。

程式預設來源改為新網域。切換前正式 `.env` 暫留 `TRAFFIC_PUBLIC_ORIGIN=https://traffic.observe.tw`，現有網域與 Google 登入可繼續使用；這時僅發布新品牌，不代表新網域已上線。切換條件與順序：

1. Cloudflare Tunnel `observe-steamos` 新增公開 hostname `site.observe.tw` → `http://127.0.0.1:18150`，保留 `traffic.observe.tw` 路由；建立對應 DNS，確認 HTTPS 可用。新網域應沿用 HTTP → HTTPS 轉址。
2. 既有 Google Web OAuth client 新增 `https://site.observe.tw/auth/google/callback` 為已授權重新導向 URI；保留舊 callback，避免影響其他 observe.tw 站台。僅登入所需的 openid/email/profile，未新增 GSC、GA 或 GTM 匯入。
3. `.env` 將 `TRAFFIC_PUBLIC_ORIGIN` 改為 `https://site.observe.tw`，重啟 `traffic-observe-web.service`。不需 migration，不需重啟 worker。
4. 驗證新站首頁、API、canonical、robots、sitemap 與 Google 登入；舊 host 對公開路徑回 308，保留原 path/query。loopback 與 `/internal/*` 保留既有行為。Session cookie 為 host-only，換網域後使用者需重新登入。
5. Google Search Console 新增新網址資源、提交 `https://site.observe.tw/sitemap.xml`，再於舊資源完成網址變更（管理權限就緒後執行）。

保留現有 checkout 路徑、systemd unit 名稱及 `TRAFFIC_*` 設定名稱，以相容本機服務。回復網域切換：將 `.env` 的公開來源改回舊網址，再重啟 web；`src/origin.ts` 會自動停用舊 host 轉址。原版程式與環境設定備份位於 `data/last-site-radar-release.txt` 指向的私有目錄。


2026-10-27 03:53（台北時間）新品牌已發布到現有 `traffic.observe.tw`：頁首頁尾、標題、API 文件與 Logo 更新，T3 專案名稱亦改為「網站雷達」。本機與正式首頁皆 200、無舊品牌文字；canonical 與 Google callback 仍為舊網域，未啟用舊站轉址。桌面 1280px、手機 390px 無頁面橫向溢出；typecheck、lint、遷移與 SEO 15 項測試通過。完整套件初次 130 項通過、1 項 Radar 測試因 MySQL 全伺服器 named lock `traffic-radar` 已由另一連線持有而失敗，單項重試相同；未中斷持鎖程序。

使用者將自行處理 Cloudflare 與 Google 管理端設定，明確要求待通知後才切換正式來源或啟用舊站轉址。現有 Tunnel `observe-steamos`，ID `f6342ca7-0e3b-4998-8971-f8f1837d37e9`（從執行中的 connector 驗證），目前 ingress `traffic.observe.tw` → `http://127.0.0.1:18150`。OAuth client 所屬 project number 為 `453403068137`；控制台的專案／client 顯示名稱尚未驗證。勿將 analytics service account 的專案視為已確認的 OAuth 專案。


2026-10-27 03:59（台北時間）管理端設定經使用者確認後，正式 `.env` 的 `TRAFFIC_PUBLIC_ORIGIN` 已切換為 `https://site.observe.tw`，重啟 web 完成。OAuth 專案確認為 `skys-gemini-api`、client 名稱 `observe.tw`；新 callback 為 `https://site.observe.tw/auth/google/callback`，既有 12 筆 URI 保留。應用端只變更公開來源，OAuth secret 與 openid/email/profile 權限範圍均未變更。

使用者以 Brave 完成新網域真實 Google 登入並回到新站；服務紀錄核對新 host 的 callback 回 303，資料庫確認新增 session（驗證紀錄不保存個資、code 或 token）。新站主要公開頁面、API、canonical、robots/sitemap 均使用新來源且回 200。舊站首頁、網站頁、API、登入入口與 sitemap 回 308，保留原始 path/query；loopback 的首頁及健康檢查仍為 200，兩個公開 host 的 internal POST 仍為 404。15 項遷移/SEO 測試通過。

公開 Cloudflare 與 Google DNS 均已回新站 A 記錄；本機 resolver 暫留負快取，因此 HTTPS 核對以公開 DNS 回覆的 IP 配合原 hostname/SNI 完成。舊站 robots.txt 與 favicon.ico 一度仍由 CDN HIT 舊快取，來源與附查詢參數的 URL 都正確回 308；使用者決定讓此兩個快取自然到期，未執行 purge。其他舊靜態檔若有未到期快取仍可暫時回圖像，並不影響主要頁面的網域轉址。新站圖像採內容雜湊 URL。

本次環境設定備份與公開核對 JSON 位於 `data/last-site-domain-cutover.txt` 指向的私有目錄。僅重啟 web，未重啟 worker、未執行資料庫 migration。Google Search Console 網址變更仍是獨立的搜尋管理端後續作業，本次未執行。


切換後補查發現新 host 的 HTTP 請求仍可回 200，因此 `src/origin.ts` 依 Tunnel 的 `x-forwarded-proto: http` 將正式 host 的訪客升級到固定 HTTPS 來源，保留 path/query；目的地僅取設定，不取轉送 host，loopback/internal 不受影響。已重啟 web，公開 `http://site.observe.tw/table/?q=...&from=...` 實測 308 至同一路徑的 HTTPS；新 HTTPS 首頁 200、登入入口 302 使用新 callback，舊 HTTPS 網站頁 308。最終 typecheck、lint、16 項遷移/SEO 測試與 diff 檢查通過。舊 robots/favicon 依使用者決定保留 CDN 快取至自然到期。

2026-10-27 23:50（台北時間）Google Search Console（使用者處理）：新增並驗證 `https://site.observe.tw/` 資源，`sitemap.xml` 成功處理、讀到 4 個網址（`/`、`/table/`、`/tag/`、`/tech/`）；舊資源 `https://traffic.observe.tw/` 已提交網址變更至 `site.observe.tw` 並通過驗證，狀態為「This site is currently moving」，開始日 2026-10-27。索引轉移需等 Google 處理，期間舊站 308 必須保留；勿在舊資源按 Cancel move。同日實測舊站 robots.txt、favicon.ico 已回 308，先前的 CDN 快取已到期。GTM／GA 本站從未安裝，換網域無須調整。
