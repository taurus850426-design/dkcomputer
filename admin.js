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

  if (!loginCard || !panel) return;

  let editingId = null;
  let editingPhotos = [];
  let previewState = {
    query: "",
    category: "全部",
    stock: "全部",
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
    if (tabName === "preview") renderPreview();
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
    adminPassInput.value = cfg.admin?.password ?? "";
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
        password: adminPassInput.value.trim() || "admin123",
      },
    };
    DK.saveConfig(next);
    hideMsg(settingsMsg);
    showMsg(settingsMsg, "已儲存設定。回到首頁重新整理即可看到更新。");
  }

  function resetAll() {
    DK.saveConfig(DK.DEFAULT_CONFIG);
    DK.saveInventory([...DK.DEFAULT_INVENTORY]);
    loadSettingsForm();
    renderTable();
    renderPreview();
    hideMsg(settingsMsg);
    showMsg(settingsMsg, "已重置為預設（設定 + 庫存）。");
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
  resetBtn?.addEventListener("click", () => {
    if (!confirm("確定要重置為預設？（設定 + 庫存都會重置）")) return;
    resetAll();
  });

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
  }
})();

