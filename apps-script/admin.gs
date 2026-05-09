/**
 * admin.gs — HR / Owner CRUD handlers for sheet-edit-replacement LIFF UI.
 *
 * All functions in this file require role 'hr' or 'owner' in LINE_User_Map.
 * The Code.gs router calls _requireHrOrOwner_(ctx) before invoking these.
 *
 * Why a dedicated file: edits go through validation + audit log, instead of
 * raw sheet editing that's easy to corrupt. HR's daily workflow now lives in
 * hr.html, never opens the spreadsheet.
 */

/* ============================================================
 * Auth helper
 * ============================================================ */
function _isHrOrOwner_(userId) {
  if (!userId) return false;
  const map = readTab_(getSecretSheet_(), 'LINE_User_Map');
  const row = map.find(r => r.line_user_id === userId);
  if (!row) return false;
  const role = String(row.role || '').toLowerCase();
  return role === 'hr' || role === 'owner';
}

function _requireHrOrOwner_(ctx) {
  if (!_isHrOrOwner_(ctx && ctx.userId)) {
    throw new Error('forbidden_hr_only');
  }
}

/* ============================================================
 * Employees — HR can edit non-sensitive fields. Cannot create
 * (use onboard.html); cannot hard-delete (set status='resigned').
 * ============================================================ */
function hrListEmployees() {
  return readTab_(getPublicSheet_(), 'Employees').map(e => ({
    emp_code:    e.emp_code,
    first_name:  e.first_name || '',
    last_name:   e.last_name  || '',
    nickname:    e.nickname   || '',
    department:  e.department || '',
    position:    e.position   || '',
    status:      e.status     || '',
    start_date:  e.start_date || '',
    end_date:    e.end_date   || '',
    note:        e.note       || '',
  }));
}

