# Admin SOP — รอบเดือน Payroll

ขั้นตอนสำหรับ **OWNER** (ผู้จัดทำเงินเดือน) ในการรันรอบเดือน ตั้งแต่ก่อน cutoff จนถึงล็อคงวด

ทุกคำสั่งสามารถสั่งได้ 2 ทาง:
- **LINE chat** — พิมพ์ข้อความใน OA (เช่น `/reconcile`, `/payroll`)
- **LIFF owner.html** — เปิดจากเมนู → กล่องอนุมัติ + ปุ่ม Reconcile / Payroll

---

## 1. Daily / Weekly — Approvals

ใบลาและคำขอ OT เข้ามาตลอดเดือน ทำได้ 2 ทาง:

### 1.1 ผ่าน Flex Message
ทุกครั้งที่พนักงานส่งใบลา/OT ระบบส่ง Flex Message พร้อมปุ่ม **อนุมัติ / ปฏิเสธ** เข้า chat ของ OWNER

- กดปุ่มในแชท → ระบบจะตอบกลับด้วยข้อความยืนยัน
- กดซ้ำ → ระบบบอก "คุณได้อนุมัติไว้แล้ว — ไม่ต้องกดซ้ำ"
- พนักงานจะได้รับแจ้งผลโดยอัตโนมัติ

### 1.2 ผ่าน owner.html (batch)
เปิดจาก LIFF menu → **กล่องอนุมัติ**

- รายการรออนุมัติทั้งหมดเรียงเวลาส่งล่าสุด
- ใบลาแสดง: ชื่อ-สกุล · แผนก · ประเภท · ช่วงวันที่ · จำนวนวัน · เหตุผล
- OT แสดง: ชื่อ · แผนก · ประเภท + อัตรา · วันที่ · ช่วงเวลา · เหตุผล
- ป้าย `L1/N` บอกระดับการอนุมัติ · `ย้อนหลัง` ถ้า backdated
- กดปุ่ม → list refresh ทันที

> **เคล็ด:** กล่องอนุมัติแสดงเฉพาะรายการที่คุณ "ต้อง" ตัดสินในระดับนั้น ไม่รวมรายการที่อยู่ระหว่าง L2/L3 ของคนอื่น

---

## 2. ก่อน CUTOFF_DAY — เตรียมข้อมูล

`CUTOFF_DAY` ตั้งค่าใน `Settings` tab (default = 25)

หลังคุยกับทีมรอบนี้ ตรวจ:

| รายการ | ที่ไหน | ทำอะไร |
|---|---|---|
| Attendance | Public → `Attendance_Raw` | Import scan ทั้งเดือน (paste CSV จาก fingerprint) |
| สิทธิ์ลา / OT ย้อนหลัง | LINE chat / owner inbox | เตือนพนักงานส่งให้ครบก่อน cutoff |
| เงินเดือนเปลี่ยน | Secret → `Salary_Master` | เพิ่ม row ใหม่ตาม `effective_date` (อย่าแก้ row เดิม) |
| ผ่อนใหม่/หยุดผ่อน | Secret → `Recurring_Deductions` | เพิ่ม/ปิด `effective_to` |
| โบนัส/พิเศษ | Secret → `Monthly_Adjustments` | row ต่อรายการ ระบุ `period`, `direction`, `category`, `amount` |
| Approval Chain | Public → `Approval_Chain` | ถ้าหัวหน้าเปลี่ยน เพิ่ม row ใหม่ตาม `effective_from` |

---

## 3. Day 1 ของเดือนถัดไป — RECONCILE

> รัน reconcile เพื่อปิดงวด ทำให้ระบบรู้ว่าใครทำงานครบ ใครขาด ใคร OT

```bash
# ทาง 1 — LINE chat
/reconcile 2026-04        # งวดที่ระบุ
/reconcile                # default = เดือนก่อน

# ทาง 2 — owner.html
เลือก "งวด" → กด Reconcile
```

ระบบจะ:
1. อ่าน Attendance_Raw + Holiday_Calendar + Work_Schedule + Schedule_Override
2. รวมกับ Leave_Records (status=approved) + OT_Requests (status=approved)
3. เขียน Attendance_Reconciled (รายวัน) + Monthly_Summary (รายเดือน) + Escalation_Queue (เคสปัญหา)
4. ส่ง Flex สรุปกลับ — total reconciled, escalation by type, top 3 emp ที่มี escalation มากสุด

