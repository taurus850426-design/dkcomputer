# Stage 18 正式部署說明（照著做即可）

本文件給 Production 一次部署使用。

- 不要一次貼整份 SQL 檔。
- 每個 SECTION 只複製 `/*` 與 `*/` **中間**的內容去執行。
- PREFLIGHT / M3 結果應全部是 `PASS`。
- **M0 跑完後立刻跑 M1**（不要停在 M0）。原因：M0 可能先拿掉 SELECT 權限，M1 才會補回來。
- **不要回頭重跑較早檔案的 M2**。後面的檔案會覆蓋前面的函式，回頭跑會把新規則蓋掉。

前端 cache：`20260908s18final`（`admin.html` 的 `styles.css` / `shared.js` / `attendance.js`）。

---

## A. 已部署、不要重跑

以下已在 Production，**不要重跑 M0**（重跑 M0 可能讓畫面讀不到班表）。

### 1. `supabase-stage18-scheduling.sql`

全部 SECTION 已執行。本次不要跑。

### 2. `supabase-stage18-default-shift.sql`

已執行過。本次不要跑。

開始前可先跑第 4 份的 PREFLIGHT。  
若 `employee_default_shift_periods` 不是 PASS，才補跑 default-shift 的 PREFLIGHT → M0 → **立刻 M1** → M2 → M3。  
不要因此重跑 scheduling 的 M0。

---

## B. 現在真正要執行的 SQL

依下面順序，一份做完再做下一份。

### 3. `supabase-stage18-leave-requests.sql`

PREFLIGHT → M0 → **立刻 M1** → M2 → M3

### 4. `supabase-stage18-attendance-evaluation.sql`

PREFLIGHT → M0（NONE，可跑）→ M1（NONE，可跑）→ M2 → M3

### 5. `supabase-stage18-compensation.sql`

PREFLIGHT → M0 → **立刻 M1** → M2 → M3

### 6. `supabase-stage18-day-classification.sql`

PREFLIGHT → M0 → **立刻 M1** → M2 → M3

此份 M2 會刪除舊版：

- `backoffice_approve_leave_request(uuid)`
- `dk_leave_apply_off`（4 個參數舊版）

之後請假核准必須帶日別參數。不要再跑第 3 份的 M2。

### 7. `supabase-stage18-leave-types.sql`

PREFLIGHT → M0 → M1（NONE，可跑）→ M2 → M3

此份 M2 是請假 overlay 與出勤判定的最終版。不要再跑第 4、第 6 份的 M2。

### 8. `supabase-stage18-payroll-engine.sql`

PREFLIGHT → M0（NONE，可跑）→ M1（NONE，可跑）→ M2 → M3

### 9. `supabase-stage18-overtime-approval.sql`

PREFLIGHT → M0 → **立刻 M1** → M2 → M3

此份 M2 是薪資預覽最終版（含加班核准）。不要再跑第 8 份的 M2。

### 10. `supabase-stage18-payroll-settlement.sql`

PREFLIGHT → M0 → **立刻 M1** → M2 → M3

此份最後執行。不要再跑第 8、第 9 份的 M2。

---

## C. SQL 全部完成後

再上前端這 4 個檔：

- `admin.html`
- `attendance.js`
- `shared.js`
- `styles.css`

SQL 沒跑完就上前端，排班讀取可能因缺少 `day_type` 欄位失敗。

---

## D. 禁止回頭重跑

| 若重跑這個 | 會發生什麼 |
|---|---|
| scheduling / default-shift 的 **M0** | 可能拿掉 SELECT，畫面讀不到班表／預設班 |
| leave-requests 的 **M2**（在第 6、7 份之後） | 請假核准變回舊簽名，前端會壞 |
| evaluation 的 **M2**（在第 6、7 份之後） | 出勤判定失去 day_type / 請假 overlay |
| day-classification 的 **M2**（在第 7 份之後） | 請假 overlay 被蓋掉 |
| payroll-engine 的 **M2**（在第 9、10 份之後） | 加班核准從薪資預覽消失 |

