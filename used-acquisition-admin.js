/* used-acquisition-admin.js - Stage 06 收購案件（Admin only；財務公式只在 server） */
(function () {
  "use strict";

  var STATUS_LABEL = {
    CONTACTED: "已聯絡",
    INSPECTION_PENDING: "待檢測",
    OFFERED: "已報價",
    ACCEPTED: "客人接受",
    DECLINED: "客人拒絕",
    EXPIRED: "報價逾期",
    ACQUIRED: "已收購",
    ESTIMATED: "已估價",
    SELL_INTENT: "有出售意向",
    RESOLD: "已轉售"
  };
  var CHANNEL_LABEL = { LINE: "LINE", PHONE: "電話", WALK_IN: "現場", OTHER: "其他" };
  var CATEGORIES = ["CPU", "GPU", "MOTHERBOARD", "RAM", "STORAGE", "PSU", "CASE", "COOLER", "LAPTOP", "OTHER"];
  var CAT_LABEL = {
    CPU: "CPU", GPU: "顯示卡", MOTHERBOARD: "主機板", RAM: "記憶體", STORAGE: "儲存",
    PSU: "電源", CASE: "機殼", COOLER: "散熱", LAPTOP: "筆電", OTHER: "其他"
  };
  var RISK = ["LOW", "MEDIUM", "HIGH"];
  var RISK_LABEL = { LOW: "低", MEDIUM: "中", HIGH: "高" };

  var cases = [];
  var current = null;
  var currentId = "";
  var preview = null;
  var submitting = false;

  function rest() {
    return typeof stage7RestJson === "function" ? stage7RestJson : null;
  }
  function rpc() {
    return typeof stage7Rpc === "function" ? stage7Rpc : null;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function isAdmin() {
    try {
      return window.DK && window.DK.getCurrentRole && window.DK.getCurrentRole() === "admin";
    } catch (_) {
      return false;
    }
  }
  function fmtNum(n) {
    if (n == null || n === "") return "—";
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString("zh-TW");
  }
  function fmtMoney(n) {
    if (n == null || n === "") return "—";
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return "NT$" + x.toLocaleString("zh-TW");
  }
  function fmtTime(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("zh-TW");
  }
  function showMsg(text, isErr) {
    var el = $("uaPageMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("ua-msg-error", !!isErr);
  }
  function friendlyError(res) {
    var raw = String((res && (res.error || res.message)) || "");
    var low = raw.toLowerCase();
    if (res && (res.permissionDenied || res.forbidden || low.indexOf("admin only") >= 0 || low.indexOf("42501") >= 0)) {
      return "你沒有執行此操作的權限。";
    }
    if (res && res.notAuthenticated) return "請先登入後台。";
    if (raw.indexOf("CASE_NOT_FOUND") >= 0) return "找不到收購案件。";
    if (raw.indexOf("NO_COMPONENTS") >= 0) return "此案件沒有可估價的零件。";
    if (raw.indexOf("NO_VALUATION_RESULT") >= 0) return "請先完成市場估值。";
    if (raw.indexOf("INVALID_TARGET_MARGIN") >= 0) return "目標毛利率設定有誤。";
    if (raw.indexOf("INVALID_REFURBISHMENT_COST") >= 0) return "翻新／維修成本設定有誤。";
    if (raw.indexOf("UNECONOMIC_ACQUISITION") >= 0) return "依目前轉售價、翻新成本與目標毛利，此案件暫不適合收購。";
    if (raw.indexOf("OFFER_EXCEEDS_MAXIMUM") >= 0) return "本次出價超過系統計算的最高收購價。";
    if (raw.indexOf("INVALID_STATUS_TRANSITION") >= 0) return "此案件目前不能執行這個狀態操作。";
    if (raw.indexOf("ACTUAL_PRICE_REASON_REQUIRED") >= 0) return "實際收購價超過最高收購價，請填寫原因。";
    if (raw.indexOf("ALREADY_ACQUIRED") >= 0) return "此案件已完成收購。";
    if (raw.indexOf("INVALID_DECISION_PAYLOAD") >= 0) return "收購評估資料不完整或超出限制，請縮短備註後再試。";
    if (raw.indexOf("INVALID_OFFER_DECISION") >= 0) return "找不到有效的收購評估或報價紀錄，無法完成此操作。";
    if (raw.indexOf("INSUFFICIENT_MARKET_DATA") >= 0) return "目前可參考的市場行情不足，暫時無法完成估值。";
    return "操作失敗，請稍後再試。";
  }
  async function callRpc(name, args) {
    var fn = rpc();
    if (!fn) return { ok: false, error: "後台資料介面尚未就緒" };
    return fn(name, args);
  }
  function unwrap(res) {
    if (!res || res.ok === false) return res;
    var d = res.data;
    if (Array.isArray(d) && d.length === 1 && d[0] && typeof d[0] === "object") d = d[0];
    return d || res;
  }
  function statusBadge(st) {
    var cls = "status-badge status-muted";
    if (st === "OFFERED" || st === "INSPECTION_PENDING") cls = "status-badge status-warning";
    if (st === "ACCEPTED" || st === "ACQUIRED") cls = "status-badge status-success";
    if (st === "DECLINED" || st === "EXPIRED") cls = "status-badge status-danger";
    return '<span class="' + cls + '">' + esc(STATUS_LABEL[st] || st) + "</span>";
  }

  function collectComponents(hostId) {
    var host = $(hostId);
    if (!host) return [];
    var rows = host.querySelectorAll(".ua-comp-row");
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push({
        component_type: (r.querySelector("[data-k=type]") || {}).value || "",
        brand: (r.querySelector("[data-k=brand]") || {}).value || "",
        model: (r.querySelector("[data-k=model]") || {}).value || "",
        variant: (r.querySelector("[data-k=variant]") || {}).value || "",
        spec: (r.querySelector("[data-k=spec]") || {}).value || "",
        age_months: (r.querySelector("[data-k=age]") || {}).value || "",
        condition_grade: (r.querySelector("[data-k=grade]") || {}).value || "",
        note: (r.querySelector("[data-k=note]") || {}).value || ""
      });
    }
    return out;
  }
  function compRowHtml(c) {
    c = c || {};
    var opts = CATEGORIES.map(function (k) {
      var sel = k === (c.component_type || "CPU") ? " selected" : "";
      return '<option value="' + k + '"' + sel + ">" + esc(CAT_LABEL[k] || k) + "</option>";
    }).join("");
    return (
      '<div class="ua-comp-row">' +
        '<div class="field"><label>分類</label><select data-k="type">' + opts + "</select></div>" +
        '<div class="field"><label>品牌</label><input data-k="brand" type="text" maxlength="100" value="' + esc(c.brand || "") + '" /></div>' +
        '<div class="field"><label>型號</label><input data-k="model" type="text" maxlength="160" value="' + esc(c.model || "") + '" /></div>' +
        '<div class="field"><label>規格／版本</label><input data-k="variant" type="text" maxlength="160" value="' + esc(c.variant || "") + '" /></div>' +
        '<div class="field"><label>其他規格</label><input data-k="spec" type="text" maxlength="200" value="' + esc(c.spec || "") + '" /></div>' +
        '<div class="field"><label>使用月數</label><input data-k="age" type="number" min="0" value="' + esc(c.age_months == null ? "" : c.age_months) + '" /></div>' +
        '<div class="field"><label>成色</label><input data-k="grade" type="text" maxlength="32" value="' + esc(c.condition_grade || "") + '" /></div>' +
        '<div class="field"><label>備註</label><input data-k="note" type="text" maxlength="200" value="' + esc(c.note || "") + '" /></div>' +
        '<div class="field ua-comp-delwrap"><button type="button" class="btn btn-ghost btn-sm" data-ua-del-row>刪除</button></div>' +
      "</div>"
    );
  }
  function bindCompHost(hostId) {
    var host = $(hostId);
    if (!host || host.getAttribute("data-bound") === "1") return;
    host.setAttribute("data-bound", "1");
    host.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-ua-del-row]");
      if (!btn) return;
      var rows = host.querySelectorAll(".ua-comp-row");
      if (rows.length <= 1) return;
      var row = btn.closest(".ua-comp-row");
      if (row) row.remove();
    });
  }
  function addCompRow(hostId) {
    var host = $(hostId);
    if (!host) return;
    host.insertAdjacentHTML("beforeend", compRowHtml({}));
  }

  function latestResult() {
    var list = (current && current.results) || [];
    return list.length ? list[0] : null;
  }
  function latestByType(type) {
    var list = (current && current.decisions) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].record_type === type) return list[i];
    }
    return null;
  }
  function latestEvaluation() {
    return latestByType("ACQUISITION_EVALUATION");
  }
  function latestOffer() {
    return latestByType("OFFER");
  }
  function evaluationSnapshot(d) {
    if (!d) return { ok: false, snap: null };
    if (d.record_type !== "ACQUISITION_EVALUATION") return { ok: false, snap: null };
    if (!d.snapshot || typeof d.snapshot !== "object") return { ok: false, snap: null };
    return { ok: true, snap: d.snapshot };
  }
  function toNumOrNull(v) {
    if (v == null || String(v).trim() === "") return null;
    var n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  async function loadList() {
    if (!isAdmin()) {
      showMsg("僅管理員可使用收購案件。", true);
      return;
    }
    showMsg("載入中…", false);
    var res = await callRpc("backoffice_used_acquisition_list_cases", {});
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    var data = unwrap(res);
    cases = (data && data.cases) || [];
    showMsg("");
    renderList();
  }
  async function loadCase(id) {
    var res = await callRpc("backoffice_used_acquisition_get_case", { p_id: id });
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return false;
    }
    current = unwrap(res);
    currentId = id;
    preview = null;
    return true;
  }

  function renderList() {
    var host = $("uaCaseList");
    var listPane = $("uaListPane");
    var detailPane = $("uaDetailPane");
    var createPane = $("uaCreatePane");
    if (listPane) listPane.hidden = false;
    if (detailPane) detailPane.hidden = true;
    if (createPane) createPane.hidden = true;
    if (!host) return;
    if (!cases.length) {
      host.innerHTML = '<p class="muted">尚無收購案件。可從上方新增。</p>';
      return;
    }
    host.innerHTML = cases.map(function (c) {
      return (
        '<article class="ua-case-card">' +
          '<div class="ua-case-main">' +
            '<div class="ua-case-title">' + esc(c.public_code || "未編號") + " " + statusBadge(c.status) + "</div>" +
            '<div class="muted small">來源 ' + esc(CHANNEL_LABEL[c.source_channel] || c.source_channel || "—") +
              " ｜ 建立 " + esc(fmtTime(c.created_at)) +
              " ｜ 更新 " + esc(fmtTime(c.updated_at)) + "</div>" +
            '<div class="ua-case-fin muted small">市場中位 ' + esc(fmtMoney(c.market_mid)) +
              " ｜ 建議收購 " + esc(fmtMoney(c.recommended_acquisition)) +
              " ｜ 最高收購 " + esc(fmtMoney(c.maximum_acquisition)) + "</div>" +
          "</div>" +
          '<div class="ua-case-actions"><button type="button" class="btn btn-primary btn-sm" data-ua-open="' + esc(c.id) + '">開啟</button></div>' +
        "</article>"
      );
    }).join("");
  }

  function renderDetail() {
    var listPane = $("uaListPane");
    var detailPane = $("uaDetailPane");
    var createPane = $("uaCreatePane");
    if (listPane) listPane.hidden = true;
    if (createPane) createPane.hidden = true;
    if (detailPane) detailPane.hidden = false;
    if (!current || !current.case) return;
    var c = current.case;
    var st = c.status;
    $("uaDetailCode").textContent = c.public_code || "—";
    $("uaDetailMeta").innerHTML =
      statusBadge(st) +
      '<span class="muted">來源 ' + esc(CHANNEL_LABEL[c.source_channel] || c.source_channel || "—") +
      " ｜ 建立 " + esc(fmtTime(c.created_at)) + "</span>";
    var comps = current.components || [];
    $("uaCompHost").innerHTML = comps.length ? comps.map(compRowHtml).join("") : compRowHtml({});
    var canEditComp = st === "CONTACTED" || st === "INSPECTION_PENDING";
    $("uaCompActions").hidden = !canEditComp;
    var r = latestResult();
    var valHost = $("uaValuationCard");
    if (!r) {
      valHost.innerHTML = '<p class="muted">尚未執行市場估值。</p>';
    } else {
      valHost.innerHTML =
        '<div class="ua-fin-grid">' +
          '<div><div class="muted small">市場低價</div><div class="ua-strong">' + esc(fmtMoney(r.market_low)) + "</div></div>" +
          '<div><div class="muted small">市場中間價</div><div class="ua-strong">' + esc(fmtMoney(r.market_mid)) + "</div></div>" +
          '<div><div class="muted small">市場高價</div><div class="ua-strong">' + esc(fmtMoney(r.market_high)) + "</div></div>" +
          '<div><div class="muted small">DK VALUE</div><div class="ua-strong">' + esc(fmtNum(r.value_score)) + "</div></div>" +
          '<div><div class="muted small">估值時間</div><div>' + esc(fmtTime(r.created_at)) + "</div></div>" +
        "</div>";
    }
    $("uaRunValuation").hidden = !(st === "CONTACTED" || st === "INSPECTION_PENDING");
    renderDecisionBlock();
    renderOfferBlock();
    renderAcquireBlock();
  }

  function riskSelect(id, val) {
    return RISK.map(function (k) {
      return '<option value="' + k + '"' + (k === val ? " selected" : "") + ">" + esc(RISK_LABEL[k]) + "</option>";
    }).join("");
  }

  function renderDecisionBlock() {
    var host = $("uaDecisionCard");
    var d = latestEvaluation();
    var parsed = evaluationSnapshot(d);
    var snap = parsed.ok ? parsed.snap : {};
    var r = latestResult();
    var st = current.case.status;
    var canEdit = st === "CONTACTED" || st === "INSPECTION_PENDING";
    var html = "";
    html += '<p class="form-hint">預估轉售價目前採本次市場估值中位數。</p>';
    html += '<p class="form-hint">最高收購價依翻新成本與你設定的目標毛利率計算。</p>';
    html += '<p class="form-hint">建議收購價再扣除你設定的風險預留金額。</p>';
    html += '<p class="form-hint">風險等級目前用於案件紀錄；實際價格預留請填「風險預留金額」。風險等級本身目前不會自動套折價係數。</p>';
    if (d && !parsed.ok) {
      html += '<p class="muted">此筆歷史評估資料格式無法解析</p>';
    }
    if (!r) {
      html += '<p class="muted">請先完成市場估值，才能試算收購價格。</p>';
      host.innerHTML = html;
      return;
    }
    if (canEdit) {
      html +=
        '<div class="form-grid">' +
          '<div class="field"><label for="uaRefurb">翻新／維修預估成本</label><input id="uaRefurb" type="number" min="0" step="1" value="' + esc(snap.estimated_refurbishment_cost || "") + '" /></div>' +
          '<div class="field"><label for="uaMargin">目標毛利率（%）</label><input id="uaMargin" type="number" min="1" max="90" step="0.1" value="' + esc(snap.target_margin_pct || "") + '" /></div>' +
          '<div class="field"><label for="uaReserve">風險預留金額</label><input id="uaReserve" type="number" min="0" step="1" value="' + esc(snap.risk_reserve_amount || "") + '" /></div>' +
          '<div class="field"><label for="uaLiq">流動性風險</label><select id="uaLiq">' + riskSelect("uaLiq", snap.liquidity_level || "MEDIUM") + "</select></div>" +
          '<div class="field"><label for="uaMkt">市場風險</label><select id="uaMkt">' + riskSelect("uaMkt", snap.market_risk_level || "MEDIUM") + "</select></div>" +
          '<div class="field"><label for="uaInv">庫存風險</label><select id="uaInv">' + riskSelect("uaInv", snap.inventory_risk_level || "MEDIUM") + "</select></div>" +
          '<div class="field full"><label for="uaDecNote">備註</label><input id="uaDecNote" type="text" maxlength="500" value="' + esc(typeof snap.note === "string" ? snap.note : "") + '" /></div>' +
        "</div>" +
        '<div class="actions ua-actions">' +
          '<button id="uaBtnPreview" class="btn btn-ghost" type="button">試算收購價格</button>' +
          '<button id="uaBtnSaveDecision" class="btn btn-primary" type="button">儲存本次收購評估</button>' +
        "</div>" +
        '<div id="uaPreviewBox" class="ua-preview-box"></div>';
    }
    if (d) {
      if (parsed.ok) {
        html +=
          '<div class="ua-fin-grid ua-fin-saved">' +
            '<div><div class="muted small">已存翻新成本</div><div>' + esc(fmtMoney(snap.estimated_refurbishment_cost)) + "</div></div>" +
            '<div><div class="muted small">目標毛利率</div><div>' + esc(fmtNum(snap.target_margin_pct) + (snap.target_margin_pct == null ? "" : "%")) + "</div></div>" +
            '<div><div class="muted small">風險預留</div><div>' + esc(fmtMoney(snap.risk_reserve_amount)) + "</div></div>" +
            '<div><div class="muted small">流動性風險</div><div>' + esc(RISK_LABEL[snap.liquidity_level] || snap.liquidity_level || "—") + "</div></div>" +
            '<div><div class="muted small">市場風險</div><div>' + esc(RISK_LABEL[snap.market_risk_level] || snap.market_risk_level || "—") + "</div></div>" +
            '<div><div class="muted small">庫存風險</div><div>' + esc(RISK_LABEL[snap.inventory_risk_level] || snap.inventory_risk_level || "—") + "</div></div>" +
            '<div class="full"><div class="muted small">備註</div><div>' + esc(typeof snap.note === "string" && snap.note ? snap.note : "—") + "</div></div>" +
          "</div>";
      }
      html +=
        '<div class="ua-fin-grid ua-fin-saved">' +
          '<div><div class="muted small">已存建議收購</div><div class="ua-strong">' + esc(fmtMoney(d.recommended_acquisition)) + "</div></div>" +
          '<div><div class="muted small">已存最高收購</div><div class="ua-strong">' + esc(fmtMoney(d.maximum_acquisition)) + "</div></div>" +
          '<div><div class="muted small">評估時間</div><div>' + esc(fmtTime(d.created_at)) + "</div></div>" +
        "</div>";
    }
    host.innerHTML = html;
    renderPreviewBox();
    var btnP = $("uaBtnPreview");
    var btnS = $("uaBtnSaveDecision");
    if (btnP) btnP.addEventListener("click", onPreview);
    if (btnS) btnS.addEventListener("click", onSaveDecision);
  }

  function renderPreviewBox() {
    var box = $("uaPreviewBox");
    if (!box) return;
    if (!preview || preview.ok === false) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      '<div class="ua-fin-grid">' +
        '<div><div class="muted small">預估轉售價</div><div class="ua-strong">' + esc(fmtMoney(preview.estimated_resale_price)) + "</div></div>" +
        '<div><div class="muted small">建議收購價</div><div class="ua-strong">' + esc(fmtMoney(preview.recommended_acquisition)) + "</div></div>" +
        '<div><div class="muted small">最高收購價</div><div class="ua-strong">' + esc(fmtMoney(preview.maximum_acquisition)) + "</div></div>" +
        '<div><div class="muted small">預估毛利</div><div class="ua-strong">' + esc(fmtMoney(preview.estimated_gross_profit)) + "</div></div>" +
        '<div><div class="muted small">預估毛利率</div><div class="ua-strong">' + esc(fmtNum(preview.estimated_margin_pct) + (preview.estimated_margin_pct == null ? "" : "%")) + "</div></div>" +
      "</div>";
  }

  function decisionPayload() {
    var r = latestResult();
    return {
      valuation_result_id: r && r.id,
      estimated_refurbishment_cost: toNumOrNull(($("uaRefurb") || {}).value),
      target_margin_pct: toNumOrNull(($("uaMargin") || {}).value),
      risk_reserve_amount: toNumOrNull(($("uaReserve") || {}).value),
      liquidity_level: ($("uaLiq") || {}).value,
      market_risk_level: ($("uaMkt") || {}).value,
      inventory_risk_level: ($("uaInv") || {}).value,
      note: ($("uaDecNote") || {}).value || ""
    };
  }

  async function onPreview() {
    if (submitting) return;
    var r = latestResult();
    if (!r) {
      showMsg("請先完成市場估值。", true);
      return;
    }
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_preview", { p_payload: decisionPayload() });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      preview = null;
      renderPreviewBox();
      return;
    }
    preview = unwrap(res);
    showMsg("");
    renderPreviewBox();
  }

  async function onSaveDecision() {
    if (submitting) return;
    var r = latestResult();
    if (!r) {
      showMsg("請先完成市場估值。", true);
      return;
    }
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_create_decision", { p_payload: decisionPayload() });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("已儲存本次收購評估。", false);
    await loadCase(currentId);
    renderDetail();
  }

  function renderOfferBlock() {
    var host = $("uaOfferCard");
    var d = latestEvaluation();
    var offer = latestOffer();
    var st = current.case.status;
    var html = "";
    if (!d) {
      html = '<p class="muted">請先儲存收購評估，才能對客報價。</p>';
      host.innerHTML = html;
      return;
    }
    html +=
      '<div class="ua-fin-grid">' +
        '<div><div class="muted small">建議收購</div><div class="ua-strong">' + esc(fmtMoney(d.recommended_acquisition)) + "</div></div>" +
        '<div><div class="muted small">最高收購</div><div class="ua-strong">' + esc(fmtMoney(d.maximum_acquisition)) + "</div></div>" +
        '<div><div class="muted small">對客報價</div><div class="ua-strong">' + esc(offer ? fmtMoney(offer.final_offer) : "尚未出價") + "</div></div>" +
      "</div>";
    if (st === "CONTACTED" || st === "INSPECTION_PENDING" || st === "OFFERED") {
      html +=
        '<div class="form-grid">' +
          '<div class="field"><label for="uaOfferAmt">實際對客報價</label><input id="uaOfferAmt" type="number" min="0" step="1" /></div>' +
          '<div class="field full"><label for="uaOfferNote">備註</label><input id="uaOfferNote" type="text" maxlength="500" /></div>' +
        "</div>" +
        '<div class="actions ua-actions"><button id="uaBtnOffer" class="btn btn-primary" type="button">記錄報價</button></div>';
    }
    if (st === "CONTACTED") {
      html += '<div class="actions ua-actions"><button id="uaBtnInspect" class="btn btn-ghost" type="button">改為待檢測</button></div>';
    }
    if (st === "OFFERED") {
      html +=
        '<div class="actions ua-actions">' +
          '<button id="uaBtnAccept" class="btn btn-primary" type="button">客人接受</button>' +
          '<button id="uaBtnDecline" class="btn btn-ghost" type="button">客人拒絕</button>' +
          '<button id="uaBtnExpire" class="btn btn-ghost" type="button">報價逾期</button>' +
        "</div>";
    }
    host.innerHTML = html;
    if ($("uaBtnOffer")) $("uaBtnOffer").addEventListener("click", onOffer);
    if ($("uaBtnInspect")) $("uaBtnInspect").addEventListener("click", function () { onStatus("INSPECTION_PENDING"); });
    if ($("uaBtnAccept")) $("uaBtnAccept").addEventListener("click", function () { onStatus("ACCEPTED"); });
    if ($("uaBtnDecline")) $("uaBtnDecline").addEventListener("click", function () { onStatus("DECLINED"); });
    if ($("uaBtnExpire")) $("uaBtnExpire").addEventListener("click", function () { onStatus("EXPIRED"); });
  }

  async function onOffer() {
    if (submitting) return;
    var d = latestEvaluation();
    if (!d) return;
    if (!window.confirm("確認記錄此次對客報價？出價不得超過最高收購價。")) return;
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_record_offer", {
      p_payload: {
        base_decision_id: d.id,
        final_offer: toNumOrNull(($("uaOfferAmt") || {}).value),
        note: ($("uaOfferNote") || {}).value || ""
      }
    });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("已記錄報價。", false);
    await loadCase(currentId);
    renderDetail();
  }

  async function onStatus(status) {
    if (submitting) return;
    var labels = { ACCEPTED: "客人接受", DECLINED: "客人拒絕", EXPIRED: "報價逾期", INSPECTION_PENDING: "待檢測" };
    if (!window.confirm("確認將案件改為「" + (labels[status] || status) + "」？")) return;
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_set_status", {
      p_payload: { case_id: currentId, status: status }
    });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("案件狀態已更新。", false);
    await loadCase(currentId);
    renderDetail();
  }

  function renderAcquireBlock() {
    var host = $("uaAcquireCard");
    var st = current.case.status;
    var d = latestOffer() || latestEvaluation();
    var link = current.acquisition;
    if (link && link.id) {
      host.innerHTML =
        '<div class="ua-fin-grid">' +
          '<div><div class="muted small">實際收購成本</div><div class="ua-strong">' + esc(fmtMoney(link.actual_acquisition_price)) + "</div></div>" +
          '<div><div class="muted small">實際收購時間</div><div>' + esc(fmtTime(link.acquired_at)) + "</div></div>" +
          '<div><div class="muted small">備註</div><div>' + esc(link.note || "—") + "</div></div>" +
        "</div>";
      return;
    }
    if (st !== "ACCEPTED") {
      host.innerHTML = '<p class="muted">客人接受報價後，才能完成收購。</p>';
      return;
    }
    host.innerHTML =
      '<div class="form-grid">' +
        '<div class="field"><label for="uaActualPrice">實際收購成本</label><input id="uaActualPrice" type="number" min="0" step="1" /></div>' +
        '<div class="field"><label for="uaAcquiredAt">實際收購時間</label><input id="uaAcquiredAt" type="datetime-local" /></div>' +
        '<div class="field full"><label for="uaAcqNote">備註</label><input id="uaAcqNote" type="text" maxlength="500" /></div>' +
        '<div class="field full"><label for="uaOverReason">若超過最高收購價，請填原因</label><input id="uaOverReason" type="text" maxlength="500" /></div>' +
      "</div>" +
      '<div class="actions ua-actions"><button id="uaBtnAcquire" class="btn btn-primary" type="button">完成收購</button></div>' +
      (d ? '<p class="form-hint">目前最高收購價 ' + esc(fmtMoney(d.maximum_acquisition)) + "。超過時必須填原因，系統仍會記錄真實成本。</p>" : "");
    if ($("uaBtnAcquire")) $("uaBtnAcquire").addEventListener("click", onAcquire);
  }

  async function onAcquire() {
    if (submitting) return;
    var d = latestOffer();
    if (!d) return;
    var price = toNumOrNull(($("uaActualPrice") || {}).value);
    var reason = (($("uaOverReason") || {}).value || "").trim();
    if (price != null && Number(d.maximum_acquisition) != null && price > Number(d.maximum_acquisition) && !reason) {
      showMsg("實際收購價超過最高收購價，請填寫原因。", true);
      return;
    }
    if (!window.confirm("確認完成收購？此紀錄建立後不可修改。")) return;
    var at = ($("uaAcquiredAt") || {}).value;
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_mark_acquired", {
      p_payload: {
        case_id: currentId,
        decision_id: d.id,
        actual_acquisition_price: price,
        acquired_at: at ? new Date(at).toISOString() : null,
        note: ($("uaAcqNote") || {}).value || "",
        override_reason: reason
      }
    });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("已完成收購。", false);
    await loadCase(currentId);
    renderDetail();
  }

  async function onCreate() {
    if (submitting) return;
    var comps = collectComponents("uaCreateComps");
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_create_case", {
      p_payload: {
        source_channel: ($("uaSource") || {}).value,
        components: comps
      }
    });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    var data = unwrap(res);
    showMsg("案件已建立。", false);
    if (data && data.id) {
      var ok = await loadCase(data.id);
      if (ok) renderDetail();
    }
  }

  async function onSaveComps() {
    if (submitting) return;
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_replace_components", {
      p_payload: { case_id: currentId, components: collectComponents("uaCompHost") }
    });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("零件清單已更新。", false);
    await loadCase(currentId);
    renderDetail();
  }

  async function onRunValuation() {
    if (submitting) return;
    if (!window.confirm("確認依目前零件執行正式市場估值？每次會新增一筆估值紀錄。")) return;
    submitting = true;
    var res = await callRpc("backoffice_used_acquisition_run_valuation", { p_case_id: currentId });
    submitting = false;
    if (!res || res.ok === false) {
      showMsg(friendlyError(res), true);
      return;
    }
    showMsg("市場估值已完成。", false);
    await loadCase(currentId);
    renderDetail();
  }

  function showCreate() {
    $("uaListPane").hidden = true;
    $("uaDetailPane").hidden = true;
    $("uaCreatePane").hidden = false;
    $("uaCreateComps").innerHTML = compRowHtml({});
    bindCompHost("uaCreateComps");
    showMsg("");
  }

  function bind() {
    bindCompHost("uaCreateComps");
    bindCompHost("uaCompHost");
    var addCreate = $("uaAddCreateComp");
    if (addCreate) addCreate.addEventListener("click", function () { addCompRow("uaCreateComps"); });
    var addComp = $("uaAddComp");
    if (addComp) addComp.addEventListener("click", function () { addCompRow("uaCompHost"); });
    var newBtn = $("uaBtnNew");
    if (newBtn) newBtn.addEventListener("click", showCreate);
    var createBtn = $("uaBtnCreate");
    if (createBtn) createBtn.addEventListener("click", onCreate);
    var cancelCreate = $("uaBtnCancelCreate");
    if (cancelCreate) cancelCreate.addEventListener("click", function () { renderList(); });
    var back = $("uaBtnBack");
    if (back) back.addEventListener("click", function () { current = null; currentId = ""; loadList(); });
    var saveComp = $("uaBtnSaveComps");
    if (saveComp) saveComp.addEventListener("click", onSaveComps);
    var runV = $("uaRunValuation");
    if (runV) runV.addEventListener("click", onRunValuation);
    var list = $("uaCaseList");
    if (list) {
      list.addEventListener("click", async function (e) {
        var btn = e.target.closest("[data-ua-open]");
        if (!btn) return;
        var ok = await loadCase(btn.getAttribute("data-ua-open"));
        if (ok) renderDetail();
      });
    }
  }

  window.__dkUsedAcquisitionOnShow = function () {
    if (!isAdmin()) {
      showMsg("僅管理員可使用收購案件。", true);
      return;
    }
    bind();
    if ($("uaCreateComps") && !$("uaCreateComps").children.length) {
      $("uaCreateComps").innerHTML = compRowHtml({});
    }
    loadList();
  };
})();
