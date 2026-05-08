# Payroll Mini System

> ระบบ payroll สำหรับ SME ไทย ที่แยกข้อมูลเงินเดือนออกจาก HR
> Stack: Google Sheets + Apps Script + LINE LIFF + GitHub Pages

## ทำไมระบบนี้ถึงเกิด

ลูกค้า SME ไทยส่วนใหญ่มีปัญหาเดียวกัน:
1. **ระบบสแกนนิ้ว + ระบบลางาน + payroll** ไม่คุยกัน → HR reconcile เอง ทุกเดือน
2. **HR เห็นเงินเดือน** = เจ้าของไม่สบายใจ ความลับรั่ว

ระบบนี้แก้ทั้ง 2 ปัญหา ด้วย:
- **3-layer privacy architecture** — HR เห็นแค่วันเข้างาน เจ้าของเห็นเงิน พนักงานเห็นแค่ของตัวเอง
- **Auto reconcile** — สแกนนิ้ว + ใบลา + ใบ OT → คำนวณวันทำงานสุทธิ
- **Default deny** — ถ้าไม่มีหลักฐาน = ไม่จ่าย (ปลอดภัยทางกฎหมาย)
- **LIFF** — พนักงานส่งใบลา/ขอ OT/ดูสลิปผ่าน LINE

## โครงสร้างโปรเจกต์

```
payroll-starter/
├── frontend/              ← LIFF static web (deploy GitHub Pages)
│   ├── src/
│   │   ├── leave.html     ← หน้าส่งใบลา (พร้อมใช้)
│   │   ├── shared.css     ← styling
│   │   ├── liff-bridge.js ← LIFF SDK + mock for local dev
│   │   └── api.js         ← POST helper (CORS-safe)
│   └── public/            ← static assets
│
├── apps-script/           ← Backend (clasp push to Apps Script)
│   ├── Code.gs            ← entry: doGet, doPost, routing
│   ├── setup.gs           ← run-once: สร้าง Sheet ครบทุก tab
│   ├── reconcile.gs       ← ขั้น 1-4 ของ pipeline
│   ├── line_api.gs        ← verify token, push message
│   ├── audit.gs           ← audit log
│   ├── ai_stub.gs         ← AI parse interface (stub, ยังไม่ working)
│   ├── utils.gs           ← helper: dates, lookups
│   └── .clasp.json        ← clasp config (gitignored)
│
├── docs/
│   ├── ARCHITECTURE.md    ← ภาพรวมระบบ + flow
│   ├── SHEET_SCHEMA.md    ← column ทุก tab
│   ├── SETUP_GUIDE.md     ← step-by-step setup ทีละหน้าจอ
│   └── ONBOARDING_NEW_CLIENT.md ← วิธี onboard ลูกค้าใหม่
│
├── tests/                 ← unit tests สำหรับ reconcile logic
│
├── .github/workflows/
│   └── deploy.yml         ← auto-deploy frontend to GitHub Pages
│
├── CLAUDE.md              ← context ให้ Claude Code อ่านก่อนเริ่ม
└── README.md              ← (ไฟล์นี้)
```

## เริ่มต้นใช้งาน

อ่านใน order นี้:

1. **`CLAUDE.md`** — ถ้าเริ่ม Claude Code ใน repo นี้ ให้อ่านอันนี้ก่อน
2. **`docs/SETUP_GUIDE.md`** — setup ครั้งแรก
3. **`docs/ARCHITECTURE.md`** — เข้าใจ design decision
4. **`docs/SHEET_SCHEMA.md`** — column reference

## Stack สรุป

| Layer | Tech | ทำไม |
|---|---|---|
| Frontend | Vanilla HTML + JS + Tailwind CDN | ไม่ต้อง build, deploy เร็ว |
| Hosting | GitHub Pages | ฟรี, CDN, version control |
| Backend | Google Apps Script | ฟรี, integrated กับ Sheets |
| Database | Google Sheets | ลูกค้าเป็นเจ้าของ, แก้มือได้ |
| Auth | LINE Login + LIFF | คนไทยทุกคนมี LINE |
| Notification | LINE Messaging API | reach 100% |

## Roadmap

- [x] Phase 0: Project setup
- [x] Phase 1: Reconcile Engine (ขั้น 1-4)
- [ ] Phase 2: LIFF Forms (leave + OT + slip view)
- [ ] Phase 3: Onboarding (LINE userId ↔ emp_code mapping)
- [ ] Phase 4: Approval flow (Flex message)
- [ ] Phase 5: Payroll calculation + Slip generator (ขั้น 5-8)
- [ ] Phase 6: Audit + Lock period
- [ ] Phase 7+: AI parse for onboarding (post-MVP)

Phase 0-1 และ leave form เริ่มต้น = อยู่ใน starter pack นี้  
ที่เหลือ = build ต่อด้วย Claude Code
