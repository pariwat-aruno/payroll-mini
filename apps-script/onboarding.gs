/**
 * onboarding.gs — Employee onboarding flow.
 *
 * Owner fills a form in onboard.html → backend creates 5 rows in one shot:
 *   Public:  Employees, Work_Schedule, Approval_Chain, Leave_Quota
 *   Secret:  Salary_Master
 * Then issues a 6-digit pairing code (24h TTL) so the new employee can
 * link their LINE userId via pair.html.
 */

function onboardEmployee(payload) {
  const required = ['emp_code', 'first_name', 'last_name', 'national_id',
                    'email', 'department', 'position', 'start_date', 'base_salary'];
  for (const k of required) {
    if (!payload[k] && payload[k] !== 0) throw new Error('missing_field: ' + k);
  }

  const empCode = String(payload.emp_code).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,}$/.test(empCode)) throw new Error('invalid_emp_code');
  if (!/^\d{13}$/.test(String(payload.national_id))) throw new Error('invalid_national_id');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) throw new Error('invalid_email');

  const pubSs = getPublicSheet_();
  const secSs = getSecretSheet_();

  const employees = readTab_(pubSs, 'Employees');
  if (employees.some(e => e.emp_code === empCode)) throw new Error('emp_code_exists');
  if (employees.some(e => e.email === payload.email)) throw new Error('email_exists');

  // L1 approver must exist among current employees or be 'OWNER'
  const validApprovers = new Set(employees.map(e => e.emp_code).concat(['OWNER']));
  if (payload.l1_approver && !validApprovers.has(payload.l1_approver)) {
    throw new Error('l1_approver_not_found');
  }
  if (payload.l2_approver && !validApprovers.has(payload.l2_approver)) {
    throw new Error('l2_approver_not_found');
  }
  if (payload.l3_approver && !validApprovers.has(payload.l3_approver)) {
    throw new Error('l3_approver_not_found');
  }

  // Auto-derive rates from base salary
  const base = Number(payload.base_salary);
  const dailyHours = Number(payload.daily_hours) || 8;
  const daily  = base / 30;
  const hourly = daily / dailyHours;
  const round2 = n => Math.round(n * 100) / 100;

  appendRows_(pubSs, 'Employees', [{
    emp_code:         empCode,
    first_name:       payload.first_name,
    last_name:        payload.last_name,
    nickname:         payload.nickname || '',
    national_id:      String(payload.national_id),
    email:            payload.email,
    department:       payload.department,
    position:         payload.position,
    supervisor_email: payload.supervisor_email || '',
    start_date:       payload.start_date,
    end_date:         '',
    status:           payload.status || 'active',
    sso_number:       payload.sso_number || '',
    note:             payload.note || '',
  }]);

  appendRows_(pubSs, 'Work_Schedule', [{
    emp_code:         empCode,
    effective_from:   payload.start_date,
    pattern_type:     'fixed',
    work_days_bitmap: payload.work_days_bitmap || '1111100',
    daily_hours:      dailyHours,
    note:             '',
  }]);

  appendRows_(pubSs, 'Approval_Chain', [{
    emp_code:          empCode,
    level_1_approver:  payload.l1_approver || 'OWNER',
    level_2_approver:  payload.l2_approver || '',
    level_3_approver:  payload.l3_approver || '',
    effective_from:    payload.start_date,
    note:              '',
  }]);

  const year = new Date().getFullYear();
  appendRows_(pubSs, 'Leave_Quota', [{
    emp_code:        empCode,
    year:            year,
    sick_quota:      Number(payload.sick_quota)     || 30,
    sick_used:       '',
    personal_quota:  Number(payload.personal_quota) || 3,
    personal_used:   '',
    vacation_quota:  Number(payload.vacation_quota) || 8,
    vacation_used:   '',
  }]);

  appendRows_(secSs, 'Salary_Master', [{
    emp_code:       empCode,
    effective_date: payload.start_date,
    base_salary:    base,
    daily_rate:     round2(daily),
    hourly_rate:    round2(hourly),
    ot_1_rate:      round2(hourly * 1.5),
    ot_2_rate:      round2(hourly * 1.0),
    ot_3_rate:      round2(hourly * 3.0),
    sso_eligible:   payload.sso_eligible !== false,
    pf_rate:        Number(payload.pf_rate) || 0,
    note:           payload.salary_note || '',
  }]);

  // Issue 6-digit pairing code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put('pair:' + code, empCode, 24 * 3600);

  logAudit({
    action: 'ONBOARD_EMPLOYEE',
    target_type: 'employee',
    target_id: empCode,
    after: {
      name: `${payload.first_name} ${payload.last_name}`,
      department: payload.department,
      position: payload.position,
      base_salary: base,
    },
  });

  return {
    emp_code: empCode,
    pairing_code: code,
    expires_in_hours: 24,
    full_name: `${payload.first_name} ${payload.last_name}`.trim(),
  };
}

