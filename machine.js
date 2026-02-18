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
  const productDetailModal = document.getElementById("productDetailModal");
  const productDetailClose = document.getElementById("productDetailClose");
  const productDetailPhoto = document.getElementById("productDetailPhoto");
  const productDetailTitle = document.getElementById("productDetailTitle");
  const productDetailIntro = document.getElementById("productDetailIntro");
  const productDetailPrice = document.getElementById("productDetailPrice");
  const productDetailQty = document.getElementById("productDetailQty");
  const productDetailLineBtn = document.getElementById("productDetailLineBtn");

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
    let items = (typeof DK.getInventoryForDisplay === "function" ? DK.getInventoryForDisplay() : DK.getInventory());
    if (items.length === 0 && typeof DK.getStock === "function") {
      items = DK.getStock()
        .filter((s) => s?.web?.publish && s?.status !== "已售出")
        .map((s) => {
          const w = s.web || {};
          const qty = (() => {
            const n = Number(w?.qty ?? s?.qty);
            return Number.isFinite(n) && n >= 0 ? n : null;
          })();
          return {
            id: s.id,
            name: w.name || s.modelSpec || s.stockNo,
            category: w.category || "遊戲",
            price: typeof w.price === "number" ? w.price : DK.toNumber?.(w.price) ?? null,
            note: w.note || "",
            photos: Array.isArray(w.photos) ? w.photos : [],
            qty,
          };
        });
    }
    return items;
  }

  function buildMachineCard(item) {
    const name = DK.escapeHtml(item.name || "整機");
    const price = item.price != null ? DK.formatPrice(item.price) : null;
    const priceText = price ? `NT$ ${price}` : "價格請加 LINE 詢問";
    const qty = (() => { const n = typeof item.qty === "number" ? item.qty : Number(item.qty); return Number.isFinite(n) && n >= 0 ? n : null; })();
    const photosRaw = Array.isArray(item.photos) ? item.photos : [];
    const photos = photosRaw
      .filter((p) => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p && (p.startsWith("data:image/") || p.startsWith("http://") || p.startsWith("https://") || p.startsWith("blob:")));

    const photoCarouselHtml = photos.length > 0
      ? `<div class="machine-card-photo-wrap">
          ${photos.length > 1 ? `<button type="button" class="machine-card-arrow machine-card-arrow-prev" aria-label="上一張"></button>` : ""}
          <div class="machine-card-photo machine-card-photo-carousel" data-photo-count="${photos.length}">
            <div class="machine-card-photo-carousel-inner" style="width:${photos.length * 100}%">
              ${photos.map((p, i) => `<div class="machine-card-photo-slide" style="flex:0 0 ${100 / photos.length}%"><img src="${DK.escapeHtml(p)}" alt="" loading="lazy" /></div>`).join("")}
            </div>
          </div>
          ${photos.length > 1 ? `<button type="button" class="machine-card-arrow machine-card-arrow-next" aria-label="下一張"></button>` : ""}
          ${photos.length > 1 ? `<div class="machine-card-dots">${photos.map((_, i) => `<button type="button" class="machine-card-dot${i === 0 ? " active" : ""}" aria-label="第${i + 1}張" data-i="${i}"></button>`).join("")}</div>` : ""}
        </div>`
      : "";

    return `
      <article class="machine-card" data-item-id="${DK.escapeHtml(String(item.id))}" role="button" tabindex="0">
        ${photoCarouselHtml}
        <h3 class="machine-card-title">${name}</h3>
        <div class="machine-card-price">${priceText}</div>
        ${qty != null ? `<div class="machine-card-qty">剩餘 ${qty} 件</div>` : ""}
        <button type="button" class="btn btn-primary machine-line-btn" data-id="${DK.escapeHtml(item.id)}">加 LINE 詢問</button>
      </article>
    `;
  }

  function openProductDetail(item) {
    if (!item || !productDetailModal) return;
    if (productDetailTitle) productDetailTitle.textContent = item.name || "商品";
    if (productDetailIntro) {
      productDetailIntro.textContent = item.note?.trim() || "（無產品介紹）";
      productDetailIntro.style.whiteSpace = "pre-wrap";
    }
    const price = item.price != null ? DK.formatPrice(item.price) : null;
    if (productDetailPrice) productDetailPrice.textContent = price ? `NT$ ${price}` : "價格請加 LINE 詢問";
    const qty = typeof item.qty === "number" && item.qty >= 0 ? item.qty : null;
    if (productDetailQty) {
      productDetailQty.textContent = qty != null ? `剩餘 ${qty} 件` : "";
      productDetailQty.hidden = qty == null;
    }
    if (productDetailPhoto) {
      const photos = Array.isArray(item.photos) ? item.photos.filter((p) => typeof p === "string" && p.trim()) : [];
      if (photos.length === 0) {
        productDetailPhoto.innerHTML = "";
        productDetailPhoto.hidden = true;
      } else {
        productDetailPhoto.hidden = false;
        const n = photos.length;
        const showArrows = n > 1;
        const slidesHtml = photos.map((p, i) => `<div class="product-detail-photo-slide"><img src="${DK.escapeHtml(p)}" alt="" loading="lazy" /></div>`).join("");
        productDetailPhoto.innerHTML = `
          <div class="product-detail-photo-wrap">
            ${showArrows ? `<button type="button" class="product-detail-arrow product-detail-arrow-prev" aria-label="上一張"></button>` : ""}
            <div class="product-detail-photo-carousel" data-photo-count="${n}">
              <div class="product-detail-photo-inner">${slidesHtml}</div>
            </div>
            ${showArrows ? `<button type="button" class="product-detail-arrow product-detail-arrow-next" aria-label="下一張"></button>` : ""}
            ${showArrows ? `<div class="product-detail-dots">${photos.map((_, i) => `<button type="button" class="product-detail-dot${i === 0 ? " active" : ""}" aria-label="第${i + 1}張" data-i="${i}"></button>`).join("")}</div>` : ""}
          </div>`;
        if (n > 1) {
          const wrap = productDetailPhoto.querySelector(".product-detail-photo-wrap");
          const carousel = productDetailPhoto.querySelector(".product-detail-photo-carousel");
          const inner = productDetailPhoto.querySelector(".product-detail-photo-inner");
          const slides = productDetailPhoto.querySelectorAll(".product-detail-photo-slide");
          const prevBtn = productDetailPhoto.querySelector(".product-detail-arrow-prev");
          const nextBtn = productDetailPhoto.querySelector(".product-detail-arrow-next");
          const dots = productDetailPhoto.querySelectorAll(".product-detail-dot");
          const goTo = (index) => {
            const i = Math.max(0, Math.min(index, n - 1));
            if (carousel && carousel.offsetWidth > 0) carousel.scrollLeft = i * carousel.offsetWidth;
            dots.forEach((d, j) => d.classList.toggle("active", j === i));
          };
          const updateDots = () => {
            if (!carousel || !carousel.offsetWidth) return;
            const idx = Math.round(carousel.scrollLeft / carousel.offsetWidth);
            const i = Math.max(0, Math.min(idx, n - 1));
            dots.forEach((d, j) => d.classList.toggle("active", j === i));
          };
          carousel.addEventListener("scroll", updateDots);
          prevBtn?.addEventListener("click", () => goTo(Math.round(carousel.scrollLeft / carousel.offsetWidth) - 1));
          nextBtn?.addEventListener("click", () => goTo(Math.round(carousel.scrollLeft / carousel.offsetWidth) + 1));
          dots.forEach((d) => d.addEventListener("click", () => goTo(Number(d.getAttribute("data-i")))));
        }
      }
    }
    if (productDetailLineBtn) {
      productDetailLineBtn.onclick = () => { DK.openLineOrder(item); closeProductDetail(); };
    }
    productDetailModal.hidden = false;
    productDetailClose?.focus();
  }

  function closeProductDetail() {
    if (productDetailModal) productDetailModal.hidden = true;
  }

  function showCategory(catKey) {
    const items = getItems();
    let filtered;
    let title;
    if (catKey === "all" || !CAT_MAP[catKey]) {
      filtered = items;
      title = "全部商品";
    } else {
      const cfg = CAT_MAP[catKey];
      filtered = items.filter((it) => categoryMatch(it, cfg.categories));
      title = cfg.title;
    }

    if (productsSectionTitle) productsSectionTitle.textContent = title;
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
        if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); DK.openLineOrder(item); });
        if (card) {
          card.addEventListener("click", (e) => {
            if (e.target.closest(".machine-line-btn")) return;
            openProductDetail(item);
          });
          card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProductDetail(item); }
          });
          productsGrid.appendChild(card);
          const wrap = card.querySelector(".machine-card-photo-wrap");
          const carousel = card.querySelector(".machine-card-photo-carousel");
          if (carousel && wrap) {
            const inner = carousel.querySelector(".machine-card-photo-carousel-inner");
            const slides = carousel.querySelectorAll(".machine-card-photo-slide");
            const n = slides.length;
            const prevBtn = wrap.querySelector(".machine-card-arrow-prev");
            const nextBtn = wrap.querySelector(".machine-card-arrow-next");
            const dots = wrap.querySelectorAll(".machine-card-dot");
            const setWidths = () => {
              const w = carousel.offsetWidth;
              if (w > 0 && inner) {
                inner.style.width = w * n + "px";
                slides.forEach((s) => { s.style.width = w + "px"; });
              }
              // w 為 0 時不寫入，保留 HTML 的 % 佈局（inner 200%、slide 50%）
            };
            const scheduleSetWidths = () => {
              requestAnimationFrame(() => requestAnimationFrame(setWidths));
              setTimeout(setWidths, 100);
              setTimeout(setWidths, 400);
              setTimeout(setWidths, 800);
            };
            const goTo = (index) => {
              const i = Math.max(0, Math.min(index, n - 1));
              if (inner && carousel.offsetWidth > 0) carousel.scrollLeft = i * carousel.offsetWidth;
              dots.forEach((d, j) => d.classList.toggle("active", j === i));
            };
            const updateDots = () => {
              if (n <= 0 || !carousel.offsetWidth) return;
              const idx = Math.round(carousel.scrollLeft / carousel.offsetWidth);
              const i = Math.max(0, Math.min(idx, n - 1));
              dots.forEach((d, j) => d.classList.toggle("active", j === i));
            };
            if (n > 0 && inner) {
              scheduleSetWidths();
              if (typeof ResizeObserver !== "undefined") new ResizeObserver(setWidths).observe(carousel);
            }
            carousel.addEventListener("scroll", updateDots);
            prevBtn?.addEventListener("click", () => {
              const i = Math.round(carousel.scrollLeft / carousel.offsetWidth) - 1;
              goTo(i);
            });
            nextBtn?.addEventListener("click", () => {
              const i = Math.round(carousel.scrollLeft / carousel.offsetWidth) + 1;
              goTo(i);
            });
            dots.forEach((d) => {
              d.addEventListener("click", () => goTo(Number(d.getAttribute("data-i"))));
            });
          }
        }
      }
    }

    productsSection.hidden = false;
    if (productsPrompt) productsPrompt.hidden = true;

    // 手機／iOS：區塊剛顯示時 offsetWidth 常為 0，多段延遲重算輪播寬度
    function recalcAllCarousels() {
      productsGrid.querySelectorAll(".machine-card-photo-carousel").forEach((carousel) => {
        const inner = carousel.querySelector(".machine-card-photo-carousel-inner");
        const slides = carousel.querySelectorAll(".machine-card-photo-slide");
        const n = slides.length;
        const w = carousel.offsetWidth;
        if (w > 0 && inner && n > 0) {
          inner.style.width = w * n + "px";
          slides.forEach((s) => { s.style.width = w + "px"; });
        }
      });
    }
    requestAnimationFrame(() => requestAnimationFrame(recalcAllCarousels));
    setTimeout(recalcAllCarousels, 350);
    setTimeout(recalcAllCarousels, 800);

    const selectedCat = catKey === "all" || !CAT_MAP[catKey] ? "all" : catKey;
    for (const card of catCards) {
      card.classList.toggle("active", card.dataset.cat === selectedCat);
      card.setAttribute("aria-selected", card.dataset.cat === selectedCat ? "true" : "false");
    }

    productsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  for (const card of catCards) {
    card.addEventListener("click", () => showCategory(card.dataset.cat));
  }

  if (productDetailClose) productDetailClose.addEventListener("click", closeProductDetail);
  if (productDetailModal) {
    productDetailModal.addEventListener("click", (e) => { if (e.target === productDetailModal) closeProductDetail(); });
    productDetailModal.addEventListener("keydown", (e) => { if (e.key === "Escape") closeProductDetail(); });
  }

  // 進入頁面先顯示全部商品；若有 hash 則顯示該分類
  const hash = window.location.hash.replace(/^#/, "");
  if (hash && CAT_MAP[hash]) {
    showCategory(hash);
  } else {
    showCategory("all");
  }

  // 套用 LINE 連結
  if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
    DK.applyConfigToHomePage();
  }
})();
