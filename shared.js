/* shared.js - 單頁靜態站：設定/資料存取/共用工具 */

const STORAGE_KEYS = {
  config: "dk_site_config_v1",
  inventory: "dk_inventory_v1",
  inventoryBackup: "dk_inventory_backup_v1",
  adminAuthed: "dk_admin_authed_v1",
  adminSession: "dk_admin_session_v1",
  computers: "dk_computers_v1",
  gpus: "dk_gpus_v1",
  misc: "dk_misc_v1",
  stockKinds: "dk_stock_kinds_v1",
  stockSchema: "dk_stock_schema_v1",
  stock: "dk_stock_v1",
  configSyncMeta: "dk_site_config_sync_meta_v1",
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
// ===== Stage 4 正式登入模式 =====
// "supabase" = Supabase Auth + public.profiles（正式）
// "legacy"  = 舊 site_config.admin 帳密（已淘汰；Stage 6-2 起不再保存明文密碼）
// 若人工改回 "legacy"：舊 password login 不再保證可用。這是刻意淘汰 insecure rollback，不是 bug。
const AUTH_LOGIN_MODE = "supabase";
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
// 專供站內資產（例如首頁 Banner）使用的 Storage bucket，請在 Supabase 建立並設為 Public
const SUPABASE_SITE_ASSET_BUCKET = "site-assets";
const V2_STORAGE_KEYS = { items: "dk_v2_items", ledger: "dk_v2_ledger", orders: "dk_v2_orders", expenses: "dk_v2_expenses", auditLogs: "dk_v2_audit_logs" };

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
    // 分享連結（LINE / Facebook）預設標題與說明、圖片（可在後台覆寫）
    ogTitle: "二手電腦・實測交付｜依用途配機，不亂賣、不踩雷",
    ogDescription: "依用途配機，不亂賣、不踩雷。買整機、不知道怎麼選、電腦維修，加 LINE 一次搞定。",
    ogImageUrl: "",
    /** 整機頁五張分類卡片：背景圖與標題 */
    catImages: {},
    catTitles: {
      office: "文書／上網／學生",
      "game-entry": "遊戲入門",
      "game-mid": "遊戲中階（主力）",
      work: "工作／效能取向",
      peripherals: "電腦周邊",
    },
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
    /** 首頁 header Logo 圖片網址（Supabase site-assets 等）；空字串表示不顯示圖片 */
    brandLogo: "",
    /** 首頁 Banner 設定（後台管理）；可為空陣列 */
    homeBanners: [],
    /** 首頁三大分類入口（第二區）；可於後台或日後配置擴充 */
    homeEntries: [
      {
        title: "網咖淘汰",
        subtitle: "精選高 CP 值現貨主機，適合想直接入手、快速開玩的客人。",
        image: "./assets/entry-cafe.png",
        link: "./machine.html",
      },
      {
        title: "不知道怎麼下單",
        subtitle: "不確定規格怎麼選沒關係，先填需求，我幫你配到適合的電腦。",
        image: "./assets/entry-select.png",
        link: "./form.html",
      },
      {
        title: "電腦壞了 / 維修",
        subtitle: "電腦故障、異常、升級需求，都可以先聯絡我協助判斷。",
        image: "./assets/entry-repair.png",
        link: "./form.html",
      },
    ],
    /** 首頁視覺效果（可選；缺欄位時用安全預設，不覆蓋其他 frontend 欄位） */
    homeStyle: {
      heroContentPosition: "left",
      heroOverlayStrength: 70,
      heroAccentGlow: true,
      sectionReveal: true,
      mouseGlow: true,
      cardTilt: false,
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
    url: "https://lin.ee/p58Bkqp",
    lineId: "@315PEPPL",
    lineCtaText: "加 LINE 快速配單／看現貨",
    footerLineSentence: "不確定怎麼選？直接加 LINE：@315PEPPL，我用你的用途/預算給你最划算的配置或現貨選項。",
    orderMessageTemplate: "你好，我想詢問：{name}",
  },
  admin: {
    username: "",
  },
  // 庫存品項品類（可於後台新增/移除；讀取時會確保正式品類齊全）
  inventoryCategories: [
    "處理器",
    "主機板",
    "記憶體",
    "硬碟",
    "顯示卡",
    "電源供應器",
    "機殼",
    "螢幕",
    "鍵盤",
    "滑鼠",
    "耳機",
    "周邊",
    "其他",
  ],
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

/**
 * Stage 6-2：寫入 localStorage / site_config 前移除明文密碼。
 * 真正 delete password property，不用空字串。不 log 原密碼。
 */
function sanitizeSiteConfigForStorage(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const next = { ...config };
  if (next.admin && typeof next.admin === "object" && !Array.isArray(next.admin)) {
    const admin = { ...next.admin };
    if (Object.prototype.hasOwnProperty.call(admin, "password")) delete admin.password;
    if (Array.isArray(admin.users)) {
      admin.users = admin.users.map(function (u) {
        if (!u || typeof u !== "object" || Array.isArray(u)) return u;
        if (!Object.prototype.hasOwnProperty.call(u, "password")) return u;
        const nu = { ...u };
        delete nu.password;
        return nu;
      });
    }
    next.admin = admin;
  }
  return next;
}

function siteConfigHasLegacyPassword(config) {
  const admin = config && config.admin;
  if (!admin || typeof admin !== "object" || Array.isArray(admin)) return false;
  if (Object.prototype.hasOwnProperty.call(admin, "password")) return true;
  const users = admin.users;
  if (!Array.isArray(users)) return false;
  return users.some(function (u) {
    return !!(u && typeof u === "object" && !Array.isArray(u) && Object.prototype.hasOwnProperty.call(u, "password"));
  });
}

function persistSiteConfigLocal(config) {
  const clean = sanitizeSiteConfigForStorage(config);
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(clean));
  return clean;
}

function getConfig() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.config), null);
  if (!saved) return sanitizeSiteConfigForStorage({ ...DEFAULT_CONFIG });

  // 緊急修復：若曾經把整份 config 覆蓋成只剩 frontend.vendorOptions，這裡要自動補回缺失的 admin（只補缺失欄位，不覆蓋既有資料）
  try {
    const s = saved && typeof saved === "object" ? saved : null;
    const hasAdmin = !!(s && s.admin && typeof s.admin === "object");
    if (!hasAdmin) {
      const patched = { ...s, admin: { ...(s.admin && typeof s.admin === "object" ? s.admin : {}), users: Array.isArray(s.admin && s.admin.users) ? s.admin.users : [] } };
      persistSiteConfigLocal(patched);
      return sanitizeSiteConfigForStorage(deepMerge(DEFAULT_CONFIG, patched));
    }
    const admin = s.admin || {};
    const needsUser = admin.username == null;
    if (needsUser) {
      const patched = {
        ...s,
        admin: {
          ...admin,
          username: String(admin.username || ""),
        },
      };
      persistSiteConfigLocal(patched);
      return sanitizeSiteConfigForStorage(deepMerge(DEFAULT_CONFIG, patched));
    }
  } catch {
    // 補 admin 失敗不應阻止後台使用（仍回傳 merge 結果）
  }

  const merged = sanitizeSiteConfigForStorage(deepMerge(DEFAULT_CONFIG, saved));
  try {
    if (siteConfigHasLegacyPassword(saved)) persistSiteConfigLocal(merged);
  } catch (_) {}
  return merged;
}

function saveConfig(nextConfig) {
  const clean = persistSiteConfigLocal(nextConfig);
  const opts = arguments[1] || {};
  const skipSupabase = opts && opts.skipSupabase;
  // 預設仍會 fire-and-forget 寫入 Supabase；後台若需要精準同步結果，可傳 skipSupabase: true 並自行呼叫 saveSiteConfigToSupabase
  if (!skipSupabase && window.DK?.saveSiteConfigToSupabase) {
    window.DK.saveSiteConfigToSupabase(clean).catch(() => {});
  }
}

function getConfigSyncMeta() {
  const raw = safeJsonParse(localStorage.getItem(STORAGE_KEYS.configSyncMeta), null);
  if (!raw || typeof raw !== "object") {
    return {
      currentSource: "local",
      lastCloudReadAt: null,
      lastCloudWriteAt: null,
      lastCloudSyncStatus: "never", // "never" | "success-read" | "success-write" | "failed"
      lastCloudError: null,
    };
  }
  return {
    currentSource: raw.currentSource || "local",
    lastCloudReadAt: raw.lastCloudReadAt || null,
    lastCloudWriteAt: raw.lastCloudWriteAt || null,
    lastCloudSyncStatus: raw.lastCloudSyncStatus || "never",
    lastCloudError: raw.lastCloudError || null,
  };
}

function saveConfigSyncMeta(patch) {
  const base = getConfigSyncMeta();
  const next = { ...base, ...(patch || {}) };
  try {
    localStorage.setItem(STORAGE_KEYS.configSyncMeta, JSON.stringify(next));
  } catch (_) {
    // meta 寫入失敗不應影響主要功能
  }
}

/** 正式庫存品類順序（顯示合併用；不批次改寫舊庫存資料） */
const PREFERRED_INVENTORY_CATEGORIES = [
  "處理器",
  "主機板",
  "記憶體",
  "硬碟",
  "顯示卡",
  "電源供應器",
  "機殼",
  "螢幕",
  "鍵盤",
  "滑鼠",
  "耳機",
  "周邊",
  "其他",
];

function getInventoryCategories() {
  const cfg = getConfig();
  let list = cfg.inventoryCategories;
  if (!Array.isArray(list) || list.length === 0) list = DEFAULT_CONFIG.inventoryCategories.slice();
  else list = list.slice().map((c) => String(c || "").trim()).filter(Boolean);

  // 確保正式品類存在（僅影響回傳清單，不覆寫 localStorage／不改舊品項）
  for (const c of PREFERRED_INVENTORY_CATEGORIES) {
    if (!list.includes(c)) list.push(c);
  }

  const seen = new Set();
  const ordered = [];
  for (const c of PREFERRED_INVENTORY_CATEGORIES) {
    if (list.includes(c) && !seen.has(c)) {
      ordered.push(c);
      seen.add(c);
    }
  }
  for (const c of list) {
    if (!seen.has(c)) {
      ordered.push(c);
      seen.add(c);
    }
  }
  return ordered;
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
    featuredHome: r.featured_home === true || String(r.featured_home).toLowerCase() === "true",
    featuredOrder: (() => {
      const n = typeof r.featured_order === "number" ? r.featured_order : Number(r.featured_order);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
    })(),
  }));
}

/**
 * Stage 6-3-2：inventory WRITE 通用 admin gate。
 * 只讀 Stage 4 runtime profile（__dkCurrentAuthProfile）。
 * 不讀 dk_admin_session_v1。真正安全邊界仍是 RLS。
 */
function requireVerifiedAdminCloudAccess() {
  if (!isAuthLoginModeSupabase()) {
    return {
      ok: false,
      notAuthenticated: true,
      forbidden: false,
      permissionDenied: false,
      code: "not_authenticated",
      error: "請先登入後台",
    };
  }
  const p = __dkCurrentAuthProfile;
  if (!p || typeof p !== "object") {
    return {
      ok: false,
      notAuthenticated: true,
      forbidden: false,
      permissionDenied: false,
      code: "not_authenticated",
      error: "請先登入後台",
    };
  }
  if (p.enabled === true && p.role === "admin") {
    return { ok: true };
  }
  return {
    ok: false,
    notAuthenticated: false,
    forbidden: true,
    permissionDenied: true,
    code: "permission_denied",
    error: "你沒有此資料權限",
  };
}

function inventoryWriteGateResult() {
  const gate = requireVerifiedAdminCloudAccess();
  if (gate.ok) return null;
  return {
    ok: false,
    notAuthenticated: !!gate.notAuthenticated,
    forbidden: !!gate.forbidden,
    permissionDenied: !!gate.permissionDenied,
    code: gate.code || (gate.notAuthenticated ? "not_authenticated" : "permission_denied"),
    error: gate.error || (gate.notAuthenticated ? "請先登入後台" : "你沒有此資料權限"),
  };
}

