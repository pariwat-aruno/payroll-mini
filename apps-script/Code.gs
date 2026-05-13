/**
 * Code.gs — Entry point for HTTP requests
 *
 * doPost is the only public-facing handler. doGet is intentionally
 * minimal (we host the frontend on GitHub Pages, not here).
 *
 * Request shape:
 *   { action: string, idToken: string, payload: object }
 *
 * Response shape:
 *   { ok: true, data: any } | { ok: false, error: string }
 */

/**
 * doPost — main router. All LIFF actions land here.
 */
function doPost(e) {
  let request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (err) {
    return _jsonResponse({ ok: false, error: 'invalid_json' });
  }

  // === Branch 1: LINE Messaging API webhook (postback from Flex buttons) ===
  // LINE webhook payload has shape: { destination, events: [...] }
  if (request && Array.isArray(request.events)) {
    return _handleLineWebhook(request);
  }

  // === Branch 2: LIFF action request ===
  const { action, idToken, payload } = request || {};

  if (!action) {
    return _jsonResponse({ ok: false, error: 'missing_action' });
  }

  // Actions that work without an empCode mapping (used during onboarding/pair flow)
  const ACTIONS_NO_MAPPING = ['pairEmployee', 'getMe'];

  // Verify identity (except for actions that don't need auth, like ping)
  let userContext = null;
  if (action !== 'ping') {
    const verifyResult = verifyIdToken(idToken);
    if (!verifyResult.ok) {
      logAudit({
        action: 'AUTH_FAILED',
        target_type: 'request',
        target_id: action,
        reason: verifyResult.error,
      });
      return _jsonResponse({ ok: false, error: 'auth_failed' });
    }
    userContext = {
      userId: verifyResult.userId,
      empCode: lookupEmpCodeByUserId(verifyResult.userId),
    };
    if (!userContext.empCode && !ACTIONS_NO_MAPPING.includes(action)) {
      return _jsonResponse({ ok: false, error: 'employee_not_mapped' });
    }
  }

  try {
    const handler = _getHandler(action);
    if (!handler) {
      return _jsonResponse({ ok: false, error: 'unknown_action' });
    }
    const data = handler(payload || {}, userContext);
    return _jsonResponse({ ok: true, data });
  } catch (err) {
    console.error(err);
    logAudit({
      action: 'HANDLER_ERROR',
      target_type: 'request',
      target_id: action,
      reason: String(err),
    });
    return _jsonResponse({ ok: false, error: 'internal_error' });
  }
}

/**
 * doGet — health check only. Frontend lives on GitHub Pages.
 */
function doGet(e) {
  return _jsonResponse({
    ok: true,
    service: 'payroll-mini-backend',
    version: '0.1.0',
  });
}

/**
 * Map of action → handler function
 *
 * Adding a new action:
 *   1. Implement the handler function (in reconcile.gs, payroll.gs, etc.)
 *   2. Add it to this map
 *   3. Document in CLAUDE.md API contract section
 */
function _getHandler(action) {
  const handlers = {
    ping: () => ({ pong: true, time: new Date().toISOString() }),
    getMe: handleGetMe,
    invalidateCache: handleInvalidateCache,

    // Leave & OT
    submitLeave: handleSubmitLeave,
    submitOT: handleSubmitOT,
    getMyQuota: handleGetMyQuota,
    getMyHistory: handleGetMyHistory,
    respondInfoRequest: handleRespondInfoRequest,
    submitConditionalEvidence: handleSubmitConditionalEvidence,
    getLeaveForRespond: handleGetLeaveForRespond,
    uploadEvidence: handleUploadEvidence,

    // Selfie check-in
    uploadCheckinSelfie:(p, c) => uploadCheckinSelfie(p, c),
    submitCheckin:      (p, c) => submitCheckin(p, c),
    getCheckinStatus:   (p, c) => getCheckinStatus(p, c),

    // HR / Admin (HR or Owner role required)
    hrListEmployees:    handleHrListEmployees,
    hrUpsertEmployee:   handleHrUpsertEmployee,
    hrListAllowances:   handleHrListAllowances,
    hrUpsertAllowance:  handleHrUpsertAllowance,
    hrDeleteAllowance:  handleHrDeleteAllowance,
    hrListRecurringDeductions:  handleHrListRecurringDeductions,
    hrUpsertRecurringDeduction: handleHrUpsertRecurringDeduction,
    hrDeleteRecurringDeduction: handleHrDeleteRecurringDeduction,
    hrListHolidays:     handleHrListHolidays,
    hrUpsertHoliday:    handleHrUpsertHoliday,
    hrDeleteHoliday:    handleHrDeleteHoliday,
    hrListLeaveQuota:   handleHrListLeaveQuota,
    hrUpsertLeaveQuota: handleHrUpsertLeaveQuota,
    listPendingChanges:    handleListPendingChanges,
    approvePendingChange:  handleApprovePendingChange,
    rejectPendingChange:   handleRejectPendingChange,

    // Owner-only — handler enforces role check internally
    runReconcile: handleRunReconcile,
    listEscalations: handleListEscalations,
    resolveEscalation: handleResolveEscalation,
    listPendingApprovals: handleListPendingApprovals,
    actOnApproval: handleActOnApproval,
    runPayroll: handleRunPayroll,

    // Onboarding
    onboardEmployee:  handleOnboardEmployee,
    listEmployees:    handleListEmployees,
    pairEmployee:     handlePairEmployee,

    // Slip access (employee sees own only)
    getMySlip: handleGetMySlip,
    listMyPeriods: handleListMyPeriods,
    getMySlipPdf: handleGetMySlipPdf,
  };
  return handlers[action] || null;
}

