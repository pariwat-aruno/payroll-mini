# เทคนิค & สถานะ — Module by Module

สรุปเทคนิคหลักที่ใช้ในแต่ละ module + สถานะการ implement (Iteration 3)

---

## 1. เช็คอินด้วยใบหน้า (Selfie check-in) ✅

**ไฟล์หลัก:** `apps-script/checkin.gs` · `frontend/src/checkin.html` · `frontend/src/js/camera.js`

**เทคนิค:**
- **`getUserMedia`** ขอ stream กล้องสด (constraints `facingMode: 'user'` + ideal 960×720 — ไม่ใช้ `exact` กัน iOS "internal error")
- **Canvas burn overlay** — วาด video frame ลง canvas + วาด text band ทับ (date+time + emp_code + name) → tamper-evident
- **One-prompt-per-session** — เปิด stream ครั้งแรก ค้างไว้ stop ตอน `pagehide` เท่านั้น → สแกน 4 slot ไม่ขอ permission ซ้ำ
- **Camera-before-GPS** — เปิดกล้องก่อน (ในยู้สเซอร์ gesture) แล้วค่อยขอ GPS — iOS กัน user gesture หมด
- **File-input fallback** — `<input type=file accept=image/* capture=user>` เปิดกล้องระบบ iOS เมื่อ getUserMedia โดน webview block
- **Two-step upload** — `uploadCheckinSelfie` (body ใหญ่) แยกจาก `submitCheckin` (body เล็ก) → กัน LINE webview ตัด POST body ใหญ่
- **Haversine** geofence calc บน server
- **getDisplayValues** อ่านเวลาจาก Sheet (กัน 1899 BMT Date object shift)
- **Leading-space write** บังคับ Sheets เก็บ "HH:mm" เป็น text ไม่ปนเป็น Date serial

---

## 2. Reference selfie + ID card ตอน pair ✅

**ไฟล์หลัก:** `frontend/src/pair.html` · `apps-script/onboarding.gs`

**เทคนิค:**
- **Selfie: camera-only** (`getUserMedia`) — ห้าม upload เก่า
- **ID card: file input no-capture** — `<input type=file accept=image/*>` ไม่มี `capture` → iOS แสดง dialog "ถ่าย/เลือกจากคลัง"
- **`compressFile` helper** — file → canvas → JPEG 1200px quality 0.82 (ไม่ burn overlay สำหรับเอกสาร)
- **Try-catch รอบ upload** — pair สำเร็จต่อให้รูปอัปไม่ผ่าน (ยังเปิด chat ได้ ค่อยส่งรูปทีหลังก็ได้)

---

## 3. Drive image storage ✅

**ไฟล์หลัก:** `apps-script/drive.gs`

**เทคนิค:**
- **`DriveApp.createFile`** จาก base64 → blob ใน folder จาก `Settings.CHECKIN_DRIVE_FOLDER_ID`
- **`setSharing` ครอบ try-catch** — Workspace ที่บล็อก "anyone with link" ก็ยัง upload ไฟล์สำเร็จ
- **`driveUrlToThumbnail_`** แปลง preview URL → `drive.google.com/thumbnail?id=...&sz=w800` direct JPEG → LINE Flex hero render ได้แม้ไฟล์ไม่ public
- **Filename prefix** แยก kind ใน folder เดียว: `reference_<EMP>_<ts>.jpg`, `idcard_<EMP>_<ts>.jpg`, `slot<N>_<EMP>_<ts>.jpg`

---

## 4. Owner approval Flex ✅

**ไฟล์หลัก:** `apps-script/line_api.gs`

**เทคนิค:**
- **LINE Messaging API push** — `POST /v2/bot/message/push` พร้อม Flex bubble JSON
- **Side-by-side hero** — `type: 'box' layout: 'horizontal'` มี 2 image (scan + reference) สำหรับ checkin
- **Postback action** — `data: action=approve_checkin&emp=X&date=Y` → routed ที่ `_handlePostback` ใน Code.gs
- **Color-coded title** — green/amber/red/blue ตาม decision
- **altText capped 380 chars** — LINE จำกัด 400 chars
- **HTTP error logging** — pushFlex อ่าน response code, throw + write `PUSH_FLEX_FAILED` ใน Audit_Log

---

## 5. Decision ack Flex (generic) ✅

**ไฟล์หลัก:** `apps-script/line_api.gs::sendDecisionAckFlex`

**เทคนิค:**
- **One helper, 4 kinds × 2 audiences × 4 decisions** — checkin/leave/ot/change × approver/employee × approved/rejected/conditional/info_requested
- **Smart title** — "คุณ${verb}${kind} ${empCode}" สำหรับ approver, "${kind}ของคุณ${verb}" สำหรับ employee
- **Optional hero** — single image OR side-by-side ขึ้นกับ refImageUrl ที่ส่งมา
- **Optional footer buttons** — "🖼️ ดูรูปขนาดเต็ม" + "📄 ดูรายละเอียด" auto-render ตามที่ payload ระบุ

