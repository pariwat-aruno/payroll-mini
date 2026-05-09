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

  if (!['approve_leave', 'reject_leave', 'approve_ot', 'reject_ot'].includes(action)) {
    return { ok: false, error: 'unknown_action' };
  }

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
    ? `✅ คุณอนุมัติ${reqLabel}ของ ${empCode} วันที่ ${dateLabel} เรียบร้อยแล้ว`
    : `❌ คุณปฏิเสธ${reqLabel}ของ ${empCode} วันที่ ${dateLabel} เรียบร้อยแล้ว`;
  pushLineMessage(approverUserId, ack);

  // Notify others
  if (isApprove) {
    const newStatus = data[firstRow][statusCol];
    if (newStatus === 'approved') {
      _notifyEmployeeApproved(data[firstRow], headers, isLeave);
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

function _notifyEmployeeApproved(row, headers, isLeave) {
  const empCol = headers.indexOf('emp_code');
  const empCode = row[empCol];
  const userId = lookupUserIdByEmpCode(empCode);
  if (!userId) return;
  const idLabel = isLeave ? 'ใบลา' : 'ใบขอ OT';
  const dateCol = headers.indexOf('date');
  const text = `✅ ${idLabel}ของคุณวันที่ ${formatDate_(row[dateCol])} ได้รับอนุมัติเรียบร้อยแล้ว`;
  pushLineMessage(userId, text);
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
  sendApprovalFlex(approverId, {
    id: row[idCol],
    level: nextLevel,
    isLeave,
    empCode: row[empCol],
    date: formatDate_(row[dateCol]),
    summary: text,
  });
}
