/**
 * migrate.gs — Idempotent schema upgrades for existing tenants.
 *
 * Use this when the column list in PUBLIC_TABS / _seedSettings has grown
 * since the customer's Sheet was first created. It will:
 *   - Append missing column headers to existing tabs (no reorder, no data loss)
 *   - Append missing Settings rows (existing values are kept)
 *
 * USAGE:
 *   1. clasp push the latest code
 *   2. In Apps Script editor → Run → migrateSheets
 *   3. Read the log — it lists exactly what was added
 *
 * Safe to run multiple times. Existing rows that lack values for new columns
 * will simply have empty cells; reads treat empty as default.
 */
function migrateSheets() {
  const props = PropertiesService.getScriptProperties();
  const publicId = props.getProperty('PUBLIC_SHEET_ID');
  if (!publicId) {
    Logger.log('PUBLIC_SHEET_ID not set — run setupAll() first');
    return;
  }

  const ss = SpreadsheetApp.openById(publicId);
  const report = {
    columns_added: [],   // [{ tab, columns: [...] }]
    settings_added: [],  // [key, ...]
  };

  // === 1. Header migration for Public tabs ===
  PUBLIC_TABS.forEach(tab => {
    const sheet = ss.getSheetByName(tab.name);
    if (!sheet) {
      Logger.log(`Skip ${tab.name} — sheet not found`);
      return;
    }
    const lastCol = sheet.getLastColumn();
    const existingHeaders = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h))
      : [];
    const missing = tab.headers.filter(h => !existingHeaders.includes(h));
    if (missing.length === 0) return;

    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length)
      .setFontWeight('bold')
      .setBackground('#E8E8E8');
    report.columns_added.push({ tab: tab.name, columns: missing });
    Logger.log(`+ ${tab.name}: added ${missing.length} cols → ${missing.join(', ')}`);
  });

  // === 2. Settings rows ===
  const settingsSheet = ss.getSheetByName('Settings');
  if (settingsSheet) {
    const data = settingsSheet.getDataRange().getValues();
    const existingKeys = new Set();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) existingKeys.add(String(data[i][0]));
    }

    // Re-derive the desired Settings rows by reading what _seedSettings would produce.
    // We replicate the list here so this file is self-contained — keep in sync with setup.gs::_seedSettings.
    const desired = [
      ['CUTOFF_DAY', '25', 'Day of month when payroll period closes.'],
      ['CUTOFF_MODE', 'lenient', 'strict = reject backdated submissions. lenient = accept but flag.'],
      ['REMINDER_ENABLED', 'true', 'Whether to send LINE reminders before/at cutoff.'],
      ['REMINDER_DAYS_BEFORE', '2,1,0', 'Comma-separated days before cutoff to send reminders.'],
      ['REMINDER_TIME', '09:00', 'HH:mm — when daily reminder check runs.'],
      ['SHIFT_HOURS', '8', 'Standard daily working hours.'],
      ['SHORT_WORK_TOLERANCE_MIN', '15', 'Minutes of slack before flagging short_work.'],
      ['OT_MATCH_TOLERANCE_MIN', '15', 'Tolerance when matching actual OT minutes vs requested.'],
      ['BACKDATED_REQUIRES_OWNER', 'true', 'If true, only owner can submit backdated leave/OT after cutoff.'],
      ['LEAVE_PERSONAL_MIN_ADVANCE_DAYS', '3', 'Minimum advance notice (days) for personal/vacation/unpaid leave.'],
      ['LEAVE_SICK_MIN_ADVANCE_HOURS', '1', 'Minimum advance notice (hours) for sick leave before work-start time.'],
      ['INFO_REQUEST_TIMEOUT_MINUTES', '30', 'Minutes after approver requests info before leave is auto-cancelled.'],
      ['CONDITIONAL_EVIDENCE_DAYS_AFTER_END', '1', 'Days after leave end_date when employee must submit conditional evidence.'],
    ];

    const toAppend = desired.filter(row => !existingKeys.has(row[0]));
    if (toAppend.length > 0) {
      const startRow = settingsSheet.getLastRow() + 1;
      settingsSheet.getRange(startRow, 1, toAppend.length, 3).setValues(toAppend);
      toAppend.forEach(r => report.settings_added.push(r[0]));
      Logger.log(`+ Settings: appended ${toAppend.length} rows → ${toAppend.map(r => r[0]).join(', ')}`);
    }
  }

  // === 3. Summary ===
  Logger.log('\n=== MIGRATION COMPLETE ===');
  if (report.columns_added.length === 0 && report.settings_added.length === 0) {
    Logger.log('No changes — schema already up to date.');
  } else {
    report.columns_added.forEach(r => {
      Logger.log(`  ${r.tab}: +${r.columns.length} cols`);
    });
    if (report.settings_added.length) {
      Logger.log(`  Settings: +${report.settings_added.length} rows (${report.settings_added.join(', ')})`);
    }
  }

  Logger.log('\nNEXT STEPS:');
  Logger.log('1. Apps Script → Triggers → add `infoRequestTimeoutTick` (every 5 min)');
  Logger.log('2. Apps Script → Triggers → add `conditionalEvidenceCheckTick` (daily 09:00)');
  Logger.log('3. Deploy → Manage deployments → Edit → New version');

  return report;
}
