# Iteration 3 — สรุป Feature

ระบบเช็คอินด้วยใบหน้า (selfie check-in) + งาน UX/onboarding ที่ทำต่อจาก iteration 2

---

## 1. เช็คอินด้วยใบหน้า (Selfie check-in)

ทางเลือกสำหรับร้าน/บริษัทที่ไม่มีเครื่องสแกนนิ้ว — พนักงานเปิด LIFF ถ่ายรูปสด พร้อม GPS ครั้งละ 1 slot สูงสุด 4 ครั้ง/วัน

**Slots ต่อวัน (1 row ต่อ emp_code · date · source=selfie):**
| slot | ความหมาย |
|---|---|
| slot1 | เช้า |
| slot2 | ก่อนเที่ยง |
| slot3 | หลังเที่ยง |
| slot4 | เย็น |

- `clock_in` = slot1_time, `clock_out` = เวลา slot ล่าสุดที่เติม
- `total_minutes` คำนวณอัตโนมัติ
- เกินรัศมี geofence → flag `approval_status=pending` ส่ง Flex หา owner (ไม่ block)
- Owner ปฏิเสธ → row ถูกข้ามใน reconcile

**ไฟล์รูปใน Drive:**
- ทุก scan + reference selfie อยู่ใน folder จาก `Settings.CHECKIN_DRIVE_FOLDER_ID`
- ชื่อไฟล์: `slot<N>_<EMP>_<YYYY-MM-DD-HH-mm-ss>.jpg`
- Burn overlay: `<slot> · DD-MM-YYYY HH:mm` + `<EMP_CODE> · <ชื่อพนักงาน>` (กัน edit/ใช้รูปเดิม)

**Settings keys ใหม่ (ทั้ง tenant — มาจาก migrate):**
- `CHECKIN_MODE` — `fingerprint` (default) | `selfie` | `both`
- `CHECKIN_APPROVER_USERIDS` — comma-sep LINE userIds (รับ Flex อนุมัติเมื่อ flag)
- `CHECKIN_GEOFENCE_LAT` / `_LNG` — พิกัดหน้างาน
- `CHECKIN_GEOFENCE_RADIUS_M` — รัศมี (default 150 m)
- `CHECKIN_DRIVE_FOLDER_ID` — folder ใน Drive ของ script owner

**Attendance_Raw columns ใหม่ (+16 cols):**
`selfie_in_url, selfie_out_url, lat, lng, distance_m, geofence_ok, approval_status, slot1_time, slot1_url, slot2_time, slot2_url, slot3_time, slot3_url, slot4_time, slot4_url, scan_count`

**Frontend (`checkin.html`):**
- 4 slot cards แต่ละใบมี thumbnail (Drive thumbnail endpoint sz=w400) + เวลา
- Tap thumbnail → lightbox ขยายในหน้า ไม่เด้งออกไป Drive
- กล้องเปิดครั้งเดียวต่อ session (ปุ่ม "เริ่มเช็คอิน" ทุกครั้งใช้ stream เดิม)
- มี fallback "📷 ใช้กล้องระบบ" — เปิด iOS system camera ผ่าน `<input type="file" capture>` กรณี getUserMedia โดน LINE webview block

---

## 2. Reference selfie ตอน pair

- `pair.html` มี step ถ่าย reference selfie (optional) ก่อนผูกบัญชี
- เก็บใน `Employees.reference_selfie_url`
- Flex อนุมัติ checkin จะแสดง **selfie ที่ flag + reference** ข้างกัน เพื่อให้ owner เทียบหน้า

---

## 3. Owner approval Flex (เช็คอินนอกรัศมี)

- เมื่อ `geofence_ok` flip จาก `auto` → `pending` ครั้งแรกของวัน → push Flex หาทุก userId ใน `CHECKIN_APPROVER_USERIDS`
- Flex มี hero = thumbnail (scan + ref) + ปุ่ม **อนุมัติ / ปฏิเสธ** (postback)
- Owner กด → row update + แจ้งพนักงาน

---

## 4. Flex ack ทุก decision ของ Owner

แทน plain text reply ทุกจุดที่ owner ตัดสินใจ:

| จุด | ใครได้ Flex | รูปใน hero |
|---|---|---|
| checkin approve / reject | owner + พนักงาน | scan + ref selfie (side-by-side) |
| ใบลา approve / reject / conditional | owner + พนักงาน | evidence_url (ถ้ามี) |
| OT approve / reject | owner + พนักงาน | — |
| HR change approve / reject | owner | — |

Helper กลาง: `sendDecisionAckFlex(userId, payload)` ใน `line_api.gs`
- decision: `approved | approved_conditional | rejected | info_requested` — สีต่างกัน
- kind: `checkin | leave | ot | change`
- audience: `approver | employee` (title ปรับตามมุมมอง)
- imageUrl → Drive thumbnail (sz=w800) + ปุ่ม "🖼️ ดูรูปขนาดเต็ม"

---

## 5. /ลงทะเบียน — chat command สำหรับพนักงานใหม่

- พนักงานเพิ่ม OA → พิมพ์ `/ลงทะเบียน` (หรือ `ลงทะเบียน`, `/register`)
- บอทตอบลิงก์ `https://liff.line.me/<LIFF_ID>/pair.html`
- ถ้า user ผูกอยู่แล้ว → บอทตอบ "บัญชี LINE ของคุณผูกอยู่แล้ว (รหัส X)"

---

