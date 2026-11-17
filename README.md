# traffic.observe.tw

`traffic.observe.tw` 是一個可自行部署的網站流量觀察服務。它把多個來源的網域、月份流量、台灣熱門度、導流組成、網站技術與標籤整理成可查詢的資料庫，並提供網站介面與唯讀 API。

正式服務目前運行於 [site.observe.tw](https://site.observe.tw)。這個 repository 是公開的 MIT 開源專案；正式站的資料庫、第三方 API 憑證與部署設定不包含在 repository 內。

## 目前功能

- Similarweb 月份流量與導流資料的集中收集、永久保存與缺漏佇列。
- 共用鎖、送出預留、最短間隔、滾動上限、Retry-After 與自適應退避，讓所有入口共用同一套保護。
- 依台灣流量、核心網站、稀有標籤、CrUX 台灣熱門度與資料完整度安排收集順序。
- Chrome UX Report（CrUX）台灣熱門度歷史與月份同步。
- Cloudflare Radar 排名同步。
- 網站首頁技術偵測、Wappalyzer 規則、技術瀏覽頁與每日排程。
- 試算表匯入、人工補登、網域名稱與標籤管理、標籤投票及稽核紀錄。
- 公開 HTML 頁面、CSV 與 JSON API；管理員可查看較完整的資料欄位。

社群貢獻節點與集中上傳協定正在 [Issue #3](https://github.com/skyhong2002/traffic.observe.tw/issues/3) 規劃中。現行版本尚未提供可直接使用的貢獻者上傳 API。

## 系統架構

| 元件 | 用途 |
| --- | --- |
| `src/server.ts` | 啟動 Fastify 網站、公開 API 與受保護的服務 API。 |
| `src/worker.ts` | 執行 Similarweb、CrUX、Radar 與網站技術掃描的持久化排程。 |
| `src/scheduler.ts`、`src/collection.ts` | 建立收集佇列、計算優先級、預留請求與處理重試。 |
| `src/similarweb.ts` | Similarweb 請求與回應解析。 |
| `src/crux.ts`、`src/radar.ts` | CrUX 與 Cloudflare Radar 同步。 |
| `src/tech-scan.ts`、`src/tech-browser.ts`、`src/wappalyzer.ts` | 首頁抓取與技術偵測。 |
| `src/db.ts`、`src/migrations/` | MariaDB 連線與資料庫 migration。 |
| `tools/` | 匯入、同步、部署、回溯與資料維護工具。 |

資料庫使用 MariaDB。正式服務與測試資料庫必須分開；測試會清空其指定的資料庫，請勿把 `TRAFFIC_TEST_DB_URL` 指向正式庫。

## 快速開始

需求：Node.js 24.x、MariaDB 10.6+（或相容版本）及 npm。

```sh
git clone https://github.com/skyhong2002/traffic.observe.tw.git
cd traffic.observe.tw
npm ci
cp .env.example .env
```

在 `.env` 設定至少一個可用的 MariaDB 連線，並建立資料庫後執行：

```sh
npm run db:migrate
npm run start       # http://127.0.0.1:18150
```

另開一個終端機啟動排程 worker：

```sh
npm run worker
```

首次部署建議先將 `TRAFFIC_RUN_BUDGET=0`，確認資料庫、網站與排程正常後，再依服務條件調整。Similarweb、CrUX、Radar 的憑證只放在本機環境變數或秘密管理系統，不要提交到 Git。

## 常用設定

所有設定都列在 [.env.example](.env.example)，常用項目如下：

| 變數 | 作用 |
| --- | --- |
| `TRAFFIC_DB_URL` | MariaDB 連線字串。 |
| `TRAFFIC_HOST`、`TRAFFIC_PORT` | HTTP 監聽位置，預設 `127.0.0.1:18150`。 |
| `TRAFFIC_RUN_BUDGET` | 每輪最多送出的 Similarweb 請求；`0` 表示不送出。 |
| `TRAFFIC_COLLECTION_ENABLED` | 是否啟用月份收集佇列。 |
| `TRAFFIC_TARGET_MONTH` | 目標月份；`auto` 使用上一個 UTC 月份。 |
| `TRAFFIC_CORE_DOMAINS` | 核心網站數量。 |
| `TRAFFIC_HOURLY_BUDGET`、`TRAFFIC_MIN_INTERVAL_SECONDS` | 本機的共用速率保護，不代表上游已確認額度。 |
| `TRAFFIC_ADAPTIVE_BACKOFF` | 是否啟用拒絕後的持久化退避。 |
| `TRAFFIC_TOKEN_<REQUESTER>` | 其他 observe 服務呼叫內部 API 的 token。 |
| `TRAFFIC_ADMIN_EMAILS` | 可查看完整資料與管理網站的管理員。 |

本機上限、週限額與冷卻是安全策略，不應被解讀為 Similarweb 官方額度。收到 401、403、429、quota exceeded 或有效 `Retry-After` 時，服務會停止當輪送出並保存退避狀態；請勿用更換帳號、Cookie、IP、出口或裝置的方式規避限制。

## 公開 API

服務提供 OpenAPI 文件：`/api/v1/openapi.json`。常用唯讀端點：

```text
GET /api/v1/months
GET /api/v1/history?month=YYYYMM
GET /api/v1/rankings?month=YYYYMM
GET /api/v1/rankings.csv?month=YYYYMM
GET /api/v1/topics?month=YYYYMM
GET /api/v1/sites/:domain
GET /api/v1/tags/:domain
GET /api/v1/tech?month=YYYYMM
GET /api/v1/tech/:domain
GET /api/v1/status
GET /api/v1/collection?month=YYYYMM
```

`/healthz` 僅表示網站程序可回應；`/readyz` 也會檢查 worker 心跳與最近的可用結果。狀態 API 會區分本機資料庫檢查、真正送往上游的請求、退避狀態與月份收集進度。沒有新請求不代表上游成功。

公開使用者看到的欄位與筆數會依權限限制；管理員資料不應直接複製到公開回應。

## 開發與驗證

```sh
npm run typecheck
npm run lint
npm test
```

測試需要獨立的 `TRAFFIC_TEST_DB_URL`。提交前請確認：

- migration 可在乾淨資料庫套用，且不會把正式資料寫入測試庫。
- Similarweb 呼叫仍經共用 scheduler、lock、預留與 backoff。
- API 不會洩漏 Cookie、Authorization、完整上游回應或資料庫憑證。
- 新增資料來源時保留來源、抓取時間、月份與 schema 版本，並讓重試具備冪等性。

## 部署

`deploy/` 包含 systemd user service 範例；部署說明在 [deploy/README.md](deploy/README.md)。正式 release 可使用：

```sh
bash tools/deploy-web.sh <commit> --activate
```

這個工具會保留既有資料目錄與環境設定，並在健康檢查失敗時回復 web release。worker 與 web 的 migration、重啟及回滾應分開驗證。

## 貢獻方式

歡迎提交 issue、文件修正、測試與小型功能。大型變更請先開 issue 說明資料模型、來源授權、重試行為與回滾方式。涉及外部資料的功能必須：

1. 明確保存來源與抓取時間。
2. 支援重試、部分失敗與冪等寫入。
3. 不把估算值宣稱為 Similarweb、CrUX 或 Radar 的原始測量。
4. 不繞過第三方服務的限制或條款。

社群節點、簽名上傳、資料驗證與抓取順序最佳化的設計追蹤於 [Issue #3](https://github.com/skyhong2002/traffic.observe.tw/issues/3)。

## 授權與第三方資料

本 repository 的原始碼以 [MIT License](LICENSE) 授權。MIT 授權只涵蓋本 repository 的程式碼與文件，不授予 Similarweb、Google CrUX、Cloudflare Radar、試算表內容、網站內容、商標或其他第三方資料的權利。部署者必須自行確認 API 憑證、資料來源、網站抓取與公開服務符合適用的條款與法律。

品牌素材與字型授權請另見 [`assets/brand/`](assets/brand/) 內的說明。
