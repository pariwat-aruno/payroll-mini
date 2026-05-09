/**
 * seed.gs — One-shot dummy data injection.
 *
 * Pre-reqs:
 *   1. Run setupAll() once (creates sheets + tabs).
 *   2. Send at least one LINE message to the OA so a WEBHOOK_DEBUG row
 *      lands in Audit_Log — that's how we detect your LINE userId.
 *
 * Then select `seedDummyData` from the dropdown and click Run.
 *
 * Idempotent guard: skips any tab that already has data rows.
 * For a full reseed, clear those tabs (keep headers) and run again.
 */

const _DUMMY = {
  employees: [
    ['EMP001', 'สมชาย', 'ใจดี', 'ชาย', '1100800123456', 'somchai.j@example.com', 'HR', 'HR Manager', '', '2022-01-15', '', 'active', 'SSO-001-2022', ''],
    ['EMP002', 'ปิยะ', 'วิทยา', 'ปื๊ด', '1100800234567', 'piya.w@example.com', 'Engineering', 'Senior Engineer', 'somchai.j@example.com', '2023-03-01', '', 'active', 'SSO-001-2023', ''],
    ['EMP003', 'มาลี', 'บุญมา', 'ลี', '3100800345678', 'malee.b@example.com', 'Sales', 'Sales Executive', 'somchai.j@example.com', '2024-06-10', '', 'active', 'SSO-001-2024', ''],
    ['EMP004', 'วิชัย', 'สมบูรณ์', 'ชัย', '1100800456789', 'wichai.s@example.com', 'Engineering', 'Junior Engineer', 'piya.w@example.com', '2025-11-20', '', 'probation', 'SSO-001-2025', 'passed 90-day'],
    ['EMP005', 'ปนิดา', 'ฉลาด', 'นิด', '3100800567890', 'panida.c@example.com', 'Accounting', 'Accountant', 'somchai.j@example.com', '2024-09-05', '', 'active', 'SSO-001-2024-2', ''],
  ],

  holidays: [
    ['2026-01-01', 'วันขึ้นปีใหม่', 'public', '*'],
    ['2026-02-13', 'วันมาฆบูชา', 'public', '*'],
    ['2026-04-06', 'วันจักรี', 'public', '*'],
    ['2026-04-13', 'วันสงกรานต์', 'public', '*'],
    ['2026-04-14', 'วันสงกรานต์', 'public', '*'],
    ['2026-04-15', 'วันสงกรานต์', 'public', '*'],
    ['2026-05-01', 'วันแรงงาน', 'public', '*'],
    ['2026-05-04', 'วันฉัตรมงคล', 'public', '*'],
    ['2026-06-01', 'วันวิสาขบูชา (ชดเชย)', 'public', '*'],
    ['2026-06-03', 'วันเฉลิมพระชนมพรรษาสมเด็จพระบรมราชินี', 'public', '*'],
    ['2026-07-28', 'วันเฉลิมพระชนมพรรษา ร.10', 'public', '*'],
    ['2026-07-29', 'วันอาสาฬหบูชา', 'public', '*'],
    ['2026-07-30', 'วันเข้าพรรษา', 'public', '*'],
    ['2026-08-12', 'วันแม่', 'public', '*'],
    ['2026-10-13', 'วันคล้ายวันสวรรคต ร.9', 'public', '*'],
    ['2026-10-23', 'วันปิยมหาราช', 'public', '*'],
    ['2026-12-07', 'ชดเชยวันคล้ายวันเฉลิม ร.9', 'public', '*'],
    ['2026-12-10', 'วันรัฐธรรมนูญ', 'public', '*'],
    ['2026-12-31', 'วันสิ้นปี', 'public', '*'],
  ],

  workSchedule: [
    ['EMP001', '2022-01-15', 'fixed', '1111100', 8, ''],
    ['EMP002', '2023-03-01', 'fixed', '1111100', 8, ''],
    ['EMP003', '2024-06-10', 'fixed', '1111100', 8, ''],
    ['EMP004', '2025-11-20', 'fixed', '1111100', 8, 'probation'],
    ['EMP005', '2024-09-05', 'fixed', '1111100', 8, ''],
  ],

  leaveQuota: [
    ['EMP001', 2026, 30, '', 3, '', 10, ''],
    ['EMP002', 2026, 30, '', 3, '', 8, ''],
    ['EMP003', 2026, 30, '', 3, '', 8, ''],
    ['EMP004', 2026, 30, '', 3, '', 6, ''],
    ['EMP005', 2026, 30, '', 3, '', 8, ''],
  ],

  approvalChain: [
    ['EMP001', 'OWNER', '', '', '2026-01-01', 'HR Manager direct to owner'],
    ['EMP002', 'EMP001', 'OWNER', '', '2026-01-01', ''],
    ['EMP003', 'EMP001', 'OWNER', '', '2026-01-01', ''],
    ['EMP004', 'EMP002', 'EMP001', 'OWNER', '2026-01-01', 'probation 3-level'],
    ['EMP005', 'EMP001', 'OWNER', '', '2026-01-01', ''],
  ],

  attendanceRaw: [
    ['EMP001', '2026-05-05', '09:00', '18:00', 540, 'fingerprint', '2026-05-05 18:01:00'],
    ['EMP001', '2026-05-06', '09:00', '18:00', 540, 'fingerprint', '2026-05-06 18:01:00'],
    ['EMP001', '2026-05-07', '09:00', '18:00', 540, 'fingerprint', '2026-05-07 18:01:00'],
    ['EMP001', '2026-05-08', '09:00', '18:00', 540, 'fingerprint', '2026-05-08 18:01:00'],
    ['EMP002', '2026-05-05', '09:00', '18:00', 540, 'fingerprint', '2026-05-05 18:01:00'],
    ['EMP002', '2026-05-06', '09:30', '18:00', 510, 'fingerprint', '2026-05-06 18:01:00'],
    ['EMP002', '2026-05-07', '09:00', '20:30', 690, 'fingerprint', '2026-05-07 20:31:00'],
    ['EMP002', '2026-05-08', '09:00', '18:00', 540, 'fingerprint', '2026-05-08 18:01:00'],
    ['EMP003', '2026-05-05', '09:00', '18:00', 540, 'fingerprint', '2026-05-05 18:01:00'],
    ['EMP003', '2026-05-06', '09:00', '18:00', 540, 'fingerprint', '2026-05-06 18:01:00'],
    ['EMP003', '2026-05-07', '09:00', '18:00', 540, 'fingerprint', '2026-05-07 18:01:00'],
    ['EMP004', '2026-05-05', '09:00', '18:00', 540, 'fingerprint', '2026-05-05 18:01:00'],
    ['EMP004', '2026-05-06', '09:00', '16:00', 420, 'fingerprint', '2026-05-06 16:01:00'],
    ['EMP004', '2026-05-07', '09:00', '18:00', 540, 'fingerprint', '2026-05-07 18:01:00'],
    ['EMP004', '2026-05-08', '09:00', '18:00', 540, 'fingerprint', '2026-05-08 18:01:00'],
    ['EMP005', '2026-05-05', '09:00', '18:00', 540, 'fingerprint', '2026-05-05 18:01:00'],
    ['EMP005', '2026-05-06', '09:00', '18:00', 540, 'fingerprint', '2026-05-06 18:01:00'],
    ['EMP005', '2026-05-07', '09:00', '18:00', 540, 'fingerprint', '2026-05-07 18:01:00'],
    ['EMP005', '2026-05-08', '09:00', '18:00', 540, 'fingerprint', '2026-05-08 18:01:00'],
  ],

  // ot_1 = 1.5× hourly  (weekday OT)
  // ot_2 = 1.0× hourly  (rest-day work — extra on top of base salary, total 2×)
  // ot_3 = 3.0× hourly  (OT on a rest/holiday)
  salaryMaster: [
    ['EMP001', '2022-01-15', 45000, 1500, 187.50, 281.25, 187.50, 562.50, true, 0.05, ''],
    ['EMP002', '2023-03-01', 65000, 2166.67, 270.83, 406.25, 270.83, 812.50, true, 0.05, ''],
    ['EMP003', '2024-06-10', 35000, 1166.67, 145.83, 218.75, 145.83, 437.50, true, 0.05, ''],
    ['EMP004', '2025-11-20', 30000, 1000, 125.00, 187.50, 125.00, 375.00, true, 0, 'probation no PF'],
    ['EMP005', '2024-09-05', 40000, 1333.33, 166.67, 250.00, 166.67, 500.00, true, 0.05, ''],
  ],

  recurringDeductions: [
    ['EMP002', 'mobile_loan', 1500, '2026-01-01', '2026-12-31', 'iPhone installment 12 mo'],
    ['EMP004', 'health_insurance', 800, '2025-11-20', '', 'group health plan'],
  ],
};

