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
