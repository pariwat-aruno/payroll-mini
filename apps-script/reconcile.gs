/**
 * reconcile.gs — Pipeline steps 1-4
 *
 *  1. INGEST          — import fingerprint CSV (manual or via UI)
 *  2. RECONCILE       — derive daily attendance status
 *  3. OT MATCH        — match OT requests with actual overtime
 *  4. MONTHLY SUMMARY — collapse to per-employee totals (Public→Secret bridge)
 *
 * Steps 5-8 (calc gross, deductions, slip) are in payroll.gs (TODO).
 */

/* ============================================================
 * Public API: handlers called from Code.gs
 * ============================================================ */

/**
 * Submit a leave request from LIFF.
 * One submission may span multiple days → creates multiple rows.
 *
 * @param {object} payload
 * @param {string} payload.start_date
 * @param {string} payload.end_date
 * @param {string} payload.leave_type — sick | personal | vacation | unpaid | maternity
 * @param {string} payload.reason
 * @param {string} [payload.evidence_url]
 */
function submitLeave(payload, ctx) {
  const { start_date, end_date, leave_type, reason, evidence_url } = payload;
  if (!start_date || !end_date || !leave_type) {
    throw new Error('missing_fields');
  }
  if (!reason || String(reason).trim().length < 3) {
    throw new Error('reason_required');
  }

  const dates = [];
  let cursor = new Date(start_date);
  const end = new Date(end_date);
  while (cursor <= end) {
    dates.push(formatDate_(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (dates.length === 0 || dates.length > 31) {
    throw new Error('invalid_date_range');
  }

  // === Cut-off check ===
  // Check the EARLIEST date in the request — if any falls in a closed period, it's backdated
  const earliestDate = dates[0];
  const cutoffCheck = checkBackdated(earliestDate);
  let isBackdated = false;

  if (cutoffCheck.isBackdated) {
    if (cutoffCheck.mode === 'strict') {
      // Reject outright unless owner override (owner has empCode='OWNER' per Code.gs)
      const ownerOverride = String(getSetting_('BACKDATED_REQUIRES_OWNER', 'true')).toLowerCase() === 'true';
      if (ownerOverride && ctx.empCode !== 'OWNER') {
        throw new Error('backdated_rejected: ' + cutoffCheck.reason);
      }
    }
    // lenient mode: accept but flag
    isBackdated = true;
  }

  // === Determine required approval levels based on the rule ===
  const days = dates.length;
  const requiredLevels = determineRequiredLevels(leave_type, days);
  const approvalState = buildInitialApprovalState(ctx.empCode, requiredLevels);

  // === Write all rows together with shared request_group_id ===
  const publicSs = getPublicSheet_();
  const submittedAt = formatDatetime_(new Date());
  const groupId = generateId_('LVG');  // shared across all dates in this submission

  const rows = dates.map((d, idx) => ({
    leave_id: groupId + '-D' + String(idx + 1).padStart(2, '0'),
    emp_code: ctx.empCode,
    date: d,
    leave_type,
    reason: reason || '',
    submitted_at: submittedAt,
    status: approvalState.status,
    request_group_id: groupId,
    days_in_request: days,
    required_levels: approvalState.required_levels,
    level_1_status: approvalState.level_1_status,
    level_1_approver: approvalState.level_1_approver,
    level_1_at: approvalState.level_1_at,
    level_2_status: approvalState.level_2_status,
    level_2_approver: approvalState.level_2_approver,
    level_2_at: approvalState.level_2_at,
    level_3_status: approvalState.level_3_status,
    level_3_approver: approvalState.level_3_approver,
    level_3_at: approvalState.level_3_at,
    final_approved_at: approvalState.final_approved_at,
    is_backdated: isBackdated ? 'TRUE' : 'FALSE',
    evidence_url: evidence_url || '',
  }));

  appendRows_(publicSs, 'Leave_Records', rows);

  logAudit({
    action: 'SUBMIT_LEAVE',
    target_type: 'leave_record',
    target_id: groupId,
    after: {
      count: rows.length,
      dates,
      leave_type,
      required_levels: requiredLevels,
      is_backdated: isBackdated,
    },
  });

  // === Notify L1 approver via Flex Message ===
  try {
    const emp = _getEmployeeRow_(ctx.empCode);
    const stats = _getLeaveStatsThisYear_(ctx.empCode);
    sendApprovalFlex(approvalState.level_1_approver, {
      id: rows[0].leave_id,
      level: 1,
      isLeave: true,
      empCode: ctx.empCode,
      firstName: emp ? emp.first_name : '',
      lastName:  emp ? emp.last_name  : '',
      department: emp ? emp.department : '',
      position:   emp ? emp.position   : '',
      date: dates.length === 1 ? dates[0] : `${dates[0]} ถึง ${dates[dates.length-1]} (${days} วัน)`,
      leaveType: leave_type,
      reason: reason || '-',
      requiredLevels,
      isBackdated,
      stats,
    });
  } catch (e) {
    console.error('notify L1 approver failed: ' + e);
    // Don't fail the submission — record is saved, owner can resolve manually
  }

  return {
    request_group_id: groupId,
    count: rows.length,
    leave_ids: rows.map(r => r.leave_id),
    required_levels: requiredLevels,
    is_backdated: isBackdated,
    backdated_reason: isBackdated ? cutoffCheck.reason : null,
  };
}

/**
 * Look up employee detail row by emp_code.
 */
function _getEmployeeRow_(empCode) {
  const all = readTab_(getPublicSheet_(), 'Employees');
  return all.find(e => e.emp_code === empCode) || null;
}

/**
 * Aggregate approved leave stats for current year, grouped by leave_type.
 * count = number of distinct request_group_id; days = number of rows.
 */
function _getLeaveStatsThisYear_(empCode) {
  const year = new Date().getFullYear();
  const records = readTab_(getPublicSheet_(), 'Leave_Records')
    .filter(r => r.emp_code === empCode)
    .filter(r => r.status === 'approved')
    .filter(r => new Date(r.date).getFullYear() === year);

  const groups = {};
  records.forEach(r => {
    const t = r.leave_type;
    if (!groups[t]) groups[t] = new Set();
    groups[t].add(r.request_group_id || r.leave_id);
  });

  const buildStat = (type) => ({
    count: groups[type] ? groups[type].size : 0,
    days:  records.filter(r => r.leave_type === type).length,
  });

  return {
    year,
    sick:     buildStat('sick'),
    personal: buildStat('personal'),
    vacation: buildStat('vacation'),
  };
}

/**
 * Submit an OT request from LIFF.
 */
function submitOT(payload, ctx) {
  const { date, start_time, end_time, ot_type, reason } = payload;
  if (!date || !start_time || !end_time || !ot_type) {
    throw new Error('missing_fields');
  }

  const publicSs = getPublicSheet_();
  const otId = generateId_('OT');
  appendRows_(publicSs, 'OT_Requests', [{
    ot_id: otId,
    emp_code: ctx.empCode,
    date,
    start_time,
    end_time,
    ot_type,
    reason: reason || '',
    submitted_at: formatDatetime_(new Date()),
    status: 'pending',
    approved_by: '',
    approved_at: '',
  }]);

  logAudit({
    action: 'SUBMIT_OT',
    target_type: 'ot_request',
    target_id: otId,
    after: { date, start_time, end_time, ot_type },
  });

  return { ot_id: otId };
}

/**
 * Get my leave quota (current year).
 */
function getMyQuota(empCode) {
  const publicSs = getPublicSheet_();
  const quotas = readTab_(publicSs, 'Leave_Quota');
  const year = new Date().getFullYear();
  const row = quotas.find(q => q.emp_code === empCode && Number(q.year) === year);
  if (!row) return null;

  // Compute used counts on the fly (don't trust formulas here)
  const records = readTab_(publicSs, 'Leave_Records')
    .filter(r => r.emp_code === empCode && r.status === 'approved')
    .filter(r => new Date(r.date).getFullYear() === year);

  const used = (type) => records.filter(r => r.leave_type === type).length;

  return {
    year,
    sick:     { quota: row.sick_quota,     used: used('sick'),     remain: row.sick_quota     - used('sick') },
    personal: { quota: row.personal_quota, used: used('personal'), remain: row.personal_quota - used('personal') },
    vacation: { quota: row.vacation_quota, used: used('vacation'), remain: row.vacation_quota - used('vacation') },
  };
}

/**
 * RUN RECONCILE for a period.
 * This is owner-triggered (e.g. "run for 2026-05" before payroll).
 */
function runReconcile(period) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('invalid_period');
  }
  const publicSs = getPublicSheet_();

  // Load all the data we need
  const employees = readTab_(publicSs, 'Employees').filter(e => e.status === 'active');
  const holidays = readTab_(publicSs, 'Holiday_Calendar');
  const schedules = readTab_(publicSs, 'Work_Schedule');
  const overrides = readTab_(publicSs, 'Schedule_Override');
  const leaves = readTab_(publicSs, 'Leave_Records').filter(l => l.status === 'approved');
  const otRequests = readTab_(publicSs, 'OT_Requests').filter(o => o.status === 'approved');
  const attendance = readTab_(publicSs, 'Attendance_Raw')
    .filter(a => periodOf_(a.date) === period);

  // STEP 2-3: build reconciled rows + escalations
  const reconciledRows = [];
  const escalations = [];

  employees.forEach(emp => {
    eachDateInPeriod_(period, date => {
      const dateStr = formatDate_(date);
      const result = _reconcileOneDay({
        empCode: emp.emp_code,
        dateStr,
        date,
        holidays, schedules, overrides,
        leaves: leaves.filter(l => l.emp_code === emp.emp_code),
        otRequests: otRequests.filter(o => o.emp_code === emp.emp_code),
        attendance: attendance.filter(a =>
          a.emp_code === emp.emp_code && formatDate_(a.date) === dateStr
        ),
      });
      reconciledRows.push(result.row);
      if (result.escalation) escalations.push(result.escalation);
    });
  });

  // Wipe and rewrite Attendance_Reconciled for this period
  _replacePeriodData(publicSs, 'Attendance_Reconciled', period, reconciledRows);

  // Append new escalations (but skip duplicates by emp+date+type)
  _addEscalations(publicSs, escalations);

  // STEP 4: Build Monthly_Summary
  const summary = _buildMonthlySummary(reconciledRows, period);
  _replacePeriodData(publicSs, 'Monthly_Summary', period, summary);

  logAudit({
    action: 'RUN_RECONCILE',
    target_type: 'period',
    target_id: period,
    after: {
      employees: employees.length,
      reconciled_rows: reconciledRows.length,
      escalations: escalations.length,
    },
  });

  return {
    period,
    employees: employees.length,
    reconciled_rows: reconciledRows.length,
    escalations: escalations.length,
    summary,
  };
}

/* ============================================================
 * Per-day reconciliation logic
 * ============================================================ */

const SHIFT_HOURS = 8;
const SHIFT_MINUTES = SHIFT_HOURS * 60;
// Tolerance for "did the employee actually work a full shift"
// 15 min slack so a 7h45m shift still counts as full work
const SHORT_WORK_THRESHOLD = SHIFT_MINUTES - 15;

function _reconcileOneDay({ empCode, dateStr, date, holidays, schedules, overrides,
                            leaves, otRequests, attendance }) {
  const dow = date.getDay();
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];

  const isPublicHoliday = isHoliday_(holidays, dateStr);
  const restInfo = isRestDay_(empCode, dateStr, schedules, overrides);
  const isRest = restInfo.isRest;

  const leaveRecord = leaves.find(l => formatDate_(l.date) === dateStr);
  const otReq = otRequests.find(o => formatDate_(o.date) === dateStr);
  const att = attendance[0];  // there should be at most 1 row per day per emp

  let status = 'absent';
  let leaveType = '';
  let workMinutes = 0;
  let ot1 = 0, ot2 = 0, ot3 = 0;
  let escalationFlag = false;
  let escalationReason = '';

  // === Branch 1: holiday ===
  if (isPublicHoliday) {
    status = 'holiday';
    if (att) {
      // working on a holiday — might be paid OT
      if (otReq) {
        // OT 2 = work on holiday at base rate (1x); OT 3 = beyond shift hours on holiday
        const minutes = att.total_minutes || 0;
        ot2 = Math.min(minutes, SHIFT_MINUTES);
        if (minutes > SHIFT_MINUTES) {
          ot3 = minutes - SHIFT_MINUTES;
        }
      } else {
        escalationFlag = true;
        escalationReason = 'ทำงานในวันหยุดประจำปี โดยไม่มีใบขอ OT';
      }
    }
  }
  // === Branch 2: scheduled rest day ===
  else if (isRest) {
    status = 'rest';
    if (att) {
      if (otReq) {
        const minutes = att.total_minutes || 0;
        ot2 = Math.min(minutes, SHIFT_MINUTES);
        if (minutes > SHIFT_MINUTES) {
          ot3 = minutes - SHIFT_MINUTES;
        }
      } else {
        escalationFlag = true;
        escalationReason = 'ทำงานในวันหยุดประจำสัปดาห์ โดยไม่มีใบขอ OT';
      }
    }
    // No fingerprint on rest day = expected, not a problem
  }
  // === Branch 3: regular work day ===
  else {
    if (leaveRecord) {
      status = 'on_leave';
      leaveType = leaveRecord.leave_type;
      // Note: quota check happens in _buildMonthlySummary
    } else if (att) {
      const minutes = att.total_minutes || 0;
      if (minutes >= SHORT_WORK_THRESHOLD) {
        status = 'working';
        workMinutes = SHIFT_MINUTES;
        // Check OT
        if (minutes > SHIFT_MINUTES) {
          const overtimeMin = minutes - SHIFT_MINUTES;
          if (otReq) {
            const reqMin = _otRequestMinutes(otReq);
            if (Math.abs(overtimeMin - reqMin) <= 15) {
              // OT matches (within 15 min)
              ot1 = overtimeMin;
            } else if (overtimeMin > reqMin) {
              ot1 = reqMin;  // pay only what was requested
              escalationFlag = true;
              escalationReason = `OT จริง ${Math.round(overtimeMin)} นาที มากกว่าใบขอ ${reqMin} นาที`;
            } else {
              ot1 = overtimeMin;  // pay only what was actually worked
              escalationFlag = true;
              escalationReason = `OT จริง ${Math.round(overtimeMin)} นาที น้อยกว่าใบขอ ${reqMin} นาที`;
            }
          } else {
            // No OT request — escalate, don't pay
            ot1 = 0;
            escalationFlag = true;
            escalationReason = `ทำงานเกินเวลา ${Math.round(overtimeMin)} นาที โดยไม่มีใบขอ OT`;
          }
        }
      } else {
        // Short work — escalate per Pui's request
        status = 'short_work';
        workMinutes = minutes;
        escalationFlag = true;
        escalationReason = `สแกนเข้า ${att.clock_in} ออก ${att.clock_out} ` +
                           `ทำงาน ${(minutes / 60).toFixed(1)} ชม. (ต่ำกว่า ${SHIFT_HOURS} ชม.)`;
      }
    } else {
      // No fingerprint, no leave → absent (default deny)
      status = 'absent';
      escalationFlag = true;
      escalationReason = 'ไม่มีสแกนนิ้ว ไม่มีใบลา';
    }
  }

  const row = {
    emp_code: empCode,
    date: dateStr,
    day_of_week: dayOfWeek,
    status,
    leave_type: leaveType,
    work_minutes: workMinutes,
    ot_1_minutes: Math.round(ot1),
    ot_2_minutes: Math.round(ot2),
    ot_3_minutes: Math.round(ot3),
    escalation_flag: escalationFlag ? 'TRUE' : 'FALSE',
    escalation_reason: escalationReason,
    reconciled_at: formatDatetime_(new Date()),
  };

  let escalation = null;
  if (escalationFlag) {
    escalation = {
      esc_id: generateId_('ESC') + '-' + empCode,
      emp_code: empCode,
      date: dateStr,
      type: _classifyEscalation(status, escalationReason),
      detail: escalationReason,
      created_at: formatDatetime_(new Date()),
      status: 'pending',
      resolved_by: '',
      resolved_at: '',
      resolution_note: '',
    };
  }

  return { row, escalation };
}

