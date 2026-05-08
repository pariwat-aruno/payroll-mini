# Setup Guide

> คู่มือ setup ระบบ Payroll Mini ทีละขั้น
> สำหรับ deploy ครั้งแรก หรือเมื่อ onboard ลูกค้าใหม่

## ภาพรวม

ใช้เวลาประมาณ **45 นาที - 1 ชั่วโมง** ทั้งหมด แบ่งเป็น 5 phase:

| Phase | ทำอะไร | เวลา |
|---|---|---|
| 1. Google Setup | สร้าง Sheet + Apps Script | 10 นาที |
| 2. LINE Setup | (ถ้าลูกค้ายังไม่มี) สร้าง OA + Channel | 15 นาที |
| 3. Wire Keys | ใส่ key ลง PropertiesService | 5 นาที |
| 4. Deploy Backend | Apps Script Web App | 5 นาที |
| 5. Deploy Frontend | GitHub Pages | 10 นาที |

---

## Phase 1: Google Setup

### 1.1 สร้าง Apps Script project ใหม่

1. ไปที่ https://script.google.com → กด "New project"
2. เปลี่ยนชื่อ project เป็น `Payroll-[ชื่อบริษัท]` เช่น `Payroll-AcmeCo`

### 1.2 ลบไฟล์ default + push code จาก repo

**วิธีที่ 1: ใช้ clasp (แนะนำ — เร็ว)**

```bash
# ติดตั้ง clasp ครั้งแรก
npm install -g @google/clasp
clasp login

# ใน repo
cd apps-script
clasp create --title "Payroll-[ชื่อบริษัท]" --type webapp --rootDir .
clasp push
```

**วิธีที่ 2: copy-paste manually**

1. ใน Apps Script editor → กด + ข้าง "Files" → "Script"
2. สร้างไฟล์ตามรายชื่อนี้และ paste content จาก `apps-script/`:
   - `Code.gs`
   - `setup.gs`
   - `utils.gs`
   - `audit.gs`
   - `line_api.gs`
   - `reconcile.gs`
   - `ai_stub.gs`
3. ลบ `Code.gs` default ที่มาพร้อม project

### 1.3 รัน setupAll() ครั้งแรก

1. ใน Apps Script editor → เลือก function `setupAll` จาก dropdown ด้านบน
2. กด Run
3. ครั้งแรกจะเด้ง "Authorization required" → กด Review permissions
4. เลือกบัญชี Google ของคุณ → "Advanced" → "Go to [project name] (unsafe)" → Allow
5. รอจนเห็น log `=== SETUP COMPLETE ===`

**สิ่งที่เกิดขึ้น:**
- สร้าง Google Sheet ชื่อ `Payroll_Public` (มี 11 tabs)
- สร้าง Google Sheet ชื่อ `Payroll_Secret` (มี 7 tabs, Audit_Log ถูก protected)
- Sheet IDs ถูก save ใน Properties แล้ว

### 1.4 ตั้งค่า Sheet sharing

> ⚠️ **สำคัญมาก:** ขั้นนี้คือกุญแจของ privacy model

1. ไปที่ Drive → เปิด `Payroll_Secret`
2. กด Share (มุมขวาบน) → ตั้งให้:
   - **General access:** Restricted (ไม่ใช่ "Anyone with the link")
   - **People:** มีแค่อีเมลเจ้าของบริษัท
3. เปิด `Payroll_Public`
4. กด Share → ตั้งให้:
   - **General access:** Restricted
   - **People:** เจ้าของ + HR ทุกคน

---

## Phase 2: LINE Setup

> ⏭️ ถ้าลูกค้ามี LINE OA + Channel + LIFF แล้ว ข้ามไป Phase 3

### 2.1 สร้าง LINE Official Account

1. ไป https://www.linebiz.com/th/account/ → "Create Account"
2. เข้าสู่ระบบด้วย LINE Business ID
3. กรอกข้อมูลบริษัท → ได้ LINE OA ใหม่

