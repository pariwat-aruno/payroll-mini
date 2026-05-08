/**
 * tests/reconcile.test.js — Unit tests for reconcile logic
 *
 * Run: node tests/run.js
 *
 * These tests don't run inside Apps Script — they test pure logic
 * by mocking the Sheet I/O. Apps Script-specific code (UrlFetchApp,
 * SpreadsheetApp) needs separate integration tests inside Apps Script.
 */

const assert = require('assert');

// Mock the Apps Script globals
global.formatDate_ = (d) => {
  if (!(d instanceof Date)) d = new Date(d);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
global.formatDatetime_ = (d) => global.formatDate_(d) + ' 00:00:00';
global.periodOf_ = (d) => global.formatDate_(d).substring(0, 7);
global.timeToMinutes_ = (s) => {
  if (!s) return null;
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};
global.compareDateStrings_ = (a, b) => a < b ? -1 : a > b ? 1 : 0;
global.findActiveRecord_ = (records, empCode, dateStr) => {
  const cands = records
    .filter(r => r.emp_code === empCode)
    .filter(r => {
      const from = global.formatDate_(r.effective_from || r.effective_date);
      return global.compareDateStrings_(from, dateStr) <= 0;
    })
    .sort((a, b) => {
      const af = global.formatDate_(a.effective_from || a.effective_date);
      const bf = global.formatDate_(b.effective_from || b.effective_date);
      return global.compareDateStrings_(bf, af);
    });
  return cands[0] || null;
};
global.isHoliday_ = (holidays, dateStr) =>
  holidays.some(h => global.formatDate_(h.date) === dateStr);

global.isRestDay_ = (empCode, dateStr, schedules, overrides) => {
  const ovr = overrides.find(o =>
    o.emp_code === empCode && global.formatDate_(o.date) === dateStr
  );
  if (ovr) return { isRest: ovr.new_status === 'rest', source: 'override' };
  const sch = global.findActiveRecord_(schedules, empCode, dateStr);
  if (!sch) {
    const dow = new Date(dateStr).getDay();
    return { isRest: dow === 0 || dow === 6, source: 'default' };
  }
  const bm = sch.work_days_bitmap || '1111100';
  const dow = new Date(dateStr).getDay();
  const idx = dow === 0 ? 6 : dow - 1;
  return { isRest: bm.charAt(idx) !== '1', source: 'schedule' };
};

global.generateId_ = (prefix) => prefix + '-test-' + Math.random().toString(36).slice(2, 8);
global.SHIFT_HOURS = 8;
global.SHIFT_MINUTES = 480;
global.SHORT_WORK_THRESHOLD = 465;

// Mock state
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: () => null,
    setProperty: () => {},
    setProperties: () => {},
  }),
};

