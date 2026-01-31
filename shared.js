/* shared.js - 單頁靜態站：設定/資料存取/共用工具 */

const STORAGE_KEYS = {
  config: "dk_site_config_v1",
  inventory: "dk_inventory_v1",
  adminAuthed: "dk_admin_authed_v1",
};

const DEFAULT_CONFIG = {
  siteTitle: "哈啦電競電腦維修｜現貨庫存｜加 LINE 下單",
  brand: {
    mark: "DK",
    title: "DK Computer",
    subtitle: "現貨庫存｜加 LINE 下單",
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
    // 建議填：https://line.me/R/ti/p/@xxxx
    url: "https://lin.ee/zWYz2KH7",
    orderMessageTemplate: "你好，我想詢問：{name}",
  },
  admin: {
    username: "admin",
    password: "admin123",
  },
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
}

function getInventory() {
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.inventory), null);
  if (!saved || !Array.isArray(saved)) return [...DEFAULT_INVENTORY];
  return saved;
}

function saveInventory(items) {
  localStorage.setItem(STORAGE_KEYS.inventory, JSON.stringify(items));
}

function formatPrice(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";
  return n.toLocaleString("zh-Hant-TW");
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
  document.title = cfg.siteTitle;

  const brandMark = document.getElementById("brandMark");
  if (brandMark) brandMark.textContent = cfg.brand.mark;
  const brandTitle = document.getElementById("brandTitle");
  if (brandTitle) brandTitle.textContent = cfg.brand.title;
  const brandSubtitle = document.getElementById("brandSubtitle");
  if (brandSubtitle) brandSubtitle.textContent = cfg.brand.subtitle;

  const shopName = document.getElementById("shopName");
  if (shopName) shopName.textContent = cfg.shop.name;

  const shopAddressLink = document.getElementById("shopAddressLink");
  if (shopAddressLink) {
    shopAddressLink.textContent = cfg.shop.address;
    shopAddressLink.href = cfg.shop.mapUrl || "#";
  }

  const shopPhoneLink = document.getElementById("shopPhoneLink");
  const shopCallBtn = document.getElementById("shopCallBtn");
  const phoneHref = cfg.shop.phone ? `tel:+886${cfg.shop.phone.replaceAll(" ", "").replace(/^0/, "")}` : "#";
  if (shopPhoneLink) {
    shopPhoneLink.textContent = cfg.shop.phone;
    shopPhoneLink.href = phoneHref;
  }
  if (shopCallBtn) shopCallBtn.href = phoneHref;

  const shopMapBtn = document.getElementById("shopMapBtn");
  if (shopMapBtn) shopMapBtn.href = cfg.shop.mapUrl || "#";

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

  const lineButtons = [
    document.getElementById("lineMainBtn"),
    document.getElementById("lineStickyBtn"),
  ].filter(Boolean);

  for (const btn of lineButtons) {
    btn.href = cfg.line.url || "#";
    btn.target = "_blank";
    btn.rel = "noreferrer";
    if (!cfg.line.url) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        alert("尚未設定 LINE 連結。請到管理員後台填入 LINE URL。");
      });
    }
  }
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
  return sessionStorage.getItem(STORAGE_KEYS.adminAuthed) === "1";
}

function setAdminAuthed(v) {
  if (v) sessionStorage.setItem(STORAGE_KEYS.adminAuthed, "1");
  else sessionStorage.removeItem(STORAGE_KEYS.adminAuthed);
}

window.DK = {
  STORAGE_KEYS,
  DEFAULT_CONFIG,
  DEFAULT_INVENTORY,
  getConfig,
  saveConfig,
  getInventory,
  saveInventory,
  formatPrice,
  makeId,
  normalizeText,
  stockBadgeClass,
  escapeHtml,
  applyConfigToHomePage,
  openLineOrder,
  isAdminAuthed,
  setAdminAuthed,
};

// 首頁自動套用商家/連結設定
if (document.getElementById("inventoryGrid")) {
  applyConfigToHomePage();
}

