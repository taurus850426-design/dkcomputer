# Stage 33｜自動行情蒐集 MVP

## 2026-09-29 篩選修正部署

1. 在 SQL Editor 執行 `supabase-stage34-market-quality.sql`，候選統計只使用新版規則資料，並以每個商品連結的最新紀錄計算。舊資料保留供稽核，不再影響統計。
2. 將 `supabase/functions/used-market-collector/index.ts` 更新至同名 Edge Function 並部署。既有 Secret 不需重設。
3. 先抓一個型號並查看明細；未明示二手、翻新、全新與多型號商品均不納入。樣本不足時保持空白，不以未確認商品補數。
4. 相同連結會移除追蹤參數後去重；不同商品連結不會僅因標題相同而合併。來源價格仍需人工確認幣別、地區、運費與實際規格，不能視為已成交價格。

本機驗證：`node --test tests/backup-regression.cjs`。正式 SQL 與外部 API 需部署後驗證。

## 已完成

- 20 個常見 CPU／GPU 監控型號。
- SerpApi Google Shopping 伺服器端蒐集器。
- 自動排除故障品、空盒、徵收、訂金、全新品、型號不符與超出價格範圍的資料。
- 後台候選行情預覽：有效／排除數、25% 分位、中位數、75% 分位與來源明細。
- 候選行情與正式行情完全隔離；不會自動影響顧客估價。

## 上線順序

1. 在 Supabase SQL Editor 執行 `supabase-stage33-auto-market.sql`。
2. 在 Supabase 設定伺服器端 Secret：`SERPAPI_API_KEY`。
3. 部署 Edge Function：`supabase functions deploy used-market-collector`。
4. 登入後台 → 二手專區 → 行情管理 → 自動行情候選區。
5. 先抓單一型號檢查，再使用「抓取前 5 個型號」。

## 安全原則

- API 金鑰只能放在 Supabase Secret，不可寫入 HTML、JavaScript 或資料庫公開欄位。
- Edge Function 只允許已登入的管理員呼叫。
- 第一階段只產生候選資料；人工確認規則準確後，下一階段才提供「匯入草稿批次」。
- 定時排程應在抽查準確度後啟用，避免浪費 API 額度或累積錯誤資料。
