# 換電腦／換瀏覽器都能用：Supabase 設定步驟

只要在 Supabase 建好表、在專案裡填好連線，**官網設定**與**前台整機販售商品**就會存到雲端，換電腦或換瀏覽器登入後台都會看到同一份資料。

---

## 一、你需要「改」的只有兩件事

### 1. 在 Supabase 建立表（第一次做就好）

1. 登入 [Supabase](https://supabase.com) → 建立新專案（或用既有專案）。
2. 左側選 **SQL Editor** → **New query**。
3. 打開專案裡的 **`supabase-tables.sql`**，整段複製貼到 SQL Editor，按 **Run**。
4. 左側 **Table Editor** 應該會看到 `site_config`、`inventory`、`stock_data`、`orders_data`、`v2_data` 五張表。

### 2. 在專案裡填 Supabase 連線（只填一次）

1. 在 Supabase 左側選 **Project Settings**（齒輪）→ **API**。
2. 複製：
   - **Project URL**（例如 `https://xxxxx.supabase.co`）
   - **anon public** 的 key（在 Project API keys 區塊）。
3. 打開專案裡的 **`shared.js`**，找到最上面：

```js
const SUPABASE_URL = "https://npynqrsmduukulwgylkz.supabase.co";  // 改成你的 Project URL
const SUPABASE_ANON_KEY = "sb_publishable_xxx...";                 // 改成你的 anon key
```

4. 把上面兩行改成你自己的 **Project URL** 和 **anon key**，存檔。

做完以上，**不用改任何 Supabase 後台設定**，程式已經會自動讀寫。

---

## 二、這樣做之後，哪些會「換電腦也能用」？

| 項目 | 是否存到 Supabase | 換電腦／換瀏覽器 |
|------|-------------------|-------------------|
| **官網設定**（LINE 連結、按鈕文案、每頁一句話、品牌標題等） | ✅ 存到 `site_config` | ✅ 任一裝置開官網或後台都會讀到同一份 |
| **前台整機販售商品**（上架管理、同步到前台） | ✅ 存到 `inventory` | ✅ 同上 |
| **庫存＋記帳**（品項、流水帳、訂單、支出） | ✅ 存到 `v2_data` | ✅ 換電腦／換瀏覽器會同步（需執行下方 SQL 建表） |

也就是說：

- **官網設定**、**前台商品**：只要 Supabase 設好，換電腦或換瀏覽器登入後台修改，都會存到雲端，再開就是同一份。
- **庫存＋記帳**（品項／流水帳／訂單／支出）：已同步到 Supabase 的 `v2_data` 表。後台每次儲存會自動上傳；切到「庫存＋記帳」分頁時會先從 Supabase 拉最新資料再顯示。請確認已執行 `supabase-tables.sql`（內含 `v2_data` 表）。

---

## 三、若出現「權限不足」或 401 / 403

Supabase 若開啟了 RLS（Row Level Security），預設可能不允許 anon 讀寫。

- 到 **Table Editor** → 點選 `site_config`（或報錯的那張表）→ **Policies**。
- 新增 Policy：**Allow all for anon**（或對 anon 開放 SELECT、INSERT、UPDATE、DELETE）。
- 對 `inventory`、`stock_data`、`orders_data` 也做同樣設定。

或到 **SQL Editor** 執行（把 `site_config` 換成其他表名即可）：

```sql
ALTER TABLE site_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON site_config FOR ALL TO anon USING (true) WITH CHECK (true);
```

---

## 四、總結

- **Supabase 你要改的**：建立專案 → 執行 `supabase-tables.sql` 建表 → 必要時設 RLS 讓 anon 能讀寫。
- **專案裡你要改的**：在 `shared.js` 把 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 換成你自己的。
- 完成後：**官網設定**、**前台整機商品**、**庫存＋記帳**（品項／流水帳／訂單／支出）都會存到 Supabase，換電腦或換瀏覽器登入後台都會看到同一份、修改會自動同步。
