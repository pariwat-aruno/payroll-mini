/**
 * approval.gs — Multi-level approval flow
 *
 * Drives the leave/OT approval lifecycle:
 *   submitted → pending_L1 → pending_L2 → pending_L3 → approved
 *                       ↓ (any reject)
 *                    rejected
 *
 * Used by:
 *   - submitLeave() in reconcile.gs: calls determineRequiredLevels() + initApprovalState()
 *                                    + sends Flex to L1 approver
 *   - LINE webhook (in line_api.gs): when approver taps Approve/Reject button,
 *                                    routes to handleApprovalAction()
 */

/* ============================================================
 * Settings & Rules — read from Sheet at request time
 * ============================================================ */

/**
 * Read a setting value with fallback to default.
 * Settings are in the public Sheet so reading is permitted from any context.
 */
function getSetting_(key, defaultValue) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Settings');
  if (!sheet) return defaultValue;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return defaultValue;
}

/**
 * Find the first matching active approval rule for the given leave_type + days.
 * Returns the rule's required_levels (1, 2, or 3).
 * Falls back to 1 if nothing matches.
 */
function determineRequiredLevels(leaveType, days) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Approval_Rules');
  if (!sheet) return 1;

  const rows = sheet.getDataRange().getValues();
  // header at row 0
  for (let i = 1; i < rows.length; i++) {
    const [rule_id, type, min_days, max_days, required_levels, note, active] = rows[i];
    if (String(active).toUpperCase() !== 'TRUE') continue;
    const typeMatches = type === '*' || type === leaveType;
    if (!typeMatches) continue;
    if (days >= Number(min_days) && days <= Number(max_days)) {
      return Number(required_levels);
    }
  }
  return 1; // safe default
}

/**
 * Look up the approval chain for an employee.
 * Returns { l1, l2, l3 } where each is a LINE userId or empty string.
 */
function getApprovalChain(empCode) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Approval_Chain');
  if (!sheet) return { l1: '', l2: '', l3: '' };

  const rows = sheet.getDataRange().getValues();
  // pick latest effective_from row for this emp
  const todayStr = formatDate_(new Date());
  let latest = null;
  for (let i = 1; i < rows.length; i++) {
    const [emp_code, l1, l2, l3, effective_from] = rows[i];
    if (emp_code !== empCode) continue;
    const ef = formatDate_(effective_from);
    if (ef <= todayStr && (!latest || ef > latest.ef)) {
      latest = { l1, l2, l3, ef };
    }
  }
  if (!latest) return { l1: '', l2: '', l3: '' };
  return { l1: latest.l1 || '', l2: latest.l2 || '', l3: latest.l3 || '' };
}

/* ============================================================
 * Cut-off enforcement
 * ============================================================ */

/**
 * Check if a target date (the date being requested off / OT'd) is in a closed period.
 * Returns { isBackdated: bool, reason: string, mode: 'strict'|'lenient' }
 *
 * Logic:
 *   - cutoff_day = e.g. 25
 *   - If today is BEFORE cutoff_day of THIS month, then:
 *       - the active period = previous month (closing on cutoff)
 *       - any target_date in months before previous month = closed = backdated
 *   - If today is AFTER cutoff_day of this month:
 *       - active period = this month
 *       - any target_date before this month's first day = closed
 */
function checkBackdated(targetDateStr) {
  const cutoffDay = Number(getSetting_('CUTOFF_DAY', 25));
  const mode = String(getSetting_('CUTOFF_MODE', 'lenient')).toLowerCase();

  const today = new Date();
  const target = new Date(targetDateStr);

  // Compute the earliest date that's still "open" (i.e. in the current or just-opened period)
  let earliestOpen;
  if (today.getDate() <= cutoffDay) {
    // We're before/at cutoff — previous month is still open until cutoff
    earliestOpen = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  } else {
    // After cutoff — only this month onward is open
    earliestOpen = new Date(today.getFullYear(), today.getMonth(), 1);
  }

  const isBackdated = target < earliestOpen;
  return {
    isBackdated,
    mode,
    reason: isBackdated
      ? `วันที่ขอ ${targetDateStr} อยู่ในรอบที่ปิดแล้ว (ตัดรอบทุกวันที่ ${cutoffDay})`
      : '',
  };
}

