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

    return {
      ok: true,
      userId: body.sub,
      displayName: body.name,
      picture: body.picture,
    };
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
  const secret = getSecretSheet_();
  const map = readTab_(secret, 'LINE_User_Map');
  const row = map.find(r => r.line_user_id === userId);
  if (!row) return null;
  // Update last_seen
  _touchUserMapping(userId);
  return row.emp_code;
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
 * Reverse lookup: emp_code → LINE userId.
 * Returns null if no mapping exists yet (employee hasn't onboarded).
 */
function lookupUserIdByEmpCode(empCode) {
  const secret = getSecretSheet_();
  const map = readTab_(secret, 'LINE_User_Map');
  const row = map.find(r => r.emp_code === empCode);
  return row ? row.line_user_id : null;
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
    bodyContents.push(_flexRow('ประเภท', req.leaveType || '-'));
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
      bodyContents.push(_flexRow('เวลา', `${req.startTime || '?'} – ${req.endTime || '?'}`));
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

  const flex = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
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
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ ปฏิเสธ',
            data: `action=reject_${action}&id=${req.id}&level=${req.level}`,
            displayText: `ปฏิเสธ ${req.empCode} วันที่ ${req.date}`,
          },
        },
      ],
    },
  };
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
