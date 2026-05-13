/**
 * drive.gs — Evidence file upload to Google Drive.
 *
 * Frontend captures a photo (camera/library) → compresses → base64-encodes → POSTs here.
 * Backend decodes, creates a Drive file in the configured folder, and returns
 * a viewable link that can be stored as evidence_url.
 *
 * Properties needed:
 *   EVIDENCE_FOLDER_ID — Drive folder ID where uploads are stored (must be set
 *                        before first upload). Folder must be readable by the
 *                        Apps Script owner.
 */

/* ============================================================
 * Public entry — registered in Code.gs as 'uploadEvidence'
 * Body: { filename, mime_type, data_base64 }
 * Returns: { url, id, filename }
 * ============================================================ */
function uploadEvidence(payload, ctx) {
  const filename   = String(payload.filename   || '').trim();
  const mime       = String(payload.mime_type  || 'image/jpeg').trim();
  const dataBase64 = String(payload.data_base64 || '');

  if (!filename || !dataBase64) throw new Error('missing_fields');
  if (!/^image\//.test(mime)) throw new Error('only_image_allowed');

  // Reject oversize before decoding
  // base64 expands ~33% — 7MB base64 ≈ 5.25MB original
  if (dataBase64.length > 7 * 1024 * 1024) {
    throw new Error('file_too_large_max_5mb');
  }

  const folder = _getEvidenceFolder_();
  const ext = _extFromMime_(mime);
  const safeName = _sanitizeFilename_(filename, ext);
  const stamped = `${ctx.empCode || 'unknown'}_${formatDatetime_(new Date()).replace(/[: ]/g, '-')}_${safeName}`;

  const bytes = Utilities.base64Decode(dataBase64);
  const blob = Utilities.newBlob(bytes, mime, stamped);
  const file = folder.createFile(blob);
  // Anyone with the link can view — approver clicks the URL from Flex Message
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  logAudit({
    action: 'EVIDENCE_UPLOADED',
    target_type: 'drive_file',
    target_id: file.getId(),
    actor_email: ctx.empCode,
    after: { filename: stamped, size_bytes: bytes.length },
  });

  return {
    url: file.getUrl(),
    id: file.getId(),
    filename: stamped,
  };
}

function _getEvidenceFolder_() {
  const folderId = PropertiesService.getScriptProperties().getProperty('EVIDENCE_FOLDER_ID');
  if (!folderId) {
    throw new Error('evidence_folder_not_configured');
  }
  try {
    return DriveApp.getFolderById(folderId);
  } catch (e) {
    throw new Error('evidence_folder_not_accessible: ' + folderId);
  }
}

function _extFromMime_(mime) {
  switch (String(mime).toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':  return 'jpg';
    case 'image/png':  return 'png';
    case 'image/heic': return 'heic';
    case 'image/webp': return 'webp';
    default:           return 'bin';
  }
}

function _sanitizeFilename_(name, ext) {
  // Keep the original basename for context but force a safe form + correct ext
  const base = String(name)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\.[^.]+$/, '')   // strip extension
    .substring(0, 50)
    || 'photo';
  return `${base}.${ext}`;
}

/* ============================================================
 * Selfie check-in uploads — separate folder from evidence.
 * Folder is per-tenant, configured in Settings.CHECKIN_DRIVE_FOLDER_ID.
 * ============================================================ */

/**
 * Upload a base64 selfie image and return its shareable URL.
 *
 * If CHECKIN_DRIVE_FOLDER_ID is unset OR points to a folder the script
 * owner can't access, auto-create a fresh "Payroll Checkin Selfies"
 * folder in the script owner's My Drive and write its ID back into
 * Settings — so the next call resolves cleanly.
 *
 * @param {string} base64 — pure base64 (no `data:` prefix)
 * @param {string} kind — 'reference' | 'daily' | 'slot'
 * @param {string} empCode
 */
function uploadSelfieBase64_(base64, kind, empCode) {
  if (!base64) throw new Error('missing_selfie');
  if (base64.length > 7 * 1024 * 1024) throw new Error('selfie_too_large_max_5mb');

  const folder = _resolveCheckinFolder_();

  const stamp = formatDatetime_(new Date()).replace(/[: ]/g, '-');
  const filename = `${kind}_${empCode || 'unknown'}_${stamp}.jpg`;
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', filename);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function _resolveCheckinFolder_() {
  const folderId = String(getSetting_('CHECKIN_DRIVE_FOLDER_ID', '')).trim();
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); }
    catch (e) {
      console.warn('checkin folder not accessible (' + folderId + ') — falling back to auto-create');
    }
  }
  // Auto-create a folder in the script owner's My Drive and persist its ID.
  const folder = DriveApp.createFolder('Payroll Checkin Selfies (auto)');
  const newId = folder.getId();
  _writeSetting_('CHECKIN_DRIVE_FOLDER_ID', newId);
  console.info('Created and saved CHECKIN_DRIVE_FOLDER_ID = ' + newId);
  return folder;
}

function _writeSetting_(key, value) {
  const ss = getPublicSheet_();
  const sheet = ss.getSheetByName('Settings');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  // Key not found — append a new row
  sheet.appendRow([key, value, 'auto-created']);
}