### Resolve escalations

| ประเภท | สาเหตุ | วิธีแก้ |
|---|---|---|
| `absent` | ไม่มีสแกน + ไม่มีใบลา + ไม่ใช่วันหยุด | ขอใบลาย้อนหลัง หรือเพิ่ม Schedule_Override |
| `short_work` | สแกนแต่ทำไม่ครบ 8 ชม. | ตรวจ clock_in/out หรือเพิ่มเวลา OT |
| `ot_unrequested` | ทำเกิน 8 ชม. แต่ไม่มี OT request approved | ขอ OT ย้อนหลัง หรือยอมรับว่าไม่จ่าย |
| `weekend_work_unrequested` | สแกนวันหยุดแต่ไม่มี OT | ขอ OT ย้อนหลัง |
| `leave_pending` | ใบลาวันที่นั้นยังไม่อนุมัติ | ตามอนุมัติ/ปฏิเสธให้เสร็จ |

แก้แล้ว rerun `/reconcile` (idempotent — เขียนทับงวดเดิม)

---

## 4. Day ~3 — RUN PAYROLL

```bash
# ทาง 1 — LINE chat
/payroll 2026-04          # งวดที่ระบุ
/payroll                  # default = เดือนก่อน
/payroll 2026-04 force    # บังคับเขียนทับงวดที่ locked อยู่

# ทาง 2 — owner.html
เลือก "งวด" → กด Payroll
```

ระบบจะ:
1. อ่าน Monthly_Summary (จาก reconcile) + Salary_Master + Recurring_Deductions + Monthly_Adjustments
2. คำนวณ gross = base − unpaid − absent + OT(1/2/3) + adjustments
3. คำนวณ deductions: tax (ตอนนี้ stub = 0) + SSO 5% (cap 750) + PF + studentloan + companyloan + manual
4. net = gross − deductions
5. เขียน `Payroll_Run` (1 row ต่อพนักงานต่องวด) status='computed'
6. Recompute `YTD_Accumulator` ทั้งปีจาก Payroll_Run ทั้งหมด
7. Audit ลง Audit_Log
8. ส่ง summary กลับ: จำนวนพนักงาน, total gross, total net, skipped (กรณีไม่มี Monthly_Summary หรือ Salary_Master)

### Spot-check
เปิด **Secret Sheet → Payroll_Run** กรองตาม period:
- pนักงานครบทุกคน?
- net > 0 ทุกคน?
- ค่า OT × rate ตรงตามนาที?
- หัก SSO ≤ 750?

ถ้าเจอผิดปกติ → แก้ที่ source (Monthly_Summary, Salary_Master, Adjustments) แล้ว rerun `/payroll` (เขียนทับให้)

---

## 5. Distribute Slips

ตอนนี้พนักงานต้องเปิด LIFF เอง:

1. เปิด LINE OA → tap rich menu → menu → **สลิปเงินเดือน**
2. เลือกงวด → ดูสลิป (รายได้ · รายการหัก · Net · YTD สรุป)
3. กด **ดาวน์โหลด PDF** → เปิดใน external browser → save เก็บ

> **TODO post-MVP:** auto-push Flex card ให้พนักงานทุกคนหลัง `/payroll` เสร็จ พร้อมลิงก์ deep-link เข้า slip.html ของงวดนั้น

---

## 6. Lock Period

หลังตรวจสลิปครบ + จ่ายเงินเสร็จ:

1. เปิด **Secret Sheet → Payroll_Run** กรองตาม period
2. แก้ column `status` จาก `computed` → `locked` ในทุก row ของงวดนั้น
3. ครั้งต่อไป `/payroll YYYY-MM` จะ throw `period_locked` ป้องกันเขียนทับ
4. หากต้องเขียนทับจริง (เช่น เจอ bug) → ใช้ `/payroll YYYY-MM force` (audit จะบันทึก)

---

## 7. Edge Cases

