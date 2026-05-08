# Payroll Mini System — Sheet Schema

> โครงสร้าง Google Sheet ทุก tab พร้อม column และสูตรสำคัญ
> แยกเป็น 2 Sheet หลัก: **Public Sheet** + **Secret Sheet**

---

## Sheet A — PUBLIC SHEET (HR + Owner)
ชื่อไฟล์: `Payroll_Public_[Company]`

### Tab A1 — `Employees`
**ใครเขียน:** HR + Owner
**ใครอ่าน:** ทุกคน (พนักงานเห็นเฉพาะ row ตัวเอง — ใช้ filter view)

| Column | Type | Required | คำอธิบาย |
|--------|------|:--------:|---------|
| emp_code | text | ✓ | รหัสพนักงาน (unique) |
| first_name | text | ✓ | ชื่อ |
| last_name | text | ✓ | นามสกุล |
| nickname | text | | ชื่อเล่น |
| national_id | text | ✓ | เลขบัตร ปชช. (13 หลัก) |
| birth_date | date | | วันเกิด |
| email | email | ✓ | อีเมลส่วนตัว (สำหรับส่งสลิป) |
| phone | text | | เบอร์โทร |
| department | text | ✓ | แผนก |
| position | text | ✓ | ตำแหน่ง |
| supervisor_email | email | | อีเมลหัวหน้างาน |
| start_date | date | ✓ | วันเริ่มงาน |
| end_date | date | | วันสิ้นสุด (ถ้าออกแล้ว) |
| status | enum | ✓ | active / probation / resigned / terminated |
| sso_number | text | | เลขประกันสังคม |
| bank | text | | ธนาคาร |
| bank_account | text | | เลขบัญชี (มาส์ก 4 หลักท้าย) |

> **ไม่มี salary, ไม่มี wage rate, ไม่มี hourly rate**

---

### Tab A2 — `Holiday_Calendar`
**ใครเขียน:** HR + Owner
**ใครอ่าน:** ทุกคน

| Column | Type | Required | คำอธิบาย |
|--------|------|:--------:|---------|
| date | date | ✓ | วันที่ |
| name | text | ✓ | ชื่อวันหยุด |
| type | enum | ✓ | public / company / substitute |
| applies_to | text | | "all" หรือ list department |

---

### Tab A3 — `Leave_Quota`
**ใครเขียน:** HR + Owner
**ใครอ่าน:** ทุกคน (พนักงานเห็นของตัวเอง)

| Column | Type | Required | คำอธิบาย |
|--------|------|:--------:|---------|
| emp_code | text | ✓ | FK → Employees |
| year | number | ✓ | ปี (เช่น 2026) |
| sick_quota | number | ✓ | สิทธิ์ลาป่วย (default 30) |
| sick_used | formula | | =COUNTIF จาก Leave_Records |
| personal_quota | number | ✓ | สิทธิ์ลากิจ (ตามบริษัท) |
| personal_used | formula | | =COUNTIF |
| vacation_quota | number | ✓ | สิทธิ์พักร้อน |
| vacation_used | formula | | =COUNTIF |

**สูตรสำคัญ:**
```
sick_used =
  COUNTIFS(Leave_Records!emp_code, A2,
           Leave_Records!leave_type, "sick",
           Leave_Records!status, "approved",
           Leave_Records!date, ">="&DATE(B2,1,1),
           Leave_Records!date, "<="&DATE(B2,12,31))
```

---

### Tab A4 — `Leave_Records`
**ใครเขียน:** พนักงาน (ส่ง), หัวหน้า (อนุมัติ)
**ใครอ่าน:** ทุกคน

| Column | Type | Required | คำอธิบาย |
|--------|------|:--------:|---------|
| leave_id | text | ✓ | auto-generate LV-YYYYMMDD-NNN |
| emp_code | text | ✓ | FK |
| date | date | ✓ | วันที่ลา (1 row = 1 วัน) |
| leave_type | enum | ✓ | sick / personal / vacation / unpaid / maternity |
| reason | text | | เหตุผล |
| submitted_at | datetime | ✓ | auto |
| status | enum | ✓ | pending / approved / rejected |
| approved_by | email | | หัวหน้างานที่อนุมัติ |
| approved_at | datetime | | auto เมื่อกด approve |
| evidence_url | url | | ใบรับรองแพทย์ ฯลฯ |

> ⚠️ ถ้าลา 3 วัน ใส่ 3 rows (ขั้น reconcile ทำได้ง่ายกว่า)

---

### Tab A5 — `OT_Requests`
**ใครเขียน:** พนักงาน (ส่ง), หัวหน้า (อนุมัติ)
**ใครอ่าน:** ทุกคน

| Column | Type | Required | คำอธิบาย |
|--------|------|:--------:|---------|
| ot_id | text | ✓ | auto-generate OT-YYYYMMDD-NNN |
| emp_code | text | ✓ | FK |
| date | date | ✓ | วันที่ทำ OT |
| start_time | time | ✓ | เริ่ม |
| end_time | time | ✓ | สิ้นสุด |
| ot_type | enum | ✓ | ot_1 / ot_2 / ot_3 |
| reason | text | ✓ | เหตุผลที่ต้องทำ OT |
| submitted_at | datetime | ✓ | auto |
| status | enum | ✓ | pending / approved / rejected |
| approved_by | email | | หัวหน้างาน |
| approved_at | datetime | | |

