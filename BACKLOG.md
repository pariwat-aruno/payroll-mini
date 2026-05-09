# BACKLOG — Feature Spec for Iteration 2

ระบบ Payroll Mini base flow ทำงานได้แล้ว (ใบลา → อนุมัติ → บันทึก Sheet)
เอกสารนี้เก็บ feature ที่เพิ่มเข้ามาตาม feedback จากการใช้งานจริง

จัดเป็น **3 PRs เรียงลำดับ** เพื่อ test ได้ทีละชั้น

---

## PR-1: Quick UI Polish (30 นาที)

### Feature 1.1: Date picker UI fix

**Problem:** ช่อง `<input type="date">` ใน leave.html เริ่มเล็กตอน empty พอเลือกวันแล้วช่องขยายใหญ่ขึ้น ดูตลก

**Fix:**
- ตั้ง `width: 100%` ที่ input
- ตั้ง `min-height` คงที่ (~44px)
- Layout: 2 ช่องวันที่ใช้ CSS grid 2 columns + gap 12px
- iOS Safari: ตั้ง `font-size: 16px` เพื่อกัน auto-zoom

**Files:** `frontend/src/leave.html` (CSS)

---

### Feature 1.2: Evidence Type Selection

**Problem:** ช่องแนบหลักฐานปัจจุบันรับ URL อย่างเดียว ไม่ระบุประเภท → approver มองไม่ออกว่าหลักฐานคืออะไร

**Spec:**

UI changes ใน `leave.html`:
- ลบ field "แนบหลักฐาน (ถ้ามี)" เดิม
- เพิ่ม **dropdown "ประเภทหลักฐาน"**:
  - Options: `ใบรับรองแพทย์`, `ใบนัด`, `ใบเสร็จ`, `รูปถ่าย`, `chat screenshot`, `อื่นๆ`, `ไม่มี`
- เพิ่ม **field "ลิงก์หลักฐาน (Google Drive / Photos)"** — เปิด/ปิด disabled ตาม dropdown:
  - ถ้าเลือก "ไม่มี" → field disabled
- เพิ่ม **checkbox "ส่งภายหลัง"** — แสดงเฉพาะตอน dropdown ≠ "ไม่มี":
  - Tick = บันทึก URL ว่าง + flag pending

Schema (`Leave_Records` เพิ่ม columns):
- `evidence_type` (string) — enum หรือ free text
- `evidence_pending` (boolean) — TRUE ถ้ารอส่งภายหลัง

**Files:**
- `frontend/src/leave.html`
- `apps-script/reconcile.gs` (submitLeave parse evidence_type, evidence_pending)
- `apps-script/setup.gs` (PUBLIC_TABS Leave_Records headers)

**Acceptance:**
- Submit ใบลา + เลือก evidence_type=ใบนัด + URL=https://... → row ใน Sheet มีค่าครบ
- Submit + เลือก evidence_type=ใบรับรองแพทย์ + tick "ส่งภายหลัง" → row มี evidence_pending=TRUE, evidence_url=""

---

## PR-2: Leave Modes & Emergency (4-5 ชั่วโมง)

### Feature 2.1: ลารายชั่วโมง / ครึ่งวัน / เต็มวัน

**Problem:** ตอนนี้ลาได้เต็มวันเท่านั้น ไม่รองรับลาครึ่งวันหรือ 2-3 ชั่วโมงไปธุระ

**Spec:**

UI ใน `leave.html`:
- เพิ่ม **toggle "ระยะเวลา"** (3 ปุ่ม): `[เต็มวัน] [ครึ่งวัน] [รายชั่วโมง]` — default = เต็มวัน
- ถ้าเลือก **ครึ่งวัน**: แสดง dropdown `[เช้า / บ่าย]` + บังคับวันที่เริ่ม=สิ้นสุด
- ถ้าเลือก **รายชั่วโมง**: แสดง 2 time inputs `[เริ่ม HH:mm]` `[จบ HH:mm]` + บังคับวันที่เริ่ม=สิ้นสุด
- ถ้าเลือก **เต็มวัน**: ใช้ start_date / end_date ตามเดิม (รองรับหลายวัน)