function _otRequestMinutes(req) {
  const start = timeToMinutes_(req.start_time);
  const end = timeToMinutes_(req.end_time);
  return Math.max(0, end - start);
}

function _classifyEscalation(status, reason) {
  if (status === 'short_work') return 'short_work';
  if (status === 'absent') return 'absent_no_evidence';
  if (reason.includes('ไม่มีใบขอ OT')) return 'ot_unrequested';
  if (reason.includes('OT จริง')) return 'ot_mismatch';
  return 'other';
}

/* ============================================================
 * Step 4: Monthly Summary
 * ============================================================ */

function _buildMonthlySummary(reconciledRows, period) {
  // Group by emp_code
  const byEmp = {};
  reconciledRows.forEach(r => {
    if (!byEmp[r.emp_code]) byEmp[r.emp_code] = [];
    byEmp[r.emp_code].push(r);
  });

  const publicSs = getPublicSheet_();
  const quotas = readTab_(publicSs, 'Leave_Quota');
  const leaves = readTab_(publicSs, 'Leave_Records').filter(l => l.status === 'approved');

  const summary = [];
  Object.keys(byEmp).forEach(empCode => {
    const rows = byEmp[empCode];
    const working = rows.filter(r => r.status === 'working').length;
    const short = rows.filter(r => r.status === 'short_work').length;
    const onLeave = rows.filter(r => r.status === 'on_leave').length;
    const absent = rows.filter(r => r.status === 'absent').length;
    const holiday = rows.filter(r => r.status === 'holiday' || r.status === 'rest').length;

    // Split leave into paid (within quota) vs unpaid (over quota)
    // Year-level quota check
    const year = Number(period.split('-')[0]);
    const quota = quotas.find(q => q.emp_code === empCode && Number(q.year) === year);
    const leavesThisEmp = leaves.filter(l =>
      l.emp_code === empCode &&
      new Date(l.date).getFullYear() === year
    );

    const usedByType = {};
    leavesThisEmp.forEach(l => {
      usedByType[l.leave_type] = (usedByType[l.leave_type] || 0) + 1;
    });

    let paidLeave = 0, unpaidLeave = 0;
    rows.filter(r => r.status === 'on_leave').forEach(r => {
      const type = r.leave_type;
      if (type === 'unpaid') {
        unpaidLeave++;
        return;
      }
      const used = usedByType[type] || 0;
      const total = quota ? Number(quota[type + '_quota'] || 0) : 0;
      // We're processing all leaves of this year; if this leave's index
      // falls within quota → paid; else unpaid.
      // Simplification: assume leaves processed chronologically, count from earliest.
      // For MVP, assume any leave of allowed type within the period is paid
      // unless cumulative-this-period would exceed. Refine in Phase 2.
      if (total > 0) paidLeave++;
      else unpaidLeave++;
    });

    const ot1Hours = rows.reduce((s, r) => s + Number(r.ot_1_minutes || 0), 0) / 60;
    const ot2Hours = rows.reduce((s, r) => s + Number(r.ot_2_minutes || 0), 0) / 60;
    const ot3Hours = rows.reduce((s, r) => s + Number(r.ot_3_minutes || 0), 0) / 60;

    const hasUnresolved = rows.some(r => r.escalation_flag === 'TRUE' || r.escalation_flag === true);

    summary.push({
      emp_code: empCode,
      period,
      working_days: working + short,  // counted, but flagged via has_unresolved
      short_days: short,
      paid_leave_days: paidLeave,
      unpaid_leave_days: unpaidLeave,
      absent_days: absent,
      holiday_days: holiday,
      ot_1_hours: Number(ot1Hours.toFixed(2)),
      ot_2_hours: Number(ot2Hours.toFixed(2)),
      ot_3_hours: Number(ot3Hours.toFixed(2)),
      has_unresolved: hasUnresolved ? 'TRUE' : 'FALSE',
      computed_at: formatDatetime_(new Date()),
      locked: 'FALSE',
    });
  });

  return summary;
}

