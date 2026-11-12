# Similarweb 429：有限恢復探查與持久化退避

2026-11-10。範圍只包含 `data.similarweb.com/api/v1/data` 的既有收集流程，沒有額外呼叫該端點研究限制，也沒有更換 IP、裝置識別或資料端點。

## 文件可支持的結論

- [RFC 6585 §4：429](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)：429 表示一段期間內請求過多；可以帶 Retry-After。規範沒有定義伺服器如何辨識使用者或如何計數，不能從 429 推算每小時／每日／每週額度。
- [RFC 9110 §10.2.3：Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)：可用秒數或 HTTP 日期表示應等待時間。有有效伺服器時間就不能以較短的本機退避取代。
- [AWS Builders' Library：Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)：重試應集中在單一層，限制重試流量，使用退避與 jitter；反覆重試可能放大負載。本文提及熔斷器的測試及復原風險，因此這裡將狀態持久化並測試跨程序、限額與復原失敗情境。
- [Similarweb 官方 API rate limit](https://developers.similarweb.com/docs/rate-limit) 的每秒 10 次規格適用其正式 API，**不能套用到 Chrome 插件使用的資料端點**。目前沒有足夠官方資料確認插件資料端點的伺服器額度或重置時間。官方插件說明頁這次回 403，沒有以它作為限額證據。

以下 2、4、8、16、24 小時，以及 15 分鐘／3 次，都是本機可調的工程選擇；上述文件沒有規定這些數字，也不保證伺服器已解除限制。

## 策略

1. 429（含 HTTP 200 的明確 `exceeded: true`）立刻停止這一輪。
2. 有有效 Retry-After，遵守該時間及既有最低拒絕冷卻；即使它要求七天，也不縮短。
3. 沒有有效 Retry-After，依連續 429 次數等待 2 → 4 → 8 → 16 → 24 小時，之後基礎等待維持 24 小時；再加 0–10% 的正向 jitter，因此等待只會更長。抽樣出的確切時間寫入資料庫，重啟不重新抽樣。
4. 到期只取一個待補網域。此請求同時取回有用資料，也確認是否可以恢復；它確實可能消耗 Similarweb 額度，不能宣稱是零成本的狀態檢查。
5. 恢復階段每次只取一站、至少間隔 15 分鐘，滾動 24 小時最多 3 次；成功、錯誤、拒絕、pending 預留均計入。原有每小時／每週上限、每日新月份探查、網域重試與全域資料庫鎖仍一起約束。
6. 連續三次得到可解析並已保存的回應，才回到既有正常限速（至少 4 分鐘、滾動一小時最多 15 次）。一次成功不清除連續拒絕次數；恢復期間再次 429 會進到更長一級退避。格式錯誤及網路失敗不算恢復成功。
7. 程序在探查中中斷時，已預留的探查仍計入上限，狀態會先保留基礎兩小時等待；不因重啟馬上再送一次。
8. 等待期間每小時只讀本機排程。另設一次性的到期 timer，在到期後才喚醒 runner；不做每小時真實測打。

401／403 仍走既有全域拒絕與最低冷卻，不將它們計為新的 429 級數。沒有把這個改動當成能解決權限或身分驗證問題。

## 實作與設定

- `src/provider-backoff.ts`：計算等待、記錄拒絕、預留單站恢復探查、確認成功或重新等待。
- `similarweb_backoff`：唯一一列全域狀態，保存 phase、refusals、successes、retry_source、next_attempt_at、provider_retry_at、last_refused_at。
- `sends.recovery_probe`：區分一般收集與恢復探查，跨程序共用滾動 24 小時計數。
- `fetchPolicy`：合併所有等待與額度，回傳 `recovery`，最多送一筆；手動指定也不能繞過。
- `GET /api/v1/status` 與狀態頁：標明等待是 provider 還是 local-backoff/local-recovery/local-error、已用恢復探查數及連續成功數。

```dotenv
TRAFFIC_ADAPTIVE_BACKOFF=1
TRAFFIC_BACKOFF_BASE_HOURS=2
TRAFFIC_BACKOFF_MAX_HOURS=24
TRAFFIC_RECOVERY_INTERVAL_MINUTES=15
TRAFFIC_RECOVERY_SUCCESSES=3
TRAFFIC_RECOVERY_DAILY_BUDGET=3
```

`TRAFFIC_QUOTA_COOLDOWN_HOURS=168` 僅保留給停用 adaptive 模式時的舊流程；adaptive 模式使用上面設定。啟用新設定不會自行縮短任何已保存冷卻。

部署先套用 `0014_provider_backoff.sql`，再啟用設定並重啟 web／worker。這次既有 11/10 16:35:43 的 429，既有查核紀錄明確標為本機七天退避；對這一筆作有備份的設定遷移，從啟用新策略的時間再等待至少兩小時加 jitter。保留原拒絕時間與歷史 sends，沒有當場發出真實探查。不能將這個特例當成縮短伺服器 Retry-After 的通用工具。

測試使用假的 provider 回應，覆蓋重啟後仍等待、遞增退避、伺服器七天時間不縮短、一次只送一站、三次低速成功才恢復、一次成功後再拒絕仍升級、pending 也計入日上限，以及格式錯誤不視為恢復。部署核對保存在 `data/adaptive-backoff-release-20261110/`。

實際於台北時間 2026-11-10 23:53:44 啟用，遷移後最早可試時間為 11/11 01:55:48，依四分鐘時槽喚醒為 01:56。部署後公開 health／ready／status 都回 200；`sends` 仍為 2350 筆，最後送出時間仍是 11/10 16:35:43，沒有新 provider 回應，也不能據此判定限制已解除。每日 15:40 監看仍維持停用。
