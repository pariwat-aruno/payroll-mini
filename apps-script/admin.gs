/**
 * admin.gs — HR / Owner CRUD with Owner-approval routing.
 *
 * Policy (since v2.1):
 *   HR edits → queued in Pending_Approvals → Owner gets Flex →
 *   on Approve, _applyChange_ runs the same write that would have happened.
 *   Owner edits go through the same handlers but apply directly (skip the queue).
 *
 * Auth:
 *   _requireHrOrOwner_(ctx) — opens the door
 *   _isOwnerCtx_(ctx)       — direct-apply vs. queue
 */

/* ============================================================
 * Auth + role helpers
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
  if (!_isHrOrOwner_(ctx && ctx.userId)) throw new Error('forbidden_hr_only');
}

function _isOwnerCtx_(ctx) {
  if (!ctx) return false;
  if (ctx.empCode === 'OWNER') return true;
  const map = readTab_(getSecretSheet_(), 'LINE_User_Map');
  const r = map.find(m => m.line_user_id === ctx.userId);
  return !!(r && String(r.role).toLowerCase() === 'owner');
}

/* ============================================================
 * Public entrypoints — call validators, then route.
 * Each entity has _validate, _apply, _summary, _label
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

function hrUpsertEmployee(payload, ctx) {
  if (!payload || !payload.emp_code) throw new Error('missing_emp_code');
  return _routeChange_('employee', 'update', payload.emp_code, payload,
    _summarizeEmployeeUpdate_(payload), ctx);
}

/* === Allowances === */
function hrListAllowances(payload) {
  const all = readTab_(getPublicSheet_(), 'Public_Allowances');
  if (payload && payload.period) {
    return all.filter(a => a.period === payload.period || a.period === '*');
  }
  return all;
}

function hrUpsertAllowance(payload, ctx) {
  _validateAllowance_(payload);
  const op = payload.allowance_id ? 'update' : 'create';
  return _routeChange_('allowance', op, payload.allowance_id || '',
    payload, _summarizeAllowance_(payload), ctx);
}

function hrDeleteAllowance(payload, ctx) {
  if (!payload || !payload.allowance_id) throw new Error('missing_allowance_id');
  return _routeChange_('allowance', 'delete', payload.allowance_id,
    payload, `ลบรายการ ${payload.allowance_id}`, ctx);
}

/* === Recurring Deductions === */
function hrListRecurringDeductions() {
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) return [];
  return readTab_(getPublicSheet_(), 'Recurring_Deductions');
}

function hrUpsertRecurringDeduction(payload, ctx) {
  _validateRecurringDeduction_(payload);
  const op = payload._row_index ? 'update' : 'create';
  return _routeChange_('recurring_deduction', op,
    `${payload.emp_code}|${payload.deduction_type}`,
    payload, _summarizeRecurringDeduction_(payload, op), ctx);
}

function hrDeleteRecurringDeduction(payload, ctx) {
  if (!payload || !payload._row_index) throw new Error('missing_row_index');
  return _routeChange_('recurring_deduction', 'delete',
    `row_${payload._row_index}`, payload,
    `ลบหักประจำ row ${payload._row_index}`, ctx);
}

/* === Holidays === */
function hrListHolidays() {
  return readTab_(getPublicSheet_(), 'Holiday_Calendar');
}

function hrUpsertHoliday(payload, ctx) {
  if (!payload || !payload.date || !payload.name) throw new Error('missing_fields');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) throw new Error('invalid_date');
  // Decide create vs update by whether the date already exists
  const existing = readTab_(getPublicSheet_(), 'Holiday_Calendar')
    .some(h => formatDate_(h.date) === payload.date);
  const op = existing ? 'update' : 'create';
  return _routeChange_('holiday', op, payload.date, payload,
    `${op === 'create' ? 'เพิ่ม' : 'แก้'}วันหยุด ${payload.date} (${payload.name})`, ctx);
}

function hrDeleteHoliday(payload, ctx) {
  if (!payload || !payload.date) throw new Error('missing_date');
  return _routeChange_('holiday', 'delete', payload.date, payload,
    `ลบวันหยุด ${payload.date}`, ctx);
}

