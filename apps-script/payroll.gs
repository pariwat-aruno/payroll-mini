/**
 * payroll.gs — Phase 5 engine
 *
 * Computes monthly payroll from:
 *   - Monthly_Summary       (per-employee period — produced by reconcile.gs)
 *   - Salary_Master         (per-employee active record)
 *   - Recurring_Deductions  (active rows for the period)
 *   - Monthly_Adjustments   (one-off adds/deducts for the period)
 *
 * Writes:
 *   - Payroll_Run         (per-employee period)
 *   - YTD_Accumulator     (per-employee year — recomputed every run)
 *
 * Idempotency: re-runs replace prior rows for the period unless any row is
 *   `status='locked'`. Pass opts.force=true to override (owner only).
 *
 * Tax: stubbed at 0 — replace `_computeTax_` when finalizing PIT logic.
 */

const SSO_RATE = 0.05;
const SSO_CAP  = 750;

function runPayroll(period, opts) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) throw new Error('invalid_period');
  opts = opts || {};

  const pubSs = getPublicSheet_();
  const secSs = getSecretSheet_();

  const employees   = readTab_(pubSs, 'Employees').filter(e =>
    e.status === 'active' || e.status === 'probation');
  const summaries   = readTab_(pubSs, 'Monthly_Summary').filter(s =>
    String(s.period) === period);
  const summaryMap  = {};
  summaries.forEach(s => summaryMap[s.emp_code] = s);

  const salaries    = readTab_(secSs, 'Salary_Master');
  const deductions  = readTab_(secSs, 'Recurring_Deductions');
  const adjustments = readTab_(secSs, 'Monthly_Adjustments').filter(a =>
    String(a.period) === period);

  const existing = readTab_(secSs, 'Payroll_Run').filter(r =>
    String(r.period) === period);
  if (existing.some(r => String(r.status) === 'locked') && !opts.force) {
    throw new Error('period_locked');
  }

  const periodEnd = _periodEndDate_(period);
  const newRows = [];
  const skipped = [];

  employees.forEach(emp => {
    const summary = summaryMap[emp.emp_code];
    if (!summary) { skipped.push({ emp_code: emp.emp_code, reason: 'no_summary' }); return; }

    const sal = findActiveRecord_(salaries, emp.emp_code, periodEnd);
    if (!sal) { skipped.push({ emp_code: emp.emp_code, reason: 'no_salary_record' }); return; }

    const basePay   = Number(sal.base_salary) || 0;
    const dailyRate = Number(sal.daily_rate)  || 0;
    const ot1Rate   = Number(sal.ot_1_rate)   || 0;
    const ot2Rate   = Number(sal.ot_2_rate)   || 0;
    const ot3Rate   = Number(sal.ot_3_rate)   || 0;

    const unpaidLeaveDays = Number(summary.unpaid_leave_days) || 0;
    const absentDays      = Number(summary.absent_days)       || 0;
    const ot1Hours        = Number(summary.ot_1_hours)        || 0;
    const ot2Hours        = Number(summary.ot_2_hours)        || 0;
    const ot3Hours        = Number(summary.ot_3_hours)        || 0;

    const unpaidLeaveDeduct = unpaidLeaveDays * dailyRate;
    const absentDeduct      = absentDays      * dailyRate;
    const ot1Pay = ot1Hours * ot1Rate;
    const ot2Pay = ot2Hours * ot2Rate;
    const ot3Pay = ot3Hours * ot3Rate;

    const myAdj = adjustments.filter(a => a.emp_code === emp.emp_code);
    const additionsTotal = _sum_(myAdj.filter(a => a.direction === 'addition').map(a => a.amount));
    const adjManual      = _sum_(myAdj.filter(a => a.direction === 'deduction' && (a.category === 'manual' || a.category === 'manual_deduction')).map(a => a.amount));
    const adjStudentLoan = _sum_(myAdj.filter(a => a.direction === 'deduction' && a.category === 'studentloan').map(a => a.amount));
    const adjCompanyLoan = _sum_(myAdj.filter(a => a.direction === 'deduction' && a.category === 'companyloan').map(a => a.amount));

    const myRec = deductions.filter(d => d.emp_code === emp.emp_code && _activeInPeriod_(d, period));
    const recStudentLoan = _sum_(myRec.filter(d => d.deduction_type === 'studentloan').map(d => d.amount));
    const recCompanyLoan = _sum_(myRec.filter(d => d.deduction_type === 'companyloan').map(d => d.amount));
    const recOther       = _sum_(myRec.filter(d => !['studentloan', 'companyloan'].includes(d.deduction_type)).map(d => d.amount));

    const studentLoan      = adjStudentLoan + recStudentLoan;
    const companyLoan      = adjCompanyLoan + recCompanyLoan;
    const manualDeductions = adjManual + recOther;

    const gross = basePay - unpaidLeaveDeduct - absentDeduct
                + ot1Pay + ot2Pay + ot3Pay + additionsTotal;

    const ssoEligible = String(sal.sso_eligible).toLowerCase() === 'true';
    const sso = ssoEligible ? Math.min(gross * SSO_RATE, SSO_CAP) : 0;
    const pf  = basePay * (Number(sal.pf_rate) || 0);
    const tax = _computeTax_(gross, sso + pf);
    const deductionsTotal = tax + sso + studentLoan + companyLoan + pf + manualDeductions;
    const net = gross - deductionsTotal;

    newRows.push({
      emp_code: emp.emp_code,
      period,
      base_pay:           _round2_(basePay),
      unpaid_leave_days:  unpaidLeaveDays,
      unpaid_leave_deduct:_round2_(unpaidLeaveDeduct),
      absent_days:        absentDays,
      absent_deduct:      _round2_(absentDeduct),
      ot_1_hours: ot1Hours, ot_1_pay: _round2_(ot1Pay),
      ot_2_hours: ot2Hours, ot_2_pay: _round2_(ot2Pay),
      ot_3_hours: ot3Hours, ot_3_pay: _round2_(ot3Pay),
      additions_total: _round2_(additionsTotal),
      gross:           _round2_(gross),
      tax: _round2_(tax),
      sso: _round2_(sso),
      studentloan: _round2_(studentLoan),
      companyloan: _round2_(companyLoan),
      pf: _round2_(pf),
      manual_deductions: _round2_(manualDeductions),
      deductions_total:  _round2_(deductionsTotal),
      net: _round2_(net),
      status: 'computed',
      computed_at: formatDatetime_(new Date()),
      sent_at: '',
    });
  });

  _replacePeriod_(secSs, 'Payroll_Run', period, newRows);

  const year = Number(period.substring(0, 4));
  _recomputeYtd_(secSs, year);

  logAudit({
    action: 'RUN_PAYROLL',
    target_type: 'period',
    target_id: period,
    after: {
      employees_processed: newRows.length,
      skipped: skipped.length,
      total_gross: _round2_(_sum_(newRows.map(r => r.gross))),
      total_net:   _round2_(_sum_(newRows.map(r => r.net))),
    },
  });

  return {
    period,
    employees_processed: newRows.length,
    skipped,
    total_gross: _round2_(_sum_(newRows.map(r => r.gross))),
    total_net:   _round2_(_sum_(newRows.map(r => r.net))),
  };
}

