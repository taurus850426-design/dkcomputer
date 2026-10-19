# DK 官網購物與信用卡介接（尚未正式啟用）

新增 `shop.html`、商品詳情購物車入口、後台訂單頁「網站訂購待確認」獨立佇列，以及 ECPay AIO 信用卡一次付清介接。預設關閉，未部署服務時仍可預覽購物車。

## 與現有資料的關係

- 安裝只新增 shop_orders 與 shop_* RPC，不重寫既有訂單、叫貨單、報價、庫存或財務資料。
- 網站商品來自 public.inventory，並未連到後台 inventory_items。新網站單不自動變成原 orders，也不自動入帳。
- 店家批准網站訂購時，核對最新價格與官網可售數量，保留該數量；實際出貨按鈕才扣 public.inventory.qty。後台實體庫存與財務仍依原流程登記，須用 WEB 單號核對避免重複。
- 測試單不占正式單保留數量，不能出貨或扣庫存。
- 本機測試使用隔離資料庫，未建立正式測試訂單或修改正式資料。

## 操作流程

客人選購 → 送出聯絡資訊與訂購需求 → 管理員確認供貨及運費 → 客人在同一瀏覽器按查詢進度 → 開啟綠界刷卡頁 → 綠界伺服器通知驗簽、商店與金額核對 → 顯示已付款 → 管理員核對出貨並扣官網上架量。

轉帳／到店付款須管理員實際核實款項後，填寫核對憑據。這不會自動寫入舊財務系統。

## 安裝與設定

1. Review `supabase/migrations/20261019115248_shop_checkout_queue.sql`。依專案規則，由使用者手動執行。`schema.sql` 為相同內容的便讀副本，擇一執行即可。
2. 在 Supabase Edge Secrets 設定下列變數。正式金鑰只可存伺服器 Secrets，禁止放到任何公開 HTML、JS 或 Git。
3. 部署 `shop-checkout` Edge Function；`supabase/config.toml` 設 verify_jwt=false，公開 checkout/webhook 可達；管理操作仍由函式驗證管理員 JWT、profiles.role 與 enabled，刷卡通知另驗簽。
4. 先用 test 模式與官方測試帳號，管理員登入同一網站後測試。核對回呼、重新整理、重送、拒付、金額異常、出貨扣量與權限。
5. 正式金流帳號核准後，換正式憑證、設定 live 防機器人、正式付款／退貨與隱私說明，確認可售數量，再設 SHOP_LIVE_APPROVED=true、ECPAY_MODE=live、SHOP_ENABLED=true。
6. 最後將 shop-config.js 的 enabled 改為 true 並加入官網導覽購物入口。未完成前保持 false，不能宣稱正式收款已開放。

| 變數 | 用途 |
| --- | --- |
| SHOP_ENABLED | 預設 false，true 才能建立需求、批准與開始刷卡 |
| SHOP_ORIGIN | 官網精確 origin，例如 https://taurus850426-design.github.io；不含 /dkcomputer |
| SHOP_BACK_URL | 同 origin 完整回站網址，例如 https://taurus850426-design.github.io/dkcomputer/shop.html |
| ECPAY_MODE | test 或 live |
| ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV | 該環境商店憑證 |
| SHOP_LIVE_APPROVED | live 必須為 true，且禁止使用官方測試憑證 |
| SHOP_TURNSTILE_SITE_KEY / SHOP_TURNSTILE_SECRET | live 必填；網站驗證 hostname 要符合 SHOP_ORIGIN |
| SHOP_IP_HASH_SALT | live 必填的隨機伺服器秘密，用於短期網路來源限流雜湊 |

Supabase 內建 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、SUPABASE_ANON_KEY 由環境提供。公開瀏覽器不接觸 service role。

## 已處理的情境與限制

- 金額以伺服器商品資料重算，前端改價格無效。供貨批准會重新核價、核量；版本不一致須更新，避免互相覆蓋。
- 重送需求使用 idempotency key；付款只允許啟動一次；通知驗簽並核對金額、商店、單號、環境。重複成功通知不重複扣量；失敗通知不能把已付款或已出貨單降回未付款。
- 模擬付款不能成為正式已付款。沒有可信通知不能以回到官網或截圖判定收款。
- 付款開始後如離開刷卡頁、失敗或通知延遲，先保留數量並人工查金流後台。本版不提供自動重新刷卡、解鎖、退款或交易查詢 API；不應直接改資料庫強行取消。
- 客人狀態憑證存 sessionStorage，本版只追蹤同分頁最近一筆，尚無會員歷史查詢、通知信、LINE 自動通知、發票或物流介接。關閉分頁後請用 WEB 單號聯絡店家；若正式營運需要長期自助查單，須補上安全查詢／通知再開放。
- 後台顯示最近50筆；超過規模須補分頁與搜尋。私人資料由服務端驗證管理員後返回，anon/authenticated 無直接 table SELECT 或 RPC 權限。
- 管理員仍能在原商品管理修改上架數量，必須包含既有待付款保留量，不能把官網數量視為實體庫存的自動同步。
- 尚未完成部署環境端到端刷卡、正式金流驗收或真實瀏覽器視覺驗收，不能當作正式可營運承諾。

## 本機驗證

`NODE_PATH=/workspace/scratch/fb551fc01fe4/test-deps/node_modules node --test tests/shop-checkout.cjs tests/shop-ui.cjs tests/shop-edge.cjs`

官方介接依據：綠界開發者 AIO 建立訂單 https://developers.ecpay.com.tw/2862/ 、檢查碼 https://developers.ecpay.com.tw/2902/ 、付款通知 https://developers.ecpay.com.tw/2878/ 。