/* === Leave Quota === */
function hrListLeaveQuota(payload) {
  const all = readTab_(getPublicSheet_(), 'Leave_Quota');
  if (payload && payload.year) return all.filter(q => Number(q.year) === Number(payload.year));
  return all;
}

function hrUpsertLeaveQuota(payload, ctx) {
  if (!payload || !payload.emp_code || !payload.year) throw new Error('missing_fields');
  const year = Number(payload.year);
  if (year < 2020 || year > 2100) throw new Error('invalid_year');
  payload.year = year;
  // Decide create/update by checking existing
  const existing = readTab_(getPublicSheet_(), 'Leave_Quota')
    .some(q => q.emp_code === payload.emp_code && Number(q.year) === year);
  const op = existing ? 'update' : 'create';
  return _routeChange_('leave_quota', op, `${payload.emp_code}|${year}`,
    payload, _summarizeLeaveQuota_(payload, op), ctx);
}

/* ============================================================
 * Routing — Owner direct-apply vs HR queue
 * ============================================================ */
function _routeChange_(actionType, actionOp, targetId, payload, summary, ctx) {
  if (_isOwnerCtx_(ctx)) {
    // Owner: skip queue, apply immediately
    const result = _applyChange_(actionType, actionOp, payload, ctx);
    logAudit({
      action: 'OWNER_DIRECT_' + actionType.toUpperCase() + '_' + actionOp.toUpperCase(),
      target_type: actionType,
      target_id: targetId,
      actor_email: ctx.userId,
      after: payload,
    });
    return result;
  }
  // HR: queue + notify owner
  const changeId = generateId_('PC');
  appendRows_(getPublicSheet_(), 'Pending_Approvals', [{
    change_id: changeId,
    action_type: actionType,
    action_op:   actionOp,
    target_id:   targetId,
    payload_json: JSON.stringify(payload || {}),
    summary,
    submitted_by: ctx.empCode,
    submitted_at: formatDatetime_(new Date()),
    status: 'pending',
    decided_by: '',
    decided_at: '',
    decision_notes: '',
  }]);

  logAudit({
    action: 'HR_QUEUE_CHANGE',
    target_type: actionType,
    target_id: changeId,
    actor_email: ctx.empCode,
    after: { action_op: actionOp, summary },
  });

  // Notify all owners via Flex
  try {
    _notifyOwnersOfPendingChange_({
      change_id: changeId,
      action_type: actionType,
      action_op:   actionOp,
      summary,
      submitted_by: ctx.empCode,
    });
  } catch (e) {
    console.error('notify owners failed: ' + e);
  }

  return { ok: true, queued: true, change_id: changeId };
}

/* ============================================================
 * Apply — used by both Owner direct path and approval path
 * ============================================================ */
function _applyChange_(actionType, actionOp, payload, ctx) {
  switch (actionType) {
    case 'allowance':
      if (actionOp === 'delete') return _applyAllowanceDelete_(payload);
      return _applyAllowanceUpsert_(payload);
    case 'recurring_deduction':
      if (actionOp === 'delete') return _applyRecurringDeductionDelete_(payload);
      return _applyRecurringDeductionUpsert_(payload);
    case 'holiday':
      if (actionOp === 'delete') return _applyHolidayDelete_(payload);
      return _applyHolidayUpsert_(payload);
    case 'leave_quota':
      return _applyLeaveQuotaUpsert_(payload);
    case 'employee':
      return _applyEmployeeUpsert_(payload);
  }
  throw new Error('unknown_action_type: ' + actionType);
}

