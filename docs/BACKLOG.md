# Backlog

Status as of 2026-05-09. Six features grouped into three PRs, ordered by dependency.

Conventions: each feature lists the user story, acceptance criteria, files touched, and the open questions that should be resolved before implementation. Backend changes always bump an Apps Script version (`clasp create-version` + `clasp redeploy -V N`) so the LIFF/webhook URL stays stable.

---

## PR 1 — Complete the employee LIFF surface

Goal: an employee can do every routine self-service (lookup, OT, leave) entirely inside LINE without touching the sheet.

### F1. OT request form (`ot.html`)

**As an employee**, I want to submit an OT request from LINE so that my approver gets a Flex message.

**Acceptance criteria**
- New LIFF page at `frontend/src/ot.html` that mirrors `leave.html` styling (HumanAI brand: cyan→emerald gradient, Prompt font, no emoji).
- Fields: date, start_time, end_time, ot_type (`weekday | rest | holiday`), reason (required, ≥3 chars).
- Live duration display ("X.X ชม.") below the time inputs.
- Posts `submitOT` with `idToken`; success closes the LIFF after 1.5s like `leave.html`.
- Pulls `getMyQuota`-equivalent context if needed (not required for MVP).

**Files**
- `frontend/src/ot.html` (new)
- Backend already has `submitOT` in `reconcile.gs` — no backend change unless validation (`reason_required`) needs to mirror leave.

**Open questions**
- Do we want the same `?backend=` fallback hardcoded as `leave.html`? Yes for now (single-tenant).
- Should LIFF Endpoint URL stay one URL (`leave.html`) and route to `ot.html` via query param, or have a second LIFF app? Pick one before implementing.

### F2. Quota & history view (`quota.html`)

**As an employee**, I want a read-only page that shows my remaining quota and recent approved leave so I can plan without asking HR.

**Acceptance criteria**
- New LIFF page at `frontend/src/quota.html`.
- Shows the same three quota tiles as the leave form header (sick / personal / vacation, remain / quota, with red/amber thresholds).
- Below: a list of the last 10 leave records (date, type, status pill).
- Empty state if no records yet.
- Link/button to open `leave.html` for new submission.

**Files**
- `frontend/src/quota.html` (new)
- New backend action `getMyHistory` (or extend `getMyQuota` payload) in `reconcile.gs` + register in `Code.gs::_getHandler`.

**Open questions**
- Should pending requests be shown alongside approved? Probably yes, with a "รออนุมัติ" pill — confirm with stakeholder.

---

## PR 2 — Owner approval & admin surface

Goal: the owner can manage approvals and trigger month-end actions from inside LINE; HR-side workflows that don't fit in chat.

### F3. Owner inbox LIFF (`owner.html`)

**As the owner**, I want a single page that lists every pending approval (leave + OT) so I can batch-handle them, instead of waiting for individual Flex pings.

**Acceptance criteria**
- New LIFF page at `frontend/src/owner.html`, gated by `ctx.empCode === 'OWNER'`.
- Lists pending leave + OT grouped by employee: name, dept, type, dates, reason, days, level (L1/L2/L3).
- Each row has Approve / Reject buttons that call `handleApprovalAction` directly (skip postback path).
- Refresh after each action; show count badge in the header.
- Forbidden message if non-owner opens the URL.

**Files**
- `frontend/src/owner.html` (new)
- New backend action `listPendingApprovals` in `approval.gs` (returns enriched rows via the same helpers used for Flex).
- `_requireOwner` is reused.

**Open questions**
- Should "rejected by other level" rows appear in history? For now hide; only show items still actionable by this approver.

### F4. Reconcile trigger + escalation summary

**As the owner**, I want to run reconcile for a period and get a Flex summary of escalations so I know what to fix before payroll.

**Acceptance criteria**
- New backend action `runReconcileWithSummary(period)` that wraps `runReconcile(period)` and pushes a Flex Message to OWNER summarizing: total reconciled rows, count escalated by reason (absent / short_work / unrequested_OT / unmatched_leave), top 3 employees by escalations.
- Triggered from `owner.html` (PR 2) or via a `/reconcile` text command in chat (handled by `_handleLineWebhook` text branch — currently TODO).
- Reuses `Escalation_Queue` data already produced by `reconcile.gs`.

