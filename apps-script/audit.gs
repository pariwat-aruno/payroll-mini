/**
 * audit.gs — Append-only audit log
 *
 * Every state-changing operation should call logAudit().
 * The Audit_Log sheet is protected so only this script can write.
 */

/**
 * Log an audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action   — e.g. 'SUBMIT_LEAVE', 'RUN_PAYROLL'
 * @param {string} entry.target_type — e.g. 'leave_record', 'payroll_run'
 * @param {string} entry.target_id   — id of the affected entity
 * @param {object} [entry.before]    — JSON-serializable
 * @param {object} [entry.after]     — JSON-serializable
 * @param {string} [entry.reason]
 * @param {string} [entry.actor_email] — defaults to active user
 */
function logAudit(entry) {
  try {
    const secret = getSecretSheet_();
    const sheet = secret.getSheetByName('Audit_Log');
    if (!sheet) return;

    const now = new Date();
    const lastRow = sheet.getLastRow();
    const logId = lastRow;  // 0-indexed visible (header is row 1, so first log = id 1)

    const actor = entry.actor_email
      || Session.getActiveUser().getEmail()
      || 'system';

    const row = [
      logId,
      formatDatetime_(now),
      actor,
      entry.action || 'UNKNOWN',
      entry.target_type || '',
      entry.target_id || '',
      entry.before ? JSON.stringify(entry.before) : '',
      entry.after ? JSON.stringify(entry.after) : '',
      entry.reason || '',
    ];

    sheet.appendRow(row);
  } catch (err) {
    // Never let audit failure break the main flow,
    // but do log it to console so we notice
    console.error('Audit failed: ' + err);
  }
}

/**
 * Read recent audit entries (for Owner only).
 */
function getRecentAuditEntries(limit) {
  limit = limit || 50;
  const secret = getSecretSheet_();
  const sheet = secret.getSheetByName('Audit_Log');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const start = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - start + 1;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rows = sheet.getRange(start, 1, numRows, sheet.getLastColumn()).getValues();
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i]; });
    return obj;
  }).reverse();
}
