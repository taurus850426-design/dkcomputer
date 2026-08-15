/* admin.js - 本機管理員後台（localStorage） */

(function () {
  const loginCard = document.getElementById("loginCard");
  const panel = document.getElementById("panel");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const loginError = document.getElementById("loginError");

  const usernameEl = document.getElementById("username");
  const passwordEl = document.getElementById("password");

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const tabSettings = document.getElementById("tab-settings");
  const tabPreview = document.getElementById("tab-preview");
  const tabInventory = document.getElementById("tab-inventory");
  const tabComputers = document.getElementById("tab-computers");
  const tabGpus = document.getElementById("tab-gpus");
  const tabReports = document.getElementById("tab-reports");
  const tabData = document.getElementById("tab-data");

  // settings inputs
  const siteTitle = document.getElementById("siteTitle");
  const brandMarkInput = document.getElementById("brandMarkInput");
  const brandTitleInput = document.getElementById("brandTitleInput");
  const brandSubtitleInput = document.getElementById("brandSubtitleInput");
  const shopNameInput = document.getElementById("shopNameInput");
  const shopPhoneInput = document.getElementById("shopPhoneInput");
  const shopAddressInput = document.getElementById("shopAddressInput");
  const shopMapUrlInput = document.getElementById("shopMapUrlInput");
  const shopPhotoUrlInput = document.getElementById("shopPhotoUrlInput");
  const lineUrlInput = document.getElementById("lineUrlInput");
  const lineTplInput = document.getElementById("lineTplInput");
  const adminUserInput = document.getElementById("adminUserInput");
  const adminPassInput = document.getElementById("adminPassInput");
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  const resetBtn = document.getElementById("resetBtn");
  const settingsMsg = document.getElementById("settingsMsg");

  // inventory
  const itemsTbody = document.getElementById("itemsTbody");
  const newItemBtn = document.getElementById("newItemBtn");
  const itemName = document.getElementById("itemName");
  const itemCategory = document.getElementById("itemCategory");
  const itemStock = document.getElementById("itemStock");
  const itemCpu = document.getElementById("itemCpu");
  const itemGpu = document.getElementById("itemGpu");
  const itemRam = document.getElementById("itemRam");
  const itemSsd = document.getElementById("itemSsd");
  const itemPrice = document.getElementById("itemPrice");
  const itemTags = document.getElementById("itemTags");
  const itemNote = document.getElementById("itemNote");
  const itemPhotos = document.getElementById("itemPhotos");
  const photoStrip = document.getElementById("photoStrip");
  const photoHint = document.getElementById("photoHint");
  const saveItemBtn = document.getElementById("saveItemBtn");
  const cancelEditBtn = document.getElementById("cancelEditBtn");
  const itemMsg = document.getElementById("itemMsg");

  // preview (現有庫存)
  const previewGrid = document.getElementById("previewGrid");
  const previewEmpty = document.getElementById("previewEmptyState");
  const previewSearchInput = document.getElementById("previewSearchInput");
  const previewStockSelect = document.getElementById("previewStockSelect");
  const previewSegs = Array.from(document.querySelectorAll('#tab-preview .segmented .seg'));

  // 電腦庫存
  const pcsTbody = document.getElementById("pcsTbody");
  const newPcBtn = document.getElementById("newPcBtn");
  const pcSearchInput = document.getElementById("pcSearchInput");
  const pcStatusSelect = document.getElementById("pcStatusSelect");
  const pcTypeSelect = document.getElementById("pcTypeSelect");
  const pcMachineNo = document.getElementById("pcMachineNo");
  const pcType = document.getElementById("pcType");
  const pcStatus = document.getElementById("pcStatus");
  const pcListedAt = document.getElementById("pcListedAt");
  const pcSoldAt = document.getElementById("pcSoldAt");
  const pcSoldPrice = document.getElementById("pcSoldPrice");
  const pcCpu = document.getElementById("pcCpu");
  const pcMotherboard = document.getElementById("pcMotherboard");
  const pcRam = document.getElementById("pcRam");
  const pcStorage = document.getElementById("pcStorage");
  const pcGpu = document.getElementById("pcGpu");
  const pcPsu = document.getElementById("pcPsu");
  const pcCase = document.getElementById("pcCase");
  const pcCostBase = document.getElementById("pcCostBase");
  const pcCostAddon = document.getElementById("pcCostAddon");
  const pcCostRefurb = document.getElementById("pcCostRefurb");
  const pcCostSummary = document.getElementById("pcCostSummary");
  const pcSuggestedPrice = document.getElementById("pcSuggestedPrice");
  const pcMinPrice = document.getElementById("pcMinPrice");
  const pcSource = document.getElementById("pcSource");
  const pcCustomer = document.getElementById("pcCustomer");
  const pcNote = document.getElementById("pcNote");
  const savePcBtn = document.getElementById("savePcBtn");
  const cancelPcBtn = document.getElementById("cancelPcBtn");
  const deletePcBtn = document.getElementById("deletePcBtn");
  const pcMsg = document.getElementById("pcMsg");

  // 顯卡庫存
  const gpusTbody = document.getElementById("gpusTbody");
  const newGpuBtn = document.getElementById("newGpuBtn");
  const gpuSearchInput = document.getElementById("gpuSearchInput");
  const gpuStatusSelect = document.getElementById("gpuStatusSelect");
  const gpuTestSelect = document.getElementById("gpuTestSelect");
  const gpuNo = document.getElementById("gpuNo");
  const gpuModel = document.getElementById("gpuModel");
  const gpuBrand = document.getElementById("gpuBrand");
  const gpuFans = document.getElementById("gpuFans");
  const gpuOrigin = document.getElementById("gpuOrigin");
  const gpuCost = document.getElementById("gpuCost");
  const gpuTestStatus = document.getElementById("gpuTestStatus");
  const gpuWarranty = document.getElementById("gpuWarranty");
  const gpuStatus = document.getElementById("gpuStatus");
  const gpuListedAt = document.getElementById("gpuListedAt");
  const gpuSoldAt = document.getElementById("gpuSoldAt");
  const gpuSoldPrice = document.getElementById("gpuSoldPrice");
  const gpuSuggestedPrice = document.getElementById("gpuSuggestedPrice");
  const gpuMinPrice = document.getElementById("gpuMinPrice");
  const gpuSource = document.getElementById("gpuSource");
  const gpuCustomer = document.getElementById("gpuCustomer");
  const gpuNote = document.getElementById("gpuNote");
  const saveGpuBtn = document.getElementById("saveGpuBtn");
  const cancelGpuBtn = document.getElementById("cancelGpuBtn");
  const deleteGpuBtn = document.getElementById("deleteGpuBtn");
  const gpuMsg = document.getElementById("gpuMsg");

  // 報表 / 其他收入
  const reportMonth = document.getElementById("reportMonth");
  const refreshReportBtn = document.getElementById("refreshReportBtn");
  const reportWrap = document.getElementById("reportWrap");
  const miscTbody = document.getElementById("miscTbody");
  const newMiscBtn = document.getElementById("newMiscBtn");
  const miscDate = document.getElementById("miscDate");
  const miscCategory = document.getElementById("miscCategory");
  const miscRevenue = document.getElementById("miscRevenue");
  const miscCost = document.getElementById("miscCost");
  const miscSource = document.getElementById("miscSource");
  const miscCustomer = document.getElementById("miscCustomer");
  const miscNote = document.getElementById("miscNote");
  const saveMiscBtn = document.getElementById("saveMiscBtn");
  const cancelMiscBtn = document.getElementById("cancelMiscBtn");
  const deleteMiscBtn = document.getElementById("deleteMiscBtn");
  const miscMsg = document.getElementById("miscMsg");

  // 匯入/匯出
  const exportAllBtn = document.getElementById("exportAllBtn");
  const copyAllBtn = document.getElementById("copyAllBtn");
  const dataText = document.getElementById("dataText");
  const importAllBtn = document.getElementById("importAllBtn");
  const clearDataBtn = document.getElementById("clearDataBtn");
  const dataMsg = document.getElementById("dataMsg");

  if (!loginCard || !panel) return;

  let editingId = null;
  let editingPhotos = [];
  let pcEditingId = null;
  let gpuEditingId = null;
  let miscEditingId = null;
  let previewState = {
    query: "",
    category: "全部",
    stock: "全部",
  };
  let pcState = {
    query: "",
    status: "全部",
    type: "全部",
  };
  let gpuState = {
    query: "",
    status: "全部",
    test: "全部",
  };

  function showMsg(el, text) {
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
  }
  function hideMsg(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function applyAuthUI() {
    const authed = DK.isAdminAuthed();
    loginCard.hidden = authed;
    panel.hidden = !authed;
    logoutBtn.hidden = !authed;
  }

  function switchTab(tabName) {
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === tabName);
    tabSettings.hidden = tabName !== "settings";
    tabInventory.hidden = tabName !== "inventory";
    if (tabPreview) tabPreview.hidden = tabName !== "preview";
    if (tabComputers) tabComputers.hidden = tabName !== "computers";
    if (tabGpus) tabGpus.hidden = tabName !== "gpus";
    if (tabReports) tabReports.hidden = tabName !== "reports";
    if (tabData) tabData.hidden = tabName !== "data";
    if (tabName === "preview") renderPreview();
    if (tabName === "computers") renderPcTable();
    if (tabName === "gpus") renderGpuTable();
    if (tabName === "reports") {
      renderMiscTable();
      renderReport();
    }
  }

  function previewMatches(item) {
    const q = DK.normalizeText(previewState.query);
    if (previewState.category !== "全部" && item.category !== previewState.category) return false;
    if (previewState.stock !== "全部" && item.stockStatus !== previewState.stock) return false;
    if (!q) return true;

    const hay = [
      item.name,
      item.category,
      item.stockStatus,
      item.cpu,
      item.gpu,
      item.ram,
      item.ssd,
      ...(item.tags ?? []),
      item.note,
    ]
      .map(DK.normalizeText)
      .join(" ");

    return hay.includes(q);
  }

  function renderPreview() {
    if (!previewGrid || !previewEmpty) return;
    const items = DK.getInventory().filter(previewMatches);
    previewGrid.innerHTML = "";

    if (items.length === 0) {
      previewEmpty.hidden = false;
      return;
    }
    previewEmpty.hidden = true;

    for (const item of items) {
      const el = document.createElement("article");
      el.className = "card item";

      const badgeClass = DK.stockBadgeClass(item.stockStatus);
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const photos = Array.isArray(item.photos) ? item.photos : [];
      const firstPhoto = photos[0] || "";
      const tagBadges = tags
        .slice(0, 4)
        .map((t) => `<span class="badge tag">${DK.escapeHtml(t)}</span>`)
        .join("");

      el.innerHTML = `
        ${firstPhoto ? `<img class="item-photo" alt="${DK.escapeHtml(item.name)}" src="${firstPhoto}" loading="lazy" />` : ""}
        <div class="item-top">
          <div class="item-name">${DK.escapeHtml(item.name)}</div>
          <div class="badges">
            <span class="badge ${badgeClass}">${DK.escapeHtml(item.stockStatus)}</span>
            <span class="badge tag">${DK.escapeHtml(item.category)}</span>
            ${tagBadges}
          </div>
        </div>

        <div class="spec">
          <div class="row"><div class="k">CPU</div><div class="v">${DK.escapeHtml(item.cpu || "-")}</div></div>
          <div class="row"><div class="k">GPU</div><div class="v">${DK.escapeHtml(item.gpu || "-")}</div></div>
          <div class="row"><div class="k">RAM</div><div class="v">${DK.escapeHtml(item.ram || "-")}</div></div>
          <div class="row"><div class="k">SSD</div><div class="v">${DK.escapeHtml(item.ssd || "-")}</div></div>
        </div>

        <div class="item-bottom">
          <div class="price"><small>NT$</small> ${DK.formatPrice(item.price) || "-"}</div>
          <div class="item-actions">
            <button class="btn btn-primary btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="line">加 LINE 下單</button>
            <button class="btn btn-danger btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </div>
      `;

      el.querySelector('[data-act="line"]').addEventListener("click", () => DK.openLineOrder(item));
      el.querySelector('[data-act="edit"]').addEventListener("click", () => {
        switchTab("inventory");
        startEdit(item.id);
        itemName?.focus();
      });
      el.querySelector('[data-act="del"]').addEventListener("click", () => removeItem(item.id));
      previewGrid.appendChild(el);
    }
  }

  let currentInventoryCategories = [];

  function renderInventoryCategoriesTable() {
    const tbody = document.getElementById("inventoryCategoriesTbody");
    const searchEl = document.getElementById("inventoryCategorySearch");
    if (!tbody) return;
    const q = (searchEl && searchEl.value || "").trim().toLowerCase();
    const list = q ? currentInventoryCategories.filter(function (c) { return String(c).toLowerCase().includes(q); }) : currentInventoryCategories;
    tbody.innerHTML = list.map(function (cat) {
      return "<tr><td>" + DK.escapeHtml(cat) + "</td><td style=\"text-align:right\"><button type=\"button\" class=\"btn btn-ghost btn-sm btn-remove-inventory-cat\" data-cat=\"" + DK.escapeHtml(cat) + "\">移除</button></td></tr>";
    }).join("");
    tbody.querySelectorAll(".btn-remove-inventory-cat").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const cat = btn.getAttribute("data-cat");
        currentInventoryCategories = currentInventoryCategories.filter(function (c) { return c !== cat; });
        renderInventoryCategoriesTable();
      });
    });
  }

  function loadSettingsForm() {
    const cfg = DK.getConfig();
    siteTitle.value = cfg.siteTitle ?? "";
    brandMarkInput.value = cfg.brand?.mark ?? "";
    brandTitleInput.value = cfg.brand?.title ?? "";
    brandSubtitleInput.value = cfg.brand?.subtitle ?? "";
    shopNameInput.value = cfg.shop?.name ?? "";
    shopPhoneInput.value = cfg.shop?.phone ?? "";
    shopAddressInput.value = cfg.shop?.address ?? "";
    shopMapUrlInput.value = cfg.shop?.mapUrl ?? "";
    shopPhotoUrlInput.value = cfg.shop?.photoUrl ?? "";
    lineUrlInput.value = cfg.line?.url ?? "";
    lineTplInput.value = cfg.line?.orderMessageTemplate ?? "";
    adminUserInput.value = cfg.admin?.username ?? "";
    if (adminPassInput) adminPassInput.value = "";
    currentInventoryCategories = (cfg.inventoryCategories && cfg.inventoryCategories.length) ? cfg.inventoryCategories.slice() : (DK.DEFAULT_CONFIG.inventoryCategories || []).slice();
    renderInventoryCategoriesTable();
  }

  function saveSettings() {
    const cfg = DK.getConfig();
    const next = {
      ...cfg,
      siteTitle: siteTitle.value.trim(),
      brand: {
        ...cfg.brand,
        mark: brandMarkInput.value.trim(),
        title: brandTitleInput.value.trim(),
        subtitle: brandSubtitleInput.value.trim(),
      },
      shop: {
        ...cfg.shop,
        name: shopNameInput.value.trim(),
        phone: shopPhoneInput.value.trim(),
        address: shopAddressInput.value.trim(),
        mapUrl: shopMapUrlInput.value.trim(),
        photoUrl: shopPhotoUrlInput.value.trim(),
      },
      line: {
        ...cfg.line,
        url: lineUrlInput.value.trim(),
        orderMessageTemplate: lineTplInput.value.trim(),
      },
      admin: {
        ...cfg.admin,
        username: adminUserInput.value.trim() || "admin",
      },
      inventoryCategories: currentInventoryCategories.slice(),
    };
    DK.saveConfig(next);
    hideMsg(settingsMsg);
    showMsg(settingsMsg, "已儲存設定。回到首頁重新整理即可看到更新。");
  }

  function resetAll() {
    DK.saveConfig(DK.DEFAULT_CONFIG);
    DK.saveInventory([...DK.DEFAULT_INVENTORY]);
    DK.saveComputers([...DK.DEFAULT_COMPUTERS]);
    DK.saveGpus([...DK.DEFAULT_GPUS]);
    DK.saveMisc([...DK.DEFAULT_MISC]);
    loadSettingsForm();
    renderTable();
    renderPreview();
    renderPcTable();
    renderGpuTable();
    renderMiscTable();
    renderReport();
    hideMsg(settingsMsg);
    showMsg(settingsMsg, "已重置為預設（設定 + 庫存 + 電腦/顯卡/記帳）。");
  }

  function renderTable() {
    const items = DK.getInventory();
    itemsTbody.innerHTML = "";

    for (const item of items) {
      const photoCount = Array.isArray(item.photos) ? item.photos.length : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${DK.escapeHtml(item.name)}</td>
        <td class="nowrap">${DK.escapeHtml(item.category)}</td>
        <td class="nowrap">${DK.escapeHtml(item.stockStatus)}</td>
        <td>
          <div class="muted">CPU：${DK.escapeHtml(item.cpu || "-")}｜GPU：${DK.escapeHtml(item.gpu || "-")}</div>
          <div class="muted">RAM：${DK.escapeHtml(item.ram || "-")}｜SSD：${DK.escapeHtml(item.ssd || "-")}</div>
          <div class="muted">標籤：${DK.escapeHtml((item.tags || []).join(", "))}</div>
          <div class="muted">照片：${photoCount} 張</div>
        </td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(item.price) || "-"}</td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(item.id));
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeItem(item.id));

      itemsTbody.appendChild(tr);
    }
  }

  function clearEditor() {
    editingId = null;
    editingPhotos = [];
    itemName.value = "";
    itemCategory.value = "遊戲";
    itemStock.value = "現貨";
    itemCpu.value = "";
    itemGpu.value = "";
    itemRam.value = "";
    itemSsd.value = "";
    itemPrice.value = "";
    itemTags.value = "";
    itemNote.value = "";
    hideMsg(itemMsg);
    renderPhotoStrip();
  }

  function startEdit(id) {
    const item = DK.getInventory().find((x) => x.id === id);
    if (!item) return;
    editingId = id;
    editingPhotos = Array.isArray(item.photos) ? [...item.photos] : [];
    itemName.value = item.name ?? "";
    itemCategory.value = item.category ?? "遊戲";
    itemStock.value = item.stockStatus ?? "現貨";
    itemCpu.value = item.cpu ?? "";
    itemGpu.value = item.gpu ?? "";
    itemRam.value = item.ram ?? "";
    itemSsd.value = item.ssd ?? "";
    itemPrice.value = typeof item.price === "number" ? String(item.price) : "";
    itemTags.value = (item.tags || []).join(", ");
    itemNote.value = item.note ?? "";
    hideMsg(itemMsg);
    showMsg(itemMsg, `正在編輯：${item.name}`);
    renderPhotoStrip();
  }

  function removeItem(id) {
    const items = DK.getInventory();
    const item = items.find((x) => x.id === id);
    if (!item) return;
    if (!confirm(`確定要刪除「${item.name}」？`)) return;
    DK.saveInventory(items.filter((x) => x.id !== id));
    renderTable();
    renderPreview();
    if (editingId === id) clearEditor();
  }

  function saveItem() {
    const name = itemName.value.trim();
    if (!name) {
      showMsg(itemMsg, "商品名稱不能空白。");
      return;
    }

    const tags = itemTags.value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    const priceNum = itemPrice.value ? Number(itemPrice.value) : NaN;
    const price = Number.isFinite(priceNum) ? priceNum : null;

    const next = {
      id: editingId || DK.makeId("item"),
      name,
      category: itemCategory.value,
      stockStatus: itemStock.value,
      cpu: itemCpu.value.trim(),
      gpu: itemGpu.value.trim(),
      ram: itemRam.value.trim(),
      ssd: itemSsd.value.trim(),
      price: price ?? undefined,
      tags,
      note: itemNote.value.trim(),
      photos: editingPhotos.slice(0, 5),
    };

    const items = DK.getInventory();
    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    DK.saveInventory(items);
    renderTable();
    renderPreview();
    hideMsg(itemMsg);
    showMsg(itemMsg, "已儲存商品。回到首頁重新整理即可看到更新。");
  }

  function renderPhotoStrip() {
    if (!photoStrip) return;
    photoStrip.innerHTML = "";

    const count = editingPhotos.length;
    if (photoHint) {
      photoHint.hidden = false;
      photoHint.textContent = `目前相片：${count}/5（選檔後會自動轉成 URL 並儲存）`;
    }

    for (let i = 0; i < editingPhotos.length; i++) {
      const src = editingPhotos[i];
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      wrap.innerHTML = `
        <img alt="商品相片 ${i + 1}" />
        <button type="button" title="移除">×</button>
      `;
      const img = wrap.querySelector("img");
      img.src = src;
      wrap.querySelector("button").addEventListener("click", () => {
        editingPhotos.splice(i, 1);
        renderPhotoStrip();
      });
      photoStrip.appendChild(wrap);
    }
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

  async function addPhotosFromFiles(fileList) {
    hideMsg(itemMsg);
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (files.length === 0) return;

    const remaining = 5 - editingPhotos.length;
    if (remaining <= 0) {
      showMsg(itemMsg, "最多只能放 5 張相片。請先移除再新增。");
      return;
    }

    const picked = files.slice(0, remaining);
    showMsg(itemMsg, `正在處理相片...（${picked.length} 張）`);

    try {
      for (const f of picked) {
        const dataUrl = await fileToCompressedDataUrl(f);
        editingPhotos.push(dataUrl);
        renderPhotoStrip();
      }
      hideMsg(itemMsg);
      showMsg(itemMsg, "相片已加入（已自動轉成 URL 並暫存於此商品）。記得按「儲存商品」。");
    } catch {
      showMsg(itemMsg, "相片處理失敗，請換一張圖片或縮小檔案大小再試一次。");
    }
  }

  /* =========================
     新後台：電腦/顯卡庫存 + 記帳 + 報表
     ========================= */

  function norm(s) {
    return DK.normalizeText(String(s ?? ""));
  }

  // ---- 電腦庫存 ----
  function pcMatches(pc) {
    const q = norm(pcState.query);
    if (pcState.status !== "全部" && pc?.status !== pcState.status) return false;
    if (pcState.type !== "全部" && pc?.type !== pcState.type) return false;
    if (!q) return true;
    const hay = [
      pc?.machineNo,
      pc?.type,
      pc?.status,
      pc?.cpu,
      pc?.gpu,
      pc?.ram,
      pc?.storage,
      pc?.customer,
      pc?.source,
      pc?.note,
    ]
      .map(norm)
      .join(" ");
    return hay.includes(q);
  }

  function renderPcCostSummary() {
    if (!pcCostSummary) return;
    const costBase = Number(pcCostBase?.value || 0);
    const costAddon = Number(pcCostAddon?.value || 0);
    const costRefurb = Number(pcCostRefurb?.value || 0);
    const totalCost = DK.calcTotalCostPC({ costBase, costAddon, costRefurb });
    const suggested = Number(pcSuggestedPrice?.value || 0);
    const estProfit = (Number.isFinite(suggested) ? suggested : 0) - totalCost;
    pcCostSummary.textContent = `總成本：NT$ ${DK.formatPrice(totalCost) || "0"}｜預估毛利（建議售價 - 總成本）：NT$ ${DK.formatPrice(estProfit) || "0"}`;
  }

  function clearPcEditor() {
    pcEditingId = null;
    if (deletePcBtn) deletePcBtn.hidden = true;
    hideMsg(pcMsg);

    const pcs = DK.getComputers();
    const nextNo = DK.nextNumber("DK", pcs.map((x) => x.machineNo));
    if (pcMachineNo) pcMachineNo.value = nextNo;
    if (pcType) pcType.value = "電競機";
    if (pcStatus) pcStatus.value = "在庫";
    if (pcListedAt) pcListedAt.value = DK.todayISO();
    if (pcSoldAt) pcSoldAt.value = "";
    if (pcSoldPrice) pcSoldPrice.value = "";

    if (pcCpu) pcCpu.value = "";
    if (pcMotherboard) pcMotherboard.value = "";
    if (pcRam) pcRam.value = "";
    if (pcStorage) pcStorage.value = "";
    if (pcGpu) pcGpu.value = "";
    if (pcPsu) pcPsu.value = "";
    if (pcCase) pcCase.value = "";

    if (pcCostBase) pcCostBase.value = "";
    if (pcCostAddon) pcCostAddon.value = "";
    if (pcCostRefurb) pcCostRefurb.value = "";

    if (pcSuggestedPrice) pcSuggestedPrice.value = "";
    if (pcMinPrice) pcMinPrice.value = "";

    if (pcSource) pcSource.value = "";
    if (pcCustomer) pcCustomer.value = "";
    if (pcNote) pcNote.value = "";

    renderPcCostSummary();
  }

  function startEditPc(id) {
    const pc = DK.getComputers().find((x) => x.id === id);
    if (!pc) return;
    pcEditingId = id;
    if (deletePcBtn) deletePcBtn.hidden = false;
    hideMsg(pcMsg);
    showMsg(pcMsg, `正在編輯：${pc.machineNo || pc.id}`);

    if (pcMachineNo) pcMachineNo.value = pc.machineNo ?? "";
    if (pcType) pcType.value = pc.type ?? "電競機";
    if (pcStatus) pcStatus.value = pc.status ?? "在庫";
    if (pcListedAt) pcListedAt.value = pc.listedAt ?? "";
    if (pcSoldAt) pcSoldAt.value = pc.soldAt ?? "";
    if (pcSoldPrice) pcSoldPrice.value = pc.soldPrice != null ? String(pc.soldPrice) : "";

    if (pcCpu) pcCpu.value = pc.cpu ?? "";
    if (pcMotherboard) pcMotherboard.value = pc.motherboard ?? "";
    if (pcRam) pcRam.value = pc.ram ?? "";
    if (pcStorage) pcStorage.value = pc.storage ?? "";
    if (pcGpu) pcGpu.value = pc.gpu ?? "";
    if (pcPsu) pcPsu.value = pc.psu ?? "";
    if (pcCase) pcCase.value = pc.case ?? "";

    if (pcCostBase) pcCostBase.value = pc.costBase != null ? String(pc.costBase) : "";
    if (pcCostAddon) pcCostAddon.value = pc.costAddon != null ? String(pc.costAddon) : "";
    if (pcCostRefurb) pcCostRefurb.value = pc.costRefurb != null ? String(pc.costRefurb) : "";

    if (pcSuggestedPrice) pcSuggestedPrice.value = pc.suggestedPrice != null ? String(pc.suggestedPrice) : "";
    if (pcMinPrice) pcMinPrice.value = pc.minPrice != null ? String(pc.minPrice) : "";

    if (pcSource) pcSource.value = pc.source ?? "";
    if (pcCustomer) pcCustomer.value = pc.customer ?? "";
    if (pcNote) pcNote.value = pc.note ?? "";

    renderPcCostSummary();
  }

  function removePc(id) {
    const pcs = DK.getComputers();
    const pc = pcs.find((x) => x.id === id);
    if (!pc) return;
    if (!confirm(`確定要刪除「${pc.machineNo || pc.id}」？`)) return;
    DK.saveComputers(pcs.filter((x) => x.id !== id));
    renderPcTable();
    if (pcEditingId === id) clearPcEditor();
  }

  function savePc() {
    hideMsg(pcMsg);
    const machineNo = String(pcMachineNo?.value || "").trim();
    if (!machineNo) {
      showMsg(pcMsg, "機器編號不能空白（例如 DK-023）。");
      return;
    }

    const pcs = DK.getComputers();
    const dup = pcs.find((x) => x.machineNo === machineNo && x.id !== pcEditingId);
    if (dup) {
      showMsg(pcMsg, `機器編號重複：${machineNo}（請換一個編號）`);
      return;
    }

    const status = pcStatus?.value || "在庫";
    let soldAt = String(pcSoldAt?.value || "").trim();
    const soldPrice = DK.toNumber(pcSoldPrice?.value);
    if (status === "已售出") {
      if (!soldAt) soldAt = DK.todayISO();
      if (soldPrice == null) {
        showMsg(pcMsg, "狀態是「已售出」時，請填售出金額。");
        return;
      }
    } else {
      soldAt = "";
    }

    const next = {
      id: pcEditingId || DK.makeId("pc"),
      machineNo,
      type: pcType?.value || "電競機",
      cpu: String(pcCpu?.value || "").trim(),
      motherboard: String(pcMotherboard?.value || "").trim(),
      ram: String(pcRam?.value || "").trim(),
      storage: String(pcStorage?.value || "").trim(),
      gpu: String(pcGpu?.value || "").trim(),
      psu: String(pcPsu?.value || "").trim(),
      case: String(pcCase?.value || "").trim(),
      costBase: DK.toNumber(pcCostBase?.value) || 0,
      costAddon: DK.toNumber(pcCostAddon?.value) || 0,
      costRefurb: DK.toNumber(pcCostRefurb?.value) || 0,
      suggestedPrice: DK.toNumber(pcSuggestedPrice?.value),
      minPrice: DK.toNumber(pcMinPrice?.value),
      status,
      listedAt: String(pcListedAt?.value || "").trim() || DK.todayISO(),
      soldAt,
      soldPrice,
      source: String(pcSource?.value || "").trim(),
      customer: String(pcCustomer?.value || "").trim(),
      note: String(pcNote?.value || "").trim(),
    };

    const idx = pcs.findIndex((x) => x.id === next.id);
    if (idx >= 0) pcs[idx] = next;
    else pcs.unshift(next);
    DK.saveComputers(pcs);
    renderPcTable();
    showMsg(pcMsg, "已儲存電腦。");
  }

  function renderPcTable() {
    if (!pcsTbody) return;
    const pcs = DK.getComputers().filter(pcMatches);
    pcsTbody.innerHTML = "";

    for (const pc of pcs) {
      const totalCost = DK.calcTotalCostPC(pc);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${DK.escapeHtml(pc.machineNo || "-")}</span></td>
        <td class="nowrap">${DK.escapeHtml(pc.type || "-")}</td>
        <td class="nowrap">${DK.escapeHtml(pc.status || "-")}</td>
        <td>
          <div class="muted">CPU：${DK.escapeHtml(pc.cpu || "-")}｜GPU：${DK.escapeHtml(pc.gpu || "-")}</div>
          <div class="muted">RAM：${DK.escapeHtml(pc.ram || "-")}｜SSD/HDD：${DK.escapeHtml(pc.storage || "-")}</div>
          <div class="muted">客人：${DK.escapeHtml(pc.customer || "-")}｜來源：${DK.escapeHtml(pc.source || "-")}</div>
        </td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(totalCost) || "0"}</td>
        <td class="nowrap">
          <div class="muted">建議：<span class="mono">NT$</span> ${DK.formatPrice(pc.suggestedPrice) || "-"}</div>
          <div class="muted">最低：<span class="mono">NT$</span> ${DK.formatPrice(pc.minPrice) || "-"}</div>
        </td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
        switchTab("computers");
        startEditPc(pc.id);
        pcMachineNo?.focus();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removePc(pc.id));
      pcsTbody.appendChild(tr);
    }
  }

  // ---- 顯卡庫存 ----
  function gpuMatches(g) {
    const q = norm(gpuState.query);
    if (gpuState.status !== "全部" && g?.status !== gpuState.status) return false;
    if (gpuState.test !== "全部" && g?.testStatus !== gpuState.test) return false;
    if (!q) return true;
    const hay = [g?.gpuNo, g?.model, g?.brand, g?.origin, g?.status, g?.testStatus, g?.customer, g?.source, g?.note]
      .map(norm)
      .join(" ");
    return hay.includes(q);
  }

  function clearGpuEditor() {
    gpuEditingId = null;
    if (deleteGpuBtn) deleteGpuBtn.hidden = true;
    hideMsg(gpuMsg);

    const gpus = DK.getGpus();
    const nextNo = DK.nextNumber("GPU", gpus.map((x) => x.gpuNo));
    if (gpuNo) gpuNo.value = nextNo;
    if (gpuModel) gpuModel.value = "";
    if (gpuBrand) gpuBrand.value = "";
    if (gpuFans) gpuFans.value = "";
    if (gpuOrigin) gpuOrigin.value = "";
    if (gpuCost) gpuCost.value = "";
    if (gpuTestStatus) gpuTestStatus.value = "OK";
    if (gpuWarranty) gpuWarranty.value = "N";
    if (gpuStatus) gpuStatus.value = "在庫";
    if (gpuListedAt) gpuListedAt.value = DK.todayISO();
    if (gpuSoldAt) gpuSoldAt.value = "";
    if (gpuSoldPrice) gpuSoldPrice.value = "";
    if (gpuSuggestedPrice) gpuSuggestedPrice.value = "";
    if (gpuMinPrice) gpuMinPrice.value = "";
    if (gpuSource) gpuSource.value = "";
    if (gpuCustomer) gpuCustomer.value = "";
    if (gpuNote) gpuNote.value = "";
  }

  function startEditGpu(id) {
    const g = DK.getGpus().find((x) => x.id === id);
    if (!g) return;
    gpuEditingId = id;
    if (deleteGpuBtn) deleteGpuBtn.hidden = false;
    hideMsg(gpuMsg);
    showMsg(gpuMsg, `正在編輯：${g.gpuNo || g.id}`);

    if (gpuNo) gpuNo.value = g.gpuNo ?? "";
    if (gpuModel) gpuModel.value = g.model ?? "";
    if (gpuBrand) gpuBrand.value = g.brand ?? "";
    if (gpuFans) gpuFans.value = g.fans != null ? String(g.fans) : "";
    if (gpuOrigin) gpuOrigin.value = g.origin ?? "";
    if (gpuCost) gpuCost.value = g.cost != null ? String(g.cost) : "";
    if (gpuTestStatus) gpuTestStatus.value = g.testStatus ?? "OK";
    if (gpuWarranty) gpuWarranty.value = g.warranty ? "Y" : "N";
    if (gpuStatus) gpuStatus.value = g.status ?? "在庫";
    if (gpuListedAt) gpuListedAt.value = g.listedAt ?? "";
    if (gpuSoldAt) gpuSoldAt.value = g.soldAt ?? "";
    if (gpuSoldPrice) gpuSoldPrice.value = g.soldPrice != null ? String(g.soldPrice) : "";
    if (gpuSuggestedPrice) gpuSuggestedPrice.value = g.suggestedPrice != null ? String(g.suggestedPrice) : "";
    if (gpuMinPrice) gpuMinPrice.value = g.minPrice != null ? String(g.minPrice) : "";
    if (gpuSource) gpuSource.value = g.source ?? "";
    if (gpuCustomer) gpuCustomer.value = g.customer ?? "";
    if (gpuNote) gpuNote.value = g.note ?? "";
  }

  function removeGpu(id) {
    const items = DK.getGpus();
    const g = items.find((x) => x.id === id);
    if (!g) return;
    if (!confirm(`確定要刪除「${g.gpuNo || g.id}」？`)) return;
    DK.saveGpus(items.filter((x) => x.id !== id));
    renderGpuTable();
    if (gpuEditingId === id) clearGpuEditor();
  }

  function saveGpu() {
    hideMsg(gpuMsg);
    const code = String(gpuNo?.value || "").trim();
    if (!code) {
      showMsg(gpuMsg, "顯卡編號不能空白（例如 GPU-023）。");
      return;
    }
    const items = DK.getGpus();
    const dup = items.find((x) => x.gpuNo === code && x.id !== gpuEditingId);
    if (dup) {
      showMsg(gpuMsg, `顯卡編號重複：${code}`);
      return;
    }

    const status = gpuStatus?.value || "在庫";
    let soldAt = String(gpuSoldAt?.value || "").trim();
    const soldPrice = DK.toNumber(gpuSoldPrice?.value);
    if (status === "已售出") {
      if (!soldAt) soldAt = DK.todayISO();
      if (soldPrice == null) {
        showMsg(gpuMsg, "狀態是「已售出」時，請填售出金額。");
        return;
      }
    } else {
      soldAt = "";
    }

    const next = {
      id: gpuEditingId || DK.makeId("gpu"),
      gpuNo: code,
      model: String(gpuModel?.value || "").trim(),
      brand: String(gpuBrand?.value || "").trim(),
      fans: DK.toNumber(gpuFans?.value) ?? undefined,
      origin: String(gpuOrigin?.value || "").trim(),
      cost: DK.toNumber(gpuCost?.value) || 0,
      testStatus: gpuTestStatus?.value || "OK",
      warranty: (gpuWarranty?.value || "N") === "Y",
      suggestedPrice: DK.toNumber(gpuSuggestedPrice?.value),
      minPrice: DK.toNumber(gpuMinPrice?.value),
      status,
      listedAt: String(gpuListedAt?.value || "").trim() || DK.todayISO(),
      soldAt,
      soldPrice,
      source: String(gpuSource?.value || "").trim(),
      customer: String(gpuCustomer?.value || "").trim(),
      note: String(gpuNote?.value || "").trim(),
    };

    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    DK.saveGpus(items);
    renderGpuTable();
    showMsg(gpuMsg, "已儲存顯卡。");
  }

  function renderGpuTable() {
    if (!gpusTbody) return;
    const items = DK.getGpus().filter(gpuMatches);
    gpusTbody.innerHTML = "";
    for (const g of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${DK.escapeHtml(g.gpuNo || "-")}</span></td>
        <td>${DK.escapeHtml(g.model || "-")}<div class="muted">${DK.escapeHtml(g.brand || "-")}｜${DK.escapeHtml(g.origin || "-")}｜風扇：${DK.escapeHtml(g.fans ?? "-")}</div></td>
        <td class="nowrap">${DK.escapeHtml(g.testStatus || "-")}</td>
        <td class="nowrap">${g.warranty ? "Y" : "N"}</td>
        <td class="nowrap">${DK.escapeHtml(g.status || "-")}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(g.cost) || "0"}</td>
        <td class="nowrap">
          <div class="muted">建議：<span class="mono">NT$</span> ${DK.formatPrice(g.suggestedPrice) || "-"}</div>
          <div class="muted">最低：<span class="mono">NT$</span> ${DK.formatPrice(g.minPrice) || "-"}</div>
        </td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
        switchTab("gpus");
        startEditGpu(g.id);
        gpuNo?.focus();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeGpu(g.id));
      gpusTbody.appendChild(tr);
    }
  }

  // ---- 其他收入（維修/配件/升級） ----
  function clearMiscEditor() {
    miscEditingId = null;
    if (deleteMiscBtn) deleteMiscBtn.hidden = true;
    hideMsg(miscMsg);
    if (miscDate) miscDate.value = DK.todayISO();
    if (miscCategory) miscCategory.value = "維修收入";
    if (miscRevenue) miscRevenue.value = "";
    if (miscCost) miscCost.value = "";
    if (miscSource) miscSource.value = "";
    if (miscCustomer) miscCustomer.value = "";
    if (miscNote) miscNote.value = "";
  }

  function startEditMisc(id) {
    const items = DK.getMisc();
    const m = items.find((x) => x.id === id);
    if (!m) return;
    miscEditingId = id;
    if (deleteMiscBtn) deleteMiscBtn.hidden = false;
    hideMsg(miscMsg);
    showMsg(miscMsg, `正在編輯：${m.date}｜${m.category}`);
    if (miscDate) miscDate.value = m.date ?? "";
    if (miscCategory) miscCategory.value = m.category ?? "維修收入";
    if (miscRevenue) miscRevenue.value = m.revenue != null ? String(m.revenue) : "";
    if (miscCost) miscCost.value = m.cost != null ? String(m.cost) : "";
    if (miscSource) miscSource.value = m.source ?? "";
    if (miscCustomer) miscCustomer.value = m.customer ?? "";
    if (miscNote) miscNote.value = m.note ?? "";
  }

  function saveMisc() {
    hideMsg(miscMsg);
    const date = String(miscDate?.value || "").trim() || DK.todayISO();
    const category = miscCategory?.value || "維修收入";
    const revenue = DK.toNumber(miscRevenue?.value);
    if (revenue == null) {
      showMsg(miscMsg, "請填收入金額。");
      return;
    }
    const cost = DK.toNumber(miscCost?.value) || 0;
    const next = {
      id: miscEditingId || DK.makeId("misc"),
      date,
      category,
      revenue,
      cost,
      source: String(miscSource?.value || "").trim(),
      customer: String(miscCustomer?.value || "").trim(),
      note: String(miscNote?.value || "").trim(),
    };
    const items = DK.getMisc();
    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    DK.saveMisc(items);
    renderMiscTable();
    renderReport();
    showMsg(miscMsg, "已儲存。");
  }

  function removeMisc(id) {
    const items = DK.getMisc();
    const m = items.find((x) => x.id === id);
    if (!m) return;
    if (!confirm(`確定要刪除這筆？（${m.date}｜${m.category}｜NT$ ${DK.formatPrice(m.revenue)}）`)) return;
    DK.saveMisc(items.filter((x) => x.id !== id));
    renderMiscTable();
    renderReport();
    if (miscEditingId === id) clearMiscEditor();
  }

  function renderMiscTable() {
    if (!miscTbody) return;
    const items = DK.getMisc();
    miscTbody.innerHTML = "";
    for (const m of items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap">${DK.escapeHtml(m.date || "-")}</td>
        <td class="nowrap">${DK.escapeHtml(m.category || "-")}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(m.revenue) || "-"}</td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(m.cost) || "-"}</td>
        <td>${DK.escapeHtml(m.note || "")}<div class="muted">來源：${DK.escapeHtml(m.source || "-")}｜客人：${DK.escapeHtml(m.customer || "-")}</div></td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => startEditMisc(m.id));
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeMisc(m.id));
      miscTbody.appendChild(tr);
    }
  }

  // ---- 報表 ----
  function monthStr(d) {
    const s = String(d || "");
    if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
    return "";
  }

  function groupSum(items, keyFn, valFn) {
    const map = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (!k) continue;
      const v = valFn(it);
      map.set(k, (map.get(k) || 0) + (Number.isFinite(v) ? v : 0));
    }
    return map;
  }

  function groupCount(items, keyFn) {
    const map = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (!k) continue;
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  function renderReport() {
    if (!reportWrap) return;
    const m = reportMonth?.value || DK.todayISO().slice(0, 7);
    if (reportMonth && !reportMonth.value) reportMonth.value = m;

    const pcsSold = DK.getComputers().filter((x) => x.status === "已售出" && monthStr(x.soldAt) === m && typeof x.soldPrice === "number");
    const gpusSold = DK.getGpus().filter((x) => x.status === "已售出" && monthStr(x.soldAt) === m && typeof x.soldPrice === "number");
    const miscInMonth = DK.getMisc().filter((x) => monthStr(x.date) === m && typeof x.revenue === "number");

    const pcRevenue = pcsSold.reduce((s, x) => s + (x.soldPrice || 0), 0);
    const pcCost = pcsSold.reduce((s, x) => s + DK.calcTotalCostPC(x), 0);
    const gpuRevenue = gpusSold.reduce((s, x) => s + (x.soldPrice || 0), 0);
    const gpuCost = gpusSold.reduce((s, x) => s + (x.cost || 0), 0);
    const miscRevenue = miscInMonth.reduce((s, x) => s + (x.revenue || 0), 0);
    const miscCost = miscInMonth.reduce((s, x) => s + (x.cost || 0), 0);

    const revenue = pcRevenue + gpuRevenue + miscRevenue;
    const cost = pcCost + gpuCost + miscCost;
    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    const txCount = pcsSold.length + gpusSold.length + miscInMonth.length;
    const avgOrder = txCount > 0 ? revenue / txCount : 0;
    const avgProfit = txCount > 0 ? profit / txCount : 0;

    // 回購比例：本月有客人，且在本月前曾經成交過
    const allTx = [
      ...DK.getComputers().filter((x) => x.status === "已售出" && x.customer && x.soldAt),
      ...DK.getGpus().filter((x) => x.status === "已售出" && x.customer && x.soldAt),
      ...DK.getMisc().filter((x) => x.customer && x.date),
    ];
    const monthCustomers = new Set(
      [
        ...pcsSold.map((x) => (x.customer || "").trim()),
        ...gpusSold.map((x) => (x.customer || "").trim()),
        ...miscInMonth.map((x) => (x.customer || "").trim()),
      ].filter(Boolean),
    );
    let repurchase = 0;
    for (const c of monthCustomers) {
      const hadBefore = allTx.some((x) => (x.customer || "").trim() === c && monthStr(x.soldAt || x.date) < m);
      if (hadBefore) repurchase++;
    }
    const repurchaseRate = monthCustomers.size > 0 ? (repurchase / monthCustomers.size) * 100 : 0;

    const pcByTypeRevenue = groupSum(pcsSold, (x) => x.type || "未分類", (x) => x.soldPrice || 0);
    const pcByTypeCount = groupCount(pcsSold, (x) => x.type || "未分類");
    const miscByCatRevenue = groupSum(miscInMonth, (x) => x.category || "其他", (x) => x.revenue || 0);

    const srcItems = [
      ...pcsSold.map((x) => ({ source: x.source, revenue: x.soldPrice || 0 })),
      ...gpusSold.map((x) => ({ source: x.source, revenue: x.soldPrice || 0 })),
      ...miscInMonth.map((x) => ({ source: x.source, revenue: x.revenue || 0 })),
    ];
    const srcRevenue = groupSum(srcItems, (x) => (x.source || "未填").trim() || "未填", (x) => x.revenue || 0);
    const srcCount = groupCount(srcItems, (x) => (x.source || "未填").trim() || "未填");

    function renderRowsFromMap(map, countMap) {
      const keys = [...map.keys()].sort((a, b) => (map.get(b) || 0) - (map.get(a) || 0));
      return keys
        .map((k) => `<tr><td>${DK.escapeHtml(k)}</td><td class="nowrap">${countMap ? (countMap.get(k) || 0) : "-"}</td><td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(map.get(k) || 0)}</td></tr>`)
        .join("");
    }

    reportWrap.innerHTML = `
      <div class="card">
        <h3 class="h3">每月營收總覽（${DK.escapeHtml(m)}）</h3>
        <div class="spec" style="margin-top:10px">
          <div class="row"><div class="k">成交數</div><div class="v">${txCount}（主機 ${pcsSold.length} / 顯卡 ${gpusSold.length} / 其他 ${miscInMonth.length}）</div></div>
          <div class="row"><div class="k">總營收</div><div class="v"><span class="mono">NT$</span> ${DK.formatPrice(revenue) || "0"}</div></div>
          <div class="row"><div class="k">總成本</div><div class="v"><span class="mono">NT$</span> ${DK.formatPrice(cost) || "0"}</div></div>
          <div class="row"><div class="k">毛利</div><div class="v"><span class="mono">NT$</span> ${DK.formatPrice(profit) || "0"}</div></div>
          <div class="row"><div class="k">毛利率</div><div class="v">${margin.toFixed(1)}%</div></div>
        </div>
      </div>

      <div class="card">
        <h3 class="h3">老闆 3 個關鍵指標</h3>
        <div class="spec" style="margin-top:10px">
          <div class="row"><div class="k">平均單價</div><div class="v"><span class="mono">NT$</span> ${DK.formatPrice(Math.round(avgOrder)) || "0"}</div></div>
          <div class="row"><div class="k">平均毛利</div><div class="v"><span class="mono">NT$</span> ${DK.formatPrice(Math.round(avgProfit)) || "0"}</div></div>
          <div class="row"><div class="k">回購客</div><div class="v">${repurchaseRate.toFixed(1)}%（以「客人欄位」判斷）</div></div>
        </div>
        <div class="muted" style="margin-top:10px">毛利率參考：&lt;15% 太硬撐｜15–25% 正常｜25% 以上很漂亮</div>
      </div>

      <div class="card">
        <h3 class="h3">分類收入（主機）</h3>
        <table class="table" style="margin-top:10px">
          <thead><tr><th>類型</th><th class="nowrap">成交數</th><th class="nowrap">營收</th></tr></thead>
          <tbody>
            ${renderRowsFromMap(pcByTypeRevenue, pcByTypeCount) || `<tr><td colspan="3" class="muted">本月無主機售出</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:10px">顯卡營收：<span class="mono">NT$</span> ${DK.formatPrice(gpuRevenue) || "0"}｜維修/其他：<span class="mono">NT$</span> ${DK.formatPrice(miscRevenue) || "0"}</div>
      </div>

      <div class="card">
        <h3 class="h3">行銷來源成效</h3>
        <table class="table" style="margin-top:10px">
          <thead><tr><th>來源</th><th class="nowrap">成交數</th><th class="nowrap">營收</th></tr></thead>
          <tbody>
            ${renderRowsFromMap(srcRevenue, srcCount) || `<tr><td colspan="3" class="muted">本月無資料</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }

  // ---- 匯入/匯出 ----
  function exportToTextarea() {
    if (!dataText) return;
    dataText.value = DK.exportAllData();
    hideMsg(dataMsg);
    showMsg(dataMsg, "已產生備份 JSON（可複製保存）。");
  }

  async function copyTextarea() {
    if (!dataText) return;
    try {
      await navigator.clipboard.writeText(dataText.value || "");
      hideMsg(dataMsg);
      showMsg(dataMsg, "已複製到剪貼簿。");
    } catch {
      hideMsg(dataMsg);
      showMsg(dataMsg, "複製失敗（瀏覽器不允許）。你可以手動全選複製。");
    }
  }

  function importFromTextarea() {
    hideMsg(dataMsg);
    const text = String(dataText?.value || "").trim();
    if (!text) {
      showMsg(dataMsg, "請先貼上備份 JSON。");
      return;
    }
    if (!confirm("確定要匯入？（會覆蓋目前資料）")) return;
    try {
      DK.importAllData(text);
      loadSettingsForm();
      renderTable();
      renderPreview();
      renderPcTable();
      renderGpuTable();
      renderMiscTable();
      renderReport();
      showMsg(dataMsg, "已匯入完成。");
    } catch {
      showMsg(dataMsg, "匯入失敗：JSON 格式不正確或內容不完整。");
    }
  }

  function clearAllData() {
    if (!confirm("確定要清空所有資料？（設定/庫存/電腦/顯卡/記帳都會清空）")) return;
    DK.saveConfig(DK.DEFAULT_CONFIG);
    DK.saveInventory([...DK.DEFAULT_INVENTORY]);
    DK.saveComputers([...DK.DEFAULT_COMPUTERS]);
    DK.saveGpus([...DK.DEFAULT_GPUS]);
    DK.saveMisc([...DK.DEFAULT_MISC]);
    loadSettingsForm();
    renderTable();
    renderPreview();
    renderPcTable();
    renderGpuTable();
    renderMiscTable();
    renderReport();
    hideMsg(dataMsg);
    showMsg(dataMsg, "已清空並重置為預設。");
  }

  // auth
  function doLogin() {
    hideMsg(loginError);
    const cfg = DK.getConfig();
    const u = usernameEl.value.trim();
    const p = passwordEl.value;
    if (u === cfg.admin.username && p === cfg.admin.password) {
      DK.setAdminAuthed(true);
      applyAuthUI();
      loadSettingsForm();
      renderTable();
      renderPreview();
      clearEditor();
      renderPcTable();
      renderGpuTable();
      renderMiscTable();
      clearPcEditor();
      clearGpuEditor();
      clearMiscEditor();
      if (reportMonth && !reportMonth.value) reportMonth.value = DK.todayISO().slice(0, 7);
      switchTab("settings");
      return;
    }
    showMsg(loginError, "帳號或密碼錯誤。");
  }

  // events
  loginBtn?.addEventListener("click", doLogin);
  passwordEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  logoutBtn?.addEventListener("click", () => {
    DK.setAdminAuthed(false);
    applyAuthUI();
  });

  for (const t of tabs) {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  }

  saveSettingsBtn?.addEventListener("click", saveSettings);

  const inventoryCategorySearch = document.getElementById("inventoryCategorySearch");
  const newInventoryCategory = document.getElementById("newInventoryCategory");
  const addInventoryCategoryBtn = document.getElementById("addInventoryCategoryBtn");
  if (inventoryCategorySearch) inventoryCategorySearch.addEventListener("input", renderInventoryCategoriesTable);
  if (addInventoryCategoryBtn && newInventoryCategory) {
    addInventoryCategoryBtn.addEventListener("click", function () {
      const name = newInventoryCategory.value.trim();
      if (!name) return;
      if (currentInventoryCategories.indexOf(name) >= 0) return;
      currentInventoryCategories.push(name);
      newInventoryCategory.value = "";
      renderInventoryCategoriesTable();
    });
  }
  resetBtn?.addEventListener("click", () => {
    if (!confirm("確定要重置為預設？（設定 + 庫存 + 電腦/顯卡/記帳都會重置）")) return;
    resetAll();
  });

  // 電腦庫存 events
  newPcBtn?.addEventListener("click", () => {
    switchTab("computers");
    clearPcEditor();
    showMsg(pcMsg, "新增電腦：填寫後按「儲存電腦」。");
    pcMachineNo?.focus();
  });
  savePcBtn?.addEventListener("click", savePc);
  cancelPcBtn?.addEventListener("click", clearPcEditor);
  deletePcBtn?.addEventListener("click", () => {
    if (!pcEditingId) return;
    removePc(pcEditingId);
  });
  pcSearchInput?.addEventListener("input", () => {
    pcState.query = pcSearchInput.value;
    renderPcTable();
  });
  pcStatusSelect?.addEventListener("change", () => {
    pcState.status = pcStatusSelect.value;
    renderPcTable();
  });
  pcTypeSelect?.addEventListener("change", () => {
    pcState.type = pcTypeSelect.value;
    renderPcTable();
  });
  for (const el of [pcCostBase, pcCostAddon, pcCostRefurb, pcSuggestedPrice]) {
    el?.addEventListener("input", renderPcCostSummary);
  }
  pcStatus?.addEventListener("change", () => {
    if (pcStatus.value === "已售出") {
      if (pcSoldAt && !pcSoldAt.value) pcSoldAt.value = DK.todayISO();
    } else {
      if (pcSoldAt) pcSoldAt.value = "";
      if (pcSoldPrice) pcSoldPrice.value = "";
    }
  });

  // 顯卡庫存 events
  newGpuBtn?.addEventListener("click", () => {
    switchTab("gpus");
    clearGpuEditor();
    showMsg(gpuMsg, "新增顯卡：填寫後按「儲存顯卡」。");
    gpuNo?.focus();
  });
  saveGpuBtn?.addEventListener("click", saveGpu);
  cancelGpuBtn?.addEventListener("click", clearGpuEditor);
  deleteGpuBtn?.addEventListener("click", () => {
    if (!gpuEditingId) return;
    removeGpu(gpuEditingId);
  });
  gpuSearchInput?.addEventListener("input", () => {
    gpuState.query = gpuSearchInput.value;
    renderGpuTable();
  });
  gpuStatusSelect?.addEventListener("change", () => {
    gpuState.status = gpuStatusSelect.value;
    renderGpuTable();
  });
  gpuTestSelect?.addEventListener("change", () => {
    gpuState.test = gpuTestSelect.value;
    renderGpuTable();
  });
  gpuStatus?.addEventListener("change", () => {
    if (gpuStatus.value === "已售出") {
      if (gpuSoldAt && !gpuSoldAt.value) gpuSoldAt.value = DK.todayISO();
    } else {
      if (gpuSoldAt) gpuSoldAt.value = "";
      if (gpuSoldPrice) gpuSoldPrice.value = "";
    }
  });

  // 報表 / 其他收入 events
  refreshReportBtn?.addEventListener("click", renderReport);
  reportMonth?.addEventListener("change", renderReport);
  newMiscBtn?.addEventListener("click", () => {
    clearMiscEditor();
    showMsg(miscMsg, "新增一筆其他收入：填寫後按「儲存」。");
    miscDate?.focus();
  });
  saveMiscBtn?.addEventListener("click", saveMisc);
  cancelMiscBtn?.addEventListener("click", clearMiscEditor);
  deleteMiscBtn?.addEventListener("click", () => {
    if (!miscEditingId) return;
    removeMisc(miscEditingId);
  });

  // 匯入/匯出 events
  exportAllBtn?.addEventListener("click", exportToTextarea);
  copyAllBtn?.addEventListener("click", copyTextarea);
  importAllBtn?.addEventListener("click", importFromTextarea);
  clearDataBtn?.addEventListener("click", clearAllData);

  newItemBtn?.addEventListener("click", () => {
    clearEditor();
    showMsg(itemMsg, "新增商品：請填寫後按「儲存商品」。");
    itemName.focus();
  });
  saveItemBtn?.addEventListener("click", saveItem);
  cancelEditBtn?.addEventListener("click", clearEditor);

  itemPhotos?.addEventListener("change", async () => {
    await addPhotosFromFiles(itemPhotos.files);
    itemPhotos.value = "";
  });

  previewSearchInput?.addEventListener("input", () => {
    previewState.query = previewSearchInput.value;
    renderPreview();
  });

  previewStockSelect?.addEventListener("change", () => {
    previewState.stock = previewStockSelect.value;
    renderPreview();
  });

  for (const seg of previewSegs) {
    seg.addEventListener("click", () => {
      for (const s of previewSegs) s.classList.remove("active");
      seg.classList.add("active");
      previewState.category = seg.dataset.category || "全部";
      renderPreview();
    });
  }

  // init
  applyAuthUI();
  if (DK.isAdminAuthed()) {
    loadSettingsForm();
    renderTable();
    renderPreview();
    clearEditor();
    renderPcTable();
    renderGpuTable();
    renderMiscTable();
    clearPcEditor();
    clearGpuEditor();
    clearMiscEditor();
    if (reportMonth && !reportMonth.value) reportMonth.value = DK.todayISO().slice(0, 7);
  }
})();

