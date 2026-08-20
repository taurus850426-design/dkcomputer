/**
 * 庫存＋記帳 - 資料層與規則引擎
 * Items / Ledger / Orders / Expenses，自動計算欄位，放太久提醒
 */
(function (global) {
  const KEYS = {
    items: "dk_v2_items",
    ledger: "dk_v2_ledger",
    orders: "dk_v2_orders",
    expenses: "dk_v2_expenses",
  };

  const ITEM_CONDITIONS = ["NEW", "USED", "REFURB"];
  const ITEM_STATUSES = ["READY", "TESTING", "PREP", "RESERVED", "CLEARANCE", "SCRAP"];
  const LEDGER_TYPES = ["IN", "OUT", "ADJUST"];
  const REF_TYPES = ["PURCHASE", "ORDER", "RMA", "SCRAP", "MOVE", "ADJUST"];
  const ORDER_STATUSES = ["pending", "paid", "shipped", "completed", "refunded"];
  const ORDER_SALES_TYPES = ["整機", "零組件", "維修／服務", "周邊", "其他"];
  const EXPENSE_TYPES = ["COGS", "OPEX", "OTHER"];

  const RULES = {
    PC_GPU_CLEARANCE_DAYS: 30,
    PC_GPU_FORCE_CLEAR_DAYS: 60,
    PART_ALERT_DAYS: 45,
  };

  function safeParse(v, fallback) {
    try {
      if (v == null || v === "") return fallback;
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function load(key) {
    return safeParse(localStorage.getItem(key), []);
  }

  function save(key, data) {
    localStorage.setItem(key, JSON.stringify(Array.isArray(data) ? data : []));
    try {
      if (typeof global.__dkBumpV2LocalWriteGen === "function") global.__dkBumpV2LocalWriteGen();
    } catch (_) {}
  }

  function rpcError(res) {
    if (!res) return "寫入失敗";
    if (res.ok) return "";
    return res.error || (res.data && res.data.message) || "寫入失敗";
  }

  function rpcData(res) {
    const d = res && res.data;
    if (d && typeof d === "object" && !Array.isArray(d)) return d;
    if (Array.isArray(d) && d[0] && typeof d[0] === "object") return d[0];
    return d;
  }

  async function refreshFromCloud() {
    if (typeof global.fetchV2DataFromSupabase === "function") {
      await global.fetchV2DataFromSupabase();
    }
  }

  function saveItems(items) {
    const prev = load(KEYS.items);
    save(KEYS.items, items);
    if (global._suppressV2Sync) return Promise.resolve({ ok: true, skipped: true });
    return persistItemsSnapshot(items, prev);
  }

  async function persistItemsSnapshot(items, prevItems) {
    const next = Array.isArray(items) ? items : [];
    const prev = Array.isArray(prevItems) ? prevItems : [];
    const prevIds = new Set(prev.map((x) => String(x.id)));
    const nextIds = new Set(next.map((x) => String(x.id)));
    if (typeof global.stage7DeleteItem === "function") {
      for (const old of prev) {
        if (!nextIds.has(String(old.id))) {
          const del = await global.stage7DeleteItem(old.id);
          if (!del.ok) return del;
        }
      }
    }
    if (typeof global.stage7UpsertItem !== "function") {
      return { ok: false, error: "Stage 7 寫入未載入" };
    }
    function stamp(it) {
      return JSON.stringify({
        sku: it.sku, category: it.category, sub_type: it.sub_type, brand: it.brand, model: it.model,
        name: it.name, spec: it.spec, vendor: it.vendor, condition: it.condition, status: it.status,
        price_list: it.price_list, price_floor: it.price_floor, inbound_date: it.inbound_date,
        reorder_point: it.reorder_point, location: it.location, notes: it.notes,
        cost_unit: it.cost_unit, qty_on_hand: it.qty_on_hand,
      });
    }
    const prevMap = Object.fromEntries(prev.map((x) => [String(x.id), x]));
    for (const item of next) {
      const wasNew = !prevIds.has(String(item.id));
      const prevItem = prevMap[String(item.id)];
      if (!wasNew && stamp(item) === stamp(prevItem)) continue;
      const up = await global.stage7UpsertItem(item);
      if (!up.ok) return up;
      const data = rpcData(up);
      if (data && data.id && !item.id) item.id = data.id;
      const prevQty = wasNew ? 0 : Number(prevItem && prevItem.qty_on_hand) || 0;
      const nextQty = Number(item.qty_on_hand);
      const targetQty = Number.isFinite(nextQty) ? Math.max(0, nextQty) : 0;
      if (targetQty !== prevQty && typeof global.stage7RpcAdjustStock === "function") {
        const adj = await global.stage7RpcAdjustStock({
          item_id: item.id,
          type: "ADJUST",
          qty: targetQty,
          unit_cost: item.cost_unit,
          note: wasNew ? "新增品項數量" : "品項數量調整",
        });
        if (!adj.ok) return adj;
      }
    }
    await refreshFromCloud();
    return { ok: true };
  }

  function todayStr() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function parseDateStr(s) {
    if (!s || typeof s !== "string") return null;
    const d = new Date(s.slice(0, 10) + "T00:00:00");
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function daysBetween(fromStr, toStr) {
    const to = toStr ? parseDateStr(toStr) : new Date();
    const from = parseDateStr(fromStr);
    if (!from || !to) return null;
    const ms = to.getTime() - from.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  // ---------- Items ----------
  function getItems() {
    return load(KEYS.items);
  }

  function findItemBySku(sku) {
    return getItems().find((x) => String(x.sku || "").toUpperCase() === String(sku || "").toUpperCase());
  }

  function findItemById(id) {
    return getItems().find((x) => String(x.id) === String(id));
  }

  function itemAgeDays(item) {
    return daysBetween(item.inbound_date, todayStr());
  }

  function itemIdleDays(item) {
    const moved = item.last_moved_at;
    const d = typeof moved === "string" ? moved.slice(0, 10) : null;
    return daysBetween(d || item.inbound_date, todayStr());
  }

  function itemInventoryValue(item) {
    const q = Number(item.qty_on_hand) || 0;
    const c = Number(item.cost_unit) || 0;
    return q * c;
  }

  /** 可售庫存：qty_on_hand 必須是有效數字且 > 0（0／負數／無效都不算） */
  function isSellableOnHand(item) {
    const qty = Number(item?.qty_on_hand);
    return Number.isFinite(qty) && qty > 0;
  }

  function isItemArchived(item) {
    if (!item) return false;
    if (item.isArchived === true) return true;
    if (item.isArchived === false) return false;
    return Boolean(item.archivedAt);
  }

  /** 目前仍有庫存：未封存且 qty_on_hand > 0（報表「目前庫存型」清單用） */
  function isCurrentOnHandItem(item) {
    if (isItemArchived(item)) return false;
    return isSellableOnHand(item);
  }

  /**
   * qty 從 >0 變成 0（或無效／負數）時自動封存；qty 回到 >0 時自動解除封存。
   * 寫入品項 JSON 欄位 isArchived / archivedAt，不改 Supabase schema。
   */
  function applyQtyArchiveState(item, prevQty, newQty) {
    if (!item) return item;
    const prev = Number(prevQty);
    const next = Number(newQty);
    const prevPositive = Number.isFinite(prev) && prev > 0;
    const nextPositive = Number.isFinite(next) && next > 0;
    if (prevPositive && !nextPositive) {
      item.isArchived = true;
      item.archivedAt = nowISO();
    } else if (nextPositive) {
      item.isArchived = false;
      item.archivedAt = null;
    }
    return item;
  }

  function enrichItem(item) {
    const age = itemAgeDays(item);
    const idle = itemIdleDays(item);
    const value = itemInventoryValue(item);
    return {
      ...item,
      age_days: age,
      idle_days: idle,
      inventory_value: value,
    };
  }

  function getEnrichedItems() {
    return getItems().map(enrichItem);
  }

  // 規則引擎：放太久提醒 / 自動標記（品類由後台設定，這裡只依 耗材/其他 與滯留天數判斷）
  function getItemAlert(item) {
    const cat = String(item.category || "");
    const idle = itemIdleDays(item);
    const qty = Number(item.qty_on_hand) || 0;
    const reorder = Number(item.reorder_point) || 0;

    if (cat === "耗材") {
      if (reorder > 0 && qty < reorder) return { type: "REORDER", message: "低於警戒，需補貨" };
      return null;
    }

    if (idle != null && idle >= RULES.PC_GPU_FORCE_CLEAR_DAYS) return { type: "FORCE_CLEAR", message: "強制出清" };
    if (idle != null && idle > RULES.PC_GPU_CLEARANCE_DAYS) return { type: "CLEARANCE", message: "待出清" };
    if (idle != null && idle > RULES.PART_ALERT_DAYS) return { type: "PART_OLD", message: "建議組成品或降價" };
    return null;
  }

  function suggestStatus(item) {
    const alert = getItemAlert(item);
    if (alert?.type === "FORCE_CLEAR" || alert?.type === "CLEARANCE") return "CLEARANCE";
    return item.status;
  }

  // ---------- Ledger ----------
  function getLedger() {
    return load(KEYS.ledger);
  }

  function saveLedger(rows) {
    save(KEYS.ledger, rows);
  }

  async function addLedgerEntry(entry) {
    const { item_id, type, qty, unit_cost, note, inbound_date } = entry || {};
    const item = findItemById(item_id);
    if (!item) return { ok: false, error: "找不到品項" };
    if (typeof global.stage7RpcAdjustStock !== "function") {
      return { ok: false, error: "Stage 7 寫入未載入" };
    }
    const res = await global.stage7RpcAdjustStock({
      item_id,
      type,
      qty,
      unit_cost,
      note,
      inbound_date,
    });
    if (!res.ok) return { ok: false, error: rpcError(res) };
    await refreshFromCloud();
    const data = rpcData(res);
    return { ok: true, row: data, syncPromise: Promise.resolve({ ok: true }) };
  }

  // ---------- Orders ----------
  function getOrders() {
    return load(KEYS.orders);
  }

  function saveOrders(orders) {
    const prev = load(KEYS.orders);
    save(KEYS.orders, orders);
    if (global._suppressV2Sync) return Promise.resolve({ ok: true, skipped: true });
    return persistOrdersSnapshot(orders, prev);
  }

  async function persistOrdersSnapshot(orders, prevOrders) {
    const next = Array.isArray(orders) ? orders : [];
    const prev = Array.isArray(prevOrders) ? prevOrders : [];
    const prevMap = Object.fromEntries(prev.map((x) => [String(x.id), x]));
    for (const o of next) {
      const old = prevMap[String(o.id)];
      if (old && JSON.stringify(old) === JSON.stringify(o)) continue;
      const fn = old ? global.stage7UpdateOrder : global.stage7CreateOrder;
      if (typeof fn !== "function") return { ok: false, error: "Stage 7 寫入未載入" };
      const res = await fn(o);
      if (!res.ok) return res;
    }
    await refreshFromCloud();
    return { ok: true };
  }

  function orderGrossProfit(o) {
    const sale = Number(o.total_sale) || 0;
    const ship = Number(o.shipping_income) || 0;
    const disc = Number(o.discount) || 0;
    const cogs = Number(o.cogs_total) || 0;
    return sale + ship - disc - cogs;
  }

  function orderGrossMargin(o) {
    const sale = Number(o.total_sale) || 0;
    const ship = Number(o.shipping_income) || 0;
    const disc = Number(o.discount) || 0;
    const rev = sale + ship - disc;
    if (rev <= 0) return null;
    return orderGrossProfit(o) / rev;
  }

  /** 營業額：與毛利率分母相同（售價＋運費−折扣），不另開公式 */
  function orderRevenue(o) {
    const sale = Number(o.total_sale) || 0;
    const ship = Number(o.shipping_income) || 0;
    const disc = Number(o.discount) || 0;
    return sale + ship - disc;
  }

  function normalizeOrderSalesType(o) {
    const v = String(o && (o.salesType != null ? o.salesType : o.sales_type) || "").trim();
    if (ORDER_SALES_TYPES.indexOf(v) >= 0) return v;
    return "";
  }

  function orderSalesTypeLabel(o) {
    return normalizeOrderSalesType(o) || "未分類";
  }

  function reportSalesTypeStats(fromStr, toStr) {
    const orders = getOrders().filter((o) => {
      const d = (o.created_at || o.date || "").toString().slice(0, 10);
      return d >= fromStr && d <= toStr && o.status !== "refunded";
    });
    const keys = ORDER_SALES_TYPES.concat(["未分類"]);
    const buckets = {};
    keys.forEach((k) => {
      buckets[k] = { salesType: k, count: 0, revenue: 0, profit: 0, avg: 0 };
    });
    orders.forEach((o) => {
      const key = orderSalesTypeLabel(o);
      const b = buckets[key] || buckets["未分類"];
      b.count += 1;
      b.revenue += orderRevenue(o);
      b.profit += orderGrossProfit(o);
    });
    keys.forEach((k) => {
      const b = buckets[k];
      b.avg = b.count > 0 ? b.revenue / b.count : 0;
    });
    return {
      rows: keys.map((k) => buckets[k]),
      pcCount: buckets["整機"].count,
      partsCount: buckets["零組件"].count,
      serviceCount: buckets["維修／服務"].count,
    };
  }

  function enrichOrder(o) {
    return {
      ...o,
      gross_profit: orderGrossProfit(o),
      gross_margin: orderGrossMargin(o),
    };
  }

  function nextOrderNo() {
    const orders = getOrders();
    const today = todayStr().replace(/-/g, "");
    const sameDay = orders.filter((o) => String(o.order_no || "").includes(today));
    const n = sameDay.length + 1;
    return "ORD-" + today + "-" + String(n).padStart(3, "0");
  }

  // ---------- Expenses ----------
  function getExpenses() {
    return load(KEYS.expenses);
  }

  function saveExpenses(rows) {
    const prev = load(KEYS.expenses);
    save(KEYS.expenses, rows);
    if (global._suppressV2Sync) return Promise.resolve({ ok: true, skipped: true });
    return persistExpensesSnapshot(rows, prev);
  }

  async function persistExpensesSnapshot(rows, prevRows) {
    if (typeof global.stage7SaveExpense !== "function") {
      return { ok: false, error: "Stage 7 寫入未載入" };
    }
    const next = Array.isArray(rows) ? rows : [];
    const prev = Array.isArray(prevRows) ? prevRows : [];
    const nextIds = new Set(next.map((x) => String(x.id)));
    for (const old of prev) {
      if (!nextIds.has(String(old.id)) && typeof global.stage7DeleteExpense === "function") {
        const del = await global.stage7DeleteExpense(old.id);
        if (!del.ok) return del;
      }
    }
    for (const row of next) {
      const res = await global.stage7SaveExpense(row);
      if (!res.ok) return res;
    }
    await refreshFromCloud();
    return { ok: true };
  }


  // ---------- Reports ----------
  function reportTop20IdleDays() {
    return getEnrichedItems()
      .filter(isCurrentOnHandItem)
      .filter((x) => x.idle_days != null)
      .sort((a, b) => (b.idle_days ?? 0) - (a.idle_days ?? 0))
      .slice(0, 20);
  }

  function reportTestingPrep() {
    return getEnrichedItems().filter((x) => isCurrentOnHandItem(x) && (x.status === "TESTING" || x.status === "PREP"));
  }

  function reportClearance() {
    return getEnrichedItems().filter((x) => {
      if (!isCurrentOnHandItem(x)) return false;
      if (x.status === "CLEARANCE") return true;
      if ((x.category === "PC" || x.category === "GPU") && (x.idle_days ?? 0) > RULES.PC_GPU_CLEARANCE_DAYS) return true;
      return false;
    });
  }

  function reportWeeklySummary() {
    const now = new Date();
    const day = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    const fromStr = start.toISOString().slice(0, 10);
    const toStr = end.toISOString().slice(0, 10);

    const orders = getOrders().filter((o) => {
      const d = (o.created_at || o.date || "").toString().slice(0, 10);
      return d >= fromStr && d <= toStr && o.status !== "refunded";
    });
    const ordersProfit = orders.reduce((s, o) => s + orderGrossProfit(o), 0);

    const expenses = getExpenses().filter((e) => e.date >= fromStr && e.date <= toStr);
    const expensesTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const items = getItems();
    const inventoryValue = items.reduce((s, i) => s + itemInventoryValue(i), 0);

    return {
      weekFrom: fromStr,
      weekTo: toStr,
      ordersProfit,
      expensesTotal,
      inventoryValue,
      ordersCount: orders.length,
      expensesCount: expenses.length,
    };
  }

  function reportMonthlySummary() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const start = new Date(y, m, 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(y, m + 1, 0);
    end.setHours(23, 59, 59, 999);
    const fromStr = start.toISOString().slice(0, 10);
    const toStr = end.toISOString().slice(0, 10);

    const orders = getOrders().filter((o) => {
      const d = (o.created_at || o.date || "").toString().slice(0, 10);
      return d >= fromStr && d <= toStr && o.status !== "refunded";
    });
    const ordersProfit = orders.reduce((s, o) => s + orderGrossProfit(o), 0);

    const expenses = getExpenses().filter((e) => e.date >= fromStr && e.date <= toStr);
    const expensesTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const items = getItems();
    const inventoryValue = items.reduce((s, i) => s + itemInventoryValue(i), 0);

    return {
      monthFrom: fromStr,
      monthTo: toStr,
      ordersProfit,
      expensesTotal,
      inventoryValue,
      ordersCount: orders.length,
      expensesCount: expenses.length,
    };
  }

  /** 指定日期區間查詢報表（fromStr/toStr 格式 YYYY-MM-DD） */
  function reportSummaryByDateRange(fromStr, toStr) {
    const orders = getOrders().filter((o) => {
      const d = (o.created_at || o.date || "").toString().slice(0, 10);
      return d >= fromStr && d <= toStr && o.status !== "refunded";
    });
    const ordersProfit = orders.reduce((s, o) => s + orderGrossProfit(o), 0);
    const expenses = getExpenses().filter((e) => e.date >= fromStr && e.date <= toStr);
    const expensesTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const items = getItems();
    const inventoryValue = items.reduce((s, i) => s + itemInventoryValue(i), 0);
    return {
      fromStr,
      toStr,
      ordersProfit,
      expensesTotal,
      inventoryValue,
      ordersCount: orders.length,
      expensesCount: expenses.length,
    };
  }

  /** 取得指定日期區間內的訂單（供匯出用） */
  function getOrdersInDateRange(fromStr, toStr) {
    return getOrders().filter((o) => {
      const d = (o.created_at || o.date || "").toString().slice(0, 10);
      return d >= fromStr && d <= toStr;
    });
  }

  // ---------- Seed ----------
  function seed() {
    const id = () => "i-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const t = todayStr();
    const past = (d) => {
      const x = new Date();
      x.setDate(x.getDate() - d);
      return x.toISOString().slice(0, 10);
    };

    const items = [
      { id: id(), sku: "PC-001", category: "處理器", name: "文書整新機", spec: "i5-8400/8G/256G", condition: "REFURB", status: "READY", qty_on_hand: 2, cost_unit: 4500, price_list: 6990, price_floor: 5500, inbound_date: past(45), last_moved_at: past(5) + "T10:00:00Z", reorder_point: 0, location: "A櫃", notes: "", created_at: nowISO(), updated_at: nowISO() },
      { id: id(), sku: "PC-002", category: "處理器", name: "遊戲主機", spec: "i5-12400/16G/512G/3060", condition: "REFURB", status: "TESTING", qty_on_hand: 1, cost_unit: 12000, price_list: 18900, price_floor: 15000, inbound_date: past(15), last_moved_at: past(15) + "T10:00:00Z", reorder_point: 0, location: "A櫃", notes: "", created_at: nowISO(), updated_at: nowISO() },
      { id: id(), sku: "GPU-3060TI", category: "顯示卡", name: "RTX 3060 Ti 8G", spec: "3060Ti 8G", condition: "USED", status: "READY", qty_on_hand: 3, cost_unit: 5500, price_list: 7500, price_floor: 6500, inbound_date: past(35), last_moved_at: past(35) + "T10:00:00Z", reorder_point: 0, location: "顯卡區", notes: "", created_at: nowISO(), updated_at: nowISO() },
      { id: id(), sku: "GPU-3070", category: "顯示卡", name: "RTX 3070 8G", spec: "3070 8G", condition: "USED", status: "CLEARANCE", qty_on_hand: 1, cost_unit: 8000, price_list: 9500, price_floor: 8500, inbound_date: past(50), last_moved_at: past(50) + "T10:00:00Z", reorder_point: 0, location: "顯卡區", notes: "", created_at: nowISO(), updated_at: nowISO() },
      { id: id(), sku: "RAM-DDR4-8", category: "記憶體", name: "DDR4 8G", spec: "DDR4 2666 8G", condition: "USED", status: "READY", qty_on_hand: 10, cost_unit: 350, price_list: 499, price_floor: 400, inbound_date: past(20), last_moved_at: past(3) + "T10:00:00Z", reorder_point: 0, location: "零件區", notes: "", created_at: nowISO(), updated_at: nowISO() },
      { id: id(), sku: "SSD-512", category: "硬碟", name: "SSD 512G SATA", spec: "512G SATA", condition: "NEW", status: "READY", qty_on_hand: 2, cost_unit: 650, price_list: 899, price_floor: 750, inbound_date: past(10), last_moved_at: past(10) + "T10:00:00Z", reorder_point: 3, location: "耗材區", notes: "", created_at: nowISO(), updated_at: nowISO() },
    ];
    const prevSuppress = global._suppressV2Sync;
    global._suppressV2Sync = true;
    saveItems(items);

    const ledger = [
      { id: "L-seed-1", item_id: items[0].id, type: "IN", qty: 2, unit_cost: 4500, ref_type: "PURCHASE", ref_id: "", created_at: nowISO(), note: "進貨" },
      { id: "L-seed-2", item_id: items[4].id, type: "IN", qty: 10, unit_cost: 350, ref_type: "PURCHASE", ref_id: "", created_at: nowISO(), note: "進貨" },
    ];
    saveLedger(ledger);

    const orders = [
      { id: "ord-seed-1", order_no: "ORD-" + todayStr().replace(/-/g, "") + "-001", customer_name: "測試客", total_sale: 7500, shipping_income: 100, discount: 0, payment_method: "transfer", status: "completed", cogs_total: 5500, created_at: nowISO(), shipped_at: nowISO() },
    ];
    saveOrders(orders);

    const expenses = [
      { id: "ex-seed-1", date: todayStr(), type: "OPEX", category: "包材", amount: 200, note: "紙箱", ref_item_id: "", created_at: nowISO() },
      { id: "ex-seed-2", date: past(2), type: "COGS", category: "進貨", amount: 5000, note: "顯卡進貨", ref_item_id: "", created_at: nowISO() },
    ];
    saveExpenses(expenses);
    global._suppressV2Sync = prevSuppress;

    return { items: items.length, ledger: ledger.length, orders: orders.length, expenses: expenses.length };
  }

  // Export
  const DK = global.DK || {};
  if (global.fetchV2DataFromSupabase) DK.fetchV2DataFromSupabase = global.fetchV2DataFromSupabase;
  if (global.saveV2DataToSupabase) DK.saveV2DataToSupabase = global.saveV2DataToSupabase;
  Object.assign(DK, {
    KEYS,
    ITEM_CONDITIONS,
    ITEM_STATUSES,
    LEDGER_TYPES,
    REF_TYPES,
    ORDER_STATUSES,
    ORDER_SALES_TYPES,
    EXPENSE_TYPES,
    RULES,
    getItems,
    saveItems,
    findItemBySku,
    findItemById,
    getEnrichedItems,
    enrichItem,
    itemAgeDays,
    itemIdleDays,
    itemInventoryValue,
    isSellableOnHand,
    isItemArchived,
    isCurrentOnHandItem,
    applyQtyArchiveState,
    getItemAlert,
    suggestStatus,
    getLedger,
    saveLedger,
    addLedgerEntry,
    createOrder: function (payload) {
      if (typeof global.stage7CreateOrder !== "function") return Promise.resolve({ ok: false, error: "Stage 7 寫入未載入" });
      return global.stage7CreateOrder(payload).then(async function (res) {
        if (res && res.ok) await refreshFromCloud();
        return res;
      });
    },
    updateOrder: function (payload) {
      if (typeof global.stage7UpdateOrder !== "function") return Promise.resolve({ ok: false, error: "Stage 7 寫入未載入" });
      return global.stage7UpdateOrder(payload).then(async function (res) {
        if (res && res.ok) await refreshFromCloud();
        return res;
      });
    },
    getOrders,
    saveOrders,
    enrichOrder,
    orderGrossProfit,
    orderGrossMargin,
    orderRevenue,
    normalizeOrderSalesType,
    orderSalesTypeLabel,
    reportSalesTypeStats,
    nextOrderNo,
    getExpenses,
    saveExpenses,
    reportTop20IdleDays,
    reportTestingPrep,
    reportClearance,
    reportWeeklySummary,
    reportMonthlySummary,
    reportSummaryByDateRange,
    getOrdersInDateRange,
    todayStr,
    nowISO,
    seed,
  });
  global.DK = DK;
})(typeof window !== "undefined" ? window : this);