function hrUpsertEmployee(payload) {
  if (!payload || !payload.emp_code) throw new Error('missing_emp_code');
  const sheet = getPublicSheet_().getSheetByName('Employees');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const codeCol = headers.indexOf('emp_code');
  const editable = ['first_name', 'last_name', 'nickname', 'department',
                    'position', 'status', 'end_date', 'note'];

  for (let i = 1; i < data.length; i++) {
    if (data[i][codeCol] === payload.emp_code) {
      editable.forEach(f => {
        const col = headers.indexOf(f);
        if (col >= 0 && payload[f] !== undefined) data[i][col] = payload[f];
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
      logAudit({
        action: 'HR_UPDATE_EMPLOYEE',
        target_type: 'employee',
        target_id: payload.emp_code,
        after: payload,
      });
      return { ok: true };
    }
  }
  throw new Error('employee_not_found');
}

/* ============================================================
 * Public_Allowances — HR managed
 * ============================================================ */
function hrListAllowances(payload) {
  const all = readTab_(getPublicSheet_(), 'Public_Allowances');
  if (payload && payload.period) {
    return all.filter(a => a.period === payload.period || a.period === '*');
  }
  return all;
}

function hrUpsertAllowance(payload) {
  _validateAllowance_(payload);
  const sheet = getPublicSheet_().getSheetByName('Public_Allowances');
  if (!sheet) throw new Error('tab_missing_run_migrate');

  if (payload.allowance_id) {
    return _updateRow_(sheet, 'allowance_id', payload.allowance_id,
      ['emp_code', 'period', 'direction', 'category', 'amount', 'note'],
      payload, 'HR_UPDATE_ALLOWANCE', 'allowance');
  }
  const id = generateId_('ALW');
  appendRows_(getPublicSheet_(), 'Public_Allowances', [{
    allowance_id: id,
    emp_code:  payload.emp_code,
    period:    payload.period,
    direction: payload.direction,
    category:  payload.category,
    amount:    Number(payload.amount),
    note:      payload.note || '',
    created_at: formatDatetime_(new Date()),
  }]);
  logAudit({
    action: 'HR_CREATE_ALLOWANCE',
    target_type: 'allowance',
    target_id: id,
    after: payload,
  });
  return { ok: true, allowance_id: id };
}

function hrDeleteAllowance(payload) {
  if (!payload || !payload.allowance_id) throw new Error('missing_allowance_id');
  return _deleteRow_(getPublicSheet_().getSheetByName('Public_Allowances'),
    'allowance_id', payload.allowance_id, 'HR_DELETE_ALLOWANCE', 'allowance');
}

function _validateAllowance_(p) {
  const required = ['emp_code', 'period', 'direction', 'category'];
  const missing = required.filter(k => !p || p[k] === undefined || p[k] === '');
  if (missing.length) throw new Error('missing_fields: ' + missing.join(','));
  const amt = Number(p.amount);
  if (!isFinite(amt) || amt < 0) throw new Error('invalid_amount');
  if (!['addition', 'deduction'].includes(p.direction)) throw new Error('invalid_direction');
  if (p.period !== '*' && !/^\d{4}-\d{2}$/.test(p.period)) throw new Error('invalid_period_format');
}

/* ============================================================
 * Recurring_Deductions — HR managed (Public Sheet)
 * ============================================================ */
function hrListRecurringDeductions() {
  // Public copy is authoritative; legacy Secret rows are still read by payroll
  // but won't appear here so HR can't accidentally delete the wrong copy.
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) return [];
  return readTab_(getPublicSheet_(), 'Recurring_Deductions');
}

function hrUpsertRecurringDeduction(payload) {
  _validateRecurringDeduction_(payload);
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) throw new Error('tab_missing_run_migrate');

  // Recurring_Deductions has no synthetic ID — composite key is
  // (emp_code, deduction_type, effective_from). For UI simplicity,
  // we treat (emp_code, deduction_type) as the upsert key per active row.
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const empCol  = headers.indexOf('emp_code');
  const typeCol = headers.indexOf('deduction_type');
  const efCol   = headers.indexOf('effective_from');

  // If the caller sent _row_index (1-based row in sheet), update that row exactly
  if (payload._row_index) {
    const idx = Number(payload._row_index);
    if (idx < 2 || idx > data.length) throw new Error('invalid_row_index');
    const fields = ['emp_code', 'deduction_type', 'amount', 'effective_from', 'effective_to', 'note'];
    fields.forEach(f => {
      const col = headers.indexOf(f);
      if (col >= 0 && payload[f] !== undefined) data[idx - 1][col] = payload[f];
    });
    sheet.getRange(idx, 1, 1, headers.length).setValues([data[idx - 1]]);
    logAudit({
      action: 'HR_UPDATE_RECURRING_DEDUCTION',
      target_type: 'recurring_deduction',
      target_id: `${payload.emp_code}|${payload.deduction_type}`,
      after: payload,
    });
    return { ok: true };
  }

  // Insert new
  appendRows_(getPublicSheet_(), 'Recurring_Deductions', [{
    emp_code:        payload.emp_code,
    deduction_type:  payload.deduction_type,
    amount:          Number(payload.amount),
    effective_from:  payload.effective_from,
    effective_to:    payload.effective_to || '',
    note:            payload.note || '',
  }]);
  logAudit({
    action: 'HR_CREATE_RECURRING_DEDUCTION',
    target_type: 'recurring_deduction',
    target_id: `${payload.emp_code}|${payload.deduction_type}`,
    after: payload,
  });
  return { ok: true };
}

function hrDeleteRecurringDeduction(payload) {
  if (!payload || !payload._row_index) throw new Error('missing_row_index');
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) throw new Error('tab_missing_run_migrate');
  const idx = Number(payload._row_index);
  if (idx < 2) throw new Error('invalid_row_index');
  // Snapshot for audit before deleting
  const before = sheet.getRange(idx, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.deleteRow(idx);
  logAudit({
    action: 'HR_DELETE_RECURRING_DEDUCTION',
    target_type: 'recurring_deduction',
    target_id: `row_${idx}`,
    before: before.join('|'),
  });
  return { ok: true };
}

function _validateRecurringDeduction_(p) {
  const required = ['emp_code', 'deduction_type', 'amount', 'effective_from'];
  const missing = required.filter(k => !p || p[k] === undefined || p[k] === '');
  if (missing.length) throw new Error('missing_fields: ' + missing.join(','));
  const amt = Number(p.amount);
  if (!isFinite(amt) || amt < 0) throw new Error('invalid_amount');
  if (!['pf', 'sso', 'studentloan', 'companyloan', 'other'].includes(p.deduction_type)) {
    throw new Error('invalid_deduction_type');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effective_from)) throw new Error('invalid_effective_from');
  if (p.effective_to && !/^\d{4}-\d{2}-\d{2}$/.test(p.effective_to)) throw new Error('invalid_effective_to');
}

/* ============================================================
 * Holiday_Calendar — HR managed
 * ============================================================ */
function hrListHolidays() {
  return readTab_(getPublicSheet_(), 'Holiday_Calendar');
}

