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

  function saveItems(items) {
    save(KEYS.items, items);
    if (typeof global.__syncV2ToSupabase === "function") global.__syncV2ToSupabase();
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
    if (typeof global.__syncV2ToSupabase === "function") global.__syncV2ToSupabase();
  }

  function addLedgerEntry(entry) {
    const { item_id, type, qty, unit_cost, ref_type, ref_id, note } = entry;
    const items = getItems();
    const item = items.find((x) => String(x.id) === String(item_id));
    if (!item) return { ok: false, error: "找不到品項" };

    const now = nowISO();
    const dateStr = now.slice(0, 10);
    const numQty = Number(qty) || 0;
    const currentQty = Number(item.qty_on_hand) || 0;

    let newQty = currentQty;
    if (type === "IN") newQty = currentQty + Math.abs(numQty);
    else if (type === "OUT") newQty = Math.max(0, currentQty - Math.abs(numQty));
    else if (type === "ADJUST") newQty = Math.max(0, numQty);

    const cost = type === "IN" ? (Number(unit_cost) || Number(item.cost_unit) || 0) : (Number(item.cost_unit) || 0);
    const newCostUnit = type === "IN" && numQty > 0 && cost > 0
      ? (currentQty * Number(item.cost_unit || 0) + numQty * cost) / (currentQty + numQty)
      : Number(item.cost_unit) || 0;

    const row = {
      id: "L-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9),
      item_id,
      type,
      qty: type === "OUT" ? -Math.abs(numQty) : type === "ADJUST" ? numQty - currentQty : Math.abs(numQty),
      unit_cost: cost,
      ref_type: ref_type || (type === "ADJUST" ? "ADJUST" : "PURCHASE"),
      ref_id: ref_id || "",
      created_at: now,
      note: note || "",
    };

    const ledger = getLedger();
    ledger.unshift(row);
    saveLedger(ledger);

    item.qty_on_hand = newQty;
    item.cost_unit = newCostUnit;
    item.last_moved_at = now;
    if (type === "IN" && !item.inbound_date) item.inbound_date = dateStr;
    item.updated_at = now;
    saveItems(items);

    return { ok: true, row };
  }

  // ---------- Orders ----------
  function getOrders() {
    return load(KEYS.orders);
  }

  function saveOrders(orders) {
    save(KEYS.orders, orders);
    if (typeof global.__syncV2ToSupabase === "function") global.__syncV2ToSupabase();
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
    save(KEYS.expenses, rows);
    if (typeof global.__syncV2ToSupabase === "function") global.__syncV2ToSupabase();
  }

  // ---------- Reports ----------
  function reportTop20IdleDays() {
    return getEnrichedItems()
      .filter((x) => x.idle_days != null)
      .sort((a, b) => (b.idle_days ?? 0) - (a.idle_days ?? 0))
      .slice(0, 20);
  }

  function reportTestingPrep() {
    return getEnrichedItems().filter((x) => x.status === "TESTING" || x.status === "PREP");
  }

  function reportClearance() {
    return getEnrichedItems().filter((x) => {
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
    getItemAlert,
    suggestStatus,
    getLedger,
    saveLedger,
    addLedgerEntry,
    getOrders,
    saveOrders,
    enrichOrder,
    orderGrossProfit,
    orderGrossMargin,
    nextOrderNo,
    getExpenses,
    saveExpenses,
    reportTop20IdleDays,
    reportTestingPrep,
    reportClearance,
    reportWeeklySummary,
    todayStr,
    nowISO,
    seed,
  });
  global.DK = DK;
})(typeof window !== "undefined" ? window : this);