---

## 6. Late-scan reminders + EOD card ✅

**ไฟล์หลัก:** `apps-script/scheduler.gs::checkinReminderTick`

**เทคนิค:**
- **Time-driven trigger ทุก 5 นาที** สร้างผ่าน `installCheckinReminderTrigger()`
- **Slot-based trigger time** — `WORK_DAY_START + grace`, `LUNCH_START + grace`, `LUNCH_END + grace`, `WORK_DAY_END` exact
- **Tolerance ±2 นาที** กัน trigger drift
- **Multi-filter** — paired + work day (bitmap) + not holiday + slot not scanned
- **CacheService dedup** — key `reminder:<emp>:slot<N>:<date>` TTL 24h → กันส่งซ้ำ
- **EOD card สีเหลือง** — `styles: { body: { backgroundColor: '#FEF3C7' } }` + disclaimer

---

## 7. OT pay info ใน Flex ✅

**ไฟล์หลัก:** `apps-script/reconcile.gs::_otSalaryInfo_` · `line_api.gs::sendApprovalFlex`

**เทคนิค:**
- **`findActiveRecord_`** หา Salary_Master record ที่ effective ณ วันที่ขอ
- **Auto-classify ot_type** — Holiday_Calendar / Work_Schedule bitmap / time-of-day check
- **Monthly accumulation** — sum approved OT_Requests ใน period เดียวกัน group by ot_type × rate
- **Owner-only render** — เช็ค `lookupEmpCodeByUserId(approverUserId) === 'OWNER'` → render money rows เฉพาะ owner (privacy: HR เห็นไม่ได้)
- **Overnight OT** — รองรับ `end_date != date` (เวลา 23:00–02:00)

---

## 8. /ลงทะเบียน chat command ✅

**ไฟล์หลัก:** `apps-script/Code.gs::_handleTextMessage`

**เทคนิค:**
- **LINE webhook text event** — `event.type === 'message' && event.message.type === 'text'`
- **Open command** (ทุกคน) ก่อน owner-only gate
- **Auto-detect already paired** — ตอบข้อความต่าง: "ผูกอยู่แล้ว (รหัส X)" vs "ลิงก์ pair"
- **LIFF deep link** — `https://liff.line.me/<LIFF_ID>/pair.html`

---

## 9. Rich menu (4 ปุ่ม) ✅

**ไฟล์หลัก:** `apps-script/line_api.gs::setupPairedRichMenu4` · `frontend/src/richmenu-paired-4btn.png`

**เทคนิค:**
- **LINE Messaging API** — `POST /v2/bot/richmenu` สร้าง config JSON, `POST /content` upload image
- **Image generated by Python PIL** — วาด icon shapes (camera/note/clock/hamburger) ด้วย ImageDraw + Thai text ด้วย Sukhumvit Set font (Apple Color Emoji render ไม่ได้ → ใช้ shapes แทน)
- **Auto-assign on pair** — `assignRichMenu_` ใน pairEmployee + bulk reassign ทุก paired user หลัง setup
- **URI action** — แต่ละปุ่มเปิด `https://liff.line.me/<LIFF_ID>/<page>.html`

---

## 10. Onboarding new employee ✅

**ไฟล์หลัก:** `apps-script/onboarding.gs::onboardEmployee` · `frontend/src/onboard.html`

**เทคนิค:**
- **Single-transaction insert** — สร้าง 5 rows (Employees, Work_Schedule, Approval_Chain, Leave_Quota, Salary_Master) ในการเรียกเดียว
- **6-digit pairing code** — `Math.floor(100000 + Math.random() * 900000)` + CacheService TTL 24h
- **Auto-derive rates** — daily = base/30, hourly = daily/8, OT 1.5×/1×/3×
- **Copy buttons** บน success screen — `navigator.clipboard.writeText` + execCommand fallback

---

## 11. Pair flow + LINE_User_Map ✅

**ไฟล์หลัก:** `apps-script/onboarding.gs::pairEmployee` · `frontend/src/pair.html`

**เทคนิค:**
- **emp_code + 6-digit code match** จาก CacheService
- **Auto rich-menu switch** Onboarding → Paired หลัง pair สำเร็จ
- **Cache invalidation** ทันทีหลัง pair (emp:userId, uid:empCode)
- **Optional uploads** wrapped in try-catch (selfie + ID card)
- **Light-green gradient** "เริ่มใช้งาน" button (404 fix ที่ใช้ relative href)

---

## 12. Time storage fix (Sheets quirks) ✅

