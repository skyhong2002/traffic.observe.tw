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
| `src/sheet.ts`、`tools/import-sheet.ts` | 讀試算表（各 `YYYYMM` 分頁）進 `sheet_rows` |
| `src/metrics.ts` | 月排行、分類概況的計算 |
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

## 試算表

`node --env-file=.env tools/import-sheet.ts` 會下載公開匯出的 xlsx，重寫各月份的 `sheet_rows`，並把最新兩個分頁的網域設成 `sheet` 的定期清單。來源表維持唯讀；只讀公式的快取結果，不執行公式。

- 欄位依標題名稱找，不依位置，因為各月份版面不同：202412 用「總流量」，2025 年用 SimilarWeb／Ahrefs，2026 年用 流量／搜尋S／AI，202510–202512 的流量欄標成「網站」或月份。
- 名稱結尾的 `/5` 這類除數，或流量欄是乘除公式，代表人工調整，記為 `adjusted`，**不當成造訪量**。
- 較舊的分頁只有名稱沒有網址時，用同名網站在其他月份的網域補上。
- 表上的 **搜尋S＝流量 × 自然搜尋占比**（不含付費搜尋），**AI＝流量 × GenAI 占比**。2026-10-21 回測（`tools/backtest-sheet.ts`）：
  - 造訪量：202607 有 81/85、202608 有 95/98、202609 有 37/38 落在 1% 內；
  - 202609 搜尋占比：只算自然搜尋時 33/35 一致，加上付費時只有 12/35；
  - AI 占比 34/35 一致。
  - 例外：Similarweb 對 tw.news.yahoo.com 回 0，表上這個網域的數字是從別處來的。
- 表上另一組「搜尋／搜尋排名」（2025 年分頁標為 **Ahrefs**），以及「A/S 比值」，都不是 Similarweb 的資料，本服務不提供。

## 頁面與公開 API

- `/` 月排行（分類篩選、CSV 下載）、`/topics/` 分類概況、`/site/<domain>/` 單一網站歷史、`/status/` 抓取狀態。
- `GET /api/v1/`、`/api/v1/months`、`/api/v1/rankings?month=&topic=`、`/api/v1/rankings.csv`、`/api/v1/topics?month=`、`/api/v1/sites/<domain>`、`/api/v1/status`。
- 有 Similarweb 數字就用 Similarweb；沒有的月份或網域用試算表數字，並標「表」。分類取試算表裡該網域截至該月最新的一列；不在表上的網域歸「未分類」。

## 登入與手動追蹤（`/watch/`）

用 Google 登入（`src/login.ts`，從 tag 的 `app/src/auth/google-login.ts` 簡化而來），OAuth client 與 tag 共用。只有 `TRAFFIC_ADMIN_EMAILS` 名單上的帳號會拿到 session（30 天，cookie `traffic_session`，資料庫只存 SHA-256）。名單每次請求都會重新比對，從名單移除後立刻失效。其他人看公開頁面不需要登入。

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
