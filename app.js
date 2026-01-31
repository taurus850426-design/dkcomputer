/* app.js - 首頁：庫存搜尋/篩選/渲染 */

(function () {
  const grid = document.getElementById("inventoryGrid");
  const empty = document.getElementById("emptyState");
  const searchInput = document.getElementById("searchInput");
  const stockSelect = document.getElementById("stockSelect");
  const segs = Array.from(document.querySelectorAll(".segmented .seg"));

  if (!grid || !empty || !searchInput || !stockSelect) return;

  // 焦點推薦（首頁最上方）
  const focusHotGrid = document.getElementById("focusHotGrid");
  const focusHotEmpty = document.getElementById("focusHotEmpty");
  const focusGameGrid = document.getElementById("focusGameGrid");
  const focusGameEmpty = document.getElementById("focusGameEmpty");
  const focusOnlyInStockBtn = document.getElementById("focusOnlyInStockBtn");
  const focusHotBtn = document.getElementById("focusHotBtn");
  const focusGameBtn = document.getElementById("focusGameBtn");

  let state = {
    query: "",
    category: "全部",
    stock: "全部",
  };

  function stockRank(stockStatus) {
    if (stockStatus === "現貨") return 0;
    if (stockStatus === "低庫存") return 1;
    if (stockStatus === "缺貨") return 2;
    return 9;
  }

  function isHotItem(item) {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    const hay = DK.normalizeText([item?.name, ...tags].join(" "));
    return hay.includes("熱銷") || hay.includes("熱門") || hay.includes("推薦");
  }

  function pickHotItems(items) {
    return [...items]
      .filter((x) => x && isHotItem(x))
      .sort((a, b) => stockRank(a.stockStatus) - stockRank(b.stockStatus) || (b.price || 0) - (a.price || 0))
      .slice(0, 3);
  }

  function pickGameItems(items) {
    return [...items]
      .filter((x) => x && x.category === "遊戲")
      .sort((a, b) => stockRank(a.stockStatus) - stockRank(b.stockStatus) || (b.price || 0) - (a.price || 0))
      .slice(0, 3);
  }

  function renderMiniList(hostEl, list) {
    if (!hostEl) return;
    hostEl.innerHTML = "";

    for (const item of list) {
      const el = document.createElement("div");
      el.className = "mini-item";

      const badgeClass = DK.stockBadgeClass(item.stockStatus);
      const photos = Array.isArray(item.photos) ? item.photos : [];
      const firstPhoto = photos[0] || "";

      el.innerHTML = `
        ${firstPhoto ? `<img class="mini-photo" alt="${DK.escapeHtml(item.name)}" src="${firstPhoto}" loading="lazy" />` : ""}
        <div class="mini-main">
          <div class="mini-top">
            <a class="mini-name" href="./product.html?id=${encodeURIComponent(item.id)}">${DK.escapeHtml(item.name)}</a>
            <span class="badge ${badgeClass}">${DK.escapeHtml(item.stockStatus)}</span>
          </div>
          <div class="mini-spec muted">CPU：${DK.escapeHtml(item.cpu || "-")}｜GPU：${DK.escapeHtml(item.gpu || "-")}</div>
          <div class="mini-bottom">
            <div class="price"><small>NT$</small> ${DK.formatPrice(item.price) || "-"}</div>
            <div class="mini-actions">
              <a class="btn btn-ghost btn-sm" href="./product.html?id=${encodeURIComponent(item.id)}">查看詳情</a>
              <button class="btn btn-primary btn-sm" type="button">加 LINE 下單</button>
            </div>
          </div>
        </div>
      `;

      el.querySelector("button")?.addEventListener("click", () => DK.openLineOrder(item));
      hostEl.appendChild(el);
    }
  }

  function renderFocus() {
    const items = DK.getInventory();

    const hot = pickHotItems(items);
    const game = pickGameItems(items);

    if (focusHotEmpty) focusHotEmpty.hidden = hot.length > 0;
    if (focusGameEmpty) focusGameEmpty.hidden = game.length > 0;
    renderMiniList(focusHotGrid, hot);
    renderMiniList(focusGameGrid, game);
  }

  function matches(item) {
    const q = DK.normalizeText(state.query);

    if (state.category !== "全部" && item.category !== state.category) return false;
    if (state.stock !== "全部" && item.stockStatus !== state.stock) return false;

    if (!q) return true;

    const hay = [
      item.name,
      item.category,
      item.stockStatus,
      item.cpu,
      item.gpu,
      item.ram,
      item.ssd,
      ...(item.tags ?? []),
      item.note,
    ]
      .map(DK.normalizeText)
      .join(" ");

    return hay.includes(q);
  }

  function setStock(v) {
    state.stock = v;
    stockSelect.value = v;
  }

  function setCategory(v) {
    state.category = v;
    for (const s of segs) s.classList.toggle("active", (s.dataset.category || "全部") === v);
  }

  function setQuery(v) {
    state.query = v;
    searchInput.value = v;
  }

  function scrollToInventory() {
    document.getElementById("inventory")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function render() {
    const items = DK.getInventory().filter(matches);
    grid.innerHTML = "";

    if (items.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const item of items) {
      const el = document.createElement("article");
      el.className = "card item";

      const badgeClass = DK.stockBadgeClass(item.stockStatus);
      const tags = Array.isArray(item.tags) ? item.tags : [];
      const photos = Array.isArray(item.photos) ? item.photos : [];
      const firstPhoto = photos[0] || "";

      const tagBadges = tags
        .slice(0, 4)
        .map((t) => `<span class="badge tag">${DK.escapeHtml(t)}</span>`)
        .join("");

      el.innerHTML = `
        ${firstPhoto ? `<img class="item-photo" alt="${DK.escapeHtml(item.name)}" src="${firstPhoto}" loading="lazy" />` : ""}
        <div class="item-top">
          <a class="item-name" href="./product.html?id=${encodeURIComponent(item.id)}">${DK.escapeHtml(item.name)}</a>
          <div class="badges">
            <span class="badge ${badgeClass}">${DK.escapeHtml(item.stockStatus)}</span>
            <span class="badge tag">${DK.escapeHtml(item.category)}</span>
            ${tagBadges}
          </div>
        </div>

        <div class="spec">
          <div class="row"><div class="k">CPU</div><div class="v">${DK.escapeHtml(item.cpu || "-")}</div></div>
          <div class="row"><div class="k">GPU</div><div class="v">${DK.escapeHtml(item.gpu || "-")}</div></div>
          <div class="row"><div class="k">RAM</div><div class="v">${DK.escapeHtml(item.ram || "-")}</div></div>
          <div class="row"><div class="k">SSD</div><div class="v">${DK.escapeHtml(item.ssd || "-")}</div></div>
        </div>

        <div class="item-bottom">
          <div class="price"><small>NT$</small> ${DK.formatPrice(item.price) || "-"}</div>
          <div class="item-actions">
            <a class="btn btn-ghost btn-sm" href="./product.html?id=${encodeURIComponent(item.id)}">查看詳情</a>
            <button class="btn btn-primary btn-sm" type="button">加 LINE 下單</button>
          </div>
        </div>
      `;

      const btn = el.querySelector("button");
      btn.addEventListener("click", () => DK.openLineOrder(item));

      grid.appendChild(el);
    }
  }

  // 焦點推薦操作：一鍵套用篩選
  focusOnlyInStockBtn?.addEventListener("click", () => {
    setStock("現貨");
    render();
    scrollToInventory();
  });

  focusGameBtn?.addEventListener("click", () => {
    setCategory("遊戲");
    setStock("全部");
    setQuery("");
    render();
    scrollToInventory();
  });

  focusHotBtn?.addEventListener("click", () => {
    setCategory("全部");
    setStock("全部");
    setQuery("熱銷");
    render();
    // 若使用者沒有用「熱銷」標籤，試著退而求其次
    if (DK.getInventory().filter(matches).length === 0) {
      setQuery("熱門");
      render();
    }
    if (DK.getInventory().filter(matches).length === 0) {
      setQuery("推薦");
      render();
    }
    scrollToInventory();
  });

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    render();
  });

  stockSelect.addEventListener("change", () => {
    state.stock = stockSelect.value;
    render();
  });

  for (const seg of segs) {
    seg.addEventListener("click", () => {
      for (const s of segs) s.classList.remove("active");
      seg.classList.add("active");
      state.category = seg.dataset.category || "全部";
      render();
    });
  }

  renderFocus();
  render();
})();

