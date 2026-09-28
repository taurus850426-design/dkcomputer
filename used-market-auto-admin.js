/* Stage 33: auto market candidate preview. Candidates never publish automatically. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => {
    const el = document.createElement("div");
    el.textContent = value == null ? "" : String(value);
    return el.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  const money = (value) => value == null ? "—" : "NT$ " + Math.round(Number(value)).toLocaleString("zh-TW");
  const time = (value) => value ? new Date(value).toLocaleString("zh-TW") : "—";
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (_) { return ""; }
  };

  function message(text, error) {
    const el = $("uamMsg");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
    el.classList.toggle("uv-msg-error", !!error);
  }

  async function load() {
    if (typeof stage7RestJson !== "function") return;
    message("載入自動行情候選…", false);
    const res = await stage7RestJson("used_market_candidate_summary?select=*&order=category.asc,model.asc");
    if (!res.ok) {
      message(res.status === 404 ? "尚未執行 Stage 33 資料庫更新。" : "自動行情候選載入失敗。", true);
      return;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    const total = rows.reduce((n, row) => n + Number(row.accepted_count || 0), 0);
    const latest = rows.map((row) => row.last_collected_at).filter(Boolean).sort().pop();
    $("uamModelCount").textContent = String(rows.length);
    $("uamAcceptedCount").textContent = String(total);
    $("uamUpdatedAt").textContent = time(latest);
    $("uamSummaryBody").innerHTML = rows.length ? rows.map((row) =>
      "<tr>" +
      "<td>" + esc(row.category) + "</td>" +
      "<td><strong>" + esc([row.brand, row.model, row.variant].filter(Boolean).join(" ")) + "</strong><div class=\"muted small\">" + esc(row.search_query) + "</div></td>" +
      "<td class=\"table-number\">" + esc(row.accepted_count || 0) + "／" + esc(row.rejected_count || 0) + "</td>" +
      "<td class=\"table-number\">" + money(row.market_low) + "</td>" +
      "<td class=\"table-number\"><strong>" + money(row.market_mid) + "</strong></td>" +
      "<td class=\"table-number\">" + money(row.market_high) + "</td>" +
      "<td>" + esc(time(row.last_collected_at)) + "</td>" +
      "<td><button type=\"button\" class=\"btn btn-ghost btn-sm\" data-uam-view=\"" + esc(row.watchlist_id) + "\">明細</button> <button type=\"button\" class=\"btn btn-ghost btn-sm\" data-uam-run=\"" + esc(row.watchlist_id) + "\">抓取</button></td>" +
      "</tr>"
    ).join("") : "<tr><td colspan=\"8\" class=\"muted\">目前沒有監控型號。</td></tr>";
    message("", false);
  }

  async function observations(id) {
    const path = "used_market_observations?watchlist_id=eq." + encodeURIComponent(id) + "&select=title,price,source_name,item_url,accepted,reject_reason,collected_at&order=collected_at.desc&limit=40";
    const res = await stage7RestJson(path);
    if (!res.ok) { message("明細載入失敗。", true); return; }
    const rows = Array.isArray(res.data) ? res.data : [];
    $("uamObservationList").innerHTML = rows.length ? rows.map((row) => {
      const link = safeUrl(row.item_url);
      return (
      "<article class=\"uv-auto-observation" + (row.accepted ? "" : " is-rejected") + "\">" +
      "<div><strong>" + esc(money(row.price)) + "｜" + esc(row.title) + "</strong></div>" +
      "<div class=\"muted small\">" + esc(row.source_name || "未知來源") + "｜" + esc(row.accepted ? "納入" : "排除：" + (row.reject_reason || "不符合條件")) + "｜" + esc(time(row.collected_at)) + "</div>" +
      (link ? "<a href=\"" + esc(link) + "\" target=\"_blank\" rel=\"noopener noreferrer\">查看來源</a>" : "") +
      "</article>"
      );
    }).join("") : "<p class=\"muted small\">此型號尚未抓取資料。</p>";
    const details = $("uamObservationList").closest("details");
    if (details) details.open = true;
  }

  async function collect(watchlistId) {
    if (typeof callBackofficeEdgeFunction !== "function") return;
    message("正在抓取公開行情，請稍候…", false);
    const body = watchlistId ? { watchlist_id: watchlistId } : { limit: 5 };
    const res = await callBackofficeEdgeFunction("used-market-collector", body);
    if (!res.ok) {
      const code = res.data && res.data.code;
      message(code === "API_KEY_MISSING" ? "程式已完成，尚需設定 SERPAPI_API_KEY 才能開始抓取。" : "抓取失敗，請確認 Edge Function 與資料庫已部署。", true);
      return;
    }
    await load();
    const failed = (res.data.runs || []).filter((run) => !run.ok).length;
    message("抓取完成：" + Number(res.data.models || 0) + " 個型號、" + Number(res.data.observations || 0) + " 筆候選資料。" + (failed ? "其中 " + failed + " 個型號失敗，請稍後重試。" : ""), failed > 0);
  }

  function bind() {
    const root = $("tab-used-market");
    if (!root || root.dataset.uamBound === "1") return;
    root.dataset.uamBound = "1";
    $("uamRefresh").addEventListener("click", load);
    $("uamCollect").addEventListener("click", () => collect(""));
    root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-uam-view],[data-uam-run]");
      if (!target) return;
      const view = target.getAttribute("data-uam-view");
      const run = target.getAttribute("data-uam-run");
      if (view) observations(view);
      if (run) collect(run);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