// Source: copy of _reconcileOneDay (we extract only this; rest depends on
// SpreadsheetApp which we'd need to mock more thoroughly)
function reconcileOneDay({ empCode, dateStr, date, holidays, schedules, overrides,
                          leaves, otRequests, attendance }) {
  const dow = date.getDay();
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
  const isPublicHoliday = global.isHoliday_(holidays, dateStr);
  const restInfo = global.isRestDay_(empCode, dateStr, schedules, overrides);
  const isRest = restInfo.isRest;
  const leaveRecord = leaves.find(l => global.formatDate_(l.date) === dateStr);
  const otReq = otRequests.find(o => global.formatDate_(o.date) === dateStr);
  const att = attendance[0];

  let status = 'absent';
  let leaveType = '';
  let workMinutes = 0;
  let ot1 = 0, ot2 = 0, ot3 = 0;
  let escalationFlag = false;
  let escalationReason = '';

  if (isPublicHoliday) {
    status = 'holiday';
    if (att) {
      if (otReq) {
        const m = att.total_minutes || 0;
        ot2 = Math.min(m, global.SHIFT_MINUTES);
        if (m > global.SHIFT_MINUTES) ot3 = m - global.SHIFT_MINUTES;
      } else {
        escalationFlag = true;
        escalationReason = 'ทำงานในวันหยุดประจำปี โดยไม่มีใบขอ OT';
      }
    }
  } else if (isRest) {
    status = 'rest';
    if (att) {
      if (otReq) {
        const m = att.total_minutes || 0;
        ot2 = Math.min(m, global.SHIFT_MINUTES);
        if (m > global.SHIFT_MINUTES) ot3 = m - global.SHIFT_MINUTES;
      } else {
        escalationFlag = true;
        escalationReason = 'ทำงานในวันหยุดประจำสัปดาห์ โดยไม่มีใบขอ OT';
      }
    }
  } else {
    if (leaveRecord) {
      status = 'on_leave';
      leaveType = leaveRecord.leave_type;
    } else if (att) {
      const m = att.total_minutes || 0;
      if (m >= global.SHORT_WORK_THRESHOLD) {
        status = 'working';
        workMinutes = global.SHIFT_MINUTES;
        if (m > global.SHIFT_MINUTES) {
          const ot = m - global.SHIFT_MINUTES;
          if (otReq) {
            const reqMin = (global.timeToMinutes_(otReq.end_time) - global.timeToMinutes_(otReq.start_time));
            if (Math.abs(ot - reqMin) <= 15) {
              ot1 = ot;
            } else if (ot > reqMin) {
              ot1 = reqMin;
              escalationFlag = true;
              escalationReason = 'OT จริงมากกว่าใบขอ';
            } else {
              ot1 = ot;
              escalationFlag = true;
              escalationReason = 'OT จริงน้อยกว่าใบขอ';
            }
          } else {
            escalationFlag = true;
            escalationReason = 'ทำงานเกินเวลา ไม่มีใบขอ OT';
          }
        }
      } else {
        status = 'short_work';
        workMinutes = m;
        escalationFlag = true;
        escalationReason = 'short_work';
      }
    } else {
      status = 'absent';
      escalationFlag = true;
      escalationReason = 'ไม่มีสแกนนิ้ว ไม่มีใบลา';
    }
  }

  return {
    row: {
      emp_code: empCode, date: dateStr, day_of_week: dayOfWeek,
      status, leave_type: leaveType, work_minutes: workMinutes,
      ot_1_minutes: Math.round(ot1), ot_2_minutes: Math.round(ot2), ot_3_minutes: Math.round(ot3),
      escalation_flag: escalationFlag, escalation_reason: escalationReason,
    },
    escalation: escalationFlag,
  };
}

/* ========== Test cases ========== */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const baseEmp = 'EMP001';
const stdSchedule = [{
  emp_code: baseEmp, effective_from: '2024-01-01',
  pattern_type: 'fixed', work_days_bitmap: '1111100', daily_hours: 8,
}];

test('clean working day: 8h work → status=working, no OT, no escalation', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [],
    attendance: [{ total_minutes: 480, clock_in: '08:00', clock_out: '17:30' }],
  });
  assert.strictEqual(result.row.status, 'working');
  assert.strictEqual(result.row.ot_1_minutes, 0);
  assert.strictEqual(result.escalation, false);
});

test('absent: no scan + no leave → escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [], attendance: [],
  });
  assert.strictEqual(result.row.status, 'absent');
  assert.strictEqual(result.escalation, true);
});

test('approved leave: scan unused, status=on_leave', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [{ date: '2026-05-05', leave_type: 'sick', status: 'approved' }],
    otRequests: [], attendance: [],
  });
  assert.strictEqual(result.row.status, 'on_leave');
  assert.strictEqual(result.row.leave_type, 'sick');
  assert.strictEqual(result.escalation, false);
});

test('short work: scanned only 5h → status=short_work, escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [],
    attendance: [{ total_minutes: 300, clock_in: '08:00', clock_out: '13:00' }],
  });
  assert.strictEqual(result.row.status, 'short_work');
  assert.strictEqual(result.escalation, true);
});

