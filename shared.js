/* shared.js - 單頁靜態站：設定/資料存取/共用工具 */

const STORAGE_KEYS = {
  config: "dk_site_config_v1",
  inventory: "dk_inventory_v1",
  inventoryBackup: "dk_inventory_backup_v1",
  adminAuthed: "dk_admin_authed_v1",
  computers: "dk_computers_v1",
  gpus: "dk_gpus_v1",
  misc: "dk_misc_v1",
  stockKinds: "dk_stock_kinds_v1",
  stockSchema: "dk_stock_schema_v1",
  stock: "dk_stock_v1",
};

// ===== Supabase（遠端前台商品）設定 =====
// ⚠️ 請把下面兩個常數改成你在 Supabase 後台看到的值：
// - SUPABASE_URL：Project Settings → Data API 裡的 Project URL
// - SUPABASE_ANON_KEY：Project Settings → API Keys 裡的 Publishable key
//
// 例：
// const SUPABASE_URL = "https://xxxxx.supabase.co";
// const SUPABASE_ANON_KEY = "sb_publishable_xxx...";
//
// 若留空會退回使用 localStorage。
const SUPABASE_URL = "https://npynqrsmduukulwgylkz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_K0fyhespfyQIP-56bTZEFg_Gq1PJG4F";
const SUPABASE_INVENTORY_TABLE = "inventory";
const SUPABASE_SITE_CONFIG_TABLE = "site_config";
const SITE_CONFIG_ROW_ID = "default";
const SUPABASE_STOCK_DATA_TABLE = "stock_data";
const STOCK_DATA_ROW_ID = "default";
const SUPABASE_ORDERS_DATA_TABLE = "orders_data";
const ORDERS_DATA_ROW_ID = "default";
const SUPABASE_V2_DATA_TABLE = "v2_data";
const V2_DATA_ROW_ID = "default";
/** 若設定為 bucket 名稱（例如 "product-photos"），上傳商品照片時會改存 Supabase Storage，只在本機存網址，可避免 5MB 上限。請先在 Supabase 後台建立該 bucket 並設為 Public。 */
const SUPABASE_STORAGE_BUCKET = "product-photos";
const V2_STORAGE_KEYS = { items: "dk_v2_items", ledger: "dk_v2_ledger", orders: "dk_v2_orders", expenses: "dk_v2_expenses" };

const DEFAULT_CONFIG = {
  siteTitle: "二手電腦・實測交付｜依用途配機，不亂賣、不踩雷",
  brand: {
    mark: "DK",
    title: "二手電腦・實測交付",
    subtitle: "依用途配機，不亂賣、不踩雷",
  },
  frontend: {
    heroTagline: "二手電腦・實測交付",
    heroSub: "依用途配機，不亂賣、不踩雷",
    heroBtn1: "🔥 我要買整機",
    heroBtn2: "🧠 不知道怎麼選（需求表單）",
    heroBtn3: "🔧 電腦有問題要維修",
    trustTitle: "所有整機皆",
    trustItems: ["實測", "清潔", "交付前檢查", "不賣不適合用途的配法", "有問題可回來處理"],
    trustNote: "官網會寫清楚：不適合誰、不能幹嘛、不賣的情況。奧客會自己離開。",
    contactTitle: "聯絡我們",
    contactSub: "只留 LINE 官方帳，入口越少你越不亂。",
    machinePageTitle: "整機販售",
    machinePageSub: "依用途分類，不寫一堆規格。價格是「約」，詳細配備請加 LINE 詢問。",
    catImages: {},
    catPrices: {
      office: "NT$ 3,000–6,000",
      "game-entry": "NT$ 7,000–12,000",
      "game-mid": "NT$ 13,000–20,000",
      work: "NT$ 18,000+",
      peripherals: "價格依品項",
    },
    /** 篩選用價格區間（商品會依價格歸類到各區塊）。留空則用預設值 */
    catPriceRanges: {
      office: { min: 0, max: 6000 },
      "game-entry": { min: 7000, max: 12000 },
      "game-mid": { min: 13000, max: 20000 },
      work: { min: 18000, max: 999999 },
      peripherals: { min: 0, max: 999999 },
    },
  },
  shop: {
    name: "哈啦電競電腦維修",
    address: "510 彰化縣員林市中山路二段 277 巷 12 弄 73 號 B1",
    phone: "0976 009 628",
    // 你提供的 Google 商家分享連結
    mapUrl: "https://share.google/8KYdQojTnx4cKgqxz",
    // Google 商家照片（建議放在本專案 assets 資料夾）
    photoUrl:
      "file:///C:/Users/Hi/.cursor/projects/c-Users-Hi-Desktop-2/assets/c__Users_Hi_AppData_Roaming_Cursor_User_workspaceStorage_fd07e6f51d41fe8bccbee3cc5dca28d0_images_S__5128195-53ab6056-6438-4d95-8ea3-209ff94139ed.png",
  },
  line: {
    url: "https://lin.ee/VcxP0QO",
    lineId: "@315PEPPL",
    lineCtaText: "加 LINE 快速配單／看現貨",
    footerLineSentence: "不確定怎麼選？直接加 LINE：@315PEPPL，我用你的用途/預算給你最划算的配置或現貨選項。",
    orderMessageTemplate: "你好，我想詢問：{name}",
  },
  admin: {
    username: "admin",
    password: "admin123",
  },
  // 庫存品項品類（可於後台新增/移除）
  inventoryCategories: ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼", "周邊", "其他"],
};

