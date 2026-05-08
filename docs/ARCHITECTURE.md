# Payroll Mini System — Architecture Spec

> ระบบเงินเดือนแบบแยกชั้นข้อมูล (Privacy-First Payroll)
> Stack: Google Sheets + Apps Script + Drive

---

## 1. หลักการออกแบบ (Design Principles)

| # | หลักการ | เหตุผล |
|---|---------|--------|
| 1 | Privacy by Separation | HR ไม่เห็นเงินเดือน, พนักงานไม่เห็นของคนอื่น |
| 2 | Default Deny | ไม่มาทำงาน = ขาดงาน จนกว่าจะมีหลักฐาน override |
| 3 | Evidence-Based Override | ทุกการเปลี่ยน status ต้องมีหลักฐาน (ใบลา/ใบ OT) |
| 4 | Auto-Match First, Escalate Later | ระบบจับคู่ก่อน ถ้าไม่ตรงค่อยส่งคนตรวจ |
| 5 | Append-Only Audit | log ทุก action, ห้ามลบย้อนหลัง |
| 6 | Locked Period | รอบที่ปิดแล้วล็อก ไม่ให้แก้ |

---

## 2. Data Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PUBLIC LAYER (HR + Owner เข้าได้)                          │
│  Drive Folder: /Payroll/[Company]/Public/                   │
│  ─────────────────────────────────                          │
│  • Employee_Registry      ทะเบียนพนักงาน (ไม่มีเงินเดือน)   │
│  • Attendance_[YYYY-MM]   การเข้างาน                        │
│  • Leave_Records          ใบลา + สิทธิ์คงเหลือ              │
│  • OT_Requests            ใบขอ OT                           │
│  • Holiday_Calendar       วันหยุดบริษัท                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ (วันทำงาน, OT ชั่วโมง, ลาเกินสิทธิ์)
                            │
┌─────────────────────────────────────────────────────────────┐
│  SECRET LAYER (Owner เท่านั้น)                              │
│  Drive Folder: /Payroll/[Company]/Secret/ (restricted)      │
│  ─────────────────────────────────                          │
│  • Salary_Master          เงินเดือน base + อัตรา OT         │
│  • Recurring_Deductions   ภาษี, สปส., กยศ., เงินกู้         │
│  • Monthly_Adjustments    เงินเพิ่ม/หักพิเศษรายเดือน         │
│  • Payroll_Run_[YYYY-MM]  ผลการคำนวณรอบนั้น                 │
│  • YTD_Accumulator        ยอดสะสมรายปี                      │
│  • Audit_Log              log append-only                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ (PDF slip รายคน)
                            │
┌─────────────────────────────────────────────────────────────┐
│  OUTPUT LAYER (พนักงานคนนั้นเท่านั้น)                       │
│  ─────────────────────────────────                          │
│  • ส่งตรงเข้าเมลพนักงาน (BCC ไม่ผ่าน HR)                    │
│  • Optional: เก็บ copy ใน secret folder                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Access Control Matrix

| Resource | Owner | HR | หัวหน้างาน | พนักงาน |
|----------|:-----:|:--:|:----------:|:-------:|
| Employee_Registry | RW | RW | R | R (ของตัวเอง) |
| Attendance | RW | RW | R | R (ของตัวเอง) |
| Leave_Records | RW | RW | R+approve | R+submit |
| OT_Requests | RW | R | R+approve | R+submit |
| Salary_Master | RW | ❌ | ❌ | ❌ |
| Monthly_Adjustments | RW | ❌ | submit only | ❌ |
| Payroll_Run | RW | ❌ | ❌ | ❌ |
| Audit_Log | R | ❌ | ❌ | ❌ |
| สลิปของตัวเอง | R | ❌ | ❌ | R |

> **R** = อ่าน, **W** = เขียน, **❌** = เข้าไม่ได้

---

## 4. Processing Pipeline (8 ขั้น)

