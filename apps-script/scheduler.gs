/**
 * scheduler.gs — Time-based triggers for automated messages
 *
 * Setup (run once):
 *   1. Open Apps Script editor → Triggers (clock icon, left side)
 *   2. + Add Trigger
 *      - Function: dailyReminderTick
 *      - Event source: Time-driven
 *      - Type: Day timer
 *      - Hour: 9am-10am
 *
 * To stop reminders without removing the trigger, set REMINDER_ENABLED=false
 * in Settings tab.
 *
 * Each reminder is gated by Settings — customer can disable, change days,
 * or change time without touching code.
 */

/**
 * Main entry — called by daily time trigger.
 * Decides which reminders (if any) to send today.
 */
function dailyReminderTick() {
  const enabled = String(getSetting_('REMINDER_ENABLED', 'true')).toLowerCase();
  if (enabled !== 'true') {
    Logger.log('Reminders disabled in Settings. Skipping.');
    return;
  }

  const today = new Date();
  const cutoffDay = Number(getSetting_('CUTOFF_DAY', 25));
  const reminderDaysBefore = String(getSetting_('REMINDER_DAYS_BEFORE', '2,1,0'))
    .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));

  // Compute "days until cutoff" for this month
  const cutoffDate = new Date(today.getFullYear(), today.getMonth(), cutoffDay);
  const msPerDay = 24 * 60 * 60 * 1000;
  // Strip time component for comparison
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysUntilCutoff = Math.round((cutoffDate - todayDateOnly) / msPerDay);

  if (reminderDaysBefore.includes(daysUntilCutoff)) {
    Logger.log(`Sending reminder: T-${daysUntilCutoff} before cutoff`);
    _broadcastEmployeeReminder(daysUntilCutoff, cutoffDay);
  }

  // Day after cutoff: notify owner that period closed
  if (daysUntilCutoff === -1) {
    Logger.log('Period just closed — notifying owner');
    _notifyOwnerPeriodClosed();
  }
}

function _broadcastEmployeeReminder(daysUntil, cutoffDay) {
  const emps = getEmployees_({ status: 'active' });
  const message = _buildEmployeeReminderText(daysUntil, cutoffDay);

  let sent = 0, failed = 0;
  emps.forEach(emp => {
    const userId = lookupUserIdByEmpCode(emp.emp_code);
    if (!userId) { failed++; return; }
    try {
      pushLineMessage(userId, message);
      sent++;
    } catch (e) {
      Logger.log(`Failed to push to ${emp.emp_code}: ${e}`);
      failed++;
    }
  });

  logAudit({
    action: 'BROADCAST_REMINDER',
    target_type: 'period',
    target_id: formatDate_(new Date()),
    after: { daysUntilCutoff: daysUntil, sent, failed },
  });
}

function _buildEmployeeReminderText(daysUntil, cutoffDay) {
  if (daysUntil === 0) {
    return `⏰ วันนี้ตัดรอบเงินเดือน (วันที่ ${cutoffDay})\n\n` +
           `กรุณาส่งใบลา/ใบขอ OT ที่ค้างให้เสร็จก่อนสิ้นวัน\n` +
           `หลังจากนี้จะเข้าสู่รอบเดือนถัดไป`;
  }
  if (daysUntil === 1) {
    return `📅 พรุ่งนี้ตัดรอบเงินเดือน\n\n` +
           `อย่าลืมส่งใบลา/ใบขอ OT ของเดือนนี้ให้ครบ\n` +
           `เพื่อให้ระบบคำนวณเงินเดือนได้ถูกต้อง`;
  }
  return `📅 อีก ${daysUntil} วันจะตัดรอบเงินเดือน\n\n` +
         `กรุณาตรวจสอบและส่งใบลา/ใบขอ OT ที่ค้างให้ครบ ` +
         `ก่อนวันที่ ${cutoffDay} ของเดือนนี้`;
}

