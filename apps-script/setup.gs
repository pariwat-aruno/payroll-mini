/**
 * setup.gs — Run-once setup. Creates Public + Secret Sheets with all tabs.
 *
 * USAGE:
 *   1. Open Apps Script editor
 *   2. Run setupAll() ONCE  (you'll be asked to authorize)
 *   3. Two new Sheets will be created in your Drive
 *   4. Their IDs will be saved to PropertiesService automatically
 *   5. Then call setProperties() to add LINE keys
 *
 * Re-running setupAll() is safe — it will detect existing Sheets and skip.
 */

/**
 * Main entry — set up everything from scratch.
 */
function setupAll() {
  const props = PropertiesService.getScriptProperties();

  let publicSheetId = props.getProperty('PUBLIC_SHEET_ID');
  let secretSheetId = props.getProperty('SECRET_SHEET_ID');

  if (!publicSheetId) {
    const publicSs = SpreadsheetSheet_.create('Payroll_Public');
    publicSheetId = publicSs.getId();
    props.setProperty('PUBLIC_SHEET_ID', publicSheetId);
    _populatePublicSheet(publicSs);
    Logger.log('Created Public Sheet: ' + publicSheetId);
  } else {
    Logger.log('Public Sheet already exists: ' + publicSheetId);
  }

  if (!secretSheetId) {
    const secretSs = SpreadsheetSheet_.create('Payroll_Secret');
    secretSheetId = secretSs.getId();
    props.setProperty('SECRET_SHEET_ID', secretSheetId);
    _populateSecretSheet(secretSs);
    Logger.log('Created Secret Sheet: ' + secretSheetId);
  } else {
    Logger.log('Secret Sheet already exists: ' + secretSheetId);
  }

  Logger.log('\n=== SETUP COMPLETE ===');
  Logger.log('Public Sheet:  https://docs.google.com/spreadsheets/d/' + publicSheetId);
  Logger.log('Secret Sheet:  https://docs.google.com/spreadsheets/d/' + secretSheetId);
  Logger.log('\nNEXT STEPS:');
  Logger.log('1. Restrict Secret Sheet sharing to OWNER ONLY (Drive UI)');
  Logger.log('2. Run setProperties() and fill in LINE keys');
  Logger.log('3. Deploy → New deployment → Web App → Anyone can access');
}

/**
 * Convenience helper — call this and edit the strings inline.
 *
 * SECURITY: Don't commit the actual values. Edit, run, then revert
 * to placeholders.
 */
function setProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    LINE_CHANNEL_ID:           'PASTE_HERE',
    LINE_CHANNEL_SECRET:       'PASTE_HERE',
    LINE_CHANNEL_ACCESS_TOKEN: 'PASTE_HERE',
    LIFF_ID:                   'PASTE_HERE',
    OWNER_EMAIL:               'PASTE_HERE@example.com',
    // ANTHROPIC_API_KEY:      'PASTE_HERE',  // optional, for AI features
  });
  Logger.log('Properties saved. Run printProperties() to verify.');
}

function printProperties() {
  const props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(k => {
    const v = props[k];
    const masked = v && v.length > 12
      ? v.substring(0, 6) + '...' + v.substring(v.length - 4)
      : v;
    Logger.log(k + ' = ' + masked);
  });
}

/* ============================================================
 * Sheet population
 * ============================================================ */

const SpreadsheetSheet_ = SpreadsheetApp;