const DEFAULT_INVENTORY = [
  {
    id: "demo-1",
    name: "R5 7500F / RTX 4060 遊戲主機",
    category: "遊戲",
    stockStatus: "現貨",
    cpu: "Ryzen 5 7500F",
    gpu: "RTX 4060",
    ram: "32GB",
    ssd: "1TB",
    price: 28900,
    tags: ["2K", "高CP"],
    note: "",
    photos: [],
  },
  {
    id: "demo-2",
    name: "i5 / RTX 3060 剪輯入門機",
    category: "剪輯",
    stockStatus: "低庫存",
    cpu: "Intel Core i5",
    gpu: "RTX 3060",
    ram: "32GB",
    ssd: "1TB",
    price: 25900,
    tags: ["剪輯", "入門"],
    note: "",
    photos: [],
  },
  {
    id: "demo-3",
    name: "文書辦公小主機",
    category: "辦公",
    stockStatus: "缺貨",
    cpu: "Intel / AMD",
    gpu: "內顯",
    ram: "16GB",
    ssd: "512GB",
    price: 12900,
    tags: ["辦公", "安靜"],
    note: "",
    photos: [],
  },
];

// 新後台：電腦庫存（每台一列）
const DEFAULT_COMPUTERS = [
  {
    id: "pc-demo-1",
    machineNo: "DK-001",
    type: "電競機", // 文書機 / 電競機 / 整新機
    cpu: "Ryzen 5 7500F",
    motherboard: "B650",
    ram: "32GB",
    storage: "1TB SSD",
    gpu: "RTX 4060",
    psu: "650W",
    case: "ATX",
    costBase: 24000,
    costAddon: 1200,
    costRefurb: 0,
    suggestedPrice: 28900,
    minPrice: 27500,
    status: "在庫", // 在庫 / 已預訂 / 已售出
    listedAt: "2026-02-01",
    soldAt: "",
    soldPrice: null,
    source: "LINE", // LINE / 社群 / 短影音 / 老客戶回購 / 朋友介紹 ...
    customer: "",
    note: "",
  },
];

// 新後台：顯卡庫存
const DEFAULT_GPUS = [
  {
    id: "gpu-demo-1",
    gpuNo: "GPU-001",
    model: "RTX 3060 Ti",
    brand: "MSI",
    fans: 2,
    origin: "網咖",
    cost: 6500,
    testStatus: "OK", // OK / 待測
    warranty: false,
    suggestedPrice: 7900,
    minPrice: 7400,
    status: "在庫", // 在庫 / 已售出
    listedAt: "2026-02-01",
    soldAt: "",
    soldPrice: null,
    source: "社群",
    customer: "",
    note: "",
  },
];

// 新後台：其他收入（維修/升級/配件等）
const DEFAULT_MISC = [
  {
    id: "misc-demo-1",
    date: "2026-02-01",
    category: "維修收入", // 維修收入 / 其他
    revenue: 1200,
    cost: 0,
    source: "LINE",
    customer: "",
    note: "更換風扇",
  },
];

// ✅ 你要的「庫存類別可自訂」：每個類別對應一個編號前綴（例如 DK-001 / GPU-001）
const DEFAULT_STOCK_KINDS = [
  { label: "電腦", prefix: "DK" },
  { label: "顯卡", prefix: "GPU" },
  { label: "周邊", prefix: "ACC" },
  { label: "其他", prefix: "OT" },
];

// ✅ 你要的「一個庫存」＋「可自訂項目（欄位）」
const DEFAULT_STOCK_SCHEMA = [
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "記憶體" },
  { key: "gpu", label: "顯示卡" },
  { key: "motherboard", label: "主機板" },
  { key: "storage", label: "硬碟" },
  { key: "psu", label: "電源供應器" },
  { key: "case", label: "機殼" },
  { key: "peripherals", label: "周邊" },
];

const DEFAULT_STOCK = [
  {
    id: "stk-demo-1",
    stockNo: "DK-001",
    kind: "電腦",
    brand: "DK",
    modelSpec: "R5 7500F / RTX 4060 / 32GB / 1TB SSD",
    type: "電競機", // 文書機 / 電競機 / 整新機 / 自訂
    status: "在庫", // 在庫 / 已預訂 / 已售出
    listedAt: "2026-02-01",
    soldAt: "",
    soldPrice: null,
    costBase: 24000,
    costAddon: 1200,
    costRefurb: 0,
    suggestedPrice: 28900,
    minPrice: 27500,
    source: "LINE",
    customer: "",
    note: "",
    web: {
      publish: true,
      name: "R5 7500F / RTX 4060 遊戲主機",
      category: "遊戲", // 遊戲 / 剪輯 / 辦公
      stockStatus: "現貨", // 現貨 / 低庫存 / 缺貨
      price: 28900,
      tags: ["熱銷"],
      note: "",
      photos: [],
    },
    spec: {
      cpu: "Ryzen 5 7500F",
      ram: "32GB",
      gpu: "RTX 4060",
      motherboard: "B650",
      storage: "1TB SSD",
      psu: "650W",
      case: "ATX",
      peripherals: "",
    },
  },
];

function safeJsonParse(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function deepMerge(base, patch) {
  if (typeof base !== "object" || base === null) return patch;
  if (typeof patch !== "object" || patch === null) return patch;

  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(base[k] ?? {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getConfig() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.config), null);
  if (!saved) return { ...DEFAULT_CONFIG };
  return deepMerge(DEFAULT_CONFIG, saved);
}

function saveConfig(nextConfig) {
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(nextConfig));
  // 同步寫入 Supabase，讓所有人看到同一份前台設定
  if (window.DK?.saveSiteConfigToSupabase) {
    window.DK.saveSiteConfigToSupabase(nextConfig).catch(() => {});
  }
}

