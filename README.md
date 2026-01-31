# 現貨庫存網站（靜態版）

這是一個可直接在 Windows 開啟的靜態網站，提供：
- 首頁：庫存列表、搜尋、分類/庫存狀態篩選、加 LINE 下單按鈕
- 管理員：修改商家資訊（含 Google 商家連結）、設定 LINE 連結、管理庫存商品

## 使用方式

1. 直接雙擊開啟 `index.html`
2. 管理員後台：開啟 `admin.html`

## 管理員帳密

預設：
- 帳號：`admin`
- 密碼：`admin123`

可在 `admin.html` →「站台/商家設定」內修改。

## Google 商家連結

目前已設定為：
- `https://share.google/8KYdQojTnx4cKgqxz`

可在 `admin.html` 內調整。

## LINE 連結

目前已預設為：
- `https://lin.ee/zWYz2KH7`

可在 `admin.html` 內調整。

## Google 商家相片（你剛提供的那張）

我已先用你剛上傳的那張相片做為預設顯示（不需要你手動搬檔）。

如果你想要讓網站資料夾可獨立搬移/備份（不依賴 Cursor 內部路徑），建議你再做一次：
- 把照片放到 `assets/` 並命名為 `google-photo.png`
- 到 `admin.html` →「站台/商家設定」→「Google 商家照片路徑/網址」改成：`./assets/google-photo.png`

## 資料儲存位置

所有資料都存在同一台電腦/同一個瀏覽器的 `localStorage`：
- 站台設定：`dk_site_config_v1`
- 庫存資料：`dk_inventory_v1`