Validation:
- ครึ่งวัน + รายชั่วโมง → 1 วันเท่านั้น (start_date === end_date)
- รายชั่วโมง: end_time > start_time, ภายในวันเดียว
- ไม่มี cap — ผู้ใช้ระบุ 0.5 / 8 ชม. ได้ตลอด

Schema (`Leave_Records` เพิ่ม columns):
- `duration_unit` (string) — `full_day` / `half_day` / `hour`
- `half_day_period` (string) — `morning` / `afternoon` (เฉพาะ half_day, อื่นๆ ว่าง)
- `hour_start` (string HH:mm) — เฉพาะ hour
- `hour_end` (string HH:mm) — เฉพาะ hour
- `days_equivalent` (float) — สำหรับคำนวณหักสิทธิ์/payroll

หักสิทธิ์ formula:
- full_day → 1.0 ต่อวัน
- half_day → 0.5
- hour → (end_minutes - start_minutes) / 60 / 8 = X/8

Approval rule:
- 1 hour / half_day = ใช้ rule R1 (L1 only) — ไม่กระทบ multi-level rules ปัจจุบัน
- กฎ 1-2 วัน → L1, 3-5 → L2, 6+ → L3 ใช้ days_equivalent rounded up เป็นจำนวนเต็ม

**Files:**
- `frontend/src/leave.html`
- `apps-script/reconcile.gs` (submitLeave คำนวณ days_equivalent, validate)
- `apps-script/approval.gs` (determineRequiredLevels ใช้ Math.ceil(days_equivalent))
- `apps-script/setup.gs` (Leave_Records headers)

**Acceptance:**
- Submit ลาเต็มวัน 5/12 - 5/14 → 3 rows, days_equivalent=1.0 ต่อ row
- Submit ลาครึ่งวันเช้า 5/12 → 1 row, days_equivalent=0.5
- Submit ลา 9:00-12:00 5/12 → 1 row, days_equivalent=0.375 (3 hr / 8)
- Approval flow ใช้ rule R1 ทั้ง 3 case (≤2 days)

---

### Feature 2.2: Emergency Leave (เฉพาะลาป่วย/ลากิจ)

**Problem:** บางครั้งลาฉุกเฉิน (ป่วยตอนเช้า / ธุระด่วน) — ต้องส่งหลังเริ่มงานหรือใกล้เกินไป → ระบบบล็อกตามกฎล่วงหน้าได้

**Business rules (จาก stakeholder):**
- ลากิจ (personal): ต้องส่งล่วงหน้า ≥ 3 วัน
- ลาป่วย (sick): ต้องส่งล่วงหน้า ≥ 1 ชั่วโมงก่อนเข้างาน
- ถ้าไม่ทันเวลา → บังคับเป็น "emergency mode"
- ลาประเภทอื่น (พักร้อน, ลาไม่รับเงิน): ไม่มี emergency mode

**Spec:**

UI ใน `leave.html`:
- ตอนเลือก "ลาป่วย" หรือ "ลากิจ" + กรอกวันที่/เวลา:
  - Frontend คำนวณ "ทันเงื่อนไขล่วงหน้าไหม"
  - ถ้าไม่ทัน → แสดง warning banner สีส้ม:
    ```
    ⚠️ คำขอนี้ไม่ทันกำหนดเวลาล่วงหน้า
    ต้องเป็นการลาฉุกเฉิน — กรุณาติ๊กยืนยัน
    ```
  - แสดง **checkbox "ยืนยันว่าเป็นการลาฉุกเฉิน"** (default unchecked, required)
  - ปุ่ม submit disabled จนกว่าจะติ๊ก
- ถ้าทันเวลา → ไม่มี checkbox emergency

Backend logic ใน `submitLeave`:
- คำนวณ `is_emergency` ฝั่ง backend ด้วย (อย่าเชื่อ frontend อย่างเดียว)
- ถ้าคำนวณแล้วเป็น emergency แต่ payload ไม่มี `is_emergency=true` → reject
- ถ้า is_emergency=true:
  - Bypass advance notice rule
  - Override leave_type label = "ลาป่วย (ฉุกเฉิน)" หรือ "ลากิจ (ฉุกเฉิน)" ใน Flex Message
  - Approver chain ใช้เดิม (level_1 = หัวหน้าตรง)

