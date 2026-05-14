# Troubleshooting — Known Issues & Fixes

บันทึก bug ที่เคยเจอ + วิธีแก้ — ถ้าเจออาการเดิมในอนาคต กลับมาดูที่นี่ก่อน

---

## 1. White page / หน้าขาว — Tailwind CDN safelist block

### อาการ
- เปิด LIFF page ในเบราว์เซอร์ตรงๆ → หน้าขาวทั้งหมด (ไม่มี header, ไม่มี content)
- เปิดผ่าน LIFF (LINE webview) ก็เห็นหน้าขาว
- HTML source มีทุกอย่างปกติ — แต่ render เป็นขาวล้วน
- ไม่มี error ใน console ที่ชัดเจน

### สาเหตุ
Block แบบนี้ใน `<head>`:
```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    safelist: [
      { pattern: /(bg|text|ring|border)-(emerald|amber|red|sky|cyan|slate)-(50|100|200|300|400|500|600|700|800|900)/ },
      ...
    ],
  };
</script>
```

Tailwind CDN v3 JIT runtime **ไม่รองรับ `safelist` option** ใน runtime config. การกำหนด safelist ทำให้ Tailwind throw ขณะ initialize → abort การ render styles → หน้าทั้งหมดดูเป็นขาวเปล่า (เนื้อหามีแต่ไม่มี style ทำให้ดูเป็นพื้นว่าง — บางทีก็ blank จริงๆ ถ้า `<body>` ไม่มี base background)

### วิธีแก้
**ลบทั้ง `<script> tailwind.config = ... </script>` block ออก**

```html
<!-- BEFORE -->
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { safelist: [...] };
</script>

<!-- AFTER -->
<script src="https://cdn.tailwindcss.com"></script>
```

Tailwind CDN JIT จะ scan static HTML เจอ class ที่ใช้แล้ว generate ให้เอง — สำหรับ class ที่ inject ด้วย JS dynamically ต้องใส่ class นั้นใน static HTML ที่ไหนสักที่ (เช่นใน `<template>` tag ที่ซ่อนไว้) เพื่อให้ JIT detect

### เคสที่เจอ
- `onboard.html` (commit `e7b2ca9` ปี 2026-05-10)
- `owner.html` (commit `e857a25` ปี 2026-05-13)

ถ้าเจออีก check ทุก page ที่เหลือก่อน:
```bash
grep -l "tailwind.config" frontend/src/*.html
```

---

## 2. LIFF deep-link navigation ไม่ทำงาน — path stuck on home

### อาการ
- กด menu card ใน home ที่ point ไป sub-page (เช่น `owner.html`)
- มี animation/loading แต่ URL ไม่เปลี่ยน หรือกลับมา home ทันที
- เกิดเฉพาะใน LINE in-app webview, browser ทำงานปกติ

### สาเหตุ
LIFF dispatcher แปลง `liff.line.me/<ID>/owner.html` เป็น `<endpoint>/?liff.state=/owner.html` LIFF SDK บางเวอร์ชัน (โดยเฉพาะ iOS LINE) **ไม่ navigate ตาม `liff.state` อัตโนมัติหลัง `liff.init()`** → ค้างที่ endpoint root (index.html)

### วิธีแก้ — ใช้ดีดสุดอันใดอันหนึ่ง

**A. Dedicated LIFF per page (robust ที่สุด — แนะนำสำหรับ owner/hr/onboard/help):**
- LINE Dev Console → Add LIFF → Endpoint URL = ชี้ตรงไป page เลย (เช่น `https://.../owner.html`)
- จด LIFF ID ใหม่ → ใช้ใน menu navigation: `https://liff.line.me/<NEW_ID>/`
- ไม่ผ่าน liff.state เลย → ไม่มี bug
- เคสที่เจอ: `owner.html` ใช้ LIFF `2010019987-GnIMAEFB` (commit `4976040`)

**B. Manual `liff.state` handler ใน `liff-bridge.js`** (commit `ba5c4f3`):
```js
const liffState = new URLSearchParams(window.location.search).get('liff.state');
if (liffState && !window.__liffStateHandled) {
  window.__liffStateHandled = true;
  const target = liffState.replace(/^\/+/, '');
  if (target && !window.location.pathname.endsWith('/' + target.split('?')[0])) {
    window.location.replace(target);
  }
}
```
ทำงานหลังจาก `liff.init()` succeeded — manual navigate ถ้าเจอ liff.state ที่ SDK ไม่ honor

---

## 3. Sheets "HH:mm" → Date 1899 BMT shift

### อาการ
- เขียน "19:03" ลง Sheet cell → อ่านกลับมาแสดงเป็น "06:45" หรือ "Sun Dec 31 1899 06:27:04 GMT+0642"
- เกิดเฉพาะกับ time-only string ที่ Sheets parse เป็น Date

### สาเหตุ
Sheets แปลง "HH:mm" → serial number (fractional day) เก็บใน Date 1899-12-30. การอ่านกลับเป็น Date ผ่าน Asia/Bangkok TZ ใช้ **Bangkok Mean Time** (BMT, GMT+6:42:04) ที่ใช้ใน Thailand ก่อนปี 1920 → shift ~17-18 นาที

