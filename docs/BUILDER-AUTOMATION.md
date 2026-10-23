# 自動配單、外部需求查找與費用控制

本分支延續 PR #78，不修改訂單、庫存、營運資料或正式環境。正式 main 基底：9ede009。

## 本次行為

- 40 個本機名稱；24 個有明確標示的 DK 起始選配政策，含 GTA V Enhanced／Legacy、LOL、VALORANT、CS2、Apex、PUBG、Minecraft、常見文書、Photoshop、Premiere、OBS 等。其餘可查外部來源或先加入並保留限制。
- `builder-policy.js` 明列 CPU／GPU 候選集合，分項取需求上限，累加安裝空間並預留系統容量。這些是店家推估政策，不是跨平台實測排名，也不是 FPS 承諾。
- `data/builder-requirements.json` 為實際讀取的 9 份官方 Steam 商店需求快照，保留 app ID、來源、minimum/recommended 與抓取時間。只有明確可映射的硬體會轉成規則；例如 CS2 的泛稱顯卡、Apex 的泛稱 CPU，不假造對應型號，繼續採有標示的 DK 起始政策。
- 遊戲＋文書、多遊戲、同時執行都能推薦。未知項目、自由文字模組／特殊效能要求單獨標示「尚未涵蓋」，不封鎖整張配單，也不假稱已滿足。
- 螢幕不明時明說暫以 1080P 規劃。4K、畫面／流暢偏好調整規劃資源，不宣稱所有遊戲都能在指定設定達到相同 FPS。
- 大量多工／大型報表與 4K 剪輯改用結構化選項，預留 RAM／SSD；自由文字仍完整保留，尚未被規則解析的條件會列出。
- 超出預算保留原目標，另在能成立時提出 1080P 平衡方案；須客人確認才改需求與零件。沒有可行完整方案會明說；不改外觀、不隱藏缺項。
- 修改零件後沿用既有相容性與需求檢查。裝機前的 BIOS、未建檔接頭／尺寸等仍須核對，不把 3D 當相容認證。
- 舊草稿、其他／自備商品、照片及既有零件保留。需求資料更新由客人明確採用；採用資料仍不會偷偷更換已選零件。

## 外部查找流程

搜尋框按「搜尋更多遊戲／軟體」才發出有費用可能性的查找；輸入每個字不呼叫服務。前端只傳 query 與 kind，不傳姓名、聯絡資料、整份配單或工作量描述。

1. Edge 查共享資料庫快取。新鮮資料不用再搜尋；較舊資料遇限額或來源錯誤會標示日期與狀態。
2. SQL 交易鎖定設定行，先檢查啟用、帳務確認、月額度、每 IP／全站速率、同查詢短期去重，再預留本次額度。
3. 最多兩次 Brave Search，僅採可信官方網域；不是任意網址抓取器。
4. Steam 候選直接抓固定官方 appdetails 端點，取得真正的名稱、app ID 及需求；非 Steam 才用一次固定型號 OpenAI Responses 結構化整理。
5. AI 只能從來源摘錄抽取字面硬體需求，無權挑選商品或產生 FPS。引用網址必須真的出現在搜尋回應，證據與 CPU／GPU 必須存在於同一來源；映射不了就不建造效能規則。
6. 顯示候選版本供客人確認。名稱相近、續作、Enhanced／Legacy 不無聲合併。
7. 有可用需求的資料快取 7 天；找不到或需求不完整的資料快取 1 天。失敗不覆寫上一次成功資料。

官方商店端點也可能改版、限流、缺欄位或受地區限制；有超時、大小上限與失敗回退。非 Steam 目前抽取的是搜尋服務提供的官方來源摘錄，摘錄不足便保留未涵蓋狀態，尚未實作任意出版社全文爬取。不能宣稱已涵蓋全網所有軟體。

## NT$2,000 控制方式

資料庫設定採毫元記帳，所有表與 RPC 僅 service_role 可用；RLS 開啟，anon／authenticated 無直接存取權。

| 項目 | 預設預留 |
|---|---:|
| 月總額 | NT$2,000（SQL check 不允許超過） |
| 固定後端服務 | NT$1,000 |
| 匯差／稅費／用量緩衝 | NT$200 |
| 新資料查找可用額度 | NT$800 |
| 每次查找保守預留 | NT$10，約 80 次／月 |

固定費 NT$1,000 是待核對帳務的預留，**不是已確認訂閱費**。應在啟用前核對既有 Supabase 方案、其他用量、外部服務稅費與匯率，再設定實際固定預留。此次未取得服務商帳單，也沒有購買／升級任何方案。

費率依目前已查官方頁：Brave US$5/1,000 requests；OpenAI 固定 `gpt-6.1-sol` 標準短上下文每百萬 input/output tokens US$2/US$10。每次最大兩個搜尋、六段有限長度摘錄、1,800 output tokens，不重試；NT$10 以保守換算及餘裕預留。變更模型／費率／提示長度前必須重算預留額，不可只換環境變數繞過費用模型。

