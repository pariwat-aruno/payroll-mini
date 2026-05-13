/**
 * line_api.gs — LINE integration: verify ID token, push messages,
 * lookup userId ↔ emp_code mapping.
 */

/**
 * Verify a LIFF ID token with LINE's API.
 *
 * Why this matters: clients can lie about their userId. The ID token
 * is signed by LINE; verifying it is the only way to trust who's calling.
 *
 * @returns {{ ok: true, userId, displayName, picture } | { ok: false, error }}
 */
function verifyIdToken(idToken) {
  if (!idToken) return { ok: false, error: 'missing_id_token' };

  // Cache verified result for 60s — idToken is good for an hour, but we re-verify
  // every minute as a safety margin in case LINE invalidates a session.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'vit:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  ).substring(0, 22);
  const hit = cache.get(cacheKey);
  if (hit) {
    try { return JSON.parse(hit); } catch (_) { /* fall through */ }
  }

  const channelId = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ID');
  if (!channelId) return { ok: false, error: 'channel_id_not_configured' };

  try {
    const response = UrlFetchApp.fetch(
      'https://api.line.me/oauth2/v2.1/verify',
      {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: {
          id_token: idToken,
          client_id: channelId,
        },
        muteHttpExceptions: true,
      }
    );
    const code = response.getResponseCode();
    const body = JSON.parse(response.getContentText());

    if (code !== 200) {
      return { ok: false, error: 'verify_failed: ' + (body.error_description || body.error || code) };
    }

    const result = {
      ok: true,
      userId: body.sub,
      displayName: body.name,
      picture: body.picture,
    };
    try { cache.put(cacheKey, JSON.stringify(result), 60); } catch (_) {}
    return result;
  } catch (err) {
    return { ok: false, error: 'verify_exception: ' + err };
  }
}

/**
 * Look up emp_code from LINE userId.
 *
 * Uses the LINE_User_Map tab in Secret Sheet.
 */
function lookupEmpCodeByUserId(userId) {
  if (!userId) return null;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'emp:' + userId;
  const hit = cache.get(cacheKey);
  if (hit !== null) return hit === '__null__' ? null : hit;

  const secret = getSecretSheet_();
  const map = readTab_(secret, 'LINE_User_Map');
  const row = map.find(r => r.line_user_id === userId);
  const empCode = row ? row.emp_code : null;
  try { cache.put(cacheKey, empCode || '__null__', 300); } catch (_) {}

  // Update last_seen only on cache miss (cuts the per-request write)
  if (row) _touchUserMapping(userId);
  return empCode;
}

function _touchUserMapping(userId) {
  try {
    const secret = getSecretSheet_();
    const sheet = secret.getSheetByName('LINE_User_Map');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf('line_user_id') + 1;
    const lastSeenCol = headers.indexOf('last_seen') + 1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][idCol - 1] === userId) {
        sheet.getRange(i + 1, lastSeenCol).setValue(formatDatetime_(new Date()));
        return;
      }
    }
  } catch (err) {
    // non-fatal
  }
}

/**
 * Map a userId to an emp_code (called during onboarding).
 */
function mapUserIdToEmployee(userId, empCode, displayName, role) {
  role = role || 'employee';
  const secret = getSecretSheet_();
  const sheet = secret.getSheetByName('LINE_User_Map');
  const existing = readTab_(secret, 'LINE_User_Map');

  // Check if userId already mapped
  if (existing.some(r => r.line_user_id === userId)) {
    throw new Error('userId already mapped');
  }
  // Check if empCode already taken
  if (existing.some(r => r.emp_code === empCode)) {
    throw new Error('emp_code already mapped to another userId');
  }

  appendRows_(secret, 'LINE_User_Map', [{
    line_user_id: userId,
    emp_code: empCode,
    role: role,
    display_name: displayName || '',
    mapped_at: formatDatetime_(new Date()),
    last_seen: formatDatetime_(new Date()),
  }]);

  logAudit({
    action: 'MAP_LINE_USER',
    target_type: 'line_user_map',
    target_id: userId,
    after: { emp_code: empCode, role: role },
  });
}

/**
 * Push a text message to a LINE userId.
 */
function pushText(userId, text) {
  const token = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');

  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: text }],
    }),
    muteHttpExceptions: true,
  });
}

/* ============================================================
 * Rich Menu management
 * ============================================================ */

/**
 * Link a rich menu to a specific user. Use after pairEmployee succeeds
 * to switch from the onboarding menu to the paired menu.
 *
 * @param {string} userId
 * @param {string} richMenuId  — leave empty to unlink (revert to default)
 */