function getInventoryCategories() {
  const cfg = getConfig();
  let list = cfg.inventoryCategories;
  if (!Array.isArray(list) || list.length === 0) list = DEFAULT_CONFIG.inventoryCategories.slice();
  else list = list.slice();
  const extra = ["周邊", "其他"];
  for (const c of extra) {
    if (!list.includes(c)) list.push(c);
  }
  return list;
}

function getInventory() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.inventory), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_INVENTORY];
  return saved;
}

/** 供前台顯示用：回傳上架商品列表，且「剩餘數量」優先從庫存連動（同 id 的庫存品項現有數量），不用手動輸入。 */
function getInventoryForDisplay() {
  const list = getInventory();
  const out = list.map((it) => ({ ...it }));
  const ids = new Set(out.map((i) => String(i?.id || "")));
  if (ids.size === 0) return out;
  if (typeof window !== "undefined" && window.DK) {
    const DK = window.DK;
    if (typeof DK.getItems === "function") {
      const v2Items = DK.getItems();
      for (const it of out) {
        const v = v2Items.find((x) => String(x?.id || "") === String(it?.id || ""));
        if (v != null && Number.isFinite(Number(v.qty_on_hand)) && Number(v.qty_on_hand) >= 0) {
          it.qty = Number(v.qty_on_hand);
        }
      }
    }
    if (typeof DK.getStock === "function") {
      const stockList = DK.getStock();
      for (const it of out) {
        if (it.qty != null) continue;
        const s = stockList.find((x) => String(x?.id || "") === String(it?.id || ""));
        if (s != null) {
          const q = s.web?.qty ?? s.qty;
          const n = Number(q);
          if (Number.isFinite(n) && n >= 0) it.qty = n;
        }
      }
    }
  }
  return out;
}

function saveInventory(items) {
  localStorage.setItem(STORAGE_KEYS.inventory, JSON.stringify(items));
}

// ===== Supabase：前台商品讀寫 =====
async function fetchInventoryFromSupabase() {
  // 若尚未設定 Supabase，退回用 localStorage / 預設 demo
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return getInventory();

  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_INVENTORY_TABLE}?select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error("fetch inventory from Supabase failed");
  }
  const rows = await res.json();
  return rows.map((r) => ({
    id: String(r.id || ""),
    name: String(r.name || ""),
    category: String(r.category || ""),
    stockStatus: String(r.stock_status || "現貨"),
    price: typeof r.price === "number" ? r.price : toNumber(r.price) ?? null,
    note: String(r.note || ""),
    photos: Array.isArray(r.photos) ? r.photos : [],
    qty: (() => { const n = typeof r.qty === "number" ? r.qty : Number(r.qty); return Number.isFinite(n) && n >= 0 ? n : null; })(),
  }));
}

async function upsertInventoryItemToSupabase(item) {
  if (!item || !item.id) return { ok: true };
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const msg = "未設定 SUPABASE_URL 或 SUPABASE_ANON_KEY，上架僅存於本機。請在 shared.js 填寫並重新部署。";
    console.warn("[Supabase]", msg);
    return { ok: false, error: msg };
  }
  const payload = {
    id: String(item.id),
    name: String(item.name || ""),
    category: String(item.category || ""),
    stock_status: String(item.stockStatus || "現貨"),
    price: typeof item.price === "number" ? item.price : toNumber(item.price),
    note: String(item.note || ""),
    photos: Array.isArray(item.photos) ? item.photos : [],
    qty: typeof item.qty === "number" && item.qty >= 0 ? item.qty : null,
  };

  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_INVENTORY_TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify([payload]),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("同步商品到 Supabase 失敗 (" + res.status + ")", errText);
    return { ok: false, error: `HTTP ${res.status}：${errText.slice(0, 100)}` };
  }
  return { ok: true };
}

async function deleteInventoryItemFromSupabase(id) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !id) return { ok: true };
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_INVENTORY_TABLE}?id=eq.${encodeURIComponent(
    String(id),
  )}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    console.warn("從 Supabase 刪除商品失敗", errText);
    return { ok: false, error: `HTTP ${res.status}：${errText.slice(0, 80)}` };
  }
  return { ok: true };
}

// ===== Supabase Storage：商品照片上傳（選用，可避免 localStorage 5MB 上限） =====
/** 上傳圖片到 Supabase Storage，回傳公開網址；失敗或未設定 bucket 時回傳 null。 */
async function uploadImageToSupabaseStorage(blob, pathOrFilename) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_STORAGE_BUCKET) return null;
  const path = String(pathOrFilename || "img.jpg").replace(/^\/+/, "");
  const url = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": blob.type || "image/jpeg",
        "x-upsert": "true",
      },
      body: blob,
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn("[Supabase Storage] 上傳失敗", res.status, err.slice(0, 100));
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${path}`;
  } catch (e) {
    console.warn("[Supabase Storage] 上傳錯誤", e?.message || e);
    return null;
  }
}

// ===== Supabase：官網設定（site_config）讀寫 =====
async function fetchSiteConfigFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_SITE_CONFIG_TABLE}?id=eq.${encodeURIComponent(
    SITE_CONFIG_ROW_ID,
  )}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object") return null;
  return deepMerge(DEFAULT_CONFIG, raw);
}

async function saveSiteConfigToSupabase(config) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !config || typeof config !== "object") return;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_SITE_CONFIG_TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify([{ id: SITE_CONFIG_ROW_ID, data: config }]),
  });
  if (!res.ok) {
    console.warn("同步官網設定到 Supabase 失敗", await res.text());
  }
}

// ===== Supabase：庫存資料（stock + stockKinds + stockSchema）讀寫 =====
async function fetchStockDataFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_STOCK_DATA_TABLE}?id=eq.${encodeURIComponent(
    STOCK_DATA_ROW_ID,
  )}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

async function saveAllStockDataToSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const payload = {
    id: STOCK_DATA_ROW_ID,
    data: {
      stock: getStock(),
      stockKinds: getStockKinds(),
      stockSchema: getStockSchema(),
    },
  };
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_STOCK_DATA_TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify([payload]),
  });
  if (!res.ok) {
    console.warn("同步庫存到 Supabase 失敗", await res.text());
  }
}

// ===== Supabase：訂單資料（訂單管理、報表用）讀寫 =====
async function fetchOrdersFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_ORDERS_DATA_TABLE}?id=eq.${encodeURIComponent(
    ORDERS_DATA_ROW_ID,
  )}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.orders)) return null;
  return raw.orders;
}

async function saveOrdersToSupabase(orders) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !Array.isArray(orders)) return;
  const payload = {
    id: ORDERS_DATA_ROW_ID,
    data: { orders: orders },
  };
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_ORDERS_DATA_TABLE}?on_conflict=id`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify([payload]),
  });
  if (!res.ok) {
    console.warn("同步訂單到 Supabase 失敗", await res.text());
  }
}

