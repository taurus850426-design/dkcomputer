/* valuation.js - Stage 05 公開二手估價（公式在 server-side；此檔只送零件規格） */
(function () {
  "use strict";

  var MAX_ROWS = 20;
  var REQUEST_TIMEOUT_MS = 20000;
  var DEFAULT_LINE_URL = "https://lin.ee/p58Bkqp";
  var CATEGORIES = [
    { value: "CPU", label: "處理器（CPU）" },
    { value: "GPU", label: "顯示卡（GPU）" },
    { value: "MOTHERBOARD", label: "主機板" },
    { value: "RAM", label: "記憶體（RAM）" },
    { value: "STORAGE", label: "儲存裝置（SSD／HDD）" },
    { value: "PSU", label: "電源供應器" },
    { value: "CASE", label: "機殼" },
    { value: "COOLER", label: "散熱器" },
    { value: "LAPTOP", label: "筆電" },
    { value: "OTHER", label: "其他" }
  ];

  var rowSeq = 0;
  var submitting = false;

  function $(id) {
    return document.getElementById(id);
  }

  function lineUrl() {
    try {
      var cfg = window.DK && window.DK.getConfig && window.DK.getConfig();
      var url = cfg && cfg.line && cfg.line.url;
      if (url) return String(url);
    } catch (_) {}
    return DEFAULT_LINE_URL;
  }

  function applyLineLinks() {
    var url = lineUrl();
    ["uvSellBtn", "uvSoftLineBtn"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.setAttribute("href", url);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noreferrer");
    });
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = text == null ? "" : String(text);
  }

  function formatNtd(n) {
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return "NT$" + Math.round(x).toLocaleString("zh-TW");
  }

  function formatDate(v) {
    if (!v) return "—";
    var d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "/" + m + "/" + day;
  }

  function showFormError(msg) {
    var el = $("uvFormError");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function hidePanels() {
    var result = $("uvResult");
    var soft = $("uvSoftError");
    if (result) result.hidden = true;
    if (soft) soft.hidden = true;
  }

  function rowsRoot() {
    return $("uvRows");
  }

  function rowCount() {
    var root = rowsRoot();
    return root ? root.querySelectorAll(".uv-row").length : 0;
  }

  function refreshRowControls() {
    var n = rowCount();
    var addBtn = $("uvAddBtn");
    if (addBtn) addBtn.disabled = n >= MAX_ROWS;
    var root = rowsRoot();
    if (!root) return;
    var dels = root.querySelectorAll(".uv-row-del");
    dels.forEach(function (btn) {
      btn.disabled = n <= 1;
    });
  }

  function addRow() {
    if (rowCount() >= MAX_ROWS) return;
    rowSeq += 1;
    var id = String(rowSeq);
    var root = rowsRoot();
    if (!root) return;

    var article = document.createElement("article");
    article.className = "uv-row";
    article.setAttribute("data-row-id", id);

    var head = document.createElement("div");
    head.className = "uv-row-head";
    var title = document.createElement("h2");
    title.className = "uv-row-title";
    title.textContent = "零件";
    var del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost uv-row-del";
    del.textContent = "刪除";
    del.addEventListener("click", function () {
      if (rowCount() <= 1) return;
      article.remove();
      refreshRowControls();
    });
    head.appendChild(title);
    head.appendChild(del);

    var fields = document.createElement("div");
    fields.className = "uv-row-fields";

    function fieldWrap(labelText, control, required) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var lab = document.createElement("label");
      lab.setAttribute("for", control.id);
      lab.textContent = labelText;
      if (required) {
        var star = document.createElement("span");
        star.className = "required";
        star.textContent = " ＊";
        lab.appendChild(star);
      }
      wrap.appendChild(lab);
      wrap.appendChild(control);
      return wrap;
    }

    var cat = document.createElement("select");
    cat.id = "uv-cat-" + id;
    cat.name = "category-" + id;
    cat.required = true;
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "請選擇分類";
    cat.appendChild(placeholder);
    CATEGORIES.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.value;
      opt.textContent = c.label;
      cat.appendChild(opt);
    });

    var brand = document.createElement("input");
    brand.type = "text";
    brand.id = "uv-brand-" + id;
    brand.name = "brand-" + id;
    brand.required = true;
    brand.maxLength = 100;
    brand.autocomplete = "off";
    brand.placeholder = "例：Intel、AMD、NVIDIA";

    var model = document.createElement("input");
    model.type = "text";
    model.id = "uv-model-" + id;
    model.name = "model-" + id;
    model.required = true;
    model.maxLength = 160;
    model.autocomplete = "off";
    model.placeholder = "例：i7-12700、RTX 3070";

    var variant = document.createElement("input");
    variant.type = "text";
    variant.id = "uv-variant-" + id;
    variant.name = "variant-" + id;
    variant.maxLength = 160;
    variant.autocomplete = "off";
    variant.placeholder = "選填，例：16GB、1TB";

    fields.appendChild(fieldWrap("分類", cat, true));
    fields.appendChild(fieldWrap("品牌", brand, true));
    fields.appendChild(fieldWrap("型號", model, true));
    fields.appendChild(fieldWrap("規格／版本", variant, false));

    article.appendChild(head);
    article.appendChild(fields);
    root.appendChild(article);
    refreshRowControls();
  }

  function readComponents() {
    var root = rowsRoot();
    var rows = root ? root.querySelectorAll(".uv-row") : [];
    var list = [];
    var i;
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var cat = row.querySelector("select");
      var brand = row.querySelector('input[id^="uv-brand-"]');
      var model = row.querySelector('input[id^="uv-model-"]');
      var variant = row.querySelector('input[id^="uv-variant-"]');
      var category = cat ? String(cat.value || "").trim() : "";
      var brandVal = brand ? String(brand.value || "").trim() : "";
      var modelVal = model ? String(model.value || "").trim() : "";
      var variantVal = variant ? String(variant.value || "").trim() : "";
      if (!category) return { ok: false, error: "請選擇每一項零件的分類。" };
      if (!brandVal) return { ok: false, error: "請填寫每一項零件的品牌。" };
      if (!modelVal) return { ok: false, error: "請填寫每一項零件的型號。" };
      list.push({
        category: category,
        brand: brandVal,
        model: modelVal,
        variant: variantVal
      });
    }
    if (!list.length) return { ok: false, error: "請至少新增一項零件。" };
    if (list.length > MAX_ROWS) return { ok: false, error: "一次最多可估 20 項零件。" };
    return { ok: true, components: list };
  }

  function setSubmitting(on) {
    submitting = !!on;
    var btn = $("uvSubmitBtn");
    var loading = $("uvLoading");
    if (btn) {
      btn.disabled = submitting;
      btn.textContent = submitting ? "估價中…" : "立即免費估價";
    }
    if (loading) loading.hidden = !submitting;
  }

  function errorMessage(code, status, retryAfter) {
    if (code === "INSUFFICIENT_MARKET_DATA") {
      return "目前可參考的市場行情不足，暫時無法提供可靠估值。你仍可聯絡 DK 協助人工估價。";
    }
    if (code === "TOO_MANY_COMPONENTS") return "一次最多可估 20 項零件。";
    if (code === "INVALID_REQUEST") return "請檢查零件分類、品牌與型號是否填寫完整。";
    if (code === "RATE_LIMITED") {
      var msg = "操作過於頻繁，請稍後再試。";
      var sec = Number(retryAfter);
      if (Number.isFinite(sec) && sec > 0) {
        msg += "約 " + String(Math.round(sec)) + " 秒後再試。";
      }
      return msg;
    }
    if (code === "NO_ACTIVE_MARKET" || code === "NO_ACTIVE_RULE" || code === "INTERNAL_ERROR") {
      return "目前估價服務暫時無法使用，請稍後再試。";
    }
    if (status === 404) return "目前估價服務暫時無法使用，請稍後再試。";
    return "目前估價服務暫時無法使用，請稍後再試。";
  }

  function showSoftError(text) {
    hidePanels();
    var box = $("uvSoftError");
    var msg = $("uvSoftErrorText");
    setText(msg, text);
    if (box) box.hidden = false;
  }

  function renderResult(estimate) {
    hidePanels();
    var box = $("uvResult");
    if (!box) return;
    setText($("uvRange"), formatNtd(estimate.market_low) + " ～ " + formatNtd(estimate.market_high));
    setText($("uvMid"), formatNtd(estimate.market_mid));
    setText($("uvScore"), String(estimate.value_score) + " / 100");
    setText($("uvCoverage"), String(estimate.coverage_percent) + "%");
    setText($("uvMatched"), String(estimate.matched_count) + " / " + String(estimate.total_count) + " 項");
    setText($("uvUpdated"), formatDate(estimate.market_updated_at));

    var ul = $("uvReasons");
    if (ul) {
      while (ul.firstChild) ul.removeChild(ul.firstChild);
      var reasons = Array.isArray(estimate.reasons) ? estimate.reasons : [];
      reasons.forEach(function (r) {
        if (typeof r !== "string" || !r.trim()) return;
        var li = document.createElement("li");
        li.textContent = r.trim();
        ul.appendChild(li);
      });
    }
    box.hidden = false;
  }

  function functionUrl() {
    var base = "";
    try {
      if (window.DK && typeof window.DK.getSupabaseProjectUrl === "function") {
        base = String(window.DK.getSupabaseProjectUrl() || "");
      }
    } catch (_) {}
    if (!base) return "";
    return base.replace(/\/$/, "") + "/functions/v1/used-valuation-estimate";
  }

  function anonKey() {
    try {
      if (window.DK && typeof window.DK.getSupabaseAnonKey === "function") {
        return String(window.DK.getSupabaseAnonKey() || "");
      }
    } catch (_) {}
    return "";
  }

  function submitEstimate(components) {
    var url = functionUrl();
    var key = anonKey();
    if (!url || !key) {
      return Promise.resolve({ ok: false, code: "INTERNAL_ERROR", status: 0 });
    }
    var ac = new AbortController();
    var timer = setTimeout(function () {
      try { ac.abort(); } catch (_) {}
    }, REQUEST_TIMEOUT_MS);
    return fetch(url, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ components: components }),
      signal: ac.signal
    }).then(function (res) {
      return res.json().then(function (data) {
        return { http: res, data: data };
      }).catch(function () {
        return { http: res, data: null };
      });
    }).then(function (pack) {
      var data = pack.data;
      var status = pack.http ? pack.http.status : 0;
      if (data && data.ok === true && data.estimate) {
        return { ok: true, estimate: data.estimate, status: status };
      }
      var code = data && data.code ? String(data.code) : "INTERNAL_ERROR";
      var retryAfter = data && data.retry_after_seconds != null ? data.retry_after_seconds : 0;
      return { ok: false, code: code, status: status, retryAfter: retryAfter };
    }).catch(function (err) {
      var aborted = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
      return { ok: false, code: aborted ? "TIMEOUT" : "NETWORK", status: 0 };
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (submitting) return;
    showFormError("");
    hidePanels();
    var parsed = readComponents();
    if (!parsed.ok) {
      showFormError(parsed.error);
      return;
    }
    setSubmitting(true);
    submitEstimate(parsed.components).then(function (out) {
      setSubmitting(false);
      if (out.ok) {
        renderResult(out.estimate);
        return;
      }
      if (out.code === "TIMEOUT" || out.code === "NETWORK") {
        showFormError("連線逾時或網路異常，請稍後再試。");
        return;
      }
      var msg = errorMessage(out.code, out.status, out.retryAfter);
      if (out.code === "INSUFFICIENT_MARKET_DATA") {
        showSoftError(msg);
        return;
      }
      showFormError(msg);
    }).catch(function () {
      setSubmitting(false);
      showFormError("連線逾時或網路異常，請稍後再試。");
    });
  }

  function resetForm() {
    setSubmitting(false);
    showFormError("");
    hidePanels();
    var root = rowsRoot();
    if (root) {
      while (root.firstChild) root.removeChild(root.firstChild);
    }
    addRow();
    var form = $("uvForm");
    if (form && typeof form.scrollIntoView === "function") {
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function bind() {
    applyLineLinks();
    var addBtn = $("uvAddBtn");
    if (addBtn) addBtn.addEventListener("click", addRow);
    var form = $("uvForm");
    if (form) form.addEventListener("submit", onSubmit);
    var resetBtn = $("uvResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetForm);
    var softReset = $("uvSoftResetBtn");
    if (softReset) softReset.addEventListener("click", resetForm);
    addRow();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