async function inventoryWriteFailFromResponse(res) {
  let errText = "";
  try {
    errText = await res.text();
  } catch (_) {}
  const t = String(errText || "").toLowerCase();
  const status = res && res.status;
  if (
    status === 401 &&
    /jwt expired|invalid jwt|not authenticated|no authorization|unauthoriz/.test(t) &&
    !/row-level security/.test(t)
  ) {
    return { ok: false, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
  }
  if (
    status === 401 ||
    status === 403 ||
    /row-level security|violates row-level|42501|permission denied|pgrst301/.test(t)
  ) {
    return {
      ok: false,
      forbidden: true,
      permissionDenied: true,
      code: "permission_denied",
      error: "你沒有此資料權限",
    };
  }
  console.warn("同步商品到 Supabase 失敗", status || "");
  return { ok: false, error: "雲端同步失敗" };
}

async function upsertInventoryItemToSupabase(item) {
  if (!item || !item.id) return { ok: true };
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const msg = "未設定 SUPABASE_URL 或 SUPABASE_ANON_KEY，上架僅存於本機。請在 shared.js 填寫並重新部署。";
    console.warn("[Supabase]", msg);
    return { ok: false, error: msg };
  }
  const denied = inventoryWriteGateResult();
  if (denied) return denied;
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) {
    return { ok: false, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
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
    featured_home: item.featuredHome === true || String(item.featuredHome).toLowerCase() === "true",
    featured_order: (() => {
      const n = typeof item.featuredOrder === "number" ? item.featuredOrder : Number(item.featuredOrder);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
    })(),
  };

  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_INVENTORY_TABLE}?on_conflict=id`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: auth.headers.apikey,
        Authorization: auth.headers.Authorization,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) return await inventoryWriteFailFromResponse(res);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: "雲端同步失敗" };
  }
}

async function deleteInventoryItemFromSupabase(id) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !id) return { ok: true };
  const denied = inventoryWriteGateResult();
  if (denied) return denied;
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) {
    return { ok: false, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
  }
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_INVENTORY_TABLE}?id=eq.${encodeURIComponent(
    String(id),
  )}`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: auth.headers.apikey,
        Authorization: auth.headers.Authorization,
      },
    });
    if (!res.ok) return await inventoryWriteFailFromResponse(res);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: "雲端同步失敗" };
  }
}

// ===== Supabase Storage：商品照片／站內資產上傳 =====
// Stage 6-4-2 S1：前端改 user JWT。bucket / path / public URL / x-upsert 不改。
// 真正 WRITE 邊界仍是 Storage RLS；本 gate 只擋未登入與 staff。不 fallback anon。

function storageWriteGateResult() {
  const gate = requireVerifiedAdminCloudAccess();
  if (gate.ok) return null;
  return {
    ok: false,
    url: null,
    notAuthenticated: !!gate.notAuthenticated,
    forbidden: !!gate.forbidden,
    permissionDenied: !!gate.permissionDenied,
    code: gate.code || (gate.notAuthenticated ? "not_authenticated" : "permission_denied"),
    error: gate.error || (gate.notAuthenticated ? "請先登入後台" : "你沒有此資料權限"),
  };
}

async function storageWriteFailFromResponse(res) {
  let errText = "";
  try {
    errText = await res.text();
  } catch (_) {}
  const t = String(errText || "").toLowerCase();
  const status = res && res.status;
  if (
    status === 401 &&
    /jwt expired|invalid jwt|not authenticated|no authorization|unauthoriz/.test(t) &&
    !/row-level security/.test(t)
  ) {
    return { ok: false, url: null, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
  }
  if (
    status === 401 ||
    status === 403 ||
    /row-level security|violates row-level|42501|permission denied|not allowed|unauthorized/.test(t)
  ) {
    return {
      ok: false,
      url: null,
      forbidden: true,
      permissionDenied: true,
      code: "permission_denied",
      error: "你沒有此資料權限",
    };
  }
  console.warn("[Supabase Storage] 上傳失敗", status || "");
  return { ok: false, url: null, error: "雲端同步失敗" };
}

async function uploadToSupabaseStorageBucket(bucket, blob, pathOrFilename, defaultFilename) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !bucket) {
    return { ok: false, url: null, error: "雲端同步失敗" };
  }
  const denied = storageWriteGateResult();
  if (denied) return denied;
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) {
    return { ok: false, url: null, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
  }
  const path = String(pathOrFilename || defaultFilename || "file.jpg").replace(/^\/+/, "");
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: auth.headers.apikey,
        Authorization: auth.headers.Authorization,
        "Content-Type": (blob && blob.type) || "image/jpeg",
        "x-upsert": "true",
      },
      body: blob,
    });
    if (!res.ok) return await storageWriteFailFromResponse(res);
    return { ok: true, url: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}` };
  } catch (_) {
    return { ok: false, url: null, error: "雲端同步失敗" };
  }
}

/** 上傳商品圖到 product-photos。成功回 { ok, url }；未登入／staff 不發 request。 */
async function uploadImageToSupabaseStorage(blob, pathOrFilename) {
  return uploadToSupabaseStorageBucket(SUPABASE_STORAGE_BUCKET, blob, pathOrFilename, "img.jpg");
}

/** 上傳站內資產到 site-assets。成功回 { ok, url }；未登入／staff 不發 request。 */
async function uploadSiteAssetToSupabaseStorage(blob, pathOrFilename) {
  return uploadToSupabaseStorageBucket(SUPABASE_SITE_ASSET_BUCKET, blob, pathOrFilename, "asset.jpg");
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
  if (!res.ok) {
    const errText = await res.text();
    saveConfigSyncMeta({
      lastCloudSyncStatus: "failed",
      lastCloudError: errText.slice(0, 200) || ("HTTP " + res.status),
    });
    return null;
  }
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object") return null;
  const merged = deepMerge(DEFAULT_CONFIG, raw);
  // 雲端舊資料若尚未有 homeStyle：保留本機已存的 homeStyle，避免被 DEFAULT 覆寫
  try {
    const cloudHasHomeStyle =
      raw.frontend &&
      Object.prototype.hasOwnProperty.call(raw.frontend, "homeStyle") &&
      raw.frontend.homeStyle &&
      typeof raw.frontend.homeStyle === "object";
    if (!cloudHasHomeStyle) {
      const local = safeJsonParse(localStorage.getItem(STORAGE_KEYS.config), null);
      const localHs = local && local.frontend && local.frontend.homeStyle;
      if (localHs && typeof localHs === "object") {
        merged.frontend = { ...(merged.frontend || {}), homeStyle: { ...localHs } };
      }
    }
  } catch (_) {}
  saveConfigSyncMeta({
    currentSource: "cloud",
    lastCloudSyncStatus: "success-read",
    lastCloudReadAt: new Date().toISOString(),
    lastCloudError: null,
  });
  return sanitizeSiteConfigForStorage(merged);
}

async function saveSiteConfigToSupabase(config) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !config || typeof config !== "object") {
    const msg = !SUPABASE_URL || !SUPABASE_ANON_KEY ? "Supabase 未設定" : "設定物件不合法";
    saveConfigSyncMeta({
      lastCloudSyncStatus: "failed",
      lastCloudError: msg,
    });
    return { ok: false, error: msg };
  }
  const denied = inventoryWriteGateResult();
  if (denied) {
    saveConfigSyncMeta({
      lastCloudSyncStatus: "failed",
      lastCloudError: denied.error,
    });
    return denied;
  }
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) {
    const fail = { ok: false, notAuthenticated: true, code: "not_authenticated", error: "請先登入後台" };
    saveConfigSyncMeta({
      lastCloudSyncStatus: "failed",
      lastCloudError: fail.error,
    });
    return fail;
  }
  const clean = sanitizeSiteConfigForStorage(config);
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_SITE_CONFIG_TABLE}?on_conflict=id`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: auth.headers.apikey,
        Authorization: auth.headers.Authorization,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify([{ id: SITE_CONFIG_ROW_ID, data: clean }]),
    });
    if (!res.ok) {
      const fail = await inventoryWriteFailFromResponse(res);
      saveConfigSyncMeta({
        lastCloudSyncStatus: "failed",
        lastCloudError: fail.error || "雲端同步失敗",
      });
      return fail;
    }
  } catch (_) {
    saveConfigSyncMeta({
      lastCloudSyncStatus: "failed",
      lastCloudError: "雲端同步失敗",
    });
    return { ok: false, error: "雲端同步失敗" };
  }
  saveConfigSyncMeta({
    lastCloudSyncStatus: "success-write",
    lastCloudWriteAt: new Date().toISOString(),
    lastCloudError: null,
  });
  return { ok: true };
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
// Stage 5B：user JWT；admin+staff。無 session 不 fallback anon。失敗不寫 localStorage。
// 本機在 GET await 期間寫入後，不得用該次舊雲端快照覆蓋 localStorage。
function bumpV2LocalWriteGen() {
  if (typeof window === "undefined") return;
  window.__dkV2LocalWriteGen = (Number(window.__dkV2LocalWriteGen) || 0) + 1;
}
if (typeof window !== "undefined") window.__dkBumpV2LocalWriteGen = bumpV2LocalWriteGen;

