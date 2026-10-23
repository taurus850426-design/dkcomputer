# 白話配單第一版（開發稿，2026-10-23）

基線：`main` / `2ade804cec64f491ce4fd4424382ae96af9085b8`（PR #75）。

## 已實作

- `builder.html`：用途複選 → 遊戲／軟體 → 遊玩目標 → 主機預算、螢幕與外觀 → 需求摘要 → 八類零件逐頁選擇 → 複製完整需求並由顧客自行貼到官方 LINE。
- `index.html`：導覽與首頁新增「我要配電腦」入口，沿用首頁既有入口樣式。
- 30 分類、6,322 筆原價屋商品／一般標價快照；排除 34 筆獨家標示、205 筆條件價格。來源為公開估價頁，不複製圖片，不使用來源腳本。
- 獨家排除同時考慮商品、分類與後續說明；一般標價後附帶的「任搭折扣」不會被錯當成已扣折扣價。
- 依完整名稱產生穩定 ID，後台人員可在 `data/builder-overrides.json` 的 `blockedIds` 排除無法供貨或未標示的獨家品項。
- CPU 插槽、記憶體世代、主機板尺寸、顯示卡與散熱器空間的初步過濾；更換平台前確認是否移除相衝突的選項。未知規格不得當成已相容。
- 已選零件小計、超出預算提示、手機固定小計列、本機草稿自動保存、重新載入時依當前商品與價格重算。
- 分頁顯示商品，避免一次渲染六千筆；每個零件預設四個選項，可搜尋／展開更多。
- 英雄聯盟、特戰英豪、電馭叛客 2077 的部分官方需求目標，附來源與查核日期。其他遊戲與軟體可自填。

## 尚未完成，不能宣稱已正式可用

1. **遊戲畫質／幀數到現售零件的可靠對照。** 官方需求可查閱，目前「產生草稿」只依預算、容量與基本規格分配，不代表已達到某遊戲目標。沒有完整效能資料前，不啟用達標／FPS 保證。`reviewedRecipes` 尚無經 DK 核可的配置。
2. **完整相容性。** BIOS／CPU 支援表、記憶體 QVL、SSD 插槽、散熱器扣具與解熱能力、電源接頭與功耗仍須人工核對。資料不足時保留空缺；尤其未補散熱器扣具資料前，不能自動搭配獨立散熱器。
3. **供貨核可。** 原價屋上架不代表 DK 可供貨；第一版所有金額均為參考零件小計，不能拿來直接下單付款。
4. **長期價格同步與來源使用條件。** 已完成人工觸發的一次請求同步工具、失敗保留舊資料與過期提示；尚未設定排程，也未確認來源允許的商業同步方式或取得授權。抓取成功不代表有長期再利用授權。
5. **正式發布。** 本版供開發審查；不修改正式 Supabase 資料、不部署函式、不合併 main。需完成上述資料核對，再依既有 GitHub 審查流程決定發布。

## 更新商品快照

Node 內建功能，無新增正式執行相依套件：

```bash
node scripts/sync-coolpc-catalog.mjs
```

只送一個來源請求，驗證分類與筆數，成功才原子替換 `data/builder-catalog.json`。抓取失敗或總數減少超過 30% 時中止並保留舊檔；需先人工檢查來源結構，不能直接繞過錯誤。此指令不會自行 commit、push 或更新官網。

`--input /absolute/path/to/decoded-source.html` 可用已下載且解碼成 UTF-8 的快照重跑解析；更新時間保留輸入檔的 mtime，不能把重新解析時間當成新抓取時間。

商品名稱更動時會產生新 ID，舊草稿該項目移除並提醒核對，不以模糊比對偷偷換型號。

## 驗證

```bash
node --check builder-core.js
node --check builder.js
node --check scripts/coolpc-catalog.mjs
node --check scripts/sync-coolpc-catalog.mjs
node --test tests/builder-core.cjs tests/builder-catalog.mjs
# 以下 UI 測試使用既有測試慣例的 jsdom，瀏覽器測試使用 playwright。
node --test tests/builder-ui.cjs
node --test tests/builder-browser.cjs
git diff --check
```

本次開發環境的 jsdom 安裝在 `/tmp/dk-builder-qa`，Chromium 在 `/tmp/chromium`；未加入正式依賴。

```bash
NODE_PATH=/tmp/dk-builder-qa/node_modules node --test tests/builder-ui.cjs
DK_TEST_CHROME=/tmp/chromium node --test tests/builder-browser.cjs
```

本次共 22 項新增測試通過。真實瀏覽器檢查 1440×1000 與 390×844：流程、搜尋、重載草稿與總價、首頁入口均可操作，無水平溢出與頁面 JavaScript 錯誤。測試阻擋所有外部請求，沒有建立正式訂單、寫入正式庫存或修改資料庫。沒有修改後台或共用核心；未重新驗收所有後台營運流程。
