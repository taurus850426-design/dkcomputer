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

  /* ===== 首頁主推主機（Hero 下方）：從 inventory 篩選 ===== */
  function renderFeaturedMachines(retriesLeft) {
    if (retriesLeft == null) retriesLeft = 5;
    const host = document.getElementById("featuredMachines");
    if (!host) return;
    const inner = host.querySelector(".container") || host;

    const DK = window.DK;
    const items = (DK && typeof DK.getInventoryForDisplay === "function") ? DK.getInventoryForDisplay() : [];
    if (!Array.isArray(items) || items.length === 0) {
      if (retriesLeft > 0) {
        setTimeout(() => renderFeaturedMachines(retriesLeft - 1), 800);
      } else {
        inner.innerHTML = "";
      }
      return;
    }

    const picked = items
      .filter((it) => {
        const catRaw = String(it?.category || "");
        const cat = catRaw.toLowerCase();
        return cat.includes("game") || catRaw.includes("遊戲");
      })
      .sort((a, b) => (Number(b?.price) || 0) - (Number(a?.price) || 0))
      .slice(0, 3);

    if (!picked.length) {
      inner.innerHTML = "";
      return;
    }

    const cfg = (DK && typeof DK.getConfig === "function") ? DK.getConfig() : {};
    const lineUrl = cfg?.line?.url || "";

    inner.innerHTML = `
      <div class="section-head" style="margin-bottom:12px">
        <h2 class="h2" style="margin:0">主推主機</h2>
        <div class="muted small">30,000 以內精選（遊戲）</div>
      </div>
      <div class="machine-cards">
        ${picked
          .map((it) => {
            const name = String(it?.name || "").trim();
            const price = Number(it?.price);
            const priceText = (DK && typeof DK.formatPrice === "function") ? DK.formatPrice(price) : ("NT$ " + price.toLocaleString("zh-TW"));
            const cpuText = String(it?.cpu || it?.spec_cpu || "未標示");
            const gpuText = String(it?.gpu || it?.spec_gpu || "未標示");
            const descText = String(it?.note || it?.description || it?.desc || "");
            const photos = Array.isArray(it?.photos) ? it.photos : [];
            const img = String(photos[0] || "").trim();
            const escAttr = (s) =>
              String(s || "")
                .replace(/&/g, "&amp;")
                .replace(/"/g, "&quot;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            const badgeHtml = (() => {
              const tags = [];
              const add = (t) => {
                if (!t) return;
                if (tags.includes(t)) return;
                if (tags.length >= 3) return;
                tags.push(t);
              };
              const catRaw = String(it?.category || "");
              const cat = catRaw.toLowerCase();
              if (cat.includes("game") || catRaw.includes("遊戲")) add("遊戲主機");
              const hay = (name + " " + cpuText + " " + gpuText + " " + descText).toLowerCase();
              if (/(4060|4070|3060|3070|rx\s*6700|rx6700)/i.test(hay)) add("3A遊戲");
              if (/(2060|1660|6600|3050)/i.test(hay)) add("1080P遊戲");
              if (/(文書|office)/i.test(name + " " + descText)) add("文書使用");
              if (/(剪輯|設計|創作)/i.test(name + " " + descText)) add("剪輯設計");
              if (!tags.length) return "";
              return `<div class="fm-badges" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:6px 0 10px">` +
                tags.map((t) => `<span class="fm-badge" style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:12px;background:rgba(17,24,39,0.06);color:#111827;">${t}</span>`).join("") +
                `</div>`;
            })();
            return `
              <article class="machine-card">
                <div style="margin-bottom:10px">
                  ${img ? `<img src="${img}" alt="" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:12px;display:block" onerror="this.style.display='none'" />` : ""}
                </div>
                <div style="font-weight:700;margin-bottom:6px">${(DK && DK.escapeHtml) ? DK.escapeHtml(name) : name}</div>
                ${badgeHtml}
                <div class="muted" style="margin-bottom:12px">${priceText}</div>
                <a class="btn btn-primary btn-sm featured-line-btn" href="${lineUrl || "#"}" data-name="${escAttr(name)}" data-price="${Number.isFinite(price) ? String(price) : ""}" data-cpu="${escAttr(cpuText)}" data-gpu="${escAttr(gpuText)}">
                  LINE詢問
                </a>
              </article>
            `;
          })
          .join("")}
      </div>
    `;
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
    const priceText = (Number.isFinite(priceNum) && DK && typeof DK.formatPrice === "function")
      ? DK.formatPrice(priceNum)
      : (priceRaw || "");
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

  renderFeaturedMachines();
})();