function seedDummyData() {
  const userId = _findLatestUserIdFromAudit_();
  if (!userId) {
    throw new Error('No WEBHOOK_DEBUG row in Audit_Log. Send a LINE message to the OA first.');
  }
  Logger.log('Detected LINE userId: ' + userId);

  const pub = getPublicSheet_();
  const sec = getSecretSheet_();

  const tasks = [
    [pub, 'Employees',          _DUMMY.employees],
    [pub, 'Holiday_Calendar',   _DUMMY.holidays],
    [pub, 'Work_Schedule',      _DUMMY.workSchedule],
    [pub, 'Leave_Quota',        _DUMMY.leaveQuota],
    [pub, 'Approval_Chain',     _DUMMY.approvalChain],
    [pub, 'Attendance_Raw',     _DUMMY.attendanceRaw],
    [sec, 'Salary_Master',      _DUMMY.salaryMaster],
    [sec, 'Recurring_Deductions', _DUMMY.recurringDeductions],
    [sec, 'LINE_User_Map', [
      [userId, 'OWNER', 'owner', 'เจ้าของระบบ', formatDatetime_(new Date()), '']
    ]],
  ];

  let added = 0;
  const summary = [];
  tasks.forEach(([ss, tabName, rows]) => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      summary.push('SKIP ' + tabName + ' — tab not found');
      return;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      summary.push('SKIP ' + tabName + ' — already has ' + (lastRow - 1) + ' rows');
      return;
    }
    const numCols = sheet.getLastColumn();
    const padded = rows.map(r => {
      const out = r.slice(0, numCols);
      while (out.length < numCols) out.push('');
      return out;
    });
    sheet.getRange(2, 1, padded.length, numCols).setValues(padded);
    summary.push('ADD  ' + tabName + ' +' + rows.length + ' rows');
    added += rows.length;
  });

  Logger.log(summary.join('\n'));
  Logger.log('=== SEED COMPLETE === added: ' + added + ' rows total');
  return { added, summary };
}

