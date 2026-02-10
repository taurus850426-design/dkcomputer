/* admin3.js - 後台 3 大模組：庫存 / 訂單 / 報表（localStorage） */

(function () {
  // ---------- storage ----------
  const KEYS = {
    items: "dk_im_items_v1",
    orders: "dk_im_orders_v1",
    seq: "dk_im_seq_v1",
  };

  const INV_STATUSES = ["在庫", "測試中", "已預定", "已售出", "不良品"];
  const CLEAN_STATUSES = ["未清潔", "已清潔"];
  const SHIP_STATUSES = ["未出貨", "已出貨", "已取消"];

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
    return it?.status === "在庫" ? qty : 0;
  }

  // ---------- DOM ----------
  const loginCard = document.getElementById("loginCard");
  const panel = document.getElementById("panel");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const loginError = document.getElementById("loginError");
  const usernameEl = document.getElementById("username");
  const passwordEl = document.getElementById("password");

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const tabInv = document.getElementById("tab-inv");
  const tabPublish = document.getElementById("tab-publish");
  const tabOrders = document.getElementById("tab-orders");
  const tabReports = document.getElementById("tab-reports");
  const tabFrontend = document.getElementById("tab-frontend");

  // inventory
  const invNewBtn = document.getElementById("invNewBtn");
  const invBatchBtn = document.getElementById("invBatchBtn");
  const invSearch = document.getElementById("invSearch");
  const invStatusFilter = document.getElementById("invStatusFilter");
  const invTbody = document.getElementById("invTbody");
  const invEditor = document.getElementById("invEditor");
  const invEditorTitle = document.getElementById("invEditorTitle");
  const invCloseBtn = document.getElementById("invCloseBtn");
  const invIdPreview = document.getElementById("invIdPreview");
  const invIdPrefix = document.getElementById("invIdPrefix");
  const invIdModel = document.getElementById("invIdModel");
  const invName = document.getElementById("invName");
  const invCategory = document.getElementById("invCategory");
  const invQty = document.getElementById("invQty");
  const invCost = document.getElementById("invCost");
  const invSuggested = document.getElementById("invSuggested");
  const invActual = document.getElementById("invActual");
  const invStatus = document.getElementById("invStatus");
  const invCleaning = document.getElementById("invCleaning");
  const invBatchSource = document.getElementById("invBatchSource");
  const invNote = document.getElementById("invNote");
  const invBench = document.getElementById("invBench");
  const invTemp = document.getElementById("invTemp");
  const invVideoUrl = document.getElementById("invVideoUrl");
  const invSaveBtn = document.getElementById("invSaveBtn");
  const invDeleteBtn = document.getElementById("invDeleteBtn");
  const invMsg = document.getElementById("invMsg");

  const invBatch = document.getElementById("invBatch");
  const invBatchCloseBtn = document.getElementById("invBatchCloseBtn");
  const invBatchText = document.getElementById("invBatchText");
  const invBatchImportBtn = document.getElementById("invBatchImportBtn");
  const invBatchMsg = document.getElementById("invBatchMsg");

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

  // orders
  const ordNewBtn = document.getElementById("ordNewBtn");
  const ordSearch = document.getElementById("ordSearch");
  const ordShipFilter = document.getElementById("ordShipFilter");
  const ordTbody = document.getElementById("ordTbody");
  const ordEditor = document.getElementById("ordEditor");
  const ordEditorTitle = document.getElementById("ordEditorTitle");
  const ordCloseBtn = document.getElementById("ordCloseBtn");
  const ordDate = document.getElementById("ordDate");
  const ordShip = document.getElementById("ordShip");
  const ordCustomer = document.getElementById("ordCustomer");
  const ordItemId = document.getElementById("ordItemId");
  const ordQty = document.getElementById("ordQty");
  const ordPrice = document.getElementById("ordPrice");
  const ordCost = document.getElementById("ordCost");
  const ordProfit = document.getElementById("ordProfit");
  const ordNote = document.getElementById("ordNote");
  const ordSaveBtn = document.getElementById("ordSaveBtn");
  const ordDeleteBtn = document.getElementById("ordDeleteBtn");
  const ordMsg = document.getElementById("ordMsg");

  // reports
  const repRange = document.getElementById("repRange");
  const repRefreshBtn = document.getElementById("repRefreshBtn");
  const repWrap = document.getElementById("repWrap");
  const repInvDist = document.getElementById("repInvDist");
  const repLowThreshold = document.getElementById("repLowThreshold");
  const repLowStock = document.getElementById("repLowStock");
  const repSlow = document.getElementById("repSlow");

  if (!loginCard || !panel) return;

  // ---------- state ----------
  let invState = { q: "", status: "全部" };
  let ordState = { q: "", ship: "全部" };
  let editingInvId = null;
  let editingOrdId = null;
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
    if (tabOrders) tabOrders.hidden = name !== "orders";
    if (tabReports) tabReports.hidden = name !== "reports";
    if (tabFrontend) tabFrontend.hidden = name !== "frontend";
    if (name === "inv") renderInventory();
    if (name === "publish") {
      if (publishFormCard) publishFormCard.hidden = true;
      renderPublish();
    }
    if (name === "orders") renderOrders();
    if (name === "reports") renderReports();
    if (name === "frontend") loadFrontendForm();
  }

  // ---------- inventory ----------
  function getItems() {
    return loadArr(KEYS.items);
  }

  function saveItems(items) {
    saveArr(KEYS.items, items);
  }

  function openInvEditor() {
    if (!invEditor) return;
    invEditor.hidden = false;
    invEditor.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeInvEditor() {
    if (!invEditor) return;
    invEditor.hidden = true;
    hide(invMsg);
  }

  function updateInvIdPreview() {
    if (!invIdPreview) return;
    if (editingInvId) {
      invIdPreview.textContent = editingInvId;
      return;
    }
    const p = sanitizeCode(invIdPrefix?.value) || "ITEM";
    const m = sanitizeCode(invIdModel?.value) || "X";
    invIdPreview.textContent = `${p}-${m}-001（預覽）`;
  }

  function clearInvForm() {
    editingInvId = null;
    if (invDeleteBtn) invDeleteBtn.hidden = true;
    if (invEditorTitle) invEditorTitle.textContent = "新增商品";
    if (invIdPrefix) invIdPrefix.value = "GPU";
    if (invIdModel) invIdModel.value = "";
    if (invName) invName.value = "";
    if (invCategory) invCategory.value = "";
    if (invQty) invQty.value = "1";
    if (invCost) invCost.value = "";
    if (invSuggested) invSuggested.value = "";
    if (invActual) invActual.value = "";
    if (invStatus) invStatus.value = "在庫";
    if (invCleaning) invCleaning.value = "未清潔";
    if (invBatchSource) invBatchSource.value = "";
    if (invNote) invNote.value = "";
    if (invBench) invBench.value = "";
    if (invTemp) invTemp.value = "";
    if (invVideoUrl) invVideoUrl.value = "";
    hide(invMsg);
    updateInvIdPreview();
  }

  function fillInvForm(it) {
    editingInvId = it.id;
    if (invDeleteBtn) invDeleteBtn.hidden = false;
    if (invEditorTitle) invEditorTitle.textContent = `編輯：${it.id}`;
    if (invIdPrefix) invIdPrefix.value = it.idPrefix || "";
    if (invIdModel) invIdModel.value = it.idModel || "";
    if (invName) invName.value = it.name || "";
    if (invCategory) invCategory.value = it.category || "";
    if (invQty) invQty.value = String(it.qty ?? 0);
    if (invCost) invCost.value = String(it.cost ?? "");
    if (invSuggested) invSuggested.value = String(it.suggestedPrice ?? "");
    if (invActual) invActual.value = String(it.actualPrice ?? "");
    if (invStatus) invStatus.value = it.status || "在庫";
    if (invCleaning) invCleaning.value = it.cleaningStatus || "未清潔";
    if (invBatchSource) invBatchSource.value = it.batchSource || "";
    if (invNote) invNote.value = it.note || "";
    if (invBench) invBench.value = it.test?.bench || "";
    if (invTemp) invTemp.value = it.test?.temp || "";
    if (invVideoUrl) invVideoUrl.value = it.test?.videoUrl || "";
    hide(invMsg);
    updateInvIdPreview();
  }

  function invMatches(it) {
    if (invState.status !== "全部" && it.status !== invState.status) return false;
    const q = norm(invState.q);
    if (!q) return true;
    const hay = [it.id, it.name, it.category, it.batchSource, it.note, it.test?.bench, it.test?.temp, it.test?.videoUrl]
      .map(norm)
      .join(" ");
    return hay.includes(q);
  }

  function renderInventory() {
    const items = getItems().filter(invMatches);
    if (!invTbody) return;
    invTbody.innerHTML = "";

    for (const it of items) {
      const tr = document.createElement("tr");
      const sellable = sellableQty(it);
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${escapeHtml(it.id)}</span></td>
        <td>${escapeHtml(it.name || "-")}<div class="muted">${escapeHtml(it.note || "")}</div></td>
        <td class="nowrap">${escapeHtml(it.category || "-")}</td>
        <td class="nowrap">${Number(it.qty || 0)}</td>
        <td class="nowrap">${sellable}</td>
        <td class="nowrap">${escapeHtml(it.status || "-")}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(it.cost)}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(it.suggestedPrice)}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(it.actualPrice)}</td>
        <td class="nowrap">${escapeHtml(it.cleaningStatus || "-")}</td>
        <td>${escapeHtml(it.batchSource || "-")}</td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
        fillInvForm(it);
        openInvEditor();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeInv(it.id));
      invTbody.appendChild(tr);
    }
  }

  function saveInv() {
    hide(invMsg);

    const items = getItems();
    const name = String(invName?.value || "").trim();
    const category = String(invCategory?.value || "").trim();
    const qty = toNum(invQty?.value);
    const cost = toNum(invCost?.value);
    const suggestedPrice = toNum(invSuggested?.value);
    const actualPrice = toNum(invActual?.value);
    const status = invStatus?.value || "在庫";
    const cleaningStatus = invCleaning?.value || "未清潔";
    const batchSource = String(invBatchSource?.value || "").trim();
    const note = String(invNote?.value || "").trim();

    const idPrefix = sanitizeCode(invIdPrefix?.value) || "ITEM";
    const idModel = sanitizeCode(invIdModel?.value) || sanitizeCode(name) || "X";

    if (!name) return show(invMsg, "商品名稱不能空白。");
    if (!category) return show(invMsg, "商品類別不能空白。");
    if (qty == null || qty < 0) return show(invMsg, "庫存數量需為 0 以上。");
    if (cost == null || cost < 0) return show(invMsg, "成本需為 0 以上。");
    if (!INV_STATUSES.includes(status)) return show(invMsg, "商品狀態不合法。");
    if (!CLEAN_STATUSES.includes(cleaningStatus)) return show(invMsg, "清潔狀態不合法。");

    const test = {
      bench: String(invBench?.value || "").trim(),
      temp: String(invTemp?.value || "").trim(),
      videoUrl: String(invVideoUrl?.value || "").trim(),
    };

    const now = new Date().toISOString();

    if (editingInvId) {
      const idx = items.findIndex((x) => x.id === editingInvId);
      if (idx < 0) return show(invMsg, "找不到此商品。");
      const prev = items[idx];
      items[idx] = {
        ...prev,
        name,
        category,
        qty,
        cost,
        suggestedPrice: suggestedPrice ?? null,
        actualPrice: actualPrice ?? null,
        status,
        cleaningStatus,
        batchSource,
        note,
        test,
        updatedAt: now,
      };
      saveItems(items);
      closeInvEditor();
      renderInventory();
      return;
    }

    const id = makeItemId(idPrefix, idModel);
    const next = {
      id,
      idPrefix,
      idModel,
      name,
      category,
      qty,
      cost,
      suggestedPrice: suggestedPrice ?? null,
      actualPrice: actualPrice ?? null,
      status,
      cleaningStatus,
      batchSource,
      note,
      test,
      createdAt: now,
      updatedAt: now,
    };
    items.unshift(next);
    saveItems(items);
    closeInvEditor();
    renderInventory();
  }

  function removeInv(id) {
    const items = getItems();
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`確定刪除「${it.id}」？`)) return;
    saveItems(items.filter((x) => x.id !== id));
    renderInventory();
  }

  function openBatch() {
    if (!invBatch) return;
    invBatch.hidden = false;
    invBatch.scrollIntoView({ behavior: "smooth", block: "start" });
    hide(invBatchMsg);
  }

  function closeBatch() {
    if (!invBatch) return;
    invBatch.hidden = true;
    hide(invBatchMsg);
  }

  function importBatch() {
    hide(invBatchMsg);
    const text = String(invBatchText?.value || "").trim();
    if (!text) return show(invBatchMsg, "請貼上批次資料。");

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return show(invBatchMsg, "沒有可匯入的行。");

    const items = getItems();
    const now = new Date().toISOString();
    let ok = 0;
    let fail = 0;

    for (const line of lines) {
      const parts = line.split(",").map((x) => x.trim());
      if (parts.length < 7) {
        fail++;
        continue;
      }
      const [prefix, model, name, category, qtyStr, costStr, suggestedStr, batchSource = ""] = parts;
      const qty = toNum(qtyStr);
      const cost = toNum(costStr);
      const suggestedPrice = toNum(suggestedStr);
      if (!name || !category || qty == null || qty < 0 || cost == null || cost < 0) {
        fail++;
        continue;
      }
      const id = makeItemId(prefix, model || name);
      items.unshift({
        id,
        idPrefix: sanitizeCode(prefix) || "ITEM",
        idModel: sanitizeCode(model || name) || "X",
        name,
        category,
        qty,
        cost,
        suggestedPrice: suggestedPrice ?? null,
        actualPrice: null,
        status: "在庫",
        cleaningStatus: "未清潔",
        batchSource,
        note: "",
        test: { bench: "", temp: "", videoUrl: "" },
        createdAt: now,
        updatedAt: now,
      });
      ok++;
    }

    saveItems(items);
    renderInventory();
    show(invBatchMsg, `已匯入 ${ok} 筆，失敗 ${fail} 筆。`);
  }

  function syncToWeb() {
    // 將「在庫/已預定/測試中」同步到首頁現貨（沿用原本前台資料格式）
    if (!window.DK?.saveInventory) return alert("找不到前台同步函式。");

    const items = getItems();
    const web = items
      .filter((it) => it.status === "在庫" || it.status === "已預定" || it.status === "測試中")
      .map((it) => ({
        id: it.id,
        name: it.name,
        category: it.category || "其他",
        stockStatus: it.status === "在庫" ? "現貨" : it.status === "已預定" ? "低庫存" : "低庫存",
        cpu: "",
        gpu: "",
        ram: "",
        ssd: "",
        price: typeof it.suggestedPrice === "number" ? it.suggestedPrice : undefined,
        tags: it.batchSource ? [it.batchSource] : [],
        note: it.note || "",
        photos: [],
      }));
    window.DK.saveInventory(web);
    return web.length;
  }

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

  function renderPublishPhotoStrip() {
    if (!publishPhotoStrip) return;
    publishPhotoStrip.innerHTML = "";
    const count = publishPhotos.length;
    if (publishPhotoHint) {
      publishPhotoHint.hidden = false;
      publishPhotoHint.textContent = `目前 ${count}/5 張（選檔後自動壓縮轉成 URL，可選 1–5 張，選填）`;
    }
    for (let i = 0; i < publishPhotos.length; i++) {
      const src = publishPhotos[i];
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      wrap.innerHTML = `<img alt="商品相片 ${i + 1}" /><button type="button" title="移除">×</button>`;
      const img = wrap.querySelector("img");
      img.src = src;
      wrap.querySelector("button").addEventListener("click", () => {
        publishPhotos.splice(i, 1);
        renderPublishPhotoStrip();
      });
      publishPhotoStrip.appendChild(wrap);
    }
  }

  function getItemsByCategory(category) {
    return getItems().filter((it) => (it.category || "").trim() === category);
  }

  function fillPublishSpecDropdowns() {
    for (const spec of PUBLISH_SPECS) {
      const sel = document.getElementById(spec.selectId);
      if (!sel) continue;
      const currentVal = sel.value;
      sel.innerHTML = '<option value="">— 請選擇 —</option>';
      const items = getItemsByCategory(spec.category);
      for (const it of items) {
        const opt = document.createElement("option");
        opt.value = it.id;
        opt.textContent = `${it.name || it.id}（庫存 ${Number(it.qty || 0)} / NT$ ${formatNum(it.cost)}）`;
        opt.dataset.cost = String(it.cost ?? 0);
        opt.dataset.qty = String(it.qty ?? 0);
        sel.appendChild(opt);
      }
      if (currentVal && items.some((it) => it.id === currentVal)) sel.value = currentVal;
      updatePublishSpecInfo(spec.key);
      const v = getPublishSpecValue(spec.key);
      if (!v.isCustom && v.id) setPublishSpecPrice(spec.key, v.cost);
    }
    updatePublishTotalCost();
    updatePublishSalePrice();
  }

  function getPublishSpecCondition(specKey) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec || !spec.conditionId) return "全新";
    const v = document.getElementById(spec.conditionId)?.value;
    return v === "二手" ? "二手" : "全新";
  }

  function getPublishSpecRemark(specKey) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec || !spec.remarkId) return "";
    return String(document.getElementById(spec.remarkId)?.value || "").trim();
  }

  function getPublishSpecPrice(specKey) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec || !spec.priceId) return 0;
    const v = toNum(document.getElementById(spec.priceId)?.value);
    return v != null && v >= 0 ? v : 0;
  }

  function setPublishSpecPrice(specKey, value) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec || !spec.priceId) return;
    const el = document.getElementById(spec.priceId);
    if (el) el.value = value != null && value >= 0 ? String(value) : "";
  }

  function updatePublishSalePrice() {
    let sum = 0;
    for (const spec of PUBLISH_SPECS) sum += getPublishSpecPrice(spec.key);
    if (publishPrice) publishPrice.value = sum > 0 ? `NT$ ${formatNum(sum)}` : "";
  }

  function getPublishSpecValue(specKey) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec) return { name: "", cost: 0, qty: 0, id: null, isCustom: false };
    const sel = document.getElementById(spec.selectId);
    const custom = document.getElementById(spec.customId);
    const customText = String(custom?.value || "").trim();
    if (customText) {
      return { name: customText, cost: 0, qty: 0, id: null, isCustom: true };
    }
    const id = sel?.value || "";
    if (!id) return { name: "", cost: 0, qty: 0, id: null, isCustom: false };
    const it = findItemById(id);
    if (!it) return { name: "", cost: 0, qty: 0, id: null, isCustom: false };
    return {
      name: it.name || it.id,
      cost: Number(it.cost) || 0,
      qty: Number(it.qty) || 0,
      id: it.id,
      isCustom: false,
    };
  }

  function updatePublishSpecInfo(specKey) {
    const spec = PUBLISH_SPECS.find((s) => s.key === specKey);
    if (!spec) return;
    const infoEl = document.getElementById(spec.infoId);
    const v = getPublishSpecValue(specKey);
    if (!infoEl) return;
    if (!v.name) {
      infoEl.textContent = "";
      return;
    }
    if (v.isCustom) infoEl.textContent = `自訂顯示用（不會加入庫存，請至庫存管理手動新增）`;
    else infoEl.textContent = `庫存 ${v.qty}／成本 NT$ ${formatNum(v.cost)}${v.qty === 0 ? " ※ 庫存為 0" : ""}`;
  }

  function updatePublishTotalCost() {
    let total = 0;
    for (const spec of PUBLISH_SPECS) total += getPublishSpecValue(spec.key).cost;
    if (publishTotalCost) publishTotalCost.textContent = `NT$ ${formatNum(total)}`;
  }

  function submitPublish() {
    hide(publishMsg);
    const productName = String(publishProductName?.value || "").trim();
    if (!productName) {
      show(publishMsg, "請填寫商品名稱。");
      return;
    }
    const photoCount = publishPhotos.length;
    if (photoCount > 5) {
      show(publishMsg, "最多上傳 5 張商品照片。");
      return;
    }
    if (!window.DK?.getInventory || !window.DK?.saveInventory) {
      show(publishMsg, "找不到前台資料函式。");
      return;
    }

    const specValues = {};
    const zeroStockNames = [];

    for (const spec of PUBLISH_SPECS) {
      const v = getPublishSpecValue(spec.key);
      specValues[spec.key] = v;
      if (v.name && !v.isCustom && v.qty === 0) zeroStockNames.push(`${spec.category}：${v.name}`);
    }

    const cpu = specValues.cpu?.name || "";
    const gpu = specValues.vga?.name || "";
    const ram = specValues.ram?.name || "";
    const ssd = specValues.hdd?.name || "";
    const specParts = [];
    for (const s of PUBLISH_SPECS) {
      const name = specValues[s.key]?.name;
      if (!name) continue;
      const condition = getPublishSpecCondition(s.key);
      const remark = getPublishSpecRemark(s.key);
      let part = `${s.category}：${name}（${condition}）`;
      if (remark) part += `；備注：${remark}`;
      specParts.push(part);
    }
    const noteParts = [publishSpecSummary?.value?.trim()].filter(Boolean);
    if (specParts.length) noteParts.push(specParts.join("｜"));

    let salePrice = 0;
    for (const s of PUBLISH_SPECS) salePrice += getPublishSpecPrice(s.key);

    const currentInv = window.DK.getInventory();
    const qtyNum = toNum(publishQty?.value);
    const newItem = {
      id: makeWebItemId(),
      name: productName,
      category: publishCategory?.value || "遊戲",
      stockStatus: "現貨",
      cpu,
      gpu,
      ram,
      ssd,
      price: salePrice,
      qty: qtyNum != null && qtyNum >= 0 ? qtyNum : 1,
      tags: [],
      note: noteParts.join(" "),
      photos: publishPhotos.slice(0, 5),
    };
    currentInv.unshift(newItem);
    window.DK.saveInventory(currentInv);

    let msg = `已上架「${productName}」至前台（出售金額 NT$ ${formatNum(salePrice)}，${photoCount} 張照片）。`;
    if (zeroStockNames.length) msg += ` 以下規格庫存為 0，請至庫存管理補齊：${zeroStockNames.join("、")}`;
    show(publishMsg, msg);

    publishPhotos = [];
    renderPublishPhotoStrip();
    if (publishPhotosInput) publishPhotosInput.value = "";
    if (publishFormCard) publishFormCard.hidden = true;
    renderPublish();
  }

  function getWebItems() {
    return window.DK?.getInventory?.() || [];
  }

  function openPublishEditor() {
    if (!publishEditor) return;
    publishEditor.hidden = false;
    publishEditor.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closePublishEditor() {
    if (!publishEditor) return;
    publishEditor.hidden = true;
    editingWebId = null;
    hide(publishEditorMsg);
  }

  function fillPublishEditor(it) {
    editingWebId = it.id;
    if (publishEditorTitle) publishEditorTitle.textContent = it.name || it.id || "";
    if (webEditName) webEditName.value = it.name || "";
    if (webEditCategory) webEditCategory.value = it.category || "遊戲";
    if (webEditStockStatus) webEditStockStatus.value = it.stockStatus || "現貨";
    if (webEditPrice) webEditPrice.value = typeof it.price === "number" ? String(it.price) : "";
    if (webEditQty) webEditQty.value = typeof it.qty === "number" && it.qty >= 0 ? String(it.qty) : "1";
    if (webEditNote) webEditNote.value = it.note || "";
    hide(publishEditorMsg);
  }

  function savePublishEditor() {
    hide(publishEditorMsg);
    if (!editingWebId || !window.DK?.getInventory || !window.DK?.saveInventory) return;
    const items = getWebItems();
    const idx = items.findIndex((x) => x.id === editingWebId);
    if (idx < 0) {
      show(publishEditorMsg, "找不到該商品。");
      return;
    }
    const name = String(webEditName?.value || "").trim();
    if (!name) {
      show(publishEditorMsg, "請填寫商品名稱。");
      return;
    }
    const qtyVal = toNum(webEditQty?.value);
    items[idx] = {
      ...items[idx],
      name,
      category: webEditCategory?.value || "遊戲",
      stockStatus: webEditStockStatus?.value || "現貨",
      price: toNum(webEditPrice?.value) ?? items[idx].price,
      qty: qtyVal != null && qtyVal >= 0 ? qtyVal : items[idx].qty,
      note: String(webEditNote?.value || "").trim(),
    };
    window.DK.saveInventory(items);
    closePublishEditor();
    renderPublish();
  }

  function removeFromWeb(id) {
    if (!window.DK?.getInventory || !window.DK?.saveInventory) return;
    const items = getWebItems().filter((x) => x.id !== id);
    window.DK.saveInventory(items);
    if (editingWebId === id) closePublishEditor();
    renderPublish();
  }

  function renderPublish() {
    fillPublishSpecDropdowns();
    renderPublishPhotoStrip();
    const webItems = getWebItems();
    const publishWebEmpty = document.getElementById("publishWebEmpty");
    if (!publishWebGrid) return;
    publishWebGrid.innerHTML = "";
    for (const it of webItems) {
      const photos = Array.isArray(it.photos) ? it.photos : [];
      const imgSrc = photos[0] || "";
      const baseSpec = it.note
        ? String(it.note).trim()
        : [it.category, it.stockStatus, it.price != null ? `NT$ ${formatNum(it.price)}` : ""].filter(Boolean).join(" · ");
      const qtyStr = typeof it.qty === "number" && it.qty >= 0 ? `剩餘 ${it.qty} 件` : "";
      const specText = qtyStr ? (baseSpec ? `${baseSpec} · ${qtyStr}` : qtyStr) : baseSpec;
      const card = document.createElement("div");
      card.className = "publish-web-card";
      card.innerHTML = `
        <div class="publish-web-card-img">
          ${imgSrc ? `<img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(it.name || "")}" loading="lazy" />` : '<span class="publish-web-card-noimg">無圖片</span>'}
        </div>
        <div class="publish-web-card-body">
          <div class="publish-web-card-name">${escapeHtml(it.name || "-")}</div>
          <div class="publish-web-card-spec muted">${escapeHtml(specText || "-")}</div>
          <div class="publish-web-card-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="off">下架</button>
          </div>
        </div>
      `;
      card.querySelector('[data-act="edit"]').addEventListener("click", () => {
        fillPublishEditor(it);
        openPublishEditor();
      });
      card.querySelector('[data-act="off"]').addEventListener("click", () => {
        if (confirm(`確定將「${it.name || it.id}」下架？`)) removeFromWeb(it.id);
      });
      publishWebGrid.appendChild(card);
    }
    if (publishWebEmpty) publishWebEmpty.hidden = webItems.length > 0;
    hide(publishMsg);
  }

  // ---------- orders ----------
  function getOrders() {
    return loadArr(KEYS.orders);
  }

  function saveOrders(orders) {
    saveArr(KEYS.orders, orders);
  }

  function openOrdEditor() {
    if (!ordEditor) return;
    ordEditor.hidden = false;
    ordEditor.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeOrdEditor() {
    if (!ordEditor) return;
    ordEditor.hidden = true;
    hide(ordMsg);
  }

  function clearOrdForm() {
    editingOrdId = null;
    if (ordDeleteBtn) ordDeleteBtn.hidden = true;
    if (ordEditorTitle) ordEditorTitle.textContent = "新增訂單";
    if (ordDate) ordDate.value = isoDate();
    if (ordShip) ordShip.value = "未出貨";
    if (ordCustomer) ordCustomer.value = "";
    if (ordItemId) ordItemId.value = "";
    if (ordQty) ordQty.value = "1";
    if (ordPrice) ordPrice.value = "";
    if (ordNote) ordNote.value = "";
    if (ordCost) ordCost.textContent = "-";
    if (ordProfit) ordProfit.textContent = "-";
    hide(ordMsg);
  }

  function fillOrdForm(o) {
    editingOrdId = o.id;
    if (ordDeleteBtn) ordDeleteBtn.hidden = false;
    if (ordEditorTitle) ordEditorTitle.textContent = `編輯：${o.id}`;
    if (ordDate) ordDate.value = o.date || isoDate();
    if (ordShip) ordShip.value = o.shippingStatus || "未出貨";
    if (ordCustomer) ordCustomer.value = o.customer || "";
    if (ordItemId) ordItemId.value = o.itemId || "";
    if (ordQty) ordQty.value = String(o.qty || 1);
    if (ordPrice) ordPrice.value = String(o.price || 0);
    if (ordNote) ordNote.value = o.note || "";
    updateOrdCalc();
    hide(ordMsg);
  }

  function ordMatches(o) {
    if (ordState.ship !== "全部" && o.shippingStatus !== ordState.ship) return false;
    const q = norm(ordState.q);
    if (!q) return true;
    const hay = [o.id, o.customer, o.itemId, o.note].map(norm).join(" ");
    return hay.includes(q);
  }

  function renderOrders() {
    const orders = getOrders().filter(ordMatches);
    if (!ordTbody) return;
    ordTbody.innerHTML = "";
    for (const o of orders) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${escapeHtml(o.id)}</span></td>
        <td class="nowrap">${escapeHtml(o.date || "-")}</td>
        <td>${escapeHtml(o.customer || "-")}<div class="muted">${escapeHtml(o.note || "")}</div></td>
        <td class="nowrap"><span class="mono">${escapeHtml(o.itemId || "-")}</span></td>
        <td class="nowrap">${Number(o.qty || 0)}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(o.price)}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(o.cost)}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${formatNum(o.profit)}</td>
        <td class="nowrap">${escapeHtml(o.shippingStatus || "-")}</td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
        fillOrdForm(o);
        openOrdEditor();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeOrder(o.id));
      ordTbody.appendChild(tr);
    }
  }

  function findItemById(id) {
    const items = getItems();
    return items.find((x) => x.id === id) || null;
  }

  function updateOrdCalc() {
    const itemId = String(ordItemId?.value || "").trim();
    const qty = toNum(ordQty?.value) ?? 0;
    const price = toNum(ordPrice?.value) ?? 0;
    const it = itemId ? findItemById(itemId) : null;
    const cost = it ? (Number(it.cost || 0) * (qty || 0)) : 0;
    const profit = price - cost;
    if (ordCost) ordCost.textContent = it ? `NT$ ${formatNum(cost)}` : "-";
    if (ordProfit) ordProfit.textContent = it ? `NT$ ${formatNum(profit)}` : "-";
  }

  function saveOrder() {
    hide(ordMsg);
    const date = String(ordDate?.value || "").trim() || isoDate();
    const shippingStatus = ordShip?.value || "未出貨";
    const customer = String(ordCustomer?.value || "").trim();
    const itemId = String(ordItemId?.value || "").trim();
    const qty = toNum(ordQty?.value);
    const price = toNum(ordPrice?.value);
    const note = String(ordNote?.value || "").trim();

    if (!SHIP_STATUSES.includes(shippingStatus)) return show(ordMsg, "出貨狀態不合法。");
    if (!itemId) return show(ordMsg, "請填商品 ID。");
    if (qty == null || qty <= 0) return show(ordMsg, "數量需為 1 以上。");
    if (price == null || price < 0) return show(ordMsg, "售價需為 0 以上。");

    const items = getItems();
    const it = items.find((x) => x.id === itemId);
    if (!it) return show(ordMsg, "找不到此商品 ID（請先在庫存建立）。");

    const canSell = sellableQty(it);
    if (!editingOrdId && qty > canSell) return show(ordMsg, `可售數量不足（可售 ${canSell}）。`);

    const costTotal = Number(it.cost || 0) * qty;
    const profit = price - costTotal;
    const now = new Date().toISOString();

    const orders = getOrders();
    if (editingOrdId) {
      const idx = orders.findIndex((x) => x.id === editingOrdId);
      if (idx < 0) return show(ordMsg, "找不到此訂單。");
      // 目前簡化：編輯不回沖庫存（避免出現複雜差額），建議刪除重建
      orders[idx] = {
        ...orders[idx],
        date,
        shippingStatus,
        customer,
        itemId,
        qty,
        price,
        cost: costTotal,
        profit,
        note,
        updatedAt: now,
      };
      saveOrders(orders);
      closeOrdEditor();
      renderOrders();
      return;
    }

    const id = makeOrderId(date);
    orders.unshift({
      id,
      date,
      shippingStatus,
      customer,
      itemId,
      qty,
      price,
      cost: costTotal,
      profit,
      batchSource: it.batchSource || "",
      note,
      createdAt: now,
      updatedAt: now,
    });
    saveOrders(orders);

    // 扣庫存
    it.qty = Math.max(0, Number(it.qty || 0) - qty);
    if (it.qty === 0) it.status = "已售出";
    it.actualPrice = Math.round(price / qty);
    it.updatedAt = now;
    saveItems(items);

    closeOrdEditor();
    renderOrders();
    renderInventory();
  }

  function removeOrder(id) {
    const orders = getOrders();
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    if (!confirm(`確定刪除訂單「${o.id}」？（不會回沖庫存）`)) return;
    saveOrders(orders.filter((x) => x.id !== id));
    renderOrders();
  }

  // ---------- reports ----------
  function parseDate(s) {
    const v = String(s || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + "T00:00:00");
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  }

  function inRange(dateStr, from, to) {
    const d = parseDate(dateStr);
    if (!d) return false;
    return d >= from && d <= to;
  }

  function topEntries(map, limit = 5) {
    return [...map.entries()].sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, limit);
  }

  function renderReports() {
    if (!repWrap) return;
    const range = repRange?.value || "month";

    const to = new Date();
    const from = range === "day" ? daysAgo(0) : range === "week" ? daysAgo(6) : daysAgo(29);
    const fromStr = isoDate(from);
    const toStr = isoDate(to);

    const orders = getOrders().filter((o) => o.shippingStatus !== "已取消" && inRange(o.date, from, to));
    const revenue = orders.reduce((s, o) => s + (Number(o.price) || 0), 0);
    const profit = orders.reduce((s, o) => s + (Number(o.profit) || 0), 0);
    const qty = orders.reduce((s, o) => s + (Number(o.qty) || 0), 0);

    const hot = new Map();
    const bestBatch = new Map();
    for (const o of orders) {
      const k = o.itemId || "-";
      hot.set(k, (hot.get(k) || 0) + (Number(o.qty) || 0));
      const b = String(o.batchSource || "未填").trim() || "未填";
      bestBatch.set(b, (bestBatch.get(b) || 0) + (Number(o.profit) || 0));
    }

    const items = getItems();
    const recentOrdersByItem = new Set(
      getOrders()
        .filter((o) => o.shippingStatus !== "已取消" && inRange(o.date, daysAgo(29), new Date()))
        .map((o) => o.itemId),
    );
    const slow = items.filter((it) => it.status === "在庫" && sellableQty(it) > 0 && !recentOrdersByItem.has(it.id));

    repWrap.innerHTML = `
      <div class="card">
        <h3 class="h3">營運報表（${escapeHtml(rangeLabel(range))}）</h3>
        <div class="muted" style="margin-top:8px">區間：${escapeHtml(fromStr)} ～ ${escapeHtml(toStr)}</div>
        <div class="spec" style="margin-top:10px">
          <div class="row"><div class="k">營收</div><div class="v"><span class="mono">NT$</span> ${formatNum(revenue)}</div></div>
          <div class="row"><div class="k">毛利</div><div class="v"><span class="mono">NT$</span> ${formatNum(profit)}</div></div>
          <div class="row"><div class="k">銷售量</div><div class="v">${qty}</div></div>
        </div>
      </div>
      <div class="card">
        <h3 class="h3">商品報表</h3>
        <div class="muted" style="margin-top:8px">最熱賣品項（依銷售量）</div>
        <div style="margin-top:10px">${renderList(topEntries(hot, 5).map(([k, v]) => `${escapeHtml(k)}：${v}`), "本區間無銷售")}</div>
        <div class="muted" style="margin-top:14px">最佳毛利批次（依毛利總和）</div>
        <div style="margin-top:10px">${renderList(topEntries(bestBatch, 5).map(([k, v]) => `${escapeHtml(k)}：NT$ ${formatNum(v)}`), "本區間無資料")}</div>
      </div>
    `;

    // 庫存分佈：依狀態
    if (repInvDist) {
      const byStatus = new Map();
      for (const it of items) byStatus.set(it.status || "未填", (byStatus.get(it.status || "未填") || 0) + (Number(it.qty) || 0));
      repInvDist.innerHTML = renderBars(byStatus);
    }

    // 低庫存
    const th = toNum(repLowThreshold?.value) ?? 2;
    const low = items
      .filter((it) => sellableQty(it) > 0 && sellableQty(it) <= th)
      .map((it) => `${escapeHtml(it.id)}｜${escapeHtml(it.name || "-")}｜可售 ${sellableQty(it)}`);
    if (repLowStock) repLowStock.innerHTML = renderList(low, "目前沒有低庫存。");

    // 滯銷
    const slowLines = slow.slice(0, 30).map((it) => `${escapeHtml(it.id)}｜${escapeHtml(it.name || "-")}｜庫存 ${Number(it.qty || 0)}`);
    if (repSlow) repSlow.innerHTML = renderList(slowLines, "目前沒有滯銷提醒。");
  }

  function rangeLabel(v) {
    if (v === "day") return "日";
    if (v === "week") return "週";
    return "月";
  }

  function renderList(lines, emptyText) {
    if (!lines || lines.length === 0) return `<div class="muted">${escapeHtml(emptyText)}</div>`;
    return `<ul class="ol" style="padding-left: 18px; margin: 0">${lines.map((x) => `<li style="margin:6px 0">${x}</li>`).join("")}</ul>`;
  }

  function renderBars(map) {
    const entries = [...map.entries()].sort((a, b) => (b[1] || 0) - (a[1] || 0));
    const max = Math.max(1, ...entries.map(([, v]) => Number(v) || 0));
    return `
      <div style="display:grid; gap:10px">
        ${entries
          .map(([k, v]) => {
            const pct = Math.round(((Number(v) || 0) / max) * 100);
            return `
              <div style="display:grid; gap:6px">
                <div class="muted" style="display:flex; justify-content:space-between; gap:10px">
                  <span>${escapeHtml(k)}</span><span>${Number(v) || 0}</span>
                </div>
                <div style="height:10px; border-radius:999px; background: rgba(0,0,0,0.06); overflow:hidden">
                  <div style="height:100%; width:${pct}%; background: rgba(0,113,227,0.75)"></div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  // ---------- small utils ----------
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNum(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return "-";
    return n.toLocaleString("zh-Hant-TW");
  }

  // ---------- events ----------
  function doLogin() {
    hide(loginError);
    const cfg = window.DK?.getConfig?.();
    const u = String(usernameEl?.value || "").trim();
    const p = String(passwordEl?.value || "");
    if (cfg && u === cfg.admin.username && p === cfg.admin.password) {
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

  for (const t of tabs) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }

  // inventory events
  invNewBtn?.addEventListener("click", () => {
    clearInvForm();
    openInvEditor();
  });
  invCloseBtn?.addEventListener("click", closeInvEditor);
  invSaveBtn?.addEventListener("click", saveInv);
  invDeleteBtn?.addEventListener("click", () => {
    if (!editingInvId) return;
    removeInv(editingInvId);
    closeInvEditor();
  });
  invIdPrefix?.addEventListener("input", updateInvIdPreview);
  invIdModel?.addEventListener("input", updateInvIdPreview);
  invSearch?.addEventListener("input", () => {
    invState.q = invSearch.value;
    renderInventory();
  });
  invStatusFilter?.addEventListener("change", () => {
    invState.status = invStatusFilter.value;
    renderInventory();
  });
  invBatchBtn?.addEventListener("click", openBatch);
  invBatchCloseBtn?.addEventListener("click", closeBatch);
  invBatchImportBtn?.addEventListener("click", importBatch);

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

  // orders events
  ordNewBtn?.addEventListener("click", () => {
    clearOrdForm();
    openOrdEditor();
  });
  ordCloseBtn?.addEventListener("click", closeOrdEditor);
  ordSaveBtn?.addEventListener("click", saveOrder);
  ordDeleteBtn?.addEventListener("click", () => {
    if (!editingOrdId) return;
    removeOrder(editingOrdId);
    closeOrdEditor();
  });
  ordSearch?.addEventListener("input", () => {
    ordState.q = ordSearch.value;
    renderOrders();
  });
  ordShipFilter?.addEventListener("change", () => {
    ordState.ship = ordShipFilter.value;
    renderOrders();
  });
  for (const el of [ordItemId, ordQty, ordPrice]) {
    el?.addEventListener("input", updateOrdCalc);
  }

  // reports events
  repRefreshBtn?.addEventListener("click", renderReports);
  repRange?.addEventListener("change", renderReports);
  repLowThreshold?.addEventListener("input", renderReports);

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

  // ---------- init ----------
  applyAuthUI();
  if (window.DK?.isAdminAuthed?.()) {
    switchTab("inv");
  }
})();

