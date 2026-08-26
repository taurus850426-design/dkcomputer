/**
 * Stage 11 / 11-5 員工打卡。
 * 讀 attendance_shifts / attendance_breaks / attendance_audit_logs / attendance_settings（RLS）。
 * GPS：authenticated RPC（p_latitude/p_longitude/p_accuracy）。
 * 公司網路：Edge 取 server-side Public IP，再以 service_role 呼叫 *_company_network。
 * 不直接 INSERT/UPDATE/DELETE attendance 表；不送 client IP／timestamp；不背景追蹤 GPS。
 */
(function (global) {
  const TZ = "Asia/Taipei";
  const SHIFT_SELECT = "id,employee_id,clock_in_at,clock_out_at,status,source,created_at,updated_at";
  const BREAK_SELECT = "id,shift_id,employee_id,break_start_at,break_end_at,created_at";
  const AUDIT_SELECT = "id,actor_user_id,employee_id,shift_id,action,reason,created_at";
  const SETTINGS_SELECT =
    "id,location_enabled,latitude,longitude,radius_meters,max_accuracy_meters,network_enabled,allowed_public_ips,updated_at";
  const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

  const ACTION_LABEL = {
    CLOCK_IN: "上班打卡",
    CLOCK_OUT: "下班打卡",
    BREAK_START: "開始休息",
    BREAK_END: "結束休息",
    ADMIN_CORRECTION: "管理員更正",
    ADMIN_DELETE: "管理員刪除",
    ADMIN_NETWORK_SETTINGS: "網路設定變更",
  };

  const GPS_RPC_TO_PUNCH = {
    attendance_clock_in: "clock_in",
    attendance_clock_out: "clock_out",
    attendance_break_start: "break_start",
    attendance_break_end: "break_end",
  };

  let busy = false;
  let clockTimer = null;
  let myShifts = [];
  let myBreaks = [];
  let adminShifts = [];
  let adminBreaks = [];
  let adminAuditRows = [];
  let profileMap = {};
  let locationSettings = null;
  let lastFetchError = "";
  let lastReportHtml = "";
  let pendingGpsPreview = null;

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

  function setLocStatus(text, kind) {
    const el = $("attLocStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "att-loc-status muted";
    if (kind === "ok") el.className = "att-loc-status att-loc-ok";
    if (kind === "err") el.className = "att-loc-status att-loc-err";
    if (kind === "busy") el.className = "att-loc-status att-loc-busy";
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
      weekday: "short",
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
    return taipeiParts(date || new Date()).ymd.replace(/-/g, "/");
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

  function weekdayZh(ymd) {
    const d = new Date(ymd + "T12:00:00+08:00");
    return WEEKDAY_ZH[d.getUTCDay()] || "";
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

  function formatDurationHours(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    return (ms / 3600000).toFixed(2) + " 小時";
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

  function completedBreakMs(breaks, nowMs, onlyCompleted) {
    let ms = 0;
    (breaks || []).forEach(function (b) {
      if (!b || !b.break_start_at) return;
      const start = new Date(b.break_start_at).getTime();
      if (b.break_end_at) {
        const end = new Date(b.break_end_at).getTime();
        if (end > start) ms += end - start;
        return;
      }
      if (onlyCompleted) return;
      const now = nowMs != null ? nowMs : Date.now();
      if (now > start) ms += now - start;
    });
    return ms;
  }

  function workedMsForShift(shift, breaks, nowMs, onlyCompletedBreaks) {
    if (!shift || !shift.clock_in_at) return 0;
    const start = new Date(shift.clock_in_at).getTime();
    const end = shift.clock_out_at ? new Date(shift.clock_out_at).getTime() : (nowMs != null ? nowMs : Date.now());
    const raw = end - start;
    const br = completedBreakMs(breaks || [], nowMs, !!onlyCompletedBreaks);
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

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const toRad = function (d) { return (d * Math.PI) / 180; };
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.asin(Math.sqrt(a));
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
    if (/admin only/.test(m)) return "只有管理員可以執行此操作。";
    if (/permission denied/.test(m) || /42501/.test(m)) return "沒有權限執行此操作。";
    if (/employee mismatch/.test(m)) return "不能更改班次所屬員工。";
    if (/nothing to correct/.test(m)) return "沒有可更正的內容。";
    if (/invalid clock range/.test(m)) return "下班時間不可早於上班時間。";
    if (/invalid break range/.test(m)) return "休息結束時間不可早於開始時間。";
    if (/shift not found/.test(m)) return "找不到該班次。";
    if (/break not found/.test(m)) return "找不到該休息紀錄。";
    if (/location not configured/.test(m)) return "公司尚未設定打卡位置，請先請管理員設定。";
    if (/location required/.test(m)) return "打卡需要提供定位資訊。";
    if (/accuracy too poor/.test(m)) return "定位精度不足，請到室外或訊號較佳處重試。";
    if (/outside company range/.test(m)) return "超出公司允許範圍，無法打卡。";
    if (/invalid location/.test(m)) return "定位資料無效。";
    if (/invalid radius|invalid max accuracy|enabled required/.test(m)) return "地點設定參數無效。";
    if (/not authenticated|請先登入/.test(m)) return "請先登入後台。";
    if (/could not find the function|pgrst202|404/.test(m)) return "打卡功能尚未就緒，請稍後再試或通知管理員。";
    return raw.slice(0, 180) || "操作失敗";
  }

  function mapGeoError(err) {
    if (!err) return "無法取得位置。";
    const code = err.code;
    if (code === 1) return "未允許定位權限，無法打卡。";
    if (code === 2) return "無法取得位置，請確認 GPS／定位服務已開啟。";
    if (code === 3) return "定位逾時，請到訊號較佳處重試。";
    return mapRpcError(err.message || err) || "無法取得位置。";
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

  async function callAttendanceNetworkEdge(payload) {
    gateBackoffice();
    const base =
      global.DK && typeof global.DK.getSupabaseProjectUrl === "function"
        ? global.DK.getSupabaseProjectUrl()
        : "";
    const anon =
      global.DK && typeof global.DK.getSupabaseAnonKey === "function"
        ? global.DK.getSupabaseAnonKey()
        : "";
    if (!base || !anon) throw new Error("Supabase 未設定");
    const hdr =
      global.DK && typeof global.DK.getSupabaseRestAuthHeaders === "function"
        ? await global.DK.getSupabaseRestAuthHeaders({ requireUser: true })
        : null;
    if (!hdr || !hdr.ok || !hdr.headers) {
      throw new Error((hdr && hdr.error) || "請先登入後台");
    }
    const url = String(base).replace(/\/$/, "") + "/functions/v1/attendance-network";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: hdr.headers.Authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { httpOk: res.ok, status: res.status, data: data };
  }

  /**
   * Try COMPANY_NETWORK punch via Edge.
   * Returns { ok:true, data } on success.
   * Returns { ok:false, soft:true, diag } when network path unavailable → caller may GPS fallback.
   * Throws only when network matched but RPC failed (should not silently GPS-duplicate).
   */
  function formatNetworkDiag(net) {
    if (!net) return "公司網路：無回應";
    const parts = [];
    if (net.status != null) parts.push("http=" + net.status);
    if (net.code) parts.push("code=" + net.code);
    if (net.network_ok === true) parts.push("network_ok=true");
    if (net.network_ok === false) parts.push("network_ok=false");
    if (net.server_seen_ip) parts.push("seen_ip=" + net.server_seen_ip);
    if (net.allow_count != null) parts.push("allow_count=" + net.allow_count);
    if (net.error) parts.push("err=" + String(net.error).slice(0, 120));
    return parts.length ? parts.join("｜") : "公司網路：未知失敗";
  }

  async function tryCompanyNetworkPunch(punchKind) {
    try {
      const res = await callAttendanceNetworkEdge({ action: "punch", punch: punchKind });
      const d = res.data || {};
      const diag = {
        status: res.status,
        httpOk: res.httpOk,
        code: d.code || (res.httpOk ? "" : "http_" + res.status),
        network_ok: d.network_ok,
        server_seen_ip: d.server_seen_ip || "",
        allow_count: d.allow_count,
        error: d.error || d.message || "",
        raw_allowed_type: d.raw_allowed_type || "",
      };
      if (d.ok === true && d.network_ok === true) {
        return { ok: true, data: d, diag: diag };
      }
      if (d.network_ok === true && d.code === "rpc_failed") {
        const err = new Error(d.error || "公司網路打卡失敗");
        err._attNetDiag = diag;
        throw err;
      }
      return {
        ok: false,
        soft: true,
        code: diag.code || "network_unavailable",
        error: diag.error || "",
        diag: diag,
      };
    } catch (e) {
      if (e && e._attNetDiag) throw e;
      const msg = String((e && e.message) || e || "");
      if (/公司網路打卡失敗/.test(msg)) throw e;
      return {
        ok: false,
        soft: true,
        code: "edge_unavailable",
        error: msg,
        diag: { status: null, code: "edge_unavailable", error: msg },
      };
    }
  }

  async function fetchRows(table, build) {
    const client = await getClient();
    let q = client.from(table).select(build.select);
    if (typeof build.apply === "function") q = build.apply(q);
    const res = await q;
    if (res && res.error) throw res.error;
    return Array.isArray(res.data) ? res.data : [];
  }

  function getCurrentPositionOnce() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
        reject({ code: 2, message: "此瀏覽器不支援定位" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          const c = pos && pos.coords;
          if (!c || c.latitude == null || c.longitude == null || c.accuracy == null) {
            reject({ code: 2, message: "定位資料不完整" });
            return;
          }
          resolve({
            latitude: Number(c.latitude),
            longitude: Number(c.longitude),
            accuracy: Number(c.accuracy),
          });
        },
        function (err) { reject(err || { code: 2, message: "無法取得位置" }); },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  // Mobile Safari/Chrome：async geolocation/RPC 後會失去 user activation。
  // 必須在原始 click 同步區 unlock AudioContext；RPC 成功後才播成功音。
  let attendanceAudioCtx = null;
  let attendanceAudioUnlocked = false;

  function getAttendanceAudioCtx() {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return null;
    if (!attendanceAudioCtx) {
      try { attendanceAudioCtx = new Ctx(); } catch (_) { return null; }
    }
    return attendanceAudioCtx;
  }

  function unlockAttendanceAudio() {
    try {
      const ctx = getAttendanceAudioCtx();
      if (!ctx) return;
      if (typeof ctx.resume === "function") {
        try { ctx.resume(); } catch (_) {}
      }
      // iOS：gesture 內播極短靜音，避免之後 suspended 無法發聲
      const now = ctx.currentTime || 0;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.00001, now);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.02);
      attendanceAudioUnlocked = true;
    } catch (_) {
      attendanceAudioUnlocked = false;
    }
  }

  function playDingDong() {
    try {
      const ctx = getAttendanceAudioCtx();
      if (!ctx) return;
      if (typeof ctx.resume === "function") {
        try { ctx.resume(); } catch (_) {}
      }
      const t0 = ctx.currentTime || 0;
      function tone(freq, start, dur, peak) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t0 + start);
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur + 0.02);
      }
      tone(880, 0, 0.14, 0.08);
      tone(1175, 0.13, 0.18, 0.07);
    } catch (_) {}
  }

  function playSuccessSpeech() {
    try {
      if (!global.speechSynthesis || typeof global.SpeechSynthesisUtterance !== "function") return;
      const u = new SpeechSynthesisUtterance("打卡成功，位置正確");
      u.lang = "zh-TW";
      u.rate = 1;
      try { global.speechSynthesis.cancel(); } catch (_) {}
      global.speechSynthesis.speak(u);
    } catch (_) {}
  }

  function playSuccessFeedback() {
    // 僅在 RPC 成功後呼叫。音訊失敗不得影響打卡結果。
    try { playDingDong(); } catch (_) {}
    try { playSuccessSpeech(); } catch (_) {}
  }

  function profileUsernameKey(username) {
    return String(username || "").trim().toLowerCase();
  }

  function findProfileIdByUsername(username) {
    const key = profileUsernameKey(username);
    if (!key) return "";
    const ids = Object.keys(profileMap);
    for (let i = 0; i < ids.length; i += 1) {
      const p = profileMap[ids[i]];
      if (p && profileUsernameKey(p.username) === key) return String(p.id || ids[i]);
    }
    return "";
  }

  function upsertProfileEntry(id, entry, preferExisting) {
    const key = String(id || "");
    if (!key || !entry) return;
    const prev = profileMap[key];
    if (!prev || !preferExisting) {
      profileMap[key] = entry;
      return;
    }
    profileMap[key] = {
      id: key,
      username: prev.username || entry.username,
      displayName: prev.displayName || entry.displayName || prev.username || entry.username || "",
      role: prev.role != null ? prev.role : entry.role,
      enabled: prev.enabled != null ? prev.enabled : entry.enabled,
    };
  }

  async function loadProfilesIfAdmin() {
    profileMap = {};
    if (!isAdmin()) {
      const meOnly = currentUser();
      if (meOnly && meOnly.userId) {
        profileMap[String(meOnly.userId)] = {
          id: meOnly.userId,
          username: meOnly.username,
          displayName: meOnly.displayName || meOnly.username,
        };
      }
      return;
    }
    try {
      const rows = await fetchRows("profiles", {
        select: "id,username,display_name,role,enabled",
        apply: function (q) {
          return q.order("display_name", { ascending: true });
        },
      });
      rows.forEach(function (r) {
        if (!r || !r.id) return;
        upsertProfileEntry(String(r.id), {
          id: r.id,
          username: r.username,
          displayName: r.display_name || r.username || "",
          role: r.role,
          enabled: r.enabled === true,
        }, false);
      });
    } catch (_) {}
    const me = currentUser();
    if (me && me.userId && !profileMap[String(me.userId)]) {
      profileMap[String(me.userId)] = {
        id: me.userId,
        username: me.username,
        displayName: me.displayName || me.username,
      };
    }
    try {
      const users = global.DK && global.DK.getAdminUsers ? global.DK.getAdminUsers() : [];
      (users || []).forEach(function (u) {
        if (!u || !u.id) return;
        const id = String(u.id);
        if (profileMap[id]) return;
        if (findProfileIdByUsername(u.username)) return;
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

  async function fetchLocationSettings() {
    if (!isAdmin()) {
      locationSettings = null;
      return null;
    }
    const rows = await fetchRows("attendance_settings", {
      select: SETTINGS_SELECT,
      apply: function (q) {
        return q.eq("id", 1).limit(1);
      },
    });
    locationSettings = rows[0] || null;
    return locationSettings;
  }

  function fillLocationForm() {
    if (!isAdmin()) return;
    const s = locationSettings;
    if ($("attLocEnabled")) $("attLocEnabled").value = s && s.location_enabled === false ? "0" : "1";
    if ($("attLocLat")) $("attLocLat").value = s && s.latitude != null ? s.latitude : "";
    if ($("attLocLng")) $("attLocLng").value = s && s.longitude != null ? s.longitude : "";
    if ($("attLocRadius")) $("attLocRadius").value = s && s.radius_meters != null ? s.radius_meters : 150;
    if ($("attLocMaxAcc")) $("attLocMaxAcc").value = s && s.max_accuracy_meters != null ? s.max_accuracy_meters : 80;
    const preview = $("attLocPreview");
    if (!preview) return;
    if (!s) {
      preview.textContent = "伺服器尚無地點設定列。";
      return;
    }
    if (s.location_enabled !== true) {
      preview.textContent = "地點限制：關閉（打卡不強制 GPS 範圍）。";
      return;
    }
    if (s.latitude == null || s.longitude == null) {
      preview.textContent = "地點限制：啟用，但公司座標尚未設定（員工將無法打卡）。";
      return;
    }
    preview.textContent =
      "已設定：lat " + Number(s.latitude).toFixed(6) +
      " / lng " + Number(s.longitude).toFixed(6) +
      "，半徑 " + s.radius_meters + " m，最大誤差 " + s.max_accuracy_meters + " m。";
  }

  function normalizeIpLines(text) {
    return String(text || "")
      .split(/[\n,;]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function fillNetworkForm() {
    if (!isAdmin()) return;
    const s = locationSettings;
    if ($("attNetEnabled")) $("attNetEnabled").value = s && s.network_enabled === true ? "1" : "0";
    const ips = s && Array.isArray(s.allowed_public_ips) ? s.allowed_public_ips : [];
    if ($("attNetIps")) {
      $("attNetIps").value = ips
        .map(function (ip) {
          const t = String(ip || "");
          return t.indexOf("/") >= 0 ? t.split("/")[0] : t;
        })
        .join("\n");
    }
    const preview = $("attNetPreview");
    if (!preview) return;
    if (!s) {
      preview.textContent = "尚未讀取伺服器設定。";
      return;
    }
    preview.textContent =
      (s.network_enabled === true ? "公司網路驗證：啟用" : "公司網路驗證：關閉") +
      "｜允許 IP 數 " +
      ips.length +
      "。請使用公司出網 Public IP，勿填 Cloudflare proxy。";
  }

  async function fetchMyAttendance() {
    const me = currentUser();
    if (!me || !me.userId) throw new Error("請先登入後台");
    const myId = String(me.userId);
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
        return q.order("created_at", { ascending: false }).limit(120);
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
    const open = openShiftOf(myShifts);
    const openBr = openBreakOf(open ? breaksForShift(open.id, myBreaks) : myBreaks);
    const nowMs = Date.now();

    if ($("attClockIn")) $("attClockIn").textContent = shift ? formatTaipeiClock(shift.clock_in_at) : "—";
    if ($("attClockOut")) $("attClockOut").textContent = shift && shift.clock_out_at ? formatTaipeiClock(shift.clock_out_at) : (open ? "尚未下班" : "—");
    if ($("attStatus")) $("attStatus").textContent = statusLabel(open || shift, open ? breaksForShift(open.id, myBreaks) : (shift ? breaksForShift(shift.id, myBreaks) : []));

    const ymd = taipeiYmd(new Date());
    let workMs = 0;
    todayShifts().forEach(function (s) {
      workMs += workedMsForShift(s, breaksForShift(s.id, myBreaks), nowMs, false);
    });
    if (open && !shiftOverlapsDay(open, ymd)) {
      workMs += workedMsForShift(open, breaksForShift(open.id, myBreaks), nowMs, false);
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
          const dur = formatDuration(completedBreakMs([b], nowMs, false));
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
    const sels = [$("attAdminEmployee"), $("attReportEmployee")];
    sels.forEach(function (sel) {
      if (!sel || !isAdmin()) return;
      const keep = sel.value;
      const isReport = sel.id === "attReportEmployee";
      const opts = [isReport ? '<option value="">請選擇員工</option>' : '<option value="">全部員工</option>'];
      const seenIds = {};
      Object.keys(profileMap).sort(function (a, b) {
        return String(personName(a)).localeCompare(String(personName(b)), "zh-Hant");
      }).forEach(function (mapKey) {
        const p = profileMap[mapKey];
        if (!p) return;
        const uid = String(p.id || mapKey);
        if (seenIds[uid]) return;
        if (p.enabled === false) return;
        seenIds[uid] = true;
        opts.push('<option value="' + esc(uid) + '">' + esc(personName(uid)) + "</option>");
      });
      sel.innerHTML = opts.join("");
      if (keep && seenIds[keep]) sel.value = keep;
    });
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
      const work = formatDuration(workedMsForShift(s, br, Date.now(), true));
      const rest = formatDuration(completedBreakMs(br, Date.now(), true));
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
        "<td style=\"text-align:right;white-space:nowrap\">" +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm att-correct-btn\" data-shift=\"" + esc(s.id) + "\">更正</button> " +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm att-delete-btn\" data-shift=\"" + esc(s.id) + "\">刪除</button>" +
        "</td>" +
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
    if ($("attDeleteCard")) $("attDeleteCard").hidden = true;
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
        await fetchLocationSettings();
        fillLocationForm();
        fillNetworkForm();
        await fetchAdminAttendance();
        adminAuditRows = await fetchAdminAudit();
        renderAdminTable();
        renderAudit(adminAuditRows);
      } else {
        locationSettings = null;
        adminShifts = [];
        adminBreaks = [];
        adminAuditRows = [];
        if ($("attAdminManage")) $("attAdminManage").hidden = true;
        if ($("attAdminAudit")) $("attAdminAudit").hidden = true;
        if ($("attLocationSettings")) $("attLocationSettings").hidden = true;
        if ($("attNetworkSettings")) $("attNetworkSettings").hidden = true;
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
    unlockAttendanceAudio();
    busy = true;
    setButtons({ canClockIn: false, canBreakStart: false, canBreakEnd: false, canClockOut: false });
    showMsg($("attMsg"), "驗證公司網路中…", false);
    setLocStatus("驗證公司網路中…", "busy");
    let networkDiagText = "";
    try {
      const punchKind = GPS_RPC_TO_PUNCH[fnName];
      if (punchKind) {
        const net = await tryCompanyNetworkPunch(punchKind);
        if (net && net.ok) {
          await refreshAll({ silent: true });
          setLocStatus("公司網路驗證成功", "ok");
          const okText =
            (successText ? successText.replace(/。?$/, "") + "。" : "") +
            "打卡成功，位置正確（公司網路）";
          showMsg($("attMsg"), okText, false);
          playSuccessFeedback();
          return;
        }
        if (net && !net.soft && net.error) {
          throw new Error(net.error);
        }
        networkDiagText = formatNetworkDiag(net && net.diag ? net.diag : net);
        setLocStatus("公司網路未通過 → 改試 GPS。 " + networkDiagText, "busy");
        showMsg($("attMsg"), "公司網路未通過，改試 GPS定位…（" + networkDiagText + "）", false);
      }

      showMsg($("attMsg"), (networkDiagText ? "公司網路未通過（" + networkDiagText + "）。" : "") + "定位中…", false);
      setLocStatus(networkDiagText ? "公司網路未通過 → 定位中… " + networkDiagText : "定位中…", "busy");
      const geo = await getCurrentPositionOnce();
      pendingGpsPreview = geo;
      let uxHint = "";
      if (locationSettings && locationSettings.location_enabled === true && locationSettings.latitude != null && locationSettings.longitude != null) {
        const dist = haversineMeters(locationSettings.latitude, locationSettings.longitude, geo.latitude, geo.longitude);
        uxHint = "距離公司約 " + Math.round(dist) + " 公尺，定位精度 " + Math.round(geo.accuracy) + " 公尺。伺服器驗證中…";
        setLocStatus(uxHint, "busy");
      } else {
        setLocStatus("已取得定位（精度 " + Math.round(geo.accuracy) + " 公尺），伺服器驗證中…", "busy");
      }
      showMsg($("attMsg"), "伺服器驗證位置中…", false);
      const data = await rpcCall(fnName, {
        p_latitude: geo.latitude,
        p_longitude: geo.longitude,
        p_accuracy: geo.accuracy,
      });
      await refreshAll({ silent: true });
      const distServer = data && data.distance_meters != null ? Number(data.distance_meters) : null;
      const accServer = data && data.accuracy_meters != null ? Number(data.accuracy_meters) : geo.accuracy;
      const verified = data && (data.location_verified === true || data.location_verified === "true");
      let okText = "打卡成功，位置正確";
      if (successText) okText = successText.replace(/。?$/, "") + "。打卡成功，位置正確";
      if (distServer != null && !Number.isNaN(distServer)) {
        okText += "。距離公司 " + Math.round(distServer) + " 公尺，定位精度 " + Math.round(accServer) + " 公尺。";
        setLocStatus(
          (verified ? "位置正確。距離公司 " : "打卡成功。距離公司 ") +
            Math.round(distServer) + " 公尺，定位精度 " + Math.round(accServer) + " 公尺。",
          "ok"
        );
      } else {
        setLocStatus("打卡成功（地點限制未啟用或無需驗證距離）。", "ok");
        okText += "。";
      }
      showMsg($("attMsg"), okText, false);
      playSuccessFeedback();
    } catch (e) {
      let msg = e && (e.code === 1 || e.code === 2 || e.code === 3) ? mapGeoError(e) : mapRpcError(e);
      if (e && e._attNetDiag) {
        msg = "公司網路 RPC 失敗：" + formatNetworkDiag(e._attNetDiag) + "。 " + msg;
      } else if (networkDiagText) {
        msg = "公司網路未通過（" + networkDiagText + "）。GPS：" + msg;
      }
      showMsg($("attMsg"), msg, true);
      setLocStatus("打卡未完成", "err");
      renderClockFace();
    } finally {
      busy = false;
      renderClockFace();
    }
  }

  async function useCurrentAsCompanyLocation() {
    if (!isAdmin() || busy) return;
    busy = true;
    showMsg($("attLocMsg"), "定位中…", false);
    try {
      const geo = await getCurrentPositionOnce();
      if ($("attLocLat")) $("attLocLat").value = String(geo.latitude);
      if ($("attLocLng")) $("attLocLng").value = String(geo.longitude);
      if ($("attLocEnabled")) $("attLocEnabled").value = "1";
      showMsg(
        $("attLocMsg"),
        "已帶入目前位置：lat " + geo.latitude.toFixed(6) + " / lng " + geo.longitude.toFixed(6) +
          "（精度 " + Math.round(geo.accuracy) + " m）。請確認後按「儲存地點設定」。",
        false
      );
    } catch (e) {
      showMsg($("attLocMsg"), mapGeoError(e), true);
    } finally {
      busy = false;
    }
  }

  async function saveLocationSettings() {
    if (!isAdmin() || busy) return;
    const enabled = $("attLocEnabled") && $("attLocEnabled").value === "1";
    const latRaw = $("attLocLat") && String($("attLocLat").value).trim();
    const lngRaw = $("attLocLng") && String($("attLocLng").value).trim();
    const radius = Number($("attLocRadius") && $("attLocRadius").value);
    const maxAcc = Number($("attLocMaxAcc") && $("attLocMaxAcc").value);
    const lat = latRaw === "" ? null : Number(latRaw);
    const lng = lngRaw === "" ? null : Number(lngRaw);
    if (!Number.isFinite(radius) || radius <= 0) {
      showMsg($("attLocMsg"), "允許半徑必須大於 0。", true);
      return;
    }
    if (!Number.isFinite(maxAcc) || maxAcc <= 0) {
      showMsg($("attLocMsg"), "最大定位誤差必須大於 0。", true);
      return;
    }
    if (enabled && (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng))) {
      showMsg($("attLocMsg"), "啟用地點限制時，必須填寫公司緯度與經度。", true);
      return;
    }
    busy = true;
    showMsg($("attLocMsg"), "儲存中…", false);
    try {
      await rpcCall("attendance_admin_save_location", {
        p_enabled: enabled,
        p_latitude: lat,
        p_longitude: lng,
        p_radius_meters: radius,
        p_max_accuracy_meters: maxAcc,
      });
      await fetchLocationSettings();
      fillLocationForm();
      showMsg($("attLocMsg"), "地點設定已儲存。", false);
    } catch (e) {
      showMsg($("attLocMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
    }
  }

  async function detectServerSeenIp() {
    if (!isAdmin() || busy) return;
    busy = true;
    showMsg($("attNetMsg"), "偵測中…", false);
    try {
      const res = await callAttendanceNetworkEdge({ action: "detect_ip" });
      const d = res.data || {};
      if (!d.ok || !d.server_seen_ip) {
        throw new Error(d.error || "無法取得伺服器可見 IP（請確認 Edge 已部署）");
      }
      showMsg(
        $("attNetMsg"),
        "伺服器目前看到的 Public IP：" + d.server_seen_ip + "（非 client 自報）。確認後可按「將目前公司網路設為允許」。",
        false
      );
    } catch (e) {
      showMsg($("attNetMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
    }
  }

  async function saveCurrentCompanyNetwork() {
    if (!isAdmin() || busy) return;
    busy = true;
    showMsg($("attNetMsg"), "由伺服器擷取目前網路並儲存…", false);
    try {
      const reason = $("attNetReason") && String($("attNetReason").value || "").trim();
      const res = await callAttendanceNetworkEdge({
        action: "save_current_network",
        reason: reason || undefined,
      });
      const d = res.data || {};
      if (!d.ok) {
        throw new Error(d.error || "儲存目前公司網路失敗");
      }
      await fetchLocationSettings();
      fillNetworkForm();
      showMsg(
        $("attNetMsg"),
        "已將伺服器可見 IP " + (d.server_seen_ip || "") + " 加入允許清單並啟用公司網路驗證。",
        false
      );
    } catch (e) {
      showMsg($("attNetMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
    }
  }

  async function saveNetworkSettings() {
    if (!isAdmin() || busy) return;
    const enabled = $("attNetEnabled") && $("attNetEnabled").value === "1";
    const ips = normalizeIpLines($("attNetIps") && $("attNetIps").value);
    const reason = $("attNetReason") && String($("attNetReason").value || "").trim();
    if (enabled && !ips.length) {
      showMsg($("attNetMsg"), "啟用公司網路時，至少需要一個 Public IP。", true);
      return;
    }
    busy = true;
    showMsg($("attNetMsg"), "儲存中…", false);
    try {
      await rpcCall("attendance_admin_save_network", {
        p_enabled: enabled,
        p_allowed_public_ips: ips,
        p_reason: reason || null,
      });
      await fetchLocationSettings();
      fillNetworkForm();
      showMsg($("attNetMsg"), "公司網路設定已儲存。", false);
    } catch (e) {
      showMsg($("attNetMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
    }
  }

  function openDeleteForm(shiftId) {
    if (!isAdmin()) return;
    const shift = adminShifts.concat(myShifts).find(function (s) { return s && s.id === shiftId; });
    if (!shift) {
      showMsg($("attDeleteMsg"), "找不到該班次。", true);
      return;
    }
    if ($("attCorrectCard")) $("attCorrectCard").hidden = true;
    const card = $("attDeleteCard");
    if (card) card.hidden = false;
    if ($("attDeleteShiftId")) $("attDeleteShiftId").value = shift.id;
    if ($("attDeleteEmployeeLabel")) $("attDeleteEmployeeLabel").textContent = personName(shift.employee_id);
    if ($("attDeleteShiftLabel")) {
      $("attDeleteShiftLabel").textContent =
        formatTaipeiDateTime(shift.clock_in_at) +
        " → " +
        (shift.clock_out_at ? formatTaipeiDateTime(shift.clock_out_at) : "尚未下班");
    }
    if ($("attDeleteReason")) $("attDeleteReason").value = "";
    showMsg($("attDeleteMsg"), "", false);
  }

  async function submitDeleteShift() {
    if (!isAdmin() || busy) return;
    const shiftId = $("attDeleteShiftId") && $("attDeleteShiftId").value;
    const reason = $("attDeleteReason") && String($("attDeleteReason").value || "").trim();
    if (!shiftId) {
      showMsg($("attDeleteMsg"), "缺少班次。", true);
      return;
    }
    if (!reason) {
      showMsg($("attDeleteMsg"), "刪除理由必填。", true);
      return;
    }
    busy = true;
    showMsg($("attDeleteMsg"), "刪除中…", false);
    try {
      await rpcCall("attendance_admin_delete_shift", {
        p_shift_id: shiftId,
        p_reason: reason,
      });
      if ($("attDeleteCard")) $("attDeleteCard").hidden = true;
      await refreshAll({ silent: true });
      showMsg($("attDeleteMsg"), "已刪除出勤；ADMIN_DELETE 稽核已永久保留。", false);
      showMsg($("attMsg"), "已刪除出勤紀錄（稽核已留存）。", false);
    } catch (e) {
      showMsg($("attDeleteMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
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

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function monthRangeYmd(year, month) {
    const mm = String(month).padStart(2, "0");
    const start = year + "-" + mm + "-01";
    const endDay = String(daysInMonth(year, month)).padStart(2, "0");
    const end = year + "-" + mm + "-" + endDay;
    return { start: start, end: end, nextStart: nextTaipeiDay(end) };
  }

  async function generateMonthlyReport() {
    if (!isAdmin()) {
      showMsg($("attReportMsg"), "只有管理員可以產生出勤表。", true);
      return;
    }
    const year = Number($("attReportYear") && $("attReportYear").value);
    const month = Number($("attReportMonth") && $("attReportMonth").value);
    const empId = String(($("attReportEmployee") && $("attReportEmployee").value) || "").trim();
    if (!Number.isFinite(year) || year < 2020 || !Number.isFinite(month) || month < 1 || month > 12) {
      showMsg($("attReportMsg"), "請選擇有效的年份與月份。", true);
      return;
    }
    if (!empId) {
      showMsg($("attReportMsg"), "請選擇員工。", true);
      return;
    }
    busy = true;
    showMsg($("attReportMsg"), "產生中…", false);
    try {
      const range = monthRangeYmd(year, month);
      const startIso = taipeiDayStartIso(range.start);
      const endIso = taipeiDayStartIso(range.nextStart);
      const shifts = await fetchRows("attendance_shifts", {
        select: SHIFT_SELECT,
        apply: function (q) {
          return q.eq("employee_id", empId).gte("clock_in_at", startIso).lt("clock_in_at", endIso).order("clock_in_at", { ascending: true }).limit(500);
        },
      });
      const ids = shifts.map(function (s) { return s.id; });
      let breaks = [];
      if (ids.length) {
        breaks = await fetchRows("attendance_breaks", {
          select: BREAK_SELECT,
          apply: function (q) {
            return q.eq("employee_id", empId).in("shift_id", ids).order("break_start_at", { ascending: true }).limit(1000);
          },
        });
      }
      const audits = await fetchRows("attendance_audit_logs", {
        select: AUDIT_SELECT,
        apply: function (q) {
          return q
            .eq("employee_id", empId)
            .in("action", ["ADMIN_CORRECTION", "ADMIN_DELETE"])
            .gte("created_at", startIso)
            .lt("created_at", endIso)
            .limit(500);
        },
      });
      const correctedDays = {};
      let deletedAuditCount = 0;
      audits.forEach(function (a) {
        if (!a) return;
        if (a.action === "ADMIN_DELETE") deletedAuditCount += 1;
        if (a.action === "ADMIN_CORRECTION" && a.created_at) correctedDays[taipeiYmd(a.created_at)] = true;
      });
      const byDay = {};
      shifts.forEach(function (s) {
        const ymd = taipeiYmd(s.clock_in_at);
        if (!byDay[ymd]) byDay[ymd] = [];
        byDay[ymd].push(s);
      });

      let workDays = 0;
      let totalWorkMs = 0;
      let totalBreakMs = 0;
      let incomplete = 0;
      const dayCount = daysInMonth(year, month);
      const rowsHtml = [];
      for (let d = 1; d <= dayCount; d++) {
        const ymd = year + "-" + String(month).padStart(2, "0") + "-" + String(d).padStart(2, "0");
        const dayShifts = byDay[ymd] || [];
        if (!dayShifts.length) {
          rowsHtml.push(
            "<tr><td>" + esc(ymd.replace(/-/g, "/")) + "</td><td>" + esc(weekdayZh(ymd)) +
            "</td><td>—</td><td>—</td><td>—</td><td>—</td><td>未出勤</td></tr>"
          );
          continue;
        }
        workDays += 1;
        let cinText = [];
        let coutText = [];
        let dayBreakMs = 0;
        let dayWorkMs = 0;
        let statuses = [];
        let hasOpen = false;
        dayShifts.forEach(function (s) {
          const br = breaksForShift(s.id, breaks);
          cinText.push(formatTaipeiClock(s.clock_in_at));
          if (s.clock_out_at) {
            coutText.push(formatTaipeiClock(s.clock_out_at));
            dayWorkMs += workedMsForShift(s, br, null, true);
            dayBreakMs += completedBreakMs(br, null, true);
            statuses.push("正常");
          } else {
            coutText.push("未完成");
            hasOpen = true;
            incomplete += 1;
            statuses.push("未完成");
          }
        });
        totalWorkMs += dayWorkMs;
        totalBreakMs += dayBreakMs;
        let status = hasOpen ? "未完成" : "正常";
        if (correctedDays[ymd]) status = status === "未完成" ? "未完成／已修正" : "已修正";
        rowsHtml.push(
          "<tr>" +
          "<td>" + esc(ymd.replace(/-/g, "/")) + "</td>" +
          "<td>" + esc(weekdayZh(ymd)) + "</td>" +
          "<td>" + esc(cinText.join(" / ")) + "</td>" +
          "<td>" + esc(coutText.join(" / ")) + "</td>" +
          "<td>" + esc(formatDuration(dayBreakMs)) + "</td>" +
          "<td>" + esc(hasOpen ? "—" : formatDuration(dayWorkMs)) + "</td>" +
          "<td>" + esc(status) + "</td>" +
          "</tr>"
        );
      }

      const empName = personName(empId);
      const printDate = formatTaipeiDate(new Date());
      const correctionCount = audits.filter(function (a) { return a && a.action === "ADMIN_CORRECTION"; }).length;
      const html =
        '<div class="att-print-doc">' +
        "<h1>DK Computer</h1>" +
        "<h2>員工出勤紀錄</h2>" +
        '<div class="att-print-meta">員工：' + esc(empName) +
        "　　出勤月份：" + esc(String(year)) + " / " + esc(String(month)) + "</div>" +
        (deletedAuditCount > 0
          ? '<div class="att-print-meta">本期間存在已刪除出勤紀錄（' + deletedAuditCount + " 筆 ADMIN_DELETE；不計入工時）。</div>"
          : "") +
        '<table class="att-print-table"><thead><tr>' +
        "<th>日期</th><th>星期</th><th>上班時間</th><th>下班時間</th><th>休息總時間</th><th>實際工時</th><th>狀態</th>" +
        "</tr></thead><tbody>" + rowsHtml.join("") + "</tbody></table>" +
        '<div class="att-print-summary">' +
        "<div>出勤天數：" + workDays + "</div>" +
        "<div>總實際工時：" + esc(formatDurationHours(totalWorkMs)) + "（" + esc(formatDuration(totalWorkMs)) + "）</div>" +
        "<div>總休息時間：" + esc(formatDurationHours(totalBreakMs)) + "（" + esc(formatDuration(totalBreakMs)) + "）</div>" +
        "<div>未完成班次數：" + incomplete + "</div>" +
        "<div>管理員更正次數：" + correctionCount + "</div>" +
        "</div>" +
        '<div class="att-print-sign">' +
        "<div>員工簽名：________________</div>" +
        "<div>主管簽名：________________</div>" +
        "<div>列印日期：" + esc(printDate) + "</div>" +
        "</div></div>";

      lastReportHtml = html;
      const sheet = $("attPrintSheet");
      const root = $("attPrintRoot");
      if (sheet) sheet.innerHTML = html;
      if (root) {
        root.hidden = false;
        root.setAttribute("aria-hidden", "false");
      }
      showMsg($("attReportMsg"), "已產生 " + empName + " " + year + "/" + month + " 出勤表，可按「列印出勤表」。", false);
    } catch (e) {
      showMsg($("attReportMsg"), mapRpcError(e), true);
    } finally {
      busy = false;
    }
  }

  function printMonthlyReport() {
    if (!isAdmin()) {
      showMsg($("attReportMsg"), "只有管理員可以列印出勤表。", true);
      return;
    }
    if (!lastReportHtml) {
      showMsg($("attReportMsg"), "請先產生出勤表。", true);
      return;
    }
    const root = $("attPrintRoot");
    const sheet = $("attPrintSheet");
    if (sheet) sheet.innerHTML = lastReportHtml;
    if (root) {
      root.hidden = false;
      root.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("att-printing");
    const cleanup = function () {
      document.body.classList.remove("att-printing");
      global.removeEventListener("afterprint", cleanup);
    };
    global.addEventListener("afterprint", cleanup);
    setTimeout(function () {
      try { global.print(); } catch (_) { cleanup(); }
    }, 50);
  }

  function initReportDefaults() {
    const now = taipeiParts(new Date());
    const y = Number(now.ymd.slice(0, 4));
    const m = Number(now.ymd.slice(5, 7));
    if ($("attReportYear") && !$("attReportYear").value) $("attReportYear").value = String(y);
    if ($("attReportMonth")) $("attReportMonth").value = String(m);
  }

  function bind() {
    const cin = $("attBtnClockIn");
    const bs = $("attBtnBreakStart");
    const be = $("attBtnBreakEnd");
    const cout = $("attBtnClockOut");
    if (cin) {
      cin.addEventListener("click", function () {
        unlockAttendanceAudio();
        runAction("attendance_clock_in", "上班打卡成功。");
      });
    }
    if (bs) {
      bs.addEventListener("click", function () {
        unlockAttendanceAudio();
        runAction("attendance_break_start", "已開始休息。");
      });
    }
    if (be) {
      be.addEventListener("click", function () {
        unlockAttendanceAudio();
        runAction("attendance_break_end", "已結束休息。");
      });
    }
    if (cout) {
      cout.addEventListener("click", function () {
        unlockAttendanceAudio();
        runAction("attendance_clock_out", "下班打卡成功。");
      });
    }

    const refresh = $("attAdminRefresh");
    if (refresh) refresh.addEventListener("click", function () { refreshAll(); });
    const dateEl = $("attAdminDate");
    if (dateEl) dateEl.addEventListener("change", function () { if (isAdmin()) refreshAll(); });
    const empEl = $("attAdminEmployee");
    if (empEl) empEl.addEventListener("change", function () { if (isAdmin()) refreshAll(); });
    const adminTable = $("attAdminTbody");
    if (adminTable) {
      adminTable.addEventListener("click", function (ev) {
        const del = ev.target && ev.target.closest ? ev.target.closest(".att-delete-btn") : null;
        if (del) {
          openDeleteForm(del.getAttribute("data-shift"));
          return;
        }
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
    const delSub = $("attDeleteSubmit");
    if (delSub) delSub.addEventListener("click", function () { submitDeleteShift(); });
    const delCancel = $("attDeleteCancel");
    if (delCancel) {
      delCancel.addEventListener("click", function () {
        if ($("attDeleteCard")) $("attDeleteCard").hidden = true;
        showMsg($("attDeleteMsg"), "", false);
      });
    }

    const useCur = $("attLocUseCurrent");
    if (useCur) useCur.addEventListener("click", function () { useCurrentAsCompanyLocation(); });
    const saveLoc = $("attLocSave");
    if (saveLoc) saveLoc.addEventListener("click", function () { saveLocationSettings(); });

    const netDetect = $("attNetDetect");
    if (netDetect) netDetect.addEventListener("click", function () { detectServerSeenIp(); });
    const netSaveCur = $("attNetSaveCurrent");
    if (netSaveCur) netSaveCur.addEventListener("click", function () { saveCurrentCompanyNetwork(); });
    const netSave = $("attNetSave");
    if (netSave) netSave.addEventListener("click", function () { saveNetworkSettings(); });

    const gen = $("attReportGenerate");
    if (gen) gen.addEventListener("click", function () { generateMonthlyReport(); });
    const printBtn = $("attReportPrint");
    if (printBtn) printBtn.addEventListener("click", function () { printMonthlyReport(); });
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
    initReportDefaults();
    const admin = isAdmin();
    if ($("attAdminManage")) $("attAdminManage").hidden = !admin;
    if ($("attAdminAudit")) $("attAdminAudit").hidden = !admin;
    if ($("attLocationSettings")) $("attLocationSettings").hidden = !admin;
    if ($("attNetworkSettings")) $("attNetworkSettings").hidden = !admin;
    startClock();
    renderClockFace();
    setLocStatus("按下打卡：先驗證公司網路，必要時再請求 GPS。", null);
    await refreshAll();
  }

  bind();
  startClock();
  global.__dkAttendanceOnShow = onShow;
})(window);
