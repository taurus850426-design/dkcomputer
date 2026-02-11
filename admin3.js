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
  const tabs = Array.from(document.querySelectorAll(".tab[data-tab]"));
  const tabInv = document.getElementById("tab-inv");
  const tabPublish = document.getElementById("tab-publish");
  const tabFrontend = document.getElementById("tab-frontend");

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
  const publishQty = document.getElementById("publishQty");
  const publishProductName = document.getElementById("publishProductName");
  const publishCategory = document.getElementById("publishCategory");
  const publishSpecSummary = document.getElementById("publishSpecSummary");
  const publishTotalCost = document.getElementById("publishTotalCost");
  const publishPrice = document.getElementById("publishPrice");
  const publishPhotosInput = document.getElementById("publishPhotosInput");
  const publishPhotoStrip = document.getElementById("publishPhotoStrip");
  const publishPhotoHint = document.getElementById("publishPhotoHint");
  const PUBLISH_SPECS = [
    { key: "cpu", category: "處理器", prefix: "CPU", selectId: "publishCpu", customId: "publishCpuCustom", infoId: "publishCpuInfo", conditionId: "publishCpuCondition", remarkId: "publishCpuRemark", priceId: "publishCpuPrice" },
    { key: "mb", category: "主機板", prefix: "MB", selectId: "publishMb", customId: "publishMbCustom", infoId: "publishMbInfo", conditionId: "publishMbCondition", remarkId: "publishMbRemark", priceId: "publishMbPrice" },
    { key: "ram", category: "記憶體", prefix: "RAM", selectId: "publishRam", customId: "publishRamCustom", infoId: "publishRamInfo", conditionId: "publishRamCondition", remarkId: "publishRamRemark", priceId: "publishRamPrice" },
    { key: "hdd", category: "硬碟", prefix: "HDD", selectId: "publishHdd", customId: "publishHddCustom", infoId: "publishHddInfo", conditionId: "publishHddCondition", remarkId: "publishHddRemark", priceId: "publishHddPrice" },
    { key: "vga", category: "顯示卡", prefix: "VGA", selectId: "publishVga", customId: "publishVgaCustom", infoId: "publishVgaInfo", conditionId: "publishVgaCondition", remarkId: "publishVgaRemark", priceId: "publishVgaPrice" },
    { key: "psu", category: "電源供應器", prefix: "PSU", selectId: "publishPsu", customId: "publishPsuCustom", infoId: "publishPsuInfo", conditionId: "publishPsuCondition", remarkId: "publishPsuRemark", priceId: "publishPsuPrice" },
    { key: "case", category: "機殼", prefix: "CASE", selectId: "publishCase", customId: "publishCaseCustom", infoId: "publishCaseInfo", conditionId: "publishCaseCondition", remarkId: "publishCaseRemark", priceId: "publishCasePrice" },
    { key: "monitor", category: "螢幕", prefix: "MON", selectId: "publishMonitor", customId: "publishMonitorCustom", infoId: "publishMonitorInfo", conditionId: "publishMonitorCondition", remarkId: "publishMonitorRemark", priceId: "publishMonitorPrice" },
    { key: "os", category: "作業系統", prefix: "OS", selectId: "publishOs", customId: "publishOsCustom", infoId: "publishOsInfo", conditionId: "publishOsCondition", remarkId: "publishOsRemark", priceId: "publishOsPrice" },
  ];

  if (!loginCard || !panel) return;

  // ---------- state ----------
  let editingWebId = null;
  let publishPhotos = []; // data URLs

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

  function applyAuthUI() {
    const authed = window.DK?.isAdminAuthed?.() === true;
    loginCard.hidden = authed;
    panel.hidden = !authed;
    logoutBtn.hidden = !authed;
  }

  function switchTab(name) {
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === name);
    if (tabInv) tabInv.hidden = name !== "inv";
    if (tabPublish) tabPublish.hidden = name !== "publish";
    if (tabFrontend) tabFrontend.hidden = name !== "frontend";
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
    const { maxW = 1280, maxH = 1280, quality = 0.82 } = opts;
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

  const publishSpecPrices = {};
  function setPublishSpecPrice(key, val) {
    publishSpecPrices[key] = val;
  }
  function updatePublishSpecInfo() {}
  function updatePublishTotalCost() {
    const total = Object.values(publishSpecPrices).reduce((s, v) => s + (Number(v) || 0), 0);
    const el = document.getElementById("publishTotalCost");
    if (el) el.textContent = "NT$ " + (total || 0).toLocaleString("zh-TW");
  }
  function updatePublishSalePrice() {
    const total = Object.values(publishSpecPrices).reduce((s, v) => s + (Number(v) || 0), 0);
    const el = document.getElementById("publishPrice");
    if (el) el.value = String(total || 0);
  }

  function renderPublishPhotoStrip() {
    if (!publishPhotoStrip) return;
    publishPhotoStrip.innerHTML = publishPhotos.map((url, i) => `<span class="photo-thumb"><img src="${escapeHtml(url)}" alt="" /><button type="button" class="btn-remove-photo" data-i="${i}">×</button></span>`).join("");
    publishPhotoStrip.querySelectorAll(".btn-remove-photo").forEach((btn) => {
      btn.addEventListener("click", () => {
        publishPhotos.splice(Number(btn.getAttribute("data-i")), 1);
        renderPublishPhotoStrip();
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
      return `<div class="publish-web-card" data-id="${escapeHtml(it.id)}">
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
  }

  function openPublishEditor(webId) {
    editingWebId = webId || null;
    const items = window.DK?.getInventory?.() || [];
    const it = webId ? items.find((x) => x.id === webId) : null;
    if (publishEditorTitle) publishEditorTitle.textContent = it ? "編輯：" + (it.name || it.id) : "";
    if (webEditName) webEditName.value = it?.name ?? "";
    if (webEditCategory) webEditCategory.value = it?.category ?? "文書";
    if (webEditStockStatus) webEditStockStatus.value = it?.stockStatus ?? "現貨";
    if (webEditPrice) webEditPrice.value = it?.price ?? "";
    if (webEditQty) webEditQty.value = it?.qty ?? it?.stock ?? 1;
    if (webEditNote) webEditNote.value = it?.note ?? "";
    if (publishEditor) publishEditor.hidden = false;
    if (publishEditorMsg) publishEditorMsg.hidden = true;
  }

  function closePublishEditor() {
    if (publishEditor) publishEditor.hidden = true;
    editingWebId = null;
  }

  function savePublishEditor() {
    if (!editingWebId) return;
    const items = window.DK?.getInventory?.() || [];
    const idx = items.findIndex((x) => x.id === editingWebId);
    if (idx < 0) return;
    items[idx] = {
      ...items[idx],
      name: webEditName?.value?.trim() ?? items[idx].name,
      category: webEditCategory?.value ?? items[idx].category,
      stockStatus: webEditStockStatus?.value ?? items[idx].stockStatus,
      price: Number(webEditPrice?.value) || items[idx].price,
      qty: Number(webEditQty?.value) ?? items[idx].qty,
      note: webEditNote?.value?.trim() ?? items[idx].note,
    };
    window.DK?.saveInventory?.(items);
    if (window.DK?.upsertInventoryItemToSupabase) {
      window.DK.upsertInventoryItemToSupabase(items[idx]).catch(function () {});
    }
    show(publishEditorMsg, "已儲存");
    if (publishEditorMsg) publishEditorMsg.hidden = false;
    renderPublish();
    setTimeout(() => { closePublishEditor(); hide(publishEditorMsg); }, 800);
  }

  function removeFromWeb(webId) {
    const items = (window.DK?.getInventory?.() || []).filter((x) => x.id !== webId);
    window.DK?.saveInventory?.(items);
    if (window.DK?.deleteInventoryItemFromSupabase) {
      window.DK.deleteInventoryItemFromSupabase(webId).catch(function () {});
    }
    renderPublish();
    closePublishEditor();
  }

  function submitPublish() {
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
    const item = {
      id,
      name,
      category,
      stockStatus: "現貨",
      price: price || 0,
      tags: [],
      note: document.getElementById("publishSpecSummary")?.value?.trim() ?? "",
      photos: [...publishPhotos],
    };
    const items = window.DK?.getInventory?.() || [];
    items.push(item);
    window.DK?.saveInventory?.(items);
    if (window.DK?.upsertInventoryItemToSupabase) {
      window.DK.upsertInventoryItemToSupabase(item).catch(function () {});
    }
    publishPhotos.length = 0;
    renderPublishPhotoStrip();
    if (publishFormCard) publishFormCard.hidden = true;
    show(publishMsg, "已上架：" + name);
    if (publishMsg) publishMsg.hidden = false;
    renderPublish();
    setTimeout(() => hide(publishMsg), 3000);
  }

  for (const t of tabs) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }

  function doLogin() {
    hide(loginError);
    const cfg = window.DK?.getConfig?.() || {};
    const u = String(usernameEl?.value || "").trim();
    const p = String(passwordEl?.value || "");
    if (cfg?.admin && u === cfg.admin.username && p === cfg.admin.password) {
      window.DK?.setAdminAuthed?.(true);
      applyAuthUI();
      switchTab("inv");
      return;
    }
    show(loginError, "帳號或密碼錯誤。");
  }

  loginBtn?.addEventListener("click", doLogin);
  passwordEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  logoutBtn?.addEventListener("click", () => {
    window.DK?.setAdminAuthed?.(false);
    applyAuthUI();
  });

  // publish events
  publishSubmitBtn?.addEventListener("click", () => {
    if (publishFormCard) publishFormCard.hidden = false;
    publishFormCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("publishConfirmBtn")?.addEventListener("click", submitPublish);
  publishEditorCloseBtn?.addEventListener("click", closePublishEditor);
  webEditSaveBtn?.addEventListener("click", savePublishEditor);
  webEditOffBtn?.addEventListener("click", () => {
    if (editingWebId && confirm("確定下架此商品？")) {
      removeFromWeb(editingWebId);
      closePublishEditor();
    }
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
        const url = await fileToCompressedDataUrl(file);
        publishPhotos.push(url);
      }
      renderPublishPhotoStrip();
      hide(publishMsg);
    } catch (e) {
      show(publishMsg, "相片處理失敗：" + (e && e.message ? e.message : String(e)));
    }
    publishPhotosInput.value = "";
  });
  for (const spec of PUBLISH_SPECS) {
    const sel = document.getElementById(spec.selectId);
    const custom = document.getElementById(spec.customId);
    sel?.addEventListener("change", () => {
      if (custom) custom.value = "";
      const opt = sel.options[sel.selectedIndex];
      if (opt?.value && opt.dataset.cost != null) setPublishSpecPrice(spec.key, Number(opt.dataset.cost) || 0);
      else setPublishSpecPrice(spec.key, "");
      updatePublishSpecInfo(spec.key);
      updatePublishTotalCost();
      updatePublishSalePrice();
    });
    custom?.addEventListener("input", () => {
      if (custom?.value?.trim()) sel.value = "";
      setPublishSpecPrice(spec.key, "");
      updatePublishSpecInfo(spec.key);
      updatePublishTotalCost();
      updatePublishSalePrice();
    });
    const priceEl = spec.priceId ? document.getElementById(spec.priceId) : null;
    priceEl?.addEventListener("input", updatePublishSalePrice);
  }

  // ---------- frontend (前台管理) ----------
  function loadFrontendForm() {
    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const def = window.DK?.DEFAULT_CONFIG?.frontend || {};
    document.getElementById("feSiteTitle").value = cfg.siteTitle ?? "";
    document.getElementById("feBrandMark").value = cfg.brand?.mark ?? "";
    document.getElementById("feBrandTitle").value = cfg.brand?.title ?? "";
    document.getElementById("feBrandSubtitle").value = cfg.brand?.subtitle ?? "";
    document.getElementById("feHeroTagline").value = fe.heroTagline ?? def.heroTagline ?? "";
    document.getElementById("feHeroSub").value = fe.heroSub ?? def.heroSub ?? "";
    document.getElementById("feHeroBtn1").value = fe.heroBtn1 ?? def.heroBtn1 ?? "";
    document.getElementById("feHeroBtn2").value = fe.heroBtn2 ?? def.heroBtn2 ?? "";
    document.getElementById("feHeroBtn3").value = fe.heroBtn3 ?? def.heroBtn3 ?? "";
    document.getElementById("feTrustTitle").value = fe.trustTitle ?? def.trustTitle ?? "";
    document.getElementById("feTrustItems").value = Array.isArray(fe.trustItems) ? fe.trustItems.join("\n") : (def.trustItems || []).join("\n");
    document.getElementById("feTrustNote").value = fe.trustNote ?? def.trustNote ?? "";
    document.getElementById("feContactTitle").value = fe.contactTitle ?? def.contactTitle ?? "";
    document.getElementById("feContactSub").value = fe.contactSub ?? def.contactSub ?? "";
    document.getElementById("feMachinePageTitle").value = fe.machinePageTitle ?? def.machinePageTitle ?? "";
    document.getElementById("feMachinePageSub").value = fe.machinePageSub ?? def.machinePageSub ?? "";
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
    const msg = document.getElementById("frontendMsg");
    if (msg) msg.hidden = true;
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
        heroTagline: document.getElementById("feHeroTagline").value?.trim(),
        heroSub: document.getElementById("feHeroSub").value?.trim(),
        heroBtn1: document.getElementById("feHeroBtn1").value?.trim(),
        heroBtn2: document.getElementById("feHeroBtn2").value?.trim(),
        heroBtn3: document.getElementById("feHeroBtn3").value?.trim(),
        trustTitle: document.getElementById("feTrustTitle").value?.trim(),
        trustItems: trustItems.length > 0 ? trustItems : (cfg.frontend?.trustItems || []),
        trustNote: document.getElementById("feTrustNote").value?.trim(),
        contactTitle: document.getElementById("feContactTitle").value?.trim(),
        contactSub: document.getElementById("feContactSub").value?.trim(),
        machinePageTitle: document.getElementById("feMachinePageTitle").value?.trim(),
        machinePageSub: document.getElementById("feMachinePageSub").value?.trim(),
        catImages: cfg.frontend?.catImages || {},
      },
      line: {
        ...cfg.line,
        url: document.getElementById("feLineUrl").value?.trim() || cfg.line?.url,
        lineCtaText: document.getElementById("feLineCtaText")?.value?.trim() ?? cfg.line?.lineCtaText,
        footerLineSentence: document.getElementById("feFooterLineSentence")?.value?.trim() ?? cfg.line?.footerLineSentence,
      },
    };
    window.DK?.saveConfig?.(next);
    const msg = document.getElementById("frontendMsg");
    if (msg) {
      msg.hidden = false;
      msg.textContent = "已儲存。重新整理首頁即可看到變更。";
      msg.style.color = "";
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
      img.style.cssText = "max-width:100%;max-height:120px;object-fit:cover;border-radius:8px;";
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

  // ---------- 庫存+記帳 v2 (DK)：渲染與表單 ----------
  if (typeof window.DK !== "undefined") {
    const DK = window.DK;
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
    const itemsStatus = document.getElementById("itemsStatus");
    const itemEditor = document.getElementById("itemEditor");
    const itemMsg = document.getElementById("itemMsg");
    let editingV2ItemId = null;
    const CAT_LABEL = { PC: "電腦", GPU: "顯卡", PART: "零件", CONSUMABLE: "耗材" };
    const STATUS_LABEL = { READY: "可售", TESTING: "待測", PREP: "待整理", RESERVED: "保留", CLEARANCE: "待出清", SCRAP: "報廢拆料" };
    const CONDITION_LABEL = { NEW: "全新", USED: "二手", REFURB: "整新" };
    const LEDGER_TYPE_LABEL = { IN: "入庫", OUT: "出庫", ADJUST: "調整" };
    const REF_TYPE_LABEL = { PURCHASE: "進貨", ORDER: "訂單", RMA: "退換", SCRAP: "報廢", MOVE: "移倉", ADJUST: "調整" };
    const ORDER_STATUS_LABEL = { pending: "待處理", paid: "已付款", shipped: "已出貨", completed: "已完成", refunded: "已退貨" };
    const ORDER_PAYMENT_LABEL = { cash: "現金", transfer: "轉帳", card: "刷卡" };
    const EXPENSE_TYPE_LABEL = { COGS: "銷貨成本", OPEX: "營業費用", OTHER: "其他" };

    function renderV2Items() {
      if (!itemsTbody) return;
      let list = DK.getEnrichedItems();
      const q = (itemsSearch?.value || "").trim().toLowerCase();
      const cat = itemsCategory?.value || "";
      const st = itemsStatus?.value || "";
      if (q) list = list.filter((x) => [x.sku, x.name, x.spec].some((f) => String(f || "").toLowerCase().includes(q)));
      if (cat) list = list.filter((x) => x.category === cat);
      if (st) list = list.filter((x) => x.status === st);
      itemsTbody.innerHTML = list.map((x) => {
        const alert = DK.getItemAlert(x);
        const alertText = alert ? alert.message : "-";
        return `<tr>
          <td><input type="checkbox" class="item-row-cb" data-id="${v2Esc(x.id)}" /></td>
          <td class="nowrap">${v2Esc(x.sku)}</td>
          <td>${v2Esc(x.name)}</td>
          <td>${v2Esc(CAT_LABEL[x.category] || x.category)}</td>
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
    }

    function openV2ItemEditor(id) {
      editingV2ItemId = id || null;
      const item = id ? DK.findItemById(id) : null;
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
      set("itemBrand", "");
      set("itemSku", item ? item.sku : "");
      set("itemCategory", item ? item.category : "PC");
      set("itemName", item ? item.name : "");
      set("itemSpec", item ? item.spec : "");
      set("itemCondition", item ? item.condition : "USED");
      set("itemStatus", item ? item.status : "TESTING");
      set("itemQty", item ? item.qty_on_hand : 0);
      set("itemCost", item ? item.cost_unit : 0);
      set("itemPriceList", item ? item.price_list ?? "" : "");
      set("itemPriceFloor", item ? item.price_floor ?? "" : "");
      set("itemInboundDate", item && item.inbound_date ? item.inbound_date.slice(0, 10) : todayStr());
      set("itemReorderPoint", item ? (item.reorder_point ?? 0) : 0);
      set("itemLocation", item ? item.location ?? "" : "");
      set("itemNotes", item ? item.notes ?? "" : "");
      const skuEl = document.getElementById("itemSku");
      if (skuEl) skuEl.readOnly = !!item;
      const itemDeleteBtn = document.getElementById("itemDelete");
      if (itemDeleteBtn) itemDeleteBtn.hidden = !item;
      if (itemEditor) itemEditor.hidden = false;
      v2Hide(itemMsg);
    }

    function closeV2ItemEditor() {
      if (itemEditor) itemEditor.hidden = true;
      editingV2ItemId = null;
      v2Hide(itemMsg);
    }

    document.getElementById("btnNewItem")?.addEventListener("click", () => openV2ItemEditor(null));
    document.getElementById("itemCancel")?.addEventListener("click", closeV2ItemEditor);
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
          const brandEl = document.getElementById("itemBrand");
          const nameEl = document.getElementById("itemName");
          const specEl = document.getElementById("itemSpec");
          function fillForm(parsed) {
            if (brandEl) brandEl.value = (parsed.brand != null && parsed.brand !== undefined) ? parsed.brand : "";
            if (nameEl) nameEl.value = (parsed.name != null && parsed.name !== undefined) ? parsed.name : "";
            if (specEl) specEl.value = (parsed.spec != null && parsed.spec !== undefined) ? parsed.spec : (barcodeText ? "條碼:" + barcodeText : "");
          }
          if (isBarcodeOnly) {
            setItemScanStatus("正在查詢網路…");
            lookupBarcodeOnline(barcodeOnly).then(function (parsed) {
              if (parsed) {
                fillForm(parsed);
                setItemScanStatus("已從網路帶入，請核對後儲存");
              } else {
                fillForm({ brand: "", name: "", spec: "條碼:" + barcodeOnly });
                setItemScanStatus("僅辨識到條碼，網路查無商品，請手動輸入名稱與規格");
              }
            }).catch(function () {
              fillForm({ brand: "", name: "", spec: "條碼:" + barcodeOnly });
              setItemScanStatus("僅辨識到條碼，網路查詢失敗，請手動輸入名稱與規格");
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
      const brand = String(document.getElementById("itemBrand")?.value || "").trim();
      const sku = String(document.getElementById("itemSku")?.value || "").trim().toUpperCase();
      const nameRaw = String(document.getElementById("itemName")?.value || "").trim();
      const name = brand ? brand + " " + nameRaw : nameRaw;
      if (!sku) return v2Show(itemMsg, "SKU 必填");
      if (!name) return v2Show(itemMsg, "名稱必填");
      const items = DK.getItems();
      const existing = items.find((x) => x.sku.toUpperCase() === sku);
      if (!editingV2ItemId && existing) return v2Show(itemMsg, "SKU 已存在");
      if (editingV2ItemId && existing && existing.id !== editingV2ItemId) return v2Show(itemMsg, "SKU 已存在");
      const payload = {
        sku,
        category: document.getElementById("itemCategory")?.value,
        name,
        spec: document.getElementById("itemSpec")?.value || "",
        condition: document.getElementById("itemCondition")?.value || "USED",
        status: document.getElementById("itemStatus")?.value || "TESTING",
        qty_on_hand: Math.max(0, parseInt(document.getElementById("itemQty")?.value, 10) || 0),
        cost_unit: parseFloat(document.getElementById("itemCost")?.value) || 0,
        price_list: parseFloat(document.getElementById("itemPriceList")?.value) || null,
        price_floor: parseFloat(document.getElementById("itemPriceFloor")?.value) || null,
        inbound_date: document.getElementById("itemInboundDate")?.value || null,
        reorder_point: Math.max(0, parseInt(document.getElementById("itemReorderPoint")?.value, 10) || 0),
        location: document.getElementById("itemLocation")?.value || "",
        notes: document.getElementById("itemNotes")?.value || "",
        updated_at: nowISO(),
      };
      if (editingV2ItemId) {
        const idx = items.findIndex((x) => x.id === editingV2ItemId);
        if (idx < 0) return v2Show(itemMsg, "找不到品項");
        items[idx] = { ...items[idx], ...payload };
        DK.saveItems(items);
        v2Show(itemMsg, "已更新");
      } else {
        payload.id = "i-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
        payload.last_moved_at = payload.inbound_date ? payload.inbound_date + "T12:00:00Z" : null;
        payload.created_at = nowISO();
        items.unshift(payload);
        DK.saveItems(items);
        v2Show(itemMsg, "已新增");
      }
      renderV2Items();
      setTimeout(closeV2ItemEditor, 800);
    });
    itemsSearch?.addEventListener("input", renderV2Items);
    itemsCategory?.addEventListener("change", renderV2Items);
    itemsStatus?.addEventListener("change", renderV2Items);
    document.getElementById("btnDeleteSelectedItems")?.addEventListener("click", () => {
      const checked = document.querySelectorAll("#itemsTbody .item-row-cb:checked");
      const ids = Array.from(checked).map((cb) => cb.getAttribute("data-id")).filter(Boolean);
      if (ids.length === 0) {
        alert("請先勾選要刪除的品項。");
        return;
      }
      if (!confirm("確定要刪除所選的 " + ids.length + " 筆品項？刪除後無法復原。")) return;
      const items = DK.getItems().filter((x) => !ids.includes(x.id));
      DK.saveItems(items);
      renderV2Items();
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
      ledgerTbody.innerHTML = list.slice(0, 100).map((r) => {
        const name = byId[r.item_id] ? (byId[r.item_id].name || byId[r.item_id].sku) : r.item_id;
        return `<tr><td class="nowrap">${v2Esc((r.created_at || "").toString().slice(0, 19))}</td><td>${v2Esc(name)}</td><td>${v2Esc(LEDGER_TYPE_LABEL[r.type] || r.type)}</td><td>${r.qty}</td><td>${v2FmtNum(r.unit_cost)}</td><td>${v2Esc(REF_TYPE_LABEL[r.ref_type] || r.ref_type)}</td><td>${v2Esc(r.ref_id)}</td><td class="muted">${v2Esc(r.note)}</td></tr>`;
      }).join("");
    }
    document.getElementById("btnNewLedger")?.addEventListener("click", () => {
      const sel = document.getElementById("ledgerItemId");
      if (sel) sel.innerHTML = DK.getItems().map((i) => `<option value="${v2Esc(i.id)}">${v2Esc(i.sku)} ${v2Esc(i.name)}</option>`).join("");
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
      renderV2Ledger();
      renderV2Items();
      setTimeout(() => { if (ledgerForm) ledgerForm.hidden = true; v2Hide(ledgerMsg); }, 1000);
    });

    const ordersTbody = document.getElementById("ordersTbody");
    const orderForm = document.getElementById("orderForm");
    const orderMsg = document.getElementById("orderMsg");
    let editingV2OrderId = null;
    function renderV2Orders() {
      if (!ordersTbody) return;
      const list = DK.getOrders().map(DK.enrichOrder);
      ordersTbody.innerHTML = list.map((o) => {
        const margin = o.gross_margin != null ? (o.gross_margin * 100).toFixed(1) + "%" : "-";
        return `<tr><td class="nowrap">${v2Esc(o.order_no)}</td><td>${v2Esc(o.customer_name)}</td><td>${v2FmtNum(o.total_sale)}</td><td>${v2FmtNum(o.shipping_income)}</td><td>${v2FmtNum(o.discount)}</td><td>${v2FmtNum(o.cogs_total)}</td><td>${v2FmtNum(o.gross_profit)}</td><td>${margin}</td><td>${v2Esc(ORDER_STATUS_LABEL[o.status] || o.status)}</td><td class="nowrap">${v2Esc((o.created_at || "").toString().slice(0, 10))}</td><td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-order" data-id="${v2Esc(o.id)}">編輯</button></td></tr>`;
      }).join("");
      ordersTbody.querySelectorAll(".btn-edit-order").forEach((btn) => btn.addEventListener("click", () => openV2OrderEditor(btn.getAttribute("data-id"))));
    }
    function openV2OrderEditor(id) {
      editingV2OrderId = id || null;
      const o = id ? DK.getOrders().find((x) => x.id === id) : null;
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
      set("orderNo", o ? o.order_no : DK.nextOrderNo());
      const orderNoEl = document.getElementById("orderNo");
      if (orderNoEl) orderNoEl.readOnly = !!o;
      set("orderCustomer", o ? o.customer_name ?? "" : "");
      set("orderTotalSale", o ? o.total_sale ?? 0 : 0);
      set("orderShipping", o ? o.shipping_income ?? 0 : 0);
      set("orderDiscount", o ? o.discount ?? 0 : 0);
      set("orderCogs", o ? o.cogs_total ?? 0 : 0);
      set("orderPayment", o ? o.payment_method ?? "transfer" : "transfer");
      set("orderStatus", o ? o.status ?? "pending" : "pending");
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
    ["orderTotalSale", "orderShipping", "orderDiscount", "orderCogs"].forEach((id) => document.getElementById(id)?.addEventListener("input", updateV2OrderGrossDisplay));
    document.getElementById("btnNewOrder")?.addEventListener("click", () => openV2OrderEditor(null));
    document.getElementById("orderCancel")?.addEventListener("click", () => { if (orderForm) orderForm.hidden = true; editingV2OrderId = null; v2Hide(orderMsg); });
    document.getElementById("orderSave")?.addEventListener("click", () => {
      const orderNo = String(document.getElementById("orderNo")?.value || "").trim();
      const totalSale = parseFloat(document.getElementById("orderTotalSale")?.value) || 0;
      const cogsTotal = parseFloat(document.getElementById("orderCogs")?.value) || 0;
      if (!orderNo) return v2Show(orderMsg, "訂單編號必填");
      const orders = DK.getOrders();
      const existing = orders.find((x) => x.order_no === orderNo && x.id !== editingV2OrderId);
      if (existing) return v2Show(orderMsg, "訂單編號重複");
      const payload = { order_no: orderNo, customer_name: document.getElementById("orderCustomer")?.value || "", total_sale: totalSale, shipping_income: parseFloat(document.getElementById("orderShipping")?.value) || 0, discount: parseFloat(document.getElementById("orderDiscount")?.value) || 0, payment_method: document.getElementById("orderPayment")?.value || "transfer", status: document.getElementById("orderStatus")?.value || "pending", cogs_total: cogsTotal, created_at: nowISO() };
      if (editingV2OrderId) {
        const idx = orders.findIndex((x) => x.id === editingV2OrderId);
        if (idx < 0) return v2Show(orderMsg, "找不到訂單");
        orders[idx] = { ...orders[idx], ...payload, updated_at: nowISO() };
        DK.saveOrders(orders);
        v2Show(orderMsg, "已更新");
      } else {
        payload.id = "ord-" + Date.now();
        orders.unshift(payload);
        DK.saveOrders(orders);
        v2Show(orderMsg, "已新增");
      }
      renderV2Orders();
      renderV2Reports();
      setTimeout(() => { if (orderForm) orderForm.hidden = true; editingV2OrderId = null; v2Hide(orderMsg); }, 800);
    });

    const expensesTbody = document.getElementById("expensesTbody");
    const expenseForm = document.getElementById("expenseForm");
    const expenseMsg = document.getElementById("expenseMsg");
    function renderV2Expenses() {
      if (!expensesTbody) return;
      const list = DK.getExpenses();
      expensesTbody.innerHTML = list.slice(0, 100).map((e) => `<tr><td>${v2Esc(e.date)}</td><td>${v2Esc(EXPENSE_TYPE_LABEL[e.type] || e.type)}</td><td>${v2Esc(e.category)}</td><td>${v2FmtNum(e.amount)}</td><td class="muted">${v2Esc(e.note)}</td><td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-del-expense" data-id="${v2Esc(e.id)}">刪除</button></td></tr>`).join("");
      expensesTbody.querySelectorAll(".btn-del-expense").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (!confirm("確定刪除？")) return;
          const id = btn.getAttribute("data-id");
          const rows = DK.getExpenses().filter((x) => x.id !== id);
          DK.saveExpenses(rows);
          renderV2Expenses();
          renderV2Reports();
        });
      });
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
      DK.saveExpenses(rows);
      v2Show(expenseMsg, "已新增");
      renderV2Expenses();
      renderV2Reports();
      setTimeout(() => { if (expenseForm) expenseForm.hidden = true; v2Hide(expenseMsg); }, 800);
    });

    function renderV2Reports() {
      const w = DK.reportWeeklySummary();
      const elWeekly = document.getElementById("reportWeekly");
      if (elWeekly) elWeekly.innerHTML = `<div><strong>本週 ${w.weekFrom} ~ ${w.weekTo}</strong></div><div>訂單毛利合計：NT$ ${v2FmtNum(w.ordersProfit)}（${w.ordersCount} 筆）</div><div>支出合計：NT$ ${v2FmtNum(w.expensesTotal)}（${w.expensesCount} 筆）</div><div>庫存總成本：NT$ ${v2FmtNum(w.inventoryValue)}</div>`;
      const top20 = DK.reportTop20IdleDays();
      const elTop20 = document.getElementById("reportTop20");
      if (elTop20) elTop20.innerHTML = top20.length ? `<table class="table"><thead><tr><th>SKU</th><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${top20.map((x) => `<tr><td>${v2Esc(x.sku)}</td><td>${v2Esc(x.name)}</td><td>${v2Esc(x.category)}</td><td>${x.idle_days}</td><td>${v2FmtNum(x.inventory_value)}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">無資料</p>";
      const testingPrep = DK.reportTestingPrep();
      const elTesting = document.getElementById("reportTestingPrep");
      if (elTesting) elTesting.innerHTML = testingPrep.length ? `<table class="table"><thead><tr><th>SKU</th><th>名稱</th><th>狀態</th><th>數量</th></tr></thead><tbody>${testingPrep.map((x) => `<tr><td>${v2Esc(x.sku)}</td><td>${v2Esc(x.name)}</td><td>${v2Esc(STATUS_LABEL[x.status] || x.status)}</td><td>${x.qty_on_hand}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">無</p>";
      const clearance = DK.reportClearance();
      const elClear = document.getElementById("reportClearance");
      if (elClear) elClear.innerHTML = clearance.length ? `<table class="table"><thead><tr><th>SKU</th><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${clearance.map((x) => `<tr><td>${v2Esc(x.sku)}</td><td>${v2Esc(x.name)}</td><td>${v2Esc(x.category)}</td><td>${x.idle_days}</td><td>${v2FmtNum(x.inventory_value)}</td></tr>`).join("")}</tbody></table>` : "<p class=\"muted\">無</p>";
    }

    window.__adminV2Refresh = function () {
      const active = document.querySelector(".v2-tab.active");
      const name = (active && active.getAttribute("data-v2")) || "items";
      switchV2Tab(name);
    };
    switchV2Tab("items");
  }

  // ---------- init ----------
  applyAuthUI();
  if (window.DK?.isAdminAuthed?.()) {
    switchTab("inv");
  }
})();

