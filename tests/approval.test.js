/**
 * tests/approval.test.js — Multi-level approval + cutoff logic
 *
 * Tests pure functions only. Sheet reads are mocked.
 */

const assert = require('assert');

// === Mock setting store (overridable per-test) ===
let mockSettings = {};
let mockApprovalRules = [];
let mockApprovalChain = [];

global.formatDate_ = (d) => {
  if (!(d instanceof Date)) d = new Date(d);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
global.formatDatetime_ = (d) => global.formatDate_(d) + ' 00:00:00';

// Mock the Sheet readers used by approval.gs
global.getPublicSheet_ = () => ({
  getSheetByName: (name) => {
    if (name === 'Settings') {
      const rows = [['key','value','note']].concat(
        Object.entries(mockSettings).map(([k, v]) => [k, v, ''])
      );
      return { getDataRange: () => ({ getValues: () => rows }) };
    }
    if (name === 'Approval_Rules') {
      const rows = [['rule_id','leave_type','min_days','max_days','required_levels','note','active']]
        .concat(mockApprovalRules);
      return { getDataRange: () => ({ getValues: () => rows }) };
    }
    if (name === 'Approval_Chain') {
      const rows = [['emp_code','level_1_approver','level_2_approver','level_3_approver','effective_from','note']]
        .concat(mockApprovalChain);
      return { getDataRange: () => ({ getValues: () => rows }) };
    }
    return null;
  },
});

// Inline copies of the functions under test so we can run them in node
function getSetting_(key, defaultValue) {
  const ss = global.getPublicSheet_();
  const sheet = ss.getSheetByName('Settings');
  if (!sheet) return defaultValue;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return defaultValue;
}
global.getSetting_ = getSetting_;

function determineRequiredLevels(leaveType, days) {
  const ss = global.getPublicSheet_();
  const sheet = ss.getSheetByName('Approval_Rules');
  if (!sheet) return 1;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [rule_id, type, min_days, max_days, required_levels, note, active] = rows[i];
    if (String(active).toUpperCase() !== 'TRUE') continue;
    const typeMatches = type === '*' || type === leaveType;
    if (!typeMatches) continue;
    if (days >= Number(min_days) && days <= Number(max_days)) {
      return Number(required_levels);
    }
  }
  return 1;
}

function getApprovalChain(empCode) {
  const ss = global.getPublicSheet_();
  const sheet = ss.getSheetByName('Approval_Chain');
  if (!sheet) return { l1: '', l2: '', l3: '' };
  const rows = sheet.getDataRange().getValues();
  const todayStr = global.formatDate_(new Date());
  let latest = null;
  for (let i = 1; i < rows.length; i++) {
    const [emp_code, l1, l2, l3, effective_from] = rows[i];
    if (emp_code !== empCode) continue;
    const ef = global.formatDate_(effective_from);
    if (ef <= todayStr && (!latest || ef > latest.ef)) {
      latest = { l1, l2, l3, ef };
    }
  }
  if (!latest) return { l1: '', l2: '', l3: '' };
  return { l1: latest.l1 || '', l2: latest.l2 || '', l3: latest.l3 || '' };
}

function buildInitialApprovalState(empCode, requiredLevels) {
  const chain = getApprovalChain(empCode);
  if (!chain.l1) throw new Error('no_l1_approver_configured');
  if (requiredLevels >= 2 && !chain.l2) throw new Error('no_l2_approver_configured');
  if (requiredLevels >= 3 && !chain.l3) throw new Error('no_l3_approver_configured');
  return {
    required_levels: requiredLevels,
    status: 'pending_L1',
    level_1_status: 'pending',
    level_1_approver: chain.l1,
    level_2_status: requiredLevels >= 2 ? 'waiting' : 'n/a',
    level_2_approver: requiredLevels >= 2 ? chain.l2 : '',
    level_3_status: requiredLevels >= 3 ? 'waiting' : 'n/a',
    level_3_approver: requiredLevels >= 3 ? chain.l3 : '',
  };
}

function checkBackdated(targetDateStr) {
  const cutoffDay = Number(getSetting_('CUTOFF_DAY', 25));
  const mode = String(getSetting_('CUTOFF_MODE', 'lenient')).toLowerCase();
  // We allow tests to inject "today" via global.MOCK_TODAY
  const today = global.MOCK_TODAY ? new Date(global.MOCK_TODAY) : new Date();
  const target = new Date(targetDateStr);
  let earliestOpen;
  if (today.getDate() <= cutoffDay) {
    earliestOpen = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  } else {
    earliestOpen = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  const isBackdated = target < earliestOpen;
  return { isBackdated, mode };
}

// === Tests ===
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const STD_RULES = [
  ['R1', '*', 1, 2, 1, 'L1 only', 'TRUE'],
  ['R2', '*', 3, 5, 2, 'L1+L2', 'TRUE'],
  ['R3', '*', 6, 999, 3, 'L1+L2+L3', 'TRUE'],
];

const STD_CHAIN = [
  ['EMP001', 'U_BOSS', 'U_MGR', 'U_OWNER', '2024-01-01', ''],
  ['EMP002', 'U_BOSS', '', '', '2024-01-01', ''],  // only L1 configured
];

test('1-day leave → 1 level required', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('sick', 1), 1);
});