### 7.1 พนักงานใหม่
1. **Public Sheet → Employees** เพิ่ม row (`status=active` หรือ `probation`, `start_date`)
2. **Public Sheet → Work_Schedule** เพิ่ม row (`emp_code`, `effective_from`, `work_days_bitmap`)
3. **Public Sheet → Approval_Chain** เพิ่ม row (`level_1_approver` ขั้นต่ำ)
4. **Public Sheet → Leave_Quota** เพิ่ม row ปีนี้
5. **Secret Sheet → Salary_Master** เพิ่ม row (`base_salary`, `daily_rate`, `hourly_rate`, `ot_*_rate`)
6. **Secret Sheet → LINE_User_Map** จะถูกเติมอัตโนมัติเมื่อพนักงาน scan QR เข้า OA + ใช้ LIFF (ตอนนี้ยังต้อง manual)

### 7.2 พนักงานออก
1. **Employees** → ตั้ง `status=resigned`, `end_date=วันสุดท้าย`
2. row จะถูกข้ามใน reconcile/payroll ของงวดถัดไปอัตโนมัติ
3. งวดสุดท้ายจะคำนวณตามจำนวนวันที่อยู่จริง (proration ทำใน Monthly_Adjustments ถ้าจำเป็น)

### 7.3 หัวหน้าเปลี่ยน
- **Approval_Chain** เพิ่ม row ใหม่ (`emp_code` เดิม, `effective_from` วันนี้, approver ใหม่)
- ระบบใช้ `findActiveRecord_` หา row ที่ active ตามวัน → ใบลา/OT ใหม่จะใช้ approver ใหม่อัตโนมัติ

### 7.4 ปรับเงินเดือน mid-period
- **Salary_Master** เพิ่ม row ใหม่ (`emp_code` เดิม, `effective_date` วันที่ขึ้นเงิน)
- ระบบใช้ row ที่ active ณ **วันสิ้นงวด** ในการคำนวณ payroll
- หากต้อง prorate (ครึ่งงวดเก่า ครึ่งใหม่) ใช้ Monthly_Adjustments

### 7.5 OT/ลา ย้อนหลังหลัง cutoff
- ถ้า `BACKDATED_REQUIRES_OWNER=true` (default) → พนักงานทั่วไปส่งย้อนหลังไม่ได้
- OWNER ส่งแทนได้ (override flag) — หรือเปลี่ยน Settings → `BACKDATED_REQUIRES_OWNER=false`
- รับเข้าระบบแล้ว rerun `/reconcile` + `/payroll` (จนกว่า status=locked)

### 7.6 เจอ bug หลัง lock
- ใช้ `/payroll YYYY-MM force` เขียนทับ
- audit_log จะมี row `RUN_PAYROLL` ใหม่ — ตามรอยได้
- แจ้งพนักงานว่าตัวเลขเปลี่ยน (manual)

---

## 8. Quick Reference — Sheets

### Public (HR เห็น — ไม่มีเงิน)
- `Employees` · `Holiday_Calendar` · `Work_Schedule` · `Schedule_Override`
- `Leave_Quota` · `Leave_Records` · `OT_Requests` · `Approval_Chain` · `Approval_Rules`
- `Settings` · `Attendance_Raw` · `Attendance_Reconciled` · `Monthly_Summary` · `Escalation_Queue`

### Secret (เจ้าของเห็นคนเดียว)
- `Salary_Master` · `Recurring_Deductions` · `Monthly_Adjustments`
- `Payroll_Run` · `YTD_Accumulator`
- `Audit_Log` (write-only) · `LINE_User_Map`

---

## 9. Quick Reference — Commands

```
/help                       แสดงคำสั่งทั้งหมด
/reconcile                  รัน reconcile เดือนก่อน
/reconcile 2026-04          งวดที่ระบุ
/payroll                    รัน payroll เดือนก่อน
/payroll 2026-04            งวดที่ระบุ
/payroll 2026-04 force      บังคับเขียนทับงวด locked
```

LIFF URLs:

```
/                     menu home
/leave.html           ส่งใบลา
/ot.html              ขอ OT
/quota.html           สิทธิ์การลา + ประวัติ
/slip.html            สลิปเงินเดือน + PDF
/owner.html           กล่องอนุมัติ + Reconcile + Payroll (เจ้าของเท่านั้น)
```
