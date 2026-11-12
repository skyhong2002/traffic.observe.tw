# Similarweb 拒絕診斷：在現行 production 上補齊證據

2026-11-11。這次改動補齊後續正常請求的診斷，不宣稱解除上游限額或修復權限。

## 已確認與尚未確認

- Vessel 比較已用完三次：台灣 11/11 01:56:02 回 429、日本 06:20 回 429、新加坡 14:52 回 403（均為台北時間）。三次都查詢 `gamer.com.tw`，沒有取得流量或 profile 月份資料。因拒絕後保留原佇列順序，這次實際並未換網域。
- 三次請求的舊 metadata 沒有保存 CloudFront 診斷標頭。不能事後補填 `provider=CloudFront`，也不能據此判定拒絕的精確原因。
- 另一個 agent 提供的 commit `6ba7c89d02c105f547ee2b6da9818ef6b72fcb7f` 不存在於這份 production checkout 的物件庫。這次直接在已運行的現行程式上實作，保留月份收集、全域限速、退避、恢復探查與出口實驗紀錄。
- 外部回報的三次成功探測沒有足夠資訊可確認目的端點、出口、HTTP client、是否解析資料與是否納入 `sends`。沒有將它們視為 Similarweb 已恢復的證據，也沒有再測打來確認。

## 變更

1. `responseMetadata` 集中白名單：既有 Retry-After／限額標頭，加上 x-cache、x-amz-cf-pop、content-type，單值最多 256 字元。由 server、via、x-cache 或 POP 判讀回應是否經過 CloudFront，只保存 provider 名稱，不保存完整 server／via、CloudFront request ID、Cookie、請求標頭、裝置識別或 response body。
2. runner 在 HTTP 回應到達後、JSON 解析之前保存實際 status 與白名單。正常／拒絕／無資料／JSON 錯誤都能保留 HTTP 證據。JSON 解析錯誤改為固定訊息，避免解析器將 body 片段寫入錯誤紀錄。
3. 預留請求時記錄原出口與 Node fetch；出口實驗以合併方式改記實際路徑及 curl，保留實驗 ID。metadata 更新一律合併，不覆蓋出口／等待依據。
4. 所有成功解析保存的請求都記錄實際最新流量／profile 月份，不只記錄實驗。HTTP 200 的明確 exceeded 仍走原有全域 429 退避，保存真正 HTTP 200。
5. `/api/v1/status.requests` 與狀態頁顯示最近 24 筆實際請求的出口、傳輸、HTTP／結果、CDN／POP／cache、Retry-After、月份。舊紀錄未知欄位維持 null，`diagnosticsRecorded=false`，不補造歷史證據。GET 查詢只讀本機資料。

## 部署與驗證

- 測試只用假 provider 回應，完整 25 個測試檔、209 項通過；型別與 lint 通過（只有既有 Biome 設定淘汰提示）。涵蓋 403 診斷持久化、出口 metadata 合併、Retry-After 不被縮短、成功月份與 HTTP 200 JSON 錯誤、安全資料不洩漏、舊紀錄維持未知。
- 不需 migration、不更改環境配置或路由。只重啟 web／worker 載入改動，核對公開 health、ready、status 與 requests；不呼叫 provider 或 `runOnce` 驗證。
- 原本滾動 24 小時恢復探查上限仍為三次，既有預算與拒絕紀錄完整保留。實驗用完後原流程回到原出口；沒有新增實驗輪次。正常排程取得有效資料後才計入連續恢復成功，不能用 health／ready 的 200 代替。
- 原每日 15:40 監看維持停用。部署查核及程式快照保存於 `data/similarweb-diagnostics-release-20261111/`；當前同時存在其他未提交工作，沒有以舊分支覆蓋整份 checkout。

實際於 11/11 16:33:38 台北時間重啟載入，web／worker 都 active，NRestarts=0。公開 health／status API／status 頁回 200；ready 在部署前後均為 503，原因仍是最近三次 Similarweb 請求被拒絕，沒有將它改成成功。部署核對 `sends` 仍為 2353、最後請求 11/11 14:52，backoff 完整未變。最早允許時間為 11/12 01:56:02，按四分鐘時槽的下一次喚醒為 02:00，應回到原出口與 Node fetch；是否真正收到有效資料仍待該次正常排程。