// ===== Supabase：庫存＋記帳 v2（品項、流水帳、訂單、支出）讀寫 =====
async function fetchV2DataFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_V2_DATA_TABLE}?id=eq.${encodeURIComponent(
    V2_DATA_ROW_ID,
  )}&select=data`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object") return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const ledger = Array.isArray(raw.ledger) ? raw.ledger : [];
  const orders = Array.isArray(raw.orders) ? raw.orders : [];
  const expenses = Array.isArray(raw.expenses) ? raw.expenses : [];
  try {
    localStorage.setItem(V2_STORAGE_KEYS.items, JSON.stringify(items));
    localStorage.setItem(V2_STORAGE_KEYS.ledger, JSON.stringify(ledger));
    localStorage.setItem(V2_STORAGE_KEYS.orders, JSON.stringify(orders));
    localStorage.setItem(V2_STORAGE_KEYS.expenses, JSON.stringify(expenses));
  } catch (e) {
    return null;
  }
  return { items, ledger, orders, expenses };
}

async function saveV2DataToSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, error: "Supabase 未設定（請在 shared.js 填寫 SUPABASE_URL 與 SUPABASE_ANON_KEY）" };
  }
  let items = [];
  let ledger = [];
  let orders = [];
  let expenses = [];
  try {
    items = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.items), []);
    ledger = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.ledger), []);
    orders = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.orders), []);
    expenses = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.expenses), []);
  } catch (e) {
    return { ok: false, error: "讀取本機資料失敗" };
  }
  const payload = {
    id: V2_DATA_ROW_ID,
    data: { items, ledger, orders, expenses },
  };
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_V2_DATA_TABLE}?on_conflict=id`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn("同步庫存＋記帳到 Supabase 失敗", errText);
      return { ok: false, error: `HTTP ${res.status}：${(errText || "連線失敗").slice(0, 80)}` };
    }
    return { ok: true };
  } catch (e) {
    console.warn("同步庫存＋記帳到 Supabase 失敗", e);
    return { ok: false, error: String(e?.message || e || "網路連線失敗") };
  }
}

function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

if (typeof window !== "undefined") {
  window.__syncV2ToSupabase = function () {
    return saveV2DataToSupabase().catch(function (e) {
      return { ok: false, error: String(e?.message || e || "同步失敗") };
    });
  };
  window.fetchV2DataFromSupabase = fetchV2DataFromSupabase;
  window.saveV2DataToSupabase = saveV2DataToSupabase;
}

function getComputers() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.computers), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_COMPUTERS];
  return saved;
}

function saveComputers(items) {
  localStorage.setItem(STORAGE_KEYS.computers, JSON.stringify(items));
}

function getGpus() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.gpus), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_GPUS];
  return saved;
}

function saveGpus(items) {
  localStorage.setItem(STORAGE_KEYS.gpus, JSON.stringify(items));
}

function getMisc() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.misc), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_MISC];
  return saved;
}

function saveMisc(items) {
  localStorage.setItem(STORAGE_KEYS.misc, JSON.stringify(items));
}

function getStockKinds() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stockKinds), null);
  if (!saved || !Array.isArray(saved) || saved.length === 0) return [...DEFAULT_STOCK_KINDS];
  return saved
    .map((x) => ({
      label: String(x?.label || "").trim(),
      prefix: String(x?.prefix || "").trim().toUpperCase(),
    }))
    .filter((x) => x.label && x.prefix);
}

function saveStockKinds(kinds, skipSupabaseSync) {
  localStorage.setItem(STORAGE_KEYS.stockKinds, JSON.stringify(kinds));
  if (!skipSupabaseSync && window.DK?.saveAllStockDataToSupabase) {
    window.DK.saveAllStockDataToSupabase().catch(function () {});
  }
}

function getStockSchema() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stockSchema), null);
  if (!saved || !Array.isArray(saved) || saved.length === 0) return [...DEFAULT_STOCK_SCHEMA];
  // 清掉不合法的 key/label
  return saved
    .map((x) => ({ key: String(x?.key || "").trim(), label: String(x?.label || "").trim() }))
    .filter((x) => x.key && x.label);
}

function saveStockSchema(schema, skipSupabaseSync) {
  localStorage.setItem(STORAGE_KEYS.stockSchema, JSON.stringify(schema));
  if (!skipSupabaseSync && window.DK?.saveAllStockDataToSupabase) {
    window.DK.saveAllStockDataToSupabase().catch(function () {});
  }
}