Schema (`Leave_Records` เพิ่ม column):
- `is_emergency` (boolean)

Settings (`Settings` Sheet เพิ่ม keys):
- `LEAVE_PERSONAL_MIN_ADVANCE_DAYS` = `3`
- `LEAVE_SICK_MIN_ADVANCE_HOURS` = `1`

**Files:**
- `frontend/src/leave.html` (UI + JS validation)
- `apps-script/reconcile.gs` (submitLeave validate is_emergency)
- `apps-script/line_api.gs` (sendApprovalFlex แสดง label "(ฉุกเฉิน)")
- `apps-script/setup.gs` (Settings + Leave_Records headers)

**Acceptance:**
- ลากิจ start_date = วันนี้ → ต้อง emergency, frontend แสดง checkbox
- ลากิจ start_date = 5 วันข้างหน้า → ไม่ต้อง emergency
- ลาป่วย start_time = 1 ชม. ข้างหน้า → ไม่ต้อง emergency (ทัน)
- ลาป่วย start_time = 30 นาทีข้างหน้า → ต้อง emergency
- ลาพักร้อน start_date = วันนี้ → backend reject "advance_notice_required" (ไม่มี emergency mode)

---

## PR-3: Conversational Approval Flow (6-8 ชั่วโมง)

### Feature 3.1: ปุ่ม "ขอข้อมูลเพิ่มเติม" ใน Flex

**Problem:** บางครั้ง approver อยากถามเพิ่มก่อนตัดสินใจ — ปัจจุบันต้อง approve หรือ reject เด็ดขาด

**Spec:**

Flex Message change (`sendApprovalFlex` ใน `line_api.gs`):
- เพิ่ม **ปุ่มที่ 3** ใน footer: `[ℹ️ ขอข้อมูลเพิ่ม]`
- กดแล้ว → LINE postback `action=request_info_leave&id=<leave_id>&level=<n>`

Postback handler ใน `Code.gs::_handlePostback` + `approval.gs`:
- เพิ่ม action `request_info_leave`
- → ส่ง quick reply ให้ approver:
  ```
  ขอข้อมูลอะไรเพิ่ม?
  [ขอหลักฐานเพิ่ม]
  [ขอเหตุผลให้ชัดเจน]
  [อื่นๆ (พิมพ์เอง)]
  ```
- หลัง approver เลือก → store ใน Leave_Records:
  - `info_request_status` = `pending`
  - `info_request_count` += 1
  - `info_request_message` = ข้อความที่เลือก
  - `info_request_deadline` = now + INFO_REQUEST_TIMEOUT_MINUTES
- ส่ง LINE หาพนักงาน:
  ```
  ⚠️ ใบลา {leave_date} รอข้อมูลเพิ่มเติม
  ผู้อนุมัติขอ: {message}
  กรุณาตอบกลับภายใน {HH:mm} (ภายใน {timeout} นาที)
  หากไม่ตอบกลับ ใบลาจะถูกยกเลิกอัตโนมัติ
  
  [ตอบกลับ]  ← LIFF link to respond.html
  ```

LIFF page ใหม่: `frontend/src/respond.html`
- Query param: `?leave_id=<id>`
- Load leave details + info_request_message
- ฟอร์มให้กรอก:
  - ข้อความตอบ (textarea)
  - URL หลักฐานเพิ่ม (optional)
  - Evidence type (dropdown ถ้ามี url)
- ปุ่ม Submit → action `respondInfoRequest`

Backend handler `respondInfoRequest` ใน `reconcile.gs`:
- Update Leave_Records:
  - `info_request_status` = `responded`
  - Append response to `reason` หรือเก็บใน column ใหม่
  - Update `evidence_url` ถ้าส่งมา
- ส่ง Flex หา approver ใหม่ (แทบเหมือนรอบแรก แต่มี response ที่พนักงานตอบ):
  ```
  📝 ใบลา {leave_date} (รอบ {info_request_count})
  พนักงานตอบกลับ: {response_text}
  หลักฐานเพิ่ม: {evidence_url || "ไม่ส่ง"}
  
  [✅ อนุมัติ] [❌ ปฏิเสธ] [ℹ️ ขอข้อมูลเพิ่ม]  ← request again ก็ได้
  ```

