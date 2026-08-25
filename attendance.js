/**
 * Stage 11 員工打卡。
 * 讀 attendance_shifts / attendance_breaks / attendance_audit_logs（RLS）。
 * 寫入只走 RPC：clock_in/out、break_start/end、admin_correct。
 * 不直接 INSERT / UPDATE / DELETE attendance 表。不送 client timestamp。
 */
(function (global) {
  const TZ = "Asia/Taipei";
  const SHIFT_SELECT = "id,employee_id,clock_in_at,clock_out_at,status,source,created_at,updated_at";
  const BREAK_SELECT = "id,shift_id,employee_id,break_start_at,break_end_at,created_at";
  const AUDIT_SELECT = "id,actor_user_id,employee_id,shift_id,action,reason,created_at";

  const ACTION_LABEL = {
    CLOCK_IN: "上班打卡",
    CLOCK_OUT: "下班打卡",
    BREAK_START: "開始休息",
    BREAK_END: "結束休息",
    ADMIN_CORRECTION: "管理員更正",
  };

  let busy = false;
  let clockTimer = null;
  let myShifts = [];
  let myBreaks = [];
  let adminShifts = [];
  let adminBreaks = [];
  let profileMap = {};
  let lastFetchError = "";

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isAdmin() {
    return global.DK && global.DK.getCurrentRole && global.DK.getCurrentRole() === "admin";
  }

  function currentUser() {
    return (global.DK && global.DK.getCurrentAdminUser && global.DK.getCurrentAdminUser()) || null;
  }

  function showMsg(el, text, isError) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
    el.style.color = isError ? "var(--danger, #c00)" : "";
  }

  function taipeiParts(date) {
    const d = date instanceof Date ? date : new Date(date);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type) => {
      const p = parts.find((x) => x.type === type);
      return p ? p.value : "";
    };
    let hour = get("hour");
    if (hour === "24") hour = "00";
    return {
      ymd: get("year") + "-" + get("month") + "-" + get("day"),
      hms: hour + ":" + get("minute") + ":" + get("second"),
      hm: hour + ":" + get("minute"),
    };
  }

  function taipeiYmd(date) {
    return taipeiParts(date || new Date()).ymd;
  }

  function formatTaipeiDate(date) {
    const p = taipeiParts(date || new Date());
    return p.ymd.replace(/-/g, "/");
  }

  function formatTaipeiTime(date) {
    return taipeiParts(date || new Date()).hms;
  }

  function formatTaipeiDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const p = taipeiParts(d);
    return p.ymd.replace(/-/g, "/") + " " + p.hms;
  }

  function formatTaipeiClock(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return taipeiParts(d).hms;
  }

  function toDatetimeLocalValue(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = taipeiParts(d);
    return p.ymd + "T" + p.hm;
  }

  function datetimeLocalToIso(value) {
    const v = String(value || "").trim();
    if (!v) return null;
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const sec = m[3] || "00";
    const d = new Date(m[1] + "T" + m[2] + ":" + sec + "+08:00");
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function taipeiDayStartIso(ymd) {
    return datetimeLocalToIso(ymd + "T00:00");
  }

  function nextTaipeiDay(ymd) {
    const d = new Date(ymd + "T12:00:00+08:00");
    d.setUTCDate(d.getUTCDate() + 1);
    return taipeiYmd(d);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + " 小時 " + m + " 分";
    if (m > 0) return m + " 分 " + s + " 秒";
    return s + " 秒";
  }

  function shiftOverlapsDay(shift, ymd) {
    if (!shift || !shift.clock_in_at) return false;
    const startIso = taipeiDayStartIso(ymd);
    const endIso = taipeiDayStartIso(nextTaipeiDay(ymd));
    const cin = new Date(shift.clock_in_at).getTime();
    const cout = shift.clock_out_at ? new Date(shift.clock_out_at).getTime() : Date.now();
    const dayStart = new Date(startIso).getTime();
    const dayEnd = new Date(endIso).getTime();
    return cin < dayEnd && cout >= dayStart;
  }

  function completedBreakMs(breaks, nowMs) {
    let ms = 0;
    (breaks || []).forEach(function (b) {
      if (!b || !b.break_start_at) return;
      const start = new Date(b.break_start_at).getTime();
      if (b.break_end_at) {
        const end = new Date(b.break_end_at).getTime();
        if (end > start) ms += end - start;
        return;
      }
      const now = nowMs != null ? nowMs : Date.now();
      if (now > start) ms += now - start;
    });
    return ms;
  }

  function workedMsForShift(shift, breaks, nowMs) {
    if (!shift || !shift.clock_in_at) return 0;
    const start = new Date(shift.clock_in_at).getTime();
    const end = shift.clock_out_at ? new Date(shift.clock_out_at).getTime() : (nowMs != null ? nowMs : Date.now());
    const raw = end - start;
    const br = completedBreakMs(breaks || [], nowMs);
    return Math.max(0, raw - br);
  }

  function openShiftOf(shifts) {
    return (shifts || []).find(function (s) {
      return s && s.clock_out_at == null && s.status === "open";
    }) || (shifts || []).find(function (s) {
      return s && s.clock_out_at == null;
    }) || null;
  }

  function openBreakOf(breaks) {
    return (breaks || []).find(function (b) {
      return b && b.break_end_at == null;
    }) || null;
  }

  function personName(id) {
    if (!id) return "—";
    const me = currentUser();
    if (me && String(me.userId) === String(id)) return me.displayName || me.username || "我";
    const p = profileMap[String(id)];
    if (p) return p.displayName || p.username || String(id).slice(0, 8);
    return String(id).slice(0, 8);
  }

  function statusLabel(shift, breaks) {
    if (!shift) return "未打卡";
    if (openBreakOf(breaks)) return "休息中";
    if (shift.clock_out_at == null) return "上班中";
    return "已下班";
  }

  function mapRpcError(err) {
    const raw = String(
      (err && (err.message || err.error || err.details || err.hint)) || err || ""
    );
    const m = raw.toLowerCase();
    if (/open shift already exists/.test(m)) return "已經有進行中的班次，無法再次上班打卡。";
    if (/no open shift/.test(m)) return "目前沒有進行中的班次。";
    if (/open break already exists/.test(m)) return "已經在休息中。";
    if (/open break exists/.test(m)) return "請先結束休息，才能下班打卡。";
    if (/no open break/.test(m)) return "目前沒有進行中的休息。";
    if (/reason required/.test(m)) return "修改理由必填。";
    if (/admin only/.test(m)) return "只有管理員可以更正出勤。";
    if (/permission denied/.test(m) || /42501/.test(m)) return "沒有權限執行此操作。";
    if (/employee mismatch/.test(m)) return "不能更改班次所屬員工。";
    if (/nothing to correct/.test(m)) return "沒有可更正的內容。";
    if (/invalid clock range/.test(m)) return "下班時間不可早於上班時間。";
    if (/invalid break range/.test(m)) return "休息結束時間不可早於開始時間。";
    if (/shift not found/.test(m)) return "找不到該班次。";
    if (/break not found/.test(m)) return "找不到該休息紀錄。";
    if (/not authenticated|請先登入/.test(m)) return "請先登入後台。";
    return raw.slice(0, 180) || "操作失敗";
  }

  async function getClient() {
    if (!global.DK || typeof global.DK.getSupabaseAuthClient !== "function") {
      throw new Error("Supabase 尚未就緒");
    }
    const client = await global.DK.getSupabaseAuthClient();
    if (!client) throw new Error("Supabase 未設定");
    return client;
  }

  function gateBackoffice() {
    if (global.DK && typeof global.DK.requireVerifiedBackofficeCloudAccess === "function") {
      const gate = global.DK.requireVerifiedBackofficeCloudAccess();
      if (!gate || gate.ok !== true) {
        throw new Error((gate && gate.error) || "請先登入後台");
      }
    }
  }

  async function rpcCall(name, args) {
    gateBackoffice();
    const client = await getClient();
    if (args && typeof args === "object") {
      const res = await client.rpc(name, args);
      if (res && res.error) throw res.error;
      return res ? res.data : null;
    }
    const res = await client.rpc(name);
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  async function fetchRows(table, build) {
    const client = await getClient();
    let q = client.from(table).select(build.select);
    if (typeof build.apply === "function") q = build.apply(q);
    const res = await q;
    if (res && res.error) throw res.error;
    return Array.isArray(res.data) ? res.data : [];
  }

  async function loadProfilesIfAdmin() {
    profileMap = {};
    const me = currentUser();
    if (me && me.userId) {
      profileMap[String(me.userId)] = {
        id: me.userId,
        username: me.username,
        displayName: me.displayName || me.username,
      };
    }
    if (!isAdmin()) return;
    try {
      const rows = await fetchRows("profiles", {
        select: "id,username,display_name,role,enabled",
        apply: function (q) {
          return q.order("display_name", { ascending: true });
        },
      });
      rows.forEach(function (r) {
        if (!r || !r.id) return;
        profileMap[String(r.id)] = {
          id: r.id,
          username: r.username,
          displayName: r.display_name || r.username || "",
          role: r.role,
          enabled: r.enabled === true,
        };
      });
    } catch (_) {}
    try {
      const users = global.DK && global.DK.getAdminUsers ? global.DK.getAdminUsers() : [];
      (users || []).forEach(function (u) {
        if (!u || !u.id) return;
        const id = String(u.id);
        if (profileMap[id] && profileMap[id].displayName) return;
        profileMap[id] = {
          id: id,
          username: u.username,
          displayName: u.displayName || u.username || "",
          role: u.role,
          enabled: u.enabled !== false,
        };
      });
    } catch (_) {}
  }

  async function fetchMyAttendance() {
    const me = currentUser();
    if (!me || !me.userId) throw new Error("請先登入後台");
    const myId = String(me.userId);
    const today = taipeiYmd(new Date());
    const fromIso = taipeiDayStartIso(taipeiYmd(new Date(Date.now() - 36 * 3600 * 1000)));
    const rows = await fetchRows("attendance_shifts", {
      select: SHIFT_SELECT,
      apply: function (q) {
        return q.eq("employee_id", myId).gte("clock_in_at", fromIso).order("clock_in_at", { ascending: false }).limit(40);
      },
    });
    const openRows = await fetchRows("attendance_shifts", {
      select: SHIFT_SELECT,
      apply: function (q) {
        return q.eq("employee_id", myId).is("clock_out_at", null).order("clock_in_at", { ascending: false }).limit(5);
      },
    });
    const byId = {};
    rows.concat(openRows).forEach(function (s) {
      if (s && s.id) byId[s.id] = s;
    });
    myShifts = Object.keys(byId).map(function (k) { return byId[k]; });
    const ids = myShifts.map(function (s) { return s.id; });
    if (!ids.length) {
      myBreaks = [];
      return;
    }
    myBreaks = await fetchRows("attendance_breaks", {
      select: BREAK_SELECT,
      apply: function (q) {
        return q.eq("employee_id", myId).in("shift_id", ids).order("break_start_at", { ascending: true }).limit(200);
      },
    });
    void today;
  }

  async function fetchAdminAttendance() {
    if (!isAdmin()) {
      adminShifts = [];
      adminBreaks = [];
      return;
    }
    const dateEl = $("attAdminDate");
    const empEl = $("attAdminEmployee");
    const ymd = (dateEl && dateEl.value) || taipeiYmd(new Date());
    const empId = empEl && empEl.value ? String(empEl.value) : "";
    const startIso = taipeiDayStartIso(ymd);
    const endIso = taipeiDayStartIso(nextTaipeiDay(ymd));
    const inDay = await fetchRows("attendance_shifts", {
      select: SHIFT_SELECT,
      apply: function (q) {
        q = q.gte("clock_in_at", startIso).lt("clock_in_at", endIso).order("clock_in_at", { ascending: true }).limit(300);
        if (empId) q = q.eq("employee_id", empId);
        return q;
      },
    });
    const openRows = await fetchRows("attendance_shifts", {
      select: SHIFT_SELECT,
      apply: function (q) {
        q = q.is("clock_out_at", null).lt("clock_in_at", endIso).order("clock_in_at", { ascending: true }).limit(100);
        if (empId) q = q.eq("employee_id", empId);
        return q;
      },
    });
    const byId = {};
    inDay.concat(openRows).forEach(function (s) {
      if (s && s.id) byId[s.id] = s;
    });
    adminShifts = Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (s) {
      return shiftOverlapsDay(s, ymd);
    }).sort(function (a, b) {
      return new Date(a.clock_in_at) - new Date(b.clock_in_at);
    });
    const ids = adminShifts.map(function (s) { return s.id; });
    if (!ids.length) {
      adminBreaks = [];
      return;
    }
    adminBreaks = await fetchRows("attendance_breaks", {
      select: BREAK_SELECT,
      apply: function (q) {
        return q.in("shift_id", ids).order("break_start_at", { ascending: true }).limit(500);
      },
    });
  }

  async function fetchAdminAudit() {
    if (!isAdmin()) return [];
    return fetchRows("attendance_audit_logs", {
      select: AUDIT_SELECT,
      apply: function (q) {
        return q.order("created_at", { ascending: false }).limit(80);
      },
    });
  }

  function todayShifts() {
    const ymd = taipeiYmd(new Date());
    return myShifts.filter(function (s) { return shiftOverlapsDay(s, ymd); });
  }

  function breaksForShift(shiftId, source) {
    return (source || myBreaks).filter(function (b) {
      return b && String(b.shift_id) === String(shiftId);
    });
  }

  function primaryTodayShift() {
    const open = openShiftOf(myShifts);
    if (open) return open;
    const today = todayShifts().slice().sort(function (a, b) {
      return new Date(b.clock_in_at) - new Date(a.clock_in_at);
    });
    return today[0] || null;
  }

  function setButtons(state) {
    const clockIn = $("attBtnClockIn");
    const brStart = $("attBtnBreakStart");
    const brEnd = $("attBtnBreakEnd");
    const clockOut = $("attBtnClockOut");
    const disableAll = busy;
    if (clockIn) clockIn.disabled = disableAll || !state.canClockIn;
    if (brStart) brStart.disabled = disableAll || !state.canBreakStart;
    if (brEnd) brEnd.disabled = disableAll || !state.canBreakEnd;
    if (clockOut) clockOut.disabled = disableAll || !state.canClockOut;
  }

  function renderClockFace() {
    const me = currentUser();
    if ($("attTodayDate")) $("attTodayDate").textContent = formatTaipeiDate(new Date());
    if ($("attNowTime")) $("attNowTime").textContent = formatTaipeiTime(new Date());
    if ($("attUserName")) $("attUserName").textContent = me ? (me.displayName || me.username || "—") : "—";

    const shift = primaryTodayShift();
    const shiftBreaks = shift ? breaksForShift(shift.id, myBreaks) : [];
    const open = openShiftOf(myShifts);
    const openBr = openBreakOf(open ? breaksForShift(open.id, myBreaks) : myBreaks);
    const nowMs = Date.now();

    if ($("attClockIn")) $("attClockIn").textContent = shift ? formatTaipeiClock(shift.clock_in_at) : "—";
    if ($("attClockOut")) $("attClockOut").textContent = shift && shift.clock_out_at ? formatTaipeiClock(shift.clock_out_at) : (open ? "尚未下班" : "—");
    if ($("attStatus")) $("attStatus").textContent = statusLabel(open || shift, open ? breaksForShift(open.id, myBreaks) : shiftBreaks);

    const ymd = taipeiYmd(new Date());
    let workMs = 0;
    todayShifts().forEach(function (s) {
      workMs += workedMsForShift(s, breaksForShift(s.id, myBreaks), nowMs);
    });
    if (open && !shiftOverlapsDay(open, ymd)) {
      workMs += workedMsForShift(open, breaksForShift(open.id, myBreaks), nowMs);
    }
    if ($("attWorked")) $("attWorked").textContent = (open || shift) ? formatDuration(workMs) : "—";

    const tbody = $("attBreakTbody");
    if (tbody) {
      const list = [];
      todayShifts().concat(open && !todayShifts().some(function (s) { return s.id === open.id; }) ? [open] : []).forEach(function (s) {
        breaksForShift(s.id, myBreaks).forEach(function (b) { list.push(b); });
      });
      const uniq = [];
      const seen = {};
      list.forEach(function (b) {
        if (!b || seen[b.id]) return;
        seen[b.id] = true;
        uniq.push(b);
      });
      uniq.sort(function (a, b) {
        return new Date(a.break_start_at) - new Date(b.break_start_at);
      });
      if (!uniq.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="muted">尚無休息紀錄</td></tr>';
      } else {
        tbody.innerHTML = uniq.map(function (b) {
          const end = b.break_end_at ? formatTaipeiClock(b.break_end_at) : "進行中";
          const dur = formatDuration(completedBreakMs([b], nowMs));
          return "<tr><td>" + esc(formatTaipeiClock(b.break_start_at)) + "</td><td>" + esc(end) + "</td><td>" + esc(dur) + "</td></tr>";
        }).join("");
      }
    }

    setButtons({
      canClockIn: !open,
      canBreakStart: !!(open && !openBr),
      canBreakEnd: !!(open && openBr),
      canClockOut: !!(open && !openBr),
    });
  }

  function fillEmployeeSelect() {
    const sel = $("attAdminEmployee");
    if (!sel || !isAdmin()) return;
    const keep = sel.value;
    const opts = ['<option value="">全部員工</option>'];
    Object.keys(profileMap).sort(function (a, b) {
      return String(personName(a)).localeCompare(String(personName(b)), "zh-Hant");
    }).forEach(function (id) {
      const p = profileMap[id];
      if (p && p.enabled === false) return;
      opts.push('<option value="' + esc(id) + '">' + esc(personName(id)) + "</option>");
    });
    sel.innerHTML = opts.join("");
    if (keep && profileMap[keep]) sel.value = keep;
  }

  function renderAdminTable() {
    const tbody = $("attAdminTbody");
    if (!tbody || !isAdmin()) return;
    if (!adminShifts.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">尚無資料</td></tr>';
      return;
    }
    tbody.innerHTML = adminShifts.map(function (s) {
      const br = breaksForShift(s.id, adminBreaks);
      const work = formatDuration(workedMsForShift(s, br, Date.now()));
      const rest = formatDuration(completedBreakMs(br, Date.now()));
      const st = statusLabel(s, br);
      return (
        "<tr>" +
        "<td>" + esc(personName(s.employee_id)) + "</td>" +
        "<td class=\"nowrap\">" + esc(taipeiYmd(s.clock_in_at).replace(/-/g, "/")) + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTaipeiDateTime(s.clock_in_at)) + "</td>" +
        "<td class=\"nowrap\">" + esc(s.clock_out_at ? formatTaipeiDateTime(s.clock_out_at) : "尚未下班") + "</td>" +
        "<td>" + esc(rest) + "</td>" +
        "<td>" + esc(work) + "</td>" +
        "<td>" + esc(st) + "</td>" +
        "<td style=\"text-align:right\"><button type=\"button\" class=\"btn btn-ghost btn-sm att-correct-btn\" data-shift=\"" + esc(s.id) + "\">更正</button></td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAudit(rows) {
    const tbody = $("attAuditTbody");
    if (!tbody || !isAdmin()) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">尚無稽核紀錄</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return (
        "<tr>" +
        "<td class=\"nowrap\">" + esc(formatTaipeiDateTime(r.created_at)) + "</td>" +
        "<td>" + esc(personName(r.actor_user_id)) + "</td>" +
        "<td>" + esc(personName(r.employee_id)) + "</td>" +
        "<td>" + esc(ACTION_LABEL[r.action] || r.action || "") + "</td>" +
        "<td>" + esc(r.reason || "—") + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function openCorrectForm(shiftId) {
    if (!isAdmin()) return;
    const shift = adminShifts.concat(myShifts).find(function (s) { return s && s.id === shiftId; });
    if (!shift) {
      showMsg($("attCorrectMsg"), "找不到該班次。", true);
      return;
    }
    const card = $("attCorrectCard");
    if (card) card.hidden = false;
    $("attCorrectShiftId").value = shift.id;
    $("attCorrectEmployeeLabel").textContent = personName(shift.employee_id);
    $("attCorrectClockIn").value = toDatetimeLocalValue(shift.clock_in_at);
    $("attCorrectClockOut").value = toDatetimeLocalValue(shift.clock_out_at);
    $("attCorrectReason").value = "";
    const brSel = $("attCorrectBreakId");
    const brs = breaksForShift(shift.id, adminBreaks.length ? adminBreaks : myBreaks);
    brSel.innerHTML = '<option value="">不更正休息</option>' + brs.map(function (b) {
      const label = formatTaipeiClock(b.break_start_at) + " → " + (b.break_end_at ? formatTaipeiClock(b.break_end_at) : "進行中");
      return '<option value="' + esc(b.id) + '">' + esc(label) + "</option>";
    }).join("");
    $("attCorrectBreakStart").value = "";
    $("attCorrectBreakEnd").value = "";
    showMsg($("attCorrectMsg"), "", false);
  }

  function fillBreakTimesFromSelect() {
    const id = $("attCorrectBreakId") && $("attCorrectBreakId").value;
    if (!id) {
      $("attCorrectBreakStart").value = "";
      $("attCorrectBreakEnd").value = "";
      return;
    }
    const b = (adminBreaks.concat(myBreaks)).find(function (x) { return x && x.id === id; });
    if (!b) return;
    $("attCorrectBreakStart").value = toDatetimeLocalValue(b.break_start_at);
    $("attCorrectBreakEnd").value = toDatetimeLocalValue(b.break_end_at);
  }

  async function refreshAll(opts) {
    const silent = !!(opts && opts.silent);
    lastFetchError = "";
    try {
      gateBackoffice();
      await loadProfilesIfAdmin();
      fillEmployeeSelect();
      await fetchMyAttendance();
      if (isAdmin()) {
        await fetchAdminAttendance();
        const audit = await fetchAdminAudit();
        renderAdminTable();
        renderAudit(audit);
      } else {
        adminShifts = [];
        adminBreaks = [];
        if ($("attAdminManage")) $("attAdminManage").hidden = true;
        if ($("attAdminAudit")) $("attAdminAudit").hidden = true;
      }
      renderClockFace();
      if (!silent) showMsg($("attMsg"), "", false);
    } catch (e) {
      lastFetchError = mapRpcError(e);
      renderClockFace();
      if (!silent) showMsg($("attMsg"), lastFetchError, true);
    }
  }

  async function runAction(fnName, successText) {
    if (busy) return;
    busy = true;
    setButtons({ canClockIn: false, canBreakStart: false, canBreakEnd: false, canClockOut: false });
    showMsg($("attMsg"), "處理中…", false);
    try {
      await rpcCall(fnName);
      await refreshAll({ silent: true });
      showMsg($("attMsg"), successText, false);
    } catch (e) {
      showMsg($("attMsg"), mapRpcError(e), true);
      renderClockFace();
    } finally {
      busy = false;
      renderClockFace();
    }
  }

  async function submitCorrection() {
    if (!isAdmin()) {
      showMsg($("attCorrectMsg"), "只有管理員可以更正出勤。", true);
      return;
    }
    if (busy) return;
    const shiftId = String(($("attCorrectShiftId") && $("attCorrectShiftId").value) || "").trim();
    const reason = String(($("attCorrectReason") && $("attCorrectReason").value) || "").trim();
    if (!shiftId) {
      showMsg($("attCorrectMsg"), "請先選擇要更正的班次。", true);
      return;
    }
    if (!reason) {
      showMsg($("attCorrectMsg"), "修改理由必填。", true);
      return;
    }
    const payload = { p_shift_id: shiftId, p_reason: reason };
    const cin = datetimeLocalToIso($("attCorrectClockIn") && $("attCorrectClockIn").value);
    const cout = datetimeLocalToIso($("attCorrectClockOut") && $("attCorrectClockOut").value);
    if (cin) payload.p_clock_in_at = cin;
    if (cout) payload.p_clock_out_at = cout;
    const breakId = String(($("attCorrectBreakId") && $("attCorrectBreakId").value) || "").trim();
    if (breakId) {
      payload.p_break_id = breakId;
      const bStart = datetimeLocalToIso($("attCorrectBreakStart") && $("attCorrectBreakStart").value);
      const bEnd = datetimeLocalToIso($("attCorrectBreakEnd") && $("attCorrectBreakEnd").value);
      if (bStart) payload.p_break_start_at = bStart;
      if (bEnd) payload.p_break_end_at = bEnd;
    }
    if (!payload.p_clock_in_at && !payload.p_clock_out_at && !payload.p_break_id) {
      showMsg($("attCorrectMsg"), "請至少修改上班、下班或一筆休息時間。", true);
      return;
    }
    busy = true;
    showMsg($("attCorrectMsg"), "處理中…", false);
    try {
      await rpcCall("attendance_admin_correct", payload);
      await refreshAll({ silent: true });
      showMsg($("attCorrectMsg"), "已更正並重新載入伺服器資料。", false);
      showMsg($("attMsg"), "出勤更正成功。", false);
    } catch (e) {
      showMsg($("attCorrectMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
      renderClockFace();
    }
  }

  function bind() {
    const cin = $("attBtnClockIn");
    const bs = $("attBtnBreakStart");
    const be = $("attBtnBreakEnd");
    const cout = $("attBtnClockOut");
    if (cin) cin.addEventListener("click", function () { runAction("attendance_clock_in", "上班打卡成功。"); });
    if (bs) bs.addEventListener("click", function () { runAction("attendance_break_start", "已開始休息。"); });
    if (be) be.addEventListener("click", function () { runAction("attendance_break_end", "已結束休息。"); });
    if (cout) cout.addEventListener("click", function () { runAction("attendance_clock_out", "下班打卡成功。"); });
    const refresh = $("attAdminRefresh");
    if (refresh) refresh.addEventListener("click", function () { refreshAll(); });
    const dateEl = $("attAdminDate");
    if (dateEl) dateEl.addEventListener("change", function () { if (isAdmin()) refreshAll(); });
    const empEl = $("attAdminEmployee");
    if (empEl) empEl.addEventListener("change", function () { if (isAdmin()) refreshAll(); });
    const adminTable = $("attAdminTbody");
    if (adminTable) {
      adminTable.addEventListener("click", function (ev) {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".att-correct-btn") : null;
        if (!btn) return;
        openCorrectForm(btn.getAttribute("data-shift"));
      });
    }
    const brSel = $("attCorrectBreakId");
    if (brSel) brSel.addEventListener("change", fillBreakTimesFromSelect);
    const sub = $("attCorrectSubmit");
    if (sub) sub.addEventListener("click", function () { submitCorrection(); });
    const cancel = $("attCorrectCancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        const card = $("attCorrectCard");
        if (card) card.hidden = true;
        showMsg($("attCorrectMsg"), "", false);
      });
    }
  }

  function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(function () {
      if (!$("tab-attendance") || $("tab-attendance").hidden) return;
      renderClockFace();
    }, 1000);
  }

  async function onShow() {
    if ($("attAdminDate") && !$("attAdminDate").value) $("attAdminDate").value = taipeiYmd(new Date());
    const admin = isAdmin();
    if ($("attAdminManage")) $("attAdminManage").hidden = !admin;
    if ($("attAdminAudit")) $("attAdminAudit").hidden = !admin;
    startClock();
    renderClockFace();
    await refreshAll();
  }

  bind();
  startClock();
  global.__dkAttendanceOnShow = onShow;
})(window);