function getStock() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stock), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_STOCK];
  return saved;
}

function saveStock(items, skipSupabaseSync) {
  localStorage.setItem(STORAGE_KEYS.stock, JSON.stringify(items));
  if (!skipSupabaseSync && window.DK?.saveAllStockDataToSupabase) {
    window.DK.saveAllStockDataToSupabase().catch(function () {});
  }
}

function formatPrice(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return n.toLocaleString("zh-Hant-TW");
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function calcTotalCostPC(pc) {
  const a = Number(pc?.costBase || 0);
  const b = Number(pc?.costAddon || 0);
  const c = Number(pc?.costRefurb || 0);
  return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0) + (Number.isFinite(c) ? c : 0);
}

function backupInventoryOnce() {
  const hasBackup = localStorage.getItem(STORAGE_KEYS.inventoryBackup);
  if (hasBackup) return;
  const current = localStorage.getItem(STORAGE_KEYS.inventory);
  if (current) localStorage.setItem(STORAGE_KEYS.inventoryBackup, current);
}

function guessWebCategory(item) {
  const t = String(item?.type || "").trim();
  const hay = normalizeText(t);
  if (hay.includes("文書") || hay.includes("辦公")) return "辦公";
  if (hay.includes("剪輯") || hay.includes("影片")) return "剪輯";
  if (hay.includes("電競") || hay.includes("遊戲")) return "遊戲";
  return "遊戲";
}

function statusToWebStockStatus(status) {
  if (status === "在庫") return "現貨";
  if (status === "已預訂") return "低庫存";
  if (status === "已售出") return "缺貨";
  return "現貨";
}

function buildDefaultWebNameFromStock(it) {
  const kind = String(it?.kind || "").trim();
  const type = String(it?.type || "").trim();
  const cpu = String(it?.spec?.cpu || "").trim();
  const gpu = String(it?.spec?.gpu || "").trim();
  if (kind === "電腦") {
    const parts = [];
    if (cpu) parts.push(cpu);
    if (gpu) parts.push(gpu);
    const modelSpec = String(it?.modelSpec || "").trim();
    const core = parts.length ? parts.join(" / ") : modelSpec || String(it?.stockNo || "電腦");
    return `${core}${type ? ` ${type}` : " 主機"}`.trim();
  }
  if (kind === "顯卡") {
    return `${gpu || it?.stockNo || "顯卡"}`.trim();
  }
  return String(it?.stockNo || "庫存").trim();
}

function stockToInventoryItem(it) {
  const web = it?.web || {};
  // 已售出就不要出現在前台
  if (it?.status === "已售出") return null;
  if (!web.publish) return null;
  const name = String(web.name || "").trim();
  const category = String(web.category || "").trim();
  const stockStatus = String(web.stockStatus || "").trim();
  if (!name || !category || !stockStatus) return null;

  const tags = Array.isArray(web.tags)
    ? web.tags.map((x) => String(x || "").trim()).filter(Boolean)
    : String(web.tags || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  const photos = Array.isArray(web.photos) ? web.photos.filter(Boolean) : [];

  return {
    id: String(it?.id || makeId("item")),
    name,
    category,
    stockStatus,
    cpu: String(it?.spec?.cpu || "").trim(),
    gpu: String(it?.spec?.gpu || "").trim(),
    ram: String(it?.spec?.ram || "").trim(),
    ssd: String(it?.spec?.storage || "").trim(),
    price: typeof web.price === "number" ? web.price : toNumber(web.price) ?? undefined,
    tags,
    note: String(web.note || it?.note || it?.modelSpec || "").trim(),
    photos,
  };
}

function syncWebInventoryFromStock() {
  backupInventoryOnce();
  const stockList = getStock();
  const stockIds = new Set(stockList.map((s) => String(s?.id || "").trim()).filter(Boolean));
  const fromStock = stockList.map(stockToInventoryItem).filter(Boolean);
  const currentInv = getInventory();
  // 保留「僅在 inventory、不在庫存」的項目（例如上架管理新增的 WEB-xxx），避免被同步洗掉
  const inventoryOnly = currentInv.filter((it) => it?.id && !stockIds.has(String(it.id)));
  const merged = [...fromStock, ...inventoryOnly];
  saveInventory(merged);
}

function ensureUnifiedStockInitialized() {
  // 若已存在就不動
  const existing = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stock), null);
  if (Array.isArray(existing)) return;

  // 先以「電腦/顯卡」舊資料做一次整併（同一個庫存）
  const out = [];
  try {
    const pcs = getComputers();
    for (const pc of pcs) {
      const it = {
        id: pc.id || makeId("stk"),
        stockNo: pc.machineNo || makeId("DK"),
        kind: "電腦",
        brand: "",
        modelSpec: [pc.cpu, pc.gpu, pc.ram, pc.storage].filter(Boolean).join(" / "),
        type: pc.type || "",
        status: pc.status || "在庫",
        listedAt: pc.listedAt || "",
        soldAt: pc.soldAt || "",
        soldPrice: typeof pc.soldPrice === "number" ? pc.soldPrice : null,
        costBase: Number(pc.costBase || 0),
        costAddon: Number(pc.costAddon || 0),
        costRefurb: Number(pc.costRefurb || 0),
        suggestedPrice: typeof pc.suggestedPrice === "number" ? pc.suggestedPrice : null,
        minPrice: typeof pc.minPrice === "number" ? pc.minPrice : null,
        source: pc.source || "",
        customer: pc.customer || "",
        note: pc.note || "",
        web: {
          publish: (pc.status || "在庫") !== "已售出",
          name: "", // 下面補預設
          category: guessWebCategory(pc),
          stockStatus: statusToWebStockStatus(pc.status || "在庫"),
          price: typeof pc.suggestedPrice === "number" ? pc.suggestedPrice : null,
          tags: [],
          note: "",
          photos: [],
        },
        spec: {
          cpu: pc.cpu || "",
          ram: pc.ram || "",
          gpu: pc.gpu || "",
          motherboard: pc.motherboard || "",
          storage: pc.storage || "",
          psu: pc.psu || "",
          case: pc.case || "",
          peripherals: "",
        },
      };
      it.web.name = buildDefaultWebNameFromStock(it);
      out.push(it);
    }
  } catch {}

  try {
    const gs = getGpus();
    for (const g of gs) {
      const it = {
        id: g.id || makeId("stk"),
        stockNo: g.gpuNo || makeId("GPU"),
        kind: "顯卡",
        brand: g.brand || "",
        modelSpec: g.model || "",
        type: "",
        status: g.status === "已售出" ? "已售出" : "在庫",
        listedAt: g.listedAt || "",
        soldAt: g.soldAt || "",
        soldPrice: typeof g.soldPrice === "number" ? g.soldPrice : null,
        costBase: Number(g.cost || 0),
        costAddon: 0,
        costRefurb: 0,
        suggestedPrice: typeof g.suggestedPrice === "number" ? g.suggestedPrice : null,
        minPrice: typeof g.minPrice === "number" ? g.minPrice : null,
        source: g.source || "",
        customer: g.customer || "",
        note: g.note || "",
        web: {
          publish: g.status !== "已售出",
          name: "", // 下面補預設
          category: "遊戲",
          stockStatus: statusToWebStockStatus(g.status === "已售出" ? "已售出" : "在庫"),
          price: typeof g.suggestedPrice === "number" ? g.suggestedPrice : null,
          tags: [],
          note: "",
          photos: [],
        },
        spec: {
          cpu: "",
          ram: "",
          gpu: g.model || "",
          motherboard: "",
          storage: "",
          psu: "",
          case: "",
          peripherals: g.brand ? `廠牌：${g.brand}` : "",
        },
      };
      it.web.name = buildDefaultWebNameFromStock(it);
      out.push(it);
    }
  } catch {}

  // 若舊資料都沒有，就放預設示範
  if (out.length === 0) {
    saveStock([...DEFAULT_STOCK]);
    saveStockKinds([...DEFAULT_STOCK_KINDS]);
    saveStockSchema([...DEFAULT_STOCK_SCHEMA]);
    return;
  }

  saveStock(out);
  const kindsExisting = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stockKinds), null);
  if (!Array.isArray(kindsExisting)) saveStockKinds([...DEFAULT_STOCK_KINDS]);
  // 如果使用者之前沒有 schema，就存一份預設（可自行改）
  const schemaExisting = safeJsonParse(localStorage.getItem(STORAGE_KEYS.stockSchema), null);
  if (!Array.isArray(schemaExisting)) saveStockSchema([...DEFAULT_STOCK_SCHEMA]);
}