const PUBLIC_TABS = [
  {
    name: 'Employees',
    headers: ['emp_code', 'first_name', 'last_name', 'nickname',
              'national_id', 'email', 'department', 'position',
              'supervisor_email', 'start_date', 'end_date', 'status',
              'sso_number', 'note', 'reference_selfie_url', 'id_card_url'],
  },
  {
    name: 'Holiday_Calendar',
    headers: ['date', 'name', 'type', 'applies_to'],
  },
  {
    name: 'Work_Schedule',
    headers: ['emp_code', 'effective_from', 'pattern_type',
              'work_days_bitmap', 'daily_hours', 'note'],
    note: 'work_days_bitmap = 7 chars, Mon-Sun. e.g. "1111100" = Mon-Fri work, Sat-Sun off',
  },
  {
    name: 'Schedule_Override',
    headers: ['override_id', 'emp_code', 'date', 'original_status',
              'new_status', 'reason', 'paired_with_date',
              'approved_by', 'created_at'],
    note: 'Used for swap days, comp days, special arrangements',
  },
  {
    name: 'Leave_Quota',
    headers: ['emp_code', 'year', 'sick_quota', 'sick_used',
              'personal_quota', 'personal_used',
              'vacation_quota', 'vacation_used'],
    note: 'sick_used / personal_used / vacation_used are formulas (set after setup)',
  },
  {
    name: 'Leave_Records',
    headers: ['leave_id', 'emp_code', 'date', 'leave_type',
              'reason', 'submitted_at', 'status',
              'request_group_id', 'days_in_request', 'required_levels',
              'level_1_status', 'level_1_approver', 'level_1_at',
              'level_2_status', 'level_2_approver', 'level_2_at',
              'level_3_status', 'level_3_approver', 'level_3_at',
              'final_approved_at', 'is_backdated', 'evidence_url',
              'evidence_type', 'evidence_pending',
              'duration_unit', 'half_day_period',
              'hour_start', 'hour_end', 'days_equivalent',
              'is_emergency',
              'info_request_status', 'info_request_count',
              'info_request_deadline', 'info_request_message',
              'info_request_response',
              'conditional_evidence_required', 'conditional_evidence_deadline',
              'conditional_evidence_received_at', 'flag_compliance_issue'],
    note: '1 row = 1 day. A 3-day leave creates 3 rows but shares request_group_id. ' +
          'required_levels = 1/2/3 derived from Approval_Rules at submit time. ' +
          'status = pending_L1 | pending_L2 | pending_L3 | approved | rejected | cancelled',
  },
  {
    name: 'OT_Requests',
    headers: ['ot_id', 'emp_code', 'date', 'start_time', 'end_time',
              'ot_type', 'reason', 'submitted_at', 'status',
              'level_1_approver', 'level_1_at', 'final_approved_at',
              'is_backdated', 'end_date'],
    note: 'OT requests are single-level approval (L1 only) regardless of hours. ' +
          'end_date defaults to date; differs only for overnight OT (e.g. 23:00 → 02:00 next day).',
  },
  {
    name: 'Approval_Chain',
    headers: ['emp_code', 'level_1_approver', 'level_2_approver',
              'level_3_approver', 'effective_from', 'note'],
    note: 'Per-employee approver mapping. Approvers are LINE userIds (or emp_codes ' +
          'that resolve to LINE userIds via LINE_User_Map). level_1 required, others ' +
          'optional. Update via Sheet UI or admin LIFF page.',
  },
  {
    name: 'Approval_Rules',
    headers: ['rule_id', 'leave_type', 'min_days', 'max_days',
              'required_levels', 'note', 'active'],
    note: 'Configurable rules. leave_type = "*" matches all. Best practice for Thai SME: ' +
          '1-2 days L1 only, 3-5 days L1+L2, 6+ days L1+L2+L3. ' +
          'Pre-populated by setup. Edit anytime.',
  },
  {
    name: 'Settings',
    headers: ['key', 'value', 'note'],
    note: 'System-wide configuration. CUTOFF_DAY, REMINDER_DAYS, etc. ' +
          'Pre-populated by setup with sensible defaults.',
  },
  {
    name: 'Public_Allowances',
    headers: ['allowance_id', 'emp_code', 'period', 'direction',
              'category', 'amount', 'note', 'created_at'],
    note: 'Non-salary additions/deductions visible to HR. ' +
          'period = YYYY-MM for one-off, or "*" for recurring (every period). ' +
          'direction = addition | deduction. ' +
          'category = transport | per_diem | meal | uniform | parking | communication | other. ' +
          'IMPORTANT: discretionary per-person bonuses / commissions / salary advances are sensitive — ' +
          'put them in Monthly_Adjustments in the Secret Sheet, NOT here.',
  },
  {
    name: 'Recurring_Deductions',
    headers: ['emp_code', 'deduction_type', 'amount',
              'effective_from', 'effective_to', 'note'],
    note: 'Standing deductions visible to HR (PF, SSO opt-in, student loan, company loan). ' +
          'deduction_type = pf | sso | studentloan | companyloan | other. ' +
          'These are non-discretionary and already appear on the slip — moved here in v2 ' +
          'so HR can maintain them without seeing salary.',
  },
  {
    name: 'Pending_Approvals',
    headers: ['change_id', 'action_type', 'action_op', 'target_id',
              'payload_json', 'summary',
              'submitted_by', 'submitted_at',
              'status', 'decided_by', 'decided_at', 'decision_notes'],
    note: 'Queue of HR-initiated changes awaiting Owner approval. ' +
          'action_type = allowance | recurring_deduction | holiday | leave_quota | employee. ' +
          'action_op = create | update | delete. ' +
          'status = pending | approved | rejected. ' +
          'On approve, the system applies payload_json and updates the target sheet.',
  },
  {
    name: 'Attendance_Raw',
    headers: ['emp_code', 'date', 'clock_in', 'clock_out',
              'total_minutes', 'source', 'imported_at',
              'selfie_in_url', 'selfie_out_url',
              'lat', 'lng', 'distance_m', 'geofence_ok',
              'approval_status',
              'slot1_time', 'slot1_url',
              'slot2_time', 'slot2_url',
              'slot3_time', 'slot3_url',
              'slot4_time', 'slot4_url',
              'scan_count'],
    note: 'Append-only for fingerprint CSV imports. ' +
          'For source=selfie, one row per (emp_code, date) with up to 4 slots: ' +
          'slot1=เช้า, slot2=ก่อนเที่ยง, slot3=หลังเที่ยง, slot4=เย็น. ' +
          'clock_in mirrors slot1_time, clock_out mirrors the latest filled slot. ' +
          'selfie_in_url/selfie_out_url are aliases of slot1_url and the latest slot_url ' +
          'for backward compat with code that ignores the slot columns. ' +
          'approval_status = auto | pending | approved | rejected. Rejected rows ignored by reconcile.',
  },
  {
    name: 'Attendance_Reconciled',
    headers: ['emp_code', 'date', 'day_of_week', 'status',
              'leave_type', 'work_minutes',
              'ot_1_minutes', 'ot_2_minutes', 'ot_3_minutes',
              'escalation_flag', 'escalation_reason', 'reconciled_at'],
    note: 'Output of reconcile step. Auto-generated.',
  },
  {
    name: 'Monthly_Summary',
    headers: ['emp_code', 'period', 'working_days', 'short_days',
              'paid_leave_days', 'unpaid_leave_days', 'absent_days',
              'holiday_days', 'ot_1_hours', 'ot_2_hours', 'ot_3_hours',
              'has_unresolved', 'computed_at', 'locked'],
    note: 'PUBLIC↔SECRET BRIDGE. The only data crossing the privacy line. NO MONEY.',
  },
  {
    name: 'Escalation_Queue',
    headers: ['esc_id', 'emp_code', 'date', 'type', 'detail',
              'created_at', 'status', 'resolved_by',
              'resolved_at', 'resolution_note'],
  },
];

