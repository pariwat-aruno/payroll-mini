/**
 * utils.gs — Shared helpers
 */

/**
 * Get the Public Spreadsheet object.
 */
function getPublicSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('PUBLIC_SHEET_ID');
  if (!id) throw new Error('PUBLIC_SHEET_ID not set. Run setupAll() first.');
  return SpreadsheetApp.openById(id);
}

/**
 * Get the Secret Spreadsheet object.
 */
function getSecretSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SECRET_SHEET_ID');
  if (!id) throw new Error('SECRET_SHEET_ID not set. Run setupAll() first.');
  return SpreadsheetApp.openById(id);
}

/**
 * Read a tab as an array of objects keyed by header.
 *
 * Example: readTab_(getPublicSheet_(), 'Employees')
 *   → [{emp_code: 'EMP001', first_name: 'สมชาย', ...}, ...]
 */
function readTab_(spreadsheet, tabName) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Append rows to a tab. Each row is an object keyed by header.
 *
 * Example: appendRows_(spreadsheet, 'Leave_Records', [
 *   { leave_id: 'LV-001', emp_code: 'EMP001', date: '2026-05-09', ... }
 * ])
 */
function appendRows_(spreadsheet, tabName, rows) {
  if (!rows || rows.length === 0) return;
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowsAsArrays = rows.map(obj => headers.map(h => obj[h] !== undefined ? obj[h] : ''));
  sheet.getRange(sheet.getLastRow() + 1, 1, rowsAsArrays.length, headers.length)
       .setValues(rowsAsArrays);
}

/**
 * Generate an ID like LV-20260508-001.
 */
function generateId_(prefix) {
  const now = new Date();
  const yyyymmdd = Utilities.formatDate(now, 'GMT+7', 'yyyyMMdd');
  const hhmmss = Utilities.formatDate(now, 'GMT+7', 'HHmmss');
  return `${prefix}-${yyyymmdd}-${hhmmss.substring(0, 6)}`;
}

/**
 * Format date to YYYY-MM-DD.
 */
function formatDate_(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return Utilities.formatDate(d, 'GMT+7', 'yyyy-MM-dd');
}

/**
 * Format date to YYYY-MM-DD HH:mm:ss.
 */
function formatDatetime_(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return Utilities.formatDate(d, 'GMT+7', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Get period (YYYY-MM) from a date.
 */
function periodOf_(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return Utilities.formatDate(d, 'GMT+7', 'yyyy-MM');
}

/**
 * Iterate every date in a period.
 *
 * Example: eachDateInPeriod_('2026-05', d => { ... })
 */
function eachDateInPeriod_(period, callback) {
  const [year, month] = period.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  for (let day = 1; day <= last; day++) {
    callback(new Date(year, month - 1, day));
  }
}

/**
 * Compare YYYY-MM-DD strings (lexicographic = chronological).
 * Returns -1, 0, 1.
 */
function compareDateStrings_(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Look up the active record for an entity at a given date,
 * based on `effective_from` (and optionally `effective_to`).
 *
 * Used for Salary_Master, Recurring_Deductions, Work_Schedule.
 */
function findActiveRecord_(records, empCode, dateStr) {
  const candidates = records
    .filter(r => r.emp_code === empCode)
    .filter(r => {
      const from = formatDate_(r.effective_from || r.effective_date);
      if (compareDateStrings_(from, dateStr) > 0) return false;
      const to = r.effective_to ? formatDate_(r.effective_to) : null;
      if (to && compareDateStrings_(to, dateStr) < 0) return false;
      return true;
    })
    .sort((a, b) => {
      const aFrom = formatDate_(a.effective_from || a.effective_date);
      const bFrom = formatDate_(b.effective_from || b.effective_date);
      return compareDateStrings_(bFrom, aFrom);  // most recent first
    });
  return candidates[0] || null;
}

/**
 * Check if a date is a holiday (in Holiday_Calendar).
 */
function isHoliday_(holidays, dateStr) {
  return holidays.some(h => formatDate_(h.date) === dateStr);
}

/**
 * Check if employee should rest on a given date according to Work_Schedule
 * (with Schedule_Override applied).
 *
 * Returns: { isRest, source } where source = 'override' | 'schedule'
 */
function isRestDay_(empCode, dateStr, schedules, overrides) {
  // Override takes precedence
  const override = overrides.find(o =>
    o.emp_code === empCode && formatDate_(o.date) === dateStr
  );
  if (override) {
    return { isRest: override.new_status === 'rest', source: 'override' };
  }

  const schedule = findActiveRecord_(schedules, empCode, dateStr);
  if (!schedule) {
    // Default: weekend off (Mon-Fri working)
    const dow = new Date(dateStr).getDay();  // 0=Sun, 6=Sat
    return { isRest: dow === 0 || dow === 6, source: 'default' };
  }

  const bitmap = schedule.work_days_bitmap || '1111100';
  // bitmap is Mon-Sun (Mon=index 0)
  const dow = new Date(dateStr).getDay();  // JS: 0=Sun, 1=Mon...
  const monBasedIndex = dow === 0 ? 6 : dow - 1;
  const isWork = bitmap.charAt(monBasedIndex) === '1';
  return { isRest: !isWork, source: 'schedule' };
}

/**
 * Parse "HH:mm" to minutes since midnight.
 */
function timeToMinutes_(timeStr) {
  if (!timeStr) return null;
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Get list of employees, optionally filtered.
 *
 * Example: getEmployees_({ status: 'active' })
 */
function getEmployees_(filter) {
  const all = readTab_(getPublicSheet_(), 'Employees');
  if (!filter) return all;
  return all.filter(emp => {
    return Object.keys(filter).every(k => emp[k] === filter[k]);
  });
}
