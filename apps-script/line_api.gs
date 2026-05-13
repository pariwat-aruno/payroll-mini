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
 * Recreate the paired rich menu with 4 buttons:
 *   สแกนหน้า · ลางาน · OT · เมนูทั้งหมด
 *
 * Run from the Apps Script editor any time you want to refresh the image or
 * tap actions. The function fetches the image from the Pages site
 * (frontend/src/richmenu-paired-4btn.png) — override by setting Script
 * Property RICHMENU_IMAGE_URL.
 *
 * After success: RICHMENU_PAIRED_ID is updated and every row in LINE_User_Map
 * is reassigned to the new menu so existing users see it immediately.
 */
function setupPairedRichMenu4() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');

  const liffId = props.getProperty('LIFF_ID') || '2010019987-1USGaEEO';
  const baseLiff = `https://liff.line.me/${liffId}`;
  const imageUrl = props.getProperty('RICHMENU_IMAGE_URL')
    || 'https://pariwat-aruno.github.io/payroll-mini/richmenu-paired-4btn.png';

  const config = {
    size: { width: 2500, height: 843 },
    selected: false,
    name: 'Payroll Paired 4btn',
    chatBarText: 'เมนู',
    areas: [
      { bounds: { x: 0,    y: 0, width: 625, height: 843 },
        action: { type: 'uri', label: 'สแกนหน้า',     uri: `${baseLiff}/checkin.html` } },
      { bounds: { x: 625,  y: 0, width: 625, height: 843 },
        action: { type: 'uri', label: 'ลางาน',        uri: `${baseLiff}/leave.html` } },
      { bounds: { x: 1250, y: 0, width: 625, height: 843 },
        action: { type: 'uri', label: 'OT',           uri: `${baseLiff}/ot.html` } },
      { bounds: { x: 1875, y: 0, width: 625, height: 843 },
        action: { type: 'uri', label: 'เมนูทั้งหมด',   uri: `${baseLiff}/index.html` } },
    ],
  };

  // 1. Create menu config
  const createRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(config),
    muteHttpExceptions: true,
  });
  if (createRes.getResponseCode() >= 400) {
    throw new Error('richmenu_create_failed: ' + createRes.getContentText());
  }
  const newId = JSON.parse(createRes.getContentText()).richMenuId;
  Logger.log('Created richmenu: ' + newId);

  // 2. Upload background image
  const imgBlob = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true }).getBlob();
  const uploadRes = UrlFetchApp.fetch(
    `https://api-data.line.me/v2/bot/richmenu/${newId}/content`,
    {
      method: 'post',
      contentType: 'image/png',
      headers: { Authorization: 'Bearer ' + token },
      payload: imgBlob.getBytes(),
      muteHttpExceptions: true,
    }
  );
  if (uploadRes.getResponseCode() >= 400) {
    // Roll back the empty menu we just created
    UrlFetchApp.fetch(`https://api.line.me/v2/bot/richmenu/${newId}`, {
      method: 'delete',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    throw new Error('richmenu_image_upload_failed: ' + uploadRes.getContentText());
  }
  Logger.log('Uploaded image to ' + newId);

  // 3. Delete old menu (if any)
  const oldId = props.getProperty('RICHMENU_PAIRED_ID');
  if (oldId && oldId !== newId) {
    UrlFetchApp.fetch(`https://api.line.me/v2/bot/richmenu/${oldId}`, {
      method: 'delete',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    Logger.log('Deleted old menu: ' + oldId);
  }

  // 4. Save new ID
  props.setProperty('RICHMENU_PAIRED_ID', newId);
  Logger.log('RICHMENU_PAIRED_ID = ' + newId);

  // 5. Reassign every paired user so they see the new menu immediately
  const secSs = getSecretSheet_();
  const map = readTab_(secSs, 'LINE_User_Map');
  let count = 0;
  map.forEach(r => {
    if (r.line_user_id) {
      assignRichMenu_(r.line_user_id, newId);
      count++;
    }
  });
  Logger.log(`Reassigned ${count} paired user(s) to new menu.`);

  return newId;
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

    // Money rows — only render for OWNER recipients (privacy: HR-level
    // approvers should not see salary even if they approve OT).
    if (req.salary && lookupEmpCodeByUserId(approverUserId) === 'OWNER') {
      const s = req.salary;
      bodyContents.push({ type: 'separator', margin: 'md' });
      bodyContents.push({
        type: 'text', text: 'ค่าตอบแทน', size: 'xs', color: '#888888',
        margin: 'md', weight: 'bold',
      });
      bodyContents.push(_flexRow('เงินเดือน',   _baht_(s.baseSalary) + '/เดือน'));
      bodyContents.push(_flexRow('ค่าจ้าง/วัน',  _baht_(s.dailyRate)));
      bodyContents.push(_flexRow('OT/ชม.',      _baht_(s.otRate)));
      bodyContents.push(_flexRow('จำนวน',       (Math.round(s.otHours * 100) / 100) + ' ชม.'));
      bodyContents.push({
        type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm',
        contents: [
          { type: 'text', text: 'รวมจ่าย OT', color: '#0F5132', size: 'sm', flex: 2, weight: 'bold' },
          { type: 'text', text: _baht_(s.otAmount), wrap: true, size: 'sm', flex: 5, weight: 'bold', color: '#0F5132' },
        ],
      });

      // Monthly accumulated (approved OTs in same calendar month)
      if (s.thisMonth) {
        const m = s.thisMonth;
        bodyContents.push({ type: 'separator', margin: 'md' });
        bodyContents.push({
          type: 'text', text: `OT สะสมเดือน ${m.period}`, size: 'xs', color: '#888888',
          margin: 'md', weight: 'bold',
        });
        bodyContents.push(_flexRow('ล่วงเวลา (1.5×)',
          `${(Math.round(m.weekday.hours * 10) / 10)} ชม. · ${_baht_(m.weekday.amount)}`));
        bodyContents.push(_flexRow('ทำงานวันหยุด',
          `${(Math.round(m.rest.hours * 10) / 10)} ชม. · ${_baht_(m.rest.amount)}`));
        bodyContents.push(_flexRow('วันหยุดนักขัตฤกษ์',
          `${(Math.round(m.holiday.hours * 10) / 10)} ชม. · ${_baht_(m.holiday.amount)}`));
        bodyContents.push({
          type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm',
          contents: [
            { type: 'text', text: 'รวมเดือนนี้', color: '#0F5132', size: 'sm', flex: 2, weight: 'bold' },
            { type: 'text', text: _baht_(m.total), size: 'sm', flex: 5, weight: 'bold', color: '#0F5132' },
          ],
        });
      }
    }
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
    _flexRow('สแกน', (req.kind || '') + (req.slotNum ? ` (${req.slotNum}/4)` : '')),
    _flexRow('เวลา', req.time || '-'),
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

  // Thumbnail row — selfie this punch + reference selfie side by side if both available.
  // Use Drive thumbnail endpoint (direct JPEG) — works even when the file isn't shared anyone-with-link.
  const heroImgs = [];
  const punchSrc = req.selfieOutUrl || req.selfieInUrl;
  if (punchSrc) {
    heroImgs.push({
      type: 'image',
      url: driveUrlToThumbnail_(punchSrc, 800),
      size: 'full', aspectMode: 'cover', aspectRatio: '1:1', flex: 1,
      action: { type: 'uri', uri: punchSrc },
    });
  }
  if (req.refSelfieUrl) {
    heroImgs.push({
      type: 'image',
      url: driveUrlToThumbnail_(req.refSelfieUrl, 800),
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

/**
 * Generic Flex acknowledgement for every approve/reject/info-request action.
 *
 * @param {string} userId — LINE userId or emp_code (auto-resolved via LINE_User_Map)
 * @param {object} p
 *   decision: 'approved' | 'approved_conditional' | 'rejected' | 'info_requested'
 *   kind:     'checkin' | 'leave' | 'ot' | 'change'
 *   audience: 'approver' | 'employee'
 *   empCode, empName?, date?, slot?, leaveType?, detail?
 *   imageUrl?    — Drive URL of attached photo (auto thumbnailed)
 *   detailUri?   — open-in-LIFF/Drive button
 *   note?        — extra text line, e.g. compliance deadline
 */
function sendDecisionAckFlex(userId, p) {
  if (!userId) return;
  if (!String(userId).startsWith('U')) {
    const resolved = lookupUserIdByEmpCode(userId);
    if (!resolved) {
      console.warn('sendDecisionAckFlex: cannot resolve "' + userId + '"');
      return;
    }
    userId = resolved;
  }

  const KIND_LABEL = {
    checkin: 'เช็คอิน',
    leave:   'ใบลา',
    ot:      'ใบขอ OT',
    change:  'คำขอเปลี่ยนแปลง',
  };
  const DECISION_META = {
    approved:             { icon: '✅',  color: '#0F5132', verb: 'อนุมัติ' },
    approved_conditional: { icon: '✅⏳', color: '#856404', verb: 'อนุมัติแบบมีเงื่อนไข' },
    rejected:             { icon: '❌',  color: '#B91C1C', verb: 'ปฏิเสธ' },
    info_requested:       { icon: 'ℹ️',  color: '#1E40AF', verb: 'ขอข้อมูลเพิ่ม' },
  };
  const meta = DECISION_META[p.decision] || DECISION_META.approved;
  const kindLabel = KIND_LABEL[p.kind] || p.kind;

  const title = p.audience === 'approver'
    ? `${meta.icon} คุณ${meta.verb}${kindLabel} ${p.empCode || ''}`.trim()
    : `${meta.icon} ${kindLabel}ของคุณ${p.decision === 'rejected' ? 'ถูก' : 'ได้รับ'}${meta.verb}`;

  const body = [
    { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color: meta.color },
    { type: 'separator', margin: 'md' },
  ];
  if (p.audience === 'approver' && (p.empName || p.empCode)) {
    body.push({
      type: 'text',
      text: [p.empCode, p.empName].filter(Boolean).join(' · '),
      weight: 'bold', size: 'md', wrap: true, margin: 'md',
    });
  }
  if (p.date)      body.push(_flexRow('วันที่', p.date));
  if (p.slot)      body.push(_flexRow('สแกน', p.slot));
  if (p.leaveType) body.push(_flexRow('ประเภท', p.leaveType));
  if (p.detail)    body.push({ type: 'text', text: p.detail, size: 'sm', wrap: true, margin: 'md', color: '#444444' });
  if (p.note)      body.push({ type: 'text', text: p.note, size: 'xs', wrap: true, margin: 'md', color: '#888888' });

  const flex = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: body } };

  if (p.imageUrl && p.refImageUrl) {
    // Side-by-side: capture + reference (for checkin)
    flex.hero = {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        { type: 'image', url: driveUrlToThumbnail_(p.imageUrl, 800),
          size: 'full', aspectMode: 'cover', aspectRatio: '1:1', flex: 1,
          action: { type: 'uri', uri: p.imageUrl } },
        { type: 'image', url: driveUrlToThumbnail_(p.refImageUrl, 800),
          size: 'full', aspectMode: 'cover', aspectRatio: '1:1', flex: 1,
          action: { type: 'uri', uri: p.refImageUrl } },
      ],
    };
  } else if (p.imageUrl) {
    flex.hero = {
      type: 'image',
      url: driveUrlToThumbnail_(p.imageUrl, 800),
      size: 'full', aspectMode: 'cover', aspectRatio: '4:3',
      action: { type: 'uri', uri: p.imageUrl },
    };
  }

  const footerBtns = [];
  if (p.imageUrl) {
    footerBtns.push({
      type: 'button', style: 'secondary',
      action: { type: 'uri', label: '🖼️ ดูรูปขนาดเต็ม', uri: p.imageUrl },
    });
  }
  if (p.detailUri) {
    footerBtns.push({
      type: 'button', style: 'secondary',
      action: { type: 'uri', label: '📄 ดูรายละเอียด', uri: p.detailUri },
    });
  }
  if (footerBtns.length) {
    flex.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerBtns };
  }

  pushFlex(userId, title, flex);
}

function _baht_(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ฿';
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