async function fetchV2DataFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const gate = requireVerifiedBackofficeCloudAccess();
  if (!gate.ok) return null;
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) return null;
  const genAtStart = typeof window !== "undefined" ? (Number(window.__dkV2LocalWriteGen) || 0) : 0;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_V2_DATA_TABLE}?id=eq.${encodeURIComponent(
    V2_DATA_ROW_ID,
  )}&select=data`;
  const res = await fetch(url, {
    headers: auth.headers,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const raw = rows?.[0]?.data;
  if (!raw || typeof raw !== "object") return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const ledger = Array.isArray(raw.ledger) ? raw.ledger : [];
  const orders = Array.isArray(raw.orders) ? raw.orders : [];
  const expenses = Array.isArray(raw.expenses) ? raw.expenses : [];
  const auditLogs = Array.isArray(raw.auditLogs) ? raw.auditLogs : [];
  try {
    if (typeof window !== "undefined" && (Number(window.__dkV2LocalWriteGen) || 0) !== genAtStart) {
      return null;
    }
    // 保護：雲端某欄為空陣列時，不要立刻覆蓋本機已有資料
    function pickWrite(key, cloudArr) {
      const localArr = safeJsonParse(localStorage.getItem(key), null);
      const localHas = Array.isArray(localArr) && localArr.length > 0;
      const cloudHas = Array.isArray(cloudArr) && cloudArr.length > 0;
      if (!cloudHas && localHas) return localArr;
      return Array.isArray(cloudArr) ? cloudArr : (localHas ? localArr : []);
    }
    const nextItems = pickWrite(V2_STORAGE_KEYS.items, items);
    const nextLedger = pickWrite(V2_STORAGE_KEYS.ledger, ledger);
    const nextOrders = pickWrite(V2_STORAGE_KEYS.orders, orders);
    const nextExpenses = pickWrite(V2_STORAGE_KEYS.expenses, expenses);
    const nextAudit = pickWrite(V2_STORAGE_KEYS.auditLogs, auditLogs);
    if (typeof window !== "undefined" && (Number(window.__dkV2LocalWriteGen) || 0) !== genAtStart) {
      return null;
    }
    localStorage.setItem(V2_STORAGE_KEYS.items, JSON.stringify(nextItems));
    localStorage.setItem(V2_STORAGE_KEYS.ledger, JSON.stringify(nextLedger));
    localStorage.setItem(V2_STORAGE_KEYS.orders, JSON.stringify(nextOrders));
    localStorage.setItem(V2_STORAGE_KEYS.expenses, JSON.stringify(nextExpenses));
    localStorage.setItem(V2_STORAGE_KEYS.auditLogs, JSON.stringify(nextAudit));
    return { items: nextItems, ledger: nextLedger, orders: nextOrders, expenses: nextExpenses, auditLogs: nextAudit };
  } catch (e) {
    return null;
  }
}

async function saveV2DataToSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, error: "Supabase 未設定（請在 shared.js 填寫 SUPABASE_URL 與 SUPABASE_ANON_KEY）" };
  }
  const gate = requireVerifiedBackofficeCloudAccess();
  if (!gate.ok) {
    return {
      ok: false,
      notAuthenticated: !!gate.notAuthenticated,
      forbidden: !!gate.forbidden,
      permissionDenied: !!gate.permissionDenied,
      error: gate.error || (gate.notAuthenticated ? "請先登入後台" : "你沒有此資料權限"),
    };
  }
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok || !auth.headers) {
    return { ok: false, notAuthenticated: true, error: "請先登入後台" };
  }
  let items = [];
  let ledger = [];
  let orders = [];
  let expenses = [];
  let auditLogs = [];
  try {
    items = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.items), []);
    ledger = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.ledger), []);
    orders = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.orders), []);
    expenses = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.expenses), []);
    auditLogs = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.auditLogs), []);
  } catch (e) {
    return { ok: false, error: "讀取本機資料失敗" };
  }
  const payload = {
    id: V2_DATA_ROW_ID,
    data: { items, ledger, orders, expenses, auditLogs },
  };
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_V2_DATA_TABLE}?on_conflict=id`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: auth.headers.apikey,
        Authorization: auth.headers.Authorization,
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      const errText = await res.text();
      const kind = vpRestClassifyHttp(res.status, errText);
      if (kind === "not_authenticated") {
        return { ok: false, notAuthenticated: true, error: "請先登入後台" };
      }
      if (kind === "forbidden") {
        return { ok: false, forbidden: true, permissionDenied: true, error: "你沒有此資料權限" };
      }
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

  // 更新分享用 meta（LINE / FB 預覽用）：og:title / og:description / og:image
  try {
    const fe = cfg.frontend || {};
    const ogTitle = fe.ogTitle || cfg.siteTitle || DEFAULT_CONFIG.siteTitle;
    const ogDescription = fe.ogDescription || fe.heroSub || cfg.brand.subtitle || "";
    const ogImage =
      fe.ogImageUrl && fe.ogImageUrl.trim()
        ? fe.ogImageUrl.trim()
        : (cfg.shop && cfg.shop.photoUrl && cfg.shop.photoUrl.trim()) || "";
    const ogTitleMeta = document.querySelector('meta[property="og:title"]');
    if (ogTitleMeta) ogTitleMeta.setAttribute("content", ogTitle);
    const ogDescMeta = document.querySelector('meta[property="og:description"]');
    if (ogDescMeta) ogDescMeta.setAttribute("content", ogDescription);
    const ogImgMeta = document.querySelector('meta[property="og:image"]');
    if (ogImgMeta && ogImage) ogImgMeta.setAttribute("content", ogImage);
  } catch (e) {
    // 安全失敗：若 meta 標籤不存在就略過，不中斷其他設定
  }

  const fe = cfg.frontend || {};
  const brandLogoUrl = (fe.brandLogo || "").trim();
  const brandLogoImg = document.getElementById("brandLogoImg");
  if (brandLogoImg) {
    if (brandLogoUrl) {
      brandLogoImg.src = brandLogoUrl;
      brandLogoImg.alt = cfg.brand.title || "";
      brandLogoImg.hidden = false;
    } else {
      brandLogoImg.removeAttribute("src");
      brandLogoImg.alt = "";
      brandLogoImg.hidden = true;
    }
  }
  const brandMark = document.getElementById("brandMark");
  if (brandMark) {
    brandMark.textContent = cfg.brand.mark;
    brandMark.hidden = !!brandLogoUrl;
  }
  const brandTitle = document.getElementById("brandTitle");
  if (brandTitle) brandTitle.textContent = cfg.brand.title;
  const brandSubtitle = document.getElementById("brandSubtitle");
  if (brandSubtitle) brandSubtitle.textContent = cfg.brand.subtitle;

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
  const catTitles = fe.catTitles || (typeof DK !== "undefined" && DK.DEFAULT_CONFIG?.frontend?.catTitles) || {};
  const catTitleDefaults = {
    office: "文書／上網／學生",
    "game-entry": "遊戲入門",
    "game-mid": "遊戲中階（主力）",
    work: "工作／效能取向",
    peripherals: "電腦周邊",
  };
  const catPriceDefaults = { office: "NT$ 3,000–6,000", "game-entry": "NT$ 7,000–12,000", "game-mid": "NT$ 13,000–20,000", work: "NT$ 18,000+", peripherals: "價格依品項" };
  document.querySelectorAll(".cat-card[data-cat]").forEach((card) => {
    const cat = card.dataset.cat;
    if (cat === "all") return;
    const titleEl = card.querySelector(".cat-card-title");
    if (titleEl) titleEl.textContent = (catTitles[cat] || catTitleDefaults[cat] || "").trim() || catTitleDefaults[cat];
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

  // 首頁視覺效果（僅外觀；缺欄位用預設，不影響其他設定）
  try {
    applyHomeStyleToPage(cfg.frontend && cfg.frontend.homeStyle);
  } catch (_) {}
}

/** 正規化 frontend.homeStyle；缺欄位時安全預設，不寫回 storage */
function getDefaultHomeStyle() {
  const def = (DEFAULT_CONFIG.frontend && DEFAULT_CONFIG.frontend.homeStyle) || {};
  return {
    heroContentPosition: def.heroContentPosition || "left",
    heroOverlayStrength: Number.isFinite(Number(def.heroOverlayStrength)) ? Number(def.heroOverlayStrength) : 70,
    heroAccentGlow: def.heroAccentGlow !== false,
    sectionReveal: def.sectionReveal !== false,
    mouseGlow: def.mouseGlow !== false,
    cardTilt: def.cardTilt === true,
  };
}

function normalizeHomeStyle(raw) {
  const base = getDefaultHomeStyle();
  const src = raw && typeof raw === "object" ? raw : {};
  const pos = String(src.heroContentPosition || base.heroContentPosition || "left").toLowerCase();
  const position = pos === "center" || pos === "right" || pos === "left" ? pos : "left";
  let strength = Number(src.heroOverlayStrength);
  if (!Number.isFinite(strength)) strength = base.heroOverlayStrength;
  if (strength < 40) strength = 40;
  if (strength > 90) strength = 90;
  return {
    heroContentPosition: position,
    heroOverlayStrength: Math.round(strength),
    heroAccentGlow: src.heroAccentGlow == null ? base.heroAccentGlow : !!src.heroAccentGlow,
    sectionReveal: src.sectionReveal == null ? base.sectionReveal : !!src.sectionReveal,
    mouseGlow: src.mouseGlow == null ? base.mouseGlow : !!src.mouseGlow,
    cardTilt: src.cardTilt == null ? base.cardTilt : !!src.cardTilt,
  };
}

function applyHomeStyleToPage(rawStyle) {
  if (typeof document === "undefined" || !document.body) return normalizeHomeStyle(rawStyle);
  if (!document.body.classList.contains("home-page")) return normalizeHomeStyle(rawStyle);
  const hs = normalizeHomeStyle(rawStyle);
  document.body.dataset.dkHeroPos = hs.heroContentPosition;
  document.body.dataset.dkHeroOverlay = String(hs.heroOverlayStrength);
  document.body.dataset.dkHeroGlow = hs.heroAccentGlow ? "1" : "0";
  document.body.dataset.dkSectionReveal = hs.sectionReveal ? "1" : "0";
  document.body.dataset.dkMouseGlow = hs.mouseGlow ? "1" : "0";
  document.body.dataset.dkCardTilt = hs.cardTilt ? "1" : "0";
  document.body.style.setProperty("--dk-hero-overlay-strength", String(hs.heroOverlayStrength));
  document.body.classList.toggle("dk-reveal-off", !hs.sectionReveal);
  document.body.classList.toggle("dk-mouse-glow-off", !hs.mouseGlow);
  document.body.classList.toggle("dk-card-tilt-on", !!hs.cardTilt);
  document.body.classList.toggle("dk-hero-glow-off", !hs.heroAccentGlow);
  return hs;
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

const ADMIN_ROLE_LABEL = { admin: "管理員", staff: "員工" };
const STAFF_ALLOWED_PERMS = {
  inv: true,
  items: true,
  restock: true,
  editItem: true,
  orders: true,
  customers: true,
  quoteImage: true,
};
const ADMIN_ONLY_PERMS = {
  accounts: true,
  frontend: true,
  publish: true,
  vendors: true,
  purchase: true,
  settings: true,
  sync: true,
  deleteItem: true,
  deleteOrder: true,
  deleteCustomer: true,
  deleteExpense: true,
  ledger: true,
  expenses: true,
  reports: true,
  viewCost: true,
};

function omitLegacyPassword(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  if (!Object.prototype.hasOwnProperty.call(obj, "password")) return obj;
  const next = { ...obj };
  delete next.password;
  return next;
}

function mergeAdminUsers(cloudUsers, localUsers) {
  const a = Array.isArray(cloudUsers) ? cloudUsers : [];
  const b = Array.isArray(localUsers) ? localUsers : [];
  if (!a.length) return b.map(omitLegacyPassword);
  if (!b.length) return a.map(omitLegacyPassword);
  const byId = new Map();
  function ingest(list) {
    list.forEach((u) => {
      if (!u || typeof u !== "object") return;
      const id = String(u.id || "").trim();
      if (!id) return;
      const next = omitLegacyPassword(u);
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, next);
        return;
      }
      const ta = Date.parse(prev.updatedAt || prev.createdAt || 0) || 0;
      const tb = Date.parse(next.updatedAt || next.createdAt || 0) || 0;
      byId.set(id, tb >= ta ? next : prev);
    });
  }
  ingest(a);
  ingest(b);
  return Array.from(byId.values());
}

function mergeAdminConfig(cloudAdmin, localAdmin) {
  const cloud = cloudAdmin && typeof cloudAdmin === "object" ? cloudAdmin : {};
  const local = localAdmin && typeof localAdmin === "object" ? localAdmin : {};
  const merged = omitLegacyPassword({ ...cloud, ...local });
  const cloudUsers = Array.isArray(cloud.users) ? cloud.users : [];
  const localUsers = Array.isArray(local.users) ? local.users : [];
  if (cloudUsers.length || localUsers.length) {
    merged.users = mergeAdminUsers(cloudUsers, localUsers);
  }
  const lu = local.username;
  if (lu != null && String(lu).trim() !== "") merged.username = lu;
  return merged;
}