### 2.2 สร้าง Provider + Login Channel

1. ไป https://developers.line.biz/console/ → Login
2. กด Create new provider → ตั้งชื่อ
3. ใน Provider → กด "Create a new channel"
4. เลือก **LINE Login** → กรอก:
   - Channel name: `Payroll-[ชื่อบริษัท]`
   - App types: Web app
5. **บันทึก:**
   - Channel ID
   - Channel secret (Basic settings → Channel secret → Show)

### 2.3 สร้าง Messaging API Channel (จับคู่กับ OA)

1. ใน Provider เดียวกัน → Create new channel → **Messaging API**
2. ผูกกับ LINE OA ที่สร้างไว้ใน 2.1
3. **บันทึก:**
   - Channel access token (Messaging API tab → Issue) ← ⚠️ ต้องกด Issue ก่อน

### 2.4 สร้าง LIFF App

1. กลับไปที่ Login Channel → tab "LIFF"
2. กด Add → กรอก:
   - LIFF app name: `ระบบลา-OT`
   - Size: Tall
   - Endpoint URL: `https://[your-username].github.io/payroll-mini/leave.html?backend=PLACEHOLDER&liffId=PLACEHOLDER`
     (จะกลับมาแก้ใน Phase 5)
   - Scope: `profile`, `openid`
   - Bot link feature: On (Aggressive)
3. **บันทึก:**
   - LIFF ID

---

## Phase 3: Wire Keys

1. กลับไปที่ Apps Script editor
2. เปิดไฟล์ `setup.gs`
3. หา function `setProperties()` → แก้ค่าใน strings:

```javascript
function setProperties() {
  PropertiesService.getScriptProperties().setProperties({
    LINE_CHANNEL_ID:           '1234567890',           // ← ของจริง
    LINE_CHANNEL_SECRET:       'abcdef1234567890...', // ← ของจริง
    LINE_CHANNEL_ACCESS_TOKEN: 'ZGGHJrnDX...',         // ← ของจริง
    LIFF_ID:                   '1234567890-AbCdEfGh',  // ← ของจริง
    OWNER_EMAIL:               'owner@company.com',
  });
}
```

4. รัน function `setProperties` (เลือกจาก dropdown → Run)
5. รัน function `printProperties` เพื่อ verify (ค่าจะถูก mask แต่เห็นว่ามีอยู่)
6. **กลับไปแก้ `setProperties()` ให้กลับเป็น `'PASTE_HERE'`** เพื่อไม่ให้ key หลุดถ้า push code

---

## Phase 4: Deploy Backend (Apps Script Web App)

1. ใน Apps Script → Deploy → New deployment
2. กดเฟือง ⚙ → เลือก Web app
3. กรอก:
   - Description: `v1` (รุ่นแรก)
   - Execute as: **Me (your email)** ← สำคัญ ต้องเป็น "Me" ไม่ใช่ "User accessing"
   - Who has access: **Anyone** ← LIFF ต้องส่งมาได้โดยไม่ login Google
4. กด Deploy
5. ครั้งแรกจะถาม Authorize อีกที → Allow
6. **บันทึก URL** ที่ได้ — รูปแบบ: `https://script.google.com/macros/s/AKfy.../exec`

> 🔄 **ตอน update code ภายหลัง:** ใช้ Manage deployments → กดดินสอ → Version: New version → Deploy
> URL จะเหมือนเดิม ไม่ต้อง update LIFF

---

## Phase 5: Deploy Frontend (GitHub Pages)

### 5.1 Push frontend repo

```bash
cd /path/to/payroll-starter
git init
git add .
git commit -m "Initial setup"
git branch -M main
git remote add origin https://github.com/[your-username]/payroll-mini.git
git push -u origin main
```

### 5.2 เปิด GitHub Pages

1. ไป repo บน GitHub → Settings → Pages
2. Source: GitHub Actions
3. (Workflow `.github/workflows/deploy.yml` จะ trigger อัตโนมัติเมื่อ push main)

