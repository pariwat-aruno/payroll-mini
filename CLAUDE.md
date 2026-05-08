# CLAUDE.md

> Context document for Claude Code working on this repo.
> Read this fully before making changes.

## TL;DR

This is a **multi-tenant payroll system** for Thai SMEs. Each customer gets their own:
- Google Sheet (data)
- Apps Script project (backend)
- LINE Official Account + LIFF (frontend channel)

The frontend (this GitHub Pages site) is **shared** across all customers and points to each customer's Apps Script via a config baked into the LIFF URL.

## What problem does this solve

Thai SMEs struggle with three disconnected systems: fingerprint scanners, leave management, and payroll. HR ends up reconciling manually every month. Worse — owners don't want HR to see salary data, but standard payroll software exposes it.

This system enforces **privacy through data layer separation**:
- **Public Layer** (HR can see): attendance, leave, OT — no money
- **Secret Layer** (Owner only): salary, deductions, payroll runs
- **Output** (Employee only): their own slip via LINE direct message

## Architecture

```
LINE app → LIFF (GitHub Pages, this repo's frontend/)
            ↓ POST with idToken
Apps Script Web App (each customer has their own)
            ↓
Google Sheets (each customer has their own)
            ↓
LINE Messaging API → push slip back to employee
```

Frontend lives at `https://<your-username>.github.io/payroll-mini/`. Each customer's Apps Script Web App URL is **passed in the LIFF URL** as a query param, so the frontend knows which backend to talk to.

Example LIFF URL:
```
https://liff.line.me/<liff-id>?backend=AKfy...exec&tenant=acme
```

## Working principles

1. **Privacy by separation** — never mix public and secret data in the same Sheet tab. The only bridge is `Monthly_Summary` which has counts of days/hours but zero money.
2. **Default deny** — attendance starts as "absent" each day; only fingerprint + leave + OT records can override.
3. **Evidence-based override** — every status change needs proof (leave record, OT request, schedule override).
4. **Append-only audit** — `Audit_Log` is write-once. Owner can read; system writes; no manual edits.
5. **Locked periods** — once a payroll run is finalized and slips sent, it's locked. Corrections happen in the next period via adjustment entries, not by editing the past.
6. **No AI in core path** — the payroll pipeline is pure rule-based logic. AI is reserved for nice-to-have features like parsing handwritten leave slips during onboarding (currently stub only).

## Key files & where logic lives

| File | Responsibility |
|---|---|
| `apps-script/Code.gs` | HTTP entry: `doGet` (serves nothing — frontend is on Pages), `doPost` (route by `action` field, also handles LINE webhook events) |
| `apps-script/setup.gs` | One-shot: creates Public Sheet + Secret Sheet with all tabs, headers, validation, protected ranges. Seeds `Approval_Rules` and `Settings` with best-practice defaults. |
| `apps-script/reconcile.gs` | The reconcile engine. Steps 1-4: ingest → reconcile attendance → match OT → build monthly summary. Also `submitLeave`/`submitOT` handlers. |
| `apps-script/approval.gs` | Multi-level approval flow + cutoff/backdated logic. `determineRequiredLevels`, `buildInitialApprovalState`, `handleApprovalAction` (called from webhook). |
| `apps-script/scheduler.gs` | Time-driven trigger handlers. `dailyReminderTick` runs daily 09:00, sends cutoff reminders to employees + period-closed notification to owner. |
| `apps-script/line_api.gs` | Verify LIFF idToken, push messages, lookup userId↔emp_code mapping, `sendApprovalFlex` (build approve/reject Flex bubble). |
| `apps-script/audit.gs` | Write to `Audit_Log` from any operation |
| `apps-script/ai_stub.gs` | AI parse interface — currently returns mock; real impl post-MVP |
| `apps-script/utils.gs` | Date math, sheet helpers, period calculation, `getEmployees_` filter |
| `frontend/src/leave.html` | LIFF page for submitting leave requests |
| `frontend/src/liff-bridge.js` | LIFF SDK init + mock for local development |
| `frontend/src/api.js` | CORS-safe POST to Apps Script |

## CORS gotcha

