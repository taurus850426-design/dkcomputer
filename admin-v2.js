/**
 * 庫存＋記帳 後台 UI（admin-v2.html）
 * 依賴 inventory-ledger.js（window.DK）
 */
(function () {
  if (typeof window.DK === "undefined") return;

  const DK = window.DK;
  const todayStr = DK.todayStr;
  const nowISO = DK.nowISO;

  function esc(s) {
    if (s == null || s === undefined) return "";
    const t = String(s);
    const div = document.createElement("div");
    div.textContent = t;
    return div.innerHTML;
  }
  function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return "-";
    return Number(n).toLocaleString("zh-TW");
  }
  function show(el, msg) {
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }
  function hide(el) {
    if (el) el.hidden = true;
  }

  const LEDGER_TYPE_LABEL = { IN: "入庫", OUT: "出庫", ADJUST: "調整" };
  const REF_TYPE_LABEL = { PURCHASE: "進貨", ORDER: "訂單", RMA: "退換", SCRAP: "報廢", MOVE: "移倉", ADJUST: "調整" };
  const ORDER_STATUS_LABEL = { pending: "待處理", paid: "已付款", shipped: "已出貨", completed: "已完成", refunded: "已退貨" };
  const ITEM_STATUS_LABEL = { READY: "可售", TESTING: "待測", PREP: "待整理", RESERVED: "保留", CLEARANCE: "待出清", SCRAP: "報廢拆料" };
  const EXPENSE_TYPE_LABEL = { COGS: "銷貨成本", OPEX: "營業費用", OTHER: "其他" };

  // ---------- Tabs ----------
  const tabs = document.querySelectorAll(".tab");
  const sections = document.querySelectorAll("[id^='tab-']");
  function switchTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === name));
    sections.forEach((s) => {
      s.hidden = s.id !== "tab-" + name;
    });
    if (name === "items") renderItems();
    if (name === "ledger") renderLedger();
    if (name === "orders") renderOrders();
    if (name === "expenses") renderExpenses();
    if (name === "reports") renderReports();
  }
  tabs.forEach((t) => t.addEventListener("click", () => switchTab(t.getAttribute("data-tab"))));

  // ---------- Items ----------
  const itemsTbody = document.getElementById("itemsTbody");
  const itemsSearch = document.getElementById("itemsSearch");
  const itemsCategory = document.getElementById("itemsCategory");
  const itemsStatus = document.getElementById("itemsStatus");
  const itemEditorModal = document.getElementById("itemEditorModal");
  const itemEditor = document.getElementById("itemEditor");
  const itemMsg = document.getElementById("itemMsg");
  let editingItemId = null;

  const itemsCategoryQuick = document.getElementById("itemsCategoryQuick");

  function fillCategoryOptions() {
    const cats = DK.getInventoryCategories ? DK.getInventoryCategories() : ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼"];
    if (itemsCategory) {
      itemsCategory.innerHTML = "<option value=\"\">全部品類</option>" + cats.map((c) => "<option value=\"" + esc(c) + "\">" + esc(c) + "</option>").join("");
    }
    const itemCategoryEl = document.getElementById("itemCategory");
    if (itemCategoryEl) itemCategoryEl.innerHTML = cats.map((c) => "<option value=\"" + esc(c) + "\">" + esc(c) + "</option>").join("");
    if (itemsCategoryQuick) {
      itemsCategoryQuick.innerHTML = "<button type=\"button\" class=\"btn btn-ghost btn-sm seg seg-cat active\" data-cat=\"\">全部</button>" + cats.map((c) => "<button type=\"button\" class=\"btn btn-ghost btn-sm seg seg-cat\" data-cat=\"" + esc(c) + "\">" + esc(c) + "</button>").join("");
      itemsCategoryQuick.querySelectorAll(".seg-cat").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cat = btn.getAttribute("data-cat") || "";
          if (itemsCategory) itemsCategory.value = cat;
          itemsCategoryQuick.querySelectorAll(".seg-cat").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          renderItems();
        });
      });
    }
  }

  function renderItems() {
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
        <td>${esc(x.name)}</td>
        <td class="muted small">${esc(x.spec || "")}</td>
        <td>${esc(x.category)}</td>
        <td>${esc(ITEM_STATUS_LABEL[x.status] || x.status)}</td>
        <td>${x.qty_on_hand}</td>
        <td>${fmtNum(x.cost_unit)}</td>
        <td>${fmtNum(x.price_list)}</td>
        <td>${fmtNum(x.price_floor)}</td>
        <td>${esc((x.inbound_date || "").toString().slice(0, 10))}</td>
        <td>${x.age_days != null ? x.age_days : "-"}</td>
        <td>${x.idle_days != null ? x.idle_days : "-"}</td>
        <td>${fmtNum(x.inventory_value)}</td>
        <td class="muted small">${esc(alertText)}</td>
        <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-item" data-id="${esc(x.id)}">編輯</button></td>
      </tr>`;
    }).join("");

    itemsTbody.querySelectorAll(".btn-edit-item").forEach((btn) => {
      btn.addEventListener("click", () => openItemEditor(btn.getAttribute("data-id")));
    });
    const catVal = itemsCategory?.value || "";
    itemsCategoryQuick?.querySelectorAll(".seg-cat").forEach((b) => b.classList.toggle("active", (b.getAttribute("data-cat") || "") === catVal));
  }

  function generateUniqueSKU() {
    let base = "ITEM-" + Date.now().toString(36).toUpperCase();
    let sku = base;
    let n = 0;
    while (DK.findItemBySku(sku)) sku = base + "-" + (++n);
    return sku;
  }

  function openItemEditor(id) {
    editingItemId = id || null;
    const item = id ? DK.findItemById(id) : null;
    document.getElementById("itemCategory").value = item ? item.category : (DK.getInventoryCategories && DK.getInventoryCategories()[0]) || "處理器";
    document.getElementById("itemName").value = item ? item.name : "";
    document.getElementById("itemSpec").value = item ? item.spec : "";
    document.getElementById("itemCondition").value = item ? item.condition : "USED";
    document.getElementById("itemStatus").value = item ? item.status : "READY";
    document.getElementById("itemQty").value = item ? item.qty_on_hand : 0;
    document.getElementById("itemCost").value = item ? item.cost_unit : 0;
    document.getElementById("itemPriceList").value = item ? item.price_list ?? "" : "";
    document.getElementById("itemPriceFloor").value = item ? item.price_floor ?? "" : "";
    document.getElementById("itemInboundDate").value = item && item.inbound_date ? item.inbound_date.slice(0, 10) : todayStr();
    document.getElementById("itemReorderPoint").value = item ? (item.reorder_point ?? 0) : 0;
    document.getElementById("itemLocation").value = item ? item.location ?? "" : "";
    document.getElementById("itemNotes").value = item ? item.notes ?? "" : "";
    if (itemEditorModal) itemEditorModal.hidden = false;
    hide(itemMsg);
  }

  function closeItemEditor() {
    if (itemEditorModal) itemEditorModal.hidden = true;
    editingItemId = null;
    hide(itemMsg);
  }

  document.getElementById("btnNewItem")?.addEventListener("click", () => openItemEditor(null));
  document.getElementById("itemCancel")?.addEventListener("click", closeItemEditor);
  itemEditorModal?.addEventListener("click", (e) => { if (e.target === itemEditorModal) closeItemEditor(); });
  document.getElementById("itemSave")?.addEventListener("click", () => {
    const name = String(document.getElementById("itemName").value || "").trim();
    if (!name) return show(itemMsg, "名稱必填");
    const items = DK.getItems();
    const editingItem = editingItemId ? DK.findItemById(editingItemId) : null;
    const sku = editingItem ? editingItem.sku : generateUniqueSKU();

    const payload = {
      sku,
      category: document.getElementById("itemCategory").value,
      name,
      spec: document.getElementById("itemSpec").value,
      condition: document.getElementById("itemCondition").value,
      status: document.getElementById("itemStatus").value,
      qty_on_hand: Math.max(0, parseInt(document.getElementById("itemQty").value, 10) || 0),
      cost_unit: parseFloat(document.getElementById("itemCost").value) || 0,
      price_list: parseFloat(document.getElementById("itemPriceList").value) || null,
      price_floor: parseFloat(document.getElementById("itemPriceFloor").value) || null,
      inbound_date: document.getElementById("itemInboundDate").value || null,
      reorder_point: Math.max(0, parseInt(document.getElementById("itemReorderPoint").value, 10) || 0),
      location: document.getElementById("itemLocation").value || "",
      notes: document.getElementById("itemNotes").value || "",
      updated_at: nowISO(),
    };

    if (editingItemId) {
      const idx = items.findIndex((x) => x.id === editingItemId);
      if (idx < 0) return show(itemMsg, "找不到品項");
      items[idx] = { ...items[idx], ...payload };
      DK.saveItems(items);
      show(itemMsg, "已更新");
    } else {
      payload.id = "i-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
      payload.last_moved_at = payload.inbound_date ? payload.inbound_date + "T12:00:00Z" : null;
      payload.created_at = nowISO();
      items.unshift(payload);
      DK.saveItems(items);
      show(itemMsg, "已新增");
    }
    renderItems();
    setTimeout(closeItemEditor, 800);
  });

  itemsSearch?.addEventListener("input", renderItems);
  itemsCategory?.addEventListener("change", renderItems);
  itemsStatus?.addEventListener("change", renderItems);

  document.getElementById("btnSeed")?.addEventListener("click", () => {
    const r = DK.seed();
    alert("已載入測試資料：品項 " + r.items + "、流水 " + r.ledger + "、訂單 " + r.orders + "、支出 " + r.expenses);
    renderItems();
    renderLedger();
    renderOrders();
    renderExpenses();
    renderReports();
  });

  // ---------- Ledger ----------
  const ledgerTbody = document.getElementById("ledgerTbody");
  const ledgerForm = document.getElementById("ledgerForm");
  const ledgerMsg = document.getElementById("ledgerMsg");

  function renderLedger() {
    if (!ledgerTbody) return;
    const list = DK.getLedger();
    const items = DK.getItems();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    ledgerTbody.innerHTML = list.slice(0, 100).map((r) => {
      const name = byId[r.item_id] ? (byId[r.item_id].name || byId[r.item_id].sku) : r.item_id;
      return `<tr>
        <td class="nowrap">${esc((r.created_at || "").toString().slice(0, 19))}</td>
        <td>${esc(name)}</td>
        <td>${esc(LEDGER_TYPE_LABEL[r.type] || r.type)}</td>
        <td>${r.qty}</td>
        <td>${fmtNum(r.unit_cost)}</td>
        <td>${esc(REF_TYPE_LABEL[r.ref_type] || r.ref_type)}</td>
        <td>${esc(r.ref_id)}</td>
        <td class="muted">${esc(r.note)}</td>
        <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-del-ledger" data-id="${esc(r.id)}">刪除</button></td>
      </tr>`;
    }).join("");
  }

  // 刪除流水：只允許刪除「該品項最新一筆」，避免庫存/成本不一致
  ledgerTbody?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".btn-del-ledger");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    if (!id) return;

    const ledger = DK.getLedger();
    const row = ledger.find((x) => x.id === id);
    if (!row) return;

    const latestForItem = ledger.find((x) => x.item_id === row.item_id);
    if (!latestForItem || latestForItem.id !== row.id) {
      alert("目前僅支援刪除「該品項最新一筆」流水（避免庫存不一致）。");
      return;
    }
    if (!confirm("確定刪除這筆流水？（會回復此筆對庫存數量/成本的影響）")) return;

    // 回復庫存
    const items = DK.getItems();
    const item = items.find((x) => x.id === row.item_id);
    if (item) {
      const currentQty = Number(item.qty_on_hand) || 0;
      const currentCost = Number(item.cost_unit) || 0;
      const delta = Number(row.qty) || 0; // IN:+, OUT:-, ADJUST:差額

      if (row.type === "IN") {
        const added = Math.abs(delta);
        const prevQty = Math.max(0, currentQty - added);
        const unitCost = Number(row.unit_cost) || 0;
        // 反推平均成本（若 prevQty=0，成本回到 0）
        const prevCost = prevQty > 0 ? (currentQty * currentCost - added * unitCost) / prevQty : 0;
        item.qty_on_hand = prevQty;
        item.cost_unit = Number.isFinite(prevCost) ? prevCost : 0;
      } else if (row.type === "OUT") {
        // OUT 的 qty 是負數；刪除 OUT = 把數量加回去
        item.qty_on_hand = Math.max(0, currentQty - delta);
        // cost_unit 不變
      } else if (row.type === "ADJUST") {
        // ADJUST qty 是差額；刪除 ADJUST = 反向套用差額
        item.qty_on_hand = Math.max(0, currentQty - delta);
        // cost_unit 不變
      } else {
        // 未知類型：不動庫存
      }

      // last_moved_at 回到下一筆（刪除後的新最新）
      const nextLatest = ledger.find((x) => x.item_id === row.item_id && x.id !== row.id);
      item.last_moved_at = nextLatest?.created_at || item.last_moved_at || DK.nowISO();
      item.updated_at = DK.nowISO();
      DK.saveItems(items);
    }

    // 刪除流水
    DK.saveLedger(ledger.filter((x) => x.id !== id));
    renderLedger();
    renderItems();
  });

  document.getElementById("btnNewLedger")?.addEventListener("click", () => {
    const sel = document.getElementById("ledgerItemId");
    sel.innerHTML = DK.getItems().map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("");
    document.getElementById("ledgerType").value = "IN";
    document.getElementById("ledgerQty").value = "1";
    document.getElementById("ledgerUnitCost").value = "";
    document.getElementById("ledgerRefType").value = "PURCHASE";
    document.getElementById("ledgerRefId").value = "";
    document.getElementById("ledgerNote").value = "";
    ledgerForm.hidden = false;
    hide(ledgerMsg);
  });
  document.getElementById("ledgerCancel")?.addEventListener("click", () => { ledgerForm.hidden = true; hide(ledgerMsg); });
  document.getElementById("ledgerSubmit")?.addEventListener("click", () => {
    const itemId = document.getElementById("ledgerItemId").value;
    const type = document.getElementById("ledgerType").value;
    const qty = parseInt(document.getElementById("ledgerQty").value, 10);
    const unitCost = parseFloat(document.getElementById("ledgerUnitCost").value) || 0;
    const refType = document.getElementById("ledgerRefType").value;
    const refId = document.getElementById("ledgerRefId").value;
    const note = document.getElementById("ledgerNote").value;
    if (!itemId) return show(ledgerMsg, "請選擇品項");
    if (!Number.isFinite(qty) || (type === "IN" && qty <= 0) || (type === "OUT" && qty <= 0)) return show(ledgerMsg, "數量需大於 0");
    if (type === "IN" && unitCost < 0) return show(ledgerMsg, "入庫請填單位成本");
    const result = DK.addLedgerEntry({ item_id: itemId, type, qty: type === "ADJUST" ? qty : Math.abs(qty), unit_cost: unitCost, ref_type: refType, ref_id: refId, note });
    if (!result.ok) return show(ledgerMsg, result.error || "失敗");
    show(ledgerMsg, "已寫入流水並更新品項");
    renderLedger();
    renderItems();
    setTimeout(() => { ledgerForm.hidden = true; hide(ledgerMsg); }, 1000);
  });

  // ---------- Orders ----------
  const ordersTbody = document.getElementById("ordersTbody");
  const orderForm = document.getElementById("orderForm");
  const orderMsg = document.getElementById("orderMsg");
  const orderSearchEl = document.getElementById("orderSearch");
  const orderDateRangeEl = document.getElementById("orderDateRange");
  const orderStatusFilterEl = document.getElementById("orderStatusFilter");
  let editingOrderId = null;

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

  function renderOrders() {
    if (!ordersTbody) return;
    const list = getFilteredOrders();
    ordersTbody.innerHTML = list.map((o) => {
      const margin = o.gross_margin != null ? (o.gross_margin * 100).toFixed(1) + "%" : "-";
      return `<tr>
        <td class="nowrap">${esc(o.order_no)}</td>
        <td>${esc(o.customer_name)}</td>
        <td>${fmtNum(o.total_sale)}</td>
        <td>${fmtNum(o.shipping_income)}</td>
        <td>${fmtNum(o.discount)}</td>
        <td>${fmtNum(o.cogs_total)}</td>
        <td>${fmtNum(o.gross_profit)}</td>
        <td>${margin}</td>
        <td>${esc(ORDER_STATUS_LABEL[o.status] || o.status)}</td>
        <td class="nowrap">${esc((o.created_at || "").toString().slice(0, 10))}</td>
        <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-edit-order" data-id="${esc(o.id)}">編輯</button></td>
      </tr>`;
    }).join("");
    ordersTbody.querySelectorAll(".btn-edit-order").forEach((btn) => {
      btn.addEventListener("click", () => openOrderEditor(btn.getAttribute("data-id")));
    });
  }

  orderSearchEl?.addEventListener("input", renderOrders);
  orderSearchEl?.addEventListener("search", renderOrders);
  orderDateRangeEl?.addEventListener("change", renderOrders);
  orderStatusFilterEl?.addEventListener("change", renderOrders);

  function openOrderEditor(id) {
    editingOrderId = id || null;
    const orders = DK.getOrders();
    const o = id ? orders.find((x) => x.id === id) : null;
    document.getElementById("orderNo").value = o ? o.order_no : DK.nextOrderNo();
    document.getElementById("orderNo").readOnly = !!o;
    document.getElementById("orderCustomer").value = o ? o.customer_name ?? "" : "";
    document.getElementById("orderTotalSale").value = o ? o.total_sale ?? 0 : 0;
    document.getElementById("orderShipping").value = o ? o.shipping_income ?? 0 : 0;
    document.getElementById("orderDiscount").value = o ? o.discount ?? 0 : 0;
    document.getElementById("orderCogs").value = o ? o.cogs_total ?? 0 : 0;
    document.getElementById("orderPayment").value = o ? o.payment_method ?? "transfer" : "transfer";
    document.getElementById("orderStatus").value = o ? o.status ?? "pending" : "pending";
    updateOrderGrossDisplay();
    orderForm.hidden = false;
    hide(orderMsg);
  }

  function updateOrderGrossDisplay() {
    const sale = parseFloat(document.getElementById("orderTotalSale").value) || 0;
    const ship = parseFloat(document.getElementById("orderShipping").value) || 0;
    const disc = parseFloat(document.getElementById("orderDiscount").value) || 0;
    const cogs = parseFloat(document.getElementById("orderCogs").value) || 0;
    const profit = sale + ship - disc - cogs;
    const rev = sale + ship - disc;
    const margin = rev > 0 ? ((profit / rev) * 100).toFixed(1) + "%" : "-";
    const el = document.getElementById("orderGrossProfitDisplay");
    if (el) el.textContent = "毛利 " + fmtNum(profit) + " / 毛利率 " + margin;
  }
  ["orderTotalSale", "orderShipping", "orderDiscount", "orderCogs"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateOrderGrossDisplay);
  });

  document.getElementById("btnNewOrder")?.addEventListener("click", () => openOrderEditor(null));
  document.getElementById("orderCancel")?.addEventListener("click", () => { orderForm.hidden = true; editingOrderId = null; hide(orderMsg); });
  document.getElementById("orderSave")?.addEventListener("click", () => {
    const orderNo = String(document.getElementById("orderNo").value || "").trim();
    const totalSale = parseFloat(document.getElementById("orderTotalSale").value) || 0;
    const cogsTotal = parseFloat(document.getElementById("orderCogs").value) || 0;
    if (!orderNo) return show(orderMsg, "訂單編號必填");
    const orders = DK.getOrders();
    const existing = orders.find((x) => x.order_no === orderNo && x.id !== editingOrderId);
    if (existing) return show(orderMsg, "訂單編號重複");
    const payload = {
      order_no: orderNo,
      customer_name: document.getElementById("orderCustomer").value || "",
      total_sale: totalSale,
      shipping_income: parseFloat(document.getElementById("orderShipping").value) || 0,
      discount: parseFloat(document.getElementById("orderDiscount").value) || 0,
      payment_method: document.getElementById("orderPayment").value || "transfer",
      status: document.getElementById("orderStatus").value || "pending",
      cogs_total: cogsTotal,
      created_at: nowISO(),
    };
    if (editingOrderId) {
      const idx = orders.findIndex((x) => x.id === editingOrderId);
      if (idx < 0) return show(orderMsg, "找不到訂單");
      orders[idx] = { ...orders[idx], ...payload, updated_at: nowISO() };
      DK.saveOrders(orders);
      show(orderMsg, "已更新");
    } else {
      payload.id = "ord-" + Date.now();
      orders.unshift(payload);
      DK.saveOrders(orders);
      show(orderMsg, "已新增");
    }
    renderOrders();
    renderReports();
    setTimeout(() => { orderForm.hidden = true; editingOrderId = null; hide(orderMsg); }, 800);
  });

  // ---------- Expenses ----------
  const expensesTbody = document.getElementById("expensesTbody");
  const expenseForm = document.getElementById("expenseForm");
  const expenseMsg = document.getElementById("expenseMsg");

  function renderExpenses() {
    if (!expensesTbody) return;
    const list = DK.getExpenses();
    expensesTbody.innerHTML = list.slice(0, 100).map((e) => `
      <tr>
        <td>${esc(e.date)}</td>
        <td>${esc(EXPENSE_TYPE_LABEL[e.type] || e.type)}</td>
        <td>${esc(e.category)}</td>
        <td>${fmtNum(e.amount)}</td>
        <td class="muted">${esc(e.note)}</td>
        <td style="text-align:right"><button type="button" class="btn btn-ghost btn-sm btn-del-expense" data-id="${esc(e.id)}">刪除</button></td>
      </tr>`).join("");
    expensesTbody.querySelectorAll(".btn-del-expense").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!confirm("確定刪除？")) return;
        const id = btn.getAttribute("data-id");
        const rows = DK.getExpenses().filter((x) => x.id !== id);
        DK.saveExpenses(rows);
        renderExpenses();
        renderReports();
      });
    });
  }

  document.getElementById("btnNewExpense")?.addEventListener("click", () => {
    document.getElementById("expenseDate").value = todayStr();
    document.getElementById("expenseType").value = "OPEX";
    document.getElementById("expenseCategory").value = "";
    document.getElementById("expenseAmount").value = "";
    document.getElementById("expenseNote").value = "";
    expenseForm.hidden = false;
    hide(expenseMsg);
  });
  document.getElementById("expenseCancel")?.addEventListener("click", () => { expenseForm.hidden = true; hide(expenseMsg); });
  document.getElementById("expenseSave")?.addEventListener("click", () => {
    const date = document.getElementById("expenseDate").value;
    const amount = parseFloat(document.getElementById("expenseAmount").value);
    if (!date) return show(expenseMsg, "請選日期");
    if (!Number.isFinite(amount) || amount < 0) return show(expenseMsg, "請填金額");
    const rows = DK.getExpenses();
    rows.unshift({
      id: "ex-" + Date.now(),
      date,
      type: document.getElementById("expenseType").value,
      category: document.getElementById("expenseCategory").value || "",
      amount,
      note: document.getElementById("expenseNote").value || "",
      ref_item_id: "",
      created_at: nowISO(),
    });
    DK.saveExpenses(rows);
    show(expenseMsg, "已新增");
    renderExpenses();
    renderReports();
    setTimeout(() => { expenseForm.hidden = true; hide(expenseMsg); }, 800);
  });

  // ---------- Reports ----------
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
    if (reportMonthYearEl) {
      reportMonthYearEl.innerHTML = years.map((y) => `<option value="${y}"${y === currentYear ? " selected" : ""}>${y} 年</option>`).join("");
    }
    if (reportYearYearEl) {
      reportYearYearEl.innerHTML = years.map((y) => `<option value="${y}"${y === currentYear ? " selected" : ""}>${y} 年</option>`).join("");
    }
    const currentMonth = new Date().getMonth() + 1;
    if (reportMonthMonthEl) {
      reportMonthMonthEl.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
        .map((m) => `<option value="${m}"${m === currentMonth ? " selected" : ""}>${m} 月</option>`).join("");
    }
  }

  function getReportQueryParams() {
    const period = document.querySelector(".report-period-btn.active")?.getAttribute("data-period") || "week";
    const now = new Date();
    let fromStr, toStr, label;
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
      fromStr = `${y}-${String(m).padStart(2, "0")}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      toStr = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      return { fromStr, toStr, label: `${y}年${m}月` };
    }
    if (period === "customYear" && reportYearYearEl) {
      const y = parseInt(reportYearYearEl.value, 10);
      fromStr = `${y}-01-01`;
      toStr = `${y}-12-31`;
      return { fromStr, toStr, label: `${y}年` };
    }
    const w = DK.reportWeeklySummary();
    return { fromStr: w.weekFrom, toStr: w.weekTo, label: "本週" };
  }

  function renderReports() {
    const params = getReportQueryParams();
    const summary = DK.reportSummaryByDateRange(params.fromStr, params.toStr);
    const elResult = document.getElementById("reportQueryResult");
    if (elResult) {
      elResult.innerHTML = `
        <div><strong>${params.label} ${summary.fromStr} ~ ${summary.toStr}</strong></div>
        <div>訂單毛利合計：NT$ ${fmtNum(summary.ordersProfit)}（${summary.ordersCount} 筆）</div>
        <div>支出合計：NT$ ${fmtNum(summary.expensesTotal)}（${summary.expensesCount} 筆）</div>
        <div>庫存總成本：NT$ ${fmtNum(summary.inventoryValue)}</div>
      `;
    }

    const top20 = DK.reportTop20IdleDays();
    const elTop20 = document.getElementById("reportTop20");
    if (elTop20) {
      elTop20.innerHTML = top20.length ? `<table class="table"><thead><tr><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${
        top20.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td>${x.idle_days}</td><td>${fmtNum(x.inventory_value)}</td></tr>`).join("")
      }</tbody></table>` : "<p class=\"muted\">無資料</p>";
    }

    const testingPrep = DK.reportTestingPrep();
    const elTesting = document.getElementById("reportTestingPrep");
    if (elTesting) {
      elTesting.innerHTML = testingPrep.length ? `<table class="table"><thead><tr><th>名稱</th><th>狀態</th><th>數量</th></tr></thead><tbody>${
        testingPrep.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(ITEM_STATUS_LABEL[x.status] || x.status)}</td><td>${x.qty_on_hand}</td></tr>`).join("")
      }</tbody></table>` : "<p class=\"muted\">無</p>";
    }

    const clearance = DK.reportClearance();
    const elClear = document.getElementById("reportClearance");
    if (elClear) {
      elClear.innerHTML = clearance.length ? `<table class="table"><thead><tr><th>名稱</th><th>品類</th><th>滯留天</th><th>庫存價值</th></tr></thead><tbody>${
        clearance.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td>${x.idle_days}</td><td>${fmtNum(x.inventory_value)}</td></tr>`).join("")
      }</tbody></table>` : "<p class=\"muted\">無</p>";
    }
  }

  reportPeriodBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      reportPeriodBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      reportCustomMonth.style.display = (btn.getAttribute("data-period") === "customMonth") ? "flex" : "none";
      reportCustomYear.style.display = (btn.getAttribute("data-period") === "customYear") ? "flex" : "none";
      renderReports();
    });
  });
  reportMonthYearEl?.addEventListener("change", renderReports);
  reportMonthMonthEl?.addEventListener("change", renderReports);
  reportYearYearEl?.addEventListener("change", renderReports);

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
      csv += [o.order_no, o.customer_name, o.total_sale ?? "", o.shipping_income ?? "", o.discount ?? "", o.cogs_total ?? "", o.gross_profit ?? "", margin, o.status ?? "", (o.created_at || "").toString().slice(0, 10)].map(csvCell).join(",") + "\n";
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "報表_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  document.getElementById("btnExportReport")?.addEventListener("click", exportReportCSV);

  // Init
  fillCategoryOptions();
  fillReportPeriodOptions();
  renderItems();
})();
