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
 * @param {string} [payload.evidence_type] — none | medical_cert | appointment | receipt | photo | chat_screenshot | other
 * @param {boolean} [payload.evidence_pending] — true if employee will submit evidence later
 * @param {string} [payload.duration_unit] — full_day (default) | half_day | hour
 * @param {string} [payload.half_day_period] — morning | afternoon (required when duration_unit=half_day)
 * @param {string} [payload.hour_start] — HH:mm (required when duration_unit=hour)
 * @param {string} [payload.hour_end] — HH:mm (required when duration_unit=hour)
 * @param {boolean} [payload.is_emergency] — set true when employee acknowledges advance-notice rule is bypassed
 */
function submitLeave(payload, ctx) {
  const { start_date, end_date, leave_type, reason, evidence_url } = payload;
  const evidenceType = payload.evidence_type || 'none';
  const evidencePending = evidenceType !== 'none' && !!payload.evidence_pending;
  const durationUnit = payload.duration_unit || 'full_day';
  const halfDayPeriod = durationUnit === 'half_day' ? (payload.half_day_period || '') : '';
  const hourStart = durationUnit === 'hour' ? String(payload.hour_start || '') : '';
  const hourEnd   = durationUnit === 'hour' ? String(payload.hour_end   || '') : '';
  if (!start_date || !end_date || !leave_type) {
    throw new Error('missing_fields');
  }
  if (!reason || String(reason).trim().length < 3) {
    throw new Error('reason_required');
  }
  if (!['full_day', 'half_day', 'hour'].includes(durationUnit)) {
    throw new Error('invalid_duration_unit');
  }
  if (durationUnit === 'half_day' && !['morning', 'afternoon'].includes(halfDayPeriod)) {
    throw new Error('half_day_period_required');
  }
  if (durationUnit === 'hour') {
    if (!_isHHmm_(hourStart) || !_isHHmm_(hourEnd)) throw new Error('hour_format_invalid');
    if (_minutesOf_(hourEnd) <= _minutesOf_(hourStart)) throw new Error('hour_end_must_be_after_start');
  }
  if (durationUnit !== 'full_day' && start_date !== end_date) {
    throw new Error('half_or_hour_must_be_single_day');
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

  // === Days-equivalent per row ===
  // full_day = 1.0; half_day = 0.5; hour = (end - start)/60/8
  const perRowDaysEquivalent =
    durationUnit === 'full_day' ? 1.0 :
    durationUnit === 'half_day' ? 0.5 :
    Math.round(((_minutesOf_(hourEnd) - _minutesOf_(hourStart)) / 60 / 8) * 1000) / 1000;
  const totalDaysEquivalent = perRowDaysEquivalent * dates.length;

  // === Advance notice + emergency check ===
  const emergencyDecision = _evaluateEmergency_({
    leave_type,
    durationUnit,
    halfDayPeriod,
    hourStart,
    startDate: start_date,
    payloadIsEmergency: !!payload.is_emergency,
    now: new Date(),
  });
  if (emergencyDecision.reject) {
    throw new Error(emergencyDecision.error);
  }
  const isEmergency = emergencyDecision.isEmergency;

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
  // Use ceil(total days_equivalent) so half/hour leaves count as 1 day for rule lookup
  const days = Math.max(1, Math.ceil(totalDaysEquivalent));
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
    evidence_url: evidencePending ? '' : (evidence_url || ''),
    evidence_type: evidenceType,
    evidence_pending: evidencePending ? 'TRUE' : 'FALSE',
    duration_unit: durationUnit,
    half_day_period: halfDayPeriod,
    hour_start: hourStart,
    hour_end: hourEnd,
    days_equivalent: perRowDaysEquivalent,
    is_emergency: isEmergency ? 'TRUE' : 'FALSE',
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
      isEmergency,
      durationUnit,
      halfDayPeriod,
      hourStart,
      hourEnd,
      daysEquivalent: perRowDaysEquivalent,
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

/* ============================================================
 * Read-only fetch for respond.html — returns the leave summary
 * + which mode is currently expected (info | evidence).
 * ============================================================ */
function getLeaveForRespond(payload, ctx) {
  const { leave_id } = payload;
  if (!leave_id) throw new Error('missing_leave_id');
  const records = readTab_(getPublicSheet_(), 'Leave_Records');
  const row = records.find(r => r.leave_id === leave_id);
  if (!row) throw new Error('record_not_found');
  if (row.emp_code !== ctx.empCode) throw new Error('not_your_leave');

  const groupRows = records.filter(r => r.request_group_id === row.request_group_id);
  const dates = groupRows.map(r => formatDate_(r.date)).sort();

  return {
    leave_id: row.leave_id,
    leave_type: row.leave_type,
    reason: row.reason,
    start_date: dates[0],
    end_date: dates[dates.length - 1],
    days: groupRows.length,
    status: row.status,
    info_request_status: row.info_request_status || 'none',
    info_request_message: row.info_request_message || '',
    info_request_count: Number(row.info_request_count) || 0,
    conditional_evidence_required: String(row.conditional_evidence_required).toUpperCase() === 'TRUE',
    conditional_evidence_deadline: row.conditional_evidence_deadline || '',
    conditional_evidence_received_at: row.conditional_evidence_received_at || '',
    evidence_url: row.evidence_url || '',
    evidence_type: row.evidence_type || 'none',
  };
}

/* ============================================================
 * PR-3.1 — Employee responds to an info request via LIFF
 * Body: { leave_id, response, evidence_url?, evidence_type? }
 * ============================================================ */
function respondInfoRequest(payload, ctx) {
  const { leave_id, response } = payload;
  if (!leave_id || !response || String(response).trim().length < 2) {
    throw new Error('missing_response');
  }

  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol         = headers.indexOf('leave_id');
  const groupCol      = headers.indexOf('request_group_id');
  const empCol        = headers.indexOf('emp_code');
  const statusInfoCol = headers.indexOf('info_request_status');
  const responseCol   = headers.indexOf('info_request_response');
  const evidenceCol   = headers.indexOf('evidence_url');
  const evTypeCol     = headers.indexOf('evidence_type');
  const dateCol       = headers.indexOf('date');
  const reasonCol     = headers.indexOf('reason');
  const requiredCol   = headers.indexOf('required_levels');
  const statusCol     = headers.indexOf('status');

  let firstRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === leave_id) { firstRow = i; break; }
  }
  if (firstRow === null) throw new Error('record_not_found');
  if (data[firstRow][empCol] !== ctx.empCode) throw new Error('not_your_leave');
  if (data[firstRow][statusInfoCol] !== 'pending') throw new Error('no_pending_info_request');

  const groupId = data[firstRow][groupCol];
  const targetRows = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][groupCol] === groupId) targetRows.push(i);
  }

  targetRows.forEach(idx => {
    data[idx][statusInfoCol] = 'responded';
    data[idx][responseCol]   = String(response).trim();
    if (payload.evidence_url) data[idx][evidenceCol] = String(payload.evidence_url).trim();
    if (payload.evidence_type) data[idx][evTypeCol]  = String(payload.evidence_type).trim();
    sheet.getRange(idx + 1, 1, 1, data[idx].length).setValues([data[idx]]);
  });

  // Send updated Flex back to the level approver who's waiting
  const m = String(data[firstRow][statusCol]).match(/^pending_L(\d)$/);
  const level = m ? Number(m[1]) : 1;
  const approver = data[firstRow][headers.indexOf(`level_${level}_approver`)];
  const stats = _getLeaveStatsThisYear_(ctx.empCode);
  const emp = _getEmployeeRow_(ctx.empCode);
  const dates = targetRows.map(idx => formatDate_(data[idx][dateCol])).sort();
  const dateLabel = dates.length === 1 ? dates[0] : `${dates[0]} ถึง ${dates[dates.length-1]} (${dates.length} วัน)`;
  sendApprovalFlex(approver, {
    id: leave_id,
    level,
    isLeave: true,
    empCode: ctx.empCode,
    firstName: emp ? emp.first_name : '',
    lastName:  emp ? emp.last_name  : '',
    department: emp ? emp.department : '',
    position:   emp ? emp.position   : '',
    date: dateLabel,
    leaveType: data[firstRow][headers.indexOf('leave_type')],
    reason: data[firstRow][reasonCol] || '-',
    requiredLevels: Number(data[firstRow][requiredCol]) || 1,
    isBackdated: String(data[firstRow][headers.indexOf('is_backdated')]).toUpperCase() === 'TRUE',
    isEmergency: String(data[firstRow][headers.indexOf('is_emergency')]).toUpperCase() === 'TRUE',
    durationUnit: data[firstRow][headers.indexOf('duration_unit')] || 'full_day',
    halfDayPeriod: data[firstRow][headers.indexOf('half_day_period')] || '',
    hourStart: data[firstRow][headers.indexOf('hour_start')] || '',
    hourEnd:   data[firstRow][headers.indexOf('hour_end')]   || '',
    daysEquivalent: Number(data[firstRow][headers.indexOf('days_equivalent')]) || null,
    stats,
    infoRequestCount: Number(data[firstRow][headers.indexOf('info_request_count')]) || 1,
    infoRequestResponse: String(response).trim(),
  });

  logAudit({
    action: 'INFO_REQUEST_RESPONSE',
    target_type: 'leave',
    target_id: groupId,
    actor_email: ctx.empCode,
    after: { round: data[firstRow][headers.indexOf('info_request_count')] },
  });

  return { ok: true };
}