/**
 * Employee enters emp_code + pairing code from onboarding.
 * Creates LINE_User_Map row and unlocks all LIFF features for them.
 */
function pairEmployee(payload, ctx) {
  const empCodeInput = String(payload.emp_code || '').trim().toUpperCase();
  const code = String(payload.pairing_code || '').trim();
  if (!empCodeInput || !code) throw new Error('missing_fields');

  const cache = CacheService.getScriptCache();
  const cachedEmp = cache.get('pair:' + code);
  if (!cachedEmp) throw new Error('invalid_or_expired_code');
  if (cachedEmp !== empCodeInput) throw new Error('code_mismatch');

  const secSs = getSecretSheet_();
  const map = readTab_(secSs, 'LINE_User_Map');
  if (map.some(r => r.line_user_id === ctx.userId)) throw new Error('already_paired');
  if (map.some(r => r.emp_code === empCodeInput)) throw new Error('emp_code_already_paired');

  const emp = readTab_(getPublicSheet_(), 'Employees')
    .find(e => e.emp_code === empCodeInput);
  if (!emp) throw new Error('emp_not_found');

  appendRows_(secSs, 'LINE_User_Map', [{
    line_user_id: ctx.userId,
    emp_code:     empCodeInput,
    role:         empCodeInput === 'OWNER' ? 'owner' : 'employee',
    display_name: `${emp.first_name} ${emp.last_name}`.trim(),
    mapped_at:    formatDatetime_(new Date()),
    last_seen:    '',
  }]);

  // Invalidate caches so subsequent requests pick up the new mapping
  cache.remove('emp:' + ctx.userId);
  cache.remove('uid:' + empCodeInput);
  cache.remove('pair:' + code);

  logAudit({
    action: 'PAIR_LINE_USER',
    target_type: 'employee',
    target_id: empCodeInput,
    after: { user_id: ctx.userId, display_name: emp.first_name + ' ' + emp.last_name },
  });

  // Auto-switch rich menu from Onboarding → Paired (best-effort, never fails the pair)
  try {
    const pairedMenuId = PropertiesService.getScriptProperties().getProperty('RICHMENU_PAIRED_ID');
    if (pairedMenuId) assignRichMenu_(ctx.userId, pairedMenuId);
  } catch (e) {
    console.error('rich menu switch failed: ' + e);
  }

  return {
    emp_code: empCodeInput,
    full_name: `${emp.first_name} ${emp.last_name}`.trim(),
    role: empCodeInput === 'OWNER' ? 'owner' : 'employee',
  };
}

/**
 * Lightweight employee list for approver-picker dropdowns in the onboarding form.
 */
function listEmployees() {
  return readTab_(getPublicSheet_(), 'Employees')
    .filter(e => e.status === 'active' || e.status === 'probation')
    .map(e => ({
      emp_code: e.emp_code,
      first_name: e.first_name,
      last_name: e.last_name,
      department: e.department,
      position: e.position,
    }));
}
