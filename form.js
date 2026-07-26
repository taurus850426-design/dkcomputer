/* form.js - 不知道怎麼選：需求表單，填完導向 LINE；?type=repair 為維修模式 */

(function () {
  const params = new URLSearchParams(window.location.search);
  const isRepairMode = params.get("type") === "repair";

  const form = document.getElementById("demandForm");
  if (!form) return;

  /* 維修模式：切換頁面文案、欄位標籤、選項、按鈕、title */
  if (isRepairMode) {
    document.title = "電腦維修｜檢測表單｜DK電腦";
    const formPageTitle = document.getElementById("formPageTitle");
    if (formPageTitle) formPageTitle.textContent = "電腦壞了？先幫你檢測";
    const formPageLead = document.getElementById("formPageLead");
    if (formPageLead) formPageLead.textContent = "填完表單後會自動複製維修需求並開啟 LINE，請在對話框貼上後傳送給我們。";
    const usageLabel = document.getElementById("usageLabel");
    if (usageLabel) usageLabel.innerHTML = "問題類型 <span class=\"required\">*</span>";
    const budgetLabel = document.getElementById("budgetLabel");
    if (budgetLabel) budgetLabel.innerHTML = "送修方式 <span class=\"required\">*</span>";
    const usageSelect = document.getElementById("usage");
    if (usageSelect) {
      usageSelect.innerHTML = "";
      [
        { v: "", t: "請選擇" },
        { v: "無法開機", t: "無法開機" },
        { v: "藍屏 / 當機", t: "藍屏 / 當機" },
        { v: "畫面異常", t: "畫面異常" },
        { v: "溫度過高 / 風扇很吵", t: "溫度過高 / 風扇很吵" },
        { v: "不確定，想先檢測", t: "不確定，想先檢測" },
      ].forEach(function (o) {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.t;
        usageSelect.appendChild(opt);
      });
    }
    const budgetSelect = document.getElementById("budget");
    if (budgetSelect) {
      budgetSelect.innerHTML = "";
      [
        { v: "", t: "請選擇" },
        { v: "到店檢測", t: "到店檢測" },
        { v: "LINE 先詢問", t: "LINE 先詢問" },
        { v: "寄送檢測", t: "寄送檢測" },
      ].forEach(function (o) {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.t;
        budgetSelect.appendChild(opt);
      });
    }
    const noteEl = document.getElementById("note");
    if (noteEl) noteEl.placeholder = "例如：無法開機、開機會黑屏、最近有摔到、進水、風扇很大聲…";
    const formSubmitBtn = document.getElementById("formSubmitBtn");
    if (formSubmitBtn) formSubmitBtn.textContent = "複製維修需求並開啟 LINE（請在對話框貼上後傳送）";
    var usedLabel = document.getElementById("usedLabel");
    if (usedLabel) usedLabel.textContent = "是否可正常開機";
    var usedRadios = form.querySelectorAll('input[name="used"]');
    if (usedRadios[0]) { usedRadios[0].value = "可以"; var s = usedRadios[0].closest("label").querySelector("span"); if (s) s.textContent = "可以"; }
    if (usedRadios[1]) { usedRadios[1].value = "不行"; var s2 = usedRadios[1].closest("label").querySelector("span"); if (s2) s2.textContent = "不行"; }
    var oldPCLabel = document.getElementById("oldPCLabel");
    if (oldPCLabel) oldPCLabel.textContent = "是否有摔到 / 進水";
  }

  const oldPcSpecBlock = document.getElementById("oldPcSpecBlock");
  const oldPCRadios = form.querySelectorAll('input[name="oldPC"]');

  function toggleOldPcSpec() {
    if (isRepairMode && oldPcSpecBlock) { oldPcSpecBlock.hidden = true; return; }
    const hasOld = document.querySelector('input[name="oldPC"]:checked')?.value === "有";
    if (oldPcSpecBlock) oldPcSpecBlock.hidden = !hasOld;
  }

  oldPCRadios.forEach(function (radio) {
    radio.addEventListener("change", toggleOldPcSpec);
  });
  toggleOldPcSpec();

  function buildLineMessage() {
    const usage = document.getElementById("usage")?.value || "";
    const budget = document.getElementById("budget")?.value || "";
    const used = document.querySelector('input[name="used"]:checked')?.value || "";
    const oldPC = document.querySelector('input[name="oldPC"]:checked')?.value || "";
    const lineId = document.getElementById("lineId")?.value?.trim() || "";
    const note = document.getElementById("note")?.value?.trim() || "";

    const parts = isRepairMode ? ["【維修需求】"] : ["【需求表單】"];
    const usageLabelText = isRepairMode ? "問題類型" : "用途";
    const budgetLabelText = isRepairMode ? "送修方式" : "預算";
    if (usage) parts.push(usageLabelText + "：" + usage);
    if (budget) parts.push(budgetLabelText + "：" + budget);
    var usedLabelText = isRepairMode ? "是否可正常開機" : "接受二手";
    var oldPCLabelText = isRepairMode ? "是否有摔到 / 進水" : "有舊電腦";
    if (used) parts.push(usedLabelText + "：" + used);
    if (oldPC) parts.push(oldPCLabelText + "：" + oldPC);
    if (!isRepairMode && oldPC === "有") {
      const cpu = document.getElementById("specCpu")?.value?.trim() || "";
      const ram = document.getElementById("specRam")?.value?.trim() || "";
      const gpu = document.getElementById("specGpu")?.value?.trim() || "";
      const storage = document.getElementById("specStorage")?.value?.trim() || "";
      const other = document.getElementById("specOther")?.value?.trim() || "";
      if (cpu || ram || gpu || storage || other) {
        parts.push("【現有配備】");
        if (cpu) parts.push(`CPU：${cpu}`);
        if (ram) parts.push(`記憶體：${ram}`);
        if (gpu) parts.push(`顯卡：${gpu}`);
        if (storage) parts.push(`硬碟／SSD：${storage}`);
        if (other) parts.push(`其他：${other}`);
      }
    }
    if (lineId) parts.push(`LINE ID：${lineId}`);
    if (note) parts.push(`備註：${note}`);

    return parts.join("\n");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const lineId = document.getElementById("lineId")?.value?.trim();
    if (!lineId) {
      alert("請填寫 LINE ID。");
      return;
    }

    const msg = buildLineMessage();
    const cfg = DK.getConfig ? DK.getConfig() : {};
    const ok = await (DK.tryCopy?.(msg) ?? Promise.resolve(false));

    // 僅在驗證通過並完成送出流程後追蹤；不傳送表單內容或個資
    try {
      if (typeof window.trackGAEvent === "function") {
        window.trackGAEvent("generate_lead", {
          lead_source: "website_form",
          form_type: isRepairMode ? "repair" : "demand",
          page_path: String(location.pathname || ""),
        });
      }
    } catch (_) {}

    if (cfg?.line?.url) {
      window.open(cfg.line.url, "_blank", "noreferrer");
      if (ok) {
        alert("已複製你的需求內容！\n\n請到剛開啟的 LINE 對話框貼上（電腦：Ctrl+V／手機：長按→貼上）後傳送給我們。");
      } else {
        alert("已為你開啟 LINE。請手動輸入或貼上你的需求內容後傳送。");
      }
    } else {
      alert(ok ? "已複製需求內容，請貼到 LINE 傳給我們。\n\n（請到管理員後台設定 LINE 連結）" : "請到管理員後台設定 LINE 連結。");
    }
  });

  if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
    DK.applyConfigToHomePage();
  }
  if (isRepairMode) {
    var footerLineSentence = document.getElementById("footerLineSentence");
    if (footerLineSentence) footerLineSentence.textContent = "填完後我們會先看你的狀況，再由 LINE 跟你確認檢測或送修方式。";
  }
})();