/* ============================================================
 * State initialization
 * ============================================================ */

/**
 * Build the initial approval state for a leave/OT submission.
 * Returns the columns to write into Leave_Records / OT_Requests.
 */
function buildInitialApprovalState(empCode, requiredLevels) {
  const chain = getApprovalChain(empCode);
  // Determine starting status
  // - L1 always exists (or we error out)
  if (!chain.l1) {
    throw new Error('no_l1_approver_configured');
  }

  const state = {
    required_levels: requiredLevels,
    status: 'pending_L1',
    level_1_status: 'pending',
    level_1_approver: chain.l1,
    level_1_at: '',
    level_2_status: requiredLevels >= 2 ? 'waiting' : 'n/a',
    level_2_approver: requiredLevels >= 2 ? chain.l2 : '',
    level_2_at: '',
    level_3_status: requiredLevels >= 3 ? 'waiting' : 'n/a',
    level_3_approver: requiredLevels >= 3 ? chain.l3 : '',
    level_3_at: '',
    final_approved_at: '',
  };

  // Validate that all required levels have an approver
  if (requiredLevels >= 2 && !chain.l2) {
    throw new Error('no_l2_approver_configured');
  }
  if (requiredLevels >= 3 && !chain.l3) {
    throw new Error('no_l3_approver_configured');
  }

  return state;
}

/* ============================================================
 * Webhook handler — approver tapped Approve/Reject button
 * ============================================================ */

/**
 * Handle an approval action from a LINE Flex button postback.
 *
 * Postback payload format (encoded in the button's `data` field):
 *   action=approve_leave&id=LV-...&level=1
 *   action=reject_leave&id=LV-...&level=1
 *
 * @param {string} approverUserId — LINE userId of the person who tapped
 * @param {object} postback — { action, id, level }
 */