function normalizeAdminUser(u) {
  if (!u || typeof u !== "object") return null;
  const id = String(u.id || "").trim();
  const username = String(u.username || "").trim();
  if (!id || !username) return null;
  return {
    id,
    username,
    displayName: String(u.displayName || username).trim() || username,
    role: u.role === "staff" ? "staff" : "admin",
    enabled: u.enabled !== false,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

function legacyAdminUserFromConfig(admin) {
  const username = String((admin && admin.username) || "").trim();
  if (!username) return null;
  return {
    id: "user-legacy-admin",
    username,
    displayName: "管理員",
    role: "admin",
    enabled: true,
    createdAt: null,
    updatedAt: null,
  };
}

function getAdminUsers() {
  const cfg = getConfig();
  const admin = (cfg && cfg.admin) || {};
  const raw = Array.isArray(admin.users) ? admin.users : [];
  const users = raw.map(normalizeAdminUser).filter(Boolean);
  if (users.length) return users;
  const legacy = legacyAdminUserFromConfig(admin);
  return legacy ? [legacy] : [];
}

function findAdminUserByCredentials(username, password) {
  // Stage 6-2：保留函式供 rollback 編譯，但 config 不再保存明文密碼；legacy password login 不再保證可用。
  const u = String(username || "").trim();
  const p = String(password ?? "");
  if (!u || p === "") return null;
  const users = getAdminUsers();
  const found = users.find((x) => x.username === u && String(x.password ?? "") === p);
  if (found) return found;
  const cfg = getConfig();
  const admin = (cfg && cfg.admin) || {};
  const lu = String(admin.username || "").trim();
  const lp = String(admin.password ?? "");
  if (lu && lp && u === lu && p === lp) return legacyAdminUserFromConfig(admin);
  return null;
}

function hasEnabledAdminAccount() {
  return getAdminUsers().some((u) => u.role === "admin" && u.enabled !== false && String(u.password ?? "") !== "");
}

function ensureAdminUsersPersisted() {
  const cfg = getConfig();
  const admin = (cfg && cfg.admin) || {};
  if (Array.isArray(admin.users) && admin.users.length) return cfg;
  const users = getAdminUsers();
  if (!users.length) return cfg;
  const next = { ...cfg, admin: omitLegacyPassword({ ...admin, users }) };
  saveConfig(next);
  return next;
}

function saveAdminUsers(nextUsers, opts) {
  const cfg = getConfig();
  const admin = (cfg && cfg.admin) || {};
  const list = (Array.isArray(nextUsers) ? nextUsers : []).map(normalizeAdminUser).filter(Boolean);
  const nextAdmin = omitLegacyPassword({ ...admin, users: list });
  const primary =
    list.find((u) => u.id === "user-legacy-admin") ||
    list.find((u) => u.role === "admin" && u.enabled);
  if (primary) {
    nextAdmin.username = primary.username;
  }
  const next = { ...cfg, admin: nextAdmin };
  saveConfig(next, opts);
  return next;
}

function getAdminSession() {
  const raw = safeJsonParse(localStorage.getItem(STORAGE_KEYS.adminSession), null);
  if (!raw || typeof raw !== "object") return null;
  const userId = String(raw.userId || "").trim();
  const username = String(raw.username || "").trim();
  const role = raw.role === "staff" ? "staff" : raw.role === "admin" ? "admin" : "";
  const loginAt = String(raw.loginAt || "").trim();
  if (!userId || !username || !role || !loginAt) return null;
  return {
    userId,
    username,
    displayName: String(raw.displayName || raw.username || ""),
    role,
    loginAt,
  };
}

function setAdminSession(session) {
  if (!session || typeof session !== "object") {
    localStorage.removeItem(STORAGE_KEYS.adminSession);
    localStorage.removeItem(STORAGE_KEYS.adminAuthed);
    return;
  }
  const payload = {
    userId: String(session.userId || "").trim(),
    username: String(session.username || "").trim(),
    displayName: String(session.displayName || session.username || "").trim(),
    role: session.role === "staff" ? "staff" : session.role === "admin" ? "admin" : "",
    loginAt: String(session.loginAt || "").trim() || new Date().toISOString(),
  };
  if (!payload.userId || !payload.username || !payload.role || !payload.loginAt) {
    localStorage.removeItem(STORAGE_KEYS.adminSession);
    localStorage.removeItem(STORAGE_KEYS.adminAuthed);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.adminSession, JSON.stringify(payload));
  localStorage.setItem(STORAGE_KEYS.adminAuthed, "1");
}

function resolveLiveAdminUser(session) {
  if (!session || !session.userId || !session.username || !session.role || !session.loginAt) return null;
  const users = getAdminUsers();
  let live = users.find((u) => u.id === session.userId);
  if (!live) live = users.find((u) => u.username === session.username);
  if (!live || live.enabled === false) return null;
  if (String(live.password ?? "") === "") return null;
  return live;
}

let __dkCurrentAuthProfile = null;

function isAuthLoginModeSupabase() {
  return AUTH_LOGIN_MODE === "supabase";
}

function getAuthLoginMode() {
  return AUTH_LOGIN_MODE === "legacy" ? "legacy" : "supabase";
}

function isAdminAuthed() {
  if (isAuthLoginModeSupabase()) {
    const p = __dkCurrentAuthProfile;
    return !!(p && p.enabled === true && (p.role === "admin" || p.role === "staff") && p.username);
  }
  return !!resolveLiveAdminUser(getAdminSession());
}

function setAdminAuthed(v) {
  if (isAuthLoginModeSupabase()) {
    if (!v) {
      __dkCurrentAuthProfile = null;
      localStorage.removeItem(STORAGE_KEYS.adminAuthed);
      localStorage.removeItem(STORAGE_KEYS.adminSession);
    }
    return;
  }
  if (v) {
    if (resolveLiveAdminUser(getAdminSession())) {
      localStorage.setItem(STORAGE_KEYS.adminAuthed, "1");
    }
    return;
  }
  localStorage.removeItem(STORAGE_KEYS.adminAuthed);
  localStorage.removeItem(STORAGE_KEYS.adminSession);
}

function getCurrentAdminUser() {
  if (isAuthLoginModeSupabase()) {
    const p = __dkCurrentAuthProfile;
    if (!p || p.enabled !== true || (p.role !== "admin" && p.role !== "staff")) return null;
    const session = getAdminSession();
    return {
      userId: String(p.id || (session && session.userId) || ""),
      username: p.username,
      displayName: p.displayName || p.username,
      role: p.role,
      enabled: true,
      loginAt: (session && session.loginAt) || "",
    };
  }
  const session = getAdminSession();
  const live = resolveLiveAdminUser(session);
  if (!live) return null;
  return {
    userId: live.id,
    username: live.username,
    displayName: live.displayName,
    role: live.role,
    enabled: true,
    loginAt: session.loginAt,
  };
}

function getCurrentRole() {
  const u = getCurrentAdminUser();
  return (u && u.role) || "";
}

function roleLabel(role) {
  return ADMIN_ROLE_LABEL[role] || "未登入";
}

function canPermission(perm) {
  const role = getCurrentRole();
  if (role === "admin") return true;
  if (role !== "staff") return false;
  const key = String(perm || "");
  if (ADMIN_ONLY_PERMS[key]) return false;
  return !!STAFF_ALLOWED_PERMS[key];
}

function requirePermission(perm) {
  if (canPermission(perm)) return true;
  try {
    alert("你沒有此操作權限");
  } catch (_) {}
  return false;
}

function validateAdminSession() {
  if (isAuthLoginModeSupabase()) {
    if (!isAdminAuthed()) return { ok: false, reason: "unauthed" };
    return { ok: true, user: getCurrentAdminUser() };
  }
  const session = getAdminSession();
  const live = resolveLiveAdminUser(session);
  if (!live) {
    if (session || localStorage.getItem(STORAGE_KEYS.adminAuthed) === "1") {
      setAdminAuthed(false);
    }
    return { ok: false, reason: session ? "invalid" : "unauthed" };
  }
  setAdminSession({
    userId: live.id,
    username: live.username,
    displayName: live.displayName,
    role: live.role,
    loginAt: session.loginAt,
  });
  return {
    ok: true,
    user: {
      userId: live.id,
      username: live.username,
      displayName: live.displayName,
      role: live.role,
      enabled: true,
      loginAt: session.loginAt,
    },
  };
}

function clearAdminUiSessionCache() {
  __dkCurrentAuthProfile = null;
  try {
    localStorage.removeItem(STORAGE_KEYS.adminAuthed);
    localStorage.removeItem(STORAGE_KEYS.adminSession);
  } catch (_) {}
}

function clearProjectSupabaseAuthStorage() {
  try {
    localStorage.removeItem(SUPABASE_AUTH_STORAGE_KEY);
  } catch (_) {}
  try {
    if (typeof __dkSupabaseAuthClient !== "undefined") __dkSupabaseAuthClient = null;
    if (typeof __dkSupabaseAuthClientPromise !== "undefined") __dkSupabaseAuthClientPromise = null;
  } catch (_) {}
}

async function signOutSupabaseAuthKeepGoing(client) {
  let apiOk = false;
  try {
    if (client && client.auth && typeof client.auth.signOut === "function") {
      const result = await client.auth.signOut({ scope: "local" });
      apiOk = !(result && result.error);
    }
  } catch (_) {
    apiOk = false;
  }
  if (!apiOk) {
    try {
      if (client && client.auth && typeof client.auth.stopAutoRefresh === "function") {
        client.auth.stopAutoRefresh();
      }
    } catch (_) {}
    clearProjectSupabaseAuthStorage();
  }
  return apiOk;
}

function applyVerifiedAuthProfile(userId, profile, loginAt) {
  __dkCurrentAuthProfile = {
    id: String(userId || ""),
    username: profile.username,
    displayName: profile.displayName || profile.username,
    role: profile.role,
    enabled: true,
  };
  setAdminSession({
    userId: String(userId || ""),
    username: profile.username,
    displayName: profile.displayName || profile.username,
    role: profile.role,
    loginAt: loginAt || new Date().toISOString(),
  });
}

async function validateSupabaseAdminSession() {
  if (!isAuthLoginModeSupabase()) return validateAdminSession();
  try {
    const client = await getSupabaseAuthClient();
    if (!client || !client.auth) {
      __dkCurrentAuthProfile = null;
      return { ok: false, reason: "network" };
    }
    const sessionResult = await client.auth.getSession();
    if (sessionResult && sessionResult.error) {
      __dkCurrentAuthProfile = null;
      return { ok: false, reason: "network" };
    }
    const session = sessionResult && sessionResult.data && sessionResult.data.session;
    const sessionUser = session && session.user;
    if (!sessionUser || !sessionUser.id) {
      clearAdminUiSessionCache();
      return { ok: false, reason: "unauthed" };
    }
    let user = sessionUser;
    if (typeof client.auth.getUser === "function") {
      const userResult = await client.auth.getUser();
      if (userResult && userResult.error) {
        const status = Number((userResult.error && userResult.error.status) || 0);
        const msg = String((userResult.error && userResult.error.message) || "").toLowerCase();
        const invalid = status === 401 || status === 403 || /invalid|expired|not authenticated|user from sub claim/.test(msg);
        if (invalid) {
          await signOutSupabaseAuthKeepGoing(client);
          clearAdminUiSessionCache();
          return { ok: false, reason: "unauthed" };
        }
        __dkCurrentAuthProfile = null;
        return { ok: false, reason: "network" };
      }
      user = (userResult && userResult.data && userResult.data.user) || null;
      if (!user || !user.id) {
        await signOutSupabaseAuthKeepGoing(client);
        clearAdminUiSessionCache();
        return { ok: false, reason: "unauthed" };
      }
    }
    const fetched = await fetchOwnAuthProfile(client, user.id);
    if (fetched.errorCode === "network") {
      __dkCurrentAuthProfile = null;
      return { ok: false, reason: "network" };
    }
    const row = fetched.row;
    if (!row) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, reason: "profile_missing" };
    }
    if (String(row.id || "") !== String(user.id)) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, reason: "username_mismatch" };
    }
    const profile = sanitizeAuthProfileRow(row);
    if (!profile || (profile.role !== "admin" && profile.role !== "staff")) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, reason: "role_invalid" };
    }
    if (profile.enabled !== true) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, reason: "profile_disabled" };
    }
    const mapped = adminUsernameToAuthEmail(profile.username);
    const email = String(user.email || "").trim().toLowerCase();
    if (!mapped || mapped !== email) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, reason: "username_mismatch" };
    }
    const prev = getAdminSession();
    const loginAt = prev && prev.userId === String(user.id) && prev.loginAt ? prev.loginAt : new Date().toISOString();
    applyVerifiedAuthProfile(user.id, profile, loginAt);
    return { ok: true, reason: "ok", user: getCurrentAdminUser() };
  } catch (_) {
    __dkCurrentAuthProfile = null;
    return { ok: false, reason: "network" };
  }
}

async function signInSupabaseAdmin(username, password) {
  try {
    const email = adminUsernameToAuthEmail(username);
    if (!email || String(password ?? "") === "") return { ok: false, code: "auth_failed" };
    const client = await getSupabaseAuthClient();
    if (!client || !client.auth || typeof client.auth.signInWithPassword !== "function") {
      return { ok: false, code: "network" };
    }
    const signed = await client.auth.signInWithPassword({ email: email, password: String(password) });
    if (signed && signed.error) {
      return { ok: false, code: classifySupabaseAuthSignInError(signed.error) };
    }
    const user = signed && signed.data && signed.data.user;
    if (!user || !user.id) return { ok: false, code: "auth_failed" };
    const fetched = await fetchOwnAuthProfile(client, user.id);
    if (fetched.errorCode === "network") {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "network" };
    }
    const row = fetched.row;
    if (!row) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "profile_missing" };
    }
    if (String(row.id || "") !== String(user.id)) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "username_mismatch" };
    }
    const profile = sanitizeAuthProfileRow(row);
    if (!profile || (profile.role !== "admin" && profile.role !== "staff")) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "role_invalid" };
    }
    if (String(profile.username || "").trim().toLowerCase() !== String(username || "").trim().toLowerCase()) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "username_mismatch" };
    }
    if (profile.enabled !== true) {
      await signOutSupabaseAuthKeepGoing(client);
      clearAdminUiSessionCache();
      return { ok: false, code: "profile_disabled" };
    }
    applyVerifiedAuthProfile(user.id, profile, new Date().toISOString());
    return { ok: true, code: "ok", profile: profile };
  } catch (_) {
    return { ok: false, code: "network" };
  }
}

async function signOutSupabaseAdmin() {
  const client = await getSupabaseAuthClient().catch(function () { return null; });
  const apiOk = await signOutSupabaseAuthKeepGoing(client);
  clearAdminUiSessionCache();
  return { ok: true, apiOk: apiOk };
}

function loadAuditLogs() {
  const raw = safeJsonParse(localStorage.getItem(V2_STORAGE_KEYS.auditLogs), []);
  return Array.isArray(raw) ? raw : [];
}

function saveAuditLogs(list) {
  const next = Array.isArray(list) ? list.slice(0, 400) : [];
  localStorage.setItem(V2_STORAGE_KEYS.auditLogs, JSON.stringify(next));
  bumpV2LocalWriteGen();
}

function appendAuditLog(entry) {
  try {
    const user = getCurrentAdminUser() || {};
    const row = {
      id: "aud-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      userId: String(user.userId || ""),
      displayName: String(user.displayName || ""),
      action: String((entry && entry.action) || ""),
      targetId: String((entry && entry.targetId) || ""),
      timestamp: new Date().toISOString(),
    };
    const list = loadAuditLogs();
    list.unshift(row);
    saveAuditLogs(list);
    if (typeof window.__syncV2ToSupabase === "function" && !window._suppressV2Sync) {
      window.__syncV2ToSupabase().catch(function () {});
    }
    return row;
  } catch (_) {
    return null;
  }
}

