/* analytics.js - GA4 安全事件輔助（失敗不影響網站功能） */
(function (window, document) {
  "use strict";
  if (window.__dkGaAnalyticsInit) return;
  window.__dkGaAnalyticsInit = true;

  var OFFICIAL_LINE = "https://lin.ee/p58Bkqp";
  var lastLeadKey = "";
  var lastLeadAt = 0;
  var LINE_CTA_IDS = {
    navLineBtn: 1,
    lineStickyBtn: 1,
    heroLineBtn: 1,
    lineMainBtn: 1,
    lineCtaBlockBtn: 1,
    lineFaqLink: 1,
    productPageLineBtn: 1,
  };

  function trackGAEvent(eventName, parameters) {
    try {
      if (typeof window.gtag !== "function") return;
      var name = String(eventName || "").trim();
      if (!name) return;
      var params = {};
      var src = parameters && typeof parameters === "object" ? parameters : {};
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) params[k] = src[k];
      }
      if (name === "generate_lead" && !params.transport_type) {
        params.transport_type = "beacon";
      }
      window.gtag("event", name, params);
    } catch (_) {}
  }

  /** 官方 LINE（p58Bkqp，可含 query／hash） */
  function isOfficialLineUrl(url) {
    try {
      var raw = String(url || "").trim();
      if (!raw) return false;
      try {
        var u = new URL(raw, "https://lin.ee/");
        if (String(u.hostname || "").toLowerCase() !== "lin.ee") return false;
        var path = String(u.pathname || "").replace(/\/+$/, "").toLowerCase();
        return path === "/p58bkqp";
      } catch (_) {
        return /(?:^|\/\/)lin\.ee\/p58bkqp(?:[/?#]|$)/i.test(raw);
      }
    } catch (_) {
      return false;
    }
  }

  /** 任何 lin.ee 短網址（相容後台仍存舊網址的 CTA） */
  function isAnyLineUrl(url) {
    try {
      var raw = String(url || "").trim();
      if (!raw || raw === "#") return false;
      if (isOfficialLineUrl(raw)) return true;
      try {
        var u = new URL(raw, "https://lin.ee/");
        return String(u.hostname || "").toLowerCase() === "lin.ee";
      } catch (_) {
        return /lin\.ee\//i.test(raw);
      }
    } catch (_) {
      return false;
    }
  }

  function isTrackedLineUrl(url) {
    return isAnyLineUrl(url);
  }

  function shouldDedupe(key) {
    var now = Date.now();
    if (key === lastLeadKey && now - lastLeadAt < 1200) return true;
    lastLeadKey = key;
    lastLeadAt = now;
    return false;
  }

  /** 優先使用官方 gtag('event','generate_lead',…) + beacon */
  function sendGenerateLead(parameters) {
    try {
      if (typeof window.gtag !== "function") return false;
      var src = parameters && typeof parameters === "object" ? parameters : {};
      var params = {
        lead_source: src.lead_source || "line",
        page_path: String(src.page_path != null ? src.page_path : location.pathname || ""),
        transport_type: "beacon",
      };
      if (src.link_url) params.link_url = String(src.link_url);
      if (src.button_text) {
        params.button_text = String(src.button_text).replace(/\s+/g, " ").trim().slice(0, 100);
      }
      if (src.form_type) params.form_type = String(src.form_type);
      if (typeof src.event_callback === "function") params.event_callback = src.event_callback;
      window.gtag("event", "generate_lead", params);
      return true;
    } catch (_) {
      return false;
    }
  }

  function trackLineLead(linkUrl, buttonText, extra) {
    try {
      var href = String(linkUrl || "").trim();
      if (!href || href === "#") href = OFFICIAL_LINE;
      if (!isTrackedLineUrl(href)) href = OFFICIAL_LINE;
      var text = String(buttonText || "").replace(/\s+/g, " ").trim().slice(0, 100);
      var key = (extra && extra.dedupeKey) || (href + "|" + text + "|" + String(location.pathname || ""));
      if (shouldDedupe(key)) return;
      sendGenerateLead({
        lead_source: "line",
        link_url: href,
        page_path: String(location.pathname || ""),
        button_text: text,
        event_callback: extra && extra.event_callback,
      });
    } catch (_) {}
  }

  function toGaPrice(value) {
    try {
      if (value == null || value === "") return null;
      if (typeof value === "number") {
        return Number.isFinite(value) && value > 0 ? value : null;
      }
      var raw = String(value).trim();
      if (!raw || /洽詢|詢價|問價/i.test(raw)) return null;
      var n = Number(raw.replace(/,/g, "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) {
      return null;
    }
  }

  function buildGaItem(item) {
    var out = {};
    try {
      if (!item || typeof item !== "object") return out;
      var id = item.id != null && String(item.id).trim() !== ""
        ? String(item.id)
        : (item.sku != null && String(item.sku).trim() !== "" ? String(item.sku) : "");
      if (id) out.item_id = id;
      if (item.name != null && String(item.name).trim() !== "") out.item_name = String(item.name);
      if (item.category != null && String(item.category).trim() !== "") out.item_category = String(item.category);
      var price = toGaPrice(item.price);
      if (price != null) out.price = price;
    } catch (_) {}
    return out;
  }

  function getLineAnchorFromEvent(e) {
    var t = e && e.target;
    if (!t || typeof t.closest !== "function") return null;
    var a = t.closest("a[href]");
    if (a) return a;
    var el = t.closest("a, button");
    if (el && el.id && LINE_CTA_IDS[el.id]) return el;
    if (el && el.classList && el.classList.contains("machine-line-btn")) return el;
    return null;
  }

  window.trackGAEvent = trackGAEvent;
  window.__dkIsTrackedLineUrl = isTrackedLineUrl;
  window.__dkIsOfficialLineUrl = isOfficialLineUrl;
  window.__dkTrackLineLead = trackLineLead;
  window.__dkSendGenerateLead = sendGenerateLead;
  window.__dkToGaPrice = toGaPrice;
  window.__dkBuildGaItem = buildGaItem;
  window.__dkOfficialLineUrl = OFFICIAL_LINE;

  document.addEventListener(
    "click",
    function (e) {
      try {
        var el = getLineAnchorFromEvent(e);
        if (!el) return;

        var href = "";
        try {
          href = el.href || el.getAttribute("href") || "";
        } catch (_) {
          href = (el.getAttribute && el.getAttribute("href")) || "";
        }

        var isKnownCta = !!(el.id && LINE_CTA_IDS[el.id]);
        var isMachineLine = !!(el.classList && el.classList.contains("machine-line-btn"));
        if (!isTrackedLineUrl(href) && !isKnownCta && !isMachineLine) return;

        var linkUrl = isTrackedLineUrl(href) ? href : OFFICIAL_LINE;
        var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        var targetAttr = (el.getAttribute && el.getAttribute("target")) || "";
        var isNewTab = String(targetAttr).toLowerCase() === "_blank";
        var hasModifier = !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

        // 會離開目前分頁的 LINE 連結：beacon + event_callback 後再跳轉
        if (
          el.tagName === "A" &&
          isTrackedLineUrl(href) &&
          !isNewTab &&
          !hasModifier &&
          !e.defaultPrevented
        ) {
          e.preventDefault();
          var navigated = false;
          var go = function () {
            if (navigated) return;
            navigated = true;
            try {
              window.location.href = linkUrl;
            } catch (_) {}
          };
          trackLineLead(linkUrl, text, { event_callback: go });
          setTimeout(go, 350);
          return;
        }

        // 其餘（含 target=_blank、已知 CTA）：beacon 送出，不攔截預設行為
        trackLineLead(linkUrl, text);
      } catch (_) {}
    },
    true
  );
})(window, document);