function assignRichMenu_(userId, richMenuId) {
  if (!userId) return;
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) return;

  try {
    if (!richMenuId) {
      UrlFetchApp.fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu`, {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      });
      return;
    }
    const res = UrlFetchApp.fetch(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {
        method: 'post',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      }
    );
    if (res.getResponseCode() >= 400) {
      console.error('assignRichMenu failed: ' + res.getContentText());
    }
  } catch (e) {
    console.error('assignRichMenu exception: ' + e);
  }
}

/**
 * Admin helper — run once from the editor to discover rich menu IDs,
 * then paste them into Script Properties (RICHMENU_PAIRED_ID, etc).
 */
function listRichMenus() {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) { Logger.log('LINE_CHANNEL_ACCESS_TOKEN not set'); return; }
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = JSON.parse(res.getContentText());
  const list = body.richmenus || [];
  Logger.log(`Found ${list.length} rich menus:`);
  list.forEach(m => Logger.log(`  ${m.name || '(no name)'} → ${m.richMenuId}`));
  Logger.log('\nNext: Project Settings → Script Properties → add');
  Logger.log('  RICHMENU_PAIRED_ID  = <id of "Payroll Menu">');
  Logger.log('  (default Onboarding menu is set in LINE OA Manager — no property needed)');
  return list;
}

/**
 * Push a Flex Message to a LINE userId.
 *
 * @param {string} userId
 * @param {string} altText - shown in chat list
 * @param {object} contents - Flex Message contents object
 */
function pushFlex(userId, altText, contents) {
  const token = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');

  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'flex', altText: altText, contents: contents }],
    }),
    muteHttpExceptions: true,
  });
}

/**
 * Alias used by approval.gs and scheduler.gs.
 */
function pushLineMessage(userId, text) {
  return pushText(userId, text);
}

/**
 * Push a text message with Quick Reply buttons (postback actions).
 * Each item is { label, data } — tapping fires a postback event.
 *
 * @param {string} userId
 * @param {string} text — message body
 * @param {Array<{label:string, data:string}>} items — up to 13
 */
function pushQuickReply(userId, text, items) {
  const token = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');

  const quickReply = {
    items: (items || []).slice(0, 13).map(it => ({
      type: 'action',
      action: { type: 'postback', label: it.label, data: it.data, displayText: it.label },
    })),
  };

  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text, quickReply }],
    }),
    muteHttpExceptions: true,
  });
}

/**
 * Reverse lookup: emp_code → LINE userId.
 * Returns null if no mapping exists yet (employee hasn't onboarded).
 */
function lookupUserIdByEmpCode(empCode) {
  if (!empCode) return null;
  const cache = CacheService.getScriptCache();
  const cacheKey = 'uid:' + empCode;
  const hit = cache.get(cacheKey);
  if (hit !== null) return hit === '__null__' ? null : hit;

  const secret = getSecretSheet_();
  const map = readTab_(secret, 'LINE_User_Map');
  const row = map.find(r => r.emp_code === empCode);
  const userId = row ? row.line_user_id : null;
  try { cache.put(cacheKey, userId || '__null__', 300); } catch (_) {}
  return userId;
}

/**
 * Send a Flex Message with approve/reject buttons for a leave or OT request.
 * Used by approval.gs to request approval at any level.
 *
 * @param {string} approverUserId - LINE userId of the approver
 * @param {object} req - { id, level, isLeave, empCode, date, leaveType?, reason?,
 *                          requiredLevels, isBackdated, summary? }
 */
function sendApprovalFlex(approverUserId, req) {
  if (!approverUserId) return;
  // Approver may be stored as an emp_code (per Approval_Chain convention).
  // LINE userIds always start with 'U'; anything else gets resolved via LINE_User_Map.
  if (!String(approverUserId).startsWith('U')) {
    const resolved = lookupUserIdByEmpCode(approverUserId);
    if (!resolved) {
      console.warn('sendApprovalFlex: cannot resolve approver "' + approverUserId + '" — no LINE_User_Map entry');
      return;
    }
    approverUserId = resolved;
  }
  const action = req.isLeave ? 'leave' : 'ot';
  const title = req.isLeave ? '📝 ใบลาใหม่รออนุมัติ' : '⏰ ใบขอ OT รออนุมัติ';
  const levelTag = `(L${req.level}/${req.requiredLevels || req.level})`;
  const backdatedTag = req.isBackdated ? ' ⚠️ ย้อนหลัง' : '';

  const empName = (req.firstName || req.lastName)
    ? `${req.firstName || ''} ${req.lastName || ''}`.trim()
    : req.empCode || '-';
  const empSubtitle = [req.department, req.position].filter(Boolean).join(' · ') || '-';

  const bodyContents = [
    { type: 'text', text: title + backdatedTag, weight: 'bold', size: 'lg', wrap: true },
    { type: 'text', text: levelTag, size: 'xs', color: '#888888', margin: 'sm' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: empName, weight: 'bold', size: 'md', margin: 'md', wrap: true },
    { type: 'text', text: empSubtitle, size: 'xs', color: '#666666', wrap: true },
    { type: 'separator', margin: 'md' },
    _flexRow('วันที่', req.date || '-'),
  ];
  if (req.isLeave) {
    const leaveTypeLabels = {
      sick: 'ลาป่วย',
      personal: 'ลากิจ',
      vacation: 'พักร้อน',
      unpaid: 'ลาไม่รับเงิน',
      maternity: 'ลาคลอด',
    };
    const baseTypeLabel = leaveTypeLabels[req.leaveType] || req.leaveType || '-';
    const typeLabel = req.isEmergency ? `${baseTypeLabel} (ฉุกเฉิน)` : baseTypeLabel;
    bodyContents.push(_flexRow('ประเภท', typeLabel));

    // Duration row — always shown so approver sees full/half/hour at a glance
    bodyContents.push(_flexRow('ระยะเวลา', _formatDurationLabel_(req)));

    bodyContents.push(_flexRow('เหตุผล', req.reason || '-'));
  } else {
    // OT: type + time + reason
    const otTypeMap = {
      weekday: 'ล่วงเวลา (1.5×)',
      rest:    'ทำงานวันหยุด (+1×)',
      holiday: 'ล่วงเวลาในวันหยุด (3×)',
    };
    bodyContents.push(_flexRow('ประเภท', otTypeMap[req.otType] || req.otType || req.leaveType || '-'));
    if (req.startTime || req.endTime) {
      const isOvernight = req.endDate && req.date && req.endDate !== req.date;
      const timeLabel = isOvernight
        ? `${req.startTime || '?'} – ${req.endTime || '?'} (ข้ามคืน → ${req.endDate})`
        : `${req.startTime || '?'} – ${req.endTime || '?'}`;
      bodyContents.push(_flexRow('เวลา', timeLabel));
    }
    if (req.reason) bodyContents.push(_flexRow('เหตุผล', req.reason));
  }
  if (req.stats) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: `สถิติลาปีนี้ (${req.stats.year})`, size: 'xs', color: '#888888', margin: 'md', weight: 'bold' });
    ['sick', 'personal', 'vacation'].forEach(k => {
      const s = req.stats[k];
      const labelMap = { sick: 'ลาป่วย', personal: 'ลากิจ', vacation: 'พักร้อน' };
      _flexStatRow(bodyContents, labelMap[k], s);
    });
  }
  if (req.isBackdated) {
    bodyContents.push({
      type: 'text',
      text: '⚠️ คำขอย้อนหลัง — กรุณาตรวจสอบก่อนอนุมัติ',
      size: 'xs',
      color: '#B80000',
      wrap: true,
      margin: 'md',
    });
  }
  // Show info-request response when this Flex is a follow-up after employee responded
  if (req.infoRequestResponse) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({
      type: 'text',
      text: `📩 พนักงานตอบกลับ (รอบ ${req.infoRequestCount || 1})`,
      size: 'xs', color: '#888888', margin: 'md', weight: 'bold',
    });
    bodyContents.push({
      type: 'text',
      text: req.infoRequestResponse,
      size: 'sm', color: '#222222', margin: 'sm', wrap: true,
    });
  }

  // Footer: 2 buttons for OT, 4 buttons stacked for leave (approve / conditional / reject / info)
  const footerContents = [
    {
      type: 'button',
      style: 'primary',
      color: '#0F5132',
      action: {
        type: 'postback',
        label: '✅ อนุมัติ',
        data: `action=approve_${action}&id=${req.id}&level=${req.level}`,
        displayText: `อนุมัติ ${req.empCode} วันที่ ${req.date}`,
      },
    },
  ];
  if (req.isLeave) {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: '#856404',
      action: {
        type: 'postback',
        label: '✅⏳ อนุมัติแบบมีเงื่อนไข',
        data: `action=approve_conditional_leave&id=${req.id}&level=${req.level}`,
        displayText: `อนุมัติแบบมีเงื่อนไข ${req.empCode} วันที่ ${req.date}`,
      },
    });
  }
  footerContents.push({
    type: 'button',
    style: 'secondary',
    action: {
      type: 'postback',
      label: '❌ ปฏิเสธ',
      data: `action=reject_${action}&id=${req.id}&level=${req.level}`,
      displayText: `ปฏิเสธ ${req.empCode} วันที่ ${req.date}`,
    },
  });
  if (req.isLeave) {
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: {
        type: 'postback',
        label: 'ℹ️ ขอข้อมูลเพิ่ม',
        data: `action=request_info_leave&id=${req.id}&level=${req.level}`,
        displayText: `ขอข้อมูลเพิ่ม ${req.empCode} วันที่ ${req.date}`,
      },
    });
  }

  const flex = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents,
    },
  };
  pushFlex(approverUserId, title, flex);
}

/**
 * Build a human-readable duration label for the Flex body.
 * Always returns a string so 'ระยะเวลา' is visible for every leave.
 */
function _formatDurationLabel_(req) {
  const unit = req.durationUnit || 'full_day';
  if (unit === 'half_day') {
    const periodMap = { morning: 'เช้า', afternoon: 'บ่าย' };
    return `ครึ่งวัน (${periodMap[req.halfDayPeriod] || '-'})`;
  }
  if (unit === 'hour') {
    const hours = req.daysEquivalent ? (Number(req.daysEquivalent) * 8) : null;
    const hoursLabel = hours !== null ? ` (${Math.round(hours * 100) / 100} ชม.)` : '';
    return `${req.hourStart || '?'} – ${req.hourEnd || '?'}${hoursLabel}`;
  }
  // full_day
  const days = Number(req.daysEquivalent) || 1;
  return `เต็มวัน (${days} วัน)`;
}

/**
 * Flex Message for an HR-submitted change awaiting Owner approval.
 * @param {string} ownerUserId
 * @param {object} req — { change_id, action_type, action_op, summary, submitted_by }
 */
function sendChangeApprovalFlex(ownerUserId, req) {
  if (!ownerUserId) return;
  const opLabel = { create: 'เพิ่ม', update: 'แก้ไข', delete: 'ลบ' }[req.action_op] || req.action_op;
  const typeLabel = {
    allowance: 'เงินเพิ่ม/หัก',
    recurring_deduction: 'หักประจำ',
    holiday: 'วันหยุด',
    leave_quota: 'โควตาลา',
    employee: 'ข้อมูลพนักงาน',
  }[req.action_type] || req.action_type;

  const flex = {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '🔔 HR ขออนุมัติการเปลี่ยนแปลง', weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: `${opLabel}${typeLabel}`, size: 'sm', color: '#888888', margin: 'sm' },
        { type: 'separator', margin: 'md' },
        _flexRow('ผู้ขอ', req.submitted_by || '-'),
        { type: 'text', text: req.summary || '-', size: 'sm', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#0F5132',
          action: {
            type: 'postback',
            label: '✅ อนุมัติ',
            data: `action=approve_change&id=${encodeURIComponent(req.change_id)}`,
            displayText: `อนุมัติคำขอ ${req.change_id}`,
          },
        },
        { type: 'button', style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ ปฏิเสธ',
            data: `action=reject_change&id=${encodeURIComponent(req.change_id)}`,
            displayText: `ปฏิเสธคำขอ ${req.change_id}`,
          },
        },
      ],
    },
  };
  pushFlex(ownerUserId, '🔔 HR ขออนุมัติการเปลี่ยนแปลง', flex);
}

/**
 * Flex card for a selfie check-in flagged outside the geofence.
 * @param {string} approverUserId — LINE userId (must start with 'U')
 * @param {object} req
 *   { empCode, empName, empSubtitle, date, kind, time,
 *     distanceM, radiusM, geofenceOk,
 *     selfieInUrl, selfieOutUrl, refSelfieUrl, mapsUrl }
 */
function sendCheckinApprovalFlex(approverUserId, req) {
  if (!approverUserId) return;
  if (!String(approverUserId).startsWith('U')) {
    const resolved = lookupUserIdByEmpCode(approverUserId);
    if (!resolved) {
      console.warn('sendCheckinApprovalFlex: cannot resolve approver "' + approverUserId + '"');
      return;
    }
    approverUserId = resolved;
  }

  const title = '📍 เช็คอินนอกรัศมีหน้างาน';
  const bodyContents = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color: '#B91C1C' },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: req.empName || req.empCode || '-', weight: 'bold', size: 'md', margin: 'md', wrap: true },
    { type: 'text', text: req.empSubtitle || '', size: 'xs', color: '#666666', wrap: true },
    { type: 'separator', margin: 'md' },
    _flexRow('วันที่', req.date || '-'),
    _flexRow('เวลา', (req.kind === 'out' ? 'ออกงาน ' : 'เข้างาน ') + (req.time || '-')),
    _flexRow('ระยะห่าง', `${req.distanceM} m (เกิน ${req.radiusM} m)`),
  ];
  if (req.mapsUrl) {
    bodyContents.push({
      type: 'text',
      text: '🗺️ ดูตำแหน่งบนแผนที่',
      size: 'sm', color: '#0066CC', margin: 'sm',
      action: { type: 'uri', uri: req.mapsUrl },
    });
  }

  // Thumbnail row — selfie this punch + reference selfie side by side if both available
  const heroImgs = [];
  if (req.selfieOutUrl || req.selfieInUrl) {
    heroImgs.push({
      type: 'image',
      url: req.selfieOutUrl || req.selfieInUrl,
      size: 'full', aspectMode: 'cover', aspectRatio: '1:1', flex: 1,
      action: { type: 'uri', uri: req.selfieOutUrl || req.selfieInUrl },
    });
  }
  if (req.refSelfieUrl) {
    heroImgs.push({
      type: 'image',
      url: req.refSelfieUrl,
      size: 'full', aspectMode: 'cover', aspectRatio: '1:1', flex: 1,
      action: { type: 'uri', uri: req.refSelfieUrl },
    });
  }

  const flex = {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', contents: bodyContents,
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#0F5132',
          action: {
            type: 'postback',
            label: '✅ อนุมัติ',
            data: `action=approve_checkin&emp=${encodeURIComponent(req.empCode)}&date=${req.date}`,
            displayText: `อนุมัติเช็คอิน ${req.empCode} วันที่ ${req.date}`,
          } },
        { type: 'button', style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ ปฏิเสธ',
            data: `action=reject_checkin&emp=${encodeURIComponent(req.empCode)}&date=${req.date}`,
            displayText: `ปฏิเสธเช็คอิน ${req.empCode} วันที่ ${req.date}`,
          } },
      ],
    },
  };
  if (heroImgs.length) {
    flex.hero = {
      type: 'box', layout: 'horizontal', spacing: 'sm', contents: heroImgs,
    };
  }
  pushFlex(approverUserId, title, flex);
}

function _flexRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'sm',
    contents: [
      { type: 'text', text: label, color: '#888888', size: 'sm', flex: 2 },
      { type: 'text', text: String(value), wrap: true, size: 'sm', flex: 5 },
    ],
  };
}

/**
 * Push a reconcile summary as a Flex bubble.
 */
function sendReconcileSummaryFlex(ownerUserId, summary) {
  const TYPE_LABEL = {
    absent:                   'ขาดงาน',
    short_work:               'ทำงานไม่ครบ',
    ot_unrequested:           'OT ไม่ได้ขอ',
    weekend_work_unrequested: 'ทำงานวันหยุดไม่ได้ขอ',
    leave_pending:            'ลายังไม่อนุมัติ',
  };

  const bodyContents = [
    { type: 'text', text: 'สรุป Reconcile', weight: 'bold', size: 'lg' },
    { type: 'text', text: 'งวด ' + summary.period, size: 'xs', color: '#888888', margin: 'sm' },
    { type: 'separator', margin: 'md' },
    _flexRow('พนักงาน',         (summary.employees || 0) + ' คน'),
    _flexRow('แถวที่ reconcile', (summary.reconciledRows || 0) + ' แถว'),
    _flexRow('Escalation เปิด', (summary.openEscalations || 0) + ' รายการ'),
  ];

  const byTypeKeys = Object.keys(summary.byType || {});
  if (byTypeKeys.length) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: 'ตามประเภท', size: 'xs', color: '#888888', margin: 'md', weight: 'bold' });
    byTypeKeys.forEach(t => {
      bodyContents.push(_flexRow(TYPE_LABEL[t] || t, summary.byType[t] + ' ครั้ง'));
    });
  }

  if (summary.topEmployees && summary.topEmployees.length) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: 'พนักงาน Top 3 (escalation มากสุด)', size: 'xs', color: '#888888', margin: 'md', weight: 'bold', wrap: true });
    summary.topEmployees.forEach(e => {
      bodyContents.push(_flexRow(e.name, e.count + ' ครั้ง'));
    });
  }

  const flex = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: bodyContents },
  };
  pushFlex(ownerUserId, 'สรุป Reconcile ' + summary.period, flex);
}

function _flexStatRow(target, label, s) {
  if (!s) return;
  target.push({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'xs',
    contents: [
      { type: 'text', text: label, color: '#666666', size: 'xs', flex: 3 },
      { type: 'text', text: `${s.count} ครั้ง / ${s.days} วัน`, size: 'xs', flex: 5, align: 'end' },
    ],
  });
}
