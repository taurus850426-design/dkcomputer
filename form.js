/* form.js - 不知道怎麼選：需求表單，填完導向 LINE */

(function () {
  const form = document.getElementById("demandForm");
  if (!form) return;

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

    if (cfg?.line?.url) {
      await (DK.tryCopy?.(msg) ?? Promise.resolve(false));
      window.open(cfg.line.url, "_blank", "noreferrer");
    } else {
      const ok = await (DK.tryCopy?.(msg) ?? Promise.resolve(false));
      alert(ok ? "已複製需求內容，請貼到 LINE 傳給我們。\n\n（請到管理員後台設定 LINE 連結）" : "請到管理員後台設定 LINE 連結。");
    }
  });

  if (typeof DK !== "undefined" && DK.applyConfigToHomePage) {
    DK.applyConfigToHomePage();
  }
})();