const SECRET_TABS = [
  {
    name: 'Salary_Master',
    headers: ['emp_code', 'effective_date', 'base_salary',
              'daily_rate', 'hourly_rate',
              'ot_1_rate', 'ot_2_rate', 'ot_3_rate',
              'sso_eligible', 'pf_rate', 'note'],
    note: 'NEVER delete old rows. New salary = insert new row with effective_date.',
  },
  {
    name: 'Monthly_Adjustments',
    headers: ['adj_id', 'emp_code', 'period', 'direction',
              'category', 'amount', 'reason',
              'approved_by', 'created_at'],
  },
  {
    name: 'Payroll_Run',
    headers: ['emp_code', 'period',
              'base_pay', 'unpaid_leave_days', 'unpaid_leave_deduct',
              'absent_days', 'absent_deduct',
              'ot_1_hours', 'ot_1_pay',
              'ot_2_hours', 'ot_2_pay',
              'ot_3_hours', 'ot_3_pay',
              'additions_total', 'gross',
              'tax', 'sso', 'studentloan', 'companyloan', 'pf',
              'manual_deductions', 'deductions_total',
              'net', 'status', 'computed_at', 'sent_at'],
  },
  {
    name: 'YTD_Accumulator',
    headers: ['emp_code', 'year', 'gross_ytd', 'net_ytd',
              'tax_ytd', 'sso_ytd', 'pf_ytd', 'ot_pay_ytd',
              'last_updated'],
  },
  {
    name: 'Audit_Log',
    headers: ['log_id', 'timestamp', 'actor_email',
              'action', 'target_type', 'target_id',
              'before', 'after', 'reason'],
    note: 'Append-only. Set protected range after first row to prevent edits.',
  },
  {
    name: 'LINE_User_Map',
    headers: ['line_user_id', 'emp_code', 'role',
              'display_name', 'mapped_at', 'last_seen'],
    note: 'role = employee | owner. Built up during onboarding.',
  },
];

