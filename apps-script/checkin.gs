/**
 * checkin.gs — Selfie check-in for tenants whose CHECKIN_MODE includes 'selfie'.
 *
 * Flow:
 *   Employee opens checkin.html → grant GPS → live camera → capture (with stamp) → submit
 *   Backend uploads selfie to Drive, computes distance from worksite,
 *   and upserts a row in Attendance_Raw (source='selfie').
 *
 *   First check-in of the day  → clock_in
 *   Any subsequent check-in    → updates clock_out + recomputes total_minutes
 *
 * Geofence: distance > radius does NOT block. It flags the row and (if approvers
 * are configured) sets approval_status='pending' for PR-3 Flex-card approval.
 */

const CHECKIN_SOURCE_ = 'selfie';

/**
 * Public entry, routed from Code.gs as 'submitCheckin'.
 * Body: { lat, lng, selfie_base64 }
 * Returns: { ok, clock_in, clock_out, total_minutes, distance_m, geofence_ok, approval_status }
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

  // Distance to worksite (haversine). Empty geofence settings = treat as inside.
  const refLat = Number(getSetting_('CHECKIN_GEOFENCE_LAT', ''));
  const refLng = Number(getSetting_('CHECKIN_GEOFENCE_LNG', ''));
  const radius = Number(getSetting_('CHECKIN_GEOFENCE_RADIUS_M', 150));
  let distanceM = 0;
  let inside = true;
  if (isFinite(refLat) && isFinite(refLng) && refLat !== 0 && refLng !== 0) {
    distanceM = Math.round(_haversineMeters_(lat, lng, refLat, refLng));
    inside = distanceM <= radius;
  }

  // Upload selfie. Burn happens client-side; we trust the stamp the client added
  // and store as-is — reject only on raw size.
  const url = uploadSelfieBase64_(selfie, 'daily', ctx.empCode);

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

  const approverList = _getCheckinApproverIds_();
  const hasApprovers = approverList.length > 0;
  const prevApprovalStatus = existing ? String(existing[idx.approval_status] || 'auto') : 'auto';
  let approvalStatus;
  let geofenceOk;
  let kind; // 'in' or 'out' — describes THIS punch

  let clockIn, clockOut, totalMinutes, selfieIn, selfieOut;
  if (!existing) {
    kind = 'in';
    // First check-in of the day — this is clock_in.
    clockIn = timeStr;
    clockOut = '';
    totalMinutes = '';
    selfieIn = url;
    selfieOut = '';
    geofenceOk = inside;
    approvalStatus = (inside || !hasApprovers) ? 'auto' : 'pending';

    const newRow = headers.map(h => {
      switch (h) {
        case 'emp_code':       return ctx.empCode;
        case 'date':           return dateStr;
        case 'clock_in':       return clockIn;
        case 'clock_out':      return clockOut;
        case 'total_minutes':  return totalMinutes;
        case 'source':         return CHECKIN_SOURCE_;
        case 'imported_at':    return formatDatetime_(now);
        case 'selfie_in_url':  return selfieIn;
        case 'selfie_out_url': return selfieOut;
        case 'lat':            return lat;
        case 'lng':            return lng;
        case 'distance_m':     return distanceM;
        case 'geofence_ok':    return geofenceOk ? 'TRUE' : 'FALSE';
        case 'approval_status':return approvalStatus;
        default:               return '';
      }
    });
    sheet.appendRow(newRow);
  } else {
    kind = 'out';
    // Subsequent check-in — overwrite clock_out + recompute total_minutes.
    clockIn = String(existing[idx.clock_in] || '');
    clockOut = timeStr;
    selfieIn = String(existing[idx.selfie_in_url] || url);
    selfieOut = url;
    const a = _hhmmToMin_(clockIn);
    const b = _hhmmToMin_(clockOut);
    totalMinutes = (a >= 0 && b >= 0) ? Math.max(0, b - a) : '';

    const prevOk = String(existing[idx.geofence_ok]) === 'TRUE';
    geofenceOk = prevOk && inside;
    // Once flagged, stays flagged — caller can request approval later.
    const prevStatus = String(existing[idx.approval_status] || 'auto');
    if (geofenceOk) {
      approvalStatus = prevStatus;
    } else if (prevStatus === 'approved' || prevStatus === 'rejected') {
      approvalStatus = prevStatus; // owner already decided
    } else {
      approvalStatus = hasApprovers ? 'pending' : 'auto';
    }

    sheet.getRange(rowNum, idx.clock_out + 1).setValue(clockOut);
    sheet.getRange(rowNum, idx.total_minutes + 1).setValue(totalMinutes);
    sheet.getRange(rowNum, idx.selfie_in_url + 1).setValue(selfieIn);
    sheet.getRange(rowNum, idx.selfie_out_url + 1).setValue(selfieOut);
    sheet.getRange(rowNum, idx.lat + 1).setValue(lat);
    sheet.getRange(rowNum, idx.lng + 1).setValue(lng);
    sheet.getRange(rowNum, idx.distance_m + 1).setValue(distanceM);
    sheet.getRange(rowNum, idx.geofence_ok + 1).setValue(geofenceOk ? 'TRUE' : 'FALSE');
    sheet.getRange(rowNum, idx.approval_status + 1).setValue(approvalStatus);
    sheet.getRange(rowNum, idx.imported_at + 1).setValue(formatDatetime_(now));
  }

  logAudit({
    action: 'CHECKIN_SELFIE',
    target_type: 'attendance',
    target_id: ctx.empCode + ':' + dateStr,
    actor_email: ctx.empCode,
    after: {
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
        kind, // 'in' or 'out'
        distanceM: distanceM,
        radiusM: radius,
        geofenceOk,
        selfieInUrl:  selfieIn,
        selfieOutUrl: selfieOut,
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
    clock_in: clockIn,
    clock_out: clockOut,
    total_minutes: totalMinutes,
    distance_m: distanceM,
    geofence_ok: geofenceOk,
    approval_status: approvalStatus,
    selfie_url: url,
  };
}

/**
 * Lightweight status query for the LIFF page header.
 * Returns today's selfie row summary, or empty fields if none yet.
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
      clock_in: String(r[idx.clock_in] || ''),
      clock_out: String(r[idx.clock_out] || ''),
      total_minutes: r[idx.total_minutes] || 0,
      geofence_ok: String(r[idx.geofence_ok]) === 'TRUE',
      approval_status: String(r[idx.approval_status] || 'auto'),
    };
  }
  return _emptyCheckinStatus_();
}

function _emptyCheckinStatus_() {
  return {
    date: formatDate_(new Date()),
    clock_in: '', clock_out: '', total_minutes: 0,
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

  // Notify the approver of success
  pushLineMessage(approverUserId,
    decision === 'approved'
      ? `✅ อนุมัติเช็คอิน ${empCode} วันที่ ${dateStr}`
      : `❌ ปฏิเสธเช็คอิน ${empCode} วันที่ ${dateStr}`);

  // Notify the employee
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