/**
 * Helper: build a JSON response.
 *
 * IMPORTANT: We deliberately do NOT use ContentService MIME JSON because
 * with the CORS-safe text/plain trick on the client, the server's
 * Content-Type doesn't matter for the response — but using TEXT here
 * keeps logs cleaner and avoids any browser interpretation surprises.
 */
function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * Stub handlers — real implementations live in reconcile.gs etc.
 * ============================================================ */

function handleSubmitLeave(payload, ctx) {
  // implemented in reconcile.gs
  return submitLeave(payload, ctx);
}

function handleSubmitOT(payload, ctx) {
  return submitOT(payload, ctx);
}

function handleGetMyQuota(payload, ctx) {
  return getMyQuota(ctx.empCode);
}

function handleGetMyHistory(payload, ctx) {
  return getMyHistory(ctx.empCode, payload.limit);
}

function handleRespondInfoRequest(payload, ctx) {
  return respondInfoRequest(payload, ctx);
}

function handleSubmitConditionalEvidence(payload, ctx) {
  return submitConditionalEvidence(payload, ctx);
}

function handleGetLeaveForRespond(payload, ctx) {
  return getLeaveForRespond(payload, ctx);
}

function handleUploadEvidence(payload, ctx) {
  return uploadEvidence(payload, ctx);
}

function handleHrListEmployees(payload, ctx)             { _requireHrOrOwner_(ctx); return hrListEmployees(); }
function handleHrUpsertEmployee(payload, ctx)            { _requireHrOrOwner_(ctx); return hrUpsertEmployee(payload, ctx); }
function handleHrListAllowances(payload, ctx)            { _requireHrOrOwner_(ctx); return hrListAllowances(payload); }
function handleHrUpsertAllowance(payload, ctx)           { _requireHrOrOwner_(ctx); return hrUpsertAllowance(payload, ctx); }
function handleHrDeleteAllowance(payload, ctx)           { _requireHrOrOwner_(ctx); return hrDeleteAllowance(payload, ctx); }
function handleHrListRecurringDeductions(payload, ctx)   { _requireHrOrOwner_(ctx); return hrListRecurringDeductions(); }
function handleHrUpsertRecurringDeduction(payload, ctx)  { _requireHrOrOwner_(ctx); return hrUpsertRecurringDeduction(payload, ctx); }
function handleHrDeleteRecurringDeduction(payload, ctx)  { _requireHrOrOwner_(ctx); return hrDeleteRecurringDeduction(payload, ctx); }
function handleHrListHolidays(payload, ctx)              { _requireHrOrOwner_(ctx); return hrListHolidays(); }
function handleHrUpsertHoliday(payload, ctx)             { _requireHrOrOwner_(ctx); return hrUpsertHoliday(payload, ctx); }
function handleHrDeleteHoliday(payload, ctx)             { _requireHrOrOwner_(ctx); return hrDeleteHoliday(payload, ctx); }
function handleHrListLeaveQuota(payload, ctx)            { _requireHrOrOwner_(ctx); return hrListLeaveQuota(payload); }
function handleHrUpsertLeaveQuota(payload, ctx)          { _requireHrOrOwner_(ctx); return hrUpsertLeaveQuota(payload, ctx); }
function handleListPendingChanges(payload, ctx)          { _requireHrOrOwner_(ctx); return listPendingChanges(payload, ctx); }
function handleApprovePendingChange(payload, ctx)        { _requireHrOrOwner_(ctx); return approvePendingChange(payload, ctx); }
function handleRejectPendingChange(payload, ctx)         { _requireHrOrOwner_(ctx); return rejectPendingChange(payload, ctx); }