/* ============================================================
 * PR-3.2 — Employee submits conditional evidence via LIFF
 * Body: { leave_id, evidence_url, evidence_type? }
 * ============================================================ */
function submitConditionalEvidence(payload, ctx) {
  const { leave_id, evidence_url } = payload;
  if (!leave_id || !evidence_url || !/^https?:\/\//i.test(String(evidence_url))) {
    throw new Error('valid_url_required');
  }

  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol      = headers.indexOf('leave_id');
  const groupCol   = headers.indexOf('request_group_id');
  const empCol     = headers.indexOf('emp_code');
  const reqCol     = headers.indexOf('conditional_evidence_required');
  const recvCol    = headers.indexOf('conditional_evidence_received_at');
  const flagCol    = headers.indexOf('flag_compliance_issue');
  const evidenceCol= headers.indexOf('evidence_url');
  const evTypeCol  = headers.indexOf('evidence_type');

  let firstRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === leave_id) { firstRow = i; break; }
  }
  if (firstRow === null) throw new Error('record_not_found');
  if (data[firstRow][empCol] !== ctx.empCode) throw new Error('not_your_leave');
  if (String(data[firstRow][reqCol]).toUpperCase() !== 'TRUE') {
    throw new Error('no_conditional_evidence_required');
  }

  const groupId = data[firstRow][groupCol];
  const now = formatDatetime_(new Date());
  for (let i = 1; i < data.length; i++) {
    if (data[i][groupCol] !== groupId) continue;
    data[i][recvCol] = now;
    data[i][flagCol] = 'FALSE';
    data[i][evidenceCol] = String(evidence_url).trim();
    if (payload.evidence_type) data[i][evTypeCol] = String(payload.evidence_type).trim();
    sheet.getRange(i + 1, 1, 1, data[i].length).setValues([data[i]]);
  }

  logAudit({
    action: 'CONDITIONAL_EVIDENCE_SUBMITTED',
    target_type: 'leave',
    target_id: groupId,
    actor_email: ctx.empCode,
    after: { url: evidence_url },
  });

  return { ok: true };
}