**ไฟล์หลัก:** `apps-script/checkin.gs::_fmtTimeCell_`

**เทคนิค:**
- **Problem:** Sheets แปลง "HH:mm" string เป็น Date 1899-12-30 + fractional. อ่านกลับมาผ่าน Asia/Bangkok TZ เจอ historical BMT (GMT+6:42) shift
- **Solution 1: Write-side** — leading space prefix " 19:03" บังคับ Sheets เก็บเป็น text
- **Solution 2: Read-side** — `getDisplayValues()` แทน `getValues()` → คืน string เหมือนที่เห็นในเซลล์
- **Solution 3: Fallback** — Date instanceof ใช้ `getUTCHours()/getUTCMinutes()`

---

## 13. Camera permission resilience ✅

**ไฟล์หลัก:** `frontend/src/js/camera.js` · `checkin.html`

**เทคนิค:**
- **Loose constraints** — `facingMode: 'user' + width/height ideal` ไม่ใช้ `exact`
- **One-shot getUserMedia** — กัน multi-permission prompt
- **Stream persistence** — เปิด modal ปิด modal แต่ stream ค้างไว้ stop ตอน pagehide
- **3 fallback paths:**
  1. Live camera (getUserMedia) — primary
  2. File input with `capture="user"` — เปิดกล้องระบบ iOS
  3. `liff.openWindow({ external: true })` — ขึ้นเฉพาะถ้า LIFF อนุญาต (default ไม่อนุญาต)

---

## 14. Two-step upload (large body workaround) ✅

**ไฟล์หลัก:** `apps-script/checkin.gs` · `frontend/src/checkin.html`

**เทคนิค:**
- **Problem:** Apps Script Web App ตอบ 302 redirect → `script.googleusercontent.com/macros/echo`. iOS LINE webview drop POST body ใหญ่ตอน redirect → fail เงียบ
- **Solution:** แยกเป็น 2 requests
  1. `uploadCheckinSelfie` — base64 selfie → return URL
  2. `submitCheckin` — lat/lng/url (body เล็ก)

---

## 15. doPost error visibility ✅

**ไฟล์หลัก:** `apps-script/Code.gs`

**เทคนิค:**
- เดิม catch ทุก error ส่ง `{ ok: false, error: 'internal_error' }` กว้าง → debug ไม่ได้
- ใหม่ ส่ง `err.message` จริง + audit log มี full stack
- **pushFlex** อ่าน response code, throw + audit ถ้า ≥400 + capped altText 380 chars

---

## 16. Home menu ✅

**ไฟล์หลัก:** `frontend/src/index.html`

**เทคนิค:**
- **Section grouping** — งานของฉัน / HR / เจ้าของ (auto-hide section ถ้าไม่มี card visible)
- **Icon box 42×42** สีพื้นต่างกันตามหมวด (cyan/emerald/indigo/sky/teal/violet/amber/rose/slate)
- **Role pills** สีพื้น (cyan-100/amber-100) แทน caps tag
- **JS force-navigate handler** — กัน LIFF webview ที่ block default `<a href>` กับ `display: flex`

---

## 17. Test runner ✅

**ไฟล์หลัก:** `apps-script/test_flex.gs::testAllFlexCards`

**เทคนิค:**
- **One-shot Flex regression test** — ส่ง 18 cards ครบทุก variant ไปยัง OWNER ใน LINE_User_Map
- **`tryPush` wrapper** — catch ต่อ card, log ✓/✗ + summary "N ok, M failed"
- **`Utilities.sleep(400)`** ระหว่าง push ป้องกัน LINE coalesce notification
- **Reuse owner's reference selfie** ถ้ามี — render preview สมจริง

---

## สรุป

- **Apps Script (backend):** `Code.gs`, `setup.gs`, `migrate.gs`, `reconcile.gs`, `approval.gs`, `checkin.gs`, `onboarding.gs`, `scheduler.gs`, `drive.gs`, `line_api.gs`, `payroll.gs`, `audit.gs`, `utils.gs`, `seed.gs`, `admin.gs`, `ai_stub.gs`, `test_flex.gs`
- **Frontend (LIFF on GitHub Pages):** `index.html`, `pair.html`, `onboard.html`, `checkin.html`, `leave.html`, `ot.html`, `quota.html`, `slip.html`, `hr.html`, `owner.html`, `respond.html`, `help.html` + `api.js`, `liff-bridge.js`, `js/camera.js`, `nav.js`, `photo-upload.js`
- **Image asset:** `richmenu-paired-4btn.png` (PIL-generated)
- **Production deployment:** `AKfycbwIXi2HjDTeLr6ZG49FuJstrCV5ZmpuAhbcFQ-OkAy_nCoLbDzavxV0n73Cxqlsgsml` (v55+)
- **Tests:** 28 passing (`tests/run.js`)
