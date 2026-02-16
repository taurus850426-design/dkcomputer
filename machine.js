/* machine.js - 整機販售頁：5 張 9:16 分類卡片，點進去顯示上架商品 */

(async function () {
  // 分類圖片：後台設定優先（data URL），否則用完整 URL 載入預設圖
  const cfg = typeof DK !== "undefined" && DK.getConfig ? DK.getConfig() : {};
  const catImages = cfg.frontend?.catImages || {};
  const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/");
  document.querySelectorAll(".cat-card .cat-card-bg-img").forEach((img) => {
    const card = img.closest(".cat-card");
    const cat = card?.dataset?.cat;
    if (cat && catImages[cat]) {
      img.src = catImages[cat];
    } else {
      const src = img.getAttribute("src");
      if (src && !src.startsWith("http")) {
        img.src = base + src;
      }
    }
  });

  const catCards = document.querySelectorAll(".cat-card");
  const productsSection = document.getElementById("productsSection");
  const productsSectionTitle = document.getElementById("productsSectionTitle");
  const productsGrid = document.getElementById("productsGrid");
  const productsEmpty = document.getElementById("productsEmpty");
  const productsPrompt = document.getElementById("productsPrompt");

  if (!catCards.length || !productsSection || !productsGrid) return;

  // 先從 Supabase 載入最新前台商品；若有本機獨有品項（尚未同步成功）則一併保留顯示
  if (window.DK?.fetchInventoryFromSupabase && window.DK?.saveInventory) {
    try {
      const remoteItems = await DK.fetchInventoryFromSupabase();
      const localItems = DK.getInventory?.() || [];
      if (Array.isArray(remoteItems) && remoteItems.length > 0) {
        const remoteIds = new Set(remoteItems.map((r) => r.id));
        const localOnly = localItems.filter((l) => l?.id && !remoteIds.has(l.id));
        const merged = [...remoteItems, ...localOnly];
        DK.saveInventory(merged);
      } else if (Array.isArray(localItems) && localItems.length > 0) {
        // Supabase 回傳空，保留本機資料
        DK.saveInventory(localItems);
      }
    } catch (e) {
      console.warn("載入 Supabase 商品失敗，改用本機資料", e);
    }
  }

  // 用途分類對應
  const CAT_MAP = {
    office: { title: "① 文書／上網／學生", categories: ["辦公", "文書"], minPrice: 0, maxPrice: 6000 },
    "game-entry": { title: "② 遊戲入門", categories: ["遊戲"], minPrice: 7000, maxPrice: 12000 },
    "game-mid": { title: "③ 遊戲中階（主力）", categories: ["遊戲"], minPrice: 13000, maxPrice: 20000 },
    work: { title: "④ 工作／效能取向", categories: ["剪輯", "辦公"], minPrice: 18000, maxPrice: 999999 },
    peripherals: { title: "⑤ 電腦周邊", categories: ["周邊", "周邊配件", "配件"], minPrice: 0, maxPrice: 999999 },
  };

  function priceInRange(price, min, max) {
    if (typeof price !== "number" || !Number.isFinite(price)) return false;
    return price >= min && price <= max;
  }

  function categoryMatch(item, catList) {
    const cat = String(item.category || "").trim();
    return catList.some((c) => cat.includes(c));
  }

  function getItems() {
    let items = DK.getInventory();
    if (items.length === 0 && typeof DK.getStock === "function") {
      items = DK.getStock()
        .filter((s) => s?.web?.publish && s?.status !== "已售出")
        .map((s) => {
          const w = s.web || {};
          return {
            id: s.id,
            name: w.name || s.modelSpec || s.stockNo,
            category: w.category || "遊戲",
            price: typeof w.price === "number" ? w.price : DK.toNumber?.(w.price) ?? null,
            note: w.note || "",
            photos: Array.isArray(w.photos) ? w.photos : [],
          };
        });
    }
    return items;
  }

  function buildMachineCard(item) {
    const name = DK.escapeHtml(item.name || "整機");
    const desc = DK.escapeHtml(item.note || "可依用途客製，詳細配備請加 LINE 詢問。");
    const price = item.price != null ? DK.formatPrice(item.price) : null;
    const priceText = price ? `約 NT$ ${price}` : "價格請加 LINE 詢問";
    const photos = Array.isArray(item.photos) ? item.photos : [];
    const firstPhoto = photos[0] || "";

    return `
      <article class="machine-card">
        ${firstPhoto ? `<div class="machine-card-photo"><img src="${DK.escapeHtml(firstPhoto)}" alt="" loading="lazy" /></div>` : ""}
        <h3 class="machine-card-title">${name}</h3>
        <p class="machine-card-desc">${desc}</p>
        <div class="machine-card-price">${priceText}</div>
        <p class="machine-card-note">詳細配備請加 LINE 詢問</p>
        <button type="button" class="btn btn-primary machine-line-btn" data-id="${DK.escapeHtml(item.id)}">加 LINE 詢問</button>
      </article>
    `;
  }

  function showCategory(catKey) {
    const cfg = CAT_MAP[catKey];
    if (!cfg) return;

    const items = getItems();
    const filtered = items.filter((it) => {
      if (!categoryMatch(it, cfg.categories)) return false;
      // 售價 0 或未填視為「價格請加 LINE 詢問」，仍顯示在該分類
      const p = it.price;
      if (p == null || p === "" || (typeof p === "number" && (Number.isNaN(p) || p <= 0))) return true;
      return priceInRange(p, cfg.minPrice, cfg.maxPrice);
    });

    if (productsSectionTitle) productsSectionTitle.textContent = cfg.title;
    productsGrid.innerHTML = "";

    if (filtered.length === 0) {
      productsGrid.hidden = true;
      if (productsEmpty) {
        productsEmpty.hidden = false;
        productsEmpty.textContent = "此分類目前沒有上架商品，加 LINE 詢問可客製配機。";
      }
    } else {
      productsGrid.hidden = false;
      if (productsEmpty) productsEmpty.hidden = true;
      for (const item of filtered) {
        const div = document.createElement("div");
        div.innerHTML = buildMachineCard(item);
        const card = div.firstElementChild;
        const btn = card?.querySelector(".machine-line-btn");
        if (btn) btn.addEventListener("click", () => DK.openLineOrder(item));
        if (card) productsGrid.appendChild(card);
      }
    }

    productsSection.hidden = false;
    if (productsPrompt) productsPrompt.hidden = true;

    for (const card of catCards) {
      card.classList.toggle("active", card.dataset.cat === catKey);
      card.setAttribute("aria-selected", card.dataset.cat === catKey ? "true" : "false");
    }

    productsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  for (const card of catCards) {
    card.addEventListener("click", () => showCategory(card.dataset.cat));
  }

  // 支援網址 hash：machine.html#office 直接顯示該分類
  const hash = window.location.hash.replace(/^#/, "");
  if (hash && CAT_MAP[hash]) {
    showCategory(hash);
  }

  // 套用 LINE 連結
  if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
    DK.applyConfigToHomePage();
  }
})();
