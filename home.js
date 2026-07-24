/* home.js - 首頁 Hero 輪播與產品展示（不更動既有設定與資料結構） */

// 首頁專用腳本：Hero 輪播 + 分類入口
(function () {
  // 必須用 var 置頂：早期 applyConfig wrap 會呼叫 observeReveals，
  // 若用 let 會落入 TDZ 導致 ReferenceError，後續區塊全部中斷並永久 opacity:0
  var revealObserver = null;
  var homeInteractionsBound = false;
  var homeFxReady = false;
  var mouseGlowRaf = 0;
  var mouseGlowX = 0;
  var mouseGlowY = 0;
  var scrollRaf = 0;
  var tiltRaf = 0;

  /* ===== Hero Banner 輪播（第一區）：從設定讀取 homeBanners ===== */
  const hero = document.getElementById("hero");
  const heroCarousel = hero?.querySelector(".hero-carousel");
  const slidesWrap = hero?.querySelector(".hero-slides");
  const prevBtn = hero?.querySelector(".hero-arrow-prev");
  const nextBtn = hero?.querySelector(".hero-arrow-next");
  const dotsWrap = hero?.querySelector(".hero-dots");

  let slides = [];
  let heroIndex = 0;
  let heroTimer = null;
  const HERO_INTERVAL_MS = 7000;

  function buildHeroSlides() {
    if (!slidesWrap) return;
    slidesWrap.innerHTML = "";

    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const banners = Array.isArray(fe.homeBanners) ? fe.homeBanners : [];

    const list = banners.length ? banners : [null]; // 單張 fallback

    for (const banner of list) {
      const slide = document.createElement("article");
      slide.className = "hero-slide";

      if (banner && banner.image) {
        const clamp01 = (n) => {
          const v = Number(n);
          if (!Number.isFinite(v)) return 50;
          if (v < 0) return 0;
          if (v > 100) return 100;
          return v;
        };
        const fx = clamp01(banner.focusX);
        const fy = clamp01(banner.focusY);
        const linkStart = banner.link ? `<a href="${banner.link}" class="hero-banner-link">` : "";
        const linkEnd = banner.link ? "</a>" : "";
        slide.innerHTML = `
          ${linkStart}
            <div class="hero-banner-img-wrap">
              <img src="${banner.image}" alt="" loading="lazy" style="object-position:${fx}% ${fy}%;" />
            </div>
          ${linkEnd}
        `;
      } else {
        // 單張安全 fallback：純視覺區塊，不顯示文字
        slide.innerHTML = `
          <div class="hero-banner-fallback"></div>
        `;
      }

      slidesWrap.appendChild(slide);
    }

    slides = Array.from(slidesWrap.querySelectorAll(".hero-slide"));
  }

  function updateHeroCarousel(target) {
    if (!slides.length || !slidesWrap) return;
    heroIndex = ((target % slides.length) + slides.length) % slides.length;
    slides.forEach(function (el, i) {
      el.classList.toggle("hero-slide-active", i === heroIndex);
    });
    var carouselW = heroCarousel ? heroCarousel.offsetWidth : 0;
    slidesWrap.style.transform = "translateX(-" + (heroIndex * carouselW) + "px)";
    if (dotsWrap) {
      var dots = Array.from(dotsWrap.querySelectorAll(".hero-dot"));
      dots.forEach(function (d, i) { d.classList.toggle("hero-dot-active", i === heroIndex); });
    }
  }

  function startHeroAuto() {
    if (heroTimer || slides.length <= 1) return;
    heroTimer = setInterval(() => {
      updateHeroCarousel(heroIndex + 1);
    }, HERO_INTERVAL_MS);
  }

  function stopHeroAuto() {
    if (!heroTimer) return;
    clearInterval(heroTimer);
    heroTimer = null;
  }

  if (hero && slidesWrap) {
    buildHeroSlides();
    if (slides.length) {
      // 建立 dots
      if (dotsWrap) {
        dotsWrap.innerHTML = "";
        slides.forEach((_, i) => {
          const dot = document.createElement("button");
          dot.type = "button";
          dot.className = "hero-dot" + (i === 0 ? " hero-dot-active" : "");
          dot.setAttribute("aria-label", "切換到第 " + (i + 1) + " 則");
          dot.addEventListener("click", () => {
            stopHeroAuto();
            updateHeroCarousel(i);
            startHeroAuto();
          });
          dotsWrap.appendChild(dot);
        });
      }

      prevBtn?.addEventListener("click", () => {
        stopHeroAuto();
        updateHeroCarousel(heroIndex - 1);
        startHeroAuto();
      });
      nextBtn?.addEventListener("click", () => {
        stopHeroAuto();
        updateHeroCarousel(heroIndex + 1);
        startHeroAuto();
      });

      hero.addEventListener("mouseenter", stopHeroAuto);
      hero.addEventListener("mouseleave", startHeroAuto);

      /* 手機版：手指左右滑動切換 Banner（綁在 .hero-carousel） */
      if (heroCarousel && slides.length > 1) {
        var touchStartX = 0;
        var SWIPE_THRESHOLD = 50;
        heroCarousel.addEventListener("touchstart", function (e) {
          touchStartX = e.changedTouches ? e.changedTouches[0].clientX : e.touches[0].clientX;
        }, { passive: true });
        heroCarousel.addEventListener("touchend", function (e) {
          if (!e.changedTouches || !e.changedTouches[0]) return;
          var x = e.changedTouches[0].clientX;
          var delta = x - touchStartX;
          if (delta > SWIPE_THRESHOLD) {
            stopHeroAuto();
            updateHeroCarousel(heroIndex - 1);
            startHeroAuto();
          } else if (delta < -SWIPE_THRESHOLD) {
            stopHeroAuto();
            updateHeroCarousel(heroIndex + 1);
            startHeroAuto();
          }
        }, { passive: true });
      }

      updateHeroCarousel(0);
      startHeroAuto();
      window.addEventListener("resize", function () {
        if (slides.length && slidesWrap) updateHeroCarousel(heroIndex);
      });
    }

    // Hero 進場（僅一次；prefers-reduced-motion 由 CSS 處理）
    requestAnimationFrame(function () {
      hero.classList.add("hero-ready");
    });
  }

  /* Hero LINE CTA：沿用 config.line.url；設定晚到時隨 applyConfigToHomePage 同步更新 */
  var DEFAULT_LINE_URL = "https://lin.ee/p58Bkqp";
  function syncHeroLineBtn() {
    const btn = document.getElementById("heroLineBtn");
    if (!btn) return;
    const cfg = window.DK?.getConfig?.() || {};
    const url = (cfg.line && cfg.line.url) || DEFAULT_LINE_URL;
    btn.setAttribute("href", url || DEFAULT_LINE_URL);
    if (url && url !== "#") {
      btn.setAttribute("target", "_blank");
      btn.setAttribute("rel", "noreferrer");
    }
  }
  function ensureHeroCopyFallback() {
    const tag = document.getElementById("heroTagline");
    const sub = document.getElementById("heroSub");
    if (tag && !String(tag.textContent || "").trim()) tag.textContent = "DK COMPUTER";
    if (sub && !String(sub.textContent || "").trim()) {
      sub.textContent = "依用途規劃、實機測試、售後支援。從遊戲主機到工作用電腦，由 DK 幫你配到位。";
    }
    const btn1 = document.getElementById("heroBtn1");
    if (btn1) {
      if (!String(btn1.textContent || "").replace(/\s|→/g, "").trim()) {
        btn1.textContent = "查看現貨主機";
      }
      if (!btn1.querySelector(".dk-btn-arrow")) {
        const arrow = document.createElement("span");
        arrow.className = "dk-btn-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "→";
        btn1.appendChild(document.createTextNode(" "));
        btn1.appendChild(arrow);
      }
    }
  }
  syncHeroLineBtn();
  if (window.DK && typeof window.DK.applyConfigToHomePage === "function") {
    if (!window.DK.applyConfigToHomePage._dkHeroLineWrapped) {
      const _applyConfigToHomePage = window.DK.applyConfigToHomePage;
      window.DK.applyConfigToHomePage = function () {
        var ret;
        try {
          ret = _applyConfigToHomePage.apply(this, arguments);
        } catch (err) {
          console.error("[DK home] applyConfigToHomePage failed", err);
        }
        try {
          syncHeroLineBtn();
          ensureHeroCopyFallback();
        } catch (err2) {
          console.error("[DK home] hero CTA sync failed", err2);
        }
        // 視覺效果失敗不得阻止內容顯示；且須等 homeFxReady
        if (homeFxReady) {
          try {
            refreshHomeInteractions();
          } catch (err3) {
            console.error("[DK home] refreshHomeInteractions failed", err3);
            try { forceAllRevealsVisible(); } catch (_) {}
          }
        }
        return ret;
      };
      window.DK.applyConfigToHomePage._dkHeroLineWrapped = true;
    }
  }

  /* ===== 首頁第二區：分類入口（config 驅動，僅調整外觀標記）===== */
  function renderHomeEntries() {
    const container = document.getElementById("homeCategories");
    if (!container) return;

    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const entries = Array.isArray(fe.homeEntries) ? fe.homeEntries : [];
    const list = entries.filter((e) => e && (e.title || e.image || e.link));

    if (!list.length) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = list
      .map((e, i) => {
        const href = e.link || "#";
        const title = e.title || "";
        const subtitle = e.subtitle || "";
        const img = e.image || "";
        return `
          <a href="${href}" class="home-category-item dk-card reveal-child" style="--reveal-delay:${i * 80}ms">
            <div class="home-category-img">
              ${img ? `<img src="${img}" alt="${title}" loading="lazy" onerror="this.style.display='none'" />` : ""}
            </div>
            <div class="home-category-text">
              <h3>${title}</h3>
              <p>${subtitle}</p>
              <span class="home-category-arrow" aria-hidden="true">了解更多 →</span>
            </div>
          </a>
        `;
      })
      .join("");
  }

  renderHomeEntries();

  /* 首頁 header Logo（frontend.brandLogo）與品牌文字：與 shared 初次套用互補 */
  try {
    if (typeof window.DK !== "undefined" && typeof DK.applyConfigToHomePage === "function") {
      DK.applyConfigToHomePage();
    }
  } catch (err) {
    console.error("[DK home] initial applyConfigToHomePage failed", err);
  }

  /* ===== 為什麼選 DK 電腦（第三區）：frontend.homeTrust ===== */
  const DEFAULT_HOME_TRUST = {
    title: "為什麼選 DK 電腦",
    items: [
      { id: "1", title: "每台實測穩定", text: "交機前先測試，不亂出貨" },
      { id: "2", title: "依用途幫你配機", text: "文書、遊戲、剪輯，照預算配" },
      { id: "3", title: "店家保固好處理", text: "有問題直接找人，不用自己亂跑" },
    ],
  };
  const HOME_TRUST_ICONS = ["✓", "◎", "◉"];
  function renderHomeTrust() {
    const titleEl = document.getElementById("homeTrustTitle");
    const gridEl = document.getElementById("homeTrustGrid");
    if (!titleEl || !gridEl) return;
    const cfg = window.DK?.getConfig?.() || {};
    const fe = cfg.frontend || {};
    const data = fe.homeTrust && typeof fe.homeTrust === "object" ? fe.homeTrust : DEFAULT_HOME_TRUST;
    const title = (data.title || "").trim() || DEFAULT_HOME_TRUST.title;
    const items = Array.isArray(data.items) ? data.items : DEFAULT_HOME_TRUST.items;
    const list = items.slice(0, 3).filter((e) => e && (e.title || e.text));
    if (!list.length) list.push(...DEFAULT_HOME_TRUST.items);
    titleEl.textContent = title;
    titleEl.hidden = !title;
    gridEl.innerHTML = list
      .map((item, i) => {
        const t = (item.title || "").trim() || "";
        const d = (item.text || "").trim() || "";
        const icon = HOME_TRUST_ICONS[i] || "•";
        return `<div class="home-trust-card dk-panel reveal-child" style="--reveal-delay:${i * 80}ms">
          <div class="home-trust-icon" aria-hidden="true">${icon}</div>
          <h3 class="home-trust-card-title">${escapeHtml(t)}</h3>
          <p class="home-trust-card-text">${escapeHtml(d)}</p>
        </div>`;
      })
      .join("");
  }
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
  renderHomeTrust();

  /* ===== 首頁主推主機（Hero 下方）：優先 featuredHome，否則備援遊戲分類 ===== */
  function isFeaturedHomeItem(it) {
    return it?.featuredHome === true || String(it?.featuredHome).toLowerCase() === "true";
  }

  function featuredOrderValue(it) {
    const n = Number(it?.featuredOrder);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  }

  let featuredMachinesRetryTimer = null;
  let featuredMachinesRetryCount = 0;
  const FEATURED_MACHINES_MAX_RETRY = 5;

  function clearFeaturedMachinesRetry() {
    if (featuredMachinesRetryTimer) {
      clearTimeout(featuredMachinesRetryTimer);
      featuredMachinesRetryTimer = null;
    }
    featuredMachinesRetryCount = 0;
  }

  function scheduleFeaturedMachinesRetry() {
    if (featuredMachinesRetryTimer) return;
    if (featuredMachinesRetryCount >= FEATURED_MACHINES_MAX_RETRY) {
      const host = document.getElementById("featuredMachines");
      const inner = host ? (host.querySelector(".container") || host) : null;
      if (inner) inner.innerHTML = "";
      return;
    }
    featuredMachinesRetryCount += 1;
    featuredMachinesRetryTimer = setTimeout(function () {
      featuredMachinesRetryTimer = null;
      renderFeaturedMachines();
    }, 800);
  }

  function categoryLabel(it, name, cpuText, gpuText, descText) {
    const catRaw = String(it?.category || "").trim();
    if (catRaw) return catRaw;
    const hay = (name + " " + cpuText + " " + gpuText + " " + descText).toLowerCase();
    if (hay.includes("game") || String(name).includes("遊戲") || catRaw.includes("遊戲")) return "遊戲主機";
    if (/(文書|office)/i.test(name + " " + descText)) return "文書使用";
    if (/(剪輯|設計|創作)/i.test(name + " " + descText)) return "創作工作";
    return "精選主機";
  }

  function formatFeaturedPrice(DK, price) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) return "洽詢價格";
    if (DK && typeof DK.formatPrice === "function") return DK.formatPrice(n);
    return "NT$ " + n.toLocaleString("zh-TW");
  }

  function renderFeaturedMachines() {
    const host = document.getElementById("featuredMachines");
    if (!host) return;
    const inner = host.querySelector(".container") || host;

    const DK = window.DK;
    const items = (DK && typeof DK.getInventoryForDisplay === "function") ? DK.getInventoryForDisplay() : [];
    if (!Array.isArray(items) || items.length === 0) {
      scheduleFeaturedMachinesRetry();
      return;
    }

    const featuredItems = items.filter(isFeaturedHomeItem);
    let picked;
    if (featuredItems.length > 0) {
      picked = featuredItems
        .slice()
        .sort((a, b) => {
          const ao = featuredOrderValue(a);
          const bo = featuredOrderValue(b);
          const aHas = ao != null;
          const bHas = bo != null;
          if (aHas && bHas && ao !== bo) return ao - bo;
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
          return (Number(b?.price) || 0) - (Number(a?.price) || 0);
        })
        .slice(0, 3);
    } else {
      const gameItems = items.filter((it) => {
        const catRaw = String(it?.category || "");
        const cat = catRaw.toLowerCase();
        return cat.includes("game") || catRaw.includes("遊戲");
      });
      if (gameItems.length > 0) {
        picked = gameItems
          .slice()
          .sort((a, b) => (Number(b?.price) || 0) - (Number(a?.price) || 0))
          .slice(0, 3);
      } else {
        // 第三層：無主推、無遊戲分類時，顯示全部上架商品（價格高→低，最多 3）
        picked = items
          .slice()
          .sort((a, b) => (Number(b?.price) || 0) - (Number(a?.price) || 0))
          .slice(0, 3);
      }
    }

    if (!picked.length) {
      clearFeaturedMachinesRetry();
      inner.innerHTML = "";
      return;
    }

    clearFeaturedMachinesRetry();

    const cfg = (DK && typeof DK.getConfig === "function") ? DK.getConfig() : {};
    const lineUrl = cfg?.line?.url || "";
    const countClass = "fm-count-" + Math.min(picked.length, 3);

    inner.innerHTML = `
      <div class="fm-head">
        <div class="fm-head-copy">
          <p class="fm-eyebrow">DK SELECT</p>
          <h2 class="fm-title">DK 精選主機</h2>
          <p class="fm-desc">實機測試、用途配對、售後支援</p>
        </div>
        <a class="fm-view-all" href="./machine.html">查看全部 <span aria-hidden="true">→</span></a>
      </div>
      <div class="fm-grid ${countClass}">
        ${picked
          .map((it, i) => {
            const name = String(it?.name || "").trim();
            const price = Number(it?.price);
            const priceText = formatFeaturedPrice(DK, price);
            const cpuText = String(it?.cpu || it?.spec_cpu || "未標示");
            const gpuText = String(it?.gpu || it?.spec_gpu || "未標示");
            const descText = String(it?.note || it?.description || it?.desc || "");
            const photos = Array.isArray(it?.photos) ? it.photos : [];
            const img = String(photos[0] || "").trim();
            const cat = categoryLabel(it, name, cpuText, gpuText, descText);
            const escAttr = (s) =>
              String(s || "")
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            const nameHtml = (DK && DK.escapeHtml) ? DK.escapeHtml(name) : escapeHtml(name);
            const catHtml = (DK && DK.escapeHtml) ? DK.escapeHtml(cat) : escapeHtml(cat);
            const summary = featuredSpecSummary(it, cpuText, gpuText, descText);
            const summaryHtml = summary
              ? `<p class="fm-card-spec">${(DK && DK.escapeHtml) ? DK.escapeHtml(summary) : escapeHtml(summary)}</p>`
              : "";
            return `
              <article class="fm-card dk-card reveal-child" style="--reveal-delay:${i * 80}ms">
                <div class="fm-card-media">
                  ${img
                    ? `<img src="${img}" alt="${escAttr(name)}" loading="lazy" onerror="this.style.display='none'" />`
                    : `<div class="fm-card-media-empty" aria-hidden="true"></div>`}
                </div>
                <div class="fm-card-body">
                  <div class="fm-card-cat">${catHtml}</div>
                  <h3 class="fm-card-name">${nameHtml}</h3>
                  ${summaryHtml}
                  <div class="fm-card-price">${priceText}</div>
                  <a class="dk-btn dk-btn-primary dk-btn-sm featured-line-btn" href="${lineUrl || "#"}" data-name="${escAttr(name)}" data-price="${Number.isFinite(price) ? String(price) : ""}" data-cpu="${escAttr(cpuText)}" data-gpu="${escAttr(gpuText)}">
                    LINE詢問
                    <span class="dk-btn-arrow" aria-hidden="true">→</span>
                  </a>
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    `;

    // 動態內容加入後：確定父層不會永久透明，並觀察 section 本身與子卡
    requestAnimationFrame(function () {
      ensureFeaturedSectionReveal(host);
      bindCardTilt(host);
    });
  }

  function featuredSpecSummary(it, cpuText, gpuText, descText) {
    const parts = [];
    const cpu = String(it?.cpu || it?.spec_cpu || "").trim();
    const gpu = String(it?.gpu || it?.spec_gpu || "").trim();
    if (cpu && cpu !== "未標示") parts.push(cpu);
    if (gpu && gpu !== "未標示") parts.push(gpu);
    if (parts.length) return parts.join(" · ");
    const note = String(descText || "").trim();
    if (!note) return "";
    const first = note.split(/[\n\r。！？]/).map(function (s) { return s.trim(); }).filter(Boolean)[0] || "";
    if (!first || first === "undefined" || first === "null") return "";
    return first.length > 64 ? first.slice(0, 64) + "…" : first;
  }

  document.addEventListener("click", async function (e) {
    const btn = e.target && e.target.closest ? e.target.closest(".featured-line-btn") : null;
    if (!btn) return;
    const DK = window.DK;
    const cfg = (DK && typeof DK.getConfig === "function") ? DK.getConfig() : {};
    const lineUrl = cfg?.line?.url || "";
    const name = btn.getAttribute("data-name") || "";
    const priceRaw = btn.getAttribute("data-price") || "";
    const cpu = btn.getAttribute("data-cpu") || "未標示";
    const gpu = btn.getAttribute("data-gpu") || "未標示";
    const priceNum = Number(priceRaw);
    const priceText = (!Number.isFinite(priceNum) || priceNum <= 0)
      ? "洽詢價格"
      : ((DK && typeof DK.formatPrice === "function")
        ? DK.formatPrice(priceNum)
        : (priceRaw || ""));
    const msg = `我想詢問這台主機：\n名稱：${name}\n價格：${priceText}\nCPU：${cpu}\nGPU：${gpu}`;
    try {
      if (DK && typeof DK.tryCopy === "function") {
        await DK.tryCopy(msg);
      }
    } catch (_) {}
    if (lineUrl) {
      window.open(lineUrl, "_blank", "noreferrer");
    }
  });

  window.addEventListener("dk:inventory-updated", function () {
    clearFeaturedMachinesRetry();
    renderFeaturedMachines();
  });

  /* ===== 區塊進場：IntersectionObserver（僅一次）===== */
  // 狀態變數已於 IIFE 頂部以 var 宣告，避免 TDZ

  function getHomeStyleSafe() {
    const cfg = window.DK?.getConfig?.() || {};
    if (typeof window.DK?.normalizeHomeStyle === "function") {
      return window.DK.normalizeHomeStyle(cfg.frontend && cfg.frontend.homeStyle);
    }
    return {
      heroContentPosition: "left",
      heroOverlayStrength: 70,
      heroAccentGlow: true,
      sectionReveal: true,
      mouseGlow: true,
      cardTilt: false,
    };
  }

  function isFinePointerDesktop() {
    try {
      return !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches && window.matchMedia("(hover: hover)").matches);
    } catch (_) {
      return window.innerWidth >= 981;
    }
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function sectionRevealEnabled() {
    const hs = getHomeStyleSafe();
    return hs.sectionReveal !== false && !document.body.classList.contains("dk-reveal-off");
  }

  function forceAllRevealsVisible() {
    document.querySelectorAll(".reveal, .reveal-child").forEach(function (el) {
      el.classList.add("is-visible");
    });
    if (revealObserver) {
      try {
        document.querySelectorAll(".reveal, .reveal-child").forEach(function (el) {
          revealObserver.unobserve(el);
        });
      } catch (_) {}
    }
  }

  function collectRevealNodes(root) {
    const nodes = [];
    const seen = typeof Set === "function" ? new Set() : null;
    function add(el) {
      if (!el || !el.classList) return;
      if (!el.classList.contains("reveal") && !el.classList.contains("reveal-child")) return;
      if (el.classList.contains("is-visible")) return;
      if (seen) {
        if (seen.has(el)) return;
        seen.add(el);
      } else if (nodes.indexOf(el) !== -1) {
        return;
      }
      nodes.push(el);
    }

    const scope = root || document;
    if (scope && scope !== document && scope.nodeType === 1) {
      add(scope);
    }
    if (scope && typeof scope.querySelectorAll === "function") {
      const list = scope.querySelectorAll(".reveal:not(.is-visible), .reveal-child:not(.is-visible)");
      for (let i = 0; i < list.length; i++) add(list[i]);
    }
    return nodes;
  }

  function isElementInViewport(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.height > 0 && rect.top < vh && rect.bottom > 0;
  }

  function observeReveals(root) {
    if (!sectionRevealEnabled() || prefersReducedMotion() || !("IntersectionObserver" in window)) {
      const nodes = collectRevealNodes(root);
      nodes.forEach(function (el) { el.classList.add("is-visible"); });
      if (!sectionRevealEnabled() || prefersReducedMotion()) forceAllRevealsVisible();
      return;
    }

    const nodes = collectRevealNodes(root);
    if (!nodes.length) return;

    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    }

    nodes.forEach(function (el) {
      try { revealObserver.unobserve(el); } catch (_) {}
      revealObserver.observe(el);
    });
  }

  function ensureFeaturedSectionReveal(host) {
    if (!host) return;

    if (!sectionRevealEnabled() || prefersReducedMotion() || !("IntersectionObserver" in window)) {
      host.classList.add("is-visible");
      host.querySelectorAll(".reveal-child").forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }

    if (isElementInViewport(host)) {
      host.classList.add("is-visible");
    } else if (revealObserver) {
      try { revealObserver.unobserve(host); } catch (_) {}
    }

    observeReveals(host);
  }

  /* ===== 導覽捲動 class ===== */
  function updateHeaderScrollState() {
    const header = document.querySelector(".site-header");
    if (!header) return;
    header.classList.toggle("is-scrolled", (window.scrollY || window.pageYOffset || 0) > 12);
  }

  function onScrollHeader() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      updateHeaderScrollState();
    });
  }

  /* ===== 滑鼠光暈 ===== */
  function setMouseGlowEnabled(on) {
    const glow = document.getElementById("dkMouseGlow");
    if (!glow) return;
    const allow = on && isFinePointerDesktop() && !prefersReducedMotion() && getHomeStyleSafe().mouseGlow !== false;
    glow.classList.toggle("is-active", !!allow);
    if (!allow) glow.classList.remove("is-on");
  }

  function onMouseGlowMove(e) {
    if (!isFinePointerDesktop() || prefersReducedMotion()) return;
    if (getHomeStyleSafe().mouseGlow === false || document.body.classList.contains("dk-mouse-glow-off")) return;
    mouseGlowX = e.clientX;
    mouseGlowY = e.clientY;
    if (mouseGlowRaf) return;
    mouseGlowRaf = requestAnimationFrame(function () {
      mouseGlowRaf = 0;
      const glow = document.getElementById("dkMouseGlow");
      if (!glow || !glow.classList.contains("is-active")) return;
      glow.style.transform = "translate3d(" + (mouseGlowX - 180) + "px," + (mouseGlowY - 180) + "px,0)";
      glow.classList.add("is-on");
    });
  }

  function onMouseGlowLeave() {
    const glow = document.getElementById("dkMouseGlow");
    if (glow) glow.classList.remove("is-on");
  }

  /* ===== 商品卡 3D tilt（可選）===== */
  function clearCardTilt(card) {
    if (!card) return;
    card.style.transform = "";
    card.classList.remove("is-tilting");
  }

  function bindCardTilt(scope) {
    const root = scope || document;
    const cards = root.querySelectorAll ? root.querySelectorAll(".fm-card") : [];
    cards.forEach(function (card) {
      if (card._dkTiltBound) return;
      card._dkTiltBound = true;
      card.addEventListener("mousemove", function (e) {
        if (!getHomeStyleSafe().cardTilt) return;
        if (!isFinePointerDesktop() || prefersReducedMotion()) return;
        if (!document.body.classList.contains("dk-card-tilt-on")) return;
        const rect = card.getBoundingClientRect();
        const px = (e.clientX - rect.left) / Math.max(rect.width, 1);
        const py = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const ry = (px - 0.5) * 5; // max ~2.5deg each side
        const rx = (0.5 - py) * 5;
        const clamp = function (n) { return Math.max(-2.5, Math.min(2.5, n)); };
        if (tiltRaf) cancelAnimationFrame(tiltRaf);
        tiltRaf = requestAnimationFrame(function () {
          card.classList.add("is-tilting");
          card.style.transform = "perspective(900px) rotateX(" + clamp(rx) + "deg) rotateY(" + clamp(ry) + "deg) translateY(-4px)";
        });
      });
      card.addEventListener("mouseleave", function () {
        clearCardTilt(card);
      });
    });
  }

  function refreshHomeInteractions() {
    const hs = getHomeStyleSafe();
    try {
      if (typeof window.DK?.applyHomeStyleToPage === "function") {
        window.DK.applyHomeStyleToPage(hs);
      }
    } catch (err) {
      console.error("[DK home] applyHomeStyleToPage failed", err);
    }
    try {
      setMouseGlowEnabled(hs.mouseGlow !== false);
    } catch (err) {
      console.error("[DK home] mouseGlow failed", err);
    }
    try {
      if (!hs.sectionReveal) forceAllRevealsVisible();
      else observeReveals(document);
    } catch (err) {
      console.error("[DK home] reveal failed", err);
      forceAllRevealsVisible();
    }
    try {
      bindCardTilt(document.getElementById("featuredMachines"));
    } catch (err) {
      console.error("[DK home] cardTilt failed", err);
    }
    try {
      ensureHeroCopyFallback();
    } catch (_) {}
  }

  function bindHomeInteractionsOnce() {
    if (homeInteractionsBound) return;
    homeInteractionsBound = true;
    window.addEventListener("scroll", onScrollHeader, { passive: true });
    updateHeaderScrollState();
    window.addEventListener("mousemove", onMouseGlowMove, { passive: true });
    window.addEventListener("mouseleave", onMouseGlowLeave);
    window.addEventListener("blur", onMouseGlowLeave);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) onMouseGlowLeave();
    });
  }

  homeFxReady = true;
  try {
    bindHomeInteractionsOnce();
  } catch (err) {
    console.error("[DK home] bindHomeInteractionsOnce failed", err);
  }
  try {
    ensureHeroCopyFallback();
  } catch (_) {}
  try {
    refreshHomeInteractions();
  } catch (err) {
    console.error("[DK home] refreshHomeInteractions failed", err);
    try { forceAllRevealsVisible(); } catch (_) {}
  }
  try {
    observeReveals(document);
  } catch (err) {
    console.error("[DK home] observeReveals failed", err);
    try { forceAllRevealsVisible(); } catch (_) {}
  }
  try {
    renderFeaturedMachines();
  } catch (err) {
    console.error("[DK home] renderFeaturedMachines failed", err);
    try { forceAllRevealsVisible(); } catch (_) {}
  }
  // 安全備援：若仍有主區塊卡在 opacity:0，下一幀強制顯示
  requestAnimationFrame(function () {
    var stuck = document.querySelectorAll(
      "#featuredMachines.reveal:not(.is-visible), #home-entries.reveal:not(.is-visible), #home-trust.reveal:not(.is-visible)",
    );
    if (stuck && stuck.length) {
      forceAllRevealsVisible();
    }
  });
})();