function nextNumber(prefix, existingCodes) {
  // existingCodes: ["DK-001", ...] or ["GPU-001", ...]
  let max = 0;
  for (const code of existingCodes || []) {
    const m = String(code || "").match(/(\d+)\s*$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  const next = max + 1;
  const num = String(next).padStart(3, "0");
  return `${prefix}-${num}`;
}

function exportAllData() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    config: getConfig(),
    inventory: getInventory(),
    computers: getComputers(),
    gpus: getGpus(),
    misc: getMisc(),
    stockKinds: getStockKinds(),
    stockSchema: getStockSchema(),
    stock: getStock(),
  };
  return JSON.stringify(payload, null, 2);
}

function importAllData(jsonText) {
  const data = safeJsonParse(jsonText, null);
  if (!data || typeof data !== "object") throw new Error("invalid json");
  if (data.config) saveConfig(deepMerge(DEFAULT_CONFIG, data.config));
  if (Array.isArray(data.inventory)) saveInventory(data.inventory);
  if (Array.isArray(data.computers)) saveComputers(data.computers);
  if (Array.isArray(data.gpus)) saveGpus(data.gpus);
  if (Array.isArray(data.misc)) saveMisc(data.misc);
  if (Array.isArray(data.stockKinds)) saveStockKinds(data.stockKinds);
  if (Array.isArray(data.stockSchema)) saveStockSchema(data.stockSchema);
  if (Array.isArray(data.stock)) saveStock(data.stock);
}