/* ---- Allowance apply ---- */
function _applyAllowanceUpsert_(payload) {
  const sheet = getPublicSheet_().getSheetByName('Public_Allowances');
  if (!sheet) throw new Error('tab_missing_run_migrate');

  if (payload.allowance_id) {
    return _updateRow_(sheet, 'allowance_id', payload.allowance_id,
      ['emp_code', 'period', 'direction', 'category', 'amount', 'note'],
      payload, 'APPLY_UPDATE_ALLOWANCE', 'allowance');
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
  logAudit({ action: 'APPLY_CREATE_ALLOWANCE', target_type: 'allowance', target_id: id, after: payload });
  return { ok: true, allowance_id: id };
}

function _applyAllowanceDelete_(payload) {
  return _deleteRow_(getPublicSheet_().getSheetByName('Public_Allowances'),
    'allowance_id', payload.allowance_id, 'APPLY_DELETE_ALLOWANCE', 'allowance');
}

/* ---- Recurring Deductions apply ---- */
function _applyRecurringDeductionUpsert_(payload) {
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) throw new Error('tab_missing_run_migrate');

  if (payload._row_index) {
    const idx = Number(payload._row_index);
    const data = sheet.getDataRange().getValues();
    if (idx < 2 || idx > data.length) throw new Error('invalid_row_index');
    const headers = data[0];
    const fields = ['emp_code', 'deduction_type', 'amount', 'effective_from', 'effective_to', 'note'];
    fields.forEach(f => {
      const col = headers.indexOf(f);
      if (col >= 0 && payload[f] !== undefined) data[idx - 1][col] = payload[f];
    });
    sheet.getRange(idx, 1, 1, headers.length).setValues([data[idx - 1]]);
    logAudit({
      action: 'APPLY_UPDATE_RECURRING_DEDUCTION',
      target_type: 'recurring_deduction',
      target_id: `${payload.emp_code}|${payload.deduction_type}`,
      after: payload,
    });
    return { ok: true };
  }
  appendRows_(getPublicSheet_(), 'Recurring_Deductions', [{
    emp_code:        payload.emp_code,
    deduction_type:  payload.deduction_type,
    amount:          Number(payload.amount),
    effective_from:  payload.effective_from,
    effective_to:    payload.effective_to || '',
    note:            payload.note || '',
  }]);
  logAudit({
    action: 'APPLY_CREATE_RECURRING_DEDUCTION',
    target_type: 'recurring_deduction',
    target_id: `${payload.emp_code}|${payload.deduction_type}`,
    after: payload,
  });
  return { ok: true };
}