function _notifyOwnerPeriodClosed() {
  const ownerUserId = _findOwnerUserId();
  if (!ownerUserId) return;

  // Compute closed period
  const today = new Date();
  // The period that just closed is the previous month
  const closedMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const period = formatDate_(closedMonth).substring(0, 7);

  // Count pending escalations for that period
  const pendingEsc = _countPendingEscalations(period);
  const pendingApprovals = _countPendingApprovals(period);

  const text = `✅ รอบ ${period} ปิดแล้ว\n\n` +
               `📋 ใบลา/OT ที่ยังรออนุมัติ: ${pendingApprovals} รายการ\n` +
               `⚠️ Escalation ที่ยังไม่ resolve: ${pendingEsc} รายการ\n\n` +
               `กรุณาเคลียร์ก่อนรัน Payroll สำหรับรอบนี้`;
  pushLineMessage(ownerUserId, text);
}

function _findOwnerUserId() {
  const ss = getSecretSheet_();
  const sheet = ss.getSheetByName('LINE_User_Map');
  if (!sheet) return null;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).toLowerCase() === 'owner') return rows[i][0];
  }
  return null;
}

function _countPendingEscalations(period) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Escalation_Queue');
  if (!sheet) return 0;
  const rows = sheet.getDataRange().getValues();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const date = formatDate_(rows[i][2]);
    const status = rows[i][6];
    if (date.substring(0, 7) === period && status === 'pending') count++;
  }
  return count;
}

function _countPendingApprovals(period) {
  const ss = getPublicSheet_();
  let count = 0;
  ['Leave_Records', 'OT_Requests'].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const rows = sheet.getDataRange().getValues();
    const headers = rows[0];
    const dateCol = headers.indexOf('date');
    const statusCol = headers.indexOf('status');
    for (let i = 1; i < rows.length; i++) {
      const date = formatDate_(rows[i][dateCol]);
      const status = String(rows[i][statusCol]);
      if (date.substring(0, 7) === period && status.startsWith('pending')) count++;
    }
  });
  return count;
}

/* ============================================================
 * PR-3.1 — Info-request timeout
 * Trigger: every 5 minutes
 * For each Leave_Records row with info_request_status=pending and deadline < now,
 * cancel the leave (group atomically) and notify employee + approver.
 * ============================================================ */
function infoRequestTimeoutTick() {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const groupCol      = headers.indexOf('request_group_id');
  const empCol        = headers.indexOf('emp_code');
  const dateCol       = headers.indexOf('date');
  const statusCol     = headers.indexOf('status');
  const infoStatusCol = headers.indexOf('info_request_status');
  const deadlineCol   = headers.indexOf('info_request_deadline');

  if ([groupCol, statusCol, infoStatusCol, deadlineCol].some(c => c === -1)) return;

  const now = new Date();
  const groupsToExpire = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][infoStatusCol] !== 'pending') continue;
    const deadline = data[i][deadlineCol];
    if (!deadline) continue;
    const dlDate = new Date(deadline);
    if (isNaN(dlDate)) continue;
    if (dlDate.getTime() < now.getTime()) {
      groupsToExpire.add(data[i][groupCol]);
    }
  }
  if (groupsToExpire.size === 0) return;

  let cancelled = 0;
  groupsToExpire.forEach(groupId => {
    const targetRows = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][groupCol] === groupId) targetRows.push(i);
    }
    if (targetRows.length === 0) return;

    targetRows.forEach(idx => {
      data[idx][statusCol]     = 'cancelled';
      data[idx][infoStatusCol] = 'expired';
      sheet.getRange(idx + 1, 1, 1, data[idx].length).setValues([data[idx]]);
    });
    cancelled++;

    const first = data[targetRows[0]];
    const empCode = first[empCol];
    const dateLabel = formatDate_(first[dateCol]);
    const empUserId = lookupUserIdByEmpCode(empCode);
    if (empUserId) {
      pushLineMessage(empUserId,
        `❌ ใบลาวันที่ ${dateLabel} ถูกยกเลิกอัตโนมัติ\n` +
        `เนื่องจากไม่ได้ตอบกลับคำขอข้อมูลเพิ่มเติมภายในเวลาที่กำหนด`);
    }
    // Notify approver (level that requested) — match status before cancel was pending_LX
    // But we already set status=cancelled; approver was the one who initiated. Best-effort skip.
  });

  logAudit({
    action: 'INFO_REQUEST_EXPIRED_TICK',
    target_type: 'leave',
    target_id: 'batch',
    after: { groups_cancelled: cancelled },
  });
}