test('OT matched: 8h+2h with OT request 17:30-19:30 → ot_1 = 120, no escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [],
    otRequests: [{ date: '2026-05-05', start_time: '17:30', end_time: '19:30', status: 'approved' }],
    attendance: [{ total_minutes: 600 }],
  });
  assert.strictEqual(result.row.status, 'working');
  assert.strictEqual(result.row.ot_1_minutes, 120);
  assert.strictEqual(result.escalation, false);
});

test('OT unrequested: 8h+2h with no OT request → ot_1=0, escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-05',
    date: new Date('2026-05-05'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [],
    attendance: [{ total_minutes: 600 }],
  });
  assert.strictEqual(result.row.ot_1_minutes, 0);
  assert.strictEqual(result.escalation, true);
});

test('weekend rest: no scan = OK, status=rest, no escalate', () => {
  // 2026-05-02 = Saturday
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-02',
    date: new Date('2026-05-02'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [], attendance: [],
  });
  assert.strictEqual(result.row.status, 'rest');
  assert.strictEqual(result.escalation, false);
});

test('weekend work without OT: escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-02',
    date: new Date('2026-05-02'),
    holidays: [], schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [],
    attendance: [{ total_minutes: 420 }],
  });
  assert.strictEqual(result.row.status, 'rest');
  assert.strictEqual(result.escalation, true);
});

test('schedule override: weekday→rest', () => {
  // EMP001 normally works Mon-Fri. Override Wed 2026-05-13 to rest.
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-13',
    date: new Date('2026-05-13'),  // Wednesday
    holidays: [], schedules: stdSchedule,
    overrides: [{ emp_code: baseEmp, date: '2026-05-13', new_status: 'rest' }],
    leaves: [], otRequests: [], attendance: [],
  });
  assert.strictEqual(result.row.status, 'rest');
  assert.strictEqual(result.escalation, false);  // not absent because rest day
});

test('schedule override: weekend→work, scan ok', () => {
  // Override Sat 2026-05-16 to work. Employee scans normally.
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-16',
    date: new Date('2026-05-16'),  // Saturday
    holidays: [], schedules: stdSchedule,
    overrides: [{ emp_code: baseEmp, date: '2026-05-16', new_status: 'work' }],
    leaves: [], otRequests: [],
    attendance: [{ total_minutes: 480 }],
  });
  assert.strictEqual(result.row.status, 'working');
  assert.strictEqual(result.escalation, false);
});

test('public holiday: no scan = holiday, no escalate', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-01',
    date: new Date('2026-05-01'),
    holidays: [{ date: '2026-05-01', name: 'Labour Day', type: 'public' }],
    schedules: stdSchedule, overrides: [],
    leaves: [], otRequests: [], attendance: [],
  });
  assert.strictEqual(result.row.status, 'holiday');
  assert.strictEqual(result.escalation, false);
});

test('public holiday + work + OT request: pay ot_2', () => {
  const result = reconcileOneDay({
    empCode: baseEmp,
    dateStr: '2026-05-01',
    date: new Date('2026-05-01'),
    holidays: [{ date: '2026-05-01', name: 'Labour Day', type: 'public' }],
    schedules: stdSchedule, overrides: [],
    leaves: [],
    otRequests: [{ date: '2026-05-01', start_time: '08:00', end_time: '17:00', status: 'approved' }],
    attendance: [{ total_minutes: 480 }],
  });
  assert.strictEqual(result.row.status, 'holiday');
  assert.strictEqual(result.row.ot_2_minutes, 480);
  assert.strictEqual(result.escalation, false);
});

/* ========== Run ========== */

let pass = 0, fail = 0;
const failures = [];
tests.forEach(t => {
  try {
    t.fn();
    console.log('  ✓ ' + t.name);
    pass++;
  } catch (err) {
    console.log('  ✗ ' + t.name);
    console.log('    ' + err.message);
    failures.push({ name: t.name, error: err.message });
    fail++;
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