---

### Tab A6 — `Attendance_Raw_[YYYY-MM]`
**ใครเขียน:** ระบบ (import จากเครื่องสแกน) หรือ HR
**ใครอ่าน:** ทุกคน

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| date | date | |
| clock_in | time | เวลาเข้า (เร็วสุดในวัน) |
| clock_out | time | เวลาออก (ช้าสุดในวัน) |
| total_minutes | number | นาทีที่อยู่ในที่ทำงาน |
| source | text | "fingerprint" / "manual" / "import" |
| imported_at | datetime | auto |

> **Note:** ตารางนี้ append-only — ไม่แก้ row เก่า

---

### Tab A7 — `Attendance_Reconciled_[YYYY-MM]` ⭐ Output ของขั้น 2-3
**ใครเขียน:** Apps Script (อัตโนมัติ)
**ใครอ่าน:** HR + Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| date | date | |
| status | enum | working / short_work / on_leave / absent / holiday / over_quota |
| leave_type | text | ถ้า status=on_leave |
| ot_1_minutes | number | OT 1.5x |
| ot_2_minutes | number | OT 1x (วันหยุด) |
| ot_3_minutes | number | OT 3x |
| escalation_flag | bool | TRUE ถ้าต้อง escalate |
| escalation_reason | text | |
| reconciled_at | datetime | auto |

---

### Tab A8 — `Monthly_Summary_[YYYY-MM]` ⭐ Output ของขั้น 4
**ใครเขียน:** Apps Script
**ใครอ่าน:** HR + Owner

> **นี่คือ "เส้นแบ่ง"** — output ตารางนี้คือสิ่งเดียวที่ส่งเข้า Secret Sheet

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| period | text | YYYY-MM |
| working_days | number | |
| short_days | number | |
| paid_leave_days | number | |
| unpaid_leave_days | number | |
| absent_days | number | |
| holiday_days | number | |
| ot_1_hours | number | |
| ot_2_hours | number | |
| ot_3_hours | number | |
| has_unresolved | bool | TRUE = ยังมี escalation รอ |
| computed_at | datetime | auto |
| locked | bool | TRUE = ปิดรอบแล้ว |

---

### Tab A9 — `Escalation_Queue`
**ใครเขียน:** Apps Script
**ใครอ่าน + แก้:** หัวหน้า, Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| esc_id | text | auto |
| emp_code | text | FK |
| date | date | |
| type | enum | short_work / ot_mismatch / ot_unrequested / absent_no_evidence / over_leave_quota |
| detail | text | |
| created_at | datetime | auto |
| status | enum | pending / resolved / ignored |
| resolved_by | email | |
| resolved_at | datetime | |
| resolution_note | text | คำอธิบาย / decision |

---

## Sheet B — SECRET SHEET (Owner เท่านั้น)
ชื่อไฟล์: `Payroll_Secret_[Company]` (folder permission แยก)

### Tab B1 — `Salary_Master`
**ใครเขียน + อ่าน:** Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK → Public.Employees |
| effective_date | date | วันที่อัตรานี้เริ่มใช้ |
| base_salary | number | เงินเดือน base (บาท) |
| daily_rate | formula | =base_salary / 30 |
| hourly_rate | formula | =daily_rate / 8 |
| ot_1_rate | formula | =hourly_rate * 1.5 |
| ot_2_rate | formula | =hourly_rate * 1.0 |
| ot_3_rate | formula | =hourly_rate * 3.0 |
| sso_eligible | bool | เข้าประกันสังคมหรือไม่ |
| pf_rate | number | % กองทุนสำรอง (ถ้ามี) |
| note | text | |

> ⚠️ **ห้ามลบ row เก่า** — ใส่ row ใหม่พร้อม effective_date เพื่อเก็บ history

---

### Tab B2 — `Recurring_Deductions`
**ใครเขียน + อ่าน:** Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| deduction_type | enum | tax / sso / studentloan / company_loan / pf |
| amount | number | บาท/เดือน |
| effective_from | date | |
| effective_to | date | (ถ้ามี end) |
| note | text | |

**สูตรประกันสังคม (auto):**
```
sso_amount = MIN(base_salary * 0.05, 750)
```

---

### Tab B3 — `Monthly_Adjustments_[YYYY-MM]`
**ใครเขียน:** Owner (หรือหัวหน้า submit ผ่าน form)
**ใครอ่าน:** Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| adj_id | text | auto |
| emp_code | text | FK |
| period | text | YYYY-MM |
| direction | enum | add / deduct |
| category | enum | bonus / commission / diligence / reimburse / damage / advance / other |
| amount | number | บาท (เป็นบวกเสมอ) |
| reason | text | ✓ บังคับ |
| approved_by | email | |
| created_at | datetime | auto |