function handleApprovalAction(approverUserId, postback) {
  const { action, id, level } = postback;
  const lvl = Number(level);

  if (!['approve_leave', 'reject_leave', 'approve_ot', 'reject_ot',
        'approve_conditional_leave'].includes(action)) {
    return { ok: false, error: 'unknown_action' };
  }

  const isConditional = action === 'approve_conditional_leave';
  const isLeave = action.endsWith('leave');
  const isApprove = action.startsWith('approve');
  const sheetName = isLeave ? 'Leave_Records' : 'OT_Requests';

  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  // For leave, all rows in the same request_group_id move together.
  // For OT, single row.
  const idCol = headers.indexOf(isLeave ? 'leave_id' : 'ot_id');
  const groupCol = isLeave ? headers.indexOf('request_group_id') : -1;

  // Find the requesting record(s)
  let firstRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === id) { firstRow = i; break; }
  }
  if (firstRow === null) {
    return { ok: false, error: 'record_not_found' };
  }

  const groupId = isLeave ? data[firstRow][groupCol] : null;

  // Verify the approver is authorized for this level.
  // expectedApprover may be stored as emp_code; resolve to LINE userId before comparing.
  const expectedApproverCol = headers.indexOf(`level_${lvl}_approver`);
  const expectedApprover = data[firstRow][expectedApproverCol];
  const expectedUserId = String(expectedApprover).startsWith('U')
    ? expectedApprover
    : lookupUserIdByEmpCode(expectedApprover);
  if (expectedUserId !== approverUserId) {
    logAudit({
      action: 'APPROVAL_UNAUTHORIZED',
      target_type: isLeave ? 'leave' : 'ot',
      target_id: id,
      reason: `userId ${approverUserId} attempted L${lvl} but expected ${expectedApprover}`,
    });
    pushLineMessage(approverUserId, '⚠️ คุณไม่มีสิทธิ์อนุมัติคำขอนี้ในระดับนี้');
    return { ok: false, error: 'not_authorized_for_this_level' };
  }

  const requiredLevelsCol = headers.indexOf('required_levels');
  const statusCol         = headers.indexOf('status');
  const levelStatusCol    = headers.indexOf(`level_${lvl}_status`);
  const levelAtCol        = headers.indexOf(`level_${lvl}_at`);
  const finalAtCol        = headers.indexOf('final_approved_at');

  // Idempotent guard: if this level is already decided, ack and exit
  const currentLvlStatus = data[firstRow][levelStatusCol];
  if (currentLvlStatus === 'approved' || currentLvlStatus === 'rejected') {
    const wasApproved = currentLvlStatus === 'approved';
    pushLineMessage(approverUserId,
      wasApproved
        ? `ℹ️ คำขอนี้คุณได้อนุมัติไว้แล้ว — ไม่ต้องกดซ้ำ`
        : `ℹ️ คำขอนี้คุณได้ปฏิเสธไว้แล้ว — ไม่ต้องกดซ้ำ`);
    return { ok: true, status: data[firstRow][statusCol], idempotent: true };
  }

  const now = formatDatetime_(new Date());

  // Collect all rows belonging to this request (group of dates for leave, or single row for OT)
  const targetRows = [];
  for (let i = 1; i < data.length; i++) {
    if (isLeave && data[i][groupCol] === groupId) targetRows.push(i);
    if (!isLeave && i === firstRow) targetRows.push(i);
  }

  // Conditional approve: precompute deadline (end_date of group + N days) once
  let conditionalDeadlineStr = '';
  if (isConditional) {
    const days = Number(getSetting_('CONDITIONAL_EVIDENCE_DAYS_AFTER_END', 1));
    const groupRows = targetRows.map(idx => data[idx]);
    const dateColIdx = headers.indexOf('date');
    const lastDate = groupRows
      .map(r => formatDate_(r[dateColIdx]))
      .sort()
      .pop();
    const dl = new Date(lastDate);
    dl.setDate(dl.getDate() + days);
    conditionalDeadlineStr = formatDate_(dl);
  }
  const condReqCol  = headers.indexOf('conditional_evidence_required');
  const condDeadCol = headers.indexOf('conditional_evidence_deadline');

  targetRows.forEach(rowIdx => {
    const row = data[rowIdx];
    const requiredLevels = Number(row[requiredLevelsCol]);

    if (isApprove) {
      row[levelStatusCol] = 'approved';
      row[levelAtCol] = now;
      // Determine new top-level status
      if (lvl >= requiredLevels) {
        row[statusCol] = 'approved';
        row[finalAtCol] = now;
      } else {
        row[statusCol] = `pending_L${lvl + 1}`;
      }
      if (isConditional && condReqCol !== -1) {
        row[condReqCol]  = 'TRUE';
        row[condDeadCol] = conditionalDeadlineStr;
      }
    } else {
      // Reject: mark this level rejected, top-level rejected
      row[levelStatusCol] = 'rejected';
      row[levelAtCol] = now;
      row[statusCol] = 'rejected';
    }
    // Write back
    sheet.getRange(rowIdx + 1, 1, 1, row.length).setValues([row]);
  });

  // Confirm to the approver who just acted (the Flex stays in chat — this acknowledges)
  const empCol = headers.indexOf('emp_code');
  const dateCol = headers.indexOf('date');
  const reqLabel = isLeave ? 'ใบลา' : 'ใบขอ OT';
  const empCode = data[firstRow][empCol];
  const dateLabel = formatDate_(data[firstRow][dateCol]);
  const ack = isApprove
    ? (isConditional
        ? `✅⏳ คุณอนุมัติ${reqLabel}ของ ${empCode} วันที่ ${dateLabel} แบบมีเงื่อนไข (ต้องส่งหลักฐานภายใน ${conditionalDeadlineStr})`
        : `✅ คุณอนุมัติ${reqLabel}ของ ${empCode} วันที่ ${dateLabel} เรียบร้อยแล้ว`)
    : `❌ คุณปฏิเสธ${reqLabel}ของ ${empCode} วันที่ ${dateLabel} เรียบร้อยแล้ว`;
  pushLineMessage(approverUserId, ack);

  // Notify others
  if (isApprove) {
    const newStatus = data[firstRow][statusCol];
    if (newStatus === 'approved') {
      _notifyEmployeeApproved(data[firstRow], headers, isLeave,
        isConditional ? { conditional: true, deadline: conditionalDeadlineStr, leaveId: id } : null);
    } else {
      // Forward to next level
      _notifyNextLevelApprover(data[firstRow], headers, lvl + 1, isLeave);
    }
  } else {
    _notifyEmployeeRejected(data[firstRow], headers, isLeave, approverUserId);
  }

  logAudit({
    action: isApprove ? 'APPROVE' : 'REJECT',
    target_type: isLeave ? 'leave' : 'ot',
    target_id: id,
    actor_email: approverUserId,
    after: { level: lvl, status: data[firstRow][statusCol] },
  });

  return { ok: true, status: data[firstRow][statusCol] };
}

