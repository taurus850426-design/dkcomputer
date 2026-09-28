# Stage 33｜自動行情蒐集 MVP

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
