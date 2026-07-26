/* analytics.js - GA4 安全事件輔助（失敗不影響網站功能） */
(function (window, document) {
  "use strict";
  if (window.__dkGaAnalyticsInit) return;
  window.__dkGaAnalyticsInit = true;

  var lastLeadKey = "";
  var lastLeadAt = 0;

  function trackGAEvent(eventName, parameters) {
    try {
      if (typeof window.gtag !== "function") return;
      var name = String(eventName || "").trim();
      if (!name) return;
      var params = parameters && typeof parameters === "object" ? parameters : {};
      window.gtag("event", name, params);
    } catch (_) {}
  }

  /** 僅追蹤官方 LINE：https://lin.ee/p58Bkqp（可含 query／hash）；不追蹤其他 lin.ee */
  function isTrackedLineUrl(url) {
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

  function trackLineLead(linkUrl, buttonText) {
    try {
      var href = String(linkUrl || "");
      if (!isTrackedLineUrl(href)) return;
      var text = String(buttonText || "").replace(/\s+/g, " ").trim().slice(0, 100);
      var key = href + "|" + text + "|" + String(location.pathname || "");
      var now = Date.now();
      if (key === lastLeadKey && now - lastLeadAt < 1000) return;
      lastLeadKey = key;
      lastLeadAt = now;
      trackGAEvent("generate_lead", {
        lead_source: "line",
        link_url: href,
        page_path: String(location.pathname || ""),
        button_text: text,
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

  window.trackGAEvent = trackGAEvent;
  window.__dkIsTrackedLineUrl = isTrackedLineUrl;
  window.__dkTrackLineLead = trackLineLead;
  window.__dkToGaPrice = toGaPrice;
  window.__dkBuildGaItem = buildGaItem;

  document.addEventListener(
    "click",
    function (e) {
      try {
        var t = e.target;
        if (!t || typeof t.closest !== "function") return;
        var a = t.closest("a[href]");
        if (!a) return;
        var href = a.href || a.getAttribute("href") || "";
        if (!isTrackedLineUrl(href)) return;
        var text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
        trackLineLead(href, text);
      } catch (_) {}
    },
    true
  );
})(window, document);
