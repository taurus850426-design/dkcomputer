/* purchase-orders.js - 採購／叫貨單 1.0（僅後台；讀取既有廠商報價，不改其結構） */
(function () {
  "use strict";

  const PO_KEY = "dk_purchase_orders_v1";
  const STATUS_LABEL = {
    draft: "草稿",
    ordered: "已叫貨",
    partial: "部分到貨",
    received: "已到貨",
    cancelled: "已取消",
  };
  const ALLOWED_TRANSITIONS = {
    draft: ["draft", "ordered", "cancelled"],
    ordered: ["ordered", "partial", "received", "cancelled"],
    partial: ["partial", "received"],
    received: ["received"],
    cancelled: ["cancelled"],
  };

  let currentOrder = null;
  let editingItemId = null;
  let searchTimer = null;
  let lastSearchRows = [];

  function bridge() {
    return window.DKPurchaseBridge || {};
  }

  function esc(s) {
    try {
      if (bridge().esc) return bridge().esc(s);
    } catch (_) {}
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function safeParse(raw, fallback) {
    try {
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function uid(prefix) {
    return String(prefix || "id") + "_" + Date.now().toString(16) + "_" + Math.random().toString(16).slice(2, 8);
  }

  function todayYMD() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function ymdCompact(d) {
    const x = d instanceof Date ? d : new Date();
    return (
      x.getFullYear() +
      String(x.getMonth() + 1).padStart(2, "0") +
      String(x.getDate()).padStart(2, "0")
    );
  }

  function toNum(v) {
    if (v === "" || v == null) return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function fmtNT(n) {
    const x = toNum(n);
    if (x == null) return "—";
    return "NT$" + Math.round(x).toLocaleString("zh-TW");
  }

  function fmtDate(s) {
    const t = String(s || "").trim();
    if (!t) return "—";
    return t.slice(0, 10).replace(/-/g, "/");
  }

  function daysAgo(dateStr) {
    const t = String(dateStr || "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(t + "T00:00:00");
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.floor((today - d) / 86400000);
    return diff >= 0 ? diff : 0;
  }

  function ageLabel(days) {
    if (days == null) return { text: "日期未知", tone: "tag" };
    if (days === 0) return { text: "今日", tone: "ok" };
    if (days <= 7) return { text: days + " 天前 · 近期", tone: "ok" };
    if (days <= 30) return { text: days + " 天前 · 注意", tone: "warn" };
    return { text: days + " 天前 · 過期參考", tone: "danger" };
  }

  function showMsg(text, ms) {
    const el = document.getElementById("poMsg");
    if (!el) return;
    const t = String(text || "").trim();
    if (!t) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = t;
    if (ms) setTimeout(function () { if (el.textContent === t) showMsg(""); }, ms);
  }

  function loadOrders() {
    let list = [];
    if (window.DK && typeof window.DK.loadPurchaseOrdersRaw === "function") {
      list = window.DK.loadPurchaseOrdersRaw(false);
    } else {
      const raw = safeParse(localStorage.getItem(PO_KEY), null);
      list = Array.isArray(raw) ? raw : [];
      list = list.filter(function (o) { return !poIsDeleted(o); });
    }
    return list.map(normalizeOrder).filter(Boolean);
  }

  function loadOrdersAll() {
    if (window.DK && typeof window.DK.loadPurchaseOrdersRaw === "function") {
      return window.DK.loadPurchaseOrdersRaw(true).map(normalizeOrder).filter(Boolean);
    }
    const raw = safeParse(localStorage.getItem(PO_KEY), null);
    return (Array.isArray(raw) ? raw : []).map(normalizeOrder).filter(Boolean);
  }

  function poIsDeleted(o) {
    if (window.DK && typeof window.DK.vpIsDeleted === "function") return window.DK.vpIsDeleted(o);
    const d = o && (o.deletedAt != null ? o.deletedAt : o.deleted_at);
    return d != null && String(d).trim() !== "";
  }

  function saveOrders(list) {
    try {
      const active = Array.isArray(list) ? list.map(normalizeOrder).filter(Boolean) : [];
      const tombstones = loadOrdersAll().filter(function (o) { return poIsDeleted(o); });
      const activeIds = {};
      active.forEach(function (o) { activeIds[String(o.id)] = true; });
      const merged = tombstones.filter(function (t) { return !activeIds[String(t.id)]; }).concat(active);
      if (window.DK && typeof window.DK.savePurchaseOrdersRaw === "function") {
        window.DK.savePurchaseOrdersRaw(merged, { skipEvent: true, source: "local" });
      } else {
        localStorage.setItem(PO_KEY, JSON.stringify(merged));
      }
      return true;
    } catch (e) {
      showMsg("儲存失敗：" + String(e && e.message ? e.message : e));
      return false;
    }
  }

  function syncPurchaseOrderToCloud(order, okMsg) {
    if (!order || !window.DK || typeof window.DK.upsertPurchaseOrderToSupabase !== "function") return;
    if (window.DK.isVpApplyingCloud && window.DK.isVpApplyingCloud()) return;
    window.DK.upsertPurchaseOrderToSupabase(order).then(function (res) {
      renderPurchaseOrdersSyncPanel();
      const authMsg = window.DK.vpCloudUserMessage ? window.DK.vpCloudUserMessage(res) : null;
      if (res && res.ok) showMsg(okMsg || "已同步到雲端", 2500);
      else if (res && res.notEnabled) showMsg("本機已儲存。雲端尚未啟用。", 3500);
      else if (authMsg) showMsg("本機已儲存。" + authMsg, 3500);
      else showMsg("本機已儲存，雲端同步失敗" + (res && res.error ? "：" + res.error : ""), 3500);
    }).catch(function () {
      renderPurchaseOrdersSyncPanel();
      showMsg("本機已儲存，雲端同步失敗", 3500);
    });
  }

  function normalizeItem(it) {
    const r = it && typeof it === "object" ? it : {};
    const qty = Math.max(1, Math.floor(Number(r.quantity) || 1));
    return {
      id: String(r.id || uid("poi")),
      requestText: String(r.requestText || ""),
      category: String(r.category || ""),
      quantity: qty,
      selectedVendor: String(r.selectedVendor || ""),
      selectedQuoteId: r.selectedQuoteId == null || r.selectedQuoteId === "" ? null : String(r.selectedQuoteId),
      selectedSpec: String(r.selectedSpec || ""),
      selectedUnitPrice: toNum(r.selectedUnitPrice),
      quotedAt: String(r.quotedAt || ""),
      manualVendor: String(r.manualVendor || ""),
      manualUnitPrice: toNum(r.manualUnitPrice),
      itemNote: String(r.itemNote || ""),
    };
  }

  function normalizeOrder(o) {
    const r = o && typeof o === "object" ? o : null;
    if (!r) return null;
    let status = String(r.status || "draft");
    if (!STATUS_LABEL[status]) status = "draft";
    const out = {
      id: String(r.id || uid("po")),
      orderNo: String(r.orderNo || ""),
      createdAt: String(r.createdAt || new Date().toISOString()),
      updatedAt: String(r.updatedAt || new Date().toISOString()),
      status: status,
      supplierOrderDate: String(r.supplierOrderDate || ""),
      expectedDate: String(r.expectedDate || ""),
      note: String(r.note || ""),
      items: Array.isArray(r.items) ? r.items.map(normalizeItem) : [],
    };
    if (r.deletedAt || r.deleted_at) out.deletedAt = String(r.deletedAt || r.deleted_at);
    return out;
  }

  function nextOrderNo(list) {
    const day = ymdCompact(new Date());
    const prefix = "PO-" + day + "-";
    let max = 0;
    (list || []).forEach(function (o) {
      const no = String(o.orderNo || "");
      if (!no.startsWith(prefix)) return;
      const n = Number(no.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    });
    return prefix + String(max + 1).padStart(3, "0");
  }

  /** 搜尋正規化（僅採購功能使用） */
  function normalizePurchaseSearchText(text) {
    let s = String(text || "");
    s = s.replace(/　/g, " ");
    s = s.toLowerCase();
    s = s.replace(/[‐‑‒–—―−﹣－]/g, "-");
    s = s.replace(/(\d)\s*-\s*(\d)/g, "$1 $2");
    s = s.replace(/ddr\s*([345])/g, "ddr$1");
    s = s.replace(/(\d+(?:\.\d+)?)\s*gb\b/g, "$1g");
    s = s.replace(/(\d+(?:\.\d+)?)\s*g\b/g, "$1g");
    s = s.replace(/(\d+(?:\.\d+)?)\s*tb\b/g, "$1t");
    s = s.replace(/(\d+(?:\.\d+)?)\s*t\b/g, "$1t");
    s = s.replace(/[^a-z0-9\u4e00-\u9fff.\-\s]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function tokenize(norm) {
    return String(norm || "")
      .split(/\s+/)
      .filter(function (t) {
        return t && (t.length >= 2 || /^\d/.test(t));
      });
  }

  function quoteHaystack(q) {
    const b = bridge();
    const name = b.getVendorQuoteDisplayName ? b.getVendorQuoteDisplayName(q) : [q.brand, q.spec].filter(Boolean).join(" ");
    return normalizePurchaseSearchText(
      [name, q.vendor, q.category, q.brand, q.spec, q.note].filter(Boolean).join(" ")
    );
  }

  function matchLevel(queryRaw, quote) {
    const qn = normalizePurchaseSearchText(queryRaw);
    const tokens = tokenize(qn);
    if (!tokens.length) return "other";
    const hay = quoteHaystack(quote);

    const qDdr = tokens.filter(function (t) { return /^ddr[345]$/.test(t); });
    const hDdr = hay.match(/ddr[345]/g) || [];
    if (qDdr.length) {
      const ok = qDdr.every(function (d) { return hDdr.indexOf(d) !== -1; });
      if (!ok) return "other";
      // 搜尋指定 DDR 世代時，若報價含其他世代且缺目標世代 → 已在 ok 擋下
    }

    const qCap = tokens.filter(function (t) { return /^\d+(?:\.\d+)?[gt]$/.test(t); });
    for (let i = 0; i < qCap.length; i++) {
      if (hay.indexOf(qCap[i]) === -1) {
        // 容量不符：不得高度符合（例 32g vs 16g）
        const hit = tokens.filter(function (t) { return hay.indexOf(t) !== -1; }).length;
        if (hit >= Math.ceil(tokens.length * 0.5)) return "partial";
        return "other";
      }
    }

    if (hay.indexOf(qn) !== -1 || qn.indexOf(hay) !== -1) return "high";

    const hits = tokens.filter(function (t) { return hay.indexOf(t) !== -1; });
    if (hits.length === tokens.length) return "high";
    if (hits.length >= Math.ceil(tokens.length * 0.6)) return "partial";
    if (hits.length > 0) return "other";
    return null;
  }

  function loadQuotes() {
    try {
      if (bridge().loadVendorQuotes) return bridge().loadVendorQuotes() || [];
    } catch (_) {}
    const raw = safeParse(localStorage.getItem("dk_vendor_quotes_v1"), null);
    return Array.isArray(raw) ? raw : [];
  }

  function displayName(q) {
    try {
      if (bridge().getVendorQuoteDisplayName) return bridge().getVendorQuoteDisplayName(q);
    } catch (_) {}
    return [q && q.brand, q && q.spec].filter(Boolean).join(" ").trim() || "未填寫";
  }

  function itemVendor(it) {
    return String(it.selectedVendor || it.manualVendor || "").trim();
  }

  function itemPrice(it) {
    if (it.selectedUnitPrice != null && Number.isFinite(Number(it.selectedUnitPrice))) return Number(it.selectedUnitPrice);
    if (it.manualUnitPrice != null && Number.isFinite(Number(it.manualUnitPrice))) return Number(it.manualUnitPrice);
    return null;
  }

  function itemSpec(it) {
    return String(it.selectedSpec || it.requestText || "").trim();
  }

  function itemSubtotal(it) {
    const p = itemPrice(it);
    if (p == null) return null;
    return p * (Number(it.quantity) || 0);
  }

  function orderTotals(order) {
    const items = (order && order.items) || [];
    let qty = 0;
    let amount = 0;
    let hasAmount = false;
    let unassigned = 0;
    let stale = 0;
    const vendors = new Set();
    items.forEach(function (it) {
      qty += Number(it.quantity) || 0;
      const v = itemVendor(it);
      if (!v) unassigned += 1;
      else vendors.add(v);
      const sub = itemSubtotal(it);
      if (sub != null) {
        amount += sub;
        hasAmount = true;
      }
      const d = daysAgo(it.quotedAt);
      if (d != null && d > 30) stale += 1;
    });
    return {
      itemCount: items.length,
      totalQty: qty,
      totalAmount: hasAmount ? amount : null,
      unassigned: unassigned,
      stale: stale,
      vendorCount: vendors.size,
    };
  }

  function isEditable(order) {
    return !order || order.status === "draft";
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setListVisible(showList) {
    const list = el("poListView");
    const editor = el("poEditorView");
    if (list) list.hidden = !showList;
    if (editor) editor.hidden = showList;
  }

  function fillCategorySelect() {
    const sel = el("poItemCategory");
    if (!sel) return;
    const cur = sel.value;
    const cats = (bridge().getCategories && bridge().getCategories()) || [];
    sel.innerHTML = '<option value="">（可空白）</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
    }).join("");
    if (cur) sel.value = cur;
  }

  function fillManualVendorSelect() {
    const sel = el("poManualVendor");
    if (!sel) return;
    const list = (bridge().getVendors && bridge().getVendors()) || [];
    sel.innerHTML = '<option value="">請選擇廠商</option>' + list.map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(v) + "</option>";
    }).join("");
  }

  function renderList() {
    const tbody = el("poListTbody");
    if (!tbody) return;
    const q = normalizePurchaseSearchText(el("poListSearch") && el("poListSearch").value);
    const st = String((el("poListStatusFilter") && el("poListStatusFilter").value) || "");
    let list = loadOrders().slice().sort(function (a, b) {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    if (st) list = list.filter(function (o) { return o.status === st; });
    if (q) {
      list = list.filter(function (o) {
        const parts = [o.orderNo, o.note, o.status];
        (o.items || []).forEach(function (it) {
          parts.push(it.requestText, it.selectedSpec, it.selectedVendor, it.manualVendor, it.itemNote);
        });
        return normalizePurchaseSearchText(parts.join(" ")).indexOf(q) !== -1;
      });
    }
    if (!list.length) {
      tbody.innerHTML = '<tr><td class="muted" colspan="9">尚無叫貨單</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (o) {
      const tot = orderTotals(o);
      return (
        "<tr>" +
        "<td class=\"nowrap\">" + esc(o.orderNo) + "</td>" +
        "<td class=\"nowrap\">" + esc(fmtDate(o.createdAt)) + "</td>" +
        "<td><span class=\"badge " + statusBadgeClass(o.status) + "\">" + esc(STATUS_LABEL[o.status] || o.status) + "</span></td>" +
        '<td style="text-align:right">' + esc(String(tot.vendorCount)) + "</td>" +
        '<td style="text-align:right">' + esc(String(tot.itemCount)) + "</td>" +
        '<td style="text-align:right">' + esc(fmtNT(tot.totalAmount)) + "</td>" +
        "<td class=\"nowrap\">" + esc(fmtDate(o.expectedDate)) + "</td>" +
        "<td class=\"nowrap\">" + esc(fmtDate(o.updatedAt)) + "</td>" +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-act="view" data-id="' + esc(o.id) + '">查看</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-act="edit" data-id="' + esc(o.id) + '">編輯</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-act="copy" data-id="' + esc(o.id) + '">複製</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-act="print" data-id="' + esc(o.id) + '">列印</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-act="del" data-id="' + esc(o.id) + '">刪除</button>' +
        "</td></tr>"
      );
    }).join("");
  }

  function statusBadgeClass(st) {
    if (st === "draft") return "tag";
    if (st === "ordered") return "info";
    if (st === "partial") return "warn";
    if (st === "received") return "ok";
    if (st === "cancelled") return "danger";
    return "tag";
  }

  function openOrder(id, forceView) {
    const list = loadOrders();
    const found = list.find(function (o) { return o.id === id; });
    if (!found) {
      showMsg("找不到叫貨單");
      return;
    }
    currentOrder = normalizeOrder(JSON.parse(JSON.stringify(found)));
    editingItemId = null;
    fillEditor(forceView || currentOrder.status !== "draft");
    setListVisible(false);
  }

  function newOrder() {
    const list = loadOrders();
    currentOrder = normalizeOrder({
      id: uid("po"),
      orderNo: nextOrderNo(list),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
      items: [],
    });
    editingItemId = null;
    fillEditor(false);
    setListVisible(false);
    showMsg("已建立草稿（記得按儲存）", 2500);
  }

  function fillEditor(readOnlyHint) {
    const o = currentOrder;
    if (!o) return;
    fillCategorySelect();
    fillManualVendorSelect();
    if (el("poOrderNo")) el("poOrderNo").value = o.orderNo;
    if (el("poStatus")) el("poStatus").value = o.status;
    if (el("poSupplierOrderDate")) el("poSupplierOrderDate").value = (o.supplierOrderDate || "").slice(0, 10);
    if (el("poExpectedDate")) el("poExpectedDate").value = (o.expectedDate || "").slice(0, 10);
    if (el("poNote")) el("poNote").value = o.note || "";
    if (el("poEditorMeta")) {
      el("poEditorMeta").textContent =
        "建立：" + fmtDate(o.createdAt) + "｜更新：" + fmtDate(o.updatedAt) + "｜狀態：" + (STATUS_LABEL[o.status] || o.status);
    }
    const lock = el("poEditorLockHint");
    const addCard = el("poAddItemCard");
    const editable = isEditable(o) && !readOnlyHint;
    if (lock) {
      if (!editable) {
        lock.hidden = false;
        lock.textContent = "此叫貨單狀態為「" + (STATUS_LABEL[o.status] || o.status) + "」。建議僅查看；變更狀態請確認後再儲存。品項編輯以草稿為主。";
      } else {
        lock.hidden = true;
      }
    }
    if (addCard) addCard.hidden = !isEditable(o);
    if (el("poManualBox")) el("poManualBox").hidden = true;
    if (el("poCompareSummary")) el("poCompareSummary").hidden = true;
    if (el("poSearchResults")) el("poSearchResults").hidden = true;
    renderItems();
    renderVendorGroups();
  }

  function readEditorMetaIntoCurrent() {
    if (!currentOrder) return;
    const nextStatus = String((el("poStatus") && el("poStatus").value) || currentOrder.status);
    const allowed = ALLOWED_TRANSITIONS[currentOrder.status] || [currentOrder.status];
    if (allowed.indexOf(nextStatus) === -1) {
      showMsg("不允許的狀態變更：" + (STATUS_LABEL[currentOrder.status] || currentOrder.status) + " → " + (STATUS_LABEL[nextStatus] || nextStatus));
      if (el("poStatus")) el("poStatus").value = currentOrder.status;
      return false;
    }
    if (nextStatus === "ordered") {
      const tot = orderTotals(currentOrder);
      if (tot.unassigned > 0) {
        showMsg("尚有 " + tot.unassigned + " 個品項未指定廠商，無法改為已叫貨。");
        if (el("poStatus")) el("poStatus").value = currentOrder.status;
        return false;
      }
      if (tot.stale > 0) {
        const ok = confirm("部分品項使用超過 30 天的歷史報價（" + tot.stale + " 項），請確認已向廠商重新詢價。是否繼續改為已叫貨？");
        if (!ok) {
          if (el("poStatus")) el("poStatus").value = currentOrder.status;
          return false;
        }
      }
    }
    currentOrder.status = nextStatus;
    currentOrder.supplierOrderDate = String((el("poSupplierOrderDate") && el("poSupplierOrderDate").value) || "");
    currentOrder.expectedDate = String((el("poExpectedDate") && el("poExpectedDate").value) || "");
    currentOrder.note = String((el("poNote") && el("poNote").value) || "");
    return true;
  }

  function persistCurrent() {
    if (!currentOrder) return;
    if (readEditorMetaIntoCurrent() === false) return;
    currentOrder.updatedAt = new Date().toISOString();
    const list = loadOrders();
    const idx = list.findIndex(function (o) { return o.id === currentOrder.id; });
    const copy = normalizeOrder(JSON.parse(JSON.stringify(currentOrder)));
    if (idx >= 0) list[idx] = copy;
    else list.push(copy);
    if (!saveOrders(list)) return;
    currentOrder = copy;
    showMsg("已儲存 " + currentOrder.orderNo + "（本機）", 2000);
    fillEditor(false);
    renderList();
    renderPurchaseOrdersSyncPanel();
    syncPurchaseOrderToCloud(copy, "已儲存並同步 " + copy.orderNo);
  }

  function renderItems() {
    const tbody = el("poItemsTbody");
    const sum = el("poItemsSummary");
    if (!tbody || !currentOrder) return;
    const items = currentOrder.items || [];
    const tot = orderTotals(currentOrder);
    if (sum) {
      sum.textContent =
        "品項數 " + tot.itemCount +
        "｜總數量 " + tot.totalQty +
        "｜預計採購總額 " + fmtNT(tot.totalAmount) +
        "｜未選廠商 " + tot.unassigned +
        "｜過期報價 " + tot.stale;
    }
    if (!items.length) {
      tbody.innerHTML = '<tr><td class="muted" colspan="10">尚未加入品項</td></tr>';
      return;
    }
    tbody.innerHTML = items.map(function (it) {
      const d = daysAgo(it.quotedAt);
      const age = ageLabel(d);
      const tip = !itemVendor(it)
        ? '<span class="badge danger">未選廠商</span>'
        : (d != null && d > 30
          ? '<span class="badge warn">過期參考</span>'
          : '<span class="badge ' + age.tone + '">' + esc(age.text) + "</span>");
      const canEdit = isEditable(currentOrder);
      return (
        "<tr>" +
        "<td>" + esc(it.requestText || "—") + "</td>" +
        "<td>" + esc(itemSpec(it) || "—") + "</td>" +
        "<td>" + esc(itemVendor(it) || "—") + "</td>" +
        '<td style="text-align:right">' + esc(fmtNT(itemPrice(it))) + "</td>" +
        '<td style="text-align:right">' + esc(String(it.quantity)) + "</td>" +
        '<td style="text-align:right">' + esc(fmtNT(itemSubtotal(it))) + "</td>" +
        "<td class=\"nowrap\">" + esc(fmtDate(it.quotedAt)) + "</td>" +
        "<td>" + tip + "</td>" +
        "<td>" + esc(it.itemNote || "") + "</td>" +
        '<td style="text-align:right;white-space:nowrap">' +
        (canEdit
          ? '<button type="button" class="btn btn-ghost btn-sm" data-poi-act="reprice" data-id="' + esc(it.id) + '">重新比價</button> ' +
            '<button type="button" class="btn btn-ghost btn-sm" data-poi-act="rm" data-id="' + esc(it.id) + '">移除</button>'
          : "—") +
        "</td></tr>"
      );
    }).join("");
  }

  function groupByVendor(order) {
    const map = new Map();
    (order.items || []).forEach(function (it) {
      const v = itemVendor(it) || "未指定廠商";
      if (!map.has(v)) map.set(v, []);
      map.get(v).push(it);
    });
    return map;
  }

  function buildVendorText(order, vendorName, items) {
    const lines = [];
    lines.push("DK Computer 叫貨單");
    lines.push("單號：" + order.orderNo);
    lines.push("日期：" + fmtDate(order.createdAt || todayYMD()));
    lines.push("");
    lines.push("廠商：" + vendorName);
    lines.push("");
    let total = 0;
    let has = false;
    items.forEach(function (it, i) {
      lines.push((i + 1) + ". " + (itemSpec(it) || it.requestText || "品項"));
      lines.push("   數量：" + it.quantity);
      const p = itemPrice(it);
      if (p != null) {
        lines.push("   參考單價：" + fmtNT(p));
        total += p * (Number(it.quantity) || 0);
        has = true;
      } else {
        lines.push("   參考單價：請確認");
      }
      lines.push("   品項備註：" + (it.itemNote || "＿＿＿"));
      lines.push("");
    });
    lines.push("參考總額：" + (has ? fmtNT(total) : "請確認"));
    lines.push("");
    lines.push("整單備註：");
    lines.push(order.note || "＿＿＿");
    lines.push("");
    lines.push("請協助確認庫存、實際單價及到貨時間，謝謝。");
    return lines.join("\n");
  }

  function buildAllText(order) {
    const groups = groupByVendor(order);
    const chunks = [];
    groups.forEach(function (items, vendor) {
      chunks.push(buildVendorText(order, vendor, items));
      chunks.push("--------------------");
    });
    return chunks.join("\n");
  }

  async function copyText(text) {
    const t = String(text || "");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function renderVendorGroups() {
    const wrap = el("poVendorGroups");
    if (!wrap || !currentOrder) return;
    const groups = groupByVendor(currentOrder);
    if (!groups.size) {
      wrap.innerHTML = '<p class="muted">尚無品項可分組</p>';
      return;
    }
    let html = "";
    groups.forEach(function (items, vendor) {
      let sub = 0;
      let has = false;
      const rows = items.map(function (it) {
        const p = itemPrice(it);
        if (p != null) {
          sub += p * (Number(it.quantity) || 0);
          has = true;
        }
        return "<li>" + esc(itemSpec(it) || it.requestText) + " × " + esc(String(it.quantity)) +
          (p != null ? "（參考 " + esc(fmtNT(p)) + "）" : "") + "</li>";
      }).join("");
      html +=
        '<div class="po-vendor-block card" style="margin-bottom:10px" data-vendor="' + esc(vendor) + '">' +
        "<h4 class=\"h3\">" + esc(vendor) + "</h4>" +
        "<ul>" + rows + "</ul>" +
        '<div class="muted">小計：' + esc(has ? fmtNT(sub) : "—") + "</div>" +
        '<div class="actions" style="margin-top:8px">' +
        '<button type="button" class="btn btn-primary btn-sm" data-po-vg="copy" data-vendor="' + esc(vendor) + '">複製叫貨文字</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" data-po-vg="print" data-vendor="' + esc(vendor) + '">列印此廠商</button>' +
        "</div></div>";
    });
    wrap.innerHTML = html;
  }

  function searchQuotes(query) {
    const q = String(query || "").trim();
    const summary = el("poCompareSummary");
    const box = el("poSearchResults");
    if (!box) return;
    if (!q) {
      box.hidden = true;
      if (summary) summary.hidden = true;
      box.innerHTML = "";
      return;
    }
    const quotes = loadQuotes();
    const buckets = { high: [], partial: [], other: [] };
    quotes.forEach(function (quote) {
      const level = matchLevel(q, quote);
      if (!level) return;
      const price = toNum(quote.price);
      const days = daysAgo(quote.date);
      buckets[level].push({
        quote: quote,
        level: level,
        price: price,
        days: days,
        name: displayName(quote),
      });
    });

    function sortBucket(arr) {
      arr.sort(function (a, b) {
        const ap = a.price == null ? 1 : 0;
        const bp = b.price == null ? 1 : 0;
        if (ap !== bp) return ap - bp;
        if (a.price != null && b.price != null && a.price !== b.price) return a.price - b.price;
        return String(b.quote.date || "").localeCompare(String(a.quote.date || ""));
      });
    }
    sortBucket(buckets.high);
    sortBucket(buckets.partial);
    sortBucket(buckets.other);
    lastSearchRows = buckets.high.concat(buckets.partial, buckets.other);

    // 摘要：高度符合
    renderCompareSummary(buckets.high, summary);

    const levelTitle = { high: "高度符合", partial: "部分符合", other: "其他可能相關" };
    let html = "";
    ["high", "partial", "other"].forEach(function (lv) {
      const arr = buckets[lv];
      if (!arr.length) return;
      html += '<div class="po-result-group"><div class="po-result-group-title">' + esc(levelTitle[lv]) + "（" + arr.length + "）</div>";
      html += '<div class="table-wrap"><table class="table"><thead><tr>' +
        "<th>符合</th><th>廠商</th><th>規格</th><th>分類</th>" +
        '<th style="text-align:right">單價</th><th>報價日期</th><th>新舊</th><th>備註</th><th></th>' +
        "</tr></thead><tbody>";
      arr.forEach(function (row) {
        const age = ageLabel(row.days);
        const recentLow = false; // filled below badges via data
        html += "<tr>" +
          "<td><span class=\"badge " + (lv === "high" ? "ok" : lv === "partial" ? "warn" : "tag") + "\">" + esc(levelTitle[lv]) + "</span></td>" +
          "<td>" + esc(row.quote.vendor || "—") + "</td>" +
          "<td>" + esc(row.name) + "</td>" +
          "<td>" + esc(row.quote.category || "—") + "</td>" +
          '<td style="text-align:right">' + (row.price == null ? '<span class="muted">價格未確認</span>' : esc(fmtNT(row.price))) + "</td>" +
          "<td class=\"nowrap\">" + esc(fmtDate(row.quote.date)) + "</td>" +
          "<td><span class=\"badge " + age.tone + "\">" + esc(age.text) + "</span></td>" +
          "<td>" + esc(row.quote.note || "") + "</td>" +
          '<td style="text-align:right"><button type="button" class="btn btn-primary btn-sm" data-po-pick="' + esc(row.quote.id) + '">選擇</button></td>' +
          "</tr>";
      });
      html += "</tbody></table></div></div>";
    });
    if (!html) {
      html = '<p class="muted">沒有高度符合結果。可改關鍵字，或使用「改用手動報價加入」。</p>';
    }
    // 標記近期最低／歷史最低（僅高度符合有效價）
    html = annotateLowBadges(html, buckets.high);
    box.innerHTML = html;
    box.hidden = false;
  }

  function annotateLowBadges(html, highRows) {
    // 在摘要已處理；表格內額外標籤透過 summary，這裡簡化回傳
    return html;
  }

  function renderCompareSummary(highRows, summaryEl) {
    if (!summaryEl) return;
    const valid = highRows.filter(function (r) { return r.price != null; });
    const recent = valid.filter(function (r) { return r.days != null && r.days <= 30; });
    if (!highRows.length) {
      summaryEl.hidden = false;
      summaryEl.innerHTML = '<div class="muted">尚無高度符合結果。請確認規格，或改用手動報價。</div>';
      return;
    }
    // 各廠商最新有效報價（摘要用）
    const byVendor = new Map();
    valid.forEach(function (r) {
      const v = String(r.quote.vendor || "").trim() || "（未填廠商）";
      const cur = byVendor.get(v);
      if (!cur || String(r.quote.date || "") > String(cur.quote.date || "")) byVendor.set(v, r);
    });
    const vendorLatest = Array.from(byVendor.values()).sort(function (a, b) { return a.price - b.price; });

    let recentLow = null;
    recent.forEach(function (r) {
      if (!recentLow || r.price < recentLow.price) recentLow = r;
    });
    let histLow = null;
    valid.forEach(function (r) {
      if (!histLow || r.price < histLow.price) histLow = r;
    });

    let html = '<div class="po-summary-card">';
    if (recentLow) {
      html += "<div><strong>近期最低：</strong>" + esc(recentLow.quote.vendor) + "｜" + esc(recentLow.name) +
        "｜" + esc(fmtNT(recentLow.price)) + "｜" + esc(ageLabel(recentLow.days).text) +
        ' <span class="badge ok">近期最低</span></div>';
    } else {
      html += "<div class=\"muted\">尚無近期報價，請向廠商重新詢價。</div>";
    }
    if (vendorLatest[1]) {
      html += "<div><strong>第二低（各廠最新）：</strong>" + esc(vendorLatest[1].quote.vendor) + "｜" +
        esc(vendorLatest[1].name) + "｜" + esc(fmtNT(vendorLatest[1].price)) + "</div>";
    }
    if (vendorLatest[0] && vendorLatest[1] && vendorLatest[0].price != null && vendorLatest[1].price != null) {
      html += "<div><strong>價差：</strong>" + esc(fmtNT(vendorLatest[1].price - vendorLatest[0].price)) + "</div>";
    }
    if (histLow && (!recentLow || histLow.quote.id !== recentLow.quote.id)) {
      html += "<div><strong>歷史最低：</strong>" + esc(histLow.quote.vendor) + "｜" + esc(histLow.name) +
        "｜" + esc(fmtNT(histLow.price)) + ' <span class="badge warn">歷史最低</span></div>';
    }
    const vendors = new Set(highRows.map(function (r) { return String(r.quote.vendor || ""); }));
    html += "<div class=\"muted\">歷史報價筆數：" + highRows.length + "｜涉及廠商：" + vendors.size + "</div>";
    html += '<div class="muted small">不會自動選定最低價，請點「選擇」確認。</div>';
    html += "</div>";
    summaryEl.innerHTML = html;
    summaryEl.hidden = false;
  }

  function pickQuote(quoteId) {
    if (!currentOrder || !isEditable(currentOrder)) {
      showMsg("僅草稿可加入／變更品項");
      return;
    }
    const row = lastSearchRows.find(function (r) { return String(r.quote.id) === String(quoteId); });
    if (!row) {
      showMsg("找不到該報價");
      return;
    }
    const q = row.quote;
    const qty = Math.max(1, Math.floor(Number((el("poItemQty") && el("poItemQty").value) || 1)));
    const requestText = String((el("poRequestText") && el("poRequestText").value) || "").trim() || displayName(q);
    const category = String((el("poItemCategory") && el("poItemCategory").value) || q.category || "");
    const itemNote = String((el("poItemNote") && el("poItemNote").value) || "");
    const price = toNum(q.price);

    const item = normalizeItem({
      id: editingItemId || uid("poi"),
      requestText: requestText,
      category: category,
      quantity: qty,
      selectedVendor: String(q.vendor || ""),
      selectedQuoteId: String(q.id),
      selectedSpec: displayName(q),
      selectedUnitPrice: price,
      quotedAt: String(q.date || "").slice(0, 10),
      manualVendor: "",
      manualUnitPrice: null,
      itemNote: itemNote,
    });

    if (editingItemId) {
      const idx = currentOrder.items.findIndex(function (x) { return x.id === editingItemId; });
      if (idx >= 0) currentOrder.items[idx] = item;
      else currentOrder.items.push(item);
    } else {
      currentOrder.items.push(item);
    }
    editingItemId = null;
    showMsg("已加入品項（記得儲存叫貨單）", 2000);
    renderItems();
    renderVendorGroups();
  }

  function addManualItem() {
    if (!currentOrder || !isEditable(currentOrder)) {
      showMsg("僅草稿可加入品項");
      return;
    }
    const vendor = String((el("poManualVendor") && el("poManualVendor").value) || "").trim();
    const price = toNum(el("poManualPrice") && el("poManualPrice").value);
    const requestText = String((el("poRequestText") && el("poRequestText").value) || "").trim();
    const spec = String((el("poManualSpec") && el("poManualSpec").value) || "").trim() || requestText;
    const qty = Math.max(1, Math.floor(Number((el("poItemQty") && el("poItemQty").value) || 1)));
    if (!requestText && !spec) {
      showMsg("請填需求規格");
      return;
    }
    if (!vendor) {
      showMsg("請選擇手動廠商");
      return;
    }
    if (price == null || price < 0) {
      showMsg("請填正確手動單價");
      return;
    }
    const item = normalizeItem({
      id: editingItemId || uid("poi"),
      requestText: requestText || spec,
      category: String((el("poItemCategory") && el("poItemCategory").value) || ""),
      quantity: qty,
      selectedVendor: vendor,
      selectedQuoteId: null,
      selectedSpec: spec,
      selectedUnitPrice: price,
      quotedAt: todayYMD(),
      manualVendor: vendor,
      manualUnitPrice: price,
      itemNote: String((el("poItemNote") && el("poItemNote").value) || ""),
    });
    if (editingItemId) {
      const idx = currentOrder.items.findIndex(function (x) { return x.id === editingItemId; });
      if (idx >= 0) currentOrder.items[idx] = item;
      else currentOrder.items.push(item);
    } else currentOrder.items.push(item);
    editingItemId = null;
    if (el("poManualBox")) el("poManualBox").hidden = true;
    showMsg("已手動加入品項（記得儲存）", 2000);
    renderItems();
    renderVendorGroups();
  }

  function buildPrintHtml(order, onlyVendor) {
    const groups = groupByVendor(order);
    let body = "";
    groups.forEach(function (items, vendor) {
      if (onlyVendor && vendor !== onlyVendor) return;
      let sub = 0;
      let has = false;
      body += "<h3>" + esc(vendor) + "</h3><table><thead><tr><th>規格</th><th>數量</th><th>參考單價</th><th>小計</th><th>備註</th></tr></thead><tbody>";
      items.forEach(function (it) {
        const p = itemPrice(it);
        const s = itemSubtotal(it);
        if (s != null) { sub += s; has = true; }
        body += "<tr><td>" + esc(itemSpec(it)) + "</td><td>" + esc(String(it.quantity)) +
          "</td><td>" + esc(fmtNT(p)) + "</td><td>" + esc(fmtNT(s)) + "</td><td>" + esc(it.itemNote || "") + "</td></tr>";
      });
      body += '</tbody></table><p>小計：' + esc(has ? fmtNT(sub) : "—") + "</p>";
    });
    const tot = orderTotals(order);
    return (
      '<div class="po-print-inner">' +
      "<h1>DK Computer 叫貨單</h1>" +
      "<p>單號：" + esc(order.orderNo) + "<br>建立：" + esc(fmtDate(order.createdAt)) +
      "<br>狀態：" + esc(STATUS_LABEL[order.status] || order.status) +
      "<br>預計到貨：" + esc(fmtDate(order.expectedDate)) + "</p>" +
      body +
      "<p><strong>預計總額：" + esc(fmtNT(tot.totalAmount)) + "</strong></p>" +
      "<p>整單備註：" + esc(order.note || "") + "</p>" +
      "<p>確認欄：__________　　到貨欄：__________</p>" +
      '<p class="muted">參考單價為歷史報價快照，實際成交價以廠商確認為準。</p>' +
      "</div>"
    );
  }

  function printOrder(order, onlyVendor) {
    const area = el("poPrintArea");
    if (!area) return;
    area.innerHTML = buildPrintHtml(order, onlyVendor || "");
    document.body.classList.add("po-printing");
    window.print();
    setTimeout(function () {
      document.body.classList.remove("po-printing");
    }, 300);
  }

  function bind() {
    const root = el("purchaseOrdersRoot");
    if (!root || root.dataset.poBound === "1") return;
    root.dataset.poBound = "1";

    el("poNewBtn") && el("poNewBtn").addEventListener("click", newOrder);
    el("poBackToListBtn") && el("poBackToListBtn").addEventListener("click", function () {
      currentOrder = null;
      setListVisible(true);
      renderList();
    });
    el("poSaveBtn") && el("poSaveBtn").addEventListener("click", persistCurrent);
    el("poCopyAllBtn") && el("poCopyAllBtn").addEventListener("click", async function () {
      if (!currentOrder) return;
      const ok = await copyText(buildAllText(currentOrder));
      showMsg(ok ? "已複製全部叫貨文字" : "複製失敗，請手動選取", 2500);
    });
    el("poPrintBtn") && el("poPrintBtn").addEventListener("click", function () {
      if (currentOrder) printOrder(currentOrder);
    });
    el("poListSearch") && el("poListSearch").addEventListener("input", renderList);
    el("poListStatusFilter") && el("poListStatusFilter").addEventListener("change", renderList);

    el("poSearchQuotesBtn") && el("poSearchQuotesBtn").addEventListener("click", function () {
      searchQuotes(el("poRequestText") && el("poRequestText").value);
    });
    el("poRequestText") && el("poRequestText").addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        const v = el("poRequestText") && el("poRequestText").value;
        if (String(v || "").trim().length >= 2) searchQuotes(v);
      }, 350);
    });

    el("poAddManualItemBtn") && el("poAddManualItemBtn").addEventListener("click", function () {
      fillManualVendorSelect();
      if (el("poManualBox")) el("poManualBox").hidden = false;
      if (el("poManualSpec") && el("poRequestText")) el("poManualSpec").value = el("poRequestText").value || "";
    });
    el("poCancelManualBtn") && el("poCancelManualBtn").addEventListener("click", function () {
      if (el("poManualBox")) el("poManualBox").hidden = true;
    });
    el("poConfirmManualBtn") && el("poConfirmManualBtn").addEventListener("click", addManualItem);

    root.addEventListener("click", function (e) {
      const t = e.target;
      if (!t || !t.closest) return;

      const listBtn = t.closest("[data-po-act]");
      if (listBtn) {
        const id = listBtn.getAttribute("data-id");
        const act = listBtn.getAttribute("data-po-act");
        if (act === "view") openOrder(id, true);
        else if (act === "edit") openOrder(id, false);
        else if (act === "copy") {
          const o = loadOrders().find(function (x) { return x.id === id; });
          if (o) copyText(buildAllText(o)).then(function (ok) { showMsg(ok ? "已複製" : "複製失敗", 2000); });
        } else if (act === "print") {
          const o = loadOrders().find(function (x) { return x.id === id; });
          if (o) printOrder(o);
        } else if (act === "del") {
          if (window.DK && typeof window.DK.requirePermission === "function" && !window.DK.requirePermission("purchase")) return;
          if (!confirm("確定刪除此叫貨單？（soft delete，另一裝置不會再帶回）")) return;
          const targetId = id;
          if (window.DK && typeof window.DK.softDeletePurchaseOrderToSupabase === "function") {
            window.DK.softDeletePurchaseOrderToSupabase(targetId).then(function (res) {
              if (currentOrder && currentOrder.id === targetId) {
                currentOrder = null;
                setListVisible(true);
              }
              renderList();
              renderPurchaseOrdersSyncPanel();
              if (res && res.cloud && res.cloud.ok) showMsg("已刪除（本機＋雲端 soft delete）", 2500);
              else if (res && res.localSaved) {
                const authMsg = window.DK.vpCloudUserMessage ? window.DK.vpCloudUserMessage(res.cloud) : null;
                showMsg(authMsg ? "本機已刪除；" + authMsg : "本機已刪除；雲端同步失敗或尚未啟用", 3500);
              }
              else showMsg("刪除失敗", 2500);
            });
            return;
          }
          const now = new Date().toISOString();
          const all = loadOrdersAll().map(function (x) {
            if (String(x.id) !== String(targetId)) return x;
            return Object.assign({}, x, { deletedAt: now, updatedAt: now });
          });
          if (window.DK && typeof window.DK.savePurchaseOrdersRaw === "function") {
            window.DK.savePurchaseOrdersRaw(all, { skipEvent: true, source: "local" });
          } else {
            localStorage.setItem(PO_KEY, JSON.stringify(all));
          }
          if (currentOrder && currentOrder.id === targetId) {
            currentOrder = null;
            setListVisible(true);
          }
          renderList();
          showMsg("已刪除", 2000);
        }
        return;
      }

      const pick = t.closest("[data-po-pick]");
      if (pick) {
        pickQuote(pick.getAttribute("data-po-pick"));
        return;
      }

      const poi = t.closest("[data-poi-act]");
      if (poi && currentOrder) {
        const id = poi.getAttribute("data-id");
        const act = poi.getAttribute("data-poi-act");
        if (act === "rm") {
          currentOrder.items = currentOrder.items.filter(function (x) { return x.id !== id; });
          renderItems();
          renderVendorGroups();
        } else if (act === "reprice") {
          const it = currentOrder.items.find(function (x) { return x.id === id; });
          if (!it) return;
          editingItemId = id;
          if (el("poRequestText")) el("poRequestText").value = it.requestText || "";
          if (el("poItemQty")) el("poItemQty").value = String(it.quantity || 1);
          if (el("poItemNote")) el("poItemNote").value = it.itemNote || "";
          if (el("poItemCategory")) el("poItemCategory").value = it.category || "";
          searchQuotes(it.requestText || it.selectedSpec || "");
          showMsg("請從搜尋結果重新選擇報價", 2500);
        }
        return;
      }

      const vg = t.closest("[data-po-vg]");
      if (vg && currentOrder) {
        const vendor = vg.getAttribute("data-vendor");
        const act = vg.getAttribute("data-po-vg");
        const items = groupByVendor(currentOrder).get(vendor) || [];
        if (act === "copy") {
          copyText(buildVendorText(currentOrder, vendor, items)).then(function (ok) {
            showMsg(ok ? "已複製「" + vendor + "」叫貨文字" : "複製失敗", 2500);
          });
        } else if (act === "print") {
          printOrder(currentOrder, vendor);
        }
      }
    });
  }

  function onShow() {
    if (window.DK && typeof window.DK.requirePermission === "function" && !window.DK.requirePermission("purchase")) return;
    try {
      bind();
      fillCategorySelect();
      fillManualVendorSelect();
      renderPurchaseOrdersSyncPanel();
      if (!currentOrder) {
        setListVisible(true);
        renderList();
      } else {
        setListVisible(false);
        fillEditor(false);
      }
    } catch (e) {
      showMsg("叫貨單載入異常：" + String(e && e.message ? e.message : e));
    }
  }

  function poSyncSetMsg(text) {
    const el = document.getElementById("poSyncExtraMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function renderPurchaseOrdersSyncPanel() {
    const badge = document.getElementById("poSyncStatusBadge");
    const detail = document.getElementById("poSyncDetail");
    const uploadBtn = document.getElementById("poSyncUploadBtn");
    if (!badge && !detail) return;
    const meta = (window.DK && window.DK.getPurchaseOrdersSyncMeta && window.DK.getPurchaseOrdersSyncMeta()) || {};
    const status = String(meta.status || "never");
    const label = (window.DK && window.DK.vpStatusLabel && window.DK.vpStatusLabel(status)) || status;
    const localCount = Number(meta.localCount) || loadOrders().length;
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
    }
    if (detail) {
      let msg = "本機 " + localCount + " 筆｜雲端 " + cloudCount + " 筆｜來源：" + src + "｜最後同步：" + last;
      if (status === "not_enabled") {
        msg += "。請先在 Supabase SQL Editor 執行 supabase-vendor-purchase-sync.sql（尚未正式可用）。";
      } else if (status === "pending_local") {
        msg += "。雲端尚無資料，可手動「上傳本機資料」。";
      } else if (status === "failed" && meta.lastError) {
        msg += "。錯誤：" + String(meta.lastError).slice(0, 120);
      }
      if (Array.isArray(meta.conflictWarnings) && meta.conflictWarnings.length) {
        msg += "｜衝突警告 " + meta.conflictWarnings.length + " 筆（同時間取雲端）";
      }
      detail.textContent = msg;
    }
    if (uploadBtn) {
      const canUpload = meta.cloudEnabled === true && status !== "not_enabled" && status !== "syncing" && localCount > 0;
      uploadBtn.hidden = !canUpload;
    }
  }

  function bindPurchaseOrdersSyncPanelOnce() {
    if (window.__dkPoSyncPanelBound) return;
    window.__dkPoSyncPanelBound = true;

    const syncNow = async function () {
      poSyncSetMsg("同步中…");
      renderPurchaseOrdersSyncPanel();
      if (!window.DK || typeof window.DK.pullPurchaseOrdersFromCloud !== "function") {
        poSyncSetMsg("同步模組未載入");
        return;
      }
      const res = await window.DK.pullPurchaseOrdersFromCloud();
      renderList();
      if (currentOrder) {
        const fresh = loadOrders().find(function (o) { return o.id === currentOrder.id; });
        if (fresh) {
          currentOrder = fresh;
          fillEditor(false);
        }
      }
      renderPurchaseOrdersSyncPanel();
      if (res && res.notEnabled) poSyncSetMsg("雲端尚未啟用：請先執行 supabase-vendor-purchase-sync.sql");
      else if (window.DK && window.DK.vpCloudUserMessage && window.DK.vpCloudUserMessage(res)) poSyncSetMsg(window.DK.vpCloudUserMessage(res));
      else if (res && res.emptyCloud) poSyncSetMsg("雲端為空，已保留本機資料（未覆蓋）");
      else if (res && res.ok) poSyncSetMsg("已從雲端合併完成");
      else poSyncSetMsg("同步失敗，本機資料已保留");
    };

    document.getElementById("poSyncNowBtn") && document.getElementById("poSyncNowBtn").addEventListener("click", syncNow);
    document.getElementById("poSyncPullBtn") && document.getElementById("poSyncPullBtn").addEventListener("click", syncNow);

    document.getElementById("poSyncUploadBtn") && document.getElementById("poSyncUploadBtn").addEventListener("click", async function () {
      if (!window.DK || !window.DK.previewPurchaseOrdersUpload || !window.DK.uploadLocalPurchaseOrdersToCloud) {
        poSyncSetMsg("同步模組未載入");
        return;
      }
      poSyncSetMsg("正在計算上傳預覽…");
      const preview = await window.DK.previewPurchaseOrdersUpload();
      if (!preview || !preview.ok) {
        const authMsg = window.DK && window.DK.vpCloudUserMessage ? window.DK.vpCloudUserMessage(preview) : null;
        poSyncSetMsg(preview && preview.notEnabled ? "雲端尚未啟用，無法上傳" : (authMsg || ("預覽失敗：" + ((preview && preview.error) || ""))));
        renderPurchaseOrdersSyncPanel();
        return;
      }
      const ok = confirm(
        "將本機叫貨單同步到雲端？\n\n" +
          "本機筆數（未刪除）：" + preview.localCount + "\n" +
          "雲端筆數（未刪除）：" + preview.cloudCount + "\n" +
          "預計新增：" + preview.toInsert + "\n" +
          "預計更新：" + preview.toUpdate + "\n\n" +
          "將依 id upsert，不會刪除雲端其他資料。\n" +
          "僅管理員可寫入雲端。"
      );
      if (!ok) {
        poSyncSetMsg("已取消上傳");
        return;
      }
      poSyncSetMsg("上傳中…");
      const result = await window.DK.uploadLocalPurchaseOrdersToCloud();
      renderList();
      renderPurchaseOrdersSyncPanel();
      if (result && result.ok) {
        poSyncSetMsg("上傳完成：成功 " + result.success + " 筆" + (result.failed ? "，失敗 " + result.failed : ""));
      } else {
        poSyncSetMsg(
          (result && result.notEnabled ? "雲端尚未啟用。" : (window.DK && window.DK.vpCloudUserMessage && window.DK.vpCloudUserMessage(result) ? window.DK.vpCloudUserMessage(result) + "。" : "上傳失敗。")) +
            "成功 " + ((result && result.success) || 0) + "／失敗 " + ((result && result.failed) || 0) +
            (result && result.error && !(window.DK && window.DK.vpCloudUserMessage && window.DK.vpCloudUserMessage(result)) ? "：" + result.error : "") +
            "。本機資料已保留。"
        );
      }
    });

    if (!window.__dkPurchaseOrdersUpdatedBound) {
      window.__dkPurchaseOrdersUpdatedBound = true;
      window.addEventListener("dk:purchase-orders-updated", function () {
        try {
          renderList();
          renderPurchaseOrdersSyncPanel();
          if (currentOrder) {
            const fresh = loadOrders().find(function (o) { return o.id === currentOrder.id; });
            if (fresh) {
              currentOrder = fresh;
              fillEditor(false);
            } else if (poIsDeleted(currentOrder) || !loadOrders().some(function (o) { return o.id === currentOrder.id; })) {
              // 被 soft delete 後離開編輯
              currentOrder = null;
              setListVisible(true);
            }
          }
        } catch (_) {}
      });
    }
  }

  window.__dkPurchaseOrdersOnShow = onShow;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      try {
        bind();
        bindPurchaseOrdersSyncPanelOnce();
        renderPurchaseOrdersSyncPanel();
      } catch (_) {}
    });
  } else {
    try {
      bind();
      bindPurchaseOrdersSyncPanelOnce();
      renderPurchaseOrdersSyncPanel();
    } catch (_) {}
  }
})();
