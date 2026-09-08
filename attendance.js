/**
 * Stage 11 / 11-5 員工打卡；Stage 18-2 班別管理與每月 WORK 排班；Stage 18-3 排休申請。
 * 讀 attendance_shifts / attendance_breaks / attendance_audit_logs / attendance_settings（RLS）。
 * 讀 attendance_shift_templates / employee_schedules / attendance_leave_requests（RLS）；寫入走 Stage 18 RPC。
 * GPS：authenticated RPC（p_latitude/p_longitude/p_accuracy）。
 * 公司網路：Edge 取 server-side Public IP，再以 service_role 呼叫 *_company_network。
 * 不直接 INSERT/UPDATE/DELETE attendance 表；不送 client IP／timestamp；不背景追蹤 GPS。
 * 排班不自行組 snapshot；不送 created_by / updated_by。REST_DAY 核准寫 OFF；病假／事假／特休為 WORKDAY overlay。
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
  let shiftTemplates = [];
  let monthSchedules = [];
  let defaultShiftPeriods = [];
  let monthDefaultPeriods = [];
  let myLeaveRequests = [];
  let adminLeaveRequests = [];
  let monthLeaveRequests = [];
  let monthCompliance = null;
  let tplBusy = false;
  let schedBusy = false;
  let defBusy = false;
  let leaveBusy = false;
  let compensationPeriods = [];
  let compBusy = false;
  let payrollBusy = false;
  let lastPayrollPreview = null;
  let lastOtCandidates = [];
  let lastPayrollSettlement = null;
  let lastPayslipHtml = "";
  let lastAttPane = "clock";
  let selectedEmpId = "";
  let empDetailTab = "overview";
  let peopleSearch = "";
  let peopleStatusFilter = "";
  let overviewDefaults = [];
  let overviewTodaySchedules = [];
  let leaveCalYear = 0;
  let leaveCalMonth = 0;
  let leaveSelectedDates = {};

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
    el.className = "att-loc-status muted form-hint status-badge status-muted";
    if (kind === "ok") el.className = "att-loc-status att-loc-ok status-badge status-success";
    if (kind === "err") el.className = "att-loc-status att-loc-err status-badge status-danger";
    if (kind === "busy") el.className = "att-loc-status att-loc-busy status-badge status-warning";
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
    const code = err && err.code != null ? String(err.code) : "";
    const m = (raw + " " + code).toLowerCase();
    if (/open shift already exists/.test(m)) return "已經有進行中的班次，無法再次上班打卡。";
    if (/no open shift/.test(m)) return "目前沒有進行中的班次。";
    if (/open break already exists/.test(m)) return "已經在休息中。";
    if (/open break exists/.test(m)) return "請先結束休息，才能下班打卡。";
    if (/no open break/.test(m)) return "目前沒有進行中的休息。";
    if (/reason required/.test(m)) return "修改理由必填。";
    if (/admin only/.test(m)) return "只有管理員可以執行此操作。";
    if (/permission denied for function/.test(m)) {
      return "伺服器拒絕執行內部函式：" + raw.slice(0, 140);
    }
    if (/permission denied for table|permission denied for schema/.test(m)) {
      return "伺服器拒絕寫入資料表：" + raw.slice(0, 140);
    }
    if (/^permission denied$/.test(raw.trim().toLowerCase()) && /42501/.test(m)) {
      return "後台帳號未通過伺服器驗證（enabled / role）。";
    }
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
    if (/shift template not found/.test(m)) return "找不到該班別。";
    if (/shift template disabled/.test(m)) return "此班別已停用，無法指定。";
    if (/cannot create past schedule/.test(m)) return "不可新增過去日期的排班。";
    if (/today or past schedule is frozen/.test(m)) return "今天或過去的排班已凍結，無法修改或清除。";
    if (/cannot move schedule onto today or past/.test(m)) return "不可把排班改到今天或過去。";
    if (/schedule not found/.test(m)) return "找不到該筆排班。";
    if (/name required/.test(m)) return "請填班別名稱。";
    if (/invalid time|time required|invalid input syntax/.test(m)) return "請填有效的上下班時間（24小時制，例如 19:00）。";
    if (/start_time and end_time cannot be equal/.test(m)) return "上班與下班時間不可相同。";
    if (/cross_midnight requires/.test(m)) return "跨午夜班別的下班時間必須早於上班時間。";
    if (/same-day shift requires/.test(m)) return "非跨午夜班別的下班時間必須晚於上班時間。";
    if (/invalid minutes/.test(m)) return "休息／寬限分鐘數無效。";
    if (/invalid cross_midnight/.test(m)) return "跨午夜設定無效。";
    if (/invalid enabled/.test(m)) return "啟用狀態無效。";
    if (/server fields are not client-writable/.test(m)) return "不可傳送伺服器欄位。";
    if (/employee not found/.test(m)) return "找不到該員工。";
    if (/employee disabled or not a backoffice user/.test(m)) return "該員工已停用或不是後台使用者。";
    if (/user_id required/.test(m)) return "請選擇員工。";
    if (/work_date required/.test(m)) return "請選擇日期。";
    if (/shift_template_id required/.test(m)) return "請選擇班別。";
    if (/effective_from required/.test(m)) return "請選擇生效日期。";
    if (/default shift period overlap/.test(m)) return "預設班別期間重疊，請改用較晚的生效日。";
    if (/schedule_conflict|employee_schedules_user_date_uidx/.test(m)) return "該日已有不同類型的排班（例外上班／排休），不可直接覆蓋。";
    if (/cannot request leave for another employee/.test(m)) return "只能替自己提出申請。";
    if (/leave_date must be after today/.test(m)) return "只能申請今天之後的日期。";
    if (/LEAVE_BATCH_CONFLICT/i.test(raw) || /LEAVE_BATCH_CONFLICT/i.test(m)) {
      const conflictYmd = leaveBatchConflictYmd(err, raw);
      if (conflictYmd) return formatLeaveChip(conflictYmd) + " 已有待處理或已核准申請，請取消選取後再送出。";
      return "所選日期中已有待處理或已核准申請，請取消選取後再送出。";
    }
    if (/duplicate leave request|attendance_leave_requests_active_uidx/.test(m)) return "同一天已有待核准或已核准的請假／排休。";
    if (/cannot cancel another employee leave/.test(m)) return "只能取消自己的申請。";
    if (/only PENDING leave can be cancelled by staff/.test(m)) return "只能取消待核准的申請。";
    if (/leave request is not PENDING/.test(m)) return "此申請不是待核准狀態。";
    if (/only APPROVED leave can be revoked/.test(m)) return "只能撤銷已核准的請假／排休。";
    if (/leave request not found/.test(m)) return "找不到該筆申請。";
    if (/HISTORICAL_LEAVE_REQUIRES_WORKDAY/i.test(raw) || /HISTORICAL_LEAVE_REQUIRES_WORKDAY/i.test(m)) {
      return "該日不是預定工作日，無法補登病假／事假／特休。";
    }
    if (/leave_date must be before today/.test(m)) return "只能補登今天以前的日期。";
    if (/historical_reason required/.test(m)) return "請填補登原因。";
    if (/LEAVE_CONFLICT/i.test(raw) || /LEAVE_CONFLICT/i.test(m)) return "該日已有衝突的請假或排休，請先處理後再操作。";
    if (/invalid leave_unit/.test(m)) return "目前僅支援整日請假。";
    if (/invalid leave_type/.test(m)) return "請假類型無效。";
    if (/dates required/.test(m)) return "請先在月曆選擇日期。";
    if (/too many leave dates/.test(m)) return "一次申請天數過多，請分批送出。";
    if (/id required/.test(m)) return "缺少申請編號。";
    if (/month required/.test(m)) return "請選擇月份。";
    if (/eval arguments required/.test(m)) return "出勤判定參數不完整。";
    if (/compensation_period_overlap|employee_compensation_periods_open_uidx|employee_compensation_periods_user_from_uidx/.test(m)) return "薪資期間重疊，請改日期或改用調薪。";
    if (/invalid compensation period range/.test(m)) return "薪資期間日期無效。";
    if (/invalid monthly_salary|monthly_salary required/.test(m)) return "請輸入有效的月薪（整數 NT$）。";
    if (/invalid employment_stage/.test(m)) return "薪資階段無效。";
    if (/invalid pay_type/.test(m)) return "目前僅支援月薪。";
    if (/probation_from required/.test(m)) return "請選擇試用開始日。";
    if (/probation_to required/.test(m)) return "請選擇試用結束日。";
    if (/regular_from required/.test(m)) return "請選擇正式生效日。";
    if (/day_type required/.test(m)) return "請選擇日別（休息日或例假）。";
    if (/invalid day_type/.test(m)) return "日別無效。請選擇休息日或例假。";
    if (/duplicate key|unique constraint|name_ci_uidx/.test(m)) return "班別名稱已存在。";
    if (/not authenticated|請先登入/.test(m)) return "請先登入後台。";
    if (/backoffice_request_leave_batch/.test(m)) {
      return "批次請假尚未就緒，請先執行 supabase-stage18-leave-batch.sql。";
    }
    if (/backoffice_create_historical_leave/.test(m)) {
      return "歷史請假補登尚未就緒，請先執行 supabase-stage18-1-historical-leave.sql。";
    }
    if (/attendance_leave_requests|backoffice_request_leave|backoffice_cancel_leave|backoffice_approve_leave|backoffice_reject_leave|backoffice_revoke_leave|backoffice_set_employee_rest/.test(m)) {
      return "排休功能尚未就緒，請先執行 Stage 18-3 SQL。";
    }
    if (/backoffice_attendance_evaluate_month|dk_attendance_eval_day/.test(m)) {
      return "出勤判定尚未就緒，請先執行 Stage 18-4 SQL。";
    }
    if (/employee_compensation_periods|backoffice_set_employee_compensation/.test(m)) {
      return "薪資設定尚未就緒，請先執行 Stage 18-5 SQL。";
    }
    if (/backoffice_attendance_schedule_compliance|dk_attendance_resolve_schedule|attendance_calendar_days/.test(m)) {
      return "日別／排班檢查尚未就緒，請先執行 Stage 18-6 SQL。";
    }
    if (/leave_unit/.test(m)) {
      return "請假種類尚未就緒，請先執行 Stage 18-7 SQL。";
    }
    if (/PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED/i.test(raw) || /PAYROLL_ALREADY_SETTLED_HISTORY_LOCKED/i.test(m)) {
      return "該月份薪資已完成月結，不能直接補登歷史請假。請使用後續薪資更正流程處理。";
    }
    if (/PAYROLL_ALREADY_SETTLED/.test(raw) || /PAYROLL_ALREADY_SETTLED/.test(m)) {
      return "本月份已結算，不可重複結算。";
    }
    if (/PAYROLL_NOT_READY/.test(raw) || /PAYROLL_NOT_READY/.test(m)) {
      let extra = "";
      try {
        const det = err && err.details;
        const flags = typeof det === "string" ? JSON.parse(det) : det;
        const items = payrollReviewItems(flags);
        if (items.length) extra = "：" + items.map(function (r) { return r.text; }).join("、");
      } catch (_) {}
      return "本月尚不可結算" + extra + "。";
    }
    if (/HOURLY_PAYROLL_NOT_IMPLEMENTED/.test(m)) return "時薪制薪資尚未實作。";
    if (/REGULAR_HOLIDAY_NOT_APPROVABLE/.test(m)) return "例假出勤不可用一般加班核准結算。";
    if (/no overtime candidate/.test(m)) return "該日沒有可確認的加班候選。";
    if (/approved_minutes exceeds candidate/.test(m)) return "核准分鐘不可超過候選分鐘。";
    if (/invalid approved_minutes|approved_minutes required/.test(m)) return "請輸入有效的核准分鐘。";
    if (/invalid overtime_type|invalid overtime status/.test(m)) return "加班類型或狀態無效。";
    if (/backoffice_payroll_preview_month|dk_payroll_preview_day/.test(m)) {
      return "薪資預覽尚未就緒，請先執行 Stage 18-8 SQL。";
    }
    if (/attendance_overtime_approvals|backoffice_get_overtime_candidates|backoffice_set_overtime_approval/.test(m)) {
      return "加班確認尚未就緒，請先執行 Stage 18-9 SQL。";
    }
    if (/payroll_settlements|backoffice_settle_payroll_month|backoffice_get_payroll_settlement/.test(m)) {
      return "薪資月結尚未就緒，請先執行 Stage 18-10 SQL。";
    }
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
    if (clockOut) {
      const outOn = clockOut && !clockOut.disabled;
      clockOut.classList.toggle("primary-action", !!outOn);
      clockOut.classList.toggle("secondary-action", !outOn);
    }
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
    const stEl = $("attStatus");
    if (stEl) {
      const label = statusLabel(open || shift, open ? breaksForShift(open.id, myBreaks) : (shift ? breaksForShift(shift.id, myBreaks) : []));
      stEl.textContent = label;
      let stClass = "status-muted";
      if (label === "上班中") stClass = "status-success";
      else if (label === "休息中") stClass = "status-warning";
      else if (label === "已下班") stClass = "status-info";
      stEl.className = "att-stat-value status-badge " + stClass;
    }

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
        tbody.innerHTML = '<tr><td colspan="3" class="muted">今日尚無休息紀錄</td></tr>';
        if ($("attBreakEmpty")) $("attBreakEmpty").hidden = false;
        if ($("attBreakTableWrap")) $("attBreakTableWrap").hidden = true;
      } else {
        if ($("attBreakEmpty")) $("attBreakEmpty").hidden = true;
        if ($("attBreakTableWrap")) $("attBreakTableWrap").hidden = false;
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
    const sels = [$("attAdminEmployee"), $("attReportEmployee"), $("attSchedEmployee"), $("attDefEmployee"), $("attLeaveDirectEmployee"), $("attHistoricalLeaveEmployee"), $("attCompEmployee"), $("attPayrollEmployee")];
    sels.forEach(function (sel) {
      if (!sel || !isAdmin()) return;
      const keep = sel.value;
      const isAll = sel.id === "attAdminEmployee";
      const opts = [isAll ? '<option value="">全部員工</option>' : '<option value="">請選擇員工</option>'];
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
    let rows = adminShifts || [];
    if (selectedEmpId && lastAttPane === "people" && empDetailTab === "attendance") {
      rows = rows.filter(function (s) { return s && String(s.employee_id) === String(selectedEmpId); });
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">尚無資料</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (s) {
      const br = breaksForShift(s.id, adminBreaks);
      const work = formatDuration(workedMsForShift(s, br, Date.now(), true));
      const rest = formatDuration(completedBreakMs(br, Date.now(), true));
      const st = statusLabel(s, br);
      let stClass = "status-muted";
      if (st === "上班中") stClass = "status-success";
      else if (st === "休息中") stClass = "status-warning";
      else if (st === "已下班") stClass = "status-info";
      return (
        "<tr>" +
        "<td class=\"table-primary\">" + esc(personName(s.employee_id)) + "</td>" +
        "<td class=\"nowrap table-secondary\">" + esc(taipeiYmd(s.clock_in_at).replace(/-/g, "/")) + "</td>" +
        "<td class=\"nowrap table-number\">" + esc(formatTaipeiDateTime(s.clock_in_at)) + "</td>" +
        "<td class=\"nowrap table-number\">" + esc(s.clock_out_at ? formatTaipeiDateTime(s.clock_out_at) : "尚未下班") + "</td>" +
        "<td class=\"table-number\">" + esc(rest) + "</td>" +
        "<td class=\"table-number text-strong\">" + esc(work) + "</td>" +
        "<td><span class=\"status-badge " + stClass + "\">" + esc(st) + "</span></td>" +
        "<td class=\"table-actions\">" +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm tertiary-action att-correct-btn\" data-shift=\"" + esc(s.id) + "\">更正</button> " +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm danger-action att-delete-btn\" data-shift=\"" + esc(s.id) + "\">刪除</button>" +
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
      const act = r.action || "";
      let actClass = "status-muted";
      if (act === "ADMIN_DELETE") actClass = "status-danger";
      else if (act === "ADMIN_CORRECTION" || act === "ADMIN_NETWORK_SETTINGS") actClass = "status-info";
      else if (act === "CLOCK_IN" || act === "CLOCK_OUT") actClass = "status-success";
      return (
        "<tr>" +
        "<td class=\"nowrap table-secondary\">" + esc(formatTaipeiDateTime(r.created_at)) + "</td>" +
        "<td>" + esc(personName(r.actor_user_id)) + "</td>" +
        "<td>" + esc(personName(r.employee_id)) + "</td>" +
        "<td><span class=\"status-badge " + actClass + "\">" + esc(ACTION_LABEL[r.action] || r.action || "") + "</span></td>" +
        "<td class=\"table-secondary\">" + esc(r.reason || "—") + "</td>" +
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
        try {
          await loadShiftTemplates();
          renderShiftTemplates();
        } catch (e) {
          showMsg($("attTplMsg"), mapRpcError(e), true);
        }
        try {
          await loadMonthlySchedule();
          renderMonthlySchedule();
        } catch (e) {
          showMsg($("attSchedMsg"), mapRpcError(e), true);
        }
        try {
          fillDefTemplateSelect();
          await loadDefaultShiftPeriods();
          renderDefaultShift();
        } catch (e) {
          showMsg($("attDefMsg"), mapRpcError(e), true);
        }
        try {
          await loadAdminLeaveRequests();
          renderAdminLeave();
        } catch (e) {
          showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
        }
        try {
          await loadOverviewExtras();
          renderPeopleOverview();
          renderEmpOverview();
        } catch (_) {
          renderPeopleOverview();
        }
        try {
          await loadCompensationPeriods();
          renderCompensation();
          syncCompensationProbationFields();
        } catch (e) {
          showMsg($("attCompMsg"), mapRpcError(e), true);
        }
      } else {
        locationSettings = null;
        adminShifts = [];
        adminBreaks = [];
        adminAuditRows = [];
        shiftTemplates = [];
        monthSchedules = [];
        defaultShiftPeriods = [];
        monthDefaultPeriods = [];
        adminLeaveRequests = [];
        monthLeaveRequests = [];
        compensationPeriods = [];
        monthCompliance = null;
        if ($("attAdminManage")) $("attAdminManage").hidden = true;
        if ($("attAdminAudit")) $("attAdminAudit").hidden = true;
        if ($("attLocationSettings")) $("attLocationSettings").hidden = true;
        if ($("attNetworkSettings")) $("attNetworkSettings").hidden = true;
        if ($("attShiftTemplates")) $("attShiftTemplates").hidden = true;
        if ($("attMonthlySchedule")) $("attMonthlySchedule").hidden = true;
        if ($("attDefaultShift")) $("attDefaultShift").hidden = true;
        if ($("attLeaveAdmin")) $("attLeaveAdmin").hidden = true;
        if ($("attHistoricalLeave")) $("attHistoricalLeave").hidden = true;
        if ($("attPanePeople")) $("attPanePeople").hidden = true;
        if ($("attEmpDetail")) $("attEmpDetail").hidden = true;
        if ($("attComp")) $("attComp").hidden = true;
        if ($("attPayroll")) $("attPayroll").hidden = true;
      }
      syncAttendanceChrome();
      try {
        await loadMyLeaveRequests();
        renderMyLeave();
      } catch (e) {
        showMsg($("attLeaveMsg"), mapRpcError(e), true);
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

  function minutesToDuration(min) {
    const n = Number(min);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return formatDuration(Math.round(n) * 60000);
  }

  function evalStatusLabel(status) {
    if (status === "NO_SCHEDULE") return "未排班";
    if (status === "OFF") return "排休";
    if (status === "LEAVE") return "請假";
    if (status === "NORMAL") return "正常";
    if (status === "LATE") return "遲到";
    if (status === "EARLY_LEAVE") return "早退";
    if (status === "LATE_AND_EARLY") return "遲到＋早退";
    if (status === "INCOMPLETE") return "未完成";
    if (status === "ABSENT") return "未出勤";
    return status || "—";
  }

  function evalLeaveLabel(leaveType) {
    if (leaveType === "SICK_LEAVE") return "病假";
    if (leaveType === "PERSONAL_LEAVE") return "事假";
    if (leaveType === "ANNUAL_LEAVE") return "特休";
    return "—";
  }

  function evalStatusText(row) {
    const status = row && row.attendance_status;
    const label = evalStatusLabel(status);
    if (row && row.anomaly === "LEAVE_WITH_ATTENDANCE") return label + "（請假日出勤）";
    return label;
  }

  function evalDayTypeLabel(dayType) {
    if (dayType === "WORKDAY") return "一般工作日";
    if (dayType === "REST_DAY") return "休息日";
    if (dayType === "REGULAR_HOLIDAY") return "例假";
    if (dayType === "NATIONAL_HOLIDAY") return "國定假日";
    return "未分類";
  }

  function evalShiftLabel(row) {
    const st = row && row.attendance_status;
    if (st === "OFF" || (row && row.schedule_type === "OFF")) return "排休";
    if (st === "NO_SCHEDULE" || (row && row.schedule_source === "NONE")) return "未排班";
    return (row && row.shift_name) || "—";
  }

  function evalScheduledTime(row) {
    if (!row || row.schedule_type === "OFF" || row.attendance_status === "NO_SCHEDULE" || !row.scheduled_start) return "—";
    return String(row.scheduled_start) + "–" + String(row.scheduled_end || "—");
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
    if (!global.DK || typeof global.DK.evaluateAttendanceMonth !== "function") {
      showMsg($("attReportMsg"), "出勤判定尚未就緒。", true);
      return;
    }
    busy = true;
    showMsg($("attReportMsg"), "產生中…", false);
    try {
      const monthYmd = year + "-" + String(month).padStart(2, "0") + "-01";
      const evalRes = await global.DK.evaluateAttendanceMonth(empId, monthYmd);
      const days = evalRes && Array.isArray(evalRes.days) ? evalRes.days : [];
      const range = monthRangeYmd(year, month);
      const startIso = taipeiDayStartIso(range.start);
      const endIso = taipeiDayStartIso(range.nextStart);
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
      let deletedAuditCount = 0;
      audits.forEach(function (a) {
        if (a && a.action === "ADMIN_DELETE") deletedAuditCount += 1;
      });

      let workDays = 0;
      let totalWorkMin = 0;
      let totalBreakMin = 0;
      let totalLateMin = 0;
      let totalEarlyMin = 0;
      let totalOtMin = 0;
      let incomplete = 0;
      let absentDays = 0;
      let offDays = 0;
      let restDays = 0;
      let holidayDays = 0;
      let nationalDays = 0;
      const rowsHtml = [];
      days.forEach(function (row) {
        if (!row) return;
        const ymd = ymdKey(row.work_date);
        const status = String(row.attendance_status || "");
        if (status === "OFF") offDays += 1;
        if (status === "ABSENT") absentDays += 1;
        if (status === "INCOMPLETE") incomplete += 1;
        if (row.day_type === "REST_DAY") restDays += 1;
        if (row.day_type === "REGULAR_HOLIDAY") holidayDays += 1;
        if (row.day_type === "NATIONAL_HOLIDAY") nationalDays += 1;
        if (status === "NORMAL" || status === "LATE" || status === "EARLY_LEAVE" || status === "LATE_AND_EARLY" || status === "INCOMPLETE") {
          workDays += 1;
        }
        totalWorkMin += Number(row.work_minutes) || 0;
        totalBreakMin += Number(row.break_minutes) || 0;
        totalLateMin += Number(row.late_minutes) || 0;
        totalEarlyMin += Number(row.early_leave_minutes) || 0;
        totalOtMin += Number(row.potential_overtime_minutes) || 0;
        const workText = status === "INCOMPLETE"
          ? (Number(row.work_minutes) > 0 ? minutesToDuration(row.work_minutes) : "—")
          : minutesToDuration(row.work_minutes);
        rowsHtml.push(
          "<tr>" +
          "<td>" + esc(ymd.replace(/-/g, "/")) + "</td>" +
          "<td>" + esc(weekdayZh(ymd)) + "</td>" +
          "<td>" + esc(evalShiftLabel(row)) + "</td>" +
          "<td>" + esc(evalScheduledTime(row)) + "</td>" +
          "<td>" + esc(evalDayTypeLabel(row.day_type)) + "</td>" +
          "<td>" + esc(evalLeaveLabel(row.leave_type)) + "</td>" +
          "<td>" + esc(row.actual_clock_in ? formatTaipeiClock(row.actual_clock_in) : "—") + "</td>" +
          "<td>" + esc(row.actual_clock_out ? formatTaipeiClock(row.actual_clock_out) : (status === "INCOMPLETE" ? "未完成" : "—")) + "</td>" +
          "<td>" + esc(minutesToDuration(row.break_minutes)) + "</td>" +
          "<td>" + esc(workText) + "</td>" +
          "<td>" + esc(minutesToDuration(row.late_minutes)) + "</td>" +
          "<td>" + esc(minutesToDuration(row.early_leave_minutes)) + "</td>" +
          "<td>" + esc(evalStatusText(row)) + "</td>" +
          "</tr>"
        );
      });

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
        "<th>日期</th><th>星期</th><th>預定班別</th><th>預定時間</th><th>日別</th><th>請假</th><th>實際上班</th><th>實際下班</th><th>休息</th><th>實際工時</th><th>遲到</th><th>早退</th><th>狀態</th>" +
        "</tr></thead><tbody>" + rowsHtml.join("") + "</tbody></table>" +
        '<div class="att-print-summary">' +
        "<div>出勤天數：" + workDays + "</div>" +
        "<div>本月排休總天數：" + offDays + "（公司目標月休 8 天，營運提醒，非法規判定）</div>" +
        "<div>休息日：" + restDays + "　　例假：" + holidayDays + "　　國定假日：" + nationalDays + "</div>" +
        "<div>未出勤天數：" + absentDays + "</div>" +
        "<div>總實際工時：" + esc(formatDurationHours(totalWorkMin * 60000)) + "（" + esc(formatDuration(totalWorkMin * 60000)) + "）</div>" +
        "<div>總休息時間：" + esc(formatDurationHours(totalBreakMin * 60000)) + "（" + esc(formatDuration(totalBreakMin * 60000)) + "）</div>" +
        "<div>遲到合計：" + esc(totalLateMin > 0 ? minutesToDuration(totalLateMin) : "0 分") + "</div>" +
        "<div>早退合計：" + esc(totalEarlyMin > 0 ? minutesToDuration(totalEarlyMin) : "0 分") + "</div>" +
        "<div>可能加班分鐘（未核准、不計薪）：" + esc(String(totalOtMin)) + "</div>" +
        "<div>未完成天數：" + incomplete + "</div>" +
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
    if ($("attSchedYear") && !$("attSchedYear").value) $("attSchedYear").value = String(y);
    if ($("attSchedMonth")) $("attSchedMonth").value = String(m);
    if ($("attDefFrom") && !$("attDefFrom").value) $("attDefFrom").value = now.ymd;
    const tomorrow = addDaysYmd(now.ymd, 1);
    ensureLeaveCalCursor();
    const yesterday = addDaysYmd(now.ymd, -1);
    if ($("attHistoricalLeaveDate") && !$("attHistoricalLeaveDate").value) {
      $("attHistoricalLeaveDate").value = yesterday;
    }
    if ($("attHistoricalLeaveDate")) $("attHistoricalLeaveDate").max = yesterday;
    if ($("attLeaveDirectDate") && !$("attLeaveDirectDate").value) $("attLeaveDirectDate").value = tomorrow;
    if ($("attCompProbFrom") && !$("attCompProbFrom").value) $("attCompProbFrom").value = now.ymd;
    if ($("attCompRaiseFrom") && !$("attCompRaiseFrom").value) $("attCompRaiseFrom").value = now.ymd;
    if ($("attPayrollYear") && !$("attPayrollYear").value) $("attPayrollYear").value = String(y);
    if ($("attPayrollMonth")) $("attPayrollMonth").value = String(m);
  }

  function scheduleApi() {
    const d = global.DK || {};
    if (typeof d.fetchAttendanceShiftTemplates !== "function"
        || typeof d.fetchEmployeeSchedules !== "function"
        || typeof d.createAttendanceShiftTemplate !== "function"
        || typeof d.updateAttendanceShiftTemplate !== "function"
        || typeof d.upsertEmployeeSchedule !== "function"
        || typeof d.deleteEmployeeSchedule !== "function"
        || typeof d.fetchEmployeeDefaultShiftPeriods !== "function"
        || typeof d.setEmployeeDefaultShift !== "function") {
      throw new Error("排班功能尚未就緒");
    }
    return d;
  }

  function leaveApi() {
    const d = global.DK || {};
    if (typeof d.fetchAttendanceLeaveRequests !== "function"
        || typeof d.requestAttendanceLeave !== "function"
        || typeof d.requestAttendanceLeaveBatch !== "function"
        || typeof d.cancelAttendanceLeaveRequest !== "function"
        || typeof d.approveAttendanceLeaveRequest !== "function"
        || typeof d.rejectAttendanceLeaveRequest !== "function"
        || typeof d.revokeAttendanceLeaveRequest !== "function"
        || typeof d.setEmployeeRestDay !== "function"
        || typeof d.createHistoricalLeave !== "function") {
      throw new Error("排休功能尚未就緒");
    }
    return d;
  }

  function compensationApi() {
    const d = global.DK || {};
    if (typeof d.fetchEmployeeCompensationPeriods !== "function"
        || typeof d.setEmployeeCompensationPlan !== "function"
        || typeof d.setEmployeeCompensationRaise !== "function") {
      throw new Error("薪資設定尚未就緒");
    }
    return d;
  }

  function payrollApi() {
    const d = global.DK || {};
    if (typeof d.previewPayrollMonth !== "function"
        || typeof d.fetchOvertimeCandidates !== "function"
        || typeof d.setOvertimeApproval !== "function"
        || typeof d.getPayrollSettlement !== "function"
        || typeof d.settlePayrollMonth !== "function") {
      throw new Error("薪資預覽尚未就緒");
    }
    return d;
  }

  function formatTimeHm(t) {
    if (t == null || t === "") return "—";
    const s = String(t).trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return s.length >= 5 ? s.slice(0, 5) : s;
    return pad2(Number(m[1])) + ":" + m[2];
  }

  function timeInputValue(t) {
    const hm = formatTimeHm(t);
    if (!hm || hm === "—") return "09:00";
    return hm;
  }

  function ensureTime24Selects() {
    function fill(sel, max, step) {
      if (!sel || sel.options.length) return;
      for (let i = 0; i < max; i += step) {
        const v = pad2(i);
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      }
    }
    fill($("attTplStartH"), 24, 1);
    fill($("attTplEndH"), 24, 1);
    fill($("attTplStartM"), 60, 1);
    fill($("attTplEndM"), 60, 1);
  }

  function setTime24(hId, mId, hm) {
    ensureTime24Selects();
    const t = timeInputValue(hm);
    if ($(hId)) $(hId).value = t.slice(0, 2);
    if ($(mId)) $(mId).value = t.slice(3, 5);
  }

  function readTime24(hId, mId) {
    ensureTime24Selects();
    const h = String(($(hId) && $(hId).value) || "");
    const mi = String(($(mId) && $(mId).value) || "");
    if (!h || !mi) return "";
    return h + ":" + mi;
  }

  function ymdKey(v) {
    return String(v || "").slice(0, 10);
  }

  function addDaysYmd(ymd, days) {
    const d = new Date(String(ymd || taipeiYmd(new Date())) + "T12:00:00+08:00");
    d.setTime(d.getTime() + (Number(days) || 0) * 24 * 60 * 60 * 1000);
    return taipeiYmd(d);
  }

  function weekdayZhYmd(ymd) {
    const d = new Date(String(ymd) + "T12:00:00+08:00");
    return WEEKDAY_ZH[d.getUTCDay()] || "";
  }

  function daysInMonthNum(year, month) {
    return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function enabledTemplates() {
    return (shiftTemplates || []).filter(function (t) { return t && t.enabled === true; });
  }

  function findTemplate(id) {
    return (shiftTemplates || []).find(function (t) { return t && String(t.id) === String(id); }) || null;
  }

  function scheduleMode(ymd, row) {
    const today = taipeiYmd(new Date());
    if (ymd < today) return "past";
    if (ymd === today) return row ? "today-frozen" : "today-open";
    return "future";
  }

  function templatePayloadFromForm(id) {
    const name = String(($("attTplName") && $("attTplName").value) || "").trim();
    const payload = {
      name: name,
      start_time: readTime24("attTplStartH", "attTplStartM"),
      end_time: readTime24("attTplEndH", "attTplEndM"),
      break_minutes: Number(($("attTplBreak") && $("attTplBreak").value) || 0),
      cross_midnight: ($("attTplCross") && $("attTplCross").value) === "1",
      late_grace_minutes: Number(($("attTplLate") && $("attTplLate").value) || 0),
      early_leave_grace_minutes: Number(($("attTplEarly") && $("attTplEarly").value) || 0),
      enabled: ($("attTplEnabled") && $("attTplEnabled").value) !== "0",
    };
    if (id) payload.id = id;
    return payload;
  }

  function resetTemplateForm() {
    if ($("attTplEditId")) $("attTplEditId").value = "";
    if ($("attTplFormTitle")) $("attTplFormTitle").textContent = "新增班別";
    if ($("attTplName")) $("attTplName").value = "";
    setTime24("attTplStartH", "attTplStartM", "09:00");
    setTime24("attTplEndH", "attTplEndM", "18:00");
    if ($("attTplBreak")) $("attTplBreak").value = "0";
    if ($("attTplCross")) $("attTplCross").value = "0";
    if ($("attTplLate")) $("attTplLate").value = "0";
    if ($("attTplEarly")) $("attTplEarly").value = "0";
    if ($("attTplEnabled")) $("attTplEnabled").value = "1";
    showMsg($("attTplFormMsg"), "", false);
  }

  function openTemplateForm(row) {
    if (!isAdmin()) return;
    const card = $("attTplFormCard");
    if (!card) return;
    resetTemplateForm();
    if (row) {
      if ($("attTplEditId")) $("attTplEditId").value = String(row.id || "");
      if ($("attTplFormTitle")) $("attTplFormTitle").textContent = "編輯班別";
      if ($("attTplName")) $("attTplName").value = row.name || "";
      setTime24("attTplStartH", "attTplStartM", row.start_time);
      setTime24("attTplEndH", "attTplEndM", row.end_time);
      if ($("attTplBreak")) $("attTplBreak").value = String(row.break_minutes == null ? 0 : row.break_minutes);
      if ($("attTplCross")) $("attTplCross").value = row.cross_midnight === true ? "1" : "0";
      if ($("attTplLate")) $("attTplLate").value = String(row.late_grace_minutes == null ? 0 : row.late_grace_minutes);
      if ($("attTplEarly")) $("attTplEarly").value = String(row.early_leave_grace_minutes == null ? 0 : row.early_leave_grace_minutes);
      if ($("attTplEnabled")) $("attTplEnabled").value = row.enabled === false ? "0" : "1";
    }
    card.hidden = false;
    if ($("attTplName")) $("attTplName").focus();
  }

  function closeTemplateForm() {
    if ($("attTplFormCard")) $("attTplFormCard").hidden = true;
    resetTemplateForm();
  }

  async function loadShiftTemplates() {
    if (!isAdmin()) {
      shiftTemplates = [];
      return;
    }
    shiftTemplates = await scheduleApi().fetchAttendanceShiftTemplates();
    fillDefTemplateSelect();
  }

  function renderShiftTemplates() {
    const tbody = $("attTplTbody");
    if (!tbody || !isAdmin()) return;
    if (!shiftTemplates.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">尚無班別</td></tr>';
      return;
    }
    tbody.innerHTML = shiftTemplates.map(function (t) {
      const on = t.enabled !== false;
      return (
        "<tr>" +
        "<td class=\"table-primary\">" + esc(t.name || "") + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTimeHm(t.start_time)) + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTimeHm(t.end_time)) + "</td>" +
        "<td class=\"table-number\">" + esc(String(t.break_minutes == null ? 0 : t.break_minutes)) + "</td>" +
        "<td>" + (t.cross_midnight === true ? "是" : "否") + "</td>" +
        "<td class=\"table-number\">" + esc(String(t.late_grace_minutes == null ? 0 : t.late_grace_minutes)) + "</td>" +
        "<td class=\"table-number\">" + esc(String(t.early_leave_grace_minutes == null ? 0 : t.early_leave_grace_minutes)) + "</td>" +
        "<td><span class=\"status-badge " + (on ? "status-success" : "status-muted") + "\">" + (on ? "啟用" : "停用") + "</span></td>" +
        "<td class=\"table-actions\">" +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm tertiary-action att-tpl-edit\" data-id=\"" + esc(t.id) + "\">編輯</button> " +
        "<button type=\"button\" class=\"btn btn-ghost btn-sm " + (on ? "danger-action" : "secondary-action") + " att-tpl-toggle\" data-id=\"" + esc(t.id) + "\" data-enabled=\"" + (on ? "0" : "1") + "\">" +
        (on ? "停用" : "啟用") +
        "</button>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  async function saveTemplateForm() {
    if (!isAdmin() || tplBusy) return;
    const id = String(($("attTplEditId") && $("attTplEditId").value) || "").trim();
    const payload = templatePayloadFromForm(id);
    tplBusy = true;
    showMsg($("attTplFormMsg"), "儲存中…", false);
    try {
      const api = scheduleApi();
      if (id) await api.updateAttendanceShiftTemplate(payload);
      else await api.createAttendanceShiftTemplate(payload);
      closeTemplateForm();
      await loadShiftTemplates();
      renderShiftTemplates();
      renderMonthlySchedule();
      showMsg($("attTplMsg"), id ? "班別已更新。" : "班別已新增。", false);
    } catch (e) {
      showMsg($("attTplFormMsg"), mapRpcError(e), true);
    } finally {
      tplBusy = false;
    }
  }

  async function toggleTemplateEnabled(id, enabled) {
    if (!isAdmin() || tplBusy || !id) return;
    tplBusy = true;
    showMsg($("attTplMsg"), "更新中…", false);
    try {
      await scheduleApi().updateAttendanceShiftTemplate({ id: id, enabled: enabled === true });
      await loadShiftTemplates();
      renderShiftTemplates();
      renderMonthlySchedule();
      showMsg($("attTplMsg"), enabled ? "班別已啟用。" : "班別已停用。", false);
    } catch (e) {
      showMsg($("attTplMsg"), mapRpcError(e), true);
    } finally {
      tplBusy = false;
    }
  }

  async function loadMonthlySchedule() {
    monthSchedules = [];
    monthDefaultPeriods = [];
    monthLeaveRequests = [];
    monthCompliance = null;
    if (!isAdmin()) return;
    const uid = String(($("attSchedEmployee") && $("attSchedEmployee").value) || "").trim();
    const year = Number($("attSchedYear") && $("attSchedYear").value);
    const month = Number($("attSchedMonth") && $("attSchedMonth").value);
    if (!uid || !year || !month) return;
    const last = daysInMonthNum(year, month);
    const from = year + "-" + pad2(month) + "-01";
    const to = year + "-" + pad2(month) + "-" + pad2(last);
    monthSchedules = await scheduleApi().fetchEmployeeSchedules(uid, from, to);
    try {
      monthDefaultPeriods = await scheduleApi().fetchEmployeeDefaultShiftPeriods(uid);
    } catch (_) {
      monthDefaultPeriods = [];
    }
    try {
      monthLeaveRequests = await leaveApi().fetchAttendanceLeaveRequests({ userId: uid });
    } catch (_) {
      monthLeaveRequests = [];
    }
    try {
      if (global.DK && typeof global.DK.fetchAttendanceScheduleCompliance === "function") {
        monthCompliance = await global.DK.fetchAttendanceScheduleCompliance(uid, from);
      }
    } catch (_) {
      monthCompliance = null;
    }
  }

  function approvedLeaveForDate(ymd) {
    const key = ymdKey(ymd);
    return (monthLeaveRequests || []).find(function (r) {
      return r && ymdKey(r.leave_date) === key && r.status === "APPROVED" && r.leave_type === "REST_DAY";
    }) || null;
  }

  function defaultShiftForDate(ymd) {
    const key = ymdKey(ymd);
    return (monthDefaultPeriods || []).find(function (p) {
      const from = ymdKey(p.effective_from);
      const to = p.effective_to ? ymdKey(p.effective_to) : "";
      return from && from <= key && (!to || to >= key);
    }) || null;
  }

  function fillDefTemplateSelect() {
    const sel = $("attDefTemplate");
    if (!sel || !isAdmin()) return;
    const keep = sel.value;
    const opts = ['<option value="">請選擇班別</option>'];
    const seen = {};
    enabledTemplates().forEach(function (t) {
      if (!t || !t.id || seen[t.id]) return;
      seen[t.id] = true;
      opts.push('<option value="' + esc(t.id) + '">' + esc(t.name || "") + "</option>");
    });
    sel.innerHTML = opts.join("");
    if (keep && seen[keep]) sel.value = keep;
  }

  function currentOpenDefaultPeriod() {
    return (defaultShiftPeriods || []).find(function (p) {
      return p && (p.effective_to == null || p.effective_to === "");
    }) || null;
  }

  async function loadDefaultShiftPeriods() {
    defaultShiftPeriods = [];
    if (!isAdmin()) return;
    const uid = String(($("attDefEmployee") && $("attDefEmployee").value) || "").trim();
    if (!uid) return;
    defaultShiftPeriods = await scheduleApi().fetchEmployeeDefaultShiftPeriods(uid);
  }

  function renderDefaultShift() {
    if (!isAdmin()) return;
    const uid = String(($("attDefEmployee") && $("attDefEmployee").value) || "").trim();
    const open = uid ? currentOpenDefaultPeriod() : null;
    if ($("attDefCurrentName")) $("attDefCurrentName").textContent = open ? (open.shift_name_snapshot || "—") : "—";
    if ($("attDefCurrentStart")) $("attDefCurrentStart").textContent = open ? formatTimeHm(open.scheduled_start_time) : "—";
    if ($("attDefCurrentEnd")) $("attDefCurrentEnd").textContent = open ? formatTimeHm(open.scheduled_end_time) : "—";
    if ($("attDefCurrentBreak")) $("attDefCurrentBreak").textContent = open && open.scheduled_break_minutes != null ? String(open.scheduled_break_minutes) : "—";
    if ($("attDefCurrentFrom")) $("attDefCurrentFrom").textContent = open ? ymdKey(open.effective_from).replace(/-/g, "/") : "—";
    if (open && $("attDefTemplate") && open.shift_template_id) {
      $("attDefTemplate").value = String(open.shift_template_id);
    }
    const tbody = $("attDefHistTbody");
    if (!tbody) return;
    if (!uid) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">請選擇員工</td></tr>';
      return;
    }
    if (!defaultShiftPeriods.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">尚未設定預設班別</td></tr>';
      return;
    }
    tbody.innerHTML = defaultShiftPeriods.map(function (p) {
      const to = p.effective_to ? ymdKey(p.effective_to).replace(/-/g, "/") : "迄今";
      return (
        "<tr>" +
        "<td>" + esc(p.shift_name_snapshot || "") + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTimeHm(p.scheduled_start_time)) + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTimeHm(p.scheduled_end_time)) + "</td>" +
        "<td class=\"nowrap\">" + esc(ymdKey(p.effective_from).replace(/-/g, "/")) + "</td>" +
        "<td class=\"nowrap\">" + esc(to) + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  async function refreshDefaultShiftUi(opts) {
    const silent = !!(opts && opts.silent);
    if (!isAdmin()) return;
    try {
      fillDefTemplateSelect();
      await loadDefaultShiftPeriods();
      renderDefaultShift();
      if (!silent) showMsg($("attDefMsg"), "", false);
    } catch (e) {
      renderDefaultShift();
      showMsg($("attDefMsg"), mapRpcError(e), true);
    }
  }

  async function saveDefaultShift() {
    if (!isAdmin() || defBusy) return;
    const uid = String(($("attDefEmployee") && $("attDefEmployee").value) || "").trim();
    const tplId = String(($("attDefTemplate") && $("attDefTemplate").value) || "").trim();
    const from = String(($("attDefFrom") && $("attDefFrom").value) || "").trim();
    if (!uid) {
      showMsg($("attDefMsg"), "請選擇員工。", true);
      return;
    }
    if (!tplId) {
      showMsg($("attDefMsg"), "請選擇班別。", true);
      return;
    }
    if (!from) {
      showMsg($("attDefMsg"), "請選擇生效日期。", true);
      return;
    }
    defBusy = true;
    showMsg($("attDefMsg"), "儲存中…", false);
    try {
      await scheduleApi().setEmployeeDefaultShift({
        user_id: uid,
        shift_template_id: tplId,
        effective_from: from,
      });
      await refreshDefaultShiftUi({ silent: true });
      if (String(($("attSchedEmployee") && $("attSchedEmployee").value) || "") === uid) {
        await refreshMonthlyScheduleUi({ silent: true });
      }
      showMsg($("attDefMsg"), "已儲存預設班別。", false);
    } catch (e) {
      showMsg($("attDefMsg"), mapRpcError(e), true);
    } finally {
      defBusy = false;
    }
  }

  function formatNtd(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return "NT$ " + Math.round(x).toLocaleString("zh-TW");
  }

  function parseMonthlySalary(raw) {
    const s = String(raw == null ? "" : raw).trim().replace(/,/g, "");
    if (!s) return null;
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 1 || n > 99999999) return null;
    return n;
  }

  function compensationStageLabel(stage) {
    if (stage === "PROBATION") return "試用期";
    if (stage === "REGULAR") return "正式";
    return stage || "—";
  }

  function compensationPayTypeLabel(t) {
    if (t === "MONTHLY") return "月薪";
    if (t === "HOURLY") return "時薪";
    return t || "—";
  }

  function compensationPeriodStatus(p) {
    const today = taipeiYmd(new Date());
    const from = ymdKey(p.effective_from);
    const to = p.effective_to ? ymdKey(p.effective_to) : "";
    if (from && from > today) return "未來";
    if (to && to < today) return "歷史";
    return "目前";
  }

  function currentCompensationPeriod() {
    const today = taipeiYmd(new Date());
    return (compensationPeriods || []).find(function (p) {
      const from = ymdKey(p.effective_from);
      const to = p.effective_to ? ymdKey(p.effective_to) : "";
      return from && from <= today && (!to || to >= today);
    }) || null;
  }

  function hasCompensationProbation() {
    return ($("attCompHasProbation") && $("attCompHasProbation").value) !== "0";
  }

  function syncCompensationProbationFields() {
    const wrap = $("attCompProbFields");
    if (wrap) wrap.hidden = !hasCompensationProbation();
  }

  function fillRegularFromProbationEnd() {
    if (!hasCompensationProbation()) return;
    const to = String(($("attCompProbTo") && $("attCompProbTo").value) || "").trim();
    if (!to) return;
    if ($("attCompRegFrom")) $("attCompRegFrom").value = addDaysYmd(to, 1);
  }

  async function loadCompensationPeriods() {
    compensationPeriods = [];
    if (!isAdmin()) return;
    const uid = String(($("attCompEmployee") && $("attCompEmployee").value) || "").trim();
    if (!uid) return;
    compensationPeriods = await compensationApi().fetchEmployeeCompensationPeriods(uid);
  }

  function renderCompensation() {
    if (!isAdmin()) return;
    const uid = String(($("attCompEmployee") && $("attCompEmployee").value) || "").trim();
    const cur = uid ? currentCompensationPeriod() : null;
    if ($("attCompCurrentStage")) $("attCompCurrentStage").textContent = cur ? compensationStageLabel(cur.employment_stage) : "—";
    if ($("attCompCurrentPay")) $("attCompCurrentPay").textContent = cur ? formatNtd(cur.monthly_salary) : "—";
    if ($("attCompCurrentFrom")) $("attCompCurrentFrom").textContent = cur ? ymdKey(cur.effective_from).replace(/-/g, "/") : "—";
    const tbody = $("attCompHistTbody");
    if (!tbody) return;
    if (!uid) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">請選擇員工</td></tr>';
      return;
    }
    if (!compensationPeriods.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">尚未設定約定薪資</td></tr>';
      return;
    }
    tbody.innerHTML = compensationPeriods.map(function (p) {
      const to = p.effective_to ? ymdKey(p.effective_to).replace(/-/g, "/") : "迄今";
      const st = compensationPeriodStatus(p);
      return (
        "<tr>" +
        "<td>" + esc(compensationStageLabel(p.employment_stage)) + "</td>" +
        "<td>" + esc(compensationPayTypeLabel(p.pay_type)) + "</td>" +
        "<td class=\"nowrap\">" + esc(formatNtd(p.monthly_salary)) + "</td>" +
        "<td class=\"nowrap\">" + esc(ymdKey(p.effective_from).replace(/-/g, "/")) + "</td>" +
        "<td class=\"nowrap\">" + esc(to) + "</td>" +
        "<td><span class=\"status-badge " + (st === "目前" ? "status-success" : st === "未來" ? "status-info" : "status-muted") + "\">" + esc(st) + "</span></td>" +
        "</tr>"
      );
    }).join("");
  }

  async function refreshCompensationUi(opts) {
    const silent = !!(opts && opts.silent);
    if (!isAdmin()) return;
    try {
      await loadCompensationPeriods();
      renderCompensation();
      syncCompensationProbationFields();
      if (!silent) showMsg($("attCompMsg"), "", false);
    } catch (e) {
      renderCompensation();
      showMsg($("attCompMsg"), mapRpcError(e), true);
    }
  }

  async function saveCompensationPlan() {
    if (!isAdmin() || compBusy) return;
    const uid = String(($("attCompEmployee") && $("attCompEmployee").value) || "").trim();
    if (!uid) {
      showMsg($("attCompMsg"), "請選擇員工。", true);
      return;
    }
    const hasProb = hasCompensationProbation();
    const regFrom = String(($("attCompRegFrom") && $("attCompRegFrom").value) || "").trim();
    const regPay = parseMonthlySalary($("attCompRegSalary") && $("attCompRegSalary").value);
    if (!regFrom) {
      showMsg($("attCompMsg"), "請選擇正式生效日。", true);
      return;
    }
    if (!regPay) {
      showMsg($("attCompMsg"), "請輸入有效的正式月薪（整數 NT$）。", true);
      return;
    }
    const payload = {
      user_id: uid,
      has_probation: hasProb,
      regular_from: regFrom,
      regular_monthly_salary: String(regPay),
    };
    if (hasProb) {
      const probFrom = String(($("attCompProbFrom") && $("attCompProbFrom").value) || "").trim();
      const probTo = String(($("attCompProbTo") && $("attCompProbTo").value) || "").trim();
      const probPay = parseMonthlySalary($("attCompProbSalary") && $("attCompProbSalary").value);
      if (!probFrom) {
        showMsg($("attCompMsg"), "請選擇試用開始日。", true);
        return;
      }
      if (!probTo) {
        showMsg($("attCompMsg"), "請選擇試用結束日。", true);
        return;
      }
      if (probTo < probFrom) {
        showMsg($("attCompMsg"), "試用結束日不可早於開始日。", true);
        return;
      }
      if (regFrom <= probTo) {
        showMsg($("attCompMsg"), "正式生效日必須晚於試用結束日。", true);
        return;
      }
      if (!probPay) {
        showMsg($("attCompMsg"), "請輸入有效的試用期月薪（整數 NT$）。", true);
        return;
      }
      payload.probation_from = probFrom;
      payload.probation_to = probTo;
      payload.probation_monthly_salary = String(probPay);
    }
    compBusy = true;
    showMsg($("attCompMsg"), "儲存中…", false);
    try {
      await compensationApi().setEmployeeCompensationPlan(payload);
      await refreshCompensationUi({ silent: true });
      showMsg($("attCompMsg"), "已儲存約定薪資。", false);
    } catch (e) {
      showMsg($("attCompMsg"), mapRpcError(e), true);
    } finally {
      compBusy = false;
    }
  }

  async function saveCompensationRaise() {
    if (!isAdmin() || compBusy) return;
    const uid = String(($("attCompEmployee") && $("attCompEmployee").value) || "").trim();
    const from = String(($("attCompRaiseFrom") && $("attCompRaiseFrom").value) || "").trim();
    const pay = parseMonthlySalary($("attCompRaiseSalary") && $("attCompRaiseSalary").value);
    if (!uid) {
      showMsg($("attCompMsg"), "請選擇員工。", true);
      return;
    }
    if (!from) {
      showMsg($("attCompMsg"), "請選擇調薪生效日。", true);
      return;
    }
    if (!pay) {
      showMsg($("attCompMsg"), "請輸入有效的調薪後月薪（整數 NT$）。", true);
      return;
    }
    compBusy = true;
    showMsg($("attCompMsg"), "調薪中…", false);
    try {
      await compensationApi().setEmployeeCompensationRaise({
        user_id: uid,
        effective_from: from,
        employment_stage: "REGULAR",
        monthly_salary: String(pay),
      });
      await refreshCompensationUi({ silent: true });
      showMsg($("attCompMsg"), "已新增調薪期間，歷史月薪未覆蓋。", false);
    } catch (e) {
      showMsg($("attCompMsg"), mapRpcError(e), true);
    } finally {
      compBusy = false;
    }
  }

  function payrollPersonLabel(id) {
    if (!id) return "員工";
    const me = currentUser();
    if (me && String(me.userId) === String(id)) return me.displayName || me.username || "員工";
    const p = profileMap[String(id)];
    if (p) return p.displayName || p.username || "員工";
    return "員工";
  }

  function payrollMd(ymd) {
    const s = ymdKey(ymd);
    if (!s || s.length < 10) return "—";
    return s.slice(5, 7) + "/" + s.slice(8, 10);
  }

  function payrollClipRange(seg, monthStart, monthEnd) {
    const from = ymdKey(seg && seg.effective_from) || monthStart;
    const toRaw = seg && seg.effective_to ? ymdKey(seg.effective_to) : monthEnd;
    const start = from > monthStart ? from : monthStart;
    const end = toRaw && toRaw < monthEnd ? toRaw : monthEnd;
    return payrollMd(start) + "～" + payrollMd(end);
  }

  function payrollSegmentsHtml(segs, monthStart, monthEnd) {
    const list = Array.isArray(segs) ? segs : [];
    if (!list.length) return "<div>—</div>";
    const multi = list.length > 1;
    return (multi ? "<div>本月含多個薪資期間</div>" : "") +
      list.map(function (s) {
        return "<div>" + esc(payrollClipRange(s, monthStart, monthEnd)) + "　" +
          esc(compensationStageLabel(s.employment_stage)) + "　" +
          esc(formatNtd(s.monthly_salary)) + "</div>";
      }).join("");
  }

  function payrollGrossNote() {
    return '<p class="muted att-payroll-note">目前未包含勞健保、所得稅及其他代扣項目。</p>';
  }

  function setPayrollStatus(text, settled) {
    const el = $("attPayrollStatus");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "att-payroll-status" + (settled ? " is-settled" : "");
    el.textContent = text;
  }

  function setPayrollActions(mode) {
    const wrap = $("attPayrollActions");
    const settle = $("attPayrollSettle");
    const view = $("attPayrollViewDaily");
    const print = $("attPayrollPrint");
    if (!wrap) return;
    if (mode === "none") {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    if (settle) settle.hidden = mode !== "ready";
    if (view) view.hidden = mode !== "settled";
    if (print) print.hidden = mode !== "settled";
  }

  function payrollSnapshotOf(settlement) {
    const snap = settlement && settlement.snapshot_json;
    return snap && typeof snap === "object" ? snap : {};
  }

  function payrollMonthBoundsFromData(data, fallbackMonth) {
    const monthRaw = (data && data.month) || fallbackMonth || "";
    const start = ymdKey(monthRaw) || String(monthRaw || "").slice(0, 10);
    if (!start || start.length < 10) return { start: "", end: "" };
    const y = Number(start.slice(0, 4));
    const m = Number(start.slice(5, 7));
    const range = monthRangeYmd(y, m);
    return { start: range.start, end: range.end };
  }

  function payrollPairText(pair) {
    if (!pair || typeof pair !== "object") return formatNtd(0);
    if (pair.display != null && pair.display !== "") return formatNtd(pair.display);
    return formatNtd(pair.raw);
  }

  function payrollOtTypeLabel(t) {
    if (t === "WEEKDAY") return "平日加班";
    if (t === "REST_DAY") return "休息日出勤";
    if (t === "NATIONAL_HOLIDAY") return "國定假日出勤";
    if (t === "REGULAR_HOLIDAY") return "例假出勤";
    return t || "—";
  }

  function payrollOtStatusLabel(s) {
    if (s === "APPROVED") return "已核准";
    if (s === "REJECTED") return "不認列";
    if (s === "PENDING") return "待確認";
    return "待確認";
  }

  function payrollReviewItems(flags) {
    const f = flags || {};
    const items = [];
    if (f.overtime_review_required) items.push({ text: "有待確認加班", code: "overtime_review_required" });
    if (f.incomplete_attendance) items.push({ text: "出勤資料未完成", code: "incomplete_attendance" });
    if (f.regular_holiday_work) items.push({ text: "例假出勤", code: "regular_holiday_work" });
    if (f.sick_leave_over_30) items.push({ text: "病假超過30日需人工確認", code: "sick_leave_over_30" });
    if (f.personal_leave_over_14) items.push({ text: "事假超過14日需人工確認", code: "personal_leave_over_14" });
    if (f.compensation_missing) items.push({ text: "缺少薪資設定", code: "compensation_missing" });
    if (f.holiday_work_review_required) items.push({ text: "國定假日出勤待確認", code: "holiday_work_review_required" });
    if (f.overtime_limit_review_required) items.push({ text: "加班超過可安全判斷範圍需人工確認", code: "overtime_limit_review_required" });
    return items;
  }

  function payrollDayMoney(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let n = 0;
    Object.keys(obj).forEach(function (k) {
      n += Number(obj[k]) || 0;
    });
    return n;
  }

  function renderPayrollAmounts(data, extraCardsHtml) {
    const summary = $("attPayrollSummary");
    const dedEl = $("attPayrollDeductions");
    const addEl = $("attPayrollAdditional");
    if (!data) {
      if (summary) { summary.hidden = true; summary.innerHTML = ""; }
      if (dedEl) { dedEl.hidden = true; dedEl.innerHTML = ""; }
      if (addEl) { addEl.hidden = true; addEl.innerHTML = ""; }
      return;
    }
    const bounds = payrollMonthBoundsFromData(data);
    const segs = Array.isArray(data.compensation_segments) ? data.compensation_segments : [];
    const ctr = data.counters || {};
    const deds = data.deductions || {};
    const adds = data.additional_pay || {};
    const gross = payrollPairText(data.totals && data.totals.gross_pay_before_other_items);
    if (summary) {
      summary.hidden = false;
      summary.innerHTML =
        '<div class="att-payroll-grid">' +
        '<div class="att-payroll-card"><div class="muted small">薪資階段</div>' + payrollSegmentsHtml(segs, bounds.start, bounds.end) + "</div>" +
        '<div class="att-payroll-card"><div class="muted small">基本薪資</div><div>' + esc(payrollPairText(data.base_salary)) + "</div></div>" +
        '<div class="att-payroll-card"><div class="muted small">扣款</div><div>' + esc(payrollPairText(data.totals && data.totals.total_deductions)) + "</div></div>" +
        '<div class="att-payroll-card"><div class="muted small">加給</div><div>' + esc(payrollPairText(data.totals && data.totals.total_additional_pay)) + "</div></div>" +
        '<div class="att-payroll-card"><div class="muted small">本系統計算應發薪資</div><div>' + esc(gross) + "</div>" + payrollGrossNote() + "</div>" +
        (extraCardsHtml || "") +
        "</div>";
    }
    if (dedEl) {
      dedEl.hidden = false;
      dedEl.innerHTML =
        "<h4 class=\"h4\" style=\"margin-top:16px\">扣款</h4>" +
        '<div class="table-wrap att-admin-table-wrap"><table class="table table-compact"><thead><tr><th>項目</th><th>天數／分鐘</th><th>金額</th></tr></thead><tbody>' +
        "<tr><td>病假</td><td>" + esc(String(ctr.sick_leave_days || 0) + " 天") + "</td><td>" + esc(payrollPairText(deds.sick_leave)) + "</td></tr>" +
        "<tr><td>事假</td><td>" + esc(String(ctr.personal_leave_days || 0) + " 天") + "</td><td>" + esc(payrollPairText(deds.personal_leave)) + "</td></tr>" +
        "<tr><td>遲到</td><td>" + esc(minutesToDuration(ctr.late_minutes)) + "</td><td>" + esc(payrollPairText(deds.late)) + "</td></tr>" +
        "<tr><td>早退</td><td>" + esc(minutesToDuration(ctr.early_leave_minutes)) + "</td><td>" + esc(payrollPairText(deds.early_leave)) + "</td></tr>" +
        "<tr><td>曠職</td><td>—</td><td>" + esc(payrollPairText(deds.absence)) + "</td></tr>" +
        "</tbody></table></div>";
    }
    if (addEl) {
      addEl.hidden = false;
      addEl.innerHTML =
        "<h4 class=\"h4\" style=\"margin-top:16px\">加給</h4>" +
        '<div class="table-wrap att-admin-table-wrap"><table class="table table-compact"><thead><tr><th>項目</th><th>核准分鐘／天數</th><th>金額</th></tr></thead><tbody>' +
        "<tr><td>平日加班</td><td>" + esc(String(ctr.approved_weekday_overtime_minutes || 0) + " 分") + "</td><td>" + esc(payrollPairText(adds.weekday_overtime)) + "</td></tr>" +
        "<tr><td>休息日出勤</td><td>" + esc(String(ctr.approved_rest_day_minutes || 0) + " 分") + "</td><td>" + esc(payrollPairText(adds.rest_day_work)) + "</td></tr>" +
        "<tr><td>國定假日出勤</td><td>" + esc(String(ctr.approved_national_holiday_days || 0) + " 天") + "</td><td>" + esc(payrollPairText(adds.national_holiday_work)) + "</td></tr>" +
        "</tbody></table></div>";
    }
  }

  function renderPayrollPreview(data, candidates) {
    if (!isAdmin()) return;
    lastPayrollPreview = data || null;
    lastPayrollSettlement = null;
    lastPayslipHtml = "";
    lastOtCandidates = (candidates && Array.isArray(candidates.rows)) ? candidates.rows : (Array.isArray(candidates) ? candidates : []);
    const review = $("attPayrollReview");
    const otWrap = $("attPayrollOt");
    const dailyWrap = $("attPayrollDailyWrap");
    if (!data) {
      setPayrollStatus("", false);
      setPayrollActions("none");
      if (review) review.hidden = true;
      renderPayrollAmounts(null);
      if (otWrap) otWrap.hidden = true;
      if (dailyWrap) dailyWrap.hidden = true;
      return;
    }
    const flags = data.review_flags || {};
    const ready = data.payroll_ready === true;
    const reasons = payrollReviewItems(flags);
    setPayrollStatus("未結算", false);
    setPayrollActions(ready ? "ready" : "none");
    if (review) {
      review.hidden = false;
      review.className = "att-payroll-review" + (ready ? " is-ready" : "");
      if (ready) {
        review.innerHTML = "<strong>Payroll Ready</strong>：本月預覽已無阻擋結算的待確認項目（尚未結算）。";
      } else {
        review.innerHTML = "<strong>本月尚不可結算</strong><ul>" + reasons.map(function (r) {
          return "<li>" + esc(r.text) + '<span class="att-payroll-code">' + esc(r.code) + "</span></li>";
        }).join("") + "</ul>";
      }
    }
    renderPayrollAmounts(data, '<div class="att-payroll-card"><div class="muted small">Payroll Ready</div><div>' + (ready ? "是" : "否") + "</div></div>");
    renderPayrollOtTable(lastOtCandidates, false);
    const dailyEl = $("attPayrollDailyWrap");
    if (dailyEl) {
      const sum = dailyEl.querySelector("summary");
      if (sum) sum.textContent = "每日明細";
    }
    renderPayrollDaily(Array.isArray(data.daily_breakdown) ? data.daily_breakdown : []);
  }

  function renderPayrollSettled(settlement) {
    if (!isAdmin()) return;
    lastPayrollSettlement = settlement || null;
    lastPayrollPreview = null;
    lastOtCandidates = [];
    const review = $("attPayrollReview");
    const snap = payrollSnapshotOf(settlement);
    const preview = (snap.preview && typeof snap.preview === "object") ? snap.preview : snap;
    const empId = String(($("attPayrollEmployee") && $("attPayrollEmployee").value) || settlement.user_id || "");
    setPayrollStatus("已結算", true);
    setPayrollActions("settled");
    if (review) {
      review.hidden = false;
      review.className = "att-payroll-review is-settled";
      review.innerHTML =
        "<strong>本月份已結算</strong>。如需修正請使用後續薪資更正流程。" +
        "<div class=\"muted att-payroll-note\">結算時間：" + esc(formatTaipeiDateTime(settlement.settled_at)) +
        "　結算人員：" + esc(payrollPersonLabel(settlement.settled_by)) + "</div>";
    }
    const extra =
      '<div class="att-payroll-card"><div class="muted small">結算時間</div><div>' + esc(formatTaipeiDateTime(settlement.settled_at)) + "</div></div>" +
      '<div class="att-payroll-card"><div class="muted small">結算人員</div><div>' + esc(payrollPersonLabel(settlement.settled_by)) + "</div></div>";
    const displayPreview = {
      month: snap.month || preview.month || settlement.payroll_month,
      compensation_segments: snap.compensation_segments || preview.compensation_segments || [],
      base_salary: { display: settlement.display_base_salary, raw: settlement.base_salary },
      deductions: snap.deductions || preview.deductions || {},
      additional_pay: snap.additional_pay || preview.additional_pay || {},
      totals: {
        total_deductions: { display: settlement.display_total_deductions, raw: settlement.total_deductions },
        total_additional_pay: { display: settlement.display_total_additional_pay, raw: settlement.total_additional_pay },
        gross_pay_before_other_items: { display: settlement.display_gross_pay_before_other_items, raw: settlement.gross_pay_before_other_items }
      },
      counters: snap.counters || preview.counters || {}
    };
    renderPayrollAmounts(displayPreview, extra);
    const otRows = Array.isArray(snap.overtime_approvals) ? snap.overtime_approvals : [];
    renderPayrollOtTable(otRows, true);
    const dailyEl = $("attPayrollDailyWrap");
    if (dailyEl) {
      const sum = dailyEl.querySelector("summary");
      if (sum) sum.textContent = "出勤與薪資明細";
    }
    renderPayrollDaily(Array.isArray(snap.daily_breakdown) ? snap.daily_breakdown : []);
    lastPayslipHtml = buildPayslipHtml(settlement, empId);
  }

  function renderPayrollOtTable(rows, readOnly) {
    const wrap = $("attPayrollOt");
    const tbody = $("attPayrollOtTbody");
    if (!wrap || !tbody) return;
    wrap.hidden = false;
    const list = rows || [];
    const title = wrap.querySelector("h4");
    if (title) title.textContent = readOnly ? "加班確認（結算快照）" : "待確認加班";
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">' + (readOnly ? "本月沒有加班紀錄" : "本月沒有加班候選") + "</td></tr>";
      return;
    }
    tbody.innerHTML = list.map(function (r) {
      const ymd = ymdKey(r.work_date);
      const type = r.overtime_type;
      const cand = Number(r.candidate_minutes) || 0;
      const status = r.status || "";
      if (readOnly || !r.actionable) {
        const reason = !r.actionable && type === "REGULAR_HOLIDAY"
          ? "例假出勤－需人工確認"
          : payrollOtStatusLabel(status);
        return "<tr>" +
          "<td class=\"nowrap\">" + esc(ymd.replace(/-/g, "/")) + "</td>" +
          "<td>" + esc(payrollOtTypeLabel(type)) + "</td>" +
          "<td>" + esc(r.scheduled_end || "—") + "</td>" +
          "<td>" + esc(r.actual_clock_out ? formatTaipeiClock(r.actual_clock_out) : "—") + "</td>" +
          "<td>" + esc(String(cand)) + "</td>" +
          "<td>" + esc(r.approved_minutes != null ? String(r.approved_minutes) : "—") + "</td>" +
          "<td>" + esc(reason) + "</td>" +
          "<td class=\"muted\">" + (readOnly ? "已結算" : "本 Stage 不提供一鍵核准") + "</td>" +
          "</tr>";
      }
      const pending = !status || status === "PENDING";
      const defaultMin = (r.approved_minutes != null && status === "APPROVED")
        ? r.approved_minutes
        : cand;
      const ops =
        '<button type="button" class="btn btn-primary btn-sm att-ot-approve" data-date="' + esc(ymd) + '" data-type="' + esc(type) + '">核准</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm danger-action att-ot-reject" data-date="' + esc(ymd) + '" data-type="' + esc(type) + '">不認列</button>';
      return "<tr>" +
        "<td class=\"nowrap\">" + esc(ymd.replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(payrollOtTypeLabel(type)) + "</td>" +
        "<td>" + esc(r.scheduled_end || "—") + "</td>" +
        "<td>" + esc(r.actual_clock_out ? formatTaipeiClock(r.actual_clock_out) : "—") + "</td>" +
        "<td>" + esc(String(cand)) + "</td>" +
        "<td><input class=\"att-ot-minutes\" type=\"number\" min=\"0\" step=\"1\" value=\"" + esc(String(defaultMin)) + "\"></td>" +
        "<td>" + esc(pending ? "待確認" : payrollOtStatusLabel(status)) + "</td>" +
        "<td class=\"table-actions\">" + ops + "</td>" +
        "</tr>";
    }).join("");
  }

  function renderPayrollDaily(days) {
    const wrap = $("attPayrollDailyWrap");
    const tbody = $("attPayrollDailyTbody");
    if (!wrap || !tbody) return;
    wrap.hidden = false;
    if (!days.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="muted">無資料</td></tr>';
      return;
    }
    tbody.innerHTML = days.map(function (row) {
      const ymd = ymdKey(row.work_date);
      const ot = row.overtime_approval || {};
      const cand = ot.candidate_minutes != null ? ot.candidate_minutes : row.potential_overtime_minutes;
      const approved = ot.status === "APPROVED" ? ot.approved_minutes : (ot.status === "REJECTED" ? 0 : null);
      const inOut = (row.actual_clock_in ? formatTaipeiClock(row.actual_clock_in) : "—") +
        " / " + (row.actual_clock_out ? formatTaipeiClock(row.actual_clock_out) : "—");
      const shift = row.shift_name || evalShiftLabel(row);
      const ded = payrollDayMoney(row.deductions);
      const add = payrollDayMoney(row.additional_pay);
      return "<tr>" +
        "<td class=\"nowrap\">" + esc(ymd.replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(evalDayTypeLabel(row.day_type)) + "</td>" +
        "<td>" + esc(shift) + "</td>" +
        "<td class=\"nowrap\">" + esc(inOut) + "</td>" +
        "<td>" + esc(minutesToDuration(row.actual_work_minutes)) + "</td>" +
        "<td>" + esc(evalLeaveLabel(row.leave_type)) + "</td>" +
        "<td>" + esc(minutesToDuration(row.late_minutes)) + "</td>" +
        "<td>" + esc(minutesToDuration(row.early_leave_minutes)) + "</td>" +
        "<td>" + esc(cand ? String(cand) + " 分" : "—") + "</td>" +
        "<td>" + esc(approved == null ? "—" : String(approved) + " 分") + "</td>" +
        "<td>" + esc(formatNtd(ded)) + "</td>" +
        "<td>" + esc(formatNtd(add)) + "</td>" +
        "<td>" + esc(evalStatusText(row)) + "</td>" +
        "</tr>";
    }).join("");
  }

  async function runPayrollPreview() {
    if (!isAdmin() || payrollBusy) return;
    const year = Number($("attPayrollYear") && $("attPayrollYear").value);
    const month = Number($("attPayrollMonth") && $("attPayrollMonth").value);
    const empId = String(($("attPayrollEmployee") && $("attPayrollEmployee").value) || "").trim();
    if (!Number.isFinite(year) || year < 2020 || !Number.isFinite(month) || month < 1 || month > 12) {
      showMsg($("attPayrollMsg"), "請選擇有效的年份與月份。", true);
      return;
    }
    if (!empId) {
      showMsg($("attPayrollMsg"), "請選擇員工。", true);
      return;
    }
    payrollBusy = true;
    showMsg($("attPayrollMsg"), "載入中…", false);
    try {
      const monthYmd = year + "-" + String(month).padStart(2, "0") + "-01";
      let settled = null;
      try {
        settled = await payrollApi().getPayrollSettlement(empId, monthYmd);
      } catch (e) {
        const raw = String((e && (e.message || e.code || e.error)) || e || "");
        if (!/pgrst202|could not find the function|backoffice_get_payroll_settlement|payroll_settlements/i.test(raw)) {
          throw e;
        }
      }
      if (settled && settled.found) {
        renderPayrollSettled(settled);
        showMsg($("attPayrollMsg"), "已載入已結算薪資。", false);
        return;
      }
      const preview = await payrollApi().previewPayrollMonth(empId, monthYmd);
      const cands = await payrollApi().fetchOvertimeCandidates(empId, monthYmd);
      renderPayrollPreview(preview, cands);
      showMsg($("attPayrollMsg"), "已更新薪資預覽。", false);
    } catch (e) {
      showMsg($("attPayrollMsg"), mapRpcError(e), true);
    } finally {
      payrollBusy = false;
    }
  }

  async function settlePayrollMonthUi() {
    if (!isAdmin() || payrollBusy) return;
    if (lastPayrollSettlement && lastPayrollSettlement.found) {
      showMsg($("attPayrollMsg"), "本月份已結算，如需修正請使用後續薪資更正流程。", true);
      return;
    }
    if (!lastPayrollPreview || lastPayrollPreview.payroll_ready !== true) {
      showMsg($("attPayrollMsg"), "本月尚不可結算。", true);
      return;
    }
    const empId = String(($("attPayrollEmployee") && $("attPayrollEmployee").value) || "").trim();
    const year = Number($("attPayrollYear") && $("attPayrollYear").value);
    const month = Number($("attPayrollMonth") && $("attPayrollMonth").value);
    if (!empId || !Number.isFinite(year) || !Number.isFinite(month)) {
      showMsg($("attPayrollMsg"), "請選擇員工與月份。", true);
      return;
    }
    const previewEmp = lastPayrollPreview && lastPayrollPreview.employee && lastPayrollPreview.employee.user_id;
    if (String(previewEmp || "") !== empId) {
      showMsg($("attPayrollMsg"), "請先重新計算目前選擇員工的薪資預覽。", true);
      return;
    }
    const ok = global.confirm("結算後，本月份薪資將凍結，不會因後續打卡、班表或薪資設定修改而自動變更。確定結算？");
    if (!ok) return;
    payrollBusy = true;
    showMsg($("attPayrollMsg"), "月結中…", false);
    try {
      const monthYmd = year + "-" + String(month).padStart(2, "0") + "-01";
      const result = await payrollApi().settlePayrollMonth(empId, monthYmd);
      renderPayrollSettled(result);
      showMsg($("attPayrollMsg"), "本月份已結算。", false);
    } catch (e) {
      showMsg($("attPayrollMsg"), mapRpcError(e), true);
    } finally {
      payrollBusy = false;
    }
  }

  function viewPayrollDaily() {
    const wrap = $("attPayrollDailyWrap");
    if (!wrap) return;
    wrap.hidden = false;
    wrap.open = true;
    try { wrap.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
  }

  function buildPayslipHtml(settlement, empId) {
    const snap = payrollSnapshotOf(settlement);
    const preview = (snap.preview && typeof snap.preview === "object") ? snap.preview : snap;
    const bounds = payrollMonthBoundsFromData({ month: snap.month || preview.month || settlement.payroll_month });
    const monthLabel = bounds.start ? bounds.start.slice(0, 4) + " / " + bounds.start.slice(5, 7) : "—";
    const empName = payrollPersonLabel(empId);
    const segs = Array.isArray(snap.compensation_segments) ? snap.compensation_segments : [];
    const ctr = snap.counters || preview.counters || {};
    const leave = snap.leave_summary || {};
    const att = snap.attendance_summary || {};
    const deds = snap.deductions || preview.deductions || {};
    const adds = snap.additional_pay || preview.additional_pay || {};
    const days = Array.isArray(snap.daily_breakdown) ? snap.daily_breakdown : [];
    const approvedOt =
      (Number(att.approved_weekday_overtime_minutes) || 0) +
      (Number(att.approved_rest_day_minutes) || 0);
    const settleDate = formatTaipeiDate(settlement.settled_at ? new Date(settlement.settled_at) : new Date());
    const dailyRows = days.map(function (row) {
      const ymd = ymdKey(row.work_date);
      const ot = row.overtime_approval || {};
      const approved = ot.status === "APPROVED" ? ot.approved_minutes : (ot.status === "REJECTED" ? 0 : null);
      const shift = row.shift_name || evalShiftLabel(row);
      return "<tr>" +
        "<td class=\"nowrap\">" + esc(ymd.replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(evalDayTypeLabel(row.day_type)) + "</td>" +
        "<td>" + esc(shift) + "</td>" +
        "<td>" + esc(evalLeaveLabel(row.leave_type)) + "</td>" +
        "<td>" + esc(minutesToDuration(row.actual_work_minutes)) + "</td>" +
        "<td>" + esc(minutesToDuration(row.late_minutes)) + "</td>" +
        "<td>" + esc(minutesToDuration(row.early_leave_minutes)) + "</td>" +
        "<td>" + esc(approved == null ? "—" : String(approved) + " 分") + "</td>" +
        "<td>" + esc(formatNtd(payrollDayMoney(row.deductions))) + "</td>" +
        "<td>" + esc(formatNtd(payrollDayMoney(row.additional_pay))) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="att-print-doc att-payslip-doc">' +
      "<h1>DK Computer</h1>" +
      "<h2>薪資單</h2>" +
      '<div class="att-print-meta">薪資月份：' + esc(monthLabel) +
      "　　員工：" + esc(empName) + "</div>" +
      '<div class="att-print-meta">薪資階段：' + (segs.length > 1 ? "本月含多個薪資期間" : esc(compensationStageLabel(settlement.employment_stage || (segs[0] && segs[0].employment_stage)))) + "</div>" +
      (segs.length ? ('<div class="att-print-summary">' + segs.map(function (s) {
        return esc(payrollClipRange(s, bounds.start, bounds.end)) + "　" +
          esc(compensationStageLabel(s.employment_stage)) + "　" +
          "約定月薪 " + esc(formatNtd(s.monthly_salary));
      }).join("<br>") + "</div>") : "") +
      '<div class="att-print-summary">' +
      "基本薪資：" + esc(formatNtd(settlement.display_base_salary)) + "<br>" +
      "扣款：<br>" +
      "　病假 " + esc(payrollPairText(deds.sick_leave)) + "<br>" +
      "　事假 " + esc(payrollPairText(deds.personal_leave)) + "<br>" +
      "　遲到 " + esc(payrollPairText(deds.late)) + "<br>" +
      "　早退 " + esc(payrollPairText(deds.early_leave)) + "<br>" +
      "　曠職 " + esc(payrollPairText(deds.absence)) + "<br>" +
      "加給：<br>" +
      "　平日加班 " + esc(payrollPairText(adds.weekday_overtime)) + "<br>" +
      "　休息日出勤 " + esc(payrollPairText(adds.rest_day_work)) + "<br>" +
      "　國定假日出勤 " + esc(payrollPairText(adds.national_holiday_work)) +
      "</div>" +
      '<div class="att-print-summary">' +
      "總扣款：" + esc(formatNtd(settlement.display_total_deductions)) + "<br>" +
      "總加給：" + esc(formatNtd(settlement.display_total_additional_pay)) + "<br>" +
      "<strong>本系統計算應發薪資：" + esc(formatNtd(settlement.display_gross_pay_before_other_items)) + "</strong><br>" +
      '<span class="att-payslip-note">目前未包含勞健保、所得稅及其他代扣項目。</span>' +
      "</div>" +
      '<div class="att-print-summary">' +
      "出勤摘要：<br>" +
      "出勤天數 " + esc(String(att.work_days != null ? att.work_days : 0)) +
      "　排休天數 " + esc(String(att.off_days != null ? att.off_days : 0)) +
      "　病假天數 " + esc(String(leave.sick_leave_days != null ? leave.sick_leave_days : (ctr.sick_leave_days || 0))) +
      "　事假天數 " + esc(String(leave.personal_leave_days != null ? leave.personal_leave_days : (ctr.personal_leave_days || 0))) +
      "　特休天數 " + esc(String(leave.annual_leave_days != null ? leave.annual_leave_days : (ctr.annual_leave_days || 0))) + "<br>" +
      "遲到分鐘 " + esc(String(att.late_minutes != null ? att.late_minutes : (ctr.late_minutes || 0))) +
      "　早退分鐘 " + esc(String(att.early_leave_minutes != null ? att.early_leave_minutes : (ctr.early_leave_minutes || 0))) +
      "　核准加班分鐘 " + esc(String(approvedOt)) + "<br>" +
      "結算日期：" + esc(settleDate) +
      "</div>" +
      '<div class="att-payslip-daily">' +
      "<h2>出勤與薪資明細</h2>" +
      '<table class="att-print-table"><thead><tr>' +
      "<th>日期</th><th>日別</th><th>班別</th><th>請假</th><th>實際工時</th><th>遲到</th><th>早退</th><th>核准加班</th><th>扣款</th><th>加給</th>" +
      "</tr></thead><tbody>" +
      (dailyRows || '<tr><td colspan="10">無資料</td></tr>') +
      "</tbody></table></div></div>";
  }

  function printPayrollPayslip() {
    if (!isAdmin()) {
      showMsg($("attPayrollMsg"), "只有管理員可以列印薪資單。", true);
      return;
    }
    if (!lastPayrollSettlement || !lastPayrollSettlement.found) {
      showMsg($("attPayrollMsg"), "請先完成月結後再列印薪資單。", true);
      return;
    }
    const empId = String(($("attPayrollEmployee") && $("attPayrollEmployee").value) || "").trim();
    if (!empId || String(lastPayrollSettlement.user_id) !== empId) {
      showMsg($("attPayrollMsg"), "請先載入目前選擇員工的已結算薪資。", true);
      return;
    }
    lastPayslipHtml = buildPayslipHtml(lastPayrollSettlement, empId);
    const root = $("attPrintRoot");
    const sheet = $("attPrintSheet");
    if (sheet) sheet.innerHTML = lastPayslipHtml;
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

  async function decideOvertime(ymd, type, status, minutes) {
    if (!isAdmin() || payrollBusy || !ymd || !type) return;
    if (lastPayrollSettlement && lastPayrollSettlement.found) {
      showMsg($("attPayrollMsg"), "本月份已結算，無法再修改加班確認。", true);
      return;
    }
    const empId = String(($("attPayrollEmployee") && $("attPayrollEmployee").value) || "").trim();
    if (!empId) {
      showMsg($("attPayrollMsg"), "請選擇員工。", true);
      return;
    }
    payrollBusy = true;
    showMsg($("attPayrollMsg"), status === "REJECTED" ? "不認列中…" : "核准中…", false);
    try {
      const payload = { user_id: empId, work_date: ymd, overtime_type: type, status: status };
      if (status === "APPROVED") payload.approved_minutes = minutes;
      await payrollApi().setOvertimeApproval(payload);
      payrollBusy = false;
      await runPayrollPreview();
    } catch (e) {
      showMsg($("attPayrollMsg"), mapRpcError(e), true);
      payrollBusy = false;
    }
  }

  function scheduleByDate() {
    const map = {};
    (monthSchedules || []).forEach(function (row) {
      if (!row) return;
      map[ymdKey(row.work_date)] = row;
    });
    return map;
  }

  function templateSelectHtml(ymd, selectedId) {
    const opts = ['<option value="">選擇班別</option>'];
    enabledTemplates().forEach(function (t) {
      const sel = selectedId && String(t.id) === String(selectedId) ? " selected" : "";
      opts.push('<option value="' + esc(t.id) + '"' + sel + ">" + esc(t.name || "") + "</option>");
    });
    return '<select class="att-sched-tpl" data-date="' + esc(ymd) + '">' + opts.join("") + "</select>";
  }

  function renderMonthlySchedule() {
    const tbody = $("attSchedTbody");
    if (!tbody || !isAdmin()) return;
    const uid = String(($("attSchedEmployee") && $("attSchedEmployee").value) || "").trim();
    const year = Number($("attSchedYear") && $("attSchedYear").value);
    const month = Number($("attSchedMonth") && $("attSchedMonth").value);
    if (!uid) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">請選擇員工</td></tr>';
      renderScheduleCompliance();
      return;
    }
    if (!year || !month) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">請選擇年月</td></tr>';
      renderScheduleCompliance();
      return;
    }
    const last = daysInMonthNum(year, month);
    const byDate = scheduleByDate();
    const rows = [];
    for (let day = 1; day <= last; day++) {
      const ymd = year + "-" + pad2(month) + "-" + pad2(day);
      const row = byDate[ymd] || null;
      const def = row ? null : defaultShiftForDate(ymd);
      const mode = scheduleMode(ymd, row);
      const readonly = mode === "past" || mode === "today-frozen";
      let nameLabel = "未設定";
      let srcLabel = "—";
      let srcClass = "status-muted";
      let startLabel = "—";
      let endLabel = "—";
      if (row && row.schedule_type === "WORK") {
        nameLabel = row.shift_name_snapshot || "WORK";
        srcLabel = "例外";
        srcClass = "status-info";
        startLabel = formatTimeHm(row.scheduled_start_time);
        endLabel = formatTimeHm(row.scheduled_end_time);
      } else if (row && row.schedule_type === "OFF") {
        nameLabel = evalDayTypeLabel(row.day_type);
        srcLabel = row.day_type ? evalDayTypeLabel(row.day_type) : "未分類";
        srcClass = row.day_type ? "status-muted" : "status-warning";
      } else if (def) {
        nameLabel = def.shift_name_snapshot || "預設";
        srcLabel = "預設";
        srcClass = "status-success";
        startLabel = formatTimeHm(def.scheduled_start_time);
        endLabel = formatTimeHm(def.scheduled_end_time);
      }
      let ops = "";
      if (readonly) {
        ops = '<span class="muted small att-sched-readonly">唯讀</span>';
      } else if (row && row.schedule_type === "OFF") {
        const leave = approvedLeaveForDate(ymd);
        if (leave && mode === "future") {
          ops = '<button type="button" class="btn btn-ghost btn-sm danger-action att-sched-revoke" data-leave-id="' + esc(leave.id) + '">撤銷排休</button>';
        } else if (row && mode === "future") {
          ops = ' <button type="button" class="btn btn-ghost btn-sm danger-action att-sched-clear" data-id="' + esc(row.id) + '" data-date="' + esc(ymd) + '">清除例外</button>';
        }
      } else {
        const currentTpl = row && row.schedule_type === "WORK"
          ? row.shift_template_id
          : (def ? def.shift_template_id : "");
        ops = '<div class="att-sched-ops">' +
          templateSelectHtml(ymd, currentTpl) +
          '<button type="button" class="btn btn-ghost btn-sm att-sched-assign" data-date="' + esc(ymd) + '">指定例外</button>';
        if (row && mode === "future") {
          ops += ' <button type="button" class="btn btn-ghost btn-sm danger-action att-sched-clear" data-id="' + esc(row.id) + '" data-date="' + esc(ymd) + '">清除例外</button>';
        }
        ops += "</div>";
      }
      rows.push(
        "<tr>" +
        "<td class=\"nowrap\">" + esc(ymd.replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(weekdayZhYmd(ymd)) + "</td>" +
        "<td>" + esc(nameLabel) + "</td>" +
        "<td><span class=\"status-badge " + srcClass + " att-src-" + (srcLabel === "例外" ? "exception" : srcLabel === "預設" ? "default" : "leave") + "\">" + esc(srcLabel) + "</span></td>" +
        "<td class=\"nowrap\">" + esc(startLabel) + "</td>" +
        "<td class=\"nowrap\">" + esc(endLabel) + "</td>" +
        "<td class=\"table-actions\">" + ops + "</td>" +
        "</tr>"
      );
    }
    tbody.innerHTML = rows.join("");
    renderScheduleCompliance();
  }

  function renderScheduleCompliance() {
    const box = $("attSchedCompliance");
    if (!box || !isAdmin()) return;
    const uid = String(($("attSchedEmployee") && $("attSchedEmployee").value) || "").trim();
    if (!uid || !monthCompliance) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const c = monthCompliance;
    const alerts = Array.isArray(c.alerts) ? c.alerts : [];
    let html = '<div class="muted small">排班提醒（STANDARD_WEEK 檢查，非正式法規證明）</div>';
    html += '<div class="att-sched-counts">' +
      "本月排休總天數：" + esc(String(c.off_days == null ? 0 : c.off_days)) +
      "　　休息日：" + esc(String(c.rest_day_count || 0)) +
      "　　例假：" + esc(String(c.regular_holiday_count || 0)) +
      "　　國定假日：" + esc(String(c.national_holiday_count || 0)) +
      "　　公司目標月休 " + esc(String(c.company_month_rest_target || 8)) + " 天（營運提醒）" +
      "</div>";
    if (!alerts.length) {
      html += '<div class="status-badge status-success">正常</div>';
    } else {
      html += '<ul class="att-sched-alerts">';
      alerts.forEach(function (a) {
        html += "<li>⚠ " + esc((a && a.message) || "") + "</li>";
      });
      html += "</ul>";
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  async function refreshMonthlyScheduleUi(opts) {
    const silent = !!(opts && opts.silent);
    if (!isAdmin()) return;
    try {
      await loadMonthlySchedule();
      renderMonthlySchedule();
      if (!silent) showMsg($("attSchedMsg"), "", false);
    } catch (e) {
      renderMonthlySchedule();
      showMsg($("attSchedMsg"), mapRpcError(e), true);
    }
  }

  async function assignWorkSchedule(ymd, templateId) {
    if (!isAdmin() || schedBusy) return;
    const uid = String(($("attSchedEmployee") && $("attSchedEmployee").value) || "").trim();
    const tplId = String(templateId || "").trim();
    if (!uid) {
      showMsg($("attSchedMsg"), "請選擇員工。", true);
      return;
    }
    if (!tplId) {
      showMsg($("attSchedMsg"), "請選擇班別。", true);
      return;
    }
    const existing = scheduleByDate()[ymd];
    if (existing && existing.schedule_type === "OFF") {
      showMsg($("attSchedMsg"), "該日已是排休，不可直接改成例外上班。請先撤銷排休。", true);
      return;
    }
    schedBusy = true;
    showMsg($("attSchedMsg"), "儲存排班中…", false);
    try {
      await scheduleApi().upsertEmployeeSchedule({
        user_id: uid,
        work_date: ymd,
        schedule_type: "WORK",
        shift_template_id: tplId,
      });
      await refreshMonthlyScheduleUi({ silent: true });
      showMsg($("attSchedMsg"), "已指定班別。", false);
    } catch (e) {
      showMsg($("attSchedMsg"), mapRpcError(e), true);
    } finally {
      schedBusy = false;
    }
  }

  async function clearWorkSchedule(id) {
    if (!isAdmin() || schedBusy || !id) return;
    schedBusy = true;
    showMsg($("attSchedMsg"), "清除中…", false);
    try {
      await scheduleApi().deleteEmployeeSchedule(id);
      await refreshMonthlyScheduleUi({ silent: true });
      showMsg($("attSchedMsg"), "已清除排班。", false);
    } catch (e) {
      showMsg($("attSchedMsg"), mapRpcError(e), true);
    } finally {
      schedBusy = false;
    }
  }

  function leaveTypeLabel(t) {
    if (t === "REST_DAY") return "排休";
    if (t === "SICK_LEAVE") return "病假";
    if (t === "PERSONAL_LEAVE") return "事假";
    if (t === "ANNUAL_LEAVE") return "特休";
    return t || "—";
  }

  function isWorkdayLeaveType(t) {
    return t === "SICK_LEAVE" || t === "PERSONAL_LEAVE" || t === "ANNUAL_LEAVE";
  }

  function leaveReasonText(r) {
    const s = r && r.reason != null ? String(r.reason).trim() : "";
    const hist = r && r.historical_entry_reason != null ? String(r.historical_entry_reason).trim() : "";
    if (r && r.entry_source === "ADMIN_HISTORICAL" && hist) {
      return (s || "—") + "（補登：" + hist + "）";
    }
    return s || "—";
  }

  function syncLeaveQuotaHint() {
    const hint = $("attLeaveQuotaHint");
    if (!hint) return;
    const type = String(($("attLeaveType") && $("attLeaveType").value) || "");
    hint.hidden = type !== "ANNUAL_LEAVE";
  }

  function leaveStatusLabel(s) {
    if (s === "PENDING") return "待核准";
    if (s === "APPROVED") return "已核准";
    if (s === "REJECTED") return "已駁回";
    if (s === "CANCELLED") return "已取消";
    return s || "—";
  }

  function leaveStatusClass(s) {
    if (s === "PENDING") return "status-warning";
    if (s === "APPROVED") return "status-success";
    if (s === "REJECTED") return "status-danger";
    return "status-muted";
  }

  function sortLeaveRows(rows) {
    const rank = { PENDING: 0, APPROVED: 1, REJECTED: 2, CANCELLED: 3 };
    return (rows || []).slice().sort(function (a, b) {
      const ra = rank[a.status] != null ? rank[a.status] : 9;
      const rb = rank[b.status] != null ? rank[b.status] : 9;
      if (ra !== rb) return ra - rb;
      const da = ymdKey(b.leave_date).localeCompare(ymdKey(a.leave_date));
      if (da) return da;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
  }

  async function loadMyLeaveRequests() {
    myLeaveRequests = [];
    const me = currentUser();
    const uid = String((me && me.userId) || "").trim();
    if (!uid) return;
    myLeaveRequests = await leaveApi().fetchAttendanceLeaveRequests({ userId: uid });
  }

  async function loadAdminLeaveRequests() {
    adminLeaveRequests = [];
    if (!isAdmin()) return;
    adminLeaveRequests = await leaveApi().fetchAttendanceLeaveRequests();
  }

  function leaveBatchConflictYmd(err, raw) {
    const fromDetails = err && err.details != null ? String(err.details) : "";
    const blob = fromDetails + " " + String(raw || "");
    const m = blob.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function formatLeaveChip(ymd) {
    const s = ymdKey(ymd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return String(Number(s.slice(5, 7))) + "/" + String(Number(s.slice(8, 10)));
  }

  function ensureLeaveCalCursor() {
    if (leaveCalYear && leaveCalMonth) return;
    const now = taipeiYmd(new Date());
    leaveCalYear = Number(now.slice(0, 4));
    leaveCalMonth = Number(now.slice(5, 7));
  }

  function shiftLeaveCalMonth(delta) {
    ensureLeaveCalCursor();
    let y = leaveCalYear;
    let m = leaveCalMonth + Number(delta || 0);
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    leaveCalYear = y;
    leaveCalMonth = m;
    renderLeaveCalendar();
  }

  function selectedLeaveDates() {
    return Object.keys(leaveSelectedDates).filter(function (k) {
      return leaveSelectedDates[k];
    }).sort();
  }

  function activeLeaveStatusByDate() {
    const map = {};
    (myLeaveRequests || []).forEach(function (r) {
      if (!r) return;
      const key = ymdKey(r.leave_date);
      if (!key) return;
      if (r.status === "PENDING" || r.status === "APPROVED") map[key] = r.status;
    });
    return map;
  }

  function toggleLeaveDate(ymd) {
    const key = ymdKey(ymd);
    if (!key) return;
    const today = taipeiYmd(new Date());
    if (key <= today) return;
    const blocked = activeLeaveStatusByDate();
    if (blocked[key] === "PENDING" || blocked[key] === "APPROVED") return;
    if (leaveSelectedDates[key]) delete leaveSelectedDates[key];
    else leaveSelectedDates[key] = true;
    renderLeaveCalendar();
  }

  function syncLeaveSelectionUi() {
    const dates = selectedLeaveDates();
    const summary = $("attLeaveSelectedSummary");
    if (summary) summary.textContent = "已選 " + dates.length + " 天";
    const chips = $("attLeaveSelectedChips");
    if (chips) {
      chips.innerHTML = dates.map(function (ymd) {
        return '<button type="button" class="att-leave-chip" data-ymd="' + esc(ymd) + '">' +
          esc(formatLeaveChip(ymd)) + " ×</button>";
      }).join("");
    }
    const btn = $("attLeaveSubmit");
    if (btn) {
      btn.textContent = dates.length ? ("送出 " + dates.length + " 天申請") : "送出申請";
      btn.disabled = dates.length === 0;
    }
  }

  function renderLeaveCalendar() {
    ensureLeaveCalCursor();
    const title = $("attLeaveCalTitle");
    if (title) title.textContent = leaveCalYear + "/" + pad2(leaveCalMonth);
    const grid = $("attLeaveCalGrid");
    if (!grid) {
      syncLeaveSelectionUi();
      return;
    }
    const today = taipeiYmd(new Date());
    const blocked = activeLeaveStatusByDate();
    const first = leaveCalYear + "-" + pad2(leaveCalMonth) + "-01";
    const lead = new Date(first + "T12:00:00+08:00").getUTCDay();
    const dim = daysInMonthNum(leaveCalYear, leaveCalMonth);
    const cells = [];
    let i;
    for (i = 0; i < lead; i += 1) cells.push('<div class="att-leave-cal-blank"></div>');
    for (i = 1; i <= dim; i += 1) {
      const ymd = leaveCalYear + "-" + pad2(leaveCalMonth) + "-" + pad2(i);
      const status = blocked[ymd] || "";
      const isPastOrToday = ymd <= today;
      const isBlocked = status === "PENDING" || status === "APPROVED";
      const selectable = !isPastOrToday && !isBlocked;
      const selected = !!leaveSelectedDates[ymd];
      const cls = ["att-leave-cal-cell"];
      if (ymd === today) cls.push("is-today");
      if (isPastOrToday) cls.push("is-disabled");
      if (isBlocked) cls.push("is-blocked");
      if (selected && selectable) cls.push("is-selected");
      let dot = "";
      if (status === "PENDING") dot = '<span class="att-leave-cal-dot is-pending" aria-hidden="true"></span>';
      else if (status === "APPROVED") dot = '<span class="att-leave-cal-dot is-approved" aria-hidden="true"></span>';
      const label = isBlocked
        ? (status === "PENDING" ? "已有待核准申請" : "已核准")
        : (isPastOrToday ? "不可申請" : (selected ? "已選取" : "可申請"));
      cells.push(
        '<button type="button" class="' + cls.join(" ") + '" data-ymd="' + esc(ymd) + '"' +
        (selectable ? "" : " disabled") +
        ' aria-pressed="' + (selected && selectable ? "true" : "false") + '"' +
        ' aria-label="' + esc(ymd.replace(/-/g, "/") + " " + label) + '">' +
        i + dot + "</button>"
      );
    }
    grid.innerHTML = cells.join("");
    syncLeaveSelectionUi();
  }

  function renderMyLeave() {
    renderLeaveCalendar();
    const tbody = $("attLeaveTbody");
    if (!tbody) return;
    const rows = sortLeaveRows(myLeaveRequests);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">尚無申請</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      const canCancel = r.status === "PENDING";
      const op = canCancel
        ? '<button type="button" class="btn btn-ghost btn-sm att-leave-cancel" data-id="' + esc(r.id) + '">取消</button>'
        : "—";
      return (
        "<tr>" +
        "<td class=\"nowrap\">" + esc(ymdKey(r.leave_date).replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(leaveTypeLabel(r.leave_type)) + "</td>" +
        "<td><span class=\"status-badge " + leaveStatusClass(r.status) + "\">" + esc(leaveStatusLabel(r.status)) + "</span></td>" +
        "<td class=\"nowrap\">" + esc(formatTaipeiDateTime(r.created_at)) + "</td>" +
        "<td class=\"table-actions\">" + op + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderAdminLeave() {
    const tbody = $("attLeaveAdminTbody");
    if (!tbody || !isAdmin()) return;
    let rows = sortLeaveRows(adminLeaveRequests);
    if (selectedEmpId && lastAttPane === "people") {
      rows = rows.filter(function (r) { return r && String(r.user_id) === String(selectedEmpId); });
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">尚無申請</td></tr>';
      return;
    }
    const today = taipeiYmd(new Date());
    tbody.innerHTML = rows.map(function (r) {
      let ops = "—";
      if (r.status === "PENDING") {
        const daySel = r.leave_type === "REST_DAY"
          ? '<select class="att-leave-daytype" aria-label="日別">' +
            '<option value="REST_DAY">休息日</option>' +
            '<option value="REGULAR_HOLIDAY">例假</option>' +
            "</select> "
          : "";
        ops = daySel +
          '<button type="button" class="btn btn-primary btn-sm att-leave-approve" data-id="' + esc(r.id) + '">核准</button>' +
          ' <button type="button" class="btn btn-ghost btn-sm danger-action att-leave-reject" data-id="' + esc(r.id) + '">駁回</button>';
      } else if (r.status === "APPROVED" && ymdKey(r.leave_date) > today) {
        ops = '<button type="button" class="btn btn-ghost btn-sm danger-action att-leave-revoke" data-id="' + esc(r.id) + '">撤銷</button>';
      }
      return (
        "<tr>" +
        "<td>" + esc(personName(r.user_id)) + "</td>" +
        "<td class=\"nowrap\">" + esc(ymdKey(r.leave_date).replace(/-/g, "/")) + "</td>" +
        "<td>" + esc(leaveTypeLabel(r.leave_type)) +
        (r.entry_source === "ADMIN_HISTORICAL" ? "<span class=\"att-leave-hist-badge\">管理員補登</span>" : "") +
        "</td>" +
        "<td><span class=\"status-badge " + leaveStatusClass(r.status) + "\">" + esc(leaveStatusLabel(r.status)) + "</span></td>" +
        "<td>" + esc(leaveReasonText(r)) + "</td>" +
        "<td class=\"nowrap\">" + esc(formatTaipeiDateTime(r.created_at)) + "</td>" +
        "<td class=\"table-actions\">" + ops + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  async function refreshAfterLeaveChange(userId) {
    try {
      await loadMyLeaveRequests();
      renderMyLeave();
    } catch (e) {
      showMsg($("attLeaveMsg"), mapRpcError(e), true);
    }
    if (isAdmin()) {
      try {
        await loadAdminLeaveRequests();
        renderAdminLeave();
      } catch (e) {
        showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
      }
      try {
        renderPeopleOverview();
        renderEmpOverview();
      } catch (_) {}
      const schedUid = String(($("attSchedEmployee") && $("attSchedEmployee").value) || "").trim();
      if (userId && schedUid === String(userId)) {
        await refreshMonthlyScheduleUi({ silent: true });
      }
    }
  }

  async function submitMyLeave() {
    if (leaveBusy) return;
    const dates = selectedLeaveDates();
    const type = String(($("attLeaveType") && $("attLeaveType").value) || "").trim() || "REST_DAY";
    const reason = String(($("attLeaveReason") && $("attLeaveReason").value) || "").trim();
    if (!dates.length) {
      showMsg($("attLeaveMsg"), "請先在月曆選擇日期。", true);
      return;
    }
    if (type !== "REST_DAY" && !isWorkdayLeaveType(type)) {
      showMsg($("attLeaveMsg"), "請假類型無效。", true);
      return;
    }
    leaveBusy = true;
    showMsg($("attLeaveMsg"), "送出中…", false);
    try {
      const payload = { dates: dates, leave_type: type };
      if (reason) payload.reason = reason;
      await leaveApi().requestAttendanceLeaveBatch(payload);
      leaveSelectedDates = {};
      if ($("attLeaveReason")) $("attLeaveReason").value = "";
      await refreshAfterLeaveChange();
      renderLeaveCalendar();
      showMsg($("attLeaveMsg"), "已送出 " + dates.length + " 天申請", false);
    } catch (e) {
      showMsg($("attLeaveMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function cancelMyLeave(id) {
    if (leaveBusy || !id) return;
    leaveBusy = true;
    showMsg($("attLeaveMsg"), "取消中…", false);
    try {
      await leaveApi().cancelAttendanceLeaveRequest(id);
      await refreshAfterLeaveChange();
      showMsg($("attLeaveMsg"), "已取消申請。", false);
    } catch (e) {
      showMsg($("attLeaveMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function approveLeave(id, dayType) {
    if (!isAdmin() || leaveBusy || !id) return;
    const row = (adminLeaveRequests || []).find(function (r) { return r && String(r.id) === String(id); });
    const type = row && row.leave_type;
    const day = String(dayType || "").trim();
    if (type === "REST_DAY" && !day) {
      showMsg($("attLeaveAdminMsg"), "請選擇日別（休息日或例假）。", true);
      return;
    }
    leaveBusy = true;
    showMsg($("attLeaveAdminMsg"), "核准中…", false);
    try {
      await leaveApi().approveAttendanceLeaveRequest(id, type === "REST_DAY" ? day : "");
      await refreshAfterLeaveChange(row && row.user_id);
      showMsg($("attLeaveAdminMsg"), "已核准申請。", false);
    } catch (e) {
      showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function rejectLeave(id) {
    if (!isAdmin() || leaveBusy || !id) return;
    leaveBusy = true;
    showMsg($("attLeaveAdminMsg"), "駁回中…", false);
    try {
      await leaveApi().rejectAttendanceLeaveRequest(id);
      await refreshAfterLeaveChange();
      showMsg($("attLeaveAdminMsg"), "已駁回申請。", false);
    } catch (e) {
      showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function revokeLeave(id) {
    if (!isAdmin() || leaveBusy || !id) return;
    const row = (adminLeaveRequests || []).find(function (r) { return r && String(r.id) === String(id); })
      || (monthLeaveRequests || []).find(function (r) { return r && String(r.id) === String(id); });
    leaveBusy = true;
    showMsg($("attLeaveAdminMsg") || $("attSchedMsg"), "撤銷中…", false);
    try {
      await leaveApi().revokeAttendanceLeaveRequest(id);
      await refreshAfterLeaveChange(row && row.user_id);
      showMsg($("attLeaveAdminMsg"), "已撤銷申請。", false);
      showMsg($("attSchedMsg"), "已撤銷排休。", false);
    } catch (e) {
      showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
      showMsg($("attSchedMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function refreshLoadedMonthlyReport(userId, leaveDate) {
    if (!isAdmin() || !lastReportHtml) return;
    const empId = String(($("attReportEmployee") && $("attReportEmployee").value) || "").trim();
    const year = Number($("attReportYear") && $("attReportYear").value);
    const month = Number($("attReportMonth") && $("attReportMonth").value);
    const ymd = ymdKey(leaveDate);
    if (!empId || empId !== String(userId) || !ymd) return;
    if (!Number.isFinite(year) || !Number.isFinite(month)) return;
    if (Number(ymd.slice(0, 4)) !== year || Number(ymd.slice(5, 7)) !== month) return;
    try {
      await generateMonthlyReport();
    } catch (_) {}
  }

  async function submitHistoricalLeave() {
    if (!isAdmin() || leaveBusy) return;
    const uid = String(($("attHistoricalLeaveEmployee") && $("attHistoricalLeaveEmployee").value) || "").trim();
    const ymd = String(($("attHistoricalLeaveDate") && $("attHistoricalLeaveDate").value) || "").trim();
    const type = String(($("attHistoricalLeaveType") && $("attHistoricalLeaveType").value) || "").trim();
    const reason = String(($("attHistoricalLeaveReason") && $("attHistoricalLeaveReason").value) || "").trim();
    const histReason = String(($("attHistoricalLeaveNote") && $("attHistoricalLeaveNote").value) || "").trim();
    if (!uid) {
      showMsg($("attHistoricalLeaveMsg"), "請選擇員工。", true);
      return;
    }
    if (!ymd) {
      showMsg($("attHistoricalLeaveMsg"), "請選擇日期。", true);
      return;
    }
    if (!isWorkdayLeaveType(type)) {
      showMsg($("attHistoricalLeaveMsg"), "歷史補登僅能選擇病假、事假或特休。", true);
      return;
    }
    if (!histReason) {
      showMsg($("attHistoricalLeaveMsg"), "請填補登原因。", true);
      return;
    }
    leaveBusy = true;
    showMsg($("attHistoricalLeaveMsg"), "補登中…", false);
    try {
      const payload = {
        user_id: uid,
        leave_date: ymd,
        leave_type: type,
        historical_reason: histReason,
      };
      if (reason) payload.reason = reason;
      await leaveApi().createHistoricalLeave(payload);
      if ($("attHistoricalLeaveReason")) $("attHistoricalLeaveReason").value = "";
      if ($("attHistoricalLeaveNote")) $("attHistoricalLeaveNote").value = "";
      const yday = addDaysYmd(taipeiYmd(new Date()), -1);
      if ($("attHistoricalLeaveDate")) {
        $("attHistoricalLeaveDate").value = yday;
        $("attHistoricalLeaveDate").max = yday;
      }
      await refreshAfterLeaveChange(uid);
      await refreshLoadedMonthlyReport(uid, ymd);
      showMsg($("attHistoricalLeaveMsg"), "歷史請假補登成功", false);
    } catch (e) {
      showMsg($("attHistoricalLeaveMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  async function setDirectRestDay() {
    if (!isAdmin() || leaveBusy) return;
    const uid = String(($("attLeaveDirectEmployee") && $("attLeaveDirectEmployee").value) || "").trim();
    const ymd = String(($("attLeaveDirectDate") && $("attLeaveDirectDate").value) || "").trim();
    const dayType = String(($("attLeaveDirectDayType") && $("attLeaveDirectDayType").value) || "").trim();
    if (!uid) {
      showMsg($("attLeaveAdminMsg"), "請選擇員工。", true);
      return;
    }
    if (!ymd) {
      showMsg($("attLeaveAdminMsg"), "請選擇日期。", true);
      return;
    }
    if (!dayType) {
      showMsg($("attLeaveAdminMsg"), "請選擇日別（休息日或例假）。", true);
      return;
    }
    leaveBusy = true;
    showMsg($("attLeaveAdminMsg"), "設定排休中…", false);
    try {
      await leaveApi().setEmployeeRestDay({ user_id: uid, leave_date: ymd, day_type: dayType });
      await refreshAfterLeaveChange(uid);
      showMsg($("attLeaveAdminMsg"), "已直接設定排休。", false);
    } catch (e) {
      showMsg($("attLeaveAdminMsg"), mapRpcError(e), true);
    } finally {
      leaveBusy = false;
    }
  }

  function hhmm(v) {
    const s = String(v || "");
    return s.length >= 5 ? s.slice(0, 5) : (s || "");
  }

  function enabledEmployeeIds() {
    return Object.keys(profileMap).filter(function (id) {
      const p = profileMap[id];
      return p && p.enabled !== false;
    }).sort(function (a, b) {
      return String(personName(a)).localeCompare(String(personName(b)), "zh-Hant");
    });
  }

  function todayShiftsForUser(uid) {
    const ymd = taipeiYmd(new Date());
    return (adminShifts || []).filter(function (s) {
      return s && String(s.employee_id) === String(uid) && shiftOverlapsDay(s, ymd);
    });
  }

  function defaultPeriodForUser(uid) {
    const today = taipeiYmd(new Date());
    const rows = (overviewDefaults || []).filter(function (p) {
      if (!p || String(p.user_id) !== String(uid)) return false;
      const from = ymdKey(p.effective_from);
      const to = p.effective_to ? ymdKey(p.effective_to) : "";
      return from && from <= today && (!to || to >= today);
    }).sort(function (a, b) {
      return String(ymdKey(b.effective_from)).localeCompare(String(ymdKey(a.effective_from)));
    });
    return rows[0] || null;
  }

  function todayScheduleForUser(uid) {
    const today = taipeiYmd(new Date());
    return (overviewTodaySchedules || []).find(function (s) {
      return s && String(s.user_id) === String(uid) && ymdKey(s.work_date) === today;
    }) || null;
  }

  function pendingLeaveCount(uid) {
    return (adminLeaveRequests || []).filter(function (r) {
      return r && String(r.user_id) === String(uid) && r.status === "PENDING";
    }).length;
  }

  function monthLeaveCount(uid, type) {
    const now = taipeiYmd(new Date());
    const from = now.slice(0, 8) + "01";
    const y = Number(now.slice(0, 4));
    const m = Number(now.slice(5, 7));
    const to = now.slice(0, 8) + pad2(daysInMonthNum(y, m));
    return (adminLeaveRequests || []).filter(function (r) {
      if (!r || String(r.user_id) !== String(uid) || r.status !== "APPROVED") return false;
      const d = ymdKey(r.leave_date);
      if (d < from || d > to) return false;
      if (type === "REST_DAY") return r.leave_type === "REST_DAY";
      return r.leave_type === type;
    }).length;
  }

  function employeeTodayStatus(uid) {
    const today = taipeiYmd(new Date());
    const approved = (adminLeaveRequests || []).filter(function (r) {
      return r && String(r.user_id) === String(uid) && ymdKey(r.leave_date) === today && r.status === "APPROVED";
    });
    if (approved.some(function (r) { return r.leave_type === "SICK_LEAVE" || r.leave_type === "PERSONAL_LEAVE" || r.leave_type === "ANNUAL_LEAVE"; })) {
      return "今日請假";
    }
    const sched = todayScheduleForUser(uid);
    if (approved.some(function (r) { return r.leave_type === "REST_DAY"; }) || (sched && sched.schedule_type === "OFF")) {
      return "今日排休";
    }
    const shifts = todayShiftsForUser(uid);
    const open = openShiftOf(shifts);
    if (open) {
      const br = breaksForShift(open.id, adminBreaks);
      if (openBreakOf(br)) return "休息中";
      return "上班中";
    }
    if (shifts.some(function (s) { return s && s.clock_out_at; })) return "已下班";
    if (sched && sched.schedule_type === "WORK") return "尚未上班";
    if (defaultPeriodForUser(uid)) return "尚未上班";
    return "未排班";
  }

  function employeeTodayShiftLabel(uid) {
    const sched = todayScheduleForUser(uid);
    if (sched && sched.schedule_type === "OFF") return "排休";
    if (sched && sched.schedule_type === "WORK") {
      const name = sched.shift_name_snapshot || "例外上班";
      const span = hhmm(sched.scheduled_start_time) && hhmm(sched.scheduled_end_time)
        ? hhmm(sched.scheduled_start_time) + "–" + hhmm(sched.scheduled_end_time)
        : "";
      return span ? (name + " " + span) : name;
    }
    const def = defaultPeriodForUser(uid);
    if (!def) return "—";
    const span = hhmm(def.scheduled_start_time) && hhmm(def.scheduled_end_time)
      ? hhmm(def.scheduled_start_time) + "–" + hhmm(def.scheduled_end_time)
      : "";
    return span ? ((def.shift_name_snapshot || "預設班") + " " + span) : (def.shift_name_snapshot || "預設班");
  }

  function employeeTodayClock(uid, field) {
    const shifts = todayShiftsForUser(uid).slice().sort(function (a, b) {
      return new Date(a.clock_in_at) - new Date(b.clock_in_at);
    });
    if (!shifts.length) return "—";
    if (field === "in") return formatTaipeiClock(shifts[0].clock_in_at);
    const last = shifts[shifts.length - 1];
    if (!last.clock_out_at) return "—";
    return formatTaipeiClock(last.clock_out_at);
  }

  function statusBadgeClass(label) {
    if (label === "上班中") return "status-success";
    if (label === "休息中" || label === "今日請假") return "status-warning";
    if (label === "已下班") return "status-info";
    if (label === "今日排休") return "status-muted";
    return "status-muted";
  }

  async function loadOverviewExtras() {
    overviewDefaults = [];
    overviewTodaySchedules = [];
    if (!isAdmin()) return;
    const today = taipeiYmd(new Date());
    try {
      overviewDefaults = await fetchRows("employee_default_shift_periods", {
        select: "id,user_id,shift_template_id,effective_from,effective_to,shift_name_snapshot,scheduled_start_time,scheduled_end_time",
        apply: function (q) {
          return q.lte("effective_from", today).limit(400);
        },
      });
    } catch (_) { overviewDefaults = []; }
    try {
      overviewTodaySchedules = await fetchRows("employee_schedules", {
        select: "id,user_id,work_date,schedule_type,leave_type,day_type,shift_name_snapshot,scheduled_start_time,scheduled_end_time",
        apply: function (q) {
          return q.eq("work_date", today).limit(200);
        },
      });
    } catch (_) { overviewTodaySchedules = []; }
  }

  function peopleRows() {
    const q = String(peopleSearch || "").trim().toLowerCase();
    const st = String(peopleStatusFilter || "").trim();
    return enabledEmployeeIds().map(function (uid) {
      const status = employeeTodayStatus(uid);
      return {
        uid: uid,
        name: personName(uid),
        status: status,
        shift: employeeTodayShiftLabel(uid),
        cin: employeeTodayClock(uid, "in"),
        cout: employeeTodayClock(uid, "out"),
        pending: pendingLeaveCount(uid),
      };
    }).filter(function (row) {
      if (q && String(row.name).toLowerCase().indexOf(q) < 0) return false;
      if (st && row.status !== st) return false;
      return true;
    });
  }

  function renderPeopleOverview() {
    const tbody = $("attPeopleTbody");
    if (!tbody || !isAdmin()) return;
    const rows = peopleRows();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">沒有符合的員工</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (row) {
      return (
        "<tr>" +
        "<td data-label=\"員工\" class=\"table-primary\">" + esc(row.name) + "</td>" +
        "<td data-label=\"今日狀態\"><span class=\"status-badge " + statusBadgeClass(row.status) + "\">" + esc(row.status) + "</span></td>" +
        "<td data-label=\"今日班別\">" + esc(row.shift) + "</td>" +
        "<td data-label=\"上班時間\" class=\"nowrap\">" + esc(row.cin) + "</td>" +
        "<td data-label=\"下班時間\" class=\"nowrap\">" + esc(row.cout) + "</td>" +
        "<td data-label=\"本月狀態\">—</td>" +
        "<td data-label=\"待處理請假\" class=\"table-number\">" + esc(String(row.pending)) + "</td>" +
        "<td data-label=\"操作\" class=\"table-actions\">" +
        "<button type=\"button\" class=\"btn btn-primary btn-sm att-people-open\" data-id=\"" + esc(row.uid) + "\">查看</button>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderEmpOverview() {
    if (!isAdmin() || !selectedEmpId) return;
    const status = employeeTodayStatus(selectedEmpId);
    const shift = employeeTodayShiftLabel(selectedEmpId);
    const p = profileMap[String(selectedEmpId)] || {};
    if ($("attEmpName")) $("attEmpName").textContent = personName(selectedEmpId);
    if ($("attEmpEnabledBadge")) {
      const on = p.enabled !== false;
      $("attEmpEnabledBadge").textContent = on ? "在職" : "停用";
      $("attEmpEnabledBadge").className = "status-badge " + (on ? "status-success" : "status-muted");
    }
    if ($("attEmpTodayBadge")) {
      $("attEmpTodayBadge").textContent = status;
      $("attEmpTodayBadge").className = "status-badge " + statusBadgeClass(status);
    }
    if ($("attEmpShiftMeta")) $("attEmpShiftMeta").textContent = shift;
    if ($("attEmpOvStatus")) $("attEmpOvStatus").textContent = status;
    if ($("attEmpOvShift")) $("attEmpOvShift").textContent = shift;
    if ($("attEmpOvIn")) $("attEmpOvIn").textContent = employeeTodayClock(selectedEmpId, "in");
    if ($("attEmpOvOut")) $("attEmpOvOut").textContent = employeeTodayClock(selectedEmpId, "out");
    if ($("attEmpOvWorkDays")) $("attEmpOvWorkDays").textContent = "—";
    if ($("attEmpOvRest")) $("attEmpOvRest").textContent = String(monthLeaveCount(selectedEmpId, "REST_DAY"));
    if ($("attEmpOvSick")) $("attEmpOvSick").textContent = String(monthLeaveCount(selectedEmpId, "SICK_LEAVE"));
    if ($("attEmpOvPersonal")) $("attEmpOvPersonal").textContent = String(monthLeaveCount(selectedEmpId, "PERSONAL_LEAVE"));
    if ($("attEmpOvAnnual")) $("attEmpOvAnnual").textContent = String(monthLeaveCount(selectedEmpId, "ANNUAL_LEAVE"));
    if ($("attEmpOvLate")) $("attEmpOvLate").textContent = "—";
    if ($("attEmpOvEarly")) $("attEmpOvEarly").textContent = "—";
    const def = defaultPeriodForUser(selectedEmpId);
    if ($("attEmpOvDefaultShift")) {
      if (!def) $("attEmpOvDefaultShift").textContent = "—";
      else {
        const span = hhmm(def.scheduled_start_time) && hhmm(def.scheduled_end_time)
          ? hhmm(def.scheduled_start_time) + "–" + hhmm(def.scheduled_end_time)
          : "";
        $("attEmpOvDefaultShift").textContent = (def.shift_name_snapshot || "預設班") + (span ? "　" + span : "");
      }
    }
  }

  function setSelectQuiet(id, value) {
    const el = $(id);
    if (!el) return;
    el.value = value || "";
  }

  async function bindEmployeeContext(uid) {
    setSelectQuiet("attDefEmployee", uid);
    setSelectQuiet("attSchedEmployee", uid);
    setSelectQuiet("attLeaveDirectEmployee", uid);
    setSelectQuiet("attHistoricalLeaveEmployee", uid);
    setSelectQuiet("attCompEmployee", uid);
    setSelectQuiet("attPayrollEmployee", uid);
    setSelectQuiet("attReportEmployee", uid);
    try { await refreshDefaultShiftUi({ silent: true }); } catch (_) {}
    try { await refreshMonthlyScheduleUi({ silent: true }); } catch (_) {}
    try { await refreshCompensationUi({ silent: true }); } catch (_) {}
    renderAdminLeave();
    renderAdminTable();
    renderEmpOverview();
  }

  async function openEmployeeDetail(uid) {
    if (!isAdmin() || !uid) return;
    selectedEmpId = String(uid);
    empDetailTab = "overview";
    lastAttPane = "people";
    await bindEmployeeContext(selectedEmpId);
    syncAttendanceWorkspace();
  }

  function closeEmployeeDetail() {
    selectedEmpId = "";
    empDetailTab = "overview";
    lastAttPane = "people";
    renderAdminLeave();
    renderAdminTable();
    renderPeopleOverview();
    syncAttendanceWorkspace();
  }

  function setEmpTab(tab) {
    empDetailTab = tab === "attendance" || tab === "leave" || tab === "payroll" ? tab : "overview";
    renderAdminLeave();
    renderAdminTable();
    renderEmpOverview();
    syncAttendanceWorkspace();
  }

  function setHiddenEl(el, hid) {
    if (el) el.hidden = !!hid;
  }

  function syncAttendanceWorkspace() {
    const admin = isAdmin();
    const page = $("tab-attendance");
    if (page) {
      page.classList.toggle("att-role-staff", !admin);
      page.classList.toggle("att-role-admin", admin);
      page.classList.toggle("att-emp-open", admin && !!selectedEmpId && lastAttPane === "people");
    }
    if (!admin) {
      document.querySelectorAll("#tab-attendance .att-pane").forEach(function (el) {
        const match = el.getAttribute("data-att-pane") === lastAttPane;
        const adminOnly = el.hasAttribute("data-admin-only");
        el.hidden = !match || adminOnly;
      });
      document.querySelectorAll("#tab-attendance .att-subnav-btn").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.getAttribute("data-att-pane") === lastAttPane);
      });
      return;
    }

    const ws = lastAttPane;
    const empOpen = !!selectedEmpId && ws === "people";
    const empTab = empDetailTab;

    setHiddenEl($("attPanePeople"), ws !== "people");
    setHiddenEl($("attPeopleHome"), empOpen);
    setHiddenEl($("attEmpDetail"), !empOpen);
    setHiddenEl($("attEmpOverview"), !(empOpen && empTab === "overview"));

    setHiddenEl($("attPaneClock"), !(ws === "people" && !empOpen));
    const meId = currentUser() && currentUser().userId;
    const showMyLeave = ws === "leave" || (empOpen && empTab === "leave" && meId && String(meId) === String(selectedEmpId));
    setHiddenEl($("attPaneLeave"), !showMyLeave);

    const showSchedulePane = ws === "schedule" || (empOpen && empTab === "attendance");
    setHiddenEl($("attPaneSchedule"), !showSchedulePane);
    setHiddenEl($("attShiftTemplates"), ws !== "schedule");
    setHiddenEl($("attLocationSettings"), ws !== "schedule");
    setHiddenEl($("attNetworkSettings"), ws !== "schedule");
    setHiddenEl($("attDefaultShift"), !(empOpen && empTab === "attendance"));
    setHiddenEl($("attMonthlySchedule"), !(empOpen && empTab === "attendance"));

    const showLeavePane = ws === "leave" || (empOpen && empTab === "leave");
    setHiddenEl($("attPaneLeaveAdmin"), !showLeavePane);
    setHiddenEl($("attLeaveAdmin"), !showLeavePane);
    setHiddenEl($("attHistoricalLeave"), !(empOpen && empTab === "leave"));

    const showPayrollPane = empOpen && empTab === "payroll";
    setHiddenEl($("attPanePayroll"), !showPayrollPane);
    setHiddenEl($("attComp"), !showPayrollPane);
    setHiddenEl($("attPayroll"), !showPayrollPane);

    setHiddenEl($("attPaneReport"), ws !== "report" && !(empOpen && empTab === "attendance"));
    setHiddenEl($("attAdminManage"), ws === "report" || (empOpen && empTab === "attendance") ? false : true);
    setHiddenEl($("attAdminAudit"), ws !== "report");
    setHiddenEl($("attSchedCompliance"), ws !== "report");
    document.querySelectorAll("#tab-attendance .att-global-report-block").forEach(function (el) {
      el.hidden = ws !== "report";
    });

    document.querySelectorAll("#attSubnavAdmin .att-subnav-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-att-pane") === ws);
    });
    document.querySelectorAll("#attEmpSubnav .att-emp-tab-btn").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-att-emp-tab") === empTab);
    });
  }

  function applyAttendancePane(name) {
    const admin = isAdmin();
    if (!admin) {
      let pane = String(name || "clock");
      if (pane !== "clock" && pane !== "leave") pane = "clock";
      lastAttPane = pane;
      syncAttendanceWorkspace();
      return;
    }
    let pane = String(name || "people");
    if (pane === "clock" || pane === "payroll") pane = "people";
    if (pane !== "people" && pane !== "schedule" && pane !== "leave" && pane !== "report") pane = "people";
    lastAttPane = pane;
    syncAttendanceWorkspace();
  }

  function syncAttendanceChrome() {
    const admin = isAdmin();
    const navAdmin = $("attSubnavAdmin");
    const navStaff = $("attSubnavStaff");
    if (navAdmin) navAdmin.hidden = !admin;
    if (navStaff) navStaff.hidden = admin;
    if (admin && (lastAttPane === "clock" || lastAttPane === "payroll" || !lastAttPane)) lastAttPane = "people";
    if (!admin && lastAttPane !== "leave") lastAttPane = "clock";
    applyAttendancePane(lastAttPane);
  }

  function bind() {
    const subnav = $("tab-attendance");
    if (subnav) {
      subnav.addEventListener("click", function (ev) {
        const empTab = ev.target && ev.target.closest ? ev.target.closest(".att-emp-tab-btn") : null;
        if (empTab && subnav.contains(empTab)) {
          setEmpTab(empTab.getAttribute("data-att-emp-tab"));
          return;
        }
        const btn = ev.target && ev.target.closest ? ev.target.closest(".att-subnav-btn") : null;
        if (!btn || !subnav.contains(btn)) return;
        if (btn.closest("#attSubnavAdmin")) {
          selectedEmpId = "";
          empDetailTab = "overview";
        }
        applyAttendancePane(btn.getAttribute("data-att-pane"));
      });
    }
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

    ensureTime24Selects();
    const tplNew = $("attTplNew");
    if (tplNew) tplNew.addEventListener("click", function () { openTemplateForm(null); });
    const tplSave = $("attTplSave");
    if (tplSave) tplSave.addEventListener("click", function () { saveTemplateForm(); });
    const tplCancel = $("attTplCancel");
    if (tplCancel) tplCancel.addEventListener("click", function () { closeTemplateForm(); });
    const tplBody = $("attTplTbody");
    if (tplBody) {
      tplBody.addEventListener("click", function (ev) {
        const edit = ev.target && ev.target.closest ? ev.target.closest(".att-tpl-edit") : null;
        if (edit) {
          openTemplateForm(findTemplate(edit.getAttribute("data-id")));
          return;
        }
        const tog = ev.target && ev.target.closest ? ev.target.closest(".att-tpl-toggle") : null;
        if (!tog) return;
        toggleTemplateEnabled(tog.getAttribute("data-id"), tog.getAttribute("data-enabled") === "1");
      });
    }

    const schedRefresh = $("attSchedRefresh");
    if (schedRefresh) {
      schedRefresh.addEventListener("click", function () { refreshMonthlyScheduleUi(); });
    }
    const schedYear = $("attSchedYear");
    if (schedYear) schedYear.addEventListener("change", function () { if (isAdmin()) refreshMonthlyScheduleUi(); });
    const schedMonth = $("attSchedMonth");
    if (schedMonth) schedMonth.addEventListener("change", function () { if (isAdmin()) refreshMonthlyScheduleUi(); });
    const schedEmp = $("attSchedEmployee");
    if (schedEmp) schedEmp.addEventListener("change", function () { if (isAdmin()) refreshMonthlyScheduleUi(); });
    const schedBody = $("attSchedTbody");
    if (schedBody) {
      schedBody.addEventListener("click", function (ev) {
        const assign = ev.target && ev.target.closest ? ev.target.closest(".att-sched-assign") : null;
        if (assign) {
          const ymd = assign.getAttribute("data-date") || "";
          const row = assign.closest("tr");
          const sel = row ? row.querySelector(".att-sched-tpl") : null;
          assignWorkSchedule(ymd, sel && sel.value);
          return;
        }
        const revoke = ev.target && ev.target.closest ? ev.target.closest(".att-sched-revoke") : null;
        if (revoke) {
          revokeLeave(revoke.getAttribute("data-leave-id"));
          return;
        }
        const clear = ev.target && ev.target.closest ? ev.target.closest(".att-sched-clear") : null;
        if (!clear) return;
        clearWorkSchedule(clear.getAttribute("data-id"));
      });
    }

    const defEmp = $("attDefEmployee");
    if (defEmp) defEmp.addEventListener("change", function () { if (isAdmin()) refreshDefaultShiftUi(); });
    const defSave = $("attDefSave");
    if (defSave) defSave.addEventListener("click", function () { saveDefaultShift(); });

    const compEmp = $("attCompEmployee");
    if (compEmp) compEmp.addEventListener("change", function () { if (isAdmin()) refreshCompensationUi(); });
    const compHas = $("attCompHasProbation");
    if (compHas) {
      compHas.addEventListener("change", function () {
        syncCompensationProbationFields();
        if (hasCompensationProbation()) fillRegularFromProbationEnd();
      });
    }
    const compProbTo = $("attCompProbTo");
    if (compProbTo) {
      compProbTo.addEventListener("change", function () { fillRegularFromProbationEnd(); });
    }
    const compSave = $("attCompSave");
    if (compSave) compSave.addEventListener("click", function () { saveCompensationPlan(); });
    const compRaise = $("attCompRaise");
    if (compRaise) compRaise.addEventListener("click", function () { saveCompensationRaise(); });

    const payrollCalc = $("attPayrollCalc");
    if (payrollCalc) payrollCalc.addEventListener("click", function () { runPayrollPreview(); });
    const payrollSettle = $("attPayrollSettle");
    if (payrollSettle) payrollSettle.addEventListener("click", function () { settlePayrollMonthUi(); });
    const payrollView = $("attPayrollViewDaily");
    if (payrollView) payrollView.addEventListener("click", function () { viewPayrollDaily(); });
    const payrollPrint = $("attPayrollPrint");
    if (payrollPrint) payrollPrint.addEventListener("click", function () { printPayrollPayslip(); });
    const payrollOtBody = $("attPayrollOtTbody");
    if (payrollOtBody) {
      payrollOtBody.addEventListener("click", function (ev) {
        const ap = ev.target && ev.target.closest ? ev.target.closest(".att-ot-approve") : null;
        if (ap) {
          const rowEl = ap.closest("tr");
          const inp = rowEl ? rowEl.querySelector(".att-ot-minutes") : null;
          const mins = inp ? Number(inp.value) : NaN;
          if (!Number.isFinite(mins) || mins < 0 || Math.floor(mins) !== mins) {
            showMsg($("attPayrollMsg"), "請輸入有效的核准分鐘。", true);
            return;
          }
          decideOvertime(ap.getAttribute("data-date"), ap.getAttribute("data-type"), "APPROVED", mins);
          return;
        }
        const rj = ev.target && ev.target.closest ? ev.target.closest(".att-ot-reject") : null;
        if (!rj) return;
        decideOvertime(rj.getAttribute("data-date"), rj.getAttribute("data-type"), "REJECTED", 0);
      });
    }

    const leaveSubmit = $("attLeaveSubmit");
    if (leaveSubmit) leaveSubmit.addEventListener("click", function () { submitMyLeave(); });
    const leaveCalPrev = $("attLeaveCalPrev");
    if (leaveCalPrev) leaveCalPrev.addEventListener("click", function () { shiftLeaveCalMonth(-1); });
    const leaveCalNext = $("attLeaveCalNext");
    if (leaveCalNext) leaveCalNext.addEventListener("click", function () { shiftLeaveCalMonth(1); });
    const leaveCalGrid = $("attLeaveCalGrid");
    if (leaveCalGrid) {
      leaveCalGrid.addEventListener("click", function (ev) {
        const cell = ev.target && ev.target.closest ? ev.target.closest(".att-leave-cal-cell") : null;
        if (!cell || cell.disabled || !leaveCalGrid.contains(cell)) return;
        toggleLeaveDate(cell.getAttribute("data-ymd"));
      });
    }
    const leaveChips = $("attLeaveSelectedChips");
    if (leaveChips) {
      leaveChips.addEventListener("click", function (ev) {
        const chip = ev.target && ev.target.closest ? ev.target.closest(".att-leave-chip") : null;
        if (!chip || !leaveChips.contains(chip)) return;
        toggleLeaveDate(chip.getAttribute("data-ymd"));
      });
    }
    const leaveType = $("attLeaveType");
    if (leaveType) {
      leaveType.addEventListener("change", function () { syncLeaveQuotaHint(); });
      syncLeaveQuotaHint();
    }
    const leaveBody = $("attLeaveTbody");
    if (leaveBody) {
      leaveBody.addEventListener("click", function (ev) {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".att-leave-cancel") : null;
        if (!btn) return;
        cancelMyLeave(btn.getAttribute("data-id"));
      });
    }
    const leaveAdminRefresh = $("attLeaveAdminRefresh");
    if (leaveAdminRefresh) {
      leaveAdminRefresh.addEventListener("click", function () {
        if (!isAdmin()) return;
        refreshAfterLeaveChange();
      });
    }
    const leaveDirect = $("attLeaveDirectBtn");
    if (leaveDirect) leaveDirect.addEventListener("click", function () { setDirectRestDay(); });
    const histLeaveBtn = $("attHistoricalLeaveBtn");
    if (histLeaveBtn) histLeaveBtn.addEventListener("click", function () { submitHistoricalLeave(); });
    const peopleSearchEl = $("attPeopleSearch");
    if (peopleSearchEl) {
      peopleSearchEl.addEventListener("input", function () {
        peopleSearch = String(peopleSearchEl.value || "");
        renderPeopleOverview();
      });
    }
    const peopleFilterEl = $("attPeopleStatusFilter");
    if (peopleFilterEl) {
      peopleFilterEl.addEventListener("change", function () {
        peopleStatusFilter = String(peopleFilterEl.value || "");
        renderPeopleOverview();
      });
    }
    const peopleBody = $("attPeopleTbody");
    if (peopleBody) {
      peopleBody.addEventListener("click", function (ev) {
        const btn = ev.target && ev.target.closest ? ev.target.closest(".att-people-open") : null;
        if (!btn) return;
        openEmployeeDetail(btn.getAttribute("data-id"));
      });
    }
    const empBack = $("attEmpBack");
    if (empBack) empBack.addEventListener("click", function () { closeEmployeeDetail(); });
    const leaveAdminBody = $("attLeaveAdminTbody");
    if (leaveAdminBody) {
      leaveAdminBody.addEventListener("click", function (ev) {
        const ap = ev.target && ev.target.closest ? ev.target.closest(".att-leave-approve") : null;
        if (ap) {
          const rowEl = ap.closest("tr");
          const sel = rowEl ? rowEl.querySelector(".att-leave-daytype") : null;
          approveLeave(ap.getAttribute("data-id"), sel && sel.value);
          return;
        }
        const rj = ev.target && ev.target.closest ? ev.target.closest(".att-leave-reject") : null;
        if (rj) {
          rejectLeave(rj.getAttribute("data-id"));
          return;
        }
        const rv = ev.target && ev.target.closest ? ev.target.closest(".att-leave-revoke") : null;
        if (!rv) return;
        revokeLeave(rv.getAttribute("data-id"));
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
    initReportDefaults();
    const admin = isAdmin();
    if ($("attAdminManage")) $("attAdminManage").hidden = !admin;
    if ($("attAdminAudit")) $("attAdminAudit").hidden = !admin;
    if ($("attLocationSettings")) $("attLocationSettings").hidden = !admin;
    if ($("attNetworkSettings")) $("attNetworkSettings").hidden = !admin;
    if ($("attShiftTemplates")) $("attShiftTemplates").hidden = !admin;
    if ($("attMonthlySchedule")) $("attMonthlySchedule").hidden = !admin;
    if ($("attDefaultShift")) $("attDefaultShift").hidden = !admin;
    if ($("attLeaveAdmin")) $("attLeaveAdmin").hidden = !admin;
    if ($("attHistoricalLeave")) $("attHistoricalLeave").hidden = !admin;
    if ($("attComp")) $("attComp").hidden = !admin;
    if ($("attPayroll")) $("attPayroll").hidden = !admin;
    syncAttendanceChrome();
    startClock();
    renderClockFace();
    setLocStatus("按下打卡：先驗證公司網路，必要時再請求 GPS。", null);
    await refreshAll();
  }

  bind();
  startClock();
  global.__dkAttendanceOnShow = onShow;
})(window);
