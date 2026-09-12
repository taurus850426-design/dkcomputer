/* used-valuation-engine-admin.js - Stage 04 估價引擎（Admin only；公式在 server-side） */
(function () {
  "use strict";

  const STATUS_LABEL = { DRAFT: "草稿", ACTIVE: "使用中", RETIRED: "已退役" };
  const CATEGORIES = ["CPU", "GPU", "MOTHERBOARD", "RAM", "STORAGE", "PSU", "CASE", "COOLER", "LAPTOP", "OTHER"];
  const STARTER = {
    schema_version: 1,
    rounding_step: 100,
    unmatched_component_policy: "EXCLUDE",
    minimum_matched_components: 1,
    condition_multipliers: { A: 1, B: 1, C: 1 }
  };

  let rules = [];
  let activateTargetId = "";

  function rest() {
    return typeof stage7RestJson === "function" ? stage7RestJson : null;
  }
  function rpc() {
    return typeof stage7Rpc === "function" ? stage7Rpc : null;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function fmtNum(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toLocaleString("zh-TW");
  }

  function fmtPct(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return (x * 100).toFixed(0) + "%";
  }

  function fmtTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("zh-TW");
  }

  function isAdmin() {
    try {
      return window.DK && window.DK.getCurrentRole && window.DK.getCurrentRole() === "admin";
    } catch (_) {
      return false;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function cfgOf(rule) {
    const c = rule && rule.private_config;
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  }

  function showMsg(text, isErr) {
    const el = $("uePageMsg");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("ue-msg-error", !!isErr);
  }

  function friendlyError(res, fallbackReason) {
    const raw = String((res && res.error) || fallbackReason || "");
    const low = raw.toLowerCase();
    if (res && (res.permissionDenied || res.forbidden || low.indexOf("admin only") >= 0 || low.indexOf("42501") >= 0 || low.indexOf("permission denied") >= 0)) {
      return "你沒有執行此操作的權限。";
    }
    if (res && res.notAuthenticated) return "請先登入後台。";
    if (raw.indexOf("NO_ACTIVE_MARKET_BATCH") >= 0) return "尚未設定正式行情版本。";
    if (raw.indexOf("ACTIVE_MARKET_BATCH_CONFLICT") >= 0) return "正式行情版本狀態異常，暫時無法估價。";
    if (raw.indexOf("NO_ACTIVE_RULE_VERSION") >= 0) return "尚未啟用正式估價規則。";
    if (raw.indexOf("ACTIVE_RULE_VERSION_CONFLICT") >= 0) return "正式估價規則狀態異常，暫時無法估價。";
    if (raw.indexOf("RULE_NOT_DRAFT") >= 0) return "此規則已不是草稿，無法修改。";
    if (raw.indexOf("INSUFFICIENT_MARKET_DATA") >= 0) return "可用行情資料不足，暫時無法完成估價。";
    if (raw.indexOf("CASE_NOT_FOUND") >= 0) return "找不到估價案件。";
    if (raw.indexOf("NO_COMPONENTS") >= 0) return "此案件沒有可估價的零件資料。";
    if (low.indexOf("duplicate version") >= 0) return "此規則版本代碼已存在。";
    if (low.indexOf("version_code required") >= 0) return "請填寫規則版本代碼。";
    if (low.indexOf("invalid rule config") >= 0) return "規則內容不正確，請檢查進位單位、最少匹配數與成色倍率。";
    if (low.indexOf("reason required") >= 0) return "請填寫啟用原因。";
    if (low.indexOf("rule not found") >= 0) return "找不到此規則版本。";
    if (low.indexOf("server fields are not client-writable") >= 0) return "請填寫完整資料後再儲存。";
    if (low.indexOf("payload required") >= 0 || low.indexOf("invalid payload") >= 0) return "請填寫完整資料後再儲存。";
    if (low.indexOf("active rule conflict") >= 0) return "目前已有其他規則正在啟用，請稍後再試。";
    if (low.indexOf("network") >= 0 || low.indexOf("failed to fetch") >= 0) return "網路連線失敗，請稍後再試。";
    return "操作失敗，請稍後再試。";
  }

  function statusBadge(status) {
    const st = String(status || "");
    let cls = "status-badge status-muted";
    if (st === "ACTIVE") cls = "status-badge status-success";
    else if (st === "DRAFT") cls = "status-badge status-warning";
    else if (st === "RETIRED") cls = "status-badge status-muted";
    return '<span class="' + cls + '">' + esc(STATUS_LABEL[st] || st) + "</span>";
  }

  async function callRpc(name, args) {
    const fn = rpc();
    if (!fn) return { ok: false, error: "後台資料介面尚未就緒" };
    return fn(name, args);
  }

  async function loadRules() {
    const fn = rest();
    if (!fn) {
      showMsg("後台資料介面尚未就緒", true);
      return;
    }
    showMsg("載入中…", false);
    const res = await fn("used_valuation_rule_versions?select=id,version_code,status,private_config,created_at,activated_at&order=created_at.desc");
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    rules = Array.isArray(res.data) ? res.data : [];
    showMsg("");
    render();
  }

  function renderActive() {
    const host = $("ueActiveRuleCard");
    if (!host) return;
    const active = rules.find(function (r) { return r.status === "ACTIVE"; });
    if (!active) {
      host.innerHTML = '<p class="muted">目前沒有正式估價規則。請建立草稿規則並啟用。</p>';
      return;
    }
    const cfg = cfgOf(active);
    host.innerHTML =
      '<div class="ue-active-grid">' +
        '<div><div class="muted small">版本代碼</div><div class="ue-strong">' + esc(active.version_code) + "</div></div>" +
        '<div><div class="muted small">狀態</div><div>' + statusBadge(active.status) + "</div></div>" +
        '<div><div class="muted small">啟用時間</div><div>' + esc(fmtTime(active.activated_at)) + "</div></div>" +
        '<div><div class="muted small">規則格式版本</div><div>' + esc(String(cfg.schema_version || "—")) + "</div></div>" +
        '<div><div class="muted small">估值進位單位</div><div>' + esc(fmtNum(cfg.rounding_step)) + "</div></div>" +
        '<div><div class="muted small">最少需匹配零件數</div><div>' + esc(fmtNum(cfg.minimum_matched_components)) + "</div></div>" +
      "</div>";
  }

  function renderList() {
    const host = $("ueRuleList");
    if (!host) return;
    if (!rules.length) {
      host.innerHTML = '<p class="muted">尚無估價規則。可先用中性預設值建立第一版草稿。</p>';
      return;
    }
    host.innerHTML = rules.map(function (r) {
      let actions = "";
      if (r.status === "DRAFT") {
        actions =
          '<button type="button" class="btn btn-ghost btn-sm" data-ue-edit="' + esc(r.id) + '">編輯</button>' +
          '<button type="button" class="btn btn-primary btn-sm" data-ue-activate="' + esc(r.id) + '">啟用</button>';
      } else if (r.status === "ACTIVE") {
        actions = '<span class="muted small">使用中｜唯讀</span>';
      } else {
        actions = '<span class="muted small">已退役｜唯讀</span>';
      }
      return (
        '<article class="ue-rule-card">' +
          '<div class="ue-rule-card-main">' +
            '<div class="ue-rule-title">' + esc(r.version_code) + " " + statusBadge(r.status) + "</div>" +
            '<div class="muted small">建立時間 ' + esc(fmtTime(r.created_at)) + " ｜ 啟用時間 " + esc(fmtTime(r.activated_at)) + "</div>" +
          "</div>" +
          '<div class="ue-rule-actions">' + actions + "</div>" +
        "</article>"
      );
    }).join("");
  }

  function render() {
    renderActive();
    renderList();
  }

  function readMult(id) {
    const raw = String(($(id) && $(id).value) || "").trim();
    if (!raw) return 1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0.5 || n > 1.2) return null;
    return n;
  }

  function collectMultipliers() {
    const a = readMult("ueMultA");
    const b = readMult("ueMultB");
    const c = readMult("ueMultC");
    if (a == null || b == null || c == null) return { ok: false, obj: {} };
    return { ok: true, obj: { A: a, B: b, C: c } };
  }

  function fillMultipliers(multipliers) {
    const obj = multipliers && typeof multipliers === "object" && !Array.isArray(multipliers) ? multipliers : {};
    function pick(key) {
      const v = obj[key] != null ? obj[key] : obj[String(key).toLowerCase()];
      return v == null || v === "" ? "1" : String(v);
    }
    if ($("ueMultA")) $("ueMultA").value = pick("A");
    if ($("ueMultB")) $("ueMultB").value = pick("B");
    if ($("ueMultC")) $("ueMultC").value = pick("C");
  }

  function applyStarterDefaults() {
    $("ueVersionCode").value = "";
    $("ueRoundingStep").value = String(STARTER.rounding_step);
    $("ueMinMatched").value = String(STARTER.minimum_matched_components);
    $("ueUnmatchedPolicy").value = STARTER.unmatched_component_policy;
    fillMultipliers(STARTER.condition_multipliers);
  }

  function openRuleForm(rule) {
    const card = $("ueRuleFormCard");
    if (!card) return;
    card.hidden = false;
    if (!rule) {
      $("ueRuleFormTitle").textContent = "新增估價規則";
      $("ueRuleId").value = "";
      applyStarterDefaults();
      return;
    }
    $("ueRuleFormTitle").textContent = "編輯草稿規則";
    $("ueRuleId").value = rule.id;
    const cfg = cfgOf(rule);
    $("ueVersionCode").value = rule.version_code || "";
    $("ueRoundingStep").value = cfg.rounding_step != null ? String(cfg.rounding_step) : String(STARTER.rounding_step);
    $("ueMinMatched").value = cfg.minimum_matched_components != null ? String(cfg.minimum_matched_components) : String(STARTER.minimum_matched_components);
    $("ueUnmatchedPolicy").value = "EXCLUDE";
    fillMultipliers(cfg.condition_multipliers);
  }

  function closeRuleForm() {
    const card = $("ueRuleFormCard");
    if (card) card.hidden = true;
    $("ueRuleId").value = "";
  }

  function buildConfigFromForm() {
    const step = Number($("ueRoundingStep").value);
    const minM = Number($("ueMinMatched").value);
    if (!Number.isFinite(step) || step < 1 || step > 10000 || Math.floor(step) !== step) {
      return { error: "估值進位單位請填 1～10000 的整數。" };
    }
    if (!Number.isFinite(minM) || minM < 1 || minM > 100 || Math.floor(minM) !== minM) {
      return { error: "最少需匹配零件數請填 1～100 的整數。" };
    }
    const multipliers = collectMultipliers();
    if (!multipliers.ok) {
      return { error: "成色倍率請填 0.50～1.20。" };
    }
    const cfg = {
      schema_version: 1,
      rounding_step: step,
      unmatched_component_policy: "EXCLUDE",
      minimum_matched_components: minM,
      condition_multipliers: multipliers.obj
    };
    return { cfg: cfg };
  }

  async function saveRule() {
    const id = $("ueRuleId").value;
    const versionCode = String($("ueVersionCode").value || "").trim();
    if (!versionCode) {
      showMsg("請填寫規則版本代碼。", true);
      return;
    }
    const built = buildConfigFromForm();
    if (built.error) {
      showMsg(built.error, true);
      return;
    }
    const payload = {
      version_code: versionCode,
      private_config: built.cfg
    };
    const res = id
      ? await callRpc("backoffice_used_valuation_update_rule", { p_id: id, p_payload: payload })
      : await callRpc("backoffice_used_valuation_create_rule", { p_payload: payload });
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    closeRuleForm();
    showMsg(id ? "已更新草稿規則" : "已建立草稿規則", false);
    await loadRules();
  }

  function openActivate(id) {
    activateTargetId = id;
    const el = $("ueConfirmOverlay");
    if (el) el.hidden = false;
    const reason = $("ueConfirmReason");
    if (reason) {
      reason.value = "";
      reason.focus();
    }
  }

  function closeActivate() {
    activateTargetId = "";
    const el = $("ueConfirmOverlay");
    if (el) el.hidden = true;
  }

  async function submitActivate() {
    const reason = $("ueConfirmReason") && $("ueConfirmReason").value;
    if (!String(reason || "").trim()) {
      showMsg("請填寫啟用原因。", true);
      return;
    }
    const res = await callRpc("backoffice_used_valuation_activate_rule", {
      p_id: activateTargetId,
      p_reason: reason
    });
    if (!res.ok) {
      showMsg(friendlyError(res), true);
      return;
    }
    closeActivate();
    closeRuleForm();
    showMsg("已啟用正式估價規則", false);
    await loadRules();
  }

  function previewRowCount() {
    const host = $("uePreviewRows");
    return host ? host.querySelectorAll(".ue-comp-row").length : 0;
  }

  function previewRowHtml() {
    const opts = CATEGORIES.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + "</option>";
    }).join("");
    return (
      '<div class="ue-comp-row">' +
        '<div class="field"><label>分類</label><select class="ue-comp-cat">' + opts + "</select></div>" +
        '<div class="field"><label>品牌</label><input class="ue-comp-brand" type="text" maxlength="80" autocomplete="off" /></div>' +
        '<div class="field"><label>型號</label><input class="ue-comp-model" type="text" maxlength="120" autocomplete="off" /></div>' +
        '<div class="field"><label>規格／版本</label><input class="ue-comp-variant" type="text" maxlength="120" autocomplete="off" /></div>' +
        '<div class="field ue-comp-del-wrap"><button type="button" class="btn btn-ghost btn-sm" data-ue-del-comp>刪除</button></div>' +
      "</div>"
    );
  }

  function ensurePreviewRows() {
    const host = $("uePreviewRows");
    if (!host) return;
    if (!host.querySelector(".ue-comp-row")) host.insertAdjacentHTML("beforeend", previewRowHtml());
  }

  function collectPreviewComponents() {
    const host = $("uePreviewRows");
    if (!host) return [];
    return Array.from(host.querySelectorAll(".ue-comp-row")).map(function (row) {
      return {
        category: String((row.querySelector(".ue-comp-cat") && row.querySelector(".ue-comp-cat").value) || "").trim(),
        brand: String((row.querySelector(".ue-comp-brand") && row.querySelector(".ue-comp-brand").value) || "").trim(),
        model: String((row.querySelector(".ue-comp-model") && row.querySelector(".ue-comp-model").value) || "").trim(),
        variant: String((row.querySelector(".ue-comp-variant") && row.querySelector(".ue-comp-variant").value) || "").trim()
      };
    });
  }

  function itemLine(it) {
    const parts = [it.category, it.brand, it.model, it.variant].filter(function (x) { return x; });
    return parts.length ? parts.join(" ｜ ") : "（未填零件）";
  }

  function renderPreviewResult(data) {
    const host = $("uePreviewResult");
    if (!host) return;
    if (!data) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const ok = data.ok === true;
    const matched = Array.isArray(data.matched) ? data.matched : [];
    const unmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
    const reasonText = data.reason ? friendlyError(null, data.reason) : "";
    const matchedHtml = matched.length
      ? "<ul class=\"ue-diag-list\">" + matched.map(function (it) {
          const note = it.note === "UNKNOWN_CONDITION_NO_ADJUSTMENT" ? "（成色無對應加權，未調整）" : "";
          return "<li>" + esc(itemLine(it)) + note + "</li>";
        }).join("") + "</ul>"
      : '<p class="muted">沒有已匹配零件。</p>';
    const unmatchedHtml = unmatched.length
      ? "<ul class=\"ue-diag-list\">" + unmatched.map(function (it) {
          let why = "無對應行情";
          if (it.reason === "AMBIGUOUS") why = "規格對應不唯一";
          else if (it.reason === "INVALID_MARKET_PRICE") why = "行情價格資料異常";
          return "<li>" + esc(itemLine(it)) + "（" + why + "）</li>";
        }).join("") + "</ul>"
      : '<p class="muted">沒有未匹配零件。</p>';
    host.hidden = false;
    host.innerHTML =
      (reasonText && !ok ? '<p class="ue-msg-error">' + esc(reasonText) + "</p>" : "") +
      '<div class="ue-preview-grid">' +
        '<div><div class="muted small">市場低價</div><div class="ue-strong">' + esc(ok ? fmtNum(data.market_low) : "—") + "</div></div>" +
        '<div><div class="muted small">市場中間價</div><div class="ue-strong">' + esc(ok ? fmtNum(data.market_mid) : "—") + "</div></div>" +
        '<div><div class="muted small">市場高價</div><div class="ue-strong">' + esc(ok ? fmtNum(data.market_high) : "—") + "</div></div>" +
        '<div><div class="muted small">DK VALUE 分數</div><div>' + esc(fmtNum(data.value_score)) + "</div></div>" +
        '<div><div class="muted small">行情可信度</div><div>' + esc(fmtNum(data.confidence)) + "</div></div>" +
        '<div><div class="muted small">行情覆蓋率</div><div>' + esc(fmtPct(data.coverage_ratio)) + "</div></div>" +
        '<div><div class="muted small">已匹配零件數</div><div>' + esc(fmtNum(data.matched_component_count)) + "</div></div>" +
        '<div><div class="muted small">未匹配零件數</div><div>' + esc(fmtNum(data.unmatched_component_count)) + "</div></div>" +
      "</div>" +
      '<p class="form-hint">DK VALUE 分數反映目前市場資料完整度與可信度，不代表硬體健康狀況。</p>' +
      '<div class="ue-diag-cols">' +
        "<div><h4 class=\"h4\">已匹配</h4>" + matchedHtml + "</div>" +
        "<div><h4 class=\"h4\">未匹配</h4>" + unmatchedHtml + "</div>" +
      "</div>";
  }

  async function runPreview() {
    const components = collectPreviewComponents();
    if (!components.length) {
      showMsg("請至少保留一列零件。", true);
      return;
    }
    const res = await callRpc("backoffice_used_valuation_preview", { p_payload: { components: components } });
    if (!res.ok) {
      renderPreviewResult(null);
      showMsg(friendlyError(res), true);
      return;
    }
    const data = res.data && !Array.isArray(res.data) ? res.data : (Array.isArray(res.data) ? res.data[0] : null);
    if (!data) {
      showMsg("操作失敗，請稍後再試。", true);
      return;
    }
    if (data.ok === false) showMsg(friendlyError(null, data.reason || "INSUFFICIENT_MARKET_DATA"), true);
    else showMsg("測試完成。此結果未寫入估價案件。", false);
    renderPreviewResult(data);
  }

  function bind() {
    const root = $("tab-used-engine");
    if (!root || root.dataset.ueBound === "1") return;
    root.dataset.ueBound = "1";
    ensurePreviewRows();

    $("ueBtnNewRule") && $("ueBtnNewRule").addEventListener("click", function () { openRuleForm(null); });
    $("ueRuleCancel") && $("ueRuleCancel").addEventListener("click", closeRuleForm);
    $("ueRuleSave") && $("ueRuleSave").addEventListener("click", function () {
      saveRule().catch(function () { showMsg("操作失敗，請稍後再試。", true); });
    });
    $("ueBtnAddComp") && $("ueBtnAddComp").addEventListener("click", function () {
      const host = $("uePreviewRows");
      if (host) host.insertAdjacentHTML("beforeend", previewRowHtml());
    });
    $("ueBtnPreview") && $("ueBtnPreview").addEventListener("click", function () {
      runPreview().catch(function () { showMsg("操作失敗，請稍後再試。", true); });
    });
    $("ueConfirmCancel") && $("ueConfirmCancel").addEventListener("click", closeActivate);
    $("ueConfirmOk") && $("ueConfirmOk").addEventListener("click", function () {
      submitActivate().catch(function () { showMsg("操作失敗，請稍後再試。", true); });
    });

    root.addEventListener("click", function (ev) {
      const t = ev.target && ev.target.closest ? ev.target.closest("[data-ue-edit],[data-ue-activate],[data-ue-del-comp]") : null;
      if (!t) return;
      const editId = t.getAttribute("data-ue-edit");
      const actId = t.getAttribute("data-ue-activate");
      if (editId) {
        ev.preventDefault();
        const rule = rules.find(function (x) { return x.id === editId; });
        if (rule && rule.status === "DRAFT") openRuleForm(rule);
        else showMsg("此規則已不是草稿，無法修改。", true);
        return;
      }
      if (actId) {
        ev.preventDefault();
        openActivate(actId);
        return;
      }
      if (t.hasAttribute("data-ue-del-comp")) {
        ev.preventDefault();
        if (previewRowCount() <= 1) {
          showMsg("至少需保留一列零件。", true);
          return;
        }
        const row = t.closest(".ue-comp-row");
        if (row) row.remove();
      }
    });
  }

  async function onShow() {
    if (!isAdmin()) {
      showMsg("估價引擎僅限管理員", true);
      return;
    }
    bind();
    await loadRules();
  }

  window.__dkUsedEngineOnShow = onShow;
})();