/* ============================================================
 * Sheet write helpers (period-scoped)
 * ============================================================ */

function _replacePeriodData(spreadsheet, tabName, period, rows) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    // No data, just append
    appendRows_(spreadsheet, tabName, rows);
    return;
  }

  const headers = data[0];
  // Find the "period" or "date" column
  let dateColIdx = headers.indexOf('period');
  let isPeriod = true;
  if (dateColIdx < 0) {
    dateColIdx = headers.indexOf('date');
    isPeriod = false;
  }
  if (dateColIdx < 0) {
    throw new Error('No period or date column in ' + tabName);
  }

  // Filter out rows in this period
  const keepRows = [headers];
  for (let i = 1; i < data.length; i++) {
    const cell = data[i][dateColIdx];
    const cellPeriod = isPeriod ? String(cell) : periodOf_(cell);
    if (cellPeriod !== period) {
      keepRows.push(data[i]);
    }
  }

  // Rewrite the whole sheet
  sheet.clearContents();
  sheet.getRange(1, 1, keepRows.length, headers.length).setValues(keepRows);

  // Then append the new period rows
  if (rows.length > 0) appendRows_(spreadsheet, tabName, rows);
}

function _addEscalations(spreadsheet, escalations) {
  if (escalations.length === 0) return;
  const existing = readTab_(spreadsheet, 'Escalation_Queue');
  const existingKeys = new Set(
    existing.map(e => `${e.emp_code}|${formatDate_(e.date)}|${e.type}`)
  );
  const newOnes = escalations.filter(e => {
    const key = `${e.emp_code}|${e.date}|${e.type}`;
    return !existingKeys.has(key);
  });
  if (newOnes.length > 0) {
    appendRows_(spreadsheet, 'Escalation_Queue', newOnes);
  }
}

