# 官網放到 GitHub 並用網址登入後台

## 可以，而且很適合這樣做

- **全部程式**都可以放到 GitHub。
- 部署成「有網址的網站」後，用 **網址 + `/admin.html`** 就能登入後台修改。
- 若要「改一次、大家看到同一份內容」，需要搭配 **Supabase**（你專案已接好）。

---

## 一、把專案放到 GitHub

1. 在專案資料夾打開終端機（PowerShell 或 CMD）。
2. 若還沒用過 git，先初始化並提交：

```bash
cd dkcomputer-main
git init
git add .
git commit -m "初始：官網與後台"
```

3. 到 [GitHub](https://github.com/new) 建立一個**新 repo**（例如 `dkcomputer`），不要勾選「Add a README」。
4. 照 GitHub 頁面上的指示，把本機專案推上去：

```bash
git remote add origin https://github.com/你的帳號/dkcomputer.git
git branch -M main
git push -u origin main
```

之後有改動就：`git add .` → `git commit -m "說明"` → `git push`。

---

## 二、部署成「有網址的網站」（任選一種）

部署後你會得到一個網址，例如：  
`https://你的帳號.github.io/dkcomputer/` 或 `https://dkcomputer.netlify.app`。

### 方式 A：GitHub Pages（免費、簡單）

1. 到該 repo 的 **Settings → Pages**。
2. **Source** 選 **Deploy from a branch**。
3. **Branch** 選 `main`，資料夾選 **/ (root)**，儲存。
4. 幾分鐘後網址會是：  
   `https://<你的帳號>.github.io/<repo 名稱>/`
5. **後台網址**就是：  
   `https://<你的帳號>.github.io/<repo 名稱>/admin.html`

注意：若 repo 名稱不是 `你的帳號.github.io`，網址會帶 repo 名稱，例如 `/dkcomputer/`。你的站內連結若是相對路徑（`./admin.html`、`./index.html`），會正常運作。

### 方式 B：Netlify（免費、可自訂網域）

1. 到 [Netlify](https://www.netlify.com/) 登入，**Add new site → Import an existing project**。
2. 選 **GitHub**，授權後選你的 repo。
3. **Build command** 留空，**Publish directory** 填 `.` 或專案根目錄。
4. 部署完成後會給一個 `xxx.netlify.app` 網址。
5. **後台網址**：`https://xxx.netlify.app/admin.html`

### 方式 C：Vercel

類似 Netlify，連到 GitHub repo，根目錄發布，得到 `xxx.vercel.app`，後台即 `https://xxx.vercel.app/admin.html`。

---

## 三、用網址登入後台修改

1. 瀏覽器打開：**你的網站網址 + `/admin.html`**  
   例：`https://你的帳號.github.io/dkcomputer/admin.html`
2. 輸入後台帳密（預設為 `admin` / `admin123`，可在程式或之後後台設定中改）。
3. 登入後即可改：前台設定、LINE 連結、庫存、上架、訂單等。

---

## 四、資料會不會「存下來」？關鍵在 Supabase

| 情況 | 說明 |
|------|------|
| **只部署、沒用 Supabase** | 設定與庫存存在**瀏覽器的 localStorage**。換電腦、換瀏覽器、無痕模式就看不到之前改的；訪客看到的也不會是你後台改的那一份。 |
| **有接 Supabase（你專案已預留）** | 官網設定、庫存、訂單可存到 Supabase。你在**任何裝置**用網址開 `admin.html` 修改，存檔後都會寫進 Supabase；訪客開首頁／整機頁時會從 Supabase 讀，所以**大家看到同一份內容**。 |

你專案裡 `shared.js` 已有 Supabase 的 URL 與 key，並有讀寫 `site_config`、庫存、訂單的邏輯。要讓「放到 GitHub + 用網址登入後台」真正有用，請：

1. 在 [Supabase](https://supabase.com) 建立專案（若還沒有）。
2. 在 Supabase 建立所需表（可參考專案裡的 `SUPABASE_AND_CHECK.md`、`schema.sql`）。
3. 把 `shared.js` 裡的 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 改成你專案的值（這兩個會跟著程式一起放在 GitHub，屬「可公開」的 anon key；敏感權限用 Supabase RLS 控管）。

這樣你放到 GitHub 並部署後，用網址開後台修改，就會寫進 Supabase，全站都看到同一份資料。

---

## 四之一、用網址登入後上架，Supabase 卻沒有資料？

**原因**：你現在看到的網址（例如 `https://taurus850426-design.github.io/dkcomputer/`）是 **GitHub Pages 從某個 repo 建出來的**。若那個 repo 裡的 `shared.js` **沒有填** `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`，或填的是舊的，上架只會存到該瀏覽器的 localStorage，**不會寫入 Supabase**。

**請這樣做**：

1. **確認「要部署的那份」shared.js 有填 Supabase**  
   在你要推上去、並用來開 GitHub Pages 的專案裡，打開 `shared.js`，確認最上面有：
   - `SUPABASE_URL = "https://你的專案.supabase.co"`
   - `SUPABASE_ANON_KEY = "你的 anon key"`

2. **把目前這份程式推上去**  
   `git add .` → `git commit -m "補上 Supabase 並修正圖片 404"` → `git push`  
   等 GitHub Pages 重新部署（約 1～2 分鐘）。

3. **再測一次**  
   用網址開 **admin.html** → 上架一筆商品 → 開 F12 → **Console** 看有沒有出現  
   `[Supabase] 未設定 SUPABASE_URL 或 SUPABASE_ANON_KEY...`  
   若有，代表畫面上跑的仍是沒填 key 的版本。到 **Network** 找對 `supabase.co/rest/v1/inventory` 的 **POST** 請求，看狀態碼與回應。

4. **Supabase RLS**  
   若 POST 回 403，到 Supabase Dashboard → 該表 → RLS 新增 Policy 允許 `anon` 讀寫。

---

## 五、安全提醒

- **後台帳密**：目前是前端的簡單檢查，有心人若看程式碼會知道登入方式。若只給自己用、且 Supabase 有設 RLS，一般這樣即可。
- **Supabase**：anon key 可放在 repo；重要資料用 RLS 限制誰能讀寫。
- 若之後把密碼或 key 改成用「環境變數」放在 Netlify/Vercel，記得在 `.gitignore` 列出 `.env`，不要 commit 進 GitHub。

---

## 快速對照

| 項目 | 說明 |
|------|------|
| 程式放 GitHub | ✅ 整個專案 push 上去即可 |
| 用網址開後台 | ✅ 部署後打開 `你的網址/admin.html` 登入 |
| 改一次大家看到 | ✅ 需 Supabase 已設定並在 shared.js 填好 URL/key |
| 僅 localStorage | 只有當時那台電腦、那顆瀏覽器有資料，不適合當唯一後台 |

依照上面步驟，就可以把官網放到 GitHub，並用網址登入後台進行修改；搭配 Supabase 後，修改會存到雲端、全站一致。