/**
 * List every leave/OT request currently waiting on this approver.
 * Used by owner.html to render an inbox.
 */
function listPendingApprovals(ownerUserId) {
  const pub = getPublicSheet_();
  const empMap = {};
  readTab_(pub, 'Employees').forEach(e => empMap[e.emp_code] = e);

  const items = [];

  // ===== Leave (multi-level, group-aware) =====
  const leave = readTab_(pub, 'Leave_Records');
  const groups = {};
  leave.forEach(r => {
    const k = r.request_group_id || r.leave_id;
    (groups[k] = groups[k] || []).push(r);
  });

  Object.values(groups).forEach(rows => {
    rows.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
    const first = rows[0];
    const m = String(first.status).match(/^pending_L(\d)$/);
    if (!m) return;
    const level = Number(m[1]);
    const expected = first[`level_${level}_approver`];
    const expectedUserId = String(expected).startsWith('U')
      ? expected : lookupUserIdByEmpCode(expected);
    if (expectedUserId !== ownerUserId) return;

    const emp = empMap[first.emp_code] || {};
    items.push({
      kind: 'leave',
      id: first.leave_id,
      emp_code: first.emp_code,
      first_name: emp.first_name || '',
      last_name:  emp.last_name  || '',
      department: emp.department || '',
      position:   emp.position   || '',
      leave_type: first.leave_type,
      reason: first.reason || '',
      start_date: formatDate_(first.date),
      end_date:   formatDate_(rows[rows.length - 1].date),
      days: rows.length,
      level,
      required_levels: Number(first.required_levels) || 1,
      is_backdated: String(first.is_backdated).toUpperCase() === 'TRUE',
      submitted_at: first.submitted_at,
    });
  });

  // ===== OT (single level) =====
  readTab_(pub, 'OT_Requests').forEach(r => {
    if (String(r.status) !== 'pending_L1') return;
    const expected = r.level_1_approver;
    const expectedUserId = String(expected).startsWith('U')
      ? expected : lookupUserIdByEmpCode(expected);
    if (expectedUserId !== ownerUserId) return;

    const emp = empMap[r.emp_code] || {};
    items.push({
      kind: 'ot',
      id: r.ot_id,
      emp_code: r.emp_code,
      first_name: emp.first_name || '',
      last_name:  emp.last_name  || '',
      department: emp.department || '',
      position:   emp.position   || '',
      ot_type: r.ot_type,
      reason: r.reason || '',
      date: formatDate_(r.date),
      start_time: r.start_time,
      end_time:   r.end_time,
      level: 1,
      required_levels: 1,
      is_backdated: String(r.is_backdated).toUpperCase() === 'TRUE',
      submitted_at: r.submitted_at,
    });
  });

  items.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  return items;
}

/**
 * Act on an approval from owner LIFF (instead of postback Flex).
 * Wraps handleApprovalAction with the same auth guarantees.
 */
function actOnApproval(payload, ctx) {
  const { kind, decision, id, level } = payload;
  if (!['approve', 'reject'].includes(decision)) throw new Error('invalid_decision');
  if (!['leave', 'ot'].includes(kind)) throw new Error('invalid_kind');
  if (!id || !level) throw new Error('missing_fields');

  return handleApprovalAction(ctx.userId, {
    action: `${decision}_${kind}`,
    id,
    level,
  });
}