### วิธีแก้ (3 ชั้น)
1. **Write-side:** prefix ด้วย leading space `' 19:03'` → Sheets เก็บเป็น text ไม่ parse เป็น Date
2. **Read-side:** ใช้ `getDisplayValues()` แทน `getValues()` → คืน string เหมือนที่แสดงใน cell
3. **Fallback:** `_fmtTimeCell_()` helper ที่ใช้ `getUTCHours()/getUTCMinutes()` ถ้าเจอ Date object

ดู `apps-script/checkin.gs::_fmtTimeCell_`

---

## 4. Drive folder `not_accessible` แม้แชร์แล้ว

### อาการ
- ตั้ง `CHECKIN_DRIVE_FOLDER_ID` ใน Settings → upload selfie → error `checkin_drive_folder_not_accessible`
- folder URL เปิดในเบราว์เซอร์ได้ปกติ
- แชร์ "Anyone with link" แล้วก็ยังไม่ผ่าน

### สาเหตุ
Apps Script รันด้วย **บัญชี script owner** (เช่น `p.pui@moodata.me`). "Anyone with link" สำหรับ Drive API ไม่นับ — API ต้อง explicit grant **TO** บัญชีนั้น

### วิธีแก้
- ใช้ folder ที่ **owned by** script owner (สร้างใน Drive ขณะ login เป็นบัญชีนั้น)
- หรือ share folder explicit เป็น **Editor** ให้ email ของ script owner

---

## 5. Apps Script Web App 403 "ไม่พบเพจ" หลัง deploy

### อาการ
- หลัง `clasp deploy` (หรือเปลี่ยน oauthScopes) → URL Web App ตอบ 403 / "Sorry, can't open file at this time"
- curl ทดสอบเจอ `HTTP/2 403`

### สาเหตุ
clasp 3.x reset Web App access setting ทุกครั้งที่ deploy (กลับเป็น "Only myself") + Workspace policy บางครั้ง block "Anyone" access เมื่อ scope กว้าง (เช่น `drive` แทน `drive.file`)

### วิธีแก้
1. Apps Script editor → **Deploy → Manage deployments**
2. กดดินสอ ✏️ ที่ deployment ปัจจุบัน
3. **Version: New version**
4. **Who has access: Anyone** (ไม่ใช่ "Anyone with Google account")
5. **Deploy**
6. ถ้ายัง 403 → ลด scope ใน `appsscript.json` (drive → drive.file, ฯลฯ) แล้ว redeploy

---

## 6. iOS LINE webview camera "internal error"

### อาการ
- เปิด LIFF page ที่ใช้ `getUserMedia` → ขึ้น "internal error" หรือเงียบไม่ขึ้นกล้อง
- เกิดเฉพาะ iOS LINE app

### สาเหตุ + วิธีแก้ (combination)
1. **Constraints แน่นเกิน** — ใช้ `facingMode: 'user' + ideal 960×720` (อย่าใช้ `exact`)
2. **GPS ก่อนกล้อง consume user gesture** — เปิดกล้องก่อน, ขอ GPS หลัง (เพราะ getUserMedia บน iOS ต้องอยู่ใน user gesture)
3. **Permission OS-level** — Settings → LINE → Camera = Allow
4. **LIFF Size** ต้องเป็น **Full** (ไม่ใช่ Tall/Compact)
5. **Fallback path** — `<input type="file" capture="user">` เปิดกล้องระบบ iOS ตรง (เสถียรกว่า getUserMedia)

ดู `frontend/src/js/camera.js::startCamera`

---

## 7. POST body ใหญ่ใน LIFF webview → "Load failed"

### อาการ
- iOS LINE webview → fetch POST body > ~200KB → throw `TypeError: Load failed`
- ไม่เจอใน Apps Script Executions log (request ไม่ถึง backend)

### สาเหตุ
Apps Script Web App ตอบ 302 redirect → `script.googleusercontent.com`. iOS LINE webview drop body ใหญ่ตอน follow redirect

### วิธีแก้
**Split เป็น 2 requests:**
1. Upload base64 → return URL (large body)
2. Submit metadata referencing URL (small body)

ดู `apps-script/checkin.gs::uploadCheckinSelfie` + `submitCheckin`

---

## Quick reference — เคยเจอ pattern คล้ายๆ ให้ check ก่อน

| อาการ | ดูหัวข้อ |
|---|---|
| หน้าขาวเปิดเบราว์เซอร์ตรงๆ ไม่ขึ้น | §1 Tailwind safelist |
| กดเมนูใน LIFF แล้วไม่เข้า sub-page | §2 LIFF deep-link |
| เวลาใน sheet/UI เพี้ยน 17-18 นาที | §3 BMT shift |
| Drive upload fail แต่ folder เห็นได้ | §4 Drive access |
| Web App 403 หลัง deploy | §5 clasp + Workspace |
| กล้อง LIFF iOS เปิดไม่ได้ | §6 iOS camera |
| fetch POST ใหญ่ fail เงียบ | §7 redirect body cap |