// ===== 廠商報價＋採購叫貨單雲端同步 1.0（Stage 5A：user JWT；不再用 anon 讀寫這兩張表）=====
const SUPABASE_VENDOR_QUOTES_TABLE = "vendor_quotes";
const SUPABASE_PURCHASE_ORDERS_TABLE = "purchase_orders";
const VP_STORAGE_KEYS = {
  vendorQuotes: "dk_vendor_quotes_v1",
  purchaseOrders: "dk_purchase_orders_v1",
  vendorQuotesMeta: "dk_vendor_quotes_sync_meta_v1",
  purchaseOrdersMeta: "dk_purchase_orders_sync_meta_v1",
};

/** @type {{ applyingCloud: boolean, vendorPull: boolean, purchasePull: boolean }} */
const __dkVpSyncGuard = { applyingCloud: false, vendorPull: false, purchasePull: false };

function vpNowISO() {
  return new Date().toISOString();
}

function vpParseTs(v) {
  if (v == null || v === "") return 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

function vpIsDeleted(rec) {
  const d = rec && (rec.deletedAt != null ? rec.deletedAt : rec.deleted_at);
  return d != null && String(d).trim() !== "";
}

function vpDefaultMeta() {
  return {
    status: "never", // never | not_enabled | syncing | synced | pending_local | failed
    lastSyncAt: null,
    lastError: null,
    localCount: 0,
    cloudCount: 0,
    source: "local",
    conflictWarnings: [],
    cloudEnabled: false,
  };
}

function vpGetMeta(metaKey) {
  const raw = safeJsonParse(localStorage.getItem(metaKey), null);
  return raw && typeof raw === "object" ? { ...vpDefaultMeta(), ...raw } : vpDefaultMeta();
}

function vpSaveMeta(metaKey, patch) {
  const next = { ...vpGetMeta(metaKey), ...(patch || {}) };
  try {
    localStorage.setItem(metaKey, JSON.stringify(next));
  } catch (_) {}
  return next;
}

function vpIsNotEnabledError(status, errText) {
  const t = String(errText || "");
  if (status === 404 || status === 406) return true;
  return /does not exist|Could not find the table|PGRST205|PGRST116|42P01|relation .* does not exist/i.test(t);
}

function vpRestClassifyHttp(status, errText) {
  if (vpIsNotEnabledError(status, errText)) return "not_enabled";
  const t = String(errText || "").toLowerCase();
  if (status === 401) {
    if (/jwt expired|invalid jwt|not authenticated|no authorization|unauthoriz/.test(t) && !/row-level security/.test(t)) {
      return "not_authenticated";
    }
    return "forbidden";
  }
  if (status === 403) return "forbidden";
  if (/row-level security|violates row-level|42501|permission denied|pgrst301/.test(t)) {
    return "forbidden";
  }
  return "error";
}

function vpCloudUserMessage(res) {
  if (!res) return null;
  if (res.notAuthenticated) return "請先登入後台";
  if (res.forbidden || res.permissionDenied) return "你沒有此資料權限";
  return null;
}

/**
 * vendor / purchase 發 REST 前的 UI 防呆。
 * 只讀 Stage 4 已驗證的 runtime profile（__dkCurrentAuthProfile），
 * 不讀 dk_admin_session_v1。真正安全邊界仍是 RLS。
 */
function vpRequireVerifiedAdminCloudAccess() {
  if (!isAuthLoginModeSupabase()) {
    return vpRestDeniedResult({ notAuthenticated: true, error: "請先登入後台" });
  }
  const p = __dkCurrentAuthProfile;
  if (!p || typeof p !== "object") {
    return vpRestDeniedResult({ notAuthenticated: true, error: "請先登入後台" });
  }
  if (p.role === "admin" && p.enabled === true) {
    return { ok: true };
  }
  const denied = vpRestDeniedResult({
    forbidden: true,
    permissionDenied: true,
    error: "你沒有此資料權限",
  });
  denied.code = "permission_denied";
  return denied;
}

/**
 * Stage 5B：v2_data 過渡期。admin 或 staff（enabled）都可發 REST。
 * 只讀 __dkCurrentAuthProfile，不讀 dk_admin_session_v1。
 * 真正安全邊界仍是 RLS。staff 技術上仍能取得整包 JSONB（含成本）。
 */
function requireVerifiedBackofficeCloudAccess() {
  if (!isAuthLoginModeSupabase()) {
    return vpRestDeniedResult({ notAuthenticated: true, error: "請先登入後台" });
  }
  const p = __dkCurrentAuthProfile;
  if (!p || typeof p !== "object") {
    return vpRestDeniedResult({ notAuthenticated: true, error: "請先登入後台" });
  }
  if (p.enabled === true && (p.role === "admin" || p.role === "staff")) {
    return { ok: true };
  }
  const denied = vpRestDeniedResult({
    forbidden: true,
    permissionDenied: true,
    error: "你沒有此資料權限",
  });
  denied.code = "permission_denied";
  return denied;
}

function vpNumOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function vpReadLocalArray(storageKey) {
  const raw = safeJsonParse(localStorage.getItem(storageKey), null);
  return Array.isArray(raw) ? raw.filter((x) => x && typeof x === "object") : [];
}

function vpWriteLocalArray(storageKey, list) {
  localStorage.setItem(storageKey, JSON.stringify(Array.isArray(list) ? list : []));
}

function vpActiveCount(list) {
  return (list || []).filter((x) => !vpIsDeleted(x)).length;
}

function vpEnsureTimestamps(rec, { forceUpdated } = {}) {
  const out = { ...(rec && typeof rec === "object" ? rec : {}) };
  const now = vpNowISO();
  if (!out.createdAt && !out.created_at) out.createdAt = now;
  else if (!out.createdAt && out.created_at) out.createdAt = String(out.created_at);
  if (forceUpdated || (!out.updatedAt && !out.updated_at)) out.updatedAt = now;
  else if (!out.updatedAt && out.updated_at) out.updatedAt = String(out.updated_at);
  return out;
}

/** 依 id 合併；較新 updatedAt 優先；時間相同取雲端並記警告；tombstone 視為一版 */
function vpMergeByUpdatedAt(localList, cloudList) {
  const map = new Map();
  const warnings = [];
  for (const item of localList || []) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    map.set(id, item);
  }
  for (const cloud of cloudList || []) {
    const id = String(cloud?.id || "").trim();
    if (!id) continue;
    const local = map.get(id);
    if (!local) {
      map.set(id, cloud);
      continue;
    }
    const lt = vpParseTs(local.updatedAt || local.updated_at);
    const ct = vpParseTs(cloud.updatedAt || cloud.updated_at);
    if (ct > lt) {
      map.set(id, cloud);
    } else if (ct === lt) {
      warnings.push({ id, reason: "equal_updated_at", kept: "cloud" });
      map.set(id, cloud);
    }
    // ct < lt：保留本機（含較新的 tombstone）
  }
  return { list: Array.from(map.values()), warnings };
}

function vendorQuoteToCloudRow(q) {
  const stamped = vpEnsureTimestamps(q);
  const deletedAt = stamped.deletedAt || stamped.deleted_at || null;
  const dataJson = { ...stamped };
  return {
    id: String(stamped.id),
    date: stamped.date != null ? String(stamped.date) : null,
    vendor: stamped.vendor != null ? String(stamped.vendor) : null,
    category: stamped.category != null ? String(stamped.category) : null,
    brand: stamped.brand != null ? String(stamped.brand) : null,
    spec: stamped.spec != null ? String(stamped.spec) : null,
    price: vpNumOrNull(stamped.price),
    market_price: vpNumOrNull(stamped.marketPrice != null ? stamped.marketPrice : stamped.market_price),
    note: stamped.note != null ? String(stamped.note) : null,
    created_at: stamped.createdAt || stamped.created_at || null,
    updated_at: stamped.updatedAt || stamped.updated_at || vpNowISO(),
    deleted_at: deletedAt ? String(deletedAt) : null,
    data_json: dataJson,
  };
}

function cloudRowToVendorQuote(row) {
  const j = row?.data_json && typeof row.data_json === "object" && !Array.isArray(row.data_json) ? { ...row.data_json } : {};
  const price = row.price != null ? vpNumOrNull(row.price) : vpNumOrNull(j.price);
  const marketPrice =
    row.market_price != null ? vpNumOrNull(row.market_price) : vpNumOrNull(j.marketPrice != null ? j.marketPrice : j.market_price);
  return {
    ...j,
    id: String(row.id || j.id || ""),
    date: row.date != null ? String(row.date) : String(j.date || ""),
    vendor: row.vendor != null ? String(row.vendor) : String(j.vendor || ""),
    category: row.category != null ? String(row.category) : String(j.category || ""),
    brand: row.brand != null ? String(row.brand) : String(j.brand || ""),
    spec: row.spec != null ? String(row.spec) : String(j.spec || ""),
    price,
    marketPrice,
    note: row.note != null ? String(row.note) : String(j.note || ""),
    taxIncluded: !!(j.taxIncluded),
    shippingIncluded: !!(j.shippingIncluded),
    warranty: String(j.warranty || ""),
    inStock: !!(j.inStock),
    createdAt: row.created_at || j.createdAt || j.created_at || null,
    updatedAt: row.updated_at || j.updatedAt || j.updated_at || null,
    deletedAt: row.deleted_at || j.deletedAt || j.deleted_at || null,
  };
}

function purchaseOrderToCloudRow(o) {
  const stamped = vpEnsureTimestamps(o);
  const deletedAt = stamped.deletedAt || stamped.deleted_at || null;
  const items = Array.isArray(stamped.items) ? stamped.items : [];
  const dataJson = { ...stamped, items };
  return {
    id: String(stamped.id),
    order_no: stamped.orderNo != null ? String(stamped.orderNo) : String(stamped.order_no || ""),
    status: stamped.status != null ? String(stamped.status) : "draft",
    created_at: stamped.createdAt || stamped.created_at || null,
    updated_at: stamped.updatedAt || stamped.updated_at || vpNowISO(),
    supplier_order_date:
      stamped.supplierOrderDate != null
        ? String(stamped.supplierOrderDate)
        : String(stamped.supplier_order_date || ""),
    expected_date:
      stamped.expectedDate != null ? String(stamped.expectedDate) : String(stamped.expected_date || ""),
    note: stamped.note != null ? String(stamped.note) : null,
    items_json: items,
    deleted_at: deletedAt ? String(deletedAt) : null,
    data_json: dataJson,
  };
}

function cloudRowToPurchaseOrder(row) {
  const j = row?.data_json && typeof row.data_json === "object" && !Array.isArray(row.data_json) ? { ...row.data_json } : {};
  const itemsFromCol = Array.isArray(row.items_json) ? row.items_json : null;
  const itemsFromJson = Array.isArray(j.items) ? j.items : [];
  return {
    ...j,
    id: String(row.id || j.id || ""),
    orderNo: row.order_no != null ? String(row.order_no) : String(j.orderNo || j.order_no || ""),
    status: row.status != null ? String(row.status) : String(j.status || "draft"),
    createdAt: row.created_at || j.createdAt || j.created_at || null,
    updatedAt: row.updated_at || j.updatedAt || j.updated_at || null,
    supplierOrderDate:
      row.supplier_order_date != null
        ? String(row.supplier_order_date)
        : String(j.supplierOrderDate || j.supplier_order_date || ""),
    expectedDate:
      row.expected_date != null ? String(row.expected_date) : String(j.expectedDate || j.expected_date || ""),
    note: row.note != null ? String(row.note) : String(j.note || ""),
    items: itemsFromCol || itemsFromJson,
    deletedAt: row.deleted_at || j.deletedAt || j.deleted_at || null,
  };
}

function vpRestDeniedResult(authOrKind, extra) {
  const extraObj = extra || {};
  const notAuthenticated = !!(authOrKind && (authOrKind.notAuthenticated || authOrKind === "not_authenticated"));
  const forbidden = !!(authOrKind && (authOrKind.forbidden || authOrKind === "forbidden" || authOrKind.permissionDenied));
  const permissionDenied = !!(authOrKind && (authOrKind.permissionDenied || forbidden));
  const error =
    (authOrKind && authOrKind.error) ||
    (notAuthenticated ? "請先登入後台" : forbidden ? "你沒有此資料權限" : "同步失敗");
  return {
    ok: false,
    notEnabled: false,
    notAuthenticated,
    forbidden,
    permissionDenied,
    error,
    rows: extraObj.rows || [],
    success: extraObj.success || 0,
    failed: extraObj.failed != null ? extraObj.failed : 0,
  };
}