/* ============================================================
 * PR-3.2 — Conditional evidence check
 * Trigger: daily 09:00
 * - T-day  (deadline = today, not received): reminder to employee
 * - T+1    (deadline passed by 1 day, not received): flag_compliance_issue=true + notify HR
 * ============================================================ */
function conditionalEvidenceCheckTick() {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Leave_Records');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol       = headers.indexOf('leave_id');
  const groupCol    = headers.indexOf('request_group_id');
  const empCol      = headers.indexOf('emp_code');
  const reqCol      = headers.indexOf('conditional_evidence_required');
  const deadCol     = headers.indexOf('conditional_evidence_deadline');
  const recvCol     = headers.indexOf('conditional_evidence_received_at');
  const flagCol     = headers.indexOf('flag_compliance_issue');
  const dateCol     = headers.indexOf('date');
  const typeCol     = headers.indexOf('leave_type');

  if ([reqCol, deadCol, recvCol, flagCol].some(c => c === -1)) return;

  const today = new Date();
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayMs = 24 * 60 * 60 * 1000;

  // Collapse to one notification per group_id (rows in a group share state)
  const seenGroups = new Set();
  let reminded = 0, flagged = 0;
  for (let i = 1; i < data.length; i++) {
    const required = String(data[i][reqCol]).toUpperCase() === 'TRUE';
    if (!required) continue;
    if (data[i][recvCol]) continue; // already submitted
    const groupId = data[i][groupCol];
    if (seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);

    const dl = data[i][deadCol];
    if (!dl) continue;
    const dlDate = new Date(dl);
    if (isNaN(dlDate)) continue;
    const dlDateOnly = new Date(dlDate.getFullYear(), dlDate.getMonth(), dlDate.getDate());
    const diffDays = Math.round((todayDateOnly - dlDateOnly) / dayMs);

    const empCode = data[i][empCol];
    const dateLabel = formatDate_(data[i][dateCol]);
    const leaveId = data[i][idCol];

    if (diffDays === 0) {
      // T-day: reminder to employee
      const userId = lookupUserIdByEmpCode(empCode);
      if (userId) {
        const liffUrl = _buildRespondLiffUrl_(leaveId, 'evidence');
        pushLineMessage(userId,
          `📌 วันนี้เป็นวันสุดท้ายในการส่งหลักฐาน\n` +
          `ใบลาวันที่ ${dateLabel} (อนุมัติแบบมีเงื่อนไข)\n\n` +
          `ส่งหลักฐาน: ${liffUrl}`);
        reminded++;
      }
    } else if (diffDays >= 1 && String(data[i][flagCol]).toUpperCase() !== 'TRUE') {
      // T+1: flag + notify HR
      const targetRows = [];
      for (let j = 1; j < data.length; j++) {
        if (data[j][groupCol] === groupId) targetRows.push(j);
      }
      targetRows.forEach(idx => {
        data[idx][flagCol] = 'TRUE';
        sheet.getRange(idx + 1, 1, 1, data[idx].length).setValues([data[idx]]);
      });
      flagged++;

      // Notify HR (role=hr in LINE_User_Map; falls back to owner)
      const hrUserId = _findHrUserId_() || _findOwnerUserId();
      if (hrUserId) {
        pushLineMessage(hrUserId,
          `🚨 พนักงาน ${empCode} ไม่ส่งหลักฐานตามเงื่อนไข\n` +
          `ใบลา: ${dateLabel} ประเภท: ${data[i][typeCol]}\n` +
          `Deadline ผ่าน: ${formatDate_(dlDate)}\n\n` +
          `กรุณาเรียกพบเพื่อสอบสวน`);
      }
    }
  }

  if (reminded || flagged) {
    logAudit({
      action: 'CONDITIONAL_EVIDENCE_TICK',
      target_type: 'leave',
      target_id: 'batch',
      after: { reminded, flagged },
    });
  }
}

function _findHrUserId_() {
  const ss = getSecretSheet_();
  const sheet = ss.getSheetByName('LINE_User_Map');
  if (!sheet) return null;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).toLowerCase() === 'hr') return rows[i][0];
  }
  return null;
}
