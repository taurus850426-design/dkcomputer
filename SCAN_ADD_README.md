# 掃碼新增庫存 - 使用說明

## 使用方式

1. **進入後台** → 點「庫存＋記帳」→ 庫存品項。
2. 點 **「📷 掃碼新增」**（會開新分頁或新視窗）。
3. 在掃碼頁：
   - **手機**：點「開啟相機拍照」→ 對準條碼或 QR 碼拍照。
   - **電腦**：點「從相簿選擇」→ 選一張含條碼/QR 的圖片。
4. 辨識成功後會帶出 **品類、細分類、品牌、型號、規格、建議 SKU**；若辨識不完整會顯示「查不到/不確定，請手動補齊」。
5. **補填或修改**：數量、單位成本、位置、備註等，必要時改 SKU/品牌/型號。
6. 點 **「儲存入庫」**：
   - 若 SKU 已存在 → 數量累加，並寫入一筆入庫流水（IN）。
   - 若 SKU 不存在 → 建立新品項並寫入一筆入庫流水（IN）。
7. 入庫完成後可點「再掃一筆」或「回庫存列表」。

## 測試資料建議

| 類型 | 可掃內容（或手動輸入到備註當 raw_code 測試） | 預期結果 |
|------|---------------------------------------------|----------|
| 顯卡 | QR 或文字含 `RTX 3060 Ti`、`MSI`、`8G` | 品類=顯卡，細分類=GPU，規格帶 8G |
| CPU | 文字含 `i5-8400`、`Ryzen 5 7600` | 品類=零件，細分類=CPU |
| SSD | 文字含 `SSD`、`512G`、`NVMe` | 品類=零件，細分類=SSD，規格 512GB |
| RAM | 文字含 `DDR4`、`16G` | 品類=零件，細分類=RAM，規格 16G |
| 主機板 | 型號開頭 `B550`、`H610` | 品類=零件，細分類=主機板 |

**沒有實體條碼時**：可先點「從相簿選擇」選任意圖，若辨識不到會顯示「未辨識到條碼／QR」；或到「新增品項」手動新增一筆，再到「掃碼新增」用同一 SKU 測試「累加入庫」。

## 規則引擎（初版）說明

- **GPU**：model/spec 含 RTX / GTX / RX / ARC，或品牌為 MSI / ASUS / Gigabyte 等 → category=GPU, sub_type=GPU，並嘗試抓 8G/12G 等 VRAM。
- **CPU**：含 i3/i5/i7/i9、Ryzen、或 8400/12400/7600 等型號數字 → category=PART, sub_type=CPU。
- **SSD/HDD**：含 SSD / NVMe / M.2 / HDD → sub_type=SSD 或 HDD，並抓 120/240/512/1T 等容量。
- **RAM**：含 DDR3/DDR4/DDR5/DIMM → sub_type=RAM，並抓 8G/16G/32G。
- **主機板**：型號開頭為 H610/B550/Z690 等晶片組 → sub_type=MOTHERBOARD。
- **其他**：未命中 → category=PART, sub_type=OTHER；confidence &lt; 0.6 時會提示手動補齊。

## 資料欄位對應

- **Items**：category, sub_type, sku, brand, model, name, spec, condition, status, qty_on_hand, cost_unit, inbound_date, last_moved_at, location, notes, reorder_point（與現有庫存品項一致，多 sub_type / brand / model）。
- **InventoryLedger**：item_id, type=IN, qty, unit_cost, ref_type=PURCHASE, ref_id, created_at, note。

## 注意事項

- 掃碼頁需與後台同網域（或同 origin），才能共用 `DK` 與 localStorage/Supabase。
- 手機建議用瀏覽器開後台網址，再點「掃碼新增」，即可用相機掃描，無須安裝 APP。