// HH:mm parse helpers — used by half/hour leave mode
function _isHHmm_(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
}
function _minutesOf_(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Decide whether a leave submission is on time, requires emergency mode,
 * or must be rejected outright.
 *
 * - sick: needs LEAVE_SICK_MIN_ADVANCE_HOURS hours before work-start time
 *   (work-start: 09:00 full/morning, 13:00 afternoon, hour_start for hour mode)
 * - personal: needs LEAVE_PERSONAL_MIN_ADVANCE_DAYS days before start_date
 * - vacation/unpaid/maternity: needs same days as personal — NO emergency override
 *
 * Returns { isEmergency, reject, error }.
 */
function _evaluateEmergency_({ leave_type, durationUnit, halfDayPeriod, hourStart, startDate, payloadIsEmergency, now }) {
  const sickAdvanceHours = Number(getSetting_('LEAVE_SICK_MIN_ADVANCE_HOURS', 1));
  const personalAdvanceDays = Number(getSetting_('LEAVE_PERSONAL_MIN_ADVANCE_DAYS', 3));

  let meetsAdvance;
  if (leave_type === 'sick') {
    // Compute the moment work would start for this leave
    const workStartHHmm =
      durationUnit === 'hour' ? hourStart :
      durationUnit === 'half_day' && halfDayPeriod === 'afternoon' ? '13:00' :
      '09:00';
    const [h, m] = workStartHHmm.split(':').map(Number);
    const startDt = new Date(startDate + 'T00:00:00');
    startDt.setHours(h, m, 0, 0);
    const diffMs = startDt.getTime() - now.getTime();
    meetsAdvance = diffMs >= sickAdvanceHours * 3600 * 1000;
  } else {
    // Day-level rule for personal/vacation/unpaid/maternity
    const startMidnight = new Date(startDate + 'T00:00:00');
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = (startMidnight.getTime() - todayMidnight.getTime()) / (24 * 3600 * 1000);
    meetsAdvance = diffDays >= personalAdvanceDays;
  }

  if (meetsAdvance) {
    return { isEmergency: false, reject: false };
  }

  const canBeEmergency = leave_type === 'sick' || leave_type === 'personal';
  if (!canBeEmergency) {
    return { reject: true, error: 'advance_notice_required' };
  }
  if (!payloadIsEmergency) {
    return { reject: true, error: 'advance_notice_required' };
  }
  return { isEmergency: true, reject: false };
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
  if (!reason || String(reason).trim().length < 3) {
    throw new Error('reason_required');
  }

  // Overnight support: end_date defaults to date. If client didn't send end_date
  // but end_time < start_time, infer end_date = date + 1 (overnight).
  let end_date = payload.end_date || date;
  if (!payload.end_date) {
    const startMin = timeToMinutes_(start_time);
    const endMin = timeToMinutes_(end_time);
    if (endMin <= startMin) {
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      end_date = formatDate_(next);
    }
  }

  // Validate using full datetimes — overnight is now valid because end_date may differ.
  const startDt = new Date(`${date}T${start_time}:00`);
  const endDt   = new Date(`${end_date}T${end_time}:00`);
  const dur = (endDt.getTime() - startDt.getTime()) / 60000;
  if (dur <= 0) throw new Error('invalid_time_range');
  if (dur > 24 * 60) throw new Error('ot_too_long_max_24h');

  // Cutoff check (lenient by default — flag, not reject)
  const cutoffCheck = checkBackdated(date);
  let isBackdated = false;
  if (cutoffCheck.isBackdated) {
    if (cutoffCheck.mode === 'strict') {
      const ownerOverride = String(getSetting_('BACKDATED_REQUIRES_OWNER', 'true')).toLowerCase() === 'true';
      if (ownerOverride && ctx.empCode !== 'OWNER') {
        throw new Error('backdated_rejected: ' + cutoffCheck.reason);
      }
    }
    isBackdated = true;
  }

  // OT uses single-level approval (L1 only).
  const chain = getApprovalChain(ctx.empCode);
  if (!chain.l1) throw new Error('no_l1_approver_configured');

  const publicSs = getPublicSheet_();
  const otId = generateId_('OT');
  appendRows_(publicSs, 'OT_Requests', [{
    ot_id: otId,
    emp_code: ctx.empCode,
    date,
    end_date,
    start_time,
    end_time,
    ot_type,
    reason: String(reason).trim(),
    submitted_at: formatDatetime_(new Date()),
    status: 'pending_L1',
    level_1_approver: chain.l1,
    level_1_at: '',
    final_approved_at: '',
    is_backdated: isBackdated ? 'TRUE' : 'FALSE',
  }]);

  logAudit({
    action: 'SUBMIT_OT',
    target_type: 'ot_request',
    target_id: otId,
    after: { date, start_time, end_time, ot_type, is_backdated: isBackdated },
  });

  // Notify L1 approver via Flex
  try {
    const emp = _getEmployeeRow_(ctx.empCode);
    // Pull rate + base from Salary_Master so the Flex (when sent to OWNER)
    // can show hourly rate, hours, and total OT pay at a glance.
    const salary = _otSalaryInfo_(ctx.empCode, date, ot_type, start_time, end_time, end_date);
    sendApprovalFlex(chain.l1, {
      id: otId,
      level: 1,
      isLeave: false,
      empCode: ctx.empCode,
      firstName: emp ? emp.first_name : '',
      lastName:  emp ? emp.last_name  : '',
      department: emp ? emp.department : '',
      position:   emp ? emp.position   : '',
      date,
      endDate: end_date,
      otType: ot_type,
      startTime: start_time,
      endTime:   end_time,
      reason: String(reason).trim(),
      requiredLevels: 1,
      isBackdated,
      salary,
    });
  } catch (e) {
    console.error('notify L1 approver (OT) failed: ' + e);
  }

  return { ot_id: otId, is_backdated: isBackdated };
}

/**
 * Resolve the OT-relevant slice of Salary_Master for one request.
 * Returns null if no active salary record so the Flex skips the money rows.
 */
function _otSalaryInfo_(empCode, date, otType, startTime, endTime, endDate) {
  try {
    const sal = findActiveRecord_(
      readTab_(getSecretSheet_(), 'Salary_Master'), empCode, date);
    if (!sal) return null;
    const hours = _otHoursOf_(startTime, endTime, date, endDate);
    let otRate = 0;
    switch (otType) {
      case 'rest':    otRate = Number(sal.ot_2_rate) || 0; break;
      case 'holiday': otRate = Number(sal.ot_3_rate) || 0; break;
      default:        otRate = Number(sal.ot_1_rate) || 0;
    }
    return {
      baseSalary: Number(sal.base_salary) || 0,
      dailyRate:  Number(sal.daily_rate)  || 0,
      hourlyRate: Number(sal.hourly_rate) || 0,
      otRate,
      otHours: hours,
      otAmount: Math.round(otRate * hours * 100) / 100,
    };
  } catch (e) {
    console.error('_otSalaryInfo_ failed: ' + e);
    return null;
  }
}

function _otHoursOf_(startTime, endTime, startDate, endDate) {
  const parse = s => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const s = parse(startTime);
  const e = parse(endTime);
  if (s < 0 || e < 0) return 0;
  const overnight = endDate && startDate && endDate !== startDate;
  const minutes = overnight ? (24 * 60 - s + e) : (e - s);
  return Math.max(0, minutes / 60);
}

/**
 * Recent leave records for one employee, newest first.
 *
 * Aggregates per request_group_id (multi-day leaves collapse to one entry)
 * so the UI shows distinct submissions, not one row per day.
 */
function getMyHistory(empCode, limit) {
  limit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const records = readTab_(getPublicSheet_(), 'Leave_Records')
    .filter(r => r.emp_code === empCode);

  // Group by request_group_id (or by leave_id if no group)
  const groups = {};
  records.forEach(r => {
    const k = r.request_group_id || r.leave_id;
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  });

  const items = Object.keys(groups).map(k => {
    const rs = groups[k];
    rs.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
    const first = rs[0];
    const last = rs[rs.length - 1];
    return {
      group_id: k,
      leave_type: first.leave_type,
      reason: first.reason || '',
      status: first.status,
      submitted_at: first.submitted_at,
      start_date: formatDate_(first.date),
      end_date: formatDate_(last.date),
      days: rs.length,
      is_backdated: String(first.is_backdated).toUpperCase() === 'TRUE',
    };
  });

  // Newest submitted first
  items.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  return items.slice(0, limit);
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
    .filter(a => periodOf_(a.date) === period)
    // selfie rows rejected by Owner don't count as attendance — treat as if never punched
    .filter(a => !(a.source === 'selfie' && a.approval_status === 'rejected'));

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

/**
 * Run reconcile then push a Flex summary to the given owner.
 * Defaults to the previous month if no period given (current month isn't closed yet).
 */
function runReconcileWithSummary(period, ownerUserId) {
  if (!period) {
    const today = new Date();
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    period = Utilities.formatDate(prev, 'GMT+7', 'yyyy-MM');
  }
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('invalid_period');

  const result = runReconcile(period);

  // Aggregate open escalations for the period
  const escs = readTab_(getPublicSheet_(), 'Escalation_Queue')
    .filter(e => formatDate_(e.date).startsWith(period))
    .filter(e => String(e.status || 'open') === 'open');

  const byType = {};
  const byEmp = {};
  escs.forEach(e => {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byEmp[e.emp_code] = (byEmp[e.emp_code] || 0) + 1;
  });

  const empMap = {};
  readTab_(getPublicSheet_(), 'Employees').forEach(e => empMap[e.emp_code] = e);
  const topEmployees = Object.entries(byEmp)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => {
      const e = empMap[code];
      return {
        emp_code: code,
        name: e ? `${e.first_name} ${e.last_name}`.trim() : code,
        count,
      };
    });

  const summary = {
    period,
    employees: result.employees,
    reconciledRows: result.reconciled_rows,
    openEscalations: escs.length,
    byType,
    topEmployees,
  };

  if (ownerUserId) {
    try { sendReconcileSummaryFlex(ownerUserId, summary); }
    catch (e) { console.error('summary flex failed: ' + e); }
  }

  return summary;
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