/**
 * Seed an OWNER row across the tabs that need one, so the owner account
 * can both run admin actions AND use the regular leave/OT/slip flows.
 * Idempotent: skips any tab that already has a row with emp_code='OWNER'.
 */
const _OWNER_DATA = {
  Employees:       ['OWNER', 'เจ้าของ', 'ระบบ', 'Owner', '1100800999999', 'p.pui@moodata.me', 'Management', 'Owner', '', '2020-01-01', '', 'active', '', 'system owner'],
  Work_Schedule:   ['OWNER', '2020-01-01', 'fixed', '1111100', 8, 'system owner'],
  Leave_Quota:     ['OWNER', 2026, 30, '', 3, '', 15, ''],
  Approval_Chain:  ['OWNER', 'OWNER', '', '', '2020-01-01', 'self-approval'],
  Salary_Master:   ['OWNER', '2020-01-01', 100000, 3333.33, 416.67, 625.00, 416.67, 1250.00, false, 0, 'owner'],
};

function seedOwner() {
  const pub = getPublicSheet_();
  const sec = getSecretSheet_();

  const tasks = [
    [pub, 'Employees',      _OWNER_DATA.Employees],
    [pub, 'Work_Schedule',  _OWNER_DATA.Work_Schedule],
    [pub, 'Leave_Quota',    _OWNER_DATA.Leave_Quota],
    [pub, 'Approval_Chain', _OWNER_DATA.Approval_Chain],
    [sec, 'Salary_Master',  _OWNER_DATA.Salary_Master],
  ];

  const summary = [];
  tasks.forEach(([ss, tabName, row]) => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) { summary.push('SKIP ' + tabName + ' — tab not found'); return; }
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const firstCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => r[0]);
      if (firstCol.indexOf('OWNER') >= 0) {
        summary.push('SKIP ' + tabName + ' — OWNER row exists');
        return;
      }
    }
    const numCols = sheet.getLastColumn();
    const padded = row.slice(0, numCols);
    while (padded.length < numCols) padded.push('');
    sheet.appendRow(padded);
    summary.push('ADD  ' + tabName);
  });

  Logger.log(summary.join('\n'));
  return summary;
}