**Files**
- `apps-script/reconcile.gs` (extend export)
- `apps-script/Code.gs::_handleLineWebhook` (add text-message branch)
- `apps-script/line_api.gs` (new Flex builder `sendReconcileSummaryFlex`)

**Open questions**
- Default period = current month or previous month? Previous month is safer since current isn't closed yet — default to `formatDate_(today minus one month)` MM.

---

## PR 3 — Payroll engine + slip

Goal: the system can produce a sealed monthly payroll slip per employee, sent privately via LINE.

### F5. Payroll calculation engine (`payroll.gs`)

**As the owner**, I want to compute monthly payroll from `Monthly_Summary` + `Salary_Master` + `Recurring_Deductions` so payslips can be generated without Excel.

**Acceptance criteria**
- New file `apps-script/payroll.gs` implementing `runPayroll(period)`:
  1. For each active employee: read working_days/short_days/leave_days/ot_hours from `Monthly_Summary`.
  2. Pull base_salary + rates from `Salary_Master` (use `findActiveRecord_`).
  3. Compute gross = base + (ot_1_hours × ot_1_rate) + … (holidays at higher rate).
  4. Subtract `Recurring_Deductions` active in this period; add `Monthly_Adjustments`.
  5. Subtract SSO 5% (capped 750 if eligible) and PF (`pf_rate` of base).
  6. Net = gross − deductions − tax.
  7. Append rows to `Payroll_Run` with all line items.
  8. Update `YTD_Accumulator`.
- Idempotent guard: if `Payroll_Run` already has rows for this period AND `locked=TRUE`, refuse to re-run (force flag override allowed for owner only).
- Audit each run.

**Files**
- `apps-script/payroll.gs` (new)
- `apps-script/Code.gs::_getHandler` (`runPayroll` owner-only)
- Tests in `tests/payroll.test.js` (mock spreadsheet, verify gross/net for the 5 dummy employees).

**Open questions**
- Tax computation: progressive Thai PIT or fixed-bracket simulation? Start with a pluggable `_computeTax_(annualGross, deductions)` — initial impl returns 0 (no withholding), document as a stub.
- Probation employees (EMP004): same calculation, just with `pf_rate=0`. Confirm.

### F6. Slip PDF + private LINE delivery (`slip_pdf.gs` + `slip.html`)

**As an employee**, I want to view my own slip privately in LINE with a downloadable PDF, never visible to HR.

**Acceptance criteria**
- `slip.html` LIFF page: select period dropdown → fetch slip via `getMySlip(period)` → render line-by-line (gross items, deductions, net) using brand styling.
- "ดาวน์โหลด PDF" button → calls `getMySlipPdf(period)` which returns a Drive share URL (PDF generated by `slip_pdf.gs` using HtmlService → `getAs(MimeType.PDF)` → write to a per-employee Drive folder with restricted ACL).
- After `runPayroll` completes, push a Flex card to each employee with date + net + "ดูสลิป" button linking to the LIFF.
- Owner can view any employee's slip from `owner.html`; employees see only their own (enforced by `ctx.empCode` match in `getMySlip`).

**Files**
- `apps-script/slip_pdf.gs` (new)
- `apps-script/payroll.gs` (post-run hook to push Flex)
- `frontend/src/slip.html` (new)

**Open questions**
- Drive ACL: per-employee folder shared with that employee's Google email? Or password-protected link delivered via LINE? Decide before building delivery flow.
- PDF font: HtmlService PDF rendering needs the font embedded — confirm Sarabun/Prompt support before committing to brand fidelity for PDF.

---

## Out of scope here

- AI parse for onboarding (`ai_stub.gs` real impl) — post-MVP.
- Bulk import of legacy attendance — covered by `Attendance_Raw` import as a manual paste for now.
- Multi-tenant frontend (drop the hardcoded backend URL fallback in `api.js` and pass via `?backend=`) — needs a config endpoint design first.
- Lock period UI — backend lock is sufficient for now; UI to flip the lock can wait.

---

## Working order

1. Land PR 1 first — it gives a complete employee surface and unlocks usage data we need for testing PR 3 thresholds.
2. PR 2 is independent of PR 3; do whichever is closer to a real user need first. If owner spends time approving from chat manually, prioritize PR 2.
3. PR 3 is the longest pole — its tests need at least one `Monthly_Summary` row populated by an end-to-end reconcile, so don't start until PR 1 + a demo run is in place.
