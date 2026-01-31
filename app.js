/* app.js - 首頁：庫存搜尋/篩選/渲染 */

(function () {
  const grid = document.getElementById("inventoryGrid");
  const empty = document.getElementById("emptyState");
  const searchInput = document.getElementById("searchInput");
  const stockSelect = document.getElementById("stockSelect");
  const segs = Array.from(document.querySelectorAll(".segmented .seg"));

  if (!grid || !empty || !searchInput || !stockSelect) return;

  let state = {
    query: "",
    category: "全部",
    stock: "全部",
  };

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
          <div class="item-name">${DK.escapeHtml(item.name)}</div>
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
          <button class="btn btn-primary btn-sm" type="button">加 LINE 下單</button>
        </div>
      `;

      const btn = el.querySelector("button");
      btn.addEventListener("click", () => DK.openLineOrder(item));

      grid.appendChild(el);
    }
  }

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

  render();
})();