/* ============================================================
 * Notification helpers (use line_api.gs)
 * ============================================================ */

function _notifyEmployeeApproved(row, headers, isLeave, conditionalInfo) {
  const empCol = headers.indexOf('emp_code');
  const empCode = row[empCol];
  const userId = lookupUserIdByEmpCode(empCode);
  if (!userId) return;
  const idLabel = isLeave ? 'ใบลา' : 'ใบขอ OT';
  const dateCol = headers.indexOf('date');
  if (conditionalInfo && conditionalInfo.conditional) {
    const liffUrl = _buildRespondLiffUrl_(conditionalInfo.leaveId, 'evidence');
    pushLineMessage(userId,
      `✅ ${idLabel}วันที่ ${formatDate_(row[dateCol])} ได้รับการอนุมัติ (แบบมีเงื่อนไข)\n\n` +
      `คุณต้องส่งหลักฐานเพิ่มเติมภายใน ${conditionalInfo.deadline}\n\n` +
      `ส่งหลักฐาน: ${liffUrl}`);
    return;
  }
  pushLineMessage(userId,
    `✅ ${idLabel}ของคุณวันที่ ${formatDate_(row[dateCol])} ได้รับอนุมัติเรียบร้อยแล้ว`);
}

function _notifyEmployeeRejected(row, headers, isLeave, rejecterUserId) {
  const empCol = headers.indexOf('emp_code');
  const empCode = row[empCol];
  const userId = lookupUserIdByEmpCode(empCode);
  if (!userId) return;
  const idLabel = isLeave ? 'ใบลา' : 'ใบขอ OT';
  const text = `❌ ${idLabel}ของคุณถูกปฏิเสธ\nหากมีข้อสงสัย กรุณาติดต่อผู้อนุมัติโดยตรง`;
  pushLineMessage(userId, text);
}

function _notifyNextLevelApprover(row, headers, nextLevel, isLeave) {
  const approverCol = headers.indexOf(`level_${nextLevel}_approver`);
  const approverId = row[approverCol];
  if (!approverId) return;
  const empCol = headers.indexOf('emp_code');
  const idCol = headers.indexOf(isLeave ? 'leave_id' : 'ot_id');
  const dateCol = headers.indexOf('date');
  const text = `🔔 มี${isLeave ? 'ใบลา' : 'ใบขอ OT'}ที่ผ่าน L${nextLevel-1} แล้ว ` +
               `รอการอนุมัติจากคุณ\nพนักงาน: ${row[empCol]}\nวันที่: ${formatDate_(row[dateCol])}`;
  // Send Flex with action buttons (line_api.gs has the helper)
  const req = {
    id: row[idCol],
    level: nextLevel,
    isLeave,
    empCode: row[empCol],
    date: formatDate_(row[dateCol]),
    summary: text,
  };
  if (isLeave) {
    const reasonCol = headers.indexOf('reason');
    const typeCol = headers.indexOf('leave_type');
    const reqLvlCol = headers.indexOf('required_levels');
    const backdatedCol = headers.indexOf('is_backdated');
    const emergencyCol = headers.indexOf('is_emergency');
    const durationCol = headers.indexOf('duration_unit');
    const halfCol = headers.indexOf('half_day_period');
    const hsCol = headers.indexOf('hour_start');
    const heCol = headers.indexOf('hour_end');
    const deCol = headers.indexOf('days_equivalent');
    if (typeCol !== -1) req.leaveType = row[typeCol];
    if (reasonCol !== -1) req.reason = row[reasonCol];
    if (reqLvlCol !== -1) req.requiredLevels = Number(row[reqLvlCol]) || 1;
    if (backdatedCol !== -1) req.isBackdated = String(row[backdatedCol]).toUpperCase() === 'TRUE';
    if (emergencyCol !== -1) req.isEmergency = String(row[emergencyCol]).toUpperCase() === 'TRUE';
    if (durationCol !== -1) req.durationUnit = row[durationCol] || 'full_day';
    if (halfCol !== -1) req.halfDayPeriod = row[halfCol] || '';
    if (hsCol !== -1) req.hourStart = row[hsCol] || '';
    if (heCol !== -1) req.hourEnd = row[heCol] || '';
    if (deCol !== -1) req.daysEquivalent = Number(row[deCol]) || null;
  }
  sendApprovalFlex(approverId, req);
}

