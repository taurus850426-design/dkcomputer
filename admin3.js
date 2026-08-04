/* admin3.js - 後台 3 大模組：庫存 / 訂單 / 報表（localStorage + Supabase 前台商品） */

(async function () {
  // ---------- storage ----------
  const KEYS = {
    items: "dk_im_items_v1",
    orders: "dk_im_orders_v1",
    seq: "dk_im_seq_v1",
  };

  const INV_STATUSES = ["可售", "待測", "待整理", "保留", "待出清", "報廢拆料", "已售出"];
  const INV_STATUS_LEGACY_MAP = { "在庫": "可售", "測試中": "待測", "已預定": "保留", "不良品": "報廢拆料" };
  const INV_PRODUCT_TYPES = ["成品", "核心零件", "耗材", "維修待處理"];
  const CLEAN_STATUSES = ["未清潔", "已清潔"];
  const SHIP_STATUSES = ["未出貨", "已出貨", "已取消"];
  const ORD_INCOME_TYPES = ["整新主機銷售", "顯卡銷售", "零件/耗材銷售", "維修/安裝服務費", "運費收入", "加購升級費", "其他"];
  const INV_AGE_DAYS = { normal: 14, attention: 30, warning: 60 }; // 0-14 正常, 15-30 注意, 31-60 警戒, 60+ 出清

  function safeParse(v, fallback) {
    try {
      if (!v) return fallback;
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  // v2Esc：HTML escape helper（部分區塊會用到；避免因未定義而中斷整支後台 JS）
  // 這裡提供上層可用版本；v2 DK 區塊內若有同名函式，屬於區域遮蔽，不互相影響。
  function v2Esc(s) {
    if (s == null || s === undefined) return "";
    const t = String(s);
    if (window.DK && typeof window.DK.escapeHtml === "function") return window.DK.escapeHtml(t);
    const div = document.createElement("div");
    div.textContent = t;
    return div.innerHTML;
  }

  // ---------- keys（放在最前面避免 TDZ：Cannot access before initialization） ----------
  const CUSTOMER_RECORDS_KEY = "dk_customer_records_v1";
  const CREATE_ORDER_FROM_CUSTOMER_KEY = "dk_create_order_from_customer";
  const PENDING_CUSTOMER_ORDER_LINK_KEY = "dk_pending_customer_order_link";
  const VENDOR_QUOTES_KEY = "dk_vendor_quotes_v1";

  // ---------- 緊急救援：repairAdmin=1 時只補回 config.admin ----------
  (function repairAdminIfRequested() {
    let repair = null;
    try {
      const sp = new URLSearchParams(String(location.search || "").replace(/^\?/, ""));
      repair = sp.get("repairAdmin");
    } catch (_) {
      repair = null;
    }
    if (repair !== "1") return;

    try {
      const cfgKey = window.DK?.STORAGE_KEYS?.config || "dk_site_config_v1";
      const raw = localStorage.getItem(cfgKey);
      const saved = safeParse(raw, null);
      const base = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};

      const defAdmin =
        (window.DK?.DEFAULT_CONFIG && window.DK.DEFAULT_CONFIG.admin) ||
        { username: "admin", password: "admin123" };

      const hasAdmin = base.admin && typeof base.admin === "object" && !Array.isArray(base.admin);
      const next = hasAdmin
        ? {
            ...base,
            admin: {
              ...defAdmin,
              ...base.admin,
            },
          }
        : {
            ...base,
            admin: { ...defAdmin },
          };

      localStorage.setItem(cfgKey, JSON.stringify(next));
      alert("admin 設定已修復，請移除網址 repairAdmin=1 後重新登入");
    } catch (e) {
      alert("admin 修復失敗：" + String(e?.message || e || "未知錯誤"));
    }
  })();

  function loadArr(key) {
    const v = safeParse(localStorage.getItem(key), null);
    return Array.isArray(v) ? v : [];
  }

  function saveArr(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr));
  }

  function loadObj(key) {
    const v = safeParse(localStorage.getItem(key), null);
    return v && typeof v === "object" ? v : {};
  }

  function saveObj(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }

  function pad3(n) {
    return String(n).padStart(3, "0");
  }

  function isoDate(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function norm(s) {
    return String(s ?? "").trim().toLowerCase();
  }

  function toNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function nextSeq(scopeKey) {
    const seq = loadObj(KEYS.seq);
    const cur = Number(seq[scopeKey] || 0);
    const next = cur + 1;
    seq[scopeKey] = next;
    saveObj(KEYS.seq, seq);
    return next;
  }

  function sanitizeCode(s) {
    return String(s || "")
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]/g, "")
      .slice(0, 12);
  }

  function makeItemId(prefix, modelCode) {
    const p = sanitizeCode(prefix) || "ITEM";
    const m = sanitizeCode(modelCode) || "X";
    const base = `${p}-${m}`;
    const n = nextSeq(`item:${base}`);
    return `${base}-${pad3(n)}`;
  }

  function makeOrderId(dateStr) {
    const d = String(dateStr || isoDate()).replaceAll("-", "");
    const n = nextSeq(`ord:${d}`);
    return `ORD-${d}-${pad3(n)}`;
  }

  function makeWebItemId() {
    const n = nextSeq("web");
    return `WEB-${pad3(n)}`;
  }

  function sellableQty(it) {
    const qty = Number(it?.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    const s = normalizeInvStatus(it?.status);
    return s === "可售" ? qty : 0;
  }

  function normalizeInvStatus(s) {
    return INV_STATUS_LEGACY_MAP[s] || s || "可售";
  }

  function getDaysOnHand(it) {
    const d = String(it?.dateIn || it?.createdAt || "").slice(0, 10);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const then = new Date(d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    then.setHours(0, 0, 0, 0);
    return Math.floor((today - then) / (24 * 60 * 60 * 1000));
  }

  function getAgeLevel(days) {
    if (days == null || days < 0) return null;
    if (days <= INV_AGE_DAYS.normal) return "normal";
    if (days <= INV_AGE_DAYS.attention) return "attention";
    if (days <= INV_AGE_DAYS.warning) return "warning";
    return "clearout";
  }

  // ---------- DOM ----------
  const loginCard = document.getElementById("loginCard");
  const panel = document.getElementById("panel");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const loginError = document.getElementById("loginError");
  const usernameEl = document.getElementById("username");
  const passwordEl = document.getElementById("password");

  // 只針對主 tab（有 data-tab 的）做切換，避免點 v2 子 tab 把整個 panel 關掉
  const tabs = Array.from(document.querySelectorAll("#panel > .tabs > .tab[data-tab]"));
  const tabInv = document.getElementById("tab-inv");
  const tabPublish = document.getElementById("tab-publish");
  const tabFrontend = document.getElementById("tab-frontend");
  const tabVendors = document.getElementById("tab-vendors");
  const tabPurchase = document.getElementById("tab-purchase");
  const tabCustomers = document.getElementById("tab-customers");

  // publish
  const publishSubmitBtn = document.getElementById("publishSubmitBtn");
  const publishWebGrid = document.getElementById("publishWebGrid");
  const publishMsg = document.getElementById("publishMsg");
  const publishFormCard = document.getElementById("publishFormCard");
  const publishEditor = document.getElementById("publishEditor");
  const publishEditorTitle = document.getElementById("publishEditorTitle");
  const publishEditorCloseBtn = document.getElementById("publishEditorCloseBtn");
  const publishEditorMsg = document.getElementById("publishEditorMsg");
  const webEditName = document.getElementById("webEditName");
  const webEditCategory = document.getElementById("webEditCategory");
  const webEditStockStatus = document.getElementById("webEditStockStatus");
  const webEditPrice = document.getElementById("webEditPrice");
  const webEditQty = document.getElementById("webEditQty");
  const webEditNote = document.getElementById("webEditNote");
  const webEditSaveBtn = document.getElementById("webEditSaveBtn");
  const webEditOffBtn = document.getElementById("webEditOffBtn");
  const webEditPhotosInput = document.getElementById("webEditPhotosInput");
  const webEditPhotoStrip = document.getElementById("webEditPhotoStrip");
  const publishQty = document.getElementById("publishQty");
  const publishProductName = document.getElementById("publishProductName");
  const publishCategory = document.getElementById("publishCategory");
  const publishPrice = document.getElementById("publishPrice");
  const publishPhotosInput = document.getElementById("publishPhotosInput");
  const publishPhotoStrip = document.getElementById("publishPhotoStrip");
  const publishPhotoHint = document.getElementById("publishPhotoHint");
  const publishFeaturedHome = document.getElementById("publishFeaturedHome");
  const publishFeaturedOrder = document.getElementById("publishFeaturedOrder");
  const webEditFeaturedHome = document.getElementById("webEditFeaturedHome");
  const webEditFeaturedOrder = document.getElementById("webEditFeaturedOrder");
  if (!loginCard || !panel) return;

  // ---------- 產品介紹富文本編輯器（Quill）----------
  let publishQuill = null;
  let webEditQuill = null;
  if (typeof Quill !== "undefined") {
    try {
      const SizeStyle = Quill.import("attributors/style/size");
      if (SizeStyle) {
        SizeStyle.whitelist = ["10px", "12px", "14px", "16px", "18px", "20px", "24px", "32px"];
        Quill.register(SizeStyle, true);
      }
    } catch (_) {}
    const toolbarOpt = [
      [{ size: ["small", false, "large", "huge"] }],
      ["bold", "italic", "underline"],
      [{ list: "ordered" }, { list: "bullet" }],
      ["link", "image"],
      ["clean"],
    ];
    const publishEditorEl = document.getElementById("publishSpecSummaryEditor");
    const webEditEditorEl = document.getElementById("webEditNoteEditor");
    if (publishEditorEl) {
      publishQuill = new Quill(publishEditorEl, { theme: "snow", modules: { toolbar: toolbarOpt } });
    }
    if (webEditEditorEl) {
      webEditQuill = new Quill(webEditEditorEl, { theme: "snow", modules: { toolbar: toolbarOpt } });
    }
  }

  // ---------- state ----------
  let editingWebId = null;
  let publishPhotos = []; // data URLs
  let editPhotos = []; // 編輯時的商品照片

  // ---------- helpers UI ----------
  function show(el, text) {
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
  }

  function hide(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showCenterToast(msg) {
    const toast = document.getElementById("adminToast");
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => { toast.hidden = true; }, 280);
    }, 2500);
  }

  function updateSyncStatusBar() {
    const bar = document.getElementById("syncStatusBar");
    const txt = document.getElementById("syncStatusText");
    if (!bar || !txt) return;
    const configured = window.DK?.isSupabaseConfigured?.() === true;
    if (!configured) {
      bar.className = "sync-status-bar error";
      txt.textContent = "⚠ Supabase 未設定，新增／編輯的資料僅存於本機，其他裝置無法看到。請在 shared.js 填寫 SUPABASE_URL 與 SUPABASE_ANON_KEY。";
      return;
    }
    const meta = window.DK?.getConfigSyncMeta?.() || {
      currentSource: "local",
      lastCloudSyncStatus: "never",
      lastCloudReadAt: null,
      lastCloudWriteAt: null,
      lastCloudError: null,
    };
    if (meta.lastCloudSyncStatus === "failed" && meta.lastCloudError) {
      bar.className = "sync-status-bar error";
      txt.textContent = "⚠ 上次同步失敗：" + String(meta.lastCloudError).slice(0, 80);
      return;
    }
    if (meta.lastCloudSyncStatus === "never") {
      bar.className = "sync-status-bar warning";
      txt.textContent = "Supabase 已設定，尚未驗證連線或尚未同步設定。";
      return;
    }
    bar.className = "sync-status-bar";
    const src = meta.currentSource === "cloud" ? "雲端" : "本機";
    if (meta.lastCloudWriteAt) {
      const t = new Date(meta.lastCloudWriteAt);
      const ts = Number.isNaN(t.getTime())
        ? meta.lastCloudWriteAt
        : t.toLocaleString("zh-TW", { hour12: false });
      txt.textContent = `✅ 已同步到雲端（最後寫入：${ts}，目前來源：${src}）`;
      return;
    }
    if (meta.lastCloudReadAt) {
      const t = new Date(meta.lastCloudReadAt);
      const ts = Number.isNaN(t.getTime())
        ? meta.lastCloudReadAt
        : t.toLocaleString("zh-TW", { hour12: false });
      txt.textContent = `✅ 已從雲端載入設定（最後讀取：${ts}）`;
      return;
    }
    txt.textContent = "✅ Supabase 已設定，最近一次同步成功。";
  }

  function showSyncToast(result, context) {
    const ok = result && result.ok === true;
    const msg = ok
      ? (context ? context + " 已儲存並同步到 Supabase ✓" : "已同步到 Supabase ✓")
      : "同步失敗，其他裝置無法看到： " + (result?.error || "未知錯誤");
    showCenterToast(msg);
    if (!ok) {
      const bar = document.getElementById("syncStatusBar");
      const txt = document.getElementById("syncStatusText");
      if (bar && txt) {
        bar.className = "sync-status-bar error";
        txt.textContent = "⚠ 上次同步失敗：" + (result?.error || "").slice(0, 60);
      }
    } else {
      updateSyncStatusBar();
    }
  }

  function applyAuthUI() {
    const authed = window.DK?.isAdminAuthed?.() === true;
    if (loginCard) loginCard.hidden = authed;
    if (panel) panel.hidden = !authed;
    if (logoutBtn) logoutBtn.hidden = !authed;
    if (authed) updateSyncStatusBar();
  }

  const ADMIN_TAB_KEY = "dk_admin_tab";
  const VALID_TABS = ["inv", "publish", "frontend", "vendors", "purchase", "customers"];
  function switchTab(name) {
    try { sessionStorage.setItem(ADMIN_TAB_KEY, name); } catch (_) {}
    try { localStorage.setItem("dk_admin_active_tab", name); } catch (_) {}
    if (VALID_TABS.includes(name)) try { location.hash = name; } catch (_) {}
    for (const t of tabs) {
      if (t.getAttribute("data-tab") === name) t.classList.add("active");
      else t.classList.remove("active");
    }
    if (tabInv) tabInv.hidden = name !== "inv";
    if (tabPublish) tabPublish.hidden = name !== "publish";
    if (tabFrontend) tabFrontend.hidden = name !== "frontend";
    if (tabVendors) tabVendors.hidden = name !== "vendors";
    if (tabPurchase) tabPurchase.hidden = name !== "purchase";
    if (tabCustomers) tabCustomers.hidden = name !== "customers";
    if (name === "inv") {
      const doRefresh = () => {
        if (typeof window.__adminV2Refresh === "function") window.__adminV2Refresh();
      };
      if (window.DK && typeof window.DK.fetchV2DataFromSupabase === "function") {
        window.DK.fetchV2DataFromSupabase().then(doRefresh).catch(doRefresh);
      } else {
        doRefresh();
      }
    }
    if (name === "publish") {
      if (publishFormCard) publishFormCard.hidden = true;
      renderPublish();
    }
    if (name === "frontend") loadFrontendForm();
    if (name === "vendors") {
      showVendorManageMsg("");
      renderVendorOptions();
      if (typeof renderVendorQuoteVendorSelect === "function") renderVendorQuoteVendorSelect();
      if (typeof renderVendorQuoteCategorySelect === "function") renderVendorQuoteCategorySelect();
      if (typeof renderVendorQuotes === "function") renderVendorQuotes();
      if (typeof renderVendorQuotesSyncPanel === "function") renderVendorQuotesSyncPanel();
    }
    if (name === "purchase") {
      try {
        if (typeof window.__dkPurchaseOrdersOnShow === "function") window.__dkPurchaseOrdersOnShow();
      } catch (_) {}
    }
    if (name === "customers") {
      if (typeof renderCustomerRecordsPage === "function") renderCustomerRecordsPage();
    }
  }

  // ---------- 上架管理（publish）：renderPublish / submitPublish / 編輯／圖片壓縮 ----------
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    });
  }
  async function fileToCompressedDataUrl(file, opts = {}) {
    const { maxW = 960, maxH = 960, quality = 0.78 } = opts;
    const src = await readFileAsDataUrl(file);
    const img = await loadImage(src);
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(1, maxW / iw, maxH / ih);
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  }

  function dataURLToBlob(dataUrl) {
    const parts = dataUrl.split(",");
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
    const bin = atob(parts[1] || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /** 壓縮並取得照片 URL：若已設定 Supabase Storage bucket 則上傳到雲端回傳網址，否則回傳 data URL。 */
  async function compressAndResolvePhotoUrl(file, opts = {}) {
    const dataUrl = await fileToCompressedDataUrl(file, opts);
    const upload = window.DK?.uploadImageToSupabaseStorage;
    if (typeof upload === "function") {
      const blob = dataURLToBlob(dataUrl);
      const path = "products/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpg";
      const publicUrl = await upload(blob, path);
      if (publicUrl) return publicUrl;
    }
    return dataUrl;
  }

  function renderPublishPhotoStrip() {
    if (!publishPhotoStrip) return;
    const n = publishPhotos.length;
    publishPhotoStrip.innerHTML = publishPhotos.map((url, i) => `<span class="photo-thumb" data-i="${i}">
      <img src="${escapeHtml(url)}" alt="" />
      <button type="button" class="btn-remove-photo" data-i="${i}">×</button>
      <div class="photo-thumb-order">
        <button type="button" class="btn-move-photo btn-move-up" data-i="${i}" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn-move-photo btn-move-down" data-i="${i}" title="下移" ${i === n - 1 ? "disabled" : ""}>↓</button>
      </div>
    </span>`).join("");
    publishPhotoStrip.querySelectorAll(".btn-remove-photo").forEach((btn) => {
      btn.addEventListener("click", () => {
        publishPhotos.splice(Number(btn.getAttribute("data-i")), 1);
        renderPublishPhotoStrip();
      });
    });
    publishPhotoStrip.querySelectorAll(".btn-move-up").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-i"));
        if (i > 0) {
          [publishPhotos[i - 1], publishPhotos[i]] = [publishPhotos[i], publishPhotos[i - 1]];
          renderPublishPhotoStrip();
        }
      });
    });
    publishPhotoStrip.querySelectorAll(".btn-move-down").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-i"));
        if (i < publishPhotos.length - 1) {
          [publishPhotos[i], publishPhotos[i + 1]] = [publishPhotos[i + 1], publishPhotos[i]];
          renderPublishPhotoStrip();
        }
      });
    });
  }

  function renderPublish() {
    const items = window.DK?.getInventory?.() || [];
    const publishEmpty = document.getElementById("publishWebEmpty");
    if (publishWebEmpty) publishEmpty.hidden = items.length > 0;
    if (!publishWebGrid) return;
    publishWebGrid.innerHTML = items.map((it) => {
      const name = escapeHtml(it.name || it.id || "");
      const cat = escapeHtml(it.category || "");
      const price = typeof it.price === "number" ? it.price.toLocaleString("zh-TW") : "-";
      const firstPhoto = Array.isArray(it.photos) && it.photos.length > 0 ? it.photos[0] : "";
      return `<div class="publish-web-card" data-id="${escapeHtml(it.id)}">
        <div class="publish-web-card-img">${firstPhoto ? `<img src="${escapeHtml(firstPhoto)}" alt="" />` : "<span class=\"publish-web-card-noimg\">無圖片</span>"}</div>
        <div class="publish-web-card-body">
          <div class="publish-web-card-title">${name}</div>
          <div class="muted">${cat} · NT$ ${price}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm btn-edit-web">編輯</button>
      </div>`;
    }).join("");
    publishWebGrid.querySelectorAll(".btn-edit-web").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".publish-web-card")?.getAttribute("data-id");
        if (id) openPublishEditor(id);
      });
    });
    updatePublishStorageInfo(items);
  }

  async function updatePublishStorageInfo(items) {
    const el = document.getElementById("publishStorageInfo");
    if (!el) return;
    const raw = window.DK?.getInventory ? window.DK.getInventory() : items;
    const list = Array.isArray(raw) ? raw : [];
    const jsonStr = JSON.stringify(list);
    const bytes = new Blob([jsonStr]).size;
    const kb = (bytes / 1024).toFixed(1);
    let html = `商品資料約 ${kb} KB`;
    try {
      if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
        const est = await navigator.storage.estimate();
        const used = (est.usage || 0) / 1024 / 1024;
        const quota = (est.quota || 0) / 1024 / 1024;
        html += ` · 本網站儲存已用約 ${used.toFixed(1)} MB / 上限約 ${quota.toFixed(0)} MB`;
      }
    } catch (_) {}
    html += "（本機約 5MB 上限，無法升級；若儲存失敗請減少照片或縮小圖）";
    el.textContent = html;
  }

  function renderEditPhotoStrip() {
    if (!webEditPhotoStrip) return;
    const n = editPhotos.length;
    webEditPhotoStrip.innerHTML = editPhotos.map((url, i) => `<span class="photo-thumb" data-i="${i}">
      <img src="${escapeHtml(url)}" alt="" />
      <button type="button" class="btn-remove-photo" data-i="${i}">×</button>
      <div class="photo-thumb-order">
        <button type="button" class="btn-move-photo btn-move-up" data-i="${i}" title="上移" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn-move-photo btn-move-down" data-i="${i}" title="下移" ${i === n - 1 ? "disabled" : ""}>↓</button>
      </div>
    </span>`).join("");
    webEditPhotoStrip.querySelectorAll(".btn-remove-photo").forEach((btn) => {
      btn.addEventListener("click", () => {
        editPhotos.splice(Number(btn.getAttribute("data-i")), 1);
        renderEditPhotoStrip();
      });
    });
    webEditPhotoStrip.querySelectorAll(".btn-move-up").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-i"));
        if (i > 0) {
          [editPhotos[i - 1], editPhotos[i]] = [editPhotos[i], editPhotos[i - 1]];
          renderEditPhotoStrip();
        }
      });
    });
    webEditPhotoStrip.querySelectorAll(".btn-move-down").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-i"));
        if (i < editPhotos.length - 1) {
          [editPhotos[i], editPhotos[i + 1]] = [editPhotos[i + 1], editPhotos[i]];
          renderEditPhotoStrip();
        }
      });
    });
  }

  function syncFeaturedOrderEnabled(checkEl, orderEl) {
    if (!orderEl) return;
    const on = !!(checkEl && checkEl.checked);
    orderEl.disabled = !on;
  }

  function readFeaturedFromForm(checkEl, orderEl) {
    const featuredHome = !!(checkEl && checkEl.checked);
    let featuredOrder = null;
    if (featuredHome && orderEl) {
      const n = Number(orderEl.value);
      if (Number.isFinite(n) && n >= 1) featuredOrder = Math.floor(n);
    } else if (orderEl && orderEl.value !== "" && orderEl.value != null) {
      const n = Number(orderEl.value);
      if (Number.isFinite(n) && n >= 1) featuredOrder = Math.floor(n);
    }
    return { featuredHome, featuredOrder };
  }

  function fillFeaturedToForm(checkEl, orderEl, item) {
    const on = item?.featuredHome === true || String(item?.featuredHome).toLowerCase() === "true";
    if (checkEl) checkEl.checked = on;
    if (orderEl) {
      const n = Number(item?.featuredOrder);
      orderEl.value = Number.isFinite(n) && n >= 1 ? String(Math.floor(n)) : "";
    }
    syncFeaturedOrderEnabled(checkEl, orderEl);
  }

  function openPublishEditor(webId) {
    editingWebId = webId || null;
    const items = window.DK?.getInventory?.() || [];
    const it = webId ? items.find((x) => x.id === webId) : null;
    const v2Item = webId && typeof window.DK?.getItems === "function" ? window.DK.getItems().find((x) => String(x?.id) === String(webId)) : null;
    const qtyFromStock = v2Item != null && Number.isFinite(Number(v2Item.qty_on_hand)) ? Number(v2Item.qty_on_hand) : null;
    if (publishEditorTitle) publishEditorTitle.textContent = it ? "編輯：" + (it.name || it.id) : "";
    if (webEditName) webEditName.value = it?.name ?? "";
    if (webEditCategory) webEditCategory.value = it?.category ?? "文書";
    if (webEditStockStatus) webEditStockStatus.value = it?.stockStatus ?? "現貨";
    if (webEditPrice) webEditPrice.value = it?.price ?? "";
    if (webEditQty) {
      if (qtyFromStock != null) {
        webEditQty.value = String(qtyFromStock);
        webEditQty.readOnly = true;
        webEditQty.title = "此商品對應庫存+記帳品項，數量由庫存+記帳自動帶入";
      } else {
        webEditQty.value = it?.qty ?? it?.stock ?? 1;
        webEditQty.readOnly = false;
        webEditQty.title = "";
      }
    }
    const qtyHint = document.getElementById("webEditQtyHint");
    if (qtyHint) qtyHint.style.display = qtyFromStock != null ? "block" : "none";
    fillFeaturedToForm(webEditFeaturedHome, webEditFeaturedOrder, it);
    if (webEditQuill && webEditQuill.root) webEditQuill.root.innerHTML = it?.note?.trim() ?? "";
    editPhotos = Array.isArray(it?.photos) ? [...it.photos] : [];
    renderEditPhotoStrip();
    if (webEditPhotosInput) webEditPhotosInput.value = "";
    if (publishEditor) publishEditor.hidden = false;
    if (publishEditorMsg) publishEditorMsg.hidden = true;
  }

  function closePublishEditor() {
    if (publishEditor) publishEditor.hidden = true;
    editingWebId = null;
  }

  async function savePublishEditor() {
    if (!editingWebId) {
      showCenterToast("請先選擇要編輯的商品");
      return;
    }
    const items = window.DK?.getInventory?.() || [];
    const idx = items.findIndex((x) => x.id === editingWebId);
    if (idx < 0) {
      showCenterToast("找不到該商品，請重新整理後再試");
      return;
    }
    if (webEditSaveBtn) {
      webEditSaveBtn.disabled = true;
      webEditSaveBtn.textContent = "儲存中…";
    }
    showCenterToast("儲存中…");
    try {
    const v2Item = typeof window.DK?.getItems === "function" ? window.DK.getItems().find((x) => String(x?.id) === String(editingWebId)) : null;
    const resolvedQty = v2Item != null && Number.isFinite(Number(v2Item.qty_on_hand)) ? Number(v2Item.qty_on_hand) : (Number(webEditQty?.value) ?? items[idx].qty);
    const featured = readFeaturedFromForm(webEditFeaturedHome, webEditFeaturedOrder);
    items[idx] = {
        ...items[idx],
        name: webEditName?.value?.trim() ?? items[idx].name,
        category: webEditCategory?.value ?? items[idx].category,
        stockStatus: webEditStockStatus?.value ?? items[idx].stockStatus,
        price: Number(webEditPrice?.value) || items[idx].price,
        qty: resolvedQty,
        note: (webEditQuill && webEditQuill.root ? webEditQuill.root.innerHTML.trim() : "") || items[idx].note,
        photos: [...editPhotos],
        featuredHome: featured.featuredHome,
        featuredOrder: featured.featuredOrder,
      };
      window.DK?.saveInventory?.(items);
      let msg = "已儲存";
      if (window.DK?.upsertInventoryItemToSupabase) {
        try {
          const result = await window.DK.upsertInventoryItemToSupabase(items[idx]);
          if (result && !result.ok && result?.error) msg = "已存本機，Supabase 同步失敗：" + result.error;
        } catch (e) {
          msg = "已存本機，Supabase 同步失敗：" + (e?.message || String(e));
        }
      }
      renderPublish();
      showCenterToast(msg);
    } catch (e) {
      const isQuota = e && (e.name === "QuotaExceededError" || e.code === 22);
      const msg = isQuota
        ? "瀏覽器本機儲存已滿（約 5MB 上限，無法升級）。請減少照片張數或改用較小圖片後再儲存。"
        : "儲存失敗：" + (e?.message || String(e));
      showCenterToast(msg);
    } finally {
      if (webEditSaveBtn) {
        webEditSaveBtn.disabled = false;
        webEditSaveBtn.textContent = "儲存";
      }
    }
  }

  async function removeFromWeb(webId) {
    const items = (window.DK?.getInventory?.() || []).filter((x) => x.id !== webId);
    window.DK?.saveInventory?.(items);
    let syncOk = true;
    if (window.DK?.deleteInventoryItemFromSupabase) {
      try {
        const result = await window.DK.deleteInventoryItemFromSupabase(webId);
        syncOk = result && result.ok === true;
        if (!syncOk) {
          show(publishMsg, "已從本機下架，但 Supabase 同步刪除失敗：" + (result?.error || ""));
          if (typeof showSyncToast === "function") showSyncToast({ ok: false, error: result?.error || "下架同步失敗" }, "下架");
        }
      } catch (e) {
        syncOk = false;
        show(publishMsg, "已從本機下架，Supabase 同步失敗：" + (e?.message || String(e)));
        if (typeof showSyncToast === "function") showSyncToast({ ok: false, error: e?.message || String(e) }, "下架");
      }
    }
    renderPublish();
    closePublishEditor();
    if (syncOk && publishMsg) { show(publishMsg, "已下架"); publishMsg.hidden = false; setTimeout(() => hide(publishMsg), 2000); }
  }

  async function submitPublish() {
    const name = document.getElementById("publishProductName")?.value?.trim();
    const category = document.getElementById("publishCategory")?.value ?? "文書";
    const priceEl = document.getElementById("publishPrice");
    const price = Number(priceEl?.value) || 0;
    const qty = Number(document.getElementById("publishQty")?.value) || 1;
    if (!name) {
      show(publishMsg, "請填寫商品名稱");
      if (publishMsg) publishMsg.hidden = false;
      return;
    }
    const id = makeWebItemId();
    const featured = readFeaturedFromForm(publishFeaturedHome, publishFeaturedOrder);
    const item = {
      id,
      name,
      category,
      stockStatus: "現貨",
      price: price || 0,
      tags: [],
      note: (publishQuill && publishQuill.root ? publishQuill.root.innerHTML.trim() : "") ?? "",
      photos: [...publishPhotos],
      featuredHome: featured.featuredHome,
      featuredOrder: featured.featuredOrder,
    };
    const items = window.DK?.getInventory?.() || [];
    items.push(item);
    window.DK?.saveInventory?.(items);
    let syncOk = true;
    if (window.DK?.upsertInventoryItemToSupabase) {
      try {
        const result = await window.DK.upsertInventoryItemToSupabase(item);
        syncOk = result && result.ok === true;
        if (!syncOk) {
          show(publishMsg, "已存於本機，但 Supabase 同步失敗：" + (result?.error || ""));
          if (typeof showSyncToast === "function") showSyncToast({ ok: false, error: result?.error || "上架同步失敗" }, "上架");
        }
      } catch (e) {
        syncOk = false;
        show(publishMsg, "已存於本機，Supabase 同步失敗：" + (e?.message || String(e)));
        if (typeof showSyncToast === "function") showSyncToast({ ok: false, error: e?.message || String(e) }, "上架");
      }
    }
    publishPhotos.length = 0;
    renderPublishPhotoStrip();
    if (publishFormCard) publishFormCard.hidden = true;
    if (syncOk) show(publishMsg, "已上架：" + name);
    if (publishMsg) publishMsg.hidden = false;
    renderPublish();
    setTimeout(() => hide(publishMsg), syncOk ? 3000 : 8000);
  }

  for (const t of tabs) {
    t.addEventListener("click", () => {
      const toTab = t.dataset.tab;
      if (toTab !== "publish" && tabPublish && !tabPublish.hidden && publishFormCard && !publishFormCard.hidden) {
        if (!confirm("上架表單尚未送出，確定要離開？")) return;
      }
      const itemModal = document.getElementById("itemEditorModal");
      if (toTab !== "inv" && tabInv && !tabInv.hidden && itemModal && !itemModal.hidden) {
        if (!confirm("品項編輯尚未儲存，確定要離開？")) return;
      }
      switchTab(toTab);
    });
  }
  /* F5 重新整理後還原上次分頁：優先 localStorage dk_admin_active_tab，再 hash / sessionStorage */
  function restoreAdminTab() {
    const fromStorage = (function () { try { return localStorage.getItem("dk_admin_active_tab"); } catch (_) { return null; } })();
    const hasPanel = (name) =>
      (name === "inv" && tabInv) ||
      (name === "publish" && tabPublish) ||
      (name === "frontend" && tabFrontend) ||
      (name === "vendors" && tabVendors) ||
      (name === "purchase" && tabPurchase) ||
      (name === "customers" && tabCustomers);
    if (fromStorage && VALID_TABS.includes(fromStorage) && hasPanel(fromStorage)) {
      switchTab(fromStorage);
      return;
    }
    const fromHash = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
    const saved = (VALID_TABS.includes(fromHash) ? fromHash : null) || (function () { try { return sessionStorage.getItem(ADMIN_TAB_KEY); } catch (_) { return null; } })();
    if (saved && VALID_TABS.includes(saved)) switchTab(saved);
  }
  function doLogin() {
    hide(loginError);
    let cfg = window.DK?.getConfig?.() || {};
    // 防呆：若 cfg.admin 不存在，先用預設 admin 補一份，避免登入永久失效（不覆蓋既有 frontend / vendorOptions 等資料）
    if (!cfg || typeof cfg !== "object") cfg = {};
    if (!cfg.admin || typeof cfg.admin !== "object") {
      const defAdmin =
        (window.DK?.DEFAULT_CONFIG && window.DK.DEFAULT_CONFIG.admin) ||
        { username: "admin", password: "admin123" };
      cfg = { ...cfg, admin: { ...defAdmin } };
      try {
        const cfgKey = window.DK?.STORAGE_KEYS?.config || "dk_site_config_v1";
        const raw = localStorage.getItem(cfgKey);
        const saved = safeParse(raw, null);
        const base = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
        if (!base.admin || typeof base.admin !== "object") {
          localStorage.setItem(cfgKey, JSON.stringify({ ...base, admin: { ...defAdmin } }));
        }
      } catch (_) {}
    }
    const u = String(usernameEl?.value || "").trim();
    const p = String(passwordEl?.value || "");
    const cfgUser = String(cfg?.admin?.username ?? "").trim();
    const cfgPass = String(cfg?.admin?.password ?? "");
    // ① 先用設定檔的帳號密碼
    const cfgOk = !!cfg?.admin && u === cfgUser && p === cfgPass;
    // ② 若設定檔帳密有問題，保留一組固定備援：admin / admin123
    const fallbackOk = u === "admin" && p === "admin123";
    if (cfgOk || fallbackOk) {
      window.DK?.setAdminAuthed?.(true);
      applyAuthUI();
      try {
        const saved = localStorage.getItem("dk_admin_active_tab") || sessionStorage.getItem(ADMIN_TAB_KEY);
        if (saved === "publish" || saved === "inv" || saved === "frontend" || saved === "vendors" || saved === "purchase" || saved === "customers") switchTab(saved);
        else switchTab("inv");
      } catch (_) {
        try { switchTab("inv"); } catch (__) {}
      }
      return;
    }
    show(loginError, "帳號或密碼錯誤。");
  }

  // 先綁定登入/登出，避免 restoreAdminTab 若拋錯導致登入事件未綁定
  loginBtn?.addEventListener("click", doLogin);
  passwordEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  logoutBtn?.addEventListener("click", () => {
    // 登出只清登入狀態，不清除 config / 業務資料
    window.DK?.setAdminAuthed?.(false);
    applyAuthUI();
  });

  try { restoreAdminTab(); } catch (_) {}
  setTimeout(function () { try { restoreAdminTab(); } catch (_) {} }, 0);

  // publish events
  publishSubmitBtn?.addEventListener("click", () => {
    if (publishFormCard) publishFormCard.hidden = false;
    fillFeaturedToForm(publishFeaturedHome, publishFeaturedOrder, null);
    publishFormCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  publishFeaturedHome?.addEventListener("change", () => syncFeaturedOrderEnabled(publishFeaturedHome, publishFeaturedOrder));
  webEditFeaturedHome?.addEventListener("change", () => syncFeaturedOrderEnabled(webEditFeaturedHome, webEditFeaturedOrder));
  document.getElementById("publishConfirmBtn")?.addEventListener("click", submitPublish);
  publishEditorCloseBtn?.addEventListener("click", closePublishEditor);
  webEditSaveBtn?.addEventListener("click", savePublishEditor);
  webEditOffBtn?.addEventListener("click", () => {
    if (editingWebId && confirm("確定下架此商品？")) removeFromWeb(editingWebId);
  });
  webEditPhotosInput?.addEventListener("change", async () => {
    const files = Array.from(webEditPhotosInput.files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (files.length === 0) return;
    const remaining = 5 - editPhotos.length;
    if (remaining <= 0) {
      show(publishEditorMsg, "最多 5 張照片，請先移除再新增。");
      if (publishEditorMsg) publishEditorMsg.hidden = false;
      return;
    }
    const toAdd = files.slice(0, remaining);
    show(publishEditorMsg, "正在處理相片…請稍候再按儲存。");
    if (publishEditorMsg) publishEditorMsg.hidden = false;
    try {
      for (const file of toAdd) {
        const url = await compressAndResolvePhotoUrl(file, { maxW: 640, maxH: 960, quality: 0.65 });
        editPhotos.push(url);
      }
      renderEditPhotoStrip();
      if (publishEditorMsg) publishEditorMsg.hidden = true;
    } catch (e) {
      show(publishEditorMsg, "相片處理失敗：" + (e?.message || String(e)));
      if (publishEditorMsg) publishEditorMsg.hidden = false;
    }
    webEditPhotosInput.value = "";
  });
  publishPhotosInput?.addEventListener("change", async () => {
    const files = Array.from(publishPhotosInput.files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (files.length === 0) return;
    const remaining = 5 - publishPhotos.length;
    if (remaining <= 0) {
      show(publishMsg, "最多 5 張照片，請先移除再新增。");
      return;
    }
    const toAdd = files.slice(0, remaining);
    show(publishMsg, `正在處理相片…（${toAdd.length} 張）`);
    try {
      for (const file of toAdd) {
        const url = await compressAndResolvePhotoUrl(file, { maxW: 640, maxH: 960, quality: 0.65 });
        publishPhotos.push(url);
      }
      renderPublishPhotoStrip();
      hide(publishMsg);
    } catch (e) {
      show(publishMsg, "相片處理失敗：" + (e && e.message ? e.message : String(e)));
    }
    publishPhotosInput.value = "";
  });
  // ---------- frontend (前台管理) ----------
  function updateHeroLivePreview() {
    const taglineEl = document.getElementById("heroLivePreviewTagline");
    const subEl = document.getElementById("heroLivePreviewSub");
    const btn1El = document.getElementById("heroLivePreviewBtn1");
    const btn2El = document.getElementById("heroLivePreviewBtn2");
    const tagline = document.getElementById("feHeroTagline")?.value ?? "";
    const sub = document.getElementById("feHeroSub")?.value ?? "";
    const btn1 = document.getElementById("feHeroBtn1")?.value ?? "";
    const btn2 = document.getElementById("feHeroBtn2")?.value ?? "";
    if (taglineEl) taglineEl.textContent = tagline || "主標語";
    if (subEl) subEl.textContent = sub || "副標語";
    if (btn1El) btn1El.textContent = btn1 || "主按鈕 1";
    if (btn2El) btn2El.textContent = btn2 || "主按鈕 2";
  }

  function updateBrandLivePreview() {
    const markEl = document.getElementById("brandLivePreviewMark");
    const titleEl = document.getElementById("brandLivePreviewTitle");
    const subtitleEl = document.getElementById("brandLivePreviewSubtitle");
    const mark = document.getElementById("feBrandMark")?.value ?? "";
    const title = document.getElementById("feBrandTitle")?.value ?? "";
    const subtitle = document.getElementById("feBrandSubtitle")?.value ?? "";
    if (markEl) markEl.textContent = mark || "品牌縮寫";
    if (titleEl) titleEl.textContent = title || "品牌名稱";
    if (subtitleEl) subtitleEl.textContent = subtitle || "品牌副標";
  }

  function updateBrandLogoAdminPreview() {
    const prev = document.getElementById("feBrandLogoPreview");
    const url = (document.getElementById("feBrandLogoUrl")?.value ?? "").trim();
    if (!prev) return;
    prev.innerHTML = "";
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.style.cssText = "max-height:72px;max-width:200px;object-fit:contain;border-radius:8px;border:1px solid rgba(17,24,39,0.12);";
      img.onerror = function () {
        prev.textContent = "預覽失敗（網址無效或無法載入）";
        prev.className = "muted small";
      };
      prev.appendChild(img);
    } else {
      prev.textContent = "未設定";
      prev.className = "muted small";
    }
  }

  function updateTrustLivePreview() {
    const titleEl = document.getElementById("trustLivePreviewTitle");
    const itemsEl = document.getElementById("trustLivePreviewItems");
    const noteEl = document.getElementById("trustLivePreviewNote");
    const title = document.getElementById("feTrustTitle")?.value ?? "";
    const itemsText = document.getElementById("feTrustItems")?.value ?? "";
    const note = document.getElementById("feTrustNote")?.value ?? "";
    const items = itemsText.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (titleEl) titleEl.textContent = title || "標題";
    if (itemsEl) {
      itemsEl.innerHTML = "";
      items.forEach((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        li.style.marginBottom = "4px";
        itemsEl.appendChild(li);
      });
      if (items.length === 0) {
        const li = document.createElement("li");
        li.textContent = "（尚無項目）";
        li.style.color = "#9ca3af";
        itemsEl.appendChild(li);
      }
    }
    if (noteEl) noteEl.textContent = note || "備註說明";
  }

  function loadFrontendForm() {
    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const def = window.DK?.DEFAULT_CONFIG?.frontend || {};
    document.getElementById("feSiteTitle").value = cfg.siteTitle ?? "";
    document.getElementById("feOgTitle").value = fe.ogTitle ?? cfg.siteTitle ?? def.ogTitle ?? "";
    document.getElementById("feOgDescription").value = fe.ogDescription ?? def.ogDescription ?? "";
    document.getElementById("feOgImageUrl").value = fe.ogImageUrl ?? "";
    document.getElementById("feBrandMark").value = cfg.brand?.mark ?? "";
    document.getElementById("feBrandTitle").value = cfg.brand?.title ?? "";
    document.getElementById("feBrandSubtitle").value = cfg.brand?.subtitle ?? "";
    const feBrandLogoUrlEl = document.getElementById("feBrandLogoUrl");
    if (feBrandLogoUrlEl) feBrandLogoUrlEl.value = (fe.brandLogo ?? "").trim();
    updateBrandLogoAdminPreview();
    document.getElementById("feHeroTagline").value = fe.heroTagline ?? def.heroTagline ?? "";
    document.getElementById("feHeroSub").value = fe.heroSub ?? def.heroSub ?? "";
    document.getElementById("feHeroBtn1").value = fe.heroBtn1 ?? def.heroBtn1 ?? "";
    document.getElementById("feHeroBtn2").value = fe.heroBtn2 ?? def.heroBtn2 ?? "";
    document.getElementById("feTrustTitle").value = fe.trustTitle ?? def.trustTitle ?? "";
    document.getElementById("feTrustItems").value = Array.isArray(fe.trustItems) ? fe.trustItems.join("\n") : (def.trustItems || []).join("\n");
    document.getElementById("feTrustNote").value = fe.trustNote ?? def.trustNote ?? "";
    const homeTrust = fe.homeTrust && typeof fe.homeTrust === "object" ? fe.homeTrust : {};
    const htItems = Array.isArray(homeTrust.items) ? homeTrust.items : [];
    document.getElementById("feHomeTrustTitle").value = homeTrust.title ?? "";
    [1, 2, 3].forEach((i) => {
      const item = htItems[i - 1] || {};
      const titleEl = document.getElementById("feHomeTrust" + i + "Title");
      const textEl = document.getElementById("feHomeTrust" + i + "Text");
      if (titleEl) titleEl.value = item.title ?? "";
      if (textEl) textEl.value = item.text ?? "";
    });
    document.getElementById("feContactTitle").value = fe.contactTitle ?? def.contactTitle ?? "";
    document.getElementById("feContactSub").value = fe.contactSub ?? def.contactSub ?? "";
    document.getElementById("feMachinePageTitle").value = fe.machinePageTitle ?? def.machinePageTitle ?? "";
    document.getElementById("feMachinePageSub").value = fe.machinePageSub ?? def.machinePageSub ?? "";
    const catTitles = fe.catTitles || (window.DK?.DEFAULT_CONFIG?.frontend?.catTitles ?? {});
    document.getElementById("feCatTitleOffice").value = catTitles.office ?? "文書／上網／學生";
    document.getElementById("feCatTitleGameEntry").value = catTitles["game-entry"] ?? "遊戲入門";
    document.getElementById("feCatTitleGameMid").value = catTitles["game-mid"] ?? "遊戲中階（主力）";
    document.getElementById("feCatTitleWork").value = catTitles.work ?? "工作／效能取向";
    document.getElementById("feCatTitlePeripherals").value = catTitles.peripherals ?? "電腦周邊";
    const rangeDef = fe.catPriceRanges || def?.frontend?.catPriceRanges || {};
    const setRange = (cat, minId, maxId) => {
      const r = rangeDef[cat] || {};
      const minEl = document.getElementById(minId);
      const maxEl = document.getElementById(maxId);
      if (minEl) minEl.value = r.min != null && r.min !== "" ? String(r.min) : "";
      if (maxEl) maxEl.value = r.max != null && r.max !== "" ? String(r.max) : "";
    };
    setRange("office", "feCatRangeOfficeMin", "feCatRangeOfficeMax");
    setRange("game-entry", "feCatRangeGameEntryMin", "feCatRangeGameEntryMax");
    setRange("game-mid", "feCatRangeGameMidMin", "feCatRangeGameMidMax");
    setRange("work", "feCatRangeWorkMin", "feCatRangeWorkMax");
    setRange("peripherals", "feCatRangePeripheralsMin", "feCatRangePeripheralsMax");
    document.getElementById("feLineUrl").value = cfg.line?.url ?? "";
    const feLineCta = document.getElementById("feLineCtaText");
    if (feLineCta) feLineCta.value = cfg.line?.lineCtaText ?? (window.DK?.DEFAULT_CONFIG?.line?.lineCtaText ?? "");
    const feFooterLine = document.getElementById("feFooterLineSentence");
    if (feFooterLine) feFooterLine.value = cfg.line?.footerLineSentence ?? (window.DK?.DEFAULT_CONFIG?.line?.footerLineSentence ?? "");
    const catIds = ["office", "game-entry", "game-mid", "work", "peripherals"];
    const catImages = fe.catImages || {};
    catIds.forEach((cat) => {
      const el = document.getElementById("feCatPreview" + cat.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^([a-z])/, (_, c) => c.toUpperCase()));
      if (el) {
        el.innerHTML = "";
        if (catImages[cat]) {
          const img = document.createElement("img");
          img.src = catImages[cat];
          img.alt = "";
          img.style.cssText = "max-width:100%;max-height:120px;object-fit:cover;border-radius:8px;";
          el.appendChild(img);
        } else {
          el.textContent = "未設定";
          el.className = "cat-image-preview muted";
        }
      }
    });
    // 前台首頁 Banner 管理
    try {
      const listEl = document.getElementById("feHomeBannersList");
      if (listEl) {
        const banners = Array.isArray(fe.homeBanners) ? fe.homeBanners : [];
        renderHomeBanners(listEl, banners);
      }
    } catch (_) {
      // 若後台版本不支援或 DOM 缺失，略過 Banner 區塊，避免影響其他設定
    }

    // 首頁第二區分類卡片：從 frontend.homeEntries 載入並 render 出所有 row（重整後才能看到已儲存的卡片）
    try {
      const entries = Array.isArray(fe.homeEntries) ? fe.homeEntries : [];
      const safeEntries = entries.filter(
        (e) => e && typeof e === "object" && (e.id != null || e.title != null)
      );
      const listEl = document.getElementById("feHomeEntriesList");
      if (listEl && typeof renderHomeEntriesAdmin === "function") {
        renderHomeEntriesAdmin(listEl, safeEntries);
      }
    } catch (_) {}

    // 首頁視覺效果（可選；缺欄位用預設，不寫回）
    try {
      const hs =
        typeof window.DK?.normalizeHomeStyle === "function"
          ? window.DK.normalizeHomeStyle(fe.homeStyle)
          : {
              heroContentPosition: "left",
              heroOverlayStrength: 70,
              heroAccentGlow: true,
              sectionReveal: true,
              mouseGlow: true,
              cardTilt: false,
            };
      const posEl = document.getElementById("feHomeStyleHeroPos");
      const overlayEl = document.getElementById("feHomeStyleOverlay");
      const overlayVal = document.getElementById("feHomeStyleOverlayVal");
      const glowEl = document.getElementById("feHomeStyleAccentGlow");
      const revealEl = document.getElementById("feHomeStyleSectionReveal");
      const mouseEl = document.getElementById("feHomeStyleMouseGlow");
      const tiltEl = document.getElementById("feHomeStyleCardTilt");
      if (posEl) posEl.value = hs.heroContentPosition || "left";
      if (overlayEl) overlayEl.value = String(hs.heroOverlayStrength ?? 70);
      if (overlayVal) overlayVal.textContent = String(hs.heroOverlayStrength ?? 70);
      if (glowEl) glowEl.checked = hs.heroAccentGlow !== false;
      if (revealEl) revealEl.checked = hs.sectionReveal !== false;
      if (mouseEl) mouseEl.checked = hs.mouseGlow !== false;
      if (tiltEl) tiltEl.checked = hs.cardTilt === true;
    } catch (_) {}

    const msg = document.getElementById("frontendMsg");
    if (msg) msg.hidden = true;
    updateHeroLivePreview();
    updateBrandLivePreview();
  }

  // ===== 廠商清單（vendorOptions）：存於 config.frontend.vendorOptions =====
  function normalizeVendorName(name) {
    return String(name || "").trim();
  }

  function getVendorOptionsFromConfig() {
    const cfg = window.DK?.getConfig?.() || {};
    const raw = cfg?.frontend?.vendorOptions;
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const v of list) {
      const name = normalizeVendorName(v);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  }

  function saveVendorOptionsToConfig(nextList) {
    // 重要：只更新 config.frontend.vendorOptions，且必須保留 config 其他欄位（包含後台登入狀態相關設定）
    // 若 DK.getConfig 不可用或回傳異常，退回讀 localStorage 目前整份設定，避免把 config 覆蓋成只剩 frontend.vendorOptions
    let cfg = window.DK?.getConfig?.();
    if (!cfg || typeof cfg !== "object") {
      try {
        const key = window.DK?.STORAGE_KEYS?.config || "dk_site_config_v1";
        cfg = safeParse(localStorage.getItem(key), {}) || {};
      } catch (_) {
        cfg = {};
      }
    }
    const fe = cfg.frontend || {};
    const next = { ...cfg, frontend: { ...fe, vendorOptions: Array.isArray(nextList) ? nextList : [] } };
    // 1) 先寫入本機（不得清除 localStorage / sessionStorage，不做 reload）
    try {
      window.DK?.saveConfig?.(next, { skipSupabase: true });
    } catch (e) {
      showVendorManageMsg("儲存失敗：" + String(e?.message || e || "未知錯誤"));
      return;
    }
    // 2) 再嘗試同步到雲端（若有）
    if (window.DK?.saveSiteConfigToSupabase) {
      window.DK
        .saveSiteConfigToSupabase(next)
        .then((r) => showSyncToast(r, "廠商清單"))
        .catch((e) => showSyncToast({ ok: false, error: String(e?.message || e || "同步失敗") }, "廠商清單"));
    }
  }

  function renderVendorSelect(currentValue) {
    const sel = document.getElementById("itemVendor");
    if (!sel) return;
    const list = getVendorOptionsFromConfig();
    const cur = normalizeVendorName(currentValue);
    const hasCur = cur && list.some((x) => x.toLowerCase() === cur.toLowerCase());
    const options = [];
    options.push('<option value="">請選擇廠商</option>');
    for (const v of list) {
      options.push(`<option value="${v2Esc(v)}">${v2Esc(v)}</option>`);
    }
    // 舊資料相容：若目前品項 vendor 不在清單內，動態補進 select，避免被洗掉
    if (cur && !hasCur) {
      options.push(`<option value="${v2Esc(cur)}">${v2Esc(cur)}（舊）</option>`);
    }
    sel.innerHTML = options.join("");
    sel.value = cur || "";
  }

  function renderVendorOptions() {
    const tbody = document.getElementById("vendorOptionsTbody");
    if (!tbody) return;
    const list = getVendorOptionsFromConfig();
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td class="muted" colspan="2">尚無廠商</td></tr>`;
      return;
    }
    tbody.innerHTML = list
      .map(
        (v) =>
          `<tr><td>${v2Esc(v)}</td><td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-remove-vendor" data-name="${v2Esc(
            v,
          )}">移除</button></td></tr>`,
      )
      .join("");
    tbody.querySelectorAll(".btn-remove-vendor").forEach((btn) => {
      btn.addEventListener("click", () => removeVendorOption(btn.getAttribute("data-name")));
    });
  }

  function showVendorManageMsg(text) {
    const el = document.getElementById("vendorManageMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function addVendorOption() {
    const inp = document.getElementById("newVendorName");
    const raw = normalizeVendorName(inp?.value);
    if (!raw) return showVendorManageMsg("廠商名稱不能為空");
    const list = getVendorOptionsFromConfig();
    const exists = list.some((x) => x.toLowerCase() === raw.toLowerCase());
    if (exists) return showVendorManageMsg("已存在相同廠商（忽略空白與大小寫）");
    const next = [...list, raw];
    saveVendorOptionsToConfig(next);
    if (inp) inp.value = "";
    showVendorManageMsg("");
    renderVendorOptions();
    // 若目前正在編輯品項，同步更新 select（保留目前選擇）
    renderVendorSelect(document.getElementById("itemVendor")?.value || "");
  }

  function removeVendorOption(name) {
    const target = normalizeVendorName(name);
    if (!target) return;
    const list = getVendorOptionsFromConfig();
    const next = list.filter((x) => x.toLowerCase() !== target.toLowerCase());
    saveVendorOptionsToConfig(next);
    showVendorManageMsg("");
    renderVendorOptions();
    // 更新 select，但如果目前選到被移除的廠商，要保留舊值（動態補 option）
    renderVendorSelect(document.getElementById("itemVendor")?.value || "");
  }

  function saveFrontend() {
    const trustItemsText = document.getElementById("feTrustItems").value;
    const trustItems = trustItemsText
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const cfg = window.DK?.getConfig?.() || {};
    const next = {
      ...cfg,
      siteTitle: document.getElementById("feSiteTitle").value?.trim() || cfg.siteTitle,
      brand: {
        ...cfg.brand,
        mark: document.getElementById("feBrandMark").value?.trim() || cfg.brand?.mark,
        title: document.getElementById("feBrandTitle").value?.trim() || cfg.brand?.title,
        subtitle: document.getElementById("feBrandSubtitle").value?.trim() || cfg.brand?.subtitle,
      },
      frontend: {
        ...cfg.frontend,
        brandLogo: (document.getElementById("feBrandLogoUrl")?.value ?? "").trim(),
        ogTitle: document.getElementById("feOgTitle").value?.trim(),
        ogDescription: document.getElementById("feOgDescription").value?.trim(),
        ogImageUrl: document.getElementById("feOgImageUrl").value?.trim(),
        heroTagline: document.getElementById("feHeroTagline").value?.trim(),
        heroSub: document.getElementById("feHeroSub").value?.trim(),
        heroBtn1: document.getElementById("feHeroBtn1").value?.trim(),
        heroBtn2: document.getElementById("feHeroBtn2").value?.trim(),
        trustTitle: document.getElementById("feTrustTitle").value?.trim(),
        trustItems: trustItems.length > 0 ? trustItems : (cfg.frontend?.trustItems || []),
        trustNote: document.getElementById("feTrustNote").value?.trim(),
        homeTrust: (function () {
          const title = (document.getElementById("feHomeTrustTitle")?.value ?? "").trim();
          const items = [1, 2, 3].map((i) => ({
            id: String(i),
            title: (document.getElementById("feHomeTrust" + i + "Title")?.value ?? "").trim(),
            text: (document.getElementById("feHomeTrust" + i + "Text")?.value ?? "").trim(),
          }));
          return { title: title || "為什麼選 DK 電腦", items };
        })(),
        contactTitle: document.getElementById("feContactTitle").value?.trim(),
        contactSub: document.getElementById("feContactSub").value?.trim(),
        machinePageTitle: document.getElementById("feMachinePageTitle").value?.trim(),
        machinePageSub: document.getElementById("feMachinePageSub").value?.trim(),
        // 保留原本設定中的 catPrices（前台現在已不顯示價格文字）
        catPrices: cfg.frontend?.catPrices || (window.DK?.DEFAULT_CONFIG?.frontend?.catPrices ?? {}),
        catTitles: {
          office: document.getElementById("feCatTitleOffice").value?.trim() || "文書／上網／學生",
          "game-entry": document.getElementById("feCatTitleGameEntry").value?.trim() || "遊戲入門",
          "game-mid": document.getElementById("feCatTitleGameMid").value?.trim() || "遊戲中階（主力）",
          work: document.getElementById("feCatTitleWork").value?.trim() || "工作／效能取向",
          peripherals: document.getElementById("feCatTitlePeripherals").value?.trim() || "電腦周邊",
        },
        catPriceRanges: {
          office: { min: parseInt(document.getElementById("feCatRangeOfficeMin")?.value, 10) || 0, max: parseInt(document.getElementById("feCatRangeOfficeMax")?.value, 10) || 6000 },
          "game-entry": { min: parseInt(document.getElementById("feCatRangeGameEntryMin")?.value, 10) || 7000, max: parseInt(document.getElementById("feCatRangeGameEntryMax")?.value, 10) || 12000 },
          "game-mid": { min: parseInt(document.getElementById("feCatRangeGameMidMin")?.value, 10) || 13000, max: parseInt(document.getElementById("feCatRangeGameMidMax")?.value, 10) || 20000 },
          work: { min: parseInt(document.getElementById("feCatRangeWorkMin")?.value, 10) || 18000, max: parseInt(document.getElementById("feCatRangeWorkMax")?.value, 10) || 999999 },
          peripherals: { min: parseInt(document.getElementById("feCatRangePeripheralsMin")?.value, 10) || 0, max: parseInt(document.getElementById("feCatRangePeripheralsMax")?.value, 10) || 999999 },
        },
        catImages: cfg.frontend?.catImages || {},
        homeBanners: (function collectHomeBanners() {
          const listEl = document.getElementById("feHomeBannersList");
          if (!listEl) return Array.isArray(cfg.frontend?.homeBanners) ? cfg.frontend.homeBanners : [];
          const rows = Array.from(listEl.querySelectorAll(".banner-row"));
          const out = [];
          for (const row of rows) {
            const imgInput = row.querySelector(".banner-image");
            const linkInput = row.querySelector(".banner-link");
            const fxInput = row.querySelector(".banner-focus-x");
            const fyInput = row.querySelector(".banner-focus-y");
            if (!imgInput) continue;
            const image = (imgInput.value || "").trim();
            const linkRaw = (linkInput && linkInput.value) ? linkInput.value.trim() : "";
            if (!image) continue; // image 必填，空的不存
            const banner = { image };
            if (linkRaw) banner.link = linkRaw;
            const clamp = (n) => {
              const v = Number(n);
              if (!Number.isFinite(v)) return 50;
              if (v < 0) return 0;
              if (v > 100) return 100;
              return v;
            };
            banner.focusX = clamp(fxInput?.value);
            banner.focusY = clamp(fyInput?.value);
            out.push(banner);
          }
          return out;
        })(),
        homeEntries: (function () {
          const listEl = document.getElementById("feHomeEntriesList");
          const fromDom = collectHomeEntriesFromDom(listEl);
          if (!fromDom.length) {
            return Array.isArray(cfg.frontend?.homeEntries) ? cfg.frontend.homeEntries : [];
          }
          return fromDom;
        })(),
        // 僅合併 homeStyle；保留既有 frontend 其餘欄位（由上方 ...cfg.frontend 保證）
        homeStyle: (function () {
          const existing =
            cfg.frontend && cfg.frontend.homeStyle && typeof cfg.frontend.homeStyle === "object"
              ? cfg.frontend.homeStyle
              : {};
          const pos = (document.getElementById("feHomeStyleHeroPos")?.value || "left").trim();
          let strength = parseInt(document.getElementById("feHomeStyleOverlay")?.value, 10);
          if (!Number.isFinite(strength)) strength = 70;
          if (strength < 40) strength = 40;
          if (strength > 90) strength = 90;
          const nextStyle = {
            heroContentPosition: pos === "center" || pos === "right" ? pos : "left",
            heroOverlayStrength: strength,
            heroAccentGlow: !!document.getElementById("feHomeStyleAccentGlow")?.checked,
            sectionReveal: !!document.getElementById("feHomeStyleSectionReveal")?.checked,
            mouseGlow: !!document.getElementById("feHomeStyleMouseGlow")?.checked,
            cardTilt: !!document.getElementById("feHomeStyleCardTilt")?.checked,
          };
          return { ...existing, ...nextStyle };
        })(),
      },
      line: {
        ...cfg.line,
        url: document.getElementById("feLineUrl").value?.trim() || cfg.line?.url,
        lineCtaText: document.getElementById("feLineCtaText")?.value?.trim() ?? cfg.line?.lineCtaText,
        footerLineSentence: document.getElementById("feFooterLineSentence")?.value?.trim() ?? cfg.line?.footerLineSentence,
      },
    };
    // 1) 先只寫入本機，避免這裡再重複觸發 saveSiteConfigToSupabase
    window.DK?.saveConfig?.(next, { skipSupabase: true });

    const msg = document.getElementById("frontendMsg");
    if (msg) {
      msg.hidden = false;
      msg.textContent = "已儲存（本機）。正在同步到雲端…";
      msg.style.color = "";
    }

    // 2) 再嘗試同步到 Supabase，並回報真實結果
    if (window.DK?.saveSiteConfigToSupabase) {
      window.DK
        .saveSiteConfigToSupabase(next)
        .then((result) => {
          showSyncToast(result, "前台設定");
        })
        .catch((e) => {
          showSyncToast({ ok: false, error: String(e?.message || e || "同步失敗") }, "前台設定");
        });
    } else {
      showSyncToast({ ok: false, error: "環境未提供 saveSiteConfigToSupabase" }, "前台設定");
    }
  }

  function resetFrontend() {
    const def = window.DK?.DEFAULT_CONFIG;
    if (!def) return;
    window.DK?.saveConfig?.({ ...def });
    loadFrontendForm();
    const msg = document.getElementById("frontendMsg");
    if (msg) {
      msg.hidden = false;
      msg.textContent = "已重置為預設。";
      msg.style.color = "";
    }
  }

  document.getElementById("frontendSaveBtn")?.addEventListener("click", saveFrontend);
  document.getElementById("frontendSaveBtn2")?.addEventListener("click", saveFrontend);
  document.getElementById("frontendResetBtn")?.addEventListener("click", () => {
    if (confirm("確定重置前台設定為預設值？")) resetFrontend();
  });
  ["feHeroTagline", "feHeroSub", "feHeroBtn1", "feHeroBtn2"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateHeroLivePreview);
  });
  ["feBrandMark", "feBrandTitle", "feBrandSubtitle"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateBrandLivePreview);
  });
  document.getElementById("feHomeStyleOverlay")?.addEventListener("input", function () {
    const v = document.getElementById("feHomeStyleOverlay")?.value || "70";
    const label = document.getElementById("feHomeStyleOverlayVal");
    if (label) label.textContent = v;
  });
  document.getElementById("feBrandLogoFile")?.addEventListener("change", async function (e) {
    const inp = e.target;
    const file = inp.files && inp.files[0];
    if (inp) inp.value = "";
    if (!file || !file.type || !file.type.startsWith("image/")) return;
    if (!window.DK?.uploadSiteAssetToSupabaseStorage) {
      alert("Supabase 站內資產（site-assets）未設定或無法上傳，請檢查 shared.js。");
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(16).slice(2);
    const ext = file.type.includes("png") ? "png" : file.type.includes("webp") ? "webp" : file.type.includes("gif") ? "gif" : "jpg";
    const path = "brand/" + ts + "-" + rand + "." + ext;
    try {
      const url = await window.DK.uploadSiteAssetToSupabaseStorage(file, path);
      if (!url) {
        alert("Logo 上傳失敗，請稍後再試。");
        return;
      }
      const urlEl = document.getElementById("feBrandLogoUrl");
      if (urlEl) urlEl.value = url;
      updateBrandLogoAdminPreview();
    } catch (err) {
      console.warn("Logo 上傳錯誤", err);
      alert("Logo 上傳失敗，請稍後再試。");
    }
  });
  document.getElementById("feBrandLogoClear")?.addEventListener("click", function () {
    const urlEl = document.getElementById("feBrandLogoUrl");
    if (urlEl) urlEl.value = "";
    updateBrandLogoAdminPreview();
  });
  ["feTrustTitle", "feTrustItems", "feTrustNote"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateTrustLivePreview);
  });

  // 初始化廠商管理區塊
  (function initVendorManage() {
    renderVendorOptions();
    renderVendorSelect("");
    document.getElementById("addVendorBtn")?.addEventListener("click", addVendorOption);
    document.getElementById("newVendorName")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addVendorOption();
      }
    });
  })();

  // ===== 廠商報價紀錄（localStorage：dk_vendor_quotes_v1）=====

  const VQ_PAGE_SIZE = 10;
  let vqListPage = 1;
  const VQ_ANALYSIS_PAGE_SIZE = 10;
  let vqAnalysisPage = 1;
  let vqSummaryExpandedVendor = "";
  let vqAnalysisPagerBound = false;

  // 統計欄位顯示用（相容庫存品類別名；不改資料結構）
  const VQ_SUMMARY_CAT_COLS = [
    { label: "CPU", aliases: ["CPU", "處理器", "Processor"] },
    { label: "主機板", aliases: ["主機板", "MB", "Motherboard", "Mainboard"] },
    { label: "顯示卡", aliases: ["顯示卡", "GPU", "VGA", "Graphics Card", "顯卡"] },
    { label: "SSD", aliases: ["SSD", "固態硬碟", "固態碟", "NVMe", "M.2 SSD", "SATA SSD", "硬碟"] },
    { label: "記憶體", aliases: ["記憶體", "RAM", "Memory", "DRAM"] },
    { label: "電源", aliases: ["電源", "電源供應器", "PSU", "Power Supply"] },
    { label: "機殼", aliases: ["機殼", "Case", "Chassis"] },
    { label: "螢幕", aliases: ["螢幕", "顯示器", "Monitor", "Display"] },
    { label: "鍵盤", aliases: ["鍵盤", "Keyboard"] },
    { label: "滑鼠", aliases: ["滑鼠", "Mouse"] },
    { label: "耳機", aliases: ["耳機", "Headset", "Headphone", "Earphone"] },
  ];
  const VQ_SUMMARY_OTHER_LABEL = "其他";
  const VQ_SUMMARY_COLSPAN = 2 + VQ_SUMMARY_CAT_COLS.length + 1 + 3; // 廠商+總筆數+品類欄+其他+3統計

  function vqSummaryCatHeaderHtml() {
    return VQ_SUMMARY_CAT_COLS.map((c) => `<th style="text-align:right">${vqEsc(c.label)}</th>`).join("")
      + `<th style="text-align:right">${vqEsc(VQ_SUMMARY_OTHER_LABEL)}</th>`;
  }

  function vqSummaryCatCellsHtml(cats) {
    const map = cats && typeof cats === "object" ? cats : {};
    return VQ_SUMMARY_CAT_COLS.map((c) => `<td style="text-align:right">${vqEsc(String(map[c.label] || 0))}</td>`).join("")
      + `<td style="text-align:right">${vqEsc(String(map[VQ_SUMMARY_OTHER_LABEL] || 0))}</td>`;
  }

  function vqSummaryEmptyCats() {
    const cats = Object.fromEntries(VQ_SUMMARY_CAT_COLS.map((c) => [c.label, 0]));
    cats[VQ_SUMMARY_OTHER_LABEL] = 0;
    return cats;
  }

  function vqClassifySummaryCategory(category) {
    const cat = String(category || "").trim();
    for (const col of VQ_SUMMARY_CAT_COLS) {
      if (vqCategoryMatchesAliases(cat, col.aliases)) return col.label;
    }
    return VQ_SUMMARY_OTHER_LABEL;
  }

  function vqNowISODate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function vqNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function vqNormalize(q) {
    const r = q && typeof q === "object" ? q : {};
    const out = {
      id: String(r.id || ("vq_" + Date.now() + "_" + Math.random().toString(16).slice(2))),
      date: String(r.date || ""),
      vendor: String(r.vendor || ""),
      category: String(r.category || ""),
      brand: String(r.brand || ""),
      spec: String(r.spec || ""),
      price: vqNum(r.price),
      marketPrice: vqNum(r.marketPrice != null ? r.marketPrice : r.market_price),
      taxIncluded: !!r.taxIncluded,
      shippingIncluded: !!r.shippingIncluded,
      warranty: String(r.warranty || ""),
      inStock: !!r.inStock,
      note: String(r.note || ""),
    };
    // 同步用時間戳／tombstone：有才保留，不批次改寫舊資料內容
    if (r.createdAt || r.created_at) out.createdAt = String(r.createdAt || r.created_at);
    if (r.updatedAt || r.updated_at) out.updatedAt = String(r.updatedAt || r.updated_at);
    if (r.deletedAt || r.deleted_at) out.deletedAt = String(r.deletedAt || r.deleted_at);
    return out;
  }

  function vqIsDeleted(q) {
    if (window.DK && typeof window.DK.vpIsDeleted === "function") return window.DK.vpIsDeleted(q);
    const d = q && (q.deletedAt != null ? q.deletedAt : q.deleted_at);
    return d != null && String(d).trim() !== "";
  }

  function vqStampNew(q) {
    const now = new Date().toISOString();
    const out = vqNormalize(q);
    if (!out.createdAt) out.createdAt = now;
    out.updatedAt = now;
    if (out.deletedAt) delete out.deletedAt;
    return out;
  }

  function vqEsc(s) {
    return typeof v2Esc === "function" ? v2Esc(String(s ?? "")) : String(s ?? "");
  }

  /** 廠商報價品項顯示名（相容舊 brand + spec；不改寫資料） */
  function getVendorQuoteDisplayName(quote) {
    const brand = String(quote?.brand || "").trim();
    const spec = String(quote?.spec || "").trim();
    if (!brand && !spec) return "未填寫";
    if (!brand) return spec;
    if (!spec) return brand;
    const brandLower = brand.toLowerCase();
    const specLower = spec.toLowerCase();
    // 型號／規格開頭已含相同品牌時不重複
    if (
      specLower === brandLower
      || specLower.startsWith(brandLower + " ")
      || specLower.startsWith(brandLower + "/")
      || specLower.startsWith(brandLower + "／")
    ) {
      return spec;
    }
    return brand + " " + spec;
  }

  // 供採購／叫貨單模組沿用（不複製另一套顯示規則）
  try {
    window.DKPurchaseBridge = {
      loadVendorQuotes: function () { return loadVendorQuotes(); },
      getVendorQuoteDisplayName: getVendorQuoteDisplayName,
      esc: v2Esc,
      getVendors: function () { return getVendorOptionsFromConfig(); },
      getCategories: function () {
        try {
          if (window.DK && typeof window.DK.getInventoryCategories === "function") {
            return window.DK.getInventoryCategories() || [];
          }
        } catch (_) {}
        return ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼", "螢幕", "鍵盤", "滑鼠", "耳機", "周邊", "其他"];
      },
    };
  } catch (_) {}

  function loadVendorQuotes() {
    let list = [];
    if (window.DK && typeof window.DK.loadVendorQuotesRaw === "function") {
      list = window.DK.loadVendorQuotesRaw(false);
    } else {
      const raw = safeParse(localStorage.getItem(VENDOR_QUOTES_KEY), null);
      list = Array.isArray(raw) ? raw : [];
      list = list.filter((q) => !vqIsDeleted(q));
    }
    return list.map(vqNormalize);
  }

  function loadVendorQuotesAll() {
    if (window.DK && typeof window.DK.loadVendorQuotesRaw === "function") {
      return window.DK.loadVendorQuotesRaw(true).map(vqNormalize);
    }
    const raw = safeParse(localStorage.getItem(VENDOR_QUOTES_KEY), null);
    return (Array.isArray(raw) ? raw : []).map(vqNormalize);
  }

  function saveVendorQuotes(list) {
    const active = Array.isArray(list) ? list.map(vqNormalize) : [];
    const tombstones = loadVendorQuotesAll().filter((q) => vqIsDeleted(q));
    const activeIds = new Set(active.map((q) => String(q.id)));
    const merged = tombstones.filter((t) => !activeIds.has(String(t.id))).concat(active);
    if (window.DK && typeof window.DK.saveVendorQuotesRaw === "function") {
      window.DK.saveVendorQuotesRaw(merged, { skipEvent: true, source: "local" });
    } else {
      localStorage.setItem(VENDOR_QUOTES_KEY, JSON.stringify(merged));
    }
  }

  function renderVendorQuoteVendorSelect() {
    const sel = document.getElementById("vqVendor");
    if (!sel) return;
    const list = getVendorOptionsFromConfig();
    const opts = ['<option value="">請選擇廠商</option>']
      .concat(list.map((v) => `<option value="${vqEsc(v)}">${vqEsc(v)}</option>`));
    sel.innerHTML = opts.join("");
  }

  function renderVendorQuoteCategorySelect(currentValue) {
    const sel = document.getElementById("vqCategory");
    if (!sel) return;
    const cats = DK.getInventoryCategories
      ? DK.getInventoryCategories()
      : ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼", "螢幕", "鍵盤", "滑鼠", "耳機", "周邊", "其他"];
    const cur = String(currentValue != null ? currentValue : (sel.value || "")).trim();
    const opts = ['<option value="">請選擇品類</option>'].concat(
      cats.map((c) => `<option value="${vqEsc(c)}">${vqEsc(c)}</option>`),
    );
    // 舊資料相容：若目前值不在清單內，動態補進 select（僅供顯示/不報錯，不影響資料原樣保留）
    if (cur && !cats.includes(cur)) {
      opts.push(`<option value="${vqEsc(cur)}">${vqEsc(cur)}</option>`);
    }
    sel.innerHTML = opts.join("");
    if (cur) sel.value = cur;
  }

  function vqShowMsg(text) {
    const el = document.getElementById("vqMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function getVendorQuoteSearchQuery() {
    const el = document.getElementById("vendorQuoteSearch");
    return String(el?.value || "").trim().toLowerCase();
  }

  function getVendorQuoteVendorFilter() {
    const el = document.getElementById("vendorQuoteVendorFilter");
    return String(el?.value || "").trim();
  }

  function getVendorQuoteCategoryFilter() {
    const el = document.getElementById("vendorQuoteCategoryFilter");
    return String(el?.value || "").trim();
  }

  function matchVendorQuoteFilters(q, search, vendorFilter, categoryFilter) {
    if (vendorFilter && String(q?.vendor || "").trim() !== vendorFilter) return false;
    if (categoryFilter && String(q?.category || "").trim() !== categoryFilter) return false;
    if (!search) return true;
    const remark = String(q?.remark != null ? q.remark : (q?.note || ""));
    const hay = [
      String(q?.vendor || ""),
      String(q?.category || ""),
      String(q?.brand || ""),
      String(q?.spec || ""),
      remark,
    ].join(" ").toLowerCase();
    return hay.includes(search);
  }

  function getFilteredVendorQuotes(allQuotes) {
    const list = Array.isArray(allQuotes) ? allQuotes : loadVendorQuotes();
    const search = getVendorQuoteSearchQuery();
    const vendorFilter = getVendorQuoteVendorFilter();
    const categoryFilter = getVendorQuoteCategoryFilter();
    return list
      .filter((q) => matchVendorQuoteFilters(q, search, vendorFilter, categoryFilter))
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  function populateVendorQuoteFilterSelects(allQuotes) {
    const list = Array.isArray(allQuotes) ? allQuotes : loadVendorQuotes();
    const vendorSel = document.getElementById("vendorQuoteVendorFilter");
    const catSel = document.getElementById("vendorQuoteCategoryFilter");
    const curVendor = vendorSel ? String(vendorSel.value || "") : "";
    const curCat = catSel ? String(catSel.value || "") : "";

    const vendors = Array.from(new Set(
      list.map((q) => String(q?.vendor || "").trim()).filter(Boolean),
    )).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const cats = Array.from(new Set(
      list.map((q) => String(q?.category || "").trim()).filter(Boolean),
    )).sort((a, b) => a.localeCompare(b, "zh-Hant"));

    if (vendorSel) {
      vendorSel.innerHTML = ['<option value="">全部</option>']
        .concat(vendors.map((v) => `<option value="${vqEsc(v)}">${vqEsc(v)}</option>`))
        .join("");
      if (curVendor && vendors.includes(curVendor)) vendorSel.value = curVendor;
      else vendorSel.value = "";
    }
    if (catSel) {
      catSel.innerHTML = ['<option value="">全部</option>']
        .concat(cats.map((c) => `<option value="${vqEsc(c)}">${vqEsc(c)}</option>`))
        .join("");
      if (curCat && cats.includes(curCat)) catSel.value = curCat;
      else catSel.value = "";
    }
  }

  function renderVendorQuotePagination(total, page, totalPages) {
    const pager = document.getElementById("vendorQuotePagination");
    if (!pager) return;
    const count = Number(total) || 0;
    const pages = count <= 0 ? 0 : Math.max(1, Number(totalPages) || 1);
    const cur = count <= 0 ? 0 : Math.min(Math.max(1, Number(page) || 1), pages);
    const prevDisabled = count <= 0 || cur <= 1;
    const nextDisabled = count <= 0 || cur >= pages || pages <= 1;
    let html = `<span class="pagination-info">共 ${count} 筆｜每頁 ${VQ_PAGE_SIZE} 筆｜第 ${cur} / ${pages} 頁</span>`;
    html += `<span class="pagination-btns">`;
    html += `<button type="button" class="btn btn-ghost btn-sm page-btn prev" data-vq-page="${Math.max(1, cur - 1)}" ${prevDisabled ? "disabled" : ""}>上一頁</button>`;
    if (pages > 1) {
      for (let p = 1; p <= pages; p++) {
        const active = p === cur ? " current" : "";
        html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-vq-page="${p}">${p}</button>`;
      }
    }
    html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-vq-page="${Math.min(pages || 1, cur + 1)}" ${nextDisabled ? "disabled" : ""}>下一頁</button>`;
    html += `</span>`;
    pager.innerHTML = html;
  }

  function renderVendorQuotes() {
    const tbody = document.getElementById("vendorQuotesTbody");
    if (!tbody) return;
    const all = loadVendorQuotes();
    populateVendorQuoteFilterSelects(all);
    const list = getFilteredVendorQuotes(all);
    const total = list.length;
    const totalPages = total <= 0 ? 0 : Math.max(1, Math.ceil(total / VQ_PAGE_SIZE) || 1);
    if (total <= 0) {
      vqListPage = 1;
    } else {
      if (vqListPage > totalPages) vqListPage = totalPages;
      if (vqListPage < 1) vqListPage = 1;
    }
    const start = total <= 0 ? 0 : (vqListPage - 1) * VQ_PAGE_SIZE;
    const pageRows = total <= 0 ? [] : list.slice(start, start + VQ_PAGE_SIZE);

    if (total === 0) {
      tbody.innerHTML = `<tr><td class="muted" colspan="9">尚無報價</td></tr>`;
      renderVendorQuotePagination(0, 0, 0);
    } else {
      const fmt = (n) => (n == null ? "" : Number(n).toLocaleString("zh-TW"));
      const fmt1 = (n) => (n == null || !Number.isFinite(Number(n))) ? "" : Number(n).toFixed(1);
      tbody.innerHTML = pageRows
        .map((q) => {
          const stock = q.inStock ? `<span class="badge ok">現貨</span>` : `<span class="badge">—</span>`;
          const mp = (q.marketPrice == null) ? null : Number(q.marketPrice);
          const p = (q.price == null) ? null : Number(q.price);
          const diff = (mp != null && p != null) ? (mp - p) : null;
          const margin = (mp != null && mp > 0 && p != null) ? ((mp - p) / mp) : null;
          const mpText = mp == null ? "-" : fmt(mp);
          const diffText = diff == null ? "-" : fmt(diff);
          const marginText = margin == null ? "-" : fmt1(margin * 100) + "%";
          const marginBadge = (function () {
            if (margin == null) return `<span class="badge">-</span>`;
            if (margin < 0) return `<span class="badge danger">${vqEsc(marginText)}</span>`;
            if (margin >= 0.001) return `<span class="badge ok">${vqEsc(marginText)}</span>`;
            return `<span class="badge">${vqEsc(marginText)}</span>`;
          })();
          return `<tr>
            <td class="nowrap">${vqEsc((q.date || "").slice(0, 10))}</td>
            <td>${vqEsc(q.vendor)}</td>
            <td>${vqEsc(getVendorQuoteDisplayName(q))}</td>
            <td style="text-align:right">${vqEsc(fmt(q.price))}</td>
            <td style="text-align:right">${vqEsc(mpText)}</td>
            <td style="text-align:right">${vqEsc(diffText)}</td>
            <td style="text-align:right">${marginBadge}</td>
            <td>${stock}</td>
            <td style="text-align:right; white-space:nowrap">
              <button type="button" class="btn btn-ghost btn-sm btn-vq-create-inv" data-id="${vqEsc(q.id)}">建立庫存</button>
              <button type="button" class="btn btn-ghost btn-sm btn-vq-del" data-id="${vqEsc(q.id)}">刪除</button>
            </td>
          </tr>`;
        })
        .join("");
      renderVendorQuotePagination(total, vqListPage, totalPages);
    }

    // 明確各呼叫一次（不改分析公式；不由 analysis 內部再串 summary）
    const quotesForPanels = all;
    if (typeof renderVendorAnalysis === "function") renderVendorAnalysis();
    if (typeof renderVendorCategoryAdvantage === "function") renderVendorCategoryAdvantage(quotesForPanels);
    if (typeof renderVendorQuoteSummary === "function") renderVendorQuoteSummary(quotesForPanels);
  }

  function vqCategoryMatchesAliases(category, aliases) {
    const cat = String(category || "").trim().toLowerCase();
    if (!cat) return false;
    return (aliases || []).some((a) => cat === String(a || "").trim().toLowerCase());
  }

  function buildVendorQuoteSummaryStats(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    const lowest = getLowestQuotesBySpec(list);
    const winByVendor = new Map();
    for (const row of lowest) {
      const v = String(row?.vendor || "").trim() || "（未填廠商）";
      winByVendor.set(v, (winByVendor.get(v) || 0) + 1);
    }

    const now = Date.now();
    const day30 = 30 * 24 * 60 * 60 * 1000;
    const byVendor = new Map();

    for (const q of list) {
      const vendor = String(q?.vendor || "").trim() || "（未填廠商）";
      if (!byVendor.has(vendor)) {
        byVendor.set(vendor, {
          vendor,
          total: 0,
          cats: vqSummaryEmptyCats(),
          lowestWins: 0,
          recent30: 0,
          quotes: [],
        });
      }
      const row = byVendor.get(vendor);
      row.total += 1;
      row.quotes.push(q);
      const bucket = vqClassifySummaryCategory(q?.category);
      row.cats[bucket] = (row.cats[bucket] || 0) + 1;
      const ts = Date.parse(String(q?.date || "").slice(0, 10));
      if (Number.isFinite(ts) && (now - ts) <= day30 && (now - ts) >= 0) row.recent30 += 1;
    }

    for (const [vendor, wins] of winByVendor.entries()) {
      if (!byVendor.has(vendor)) {
        byVendor.set(vendor, {
          vendor,
          total: 0,
          cats: vqSummaryEmptyCats(),
          lowestWins: 0,
          recent30: 0,
          quotes: [],
        });
      }
      byVendor.get(vendor).lowestWins = wins;
    }

    return Array.from(byVendor.values())
      .map((r) => {
        const winRate = r.total > 0 ? (r.lowestWins / r.total) : 0;
        return { ...r, winRate };
      })
      .sort((a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor, "zh-Hant"));
  }

  function renderVendorQuoteSummaryDetail(stat) {
    const fmt = (n) => (n == null || !Number.isFinite(Number(n))) ? "-" : Number(n).toLocaleString("zh-TW");
    const fmt1 = (n) => (n == null || !Number.isFinite(Number(n))) ? "-" : Number(n).toFixed(1) + "%";
    const catBits = VQ_SUMMARY_CAT_COLS
      .map((c) => `${vqEsc(c.label)}：${vqEsc(String(stat.cats[c.label] || 0))}筆`)
      .concat([`${vqEsc(VQ_SUMMARY_OTHER_LABEL)}：${vqEsc(String(stat.cats[VQ_SUMMARY_OTHER_LABEL] || 0))}筆`])
      .join("　");
    const recent = (stat.quotes || [])
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .slice(0, 10);
    const recentRows = recent.length
      ? recent.map((q) => {
          const mp = (q.marketPrice == null) ? null : Number(q.marketPrice);
          const p = (q.price == null) ? null : Number(q.price);
          const margin = (mp != null && mp > 0 && p != null) ? ((mp - p) / mp) * 100 : null;
          const specText = getVendorQuoteDisplayName(q);
          const rawCat = String(q?.category || "").trim() || "—";
          return `<tr>
            <td class="nowrap">${vqEsc((q.date || "").slice(0, 10))}</td>
            <td>${vqEsc(rawCat)}</td>
            <td>${vqEsc(specText)}</td>
            <td style="text-align:right">${vqEsc(fmt(p))}</td>
            <td style="text-align:right">${vqEsc(fmt(mp))}</td>
            <td style="text-align:right">${vqEsc(fmt1(margin))}</td>
          </tr>`;
        }).join("")
      : `<tr><td class="muted" colspan="6">尚無報價</td></tr>`;
    return `<div class="vq-summary-detail-inner">
      <div class="vq-summary-cats">${catBits}</div>
      <div>
        <div class="muted small" style="margin-bottom:4px">最近報價（最近10筆）</div>
        <table class="vq-summary-recent">
          <thead>
            <tr>
              <th>日期</th>
              <th>品類</th>
              <th>品項</th>
              <th style="text-align:right">報價</th>
              <th style="text-align:right">行情價</th>
              <th style="text-align:right">毛利%</th>
            </tr>
          </thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderVendorQuoteSummary(quotes) {
    const list = Array.isArray(quotes) ? quotes : loadVendorQuotes();
    let wrap = document.getElementById("vendorQuoteSummarySection");
    const advantage = document.getElementById("vendorCategoryAdvantageSection");
    const analysis = document.getElementById("vendorAnalysisSection");
    const host = advantage?.parentElement
      || analysis?.parentElement
      || document.getElementById("vendor-section")
      || document.getElementById("tab-vendors");
    if (!host) return;

    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "vendorQuoteSummarySection";
      wrap.className = "card";
      wrap.style.marginBottom = "12px";
      wrap.innerHTML = `
        <h3 class="h3">廠商報價統計</h3>
        <div class="table-wrap" style="margin-top:10px">
          <table class="table">
            <thead>
              <tr>
                <th>廠商</th>
                <th style="text-align:right">總報價筆數</th>
                ${vqSummaryCatHeaderHtml()}
                <th style="text-align:right">最低價次數</th>
                <th style="text-align:right">最低價勝率</th>
                <th style="text-align:right">最近30天新增</th>
              </tr>
            </thead>
            <tbody id="vendorQuoteSummaryTbody"></tbody>
          </table>
        </div>
        <div id="vendorQuoteSummaryEmpty" class="muted" style="margin-top:8px" hidden>尚無報價統計</div>
      `;
      wrap.addEventListener("click", (e) => {
        const row = e.target && e.target.closest ? e.target.closest("tr.vq-summary-row") : null;
        if (!row) return;
        const vendor = row.getAttribute("data-vendor") || "";
        vqSummaryExpandedVendor = (vqSummaryExpandedVendor === vendor) ? "" : vendor;
        renderVendorQuoteSummary(loadVendorQuotes());
      });
    }

    // 固定放在「廠商品類優勢分析」上方
    if (advantage) host.insertBefore(wrap, advantage);
    else if (analysis && analysis.nextSibling) host.insertBefore(wrap, analysis.nextSibling);
    else if (!wrap.parentElement) host.appendChild(wrap);

    // 確保表頭與品類欄同步（相容舊 DOM）
    const theadRow = wrap.querySelector("thead tr");
    if (theadRow) {
      theadRow.innerHTML = `
        <th>廠商</th>
        <th style="text-align:right">總報價筆數</th>
        ${vqSummaryCatHeaderHtml()}
        <th style="text-align:right">最低價次數</th>
        <th style="text-align:right">最低價勝率</th>
        <th style="text-align:right">最近30天新增</th>
      `;
    }

    const tbody = document.getElementById("vendorQuoteSummaryTbody");
    const emptyEl = document.getElementById("vendorQuoteSummaryEmpty");
    if (!tbody || !emptyEl) return;

    const stats = buildVendorQuoteSummaryStats(list);
    if (stats.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const pct = (n) => (n == null || !Number.isFinite(Number(n))) ? "-" : (Number(n) * 100).toFixed(1) + "%";
    const rows = [];
    for (const s of stats) {
      const expanded = vqSummaryExpandedVendor === s.vendor;
      rows.push(`<tr class="vq-summary-row${expanded ? " is-open" : ""}" data-vendor="${vqEsc(s.vendor)}">
        <td>${vqEsc(s.vendor)}</td>
        <td style="text-align:right">${vqEsc(String(s.total))}</td>
        ${vqSummaryCatCellsHtml(s.cats)}
        <td style="text-align:right">${vqEsc(String(s.lowestWins || 0))}</td>
        <td style="text-align:right">${vqEsc(pct(s.winRate))}</td>
        <td style="text-align:right">${vqEsc(String(s.recent30 || 0))}</td>
      </tr>`);
      if (expanded) {
        rows.push(`<tr class="vq-summary-detail"><td colspan="${VQ_SUMMARY_COLSPAN}">${renderVendorQuoteSummaryDetail(s)}</td></tr>`);
      }
    }
    tbody.innerHTML = rows.join("");
  }

  // ===== 廠商報價：比價分析系統 =====
  function normalizeSpecKey(q) {
    const spec = String(q?.spec || "").trim();
    if (spec) return spec.toLowerCase();
    // 需求寫 brand + name；本系統結構沒有 name，故以 brand + (可能存在的 name/model) 退回，至少保持穩定 key
    const brand = String(q?.brand || "").trim();
    const name = String(q?.name || q?.model || "").trim();
    return (brand + " " + name).trim().toLowerCase();
  }

  function getLowestQuotesBySpec(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    const best = new Map(); // specKey -> quote
    for (const q of list) {
      const key = normalizeSpecKey(q);
      if (!key) continue;
      const price = Number(q?.price);
      if (!Number.isFinite(price)) continue;
      const cur = best.get(key);
      if (!cur || price < Number(cur.price)) best.set(key, q);
    }
    return Array.from(best.entries()).map(([specKey, original]) => ({
      specKey,
      vendor: String(original?.vendor || ""),
      price: Number(original?.price) || 0,
      original,
    }));
  }

  function getQuotesGroupedBySpec(quotes) {
    const list = Array.isArray(quotes) ? quotes : [];
    const out = {};
    for (const q of list) {
      const key = normalizeSpecKey(q);
      if (!key) continue;
      const price = Number(q?.price);
      if (!Number.isFinite(price)) continue;
      (out[key] = out[key] || []).push({
        vendor: String(q?.vendor || ""),
        price: price,
        date: String(q?.date || ""),
        marketPrice: (q?.marketPrice == null ? null : Number(q.marketPrice)),
      });
    }
    return out;
  }

  function getPurchaseSuggestion(group) {
    const rows = Array.isArray(group) ? group : [];
    const prices = rows.map((x) => Number(x?.price)).filter((n) => Number.isFinite(n));
    if (prices.length === 0) return { min: null, avg: null, diff: null, avgMarketPrice: null, margin: null, label: "不建議" };
    const min = Math.min(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    const mps = rows.map((x) => Number(x?.marketPrice)).filter((n) => Number.isFinite(n) && n > 0);
    if (mps.length > 0) {
      const avgMarketPrice = mps.reduce((a, b) => a + b, 0) / mps.length;
      const margin = avgMarketPrice > 0 ? (avgMarketPrice - min) / avgMarketPrice : null;
      const label = (margin != null && margin >= 0.20) ? "可進" : (margin != null && margin >= 0.10) ? "觀望" : "不建議";
      return { min, avg, diff: null, avgMarketPrice, margin, label };
    }

    const diff = avg > 0 ? (avg - min) / avg : 0;
    const label = diff >= 0.15 ? "可進" : diff >= 0.07 ? "觀望" : "不建議";
    return { min, avg, diff, avgMarketPrice: null, margin: null, label };
  }

  function renderVendorAnalysisPagination(total, page, totalPages) {
    const pager = document.getElementById("vendorAnalysisPagination");
    if (!pager) return;
    const count = Number(total) || 0;
    const pages = count <= 0 ? 0 : Math.max(1, Number(totalPages) || 1);
    const cur = count <= 0 ? 0 : Math.min(Math.max(1, Number(page) || 1), pages);
    const prevDisabled = count <= 0 || cur <= 1;
    const nextDisabled = count <= 0 || cur >= pages || pages <= 1;
    let html = `<span class="pagination-info">共 ${count} 筆｜每頁 ${VQ_ANALYSIS_PAGE_SIZE} 筆｜第 ${cur} / ${pages} 頁</span>`;
    html += `<span class="pagination-btns">`;
    html += `<button type="button" class="btn btn-ghost btn-sm page-btn prev" data-vq-analysis-page="${Math.max(1, cur - 1)}" ${prevDisabled ? "disabled" : ""}>上一頁</button>`;
    if (pages > 1) {
      for (let p = 1; p <= pages; p++) {
        const active = p === cur ? " current" : "";
        html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-vq-analysis-page="${p}">${p}</button>`;
      }
    }
    html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-vq-analysis-page="${Math.min(pages || 1, cur + 1)}" ${nextDisabled ? "disabled" : ""}>下一頁</button>`;
    html += `</span>`;
    pager.innerHTML = html;
  }

  function renderVendorAnalysis() {
    // 建立/取得容器
    let wrap = document.getElementById("vendorAnalysisSection");
    if (!wrap) {
      const host = document.getElementById("vendor-section") || document.getElementById("tab-vendors");
      if (!host) return;
      wrap = document.createElement("div");
      wrap.id = "vendorAnalysisSection";
      wrap.className = "card";
      wrap.style.marginBottom = "12px";
      wrap.innerHTML = `
        <h3 class="h3">比價分析</h3>
        <div class="table-wrap" style="margin-top:10px">
          <table class="table">
            <thead>
              <tr>
                <th>規格</th>
                <th style="text-align:right">最低價</th>
                <th>最低廠商</th>
                <th style="text-align:right">平均價</th>
                <th style="text-align:right">價差%</th>
                <th style="text-align:right">行情平均價</th>
                <th style="text-align:right">平均毛利空間%</th>
                <th>建議</th>
              </tr>
            </thead>
            <tbody id="vendorAnalysisTbody"></tbody>
          </table>
        </div>
        <div id="vendorAnalysisPagination" class="pagination"></div>
        <div id="vendorAnalysisEmpty" class="muted" style="margin-top:8px" hidden>尚無可分析的報價</div>
      `;
      host.appendChild(wrap);
    } else if (!document.getElementById("vendorAnalysisPagination")) {
      const emptyEl0 = document.getElementById("vendorAnalysisEmpty");
      const pager = document.createElement("div");
      pager.id = "vendorAnalysisPagination";
      pager.className = "pagination";
      if (emptyEl0) wrap.insertBefore(pager, emptyEl0);
      else wrap.appendChild(pager);
    }

    if (!vqAnalysisPagerBound) {
      wrap.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("[data-vq-analysis-page]") : null;
        if (!btn || btn.disabled) return;
        const page = Number(btn.getAttribute("data-vq-analysis-page"));
        if (!Number.isFinite(page) || page < 1) return;
        vqAnalysisPage = page;
        renderVendorAnalysis();
      });
      vqAnalysisPagerBound = true;
    }

    const tbody = document.getElementById("vendorAnalysisTbody");
    const emptyEl = document.getElementById("vendorAnalysisEmpty");
    if (!tbody || !emptyEl) return;

    // 先用完整報價做分析（不先 slice 原始資料）
    const quotes = loadVendorQuotes();
    const grouped = getQuotesGroupedBySpec(quotes);
    const keys = Object.keys(grouped);
    if (keys.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      vqAnalysisPage = 1;
      renderVendorAnalysisPagination(0, 0, 0);
      return;
    }
    emptyEl.hidden = true;

    const lowest = new Map(getLowestQuotesBySpec(quotes).map((x) => [x.specKey, x]));
    const fmt = (n) => (n == null || !Number.isFinite(Number(n))) ? "" : Number(n).toLocaleString("zh-TW");
    const pct = (n) => (n == null || !Number.isFinite(Number(n))) ? "" : (Number(n) * 100).toFixed(1) + "%";
    const badge = (label) => {
      if (label === "可進") return `<span class="badge ok">${vqEsc(label)}</span>`;
      if (label === "觀望") return `<span class="badge warn">${vqEsc(label)}</span>`;
      return `<span class="badge">${vqEsc(label)}</span>`;
    };
    const marginBadge = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return `<span class="badge">-</span>`;
      const t = (Number(n) * 100).toFixed(1) + "%";
      if (Number(n) < 0) return `<span class="badge danger">${vqEsc(t)}</span>`;
      if (Number(n) >= 0.001) return `<span class="badge ok">${vqEsc(t)}</span>`;
      return `<span class="badge">${vqEsc(t)}</span>`;
    };

    const allRows = keys
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((specKey) => {
        const group = grouped[specKey] || [];
        const sug = getPurchaseSuggestion(group);
        const low = lowest.get(specKey);
        const mp = group.map((x) => Number(x?.marketPrice)).filter((n) => Number.isFinite(n) && n > 0);
        const avgMarket = mp.length ? (mp.reduce((a, b) => a + b, 0) / mp.length) : null;
        const margins = group
          .map((x) => {
            const m = Number(x?.marketPrice);
            const p = Number(x?.price);
            if (!Number.isFinite(m) || m <= 0) return null;
            if (!Number.isFinite(p)) return null;
            return (m - p) / m;
          })
          .filter((n) => n != null && Number.isFinite(Number(n)));
        const avgMargin = margins.length ? (margins.reduce((a, b) => a + b, 0) / margins.length) : null;
        return `<tr>
          <td>${vqEsc(specKey)}</td>
          <td style="text-align:right">${vqEsc(fmt(sug.min))}</td>
          <td>${vqEsc(low?.vendor || "")}</td>
          <td style="text-align:right">${vqEsc(fmt(sug.avg))}</td>
          <td style="text-align:right">${vqEsc(pct(sug.diff))}</td>
          <td style="text-align:right">${vqEsc(fmt(avgMarket))}</td>
          <td style="text-align:right">${marginBadge(avgMargin)}</td>
          <td>${badge(sug.label)}</td>
        </tr>`;
      });

    const total = allRows.length;
    const totalPages = Math.max(1, Math.ceil(total / VQ_ANALYSIS_PAGE_SIZE) || 1);
    if (vqAnalysisPage > totalPages) vqAnalysisPage = totalPages;
    if (vqAnalysisPage < 1) vqAnalysisPage = 1;
    const start = (vqAnalysisPage - 1) * VQ_ANALYSIS_PAGE_SIZE;
    const pageRows = allRows.slice(start, start + VQ_ANALYSIS_PAGE_SIZE);
    tbody.innerHTML = pageRows.join("");
    renderVendorAnalysisPagination(total, vqAnalysisPage, totalPages);
  }

  function renderVendorCategoryAdvantage(quotes) {
    const list = Array.isArray(quotes) ? quotes : loadVendorQuotes();

    // 依 category -> specKey 找最低價，統計 vendor 低價次數
    const byCat = new Map(); // category -> Map(specKey -> lowestQuote)
    for (const q of list) {
      const cat = String(q?.category || "").trim() || "未分類";
      const specKey = normalizeSpecKey(q);
      const price = Number(q?.price);
      if (!specKey || !Number.isFinite(price)) continue;
      if (!byCat.has(cat)) byCat.set(cat, new Map());
      const m = byCat.get(cat);
      const cur = m.get(specKey);
      if (!cur || price < Number(cur.price)) m.set(specKey, q);
    }

    // 確保容器存在，放在 vendorAnalysisSection 下方
    let wrap = document.getElementById("vendorCategoryAdvantageSection");
    if (!wrap) {
      const anchor = document.getElementById("vendorAnalysisSection");
      const host = anchor?.parentElement || document.getElementById("vendor-section") || document.getElementById("tab-vendors");
      if (!host) return;
      wrap = document.createElement("div");
      wrap.id = "vendorCategoryAdvantageSection";
      wrap.className = "card";
      wrap.style.marginBottom = "12px";
      wrap.innerHTML = `
        <h3 class="h3">廠商品類優勢分析</h3>
        <div class="table-wrap" style="margin-top:10px">
          <table class="table">
            <thead>
              <tr>
                <th>品類</th>
                <th>優勢廠商</th>
                <th style="text-align:right">最低價次數</th>
                <th style="text-align:right">該品類報價筆數</th>
                <th>建議</th>
              </tr>
            </thead>
            <tbody id="vendorCategoryAdvantageTbody"></tbody>
          </table>
        </div>
        <div id="vendorCategoryAdvantageEmpty" class="muted" style="margin-top:8px" hidden>尚無可分析的品類</div>
      `;
      if (anchor && anchor.nextSibling) host.insertBefore(wrap, anchor.nextSibling);
      else host.appendChild(wrap);
    }

    const tbody = document.getElementById("vendorCategoryAdvantageTbody");
    const emptyEl = document.getElementById("vendorCategoryAdvantageEmpty");
    if (!tbody || !emptyEl) return;

    const cats = Array.from(byCat.keys());
    if (cats.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const catQuoteCount = new Map(); // category -> count (raw quotes)
    for (const q of list) {
      const cat = String(q?.category || "").trim() || "未分類";
      const price = Number(q?.price);
      const specKey = normalizeSpecKey(q);
      if (!specKey || !Number.isFinite(price)) continue;
      catQuoteCount.set(cat, (catQuoteCount.get(cat) || 0) + 1);
    }

    function suggestionBadge(label) {
      if (label === "優先詢價") return `<span class="badge ok">${vqEsc(label)}</span>`;
      if (label === "持續觀察") return `<span class="badge warn">${vqEsc(label)}</span>`;
      return `<span class="badge">${vqEsc(label)}</span>`;
    }

    const rows = cats
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((cat) => {
        const lowestBySpec = byCat.get(cat);
        const winCount = new Map(); // vendor -> times lowest
        for (const q of lowestBySpec.values()) {
          const v = String(q?.vendor || "").trim() || "（未填廠商）";
          winCount.set(v, (winCount.get(v) || 0) + 1);
        }
        let bestVendor = "";
        let bestTimes = 0;
        for (const [v, c] of winCount.entries()) {
          if (c > bestTimes) { bestTimes = c; bestVendor = v; }
        }
        const totalQuotes = catQuoteCount.get(cat) || 0;
        let suggestion = "持續觀察";
        if (totalQuotes < 3) suggestion = "樣本不足";
        else if (bestTimes >= 3) suggestion = "優先詢價";
        return `<tr>
          <td>${vqEsc(cat)}</td>
          <td>${vqEsc(bestVendor)}</td>
          <td style="text-align:right">${vqEsc(String(bestTimes))}</td>
          <td style="text-align:right">${vqEsc(String(totalQuotes))}</td>
          <td>${suggestionBadge(suggestion)}</td>
        </tr>`;
      });
    tbody.innerHTML = rows.join("");
  }

  function addVendorQuoteFromForm() {
    const dateEl = document.getElementById("vqDate");
    const vendorEl = document.getElementById("vqVendor");
    const catEl = document.getElementById("vqCategory");
    const brandEl = document.getElementById("vqBrand");
    const specEl = document.getElementById("vqSpec");
    const priceEl = document.getElementById("vqPrice");
    const mpEl = document.getElementById("vqMarketPrice");
    const taxEl = document.getElementById("vqTaxIncluded");
    const shipEl = document.getElementById("vqShippingIncluded");
    const warrantyEl = document.getElementById("vqWarranty");
    const stockEl = document.getElementById("vqInStock");
    const noteEl = document.getElementById("vqNote");

    // 新表單：單一欄「品牌／型號／規格」寫入 spec；brand 存空字串（欄位仍保留相容）
    const q = vqStampNew({
      date: String(dateEl?.value || "").trim(),
      vendor: String(vendorEl?.value || "").trim(),
      category: String(catEl?.value || "").trim(),
      brand: "",
      spec: String(specEl?.value || "").trim(),
      price: vqNum(priceEl?.value),
      marketPrice: vqNum(mpEl?.value),
      taxIncluded: !!taxEl?.checked,
      shippingIncluded: !!shipEl?.checked,
      warranty: String(warrantyEl?.value || "").trim(),
      inStock: !!stockEl?.checked,
      note: String(noteEl?.value || "").trim(),
    });

    if (!q.date) return vqShowMsg("請選日期");
    if (!q.vendor) return vqShowMsg("請選廠商");
    if (!q.spec) return vqShowMsg("請填品牌／型號／規格");
    if (q.price == null || q.price < 0) return vqShowMsg("請填正確報價");

    const list = loadVendorQuotes();
    list.push(q); // 每次新增，不覆蓋
    saveVendorQuotes(list);
    vqShowMsg("已新增報價（本機）");
    renderVendorQuotes();
    renderVendorQuotesSyncPanel();
    // 雲端 upsert（失敗不回滾本機）
    if (window.DK && typeof window.DK.upsertVendorQuoteToSupabase === "function" && !window.DK.isVpApplyingCloud?.()) {
      window.DK.upsertVendorQuoteToSupabase(q).then((res) => {
        if (res && res.ok) vqShowMsg("已新增報價，已同步到雲端");
        else if (res && res.notEnabled) vqShowMsg("已新增報價（本機）。雲端尚未啟用，未上傳。");
        else vqShowMsg("本機已儲存，雲端同步失敗" + (res?.error ? "：" + res.error : ""));
        renderVendorQuotesSyncPanel();
      }).catch(() => {
        vqShowMsg("本機已儲存，雲端同步失敗");
        renderVendorQuotesSyncPanel();
      });
    }
    // 新增成功後自動收合表單
    try {
      const wrap = document.getElementById("vqFormWrap");
      if (wrap) wrap.hidden = true;
    } catch (_) {}
    setTimeout(() => vqShowMsg(""), 3500);

    // 清空部分欄位（保留日期/廠商較方便連續輸入）
    if (catEl) catEl.value = "";
    if (brandEl) brandEl.value = "";
    if (specEl) specEl.value = "";
    if (priceEl) priceEl.value = "";
    if (mpEl) mpEl.value = "";
    if (taxEl) taxEl.checked = false;
    if (shipEl) shipEl.checked = false;
    if (warrantyEl) warrantyEl.value = "";
    if (stockEl) stockEl.checked = false;
    if (noteEl) noteEl.value = "";
  }

  async function deleteVendorQuoteById(id) {
    const target = String(id || "");
    if (!target) return;
    if (window.DK && typeof window.DK.softDeleteVendorQuoteToSupabase === "function") {
      const res = await window.DK.softDeleteVendorQuoteToSupabase(target);
      renderVendorQuotes();
      renderVendorQuotesSyncPanel();
      if (res && res.cloud && res.cloud.ok) vqShowMsg("已刪除（本機＋雲端 soft delete）");
      else if (res && res.localSaved) vqShowMsg("本機已刪除；雲端同步失敗或尚未啟用");
      else vqShowMsg("刪除失敗");
      setTimeout(() => vqShowMsg(""), 3500);
      return;
    }
    // fallback：無 DK 時改為標記 deletedAt
    const list = loadVendorQuotesAll();
    const now = new Date().toISOString();
    const next = list.map((x) =>
      String(x.id) === target ? { ...x, deletedAt: now, updatedAt: now } : x,
    );
    if (window.DK && typeof window.DK.saveVendorQuotesRaw === "function") {
      window.DK.saveVendorQuotesRaw(next, { skipEvent: true, source: "local" });
    } else {
      localStorage.setItem(VENDOR_QUOTES_KEY, JSON.stringify(next));
    }
    renderVendorQuotes();
  }

  function createInventoryFromVendorQuote(id) {
    const target = String(id || "");
    if (!target) return;
    const list = loadVendorQuotes();
    const q = list.find((x) => String(x.id) === target);
    if (!q) return;

    // 依需求：呼叫既有 openV2ItemEditor(null)
    switchTab("inv");
    setTimeout(() => {
      try {
        const tabBtn = document.querySelector('.v2-tab[data-v2="items"]');
        if (tabBtn) tabBtn.click();
      } catch (_) {}
      setTimeout(() => {
        try {
          if (typeof window.__openV2ItemEditor === "function") window.__openV2ItemEditor(null);
          else document.getElementById("btnNewItem")?.click();
        } catch (_) {}

        // 帶入欄位（不填數量）
        setTimeout(() => {
          try {
            if (q.vendor) {
              // 重新 renderVendorSelect 以確保 select 內含廠商
              if (typeof renderVendorSelect === "function") renderVendorSelect(q.vendor);
              const vSel = document.getElementById("itemVendor");
              if (vSel) vSel.value = q.vendor;
            }
            if (q.category) {
              const cSel = document.getElementById("itemCategory");
              if (cSel) {
                // 舊資料相容：若 category 不在目前庫存品類清單，動態補 option，避免帶入失敗
                const exists = Array.from(cSel.options || []).some((o) => String(o?.value || "") === String(q.category));
                if (!exists) {
                  const opt = document.createElement("option");
                  opt.value = String(q.category);
                  opt.textContent = String(q.category);
                  cSel.appendChild(opt);
                }
                cSel.value = q.category;
              }
            }
            const displayName = getVendorQuoteDisplayName(q);
            const name = displayName === "未填寫" ? "" : displayName;
            const nameEl = document.getElementById("itemName");
            if (nameEl) nameEl.value = name;
            const costEl = document.getElementById("itemCost");
            if (costEl && q.price != null) costEl.value = String(q.price);
            const noteEl = document.getElementById("itemNotes");
            if (noteEl) {
              const base = String(noteEl.value || "");
              const extra = "來源：廠商報價" + (q.note ? "｜" + q.note : "");
              noteEl.value = base ? (base + "｜" + extra) : extra;
            }
          } catch (_) {}
        }, 0);
      }, 0);
    }, 0);
  }

  (function initVendorQuotes() {
    const root = document.getElementById("vendorQuotesCard");
    if (!root) return;
    const dateEl = document.getElementById("vqDate");
    if (dateEl && !dateEl.value) dateEl.value = vqNowISODate();
    renderVendorQuoteVendorSelect();
    renderVendorQuoteCategorySelect();
    renderVendorQuotes();
    renderVendorQuotesSyncPanel();
    // 表單收合
    (function initVendorQuoteFormCollapse() {
      const wrap = document.getElementById("vqFormWrap");
      const toggleBtn = document.getElementById("vqFormToggleBtn");
      const cancelBtn = document.getElementById("vqCancelBtn");
      if (!wrap || !toggleBtn) return;
      function setOpen(open) {
        wrap.hidden = !open;
        if (open) {
          try { wrap.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
        }
      }
      toggleBtn.addEventListener("click", () => setOpen(wrap.hidden));
      cancelBtn?.addEventListener("click", () => setOpen(false));
    })();
    document.getElementById("vqAddBtn")?.addEventListener("click", addVendorQuoteFromForm);

    function resetVendorQuotePageAndRender() {
      vqListPage = 1;
      renderVendorQuotes();
    }
    document.getElementById("vendorQuoteSearch")?.addEventListener("input", resetVendorQuotePageAndRender);
    document.getElementById("vendorQuoteVendorFilter")?.addEventListener("change", resetVendorQuotePageAndRender);
    document.getElementById("vendorQuoteCategoryFilter")?.addEventListener("change", resetVendorQuotePageAndRender);
    document.getElementById("vendorQuotePagination")?.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-vq-page]") : null;
      if (!btn || btn.disabled) return;
      const page = Number(btn.getAttribute("data-vq-page"));
      if (!Number.isFinite(page) || page < 1) return;
      vqListPage = page;
      renderVendorQuotes();
    });

    root.addEventListener("click", (e) => {
      const createBtn = e.target && e.target.closest ? e.target.closest(".btn-vq-create-inv") : null;
      if (createBtn) {
        createInventoryFromVendorQuote(createBtn.getAttribute("data-id") || "");
        return;
      }
      const delBtn = e.target && e.target.closest ? e.target.closest(".btn-vq-del") : null;
      if (delBtn) {
        const id = delBtn.getAttribute("data-id") || "";
        if (confirm("確定刪除此筆報價？（soft delete，另一裝置不會再帶回）")) deleteVendorQuoteById(id);
      }
    });

    bindVendorQuotesSyncPanelOnce();
    // 啟動後再拉一次狀態（shared 可能已在拉）
    if (window.DK && typeof window.DK.pullVendorQuotesFromCloud === "function") {
      window.DK.pullVendorQuotesFromCloud().then(() => {
        renderVendorQuotes();
        renderVendorQuotesSyncPanel();
      }).catch(() => renderVendorQuotesSyncPanel());
    }
  })();

  function vqSyncSetMsg(text) {
    const el = document.getElementById("vqSyncMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function renderVendorQuotesSyncPanel() {
    const badge = document.getElementById("vqSyncStatusBadge");
    const detail = document.getElementById("vqSyncDetail");
    const uploadBtn = document.getElementById("vqSyncUploadBtn");
    if (!badge && !detail) return;
    const meta = window.DK?.getVendorQuotesSyncMeta?.() || {};
    const status = String(meta.status || "never");
    const label = window.DK?.vpStatusLabel?.(status) || status;
    const localCount = Number(meta.localCount) || loadVendorQuotes().length;
    const cloudCount = Number(meta.cloudCount) || 0;
    const src = meta.source === "cloud" ? "雲端" : "本機";
    const last = meta.lastSyncAt ? String(meta.lastSyncAt).replace("T", " ").slice(0, 19) : "—";
    if (badge) {
      badge.textContent = label;
      badge.className = "dk-sync-badge";
      if (status === "synced") badge.classList.add("is-synced");
      else if (status === "syncing") badge.classList.add("is-syncing");
      else if (status === "pending_local") badge.classList.add("is-pending");
      else if (status === "failed" || status === "not_enabled") badge.classList.add("is-failed");
      else if (status === "not_enabled") badge.classList.add("is-not-enabled");
    }
    if (detail) {
      let msg = `本機 ${localCount} 筆｜雲端 ${cloudCount} 筆｜來源：${src}｜最後同步：${last}`;
      if (status === "not_enabled") {
        msg += "。請先在 Supabase SQL Editor 執行 supabase-vendor-purchase-sync.sql（尚未正式可用）。";
      } else if (status === "pending_local") {
        msg += "。雲端尚無資料，可手動「上傳本機資料」。";
      } else if (status === "failed" && meta.lastError) {
        msg += "。錯誤：" + String(meta.lastError).slice(0, 120);
      }
      if (Array.isArray(meta.conflictWarnings) && meta.conflictWarnings.length) {
        msg += `｜衝突警告 ${meta.conflictWarnings.length} 筆（同時間取雲端）`;
      }
      detail.textContent = msg;
    }
    if (uploadBtn) {
      const canUpload = meta.cloudEnabled === true && status !== "not_enabled" && status !== "syncing" && localCount > 0;
      uploadBtn.hidden = !canUpload;
    }
  }

  function bindVendorQuotesSyncPanelOnce() {
    if (window.__dkVqSyncPanelBound) return;
    window.__dkVqSyncPanelBound = true;

    document.getElementById("vqSyncNowBtn")?.addEventListener("click", async () => {
      vqSyncSetMsg("同步中…");
      renderVendorQuotesSyncPanel();
      if (!window.DK?.pullVendorQuotesFromCloud) {
        vqSyncSetMsg("同步模組未載入");
        return;
      }
      const res = await window.DK.pullVendorQuotesFromCloud();
      renderVendorQuotes();
      renderVendorQuotesSyncPanel();
      if (res?.notEnabled) vqSyncSetMsg("雲端尚未啟用：請先執行 supabase-vendor-purchase-sync.sql");
      else if (res?.emptyCloud) vqSyncSetMsg("雲端為空，已保留本機資料（未覆蓋）");
      else if (res?.ok) vqSyncSetMsg("已從雲端合併完成");
      else vqSyncSetMsg("同步失敗，本機資料已保留");
    });

    document.getElementById("vqSyncPullBtn")?.addEventListener("click", async () => {
      document.getElementById("vqSyncNowBtn")?.click();
    });

    document.getElementById("vqSyncUploadBtn")?.addEventListener("click", async () => {
      if (!window.DK?.previewVendorQuotesUpload || !window.DK?.uploadLocalVendorQuotesToCloud) {
        vqSyncSetMsg("同步模組未載入");
        return;
      }
      vqSyncSetMsg("正在計算上傳預覽…");
      const preview = await window.DK.previewVendorQuotesUpload();
      if (!preview?.ok) {
        vqSyncSetMsg(preview?.notEnabled ? "雲端尚未啟用，無法上傳" : ("預覽失敗：" + (preview?.error || "")));
        renderVendorQuotesSyncPanel();
        return;
      }
      const ok = confirm(
        "將本機廠商報價同步到雲端？\n\n" +
          `本機筆數（未刪除）：${preview.localCount}\n` +
          `雲端筆數（未刪除）：${preview.cloudCount}\n` +
          `預計新增：${preview.toInsert}\n` +
          `預計更新：${preview.toUpdate}\n\n` +
          "將依 id upsert，不會刪除雲端其他資料。\n" +
          "安全風險：公開 anon 寫入。",
      );
      if (!ok) {
        vqSyncSetMsg("已取消上傳");
        return;
      }
      vqSyncSetMsg("上傳中…");
      const result = await window.DK.uploadLocalVendorQuotesToCloud();
      renderVendorQuotes();
      renderVendorQuotesSyncPanel();
      if (result?.ok) {
        vqSyncSetMsg(`上傳完成：成功 ${result.success} 筆` + (result.failed ? `，失敗 ${result.failed}` : ""));
      } else {
        vqSyncSetMsg(
          (result?.notEnabled ? "雲端尚未啟用。" : "上傳失敗。") +
            `成功 ${result?.success || 0}／失敗 ${result?.failed || 0}` +
            (result?.error ? "：" + result.error : "") +
            "。本機資料已保留。",
        );
      }
    });

    if (!window.__dkVendorQuotesUpdatedBound) {
      window.__dkVendorQuotesUpdatedBound = true;
      window.addEventListener("dk:vendor-quotes-updated", (ev) => {
        // 只重新渲染，不因 cloud 事件再上傳（避免循環）
        try {
          renderVendorQuotes();
          renderVendorQuotesSyncPanel();
        } catch (_) {}
      });
    }
  }

  // ===== 客戶紀錄（localStorage：dk_customer_records_v1）=====
  function crNowISODate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function crSafeNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function crNormalize(rec) {
    const r = rec && typeof rec === "object" ? rec : {};
    return {
      id: String(r.id || ("cr_" + Date.now() + "_" + Math.random().toString(16).slice(2))),
      date: String(r.date || ""),
      name: String(r.name || ""),
      source: String(r.source || "其他"),
      type: String(r.type || "其他"),
      budget: crSafeNum(r.budget),
      use: String(r.use || ""),
      status: String(r.status || "未回覆"),
      dealAmount: crSafeNum(r.dealAmount),
      grossProfit: crSafeNum(r.grossProfit),
      questions: String(r.questions || ""),
      lostReason: String(r.lostReason || ""),
      note: String(r.note || ""),
    };
  }

  function loadCustomerRecords() {
    const raw = safeParse(localStorage.getItem(CUSTOMER_RECORDS_KEY), null);
    const list = Array.isArray(raw) ? raw : [];
    return list.map(crNormalize);
  }

  function saveCustomerRecords(list) {
    const safe = Array.isArray(list) ? list.map(crNormalize) : [];
    localStorage.setItem(CUSTOMER_RECORDS_KEY, JSON.stringify(safe));
  }

  function crEsc(s) {
    // 使用既有 escapeHtml（shared.js 全域）避免插入 HTML
    if (typeof escapeHtml === "function") return escapeHtml(String(s ?? ""));
    return v2Esc(String(s ?? ""));
  }

  function crEscNl(s) {
    return crEsc(s).replaceAll("\n", "<br>");
  }

  function crWeekStart(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const day = x.getDay(); // 0 Sun ... 6 Sat
    const diff = (day + 6) % 7; // Mon=0
    x.setDate(x.getDate() - diff);
    return x;
  }

  function crParseDate(dateStr) {
    const s = String(dateStr || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function crTopCounts(texts, topN) {
    const map = new Map();
    for (const t of texts) {
      const parts = String(t || "")
        .split(/\n|、|，|,|;|；|\||\/|／/)
        .map((x) => x.trim())
        .filter(Boolean);
      for (const p of parts) {
        map.set(p, (map.get(p) || 0) + 1);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN);
  }

  function renderCustomerDashboard(records) {
    const cardsEl = document.getElementById("customerStatsCards");
    const srcEl = document.getElementById("customerSourceRank");
    const winSrcEl = document.getElementById("customerWinSourceRank");
    const qEl = document.getElementById("customerQuestionTop");
    const lostEl = document.getElementById("customerLostTop");
    if (!cardsEl || !srcEl || !winSrcEl || !qEl || !lostEl) return;

    const today = new Date();
    const start = crWeekStart(today);
    const weekRecs = records.filter((r) => {
      const d = crParseDate(r.date);
      return d && d >= start && d <= today;
    });

    const inquiries = weekRecs.length;
    const wins = weekRecs.filter((r) => r.status === "成交").length;
    const rate = inquiries > 0 ? (wins / inquiries) : 0;
    const sumDeal = weekRecs.reduce((acc, r) => acc + (Number(r.dealAmount) || 0), 0);
    const sumProfit = weekRecs.reduce((acc, r) => acc + (Number(r.grossProfit) || 0), 0);

    const fmt = (n) => Number(n || 0).toLocaleString("zh-TW");
    const pct = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) : "0.0") + "%";

    const card = (title, value) =>
      `<div class="card" style="padding:10px"><div class="muted small">${crEsc(title)}</div><div style="font-size:22px;font-weight:800">${crEsc(value)}</div></div>`;

    cardsEl.innerHTML = [
      card("本週詢問數", String(inquiries)),
      card("本週成交數", String(wins)),
      card("本週成交率", pct(rate)),
      card("本週預估成交金額", "NT$ " + fmt(sumDeal)),
      card("本週預估毛利", "NT$ " + fmt(sumProfit)),
    ].join("");

    const bySource = new Map();
    for (const r of weekRecs) bySource.set(r.source, (bySource.get(r.source) || 0) + 1);
    const srcRank = Array.from(bySource.entries()).sort((a, b) => b[1] - a[1]);

    const byWinSource = new Map();
    for (const r of weekRecs) {
      if (r.status !== "成交") continue;
      byWinSource.set(r.source, (byWinSource.get(r.source) || 0) + 1);
    }
    const winRank = Array.from(byWinSource.entries()).sort((a, b) => b[1] - a[1]);

    const renderRank = (pairs) => {
      if (!pairs.length) return `<div class="muted">無資料</div>`;
      return `<ol style="margin:6px 0 0 18px">${pairs
        .map(([k, v]) => `<li>${crEsc(k)} <span class="muted">(${crEsc(String(v))})</span></li>`)
        .join("")}</ol>`;
    };

    srcEl.innerHTML = renderRank(srcRank);
    winSrcEl.innerHTML = renderRank(winRank);

    const qTop = crTopCounts(weekRecs.map((r) => r.questions), 5);
    const lostTop = crTopCounts(weekRecs.map((r) => r.lostReason), 5);
    qEl.innerHTML = renderRank(qTop);
    lostEl.innerHTML = renderRank(lostTop);
  }

  function renderCustomerList(records) {
    const tbody = document.getElementById("customerRecordsTbody");
    if (!tbody) return;
    if (!records.length) {
      tbody.innerHTML = `<tr><td class="muted" colspan="12">尚無紀錄</td></tr>`;
      return;
    }
    const statusBadgeClass = (s) => {
      const v = String(s || "").trim();
      if (v === "成交") return "badge ok";
      if (v === "流失") return "badge danger";
      if (v === "已報價") return "badge warn";
      if (v === "洽談中") return "badge info";
      return "badge"; // 未回覆/其他
    };
    const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("zh-TW"));
    const rows = records
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .map((r) => {
        return `<tr data-id="${crEsc(r.id)}">
          <td class="nowrap">${crEsc((r.date || "").slice(0, 10))}</td>
          <td>${crEsc(r.name)}</td>
          <td>${crEsc(r.source)}</td>
          <td>${crEsc(r.type)}</td>
          <td><span class="${statusBadgeClass(r.status)}">${crEsc(r.status)}</span></td>
          <td style="text-align:right">${crEsc(fmt(r.dealAmount))}</td>
          <td style="text-align:right">${crEsc(fmt(r.grossProfit))}</td>
          <td>${crEsc(r.use)}</td>
          <td class="muted small">${crEscNl(r.questions)}</td>
          <td class="muted small">${crEsc(r.lostReason)}</td>
          <td class="muted small">${crEscNl(r.note)}</td>
          <td style="text-align:right; white-space:nowrap">
            <button type="button" class="btn btn-ghost btn-sm btn-cr-create-order" data-id="${crEsc(r.id)}">建立訂單</button>
            <button type="button" class="btn btn-ghost btn-sm btn-cr-del" data-id="${crEsc(r.id)}">刪除</button>
          </td>
        </tr>`;
      });
    tbody.innerHTML = rows.join("");
  }

  function renderCustomerTodayTodo(records) {
    const tbody = document.getElementById("customerTodayTodoTbody");
    const emptyEl = document.getElementById("customerTodayTodoEmpty");
    if (!tbody || !emptyEl) return;

    const allowed = new Set(["未回覆", "洽談中", "已報價"]);
    const statusOrder = { "已報價": 0, "洽談中": 1, "未回覆": 2 };
    const statusBadgeClass = (s) => {
      const v = String(s || "").trim();
      if (v === "已報價") return "badge warn";
      if (v === "洽談中") return "badge info";
      return "badge";
    };
    const fmt = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("zh-TW"));

    const list = (Array.isArray(records) ? records : [])
      .filter((r) => allowed.has(String(r.status || "").trim()))
      .slice()
      .sort((a, b) => {
        const ao = statusOrder[String(a.status || "").trim()] ?? 9;
        const bo = statusOrder[String(b.status || "").trim()] ?? 9;
        if (ao !== bo) return ao - bo;
        return String(b.date || "").localeCompare(String(a.date || ""));
      });

    if (list.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    tbody.innerHTML = list
      .map((r) => {
        return `<tr>
          <td>${crEsc(r.name)}</td>
          <td>${crEsc(r.source)}</td>
          <td>${crEsc(r.type)}</td>
          <td style="text-align:right">${crEsc(fmt(r.dealAmount))}</td>
          <td>${crEsc(r.use)}</td>
          <td class="muted small">${crEscNl(r.questions)}</td>
          <td><span class="${statusBadgeClass(r.status)}">${crEsc(r.status)}</span></td>
          <td style="text-align:right; white-space:nowrap">
            <button type="button" class="btn btn-ghost btn-sm btn-cr-create-order" data-id="${crEsc(r.id)}">建立訂單</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderCustomerRecordsPage() {
    const list = loadCustomerRecords();
    renderCustomerDashboard(list);
    renderCustomerTodayTodo(list);
    renderCustomerList(list);
  }

  function crShowMsg(text) {
    const el = document.getElementById("customerMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function addCustomerRecordFromForm() {
    const dateEl = document.getElementById("crDate");
    const nameEl = document.getElementById("crName");
    const sourceEl = document.getElementById("crSource");
    const typeEl = document.getElementById("crType");
    const budgetEl = document.getElementById("crBudget");
    const useEl = document.getElementById("crUse");
    const statusEl = document.getElementById("crStatus");
    const dealEl = document.getElementById("crDealAmount");
    const gpEl = document.getElementById("crGrossProfit");
    const qEl = document.getElementById("crQuestions");
    const lostEl = document.getElementById("crLostReason");
    const noteEl = document.getElementById("crNote");

    const rec = crNormalize({
      date: String(dateEl?.value || "").trim(),
      name: String(nameEl?.value || "").trim(),
      source: String(sourceEl?.value || "其他"),
      type: String(typeEl?.value || "其他"),
      budget: crSafeNum(budgetEl?.value),
      use: String(useEl?.value || "").trim(),
      status: String(statusEl?.value || "未回覆"),
      dealAmount: crSafeNum(dealEl?.value),
      grossProfit: crSafeNum(gpEl?.value),
      questions: String(qEl?.value || "").trim(),
      lostReason: String(lostEl?.value || "").trim(),
      note: String(noteEl?.value || "").trim(),
    });

    if (!rec.date) return crShowMsg("請選日期");
    if (!rec.name) return crShowMsg("請填客戶名稱 / 暱稱");

    const list = loadCustomerRecords();
    list.push(rec);
    saveCustomerRecords(list);
    crShowMsg("已新增");
    renderCustomerRecordsPage();
    // 新增成功後自動收合表單
    try {
      const formCard = document.getElementById("customerFormCard");
      if (formCard) formCard.hidden = true;
    } catch (_) {}

    // 清空部分欄位（保留來源/類型/狀態讓你連續輸入更快）
    if (nameEl) nameEl.value = "";
    if (budgetEl) budgetEl.value = "";
    if (useEl) useEl.value = "";
    if (dealEl) dealEl.value = "";
    if (gpEl) gpEl.value = "";
    if (qEl) qEl.value = "";
    if (lostEl) lostEl.value = "";
    if (noteEl) noteEl.value = "";
    setTimeout(() => crShowMsg(""), 2500);
  }

  function deleteCustomerRecordById(id) {
    const target = String(id || "");
    if (!target) return;
    const list = loadCustomerRecords();
    const next = list.filter((x) => String(x.id) !== target);
    saveCustomerRecords(next);
    renderCustomerRecordsPage();
  }

  function createOrderFromCustomerRecord(id) {
    const target = String(id || "");
    if (!target) return;
    const list = loadCustomerRecords();
    const rec = list.find((x) => String(x.id) === target);
    if (!rec) return;

    const parts = [];
    if (rec.use) parts.push("用途：" + rec.use);
    if (rec.questions) parts.push("客人問題：\n" + rec.questions);
    if (rec.note) parts.push("備註：\n" + rec.note);
    const note = parts.join("\n\n").trim();

    const payload = {
      customerId: String(rec.id || ""),
      name: String(rec.name || ""),
      amount: Number(rec.dealAmount) || 0,
      note: note,
    };

    try {
      sessionStorage.setItem(CREATE_ORDER_FROM_CUSTOMER_KEY, JSON.stringify(payload));
    } catch (_) {
      // 若 sessionStorage 寫入失敗，不做任何副作用
      return;
    }

    // 切到「庫存＋記帳」並開啟「訂單」子分頁與新增訂單 UI
    switchTab("inv");
    setTimeout(() => {
      try {
        const tabBtn = document.querySelector('.v2-tab[data-v2="orders"]');
        if (tabBtn) tabBtn.click();
      } catch (_) {}
      setTimeout(() => {
        try {
          const btn = document.getElementById("btnNewOrder");
          if (btn) btn.click();
        } catch (_) {}
      }, 0);
    }, 0);
  }

  (function initCustomerRecords() {
    const root = document.getElementById("customer-section");
    if (!root) return;
    const dateEl = document.getElementById("crDate");
    if (dateEl && !dateEl.value) dateEl.value = crNowISODate();
    const formCard = document.getElementById("customerFormCard");
    const toggleBtn = document.getElementById("customerFormToggleBtn");
    const cancelBtn = document.getElementById("crCancelBtn");
    function setFormOpen(open) {
      if (!formCard) return;
      formCard.hidden = !open;
      if (open) {
        try { formCard.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
      }
    }
    toggleBtn?.addEventListener("click", () => setFormOpen(formCard ? formCard.hidden : true));
    cancelBtn?.addEventListener("click", () => setFormOpen(false));
    document.getElementById("crAddBtn")?.addEventListener("click", addCustomerRecordFromForm);
    root.addEventListener("click", (e) => {
      const createBtn = e.target && e.target.closest ? e.target.closest(".btn-cr-create-order") : null;
      if (createBtn) {
        const id = createBtn.getAttribute("data-id") || "";
        createOrderFromCustomerRecord(id);
        return;
      }
      const delBtn = e.target && e.target.closest ? e.target.closest(".btn-cr-del") : null;
      if (!delBtn) return;
      const id = delBtn.getAttribute("data-id") || "";
      if (confirm("確定刪除此筆客戶紀錄？")) deleteCustomerRecordById(id);
    });
    // 初始化一次（避免空白頁）
    renderCustomerRecordsPage();
  })();

  function updateCatImage(cat, dataUrl) {
    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const catImages = { ...(fe.catImages || {}), [cat]: dataUrl || undefined };
    if (!dataUrl) delete catImages[cat];
    const next = { ...cfg, frontend: { ...fe, catImages } };
    window.DK?.saveConfig?.(next);
    loadFrontendForm();
  }

  function renderCatPreview(cat, dataUrl) {
    const id = "feCatPreview" + cat.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^([a-z])/, (_, c) => c.toUpperCase());
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = "";
    el.className = "cat-image-preview";
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
      el.appendChild(img);
    } else {
      el.textContent = "未設定";
      el.className = "cat-image-preview muted";
    }
  }

  ["office", "game-entry", "game-mid", "work", "peripherals"].forEach((cat) => {
    const input = document.getElementById("feCatFile" + cat.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^([a-z])/, (_, c) => c.toUpperCase()));
    const clearBtn = document.querySelector(".cat-image-clear[data-cat=\"" + cat + "\"]");
    input?.addEventListener("change", async (e) => {
      const file = e.target?.files?.[0];
      e.target.value = "";
      if (!file || !file.type.startsWith("image/")) return;
      try {
        const url = await fileToCompressedDataUrl(file, { maxW: 800, maxH: 1200, quality: 0.8 });
        updateCatImage(cat, url);
      } catch (err) {
        alert("圖片處理失敗：" + (err?.message || String(err)));
      }
    });
    clearBtn?.addEventListener("click", () => {
      updateCatImage(cat, null);
    });
  });

  // ---- 首頁第二區分類卡片：從 DOM 收集 homeEntries ----
  function collectHomeEntriesFromDom(listEl) {
    const container = listEl || document.getElementById("feHomeEntriesList");
    if (!container) return [];

    const rows = Array.from(container.querySelectorAll(".home-entry-row"));
    const out = [];

    rows.forEach((row) => {
      const id = row.dataset.entryId || "";
      const titleInput = row.querySelector(".entry-title");
      const subtitleInput = row.querySelector(".entry-subtitle");
      const linkInput = row.querySelector(".entry-link");
      const imageInput = row.querySelector(".entry-image-url");
      const themeInput = row.querySelector(".entry-theme");

      let title = (titleInput?.value || "").trim();
      const subtitle = (subtitleInput?.value || "").trim();
      const link = (linkInput?.value || "").trim();
      const image = (imageInput?.value || "").trim();
      const theme = (themeInput?.value || "").trim();

      if (!title && !subtitle && !link && !image) {
        title = "未命名分類";
      }

      out.push({ id, title, subtitle, link, image, theme });
    });

    return out;
  }

  function renderHomeEntriesAdmin(listEl, entries) {
    if (!listEl) return;

    const safe = Array.isArray(entries) ? entries : [];
    listEl.innerHTML = "";

    safe.forEach((entry, index) => {
      const id = entry?.id || ("home_" + Date.now() + "_" + Math.floor(Math.random() * 1000));
      if (entry && !entry.id) entry.id = id;
      const row = document.createElement("div");
      row.className = "home-entry-row home-entry-card";
      row.dataset.entryId = id;
      row.setAttribute("draggable", "true");

      const n = index + 1;
      row.innerHTML = `
        <div class="home-entry-card-head"><span class="home-entry-drag-hint" title="拖曳排序">⋮⋮</span> 第 ${n} 張</div>
        <input class="entry-title" type="text" placeholder="標題" />
        <input class="entry-subtitle" type="text" placeholder="說明" />
        <input class="entry-link" type="url" placeholder="連結（例如 ./machine.html）" />
        <select class="entry-theme">
          <option value="">預設</option>
          <option value="dark">深色</option>
          <option value="light">淺色</option>
          <option value="blue">藍色</option>
        </select>
        <div class="entry-image-preview-wrap">
          <div class="entry-image-preview">尚未設定圖片</div>
        </div>
        <input class="entry-image-url" type="url" placeholder="圖片網址" />
        <label class="btn btn-ghost btn-sm" style="margin:0">上傳圖片 <input type="file" class="entry-image-file" accept="image/*" style="display:none" /></label>
        <button type="button" class="entry-delete-btn btn btn-ghost btn-sm">刪除</button>
      `;

      const t = row.querySelector(".entry-title");
      const s = row.querySelector(".entry-subtitle");
      const l = row.querySelector(".entry-link");
      const img = row.querySelector(".entry-image-url");
      const theme = row.querySelector(".entry-theme");
      const preview = row.querySelector(".entry-image-preview");

      if (t) t.value = entry?.title || "";
      if (s) s.value = entry?.subtitle || "";
      if (l) l.value = entry?.link || "";
      if (img) img.value = entry?.image || "";
      if (theme) theme.value = entry?.theme || "";

      if (preview && entry?.image) {
        preview.innerHTML = "";
        const imgEl = document.createElement("img");
        imgEl.src = entry.image;
        imgEl.alt = "";
        imgEl.onerror = function () {
          preview.innerHTML = "";
          const msg = document.createElement("span");
          msg.textContent = "預覽失敗";
          msg.className = "muted small";
          preview.appendChild(msg);
        };
        preview.appendChild(imgEl);
      } else if (preview && !preview.querySelector("img")) {
        preview.textContent = "尚未設定圖片";
      }

      listEl.appendChild(row);
    });
  }

  // 首頁第二區分類卡片：拖曳排序（原生 drag & drop，交換 DOM 順序）
  if (!window.__dkHomeEntriesDnDBound) {
    window.__dkHomeEntriesDnDBound = true;
    let __draggingHomeEntryRow = null;

    document.addEventListener("dragstart", function (e) {
      const row = e.target && e.target.closest ? e.target.closest(".home-entry-row") : null;
      if (!row) return;
      __draggingHomeEntryRow = row;
      try {
        e.dataTransfer.effectAllowed = "move";
        // 某些瀏覽器需要 setData 才會觸發 drop
        e.dataTransfer.setData("text/plain", "home-entry-row");
      } catch (_) {}
    });

    document.addEventListener("dragover", function (e) {
      const row = e.target && e.target.closest ? e.target.closest(".home-entry-row") : null;
      if (!row) return;
      if (!__draggingHomeEntryRow) return;
      // 允許 drop
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = "move";
      } catch (_) {}
    });

    document.addEventListener("drop", function (e) {
      const targetRow = e.target && e.target.closest ? e.target.closest(".home-entry-row") : null;
      if (!targetRow) return;
      if (!__draggingHomeEntryRow) return;
      e.preventDefault();

      const from = __draggingHomeEntryRow;
      const to = targetRow;
      if (from === to) return;
      const parent = from.parentElement;
      if (!parent || parent !== to.parentElement) return;

      // 交換 DOM 順序（swap）
      const fromNext = from.nextSibling;
      const toNext = to.nextSibling;

      parent.insertBefore(from, toNext);
      parent.insertBefore(to, fromNext);

      __draggingHomeEntryRow = null;
    });

    document.addEventListener("dragend", function () {
      __draggingHomeEntryRow = null;
    });
  }

  // `.entry-delete-btn` 刪除：事件委派（避免動態 row 沒綁到）
  if (!window.__dkHomeEntriesDeleteDelegated) {
    window.__dkHomeEntriesDeleteDelegated = true;
    document.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest ? e.target.closest(".entry-delete-btn") : null;
      if (!btn) return;
      const row = btn.closest ? btn.closest(".home-entry-row") : null;
      if (row) row.remove();
    });
  }

  // 首頁第二區分類卡片圖片：圖片上傳 → Supabase Storage（site-assets/home/）→ 回寫 image URL
  (function initHomeEntryImageUploads() {
    if (window.__dkHomeEntryImageUploadBound) return;
    window.__dkHomeEntryImageUploadBound = true;
    if (!window.DK?.uploadSiteAssetToSupabaseStorage) return;

    document.addEventListener("change", async function (e) {
      const target = e.target;
      if (!target || !(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains("entry-image-file")) return;
      if (target.type !== "file") return;

      const fileInput = target;
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file || !file.type || !file.type.startsWith("image/")) return;

      let row = fileInput.closest(".home-entry-row");
      if (!row) {
        row = fileInput.closest(".home-entry") || fileInput.closest("tr") || fileInput.parentElement;
      }
      if (!row) return;

      const urlInput = row.querySelector(".entry-image-url");
      const preview = row.querySelector(".entry-image-preview");

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "-");
      const rand = Math.random().toString(16).slice(2);
      const path = `home/${ts}-${rand}.webp`;

      try {
        const url = await window.DK.uploadSiteAssetToSupabaseStorage(file, path, {
          compress: true,
          maxWidth: 1200,
          mimeType: "image/webp",
          quality: 0.82,
        });
        if (!url) {
          alert("分類圖片上傳失敗，請稍後再試。");
          return;
        }

        if (urlInput) {
          urlInput.value = url;
          urlInput.dispatchEvent(new Event("input", { bubbles: true }));
          urlInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("[homeEntries] image uploaded");
        }

        if (preview) {
          preview.innerHTML = "";
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          img.style.cssText =
            "max-width:140px;max-height:80px;object-fit:contain;border-radius:8px;background:#f9fafb;";
          img.onerror = () => {
            preview.innerHTML = "";
            const msg = document.createElement("div");
            msg.textContent = "預覽失敗";
            msg.className = "muted small";
            preview.appendChild(msg);
          };
          preview.appendChild(img);
        }
      } catch (err) {
        console.warn("上傳分類圖片發生錯誤", err);
        alert("分類圖片上傳失敗，請稍後再試。");
      }
    });
  })();

  // 首頁第二區分類卡片：刪除按鈕（動態 row 也支援）
  document.addEventListener("click", function (e) {
    const btn = e.target.closest ? e.target.closest(".entry-delete-btn") : null;
    if (!btn) return;
    const row = btn.closest(".home-entry-row");
    if (row) row.remove();
  });

  // 首頁第二區分類卡片：委派綁定新增按鈕（確保晚載入 DOM 也可運作）
  document.addEventListener("click", function (e) {
    const addBtn = e.target.closest ? e.target.closest("#addHomeEntryBtn") : null;
    if (!addBtn) return;

    e.preventDefault();
    e.stopPropagation();

    const listEl = document.getElementById("feHomeEntriesList");
    console.log("[homeEntries] delegated add click", { listEl, addBtn });

    if (!listEl) {
      console.error("[homeEntries] #feHomeEntriesList not found");
      return;
    }

    let current = [];
    try {
      current =
        typeof collectHomeEntriesFromDom === "function"
          ? collectHomeEntriesFromDom(listEl)
          : [];
    } catch (err) {
      console.error("[homeEntries] collectHomeEntriesFromDom failed:", err);
      current = [];
    }

    current.push({
      title: "",
      subtitle: "",
      image: "",
      link: "",
    });

    try {
      renderHomeEntriesAdmin(listEl, current);
      console.log("[homeEntries] row added", current);
    } catch (err) {
      console.error("[homeEntries] renderHomeEntriesAdmin failed:", err);
    }
  });

  // 首頁第二區分類卡片：初始化新增按鈕（DOM ready 後執行）
  document.addEventListener("DOMContentLoaded", function () {
    try {
      initHomeEntriesAdmin();
    } catch (err) {
      console.error("[homeEntries] init failed:", err);
    }
  });

  // 前台管理：可折疊區塊（只動 UI，不影響資料讀寫/上傳/排序）
  // 用事件委派避免 DOM 時機問題
  document.addEventListener("click", function (e) {
    const expandAllBtn = e.target?.closest ? e.target.closest("#frontendExpandAllBtn") : null;
    const collapseAllBtn = e.target?.closest ? e.target.closest("#frontendCollapseAllBtn") : null;
    if (expandAllBtn || collapseAllBtn) {
      e.preventDefault();

      const root = document.getElementById("tab-frontend");
      if (!root) return;
      const items = root.querySelectorAll(".admin-collapsible");
      const nextOpen = !!expandAllBtn;
      items.forEach((wrap) => {
        wrap.classList.toggle("is-open", nextOpen);
        const btn = wrap.querySelector(".admin-collapsible-toggle");
        if (btn) btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      });
      return;
    }

    const btn = e.target?.closest ? e.target.closest(".admin-collapsible-toggle") : null;
    if (!btn) return;
    const wrap = btn.closest ? btn.closest(".admin-collapsible") : null;
    if (!wrap) return;
    e.preventDefault();

    const nextOpen = !wrap.classList.contains("is-open");
    wrap.classList.toggle("is-open", nextOpen);
    btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  });

  function initHomeEntriesAdmin() {
    console.log("[homeEntries] init start");

    const listEl = document.getElementById("feHomeEntriesList");
    const addBtn = document.getElementById("addHomeEntryBtn");

    console.log("[homeEntries] listEl =", listEl);
    console.log("[homeEntries] addBtn =", addBtn);

    if (!listEl || !addBtn) {
      console.error("home entries DOM missing");
    }
  }

  // 首頁 Banner 管理：render / add / remove / move
  function renderHomeBanners(listEl, banners) {
    listEl.innerHTML = "";
    const safeList = Array.isArray(banners) ? banners : [];
    safeList.forEach((b, index) => {
      const row = document.createElement("div");
      row.className = "banner-row";
      row.dataset.index = String(index);

      row.innerHTML = `
        <div class="banner-preview-wrap">
          <div class="banner-preview muted small">預覽</div>
        </div>
        <div class="banner-fields">
          <input type="url" class="banner-image" placeholder="圖片網址（必填）" />
          <input type="url" class="banner-link" placeholder="點擊連結（選填）" />
          <label class="banner-focus-label">圖片焦點 X（左右，0=左，50=中，100=右）</label>
          <input type="number" class="banner-focus-x" placeholder="0–100" min="0" max="100" step="1" />
          <label class="banner-focus-label">圖片焦點 Y（上下，0=上，50=中，100=下）</label>
          <input type="number" class="banner-focus-y" placeholder="0–100" min="0" max="100" step="1" />
          <input type="file" class="banner-file" accept="image/*" />
        </div>
        <div class="banner-actions">
          <button type="button" class="btn btn-ghost btn-sm banner-move-up">↑</button>
          <button type="button" class="btn btn-ghost btn-sm banner-move-down">↓</button>
          <button type="button" class="btn btn-ghost btn-sm banner-remove">刪除</button>
        </div>
      `;

      const imgInput = row.querySelector(".banner-image");
      const linkInput = row.querySelector(".banner-link");
      const fxInput = row.querySelector(".banner-focus-x");
      const fyInput = row.querySelector(".banner-focus-y");
      const fileInput = row.querySelector(".banner-file");
      const previewWrap = row.querySelector(".banner-preview");

      if (imgInput) imgInput.value = (b && b.image) ? b.image : "";
      if (linkInput) linkInput.value = (b && b.link) ? b.link : "";
      if (fxInput) fxInput.value = (b && Number.isFinite(Number(b.focusX))) ? String(Number(b.focusX)) : "50";
      if (fyInput) fyInput.value = (b && Number.isFinite(Number(b.focusY))) ? String(Number(b.focusY)) : "50";

      function updatePreview() {
        if (!previewWrap) return;
        const url = (imgInput?.value || "").trim();
        previewWrap.innerHTML = "";
        previewWrap.className = "banner-preview muted small";
        if (!url) {
          previewWrap.textContent = "尚未設定圖片";
          return;
        }
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.style.cssText = "max-width:160px;max-height:80px;border-radius:8px;object-fit:cover;border:1px solid rgba(0,0,0,0.12);background:#f8f8f8;";
        img.onload = () => {
          // 正常載入時維持圖片
        };
        img.onerror = () => {
          previewWrap.innerHTML = "";
          previewWrap.textContent = "預覽失敗";
          previewWrap.className = "banner-preview muted small";
        };
        previewWrap.appendChild(img);
      }

      imgInput?.addEventListener("input", updatePreview);
      updatePreview();

      // 檔案上傳 → 存到 Supabase Storage（site-assets/banner/…）→ 回寫 image 欄位
      fileInput?.addEventListener("change", async (e) => {
        const input = e.target;
        const file = input?.files?.[0];
        input.value = "";
        if (!file || !file.type.startsWith("image/")) return;
        if (!window.DK?.uploadSiteAssetToSupabaseStorage) {
          alert("環境尚未提供 Banner 圖片上傳功能（uploadSiteAssetToSupabaseStorage）。");
          return;
        }
        // 依檔名或 MIME type 推斷副檔名，避免一律變成 .jpg
        let ext = "";
        const name = typeof file.name === "string" ? file.name : "";
        const m = name.match(/\.([a-zA-Z0-9]+)$/);
        if (m && m[1]) {
          ext = "." + m[1].toLowerCase();
        } else if (file.type && typeof file.type === "string") {
          if (file.type === "image/png") ext = ".png";
          else if (file.type === "image/webp") ext = ".webp";
          else if (file.type === "image/jpeg") ext = ".jpg";
          else ext = ".jpg";
        } else {
          ext = ".jpg";
        }
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, "-");
        const rand = Math.random().toString(16).slice(2);
        const path = `banner/${ts}-${rand}${ext}`;
        const url = await window.DK.uploadSiteAssetToSupabaseStorage(file, path);
        if (!url) {
          alert("Banner 圖片上傳失敗，請稍後再試。");
          return;
        }
        if (imgInput) {
          imgInput.value = url;
          imgInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });

      // move / remove 事件會重新讀取 DOM 順序並重建列表
      row.querySelector(".banner-remove")?.addEventListener("click", () => {
        const next = safeList.slice(0, index).concat(safeList.slice(index + 1));
        renderHomeBanners(listEl, next);
      });

      row.querySelector(".banner-move-up")?.addEventListener("click", () => {
        if (index === 0) return;
        const next = safeList.slice();
        const tmp = next[index - 1];
        next[index - 1] = next[index];
        next[index] = tmp;
        renderHomeBanners(listEl, next);
      });

      row.querySelector(".banner-move-down")?.addEventListener("click", () => {
        if (index >= safeList.length - 1) return;
        const next = safeList.slice();
        const tmp = next[index + 1];
        next[index + 1] = next[index];
        next[index] = tmp;
        renderHomeBanners(listEl, next);
      });

      listEl.appendChild(row);
    });

    if (!safeList.length) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "目前沒有設定任何 Banner，將使用預設首頁 Banner。";
      listEl.appendChild(empty);
    }
  }

  (function initHomeBannerAddBtn() {
    const addBtn = document.getElementById("feHomeBannerAddBtn");
    const listEl = document.getElementById("feHomeBannersList");
    if (!addBtn || !listEl) return;
    addBtn.addEventListener("click", () => {
      const cfg = window.DK?.getConfig?.() || {};
      const fe = cfg.frontend || {};
      const banners = Array.isArray(fe.homeBanners) ? fe.homeBanners.slice() : [];
      banners.push({ image: "", link: "" });
      renderHomeBanners(listEl, banners);
    });
  })();

  // ---------- 庫存+記帳 v2 子分頁：事件委派在 #panel 上，點擊一定有反應 ----------
  (function () {
    const v2Panels = ["items", "ledger", "orders", "expenses", "reports"];
    function switchV2TabUIOnly(name) {
      document.querySelectorAll(".v2-tab").forEach((t) => t.classList.toggle("active", (t.getAttribute("data-v2") || "") === name));
      v2Panels.forEach((p) => {
        const el = document.getElementById("v2-" + p);
        if (el) el.hidden = p !== name;
      });
    }
    window.__adminV2TabSwitch = function (fn) {
      window.__adminV2Handler = fn || switchV2TabUIOnly;
    };
    window.__adminV2Handler = switchV2TabUIOnly;
    panel.addEventListener("click", function (e) {
      const t = e.target.closest(".v2-tab");
      if (!t) return;
      const name = (t.getAttribute("data-v2") || "items");
      (window.__adminV2Handler || switchV2TabUIOnly)(name);
    });
  })();

  // ---------- 庫存+記帳 v2 (DK)：渲染與表單（延後初始化，確保 GitHub/部署環境下 DK 已載入）----------
  function runV2DKBlock() {
    if (window.__adminV2DKInitialized) return true;
    if (typeof window.DK === "undefined") return false;
    const DK = window.DK;
    if (typeof DK.getOrders !== "function" || typeof DK.reportSummaryByDateRange !== "function") return false;
    const todayStr = () => DK.todayStr();
    const nowISO = () => DK.nowISO();

    function v2Esc(s) {
      if (s == null || s === undefined) return "";
      const t = String(s);
      const div = document.createElement("div");
      div.textContent = t;
      return div.innerHTML;
    }
    function v2FmtNum(n) {
      if (n == null || !Number.isFinite(n)) return "-";
      return Number(n).toLocaleString("zh-TW");
    }
    function v2Show(el, msg) {
      if (!el) return;
      el.textContent = msg || "";
      el.hidden = !msg;
    }
    function v2Hide(el) {
      if (el) el.hidden = true;
    }

    const v2Tabs = document.querySelectorAll(".v2-tab");
    const v2Panels = ["items", "ledger", "orders", "expenses", "reports"];
    function switchV2Tab(name) {
      v2Tabs.forEach((t) => t.classList.toggle("active", (t.getAttribute("data-v2") || "") === name));
      v2Panels.forEach((p) => {
        const el = document.getElementById("v2-" + p);
        if (el) el.hidden = p !== name;
      });
      if (name === "items") renderV2Items();
      if (name === "ledger") renderV2Ledger();
      if (name === "orders") renderV2Orders();
      if (name === "expenses") renderV2Expenses();
      if (name === "reports") renderV2Reports();
    }
    if (typeof window.__adminV2TabSwitch === "function") window.__adminV2TabSwitch(switchV2Tab);

    const itemsTbody = document.getElementById("itemsTbody");
    const itemsSearch = document.getElementById("itemsSearch");
    const itemsCategory = document.getElementById("itemsCategory");
    const itemsCategoryQuick = document.getElementById("itemsCategoryQuick");
    const itemsStatus = document.getElementById("itemsStatus");
    const itemEditorModal = document.getElementById("itemEditorModal");
    const itemEditor = document.getElementById("itemEditor");
    const itemMsg = document.getElementById("itemMsg");
    let editingV2ItemId = null;
    /** 庫存品項表排序：key 為欄位名，dir 為 1 升序、-1 降序 */
    let v2ItemsSortKey = null;
    let v2ItemsSortDir = 1;
    let itemsStatusTouchedByUser = false;
    const HIDE_ZERO_STOCK_KEY = "dk_items_hide_zero_stock";
    let hideZeroStock = true;
    try {
      const savedHideZero = localStorage.getItem(HIDE_ZERO_STOCK_KEY);
      if (savedHideZero === "1") hideZeroStock = true;
      if (savedHideZero === "0") hideZeroStock = false;
    } catch (_) {}
    const V2_PAGE_SIZE = 15;
    let itemsPage = 1;
    let ledgerPage = 1;
    let ordersPage = 1;
    let expensesPage = 1;
    const STATUS_LABEL = { READY: "可售", TESTING: "待測", PREP: "待整理", RESERVED: "保留", CLEARANCE: "待出清", SCRAP: "報廢拆料" };
    const CONDITION_LABEL = { NEW: "全新", USED: "二手", REFURB: "整新" };
    const LEDGER_TYPE_LABEL = { IN: "入庫", OUT: "出庫", ADJUST: "調整" };
    const REF_TYPE_LABEL = { PURCHASE: "進貨", ORDER: "訂單", RMA: "退換", SCRAP: "報廢", MOVE: "移倉", ADJUST: "調整" };
    const ORDER_STATUS_LABEL = { pending: "待處理", paid: "已付款", shipped: "已出貨", completed: "已完成", refunded: "已退貨" };
    const ORDER_PAYMENT_LABEL = { cash: "現金", transfer: "轉帳", card: "刷卡" };
    const EXPENSE_TYPE_LABEL = { COGS: "銷貨成本", OPEX: "營業費用", OTHER: "其他" };

    function paginateV2(list, page, pageSize) {
      const size = pageSize || V2_PAGE_SIZE;
      const total = list.length;
      const totalPages = total === 0 ? 1 : Math.ceil(total / size);
      let p = page || 1;
      if (p < 1) p = 1;
      if (p > totalPages) p = totalPages;
      const start = (p - 1) * size;
      const end = start + size;
      return {
        pageItems: list.slice(start, end),
        page: p,
        totalPages,
        total,
      };
    }

    function fillV2CategoryOptions() {
      const cats = DK.getInventoryCategories ? DK.getInventoryCategories() : ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼", "螢幕", "鍵盤", "滑鼠", "耳機", "周邊", "其他"];
      if (itemsCategory) {
        itemsCategory.innerHTML = "<option value=\"\">全部品類</option>" + cats.map((c) => "<option value=\"" + v2Esc(c) + "\">" + v2Esc(c) + "</option>").join("");
      }
      const itemCategorySelect = document.getElementById("itemCategory");
      if (itemCategorySelect) itemCategorySelect.innerHTML = cats.map((c) => "<option value=\"" + v2Esc(c) + "\">" + v2Esc(c) + "</option>").join("");
      if (itemsCategoryQuick) {
        itemsCategoryQuick.innerHTML = "<button type=\"button\" class=\"btn btn-ghost btn-sm seg seg-cat active\" data-cat=\"\">全部</button>" + cats.map((c) => "<button type=\"button\" class=\"btn btn-ghost btn-sm seg seg-cat\" data-cat=\"" + v2Esc(c) + "\">" + v2Esc(c) + "</button>").join("");
        itemsCategoryQuick.querySelectorAll(".seg-cat").forEach((btn) => {
          btn.addEventListener("click", () => {
            const cat = btn.getAttribute("data-cat") || "";
            if (itemsCategory) itemsCategory.value = cat;
            itemsCategoryQuick.querySelectorAll(".seg-cat").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            renderV2Items();
          });
        });
      }
    }

    /** 取得目前篩選後的庫存品項列表（與畫面一致） */
    function getV2ItemsFilteredList() {
      let list = DK.getEnrichedItems();
      const q = (itemsSearch?.value || "").trim().toLowerCase();
      const cat = itemsCategory?.value || "";
      const st = itemsStatus?.value || "";
      if (q) list = list.filter((x) => [x.sku, x.name, x.spec].some((f) => String(f || "").toLowerCase().includes(q)));
      if (cat) list = list.filter((x) => x.category === cat);
      if (st) list = list.filter((x) => x.status === st);
      return list;
    }

    /** 依目前排序設定回傳篩選並排序後的列表 */
    function getV2ItemsSortedList() {
      let list = getV2ItemsFilteredList();
      if (!v2ItemsSortKey || !list.length) return list;
      const key = v2ItemsSortKey;
      const dir = v2ItemsSortDir;
      const numKeys = ["qty_on_hand", "cost_unit", "price_list", "price_floor", "age_days", "idle_days", "inventory_value"];
      const isNum = numKeys.includes(key);
      const isDate = key === "inbound_date";
      return list.slice().sort((a, b) => {
        let va = a[key];
        let vb = b[key];
        if (isNum) {
          va = va != null && va !== "" ? Number(va) : -Infinity;
          vb = vb != null && vb !== "" ? Number(vb) : -Infinity;
          return dir * (va - vb);
        }
        if (isDate) {
          va = (va || "").toString().slice(0, 10);
          vb = (vb || "").toString().slice(0, 10);
          return dir * (va.localeCompare(vb));
        }
        va = (va != null ? String(va) : "").toLowerCase();
        vb = (vb != null ? String(vb) : "").toLowerCase();
        return dir * va.localeCompare(vb, "zh-TW");
      });
    }

    function updateV2ItemsSortHeaders() {
      const table = itemsTbody?.closest("table");
      if (!table) return;
      table.querySelectorAll("thead th[data-sort]").forEach((th) => {
        th.classList.remove("sort-asc", "sort-desc");
        if (th.getAttribute("data-sort") === v2ItemsSortKey) th.classList.add(v2ItemsSortDir === 1 ? "sort-asc" : "sort-desc");
      });
    }

    (function bindV2ItemsSortClicks() {
      const table = itemsTbody?.closest("table");
      if (!table) return;
      table.querySelectorAll("thead th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
          const key = th.getAttribute("data-sort");
          if (!key) return;
          if (v2ItemsSortKey === key) v2ItemsSortDir *= -1; else { v2ItemsSortKey = key; v2ItemsSortDir = 1; }
          renderV2Items();
        });
      });
    })();

    function renderV2Items() {
      if (!itemsTbody) return;
      let list = getV2ItemsSortedList();
      // ===== 預設只顯示「可售 + 有庫存」=====
      // 這裡實際狀態值使用 READY（顯示文字才是「可售」）
      const statusFilterEl = itemsStatus || document.getElementById("v2StatusFilter");
      const isDefaultAll = !statusFilterEl || statusFilterEl.value === "全部" || statusFilterEl.value === "";
      // 只有在「尚未手動選擇狀態篩選」時才套用預設
      if (!itemsStatusTouchedByUser && isDefaultAll) {
        list = list.filter((it) => {
          const qty = Number(it.qty_on_hand || 0);
          return it.status === "READY" && qty > 0;
        });
      }
      // ===== 隱藏 0 庫存 =====
      if (hideZeroStock) {
        list = list.filter((it) => {
          const qty = Number(it.qty_on_hand || 0);
          return qty > 0;
        });
      }
      // ===== END =====
      // ===== END =====
      const pageInfo = paginateV2(list, itemsPage, V2_PAGE_SIZE);
      itemsPage = pageInfo.page;
      itemsTbody.innerHTML = pageInfo.pageItems.map((x) => {
        const alert = DK.getItemAlert(x);
        const alertText = alert ? alert.message : "-";
        const rowClass = (x.qty_on_hand ?? 0) === 0 ? " qty-zero-row" : "";
        const nameSpec = (x.name === x.spec || !String(x.spec || "").trim()) ? (x.name || x.spec || "") : [x.name, x.spec].filter(Boolean).join(" ").trim();
        return `<tr class="${rowClass}">
          <td><input type="checkbox" class="item-row-cb" data-id="${v2Esc(x.id)}" /></td>
          <td>${v2Esc(nameSpec)}</td>
          <td>${v2Esc(x.category || "")}</td>
          <td>${v2Esc(STATUS_LABEL[x.status] || x.status)}</td>
          <td>${x.qty_on_hand}</td>
          <td>${v2FmtNum(x.cost_unit)}</td>
          <td>${v2FmtNum(x.price_list)}</td>
          <td>${v2FmtNum(x.price_floor)}</td>
          <td>${v2Esc((x.inbound_date || "").toString().slice(0, 10))}</td>
          <td>${x.age_days != null ? x.age_days : "-"}</td>
          <td>${x.idle_days != null ? x.idle_days : "-"}</td>
          <td>${v2FmtNum(x.inventory_value)}</td>
          <td class="muted small">${v2Esc(alertText)}</td>
          <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-item" data-id="${v2Esc(x.id)}">編輯</button></td>
        </tr>`;
      }).join("");
      itemsTbody.querySelectorAll(".btn-edit-item").forEach((btn) => {
        btn.addEventListener("click", () => openV2ItemEditor(btn.getAttribute("data-id")));
      });
      const selectAllEl = document.getElementById("itemsSelectAll");
      if (selectAllEl) {
        selectAllEl.checked = false;
        selectAllEl.indeterminate = false;
      }
      const catVal = itemsCategory?.value || "";
      itemsCategoryQuick?.querySelectorAll(".seg-cat").forEach((b) => b.classList.toggle("active", (b.getAttribute("data-cat") || "") === catVal));
      updateV2ItemsSortHeaders();

      const pager = document.getElementById("itemsPagination");
      if (pager) {
        const cur = pageInfo.page;
        const totalPages = pageInfo.totalPages;
        const total = pageInfo.total;
        let html = `<span class="pagination-info">共 ${total} 筆，第 ${cur} / ${totalPages} 頁</span>`;
        if (totalPages > 1) {
          html += `<span class="pagination-btns"><button type="button" class="btn btn-ghost btn-sm page-btn prev" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>上一頁</button>`;
          for (let p = 1; p <= totalPages; p++) {
            const active = p === cur ? " current" : "";
            html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-page="${p}">${p}</button>`;
          }
          html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-page="${cur + 1}" ${cur >= totalPages ? "disabled" : ""}>下一頁</button></span>`;
        }
        pager.innerHTML = html;
      }
    }

    function generateUniqueSKU() {
      let base = "ITEM-" + Date.now().toString(36).toUpperCase();
      let sku = base;
      let n = 0;
      while (DK.findItemBySku(sku)) sku = base + "-" + (++n);
      return sku;
    }

    function openV2ItemEditor(id) {
      editingV2ItemId = id || null;
      const item = id ? DK.findItemById(id) : null;
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
      set("itemCategory", item ? item.category : (DK.getInventoryCategories && DK.getInventoryCategories()[0]) || "處理器");
      const nameSpec = item ? ((item.name === item.spec || !String(item.spec || "").trim()) ? (item.name || item.spec || "") : [item.name, item.spec].filter(Boolean).join(" ").trim()) : "";
      set("itemName", nameSpec);
      renderVendorSelect(item ? (item.vendor ?? "") : "");
      set("itemCondition", item ? item.condition : "USED");
      set("itemStatus", item ? item.status : "READY");
      set("itemQty", item ? item.qty_on_hand : 0);
      set("itemCost", item ? item.cost_unit : 0);
      set("itemPriceList", item ? item.price_list ?? "" : "");
      set("itemPriceFloor", item ? item.price_floor ?? "" : "");
      set("itemInboundDate", item && item.inbound_date ? item.inbound_date.slice(0, 10) : todayStr());
      set("itemReorderPoint", item ? (item.reorder_point ?? 0) : 0);
      set("itemNotes", item ? item.notes ?? "" : "");
      const itemDeleteBtn = document.getElementById("itemDelete");
      if (itemDeleteBtn) itemDeleteBtn.hidden = !item;
      if (itemEditorModal) itemEditorModal.hidden = false;
      v2Hide(itemMsg);
      // 開啟編輯器時同步更新重複品項提醒（不阻止儲存）
      try { updateItemDuplicateHint(); } catch (_) {}
    }
    // 供其他區塊（例如廠商報價）呼叫：建立庫存時開啟品項編輯器
    window.__openV2ItemEditor = openV2ItemEditor;

    function closeV2ItemEditor() {
      if (itemEditorModal) itemEditorModal.hidden = true;
      editingV2ItemId = null;
      v2Hide(itemMsg);
    }

    /** 匯出目前篩選的庫存品項為 CSV（與畫面排序一致，Excel 可開啟，UTF-8 BOM） */
    function exportV2ItemsToExcel() {
      const list = getV2ItemsSortedList();
      const escapeCsv = (v) => {
        const s = v == null ? "" : String(v);
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };
      const headers = ["編號", "名稱／規格", "品類", "狀態", "數量", "成本", "建議價", "最低價", "入庫日", "庫齡(天)", "滯留(天)", "庫存價值", "提醒"];
      const rows = list.map((x) => {
        const alert = DK.getItemAlert(x);
        const alertText = alert ? alert.message : "";
        const nameSpec = (x.name === x.spec || !String(x.spec || "").trim()) ? (x.name || x.spec || "") : [x.name, x.spec].filter(Boolean).join(" ").trim();
        return [
          x.sku ?? "",
          nameSpec || "",
          x.category ?? "",
          STATUS_LABEL[x.status] || x.status || "",
          x.qty_on_hand ?? "",
          x.cost_unit != null ? x.cost_unit : "",
          x.price_list != null ? x.price_list : "",
          x.price_floor != null ? x.price_floor : "",
          (x.inbound_date || "").toString().slice(0, 10),
          x.age_days != null ? x.age_days : "",
          x.idle_days != null ? x.idle_days : "",
          x.inventory_value != null ? x.inventory_value : "",
          alertText,
        ].map(escapeCsv);
      });
      const csv = "\uFEFF" + [headers.map(escapeCsv).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "庫存品項_" + (DK.todayStr ? DK.todayStr() : new Date().toISOString().slice(0, 10)) + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
      showCenterToast("已匯出 " + list.length + " 筆，請用 Excel 開啟 CSV 檔");
    }

    document.getElementById("btnNewItem")?.addEventListener("click", () => openV2ItemEditor(null));
    document.getElementById("btnExportItemsExcel")?.addEventListener("click", exportV2ItemsToExcel);
    (function initZeroStockToggle() {
      const actions = document.getElementById("btnNewItem")?.closest(".section-actions");
      if (!actions || document.getElementById("toggleZeroStock")) return;
      const label = document.createElement("label");
      label.style.marginLeft = "12px";
      label.style.fontSize = "14px";
      label.innerHTML = '<input type="checkbox" id="toggleZeroStock" checked> 隱藏 0 庫存';
      actions.appendChild(label);
      const toggleZeroStock = document.getElementById("toggleZeroStock");
      if (toggleZeroStock) {
        toggleZeroStock.checked = hideZeroStock;
        toggleZeroStock.addEventListener("change", function () {
          hideZeroStock = this.checked;
          try {
            localStorage.setItem(HIDE_ZERO_STOCK_KEY, hideZeroStock ? "1" : "0");
          } catch (_) {}
          itemsPage = 1;
          renderV2Items();
        });
      }
    })();
    document.getElementById("itemCancel")?.addEventListener("click", closeV2ItemEditor);
    /* 不再點空白關閉：僅能按「取消」或「關閉」按鈕關閉，避免誤觸流失資料 */
    document.getElementById("itemDelete")?.addEventListener("click", () => {
      if (!editingV2ItemId) return;
      if (!confirm("確定要刪除此品項？刪除後無法復原。")) return;
      const items = DK.getItems().filter((x) => x.id !== editingV2ItemId);
      DK.saveItems(items);
      v2Show(itemMsg, "已刪除");
      renderV2Items();
      setTimeout(closeV2ItemEditor, 500);
    });

    function setItemScanStatus(text) {
      const el = document.getElementById("itemScanStatus");
      if (el) el.textContent = text;
    }
    // 條碼上網查詢（UPCItemDB 免費 API，約 100 次/日）；經 CORS 代理以支援 file:// 開啟
    function lookupBarcodeOnline(barcode) {
      const upc = String(barcode).replace(/\D/g, "").slice(0, 14);
      if (upc.length < 12) return Promise.resolve(null);
      const apiUrl = "https://api.upcitemdb.com/prod/trial/lookup?upc=" + encodeURIComponent(upc);
      const url = "https://corsproxy.io/?" + encodeURIComponent(apiUrl);
      return fetch(url)
        .then((res) => res.json())
        .then((data) => {
          if (data.code !== "OK" || !data.items || data.items.length === 0) return null;
          const it = data.items[0];
          const brand = (it.brand || "").trim();
          const title = (it.title || it.description || "").trim();
          const capMatch = title.match(/(\d+)\s*GB|\b(\d+)\s*TB\b|(\d+)\s*G\b/i) || title.match(/(\d+)\s*MB\b/i);
          let spec = (it.size || "").trim();
          if (capMatch) {
            if (capMatch[1]) spec = (spec ? spec + " " : "") + capMatch[1] + "GB";
            else if (capMatch[2]) spec = (spec ? spec + " " : "") + capMatch[2] + "TB";
            else if (capMatch[3]) spec = (spec ? spec + " " : "") + capMatch[3] + "GB";
            else if (capMatch[4]) spec = (spec ? spec + " " : "") + capMatch[4] + "MB";
          }
          const brandZh = /TEAMGROUP|TEAM\s*GROUP/i.test(brand) ? "十銓" : /Kingston/i.test(brand) ? "金士頓" : /Samsung/i.test(brand) ? "三星" : /WD|Western/i.test(brand) ? "WD" : /Crucial|Micron/i.test(brand) ? "美光" : /SanDisk/i.test(brand) ? "SanDisk" : /Intel/i.test(brand) ? "Intel" : /ADATA/i.test(brand) ? "ADATA" : /Gigabyte/i.test(brand) ? "技嘉" : /MSI/i.test(brand) ? "微星" : /ASUS/i.test(brand) ? "華碩" : brand;
          let name = title;
          const capStr = (spec || "").match(/\d+\s*[GT]B|\d+\s*[GM]B/i);
          if (capStr && /VULCAN|A400|870\s*EVO|980\s*PRO|SN770|MX500|Barracuda/i.test(title)) {
            const seriesMatch = title.match(/(VULCAN\s*Z|A400|A500|870\s*EVO|980\s*PRO|990\s*PRO|SN770|MX500|Barracuda|T-Force[^0-9]*)/i) || title.match(/([A-Za-z0-9][A-Za-z0-9\s\-]{2,20}?)(?:\s*\d+\s*TB|\s*\d+\s*GB|\s*\d+G\b)/i);
            if (seriesMatch) name = (seriesMatch[1].trim() + " " + capStr[0]).trim();
          }
          if (name.length > 80) name = name.slice(0, 77) + "...";
          return { brand: brandZh || brand, name, spec: spec || ("條碼:" + upc) };
        })
        .catch(() => null);
    }
    // 型號前綴 → 品牌、系列（用於辨識後自動帶入）
    const PRODUCT_MODEL_MAP = [
      { pattern: /SA400|A400/i, brand: "金士頓", series: "A400", type: "SSD" },
      { pattern: /SA500|A500/i, brand: "金士頓", series: "A500", type: "SSD" },
      { pattern: /KC600|UV500/i, brand: "金士頓", series: "KC600", type: "SSD" },
      { pattern: /FURY|Fury/i, brand: "金士頓", series: "FURY", type: "SSD/RAM" },
      { pattern: /870\s*EVO|870EVO/i, brand: "三星", series: "870 EVO", type: "SSD" },
      { pattern: /980\s*PRO|980PRO/i, brand: "三星", series: "980 PRO", type: "SSD" },
      { pattern: /990\s*PRO|990PRO/i, brand: "三星", series: "990 PRO", type: "SSD" },
      { pattern: /WD\s*Blue|WDBlue|WDS/i, brand: "WD", series: "Blue", type: "SSD" },
      { pattern: /WD\s*Black|WDBlack/i, brand: "WD", series: "Black", type: "SSD" },
      { pattern: /SN770|SN850|SN580/i, brand: "WD", series: "SN 系列", type: "SSD" },
      { pattern: /MX500|BX500|P3|P5/i, brand: "美光", series: "Crucial", type: "SSD" },
      { pattern: /SanDisk|sandisk|Ultra|Extreme/i, brand: "SanDisk", series: "", type: "SSD" },
      { pattern: /SEAGATE|Barracuda|IronWolf/i, brand: "Seagate", series: "Barracuda", type: "HDD" },
      { pattern: /ADATA|XPG|SU800|SX8200/i, brand: "ADATA", series: "XPG", type: "SSD" },
      { pattern: /Transcend|TS\d+/i, brand: "Transcend", series: "", type: "SSD" },
      { pattern: /Team\s*Group|TEAMGROUP|T-Force/i, brand: "Team Group", series: "T-Force", type: "SSD/RAM" },
      { pattern: /Intel\s*6\d{2}[pP]|Intel\s*7\d{2}[pP]|6\d{2}[pP]|7\d{2}[pP]/i, brand: "Intel", series: "SSD", type: "SSD" },
      { pattern: /RTX\s*30|3060|3070|3080|3090/i, brand: "NVIDIA", series: "RTX 30", type: "顯卡" },
      { pattern: /RTX\s*40|4060|4070|4080|4090/i, brand: "NVIDIA", series: "RTX 40", type: "顯卡" },
      { pattern: /GTX\s*16|1650|1660/i, brand: "NVIDIA", series: "GTX 16", type: "顯卡" },
    ];
    function parseScannedText(text) {
      if (!text || typeof text !== "string") return {};
      const t = text.trim();
      const out = { spec: "", name: "", brand: "" };
      // 容量：480G、240GB、1T、2TB、512MB 等
      const capG = t.match(/(\d+)\s*[Gg](?:[Bb]?\b|\/)/);
      const capT = t.match(/(\d+)\s*[Tt][Bb]?\b/);
      const capM = t.match(/(\d+)\s*[Mm][Bb]?\b/);
      if (capG) {
        out.spec = (out.spec ? out.spec + " " : "") + capG[1] + "GB";
      } else if (capT) {
        out.spec = (out.spec ? out.spec + " " : "") + capT[1] + "TB";
      } else if (capM) {
        out.spec = (out.spec ? out.spec + " " : "") + capM[1] + "MB";
      }
      let capacityStr = out.spec || "";
      // 型號/容量一起出現：如 SA400S37/480G、XXX/240G
      const modelCap = t.match(/([A-Za-z0-9][A-Za-z0-9\-\.]+)\/(\d+)[Gg]/i);
      if (modelCap) {
        if (!capacityStr) capacityStr = modelCap[2] + "GB";
        if (!out.spec) out.spec = modelCap[2] + "GB";
        // 先比對已知型號，帶入品牌與系列
        for (const row of PRODUCT_MODEL_MAP) {
          if (row.pattern.test(modelCap[1])) {
            if (row.brand && !out.brand) out.brand = row.brand;
            const seriesPart = row.series ? row.series + " " : "";
            out.name = (seriesPart + capacityStr).trim() || modelCap[1] + "/" + modelCap[2] + "G";
            break;
          }
        }
        if (!out.name) out.name = modelCap[1] + "/" + modelCap[2] + "G";
      }
      // 若尚未有 name，再試從整段文字找已知型號
      if (!out.name) {
        for (const row of PRODUCT_MODEL_MAP) {
          if (row.pattern.test(t)) {
            if (row.brand && !out.brand) out.brand = row.brand;
            const seriesPart = row.series ? row.series + " " : "";
            out.name = (seriesPart + (capacityStr || "")).trim();
            if (out.name) break;
          }
        }
      }
      if (!out.name) {
        const modelMatch = t.match(/([A-Za-z0-9][A-Za-z0-9\-\.\/]+)/);
        if (modelMatch) out.name = modelMatch[1].replace(/\s+/g, " ").trim();
      }
      if (out.name && capacityStr && !out.spec) out.spec = capacityStr;
      // 品牌：先依型號表，再關鍵字
      if (!out.brand) {
        const brandMatch = t.match(/(kingston|金士頓|samsung|三星|wd|western digital|seagate|美光|crucial|sandisk|intel|adata|gigabyte|msi|asus|transcend|team group)/i);
        if (brandMatch) {
          const b = brandMatch[1].toLowerCase();
          if (/kingston|金士頓/.test(b)) out.brand = "金士頓";
          else if (/samsung|三星/.test(b)) out.brand = "三星";
          else if (/wd|western digital/.test(b)) out.brand = "WD";
          else if (/seagate/.test(b)) out.brand = "Seagate";
          else if (/crucial|美光/.test(b)) out.brand = "美光";
          else if (/sandisk/.test(b)) out.brand = "SanDisk";
          else if (/intel/.test(b)) out.brand = "Intel";
          else if (/adata/.test(b)) out.brand = "ADATA";
          else if (/gigabyte/.test(b)) out.brand = "技嘉";
          else if (/msi/.test(b)) out.brand = "微星";
          else if (/asus/.test(b)) out.brand = "華碩";
          else if (/transcend/.test(b)) out.brand = "Transcend";
          else if (/team group/.test(b)) out.brand = "Team Group";
          else out.brand = brandMatch[1];
        }
      }
      return out;
    }
    function handleItemScanFile(file) {
      if (!file || !file.type.startsWith("image/")) return;
      setItemScanStatus("辨識中…");
      const reader = new FileReader();
      reader.onload = function (e) {
        const dataUrl = e.target.result;
        const img = new Image();
        img.onload = function () {
          const canvas = document.createElement("canvas");
          const max = 1200;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; }
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          let barcodeText = "";
          let qrText = "";
          if (typeof window.jsQR === "function") {
            try {
              const qr = window.jsQR(imageData.data, w, h);
              if (qr && qr.data) qrText = qr.data;
            } catch (err) {}
          }
          function applyDecoded() {
          const combined = [qrText, barcodeText].filter(Boolean).join(" ").trim();
          const barcodeOnly = combined.replace(/\s/g, "");
          const isBarcodeOnly = /^\d{12,14}$/.test(barcodeOnly);
          const nameEl = document.getElementById("itemName");
          function fillForm(parsed) {
            const parsedBrand = (parsed && parsed.brand != null) ? String(parsed.brand).trim() : "";
            const parsedName = (parsed && parsed.name != null) ? String(parsed.name).trim() : "";
            const parsedSpec = (parsed && parsed.spec != null && parsed.spec !== undefined) ? String(parsed.spec).trim() : (barcodeText ? "條碼:" + barcodeText : "");
            const merged = [parsedBrand ? parsedBrand + " " + parsedName : parsedName, parsedSpec].filter(Boolean).join(" ").trim();
            if (nameEl) nameEl.value = merged;
            try { updateItemDuplicateHint(); } catch (_) {}
          }
          if (isBarcodeOnly) {
            setItemScanStatus("正在查詢網路…");
            lookupBarcodeOnline(barcodeOnly).then(function (parsed) {
              if (parsed) {
                fillForm(parsed);
                setItemScanStatus("已從網路帶入，請核對後儲存");
              } else {
              fillForm({ brand: "", name: "", spec: "條碼:" + barcodeOnly });
                setItemScanStatus("僅辨識到條碼，網路查無商品，請手動輸入名稱／規格");
              }
            }).catch(function () {
              fillForm({ brand: "", name: "", spec: "條碼:" + barcodeOnly });
              setItemScanStatus("僅辨識到條碼，網路查詢失敗，請手動輸入名稱／規格");
            });
            return;
          }
          const parsed = parseScannedText(combined);
          fillForm(parsed);
          setItemScanStatus(combined ? "已辨識，請核對後儲存" : "未辨識到條碼／QR，可手動輸入");
        }
          if (typeof window.Quagga !== "undefined" && window.Quagga.decodeSingle) {
            window.Quagga.decodeSingle({
              src: dataUrl,
              numOfWorkers: 0,
              inputStream: { size: Math.max(w, h) },
              decoder: { readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "upc_e_reader"] }
            }, function (result) {
              if (result && result.codeResult && result.codeResult.code) barcodeText = result.codeResult.code;
              applyDecoded();
            });
            setTimeout(applyDecoded, 2500);
          } else {
            applyDecoded();
          }
        };
        img.onerror = function () {
          setItemScanStatus("無法讀取圖片");
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    }
    document.getElementById("itemSave")?.addEventListener("click", () => {
      const nameSpec = String(document.getElementById("itemName")?.value || "").trim();
      if (!nameSpec) return v2Show(itemMsg, "名稱／規格必填");
      const items = DK.getItems();
      const editingItem = editingV2ItemId ? DK.findItemById(editingV2ItemId) : null;
      const sku = editingItem ? editingItem.sku : generateUniqueSKU();
      const payload = {
        sku,
        category: document.getElementById("itemCategory")?.value,
        name: nameSpec,
        spec: nameSpec,
        vendor: String(document.getElementById("itemVendor")?.value || "").trim(),
        condition: document.getElementById("itemCondition")?.value || "USED",
        status: document.getElementById("itemStatus")?.value || "READY",
        qty_on_hand: Math.max(0, parseInt(document.getElementById("itemQty")?.value, 10) || 0),
        cost_unit: parseFloat(document.getElementById("itemCost")?.value) || 0,
        price_list: parseFloat(document.getElementById("itemPriceList")?.value) || null,
        price_floor: parseFloat(document.getElementById("itemPriceFloor")?.value) || null,
        inbound_date: document.getElementById("itemInboundDate")?.value || null,
        reorder_point: Math.max(0, parseInt(document.getElementById("itemReorderPoint")?.value, 10) || 0),
        notes: document.getElementById("itemNotes")?.value || "",
        updated_at: nowISO(),
      };
      if (editingV2ItemId) {
        const idx = items.findIndex((x) => x.id === editingV2ItemId);
        if (idx < 0) return v2Show(itemMsg, "找不到品項");
        items[idx] = { ...items[idx], ...payload };
        const syncP = DK.saveItems(items);
        v2Show(itemMsg, "已更新");
        if (syncP) syncP.then((r) => showSyncToast(r, "品項"));
      } else {
        payload.id = "i-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
        payload.last_moved_at = payload.inbound_date ? payload.inbound_date + "T12:00:00Z" : null;
        payload.created_at = nowISO();
        items.unshift(payload);
        const syncP = DK.saveItems(items);
        v2Show(itemMsg, "已新增");
        if (syncP) syncP.then((r) => showSyncToast(r, "品項"));
      }
      renderV2Items();
      setTimeout(closeV2ItemEditor, 800);
    });

    // ===== 重複品項提醒（名稱／規格相似比對）=====
    const itemNameInput = document.getElementById("itemName");
    const itemDuplicateHint = document.getElementById("itemDuplicateHint");
    const DUP_HINT_MAX = 5;

    function normalizeNameSpecText(s) {
      return String(s ?? "")
        .toLowerCase()
        .replace(/[\u3000\s]+/g, " ")
        .replace(/[()（）【】\[\]{}<>「」『』'"`~!@#$%^&*+=|\\:;,.?，。！？、／/_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function bigrams(s) {
      const t = normalizeNameSpecText(s).replace(/\s/g, "");
      if (!t) return [];
      if (t.length === 1) return [t];
      const out = [];
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
      return out;
    }

    function diceCoefficient(a, b) {
      const A = bigrams(a);
      const B = bigrams(b);
      if (A.length === 0 || B.length === 0) return 0;
      const counts = new Map();
      for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
      let overlap = 0;
      for (const g of B) {
        const c = counts.get(g) || 0;
        if (c > 0) {
          overlap++;
          counts.set(g, c - 1);
        }
      }
      return (2 * overlap) / (A.length + B.length);
    }

    function calcNameSpecSimilarity(query, target) {
      const q = normalizeNameSpecText(query);
      const t = normalizeNameSpecText(target);
      if (!q || !t) return 0;
      if (q === t) return 1;
      // 包含關係給較高分（避免只有差一點點符號）
      if (q.length >= 4 && t.includes(q)) return 0.92;
      if (t.length >= 4 && q.includes(t)) return 0.92;
      return diceCoefficient(q, t);
    }

    function getSimilarItemsByNameSpec(query, excludeId) {
      if (!window.DK || typeof DK.getEnrichedItems !== "function") return [];
      const q = String(query || "").trim();
      if (!q) return [];
      const ex = String(excludeId || "");
      const items = DK.getEnrichedItems();
      const scored = [];
      for (const it of items) {
        if (!it || !it.id) continue;
        if (ex && String(it.id) === ex) continue;
        const nameSpec = (it.name === it.spec || !String(it.spec || "").trim())
          ? (it.name || it.spec || "")
          : [it.name, it.spec].filter(Boolean).join(" ").trim();
        const score = calcNameSpecSimilarity(q, nameSpec);
        if (score >= 0.62) scored.push({ it, nameSpec, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, DUP_HINT_MAX);
    }

    function hideItemDuplicateHint() {
      if (!itemDuplicateHint) return;
      itemDuplicateHint.hidden = true;
      itemDuplicateHint.innerHTML = "";
    }

    function renderItemDuplicateHint(rows) {
      if (!itemDuplicateHint) return;
      if (!rows || rows.length === 0) return hideItemDuplicateHint();
      const fmtNum = (n) => (n == null || !Number.isFinite(Number(n))) ? "-" : Number(n).toLocaleString("zh-TW");
      itemDuplicateHint.hidden = false;
      itemDuplicateHint.innerHTML = `
        <div class="card" style="margin:0; padding:10px; border:1px solid rgba(0,0,0,.08); background:rgba(255,210,0,.08)">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px">
            <strong>重複品項提醒</strong>
            <span class="muted">最多顯示 ${DUP_HINT_MAX} 筆</span>
          </div>
          <div class="table-wrap" style="margin-top:8px">
            <table class="table">
              <thead><tr><th>名稱</th><th>品類</th><th style="text-align:right">庫存</th><th style="text-align:right">成本</th><th style="text-align:right">操作</th></tr></thead>
              <tbody>
                ${rows.map(({ it, nameSpec }) => `
                  <tr>
                    <td>${v2Esc(String(nameSpec || ""))}</td>
                    <td>${v2Esc(String(it.category || ""))}</td>
                    <td style="text-align:right">${v2Esc(String(it.qty_on_hand ?? 0))}</td>
                    <td style="text-align:right">${v2Esc(fmtNum(it.cost_unit))}</td>
                    <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-dup-item" data-id="${v2Esc(String(it.id))}">改編輯此品項</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    function updateItemDuplicateHint() {
      if (!itemDuplicateHint) return;
      const q = String(itemNameInput?.value || "").trim();
      if (!q) return hideItemDuplicateHint();
      const rows = getSimilarItemsByNameSpec(q, editingV2ItemId);
      if (!rows.length) return hideItemDuplicateHint();
      renderItemDuplicateHint(rows);
    }

    // 不阻止新增/編輯，只做提示
    itemNameInput?.addEventListener("input", () => {
      try { updateItemDuplicateHint(); } catch (_) { hideItemDuplicateHint(); }
    });
    itemDuplicateHint?.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".btn-edit-dup-item") : null;
      if (!btn) return;
      const id = btn.getAttribute("data-id") || "";
      if (!id) return;
      try {
        hideItemDuplicateHint();
        openV2ItemEditor(id); // 直接切換到該品項編輯視窗，不新增新資料
      } catch (_) {}
    });
    itemsSearch?.addEventListener("input", () => { itemsPage = 1; renderV2Items(); });
    itemsCategory?.addEventListener("change", () => { itemsPage = 1; renderV2Items(); });
    itemsStatus?.addEventListener("change", () => { itemsStatusTouchedByUser = true; itemsPage = 1; renderV2Items(); });
    document.getElementById("btnDeleteSelectedItems")?.addEventListener("click", () => {
      const checked = document.querySelectorAll("#itemsTbody .item-row-cb:checked");
      const ids = Array.from(checked).map((cb) => cb.getAttribute("data-id")).filter(Boolean);
      if (ids.length === 0) {
        alert("請先勾選要刪除的品項。");
        return;
      }
      if (!confirm("確定要刪除所選的 " + ids.length + " 筆品項？刪除後無法復原。")) return;
      const items = DK.getItems().filter((x) => !ids.includes(x.id));
      const syncP = DK.saveItems(items);
      renderV2Items();
      if (syncP) syncP.then((r) => showSyncToast(r, "品項刪除"));
    });
    document.getElementById("itemsSelectAll")?.addEventListener("change", function () {
      itemsTbody?.querySelectorAll(".item-row-cb").forEach((cb) => { cb.checked = this.checked; });
    });
    itemsTbody?.addEventListener("change", function (e) {
      if (!e.target.classList.contains("item-row-cb")) return;
      const rowCbs = itemsTbody.querySelectorAll(".item-row-cb");
      const checked = itemsTbody.querySelectorAll(".item-row-cb:checked").length;
      const sel = document.getElementById("itemsSelectAll");
      if (sel) {
        sel.checked = checked === rowCbs.length;
        sel.indeterminate = checked > 0 && checked < rowCbs.length;
      }
    });
    const ledgerTbody = document.getElementById("ledgerTbody");
    const ledgerForm = document.getElementById("ledgerForm");
    const ledgerMsg = document.getElementById("ledgerMsg");
    function renderV2Ledger() {
      if (!ledgerTbody) return;
      const list = DK.getLedger();
      const items = DK.getItems();
      const byId = Object.fromEntries(items.map((i) => [i.id, i]));
      const pageInfo = paginateV2(list, ledgerPage, V2_PAGE_SIZE);
      ledgerPage = pageInfo.page;
      ledgerTbody.innerHTML = pageInfo.pageItems.map((r) => {
        const item = byId[r.item_id];
        const baseName = item ? (item.name || item.sku || "") : String(r.item_id || "");
        const spec = item ? String(item.spec || "").trim() : "";
        const displayName = spec ? `${baseName} ${spec}` : baseName;
        return `<tr><td class="nowrap">${v2Esc((r.created_at || "").toString().slice(0, 19))}</td><td>${v2Esc(displayName)}</td><td>${v2Esc(LEDGER_TYPE_LABEL[r.type] || r.type)}</td><td>${r.qty}</td><td>${v2FmtNum(r.unit_cost)}</td><td>${v2Esc(REF_TYPE_LABEL[r.ref_type] || r.ref_type)}</td><td>${v2Esc(r.ref_id)}</td><td class="muted">${v2Esc(r.note)}</td></tr>`;
      }).join("");

      const pager = document.getElementById("ledgerPagination");
      if (pager) {
        const cur = pageInfo.page;
        const totalPages = pageInfo.totalPages;
        const total = pageInfo.total;
        let html = `<span class="pagination-info">共 ${total} 筆，第 ${cur} / ${totalPages} 頁</span>`;
        if (totalPages > 1) {
          html += `<span class="pagination-btns"><button type="button" class="btn btn-ghost btn-sm page-btn prev" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>上一頁</button>`;
          for (let p = 1; p <= totalPages; p++) {
            const active = p === cur ? " current" : "";
            html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-page="${p}">${p}</button>`;
          }
          html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-page="${cur + 1}" ${cur >= totalPages ? "disabled" : ""}>下一頁</button></span>`;
        }
        pager.innerHTML = html;
      }
    }
    document.getElementById("btnNewLedger")?.addEventListener("click", () => {
      const sel = document.getElementById("ledgerItemId");
      if (sel) sel.innerHTML = '<option value="">— 選擇品項 —</option>' + DK.getItems().map((i) => `<option value="${v2Esc(i.id)}">${v2Esc(i.name)}</option>`).join("");
      sel.value = "";
      const ledgerSearchInp = document.getElementById("ledgerItemIdSearch");
      if (ledgerSearchInp) ledgerSearchInp.value = "";
      document.getElementById("ledgerType").value = "IN";
      document.getElementById("ledgerQty").value = "1";
      document.getElementById("ledgerUnitCost").value = "";
      document.getElementById("ledgerRefType").value = "PURCHASE";
      document.getElementById("ledgerRefId").value = "";
      document.getElementById("ledgerNote").value = "";
      if (ledgerForm) ledgerForm.hidden = false;
      v2Hide(ledgerMsg);
    });
    document.getElementById("ledgerCancel")?.addEventListener("click", () => { if (ledgerForm) ledgerForm.hidden = true; v2Hide(ledgerMsg); });
    document.getElementById("ledgerSubmit")?.addEventListener("click", () => {
      const itemId = document.getElementById("ledgerItemId")?.value;
      const type = document.getElementById("ledgerType")?.value;
      const qty = parseInt(document.getElementById("ledgerQty")?.value, 10);
      const unitCost = parseFloat(document.getElementById("ledgerUnitCost")?.value) || 0;
      const refType = document.getElementById("ledgerRefType")?.value || "";
      const refId = document.getElementById("ledgerRefId")?.value || "";
      const note = document.getElementById("ledgerNote")?.value || "";
      if (!itemId) return v2Show(ledgerMsg, "請選擇品項");
      if (!Number.isFinite(qty) || (type === "IN" && qty <= 0) || (type === "OUT" && qty <= 0)) return v2Show(ledgerMsg, "數量需大於 0");
      if (type === "IN" && unitCost < 0) return v2Show(ledgerMsg, "入庫請填單位成本");
      const result = DK.addLedgerEntry({ item_id: itemId, type, qty: type === "ADJUST" ? qty : Math.abs(qty), unit_cost: unitCost, ref_type: refType, ref_id: refId, note });
      if (!result.ok) return v2Show(ledgerMsg, result.error || "失敗");
      v2Show(ledgerMsg, "已寫入流水並更新品項");
      if (result.syncPromise) result.syncPromise.then((r) => showSyncToast(r, "流水帳"));
      renderV2Ledger();
      renderV2Items();
      setTimeout(() => { if (ledgerForm) ledgerForm.hidden = true; v2Hide(ledgerMsg); }, 1000);
    });

    const ordersTbody = document.getElementById("ordersTbody");
    const orderForm = document.getElementById("orderForm");
    const orderMsg = document.getElementById("orderMsg");
    const orderSearchEl = document.getElementById("orderSearch");
    const orderDateRangeEl = document.getElementById("orderDateRange");
    const orderStatusFilterEl = document.getElementById("orderStatusFilter");
    const orderLineTbody = document.getElementById("orderLineTbody");
    const orderLineItemSelect = document.getElementById("orderLineItem");
    let editingV2OrderId = null;
    let orderLineItems = [];

    // 訂單新增/編輯：客戶欄位搜尋建議（讀客戶紀錄，只帶入名稱）
    (function initOrderCustomerSuggest() {
      const inp = document.getElementById("orderCustomer");
      if (!inp) return;

      const wrap = inp.parentElement || inp;
      try { if (wrap && getComputedStyle(wrap).position === "static") wrap.style.position = "relative"; } catch (_) {}

      const dd = document.createElement("div");
      dd.className = "searchable-select-dropdown";
      dd.id = "orderCustomerSuggestDropdown";
      dd.hidden = true;
      dd.style.maxHeight = "220px";
      dd.style.overflow = "auto";
      dd.style.position = "absolute";
      dd.style.left = "0";
      dd.style.right = "0";
      dd.style.top = "100%";
      dd.style.marginTop = "6px";
      dd.style.zIndex = "50";
      (wrap || inp).appendChild(dd);

      function close() { dd.hidden = true; dd.innerHTML = ""; }
      function esc(s) { return typeof v2Esc === "function" ? v2Esc(String(s ?? "")) : String(s ?? ""); }

      function readCustomers() {
        try {
          if (typeof loadCustomerRecords === "function") return loadCustomerRecords();
          const raw = safeParse(localStorage.getItem(CUSTOMER_RECORDS_KEY), null);
          const list = Array.isArray(raw) ? raw : [];
          return list.map(crNormalize);
        } catch (_) {
          return [];
        }
      }

      function render(q) {
        const query = String(q || "").trim().toLowerCase();
        if (!query) return close();
        const list = readCustomers();
        const out = [];
        const seen = new Set();
        for (const r of list) {
          const name = String(r?.name || "").trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          if (!key.includes(query)) continue;
          seen.add(key);
          out.push({ name, source: String(r?.source || "其他") });
          if (out.length >= 5) break;
        }
        if (out.length === 0) {
          dd.innerHTML = '<div class="searchable-select-empty">無符合的客戶</div>';
          dd.hidden = false;
          return;
        }
        dd.innerHTML = out
          .map((x) => `<div class="searchable-select-option" data-name="${esc(x.name)}">${esc(x.name)}（${esc(x.source)}）</div>`)
          .join("");
        dd.hidden = false;
      }

      inp.addEventListener("input", () => render(inp.value));
      inp.addEventListener("focus", () => render(inp.value));
      inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
      inp.addEventListener("blur", () => setTimeout(close, 180));
      dd.addEventListener("mousedown", (e) => {
        const opt = e.target && e.target.closest ? e.target.closest(".searchable-select-option") : null;
        if (!opt) return;
        e.preventDefault();
        const name = opt.getAttribute("data-name") || "";
        inp.value = name; // 只帶入名稱
        close();
      });
      document.addEventListener("click", (e) => {
        if (dd.hidden) return;
        const t = e.target;
        if (t === inp || (wrap && wrap.contains(t)) || dd.contains(t)) return;
        close();
      });
    })();

    function consumeCreateOrderFromCustomerIfAny() {
      let raw = null;
      try { raw = sessionStorage.getItem(CREATE_ORDER_FROM_CUSTOMER_KEY); } catch (_) { raw = null; }
      if (!raw) return;
      const data = safeParse(raw, null);
      try { sessionStorage.removeItem(CREATE_ORDER_FROM_CUSTOMER_KEY); } catch (_) {}
      if (!data || typeof data !== "object") return;
      const customerId = String(data.customerId || "");
      if (customerId) {
        try { sessionStorage.setItem(PENDING_CUSTOMER_ORDER_LINK_KEY, JSON.stringify({ customerId })); } catch (_) {}
      }
      const name = String(data.name || "");
      const amount = Number(data.amount) || 0;
      const note = String(data.note || "");
      const customerEl = document.getElementById("orderCustomer");
      const saleEl = document.getElementById("orderTotalSale");
      if (customerEl) customerEl.value = name;
      if (saleEl && ((parseFloat(saleEl.value) || 0) === 0)) saleEl.value = String(amount || 0);
      // 訂單表單本身沒有 note 欄位；先把轉單備註顯示在 orderMsg，讓你可直接複製
      if (orderMsg && note) {
        orderMsg.hidden = false;
        orderMsg.textContent = "（轉單帶入）備註：\n" + note;
      }
      try { updateV2OrderGrossDisplay(); } catch (_) {}
    }

    function getOrderDateStr(o) {
      return (o.created_at || o.date || "").toString().slice(0, 10);
    }
    function getFilteredOrders() {
      let list = DK.getOrders().map(DK.enrichOrder);
      const q = (orderSearchEl?.value || "").trim().toLowerCase();
      const range = orderDateRangeEl?.value || "";
      const statusFilter = orderStatusFilterEl?.value || "";
      if (q) {
        list = list.filter((o) =>
          [o.order_no, o.customer_name].some((v) => String(v || "").toLowerCase().includes(q))
        );
      }
      if (range) {
        const now = new Date();
        let fromStr, toStr;
        if (range === "month") {
          const y = now.getFullYear(), m = now.getMonth();
          fromStr = new Date(y, m, 1).toISOString().slice(0, 10);
          toStr = new Date(y, m + 1, 0).toISOString().slice(0, 10);
        } else if (range === "week") {
          const day = now.getDay();
          const start = new Date(now);
          start.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
          start.setHours(0, 0, 0, 0);
          fromStr = start.toISOString().slice(0, 10);
          const end = new Date(start);
          end.setDate(start.getDate() + 6);
          toStr = end.toISOString().slice(0, 10);
        }
        if (fromStr && toStr) {
          list = list.filter((o) => {
            const d = getOrderDateStr(o);
            return d >= fromStr && d <= toStr;
          });
        }
      }
      if (statusFilter) list = list.filter((o) => o.status === statusFilter);
      return list;
    }

    /** 將品項 select 改為可關鍵字搜尋：依名稱／編號／規格過濾，點選後寫回 select 的 value。opts.showQty 時選單顯示庫存剩餘數量；opts.showCost 時顯示單位成本 */
    function makeSearchableItemSelect(selectId, searchInputId, dropdownId, opts) {
      opts = opts || {};
      const select = document.getElementById(selectId);
      const input = document.getElementById(searchInputId);
      const dropdown = document.getElementById(dropdownId);
      if (!select || !input || !dropdown) return;
      function getFiltered() {
        const q = (input.value || "").trim().toLowerCase();
        const items = DK.getItems();
        if (!q) return items;
        return items.filter((i) =>
          String(i.name || "").toLowerCase().includes(q) ||
          String(i.sku || "").toLowerCase().includes(q) ||
          String(i.spec || "").toLowerCase().includes(q)
        );
      }
      function render() {
        const list = getFiltered();
        if (list.length === 0) {
          dropdown.innerHTML = '<div class="searchable-select-empty">無符合的品項</div>';
        } else {
          dropdown.innerHTML = list.map((i) => {
            let label = (i.name || "") + (i.spec ? " (" + (i.spec || "") + ")" : "");
            const qty = i.qty_on_hand ?? 0;
            if (opts.showQty) label += " · 剩餘 " + qty;
            if (opts.showCost && (i.cost_unit != null && i.cost_unit !== "")) label += " · 成本 " + v2FmtNum(Number(i.cost_unit) || 0);
            const zeroClass = qty === 0 ? " qty-zero" : "";
            return `<div class="searchable-select-option${zeroClass}" data-id="${v2Esc(i.id)}" data-name="${v2Esc(i.name || "")}">${v2Esc(label)}</div>`;
          }).join("");
        }
        dropdown.hidden = false;
      }
      function pick(itemId, displayName) {
        select.value = itemId;
        input.value = displayName || "";
        dropdown.hidden = true;
        if (typeof opts.onPick === "function") opts.onPick(itemId);
      }
      input.addEventListener("focus", () => render());
      input.addEventListener("input", () => render());
      input.addEventListener("blur", () => setTimeout(() => { dropdown.hidden = true; }, 180));
      dropdown.addEventListener("mousedown", (e) => {
        const opt = e.target.closest(".searchable-select-option");
        if (opt) { e.preventDefault(); pick(opt.getAttribute("data-id"), opt.getAttribute("data-name")); }
      });
    }

    function renderV2Orders() {
      if (!ordersTbody) return;
      const list = getFilteredOrders();
      const pageInfo = paginateV2(list, ordersPage, V2_PAGE_SIZE);
      ordersPage = pageInfo.page;
      ordersTbody.innerHTML = pageInfo.pageItems.map((o) => {
        const margin = o.gross_margin != null ? (o.gross_margin * 100).toFixed(1) + "%" : "-";
        const statusKey = (o.status && ORDER_STATUS_LABEL[o.status]) ? o.status : "pending";
        const statusClass = "order-status-badge order-status-" + statusKey;
        return `<tr><td class="nowrap">${v2Esc(o.order_no)}</td><td>${v2Esc(o.customer_name)}</td><td>${v2FmtNum(o.total_sale)}</td><td>${v2FmtNum(o.shipping_income)}</td><td>${v2FmtNum(o.discount)}</td><td>${v2FmtNum(o.cogs_total)}</td><td>${v2FmtNum(o.gross_profit)}</td><td>${margin}</td><td><span class="${statusClass}">${v2Esc(ORDER_STATUS_LABEL[o.status] || o.status)}</span></td><td class="nowrap">${v2Esc((o.created_at || "").toString().slice(0, 10))}</td><td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-order" data-id="${v2Esc(o.id)}">編輯</button></td></tr>`;
      }).join("");
      ordersTbody.querySelectorAll(".btn-edit-order").forEach((btn) => btn.addEventListener("click", () => openV2OrderEditor(btn.getAttribute("data-id"))));

      const pager = document.getElementById("ordersPagination");
      if (pager) {
        const cur = pageInfo.page;
        const totalPages = pageInfo.totalPages;
        const total = pageInfo.total;
        let html = `<span class="pagination-info">共 ${total} 筆，第 ${cur} / ${totalPages} 頁</span>`;
        if (totalPages > 1) {
          html += `<span class="pagination-btns"><button type="button" class="btn btn-ghost btn-sm page-btn prev" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>上一頁</button>`;
          for (let p = 1; p <= totalPages; p++) {
            const active = p === cur ? " current" : "";
            html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-page="${p}">${p}</button>`;
          }
          html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-page="${cur + 1}" ${cur >= totalPages ? "disabled" : ""}>下一頁</button></span>`;
        }
        pager.innerHTML = html;
      }
    }
    orderSearchEl?.addEventListener("input", () => { ordersPage = 1; renderV2Orders(); });
    orderSearchEl?.addEventListener("search", () => { ordersPage = 1; renderV2Orders(); });
    orderDateRangeEl?.addEventListener("change", () => { ordersPage = 1; renderV2Orders(); });
    orderStatusFilterEl?.addEventListener("change", () => { applyOrderStatusSelectClass(); ordersPage = 1; renderV2Orders(); });

    function fillOrderLineItemSelect() {
      if (!orderLineItemSelect) return;
      const items = DK.getItems();
      orderLineItemSelect.innerHTML = '<option value="">— 選擇品項 —</option>' + items.map((i) => `<option value="${v2Esc(i.id)}">${v2Esc(i.name || "")}</option>`).join("");
      const searchInp = document.getElementById("orderLineItemSearch");
      if (searchInp) { searchInp.value = ""; orderLineItemSelect.value = ""; }
    }
    function renderOrderLineTbody() {
      if (!orderLineTbody) return;
      orderLineTbody.innerHTML = orderLineItems.map((line, i) => {
        const costUnit = Number(line.cost_unit) || 0;
        const cogsSub = costUnit * (Number(line.qty) || 0);
        const spec = line.spec != null ? line.spec : (DK.findItemById(line.item_id)?.spec ?? "");
        return `<tr><td>${v2Esc(line.name || "")}</td><td class="muted small">${v2Esc(spec)}</td><td>${line.qty}</td><td>${v2FmtNum(line.unit_price)}</td><td>${v2FmtNum(costUnit)}</td><td>${v2FmtNum(cogsSub)}</td><td><button type="button" class="btn btn-ghost btn-sm order-line-remove" data-i="${i}">移除</button></td></tr>`;
      }).join("");
      orderLineTbody.querySelectorAll(".order-line-remove").forEach((btn) => {
        btn.addEventListener("click", () => {
          orderLineItems.splice(parseInt(btn.getAttribute("data-i"), 10), 1);
          renderOrderLineTbody();
          updateOrderTotalsFromLines();
        });
      });
    }
    function updateOrderTotalsFromLines() {
      const saleSum = orderLineItems.reduce((s, l) => s + (Number(l.unit_price) || 0) * (Number(l.qty) || 0), 0);
      const cogsSum = orderLineItems.reduce((s, l) => s + (Number(l.cost_unit) || 0) * (Number(l.qty) || 0), 0);
      const saleEl = document.getElementById("orderTotalSale");
      const cogsEl = document.getElementById("orderCogs");
      if (saleEl) saleEl.value = saleSum;
      if (cogsEl) cogsEl.value = cogsSum;
      updateV2OrderGrossDisplay();
    }

    function openV2OrderEditor(id) {
      editingV2OrderId = id || null;
      const o = id ? DK.getOrders().find((x) => x.id === id) : null;
      orderLineItems = (Array.isArray(o?.items) ? o.items : []).map((l) => ({
        ...l,
        item_id: l.item_id ?? l.id,
        unit_price: l.unit_price ?? l.unitPrice ?? 0,
        cost_unit: l.cost_unit ?? l.costUnit ?? 0,
      }));
      fillOrderLineItemSelect();
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
      set("orderNo", o ? o.order_no : DK.nextOrderNo());
      const orderNoEl = document.getElementById("orderNo");
      if (orderNoEl) orderNoEl.readOnly = !!o;
      set("orderDate", o && o.created_at ? (o.created_at || "").toString().slice(0, 10) : todayStr());
      set("orderCustomer", o ? o.customer_name ?? "" : "");
      set("orderTotalSale", o ? o.total_sale ?? 0 : 0);
      set("orderShipping", o ? o.shipping_income ?? 0 : 0);
      set("orderDiscount", o ? o.discount ?? 0 : 0);
      set("orderCogs", o ? o.cogs_total ?? 0 : 0);
      set("orderPayment", o ? o.payment_method ?? "transfer" : "transfer");
      set("orderStatus", o ? o.status ?? "pending" : "pending");
      applyOrderStatusSelectClass();
      renderOrderLineTbody();
      updateOrderTotalsFromLines();
      if (orderLineItems.length) updateOrderTotalsFromLines();
      // 編輯既有訂單時，若明細加總為 0 但訂單有 total_sale，保留訂單的售價合計，避免被覆寫成 0
      if (o && (Number(o.total_sale) || 0) !== 0) {
        const saleEl = document.getElementById("orderTotalSale");
        if (saleEl && (parseFloat(saleEl.value) || 0) === 0) set("orderTotalSale", o.total_sale);
      }
      updateV2OrderGrossDisplay();
      if (orderForm) orderForm.hidden = false;
      v2Hide(orderMsg);
    }
    function updateV2OrderGrossDisplay() {
      const sale = parseFloat(document.getElementById("orderTotalSale")?.value) || 0;
      const ship = parseFloat(document.getElementById("orderShipping")?.value) || 0;
      const disc = parseFloat(document.getElementById("orderDiscount")?.value) || 0;
      const cogs = parseFloat(document.getElementById("orderCogs")?.value) || 0;
      const profit = sale + ship - disc - cogs;
      const rev = sale + ship - disc;
      const margin = rev > 0 ? ((profit / rev) * 100).toFixed(1) + "%" : "-";
      const el = document.getElementById("orderGrossProfitDisplay");
      if (el) el.textContent = "毛利 " + v2FmtNum(profit) + " / 毛利率 " + margin;
    }
    function applyOrderStatusSelectClass() {
      const statusKeys = ["pending", "paid", "shipped", "completed", "refunded"];
      [document.getElementById("orderStatus"), document.getElementById("orderStatusFilter")].forEach((el) => {
        if (!el) return;
        statusKeys.forEach((k) => el.classList.remove("order-status-" + k));
        const v = (el.value || "pending").trim();
        if (v) el.classList.add("order-status-" + v);
      });
    }
    ["orderTotalSale", "orderShipping", "orderDiscount", "orderCogs"].forEach((id) => document.getElementById(id)?.addEventListener("input", updateV2OrderGrossDisplay));
    document.getElementById("orderStatus")?.addEventListener("change", applyOrderStatusSelectClass);
    document.getElementById("btnNewOrder")?.addEventListener("click", () => {
      openV2OrderEditor(null);
      setTimeout(consumeCreateOrderFromCustomerIfAny, 0);
    });
    document.getElementById("orderCancel")?.addEventListener("click", () => { if (orderForm) orderForm.hidden = true; editingV2OrderId = null; v2Hide(orderMsg); });
    document.getElementById("orderLineAdd")?.addEventListener("click", () => {
      const itemId = orderLineItemSelect?.value;
      const qty = Math.max(1, parseInt(document.getElementById("orderLineQty")?.value, 10) || 1);
      const unitPrice = parseFloat(document.getElementById("orderLinePrice")?.value) || 0;
      if (!itemId) return v2Show(orderMsg, "請選擇品項");
      const item = DK.findItemById(itemId);
      if (!item) return v2Show(orderMsg, "找不到該品項");
      const onHand = Number(item.qty_on_hand) || 0;
      if (onHand === 0) return v2Show(orderMsg, "該品項庫存為 0，無法加入訂單");
      const alreadyInOrder = orderLineItems.filter((l) => l.item_id === itemId).reduce((s, l) => s + (Number(l.qty) || 0), 0);
      if (alreadyInOrder + qty > onHand) return v2Show(orderMsg, "庫存不足：" + item.sku + " 現有 " + onHand + "，明細已選 " + alreadyInOrder + "，再加 " + qty + " 會超過");
      orderLineItems.push({ item_id: item.id, sku: item.sku, name: item.name, spec: item.spec || "", qty: qty, unit_price: unitPrice, cost_unit: Number(item.cost_unit) || 0 });
      renderOrderLineTbody();
      updateOrderTotalsFromLines();
      v2Hide(orderMsg);
    });
    document.getElementById("orderSave")?.addEventListener("click", async () => {
      const g = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {};
      g._suppressV2Sync = true;
      try {
        const orderNo = String(document.getElementById("orderNo")?.value || "").trim();
        const totalSale = parseFloat(document.getElementById("orderTotalSale")?.value) || 0;
        const cogsTotal = parseFloat(document.getElementById("orderCogs")?.value) || 0;
        if (!orderNo) { v2Show(orderMsg, "訂單編號必填"); return; }
        const orders = DK.getOrders();
      const existing = orders.find((x) => x.order_no === orderNo && x.id !== editingV2OrderId);
      if (existing) return v2Show(orderMsg, "訂單編號重複");
      const orderDate = document.getElementById("orderDate")?.value || todayStr();
      const createdAt = orderDate.includes("T") ? orderDate : orderDate + "T12:00:00.000Z";
      const payload = { order_no: orderNo, customer_name: document.getElementById("orderCustomer")?.value || "", total_sale: totalSale, shipping_income: parseFloat(document.getElementById("orderShipping")?.value) || 0, discount: parseFloat(document.getElementById("orderDiscount")?.value) || 0, payment_method: document.getElementById("orderPayment")?.value || "transfer", status: document.getElementById("orderStatus")?.value || "pending", cogs_total: cogsTotal, created_at: createdAt, items: orderLineItems };

      function tryMarkLinkedCustomerAsWon() {
        let raw = null;
        try { raw = sessionStorage.getItem(PENDING_CUSTOMER_ORDER_LINK_KEY); } catch (_) { raw = null; }
        if (!raw) return;
        const link = safeParse(raw, null);
        const customerId = String(link?.customerId || "");
        if (!customerId) return;
        try {
          const listRaw = safeParse(localStorage.getItem(CUSTOMER_RECORDS_KEY), null);
          const list = Array.isArray(listRaw) ? listRaw.map(crNormalize) : [];
          const idx = list.findIndex((x) => String(x.id) === customerId);
          if (idx < 0) {
            v2Show(orderMsg, "訂單已儲存，但找不到對應客戶紀錄（未更新狀態）。");
            return;
          }
          list[idx] = { ...list[idx], status: "成交" };
          localStorage.setItem(CUSTOMER_RECORDS_KEY, JSON.stringify(list));
          try { sessionStorage.removeItem(PENDING_CUSTOMER_ORDER_LINK_KEY); } catch (_) {}
          if (typeof renderCustomerRecordsPage === "function") renderCustomerRecordsPage();
        } catch (e) {
          // 不要中斷訂單流程；也不要清除 pending key，避免資料遺失
          v2Show(orderMsg, "訂單已儲存，但更新客戶狀態失敗：" + String(e?.message || e || ""));
        }
      }
      if (editingV2OrderId) {
        const idx = orders.findIndex((x) => x.id === editingV2OrderId);
        if (idx < 0) return v2Show(orderMsg, "找不到訂單");
        const existingOrder = orders[idx];
        const orderId = existingOrder.id;
        const orderNoDisplay = existingOrder.order_no || orderNo;
        const oldItems = existingOrder.items || [];
        const oldItemQty = {};
        for (const line of oldItems) {
          const id = String(line.item_id ?? line.id ?? "").trim();
          if (!id) continue;
          oldItemQty[id] = (oldItemQty[id] || 0) + (Number(line.qty) || 0);
        }
        const newItemQty = {};
        for (const line of orderLineItems) {
          const id = String(line.item_id ?? line.id ?? "").trim();
          if (!id) continue;
          newItemQty[id] = (newItemQty[id] || 0) + (Number(line.qty) || 0);
        }
        /* 1. 先加回：被移除或數量減少的明細（庫存 +1 等） */
        for (const [item_id, oldQty] of Object.entries(oldItemQty)) {
          const newQty = newItemQty[item_id] || 0;
          const returnQty = oldQty - newQty;
          if (returnQty > 0) {
            const res = DK.addLedgerEntry({ item_id, type: "IN", qty: returnQty, ref_type: "ORDER", ref_id: orderId, note: "訂單編輯移除明細 " + orderNoDisplay });
            if (!res.ok) {
              v2Show(orderMsg, "加回庫存失敗：" + (res.error || item_id));
              return;
            }
          }
        }
        /* 2. 再扣庫存：新增或數量增加的明細 */
        for (const [item_id, newQty] of Object.entries(newItemQty)) {
          const oldQty = oldItemQty[item_id] || 0;
          const deductQty = newQty - oldQty;
          if (deductQty > 0) {
            const item = DK.findItemById(item_id);
            const onHand = Number(item?.qty_on_hand) || 0;
            if (deductQty > onHand) {
              v2Show(orderMsg, "庫存不足：" + (item?.sku || item_id) + " 現有 " + onHand + "，需扣 " + deductQty);
              return;
            }
            const res = DK.addLedgerEntry({ item_id, type: "OUT", qty: deductQty, ref_type: "ORDER", ref_id: orderId, note: "訂單編輯新增明細 " + orderNoDisplay });
            if (!res.ok) {
              v2Show(orderMsg, "扣庫存失敗：" + (res.error || item?.sku || item_id));
              return;
            }
          }
        }
        orders[idx] = { ...existingOrder, ...payload, id: orderId, updated_at: nowISO() };
        DK.saveOrders(orders);
        v2Show(orderMsg, "已更新（庫存已同步）");
        // 只有訂單狀態為「已完成」才回寫客戶成交（避免未完成就把客戶改成成交）
        const statusNow = String(document.getElementById("orderStatus")?.value || payload.status || "").trim();
        if (statusNow === "completed" || statusNow === "已完成") {
          tryMarkLinkedCustomerAsWon();
        }
      } else {
        /* 新增訂單：庫存為 0 的品項不能成立訂單 */
        for (const line of orderLineItems) {
          const item = DK.findItemById(line.item_id);
          const onHand = Number(item?.qty_on_hand) || 0;
          const need = Number(line.qty) || 0;
          if (onHand === 0) return v2Show(orderMsg, "品項「" + (line.sku || line.name) + "」庫存為 0，無法成立訂單");
          if (need > onHand) return v2Show(orderMsg, "品項「" + (line.sku || line.name) + "」庫存不足（現有 " + onHand + "，需要 " + need + "）");
        }
        payload.id = "ord-" + Date.now();
        /* 先扣庫存，全部成功後再存訂單，避免訂單已存但庫存未扣 */
        for (let i = 0; i < orderLineItems.length; i++) {
          const line = orderLineItems[i];
          const res = DK.addLedgerEntry({ item_id: line.item_id, type: "OUT", qty: line.qty, ref_type: "ORDER", ref_id: payload.id, note: "訂單 " + orderNo });
          if (!res.ok) {
            v2Show(orderMsg, "扣庫存失敗：" + (res.error || line.sku));
            return;
          }
        }
        orders.unshift(payload);
        DK.saveOrders(orders);
        v2Show(orderMsg, "已新增並已扣庫存");
        // 只有訂單狀態為「已完成」才回寫客戶成交（避免未完成就把客戶改成成交）
        const statusNow = String(document.getElementById("orderStatus")?.value || payload.status || "").trim();
        if (statusNow === "completed" || statusNow === "已完成") {
          tryMarkLinkedCustomerAsWon();
        }
      }
      renderV2Orders();
      renderV2Items();
      renderV2Reports();
      setTimeout(() => { if (orderForm) orderForm.hidden = true; editingV2OrderId = null; v2Hide(orderMsg); }, 800);
      } finally {
        g._suppressV2Sync = false;
        const syncP = typeof g.__syncV2ToSupabase === "function" ? g.__syncV2ToSupabase() : null;
        if (syncP) {
          const result = await syncP;
          showSyncToast(result, "訂單");
        }
      }
    });

    makeSearchableItemSelect("orderLineItem", "orderLineItemSearch", "orderLineItemDropdown", { showQty: true, showCost: true });
    makeSearchableItemSelect("ledgerItemId", "ledgerItemIdSearch", "ledgerItemIdDropdown");

    const restockForm = document.getElementById("restockForm");
    const restockMsg = document.getElementById("restockMsg");
    makeSearchableItemSelect("restockItemId", "restockItemSearch", "restockItemDropdown", {
      showQty: true,
      showCost: true,
      onPick: (itemId) => {
        const item = DK.findItemById(itemId);
        if (item) {
          const costEl = document.getElementById("restockUnitCost");
          if (costEl && (item.cost_unit != null && item.cost_unit !== "")) costEl.value = item.cost_unit;
          const dateEl = document.getElementById("restockInboundDate");
          if (dateEl) dateEl.value = item.inbound_date ? String(item.inbound_date).slice(0, 10) : todayStr();
        }
      }
    });
    document.getElementById("btnRestock")?.addEventListener("click", () => {
      const sel = document.getElementById("restockItemId");
      if (sel) sel.innerHTML = '<option value="">— 選擇品項 —</option>' + DK.getItems().map((i) => `<option value="${v2Esc(i.id)}">${v2Esc(i.name || "")}</option>`).join("");
      sel.value = "";
      const inp = document.getElementById("restockItemSearch");
      if (inp) inp.value = "";
      document.getElementById("restockQty").value = "1";
      document.getElementById("restockUnitCost").value = "";
      document.getElementById("restockInboundDate").value = todayStr();
      if (restockForm) restockForm.hidden = false;
      v2Hide(restockMsg);
    });
    document.getElementById("restockSubmit")?.addEventListener("click", () => {
      const itemId = document.getElementById("restockItemId")?.value;
      const qty = parseInt(document.getElementById("restockQty")?.value, 10);
      const unitCost = parseFloat(document.getElementById("restockUnitCost")?.value) || 0;
      const inboundDate = document.getElementById("restockInboundDate")?.value || "";
      if (!itemId) return v2Show(restockMsg, "請選擇品項");
      if (!Number.isFinite(qty) || qty <= 0) return v2Show(restockMsg, "數量需大於 0");
      if (unitCost < 0) return v2Show(restockMsg, "請填單位成本");
      const result = DK.addLedgerEntry({ item_id: itemId, type: "IN", qty, unit_cost: unitCost, ref_type: "PURCHASE", ref_id: "", note: "補貨", inbound_date: inboundDate || undefined });
      if (!result.ok) return v2Show(restockMsg, result.error || "入庫失敗");
      v2Show(restockMsg, "已入庫，入庫日已更新");
      if (result.syncPromise) result.syncPromise.then((r) => showSyncToast(r, "補貨"));
      renderV2Items();
      renderV2Ledger();
      if (restockForm) restockForm.hidden = true;
      setTimeout(() => { v2Hide(restockMsg); }, 1500);
    });
    document.getElementById("restockGoNew")?.addEventListener("click", () => {
      if (restockForm) restockForm.hidden = true;
      openV2ItemEditor(null);
    });

    const expensesTbody = document.getElementById("expensesTbody");
    const expenseForm = document.getElementById("expenseForm");
    const expenseMsg = document.getElementById("expenseMsg");
    function renderV2Expenses() {
      if (!expensesTbody) return;
      const list = DK.getExpenses();
      const pageInfo = paginateV2(list, expensesPage, V2_PAGE_SIZE);
      expensesPage = pageInfo.page;
      expensesTbody.innerHTML = pageInfo.pageItems.map((e) => `<tr><td>${v2Esc(e.date)}</td><td>${v2Esc(EXPENSE_TYPE_LABEL[e.type] || e.type)}</td><td>${v2Esc(e.category)}</td><td>${v2FmtNum(e.amount)}</td><td class="muted">${v2Esc(e.note)}</td><td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-del-expense" data-id="${v2Esc(e.id)}">刪除</button></td></tr>`).join("");
      expensesTbody.querySelectorAll(".btn-del-expense").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (!confirm("確定刪除？")) return;
          const id = btn.getAttribute("data-id");
          const rows = DK.getExpenses().filter((x) => x.id !== id);
          const syncP = DK.saveExpenses(rows);
          if (syncP) syncP.then((r) => showSyncToast(r, "支出刪除"));
          renderV2Expenses();
          renderV2Reports();
        });
      });

      const pager = document.getElementById("expensesPagination");
      if (pager) {
        const cur = pageInfo.page;
        const totalPages = pageInfo.totalPages;
        const total = pageInfo.total;
        let html = `<span class="pagination-info">共 ${total} 筆，第 ${cur} / ${totalPages} 頁</span>`;
        if (totalPages > 1) {
          html += `<span class="pagination-btns"><button type="button" class="btn btn-ghost btn-sm page-btn prev" data-page="${cur - 1}" ${cur <= 1 ? "disabled" : ""}>上一頁</button>`;
          for (let p = 1; p <= totalPages; p++) {
            const active = p === cur ? " current" : "";
            html += `<button type="button" class="btn btn-ghost btn-sm page-btn${active}" data-page="${p}">${p}</button>`;
          }
          html += `<button type="button" class="btn btn-ghost btn-sm page-btn next" data-page="${cur + 1}" ${cur >= totalPages ? "disabled" : ""}>下一頁</button></span>`;
        }
        pager.innerHTML = html;
      }
    }
    document.getElementById("btnNewExpense")?.addEventListener("click", () => {
      document.getElementById("expenseDate").value = todayStr();
      document.getElementById("expenseType").value = "OPEX";
      document.getElementById("expenseCategory").value = "";
      document.getElementById("expenseAmount").value = "";
      document.getElementById("expenseNote").value = "";
      if (expenseForm) expenseForm.hidden = false;
      v2Hide(expenseMsg);
    });
    document.getElementById("expenseCancel")?.addEventListener("click", () => { if (expenseForm) expenseForm.hidden = true; v2Hide(expenseMsg); });
    document.getElementById("expenseSave")?.addEventListener("click", () => {
      const date = document.getElementById("expenseDate")?.value;
      const amount = parseFloat(document.getElementById("expenseAmount")?.value);
      if (!date) return v2Show(expenseMsg, "請選日期");
      if (!Number.isFinite(amount) || amount < 0) return v2Show(expenseMsg, "請填金額");
      const rows = DK.getExpenses();
      rows.unshift({ id: "ex-" + Date.now(), date, type: document.getElementById("expenseType")?.value, category: document.getElementById("expenseCategory")?.value || "", amount, note: document.getElementById("expenseNote")?.value || "", ref_item_id: "", created_at: nowISO() });
      const syncP = DK.saveExpenses(rows);
      v2Show(expenseMsg, "已新增");
      if (syncP) syncP.then((r) => showSyncToast(r, "支出"));
      renderV2Expenses();
      renderV2Reports();
      setTimeout(() => { if (expenseForm) expenseForm.hidden = true; v2Hide(expenseMsg); }, 800);
    });

    const reportPeriodBtns = document.querySelectorAll(".report-period-btn");
    const reportCustomMonth = document.getElementById("reportCustomMonth");
    const reportCustomYear = document.getElementById("reportCustomYear");
    const reportMonthYearEl = document.getElementById("reportMonthYear");
    const reportMonthMonthEl = document.getElementById("reportMonthMonth");
    const reportYearYearEl = document.getElementById("reportYearYear");

    function fillReportPeriodOptions() {
      const currentYear = new Date().getFullYear();
      const years = [];
      for (let y = currentYear; y >= currentYear - 10; y--) years.push(y);
      if (reportMonthYearEl) reportMonthYearEl.innerHTML = years.map((y) => `<option value="${y}"${y === currentYear ? " selected" : ""}>${y} 年</option>`).join("");
      if (reportYearYearEl) reportYearYearEl.innerHTML = years.map((y) => `<option value="${y}"${y === currentYear ? " selected" : ""}>${y} 年</option>`).join("");
      const currentMonth = new Date().getMonth() + 1;
      if (reportMonthMonthEl) reportMonthMonthEl.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}"${m === currentMonth ? " selected" : ""}>${m} 月</option>`).join("");
    }
    function getReportQueryParams() {
      const period = document.querySelector(".report-period-btn.active")?.getAttribute("data-period") || "week";
      if (period === "week") {
        const w = DK.reportWeeklySummary();
        return { fromStr: w.weekFrom, toStr: w.weekTo, label: "本週" };
      }
      if (period === "month") {
        const m = DK.reportMonthlySummary();
        return { fromStr: m.monthFrom, toStr: m.monthTo, label: "本月" };
      }
      if (period === "customMonth" && reportMonthYearEl && reportMonthMonthEl) {
        const y = parseInt(reportMonthYearEl.value, 10);
        const m = parseInt(reportMonthMonthEl.value, 10);
        const fromStr = `${y}-${String(m).padStart(2, "0")}-01`;
        const toStr = `${y}-${String(m).padStart(2, "0")}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
        return { fromStr, toStr, label: `${y}年${m}月` };
      }
      if (period === "customYear" && reportYearYearEl) {
        const y = parseInt(reportYearYearEl.value, 10);
        return { fromStr: `${y}-01-01`, toStr: `${y}-12-31`, label: `${y}年` };
      }
      const w = DK.reportWeeklySummary();
      return { fromStr: w.weekFrom, toStr: w.weekTo, label: "本週" };
    }

    function renderV2Reports() {
      const params = getReportQueryParams();
      const summary = DK.reportSummaryByDateRange(params.fromStr, params.toStr);
      const elResult = document.getElementById("reportQueryResult");
      if (elResult) elResult.innerHTML = `<div><strong>${params.label} ${summary.fromStr} ~ ${summary.toStr}</strong></div><div>訂單毛利合計：NT$ ${v2FmtNum(summary.ordersProfit)}（${summary.ordersCount} 筆）</div><div>支出合計：NT$ ${v2FmtNum(summary.expensesTotal)}（${summary.expensesCount} 筆）</div><div>庫存總成本：NT$ ${v2FmtNum(summary.inventoryValue)}</div>`;
      // 庫齡排行前 20（滯留天數最多）：只顯示目前仍有庫存（qty_on_hand > 0）
      // ⚠ 只改此排行榜的顯示用資料，不動 DK 的其他報表/排序邏輯
      const top20 = (DK.getEnrichedItems ? DK.getEnrichedItems() : [])
        .filter((x) => x.idle_days != null)
        .filter((x) => Number(x.qty_on_hand || 0) > 0)
        .sort((a, b) => (b.idle_days ?? 0) - (a.idle_days ?? 0))
        .slice(0, 20);
      const elTop20 = document.getElementById("reportTop20");
      if (elTop20) elTop20.innerHTML = top20.length ? `<table class="table"><thead><tr><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${top20.map((x) => { const nameSpec = (x.name === x.spec || !String(x.spec || "").trim()) ? (x.name || x.spec || "") : [x.name, x.spec].filter(Boolean).join(" ").trim(); return `<tr><td>${v2Esc(nameSpec)}</td><td>${v2Esc(x.category)}</td><td>${x.idle_days}</td><td>${v2FmtNum(x.inventory_value)}</td></tr>`; }).join("")}</tbody></table>` : "<p class=\"muted\">無資料</p>";
      const testingPrep = DK.reportTestingPrep();
      const elTesting = document.getElementById("reportTestingPrep");
      if (elTesting) elTesting.innerHTML = testingPrep.length ? `<table class="table"><thead><tr><th>名稱</th><th>狀態</th><th>數量</th></tr></thead><tbody>${testingPrep.map((x) => `<tr><td>${v2Esc(x.name)}</td><td>${v2Esc(STATUS_LABEL[x.status] || x.status)}</td><td>${x.qty_on_hand}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">無</p>";
      const clearance = DK.reportClearance();
      const elClear = document.getElementById("reportClearance");
      if (elClear) elClear.innerHTML = clearance.length ? `<table class="table"><thead><tr><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${clearance.map((x) => `<tr><td>${v2Esc(x.name)}</td><td>${v2Esc(x.category)}</td><td>${x.idle_days}</td><td>${v2FmtNum(x.inventory_value)}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">無</p>";
    }
    reportPeriodBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        reportPeriodBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (reportCustomMonth) reportCustomMonth.style.display = (btn.getAttribute("data-period") === "customMonth") ? "flex" : "none";
        if (reportCustomYear) reportCustomYear.style.display = (btn.getAttribute("data-period") === "customYear") ? "flex" : "none";
        renderV2Reports();
      });
    });
    reportMonthYearEl?.addEventListener("change", renderV2Reports);
    reportMonthMonthEl?.addEventListener("change", renderV2Reports);
    reportYearYearEl?.addEventListener("change", renderV2Reports);

    function csvCell(v) {
      const s = v == null ? "" : String(v);
      if (/[,"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    function exportReportCSV() {
      const params = getReportQueryParams();
      const summary = DK.reportSummaryByDateRange(params.fromStr, params.toStr);
      const orders = (DK.getOrdersInDateRange && DK.getOrdersInDateRange(params.fromStr, params.toStr)) || DK.getOrders();
      const enrichedOrders = orders.map((o) => DK.enrichOrder(o));
      const headers = ["報表類型", "期間", "訂單毛利合計", "訂單筆數", "支出合計", "支出筆數", "庫存總成本"];
      const rows = [[params.label, `${summary.fromStr} ~ ${summary.toStr}`, summary.ordersProfit, summary.ordersCount, summary.expensesTotal, summary.expensesCount, summary.inventoryValue]];
      let csv = "\uFEFF" + headers.join(",") + "\n";
      rows.forEach((r) => { csv += r.map(csvCell).join(",") + "\n"; });
      csv += "\n訂單明細（查詢區間內）\n";
      csv += "訂單編號,客戶,售價,運費,折扣,成本,毛利,毛利率,狀態,日期\n";
      enrichedOrders.forEach((o) => {
        const margin = o.gross_margin != null ? (o.gross_margin * 100).toFixed(1) + "%" : "";
        csv += [o.order_no, o.customer_name, o.total_sale ?? "", o.shipping_income ?? "", o.discount ?? "", o.cogs_total ?? "", o.gross_profit ?? "", margin, o.status ?? "", getOrderDateStr(o)].map(csvCell).join(",") + "\n";
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "報表_" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    document.getElementById("btnExportReport")?.addEventListener("click", exportReportCSV);

    document.getElementById("itemsPagination")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-page]");
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.getAttribute("data-page"), 10);
      if (!Number.isFinite(page)) return;
      itemsPage = page;
      renderV2Items();
    });
    document.getElementById("ledgerPagination")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-page]");
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.getAttribute("data-page"), 10);
      if (!Number.isFinite(page)) return;
      ledgerPage = page;
      renderV2Ledger();
    });
    document.getElementById("ordersPagination")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-page]");
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.getAttribute("data-page"), 10);
      if (!Number.isFinite(page)) return;
      ordersPage = page;
      renderV2Orders();
    });
    document.getElementById("expensesPagination")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button[data-page]");
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.getAttribute("data-page"), 10);
      if (!Number.isFinite(page)) return;
      expensesPage = page;
      renderV2Expenses();
    });

    window.__adminV2Refresh = function () {
      const active = document.querySelector(".v2-tab.active");
      const name = (active && active.getAttribute("data-v2")) || "items";
      switchV2Tab(name);
    };
    fillV2CategoryOptions();
    fillReportPeriodOptions();
    var activeV2 = document.querySelector(".v2-tab.active");
    var currentName = (activeV2 && activeV2.getAttribute("data-v2")) || "items";
    switchV2Tab(currentName);
    window.__adminV2DKInitialized = true;
    return true;
  }

  function tryInitV2DK(retriesLeft) {
    if (retriesLeft == null) retriesLeft = 40;
    if (runV2DKBlock()) return;
    if (retriesLeft <= 0) {
      console.warn("admin3: DK 未就緒，庫存+記帳（報表/訂單查詢）可能無法使用，請重新整理頁面。");
      return;
    }
    if (document.readyState !== "complete") {
      document.addEventListener("DOMContentLoaded", function onReady() {
        document.removeEventListener("DOMContentLoaded", onReady);
        if (runV2DKBlock()) return;
        setTimeout(function () { tryInitV2DK(retriesLeft - 1); }, 150);
      });
      return;
    }
    setTimeout(function () { tryInitV2DK(retriesLeft - 1); }, 150);
  }
  tryInitV2DK();

  // ---------- init ----------
  applyAuthUI();
  if (window.DK?.isAdminAuthed?.()) {
    const saved = (function () { try { return localStorage.getItem("dk_admin_active_tab"); } catch (_) { return null; } })();
    if (saved === "publish" || saved === "inv" || saved === "frontend" || saved === "vendors" || saved === "purchase" || saved === "customers") switchTab(saved);
    else switchTab("inv");
  }
})();