หลัง deploy เสร็จ → Pages URL จะเป็น:  
`https://[your-username].github.io/payroll-mini/`

### 5.3 อัปเดต LIFF Endpoint URL

ตอนนี้คุณมีครบทั้ง:
- Apps Script Web App URL: `https://script.google.com/macros/s/AKfy.../exec`
- GitHub Pages URL: `https://[your-username].github.io/payroll-mini/`
- LIFF ID: `1234567890-AbCdEfGh`

ประกอบเป็น LIFF Endpoint URL:

```
https://[your-username].github.io/payroll-mini/leave.html?backend=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAKfy...%2Fexec&liffId=1234567890-AbCdEfGh
```

> ⚠️ ค่าของ `backend=...` ต้อง **URL-encode** (`:` → `%3A`, `/` → `%2F`)
> ใช้ https://www.urlencoder.org ช่วย encode

ไปที่ LINE Developers Console → Login Channel → LIFF tab → คลิก app → Edit → Endpoint URL → paste → Save

---

## Phase 6: Test

### 6.1 Smoke test ผ่าน console

1. เปิด LIFF URL ใน browser ปกติ (จะเข้า mock mode)
2. หน้า leave form ควรขึ้น
3. ตอนนี้ยังไม่มีข้อมูล Employee ใน Sheet → user_not_mapped error คาดเดาได้

### 6.2 ตั้งค่าข้อมูลเริ่มต้น

ใน Public Sheet → tab `Employees`:
- เพิ่ม row ของพนักงานทดสอบ — emp_code, ชื่อ, ตำแหน่ง, etc.

ใน Public Sheet → tab `Leave_Quota`:
- เพิ่ม row สิทธิ์ลาของพนักงานคนนั้น (year=2026, sick_quota=30, ...)

ใน Secret Sheet → tab `LINE_User_Map`:
- ตอนนี้ยังไม่มี — เพราะระบบ onboarding ยังไม่ได้ build (Phase 3 ของ roadmap)
- **Workaround ชั่วคราว:** เปิด LIFF, ดู Console.log ว่า userId คืออะไร, แล้ว manually เพิ่ม row:
  - `line_user_id`: ค่าจาก console
  - `emp_code`: รหัสที่ตรงกับ Employees
  - `role`: `employee` หรือ `owner`

### 6.3 ทดสอบส่งใบลา

1. เปิด LIFF จาก LINE OA จริง
2. กรอกฟอร์ม → submit
3. ตรวจ Public Sheet → tab `Leave_Records` → ควรมี row ใหม่
4. ตรวจ Secret Sheet → tab `Audit_Log` → ควรมี row `SUBMIT_LEAVE`
5. ใน LINE — เจ้าของ (role=owner) ควรได้ notification

---

## Troubleshooting

### "auth_failed"
- เช็ค `LINE_CHANNEL_ID` ใน Properties ตรงกับ Login Channel ที่ออก idToken
- ID token ของ LINE มีอายุ 60 นาที — ถ้าทดสอบนานๆ refresh หน้า

### "employee_not_mapped"
- ยังไม่มี row ใน `LINE_User_Map` ที่จับคู่ userId ↔ emp_code

### Frontend แสดง "No backend URL configured"
- ตรวจว่า LIFF Endpoint URL มี `?backend=...` ครบ
- ตรวจว่า encode ถูกต้อง (decode ทดสอบที่ urldecoder.org)

### CORS error
- ใน Apps Script: Deploy → Manage deployments → Edit → Who has access = "Anyone"
- ตรวจ `frontend/src/api.js` — ต้องใช้ `Content-Type: text/plain` ไม่ใช่ `application/json`

### "Properties not set"
- Apps Script ที่ deploy แล้วใช้ Properties แยกจาก editor — ลอง redeploy หลังตั้ง Properties

---

## Next Steps

หลัง setup เสร็จ → อ่าน `docs/ONBOARDING_NEW_CLIENT.md` ถ้าจะ deploy ให้ลูกค้าใหม่