### ขั้นที่ 1 — INGEST (นำเข้าข้อมูล)
**Input:** ไฟล์สแกนนิ้ว (CSV/Excel จากเครื่อง), ใบลา, ใบขอ OT
**ที่อยู่:** Public Layer
**Output:** ข้อมูลดิบใน `Attendance_Raw_[YYYY-MM]`

**ข้อกำหนด:**
- รองรับ format มาตรฐาน: รหัสพนักงาน + วันที่ + เวลาเข้า + เวลาออก
- ถ้าเครื่องสแกนมีหลาย format → ใช้ adapter แปลงก่อน
- ไม่ overwrite ข้อมูลเก่า — append เท่านั้น

---

### ขั้นที่ 2 — ATTENDANCE RECONCILE (กระทบยอดการเข้างาน)
**Logic:**
```
สำหรับแต่ละพนักงาน × แต่ละวันในเดือน:

  สถานะเริ่มต้น = "ขาดงาน"

  IF วันนั้นเป็นวันหยุดบริษัท (Holiday_Calendar):
      สถานะ = "หยุด"

  ELSE IF มีบันทึกสแกนนิ้ว:
      IF เวลาทำงาน >= 8 ชั่วโมง: สถานะ = "ทำงาน"
      ELSE: สถานะ = "ทำงานไม่ครบ"   ← flag ไว้ escalate

  IF มีใบลา approved คลุมวันนั้น:
      สถานะ = "ลา ([ประเภท])"
      หัก สิทธิ์การลาคงเหลือ 1 วัน

      IF สิทธิ์คงเหลือ < 0:
          สถานะ = "ลาเกินสิทธิ์"   ← จะถูกหักเงินใน step 5

  IF มีลาแต่ไม่สแกนเข้างาน + ไม่มีใบลา:
      สถานะ = "ขาดงาน"   ← จะถูกหักเงิน
```

**Output:** `Attendance_Reconciled_[YYYY-MM]` — ตาราง [วันที่][พนักงาน] = สถานะ

---

### ขั้นที่ 3 — OT MATCH (จับคู่ OT)
**Logic:**
```
หาเวลาที่เกินกะปกติของแต่ละวัน → "OT จริง"

จับคู่กับใบขอ OT ที่ approved:

  IF OT จริง ตรงกับ OT ขอ (±15 นาที):
      สถานะ = "OT approved"
      บันทึก ชั่วโมง × ประเภท

  IF OT จริง > OT ขอ:
      สถานะ = "OT เกินที่ขอ"   ← escalate
      จ่ายเฉพาะส่วนที่ขอ

  IF OT จริง < OT ขอ:
      สถานะ = "OT ไม่ครบที่ขอ"   ← escalate
      จ่ายเฉพาะส่วนที่ทำจริง

  IF มี OT จริง แต่ไม่มีใบขอ:
      สถานะ = "OT ไม่ได้ขอ"   ← escalate (ไม่จ่ายอัตโนมัติ)
```

**ประเภท OT (ตามกฎหมายแรงงาน):**
| ประเภท | กรณี | อัตรา |
|--------|------|------|
| OT-1 | เกินเวลาวันทำงานปกติ | 1.5 เท่า |
| OT-2 | ทำงานในวันหยุด (พนักงานรายเดือน) | 1 เท่า |
| OT-3 | เกินเวลาในวันหยุด | 3 เท่า |

**Output:** `OT_Approved_[YYYY-MM]` + `OT_Escalation_[YYYY-MM]`

---

### ขั้นที่ 4 — DAY COUNT (สรุปวัน) ⭐ จุดเปลี่ยน Public→Secret
**Output ที่ส่งต่อให้ Secret Layer:**

| Field | คำอธิบาย |
|-------|---------|
| working_days | วันที่ทำงานครบ |
| short_days | วันที่ทำงานไม่ครบ (escalate) |
| paid_leave_days | ลาที่มีสิทธิ์ |
| unpaid_leave_days | ลาเกินสิทธิ์ (หักเงิน) |
| absent_days | ขาดงาน (หักเงิน) |
| holiday_days | วันหยุด |
| ot_1_hours | OT 1.5 เท่า |
| ot_2_hours | OT 1 เท่า (วันหยุด) |
| ot_3_hours | OT 3 เท่า |