function makeId(prefix = "item") {
  return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function normalizeText(s) {
  return String(s ?? "").trim().toLowerCase();
}

function stockBadgeClass(stockStatus) {
  if (stockStatus === "現貨") return "ok";
  if (stockStatus === "低庫存") return "warn";
  if (stockStatus === "缺貨") return "danger";
  return "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function applyConfigToHomePage() {
  const cfg = getConfig();

  const yearEl = document.getElementById("copyrightYear");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const heroTitle = document.getElementById("heroTitle");
  if (heroTitle) heroTitle.textContent = cfg.siteTitle;
  if (document.querySelector("title")) document.title = cfg.siteTitle || document.title;

  const brandMark = document.getElementById("brandMark");
  if (brandMark) brandMark.textContent = cfg.brand.mark;
  const brandTitle = document.getElementById("brandTitle");
  if (brandTitle) brandTitle.textContent = cfg.brand.title;
  const brandSubtitle = document.getElementById("brandSubtitle");
  if (brandSubtitle) brandSubtitle.textContent = cfg.brand.subtitle;

  const fe = cfg.frontend || {};
  const heroTagline = document.getElementById("heroTagline");
  if (heroTagline) heroTagline.textContent = fe.heroTagline ?? cfg.brand.title;
  const heroSub = document.getElementById("heroSub");
  if (heroSub) heroSub.textContent = fe.heroSub ?? cfg.brand.subtitle;
  const heroBtn1 = document.getElementById("heroBtn1");
  if (heroBtn1) heroBtn1.textContent = fe.heroBtn1 ?? "🔥 我要買整機";
  const heroBtn2 = document.getElementById("heroBtn2");
  if (heroBtn2) heroBtn2.textContent = fe.heroBtn2 ?? "🧠 不知道怎麼選（需求表單）";
  const heroBtn3 = document.getElementById("heroBtn3");
  if (heroBtn3) heroBtn3.textContent = fe.heroBtn3 ?? "🔧 電腦有問題要維修";
  const trustTitle = document.getElementById("trustTitle");
  if (trustTitle) trustTitle.textContent = fe.trustTitle ?? "所有整機皆";
  const trustList = document.getElementById("trustList");
  if (trustList && Array.isArray(fe.trustItems) && fe.trustItems.length > 0) {
    trustList.innerHTML = fe.trustItems.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  }
  const trustNote = document.getElementById("trustNote");
  if (trustNote) trustNote.textContent = fe.trustNote ?? "";
  const contactTitle = document.getElementById("contactTitle");
  if (contactTitle) contactTitle.textContent = fe.contactTitle ?? "聯絡我們";
  const contactSub = document.getElementById("contactSub");
  if (contactSub) contactSub.textContent = fe.contactSub ?? "";
  const machinePageTitle = document.getElementById("machinePageTitle");
  if (machinePageTitle) machinePageTitle.textContent = fe.machinePageTitle ?? "整機販售";
  const machinePageSub = document.getElementById("machinePageSub");
  if (machinePageSub) machinePageSub.textContent = fe.machinePageSub ?? "";
  const catPrices = fe.catPrices || (typeof DK !== "undefined" && DK.DEFAULT_CONFIG?.frontend?.catPrices) || {};
  const catPriceDefaults = { office: "NT$ 3,000–6,000", "game-entry": "NT$ 7,000–12,000", "game-mid": "NT$ 13,000–20,000", work: "NT$ 18,000+", peripherals: "價格依品項" };
  document.querySelectorAll(".cat-card[data-cat]").forEach((card) => {
    const cat = card.dataset.cat;
    if (cat === "all") return;
    const priceEl = card.querySelector(".cat-card-price");
    if (priceEl) priceEl.textContent = (catPrices[cat] || catPriceDefaults[cat] || "").trim() || catPriceDefaults[cat];
  });

  const shopName = document.getElementById("shopName");
  if (shopName) shopName.textContent = cfg.shop.name;

  const shopAddressLink = document.getElementById("shopAddressLink");
  if (shopAddressLink) {
    shopAddressLink.textContent = cfg.shop.address;
    shopAddressLink.href = cfg.shop.mapUrl || "#";
  }

  const shopPhoneLink = document.getElementById("shopPhoneLink");
  const shopCallBtn = document.getElementById("shopCallBtn");
  const shopCallBtn2 = document.getElementById("shopCallBtn2");
  const phoneHref = cfg.shop.phone ? `tel:+886${cfg.shop.phone.replaceAll(" ", "").replace(/^0/, "")}` : "#";
  if (shopPhoneLink) {
    shopPhoneLink.textContent = cfg.shop.phone;
    shopPhoneLink.href = phoneHref;
  }
  if (shopCallBtn) shopCallBtn.href = phoneHref;
  if (shopCallBtn2) shopCallBtn2.href = phoneHref;

  const shopMapBtn = document.getElementById("shopMapBtn");
  if (shopMapBtn) shopMapBtn.href = cfg.shop.mapUrl || "#";

  const shopMapBtn2 = document.getElementById("shopMapBtn2");
  if (shopMapBtn2) shopMapBtn2.href = cfg.shop.mapUrl || "#";

  const shopPhoto = document.getElementById("shopPhoto");
  if (shopPhoto) {
    const url = String(cfg.shop.photoUrl || "").trim();
    if (url) {
      shopPhoto.src = url;
      shopPhoto.hidden = false;
      shopPhoto.addEventListener(
        "error",
        () => {
          shopPhoto.hidden = true;
        },
        { once: true },
      );
    } else {
      shopPhoto.hidden = true;
    }
  }

  const lineCtaText = cfg.line.lineCtaText || "加 LINE 快速配單／看現貨";
  const lineButtons = [
    document.getElementById("lineMainBtn"),
    document.getElementById("lineStickyBtn"),
    document.getElementById("navLineBtn"),
    document.getElementById("lineCtaBlockBtn"),
  ].filter(Boolean);

  for (const btn of lineButtons) {
    btn.href = cfg.line.url || "#";
    btn.target = "_blank";
    btn.rel = "noreferrer";
    if (btn.id !== "heroBtn3" && btn.textContent) btn.textContent = lineCtaText;
    if (!cfg.line.url) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        alert("尚未設定 LINE 連結。請到管理員後台填入 LINE URL。");
      });
    }
  }

  const footerLineSentence = document.getElementById("footerLineSentence");
  if (footerLineSentence) footerLineSentence.textContent = cfg.line.footerLineSentence || "";
  const footerLineSentenceFooter = document.getElementById("footerLineSentenceFooter");
  if (footerLineSentenceFooter) footerLineSentenceFooter.textContent = cfg.line.footerLineSentence || "";
}

