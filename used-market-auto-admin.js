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
    const res = await stage7RestJson("used_market_review_summary?select=*&order=category.asc,model.asc");
    if (!res.ok) {
      message("人工審核行情載入失敗，請確認已執行 Stage 35 SQL 並以管理員登入。", true);
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
      "<td class=\"table-number\">台灣已確認 " + esc(row.accepted_count || 0) + "<br>海外 " + esc(row.overseas_count || 0) + "／待確認 " + esc(row.pending_count || 0) + "<br>" + (Number(row.accepted_count) < 3 ? "樣本不足（至少 3 筆）" : "可轉入草稿") + "</td>" +
      "<td class=\"table-number\">" + money(row.market_low) + "</td>" +
      "<td class=\"table-number\"><strong>" + money(row.market_mid) + "</strong></td>" +
      "<td class=\"table-number\">" + money(row.market_high) + "</td>" +
      "<td>" + esc(time(row.last_collected_at)) + "</td>" +
      "<td><button type=\"button\" class=\"btn btn-ghost btn-sm\" data-uam-view=\"" + esc(row.watchlist_id) + "\">明細</button> <button type=\"button\" class=\"btn btn-ghost btn-sm\" data-uam-run=\"" + esc(row.watchlist_id) + "\">抓取</button></td>" +
      "</tr>"
    ).join("") : "<tr><td colspan=\"8\" class=\"muted\">目前沒有監控型號。</td></tr>";
    message("", false);
  }

  let selectedWatchlist = "";
  let detailRequest = 0;
  let detailRows = [];
  let writing = false;
  let collecting = false;
  async function observations(id) {
    const request = ++detailRequest;
    detailRows = [];
    $('uamObservationList').textContent = '載入最新樣本…';
    const path = "used_market_review_candidates?watchlist_id=eq." + encodeURIComponent(id) + "&select=*&order=collected_at.desc,id.asc&limit=200";
    const res = await stage7RestJson(path);
    if (request !== detailRequest) return;
    if (!res.ok) { message("明細載入失敗。", true); return; }
    selectedWatchlist = id;
    const rows = Array.isArray(res.data) ? res.data : [];
    detailRows = rows;
    const card = (row) => {
      const link = safeUrl(row.item_url);
      return (
      "<article class=\"uv-auto-observation" + (row.accepted ? "" : " is-rejected") + "\">" +
      "<div><strong>" + esc(row.title) + "</strong></div>" +
      "<div>搜尋回傳價格：" + esc(row.price) + "（幣別與運費待核對）</div>" +
      "<div>二手依據：來源標籤「" + esc(row.condition_label || "未提供") + "」；" + esc(row.accepted ? "通過程式初篩，非人工保證" : "排除：" + row.reject_reason) + "</div>" +
      "<div class=\"muted small\">" + esc(row.source_name || "未知來源") + "｜" + esc(time(row.collected_at)) + "</div>" +
      (row.approved !== null ? "<p>審核：" + esc(row.approved ? "已確認，含運 " + money(row.confirmed_price) : "人工排除") + "｜" + esc(row.evidence_note) + "</p>" : "<p>尚未人工確認；來源名稱僅供分區參考。</p>") +
      (link ? "<a href=\"" + esc(link) + "\" target=\"_blank\" rel=\"noopener noreferrer\">查看來源</a>" : "") +
      " <button type=\"button\" class=\"btn btn-ghost btn-sm\" data-uam-review=\"" + esc(row.id) + "\">核對／排除</button>" +
      "</article>"
      );
    };
    const groups = [
      ['台灣已確認', (row) => row.region === 'TW' && row.approved && row.accepted],
      ['海外參考（不計入台灣行情）', (row) => row.source_region === 'OVERSEAS' && row.approved !== false && row.accepted],
      ['待確認地區／商品', (row) => row.source_region !== 'OVERSEAS' && row.approved == null && row.accepted],
      ['已排除', (row) => !row.accepted || row.approved === false],
    ];
    $("uamObservationList").innerHTML = '<p>僅列最近 30 天新版資料，每個連結最新一筆；重新抓取後需重新核對。最多顯示 200 筆。</p>' + groups.map(([title, match]) =>
      '<section><h4>' + title + '</h4>' + (rows.filter(match).map(card).join('') || '<p class="muted">目前沒有資料</p>') + '</section>'
    ).join('') + '<div id="uamReviewEditor"></div><div class="section-card-soft"><label>匯入既有草稿 <select id="uamDraftBatch"><option value="">載入草稿中…</option></select></label> <button type="button" class="btn btn-primary" id="uamImport">將已確認台灣樣本轉入草稿</button><p class="muted small">至少 3 個不同連結。只新增草稿行情，不會啟用批次；需先在行情管理建立草稿。</p></div>';
    const details = $("uamObservationList").closest("details");
    if (details) details.open = true;
    const batches = await stage7RestJson('used_market_batches?select=id,batch_code&status=eq.DRAFT&order=created_at.desc');
    if (request !== detailRequest) return;
    $("uamDraftBatch").innerHTML = '<option value="">請選擇草稿批次</option>' + (batches.ok && Array.isArray(batches.data) ? batches.data : []).map((b) => '<option value="' + esc(b.id) + '">' + esc(b.batch_code) + '</option>').join('');
    $("uamImport").disabled = !batches.ok;
    $("uamImport").addEventListener('click', importReviewed);
    if (!batches.ok) message('無法載入草稿批次，請重新整理。', true);
  }

  function reviewEditor(id) {
    const row = detailRows.find((item) => item.id === id);
    if (!row || writing) return;
    const host = $('uamReviewEditor');
    host.innerHTML = '<form id="uamReviewForm" class="section-card-soft"><h4>人工核對：' + esc(row.title) + '</h4>' +
      '<label>商品所在地 <select id="uamRegion"><option value="UNKNOWN">尚未確認</option><option value="TW">台灣</option><option value="OVERSEAS">海外</option></select></label>' +
      '<label>核實含運台幣開價 <input id="uamConfirmedPrice" type="number" min="0.01" max="999999.99" step="0.01"></label>' +
      '<label>核對依據／排除原因（5–1000 字）<textarea id="uamEvidence" required minlength="5" maxlength="1000" placeholder="例如：商品頁二手、台灣出貨、單顆規格及含運總價；已檢查重複刊登"></textarea></label>' +
      '<label><input type="checkbox" id="uamAttest">我已開啟來源，核對二手狀態、型號規格、所在地、含運台幣價及重複刊登</label>' +
      '<button class="btn btn-primary" type="submit"' + (row.accepted ? '' : ' disabled') + '>確認樣本</button> <button class="btn btn-ghost" type="button" id="uamReject">排除此筆</button></form>';
    $('uamRegion').value = row.region || 'UNKNOWN';
    $('uamConfirmedPrice').value = row.confirmed_price || '';
    $('uamEvidence').value = row.evidence_note || '';
    $('uamReviewForm').addEventListener('submit', (event) => { event.preventDefault(); saveReview(id, true); });
    $('uamReject').addEventListener('click', () => saveReview(id, false));
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function saveReview(id, approved) {
    if (writing) return;
    const note = $('uamEvidence').value.trim();
    const region = $('uamRegion').value;
    const price = Number($('uamConfirmedPrice').value);
    if (note.length < 5 || note.length > 1000) return message('請填寫 5–1000 字的核對依據或排除原因。', true);
    if (approved && (!$('uamAttest').checked || region === 'UNKNOWN' || !Number.isFinite(price) || price <= 0 || price >= 1000000)) return message('請完成核對勾選、選擇地區並填寫有效的含運台幣價格。', true);
    await writeAction('backoffice_used_market_review', { p_observation_id: id, p_region: region, p_approved: approved, p_confirmed_price: approved ? price : null, p_evidence_note: note }, '審核已儲存。');
  }

  async function importReviewed() {
    if (writing || collecting) return;
    const batchId = $('uamDraftBatch').value;
    if (!batchId) return message('請先選擇草稿批次。', true);
    if (!window.confirm('將人工確認的台灣樣本新增到此草稿？不會自動啟用；同型號同草稿只允許匯入一次。')) return;
    await writeAction('backoffice_used_market_import_reviewed', { p_watchlist_id: selectedWatchlist, p_batch_id: batchId }, '已轉入草稿，請到行情資料審核後再決定是否啟用。');
  }

  async function writeAction(rpc, payload, success) {
    if (writing) return;
    if (typeof stage7Rpc !== 'function') return message('寫入功能尚未載入。', true);
    writing = true;
    try {
      const res = await stage7Rpc(rpc, payload);
      if (!res || !res.ok) return message((res && (res.error || (res.data && res.data.message))) || '儲存失敗，請重新整理確認。', true);
      await load();
      await observations(selectedWatchlist);
      if (rpc === 'backoffice_used_market_import_reviewed' && typeof window.__dkUsedMarketOnShow === 'function') await window.__dkUsedMarketOnShow();
      message(success, false);
    } catch (_) { message('連線中斷，請重新整理確認是否已儲存。', true); }
    finally { writing = false; }
  }

  async function collect(watchlistId) {
    if (writing || collecting) return;
    if (typeof callBackofficeEdgeFunction !== "function") return;
    collecting = true;
    try {
    message("正在抓取公開行情，請稍候…", false);
    const body = watchlistId ? { watchlist_id: watchlistId } : { limit: 5 };
    const res = await callBackofficeEdgeFunction("used-market-collector", body);
    if (!res.ok) {
      const code = res.data && res.data.code;
      message(code === "API_KEY_MISSING" ? "程式已完成，尚需設定 SERPAPI_API_KEY 才能開始抓取。" : "抓取失敗，請確認 Edge Function 與資料庫已部署。", true);
      return;
    }
    await load();
    if (selectedWatchlist) await observations(selectedWatchlist);
    const failed = (res.data.runs || []).filter((run) => !run.ok).length;
    message("抓取完成：" + Number(res.data.models || 0) + " 個型號、" + Number(res.data.observations || 0) + " 筆候選資料。" + (failed ? "其中 " + failed + " 個型號失敗，請稍後重試。" : ""), failed > 0);
    } catch (_) { message('抓取連線中斷，請先重新整理確認結果。', true); }
    finally { collecting = false; }
  }

  function bind() {
    const root = $("tab-used-market");
    if (!root || root.dataset.uamBound === "1") return;
    root.dataset.uamBound = "1";
    $("uamRefresh").addEventListener("click", load);
    $("uamCollect").addEventListener("click", () => collect(""));
    root.addEventListener("click", (event) => {
      if (writing || collecting) return;
      const target = event.target.closest("[data-uam-view],[data-uam-run],[data-uam-review]");
      if (!target) return;
      const view = target.getAttribute("data-uam-view");
      const run = target.getAttribute("data-uam-run");
      if (view) observations(view);
      if (run) collect(run);
      const review = target.getAttribute('data-uam-review');
      if (review) reviewEditor(review);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
