/* product.js - 商品獨立頁：依 URL ?id= 顯示單一上架商品 */

(function () {
  const content = document.getElementById("productPageContent");
  const notFound = document.getElementById("productPageNotFound");
  const photoEl = document.getElementById("productPagePhoto");
  const titleEl = document.getElementById("productPageTitle");
  const introEl = document.getElementById("productPageIntro");
  const priceEl = document.getElementById("productPagePrice");
  const qtyEl = document.getElementById("productPageQty");
  const lineBtn = document.getElementById("productPageLineBtn");
  const ctaSection = document.getElementById("productPageCtaSection");
  let viewItemTracked = false;

  function getProductId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("id")?.trim() || "";
  }

  /** 產品介紹 HTML 消毒（與 machine.js 一致） */
  function sanitizeProductNote(html) {
    if (!html || typeof html !== "string") return "";
    const s = html.trim();
    if (!s) return "";
    if (s.indexOf("<") === -1) return DK.escapeHtml ? DK.escapeHtml(s).replace(/\n/g, "<br>") : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    const allowedTags = new Set(["p", "br", "strong", "b", "em", "i", "u", "span", "h2", "h3", "h4", "ul", "ol", "li", "img", "a", "div", "blockquote"]);
    const allowedAttrs = { img: ["src", "alt", "width", "height", "style"], a: ["href", "title", "target", "rel"] };
    const div = document.createElement("div");
    div.innerHTML = s;
    function sanitizeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true);
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const tag = node.tagName.toLowerCase();
      if (!allowedTags.has(tag)) return null;
      const el = document.createElement(tag);
      const attrs = allowedAttrs[tag];
      if (attrs && node.attributes)
        for (const a of node.attributes) {
          const name = a.name.toLowerCase();
          if (attrs.indexOf(name) === -1) continue;
          let val = a.value || "";
          if (name === "href" && /^\s*javascript\s*:/i.test(val)) continue;
          if (name === "src" && /^\s*javascript\s*:/i.test(val)) continue;
          el.setAttribute(name, val);
        }
      for (let i = 0; i < node.childNodes.length; i++) {
        const c = sanitizeNode(node.childNodes[i]);
        if (c) el.appendChild(c);
      }
      return el;
    }
    const out = document.createElement("div");
    for (let i = 0; i < div.childNodes.length; i++) {
      const c = sanitizeNode(div.childNodes[i]);
      if (c) out.appendChild(c);
    }
    return out.innerHTML;
  }

  function getItems() {
    // Stage 6-6-2：公開頁只顯示 inventory。inventory 為空時顯示空狀態，
    // 不 fallback getStock()／DEFAULT_STOCK，避免訪客看到本機 legacy 假資料。
    return (typeof DK.getInventoryForDisplay === "function" ? DK.getInventoryForDisplay() : DK.getInventory?.()) || [];
  }

  function trackProductViewItem(item) {
    try {
      if (viewItemTracked || !item) return;
      const gaItem = typeof window.__dkBuildGaItem === "function" ? window.__dkBuildGaItem(item) : null;
      if (!gaItem || !gaItem.item_id) return;
      viewItemTracked = true;
      const payload = {
        currency: "TWD",
        items: [gaItem],
      };
      if (typeof window.__dkToGaPrice === "function") {
        const price = window.__dkToGaPrice(item.price);
        if (price != null) payload.value = price;
      } else if (gaItem.price != null) {
        payload.value = gaItem.price;
      }
      if (typeof window.trackGAEvent === "function") window.trackGAEvent("view_item", payload);
    } catch (_) {}
  }

  function renderProduct(item) {
    if (!item) return;

    if (titleEl) titleEl.textContent = item.name || "商品";
    document.title = (item.name || "商品") + "｜二手電腦・依用途配機";

    if (introEl) {
      const note = item.note?.trim() || "";
      introEl.innerHTML = note ? sanitizeProductNote(note) : "（無產品介紹）";
      introEl.classList.add("product-detail-intro-html");
    }

    const priceStr = item.price != null ? (typeof DK.formatPrice === "function" ? DK.formatPrice(item.price) : String(item.price)) : null;
    if (priceEl) priceEl.textContent = priceStr ? `NT$ ${priceStr}` : "價格請加 LINE 詢問";

    const qty = typeof item.qty === "number" && item.qty >= 0 ? item.qty : null;
    if (qtyEl) {
      qtyEl.textContent = qty != null ? `剩餘 ${qty} 件` : "";
      qtyEl.hidden = qty == null;
    }

    if (photoEl) {
      const photos = Array.isArray(item.photos) ? item.photos.filter((p) => typeof p === "string" && p.trim()) : [];
      if (photos.length === 0) {
        photoEl.innerHTML = "";
        photoEl.hidden = true;
      } else {
        photoEl.hidden = false;
        const n = photos.length;
        const showArrows = n > 1;
        const slidesHtml = photos.map((p) => `<div class="product-detail-photo-slide"><img src="${DK.escapeHtml(p)}" alt="" loading="lazy" /></div>`).join("");
        photoEl.innerHTML = `
          <div class="product-detail-photo-wrap">
            ${showArrows ? `<button type="button" class="product-detail-arrow product-detail-arrow-prev" aria-label="上一張"></button>` : ""}
            <div class="product-detail-photo-carousel" data-photo-count="${n}">
              <div class="product-detail-photo-inner">${slidesHtml}</div>
            </div>
            ${showArrows ? `<button type="button" class="product-detail-arrow product-detail-arrow-next" aria-label="下一張"></button>` : ""}
            ${showArrows ? `<div class="product-detail-dots">${photos.map((_, i) => `<button type="button" class="product-detail-dot${i === 0 ? " active" : ""}" aria-label="第${i + 1}張" data-i="${i}"></button>`).join("")}</div>` : ""}
          </div>`;
        if (n > 1) {
          const wrap = photoEl.querySelector(".product-detail-photo-wrap");
          const carousel = photoEl.querySelector(".product-detail-photo-carousel");
          const dots = photoEl.querySelectorAll(".product-detail-dot");
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
          wrap?.querySelector(".product-detail-arrow-prev")?.addEventListener("click", () => goTo(Math.round(carousel.scrollLeft / carousel.offsetWidth) - 1));
          wrap?.querySelector(".product-detail-arrow-next")?.addEventListener("click", () => goTo(Math.round(carousel.scrollLeft / carousel.offsetWidth) + 1));
          dots.forEach((d) => d.addEventListener("click", () => goTo(Number(d.getAttribute("data-i")))));
        }
      }
    }

    if (lineBtn) {
      const OFFICIAL_LINE = "https://lin.ee/p58Bkqp";
      try {
        if (lineBtn.tagName === "A") {
          // 公開 CTA href 固定官方網址，供 analytics.js 追蹤；實際開啟仍優先用 config
          lineBtn.setAttribute("href", OFFICIAL_LINE);
          lineBtn.setAttribute("target", "_blank");
          lineBtn.setAttribute("rel", "noreferrer");
        }
      } catch (_) {}

      lineBtn.onclick = async (e) => {
        try {
          e?.preventDefault?.();
        } catch (_) {}

        const cfg = (window.DK && typeof window.DK.getConfig === "function") ? window.DK.getConfig() : {};
        const lineUrl = (cfg?.line?.url && String(cfg.line.url).trim()) || OFFICIAL_LINE;

        // 商品詢問：select_item；generate_lead 以官方 gtag + beacon 再送一次（與 analytics 去重）
        try {
          const gaItem = typeof window.__dkBuildGaItem === "function" ? window.__dkBuildGaItem(item) : null;
          if (gaItem && gaItem.item_id && typeof window.trackGAEvent === "function") {
            window.trackGAEvent("select_item", {
              item_list_name: "product_inquiry",
              items: [gaItem],
            });
          }
          const btnText = (lineBtn.innerText || lineBtn.textContent || "").replace(/\s+/g, " ").trim();
          if (typeof window.__dkTrackLineLead === "function") {
            window.__dkTrackLineLead(OFFICIAL_LINE, btnText);
          } else if (typeof window.gtag === "function") {
            window.gtag("event", "generate_lead", {
              lead_source: "line",
              link_url: OFFICIAL_LINE,
              page_path: String(location.pathname || ""),
              button_text: btnText.slice(0, 100),
              transport_type: "beacon",
            });
          }
        } catch (_) {}

        const name = String(item?.name || "").trim();
        const cpu = String(item?.cpu || item?.spec_cpu || "未標示");
        const gpu = String(item?.gpu || item?.spec_gpu || "未標示");
        const currentUrl = String(window.location.href || "");

        const priceVal = item?.price;
        const priceText = (window.DK && typeof window.DK.formatPrice === "function")
          ? window.DK.formatPrice(priceVal)
          : (priceVal != null ? String(priceVal) : "");

        const msg =
          `我想詢問這個商品：\n` +
          `名稱：${name}\n` +
          `價格：${priceText}\n` +
          `CPU：${cpu}\n` +
          `GPU：${gpu}\n` +
          `商品連結：${currentUrl}`;

        try {
          if (window.DK && typeof window.DK.tryCopy === "function") {
            await window.DK.tryCopy(msg);
          }
        } catch (_) {}

        if (lineUrl) {
          window.open(lineUrl, "_blank", "noreferrer");
        } else {
          try {
            window.DK?.openLineOrder?.(item);
          } catch (_) {}
        }
      };
    }

    if (content) content.hidden = false;
    if (notFound) notFound.hidden = true;
    if (ctaSection) ctaSection.hidden = false;
    trackProductViewItem(item);
  }

  function showNotFound() {
    if (content) content.hidden = true;
    if (notFound) notFound.hidden = false;
    if (ctaSection) ctaSection.hidden = true;
  }

  async function init() {
    const id = getProductId();
    if (!id) {
      showNotFound();
      return;
    }

    if (window.DK?.fetchInventoryFromSupabase && window.DK?.saveInventory) {
      try {
        const remoteItems = await DK.fetchInventoryFromSupabase();
        const localItems = DK.getInventory?.() || [];
        if (Array.isArray(remoteItems) && remoteItems.length > 0) {
          const remoteIds = new Set(remoteItems.map((r) => r.id));
          const localOnly = localItems.filter((l) => l?.id && !remoteIds.has(l.id));
          DK.saveInventory([...remoteItems, ...localOnly]);
        } else if (Array.isArray(localItems) && localItems.length > 0) {
          DK.saveInventory(localItems);
        }
      } catch (e) {
        console.warn("載入 Supabase 商品失敗，改用本機資料", e);
      }
    }

    const items = getItems();
    const item = items.find((it) => String(it?.id || "") === String(id));
    if (item) {
      // --- SEO: title / meta description / JSON-LD (Product) ---
      try {
        document.title = `${item.name || "商品"}｜DK Computer`;

        const cpu = String(item?.cpu || item?.spec_cpu || "未標示");
        const gpu = String(item?.gpu || item?.spec_gpu || "未標示");
        const priceVal = item?.price;
        const priceText = (window.DK && typeof window.DK.formatPrice === "function")
          ? window.DK.formatPrice(priceVal)
          : (priceVal != null ? String(priceVal) : "未標示");

        const desc =
          `台中電腦店 DK Computer 提供 ${item.name || ""}，` +
          `價格：${priceText}，` +
          `CPU：${cpu}，` +
          `GPU：${gpu}，` +
          `可LINE詢問與客製升級。`;

        let meta = document.querySelector('meta[name="description"]');
        if (!meta) {
          meta = document.createElement("meta");
          meta.setAttribute("name", "description");
          document.head.appendChild(meta);
        }
        meta.setAttribute("content", desc);

        const jsonLd = {
          "@context": "https://schema.org",
          "@type": "Product",
          name: item.name || "",
          description: item.description || item.note || "",
          offers: {
            "@type": "Offer",
            price: item.price != null ? item.price : "",
            priceCurrency: "TWD",
            availability: "https://schema.org/InStock",
          },
        };

        let script = document.getElementById("productJsonLd");
        if (!script) {
          script = document.createElement("script");
          script.id = "productJsonLd";
          script.type = "application/ld+json";
          document.head.appendChild(script);
        }
        script.textContent = JSON.stringify(jsonLd);
      } catch (_) {}

      renderProduct(item);
    } else {
      showNotFound();
    }

    if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
      DK.applyConfigToHomePage();
    }
  }

  init();
})();
