/**
 * 掃碼新增庫存 - 解碼、規則引擎、入庫寫入
 * 使用方式：開啟 scan-add.html，用手機相機或相簿掃描條碼/QR，確認表單後儲存入庫。
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
    const s = el("scanStatus");
    if (s) s.textContent = msg;
  }

  // ---------- RuleEngine：raw_code + model_text → category, sub_type, brand, model, spec, confidence ----------
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
  const MB_CHIPSET = /^(H110|H310|H410|H510|H610|B360|B365|B460|B560|B660|Z370|Z390|Z490|Z590|Z690|Z790|X570|B450|B550|X670|A320|A520)/i;

  function ruleEngine(rawCode, modelText) {
    const out = {
      category: "PART",
      sub_type: "OTHER",
      brand: "",
      model: modelText || rawCode || "",
      spec: "",
      confidence: 0.3,
    };
    const t = String((modelText || "") + " " + (rawCode || "")).trim();
    if (!t) return out;

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
      out.sub_type = t.toLowerCase().includes("hdd") || /硬碟/i.test(t) ? "HDD" : "SSD";
      out.confidence = 0.8;
      const cap = t.match(CAPACITY);
      if (cap) out.spec = cap[1] + (cap[2] || "GB");
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
      return out;
    }

    // Motherboard
    if (MB_CHIPSET.test(t)) {
      out.category = "PART";
      out.sub_type = "MOTHERBOARD";
      out.confidence = 0.75;
      return out;
    }

    // 純數字條碼：可能是 UPC，confidence 較低
    if (/^\d{12,14}$/.test(String(rawCode || "").replace(/\s/g, ""))) {
      out.confidence = 0.4;
      out.model = rawCode || "";
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

  // ---------- 解碼圖片：Quagga + jsQR ----------
  function decodeImageFile(file) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const dataUrl = e.target.result;
        const img = new Image();
        img.onload = function () {
          const canvas = document.createElement("canvas");
          const max = 1200;
          let w = img.width;
          let h = img.height;
          if (w > max || h > max) {
            if (w > h) {
              h = Math.round((h * max) / w);
              w = max;
            } else {
              w = Math.round((w * max) / h);
              h = max;
            }
          }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          let barcodeText = "";
          let qrText = "";
          if (typeof window.jsQR === "function") {
            try {
              const qr = window.jsQR(imageData.data, w, h);
              if (qr && qr.data) qrText = qr.data;
            } catch (err) {}
          }
          let resolved = false;
          function doResolve() {
            if (resolved) return;
            resolved = true;
            resolve({ barcodeText, qrText });
          }
          if (typeof window.Quagga !== "undefined" && window.Quagga.decodeSingle) {
            window.Quagga.decodeSingle(
              {
                src: dataUrl,
                numOfWorkers: 0,
                inputStream: { size: Math.max(w, h) },
                decoder: { readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "upc_e_reader"] },
              },
              function (result) {
                if (result && result.codeResult && result.codeResult.code) barcodeText = result.codeResult.code;
                doResolve();
              }
            );
            setTimeout(doResolve, 3500);
          } else {
            doResolve();
          }
        };
        img.onerror = function () {
          resolve({ barcodeText: "", qrText: "" });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- 表單填寫與顯示 ----------
  let lastRawCode = "";
  let lastModelText = "";

  function fillForm(suggestion, rawCode, skuSuggestion) {
    el("scanCategory").value = suggestion.category || "PART";
    el("scanSubType").value = suggestion.sub_type || "";
    el("scanBrand").value = suggestion.brand || "";
    el("scanModel").value = suggestion.model || "";
    el("scanSpec").value = suggestion.spec || "";
    el("scanSku").value = skuSuggestion || "";
    el("scanCondition").value = "USED";
    el("scanStatusSel").value = "TESTING";
    el("scanQty").value = "1";
    el("scanCost").value = "0";
    el("scanInboundDate").value = todayStr();
    el("scanLocation").value = "";
    el("scanNotes").value = rawCode ? "掃碼: " + rawCode : "";
    lastRawCode = rawCode || "";
    lastModelText = suggestion.model || "";
    el("confidenceWarn").hidden = suggestion.confidence >= 0.6;
    el("scanZone").hidden = true;
    el("scanForm").hidden = false;
    el("saveSummary").hidden = true;
  }

  function showScanZone() {
    el("scanZone").hidden = false;
    el("scanForm").hidden = true;
    el("saveSummary").hidden = true;
    setStatus("");
  }

  function showSummary(text) {
    el("scanZone").hidden = true;
    el("scanForm").hidden = true;
    el("saveSummary").hidden = false;
    el("saveSummaryText").textContent = text;
  }

  // ---------- 儲存入庫：建立/更新 Item + Ledger IN ----------
  async function saveScanInbound() {
    const sku = String(el("scanSku").value || "").trim().toUpperCase();
    const category = el("scanCategory").value || "PART";
    const subType = el("scanSubType").value || "";
    const brand = String(el("scanBrand").value || "").trim();
    const model = String(el("scanModel").value || "").trim();
    const spec = String(el("scanSpec").value || "").trim();
    const name = brand ? brand + " " + model : model || "未命名";
    const qty = Math.max(1, parseInt(el("scanQty").value, 10) || 1);
    const isAdmin = window.DK && typeof window.DK.getCurrentRole === "function" && window.DK.getCurrentRole() === "admin";
    const unitCost = isAdmin ? (parseFloat(el("scanCost").value) || 0) : undefined;
    const location = String(el("scanLocation").value || "").trim();
    const notes = String(el("scanNotes").value || "").trim();
    const condition = el("scanCondition").value || "USED";
    const status = el("scanStatusSel").value || "TESTING";
    const inboundDate = el("scanInboundDate").value || todayStr();
    const reorderPoint = Math.max(0, parseInt(el("scanReorderPoint") && el("scanReorderPoint").value, 10) || 0);

    if (!sku) {
      el("scanFormMsg").textContent = "請填寫 SKU";
      el("scanFormMsg").hidden = false;
      return;
    }
    if (!name || name === "未命名") {
      el("scanFormMsg").textContent = "請填寫品牌或型號（名稱）";
      el("scanFormMsg").hidden = false;
      return;
    }

    const DK = window.DK;
    if (!DK || !DK.getItems || !DK.saveItems || !DK.addLedgerEntry) {
      el("scanFormMsg").textContent = "庫存模組未載入，請從後台進入。";
      el("scanFormMsg").hidden = false;
      return;
    }

    const items = DK.getItems();
    const existing = DK.findItemBySku(sku);
    const now = nowISO();

    if (existing) {
      const inQty = qty;
      const result = await DK.addLedgerEntry({
        item_id: existing.id,
        type: "IN",
        qty: inQty,
        unit_cost: unitCost,
        ref_type: "PURCHASE",
        ref_id: "",
        note: "掃碼入庫 " + (notes || ""),
      });
      if (!result.ok) {
        el("scanFormMsg").textContent = result.error || "入庫失敗";
        el("scanFormMsg").hidden = false;
        return;
      }
      const qtyNow = Number(DK.findItemById(existing.id)?.qty_on_hand) || (existing.qty_on_hand + inQty);
      const summary = isAdmin
        ? ("已入庫：SKU " + sku + "，+" + inQty + " 件，成本小計 " + ((inQty * (unitCost || 0)) ? "NT$ " + (inQty * (unitCost || 0)) : "0") + "。品項現有數量 " + qtyNow + "。")
        : ("已入庫：SKU " + sku + "，+" + inQty + " 件。品項現有數量 " + qtyNow + "。");
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
        el("scanFormMsg").textContent = (saved && saved.error) || "新增品項失敗";
        el("scanFormMsg").hidden = false;
        return;
      }
      const result = await DK.addLedgerEntry({
        item_id: newItem.id,
        type: "IN",
        qty,
        unit_cost: unitCost,
        ref_type: "PURCHASE",
        ref_id: "",
        note: "掃碼新增 " + (notes || ""),
      });
      if (!result.ok) {
        el("scanFormMsg").textContent = result.error || "寫入流水失敗";
        el("scanFormMsg").hidden = false;
        return;
      }
      const summaryNew = isAdmin
        ? ("已新增品項：SKU " + sku + "，" + name + "，數量 " + qty + "，成本小計 " + ((qty * (unitCost || 0)) ? "NT$ " + (qty * (unitCost || 0)) : "0") + "。")
        : ("已新增品項：SKU " + sku + "，" + name + "，數量 " + qty + "。");
      showSummary(summaryNew);
    }
  }

  // ---------- 事件綁定 ----------
  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    setStatus("辨識中…");
    decodeImageFile(file).then(function (decoded) {
      const rawCode = (decoded.qrText || decoded.barcodeText || "").trim().replace(/\s/g, " ");
      const modelText = decoded.qrText || "";
      if (!rawCode && !modelText) {
        setStatus("未辨識到條碼／QR，請重拍或手動新增。");
        return;
      }
      const suggestion = ruleEngine(rawCode, modelText);
      const skuSuggestion = suggestSKU(suggestion);
      fillForm(suggestion, rawCode || modelText, skuSuggestion);
      setStatus("已帶入建議，請確認後儲存。");
    });
  }

  function initScanAddTool() {
    el("scanCamera").addEventListener("change", function (e) {
      const file = e.target?.files?.[0];
      e.target.value = "";
      if (file) handleFile(file);
    });
    el("scanGallery").addEventListener("change", function (e) {
      const file = e.target?.files?.[0];
      e.target.value = "";
      if (file) handleFile(file);
    });
    el("scanSaveBtn").addEventListener("click", saveScanInbound);
    el("scanCancelBtn").addEventListener("click", showScanZone);
    el("scanAgainBtn").addEventListener("click", showScanZone);
    el("scanInboundDate").value = todayStr();
  }

  const gate = window.DK && window.DK.gateBackofficeToolPage;
  if (typeof gate !== "function") {
    location.replace("./admin.html");
    return;
  }
  gate({ roles: ["admin", "staff"] }).then(function (ok) {
    if (!ok) return;
    if (window.DK.revealBackofficeToolRoot) window.DK.revealBackofficeToolRoot("scanAddRoot");
    if (window.DK.getCurrentRole && window.DK.getCurrentRole() === "staff") {
      document.body.classList.add("dk-role-staff");
    }
    function start() {
      initScanAddTool();
    }
    if (typeof window.fetchV2DataFromSupabase === "function") {
      window.fetchV2DataFromSupabase().then(start).catch(start);
    } else start();
  });
})();