async function vpRestFetchAll(tableName) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, notEnabled: true, notAuthenticated: false, forbidden: false, error: "Supabase 未設定", rows: [] };
  }
  const gate = vpRequireVerifiedAdminCloudAccess();
  if (!gate.ok) return gate;
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok) {
    return vpRestDeniedResult(auth, { rows: [] });
  }
  const url = `${SUPABASE_URL}/rest/v1/${tableName}?select=*&order=updated_at.desc.nullslast`;
  let res;
  try {
    res = await fetch(url, {
      headers: auth.headers,
    });
  } catch (e) {
    return { ok: false, notEnabled: false, notAuthenticated: false, forbidden: false, error: String(e?.message || e || "網路錯誤"), rows: [] };
  }
  const errText = res.ok ? "" : await res.text();
  if (!res.ok) {
    const kind = vpRestClassifyHttp(res.status, errText);
    if (kind === "not_enabled") {
      return { ok: false, notEnabled: true, notAuthenticated: false, forbidden: false, error: errText.slice(0, 200) || ("HTTP " + res.status), rows: [] };
    }
    if (kind === "not_authenticated" || kind === "forbidden") {
      return vpRestDeniedResult(kind);
    }
    return { ok: false, notEnabled: false, notAuthenticated: false, forbidden: false, error: errText.slice(0, 200) || ("HTTP " + res.status), rows: [] };
  }
  const rows = await res.json();
  return { ok: true, notEnabled: false, notAuthenticated: false, forbidden: false, error: null, rows: Array.isArray(rows) ? rows : [] };
}

async function vpRestUpsertRows(tableName, rows) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, notEnabled: true, notAuthenticated: false, forbidden: false, error: "Supabase 未設定", success: 0, failed: (rows || []).length };
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: true, notEnabled: false, notAuthenticated: false, forbidden: false, error: null, success: 0, failed: 0 };
  const gate = vpRequireVerifiedAdminCloudAccess();
  if (!gate.ok) {
    return vpRestDeniedResult(gate, { failed: list.length });
  }
  const auth = await getSupabaseRestAuthHeaders({ requireUser: true });
  if (!auth.ok) {
    return vpRestDeniedResult(auth, { failed: list.length });
  }
  const url = `${SUPABASE_URL}/rest/v1/${tableName}?on_conflict=id`;
  const chunkSize = 40;
  let success = 0;
  let failed = 0;
  let lastError = null;
  let notEnabled = false;
  let notAuthenticated = false;
  let forbidden = false;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: auth.headers.apikey,
          Authorization: auth.headers.Authorization,
          "Content-Type": "application/json",
          Prefer: "return=representation,resolution=merge-duplicates",
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      failed += chunk.length;
      lastError = String(e?.message || e || "網路錯誤");
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      const kind = vpRestClassifyHttp(res.status, errText);
      failed += chunk.length;
      if (kind === "not_authenticated") {
        notAuthenticated = true;
        lastError = "請先登入後台";
        break;
      }
      if (kind === "forbidden") {
        forbidden = true;
        lastError = "你沒有此資料權限";
        break;
      }
      if (kind === "not_enabled") notEnabled = true;
      lastError = errText.slice(0, 200) || ("HTTP " + res.status);
      if (notEnabled) break;
      continue;
    }
    success += chunk.length;
  }
  if (notAuthenticated) return { ok: false, notEnabled: false, notAuthenticated: true, forbidden: false, error: lastError || "請先登入後台", success, failed };
  if (forbidden) return { ok: false, notEnabled: false, notAuthenticated: false, forbidden: true, error: lastError || "你沒有此資料權限", success, failed };
  if (notEnabled) return { ok: false, notEnabled: true, notAuthenticated: false, forbidden: false, error: lastError || "雲端尚未啟用", success, failed };
  if (failed > 0) return { ok: false, notEnabled: false, notAuthenticated: false, forbidden: false, error: lastError || "部分寫入失敗", success, failed };
  return { ok: true, notEnabled: false, notAuthenticated: false, forbidden: false, error: null, success, failed: 0 };
}

function vpDispatch(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  } catch (_) {}
}

function getVendorQuotesSyncMeta() {
  return vpGetMeta(VP_STORAGE_KEYS.vendorQuotesMeta);
}
function getPurchaseOrdersSyncMeta() {
  return vpGetMeta(VP_STORAGE_KEYS.purchaseOrdersMeta);
}

function loadVendorQuotesRaw(includeDeleted) {
  const list = vpReadLocalArray(VP_STORAGE_KEYS.vendorQuotes);
  if (includeDeleted) return list;
  return list.filter((x) => !vpIsDeleted(x));
}

function saveVendorQuotesRaw(list, { skipEvent, source } = {}) {
  vpWriteLocalArray(VP_STORAGE_KEYS.vendorQuotes, Array.isArray(list) ? list : []);
  if (!skipEvent) {
    vpDispatch("dk:vendor-quotes-updated", {
      source: source || "local",
      count: vpActiveCount(list),
    });
  }
}

function loadPurchaseOrdersRaw(includeDeleted) {
  const list = vpReadLocalArray(VP_STORAGE_KEYS.purchaseOrders);
  if (includeDeleted) return list;
  return list.filter((x) => !vpIsDeleted(x));
}

function savePurchaseOrdersRaw(list, { skipEvent, source } = {}) {
  vpWriteLocalArray(VP_STORAGE_KEYS.purchaseOrders, Array.isArray(list) ? list : []);
  if (!skipEvent) {
    vpDispatch("dk:purchase-orders-updated", {
      source: source || "local",
      count: vpActiveCount(list),
    });
  }
}

function vpStatusLabel(status) {
  switch (String(status || "")) {
    case "not_enabled":
      return "雲端尚未啟用";
    case "syncing":
      return "同步中";
    case "synced":
      return "已同步";
    case "pending_local":
      return "本機待同步";
    case "failed":
      return "同步失敗";
    case "never":
    default:
      return "尚未同步";
  }
}

async function pullVendorQuotesFromCloud(opts) {
  const options = opts || {};
  if (__dkVpSyncGuard.vendorPull) return { ok: false, skipped: true, reason: "busy" };
  __dkVpSyncGuard.vendorPull = true;
  const localAll = loadVendorQuotesRaw(true);
  vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
    status: "syncing",
    localCount: vpActiveCount(localAll),
    lastError: null,
  });
  try {
    const fetched = await vpRestFetchAll(SUPABASE_VENDOR_QUOTES_TABLE);
    if (fetched.notEnabled) {
      const meta = vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
        status: "not_enabled",
        cloudEnabled: false,
        cloudCount: 0,
        localCount: vpActiveCount(localAll),
        lastError: fetched.error || "請先在 Supabase 執行 supabase-vendor-purchase-sync.sql",
        source: "local",
      });
      return { ok: false, notEnabled: true, meta };
    }
    if (fetched.notAuthenticated || fetched.forbidden) {
      const msg = vpCloudUserMessage(fetched) || fetched.error;
      const meta = vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
        status: "failed",
        cloudEnabled: false,
        localCount: vpActiveCount(localAll),
        lastError: msg,
        source: "local",
      });
      return {
        ok: false,
        notAuthenticated: !!fetched.notAuthenticated,
        forbidden: !!fetched.forbidden,
        permissionDenied: !!fetched.permissionDenied,
        code: fetched.code || (fetched.permissionDenied ? "permission_denied" : null),
        meta,
      };
    }
    if (!fetched.ok) {
      const meta = vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
        status: "failed",
        cloudEnabled: true,
        localCount: vpActiveCount(localAll),
        lastError: fetched.error || "讀取失敗",
        source: "local",
      });
      return { ok: false, meta };
    }
    const cloudList = fetched.rows.map(cloudRowToVendorQuote);
    const cloudCount = vpActiveCount(cloudList);
    // 空雲端保護：不得覆蓋本機，不得自動上傳
    if (cloudList.length === 0) {
      const hasLocal = localAll.length > 0;
      const meta = vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
        status: hasLocal ? "pending_local" : "synced",
        cloudEnabled: true,
        cloudCount: 0,
        localCount: vpActiveCount(localAll),
        lastSyncAt: vpNowISO(),
        lastError: null,
        source: "local",
        conflictWarnings: [],
      });
      return { ok: true, emptyCloud: true, meta, changed: false };
    }
    const merged = vpMergeByUpdatedAt(localAll, cloudList);
    __dkVpSyncGuard.applyingCloud = true;
    try {
      saveVendorQuotesRaw(merged.list, { source: "cloud" });
    } finally {
      __dkVpSyncGuard.applyingCloud = false;
    }
    const meta = vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "synced",
      cloudEnabled: true,
      cloudCount,
      localCount: vpActiveCount(merged.list),
      lastSyncAt: vpNowISO(),
      lastError: null,
      source: "cloud",
      conflictWarnings: merged.warnings || [],
    });
    return { ok: true, meta, warnings: merged.warnings, changed: true };
  } finally {
    __dkVpSyncGuard.vendorPull = false;
  }
}

async function pullPurchaseOrdersFromCloud(opts) {
  const options = opts || {};
  if (__dkVpSyncGuard.purchasePull) return { ok: false, skipped: true, reason: "busy" };
  __dkVpSyncGuard.purchasePull = true;
  const localAll = loadPurchaseOrdersRaw(true);
  vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
    status: "syncing",
    localCount: vpActiveCount(localAll),
    lastError: null,
  });
  try {
    const fetched = await vpRestFetchAll(SUPABASE_PURCHASE_ORDERS_TABLE);
    if (fetched.notEnabled) {
      const meta = vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
        status: "not_enabled",
        cloudEnabled: false,
        cloudCount: 0,
        localCount: vpActiveCount(localAll),
        lastError: fetched.error || "請先在 Supabase 執行 supabase-vendor-purchase-sync.sql",
        source: "local",
      });
      return { ok: false, notEnabled: true, meta };
    }
    if (fetched.notAuthenticated || fetched.forbidden) {
      const msg = vpCloudUserMessage(fetched) || fetched.error;
      const meta = vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
        status: "failed",
        cloudEnabled: false,
        localCount: vpActiveCount(localAll),
        lastError: msg,
        source: "local",
      });
      return {
        ok: false,
        notAuthenticated: !!fetched.notAuthenticated,
        forbidden: !!fetched.forbidden,
        permissionDenied: !!fetched.permissionDenied,
        code: fetched.code || (fetched.permissionDenied ? "permission_denied" : null),
        meta,
      };
    }
    if (!fetched.ok) {
      const meta = vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
        status: "failed",
        cloudEnabled: true,
        localCount: vpActiveCount(localAll),
        lastError: fetched.error || "讀取失敗",
        source: "local",
      });
      return { ok: false, meta };
    }
    const cloudList = fetched.rows.map(cloudRowToPurchaseOrder);
    const cloudCount = vpActiveCount(cloudList);
    if (cloudList.length === 0) {
      const hasLocal = localAll.length > 0;
      const meta = vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
        status: hasLocal ? "pending_local" : "synced",
        cloudEnabled: true,
        cloudCount: 0,
        localCount: vpActiveCount(localAll),
        lastSyncAt: vpNowISO(),
        lastError: null,
        source: "local",
        conflictWarnings: [],
      });
      return { ok: true, emptyCloud: true, meta, changed: false };
    }
    const merged = vpMergeByUpdatedAt(localAll, cloudList);
    __dkVpSyncGuard.applyingCloud = true;
    try {
      savePurchaseOrdersRaw(merged.list, { source: "cloud" });
    } finally {
      __dkVpSyncGuard.applyingCloud = false;
    }
    const meta = vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "synced",
      cloudEnabled: true,
      cloudCount,
      localCount: vpActiveCount(merged.list),
      lastSyncAt: vpNowISO(),
      lastError: null,
      source: "cloud",
      conflictWarnings: merged.warnings || [],
    });
    return { ok: true, meta, warnings: merged.warnings, changed: true };
  } finally {
    __dkVpSyncGuard.purchasePull = false;
  }
}