/* ============================================================
 * Owner-only: list & resolve escalations
 * ============================================================ */

function listEscalations(period) {
  const publicSs = getPublicSheet_();
  const all = readTab_(publicSs, 'Escalation_Queue');
  return all.filter(e =>
    (!period || periodOf_(e.date) === period) && e.status === 'pending'
  );
}

function resolveEscalation(escId, resolution, ctx) {
  const publicSs = getPublicSheet_();
  const sheet = publicSs.getSheetByName('Escalation_Queue');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('esc_id');
  const statusCol = headers.indexOf('status');
  const byCol = headers.indexOf('resolved_by');
  const atCol = headers.indexOf('resolved_at');
  const noteCol = headers.indexOf('resolution_note');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === escId) {
      sheet.getRange(i + 1, statusCol + 1).setValue(resolution.status || 'resolved');
      sheet.getRange(i + 1, byCol + 1).setValue(ctx.empCode);
      sheet.getRange(i + 1, atCol + 1).setValue(formatDatetime_(new Date()));
      sheet.getRange(i + 1, noteCol + 1).setValue(resolution.note || '');

      logAudit({
        action: 'RESOLVE_ESCALATION',
        target_type: 'escalation',
        target_id: escId,
        after: resolution,
      });
      return { ok: true };
    }
  }
  throw new Error('escalation_not_found');
}

