# Supabase 連線狀態一覽

以下為目前各功能與 Supabase 的讀寫對照，方便確認「換電腦／換瀏覽器」時資料是否一致。

| 功能 | Supabase 表 | 載入時（讀） | 儲存時（寫） | 備註 |
|------|-------------|--------------|--------------|------|
| **官網設定**（前台管理） | `site_config` | ✅ 頁面載入時 `fetchSiteConfigFromSupabase` → `saveConfig` | ✅ `saveConfig` → `saveSiteConfigToSupabase` | 前台管理儲存會同步到 Supabase |
| **前台商品（上架）** | `inventory` | ✅ 頁面載入時 `fetchInventoryFromSupabase` → `saveInventory`；前台整機頁 `machine.js` 也會拉一次 | ✅ 上架／編輯：`upsertInventoryItemToSupabase`；下架：`deleteInventoryItemFromSupabase` | 後台與前台都會從 Supabase 拉最新清單 |
| **庫存規格**（類別／欄位） | `stock_data` | ✅ 頁面載入時 `fetchStockDataFromSupabase` → saveStock / saveStockKinds / saveStockSchema（skipSupabaseSync） | ✅ saveStock / saveStockKinds / saveStockSchema 各自呼叫 `saveAllStockDataToSupabase` | 多裝置看到同一份規格 |
| **庫存＋記帳 v2**（品項／流水／訂單／支出） | `v2_data` | ✅ 頁面載入時 `fetchV2DataFromSupabase`；切到「庫存＋記帳」時也會拉一次 | ✅ saveItems / saveLedger / saveOrders / saveExpenses 皆會觸發 `__syncV2ToSupabase` → `saveV2DataToSupabase` | 後台「庫存＋記帳」的資料全走 v2_data |
| **舊版訂單表** | `orders_data` | shared.js 有 `fetchOrdersFromSupabase` | shared.js 有 `saveOrdersToSupabase` | ⚠️ 目前後台訂單實際使用 v2_data，未使用 orders_data；此表可保留備用或之後遷移 |

## 小結

- **官網設定、前台商品、stock_data、v2_data** 都與 Supabase 正常連線：載入時會從 Supabase 拉、儲存時會寫回。
- **inventory** 已補上「頁面載入時從 Supabase 拉並寫入 localStorage」，後台開任何頁（含 admin）都會先同步上架清單，再操作。
- 若希望「以本機上架清單為準、刪除 Supabase 多餘列」的一鍵對齊，可再另加功能或腳本。
