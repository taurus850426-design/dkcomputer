/**
 * 拍照辨識新增庫存 - OCR（Tesseract.js）+ 規則引擎 + 入庫寫入
 * 使用方式：開啟 photo-recognize-add.html，拍照或選圖 → OCR 辨識 → 顯示擷取文字與判斷結果 → 確認後儲存入庫。
 */
(function () {
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  function nowISO() {
    return new Date().toISOString();
  }
  function el(id) {
    return document.getElementById(id);
  }
  function setStatus(msg) {
    const s = el("ocrStatus");
    if (s) s.textContent = msg;
  }

  // ---------- 規則引擎：OCR 文字 → category, sub_type, brand, model, spec, confidence ----------
  const GPU_KEYWORDS = /\b(RTX|GTX|RX\s*\d|ARC\s*A?\d|Radeon|GeForce)\b/i;
  const GPU_BRANDS = /^(MSI|ASUS|Gigabyte|GIGABYTE|ZOTAC|PALIT|GALAX|EVGA|PNY|Colorful|微星|華碩|技嘉)$/i;
  const VRAM = /\b(6G|8G|10G|12G|16G|24G)\b/i;
  const CPU_KEYWORDS = /\b(i[3579]-|Ryzen|Threadripper|Core\s*i[3579])\b|^\s*i[3579]\s*[-]?\s*\d/i;
  const CPU_NUMBERS = /\b(8400|9400|10400|12400F?|13400|14400|8600K?|9600K?|12600K?|13600K?|7600X?|7700X?|7800X3D)\b/i;
  const PLATFORM = /\b(LGA\s*1151|LGA\s*1200|LGA\s*1700|AM4|AM5)\b/i;
  const SSD_HDD = /\b(SSD|NVMe|M\.2|SATA|HDD|2\.5|固態|硬碟)\b/i;
  const CAPACITY = /\b(120|240|256|480|500|512|1T|2T|4T)(\s*GB|\s*G\b|\s*TB)?/i;
  const RAM_KEYWORDS = /\b(DDR3|DDR4|DDR5|DIMM|SO-DIMM)\b/i;
  const RAM_CAP = /\b(4G|8G|16G|32G|64G)\b/i;
  const MB_CHIPSET = /\b(H110|H310|H410|H510|H610|B360|B365|B460|B560|B660|Z370|Z390|Z490|Z590|Z690|Z790|X570|B450|B550|X670|A320|A520)\b/i;

  function ruleEngine(ocrText) {
    const out = {
      category: "PART",
      sub_type: "OTHER",
      brand: "",
      model: "",
      spec: "",
      confidence: 0.3,
    };
    const t = String(ocrText || "").trim();
    if (!t) return out;

    // 取一段較像型號的文字當 model（首行或最長一行）
    const lines = t.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    const longLine = lines.reduce(function (a, b) { return a.length >= b.length ? a : b; }, "");
    out.model = longLine.slice(0, 80);

    // GPU
    if (GPU_KEYWORDS.test(t) || GPU_BRANDS.test(t)) {
      out.category = "GPU";
      out.sub_type = "GPU";
      out.confidence = 0.85;
      const vram = t.match(VRAM);
      if (vram) out.spec = (out.spec ? out.spec + " " : "") + vram[0];
      if (/MSI|微星/i.test(t)) out.brand = "MSI";
      else if (/ASUS|華碩/i.test(t)) out.brand = "ASUS";
      else if (/Gigabyte|技嘉/i.test(t)) out.brand = "Gigabyte";
      else if (/ZOTAC/i.test(t)) out.brand = "ZOTAC";
      else if (/PALIT/i.test(t)) out.brand = "PALIT";
      else if (/GALAX/i.test(t)) out.brand = "GALAX";
      else if (/EVGA/i.test(t)) out.brand = "EVGA";
      else if (/NVIDIA|GeForce|RTX|GTX/i.test(t)) out.brand = "NVIDIA";
      else if (/AMD|Radeon|RX/i.test(t)) out.brand = "AMD";
      return out;
    }

    // CPU
    if (CPU_KEYWORDS.test(t) || CPU_NUMBERS.test(t)) {
      out.category = "PART";
      out.sub_type = "CPU";
      out.confidence = 0.8;
      const plat = t.match(PLATFORM);
      if (plat) out.spec = plat[0];
      if (/Intel|i[3579]-/i.test(t)) out.brand = "Intel";
      else if (/AMD|Ryzen/i.test(t)) out.brand = "AMD";
      return out;
    }

    // SSD / HDD
    if (SSD_HDD.test(t)) {
      out.category = "PART";
      out.sub_type = (/HDD|硬碟/i.test(t)) ? "HDD" : "SSD";
      out.confidence = 0.8;
      const cap = t.match(CAPACITY);
      if (cap) out.spec = (cap[1] || "") + (cap[2] || "GB");
      if (/Samsung|三星/i.test(t)) out.brand = "Samsung";
      else if (/Kingston|金士頓/i.test(t)) out.brand = "Kingston";
      else if (/WD|Western/i.test(t)) out.brand = "WD";
      else if (/Crucial|美光/i.test(t)) out.brand = "Crucial";
      else if (/TEAMGROUP|十銓/i.test(t)) out.brand = "TEAMGROUP";
      return out;
    }

    // RAM
    if (RAM_KEYWORDS.test(t)) {
      out.category = "PART";
      out.sub_type = "RAM";
      out.confidence = 0.8;
      const cap = t.match(RAM_CAP);
      if (cap) out.spec = (out.spec ? out.spec + " " : "") + cap[0];
      if (/DDR4/i.test(t)) out.spec = (out.spec ? out.spec + " " : "") + "DDR4";
      if (/DDR5/i.test(t)) out.spec = (out.spec ? out.spec + " " : "") + "DDR5";
      return out;
    }

    // Motherboard
    if (MB_CHIPSET.test(t)) {
      out.category = "PART";
      out.sub_type = "MOTHERBOARD";
      out.confidence = 0.75;
      if (/MSI|微星/i.test(t)) out.brand = "MSI";
      else if (/ASUS|華碩/i.test(t)) out.brand = "ASUS";
      else if (/Gigabyte|技嘉/i.test(t)) out.brand = "Gigabyte";
      return out;
    }

    return out;
  }

  function suggestSKU(suggestion) {
    const cat = (suggestion.category || "PART").toUpperCase();
    const sub = (suggestion.sub_type || "").toUpperCase();
    const brand = (suggestion.brand || "").replace(/\s/g, "");
    const model = (suggestion.model || "").replace(/\s/g, "").slice(0, 20);
    const spec = (suggestion.spec || "").replace(/\s/g, "").slice(0, 12);
    const parts = [cat];
    if (sub && sub !== "OTHER") parts.push(sub);
    if (brand) parts.push(brand);
    if (model) parts.push(model);
    if (spec) parts.push(spec);
    return parts.join("-").replace(/[-]+/g, "-").replace(/^-|-$/g, "") || "ITEM-" + Date.now().toString(36);
  }

  // ---------- OCR：Tesseract.js（支援英文與數字）----------
  function runOCR(fileOrDataUrl) {
    var Tesseract = window.Tesseract;
    if (!Tesseract || !Tesseract.createWorker) {
      return Promise.reject(new Error("Tesseract.js 未載入"));
    }
    return Tesseract.createWorker("eng")
      .then(function (worker) {
        return worker
          .recognize(fileOrDataUrl)
          .then(function (ret) {
            return ret.data.text;
          })
          .finally(function () {
            return worker.terminate();
          });
      });
  }

  function getCategoryOptions() {
    return (window.DK && DK.getInventoryCategories && DK.getInventoryCategories()) || ["處理器", "主機板", "記憶體", "硬碟", "顯示卡", "電源供應器", "機殼", "螢幕", "鍵盤", "滑鼠", "耳機", "周邊", "其他"];
  }

  function mapSuggestionToCategory(suggestion) {
    const opts = getCategoryOptions();
    const sub = (suggestion.sub_type || "").toUpperCase();
    const cat = (suggestion.category || "").toUpperCase();
    if (sub && opts.includes("顯示卡") && (sub === "GPU")) return "顯示卡";
    if (sub && opts.includes("處理器") && (sub === "CPU")) return "處理器";
    if (sub && opts.includes("記憶體") && (sub === "RAM")) return "記憶體";
    if (sub && opts.includes("硬碟") && (sub === "SSD" || sub === "HDD")) return "硬碟";
    if (sub && opts.includes("電源供應器") && (sub === "PSU")) return "電源供應器";
    if (sub && opts.includes("機殼") && (sub === "CASE")) return "機殼";
    if ((sub === "MOTHERBOARD" || sub === "主機板") && opts.includes("主機板")) return "主機板";
    if (cat === "GPU" && opts.includes("顯示卡")) return "顯示卡";
    return opts[0] || "處理器";
  }

  function fillRecCategorySelect() {
    const sel = el("recCategory");
    if (!sel) return;
    const opts = getCategoryOptions();
    sel.innerHTML = opts.map(function (c) { return "<option value=\"" + c.replace(/"/g, "&quot;") + "\">" + c + "</option>"; }).join("");
  }

  // ---------- 表單填寫與顯示 ----------
  function fillForm(suggestion, ocrText) {
    el("recCategory").value = mapSuggestionToCategory(suggestion);
    el("recSubType").value = suggestion.sub_type || "";
    el("recBrand").value = suggestion.brand || "";
    el("recModel").value = suggestion.model || "";
    el("recSpec").value = suggestion.spec || "";
    el("recCondition").value = "USED";
    el("recStatusSel").value = "READY";
    el("recQty").value = "1";
    el("recCost").value = "0";
    el("recInboundDate").value = todayStr();
    el("recLocation").value = "";
    el("recReorderPoint").value = "0";
    el("recNotes").value = ocrText ? "OCR辨識" : "";
    el("confidenceWarn").hidden = suggestion.confidence >= 0.6;
    el("uploadZone").hidden = false;
    el("recForm").hidden = false;
    el("saveSummary").hidden = true;
    el("ocrText").value = ocrText || "";
    el("ocrTextBlock").hidden = false;
    el("recFormMsg").hidden = true;
  }

  function showUploadZone() {
    el("uploadZone").hidden = false;
    el("recForm").hidden = true;
    el("saveSummary").hidden = true;
    el("previewWrap").hidden = true;
    el("ocrTextBlock").hidden = true;
    setStatus("");
  }

  function showSummary(text) {
    el("uploadZone").hidden = true;
    el("recForm").hidden = true;
    el("saveSummary").hidden = false;
    el("saveSummaryText").textContent = text;
  }

  // 依表單欄位產生建議 SKU，並確保不與既有重複（可加 -2, -3...）
  function ensureUniqueSKU(baseSku) {
    var DK = window.DK;
    if (!DK || !DK.findItemBySku) return baseSku || "ITEM-" + Date.now().toString(36);
    var sku = (baseSku || "").trim().toUpperCase() || "ITEM-" + Date.now().toString(36);
    var n = 1;
    while (DK.findItemBySku(sku)) {
      sku = (baseSku || "ITEM").trim().toUpperCase().replace(/\-\d+$/, "") + "-" + (++n);
    }
    return sku;
  }

  // ---------- 儲存入庫：建立/更新 Item + Ledger IN ----------
  async function savePhotoRecInbound() {
    var DK = window.DK;
    var category = el("recCategory").value || (getCategoryOptions()[0]) || "處理器";
    var subType = el("recSubType").value || "";
    var brand = String(el("recBrand").value || "").trim();
    var model = String(el("recModel").value || "").trim();
    var spec = String(el("recSpec").value || "").trim();
    var baseSku = suggestSKU({ category: category, sub_type: subType, brand: brand, model: model, spec: spec });
    var existing = DK && DK.findItemBySku ? DK.findItemBySku(baseSku) : null;
    var sku = existing ? baseSku : ensureUniqueSKU(baseSku);
    const name = brand ? brand + " " + model : model || "未命名";
    const qty = Math.max(1, parseInt(el("recQty").value, 10) || 1);
    const isAdmin = window.DK && typeof window.DK.getCurrentRole === "function" && window.DK.getCurrentRole() === "admin";
    const unitCost = isAdmin ? (parseFloat(el("recCost").value) || 0) : undefined;
    const location = String(el("recLocation").value || "").trim();
    const notes = String(el("recNotes").value || "").trim();
    const condition = el("recCondition").value || "USED";
    const status = el("recStatusSel").value || "READY";
    const inboundDate = el("recInboundDate").value || todayStr();
    const reorderPoint = Math.max(0, parseInt(el("recReorderPoint") && el("recReorderPoint").value, 10) || 0);
    if (!name || name === "未命名") {
      el("recFormMsg").textContent = "請填寫品牌或型號（名稱）";
      el("recFormMsg").hidden = false;
      return;
    }

    if (!DK || !DK.getItems || !DK.saveItems || !DK.addLedgerEntry) {
      el("recFormMsg").textContent = "庫存模組未載入，請從後台進入。";
      el("recFormMsg").hidden = false;
      return;
    }

    const items = DK.getItems();
    const existingItem = DK.findItemBySku(sku);
    const now = nowISO();

    if (existingItem) {
      const inQty = qty;
      const result = await DK.addLedgerEntry({
        item_id: existingItem.id,
        type: "IN",
        qty: inQty,
        unit_cost: unitCost,
        ref_type: "PURCHASE",
        ref_id: "",
        note: "拍照辨識入庫 " + (notes || ""),
      });
      if (!result.ok) {
        el("recFormMsg").textContent = result.error || "入庫失敗";
        el("recFormMsg").hidden = false;
        return;
      }
      const qtyNow = Number(DK.findItemById(existingItem.id)?.qty_on_hand) || (existingItem.qty_on_hand + inQty);
      const summary = isAdmin
        ? ("已入庫：品項 " + (existingItem.name || sku) + "，+" + inQty + " 件，成本小計 " + ((inQty * (unitCost || 0)) ? "NT$ " + (inQty * (unitCost || 0)) : "0") + "。現有數量 " + qtyNow + "。")
        : ("已入庫：品項 " + (existingItem.name || sku) + "，+" + inQty + " 件。現有數量 " + qtyNow + "。");
      showSummary(summary);
    } else {
      const newItem = {
        id: "i-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9),
        sku,
        category,
        sub_type: subType || undefined,
        brand: brand || undefined,
        model: model || undefined,
        name,
        spec,
        condition,
        status,
        qty_on_hand: 0,
        price_list: null,
        price_floor: null,
        inbound_date: inboundDate,
        last_moved_at: inboundDate + "T12:00:00Z",
        reorder_point: reorderPoint,
        location,
        notes,
        created_at: now,
        updated_at: now,
      };
      if (isAdmin) newItem.cost_unit = unitCost;
      items.unshift(newItem);
      const saved = await DK.saveItems(items);
      if (!saved || !saved.ok) {
        const raw = (saved && saved.error) || "新增品項失敗";
        el("recFormMsg").textContent =
          DK.mapReplenishmentWriteError ? DK.mapReplenishmentWriteError(raw) : raw;
        el("recFormMsg").hidden = false;
        return;
      }
      const result = await DK.addLedgerEntry({
        item_id: newItem.id,
        type: "IN",
        qty,
        unit_cost: unitCost,
        ref_type: "PURCHASE",
        ref_id: "",
        note: "拍照辨識新增 " + (notes || ""),
      });
      if (!result.ok) {
        el("recFormMsg").textContent = result.error || "寫入流水失敗";
        el("recFormMsg").hidden = false;
        return;
      }
      const summaryNew = isAdmin
        ? ("已新增品項：" + name + "，數量 " + qty + "，成本小計 " + ((qty * (unitCost || 0)) ? "NT$ " + (qty * (unitCost || 0)) : "0") + "。")
        : ("已新增品項：" + name + "，數量 " + qty + "。");
      showSummary(summaryNew);
    }
  }

  function applyFromOcrText() {
    var text = String(el("ocrText").value || "").trim();
    if (!text) {
      setStatus("請先上傳照片完成 OCR，或輸入文字後按「依上方文字重新判斷」。");
      return;
    }
    var suggestion = ruleEngine(text);
    fillForm(suggestion, text);
    setStatus("已依文字重新判斷，請確認表單後儲存。");
  }

  // ---------- 事件綁定 ----------
  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    var previewImg = el("previewImg");
    var previewWrap = el("previewWrap");
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      if (previewImg) {
        previewImg.src = dataUrl;
        if (previewWrap) previewWrap.hidden = false;
      }
      setStatus("OCR 辨識中…（首次會載入語言包，請稍候）");
      runOCR(file)
        .then(function (text) {
          var trimmed = (text || "").trim();
          if (!trimmed) {
            setStatus("未辨識到文字，請重拍或手動輸入後按「依上方文字重新判斷」。");
            el("ocrText").value = "";
            el("ocrTextBlock").hidden = false;
            return;
          }
          el("ocrText").value = trimmed;
          el("ocrTextBlock").hidden = false;
          var suggestion = ruleEngine(trimmed);
          fillForm(suggestion, trimmed);
          setStatus("辨識完成，請確認系統判斷結果後儲存。");
        })
        .catch(function (err) {
          setStatus("OCR 失敗：" + (err && err.message ? err.message : String(err)));
          el("ocrTextBlock").hidden = false;
          el("ocrText").value = "";
        });
    };
    reader.readAsDataURL(file);
  }

  function initPhotoRecognizeAddTool() {
    el("photoCamera").addEventListener("change", function (e) {
      var file = e.target && e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) handleFile(file);
    });
    el("photoGallery").addEventListener("change", function (e) {
      var file = e.target && e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) handleFile(file);
    });
    el("ocrReRunBtn").addEventListener("click", applyFromOcrText);
    el("recSaveBtn").addEventListener("click", savePhotoRecInbound);
    el("recCancelBtn").addEventListener("click", showUploadZone);
    el("recAgainBtn").addEventListener("click", showUploadZone);
    el("recInboundDate").value = todayStr();
    fillRecCategorySelect();
  }

  var gate = window.DK && window.DK.gateBackofficeToolPage;
  if (typeof gate !== "function") {
    location.replace("./admin.html");
    return;
  }
  gate({ roles: ["admin", "staff"] }).then(function (ok) {
    if (!ok) return;
    if (window.DK.revealBackofficeToolRoot) window.DK.revealBackofficeToolRoot("photoRecRoot");
    if (window.DK.getCurrentRole && window.DK.getCurrentRole() === "staff") {
      document.body.classList.add("dk-role-staff");
    }
    function start() {
      initPhotoRecognizeAddTool();
    }
    if (typeof window.fetchV2DataFromSupabase === "function") {
      window.fetchV2DataFromSupabase().then(start).catch(start);
    } else start();
  });
})();
