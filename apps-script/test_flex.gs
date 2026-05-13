/**
 * test_flex.gs — One-shot helper that pushes every Flex card the system can
 * produce to a target LINE userId, using fake-but-realistic data. Use it to
 * eyeball layouts after every Flex tweak without having to reproduce the
 * underlying event (out-of-radius scan, EOD trigger, etc.).
 *
 * USAGE
 *   1. Open Apps Script editor.
 *   2. Function dropdown → testAllFlexCards → Run.
 *      (By default sends to the OWNER LINE userId from LINE_User_Map.)
 *   3. Or run testAllFlexCardsTo('Uxxxx...') to target a specific userId.
 *
 * The function logs each push, sleeps ~500ms between pushes so LINE doesn't
 * coalesce them into one notification.
 */

function testAllFlexCards() {
  const owner = _findOwnerUserId();
  if (!owner) throw new Error('no OWNER row in LINE_User_Map — pair an OWNER first');
  testAllFlexCardsTo(owner);
}

function testAllFlexCardsTo(targetUserId) {
  if (!targetUserId) throw new Error('targetUserId required');

  // Reuse OWNER's reference selfie if we have one (renders nicely in LIFF preview).
  // Fall back to public placeholders.
  const ownerEmp = readTab_(getPublicSheet_(), 'Employees')
    .find(e => String(e.emp_code).trim().toUpperCase() === 'OWNER');
  const sampleSelfie   = (ownerEmp && ownerEmp.reference_selfie_url)
    || 'https://placehold.co/800x800/0EA5E9/FFFFFF/png?text=Selfie';
  const sampleRef      = (ownerEmp && ownerEmp.reference_selfie_url)
    || 'https://placehold.co/800x800/10B981/FFFFFF/png?text=Reference';
  const sampleEvidence = 'https://placehold.co/800x800/F59E0B/FFFFFF/png?text=Evidence';

  const today = formatDate_(new Date());
  const emp = {
    empCode: 'EMP001', empName: 'ปุย โกปุย',
    empSubtitle: 'ฝ่าย IT · Developer',
  };

  Logger.log('==== Sending all Flex cards to ' + targetUserId + ' ====');

  // ── 1. Late reminders (slot 1/2/3) ──
  ['เช้า', 'ก่อนเที่ยง', 'หลังเที่ยง'].forEach(slot => {
    sendCheckinReminderFlex(targetUserId, { slotLabel: slot, minutesLate: 5 });
    Utilities.sleep(400);
  });
  Logger.log('✓ 3 late-scan reminders');

  // ── 2. End-of-day card ──
  sendEndOfDayFlex(targetUserId);
  Utilities.sleep(400);
  Logger.log('✓ EOD card');

  // ── 3. Checkin approval Flex (out-of-radius) ──
  sendCheckinApprovalFlex(targetUserId, {
    empCode: emp.empCode, empName: emp.empName, empSubtitle: emp.empSubtitle,
    date: today, time: '09:15', kind: 'เช้า', slotNum: 1,
    distanceM: 250, radiusM: 150, geofenceOk: false,
    selfieInUrl: sampleSelfie, selfieOutUrl: '',
    refSelfieUrl: sampleRef,
    mapsUrl: 'https://maps.google.com/?q=18.8,99.0',
  });
  Utilities.sleep(400);
  Logger.log('✓ Checkin approval card (out of radius)');

  // ── 4. Decision acks for the approver ──
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'checkin', audience: 'approver',
    empCode: emp.empCode, empName: emp.empName, date: today,
    detail: 'ระยะห่างจากหน้างาน: 250 m',
    imageUrl: sampleSelfie, refImageUrl: sampleRef,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'rejected', kind: 'checkin', audience: 'approver',
    empCode: emp.empCode, empName: emp.empName, date: today,
    imageUrl: sampleSelfie, refImageUrl: sampleRef,
  });
  Utilities.sleep(400);

  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'leave', audience: 'approver',
    empCode: emp.empCode, empName: emp.empName, date: today, leaveType: 'ลาป่วย',
    detail: 'ป่วยปวดท้อง', imageUrl: sampleEvidence,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved_conditional', kind: 'leave', audience: 'approver',
    empCode: emp.empCode, empName: emp.empName, date: today, leaveType: 'ลาป่วย',
    detail: 'ต้องส่งใบรับรองแพทย์ภายหลัง', note: 'ต้องส่งหลักฐานภายใน 2026-05-15',
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'rejected', kind: 'leave', audience: 'approver',
    empCode: emp.empCode, empName: emp.empName, date: today, leaveType: 'ลากิจ',
    detail: 'งานเร่งสัปดาห์นี้',
  });
  Utilities.sleep(400);
  Logger.log('✓ 5 approver-side decision acks');

  // ── 5. Decision acks sent to the employee ──
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'checkin', audience: 'employee',
    empCode: emp.empCode, empName: emp.empName, date: today,
    imageUrl: sampleSelfie,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'rejected', kind: 'checkin', audience: 'employee',
    empCode: emp.empCode, empName: emp.empName, date: today,
    detail: 'กรุณาติดต่อหัวหน้าหากมีข้อสงสัย',
    imageUrl: sampleSelfie,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'leave', audience: 'employee',
    empCode: emp.empCode, empName: emp.empName, date: today, leaveType: 'ลาป่วย',
    imageUrl: sampleEvidence,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved_conditional', kind: 'leave', audience: 'employee',
    empCode: emp.empCode, empName: emp.empName, date: today, leaveType: 'ลาป่วย',
    note: 'ต้องส่งหลักฐานภายใน 2026-05-15',
    detailUri: 'https://liff.line.me/2010019987-1USGaEEO/respond.html?leave_id=LV-test&mode=evidence',
    imageUrl: sampleEvidence,
  });
  Utilities.sleep(400);
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'ot', audience: 'employee',
    empCode: emp.empCode, empName: emp.empName, date: today,
    detail: '18:00 – 21:00 (3 ชม.)',
  });
  Utilities.sleep(400);
  Logger.log('✓ 5 employee-side decision acks');

  // ── 6. HR change ack (no image) ──
  sendDecisionAckFlex(targetUserId, {
    decision: 'approved', kind: 'change', audience: 'approver',
    empCode: 'CHG-20260514-001',
  });
  Utilities.sleep(400);
  Logger.log('✓ HR change decision ack');

  // ── 7. Full Leave approval Flex (Owner perspective) ──
  sendApprovalFlex(targetUserId, {
    id: 'LV-test', level: 1, isLeave: true, requiredLevels: 2,
    empCode: emp.empCode, firstName: 'ปุย', lastName: 'โกปุย',
    department: 'IT', position: 'Developer',
    date: today, leaveType: 'sick',
    durationUnit: 'full_day', daysEquivalent: 1,
    reason: 'ปวดหัวมาก ต้องไปหาหมอ',
    isBackdated: false, isEmergency: true,
  });
  Utilities.sleep(400);
  Logger.log('✓ Leave approval Flex');

  // ── 8. OT approval Flex with salary + monthly accumulated ──
  sendApprovalFlex(targetUserId, {
    id: 'OT-test', level: 1, isLeave: false, requiredLevels: 1,
    empCode: emp.empCode, firstName: 'ปุย', lastName: 'โกปุย',
    department: 'IT', position: 'Developer',
    date: today, otType: 'weekday',
    startTime: '18:00', endTime: '21:00',
    reason: 'แก้ระบบเร่งด่วน',
    salary: {
      baseSalary: 15000, dailyRate: 500, hourlyRate: 62.5,
      otRate: 93.75, otHours: 3, otAmount: 281.25,
      thisMonth: {
        period: today.substring(0, 7),
        weekday: { hours: 9, amount: 843.75 },
        rest:    { hours: 0, amount: 0 },
        holiday: { hours: 0, amount: 0 },
        total: 843.75,
      },
    },
  });
  Utilities.sleep(400);
  Logger.log('✓ OT approval Flex (with salary + monthly accumulated)');

  // ── 9. HR change approval Flex ──
  sendChangeApprovalFlex(targetUserId, {
    change_id: 'CHG-test',
    action_type: 'allowance',
    action_op: 'create',
    summary: 'เพิ่มเบี้ยขยัน EMP001 = 500 บาท',
    submitted_by: 'HR Team',
  });
  Logger.log('✓ HR change approval Flex');

  Logger.log('==== Done — 18 Flex cards pushed to ' + targetUserId + ' ====');
}