function previewVendorQuotesUpload() {
  const localAll = loadVendorQuotesRaw(true).map((q) => vpEnsureTimestamps(q));
  return vpRestFetchAll(SUPABASE_VENDOR_QUOTES_TABLE).then((fetched) => {
    if (fetched.notEnabled) {
      return {
        ok: false,
        notEnabled: true,
        notAuthenticated: false,
        forbidden: false,
        error: fetched.error || "雲端尚未啟用",
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    if (fetched.notAuthenticated || fetched.forbidden) {
      return {
        ok: false,
        notEnabled: false,
        notAuthenticated: !!fetched.notAuthenticated,
        forbidden: !!fetched.forbidden,
        error: vpCloudUserMessage(fetched) || fetched.error,
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    if (!fetched.ok) {
      return {
        ok: false,
        notEnabled: false,
        notAuthenticated: false,
        forbidden: false,
        error: fetched.error || "無法讀取雲端",
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    const cloudMap = new Map(fetched.rows.map((r) => [String(r.id), r]));
    let toInsert = 0;
    let toUpdate = 0;
    for (const q of localAll) {
      const id = String(q.id || "");
      if (!id) continue;
      if (cloudMap.has(id)) toUpdate += 1;
      else toInsert += 1;
    }
    return {
      ok: true,
      notEnabled: false,
      error: null,
      localCount: vpActiveCount(localAll),
      localTotalIncludingDeleted: localAll.length,
      cloudCount: vpActiveCount(fetched.rows.map(cloudRowToVendorQuote)),
      cloudTotalIncludingDeleted: fetched.rows.length,
      toInsert,
      toUpdate,
    };
  });
}

function previewPurchaseOrdersUpload() {
  const localAll = loadPurchaseOrdersRaw(true).map((o) => vpEnsureTimestamps(o));
  return vpRestFetchAll(SUPABASE_PURCHASE_ORDERS_TABLE).then((fetched) => {
    if (fetched.notEnabled) {
      return {
        ok: false,
        notEnabled: true,
        notAuthenticated: false,
        forbidden: false,
        error: fetched.error || "雲端尚未啟用",
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    if (fetched.notAuthenticated || fetched.forbidden) {
      return {
        ok: false,
        notEnabled: false,
        notAuthenticated: !!fetched.notAuthenticated,
        forbidden: !!fetched.forbidden,
        error: vpCloudUserMessage(fetched) || fetched.error,
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    if (!fetched.ok) {
      return {
        ok: false,
        notEnabled: false,
        notAuthenticated: false,
        forbidden: false,
        error: fetched.error || "無法讀取雲端",
        localCount: vpActiveCount(localAll),
        cloudCount: 0,
        toInsert: 0,
        toUpdate: 0,
      };
    }
    const cloudMap = new Map(fetched.rows.map((r) => [String(r.id), r]));
    let toInsert = 0;
    let toUpdate = 0;
    for (const o of localAll) {
      const id = String(o.id || "");
      if (!id) continue;
      if (cloudMap.has(id)) toUpdate += 1;
      else toInsert += 1;
    }
    return {
      ok: true,
      notEnabled: false,
      error: null,
      localCount: vpActiveCount(localAll),
      localTotalIncludingDeleted: localAll.length,
      cloudCount: vpActiveCount(fetched.rows.map(cloudRowToPurchaseOrder)),
      cloudTotalIncludingDeleted: fetched.rows.length,
      toInsert,
      toUpdate,
    };
  });
}

async function uploadLocalVendorQuotesToCloud() {
  const localAll = loadVendorQuotesRaw(true);
  if (!localAll.length) {
    return { ok: false, error: "本機沒有可上傳的廠商報價", success: 0, failed: 0 };
  }
  // 僅補同步時間戳，不改 date/price/spec/vendor
  const stamped = localAll.map((q) => vpEnsureTimestamps(q));
  vpWriteLocalArray(VP_STORAGE_KEYS.vendorQuotes, stamped);
  const rows = stamped.map(vendorQuoteToCloudRow);
  vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, { status: "syncing", lastError: null });
  const result = await vpRestUpsertRows(SUPABASE_VENDOR_QUOTES_TABLE, rows);
  if (result.notEnabled) {
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "not_enabled",
      cloudEnabled: false,
      lastError: result.error || "雲端尚未啟用",
    });
    return { ok: false, notEnabled: true, error: result.error, success: result.success, failed: result.failed };
  }
  if (result.notAuthenticated || result.forbidden) {
    const msg = vpCloudUserMessage(result) || result.error;
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "failed",
      cloudEnabled: false,
      lastError: msg,
      localCount: vpActiveCount(stamped),
    });
    return {
      ok: false,
      notAuthenticated: !!result.notAuthenticated,
      forbidden: !!result.forbidden,
      error: msg,
      success: result.success,
      failed: result.failed,
    };
  }
  if (!result.ok) {
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "failed",
      lastError: result.error || "上傳失敗",
      localCount: vpActiveCount(stamped),
    });
    return { ok: false, error: result.error, success: result.success, failed: result.failed };
  }
  const pulled = await pullVendorQuotesFromCloud();
  return {
    ok: true,
    success: result.success,
    failed: 0,
    meta: pulled.meta || getVendorQuotesSyncMeta(),
  };
}

async function uploadLocalPurchaseOrdersToCloud() {
  const localAll = loadPurchaseOrdersRaw(true);
  if (!localAll.length) {
    return { ok: false, error: "本機沒有可上傳的叫貨單", success: 0, failed: 0 };
  }
  const stamped = localAll.map((o) => vpEnsureTimestamps(o));
  vpWriteLocalArray(VP_STORAGE_KEYS.purchaseOrders, stamped);
  const rows = stamped.map(purchaseOrderToCloudRow);
  vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, { status: "syncing", lastError: null });
  const result = await vpRestUpsertRows(SUPABASE_PURCHASE_ORDERS_TABLE, rows);
  if (result.notEnabled) {
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "not_enabled",
      cloudEnabled: false,
      lastError: result.error || "雲端尚未啟用",
    });
    return { ok: false, notEnabled: true, error: result.error, success: result.success, failed: result.failed };
  }
  if (result.notAuthenticated || result.forbidden) {
    const msg = vpCloudUserMessage(result) || result.error;
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "failed",
      cloudEnabled: false,
      lastError: msg,
      localCount: vpActiveCount(stamped),
    });
    return {
      ok: false,
      notAuthenticated: !!result.notAuthenticated,
      forbidden: !!result.forbidden,
      error: msg,
      success: result.success,
      failed: result.failed,
    };
  }
  if (!result.ok) {
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "failed",
      lastError: result.error || "上傳失敗",
      localCount: vpActiveCount(stamped),
    });
    return { ok: false, error: result.error, success: result.success, failed: result.failed };
  }
  const pulled = await pullPurchaseOrdersFromCloud();
  return {
    ok: true,
    success: result.success,
    failed: 0,
    meta: pulled.meta || getPurchaseOrdersSyncMeta(),
  };
}

async function upsertVendorQuoteToSupabase(quote) {
  if (__dkVpSyncGuard.applyingCloud) return { ok: true, skipped: true };
  if (!quote || !quote.id) return { ok: false, error: "缺少 id" };
  const stamped = vpEnsureTimestamps(quote, { forceUpdated: false });
  const result = await vpRestUpsertRows(SUPABASE_VENDOR_QUOTES_TABLE, [vendorQuoteToCloudRow(stamped)]);
  if (result.notEnabled) {
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "not_enabled",
      cloudEnabled: false,
      lastError: result.error || "雲端尚未啟用",
    });
    return { ok: false, notEnabled: true, error: result.error || "雲端尚未啟用" };
  }
  if (result.notAuthenticated || result.forbidden) {
    const msg = vpCloudUserMessage(result) || result.error;
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "failed",
      cloudEnabled: false,
      lastError: msg,
    });
    return {
      ok: false,
      notAuthenticated: !!result.notAuthenticated,
      forbidden: !!result.forbidden,
      error: msg,
    };
  }
  if (!result.ok) {
    vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
      status: "failed",
      lastError: result.error || "寫入失敗",
    });
    return { ok: false, error: result.error || "寫入失敗" };
  }
  vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
    status: "synced",
    cloudEnabled: true,
    lastSyncAt: vpNowISO(),
    lastError: null,
    source: "local",
  });
  return { ok: true };
}

async function upsertPurchaseOrderToSupabase(order) {
  if (__dkVpSyncGuard.applyingCloud) return { ok: true, skipped: true };
  if (!order || !order.id) return { ok: false, error: "缺少 id" };
  const stamped = vpEnsureTimestamps(order, { forceUpdated: false });
  const result = await vpRestUpsertRows(SUPABASE_PURCHASE_ORDERS_TABLE, [purchaseOrderToCloudRow(stamped)]);
  if (result.notEnabled) {
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "not_enabled",
      cloudEnabled: false,
      lastError: result.error || "雲端尚未啟用",
    });
    return { ok: false, notEnabled: true, error: result.error || "雲端尚未啟用" };
  }
  if (result.notAuthenticated || result.forbidden) {
    const msg = vpCloudUserMessage(result) || result.error;
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "failed",
      cloudEnabled: false,
      lastError: msg,
    });
    return {
      ok: false,
      notAuthenticated: !!result.notAuthenticated,
      forbidden: !!result.forbidden,
      error: msg,
    };
  }
  if (!result.ok) {
    vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
      status: "failed",
      lastError: result.error || "寫入失敗",
    });
    return { ok: false, error: result.error || "寫入失敗" };
  }
  vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
    status: "synced",
    cloudEnabled: true,
    lastSyncAt: vpNowISO(),
    lastError: null,
    source: "local",
  });
  return { ok: true };
}

/** soft delete：寫入 deletedAt 並 upsert（不硬刪雲端列） */
async function softDeleteVendorQuoteToSupabase(id, deletedAt) {
  const list = loadVendorQuotesRaw(true);
  const idx = list.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return { ok: false, error: "本機找不到此報價" };
  const now = deletedAt || vpNowISO();
  const next = {
    ...list[idx],
    deletedAt: now,
    updatedAt: now,
  };
  list[idx] = next;
  saveVendorQuotesRaw(list, { source: "local" });
  const cloud = await upsertVendorQuoteToSupabase(next);
  return { ok: true, localSaved: true, cloud };
}

async function softDeletePurchaseOrderToSupabase(id, deletedAt) {
  const list = loadPurchaseOrdersRaw(true);
  const idx = list.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return { ok: false, error: "本機找不到此叫貨單" };
  const now = deletedAt || vpNowISO();
  const next = {
    ...list[idx],
    deletedAt: now,
    updatedAt: now,
  };
  list[idx] = next;
  savePurchaseOrdersRaw(list, { source: "local" });
  const cloud = await upsertPurchaseOrderToSupabase(next);
  return { ok: true, localSaved: true, cloud };
}

function isVpApplyingCloud() {
  return !!__dkVpSyncGuard.applyingCloud;
}

// ===== Stage 2：Supabase Auth client（已接線、尚未啟用正式登入）=====
// 失敗必須隔離：不得影響舊登入、本機 session、site_config、前台。
// 本 Stage 不建立 Auth 帳號、不使用管理金鑰、不改舊登入流程。
const SUPABASE_JS_CDN_ESM = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const SUPABASE_AUTH_STORAGE_KEY = "dk_supabase_auth_stage2";
let __dkSupabaseAuthClient = null;
let __dkSupabaseAuthClientPromise = null;

function adminUsernameToAuthEmail(username) {
  const u = String(username == null ? "" : username).trim().toLowerCase();
  if (!u) return null;
  if (u.indexOf("@") !== -1) return null;
  if (/\s/.test(u)) return null;
  // RFC 5321/5322 local-part（dot-atom）：atext，點不能開頭/結尾/連續
  if (/[^a-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(u)) return null;
  if (u.charAt(0) === "." || u.charAt(u.length - 1) === "." || u.indexOf("..") !== -1) return null;
  return u + "@login.dkcomputer.internal";
}

function getSupabaseJsCreateClientSync() {
  try {
    if (typeof window !== "undefined" && window.supabase && typeof window.supabase.createClient === "function") {
      return window.supabase.createClient;
    }
  } catch (_) {}
  return null;
}

async function getSupabaseAuthClient() {
  if (__dkSupabaseAuthClient) return __dkSupabaseAuthClient;
  if (__dkSupabaseAuthClientPromise) return __dkSupabaseAuthClientPromise;
  __dkSupabaseAuthClientPromise = (async function () {
    try {
      if (!isSupabaseConfigured()) return null;
      let createClient = getSupabaseJsCreateClientSync();
      if (typeof createClient !== "function") {
        const mod = await import(SUPABASE_JS_CDN_ESM);
        createClient = mod && mod.createClient;
      }
      if (typeof createClient !== "function") return null;
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: SUPABASE_AUTH_STORAGE_KEY,
        },
      });
      if (client) __dkSupabaseAuthClient = client;
      return client || null;
    } catch (_) {
      return null;
    } finally {
      __dkSupabaseAuthClientPromise = null;
    }
  })();
  return __dkSupabaseAuthClientPromise;
}

async function getSupabaseAuthSession() {
  try {
    const client = await getSupabaseAuthClient();
    if (!client || !client.auth || typeof client.auth.getSession !== "function") return null;
    const result = await client.auth.getSession();
    if (result && result.error) return null;
    return (result && result.data && result.data.session) || null;
  } catch (_) {
    return null;
  }
}