function _populatePublicSheet(ss) {
  // Remove default Sheet1
  const defaultSheet = ss.getSheetByName('Sheet1');

  PUBLIC_TABS.forEach(tab => {
    const sheet = ss.insertSheet(tab.name);
    _writeHeaders(sheet, tab.headers);
    if (tab.note) {
      // Write note as a comment in cell A1 (cell note, not row content)
      sheet.getRange(1, 1).setNote(tab.note);
    }
  });

  if (defaultSheet) ss.deleteSheet(defaultSheet);

  // Seed default values for config tabs
  _seedApprovalRules(ss);
  _seedSettings(ss);
}

/**
 * Seed Approval_Rules with best-practice defaults for Thai SME.
 * Rules evaluated in order — first match wins.
 * Customer can edit/disable rules anytime via Sheet UI.
 */
function _seedApprovalRules(ss) {
  const sheet = ss.getSheetByName('Approval_Rules');
  if (!sheet) return;
  const rows = [
    // [rule_id, leave_type, min_days, max_days, required_levels, note, active]
    ['R-DEFAULT-1', '*', 1, 2, 1,
     'Default: 1-2 day leave needs only direct supervisor', 'TRUE'],
    ['R-DEFAULT-2', '*', 3, 5, 2,
     'Default: 3-5 day leave needs supervisor + manager', 'TRUE'],
    ['R-DEFAULT-3', '*', 6, 999, 3,
     'Default: 6+ day leave needs all 3 levels including owner', 'TRUE'],
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Seed Settings with system defaults.
 * Customer can override any of these via Sheet UI.
 */
function _seedSettings(ss) {
  const sheet = ss.getSheetByName('Settings');
  if (!sheet) return;
  const rows = [
    ['CUTOFF_DAY', '25',
     'Day of month when payroll period closes. Submissions for past period are flagged after this.'],
    ['CUTOFF_MODE', 'lenient',
     'strict = reject backdated submissions. lenient = accept but flag with is_backdated=true.'],
    ['REMINDER_ENABLED', 'true',
     'Whether to send LINE reminders before/at cutoff. Set to "false" to disable.'],
    ['REMINDER_DAYS_BEFORE', '2,1,0',
     'Comma-separated days before cutoff to send reminders. e.g. "2,1,0" = T-2, T-1, T-0.'],
    ['REMINDER_TIME', '09:00',
     'HH:mm — when daily reminder check runs. Driven by Apps Script Time Trigger.'],
    ['SHIFT_HOURS', '8',
     'Standard daily working hours. Used to classify short_work and OT.'],
    ['SHORT_WORK_TOLERANCE_MIN', '15',
     'Minutes of slack before flagging short_work. Default 15 min.'],
    ['OT_MATCH_TOLERANCE_MIN', '15',
     'Tolerance when matching actual OT minutes vs requested OT minutes.'],
    ['BACKDATED_REQUIRES_OWNER', 'true',
     'If true, only owner can submit backdated leave/OT after cutoff.'],
    ['LEAVE_PERSONAL_MIN_ADVANCE_DAYS', '3',
     'Minimum advance notice (days) for personal/vacation/unpaid leave. Sick uses LEAVE_SICK_MIN_ADVANCE_HOURS.'],
    ['LEAVE_SICK_MIN_ADVANCE_HOURS', '1',
     'Minimum advance notice (hours) for sick leave before work-start time. Below this requires is_emergency=true.'],
    ['INFO_REQUEST_TIMEOUT_MINUTES', '30',
     'Minutes after approver requests info before leave is auto-cancelled (PR-3.1).'],
    ['CONDITIONAL_EVIDENCE_DAYS_AFTER_END', '1',
     'Days after leave end_date when employee must submit conditional evidence (PR-3.2).'],
    ['CHECKIN_MODE', 'fingerprint',
     'fingerprint = scanner CSV only (default). selfie = LIFF selfie check-in only. both = accept both.'],
    ['CHECKIN_APPROVER_USERIDS', '',
     'Comma-separated LINE userIds who receive Flex card when a selfie check-in is flagged (outside geofence). Empty = no approval flow.'],
    ['CHECKIN_GEOFENCE_LAT', '',
     'Worksite latitude (decimal degrees). Required when CHECKIN_MODE includes selfie.'],
    ['CHECKIN_GEOFENCE_LNG', '',
     'Worksite longitude (decimal degrees). Required when CHECKIN_MODE includes selfie.'],
    ['CHECKIN_GEOFENCE_RADIUS_M', '150',
     'Allowed radius from worksite in meters. Check-ins beyond this are flagged (not blocked).'],
    ['CHECKIN_DRIVE_FOLDER_ID', '',
     'Drive folder ID for selfie check-in images. Reference selfies and daily check-in selfies go here.'],
    ['WORK_DAY_START', '09:00',
     'Normal work-day start time (HH:mm). Used by submitOT to auto-classify OT type when the requested window falls outside this range.'],
    ['WORK_DAY_END', '18:00',
     'Normal work-day end time (HH:mm). Used by submitOT to auto-classify OT type.'],
    ['LUNCH_START', '12:00',
     'Lunch-break start (HH:mm). Used to time the slot2 (ก่อนเที่ยง) check-in reminder.'],
    ['LUNCH_END', '13:00',
     'Lunch-break end (HH:mm). Used to time the slot3 (หลังเที่ยง) check-in reminder.'],
    ['REMINDER_GRACE_MIN', '5',
     'Grace period in minutes after the slot trigger time before pinging the employee.'],
    ['CHECKIN_REMINDER_ENABLED', 'true',
     'Toggle for the selfie check-in reminder push. Set false to disable all reminders.'],
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function _populateSecretSheet(ss) {
  const defaultSheet = ss.getSheetByName('Sheet1');

  SECRET_TABS.forEach(tab => {
    const sheet = ss.insertSheet(tab.name);
    _writeHeaders(sheet, tab.headers);
    if (tab.note) {
      sheet.getRange(1, 1).setNote(tab.note);
    }
  });

  if (defaultSheet) ss.deleteSheet(defaultSheet);

  // Protect Audit_Log so manual edits are blocked
  const auditSheet = ss.getSheetByName('Audit_Log');
  if (auditSheet) {
    const protection = auditSheet.protect()
      .setDescription('Audit_Log: append-only via audit.gs only');
    // Remove all editors except the script owner
    const me = Session.getEffectiveUser();
    protection.addEditor(me);
    protection.removeEditors(protection.getEditors().filter(e => e.getEmail() !== me.getEmail()));
    if (protection.canDomainEdit()) {
      protection.setDomainEdit(false);
    }
  }
}

function _writeHeaders(sheet, headers) {
  const range = sheet.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range
    .setFontWeight('bold')
    .setBackground('#2D2D2D')
    .setFontColor('#FFFFFF')
    .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}