/* ============================================================
 * Step 1: Ingest fingerprint CSV (called manually by owner)
 * ============================================================ */

/**
 * Import a CSV string into Attendance_Raw.
 * CSV format: emp_code,date,clock_in,clock_out,total_minutes,source
 *
 * @param {string} csv
 * @returns {{ imported: number, errors: string[] }}
 */
function importFingerprintCsv(csv) {
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',').map(s => s.trim());
  const requiredCols = ['emp_code', 'date', 'clock_in', 'clock_out'];
  for (const col of requiredCols) {
    if (!header.includes(col)) {
      throw new Error('Missing column: ' + col);
    }
  }

  const publicSs = getPublicSheet_();
  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(s => s.trim());
    if (cells.length < 4) continue;
    const obj = {};
    header.forEach((h, j) => { obj[h] = cells[j]; });
    obj.imported_at = formatDatetime_(new Date());
    if (!obj.total_minutes && obj.clock_in && obj.clock_out) {
      const start = timeToMinutes_(obj.clock_in);
      const end = timeToMinutes_(obj.clock_out);
      obj.total_minutes = Math.max(0, end - start);
    }
    rows.push(obj);
  }

  appendRows_(publicSs, 'Attendance_Raw', rows);
  logAudit({
    action: 'INGEST',
    target_type: 'attendance',
    target_id: 'fingerprint_csv',
    after: { rows: rows.length },
  });
  return { imported: rows.length, errors };
}