---

### Tab B4 — `Payroll_Run_[YYYY-MM]` ⭐ Output ของขั้น 5-7
**ใครเขียน:** Apps Script (เมื่อกด "Run Payroll")
**ใครอ่าน:** Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| period | text | YYYY-MM |
| **— Earnings —** | | |
| base_pay | number | from Salary_Master |
| working_days_paid | number | จาก Monthly_Summary |
| unpaid_leave_deduct | number | unpaid_leave_days × daily_rate |
| absent_deduct | number | absent_days × daily_rate |
| ot_1_pay | number | |
| ot_2_pay | number | |
| ot_3_pay | number | |
| additions_total | number | sum จาก Adjustments (add) |
| **gross** | formula | =base_pay − unpaid_leave_deduct − absent_deduct + ot_pays + additions |
| **— Deductions —** | | |
| tax_amount | number | |
| sso_amount | number | |
| studentloan_amount | number | |
| companyloan_amount | number | |
| pf_amount | number | |
| manual_deductions | number | sum จาก Adjustments (deduct) |
| **deductions_total** | formula | sum ของ deduction columns |
| **— Final —** | | |
| **net** | formula | =gross − deductions_total |
| status | enum | draft / locked / sent |
| computed_at | datetime | auto |
| sent_at | datetime | เมื่อส่งสลิป |

---

### Tab B5 — `YTD_Accumulator`
**ใครเขียน:** Apps Script (อัตโนมัติหลัง lock)

| Column | Type | คำอธิบาย |
|--------|------|---------|
| emp_code | text | FK |
| year | number | |
| gross_ytd | number | |
| net_ytd | number | |
| tax_ytd | number | |
| sso_ytd | number | |
| pf_ytd | number | |
| ot_pay_ytd | number | |
| last_updated | datetime | auto |

---

### Tab B6 — `Audit_Log`
**ใครเขียน:** Apps Script เท่านั้น (no manual edit)
**ใครอ่าน:** Owner

| Column | Type | คำอธิบาย |
|--------|------|---------|
| log_id | text | auto sequential |
| timestamp | datetime | |
| actor_email | email | |
| action | enum | (ดู Architecture §5) |
| target_type | text | employee / payroll_run / adjustment / etc. |
| target_id | text | |
| before | json | |
| after | json | |
| reason | text | |

> Apps Script: ใส่ `protected range` ห้ามแก้ + backup ไป Drive รายวัน

---

## Sheet C — ESCALATION (Public, แต่ filtered)
อยู่ใน Public Sheet ที่ tab `Escalation_Queue` (A9)

หัวหน้างานเข้ามา resolve ผ่าน Sheet โดยตรง หรือผ่าน sidebar form

---

## สูตรสำคัญที่ต้องเขียน (ไม่ใช่ Apps Script)

### 1. นับวันทำงานในเดือน (ไม่รวมวันหยุด)
```
=NETWORKDAYS.INTL(start_date, end_date, "0000000",
  FILTER(Holiday_Calendar!date,
         Holiday_Calendar!date>=start_date,
         Holiday_Calendar!date<=end_date))
```

### 2. คำนวณภาษีหัก ณ ที่จ่าย (ก้าวหน้า 7 ขั้น ปี 2569)
```
expected_annual = (gross × 12) − 100000   // ค่าใช้จ่าย 50% สูงสุด 100k
                                             − ลดหย่อนส่วนตัว 60000
                                             − ลดหย่อนอื่น (ถ้ามี)

annual_tax = ตามขั้น:
  0–150,000        → 0%
  150,001–300,000   → 5%
  300,001–500,000   → 10%
  500,001–750,000   → 15%
  750,001–1,000,000 → 20%
  1,000,001–2M      → 25%
  2,000,001–5M      → 30%
  5M+              → 35%

monthly_tax = annual_tax / 12
```

> ⚠️ สูตรนี้สมมติ — ต้องคำนวณตามลดหย่อนจริงของแต่ละคน
> **แนะนำ:** เก็บใน tab `Tax_Settings` ให้ owner ปรับเองได้

---

## Form Inputs (Google Form ที่ผูกกับ Sheet)

### Form 1 — ส่งใบลา (พนักงาน)
→ เขียนเข้า `Leave_Records` status=pending

### Form 2 — ขอ OT (พนักงาน)
→ เขียนเข้า `OT_Requests` status=pending

### Form 3 — Submit Adjustment (หัวหน้า)
→ เขียนเข้า `Monthly_Adjustments` รอ Owner approve

> ใช้ Form แทนการให้พิมพ์ลง Sheet โดยตรง — ลด human error

---

## Naming Convention

| Pattern | ตัวอย่าง |
|---------|---------|
| ทะเบียน | `Employees`, `Holiday_Calendar`, `Leave_Quota` |
| รายเดือน | `Attendance_Raw_2026-05`, `Payroll_Run_2026-05` |
| Records | `Leave_Records`, `OT_Requests` |
| ID format | `LV-20260508-001`, `OT-20260508-001`, `ESC-20260508-001` |