test('2-day leave → 1 level required', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('personal', 2), 1);
});

test('3-day leave → 2 levels required', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('vacation', 3), 2);
});

test('5-day leave → 2 levels required', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('vacation', 5), 2);
});

test('6-day leave → 3 levels required', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('vacation', 6), 3);
});

test('30-day leave → 3 levels required (within max_days=999)', () => {
  mockApprovalRules = STD_RULES;
  assert.strictEqual(determineRequiredLevels('maternity', 30), 3);
});

test('inactive rule is skipped', () => {
  mockApprovalRules = [
    ['R1', '*', 1, 999, 3, 'always L3', 'FALSE'],  // inactive
    ['R2', '*', 1, 999, 1, 'always L1', 'TRUE'],
  ];
  assert.strictEqual(determineRequiredLevels('sick', 5), 1);
});

test('type-specific rule beats wildcard', () => {
  mockApprovalRules = [
    ['R-SICK', 'sick', 1, 999, 1, 'sick always L1', 'TRUE'],
    ['R-WILD', '*', 6, 999, 3, 'long leave L3', 'TRUE'],
  ];
  // Important: rules evaluated in order. The sick rule comes first and matches.
  assert.strictEqual(determineRequiredLevels('sick', 30), 1);
  // For non-sick, wildcard kicks in
  assert.strictEqual(determineRequiredLevels('vacation', 30), 3);
});

test('build state for 1-level approval', () => {
  mockApprovalChain = STD_CHAIN;
  const s = buildInitialApprovalState('EMP001', 1);
  assert.strictEqual(s.status, 'pending_L1');
  assert.strictEqual(s.level_1_approver, 'U_BOSS');
  assert.strictEqual(s.level_2_status, 'n/a');
});

test('build state for 3-level approval', () => {
  mockApprovalChain = STD_CHAIN;
  const s = buildInitialApprovalState('EMP001', 3);
  assert.strictEqual(s.level_1_approver, 'U_BOSS');
  assert.strictEqual(s.level_2_approver, 'U_MGR');
  assert.strictEqual(s.level_3_approver, 'U_OWNER');
  assert.strictEqual(s.level_2_status, 'waiting');
  assert.strictEqual(s.level_3_status, 'waiting');
});

test('throw if L2 required but not configured', () => {
  mockApprovalChain = STD_CHAIN;
  assert.throws(() => buildInitialApprovalState('EMP002', 2), /no_l2_approver_configured/);
});

test('cutoff: lenient mode, request before cutoff = not backdated', () => {
  mockSettings = { CUTOFF_DAY: '25', CUTOFF_MODE: 'lenient' };
  global.MOCK_TODAY = '2026-05-10';  // today is 10 May
  // Requesting May 8 (this month, before today) — should be open (current period not closed yet)
  const r = checkBackdated('2026-05-08');
  assert.strictEqual(r.isBackdated, false);
});

test('cutoff: request for last month before T+cutoff = still open', () => {
  mockSettings = { CUTOFF_DAY: '25', CUTOFF_MODE: 'lenient' };
  global.MOCK_TODAY = '2026-05-10';  // before cutoff this month
  // April should still be open until cutoff (May 25)
  const r = checkBackdated('2026-04-15');
  assert.strictEqual(r.isBackdated, false);
});

test('cutoff: request for 2 months ago = backdated', () => {
  mockSettings = { CUTOFF_DAY: '25', CUTOFF_MODE: 'lenient' };
  global.MOCK_TODAY = '2026-05-10';
  // March is 2 months ago — should be backdated
  const r = checkBackdated('2026-03-20');
  assert.strictEqual(r.isBackdated, true);
});

test('cutoff: after cutoff day, last month becomes backdated', () => {
  mockSettings = { CUTOFF_DAY: '25', CUTOFF_MODE: 'lenient' };
  global.MOCK_TODAY = '2026-05-26';  // after cutoff
  // April is now closed
  const r = checkBackdated('2026-04-15');
  assert.strictEqual(r.isBackdated, true);
});

test('cutoff strict mode flag is preserved', () => {
  mockSettings = { CUTOFF_DAY: '25', CUTOFF_MODE: 'strict' };
  global.MOCK_TODAY = '2026-05-10';
  const r = checkBackdated('2026-03-20');
  assert.strictEqual(r.isBackdated, true);
  assert.strictEqual(r.mode, 'strict');
});

// === Run ===
console.log('Running approval tests...\n');
let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ✓ ' + t.name);
    passed++;
  } catch (err) {
    console.log('  ✗ ' + t.name);
    console.log('      ' + (err.message || err));
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