## 6. Onboard form — copy buttons

หลัง owner กรอกฟอร์มเพิ่มพนักงานใหม่:
- success screen มีปุ่ม "คัดลอก" ต่อช่อง (ชื่อ / รหัสพนักงาน / รหัสผูก)
- ปุ่มใหญ่ **"📋 คัดลอกข้อความทั้งหมด"** — copy บล็อก ready-to-paste:
```
ลงทะเบียนพนักงานใหม่
ชื่อ: ...
รหัสพนักงาน: ...
รหัสผูก: ... (24 ชม.)

ขั้นตอนผูกบัญชี:
1. Add LINE OA เป็นเพื่อน
2. พิมพ์ /ลงทะเบียน ใน chat
3. แตะลิงก์ที่บอทส่งให้ → กรอกรหัสพนักงาน + รหัสผูก
```

---

## 7. Home redesign

- Section grouping (งานของฉัน / HR / เจ้าของ) แทน flat list
- Icon box 42×42 สีต่างกันตามหมวด
- Role pills (HR, เจ้าของ) สีพื้นแทน caps text
- Card "เช็คอินด้วยใบหน้า" (📸) ใน "งานของฉัน"

---

## 8. Rich menu 4-button (Paired)

- `setupPairedRichMenu4()` ใน `line_api.gs` — สร้าง rich menu ผ่าน LINE API
- 4 ปุ่ม: **สแกนหน้า · ลางาน · OT · เมนูทั้งหมด**
- รูป background generated โดย Python PIL (`frontend/src/richmenu-paired-4btn.png` — 2500×843)
- Auto-assign ให้ทุก paired user หลัง setup

---

## 9. Fixes / polish

- camera permission ขอ **ครั้งเดียวต่อ session** (stream ค้างจน leave page)
- camera ขอก่อน GPS (iOS user gesture)
- upload selfie แยกเป็น 2 steps (`uploadCheckinSelfie` แล้ว `submitCheckin`) — กัน body size limit ของ LINE webview
- ลด camera resolution 960×720, JPEG quality 0.75 — รูป ~100 KB
- `setSharing` wrapped in try-catch — Workspace ที่บล็อก "anyone with link" ก็ยังใช้ระบบได้
- ใช้ Drive thumbnail endpoint สำหรับ Flex hero — render ใน LINE ได้แม้ไฟล์ไม่ public
- เวลาใน slot card ใช้ `getDisplayValues` — กัน Sheets แปลง "HH:mm" เป็น Date serial 1899 BMT (shift 17 min)
- doPost ส่ง error message จริง แทน "internal_error" กว้างๆ
- pair.html "เริ่มใช้งาน" — relative href + light gradient (404 fix)
- Drive folder auto-resolve — ถ้า configured ID ไม่ accessible → fail with clear error (auto-create ทำได้แต่ต้อง drive scope กว้างซึ่งติด Workspace policy)

---

## ไฟล์ที่เพิ่ม/แก้

**Apps Script:**
- `checkin.gs` (new) — submitCheckin, getCheckinStatus, handleCheckinApprovalAction
- `drive.gs` — uploadSelfieBase64_, driveUrlToThumbnail_
- `onboarding.gs` — _setEmployeeField_ + pairEmployee selfie
- `line_api.gs` — sendCheckinApprovalFlex, sendDecisionAckFlex, setupPairedRichMenu4
- `Code.gs` — /ลงทะเบียน command, checkin routes, Flex ack on change postback
- `setup.gs` + `migrate.gs` — schema migration
- `reconcile.gs` — skip rejected selfie rows
- `approval.gs` — Flex ack แทน pushLineMessage
- `appsscript.json` — timezone Asia/Bangkok

**Frontend:**
- `checkin.html` (new) — 4-slot UI + thumbnails + lightbox + camera/file fallback
- `js/camera.js` (new) — live camera + canvas stamp + file-input variant
- `pair.html` — reference selfie capture + success button fix
- `onboard.html` — copy buttons
- `index.html` — section grouping + icons
- `api.js` — apiUploadCheckinSelfie, apiSubmitCheckin, apiGetCheckinStatus
- `liff-bridge.js` — liffIsInClient()
- `richmenu-paired-4btn.png` (new)

---

## Deployment notes

- Production deployment ID: `AKfycbwIXi2HjDTeLr6ZG49FuJstrCV5ZmpuAhbcFQ-OkAy_nCoLbDzavxV0n73Cxqlsgsml` (v48 ตอนเขียน doc นี้)
- ทุกครั้งที่แก้ scope ใน `appsscript.json` → ต้อง redeploy ผ่าน UI (clasp 3.x reset access ทุกครั้ง)
- หลัง schema change → run `migrateSheets` ใน Apps Script editor
- หลัง rich menu image เปลี่ยน → run `setupPairedRichMenu4` ใน editor

---

## Settings → Drive checklist (สำหรับ tenant ใหม่)

1. Public Sheet → Settings → `CHECKIN_MODE` = `selfie` (หรือ `both`)
2. `CHECKIN_GEOFENCE_LAT` / `_LNG` = พิกัดหน้างาน
3. `CHECKIN_GEOFENCE_RADIUS_M` = `150`
4. `CHECKIN_APPROVER_USERIDS` = LINE userIds ของผู้อนุมัติ
5. `CHECKIN_DRIVE_FOLDER_ID` = folder ID (ต้องสร้างใน Drive ของบัญชี script owner)