Schema (`Leave_Records` เพิ่ม):
- `info_request_status` — `none` / `pending` / `responded` / `expired`
- `info_request_count` (int)
- `info_request_deadline` (datetime)
- `info_request_message` (string) — เก็บ message รอบล่าสุด
- `info_request_response` (string) — เก็บ response รอบล่าสุด

Settings:
- `INFO_REQUEST_TIMEOUT_MINUTES` = `30`

Auto-cancel mechanism (new file or extend `scheduler.gs`):
- Function ใหม่: `infoRequestTimeoutTick()`
- Time trigger: ทุก 5 นาที
- Logic:
  - Query `Leave_Records` WHERE `info_request_status='pending'` AND `info_request_deadline < now`
  - For each: set `status='cancelled'`, `info_request_status='expired'`
  - Notify employee + approver via LINE

**Files:**
- `apps-script/line_api.gs` (Flex builder, quick reply)
- `apps-script/Code.gs` (postback routing)
- `apps-script/approval.gs` (handleInfoRequest)
- `apps-script/reconcile.gs` (respondInfoRequest)
- `apps-script/scheduler.gs` (infoRequestTimeoutTick)
- `apps-script/setup.gs` (Settings + Leave_Records headers)
- `frontend/src/respond.html` (new LIFF page)
- `frontend/src/api.js` (call respondInfoRequest)

**Acceptance:**
- Approver กด ขอข้อมูลเพิ่ม → quick reply เด้ง → เลือก "ขอหลักฐาน" → พนักงานได้ LINE message
- พนักงานเปิด LIFF respond.html → กรอก response → ส่ง → approver ได้ Flex รอบใหม่
- Approver ขอ info ได้หลายรอบ (count เพิ่มทุกครั้ง)
- ถ้าพนักงานไม่ตอบใน 30 นาที → infoRequestTimeoutTick set status=cancelled + ส่ง LINE
- จำนวน rows ของ leave (multi-day) — ทุก row ของ request_group_id เดียวกัน update พร้อมกัน

---

### Feature 3.2: Conditional Approve

**Problem:** บางใบลาควรอนุมัติ "แบบมีเงื่อนไข" — ให้ลาก่อน แต่ต้องส่งหลักฐานหลังกลับมา ถ้าไม่ส่ง = ผิดระเบียบ

**Spec:**

Flex Message change ใน `sendApprovalFlex`:
- footer มี 4 ปุ่ม:
  - `[✅ อนุมัติ]` — approve เด็ดขาดตามเดิม
  - `[✅⏳ อนุมัติแบบมีเงื่อนไข]` — approve + flag conditional
  - `[❌ ปฏิเสธ]`
  - `[ℹ️ ขอข้อมูลเพิ่ม]` (จาก Feature 3.1)

Postback action ใหม่: `approve_conditional_leave`
- Status flow:
  - level_X_status = `approved`
  - top-level status = `approved` (ถ้า level นี้คือ final)
  - `conditional_evidence_required` = `true`
  - `conditional_evidence_deadline` = end_date + CONDITIONAL_EVIDENCE_DAYS_AFTER_END
- ส่ง LINE หาพนักงานทันที:
  ```
  ✅ ใบลา {date} ได้รับการอนุมัติ (แบบมีเงื่อนไข)
  
  คุณต้องส่งหลักฐานเพิ่ม: {evidence_type ที่ระบุ}
  ภายใน {deadline_date}
  
  [ส่งหลักฐาน]  ← LIFF link to respond.html?mode=evidence
  ```

หลัง end_date + 1 → ส่ง reminder ให้พนักงาน:
- ทำใน function ใหม่ `conditionalEvidenceCheckTick()`
- Time trigger: ทุกวัน 09:00
- Logic A (T-day - 0): หาใบลาที่ deadline = วันนี้ + ยังไม่ส่ง → ส่ง reminder
- Logic B (T-day + 1): หาใบลาที่ deadline ผ่านมา 1 วัน + ยังไม่ส่ง → set `flag_compliance_issue=true` + ส่ง LINE หา HR (role=hr ใน LINE_User_Map):
  ```
  🚨 พนักงาน {name} ไม่ส่งหลักฐานตามเงื่อนไข
  ใบลา: {date} ประเภท: {type}
  Deadline ผ่าน: {deadline_date}
  
  กรุณาเรียกพบเพื่อสอบสวน
  ```