逾時或來源錯誤可能已產生帳單，因此不退還該次預留。SQL 併發測試保證本應用程式的預留帳不越界；這不等於能封鎖服務商帳戶的其他程式費用、固定費調價或所有帳單超額。服務商帳戶仍應隔離本功能金鑰／專案並設定可用的用量限制。

管理員後台新增「配單服務用量」，使用現有使用者 JWT，後端核對 profiles.enabled 與 role=admin。達可用查找額度 80% 顯示提示，耗盡停止新付費查找；已保存資料與配單繼續使用。此提示是登入後台時／點擊查看時讀取，不會發送 email／LINE。

## 更新排程

準備 `builder-research-daily`：每天台灣 03:10（UTC 19:10），最多整理 3 個已到期的快取，7 天 TTL；與消費者共用額度與去重限制。這是**每天檢查一批到期項目**，不是每天全網掃描所有遊戲，更不是遊戲每次改版後都有最新實測。

來源下修或抓取失敗不覆寫成功快取。已保存配單保留資料版本，前端取得較新資料後可提示採用；不自動換零件。商品價格仍沿用現有 catalog 快照，本次未建立原價屋持續更新或 DK 即時供貨同步。

只讀查核正式專案：目前有 Vault，尚無 pg_cron／pg_net，且尚無本功能表。排程 migration 缺前置擴充時明確 NOTICE，不安裝或改動正式環境；啟用擴充後必須重新執行該 migration，確認工作真的註冊。

## 啟用前的必要設定（目前均未部署／啟用）

1. 確認月固定費與帳務歸屬；使用專用 Brave／OpenAI 金鑰，放 Supabase Edge Function Secrets，不貼聊天、不提交 Git、不放前端。
2. 設定 `BUILDER_BRAVE_API_KEY`、`BUILDER_OPENAI_API_KEY`、`BUILDER_RATE_SALT`、`BUILDER_CRON_TOKEN`。後兩者為隨機長字串。開發 localhost 僅使用專屬 `BUILDER_DEV_ORIGIN`，正式不開放任意 origin。
3. 在獨立測試環境套用三份 migration、部署 `builder-research`（verify_jwt=false；公眾查找內建 SQL quota，管理員端點另驗 JWT）。測試長尾遊戲、一般軟體、多版本候選、實際 provider 費用與失敗率。
4. 啟用 pg_cron、pg_net；在 Vault 放 `builder_research_cron_token`，值與 Edge secret 相同；另設定 `builder_research_function_url` 為同一環境的函式 HTTPS URL，避免測試排程連到正式環境。重新執行排程 migration，確認 cron.job 和執行紀錄。
5. 核對來源、費率和真實帳單後，才設定 `billing_confirmed=true, enabled=true`。預設 false 是為避免合併後直接產生費用。
6. 正式遷移／後端部署、金鑰及排程確認、前端發布後做真實端到端 smoke test。此 PR 先供審查，尚不能把 mock 測試寫成「線上搜尋已通過」。

## 驗證與限制

- Node 核心／DOM：`node --test tests/builder-core.cjs tests/builder-experience.cjs tests/builder-ui.cjs`
- Provider 與 Edge 模擬：`node --test tests/builder-research.cjs tests/builder-edge.cjs`
- 隔離 Postgres（PGlite）：`node --test tests/builder-research-db.cjs`，涵蓋重複遷移、權限、同時預留、固定費合計上限、速率、失敗與舊資料保留。
- Chromium：`node --test tests/builder-browser.cjs tests/builder-other-browser.cjs tests/builder-preview-browser.cjs tests/builder-auto-browser.cjs`，涵蓋 1440px／390px、草稿、相片、3D、外部候選與版本確認、額度耗盡和明確確認預算取捨。外部查找以 stub 測試，不發付費要求。
- Source capture：`node scripts/capture-builder-requirements.mjs`，只讀官方來源；失敗保留既有快照，不更新正式資料。

本機測試依賴使用環境 NODE_PATH 的 jsdom／PGlite／Playwright；不增加前台依賴，也不提交 node_modules 或金鑰。正式 migration、真實 Cron、Brave／OpenAI 的端到端呼叫與實際費用尚未驗證，須先完成上述設定。

## 本次本機結果

92 項驗證通過（含配單、外部 provider／Edge 模擬、隔離 Postgres、後台導航／草稿／備份回歸與 5 項真實瀏覽器測試）；11 個實際需求案例見 `BUILDER-VALIDATION.md`。最後調整排程同環境 URL 後另重跑隔離遷移測試。沒有使用正式訂單或庫存當測試資料。

## 本次前端發布

`builder-service-config.js` 的 enabled 預設 false。合併後先上線常見需求自動配單；公眾查找、啟動時讀取遠端需求與後台用量不會呼叫尚未部署的函式。完成真實服務設定／帳務／後端測試後，才以另一個受驗證的變更開啟旗標。
