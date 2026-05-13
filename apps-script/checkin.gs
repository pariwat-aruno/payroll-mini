/**
 * checkin.gs — 4-slot selfie check-in for tenants whose CHECKIN_MODE includes 'selfie'.
 *
 * Flow:
 *   Employee opens checkin.html → grant GPS → live camera → capture (with stamp) → submit
 *   Backend uploads selfie to Drive, computes distance from worksite,
 *   and fills the next empty slot (1..4) in Attendance_Raw for that emp+date.
 *
 *   slot1 = เช้า, slot2 = ก่อนเที่ยง, slot3 = หลังเที่ยง, slot4 = เย็น
 *
 *   clock_in mirrors slot1_time, clock_out mirrors the latest filled slot's time.
 *   selfie_in_url and selfie_out_url are aliases for backward compatibility.
 *
 * Geofence: out-of-radius does NOT block. It flags the row and (if approvers
 * are configured) sets approval_status='pending' for PR-3 Flex-card approval.
 */

const CHECKIN_SOURCE_ = 'selfie';
const CHECKIN_SLOT_LABELS_ = ['เช้า', 'ก่อนเที่ยง', 'หลังเที่ยง', 'เย็น'];
const CHECKIN_MAX_SLOTS_ = 4;

/**
 * Public entry, routed from Code.gs as 'submitCheckin'.
 * Body: { lat, lng, selfie_base64 }
 * Returns: { ok, slot, slot_label, clock_in, clock_out, total_minutes,
 *            distance_m, geofence_ok, approval_status, scan_count }
 */
