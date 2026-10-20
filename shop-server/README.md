# DK 官網購物：轉帳與到店付款

公開入口為 `/dkcomputer/shop.html`。客人送出訂購需求後，由管理員確認供貨、運費及付款／取貨說明。信用卡入口與後端支付操作均停用，不能使用綠界或藍新刷卡。

## 接單方式

1. 後台「營運 → 訂單 → 網站訂購」查看新需求，可分頁查看與複製資料。
2. 確認供貨時填入給客人的銀行帳號、匯款注意事項，或到店時間／地址。宅配須填運費；自取運費固定為零。客人從私人查單連結查看內容。本版沒有自動通知信或 LINE 推播，請另行聯絡客人。
3. 轉帳單確認後保留48小時。客人回報轉出帳號末五碼後，進入待核款狀態；回報不代表已付款。逾期未回報會取消保留，如已匯款須人工核對。到店單須人工追蹤與取消，不自動到期。
4. 管理員實際核實收款後，填寫核對憑據，才能登記收款。交付後再登記完成，扣除官網上架數量。

## 與原有訂單及庫存的關係

- 網站單存於獨立的 `shop_orders`，不修改既有 `orders`、叫貨單、廠商報價、`inventory_items` 或財務紀錄，也不自動計入原業績報表。須用 WEB 單號另行登記、核對，避免重複入帳。
- 官網商品來自 `public.inventory`，尚未與後台零件庫存配對。確認供貨會保留官網可售量，登記交付才扣 `public.inventory.qty`，不扣零件庫存。修改官網上架數量時須考慮既有保留量。
- `WEB-014` 同時列出2060／3060 Ti，價格尚未區分，透過 `shop_product_rules.requires_quote` 限制為先詢價，未改動原商品內容。其餘符合價格、數量條件的商品可下單。
- 本版沒有線上退款、信用卡、電子發票、物流 API、會員登入或自動通知。取消後如有款項，須人工處理退款與聯絡。

## 部署與開關

- 原始基礎 schema：`supabase/migrations/20261019115248_shop_checkout_queue.sql`（`schema.sql` 為便讀副本，擇一安裝）。再安裝 `supabase/migrations/20261020232114_shop_manual_launch.sql`。
- 部署 `supabase/functions/shop-checkout/index.ts` 及其相對依賴 `manual.mjs`。使用內建 Supabase 伺服器環境變數，私鑰不進入公開程式。`SHOP_ORIGIN` 預設為 `https://taurus850426-design.github.io`。
- Edge 的 `verify_jwt=false` 讓公開查單與送單可達；管理操作由函式驗證 JWT、`profiles.role=admin` 及 `enabled=true`。公開查單須持有隨機私人憑證。資料表及 RPC 不直接授權 anon／authenticated。
- 接單開關以 `public.shop_settings.enabled` 為準。前端 `shop-config.js` 的 enabled 只控制商品入口，不足以開啟後端。關閉接單仍可查詢舊單與回報已完成轉帳。
- `shop-checkout` 的刷卡操作與通知端點固定回410，不讀取舊 ECPay 設定；舊信用卡函式沒有公開權限。將來開啟刷卡必須另做正式串接與驗收。

## 驗證與故障處理

伺服器重算價格，確認供貨時再核價核量。版本檢查避免不同管理員覆寫；重送使用冪等鍵，斷線重開可找回已建立的單。查單連結持久保存在同裝置，最多20筆，也可複製至其他裝置。請勿公開分享連結。

公開送單有簽名挑戰、來源限制、隱藏欄位及短期雜湊限流；這些不等同第三方 CAPTCHA。後續若遭大量濫用，可先關閉接單並加強驗證。

本機隔離測試：

```sh
node --test tests/shop-checkout.cjs tests/shop-edge.cjs tests/shop-manual-db.cjs tests/shop-ui.cjs
```

測試依賴 jsdom 與 @electric-sql/pglite。覆蓋權限、伺服器計價、重送與斷線恢復、保留量、逾期、轉帳待核對、版本衝突與單次交付。正式上線另須確認 Pages 檔案及公開 Edge 實際可達；不能僅以合併或部署成功宣稱已能下單。
