/* admin2.js - 簡化後台：一個庫存 + 自訂欄位 + 記帳/報表 + 匯入/匯出 */

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
  const tabStock = document.getElementById("tab-stock");
  const tabPublish = document.getElementById("tab-publish");
  const tabReports = document.getElementById("tab-reports");
  const tabData = document.getElementById("tab-data");

  // settings inputs（沿用原本）
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

  // stock（新：一個庫存）
  const newStockBtn = document.getElementById("newStockBtn");
  const stockSearchInput = document.getElementById("stockSearchInput");
  const stockStatusSelect = document.getElementById("stockStatusSelect");
  const stockKindSelect = document.getElementById("stockKindSelect");
  const schemaTbody = document.getElementById("schemaTbody");
  const newFieldLabel = document.getElementById("newFieldLabel");
  const addFieldBtn = document.getElementById("addFieldBtn");

  // kinds（庫存類別）
  const newKindLabel = document.getElementById("newKindLabel");
  const newKindPrefix = document.getElementById("newKindPrefix");
  const addKindBtn = document.getElementById("addKindBtn");
  const kindsTbody = document.getElementById("kindsTbody");
  const kindsMsg = document.getElementById("kindsMsg");

  const stockNo = document.getElementById("stockNo");
  const stockKind = document.getElementById("stockKind");
  const stockType = document.getElementById("stockType");
  const stockStatus = document.getElementById("stockStatus");
  const stockListedAt = document.getElementById("stockListedAt");
  const stockSoldAt = document.getElementById("stockSoldAt");
  const stockSoldPrice = document.getElementById("stockSoldPrice");
  const stockBrand = document.getElementById("stockBrand");
  const stockCostTotal = document.getElementById("stockCostTotal");
  const stockModelSpec = document.getElementById("stockModelSpec");
  const stockSuggestedPrice = document.getElementById("stockSuggestedPrice");
  const stockMinPrice = document.getElementById("stockMinPrice");
  const stockCostSummary = document.getElementById("stockCostSummary");
  const stockSource = document.getElementById("stockSource");
  const stockCustomer = document.getElementById("stockCustomer");
  const stockNote = document.getElementById("stockNote");
  const stockSpecGrid = document.getElementById("stockSpecGrid");
  const webPublish = document.getElementById("webPublish");
  const webName = document.getElementById("webName");
  const webCategory = document.getElementById("webCategory");
  const webStockStatus = document.getElementById("webStockStatus");
  const webPrice = document.getElementById("webPrice");
  const webTags = document.getElementById("webTags");
  const webNote = document.getElementById("webNote");
  const webPhotos = document.getElementById("webPhotos");
  const webPhotoStrip = document.getElementById("webPhotoStrip");
  const webPhotoHint = document.getElementById("webPhotoHint");
  const saveStockBtn = document.getElementById("saveStockBtn");
  const cancelStockBtn = document.getElementById("cancelStockBtn");
  const deleteStockBtn = document.getElementById("deleteStockBtn");
  const stockMsg = document.getElementById("stockMsg");
  const stockTbody = document.getElementById("stockTbody");
  const stockEditorCard = document.getElementById("stockEditorCard");
  const stockListMsg = document.getElementById("stockListMsg");

  // publish（前台上架）
  const syncNowBtn = document.getElementById("syncNowBtn");
  const publishSearchInput = document.getElementById("publishSearchInput");
  const publishSelect = document.getElementById("publishSelect");
  const publishTbody = document.getElementById("publishTbody");
  const publishTarget = document.getElementById("publishTarget");
  const savePublishBtn = document.getElementById("savePublishBtn");
  const cancelPublishBtn = document.getElementById("cancelPublishBtn");
  const publishMsg = document.getElementById("publishMsg");

  // reports/data（沿用你現成的區塊與 id）
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

  const exportAllBtn = document.getElementById("exportAllBtn");
  const copyAllBtn = document.getElementById("copyAllBtn");
  const dataText = document.getElementById("dataText");
  const importAllBtn = document.getElementById("importAllBtn");
  const clearDataBtn = document.getElementById("clearDataBtn");
  const dataMsg = document.getElementById("dataMsg");

  if (!loginCard || !panel) return;

  let editingStockId = null;
  let miscEditingId = null;
  let stockState = { query: "", status: "全部", kind: "全部" };
  let specInputs = new Map(); // key -> inputEl
  let editingWebPhotos = [];
  let editingPublishId = null;
  let publishState = { query: "", show: "全部" };

  function getKinds() {
    return DK.getStockKinds();
  }

  function prefixForKind(kind) {
    const found = getKinds().find((x) => x.label === kind);
    return found?.prefix || "DK";
  }

  function generateNextStockNo(kind) {
    const prefix = prefixForKind(kind);
    const items = DK.getStock();
    const codes = items
      .map((x) => String(x?.stockNo || "").trim())
      .filter((x) => x.startsWith(prefix + "-"));
    return DK.nextNumber(prefix, codes);
  }

  function showKindsMsg(text) {
    if (!kindsMsg) return;
    kindsMsg.hidden = false;
    kindsMsg.textContent = text;
    window.setTimeout(() => {
      kindsMsg.hidden = true;
      kindsMsg.textContent = "";
    }, 3500);
  }

  function populateKindSelects() {
    const kinds = getKinds();

    if (stockKind) {
      const cur = stockKind.value;
      stockKind.innerHTML = "";
      for (const k of kinds) {
        const opt = document.createElement("option");
        opt.value = k.label;
        opt.textContent = k.label;
        stockKind.appendChild(opt);
      }
      if (cur && kinds.some((k) => k.label === cur)) stockKind.value = cur;
      else if (kinds[0]) stockKind.value = kinds[0].label;
    }

    if (stockKindSelect) {
      const cur = stockKindSelect.value;
      stockKindSelect.innerHTML = `<option value="全部">全部</option>`;
      for (const k of kinds) {
        const opt = document.createElement("option");
        opt.value = k.label;
        opt.textContent = k.label;
        stockKindSelect.appendChild(opt);
      }
      if (cur && (cur === "全部" || kinds.some((k) => k.label === cur))) stockKindSelect.value = cur;
      else stockKindSelect.value = "全部";
    }
  }

  function renderKinds() {
    populateKindSelects();
    if (!kindsTbody) return;
    const kinds = getKinds();
    kindsTbody.innerHTML = "";

    kinds.forEach((k, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="text" value="${DK.escapeHtml(k.label)}" data-act="label" style="width:100%" /></td>
        <td class="nowrap"><input type="text" value="${DK.escapeHtml(k.prefix)}" data-act="prefix" style="width:110px; text-transform: uppercase" /></td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="up">↑</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="down">↓</button>
            <button class="btn btn-danger btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;

      function validatePrefix(prefix, ignoreIdx) {
        const p = String(prefix || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{2,4}$/.test(p)) return { ok: false, msg: "前綴需為 2–4 碼英數（例如：MON / GPU / DK）。" };
        const dup = getKinds().some((x, i) => i !== ignoreIdx && x.prefix === p);
        if (dup) return { ok: false, msg: `前綴重複：${p}` };
        return { ok: true, value: p };
      }

      tr.querySelector('[data-act="label"]').addEventListener("change", (e) => {
        const next = getKinds();
        const label = String(e.target.value || "").trim();
        if (!label) {
          showKindsMsg("類別名稱不能空白。");
          renderKinds();
          return;
        }
        const dup = next.some((x, i) => i !== idx && x.label === label);
        if (dup) {
          showKindsMsg(`類別名稱重複：${label}`);
          renderKinds();
          return;
        }
        next[idx] = { ...next[idx], label };
        DK.saveStockKinds(next);
        renderKinds();
        renderStockTable();
        renderPublishTable();
      });

      tr.querySelector('[data-act="prefix"]').addEventListener("change", (e) => {
        const check = validatePrefix(e.target.value, idx);
        if (!check.ok) {
          showKindsMsg(check.msg);
          renderKinds();
          return;
        }
        const next = getKinds();
        next[idx] = { ...next[idx], prefix: check.value };
        DK.saveStockKinds(next);
        renderKinds();
        if (!editingStockId && stockKind?.value === next[idx].label && stockNo) stockNo.value = generateNextStockNo(stockKind.value);
      });

      tr.querySelector('[data-act="up"]').addEventListener("click", () => {
        if (idx <= 0) return;
        const next = getKinds();
        const tmp = next[idx - 1];
        next[idx - 1] = next[idx];
        next[idx] = tmp;
        DK.saveStockKinds(next);
        renderKinds();
      });
      tr.querySelector('[data-act="down"]').addEventListener("click", () => {
        const next = getKinds();
        if (idx >= next.length - 1) return;
        const tmp = next[idx + 1];
        next[idx + 1] = next[idx];
        next[idx] = tmp;
        DK.saveStockKinds(next);
        renderKinds();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => {
        const next = getKinds();
        const removing = next[idx];
        if (!confirm(`確定刪除類別「${removing.label}」？（已有庫存不會被刪除，原類別文字也會保留在資料中）`)) return;
        next.splice(idx, 1);
        DK.saveStockKinds(next);
        renderKinds();
        renderStockTable();
        renderPublishTable();
      });

      kindsTbody.appendChild(tr);
    });
  }

  function addKind() {
    const label = String(newKindLabel?.value || "").trim();
    const prefixRaw = String(newKindPrefix?.value || "").trim().toUpperCase();
    if (!label) return;
    if (!/^[A-Z0-9]{2,4}$/.test(prefixRaw)) {
      showKindsMsg("前綴需為 2–4 碼英數（例如：MON / GPU / DK）。");
      return;
    }
    const kinds = getKinds();
    if (kinds.some((x) => x.label === label)) {
      showKindsMsg(`類別名稱重複：${label}`);
      return;
    }
    if (kinds.some((x) => x.prefix === prefixRaw)) {
      showKindsMsg(`前綴重複：${prefixRaw}`);
      return;
    }
    kinds.push({ label, prefix: prefixRaw });
    DK.saveStockKinds(kinds);
    if (newKindLabel) newKindLabel.value = "";
    if (newKindPrefix) newKindPrefix.value = "";
    renderKinds();
    showKindsMsg("已新增類別。");
  }

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

  function openStockEditor() {
    if (!stockEditorCard) return;
    stockEditorCard.hidden = false;
    stockEditorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeStockEditor() {
    if (!stockEditorCard) return;
    stockEditorCard.hidden = true;
    hideMsg(stockMsg);
  }

  function showListMsg(text) {
    if (!stockListMsg) return;
    stockListMsg.hidden = false;
    stockListMsg.textContent = text;
    // 3 秒後自動收
    window.setTimeout(() => {
      if (!stockListMsg) return;
      stockListMsg.hidden = true;
      stockListMsg.textContent = "";
    }, 3000);
  }

  function applyAuthUI() {
    const authed = DK.isAdminAuthed();
    loginCard.hidden = authed;
    panel.hidden = !authed;
    logoutBtn.hidden = !authed;
  }

  function switchTab(tabName) {
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === tabName);
    if (tabSettings) tabSettings.hidden = tabName !== "settings";
    if (tabStock) tabStock.hidden = tabName !== "stock";
    if (tabPublish) tabPublish.hidden = tabName !== "publish";
    if (tabReports) tabReports.hidden = tabName !== "reports";
    if (tabData) tabData.hidden = tabName !== "data";

    if (tabName === "settings") {
      renderSchema();
      renderKinds();
    }
    if (tabName === "stock") {
      renderSpecInputs();
      renderStockTable();
      // 預設只看列表：編輯器保持收起
      closeStockEditor();
    }
    if (tabName === "publish") {
      renderPublishTable();
      renderWebPhotoStrip();
    }
    if (tabName === "reports") {
      renderMiscTable();
      renderReport();
    }
  }

  // -------- 設定（沿用） --------
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
    if (!confirm("確定要重置為預設？（設定/庫存/欄位/記帳都會重置）")) return;
    DK.saveConfig(DK.DEFAULT_CONFIG);
    DK.saveStockSchema([...DK.DEFAULT_STOCK_SCHEMA]);
    DK.saveStock([...DK.DEFAULT_STOCK]);
    DK.saveMisc([...DK.DEFAULT_MISC]);
    loadSettingsForm();
    clearStockEditor();
    renderSchema();
    renderSpecInputs();
    renderStockTable();
    renderMiscTable();
    renderReport();
    hideMsg(settingsMsg);
    showMsg(settingsMsg, "已重置為預設。");
  }

  // -------- 庫存：欄位（schema） --------
  function getSchema() {
    return DK.getStockSchema();
  }

  function saveSchema(schema) {
    DK.saveStockSchema(schema);
  }

  function makeFieldKey() {
    return `f_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`;
  }

  function renderSchema() {
    if (!schemaTbody) return;
    const schema = getSchema();
    schemaTbody.innerHTML = "";

    schema.forEach((f, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <input type="text" value="${DK.escapeHtml(f.label)}" data-act="label" style="width:100%" />
        </td>
        <td class="nowrap"><span class="mono">${DK.escapeHtml(f.key)}</span></td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="up">↑</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="down">↓</button>
            <button class="btn btn-danger btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-act="label"]').addEventListener("change", (e) => {
        const next = getSchema();
        next[idx] = { ...next[idx], label: String(e.target.value || "").trim() || next[idx].label };
        saveSchema(next);
        renderSchema();
        renderSpecInputs();
        renderStockTable();
      });

      tr.querySelector('[data-act="up"]').addEventListener("click", () => {
        if (idx <= 0) return;
        const next = getSchema();
        const tmp = next[idx - 1];
        next[idx - 1] = next[idx];
        next[idx] = tmp;
        saveSchema(next);
        renderSchema();
        renderSpecInputs();
        renderStockTable();
      });
      tr.querySelector('[data-act="down"]').addEventListener("click", () => {
        const next = getSchema();
        if (idx >= next.length - 1) return;
        const tmp = next[idx + 1];
        next[idx + 1] = next[idx];
        next[idx] = tmp;
        saveSchema(next);
        renderSchema();
        renderSpecInputs();
        renderStockTable();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => {
        const next = getSchema();
        const removing = next[idx];
        if (!confirm(`確定刪除欄位「${removing.label}」？（已有資料不會消失，只是不再顯示）`)) return;
        next.splice(idx, 1);
        saveSchema(next);
        renderSchema();
        renderSpecInputs();
        renderStockTable();
      });

      schemaTbody.appendChild(tr);
    });
  }

  function addField() {
    const label = String(newFieldLabel?.value || "").trim();
    if (!label) return;
    const schema = getSchema();
    schema.push({ key: makeFieldKey(), label });
    saveSchema(schema);
    newFieldLabel.value = "";
    renderSchema();
    renderSpecInputs();
    renderStockTable();
  }

  // -------- 圖片工具（沿用舊後台壓縮） --------
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

  function renderWebPhotoStrip() {
    if (!webPhotoStrip) return;
    webPhotoStrip.innerHTML = "";
    const count = editingWebPhotos.length;
    if (webPhotoHint) {
      webPhotoHint.hidden = false;
      webPhotoHint.textContent = `目前相片：${count}/5（選檔後會自動壓縮並暫存，記得按「儲存」）`;
    }

    for (let i = 0; i < editingWebPhotos.length; i++) {
      const src = editingWebPhotos[i];
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      wrap.innerHTML = `
        <img alt="商品相片 ${i + 1}" />
        <button type="button" title="移除">×</button>
      `;
      const img = wrap.querySelector("img");
      img.src = src;
      wrap.querySelector("button").addEventListener("click", () => {
        editingWebPhotos.splice(i, 1);
        renderWebPhotoStrip();
      });
      webPhotoStrip.appendChild(wrap);
    }
  }

  async function addWebPhotosFromFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith("image/"));
    if (files.length === 0) return;
    const remaining = 5 - editingWebPhotos.length;
    if (remaining <= 0) {
      showMsg(stockMsg, "最多只能放 5 張相片。請先移除再新增。");
      return;
    }
    const picked = files.slice(0, remaining);
    showMsg(stockMsg, `正在處理相片...（${picked.length} 張）`);
    try {
      for (const f of picked) {
        const dataUrl = await fileToCompressedDataUrl(f);
        editingWebPhotos.push(dataUrl);
        renderWebPhotoStrip();
      }
      showMsg(stockMsg, "相片已加入。記得按「儲存」。");
    } catch {
      showMsg(stockMsg, "相片處理失敗，請換一張圖片或縮小檔案大小再試一次。");
    }
  }

  // -------- 庫存：編輯器（spec 動態渲染） --------
  function renderSpecInputs() {
    if (!stockSpecGrid) return;
    const schema = getSchema();
    stockSpecGrid.innerHTML = "";
    specInputs = new Map();

    for (const f of schema) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.innerHTML = `
        <label>${DK.escapeHtml(f.label)}</label>
        <input type="text" data-key="${DK.escapeHtml(f.key)}" />
      `;
      const input = wrap.querySelector("input");
      specInputs.set(f.key, input);
      stockSpecGrid.appendChild(wrap);
    }

    // 若正在編輯，回填
    if (editingStockId) {
      const item = DK.getStock().find((x) => x.id === editingStockId);
      if (item) {
        for (const [k, input] of specInputs.entries()) {
          input.value = String(item?.spec?.[k] ?? "");
        }
      }
    }
  }

  function calcCostSummary() {
    if (!stockCostSummary) return;
    const totalCost = Number(stockCostTotal?.value || 0);
    const suggested = Number(stockSuggestedPrice?.value || 0);
    const estProfit = (Number.isFinite(suggested) ? suggested : 0) - totalCost;
    stockCostSummary.textContent = `總成本：NT$ ${DK.formatPrice(totalCost) || "0"}｜預估毛利（建議售價 - 總成本）：NT$ ${DK.formatPrice(estProfit) || "0"}`;
  }

  function clearStockEditor() {
    editingStockId = null;
    if (deleteStockBtn) deleteStockBtn.hidden = true;
    hideMsg(stockMsg);

    if (stockKind) stockKind.value = "電腦";
    if (stockNo) stockNo.value = generateNextStockNo(stockKind?.value || "電腦");
    if (stockBrand) stockBrand.value = "";
    if (stockModelSpec) stockModelSpec.value = "";
    if (stockCostTotal) stockCostTotal.value = "";
    if (stockType) stockType.value = "";
    if (stockStatus) stockStatus.value = "在庫";
    if (stockListedAt) stockListedAt.value = DK.todayISO();
    if (stockSoldAt) stockSoldAt.value = "";
    if (stockSoldPrice) stockSoldPrice.value = "";
    if (stockSuggestedPrice) stockSuggestedPrice.value = "";
    if (stockMinPrice) stockMinPrice.value = "";
    if (stockSource) stockSource.value = "";
    if (stockCustomer) stockCustomer.value = "";
    if (stockNote) stockNote.value = "";

    renderSpecInputs();
    calcCostSummary();
  }

  function startEditStock(id) {
    const item = DK.getStock().find((x) => x.id === id);
    if (!item) return;
    editingStockId = id;
    if (deleteStockBtn) deleteStockBtn.hidden = false;
    hideMsg(stockMsg);
    showMsg(stockMsg, `正在編輯：${item.stockNo || item.id}`);

    if (stockNo) stockNo.value = item.stockNo ?? "";
    if (stockKind) stockKind.value = item.kind ?? "電腦";
    if (stockBrand) stockBrand.value = item.brand ?? "";
    if (stockModelSpec) stockModelSpec.value = item.modelSpec ?? "";
    if (stockCostTotal) stockCostTotal.value = String(DK.calcTotalCostPC(item) || 0);
    if (stockType) stockType.value = item.type ?? "";
    if (stockStatus) stockStatus.value = item.status ?? "在庫";
    if (stockListedAt) stockListedAt.value = item.listedAt ?? "";
    if (stockSoldAt) stockSoldAt.value = item.soldAt ?? "";
    if (stockSoldPrice) stockSoldPrice.value = item.soldPrice != null ? String(item.soldPrice) : "";
    if (stockSuggestedPrice) stockSuggestedPrice.value = item.suggestedPrice != null ? String(item.suggestedPrice) : "";
    if (stockMinPrice) stockMinPrice.value = item.minPrice != null ? String(item.minPrice) : "";
    if (stockSource) stockSource.value = item.source ?? "";
    if (stockCustomer) stockCustomer.value = item.customer ?? "";
    if (stockNote) stockNote.value = item.note ?? "";

    renderSpecInputs();
    calcCostSummary();
    openStockEditor();
  }

  function saveStockItem() {
    hideMsg(stockMsg);
    const items = DK.getStock();
    const kind = stockKind?.value || "電腦";
    // ✅ 新增時：庫存編號自動產生；編輯時：保留原本編號
    const stockNoVal = editingStockId
      ? String(stockNo?.value || "").trim()
      : generateNextStockNo(kind);
    if (stockNo) stockNo.value = stockNoVal;

    const totalCost = DK.toNumber(stockCostTotal?.value);
    if (totalCost == null) {
      showMsg(stockMsg, "請填成本。");
      return;
    }

    const status = stockStatus?.value || "在庫";
    let soldAt = String(stockSoldAt?.value || "").trim();
    const soldPrice = DK.toNumber(stockSoldPrice?.value);
    if (status === "已售出") {
      if (!soldAt) soldAt = DK.todayISO();
      if (soldPrice == null) {
        showMsg(stockMsg, "狀態是「已售出」時，請填售出金額。");
        return;
      }
    } else {
      soldAt = "";
    }

    const spec = {};
    for (const [k, input] of specInputs.entries()) {
      spec[k] = String(input.value || "").trim();
    }

    const existingWeb = editingStockId ? (items.find((x) => x.id === editingStockId)?.web || null) : null;
    const web = existingWeb || {
      publish: false,
      name: "",
      category: "遊戲",
      stockStatus: "現貨",
      price: null,
      tags: [],
      note: "",
      photos: [],
    };

    const next = {
      id: editingStockId || DK.makeId("stk"),
      stockNo: stockNoVal,
      kind,
      brand: String(stockBrand?.value || "").trim(),
      modelSpec: String(stockModelSpec?.value || "").trim(),
      type: String(stockType?.value || "").trim(),
      status,
      listedAt: String(stockListedAt?.value || "").trim() || DK.todayISO(),
      soldAt,
      soldPrice,
      // 簡化後：只記「總成本」，統一存到 costBase，其它清零避免重複加總
      costBase: totalCost,
      costAddon: 0,
      costRefurb: 0,
      suggestedPrice: DK.toNumber(stockSuggestedPrice?.value),
      minPrice: DK.toNumber(stockMinPrice?.value),
      source: String(stockSource?.value || "").trim(),
      customer: String(stockCustomer?.value || "").trim(),
      note: String(stockNote?.value || "").trim(),
      web,
      spec,
    };

    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.unshift(next);
    DK.saveStock(items);
    DK.syncWebInventoryFromStock();
    renderStockTable();
    closeStockEditor();
    showListMsg("已儲存庫存。");
  }

  function removeStockItem(id) {
    const items = DK.getStock();
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`確定要刪除「${it.stockNo || it.id}」？`)) return;
    DK.saveStock(items.filter((x) => x.id !== id));
    DK.syncWebInventoryFromStock();
    renderStockTable();
    if (editingStockId === id) clearStockEditor();
    closeStockEditor();
    showListMsg("已刪除庫存。");
  }

  function stockMatches(it) {
    const q = DK.normalizeText(stockState.query);
    if (stockState.status !== "全部" && it.status !== stockState.status) return false;
    if (stockState.kind !== "全部" && it.kind !== stockState.kind) return false;
    if (!q) return true;
    const schema = getSchema();
    const specText = schema.map((f) => it?.spec?.[f.key]).join(" ");
    const hay = [it.stockNo, it.kind, it.brand, it.modelSpec, it.type, it.status, it.customer, it.source, it.note, specText]
      .map(DK.normalizeText)
      .join(" ");
    return hay.includes(q);
  }

  function renderStockTable() {
    if (!stockTbody) return;
    const schema = getSchema();
    const items = DK.getStock().filter(stockMatches);
    stockTbody.innerHTML = "";

    for (const it of items) {
      const totalCost = DK.calcTotalCostPC(it);
      const web = it.web || {};
      const webText = web.publish ? "上架" : "未上架";
      const summary = schema
        .slice(0, 6)
        .map((f) => {
          const v = String(it?.spec?.[f.key] ?? "").trim();
          if (!v) return "";
          return `${f.label}：${v}`;
        })
        .filter(Boolean)
        .join("｜");
      const head = [String(it.brand || "").trim(), String(it.modelSpec || "").trim()].filter(Boolean).join(" ");
      const summaryText = [head, summary].filter(Boolean).join("｜");

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${DK.escapeHtml(it.stockNo || "-")}</span></td>
        <td class="nowrap">${DK.escapeHtml(it.kind || "-")}</td>
        <td class="nowrap">${DK.escapeHtml(it.status || "-")}</td>
        <td class="nowrap">${web.publish ? `<span class="badge ok">上架</span>` : `<span class="badge tag">未上架</span>`}</td>
        <td>${DK.escapeHtml(summaryText || "")}<div class="muted">客人：${DK.escapeHtml(it.customer || "-")}｜來源：${DK.escapeHtml(it.source || "-")}</div></td>
        <td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(totalCost) || "0"}</td>
        <td class="nowrap">
          <div class="muted">建議：<span class="mono">NT$</span> ${DK.formatPrice(it.suggestedPrice) || "-"}</div>
          <div class="muted">最低：<span class="mono">NT$</span> ${DK.formatPrice(it.minPrice) || "-"}</div>
        </td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="del">刪除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => {
        switchTab("stock");
        startEditStock(it.id);
        stockNo?.focus();
      });
      tr.querySelector('[data-act="del"]').addEventListener("click", () => removeStockItem(it.id));
      stockTbody.appendChild(tr);
    }
  }

  // -------- 前台上架（獨立分頁） --------
  function clearPublishEditor() {
    editingPublishId = null;
    hideMsg(publishMsg);
    if (publishTarget) publishTarget.textContent = "尚未選擇庫存（請在下方列表按「編輯上架」）";

    editingWebPhotos = [];
    if (webPublish) webPublish.checked = false;
    if (webName) webName.value = "";
    if (webCategory) webCategory.value = "遊戲";
    if (webStockStatus) webStockStatus.value = "現貨";
    if (webPrice) webPrice.value = "";
    if (webTags) webTags.value = "";
    if (webNote) webNote.value = "";
    renderWebPhotoStrip();
  }

  function publishMatches(it) {
    const q = DK.normalizeText(publishState.query);
    const web = it.web || {};
    const isPub = !!web.publish;
    if (publishState.show === "上架" && !isPub) return false;
    if (publishState.show === "未上架" && isPub) return false;
    if (!q) return true;

    const schema = DK.getStockSchema();
    const specText = schema.map((f) => it?.spec?.[f.key]).join(" ");
    const hay = [it.stockNo, it.kind, it.brand, it.modelSpec, it.type, it.status, web.name, web.category, web.stockStatus, (web.tags || []).join(" "), specText]
      .map(DK.normalizeText)
      .join(" ");
    return hay.includes(q);
  }

  function renderPublishTable() {
    if (!publishTbody) return;
    const items = DK.getStock().filter(publishMatches);
    publishTbody.innerHTML = "";
    for (const it of items) {
      const web = it.web || {};
      const pubBadge = web.publish ? `<span class="badge ok">上架</span>` : `<span class="badge tag">未上架</span>`;
      const tags = Array.isArray(web.tags) ? web.tags.join(", ") : "";
      const price = web.price != null ? DK.formatPrice(Number(web.price)) : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="nowrap"><span class="mono">${DK.escapeHtml(it.stockNo || "-")}</span></td>
        <td class="nowrap">${DK.escapeHtml(it.kind || "-")}</td>
        <td class="nowrap">${DK.escapeHtml(it.status || "-")}</td>
        <td class="nowrap">${pubBadge}</td>
        <td>
          <div><strong>${DK.escapeHtml(web.name || "-")}</strong></div>
          <div class="muted">分類：${DK.escapeHtml(web.category || "-")}｜狀態：${DK.escapeHtml(web.stockStatus || "-")}｜售價：<span class="mono">NT$</span> ${price || "-"}</div>
          <div class="muted">標籤：${DK.escapeHtml(tags || "-")}</div>
        </td>
        <td class="nowrap" style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-act="edit">編輯上架</button>
            <button class="btn btn-ghost btn-sm" type="button" data-act="toggle">${web.publish ? "下架" : "上架"}</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-act="edit"]').addEventListener("click", () => startEditPublish(it.id));
      tr.querySelector('[data-act="toggle"]').addEventListener("click", () => {
        // 快速上/下架：只切 publish
        const all = DK.getStock();
        const idx = all.findIndex((x) => x.id === it.id);
        if (idx < 0) return;
        const cur = all[idx];
        const nextWeb = { ...(cur.web || {}), publish: !((cur.web || {}).publish) };
        all[idx] = { ...cur, web: nextWeb };
        DK.saveStock(all);
        DK.syncWebInventoryFromStock();
        renderPublishTable();
        renderStockTable();
      });

      publishTbody.appendChild(tr);
    }
  }

  function startEditPublish(id) {
    const it = DK.getStock().find((x) => x.id === id);
    if (!it) return;
    editingPublishId = id;
    hideMsg(publishMsg);
    const title = `${it.stockNo || it.id}｜${it.kind || "-"}｜${it.status || "-"}`;
    if (publishTarget) publishTarget.textContent = title;

    const web = it.web || {};
    editingWebPhotos = Array.isArray(web.photos) ? [...web.photos] : [];
    if (webPublish) webPublish.checked = !!web.publish;
    if (webName) webName.value = web.name ?? "";
    if (webCategory) webCategory.value = web.category ?? "遊戲";
    if (webStockStatus) webStockStatus.value = web.stockStatus ?? "現貨";
    if (webPrice) webPrice.value = typeof web.price === "number" ? String(web.price) : web.price != null ? String(web.price) : "";
    if (webTags) webTags.value = Array.isArray(web.tags) ? web.tags.join(", ") : web.tags ?? "";
    if (webNote) webNote.value = web.note ?? "";
    renderWebPhotoStrip();
  }

  function savePublish() {
    hideMsg(publishMsg);
    if (!editingPublishId) {
      showMsg(publishMsg, "請先選擇一筆庫存（在下方列表按「編輯上架」）。");
      return;
    }
    const all = DK.getStock();
    const idx = all.findIndex((x) => x.id === editingPublishId);
    if (idx < 0) return;
    const it = all[idx];

    const nextWeb = {
      ...(it.web || {}),
      publish: !!webPublish?.checked,
      name: String(webName?.value || "").trim(),
      category: webCategory?.value || "遊戲",
      stockStatus: webStockStatus?.value || "現貨",
      price: DK.toNumber(webPrice?.value),
      tags: String(webTags?.value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      note: String(webNote?.value || "").trim(),
      photos: editingWebPhotos.slice(0, 5),
    };

    if (nextWeb.publish && !nextWeb.name) {
      showMsg(publishMsg, "已勾選上架：請填「前台商品名稱」。");
      return;
    }
    if (it.status === "已售出" && nextWeb.publish) {
      showMsg(publishMsg, "此筆庫存狀態為「已售出」，建議不要上架（請先改庫存狀態或取消上架）。");
      return;
    }

    all[idx] = { ...it, web: nextWeb };
    DK.saveStock(all);
    DK.syncWebInventoryFromStock();
    renderPublishTable();
    renderStockTable();
    showMsg(publishMsg, "已儲存並同步到前台。");
  }

  // -------- 記帳（其他收入）與報表 --------
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

    const sold = DK.getStock().filter((x) => x.status === "已售出" && monthStr(x.soldAt) === m && typeof x.soldPrice === "number");
    const miscInMonth = DK.getMisc().filter((x) => monthStr(x.date) === m && typeof x.revenue === "number");

    const revenueStock = sold.reduce((s, x) => s + (x.soldPrice || 0), 0);
    const costStock = sold.reduce((s, x) => s + DK.calcTotalCostPC(x), 0);
    const revenueMisc = miscInMonth.reduce((s, x) => s + (x.revenue || 0), 0);
    const costMisc = miscInMonth.reduce((s, x) => s + (x.cost || 0), 0);

    const revenue = revenueStock + revenueMisc;
    const cost = costStock + costMisc;
    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    const txCount = sold.length + miscInMonth.length;
    const avgOrder = txCount > 0 ? revenue / txCount : 0;
    const avgProfit = txCount > 0 ? profit / txCount : 0;

    const byKindRevenue = groupSum(sold, (x) => x.kind || "未分類", (x) => x.soldPrice || 0);
    const byKindCount = groupCount(sold, (x) => x.kind || "未分類");
    const byTypeRevenue = groupSum(sold, (x) => x.type || "未分類", (x) => x.soldPrice || 0);
    const byTypeCount = groupCount(sold, (x) => x.type || "未分類");

    const srcItems = [
      ...sold.map((x) => ({ source: x.source, revenue: x.soldPrice || 0 })),
      ...miscInMonth.map((x) => ({ source: x.source, revenue: x.revenue || 0 })),
    ];
    const srcRevenue = groupSum(srcItems, (x) => (x.source || "未填").trim() || "未填", (x) => x.revenue || 0);
    const srcCount = groupCount(srcItems, (x) => (x.source || "未填").trim() || "未填");

    function renderRowsFromMap(map, countMap) {
      const keys = [...map.keys()].sort((a, b) => (map.get(b) || 0) - (map.get(a) || 0));
      return keys
        .map(
          (k) =>
            `<tr><td>${DK.escapeHtml(k)}</td><td class="nowrap">${countMap ? (countMap.get(k) || 0) : "-"}</td><td class="nowrap"><span class="mono">NT$</span> ${DK.formatPrice(map.get(k) || 0)}</td></tr>`,
        )
        .join("");
    }

    reportWrap.innerHTML = `
      <div class="card">
        <h3 class="h3">每月營收總覽（${DK.escapeHtml(m)}）</h3>
        <div class="spec" style="margin-top:10px">
          <div class="row"><div class="k">成交數</div><div class="v">${txCount}（庫存售出 ${sold.length} / 其他 ${miscInMonth.length}）</div></div>
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
          <div class="row"><div class="k">回購客</div><div class="v">（可用「客人」欄位自行判斷）</div></div>
        </div>
        <div class="muted" style="margin-top:10px">毛利率參考：&lt;15% 太硬撐｜15–25% 正常｜25% 以上很漂亮</div>
      </div>

      <div class="card">
        <h3 class="h3">分類收入（類別）</h3>
        <table class="table" style="margin-top:10px">
          <thead><tr><th>類別</th><th class="nowrap">成交數</th><th class="nowrap">營收</th></tr></thead>
          <tbody>
            ${renderRowsFromMap(byKindRevenue, byKindCount) || `<tr><td colspan="3" class="muted">本月無售出</td></tr>`}
          </tbody>
        </table>
        <div class="muted" style="margin-top:10px">依「類型」：</div>
        <table class="table" style="margin-top:10px">
          <thead><tr><th>類型</th><th class="nowrap">成交數</th><th class="nowrap">營收</th></tr></thead>
          <tbody>
            ${renderRowsFromMap(byTypeRevenue, byTypeCount) || `<tr><td colspan="3" class="muted">本月無售出</td></tr>`}
          </tbody>
        </table>
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

  // -------- 匯入/匯出 --------
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
      DK.ensureUnifiedStockInitialized();
      loadSettingsForm();
      clearStockEditor();
      renderSchema();
      renderKinds();
      renderSpecInputs();
      renderStockTable();
      renderMiscTable();
      renderReport();
      showMsg(dataMsg, "已匯入完成。");
    } catch {
      showMsg(dataMsg, "匯入失敗：JSON 格式不正確或內容不完整。");
    }
  }

  function clearAllData() {
    if (!confirm("確定要清空所有資料？（設定/庫存/欄位/記帳都會重置）")) return;
    DK.saveConfig(DK.DEFAULT_CONFIG);
    DK.saveStockSchema([...DK.DEFAULT_STOCK_SCHEMA]);
    DK.saveStock([...DK.DEFAULT_STOCK]);
    DK.saveMisc([...DK.DEFAULT_MISC]);
    loadSettingsForm();
    clearStockEditor();
    renderSchema();
    renderSpecInputs();
    renderStockTable();
    renderMiscTable();
    renderReport();
    hideMsg(dataMsg);
    showMsg(dataMsg, "已清空並重置為預設。");
  }

  // -------- auth --------
  function doLogin() {
    hideMsg(loginError);
    const cfg = DK.getConfig();
    const u = usernameEl.value.trim();
    const p = passwordEl.value;
    if (u === cfg.admin.username && p === cfg.admin.password) {
      DK.setAdminAuthed(true);
      applyAuthUI();

      // 初始化整併庫存（只做一次）
      DK.ensureUnifiedStockInitialized();
      DK.syncWebInventoryFromStock();

      loadSettingsForm();
      clearStockEditor();
      clearPublishEditor();
      clearMiscEditor();
      renderSchema();
      renderKinds();
      renderSpecInputs();
      renderStockTable();
      renderPublishTable();
      renderMiscTable();
      if (reportMonth && !reportMonth.value) reportMonth.value = DK.todayISO().slice(0, 7);
      renderReport();

      switchTab("stock");
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
  resetBtn?.addEventListener("click", resetAll);

  addFieldBtn?.addEventListener("click", addField);
  newFieldLabel?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addField();
  });

  addKindBtn?.addEventListener("click", addKind);
  newKindPrefix?.addEventListener("input", () => {
    // 自動轉大寫
    newKindPrefix.value = String(newKindPrefix.value || "").toUpperCase();
  });
  newKindLabel?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addKind();
  });
  newKindPrefix?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addKind();
  });

  newStockBtn?.addEventListener("click", () => {
    switchTab("stock");
    clearStockEditor();
    openStockEditor();
    showMsg(stockMsg, "新增庫存：填寫後按「儲存」。");
    stockNo?.focus();
  });
  saveStockBtn?.addEventListener("click", saveStockItem);
  cancelStockBtn?.addEventListener("click", () => {
    clearStockEditor();
    closeStockEditor();
  });
  deleteStockBtn?.addEventListener("click", () => {
    if (!editingStockId) return;
    removeStockItem(editingStockId);
  });
  stockSearchInput?.addEventListener("input", () => {
    stockState.query = stockSearchInput.value;
    renderStockTable();
  });
  stockStatusSelect?.addEventListener("change", () => {
    stockState.status = stockStatusSelect.value;
    renderStockTable();
  });
  stockKindSelect?.addEventListener("change", () => {
    stockState.kind = stockKindSelect.value;
    renderStockTable();
  });
  for (const el of [stockCostTotal, stockSuggestedPrice]) {
    el?.addEventListener("input", calcCostSummary);
  }
  stockStatus?.addEventListener("change", () => {
    if (stockStatus.value === "已售出") {
      if (stockSoldAt && !stockSoldAt.value) stockSoldAt.value = DK.todayISO();
    } else {
      if (stockSoldAt) stockSoldAt.value = "";
      if (stockSoldPrice) stockSoldPrice.value = "";
    }
  });

  // ✅ 新增狀態下，切換「類別」就自動換下一個編號
  stockKind?.addEventListener("change", () => {
    if (editingStockId) return;
    if (stockNo) stockNo.value = generateNextStockNo(stockKind.value);
  });

  // webPhotos 事件移到「前台上架」分頁

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

  exportAllBtn?.addEventListener("click", exportToTextarea);
  copyAllBtn?.addEventListener("click", copyTextarea);
  importAllBtn?.addEventListener("click", importFromTextarea);
  clearDataBtn?.addEventListener("click", clearAllData);

  // 前台上架 events
  syncNowBtn?.addEventListener("click", () => {
    DK.syncWebInventoryFromStock();
    renderPublishTable();
    renderStockTable();
    hideMsg(publishMsg);
    showMsg(publishMsg, "已同步到前台。");
  });
  publishSearchInput?.addEventListener("input", () => {
    publishState.query = publishSearchInput.value;
    renderPublishTable();
  });
  publishSelect?.addEventListener("change", () => {
    publishState.show = publishSelect.value;
    renderPublishTable();
  });
  savePublishBtn?.addEventListener("click", savePublish);
  cancelPublishBtn?.addEventListener("click", clearPublishEditor);
  webPhotos?.addEventListener("change", async () => {
    hideMsg(publishMsg);
    await addWebPhotosFromFiles(webPhotos.files);
    webPhotos.value = "";
  });

  // init
  applyAuthUI();
  if (DK.isAdminAuthed()) {
    DK.ensureUnifiedStockInitialized();
    DK.syncWebInventoryFromStock();
    loadSettingsForm();
    clearStockEditor();
    clearPublishEditor();
    clearMiscEditor();
    renderSchema();
    renderKinds();
    renderSpecInputs();
    renderStockTable();
    closeStockEditor();
    renderPublishTable();
    renderMiscTable();
    if (reportMonth && !reportMonth.value) reportMonth.value = DK.todayISO().slice(0, 7);
    renderReport();
    switchTab("stock");
  }
})();

