# 後台功能與 Supabase 同步檢查清單

## 一、已修復：新後台（admin-v2.html）未同步 Supabase

**問題**：新後台頁面沒有載入 `shared.js`，因此：
- 開新後台時**不會**從 Supabase 拉取最新的「品項／流水帳／訂單／支出」
- 在新後台儲存時**不會**觸發寫回 Supabase（`__syncV2ToSupabase` 未定義）

**修復**：已在 `admin-v2.html` 的 `<script>` 中**補上** `shared.js`，且排在 `inventory-ledger.js` 之前。

載入順序現在為：
1. `shared.js`（設定 Supabase 連線、`fetchV2DataFromSupabase`、`__syncV2ToSupabase`，並在載入時拉一次 v2 資料）
2. `inventory-ledger.js`（庫存＋記帳邏輯，儲存時會呼叫 `__syncV2ToSupabase`）
3. `admin-v2.js`（新後台 UI）

因此使用 **admin-v2.html** 時也會：
- 進入頁面時從 Supabase 拉取 v2 資料
- 每次儲存品項／流水／訂單／支出時自動寫入 Supabase `v2_data` 表

---

## 二、Supabase 同步對照（簡表）

| 功能 | Supabase 表 | 讀取時機 | 寫入時機 |
|------|-------------|----------|----------|
| 官網設定（前台管理） | `site_config` | 後台載入／儲存後 | 儲存設定時 |
| 前台整機商品（上架） | `inventory` | 後台／前台載入時 | 上架／編輯／下架時 |
| 庫存＋記帳 v2（品項／流水／訂單／支出） | `v2_data` | **任何有載入 shared.js 的頁面**載入時會拉一次；舊後台切到「庫存＋記帳」再拉一次 | **每次** saveItems / saveLedger / saveOrders / saveExpenses 會觸發 `__syncV2ToSupabase` → 寫入 `v2_data` |

**注意**：`shared.js` 內已填 `SUPABASE_URL` 與 `SUPABASE_ANON_KEY`；若兩者為空，所有同步都會改為僅用 localStorage，不連 Supabase。

---

## 三、建議你自行驗證的項目

### 1. 新後台（admin-v2.html）功能

- [ ] **庫存品項**：新增／編輯／刪除品項，列表與表單正常，儲存後重新整理仍存在。
- [ ] **流水帳**：新增一筆入庫／出庫／調整，列表顯示正確；刪除「該品項最新一筆」可成功，庫存數量會回復。
- [ ] **訂單**：新增／編輯訂單，明細、毛利顯示正常，儲存後重新整理仍存在。
- [ ] **支出**：新增／刪除支出，列表與金額正常。
- [ ] **報表**：本週毛利、庫齡排行、待整理／待測、待出清等有資料時會顯示。

### 2. 新後台與 Supabase 同步（v2_data）

- [ ] 開 **admin-v2.html**，到 Supabase **Table Editor → v2_data**，確認有 `id = default` 一列，且 `data` 內有 `items`、`ledger`、`orders`、`expenses`。
- [ ] 在新後台**新增一筆品項**或**一筆流水**後儲存，重新整理 **v2_data** 表，該筆資料應出現在對應的 `data.items` 或 `data.ledger` 中。
- [ ] 換瀏覽器（或無痕）開 **admin-v2.html**，應能看到剛新增的資料（代表是從 Supabase 拉下來，而不是只存在本機）。

### 3. 舊後台（admin.html）與 Supabase

- [ ] 登入後切到「庫存＋記帳」：若 shared.js 已載入，會再拉一次 v2 資料，品項／流水／訂單／支出應與新後台一致。
- [ ] 在舊後台修改任一 v2 資料並儲存，到 Supabase **v2_data** 應能看到更新；再開新後台或換裝置，應看到同一份資料。

### 4. 前台與 Supabase（inventory）

- [ ] 後台「上架管理」上架商品後，到 Supabase **Table Editor → inventory**，應有對應列。
- [ ] 前台整機販售頁（machine.html）重新整理後，應顯示與後台一致的架上商品（machine.js 會從 Supabase 拉 inventory）。

---

## 四、若同步失敗可檢查

1. **Supabase 表是否建好**  
   請在 Supabase **SQL Editor** 執行專案內的 `supabase-tables.sql`，確保有 `v2_data`、`inventory`、`site_config` 等表。

2. **RLS（Row Level Security）**  
   若 Supabase 開啟 RLS 且出現權限錯誤，需在該表新增 Policy 允許 `anon` 讀寫（或依你需求設定）。

3. **瀏覽器主控台**  
   儲存時若有錯誤，會出現 `同步庫存＋記帳到 Supabase 失敗` 或類似訊息；可依錯誤內容檢查網址、key、表名與欄位。

4. **載入順序**  
   使用 **admin-v2.html** 時，務必保持 `<script src="./shared.js">` 在 `inventory-ledger.js` 之前，否則 v2 仍不會同步到 Supabase。

---

以上為目前後台功能與 Supabase 同步的狀態說明與建議檢查項目；若你實際操作時有哪一步不如預期，可把畫面或錯誤訊息貼出，再針對該步驟排查。