> **สำคัญ:** ข้อมูลที่ผ่านขั้นนี้ไป **ไม่มีตัวเลขเงิน** เลย — มีแต่จำนวนวัน/ชั่วโมง

---

### ขั้นที่ 5 — CALCULATE GROSS (คำนวณค่าจ้างก่อนหัก) [Secret]

```
อัตรารายวัน = เงินเดือน_base ÷ 30   (ตามมาตรา 68 พ.ร.บ.คุ้มครองแรงงาน)

base_pay = เงินเดือน_base
unpaid_leave_deduct = unpaid_leave_days × อัตรารายวัน
absent_deduct = absent_days × อัตรารายวัน

ot_pay = (ot_1_hours × อัตรารายชั่วโมง × 1.5)
       + (ot_2_hours × อัตรารายชั่วโมง × 1.0)
       + (ot_3_hours × อัตรารายชั่วโมง × 3.0)

อัตรารายชั่วโมง = อัตรารายวัน ÷ 8

GROSS = base_pay − unpaid_leave_deduct − absent_deduct + ot_pay
```

---

### ขั้นที่ 6 — ADD/DEDUCT (เพิ่ม/หัก) [Secret]

**Auto Deductions (จาก Recurring_Deductions):**
- ภาษีหัก ณ ที่จ่าย (คำนวณจาก expected annual income)
- ประกันสังคม (5% ของเงินเดือน, max 750 บาท/เดือน)
- กยศ. (จำนวนคงที่)
- เงินกู้บริษัท (จำนวนคงที่)

**Manual Adjustments (จาก Monthly_Adjustments):**
- เงินเพิ่ม: เบี้ยขยัน, รางวัล, เงินเบิกจ่าย, commission
- เงินหัก: ค่าเสียหาย, หักล่วงหน้า, อื่นๆ

```
NET = GROSS
    + sum(monthly_additions)
    − sum(auto_deductions)
    − sum(manual_deductions)
```

---

### ขั้นที่ 7 — ACCUMULATE (สะสมยอด) [Secret]

Update `YTD_Accumulator`:
- gross_ytd
- net_ytd
- tax_ytd
- sso_ytd (ประกันสังคมสะสม)
- pf_ytd (กองทุนสำรองเลี้ยงชีพสะสม ถ้ามี)

> ใช้สำหรับ: ภงด.91 ปลายปี, สปส.1-10ก, สลิปที่แสดง YTD

---

### ขั้นที่ 8 — SLIP & SEND (ออกสลิป + ส่ง)

**Slip ประกอบด้วย:**
1. ข้อมูลพนักงาน (รหัส, ชื่อ, ตำแหน่ง)
2. ช่วงเวลา (1–31 ของเดือน)
3. รายการเงินได้ (base, OT, เงินเพิ่ม)
4. รายการเงินหัก (ภาษี, สปส., หักอื่น)
5. ยอดสุทธิ
6. ยอดสะสม YTD
7. หมายเหตุ (ถ้ามีรายการ escalate ที่ยังไม่ resolve)

**Delivery:**
- ส่งเข้าเมลพนักงานโดยตรง (ใช้เมลในทะเบียน)
- BCC: เจ้าของ (optional, สำหรับ audit)
- HR ไม่ได้รับ

**Storage:**
- เก็บ PDF ใน Secret Layer
- ตั้งชื่อ: `slip_[empcode]_[YYYY-MM].pdf`

---

## 5. Audit & Compliance

### Audit Log Schema
ทุก action เขียน 1 row:

| timestamp | actor_email | action | target | before | after | reason |