async function tryCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function buildOrderMessage(item) {
  const cfg = getConfig();
  const tpl = cfg.line.orderMessageTemplate || "你好，我想詢問：{name}";
  return tpl.replaceAll("{name}", String(item?.name ?? ""));
}

async function openLineOrder(item) {
  const cfg = getConfig();
  const msg = buildOrderMessage(item);

  if (cfg.line.url) {
    // 先嘗試複製訊息，使用者貼到 LINE 更快
    tryCopy(msg);
    window.open(cfg.line.url, "_blank", "noreferrer");
    return;
  }

  const ok = await tryCopy(msg);
  alert(ok ? "已複製詢問訊息（可貼到 LINE）。\n\n請到管理員後台設定 LINE 連結。" : "請到管理員後台設定 LINE 連結。");
}

function isAdminAuthed() {
  return localStorage.getItem(STORAGE_KEYS.adminAuthed) === "1";
}

function setAdminAuthed(v) {
  if (v) localStorage.setItem(STORAGE_KEYS.adminAuthed, "1");
  else localStorage.removeItem(STORAGE_KEYS.adminAuthed);
}

window.DK = {
  STORAGE_KEYS,
  DEFAULT_CONFIG,
  DEFAULT_INVENTORY,
  getConfig,
  saveConfig,
  getInventoryCategories,
  getInventory,
  getInventoryForDisplay,
  saveInventory,
  fetchInventoryFromSupabase,
  upsertInventoryItemToSupabase,
  deleteInventoryItemFromSupabase,
  uploadImageToSupabaseStorage,
  fetchSiteConfigFromSupabase,
  saveSiteConfigToSupabase,
  fetchStockDataFromSupabase,
  saveAllStockDataToSupabase,
  fetchOrdersFromSupabase,
  saveOrdersToSupabase,
  DEFAULT_COMPUTERS,
  DEFAULT_GPUS,
  DEFAULT_MISC,
  getComputers,
  saveComputers,
  getGpus,
  saveGpus,
  getMisc,
  saveMisc,
  DEFAULT_STOCK_KINDS,
  getStockKinds,
  saveStockKinds,
  DEFAULT_STOCK_SCHEMA,
  DEFAULT_STOCK,
  getStockSchema,
  saveStockSchema,
  getStock,
  saveStock,
  formatPrice,
  toNumber,
  todayISO,
  calcTotalCostPC,
  ensureUnifiedStockInitialized,
  syncWebInventoryFromStock,
  nextNumber,
  exportAllData,
  importAllData,
  makeId,
  normalizeText,
  stockBadgeClass,
  escapeHtml,
  applyConfigToHomePage,
  openLineOrder,
  tryCopy,
  isAdminAuthed,
  setAdminAuthed,
  isSupabaseConfigured,
};

// 頁面載入時從 Supabase 拉官網設定，覆蓋本機（大家看到同一份設定）
if (window.DK.fetchSiteConfigFromSupabase && window.DK.saveConfig) {
  window.DK
    .fetchSiteConfigFromSupabase()
    .then(function (c) {
      if (c != null) window.DK.saveConfig(c);
    })
    .catch(function () {});
}
// 頁面載入時從 Supabase 拉前台商品（上架清單），後台／前台看到同一份
if (window.DK && window.DK.fetchInventoryFromSupabase && window.DK.saveInventory) {
  window.DK
    .fetchInventoryFromSupabase()
    .then(function (items) {
      if (Array.isArray(items) && items.length > 0) window.DK.saveInventory(items);
    })
    .catch(function () {});
}
// 頁面載入時從 Supabase 拉庫存（stock + 類別 + 欄位），多裝置看到同一份（不觸發回寫）
if (window.DK && window.DK.fetchStockDataFromSupabase) {
  window.DK
    .fetchStockDataFromSupabase()
    .then(function (data) {
      if (!data) return;
      if (Array.isArray(data.stock)) window.DK.saveStock(data.stock, true);
      if (Array.isArray(data.stockKinds)) window.DK.saveStockKinds(data.stockKinds, true);
      if (Array.isArray(data.stockSchema)) window.DK.saveStockSchema(data.stockSchema, true);
    })
    .catch(function () {});
}
// 頁面載入時從 Supabase 拉庫存＋記帳 v2（品項、流水帳、訂單、支出），換電腦／換瀏覽器看到同一份
if (window.fetchV2DataFromSupabase) {
  window.fetchV2DataFromSupabase().catch(function () {});
}

// 手機選單（小螢幕可展開主選單/進後台）
(function initMobileMenu() {
  const btn = document.getElementById("mobileMenuBtn");
  const nav = document.getElementById("siteNav") || document.querySelector(".nav");
  if (!btn || !nav) return;

  function setOpen(open) {
    nav.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "關閉" : "選單";
  }

  function toggle(e) {
    e.preventDefault();
    e.stopPropagation?.();
    const open = !nav.classList.contains("open");
    setOpen(open);
  }

  // iOS/Safari：同時綁 click + touchend 更穩
  btn.addEventListener("click", toggle);
  btn.addEventListener("touchend", toggle, { passive: false });

  // 點選連結後自動關閉
  nav.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    setOpen(false);
  });

  // 點外面關閉
  document.addEventListener("click", (e) => {
    if (!nav.classList.contains("open")) return;
    const target = e.target;
    if (target === btn || btn.contains(target)) return;
    if (target === nav || nav.contains(target)) return;
    setOpen(false);
  });

  // ESC 關閉
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
})();

// 各頁面自動套用設定（品牌、LINE 連結等）
if (document.getElementById("copyrightYear") || document.getElementById("lineMainBtn") || document.getElementById("navLineBtn")) {
  applyConfigToHomePage();
}