function hrUpsertHoliday(payload) {
  if (!payload || !payload.date || !payload.name) throw new Error('missing_fields');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) throw new Error('invalid_date');
  const sheet = getPublicSheet_().getSheetByName('Holiday_Calendar');
  if (!sheet) throw new Error('tab_missing_run_migrate');

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');

  // Use date as natural key
  for (let i = 1; i < data.length; i++) {
    if (formatDate_(data[i][dateCol]) === payload.date) {
      const fields = ['name', 'type', 'applies_to'];
      fields.forEach(f => {
        const col = headers.indexOf(f);
        if (col >= 0 && payload[f] !== undefined) data[i][col] = payload[f];
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
      logAudit({ action: 'HR_UPDATE_HOLIDAY', target_type: 'holiday', target_id: payload.date, after: payload });
      return { ok: true };
    }
  }
  appendRows_(getPublicSheet_(), 'Holiday_Calendar', [{
    date:       payload.date,
    name:       payload.name,
    type:       payload.type || 'public',
    applies_to: payload.applies_to || 'all',
  }]);
  logAudit({ action: 'HR_CREATE_HOLIDAY', target_type: 'holiday', target_id: payload.date, after: payload });
  return { ok: true };
}

function hrDeleteHoliday(payload) {
  if (!payload || !payload.date) throw new Error('missing_date');
  const sheet = getPublicSheet_().getSheetByName('Holiday_Calendar');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');
  for (let i = 1; i < data.length; i++) {
    if (formatDate_(data[i][dateCol]) === payload.date) {
      sheet.deleteRow(i + 1);
      logAudit({ action: 'HR_DELETE_HOLIDAY', target_type: 'holiday', target_id: payload.date });
      return { ok: true };
    }
  }
  throw new Error('holiday_not_found');
}

/* ============================================================
 * Leave_Quota — HR managed
 * One row per (emp_code, year). Upsert merges, never deletes.
 * ============================================================ */
function hrListLeaveQuota(payload) {
  const all = readTab_(getPublicSheet_(), 'Leave_Quota');
  if (payload && payload.year) return all.filter(q => Number(q.year) === Number(payload.year));
  return all;
}

function hrUpsertLeaveQuota(payload) {
  if (!payload || !payload.emp_code || !payload.year) throw new Error('missing_fields');
  const year = Number(payload.year);
  if (year < 2020 || year > 2100) throw new Error('invalid_year');

  const sheet = getPublicSheet_().getSheetByName('Leave_Quota');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const empCol  = headers.indexOf('emp_code');
  const yearCol = headers.indexOf('year');

  const updatable = ['sick_quota', 'personal_quota', 'vacation_quota'];

  for (let i = 1; i < data.length; i++) {
    if (data[i][empCol] === payload.emp_code && Number(data[i][yearCol]) === year) {
      updatable.forEach(f => {
        const col = headers.indexOf(f);
        if (col >= 0 && payload[f] !== undefined) data[i][col] = Number(payload[f]);
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
      logAudit({
        action: 'HR_UPDATE_QUOTA',
        target_type: 'leave_quota',
        target_id: `${payload.emp_code}|${year}`,
        after: payload,
      });
      return { ok: true };
    }
  }
  appendRows_(getPublicSheet_(), 'Leave_Quota', [{
    emp_code:       payload.emp_code,
    year:           year,
    sick_quota:     Number(payload.sick_quota)     || 0,
    sick_used:      0,
    personal_quota: Number(payload.personal_quota) || 0,
    personal_used:  0,
    vacation_quota: Number(payload.vacation_quota) || 0,
    vacation_used:  0,
  }]);
  logAudit({
    action: 'HR_CREATE_QUOTA',
    target_type: 'leave_quota',
    target_id: `${payload.emp_code}|${year}`,
    after: payload,
  });
  return { ok: true };
}

/* ============================================================
 * Generic helpers
 * ============================================================ */
function _updateRow_(sheet, idColName, idValue, editableFields, payload, auditAction, targetType) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf(idColName);
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === idValue) {
      editableFields.forEach(f => {
        const col = headers.indexOf(f);
        if (col >= 0 && payload[f] !== undefined) data[i][col] = payload[f];
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
      logAudit({ action: auditAction, target_type: targetType, target_id: idValue, after: payload });
      return { ok: true, [idColName]: idValue };
    }
  }
  throw new Error(targetType + '_not_found');
}

function _deleteRow_(sheet, idColName, idValue, auditAction, targetType) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf(idColName);
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === idValue) {
      sheet.deleteRow(i + 1);
      logAudit({ action: auditAction, target_type: targetType, target_id: idValue });
      return { ok: true };
    }
  }
  throw new Error(targetType + '_not_found');
}