function submitCheckin(payload, ctx) {
  const lat = Number(payload && payload.lat);
  const lng = Number(payload && payload.lng);
  const selfie = String(payload && payload.selfie_base64 || '');

  if (!isFinite(lat) || !isFinite(lng)) throw new Error('missing_location');
  if (!selfie) throw new Error('missing_selfie');
  if (!ctx.empCode) throw new Error('not_paired');

  const mode = String(getSetting_('CHECKIN_MODE', 'fingerprint')).toLowerCase();
  if (mode !== 'selfie' && mode !== 'both') throw new Error('selfie_checkin_disabled');

  const refLat = Number(getSetting_('CHECKIN_GEOFENCE_LAT', ''));
  const refLng = Number(getSetting_('CHECKIN_GEOFENCE_LNG', ''));
  const radius = Number(getSetting_('CHECKIN_GEOFENCE_RADIUS_M', 150));
  let distanceM = 0;
  let inside = true;
  if (isFinite(refLat) && isFinite(refLng) && refLat !== 0 && refLng !== 0) {
    distanceM = Math.round(_haversineMeters_(lat, lng, refLat, refLng));
    inside = distanceM <= radius;
  }

  const now = new Date();
  const dateStr = formatDate_(now);
  const timeStr = Utilities.formatDate(now, 'GMT+7', 'HH:mm');

  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Attendance_Raw');
  if (!sheet) throw new Error('attendance_raw_missing');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  // Find today's selfie row for this employee, if any.
  const last = sheet.getLastRow();
  let rowNum = -1;
  let existing = null;
  if (last >= 2) {
    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    for (let i = data.length - 1; i >= 0; i--) {
      const r = data[i];
      if (String(r[idx.emp_code]).trim().toUpperCase() !== ctx.empCode.toUpperCase()) continue;
      if (formatDate_(r[idx.date]) !== dateStr) continue;
      if (String(r[idx.source]) !== CHECKIN_SOURCE_) continue;
      rowNum = i + 2;
      existing = r;
      break;
    }
  }

  // Determine which slot we're filling
  const prevScanCount = existing ? Number(existing[idx.scan_count] || 0) : 0;
  if (prevScanCount >= CHECKIN_MAX_SLOTS_) {
    throw new Error('all_slots_filled');
  }
  const slotNum = prevScanCount + 1;
  const slotLabel = CHECKIN_SLOT_LABELS_[slotNum - 1];

  // Upload selfie now that we know we'll use it
  const url = uploadSelfieBase64_(selfie, 'slot' + slotNum, ctx.empCode);

  const approverList = _getCheckinApproverIds_();
  const hasApprovers = approverList.length > 0;
  const prevApprovalStatus = existing ? String(existing[idx.approval_status] || 'auto') : 'auto';

  // Compute new geofence_ok (AND across all scans)
  let geofenceOk;
  if (!existing) {
    geofenceOk = inside;
  } else {
    const prevOk = String(existing[idx.geofence_ok]) === 'TRUE';
    geofenceOk = prevOk && inside;
  }

  // Compute approval_status — sticky once decided, otherwise flip auto→pending on first flag.
  let approvalStatus;
  if (geofenceOk) {
    approvalStatus = prevApprovalStatus === 'auto' ? 'auto' : prevApprovalStatus;
  } else if (prevApprovalStatus === 'approved' || prevApprovalStatus === 'rejected') {
    approvalStatus = prevApprovalStatus;
  } else {
    approvalStatus = hasApprovers ? 'pending' : 'auto';
  }

  if (!existing) {
    // First scan of the day — insert new row, slot1 + clock_in are set
    const newRow = headers.map(h => {
      switch (h) {
        case 'emp_code':       return ctx.empCode;
        case 'date':           return dateStr;
        case 'clock_in':       return timeStr;
        case 'clock_out':      return '';
        case 'total_minutes':  return '';
        case 'source':         return CHECKIN_SOURCE_;
        case 'imported_at':    return formatDatetime_(now);
        case 'selfie_in_url':  return url;
        case 'selfie_out_url': return '';
        case 'lat':            return lat;
        case 'lng':            return lng;
        case 'distance_m':     return distanceM;
        case 'geofence_ok':    return geofenceOk ? 'TRUE' : 'FALSE';
        case 'approval_status':return approvalStatus;
        case 'slot1_time':     return timeStr;
        case 'slot1_url':      return url;
        case 'scan_count':     return 1;
        default:               return '';
      }
    });
    sheet.appendRow(newRow);
  } else {
    // Subsequent scan — fill slotN, update derived fields
    const slotTimeCol = idx['slot' + slotNum + '_time'] + 1;
    const slotUrlCol  = idx['slot' + slotNum + '_url']  + 1;
    sheet.getRange(rowNum, slotTimeCol).setValue(timeStr);
    sheet.getRange(rowNum, slotUrlCol).setValue(url);

    const clockIn = String(existing[idx.clock_in] || '');
    const startMin = _hhmmToMin_(clockIn);
    const endMin   = _hhmmToMin_(timeStr);
    const totalMinutes = (startMin >= 0 && endMin >= 0) ? Math.max(0, endMin - startMin) : '';

    sheet.getRange(rowNum, idx.clock_out + 1).setValue(timeStr);
    sheet.getRange(rowNum, idx.total_minutes + 1).setValue(totalMinutes);
    sheet.getRange(rowNum, idx.selfie_out_url + 1).setValue(url);
    sheet.getRange(rowNum, idx.lat + 1).setValue(lat);
    sheet.getRange(rowNum, idx.lng + 1).setValue(lng);
    sheet.getRange(rowNum, idx.distance_m + 1).setValue(distanceM);
    sheet.getRange(rowNum, idx.geofence_ok + 1).setValue(geofenceOk ? 'TRUE' : 'FALSE');
    sheet.getRange(rowNum, idx.approval_status + 1).setValue(approvalStatus);
    sheet.getRange(rowNum, idx.scan_count + 1).setValue(slotNum);
    sheet.getRange(rowNum, idx.imported_at + 1).setValue(formatDatetime_(now));
  }

  logAudit({
    action: 'CHECKIN_SELFIE',
    target_type: 'attendance',
    target_id: ctx.empCode + ':' + dateStr,
    actor_email: ctx.empCode,
    after: {
      slot: slotNum,
      slot_label: slotLabel,
      time: timeStr,
      distance_m: distanceM,
      geofence_ok: geofenceOk,
      approval_status: approvalStatus,
    },
  });

  // Notify approvers when status flips to pending (don't spam if already pending).
  if (approvalStatus === 'pending' && prevApprovalStatus !== 'pending' && approverList.length) {
    try {
      const emp = readTab_(ss, 'Employees').find(e =>
        String(e.emp_code).trim().toUpperCase() === ctx.empCode.toUpperCase());
      const empName = emp ? `${emp.first_name || ''} ${emp.last_name || ''}`.trim() : ctx.empCode;
      const empSubtitle = emp ? [emp.department, emp.position].filter(Boolean).join(' · ') : '';
      const flexReq = {
        empCode: ctx.empCode,
        empName,
        empSubtitle,
        date: dateStr,
        time: timeStr,
        kind: slotLabel,
        slotNum,
        distanceM: distanceM,
        radiusM: radius,
        geofenceOk,
        selfieInUrl:  url, // latest scan that triggered the flag
        selfieOutUrl: '',
        refSelfieUrl: emp && emp.reference_selfie_url,
        mapsUrl: `https://maps.google.com/?q=${lat},${lng}`,
      };
      approverList.forEach(uid => {
        try { sendCheckinApprovalFlex(uid, flexReq); }
        catch (e) { console.error('checkin flex push failed for ' + uid + ': ' + e); }
      });
    } catch (e) {
      console.error('checkin approval notify failed: ' + e);
    }
  }

  return {
    ok: true,
    date: dateStr,
    slot: slotNum,
    slot_label: slotLabel,
    clock_in: existing ? String(existing[idx.clock_in] || '') : timeStr,
    clock_out: slotNum === 1 ? '' : timeStr,
    total_minutes: (function () {
      if (slotNum === 1) return 0;
      const start = _hhmmToMin_(String(existing[idx.clock_in] || ''));
      const end   = _hhmmToMin_(timeStr);
      return (start >= 0 && end >= 0) ? Math.max(0, end - start) : 0;
    })(),
    distance_m: distanceM,
    geofence_ok: geofenceOk,
    approval_status: approvalStatus,
    scan_count: slotNum,
    selfie_url: url,
  };
}