/* ============================================================
 * PR-3.1 — Info request flow
 * ============================================================
 * Approver tapped "ℹ️ ขอข้อมูลเพิ่ม" button on Flex.
 *   1) handleInfoRequestPrompt — verify auth, send quick reply
 *   2) handleInfoRequestSelect — quick-reply postback ('evidence'/'reason'/'other')
 *   3) consumePendingInfoRequest — capture free-text "อื่นๆ" message
 *   4) respondInfoRequest — employee's LIFF response handler (in reconcile.gs)
 *   5) infoRequestTimeoutTick — auto-cancel expired (in scheduler.gs)
 */

function handleInfoRequestPrompt(approverUserId, params) {
  const { id, level } = params;
  if (!id || !level) return;

  // Verify approver is authorized
  const ctx = _findLeaveRowAndAuth_(id, Number(level), approverUserId);
  if (!ctx.ok) {
    pushLineMessage(approverUserId, '⚠️ คุณไม่มีสิทธิ์ขอข้อมูลเพิ่มสำหรับคำขอนี้');
    return;
  }

  // Send a message with quick-reply buttons
  const replyText = 'ขอข้อมูลอะไรเพิ่ม?';
  const items = [
    { label: '📎 ขอหลักฐานเพิ่ม',  data: `action=info_msg_leave&id=${id}&level=${level}&msg=evidence` },
    { label: '✏️ ขอเหตุผลให้ชัดเจน', data: `action=info_msg_leave&id=${id}&level=${level}&msg=reason` },
    { label: '⌨️ อื่นๆ (พิมพ์เอง)',   data: `action=info_msg_leave&id=${id}&level=${level}&msg=other` },
  ];
  pushQuickReply(approverUserId, replyText, items);
}

function handleInfoRequestSelect(approverUserId, params) {
  const { id, level, msg } = params;
  if (!id || !level || !msg) return;

  const ctx = _findLeaveRowAndAuth_(id, Number(level), approverUserId);
  if (!ctx.ok) {
    pushLineMessage(approverUserId, '⚠️ คุณไม่มีสิทธิ์ขอข้อมูลเพิ่มสำหรับคำขอนี้');
    return;
  }

  if (msg === 'other') {
    // Park user in pending free-text state; the next text message will become the info-request body
    PropertiesService.getScriptProperties()
      .setProperty(_pendingInfoKey_(approverUserId), JSON.stringify({ id, level: Number(level), at: Date.now() }));
    pushLineMessage(approverUserId, 'พิมพ์ข้อความที่ต้องการขอจากพนักงาน — ระบบจะส่งให้อัตโนมัติ');
    return;
  }
  const presetText = msg === 'evidence'
    ? 'ขอหลักฐานเพิ่มเติมประกอบใบลา'
    : 'ขอให้ระบุเหตุผลให้ชัดเจนกว่านี้';
  _finalizeInfoRequest_(approverUserId, id, Number(level), presetText);
}

function consumePendingInfoRequest(userId, text) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(_pendingInfoKey_(userId));
  if (!raw) return false;
  let pending;
  try { pending = JSON.parse(raw); } catch (_) { props.deleteProperty(_pendingInfoKey_(userId)); return false; }
  // Stale state guard (15 minutes)
  if (Date.now() - Number(pending.at || 0) > 15 * 60 * 1000) {
    props.deleteProperty(_pendingInfoKey_(userId));
    return false;
  }
  props.deleteProperty(_pendingInfoKey_(userId));
  _finalizeInfoRequest_(userId, pending.id, pending.level, text);
  return true;
}

function _pendingInfoKey_(userId) { return 'pending_info:' + userId; }

/**
 * Persist the info-request, notify the employee, ack the approver.
 * Updates ALL rows in the request_group_id together.
 */
