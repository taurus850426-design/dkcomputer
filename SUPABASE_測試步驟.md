# Supabase 功能測試步驟

你的 Supabase 目前有：`inventory`、`orders_data`、`site_config`、`stock_data`。  
程式還會用到 **`v2_data`**（庫存＋記帳的品項／流水／訂單／支出）。若 Table Editor 裡沒有 `v2_data`，請先建表再測。

---

## 1. 確認有 v2_data 表（若沒有就建）

- 到 Supabase **Dashboard → SQL Editor**，貼上下面這段 → **Run**：

```sql
CREATE TABLE IF NOT EXISTS v2_data (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{"items":[],"ledger":[],"orders":[],"expenses":[]}'
);
INSERT INTO v2_data (id, data) VALUES ('default', '{"items":[],"ledger":[],"orders":[],"expenses":[]}')
  ON CONFLICT (id) DO NOTHING;
```

- 再到 **Table Editor** 看一下，應該會看到 **v2_data**。

---

## 2. 確認 shared.js 已填 Supabase

- 打開 `shared.js`，確認最上面有填：
  - `SUPABASE_URL`（你的 Project URL）
  - `SUPABASE_ANON_KEY`（Publishable anon key）
- 若留空，所有功能都會只用本機 localStorage，不會連 Supabase。

---

## 3. 依功能測試（建議順序）

### A. 官網設定（site_config）

1. 開後台 **admin.html** → 分頁切到 **「前台管理」**。
2. 改一個欄位（例如「每頁底部一句話」）→ 按 **儲存**。
3. 到 Supabase **Table Editor → site_config**：
   - 應有一筆 `id = default`，`data` 為 JSON（裡面有 line、footerLineSentence 等）。
4. 用 **無痕視窗** 或 **另一台裝置** 再開一次官網或後台，重新整理後應看到剛存的設定。

### B. 前台商品（inventory）

1. 後台 **admin.html** → **「上架管理」**。
2. 新增一筆商品（名稱、分類、價格等）→ 儲存。
3. Supabase **Table Editor → inventory**：
   - 應多一列，`id` 為該商品代號（如 WEB-xxx），`name`、`category`、`price` 等有值。
4. 開 **前台整機頁**（例如 machine.html），重新整理，列表應出現剛上架的商品。
5. 在後台把該商品 **下架**，回 Supabase 看 **inventory**，該列應被刪除。

### C. 庫存規格（stock_data）

1. 後台若有使用「庫存規格／類別／欄位」的頁面（例如舊版庫存設定），改動後儲存。
2. Supabase **Table Editor → stock_data**：
   - 應有一筆 `id = default`，`data` 為 JSON（內有 `stock`、`stockKinds`、`stockSchema`）。

### D. 庫存＋記帳 v2（v2_data）

1. 後台 **admin.html** → 分頁 **「庫存＋記帳」**。
2. 新增一筆 **品項** 或 **流水帳** 或 **訂單** 或 **支出** → 儲存。
3. Supabase **Table Editor → v2_data**：
   - 應有一筆 `id = default`，`data` 為 JSON，裡面有 `items`、`ledger`、`orders`、`expenses` 陣列，且剛存的資料在對應陣列裡。
4. 用 **另一台電腦或無痕** 開同一個後台網址，切到「庫存＋記帳」並重新整理，應看到同一份品項／流水／訂單／支出。

---

## 4. 若出現權限錯誤（RLS）

- 若 Supabase 有開 **Row Level Security (RLS)**，而請求回傳權限錯誤：
  - 到 **SQL Editor** 對各表放行 anon（或到 Table → 各表 → RLS 新增 Policy 允許 anon 讀寫）。
- 例如：

```sql
ALTER TABLE site_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON site_config FOR ALL TO anon USING (true) WITH CHECK (true);
-- 對 inventory、stock_data、orders_data、v2_data 重複同上兩行（改表名）
```

---

## 5. 表與程式對照（確認沒寫錯）

| 程式用的表名 | 用途           | 程式裡常數 / 列 id |
|-------------|----------------|---------------------|
| site_config | 官網設定       | id = `default`      |
| inventory   | 前台商品       | 每筆一列，id = 商品 id |
| stock_data  | 庫存規格       | id = `default`      |
| orders_data | 舊版訂單（目前未用） | id = `default`      |
| v2_data     | 庫存＋記帳 v2  | id = `default`      |

表名、欄位名（如 `id`、`data`、inventory 的 `stock_status`、`name` 等）都與 `shared.js` 和 `supabase-tables.sql` 一致，只要 Supabase 裡這五張表都建好、RLS 有放行，上述測試通過就代表連線正常。
