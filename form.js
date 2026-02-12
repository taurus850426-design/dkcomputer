/* form.js - 不知道怎麼選：需求表單，填完導向 LINE */

(function () {
  const form = document.getElementById("demandForm");
  if (!form) return;

  const oldPcSpecBlock = document.getElementById("oldPcSpecBlock");
  const oldPCRadios = form.querySelectorAll('input[name="oldPC"]');

  function toggleOldPcSpec() {
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

    const parts = ["【需求表單】"];
    if (usage) parts.push(`用途：${usage}`);
    if (budget) parts.push(`預算：${budget}`);
    if (used) parts.push(`接受二手：${used}`);
    if (oldPC) parts.push(`有舊電腦：${oldPC}`);
    if (oldPC === "有") {
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
})();