/**
 * Lightweight status query for the LIFF page header.
 * Returns today's selfie row summary with per-slot times.
 */
function getCheckinStatus(payload, ctx) {
  if (!ctx.empCode) throw new Error('not_paired');
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Attendance_Raw');
  if (!sheet) return _emptyCheckinStatus_();
  const last = sheet.getLastRow();
  if (last < 2) return _emptyCheckinStatus_();

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const dateStr = formatDate_(new Date());
  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i];
    if (String(r[idx.emp_code]).trim().toUpperCase() !== ctx.empCode.toUpperCase()) continue;
    if (formatDate_(r[idx.date]) !== dateStr) continue;
    if (String(r[idx.source]) !== CHECKIN_SOURCE_) continue;
    return {
      date: dateStr,
      slot_labels: CHECKIN_SLOT_LABELS_,
      slot_times: [
        String(r[idx.slot1_time] || ''),
        String(r[idx.slot2_time] || ''),
        String(r[idx.slot3_time] || ''),
        String(r[idx.slot4_time] || ''),
      ],
      clock_in: String(r[idx.clock_in] || ''),
      clock_out: String(r[idx.clock_out] || ''),
      total_minutes: r[idx.total_minutes] || 0,
      scan_count: Number(r[idx.scan_count] || 0),
      geofence_ok: String(r[idx.geofence_ok]) === 'TRUE',
      approval_status: String(r[idx.approval_status] || 'auto'),
    };
  }
  return _emptyCheckinStatus_();
}

function _emptyCheckinStatus_() {
  return {
    date: formatDate_(new Date()),
    slot_labels: CHECKIN_SLOT_LABELS_,
    slot_times: ['', '', '', ''],
    clock_in: '', clock_out: '', total_minutes: 0,
    scan_count: 0,
    geofence_ok: true, approval_status: 'auto',
  };
}

/**
 * Owner taps Approve / Reject on the Flex card.
 * Called from Code.gs::_handlePostback when action is approve_checkin / reject_checkin.
 */
function handleCheckinApprovalAction(approverUserId, params) {
  const decision = params.action === 'approve_checkin' ? 'approved' : 'rejected';
  const empCode = String(params.emp || '').trim().toUpperCase();
  const dateStr = String(params.date || '').trim();
  if (!empCode || !dateStr) {
    pushLineMessage(approverUserId, '⚠️ ข้อมูลไม่ครบ — ทำรายการไม่ได้');
    return;
  }

  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Attendance_Raw');
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {}; headers.forEach((h, i) => { idx[h] = i; });
  const last = sheet.getLastRow();
  if (last < 2) {
    pushLineMessage(approverUserId, '⚠️ ไม่พบรายการเช็คอิน');
    return;
  }

  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  let rowNum = -1;
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i];
    if (String(r[idx.emp_code]).trim().toUpperCase() !== empCode) continue;
    if (formatDate_(r[idx.date]) !== dateStr) continue;
    if (String(r[idx.source]) !== CHECKIN_SOURCE_) continue;
    rowNum = i + 2;
    break;
  }
  if (rowNum < 0) {
    pushLineMessage(approverUserId, `⚠️ ไม่พบเช็คอินของ ${empCode} วันที่ ${dateStr}`);
    return;
  }

  sheet.getRange(rowNum, idx.approval_status + 1).setValue(decision);

  logAudit({
    action: decision === 'approved' ? 'CHECKIN_APPROVED' : 'CHECKIN_REJECTED',
    target_type: 'attendance',
    target_id: empCode + ':' + dateStr,
    actor_email: lookupEmpCodeByUserId(approverUserId) || approverUserId,
    after: { approval_status: decision },
  });

  pushLineMessage(approverUserId,
    decision === 'approved'
      ? `✅ อนุมัติเช็คอิน ${empCode} วันที่ ${dateStr}`
      : `❌ ปฏิเสธเช็คอิน ${empCode} วันที่ ${dateStr}`);

  const empUserId = lookupUserIdByEmpCode(empCode);
  if (empUserId) {
    pushLineMessage(empUserId,
      decision === 'approved'
        ? `✅ เช็คอินวันที่ ${dateStr} ได้รับการอนุมัติแล้ว`
        : `❌ เช็คอินวันที่ ${dateStr} ไม่ได้รับอนุมัติ — กรุณาติดต่อหัวหน้า`);
  }
}

function _getCheckinApproverIds_() {
  return String(getSetting_('CHECKIN_APPROVER_USERIDS', ''))
    .split(',').map(s => s.trim()).filter(Boolean);
}

/** Distance in meters between two lat/lng pairs (haversine). */
function _haversineMeters_(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _hhmmToMin_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}