function _finalizeInfoRequest_(approverUserId, leaveId, level, message) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol         = headers.indexOf('leave_id');
  const groupCol      = headers.indexOf('request_group_id');
  const empCol        = headers.indexOf('emp_code');
  const dateCol       = headers.indexOf('date');
  const statusCol     = headers.indexOf('info_request_status');
  const countCol      = headers.indexOf('info_request_count');
  const deadlineCol   = headers.indexOf('info_request_deadline');
  const messageCol    = headers.indexOf('info_request_message');
  const responseCol   = headers.indexOf('info_request_response');

  // Find the group
  let firstRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === leaveId) { firstRow = i; break; }
  }
  if (firstRow === null) return;

  const groupId = data[firstRow][groupCol];
  const targetRows = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][groupCol] === groupId) targetRows.push(i);
  }

  const timeoutMin = Number(getSetting_('INFO_REQUEST_TIMEOUT_MINUTES', 30));
  const deadline = new Date(Date.now() + timeoutMin * 60 * 1000);
  const deadlineStr = formatDatetime_(deadline);
  const newCount = (Number(data[firstRow][countCol]) || 0) + 1;

  targetRows.forEach(idx => {
    data[idx][statusCol]   = 'pending';
    data[idx][countCol]    = newCount;
    data[idx][deadlineCol] = deadlineStr;
    data[idx][messageCol]  = message;
    data[idx][responseCol] = ''; // clear previous round's response
    sheet.getRange(idx + 1, 1, 1, data[idx].length).setValues([data[idx]]);
  });

  const empCode = data[firstRow][empCol];
  const dateLabel = formatDate_(data[firstRow][dateCol]);
  const empUserId = lookupUserIdByEmpCode(empCode);
  if (empUserId) {
    const liffUrl = _buildRespondLiffUrl_(leaveId, 'info');
    const deadlineHHmm = Utilities.formatDate(deadline, 'GMT+7', 'HH:mm');
    pushLineMessage(empUserId,
      `⚠️ ใบลาวันที่ ${dateLabel} รอข้อมูลเพิ่มเติม\n` +
      `ผู้อนุมัติขอ: ${message}\n` +
      `กรุณาตอบกลับภายใน ${deadlineHHmm} (ภายใน ${timeoutMin} นาที)\n` +
      `หากไม่ตอบกลับ ใบลาจะถูกยกเลิกอัตโนมัติ\n\n` +
      `ตอบกลับ: ${liffUrl}`);
  }
  pushLineMessage(approverUserId, `✉️ ส่งคำขอข้อมูลเพิ่มไปยัง ${empCode} แล้ว (รอบ ${newCount})`);

  logAudit({
    action: 'INFO_REQUEST',
    target_type: 'leave',
    target_id: groupId,
    actor_email: approverUserId,
    after: { round: newCount, message },
  });
}

/**
 * Verify a userId is the configured approver for this leave row at given level.
 * Returns { ok, row, headers, sheet, rowIdx } when authorized, { ok:false } otherwise.
 */
function _findLeaveRowAndAuth_(leaveId, level, approverUserId) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('leave_id');
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === leaveId) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { ok: false, error: 'not_found' };

  const expected = data[rowIdx][headers.indexOf(`level_${level}_approver`)];
  const expectedUserId = String(expected).startsWith('U')
    ? expected : lookupUserIdByEmpCode(expected);
  if (expectedUserId !== approverUserId) return { ok: false, error: 'not_authorized' };
  return { ok: true, row: data[rowIdx], headers, sheet, rowIdx };
}

/** Build LIFF URL for respond.html. Falls back to empty string if LIFF_ID not set. */
function _buildRespondLiffUrl_(leaveId, mode) {
  const liffId = PropertiesService.getScriptProperties().getProperty('LIFF_ID') || '';
  if (!liffId) return '(LIFF_ID ไม่ได้ตั้ง — ติดต่อแอดมิน)';
  return `https://liff.line.me/${liffId}/respond.html?leave_id=${encodeURIComponent(leaveId)}&mode=${mode}`;
}