PREFLIGHT 與 M3 可重跑（只檢查、不改資料）。

---

## E. 最終函式以哪一份為準

| 函式 | 第一次出現 | 最終版本 |
|---|---|---|
| `dk_schedule_require_admin` 等排班 RPC | scheduling | scheduling（不要重跑） |
| `backoffice_set_employee_default_shift` | default-shift | default-shift（不要重跑） |
| `backoffice_cancel_leave_request` | leave-requests | leave-requests |
| `backoffice_reject_leave_request` | leave-requests | leave-requests |
| `dk_leave_apply_off` | leave-requests | **day-classification**（5 參數） |
| `backoffice_attendance_schedule_compliance` | day-classification | day-classification |
| `backoffice_upsert_attendance_calendar_day` | day-classification | day-classification |
| `backoffice_request_leave` | leave-requests | **leave-types** |
| `backoffice_approve_leave_request(uuid, text)` | day-classification | **leave-types** |
| `backoffice_set_employee_rest_day` | leave-requests | **leave-types** |
| `backoffice_revoke_leave_request` | leave-requests | **leave-types** |
| `dk_attendance_resolve_schedule` | day-classification | **leave-types** |
| `dk_attendance_eval_day` | evaluation | **leave-types** |
| `backoffice_attendance_evaluate_month` | evaluation | evaluation（執行時會呼叫最新 `eval_day`） |
| 薪資公式 helpers（`/30`、`/240` 等） | payroll-engine | payroll-engine |
| `dk_payroll_preview_day` | payroll-engine | **overtime-approval** |
| `backoffice_payroll_preview_month` | payroll-engine | **overtime-approval** |
| `backoffice_get_overtime_candidates` | overtime-approval | overtime-approval |
| `backoffice_set_overtime_approval` | overtime-approval | overtime-approval |
| `backoffice_settle_payroll_month` | payroll-settlement | payroll-settlement |
| `backoffice_get_payroll_settlement` | payroll-settlement | payroll-settlement |

前端對應：

- 核准請假：`p_id` + `p_day_type`（排休必填；病假／事假／特休傳空字串）
- 直接排休：`backoffice_set_employee_rest_day`，payload 含 `user_id` / `leave_date` / `day_type`
- 月報：`backoffice_attendance_evaluate_month(p_user_id, p_month)`
- 薪資預覽：`backoffice_payroll_preview_month(p_user_id, p_month)`
- 加班候選：`backoffice_get_overtime_candidates(p_user_id, p_month)`
- 加班核准：`backoffice_set_overtime_approval(p_payload)`，不可傳 `candidate_minutes`
- 月結：`backoffice_settle_payroll_month(p_user_id, p_month)`，只傳員工與月份
- 讀已結算：`backoffice_get_payroll_settlement(p_user_id, p_month)`

---

## F. 一次 Smoke Test（部署後再測，現在不要測）

### Admin

1. 班別建立／修改  
2. 員工預設班別  
3. 單日例外班  
4. Admin 排休  
5. 員工排休申請核准  
6. 病假  
7. 事假  
8. 特休  
9. 月報出勤判定  
10. 遲到  
11. 早退  
12. ABSENT  
13. 試用期薪資  
14. 正式薪資  
15. 調薪歷史  
16. Payroll Preview  
17. 加班候選  
18. 核准部分加班分鐘  
19. 不認列加班  
20. Payroll Ready  
21. Settlement  
22. Settlement 後重新整理仍凍結  
23. 薪資單  
24. 列印  

### Staff

25. 正常上下班打卡  
26. Break  
27. 只能看自己的排休／請假  
28. 可送請假  
29. 可取消 PENDING  
30. 看不到班別管理  
31. 看不到薪資設定  
32. 看不到 Payroll  
33. 看不到其他員工資料  

### Security

34. Staff 呼叫 Admin payroll RPC 應被拒絕（`admin only`）  
35. Staff 無法 SELECT compensation / payroll_settlements  
36. anon 無敏感資料權限  

補充確認：應發薪資不要顯示成「實領」或「匯款金額」。特休目前不扣薪、也不擋月結。