Apps Script Web App does not return standard CORS headers. We work around this by sending requests as `Content-Type: text/plain;charset=utf-8` (which doesn't trigger preflight), and the body is JSON-encoded text. **Do not change this without testing thoroughly** — switching to `application/json` will break it.

See `frontend/src/api.js`.

## API contract

All requests POST to the Apps Script `/exec` URL with this shape:

```json
{
  "action": "submitLeave" | "submitOT" | "getQuota" | "getSlip" | ...,
  "idToken": "<LIFF id token>",
  "payload": { ... action-specific data ... }
}
```

Apps Script:
1. Verifies idToken with LINE API → resolves `userId`
2. Looks up `emp_code` from `userId` mapping
3. Routes to handler in `reconcile.gs` / `payroll.gs` etc.
4. Returns `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`

## Sheet structure

Two Google Sheets per customer:
- **Public Sheet**: `Employees`, `Holiday_Calendar`, `Work_Schedule`, `Schedule_Override`, `Leave_Quota`, `Leave_Records`, `OT_Requests`, `Approval_Chain`, `Approval_Rules`, `Settings`, `Attendance_Raw`, `Attendance_Reconciled`, `Monthly_Summary`, `Escalation_Queue`
- **Secret Sheet**: `Salary_Master`, `Recurring_Deductions`, `Monthly_Adjustments`, `Payroll_Run`, `YTD_Accumulator`, `Audit_Log`, `LINE_User_Map`

`Approval_Chain` and `Approval_Rules` are **per-employee approver mapping** and **rule definitions** (e.g. "leave 6+ days requires 3-level approval"). Pre-seeded with sensible defaults during `setupAll()`. Customer can edit anytime.

`Settings` is a key-value tab for system configuration (CUTOFF_DAY, REMINDER_ENABLED, etc.). Pre-seeded; customer-editable.

`docs/SHEET_SCHEMA.md` has the column-by-column spec.

## Properties (secrets)

Stored in Apps Script `PropertiesService.getScriptProperties()`. Never hardcoded:

```
LINE_CHANNEL_ID
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
LIFF_ID
PUBLIC_SHEET_ID
SECRET_SHEET_ID
OWNER_EMAIL
ANTHROPIC_API_KEY     (optional, for AI features later)
```

The `setup.gs` script asks for these on first run.

## How to develop

```bash
# Frontend (live preview)
cd frontend
npx serve src   # or use VSCode Live Server

# Backend (clasp)
cd apps-script
clasp login
clasp push       # upload to Apps Script
clasp open       # open editor in browser

# Tests
cd tests
node run.js
```

## How to onboard a new customer

See `docs/ONBOARDING_NEW_CLIENT.md`. TL;DR:

1. Customer creates LINE OA + LIFF channel themselves
2. You run `clasp clone` from template Apps Script project
3. Run `setup.gs` → it creates two Sheets
4. Paste customer's LINE keys into PropertiesService
5. Deploy Web App → give exec URL to customer
6. Customer sets LIFF endpoint URL = `https://<your-pages-url>/?backend=<exec-url>`

## Approval flow (Leave requests)

Multi-level approval triggered by rule engine, settable per leave_type and day count.

### Rule resolution
At submit time, `determineRequiredLevels(leave_type, days)` reads `Approval_Rules` and
returns 1, 2, or 3. Default ruleset (seeded by setup):

```
1-2 days  → L1 only (direct supervisor)
3-5 days  → L1 + L2 (supervisor + manager)
6+ days   → L1 + L2 + L3 (supervisor + manager + owner)
```

Customer can edit rules in the Sheet — type can be `*` (wildcard) or specific
(`sick`, `vacation`, etc.). First matching active rule wins.

### Approver chain
`Approval_Chain` tab maps each employee to their L1/L2/L3 approvers (LINE userIds).
The chain has `effective_from` for history.

### Lifecycle
```
submit → status=pending_L1, send Flex to L1
   ↓ L1 taps Approve
status=pending_L2 (if required), send Flex to L2
   ↓ L2 taps Approve
status=pending_L3 (if required), send Flex to L3
   ↓ L3 taps Approve
status=approved, final_approved_at set, employee notified
```

Any reject at any level → status=rejected, employee notified, chain stops.

### Multi-day requests
A 3-day leave creates 3 rows in `Leave_Records`, all sharing `request_group_id`.
Approval/rejection acts on the whole group atomically.

## Cutoff enforcement

`CUTOFF_DAY` setting (default 25) defines when each month's payroll period closes.

`checkBackdated(targetDateStr)` returns whether the target date is in a closed period.

Two modes (configurable in Settings):
- **strict**: Backdated submissions are rejected outright (unless owner override)
- **lenient** (default): Accept but flag with `is_backdated=true` for audit

`scheduler.gs::dailyReminderTick` fires daily at 09:00 (configurable trigger):
- T-2, T-1, T-0 before cutoff: broadcast reminder to all employees
- T+1 after cutoff: notify owner that period closed + count of pending items

## What's done vs todo

**Done in this starter pack:**
- Project structure
- Architecture + Schema docs
- Setup guide
- `setup.gs` (creates Sheets + tabs, seeds Approval_Rules + Settings with defaults)
- `reconcile.gs` (steps 1-4 of pipeline + `submitLeave`/`submitOT` with multi-level approval)
- `approval.gs` (multi-level approval flow, cutoff/backdated detection)
- `scheduler.gs` (daily reminder tick — broadcasts cutoff reminders, notifies owner of period close)
- `utils.gs`, `audit.gs`, `line_api.gs` (verify + push + Flex builder)
- `ai_stub.gs` (interface only)
- `frontend/src/leave.html` (LIFF leave request form)
- GitHub Action for Pages deployment
- Tests for reconcile (12) + approval/cutoff (16) — 28 total, all passing

**Todo (Claude Code's job):**
- LIFF pages: `ot.html`, `slip.html`, `quota.html`, `onboard.html`
- Approval Flex Message flow
- `payroll.gs` (steps 5-8: gross calc, deductions, net, slip generation)
- `slip_pdf.gs` (PDF generator using HtmlService)
- Lock period implementation
- Real AI integration (replace stub)
- More tests

## Conventions

- File names: snake_case for Apps Script (`reconcile.gs`), kebab-case for HTML (`leave.html`)
- Function names: camelCase (`reconcileAttendance`), prefixed by `_` if private
- Date format: ISO 8601 strings (`2026-05-08`)
- Time format: `HH:mm` (24h)
- Period format: `YYYY-MM` (e.g. `2026-05`)
- All amounts: number, 2 decimal places, baht
- Comments in Thai are OK for domain logic; English for technical/structural

## When you (Claude Code) need to make changes

1. Read this file first.
2. Read `docs/ARCHITECTURE.md` for the bigger picture.
3. Read `docs/SHEET_SCHEMA.md` if your change touches data.
4. Run tests before committing.
5. If adding a new `action` to the API, add it to the contract section above.
6. If adding a new property/secret, add it to the Properties section above.

## Things to NOT do without asking

- Change CORS approach in `frontend/src/api.js`
- Add new tab to Public Sheet that contains money/salary fields
- Bypass `verifyIdToken` in `line_api.gs`
- Allow `Audit_Log` writes from outside `audit.gs`
- Hardcode any key/secret/URL
- Mix Public and Secret Sheet IDs in the same code path
