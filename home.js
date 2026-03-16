/* home.js - 首頁 Hero 輪播與產品展示（不更動既有設定與資料結構） */

// 首頁專用腳本：Hero 輪播 + 分類入口
(function () {
  /* ===== Hero Banner 輪播（第一區）：從設定讀取 homeBanners ===== */
  const hero = document.getElementById("hero");
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
    if (!slides.length) return;
    heroIndex = ((target % slides.length) + slides.length) % slides.length;
    slides.forEach((el, i) => {
      el.classList.toggle("hero-slide-active", i === heroIndex);
    });
    if (dotsWrap) {
      const dots = Array.from(dotsWrap.querySelectorAll(".hero-dot"));
      dots.forEach((d, i) => d.classList.toggle("hero-dot-active", i === heroIndex));
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

      updateHeroCarousel(0);
      startHeroAuto();
    }
  }

  /* ===== 首頁第二區：ROG 風格分類入口（config 驅動）===== */
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
      .map((e) => {
        const href = e.link || "#";
        const title = e.title || "";
        const subtitle = e.subtitle || "";
        const img = e.image || "";
        return `
          <a href="${href}" class="home-category-item">
            <div class="home-category-img">
              ${img ? `<img src="${img}" alt="${title}" loading="lazy" onerror="this.style.display='none'" />` : ""}
            </div>
            <div class="home-category-text">
              <h3>${title}</h3>
              <p>${subtitle}</p>
            </div>
          </a>
        `;
      })
      .join("");
  }

  renderHomeEntries();
})();