function handleRunReconcile(payload, ctx) {
  _requireOwner(ctx);
  return runReconcileWithSummary(payload.period, ctx.userId);
}

function handleListEscalations(payload, ctx) {
  _requireOwner(ctx);
  return listEscalations(payload.period);
}

function handleResolveEscalation(payload, ctx) {
  _requireOwner(ctx);
  return resolveEscalation(payload.esc_id, payload.resolution, ctx);
}

function handleListPendingApprovals(payload, ctx) {
  _requireOwner(ctx);
  return listPendingApprovals(ctx.userId);
}

function handleActOnApproval(payload, ctx) {
  _requireOwner(ctx);
  return actOnApproval(payload, ctx);
}

function handleRunPayroll(payload, ctx) {
  _requireOwner(ctx);
  return runPayroll(payload.period, { force: !!payload.force });
}

function handleOnboardEmployee(payload, ctx) {
  _requireOwner(ctx);
  return onboardEmployee(payload);
}

function handleListEmployees(payload, ctx) {
  _requireOwner(ctx);
  return listEmployees();
}

function handlePairEmployee(payload, ctx) {
  return pairEmployee(payload, ctx);
}

function handleGetMySlip(payload, ctx) {
  return getMySlip(ctx.empCode, payload.period);
}

function handleListMyPeriods(payload, ctx) {
  return listMyPeriods(ctx.empCode);
}

function handleGetMySlipPdf(payload, ctx) {
  return getMySlipPdf(ctx.empCode, payload.period);
}

function handleGetMe(payload, ctx) {
  // Look up role from LINE_User_Map so the home page can decide which cards to show
  let role = '';
  try {
    const map = readTab_(getSecretSheet_(), 'LINE_User_Map');
    const r = map.find(m => m.line_user_id === ctx.userId);
    if (r) role = String(r.role || '').toLowerCase();
  } catch (_) { /* role optional; default to '' */ }
  return {
    emp_code: ctx.empCode,
    user_id:  ctx.userId,
    role,
    is_owner: ctx.empCode === 'OWNER' || role === 'owner',
    is_hr:    role === 'hr' || role === 'owner' || ctx.empCode === 'OWNER',
  };
}

/**
 * Owner-only: clear all CacheService entries.
 * Useful after editing LINE_User_Map / settings while debugging.
 */
function handleInvalidateCache(payload, ctx) {
  _requireOwner(ctx);
  CacheService.getScriptCache().removeAll(['vit:', 'emp:', 'uid:']);  // best-effort
  // Also clear by listing — Apps Script CacheService doesn't expose iteration, so
  // we just nuke a fixed set of well-known prefixes if caller supplies them.
  return { ok: true, hint: 'Cache cleared. Some entries (with hashed keys) will expire on TTL.' };
}

/**
 * Throws if context is not the owner.
 */
function _requireOwner(ctx) {
  const ownerEmail = PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  // Owner identification: we map their LINE userId to a special row in LINE_User_Map
  // with role='owner'. Or check if their email matches OWNER_EMAIL.
  // For simplicity in MVP: check if empCode is the special string 'OWNER'.
  if (ctx.empCode !== 'OWNER') {
    throw new Error('forbidden_owner_only');
  }
}

/**
 * Handle LINE Messaging API webhook events.
 *
 * The webhook URL must be set in LINE Developers Console → Messaging API
 * → Webhook URL = the same /exec URL as this Apps Script Web App.
 * (LINE will POST events here when users tap buttons, send messages, etc.)
 *
 * For approval flow, we only care about `postback` events from the
 * Flex Message buttons sent by sendApprovalFlex().
 */
function _handleLineWebhook(body) {
  try {
    (body.events || []).forEach(event => {
      if (event.type === 'postback') {
        _handlePostback(event);
      } else if (event.type === 'message' && event.message && event.message.type === 'text') {
        _handleTextMessage(event);
      }
      // Other event types ignored for now
    });
  } catch (err) {
    console.error('Webhook handler error: ' + err);
    logAudit({
      action: 'WEBHOOK_ERROR',
      target_type: 'webhook',
      target_id: '',
      reason: String(err),
    });
  }
  return _jsonResponse({ ok: true });
}

/**
 * Handle text messages sent to the OA. Owner-only commands for now.
 * Examples:
 *   /reconcile           → run for previous month
 *   /reconcile 2026-05   → run for that period
 *   /help                → list commands
 */
