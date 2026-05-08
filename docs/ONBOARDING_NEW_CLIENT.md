# Onboarding New Client

> วิธี deploy ระบบให้ลูกค้าใหม่ — อ่านหลังเข้าใจ `SETUP_GUIDE.md` แล้ว

## ภาพรวม

แต่ละลูกค้าจะมี **stack ของตัวเอง** ที่แยกขาดจากลูกค้าอื่น:

```
ลูกค้า A:
├── Google Sheets (Public + Secret)        ← เจ้าของ A เป็น owner
├── Apps Script project                     ← clone จาก template
├── LINE OA + Login Channel + LIFF         ← ของลูกค้าเอง
└── ใช้ Frontend จาก Pages กลางของคุณ      ← shared

ลูกค้า B:  ทำเหมือนกัน แยกอิสระ
```

## ใครรับผิดชอบอะไร

| ขั้น | ใครทำ | สิ่งที่ต้องการจากอีกฝั่ง |
|---|---|---|
| สร้าง LINE OA | ลูกค้า | - |
| สร้าง LINE Channels (Login + Messaging) | ลูกค้า | - |
| สร้าง LIFF app | ลูกค้า | Endpoint URL จากคุณ |
| สร้าง Apps Script + Sheets | คุณ | บัญชี Google ของลูกค้า (login) |
| Wire keys | คุณ | Channel ID/Secret/Token จากลูกค้า |
| Deploy Web App | คุณ | - |
| Setup Rich Menu | คุณ + ลูกค้า | - |
| Import Employee data | ลูกค้า | template จากคุณ |
| Onboard พนักงาน (mapping) | ลูกค้า | - |

## ขั้นตอน

### 1. ก่อนวัน setup — ส่งให้ลูกค้าทำเอง

Email ลูกค้าพร้อมเอกสารสรุป:
- ขอลูกค้าสมัคร LINE Business + สร้าง LINE OA
- ขอลูกค้าสร้าง Provider + Login Channel + Messaging API Channel
- **อย่าเพิ่งสร้าง LIFF** — รอจากคุณก่อน
- ขอให้ส่งกลับ:
  - Channel ID
  - Channel Secret
  - Channel Access Token

> ⚠️ **อย่าให้ลูกค้าส่ง credentials ทาง LINE chat ปกติ** — ใช้ password manager link หรือ encrypted email

### 2. คุณ — Onboarding session 1 ชั่วโมง (online)

#### 2.1 สร้าง Apps Script (ใน Google account ของลูกค้า)

```bash
# ขอลูกค้า login ที่ accounts.google.com ด้วยบัญชีบริษัท
# จากนั้น share screen + คุณดำเนินการ

cd /path/to/payroll-starter/apps-script
clasp logout  # logout จาก account ของคุณก่อน
clasp login   # login ด้วย account ลูกค้า
clasp create --title "Payroll-AcmeCo" --type webapp --rootDir .
clasp push
```

> หรือถ้าลูกค้าไม่อยากให้เข้า account → ใช้ `clasp login --creds personal-creds.json` แล้วให้ลูกค้า run เอง

#### 2.2 รัน setupAll() + ตั้ง Properties

ตามขั้นตอนใน `SETUP_GUIDE.md` Phase 3-4

#### 2.3 Deploy + ส่ง URL ให้ลูกค้า

#### 2.4 ลูกค้าสร้าง LIFF (ตอนนี้แล้ว)

ในหน้าของ LIFF app:
- Endpoint URL = ส่งจากคุณ (มี backend URL ของลูกค้า + liffId)

### 3. หลัง setup — ลูกค้าทำเอง (มีคุณช่วยใน LINE)

#### 3.1 Import Employee data

ส่ง template `employee_template.csv` ให้ลูกค้ากรอก แล้ว:
- เปิด `Payroll_Public` → tab `Employees`
- Paste rows

หรือเขียน Apps Script function `importEmployeesCSV()` ให้ลูกค้ากดปุ่มเดียว (Phase 2)

#### 3.2 Setup Work_Schedule

```
1 row ต่อพนักงาน 1 คน:
- emp_code: EMP001
- effective_from: 2026-01-01
- pattern_type: fixed
- work_days_bitmap: "1111100"  (Mon-Fri)
- daily_hours: 8
```

#### 3.3 Onboarding พนักงานครั้งแรก (mapping LINE userId)

> ⚠️ **ส่วนนี้ยังไม่มี automated UI** — เป็น TODO ของ Phase 3

วิธีชั่วคราว:
1. ลูกค้าให้พนักงานเปิด LINE OA → กด Rich Menu → เปิด LIFF
2. LIFF จะ error "employee_not_mapped" — ใน console จะ log userId
3. ลูกค้า copy userId นั้นไปใส่ในตาราง `LINE_User_Map`:
   - `line_user_id`: userId จาก console
   - `emp_code`: รหัสที่ assign ให้พนักงาน
   - `role`: `employee` (หรือ `owner` ถ้าเป็นเจ้าของ)
4. พนักงาน refresh LIFF → ใช้ได้

**Tasks for Claude Code (Phase 3):**
- เขียนหน้า `onboard.html` ที่ให้พนักงานพิมพ์ emp_code + ใช้ระบบ verify
- Owner approve mapping ผ่าน Flex message
- Auto-add to LINE_User_Map

### 4. Maintenance ระยะยาว

#### Push update ไปทุกลูกค้า

```bash
# ใน repo
git pull  # เอา code ใหม่
cd apps-script

# Switch ไป project ของลูกค้า A
clasp logout
clasp login  # account ลูกค้า A
clasp clone <SCRIPT_ID_A> --rootDir tmp_clone_A
# ... overwrite ไฟล์ใน tmp_clone_A ด้วยของใหม่
cd tmp_clone_A
clasp push
```

มี script `scripts/push_to_all_clients.sh` (TODO) ที่ทำให้อัตโนมัติได้

#### Frontend update

Push GitHub → Pages auto-redeploy → ทุกลูกค้าใช้ version ใหม่ทันที

---

## Pricing (กรณีจะคิดเงิน)

| รายการ | ตัวเลือก |
|---|---|
| Setup fee (1 ครั้ง) | 5,000-10,000 บ. (ตามความซับซ้อน) |
| Monthly fee | คิด/พนักงาน หรือ flat rate |
| LINE quota | ลูกค้าจ่ายเอง (LINE Messaging API) |
| Hosting | คุณรับ (Pages + Apps Script ฟรี) |
| Support | กำหนด SLA / ขอบเขต |

> หมายเหตุ: ผมไม่ได้ออกแบบ pricing ให้นะครับ แค่กรอบให้คิดต่อ