function _applyRecurringDeductionDelete_(payload) {
  const sheet = getPublicSheet_().getSheetByName('Recurring_Deductions');
  if (!sheet) throw new Error('tab_missing_run_migrate');
  const idx = Number(payload._row_index);
  if (idx < 2) throw new Error('invalid_row_index');
  const before = sheet.getRange(idx, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.deleteRow(idx);
  logAudit({
    action: 'APPLY_DELETE_RECURRING_DEDUCTION',
    target_type: 'recurring_deduction',
    target_id: `row_${idx}`,
    before: before.join('|'),
  });
  return { ok: true };
}

/* ---- Holiday apply ---- */
function _applyHolidayUpsert_(payload) {
  const sheet = getPublicSheet_().getSheetByName('Holiday_Calendar');
  if (!sheet) throw new Error('tab_missing_run_migrate');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');
  for (let i = 1; i < data.length; i++) {
    if (formatDate_(data[i][dateCol]) === payload.date) {
      const fields = ['name', 'type', 'applies_to'];
      fields.forEach(f => {
        const col = headers.indexOf(f);
        if (col >= 0 && payload[f] !== undefined) data[i][col] = payload[f];
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([data[i]]);
      logAudit({ action: 'APPLY_UPDATE_HOLIDAY', target_type: 'holiday', target_id: payload.date, after: payload });
      return { ok: true };
    }
  }
  appendRows_(getPublicSheet_(), 'Holiday_Calendar', [{
    date:       payload.date,
    name:       payload.name,
    type:       payload.type || 'public',
    applies_to: payload.applies_to || 'all',
  }]);
  logAudit({ action: 'APPLY_CREATE_HOLIDAY', target_type: 'holiday', target_id: payload.date, after: payload });
  return { ok: true };
}

function _applyHolidayDelete_(payload) {
  const sheet = getPublicSheet_().getSheetByName('Holiday_Calendar');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');
  for (let i = 1; i < data.length; i++) {
    if (formatDate_(data[i][dateCol]) === payload.date) {
      sheet.deleteRow(i + 1);
      logAudit({ action: 'APPLY_DELETE_HOLIDAY', target_type: 'holiday', target_id: payload.date });
      return { ok: true };
    }
  }
  throw new Error('holiday_not_found');
}

/* ---- Leave Quota apply ---- */
function _applyLeaveQuotaUpsert_(payload) {
  const year = Number(payload.year);
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
        action: 'APPLY_UPDATE_QUOTA',
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
    action: 'APPLY_CREATE_QUOTA',
    target_type: 'leave_quota',
    target_id: `${payload.emp_code}|${year}`,
    after: payload,
  });
  return { ok: true };
}

/* ---- Employee apply ---- */
function _applyEmployeeUpsert_(payload) {
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
        action: 'APPLY_UPDATE_EMPLOYEE',
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
 * Pending changes — list / approve / reject
 * ============================================================ */
function listPendingChanges(payload, ctx) {
  // HR sees own; Owner sees all pending
  const all = readTab_(getPublicSheet_(), 'Pending_Approvals');
  const isOwner = _isOwnerCtx_(ctx);
  return all
    .filter(r => r.status === 'pending')
    .filter(r => isOwner || r.submitted_by === ctx.empCode)
    .map(r => ({
      change_id: r.change_id,
      action_type: r.action_type,
      action_op:   r.action_op,
      target_id:   r.target_id,
      summary:     r.summary,
      submitted_by: r.submitted_by,
      submitted_at: r.submitted_at,
    }));
}

function approvePendingChange(payload, ctx) {
  if (!_isOwnerCtx_(ctx)) throw new Error('forbidden_owner_only');
  const { change_id } = payload;
  if (!change_id) throw new Error('missing_change_id');
  return _decidePendingChange_(change_id, ctx, 'approve', payload.notes || '');
}

function rejectPendingChange(payload, ctx) {
  if (!_isOwnerCtx_(ctx)) throw new Error('forbidden_owner_only');
  const { change_id } = payload;
  if (!change_id) throw new Error('missing_change_id');
  return _decidePendingChange_(change_id, ctx, 'reject', payload.notes || '');
}

function _decidePendingChange_(changeId, ctx, decision, notes) {
  const sheet = getPublicSheet_().getSheetByName('Pending_Approvals');
  if (!sheet) throw new Error('pending_tab_missing');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol     = headers.indexOf('change_id');
  const statusCol = headers.indexOf('status');
  const decByCol  = headers.indexOf('decided_by');
  const decAtCol  = headers.indexOf('decided_at');
  const notesCol  = headers.indexOf('decision_notes');
  const typeCol   = headers.indexOf('action_type');
  const opCol     = headers.indexOf('action_op');
  const payloadCol = headers.indexOf('payload_json');
  const summaryCol = headers.indexOf('summary');
  const submitterCol = headers.indexOf('submitted_by');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] !== changeId) continue;
    if (data[i][statusCol] !== 'pending') {
      throw new Error('already_decided: ' + data[i][statusCol]);
    }

    let result = { ok: true };
    if (decision === 'approve') {
      const payload = JSON.parse(data[i][payloadCol] || '{}');
      result = _applyChange_(data[i][typeCol], data[i][opCol], payload, ctx);
    }

    data[i][statusCol] = decision === 'approve' ? 'approved' : 'rejected';
    data[i][decByCol]  = ctx.userId || ctx.empCode || 'OWNER';
    data[i][decAtCol]  = formatDatetime_(new Date());
    data[i][notesCol]  = notes;
    sheet.getRange(i + 1, 1, 1, data[i].length).setValues([data[i]]);

    logAudit({
      action: decision === 'approve' ? 'OWNER_APPROVE_CHANGE' : 'OWNER_REJECT_CHANGE',
      target_type: 'pending_approval',
      target_id: changeId,
      actor_email: ctx.userId,
      after: { action_type: data[i][typeCol], action_op: data[i][opCol], notes },
    });

    // Notify HR submitter
    _notifyHrOfDecision_({
      submitter: data[i][submitterCol],
      summary: data[i][summaryCol],
      decision,
      notes,
    });

    return Object.assign({ ok: true, decision, change_id: changeId }, result || {});
  }
  throw new Error('change_not_found');
}