LIFF respond.html (extend จาก Feature 3.1):
- Mode `evidence`: query param `?leave_id=<id>&mode=evidence`
- ฟอร์ม: URL หลักฐาน + evidence type
- Submit → action `submitConditionalEvidence`
- Backend: update `conditional_evidence_received_at`, `evidence_url`

Schema (`Leave_Records` เพิ่ม):
- `conditional_evidence_required` (boolean)
- `conditional_evidence_deadline` (date)
- `conditional_evidence_received_at` (datetime)
- `flag_compliance_issue` (boolean)

Settings:
- `CONDITIONAL_EVIDENCE_DAYS_AFTER_END` = `1`

**Files:**
- `apps-script/line_api.gs` (Flex builder add 4th button)
- `apps-script/Code.gs` (postback routing)
- `apps-script/approval.gs` (handleApprovalAction case approve_conditional_leave)
- `apps-script/scheduler.gs` (conditionalEvidenceCheckTick)
- `apps-script/reconcile.gs` (submitConditionalEvidence handler)
- `apps-script/setup.gs` (Settings + Leave_Records headers)
- `frontend/src/respond.html` (mode=evidence)

**Acceptance:**
- Approver กด "อนุมัติแบบมีเงื่อนไข" → leave status=approved, conditional flag=true, employee ได้ LINE
- Day after deadline + 1 → conditionalEvidenceCheckTick set flag_compliance_issue=true, HR ได้ LINE
- Employee เปิด LIFF respond.html?mode=evidence → กรอก URL → submit → flag ถูก mark resolved

---

## Schema Summary — Leave_Records ใหม่

หลัง 3 PRs ครบ คอลัมน์ใน `Leave_Records` ทั้งหมด:

```
ของเดิม (PR-0):
- leave_id, emp_code, date, leave_type, reason
- submitted_at, status
- request_group_id, days_in_request, required_levels
- level_1/2/3 (status, approver, at) × 3
- final_approved_at, is_backdated, evidence_url

PR-1 เพิ่ม:
- evidence_type, evidence_pending

PR-2 เพิ่ม:
- duration_unit, half_day_period, hour_start, hour_end, days_equivalent
- is_emergency

PR-3 เพิ่ม:
- info_request_status, info_request_count, info_request_deadline
- info_request_message, info_request_response
- conditional_evidence_required, conditional_evidence_deadline
- conditional_evidence_received_at, flag_compliance_issue
```

รวม **15 columns ใหม่** + **5 keys ใน Settings ใหม่**

Migration strategy: ใน `setup.gs` เพิ่ม column ใหม่ที่ท้าย header — existing rows ที่ไม่มีค่าจะเป็น empty (treat as default)

---

## Settings Summary

```
ของเดิม:
CUTOFF_DAY, CUTOFF_MODE, REMINDER_ENABLED, REMINDER_DAYS_BEFORE,
REMINDER_TIME, SHIFT_HOURS, SHORT_WORK_TOLERANCE_MIN, OT_MATCH_TOLERANCE_MIN,
BACKDATED_REQUIRES_OWNER

PR-2 เพิ่ม:
LEAVE_PERSONAL_MIN_ADVANCE_DAYS = 3
LEAVE_SICK_MIN_ADVANCE_HOURS = 1

PR-3 เพิ่ม:
INFO_REQUEST_TIMEOUT_MINUTES = 30
CONDITIONAL_EVIDENCE_DAYS_AFTER_END = 1
```

---

## Triggers Summary

หลัง 3 PRs ครบ Apps Script triggers ที่ต้องตั้ง:

1. **dailyReminderTick** (เดิม) — รัน 09:00 ทุกวัน
2. **infoRequestTimeoutTick** (PR-3) — รันทุก 5 นาที
3. **conditionalEvidenceCheckTick** (PR-3) — รัน 09:00 ทุกวัน