function _handleTextMessage(event) {
  const userId = event.source && event.source.userId;
  const text = ((event.message && event.message.text) || '').trim();
  if (!userId || !text) return;

  // Pending info-request "อื่นๆ" capture: if approver is in free-text mode,
  // treat this message as the info-request message and dispatch.
  if (consumePendingInfoRequest(userId, text)) return;

  const empCode = lookupEmpCodeByUserId(userId);
  // Only owner has chat commands; everyone else is silent.
  if (empCode !== 'OWNER') return;

  // /reconcile [YYYY-MM]
  let m = text.match(/^\/?reconcile(?:\s+(\d{4}-\d{2}))?\s*$/i);
  if (m) {
    try {
      runReconcileWithSummary(m[1] || null, userId);
    } catch (e) {
      pushLineMessage(userId, 'Reconcile ผิดพลาด: ' + e.message);
    }
    return;
  }

  // /payroll [YYYY-MM] [force]
  m = text.match(/^\/?payroll(?:\s+(\d{4}-\d{2}))?(\s+force)?\s*$/i);
  if (m) {
    let period = m[1];
    if (!period) {
      const today = new Date();
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      period = Utilities.formatDate(prev, 'GMT+7', 'yyyy-MM');
    }
    try {
      const result = runPayroll(period, { force: !!m[2] });
      pushLineMessage(userId,
        `Payroll งวด ${period} เสร็จ\n` +
        `พนักงาน: ${result.employees_processed} คน\n` +
        `Total gross: ${result.total_gross.toLocaleString()}\n` +
        `Total net: ${result.total_net.toLocaleString()}` +
        (result.skipped.length ? `\nSkipped: ${result.skipped.length} (${result.skipped.map(s => s.emp_code + ':' + s.reason).join(', ')})` : ''));
    } catch (e) {
      pushLineMessage(userId, 'Payroll ผิดพลาด: ' + e.message);
    }
    return;
  }

  if (/^\/?help\s*$/i.test(text)) {
    pushLineMessage(userId,
      'คำสั่ง:\n' +
      '/reconcile — รัน reconcile เดือนก่อน\n' +
      '/reconcile YYYY-MM — รันงวดที่ระบุ\n' +
      '/payroll — คำนวณ payroll เดือนก่อน\n' +
      '/payroll YYYY-MM — คำนวณงวดที่ระบุ\n' +
      '/payroll YYYY-MM force — บังคับเขียนทับ (ผ่าน lock)\n' +
      '/help — แสดงคำสั่งนี้'
    );
    return;
  }
}

function _handlePostback(event) {
  const userId = event.source && event.source.userId;
  const dataStr = event.postback && event.postback.data;
  if (!userId || !dataStr) return;

  // Parse data: action=approve_leave&id=LV-xxx&level=1
  const params = {};
  dataStr.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    params[k] = decodeURIComponent(v || '');
  });

  if (!params.action) return;

  // Route to approval handler
  if (['approve_leave', 'reject_leave', 'approve_ot', 'reject_ot',
       'approve_conditional_leave'].includes(params.action)) {
    handleApprovalAction(userId, params);
    return;
  }
  // PR-3.1: Info request flow
  if (params.action === 'request_info_leave') {
    handleInfoRequestPrompt(userId, params);
    return;
  }
  if (params.action === 'info_msg_leave') {
    // params.msg is one of 'evidence' | 'reason' | 'other'
    handleInfoRequestSelect(userId, params);
    return;
  }
  // HR change approval (Owner taps approve/reject from Flex)
  if (params.action === 'approve_change' || params.action === 'reject_change') {
    handlePendingChangePostback_(userId, params);
    return;
  }
  // Selfie check-in approval (geofence flag)
  if (params.action === 'approve_checkin' || params.action === 'reject_checkin') {
    handleCheckinApprovalAction(userId, params);
    return;
  }
}

function handlePendingChangePostback_(userId, params) {
  // Build a minimal ctx from userId
  const ctx = { userId, empCode: lookupEmpCodeByUserId(userId) };
  try {
    const fn = params.action === 'approve_change' ? approvePendingChange : rejectPendingChange;
    fn({ change_id: params.id }, ctx);
    pushLineMessage(userId,
      params.action === 'approve_change'
        ? '✅ อนุมัติคำขอเรียบร้อยแล้ว'
        : '❌ ปฏิเสธคำขอเรียบร้อยแล้ว');
  } catch (err) {
    pushLineMessage(userId, '⚠️ ทำรายการไม่สำเร็จ: ' + (err.message || err));
  }
}