/* ============================================================
 * Notifications
 * ============================================================ */
function _notifyOwnersOfPendingChange_(req) {
  // Find all LINE_User_Map rows with role=owner; send Flex to each
  const map = readTab_(getSecretSheet_(), 'LINE_User_Map');
  const owners = map.filter(r => String(r.role).toLowerCase() === 'owner');
  if (owners.length === 0) return;
  owners.forEach(o => {
    try { sendChangeApprovalFlex(o.line_user_id, req); }
    catch (e) { console.error('flex to owner ' + o.line_user_id + ' failed: ' + e); }
  });
}

function _notifyHrOfDecision_({ submitter, summary, decision, notes }) {
  const userId = lookupUserIdByEmpCode(submitter);
  if (!userId) return;
  const verb = decision === 'approve' ? '✅ อนุมัติแล้ว' : '❌ ไม่อนุมัติ';
  let msg = `${verb}\n${summary}`;
  if (notes) msg += `\nหมายเหตุ: ${notes}`;
  pushLineMessage(userId, msg);
}

/* ============================================================
 * Summaries / labels for human-readable Flex content
 * ============================================================ */
const _ALLOW_CAT_LABEL = {
  transport: 'ค่าเดินทาง', per_diem: 'เบี้ยเลี้ยง', meal: 'ค่าอาหาร',
  uniform: 'ค่าเครื่องแบบ', parking: 'ค่าจอดรถ', communication: 'ค่าโทรศัพท์', other: 'อื่นๆ',
};
const _DED_TYPE_LABEL = {
  pf: 'PF', sso: 'ประกันสังคม', studentloan: 'กยศ.', companyloan: 'กู้บริษัท', other: 'อื่นๆ',
};
const _ACTION_OP_LABEL = { create: 'เพิ่ม', update: 'แก้ไข', delete: 'ลบ' };

function _summarizeAllowance_(p) {
  const sign = p.direction === 'addition' ? '+' : '−';
  const cat  = _ALLOW_CAT_LABEL[p.category] || p.category;
  const period = p.period === '*' ? 'ทุกงวด' : p.period;
  return `${cat} ${sign}${Number(p.amount).toLocaleString()} (${p.emp_code} · ${period})`;
}
function _summarizeRecurringDeduction_(p, op) {
  const t = _DED_TYPE_LABEL[p.deduction_type] || p.deduction_type;
  return `${_ACTION_OP_LABEL[op] || op}หักประจำ ${t} ${Number(p.amount).toLocaleString()} (${p.emp_code})`;
}
function _summarizeLeaveQuota_(p, op) {
  return `${_ACTION_OP_LABEL[op] || op}โควตา ${p.emp_code} ปี ${p.year}: ` +
    `ป่วย ${p.sick_quota || 0} · กิจ ${p.personal_quota || 0} · พักร้อน ${p.vacation_quota || 0}`;
}
function _summarizeEmployeeUpdate_(p) {
  return `แก้ข้อมูลพนักงาน ${p.emp_code}` +
    (p.first_name || p.last_name ? ` (${p.first_name || ''} ${p.last_name || ''})`.trim() : '');
}

/* ============================================================
 * Validators
 * ============================================================ */
function _validateAllowance_(p) {
  const required = ['emp_code', 'period', 'direction', 'category'];
  const missing = required.filter(k => !p || p[k] === undefined || p[k] === '');
  if (missing.length) throw new Error('missing_fields: ' + missing.join(','));
  const amt = Number(p.amount);
  if (!isFinite(amt) || amt < 0) throw new Error('invalid_amount');
  if (!['addition', 'deduction'].includes(p.direction)) throw new Error('invalid_direction');
  if (p.period !== '*' && !/^\d{4}-\d{2}$/.test(p.period)) throw new Error('invalid_period_format');
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