async function getSupabaseAuthUser() {
  try {
    const session = await getSupabaseAuthSession();
    return (session && session.user) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Stage 5A REST headers。
 * requireUser=true：必須帶目前 Auth session 的 access_token；沒有 session 不 fallback anon。
 * 不得把 access_token 印 console、寫 UI、寫 localStorage、寫 site_config。
 */
async function getSupabaseRestAuthHeaders(opts) {
  const requireUser = !!(opts && opts.requireUser);
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return { ok: false, notAuthenticated: false, forbidden: false, error: "Supabase 未設定", headers: null };
    }
    if (!requireUser) {
      return {
        ok: true,
        notAuthenticated: false,
        forbidden: false,
        usingUserToken: false,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: "Bearer " + SUPABASE_ANON_KEY,
        },
      };
    }
    const session = await getSupabaseAuthSession();
    const token = session && session.access_token;
    if (!token || typeof token !== "string") {
      return { ok: false, notAuthenticated: true, forbidden: false, error: "請先登入後台", headers: null };
    }
    return {
      ok: true,
      notAuthenticated: false,
      forbidden: false,
      usingUserToken: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + token,
      },
    };
  } catch (_) {
    return {
      ok: false,
      notAuthenticated: requireUser,
      forbidden: false,
      error: requireUser ? "請先登入後台" : "網路錯誤",
      headers: null,
    };
  }
}

function profilesProbeLooksMissing(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 404 || status === 406) return true;
  return /does not exist|could not find the table|pgrst205|42p01|schema cache/.test(t);
}

async function probeProfilesAccess() {
  try {
    if (!isSupabaseConfigured()) return "missing";
    const url = `${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (profilesProbeLooksMissing(res.status, text)) return "missing";
    return "ok";
  } catch (_) {
    return "missing";
  }
}

async function getAuthMigrationStatus() {
  const out = {
    authWired: false,
    authSession: false,
    profiles: "missing",
    loginMode: "legacy",
  };
  try {
    const client = await getSupabaseAuthClient();
    out.authWired = !!client;
    if (client) {
      const session = await getSupabaseAuthSession();
      out.authSession = !!(session && session.user);
    }
  } catch (_) {}
  try {
    out.profiles = await probeProfilesAccess();
  } catch (_) {
    out.profiles = "missing";
  }
  return out;
}

function sanitizeAuthProfileRow(row) {
  if (!row || typeof row !== "object") return null;
  const role = row.role === "admin" || row.role === "staff" ? row.role : "";
  return {
    id: String(row.id || ""),
    username: String(row.username || ""),
    displayName: String(row.display_name || row.displayName || ""),
    role,
    enabled: row.enabled === true,
  };
}

function classifySupabaseAuthSignInError(err) {
  try {
    const code = String((err && err.code) || "").toLowerCase();
    const msg = String((err && err.message) || "").toLowerCase();
    if (code === "invalid_credentials" || msg.indexOf("invalid login credentials") !== -1) return "auth_failed";
    if (code === "email_not_confirmed" || msg.indexOf("email not confirmed") !== -1) return "email_not_confirmed";
  } catch (_) {}
  return "network";
}

function authMigrationFail(code, extra) {
  const out = { ok: false, code: code, profile: null };
  if (extra && extra.authOk) out.authOk = true;
  return out;
}

async function fetchOwnAuthProfile(client, userId) {
  const result = await client
    .from("profiles")
    .select("id,username,display_name,role,enabled")
    .eq("id", userId)
    .maybeSingle();
  if (result && result.error) {
    const msg = String((result.error && result.error.message) || "").toLowerCase();
    if (/does not exist|could not find the table|pgrst205|42p01/.test(msg)) {
      return { errorCode: "profile_missing", row: null };
    }
    return { errorCode: "network", row: null };
  }
  return { errorCode: null, row: (result && result.data) || null };
}

function validateAuthProfileForMigration(row, username) {
  if (!row) return authMigrationFail("profile_missing", { authOk: true });
  const profile = sanitizeAuthProfileRow(row);
  if (!profile || (profile.role !== "admin" && profile.role !== "staff")) {
    return authMigrationFail("role_invalid", { authOk: true });
  }
  const expected = String(username || "").trim().toLowerCase();
  const actual = String(profile.username || "").trim().toLowerCase();
  if (!expected || actual !== expected) {
    return authMigrationFail("username_mismatch", { authOk: true });
  }
  if (profile.enabled !== true) {
    return { ok: false, code: "profile_disabled", authOk: true, profile: profile };
  }
  return { ok: true, code: "ok", authOk: true, profile: profile };
}

async function signInSupabaseAuthForMigration(username, password) {
  try {
    const email = adminUsernameToAuthEmail(username);
    if (!email) return authMigrationFail("invalid_username");
    if (String(password ?? "") === "") return authMigrationFail("auth_failed");
    const client = await getSupabaseAuthClient();
    if (!client || !client.auth || typeof client.auth.signInWithPassword !== "function") {
      return authMigrationFail("network");
    }
    const signed = await client.auth.signInWithPassword({ email: email, password: String(password) });
    if (signed && signed.error) {
      return authMigrationFail(classifySupabaseAuthSignInError(signed.error));
    }
    const user = signed && signed.data && signed.data.user;
    const userId = user && user.id;
    if (!userId) return authMigrationFail("auth_failed");
    const fetched = await fetchOwnAuthProfile(client, userId);
    if (fetched.errorCode === "network") return authMigrationFail("network", { authOk: true });
    return validateAuthProfileForMigration(fetched.row, username);
  } catch (_) {
    return authMigrationFail("network");
  }
}

async function signOutSupabaseAuthForMigration() {
  try {
    const client = await getSupabaseAuthClient();
    await signOutSupabaseAuthKeepGoing(client);
    return { ok: true };
  } catch (_) {
    try { clearProjectSupabaseAuthStorage(); } catch (__) {}
    return { ok: false, code: "network" };
  }
}

async function getSupabaseAuthProfile() {
  try {
    const client = await getSupabaseAuthClient();
    const user = await getSupabaseAuthUser();
    if (!client || !user || !user.id) {
      return { ok: false, code: "no_session", profile: null };
    }
    const fetched = await fetchOwnAuthProfile(client, user.id);
    if (fetched.errorCode === "network") return { ok: false, code: "network", profile: null };
    if (!fetched.row) return { ok: false, code: "profile_missing", profile: null };
    return { ok: true, code: "ok", profile: sanitizeAuthProfileRow(fetched.row) };
  } catch (_) {
    return { ok: false, code: "network", profile: null };
  }
}

window.DK = {
  STORAGE_KEYS,
  DEFAULT_CONFIG,
  DEFAULT_INVENTORY,
  getConfig,
  saveConfig,
  sanitizeSiteConfigForStorage,
  getConfigSyncMeta,
  saveConfigSyncMeta,
  getInventoryCategories,
  getInventory,
  getInventoryForDisplay,
  saveInventory,
  fetchInventoryFromSupabase,
  upsertInventoryItemToSupabase,
  deleteInventoryItemFromSupabase,
  uploadImageToSupabaseStorage,
  uploadSiteAssetToSupabaseStorage,
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
  normalizeHomeStyle,
  applyHomeStyleToPage,
  getDefaultHomeStyle,
  openLineOrder,
  tryCopy,
  isAdminAuthed,
  setAdminAuthed,
  getAdminUsers,
  findAdminUserByCredentials,
  hasEnabledAdminAccount,
  ensureAdminUsersPersisted,
  saveAdminUsers,
  getAdminSession,
  setAdminSession,
  getCurrentAdminUser,
  getCurrentRole,
  roleLabel,
  canPermission,
  requirePermission,
  validateAdminSession,
  AUTH_LOGIN_MODE,
  getAuthLoginMode,
  isAuthLoginModeSupabase,
  validateSupabaseAdminSession,
  signInSupabaseAdmin,
  signOutSupabaseAdmin,
  appendAuditLog,
  loadAuditLogs,
  ADMIN_ROLE_LABEL,
  isSupabaseConfigured,
  getSupabaseAuthClient,
  getSupabaseAuthSession,
  getSupabaseAuthUser,
  adminUsernameToAuthEmail,
  getAuthMigrationStatus,
  signInSupabaseAuthForMigration,
  signOutSupabaseAuthForMigration,
  getSupabaseAuthProfile,
  getSupabaseRestAuthHeaders,
  requireVerifiedAdminCloudAccess,
  requireVerifiedBackofficeCloudAccess,
  // 廠商報價＋叫貨單同步 1.0
  VP_STORAGE_KEYS,
  getVendorQuotesSyncMeta,
  getPurchaseOrdersSyncMeta,
  vpStatusLabel,
  vpCloudUserMessage,
  loadVendorQuotesRaw,
  saveVendorQuotesRaw,
  loadPurchaseOrdersRaw,
  savePurchaseOrdersRaw,
  pullVendorQuotesFromCloud,
  pullPurchaseOrdersFromCloud,
  previewVendorQuotesUpload,
  previewPurchaseOrdersUpload,
  uploadLocalVendorQuotesToCloud,
  uploadLocalPurchaseOrdersToCloud,
  upsertVendorQuoteToSupabase,
  upsertPurchaseOrderToSupabase,
  softDeleteVendorQuoteToSupabase,
  softDeletePurchaseOrderToSupabase,
  isVpApplyingCloud,
  vpEnsureTimestamps,
  vpActiveCount,
  vpIsDeleted,
};

// 頁面載入時從 Supabase 拉官網設定，覆蓋本機（大家看到同一份設定）
if (window.DK.fetchSiteConfigFromSupabase && window.DK.saveConfig) {
  window.DK
    .fetchSiteConfigFromSupabase()
    .then(function (c) {
      if (c != null) {
        // 保護：合併本機 admin 非敏感 metadata（username/users/role）。Stage 6-2 起絕不把本機舊 password merge 回 config。
        try {
          const local = safeJsonParse(localStorage.getItem(STORAGE_KEYS.config), null);
          const localAdmin = local && local.admin && typeof local.admin === "object" ? local.admin : null;
          if (localAdmin) {
            c = { ...c, admin: mergeAdminConfig(c.admin, localAdmin) };
          }
        } catch (_) {}
        window.DK.saveConfig(c, { skipSupabase: true });
        try { window.dispatchEvent(new CustomEvent("dk:config-updated")); } catch (_) {}
      }
      if (typeof window.DK.applyConfigToHomePage === "function") window.DK.applyConfigToHomePage();
    })
    .catch(function () {});
}
// 頁面載入時從 Supabase 拉前台商品（上架清單），後台／前台看到同一份
if (window.DK && window.DK.fetchInventoryFromSupabase && window.DK.saveInventory) {
  window.DK
    .fetchInventoryFromSupabase()
    .then(function (items) {
      if (!Array.isArray(items) || items.length === 0) return;
      window.DK.saveInventory(items);
      try {
        window.dispatchEvent(
          new CustomEvent("dk:inventory-updated", {
            detail: { source: "supabase", count: items.length },
          }),
        );
      } catch (_) {}
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
// 頁面載入時：僅在「本機沒有 v2 資料」時才從 Supabase 拉取，避免剛補貨／編輯後按 F5 被雲端舊資料蓋掉
// Stage 5B：profile 尚未驗證時不發 REST（不寫空、不覆蓋、不當作成功）。登入／boot 完成後再拉。
(function tryFetchV2Once() {
  if (typeof window.fetchV2DataFromSupabase !== "function") return;
  try {
    const itemsRaw = localStorage.getItem(V2_STORAGE_KEYS.items) || "";
    const ledgerRaw = localStorage.getItem(V2_STORAGE_KEYS.ledger) || "";
    if (itemsRaw.length > 2 || ledgerRaw.length > 2) return;
  } catch (_) {}
  const gate = requireVerifiedBackofficeCloudAccess();
  if (!gate.ok) return;
  window.fetchV2DataFromSupabase().catch(function () {});
})();

// 廠商報價／叫貨單：啟動時先本機、再非同步拉雲（空雲端不覆蓋、不自動上傳）
(function tryPullVendorPurchaseOnce() {
  if (!isSupabaseConfigured()) {
    try {
      vpSaveMeta(VP_STORAGE_KEYS.vendorQuotesMeta, {
        status: "not_enabled",
        cloudEnabled: false,
        lastError: "Supabase 未設定",
        localCount: vpActiveCount(loadVendorQuotesRaw(true)),
      });
      vpSaveMeta(VP_STORAGE_KEYS.purchaseOrdersMeta, {
        status: "not_enabled",
        cloudEnabled: false,
        lastError: "Supabase 未設定",
        localCount: vpActiveCount(loadPurchaseOrdersRaw(true)),
      });
    } catch (_) {}
    return;
  }
  pullVendorQuotesFromCloud().catch(function () {});
  pullPurchaseOrdersFromCloud().catch(function () {});
})();

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
