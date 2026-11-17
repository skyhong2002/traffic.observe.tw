# Docker 自動貢獻節點

節點只需要 Docker 與向外的 HTTPS。主站統一派工；節點不需要 SSH、資料庫、主站簽章 secret 或入站連線。支援 Linux amd64 及 Apple Silicon／Linux arm64。

## 主站登記一次

主站先備份資料庫，套用 migration 0019，並部署支援 contributor jobs 的 web 與 worker。為每台機器建立不同的節點 ID／金鑰：

```sh
node tools/contributor-key.ts node-a /secure/node-a-key
```

指令把原始金鑰寫到新建的 0600 檔案，只印出可加入主站 `.env` 的雜湊設定。多個節點以逗號分隔，保留原有項目：

```dotenv
TRAFFIC_COMMUNITY_ENABLED=1
TRAFFIC_CONTRIBUTOR_TRUST=node-a:10
TRAFFIC_CONTRIBUTOR_NODES=node-a
TRAFFIC_CONTRIBUTOR_NODE_KEYS=node-a:<指令印出的 SHA-256>
```

重新啟動主站 web／worker。把 `/secure/node-a-key` 安全複製到節點的 `deploy/contributor/node-key`；原始金鑰不要提交 Git、貼到日誌或放入 image。

## 節點啟動

取得這個版本的原始碼後：

```sh
cd deploy/contributor
chmod 700 .
# Compose 本機 secrets 是唯讀 bind mount；容器內的 node 使用者需能讀取。
# 上層目錄保持 0700，限制本機其他使用者接觸此檔案。
chmod 444 node-key
cat > .env <<'ENV'
CONTRIBUTOR_URL=https://site.observe.tw
SOURCE_VERSION=development
ENV
docker compose up -d --build
docker compose ps
docker compose exec contributor node -e "fetch('http://127.0.0.1:18151/health').then(r=>r.json()).then(console.log)"
```

正式部署把 `SOURCE_VERSION` 設為該 checkout 的 `git rev-parse HEAD`。初次 build 後，平常使用 `docker compose up -d` 即可。每個節點 ID 只啟動一個 container；重新啟動會沿用 named volume 的裝置 ID、已抓取回應與待回傳佇列。無需安裝 Node 或 npm 套件，也不需要開放任何 port。

主站每次在現有 named lock、全站配額、最小間隔與 provider 退避允許後，才保留一筆 send 並發出短期任務。已上線節點與主站輪流執行；未上線節點不領取配額。節點不自行挑網域、批次掃描或調高請求量。401／403／429 與 Retry-After 原樣交回現有排程，停止後續上游請求；當次失敗不改由其他節點補抓。

原始回應先在 volume 以 0600 atomic rename 保存；相同 send ID 不會重抓，未確認回傳會重送。若抓取中途異常退出，保留 started reservation 並回報失敗，不在重啟後重抓。主站收到的成功結果立即儲存 contributor observations，即使 worker 的等待已結束也保留資料；冪等鍵沿用原有 node／domain／month／hash。社群來源不寫入本站自動資料表。`sourceVersion` 是節點 image 的建置版本，資料月份和時間沿用實際回應。

裝置 ID 與 journal 在節點 `/state` volume；任務和原始回應在主站 `contributor_jobs`，來源在 `contributor_observations`。journal 保留供重播與診斷；停機歸檔前不要移除 volume。查詢 `/api/v1/contributors/<domain>?month=YYYYMM` 可核對節點來源與 canonical。

停止：`docker compose down`（保留 volume）。撤銷：從主站 `TRAFFIC_CONTRIBUTOR_NODES` 與 `TRAFFIC_CONTRIBUTOR_NODE_KEYS` 移除該節點並重啟 web／worker。移除 trust 會停止採用該節點的既有資料；全域 `TRAFFIC_COMMUNITY_ENABLED=0` 同時停止派工與社群資料採用。
