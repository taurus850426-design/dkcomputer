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

  // 用途分類對應（價格區間可從後台設定，未設定則用此預設）
  const CAT_MAP_DEFAULT = {
    office: { title: "① 文書／上網／學生", categories: ["辦公", "文書"], minPrice: 0, maxPrice: 6000 },
    "game-entry": { title: "② 遊戲入門", categories: ["遊戲"], minPrice: 7000, maxPrice: 12000 },
    "game-mid": { title: "③ 遊戲中階（主力）", categories: ["遊戲"], minPrice: 13000, maxPrice: 20000 },
    work: { title: "④ 工作／效能取向", categories: ["剪輯", "辦公"], minPrice: 18000, maxPrice: 999999 },
    peripherals: { title: "⑤ 電腦周邊", categories: ["周邊", "周邊配件", "配件"], minPrice: 0, maxPrice: 999999 },
  };
  function getCatMap() {
    const ranges = cfg.frontend?.catPriceRanges || {};
    return Object.fromEntries(
      Object.entries(CAT_MAP_DEFAULT).map(([k, v]) => [
        k,
        {
          ...v,
          minPrice: ranges[k]?.min != null ? Number(ranges[k].min) : v.minPrice,
          maxPrice: ranges[k]?.max != null ? Number(ranges[k].max) : v.maxPrice,
        },
      ])
    );
  }

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
    const rawPrice = typeof item.price === "number" ? item.price : Number(item.price);
    const hasPrice = Number.isFinite(rawPrice) && rawPrice > 0;
    const priceFormatted = hasPrice && DK.formatPrice ? DK.formatPrice(rawPrice) : "";
    const priceText = hasPrice && priceFormatted ? `NT$ ${priceFormatted}` : "洽詢價格";
    const qty = (() => { const n = typeof item.qty === "number" ? item.qty : Number(item.qty); return Number.isFinite(n) && n >= 0 ? n : null; })();
    const catLabel = String(item.category || "").trim();
    const stockStatus = String(item.stockStatus || "").trim();
    const photosRaw = Array.isArray(item.photos) ? item.photos : [];
    const photos = photosRaw
      .filter((p) => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p && (p.startsWith("data:image/") || p.startsWith("http://") || p.startsWith("https://") || p.startsWith("blob:")));

    const specParts = [];
    const pushSpec = (v) => {
      const s = String(v || "").trim();
      if (!s || s === "未標示" || s === "undefined" || s === "null") return;
      if (specParts.includes(s)) return;
      if (specParts.length >= 3) return;
      specParts.push(s);
    };
    pushSpec(item.cpu || item.spec_cpu);
    pushSpec(item.gpu || item.spec_gpu);
    pushSpec(item.ram || item.spec_ram);
    pushSpec(item.ssd || item.spec_ssd);
    const specText = specParts.length ? specParts.join(" · ") : "";

    const photoCarouselHtml = photos.length > 0
      ? `<div class="machine-card-photo-wrap">
          ${photos.length > 1 ? `<button type="button" class="machine-card-arrow machine-card-arrow-prev" aria-label="上一張"></button>` : ""}
          <div class="machine-card-photo machine-card-photo-carousel" data-photo-count="${photos.length}">
            <div class="machine-card-photo-carousel-inner" style="width:${photos.length * 100}%">
              ${photos.map((p, i) => `<div class="machine-card-photo-slide" style="flex:0 0 ${100 / photos.length}%"><img src="${DK.escapeHtml(p)}" alt="" loading="lazy" onerror="this.closest('.machine-card-photo-wrap')?.classList.add('is-broken')" /></div>`).join("")}
            </div>
          </div>
          ${photos.length > 1 ? `<button type="button" class="machine-card-arrow machine-card-arrow-next" aria-label="下一張"></button>` : ""}
          ${photos.length > 1 ? `<div class="machine-card-dots">${photos.map((_, i) => `<button type="button" class="machine-card-dot${i === 0 ? " active" : ""}" aria-label="第${i + 1}張" data-i="${i}"></button>`).join("")}</div>` : ""}
        </div>`
      : `<div class="machine-card-photo-wrap machine-card-photo-empty" aria-hidden="true"><div class="machine-card-photo"></div></div>`;

    const tagsHtml = (() => {
      const tags = [];
      if (catLabel) tags.push(DK.escapeHtml(catLabel));
      if (stockStatus) tags.push(DK.escapeHtml(stockStatus));
      else if (qty != null && qty > 0) tags.push("現貨");
      if (!tags.length) return "";
      return `<div class="machine-card-tags">${tags.map((t) => `<span class="machine-card-tag">${t}</span>`).join("")}</div>`;
    })();

    const productUrl = "product.html?id=" + encodeURIComponent(String(item.id));
    return `
      <article class="machine-card" data-item-id="${DK.escapeHtml(String(item.id))}">
        <a href="${DK.escapeHtml(productUrl)}" class="machine-card-link">
          ${photoCarouselHtml}
          <div class="machine-card-body">
            ${tagsHtml}
            <h3 class="machine-card-title">${name}</h3>
            ${specText ? `<p class="machine-card-spec">${DK.escapeHtml(specText)}</p>` : ""}
            <div class="machine-card-price">${priceText}</div>
            ${qty != null ? `<div class="machine-card-qty">剩餘 ${qty} 件</div>` : `<div class="machine-card-qty machine-card-qty-spacer" aria-hidden="true"></div>`}
          </div>
        </a>
        <a href="https://lin.ee/p58Bkqp" class="dk-btn dk-btn-primary machine-line-btn" target="_blank" rel="noreferrer" data-id="${DK.escapeHtml(item.id)}">
          加 LINE 詢問
          <span class="dk-btn-arrow" aria-hidden="true">→</span>
        </a>
      </article>
    `;
  }

  const productsSectionCount = document.getElementById("productsSectionCount");

  function displayTitleForCat(catKey, fallbackTitle) {
    if (catKey === "all" || !catKey) return "全部商品";
    const activeCard = document.querySelector(`.cat-card[data-cat="${catKey}"] .cat-card-title`);
    const fromCard = activeCard ? String(activeCard.textContent || "").trim() : "";
    if (fromCard) return fromCard;
    return String(fallbackTitle || "").replace(/^[①②③④⑤]\s*/, "").trim() || "商品";
  }

  function showCategory(catKey) {
    const items = getItems();
    const CAT_MAP = getCatMap();
    let filtered;
    let title;
    if (catKey === "all" || !CAT_MAP[catKey]) {
      filtered = items;
      title = "全部商品";
    } else {
      const catCfg = CAT_MAP[catKey];
      filtered = items.filter((it) => {
        if (!categoryMatch(it, catCfg.categories)) return false;
        if (catCfg.minPrice != null || catCfg.maxPrice != null) {
          const price = typeof it.price === "number" ? it.price : (parseFloat(it.price) || 0);
          if (!priceInRange(price, catCfg.minPrice ?? 0, catCfg.maxPrice ?? 999999)) return false;
        }
        return true;
      });
      title = catCfg.title;
    }

    const niceTitle = displayTitleForCat(catKey === "all" || !CAT_MAP[catKey] ? "all" : catKey, title);
    if (productsSectionTitle) productsSectionTitle.textContent = niceTitle;
    if (productsSectionCount) {
      productsSectionCount.textContent = filtered.length > 0 ? `共 ${filtered.length} 台可選` : "目前沒有可選商品";
    }
    productsGrid.innerHTML = "";

    if (filtered.length === 0) {
      productsGrid.hidden = true;
      if (productsEmpty) productsEmpty.hidden = false;
    } else {
      productsGrid.hidden = false;
      if (productsEmpty) productsEmpty.hidden = true;
      for (const item of filtered) {
        const div = document.createElement("div");
        div.innerHTML = buildMachineCard(item);
        const card = div.firstElementChild;
        const btn = card?.querySelector(".machine-line-btn");
        if (btn) {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const btnText = (btn.innerText || btn.textContent || "").replace(/\s+/g, " ").trim();
              const href = btn.getAttribute("href") || "https://lin.ee/p58Bkqp";
              if (typeof window.__dkTrackLineLead === "function") {
                window.__dkTrackLineLead(href, btnText);
              } else if (typeof window.gtag === "function") {
                window.gtag("event", "generate_lead", {
                  lead_source: "line",
                  link_url: href,
                  page_path: String(location.pathname || ""),
                  button_text: btnText.slice(0, 100),
                  transport_type: "beacon",
                });
              }
            } catch (_) {}
            DK.openLineOrder(item);
          });
        }
        if (card) {
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

    const selectedCat = catKey === "all" || !getCatMap()[catKey] ? "all" : catKey;
    for (const card of catCards) {
      card.classList.toggle("active", card.dataset.cat === selectedCat);
      card.setAttribute("aria-selected", card.dataset.cat === selectedCat ? "true" : "false");
    }

    productsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  for (const card of catCards) {
    card.addEventListener("click", () => showCategory(card.dataset.cat));
  }

  // 進入頁面先顯示全部商品；若有 hash 則顯示該分類
  const hash = window.location.hash.replace(/^#/, "");
  if (hash && getCatMap()[hash]) {
    showCategory(hash);
  } else {
    showCategory("all");
  }

  // 套用 LINE 連結
  if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
    DK.applyConfigToHomePage();
  }
})();
