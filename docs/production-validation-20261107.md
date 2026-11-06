# DK 官網正式驗收紀錄（2026-11-07，台北時間）

基準：GitHub main `2e7d576c5e41d357dbde8d8f97cdd2045a6dbaf1`；正式 Supabase `npynqrsmduukulwgylkz`。

## 已完成

- 以正式資料庫純結構建立隔離 PostgreSQL（PGlite）：62 表、237 函式、320 約束、55 trigger、85 policy；未複製任何營運資料或 Auth 使用者。
- 使用原函式、原 grants 與原 RLS 執行訂單→採購→到貨→序號→收款交付→結單；驗證 6,000 售價、4,000 成本、兩筆入出庫流水、最終可用庫存 0。
- 驗證過期版本與重複到貨拒絕、序號大小寫防重、作廢對帳後重新建立、已付款不重複對帳、付款重送不重複產生費用。
- 驗證無後台 profile 的登入使用者遭拒絕；匿名不能讀訂單／配單紀錄或呼叫後台 RPC；匿名僅能送出 new 配單，不能偽造 converted 狀態。
- 目前正式配單頁的 Chromium E2E：1440px／390px、搜尋、加選、總價、重整保留、失敗保留、成功送出、列印按鈕。
- 舊問卷 UI 改用歷史頁面／目錄測試 fixture，與目前正式配單 E2E 分開，避免舊 DOM 測試誤判。目前正式商品目錄更新到本次原價屋實際快照。
- 原價屋：實際 6,285 筆；欣亞：實際 1,371 筆；AUTOBUY：實際 1,971 筆。AUTOBUY 同時核對 option price attribute 與 ☆價格元；數字不一致、搭板、組合等不採用。
- 新增每日台灣時間 09:17／13:17／17:17 自動蒐集與正式原價屋目錄更新。失敗保留最後成功快照，狀態公開在 `data/market-sources/health.json`；逐筆來源快照以 gzip 保存。
- 欣亞依官網公開 DIY 分類 metadata 與 gateway API 抓取 11 類零件；保留完整分類涵蓋與排除紀錄。任何分類 HTTP／格式錯誤會中止整個欣亞快照，保留最後成功資料。實際來源驗證：GitHub Actions run 42254959734 通過。
- 正式報價仍只用原價屋；欣亞／AUTOBUY 不混入正式售價。
- 固定驗證依賴版本與 lockfile，新增全套 Regression／隔離 E2E GitHub Actions。

- 正式站部署前 Smoke 發現首頁四個預設圖片 404：已在前端將三個舊入口圖片參照映射到既有素材，Hero fallback 改用既有工作室圖片；不修改 site_config 或後台自訂圖片。

## Security Audit

- public 62 表均啟用 RLS；3 個 view 均為 security_invoker。
- 168 個 public SECURITY DEFINER 函式均設定 search_path；anon 對這些函式的 execute 權限為 0。
- 額外在隔離正式結構對 106 個 authenticated SECURITY DEFINER 入口執行無 profile 身分的拒絕探測：104 個拒絕，兩個公開授權 helper 僅回傳 false；每次以 savepoint 回滾。
- 106 個 authenticated SECURITY DEFINER 掃描警告：這些是後台 RPC／授權 helper 的預期入口，具有 profile／角色授權或受保護的內部呼叫，不能一律撤權。兩個訂單 wrapper 委派到 dk_save_order_v2，由 dk_require_backoffice 查正式 profile 授權。
- 9 個 RLS 無 policy 提示是禁止直連的內部／舊表；不因消除提示而開放資料。
- 唯一仍需設定的 Auth 警告：Leaked Password Protection 未開啟。官方文件確認此功能需 Pro 以上；Dashboard 目前未登入，未代改密碼或提升任何存取權。官方說明：https://supabase.com/docs/guides/auth/password-security
- 本次未變更正式 schema、權限、營運資料或 Auth 使用者。無正式遷移或資料回填。

## 尚未完成與驗收邊界

- 真實 Auth E2E 仍需獨立 Supabase 測試環境。已確認現有專案沒有隔離分支；建立分支被平台拒絕，原因為需 Pro 以上。未升級、未產生新費用，未把正式資料庫用作替代測試環境。
- 瀏覽器送單測試攔截傳輸；資料庫流程獨立在正式結構隔離副本執行，Auth claims 使用本機 stub。這不等同已完成真實 Auth 登入與所有後台畫面串接的完整 E2E。
- 未進行任何正式下單、收款、到貨、扣庫存或付款測試；真實 Safari、實體條碼槍與紙本列印仍未驗收。
- 三家抓價已通過實際來源驗證；仍不能將本次範圍標示為「全部完成／完整正式營運驗收通過」。

## 驗證結果

- 第一輪完整本機與 GitHub CI：331 項通過。新增欣亞真實 fixture／11 類完整性與中途失敗保護後共 334 項。
- 已部署 PR #102；正式站 index／builder／admin 登入頁／valuation／shop 均為 HTTP 200，執行錯誤 0、缺失資源 0。Smoke 封鎖 POST，未送出正式訂單或 analytics 事件。
- 暫時來源診斷 workflow 不合併至 main；只保留正式解析器、測試、經驗證快照及正式排程。

## 重跑

`npm ci --ignore-scripts`；設定 `DK_TEST_CHROME` 為可執行的 Chromium headless shell 後執行 `npm test`。

`node scripts/collect-market-sources.mjs`：任何來源失敗回傳 exit 2，同時保存成功來源與 health；不會偽造成功。

`node scripts/sync-coolpc-catalog.mjs`：正式原價屋目錄原子更新，來源結構或商品數異常時保留既有檔案。

排程 commit 以一般 push 寫入，main 同時更新時會拒絕，避免覆蓋；Pages 使用明確 deploy job，避免 GITHUB_TOKEN commit 不觸發 Pages 的問題。