**Action types:**
- `INGEST` — นำเข้าข้อมูล
- `OVERRIDE_STATUS` — เปลี่ยนสถานะการเข้างาน
- `APPROVE_OT` — อนุมัติ OT
- `ADD_ADJUSTMENT` — เพิ่มรายการ adjustment
- `RUN_PAYROLL` — รันรอบเงินเดือน
- `LOCK_PERIOD` — ล็อกรอบ
- `SEND_SLIP` — ส่งสลิป
- `EXPORT` — export ข้อมูล

### Locked Period Rule
- รอบที่ "Run Payroll" + "Send Slip" สำเร็จ → lock
- หลัง lock: แก้ไขทุกอย่างต้องสร้าง "ใบปรับปรุง" รอบถัดไป
- ป้องกัน HR/เจ้าของแก้ย้อนหลังโดยไม่มี trace

---

## 6. Escalation Queue

ทุก case ที่ไม่ผ่าน auto-match → เข้า `Escalation_Queue`:

| status | คำอธิบาย | resolver |
|--------|---------|----------|
| short_work | ทำงานไม่ครบ 8 ชม. | หัวหน้างาน |
| ot_mismatch | OT จริงไม่ตรงใบขอ | หัวหน้างาน |
| ot_unrequested | OT ไม่ได้ขอ | เจ้าของ |
| absent_no_evidence | ขาดงานไม่มีใบลา | หัวหน้างาน |
| over_leave_quota | ลาเกินสิทธิ์ | เจ้าของ |

> ทุก case ต้อง resolve ก่อนปิดรอบ (lock)

---

## 7. Roles & Permissions (Apps Script)

```
Owner       → ทำได้ทุกอย่าง รวมถึงแก้ Salary_Master
HR          → จัดการ Public Layer, เห็นวัน-ชม. แต่ไม่เห็นเงิน
Supervisor  → approve ใบลา/ใบ OT, resolve escalation
Employee    → ส่งใบลา/ใบ OT, ดูสลิปตัวเอง
```

Apps Script ตรวจ `Session.getActiveUser().getEmail()` ทุกครั้งก่อนทำ sensitive op

---

## 8. ขอบเขตที่ "ไม่ทำ" ใน MVP นี้

| ไม่ทำ | เหตุผล |
|-------|--------|
| ภงด.1 / 1ก auto-export | ใช้บัญชีตรวจอีกครั้งสิ้นปีจะปลอดภัยกว่า |
| สปส.1-10ก auto-export | ส่งงานราชการต้องแม่นยำสูง — phase 2 |
| Direct deposit / bank API | ความเสี่ยงสูง ใช้ manual transfer ก่อน |
| Time tracking app | ยังพึ่ง CSV จากเครื่องสแกน |
| Mobile app | สลิปส่งทางเมลพอ |
| Multi-company | 1 deployment = 1 บริษัท |

---

## 9. Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Sheet ถูก share ผิดคน | 1 Sheet/บริษัท, owner = ลูกค้าเอง, audit log |
| สูตรภาษีผิด | บอกลูกค้าว่าเป็น "ประมาณการ", สิ้นปีให้บัญชีตรวจ |
| Apps Script timeout (>6 นาที) | ประมวลผลเป็น batch, สูงสุด 50 คน/รอบ |
| ลูกค้าลบ Audit_Log | log เก็บใน sheet แยก + protected range + backup รายวัน |
| HR แอบดู Secret Folder | Drive permission แยก folder + auto-revoke ทุกเดือน |
| สลิปส่งผิดคน | double-check email vs employee_code ก่อนส่ง |

---

## 10. Phase Plan

| Phase | ระยะเวลา | Scope |
|-------|---------|-------|
| **Phase 1** | สัปดาห์ 1–2 | Sheet schema + Attendance reconcile (ขั้น 1–4) |
| **Phase 2** | สัปดาห์ 3 | Salary calc + Slip generation (ขั้น 5–8) |
| **Phase 3** | สัปดาห์ 4 | Audit log + Lock period + Escalation UI |
| **Phase 4** | (ภายหลัง) | ภงด./สปส. export, dashboard เจ้าของ |