/* ============================================================
 * Tax stub — replace with real Thai PIT calculation later.
 * ============================================================ */
function _computeTax_(monthlyGross, deductBeforeTax) {
  // Returns 0 until withholding logic is finalized.
  return 0;
}

/* ============================================================
 * Helpers (private)
 * ============================================================ */
function _sum_(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function _round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function _periodEndDate_(period) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${period}-${String(last).padStart(2, '0')}`;
}

function _activeInPeriod_(d, period) {
  const periodStart = period + '-01';
  const periodEnd   = _periodEndDate_(period);
  const from = d.effective_from ? formatDate_(d.effective_from) : '';
  const to   = d.effective_to   ? formatDate_(d.effective_to)   : '';
  if (from && compareDateStrings_(from, periodEnd) > 0) return false;
  if (to   && compareDateStrings_(to,   periodStart) < 0) return false;
  return true;
}

function _replacePeriod_(ss, tabName, period, rows) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const periodCol = headers.indexOf('period');
  if (periodCol < 0) throw new Error('period column missing in ' + tabName);

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const allValues = sheet.getRange(2, periodCol + 1, lastRow - 1, 1).getValues();
    for (let i = allValues.length - 1; i >= 0; i--) {
      if (String(allValues[i][0]) === period) {
        sheet.deleteRow(i + 2);
      }
    }
  }
  if (rows.length > 0) appendRows_(ss, tabName, rows);
}

function _recomputeYtd_(secSs, year) {
  const all = readTab_(secSs, 'Payroll_Run').filter(r =>
    String(r.period).startsWith(String(year) + '-'));

  const byEmp = {};
  all.forEach(r => {
    const k = r.emp_code;
    if (!byEmp[k]) byEmp[k] = {
      emp_code: k, year,
      gross_ytd: 0, net_ytd: 0, tax_ytd: 0,
      sso_ytd: 0, pf_ytd: 0, ot_pay_ytd: 0,
    };
    byEmp[k].gross_ytd  += Number(r.gross) || 0;
    byEmp[k].net_ytd    += Number(r.net)   || 0;
    byEmp[k].tax_ytd    += Number(r.tax)   || 0;
    byEmp[k].sso_ytd    += Number(r.sso)   || 0;
    byEmp[k].pf_ytd     += Number(r.pf)    || 0;
    byEmp[k].ot_pay_ytd += (Number(r.ot_1_pay) || 0)
                        + (Number(r.ot_2_pay) || 0)
                        + (Number(r.ot_3_pay) || 0);
  });

  const now = formatDatetime_(new Date());
  const rows = Object.values(byEmp).map(r => ({
    emp_code: r.emp_code,
    year:     r.year,
    gross_ytd:  _round2_(r.gross_ytd),
    net_ytd:    _round2_(r.net_ytd),
    tax_ytd:    _round2_(r.tax_ytd),
    sso_ytd:    _round2_(r.sso_ytd),
    pf_ytd:     _round2_(r.pf_ytd),
    ot_pay_ytd: _round2_(r.ot_pay_ytd),
    last_updated: now,
  }));

  // Replace YTD rows for the year
  const sheet = secSs.getSheetByName('YTD_Accumulator');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearCol = headers.indexOf('year');
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const allYears = sheet.getRange(2, yearCol + 1, lastRow - 1, 1).getValues();
    for (let i = allYears.length - 1; i >= 0; i--) {
      if (Number(allYears[i][0]) === year) {
        sheet.deleteRow(i + 2);
      }
    }
  }
  if (rows.length > 0) appendRows_(secSs, 'YTD_Accumulator', rows);
}
