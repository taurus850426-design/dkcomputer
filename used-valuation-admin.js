/* used-valuation-admin.js - Stage 03 行情管理（Admin only；不接估價引擎） */
(function () {
  "use strict";

  const STATUS_LABEL = { DRAFT: "草稿", ACTIVE: "使用中", ARCHIVED: "已封存" };
  const CATEGORIES = ["CPU", "GPU", "MOTHERBOARD", "RAM", "STORAGE", "PSU", "CASE", "COOLER", "LAPTOP", "OTHER"];

  let batches = [];
  let prices = [];
  let selectedBatchId = "";
  let editingPriceId = null;
  let confirmMode = null;
  let confirmTargetId = "";

  function rest() {
    return typeof stage7RestJson === "function" ? stage7RestJson : null;
  }
  function rpc() {
    return typeof stage7Rpc === "function" ? stage7Rpc : null;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtNum(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString("zh-TW");
  }

  function fmtDate(v) {
    if (!v) return "—";
    return String(v).slice(0, 10);
  }

  function fmtTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("zh-TW");
  }

  function isAdmin() {
    try {
      return window.DK && window.DK.getCurrentRole && window.DK.getCurrentRole() === "admin";
    } catch (_) {
      return false;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function showMsg(text, isErr) {
    const el = $("uvMarketPageMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("uv-msg-error", !!isErr);
  }

  function friendlyError(res) {
    const raw = String((res && res.error) || "");
    const low = raw.toLowerCase();
    if (res && (res.permissionDenied || res.forbidden || low.indexOf("admin only") >= 0 || low.indexOf("42501") >= 0)) {
      return "你沒有此操作權限";
    }
    if (res && res.notAuthenticated) return "請先登入後台";
    if (low.indexOf("batch not found") >= 0) return "找不到行情批次";
    if (low.indexOf("price not found") >= 0) return "找不到行情資料";
    if (low.indexOf("batch not draft") >= 0) return "只有草稿批次可以修改";
    if (low.indexOf("batch empty") >= 0) return "請先新增至少一筆行情再啟用";
    if (low.indexOf("duplicate batch") >= 0) return "批次代碼已存在";
    if (low.indexOf("duplicate market") >= 0) return "同一批次已有相同品牌／型號／規格";
    if (low.indexOf("invalid price") >= 0) return "價格區間不正確（低價 ≥ 0，中價 ≥ 低價，高價 ≥ 中價）";
    if (low.indexOf("invalid confidence") >= 0) return "信心值必須是 0 到 100";
    if (low.indexOf("reason required") >= 0) return "請填寫原因";
    if (low.indexOf("batch_code required") >= 0) return "請填寫批次代碼";
    if (low.indexOf("market_batch_id is immutable") >= 0) return "不能把行情移到其他批次";
    if (low.indexOf("network") >= 0 || low.indexOf("failed to fetch") >= 0) return "網路連線失敗，請稍後再試";
    if (raw) return raw.slice(0, 120);
    return "操作失敗";
  }

  function selectedBatch() {
    return batches.find(function (b) { return b.id === selectedBatchId; }) || null;
  }

  function isDraft(batch) {
    return batch && batch.status === "DRAFT";
  }

  function statusBadge(status) {
    const st = String(status || "");
    let cls = "status-badge status-muted";
    if (st === "ACTIVE") cls = "status-badge status-success";
    else if (st === "DRAFT") cls = "status-badge status-warning";
    else if (st === "ARCHIVED") cls = "status-badge status-muted";
    return '<span class="' + cls + '">' + esc(STATUS_LABEL[st] || st) + "</span>";
  }

  function countPrices(batchId) {
    return prices.filter(function (p) { return p.market_batch_id === batchId; }).length;
  }

  async function loadAll() {
    const fn = rest();
    if (!fn) {
      showMsg("後台資料介面尚未就緒", true);
      return;
    }
    showMsg("載入中…", false);
    const bRes = await fn("used_market_batches?select=id,batch_code,status,effective_date,source_summary,published_at,created_at&order=created_at.desc");
    if (!bRes.ok) {
      showMsg(friendlyError(bRes), true);
      return;
    }
    batches = Array.isArray(bRes.data) ? bRes.data : [];
    const pRes = await fn("used_market_prices?select=id,market_batch_id,category,brand,model,variant,market_low,market_mid,market_high,sample_count,confidence,source_type,effective_date,note&order=brand.asc");
    if (!pRes.ok) {
      showMsg(friendlyError(pRes), true);
      return;
    }
    prices = Array.isArray(pRes.data) ? pRes.data : [];
    if (!selectedBatchId || !batches.some(function (b) { return b.id === selectedBatchId; })) {
      const active = batches.find(function (b) { return b.status === "ACTIVE"; });
      selectedBatchId = (active && active.id) || (batches[0] && batches[0].id) || "";
    }
    showMsg("");
    render();
  }

  function renderActive() {
    const host = $("uvActiveBatchCard");
    if (!host) return;
    const active = batches.find(function (b) { return b.status === "ACTIVE"; });
    if (!active) {
      host.innerHTML = '<p class="muted">目前沒有正式行情。請建立草稿批次並啟用。</p>';
      return;
    }
    host.innerHTML =
      '<div class="uv-active-grid">' +
        '<div><div class="muted small">批次代碼</div><div class="uv-strong">' + esc(active.batch_code) + "</div></div>" +
        '<div><div class="muted small">生效日</div><div>' + esc(fmtDate(active.effective_date)) + "</div></div>" +
        '<div><div class="muted small">啟用時間</div><div>' + esc(fmtTime(active.published_at)) + "</div></div>" +
        '<div><div class="muted small">行情筆數</div><div>' + esc(String(countPrices(active.id))) + "</div></div>" +
      "</div>";
  }

  function renderBatches() {
    const host = $("uvBatchList");
    if (!host) return;
    if (!batches.length) {
      host.innerHTML = '<p class="muted">尚無行情批次。</p>';
      return;
    }
    host.innerHTML = batches.map(function (b) {
      const on = b.id === selectedBatchId ? " is-selected" : "";
      const draftBtns = isDraft(b)
        ? '<button type="button" class="btn btn-ghost btn-sm" data-uv-edit-batch="' + esc(b.id) + '">編輯</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-uv-activate="' + esc(b.id) + '">啟用正式行情</button>'
        : "";
      return (
        '<article class="uv-batch-card' + on + '" data-uv-select-batch="' + esc(b.id) + '">' +
          '<div class="uv-batch-card-main">' +
            '<div class="uv-batch-title">' + esc(b.batch_code) + " " + statusBadge(b.status) + "</div>" +
            '<div class="muted small">生效日 ' + esc(fmtDate(b.effective_date)) + " ｜ " + esc(b.source_summary || "無來源摘要") + " ｜ " + esc(String(countPrices(b.id))) + " 筆</div>" +
          "</div>" +
          '<div class="uv-batch-actions">' + draftBtns + "</div>" +
        "</article>"
      );
    }).join("");
  }

  function filteredPrices() {
    const batch = selectedBatch();
    if (!batch) return [];
    const q = String(($("uvPriceSearch") && $("uvPriceSearch").value) || "").trim().toLowerCase();
    const cat = String(($("uvPriceCategoryFilter") && $("uvPriceCategoryFilter").value) || "").trim();
    return prices.filter(function (p) {
      if (p.market_batch_id !== batch.id) return false;
      if (cat && String(p.category || "") !== cat) return false;
      if (!q) return true;
      const hay = [p.brand, p.model, p.variant, p.category].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function renderPrices() {
    const tbody = $("uvPriceTbody");
    const empty = $("uvPriceEmpty");
    const addBtn = $("uvBtnNewPrice");
    const hint = $("uvPriceReadonlyHint");
    const batch = selectedBatch();
    const draft = isDraft(batch);
    if (addBtn) addBtn.hidden = !draft;
    if (hint) {
      hint.hidden = !batch || draft;
      hint.textContent = batch && batch.status === "ACTIVE"
        ? "使用中批次為唯讀，不能直接修改。"
        : "已封存批次為唯讀，不能直接修改。";
    }
    if (!tbody) return;
    const rows = filteredPrices();
    if (!batch) {
      tbody.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = "請先選擇或新增一批行情。";
      }
      return;
    }
    if (!rows.length) {
      tbody.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = "這個批次還沒有行情資料。";
      }
      return;
    }
    if (empty) empty.hidden = true;
    tbody.innerHTML = rows.map(function (p) {
      const actions = draft
        ? '<button type="button" class="btn btn-ghost btn-sm" data-uv-edit-price="' + esc(p.id) + '">編輯</button>' +
          '<button type="button" class="btn btn-ghost btn-sm danger-action" data-uv-del-price="' + esc(p.id) + '">刪除</button>'
        : '<span class="muted small">唯讀</span>';
      return (
        "<tr>" +
          "<td>" + esc(p.category || "—") + "</td>" +
          "<td>" + esc(p.brand || "—") + "</td>" +
          "<td>" + esc(p.model || "—") + "</td>" +
          "<td>" + esc(p.variant || "—") + "</td>" +
          '<td class="table-number">' + esc(fmtNum(p.market_low)) + "</td>" +
          '<td class="table-number">' + esc(fmtNum(p.market_mid)) + "</td>" +
          '<td class="table-number">' + esc(fmtNum(p.market_high)) + "</td>" +
          '<td class="table-number">' + esc(fmtNum(p.sample_count)) + "</td>" +
          '<td class="table-number">' + esc(fmtNum(p.confidence)) + "</td>" +
          "<td>" + esc(fmtDate(p.effective_date)) + "</td>" +
          '<td class="table-actions">' + actions + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function render() {
    renderActive();
    renderBatches();
    renderPrices();
    const title = $("uvSelectedBatchTitle");
    const batch = selectedBatch();
    if (title) title.textContent = batch ? ("行情資料｜" + batch.batch_code) : "行情資料";
  }

  function openBatchForm(batch) {
    const card = $("uvBatchFormCard");
    if (!card) return;
    $("uvBatchFormTitle").textContent = batch ? "編輯草稿批次" : "新增行情批次";
    $("uvBatchId").value = batch ? batch.id : "";
    $("uvBatchCode").value = batch ? (batch.batch_code || "") : "";
    $("uvBatchEffectiveDate").value = batch && batch.effective_date ? String(batch.effective_date).slice(0, 10) : "";
    $("uvBatchSource").value = batch ? (batch.source_summary || "") : "";
    card.hidden = false;
    $("uvBatchCode").focus();
  }

  function closeBatchForm() {
    const card = $("uvBatchFormCard");
    if (card) card.hidden = true;
  }

  function openPriceForm(price) {
    const batch = selectedBatch();
    if (!isDraft(batch)) return;
    const card = $("uvPriceFormCard");
    if (!card) return;
    editingPriceId = price ? price.id : null;
    $("uvPriceFormTitle").textContent = price ? "編輯行情" : "新增行情";
    $("uvPriceCategory").value = price ? (price.category || "") : "";
    $("uvPriceBrand").value = price ? (price.brand || "") : "";
    $("uvPriceModel").value = price ? (price.model || "") : "";
    $("uvPriceVariant").value = price ? (price.variant || "") : "";
    $("uvPriceLow").value = price && price.market_low != null ? price.market_low : "";
    $("uvPriceMid").value = price && price.market_mid != null ? price.market_mid : "";
    $("uvPriceHigh").value = price && price.market_high != null ? price.market_high : "";
    $("uvPriceSample").value = price && price.sample_count != null ? price.sample_count : "0";
    $("uvPriceConfidence").value = price && price.confidence != null ? price.confidence : "0";
    $("uvPriceSource").value = price ? (price.source_type || "") : "";
    $("uvPriceEffectiveDate").value = price && price.effective_date ? String(price.effective_date).slice(0, 10) : "";
    $("uvPriceNote").value = price ? (price.note || "") : "";
    card.hidden = false;
    $("uvPriceBrand").focus();
  }

  function closePriceForm() {
    const card = $("uvPriceFormCard");
    if (card) card.hidden = true;
    editingPriceId = null;
  }

  function validatePriceClient() {
    const low = Number($("uvPriceLow").value);
    const mid = Number($("uvPriceMid").value);
    const high = Number($("uvPriceHigh").value);
    const sample = Number($("uvPriceSample").value);
    const conf = Number($("uvPriceConfidence").value);
    if (!Number.isFinite(low) || !Number.isFinite(mid) || !Number.isFinite(high)) return "請填寫低／中／高價";
    if (low < 0 || mid < low || high < mid) return "價格區間不正確（低價 ≥ 0，中價 ≥ 低價，高價 ≥ 中價）";
    if (!Number.isFinite(sample) || sample < 0) return "樣本數必須 ≥ 0";
    if (!Number.isFinite(conf) || conf < 0 || conf > 100) return "信心值必須是 0 到 100";
    return "";
  }

  function openConfirm(mode, id, title, text) {
    confirmMode = mode;
    confirmTargetId = id;
    $("uvConfirmTitle").textContent = title;
    $("uvConfirmText").textContent = text;
    $("uvConfirmReason").value = "";
    $("uvConfirmOverlay").hidden = false;
    $("uvConfirmReason").focus();
  }

  function closeConfirm() {
    confirmMode = null;
    confirmTargetId = "";
    const el = $("uvConfirmOverlay");
    if (el) el.hidden = true;
  }

  async function callRpc(name, args) {
    const fn = rpc();
    if (!fn) return { ok: false, error: "後台資料介面尚未就緒" };
    return fn(name, args);
  }

  async function saveBatch() {
    const id = $("uvBatchId").value;
    const payload = {
      batch_code: $("uvBatchCode").value,
      effective_date: $("uvBatchEffectiveDate").value,
      source_summary: $("uvBatchSource").value,
    };
    const res = id
      ? await callRpc("backoffice_used_market_update_batch", { p_id: id, p_payload: payload })
      : await callRpc("backoffice_used_market_create_batch", { p_payload: payload });
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    const data = res.data && !Array.isArray(res.data) ? res.data : (Array.isArray(res.data) ? res.data[0] : null);
    if (data && data.id) selectedBatchId = data.id;
    closeBatchForm();
    showMsg(id ? "已更新草稿批次" : "已建立草稿批次", false);
    await loadAll();
  }

  async function savePrice() {
    const batch = selectedBatch();
    if (!isDraft(batch)) return;
    const verr = validatePriceClient();
    if (verr) {
      showMsg(verr, true);
      return;
    }
    const payload = {
      category: $("uvPriceCategory").value,
      brand: $("uvPriceBrand").value,
      model: $("uvPriceModel").value,
      variant: $("uvPriceVariant").value,
      market_low: Number($("uvPriceLow").value),
      market_mid: Number($("uvPriceMid").value),
      market_high: Number($("uvPriceHigh").value),
      sample_count: Number($("uvPriceSample").value),
      confidence: Number($("uvPriceConfidence").value),
      source_type: $("uvPriceSource").value,
      effective_date: $("uvPriceEffectiveDate").value,
      note: $("uvPriceNote").value,
    };
    let res;
    if (editingPriceId) {
      res = await callRpc("backoffice_used_market_update_price", { p_id: editingPriceId, p_payload: payload });
    } else {
      payload.market_batch_id = batch.id;
      res = await callRpc("backoffice_used_market_create_price", { p_payload: payload });
    }
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    const wasEdit = !!editingPriceId;
    closePriceForm();
    showMsg(wasEdit ? "已更新行情" : "已新增行情", false);
    await loadAll();
  }

  async function submitConfirm() {
    const reason = $("uvConfirmReason").value;
    if (!String(reason || "").trim()) {
      showMsg("請填寫原因", true);
      return;
    }
    let res;
    if (confirmMode === "activate") {
      res = await callRpc("backoffice_used_market_activate_batch", { p_id: confirmTargetId, p_reason: reason });
    } else if (confirmMode === "delete") {
      res = await callRpc("backoffice_used_market_delete_price", { p_id: confirmTargetId, p_reason: reason });
    } else {
      return;
    }
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    const mode = confirmMode;
    closeConfirm();
    showMsg(mode === "activate" ? "已啟用正式行情" : "已刪除行情", false);
    await loadAll();
  }

  function bind() {
    const root = $("tab-used-market");
    if (!root || root.dataset.uvBound === "1") return;
    root.dataset.uvBound = "1";

    const dl = $("uvCategoryList");
    if (dl) {
      dl.innerHTML = CATEGORIES.map(function (c) {
        return '<option value="' + esc(c) + '">';
      }).join("");
    }
    const filter = $("uvPriceCategoryFilter");
    if (filter && filter.options.length <= 1) {
      CATEGORIES.forEach(function (c) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        filter.appendChild(o);
      });
    }

    $("uvBtnNewBatch") && $("uvBtnNewBatch").addEventListener("click", function () { openBatchForm(null); });
    $("uvBatchCancel") && $("uvBatchCancel").addEventListener("click", closeBatchForm);
    $("uvBatchSave") && $("uvBatchSave").addEventListener("click", function () { saveBatch().catch(function (e) { showMsg(String(e && e.message || e), true); }); });
    $("uvBtnNewPrice") && $("uvBtnNewPrice").addEventListener("click", function () { openPriceForm(null); });
    $("uvPriceCancel") && $("uvPriceCancel").addEventListener("click", closePriceForm);
    $("uvPriceSave") && $("uvPriceSave").addEventListener("click", function () { savePrice().catch(function (e) { showMsg(String(e && e.message || e), true); }); });
    $("uvPriceSearch") && $("uvPriceSearch").addEventListener("input", renderPrices);
    $("uvPriceCategoryFilter") && $("uvPriceCategoryFilter").addEventListener("change", renderPrices);
    $("uvConfirmCancel") && $("uvConfirmCancel").addEventListener("click", closeConfirm);
    $("uvConfirmOk") && $("uvConfirmOk").addEventListener("click", function () { submitConfirm().catch(function (e) { showMsg(String(e && e.message || e), true); }); });

    root.addEventListener("click", function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-uv-select-batch],[data-uv-edit-batch],[data-uv-activate],[data-uv-edit-price],[data-uv-del-price]") : null;
      if (!t) return;
      const selectId = t.getAttribute("data-uv-select-batch");
      const editBatch = t.getAttribute("data-uv-edit-batch");
      const activate = t.getAttribute("data-uv-activate");
      const editPrice = t.getAttribute("data-uv-edit-price");
      const delPrice = t.getAttribute("data-uv-del-price");
      if (editBatch) {
        ev.preventDefault();
        const b = batches.find(function (x) { return x.id === editBatch; });
        if (b) openBatchForm(b);
        return;
      }
      if (activate) {
        ev.preventDefault();
        openConfirm(
          "activate",
          activate,
          "啟用正式行情",
          "啟用後此批次將成為正式行情，目前 ACTIVE 批次會封存，ACTIVE 批次不可再直接修改。"
        );
        return;
      }
      if (editPrice) {
        ev.preventDefault();
        const p = prices.find(function (x) { return x.id === editPrice; });
        if (p) openPriceForm(p);
        return;
      }
      if (delPrice) {
        ev.preventDefault();
        openConfirm("delete", delPrice, "刪除草稿行情", "刪除後無法還原此筆行情，請輸入刪除原因。");
        return;
      }
      if (selectId) {
        selectedBatchId = selectId;
        closePriceForm();
        render();
      }
    });
  }

  async function onShow() {
    if (!isAdmin()) {
      showMsg("行情管理僅限管理員", true);
      return;
    }
    bind();
    await loadAll();
  }

  window.__dkUsedMarketOnShow = onShow;
})();