/**
 * Migration: rest-day OT rate (ot_2_rate) was originally seeded as 2× hourly,
 * but per Thai labor practice for monthly-salaried staff, the EXTRA paid on a
 * rest day is 1× hourly (base wage already covers the day, so total = 2×).
 * This rewrites ot_2_rate to equal hourly_rate for every row in Salary_Master.
 */
function fixOtRates() {
  const sheet = getSecretSheet_().getSheetByName('Salary_Master');
  if (!sheet) { Logger.log('Salary_Master not found'); return 0; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const hourlyCol = headers.indexOf('hourly_rate') + 1;
  const ot2Col    = headers.indexOf('ot_2_rate') + 1;
  if (hourlyCol === 0 || ot2Col === 0) {
    Logger.log('hourly_rate or ot_2_rate column missing'); return 0;
  }

  let updated = 0;
  for (let r = 2; r <= lastRow; r++) {
    const hourly = Number(sheet.getRange(r, hourlyCol).getValue());
    const ot2    = Number(sheet.getRange(r, ot2Col).getValue());
    if (!hourly) continue;
    if (Math.abs(ot2 - hourly) < 0.01) continue;  // already correct
    sheet.getRange(r, ot2Col).setValue(hourly);
    updated++;
  }
  Logger.log('Updated ot_2_rate on ' + updated + ' rows');
  return updated;
}

/**
 * One-shot: delete WEBHOOK_DEBUG rows from Audit_Log (cleanup after onboarding).
 * Returns number of rows removed.
 */
function cleanupWebhookDebug() {
  const sheet = getSecretSheet_().getSheetByName('Audit_Log');
  if (!sheet) { Logger.log('Audit_Log not found'); return 0; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const actionCol = headers.indexOf('action');
  if (actionCol < 0) { Logger.log('action column not found'); return 0; }

  // Walk bottom-up so deletions don't shift unscanned rows
  let removed = 0;
  for (let r = lastRow; r >= 2; r--) {
    const v = sheet.getRange(r, actionCol + 1).getValue();
    if (v === 'WEBHOOK_DEBUG') {
      sheet.deleteRow(r);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' WEBHOOK_DEBUG rows');
  return removed;
}

/**
 * Debug helper: bypass LIFF/idToken, test the userId→empCode→quota chain.
 */
function debugMyQuota() {
  const userId = _findLatestUserIdFromAudit_();
  Logger.log('userId from audit: ' + userId);

  const empCode = lookupEmpCodeByUserId(userId);
  Logger.log('empCode from map: ' + empCode);

  const quotas = readTab_(getPublicSheet_(), 'Leave_Quota');
  Logger.log('Leave_Quota rows: ' + JSON.stringify(quotas));

  const quota = getMyQuota(empCode);
  Logger.log('getMyQuota returned: ' + JSON.stringify(quota));

  Logger.log('current year: ' + new Date().getFullYear());
}

function _findLatestUserIdFromAudit_() {
  const sec = getSecretSheet_();
  const sheet = sec.getSheetByName('Audit_Log');
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const actionCol = headers.indexOf('action');
  const targetIdCol = headers.indexOf('target_id');
  if (actionCol < 0 || targetIdCol < 0) return null;
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][actionCol] === 'WEBHOOK_DEBUG') {
      const id = data[i][targetIdCol];
      if (id && String(id).startsWith('U')) return String(id);
    }
  }
  return null;
}
