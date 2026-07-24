# 前台／後台邏輯檢查 ＋ Supabase 設定說明

## 一、整體架構與資料流

| 區塊 | 資料來源 | 說明 |
|------|----------|------|
| **前台（整機販售）** | Supabase `inventory` | machine.js 載入時先 `fetchInventoryFromSupabase()`，再 `saveInventory()` 到 localStorage，列表用 `getInventory()` 顯示。 |
| **後台（admin.html + admin3.js）** | localStorage + Supabase | 上架商品用 `getInventory`/`saveInventory`（同表 dk_inventory_v1），並會寫入 Supabase `inventory`；庫存＋記帳 v2 用 `dk_v2_*`，並經 `shared.js` 同步 `v2_data`。 |

> 已移除舊版：`admin.js`、`admin2.js`、`admin-v2.html`、`admin-v2.js`（請一律使用 **admin.html**）。


---

## 二、邏輯檢查結果

### 前台（index.html / machine.html）

- **載入**：有呼叫 `DK.fetchInventoryFromSupabase()`，成功後寫入 localStorage 並用 `DK.getInventory()` 渲染。若 Supabase 失敗會用本機資料。
- **分類篩選**：依 category、price 區間與售價 0（顯示「價格請加 LINE 詢問」）正常。
- **依賴**：`shared.js` 的 `DK.getConfig`、`DK.getInventory`、`DK.saveInventory`、`DK.fetchInventoryFromSupabase`、`DK.escapeHtml`、`DK.formatPrice`、`DK.openLineOrder`、`DK.applyConfigToHomePage`。皆由 shared.js 提供，無缺漏。

### 後台（admin.html + admin3.js）

- **登入**：依現有邏輯，無改動。
- **庫存管理**：使用 `dk_im_items_v1`，狀態為 可售/待測/待整理/保留/待出清/報廢拆料/已售出；品類、入庫日、庫齡、最低價、位置、四種檢視（放最久 20、待整理、待出清、低庫存）皆正常。
- **同步到前台**：已補「同步到前台」按鈕，會執行 `syncToWebAndSupabase()`：先依「可售/保留/待測」產生前台清單並寫入 localStorage，再**逐筆寫入 Supabase `inventory`**，訪客重新整理前台即可看到最新列表。
- **上架管理**：新增/編輯/下架都會 `saveInventory` + `upsertInventoryItemToSupabase` 或 `deleteInventoryItemFromSupabase`，與 Supabase 一致。
- **訂單管理**：讀取/儲存會呼叫 `fetchOrdersFromSupabase` / `saveOrdersToSupabase`，訂單存在 Supabase `orders_data`。
- **報表**：使用本機訂單與庫存，無直接依賴 Supabase。
- **庫存＋記帳（v2）**：整合於 admin.html「庫存＋記帳」分頁（`admin3.js` + `inventory-ledger.js`），資料為 `dk_v2_*`，並可經 `shared.js` 同步 Supabase `v2_data`。

---

## 三、Supabase 需要有的設定

以下表與欄位是 **現有前台＋後台** 會用到的，需與 shared.js 一致。

### 1. 表 `inventory`（前台商品）

給 **整機販售頁** 與 **上架管理** 使用。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | text (PK) | 商品 ID，唯一 |
| `name` | text | 顯示名稱 |
| `category` | text | 分類（例：文書、遊戲、周邊） |
| `stock_status` | text | 現貨 / 低庫存 / 缺貨 |
| `price` | numeric 或 null | 售價，可 null |
| `note` | text | 備註 |
| `photos` | jsonb 或 array | 相片 URL 陣列 |

- **RLS**：若開啟 RLS，需允許 anon 對 `inventory` 做 `SELECT`；後台寫入若用同一 anon key，需允許 `INSERT` / `UPDATE` / `DELETE`（或由 service role 寫入）。

### 2. 表 `site_config`（官網設定）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | text (PK) | 固定一筆（例：`default`） |
| `data` | jsonb | 網站標題、LINE、Google 等設定 |

### 3. 表 `stock_data`（庫存規格／種類）

若後台有使用「庫存規格」或從庫存同步，會讀寫此表。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | text (PK) | 固定一筆 |
| `data` | jsonb | 庫存結構與資料 |

### 4. 表 `orders_data`（訂單）

後台訂單管理用。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | text (PK) | 固定一筆（例：`default`） |
| `data` | jsonb | 內含 `{ "orders": [ ... ] }` 陣列 |

---

## 四、Supabase 需要「改」什麼？

- **若你已經照之前規劃建好** `inventory`、`site_config`、`stock_data`、`orders_data`，且欄位與上表一致，**不用再改**。
- **若尚未建表**：在 SQL Editor 依上面結構建立這四張表，並設定好 RLS（anon 可讀 inventory；寫入依你的權限設計開放或改用 service role）。
- **若你要把「庫存＋記帳」v2 也存到 Supabase**：專案已透過 `shared.js`／`inventory-ledger.js` 對接 `v2_data`；若尚未建表，請執行 `supabase-tables.sql`。正式後台請使用 **admin.html**（`admin3.js`）。

---

## 五、本次程式修改摘要

1. **syncToWeb 改為回傳陣列**，並新增 **syncToWebAndSupabase()**：先同步到本機，再逐筆 `upsertInventoryItemToSupabase`，讓庫存「同步到前台」時會寫入 Supabase。
2. **庫存管理區** 新增按鈕「**同步到前台**」，點擊後執行 `syncToWebAndSupabase()`，並顯示「已同步 N 筆到前台（含 Supabase）」。

這樣一來，前台顯示的內容會與後台「同步到前台」及「上架管理」的結果一致，且都寫入 Supabase，多裝置／重新整理後仍會看到最新資料。
