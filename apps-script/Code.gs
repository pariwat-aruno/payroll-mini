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
    if (!userContext.empCode) {
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

    // Leave & OT
    submitLeave: handleSubmitLeave,
    submitOT: handleSubmitOT,
    getMyQuota: handleGetMyQuota,
    getMyHistory: handleGetMyHistory,

    // Owner-only — handler enforces role check internally
    runReconcile: handleRunReconcile,
    listEscalations: handleListEscalations,
    resolveEscalation: handleResolveEscalation,
    listPendingApprovals: handleListPendingApprovals,
    actOnApproval: handleActOnApproval,

    // Slip access (employee sees own only)
    getMySlip: handleGetMySlip,
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

function handleGetMySlip(payload, ctx) {
  // implemented in payroll.gs (Phase 5 — currently returns not_implemented)
  return getMySlip(ctx.empCode, payload.period);
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

  if (/^\/?help\s*$/i.test(text)) {
    pushLineMessage(userId,
      'คำสั่ง:\n' +
      '/reconcile — รัน reconcile เดือนก่อน\n' +
      '/reconcile YYYY-MM — รันงวดที่ระบุ\n' +
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
  if (['approve_leave', 'reject_leave', 'approve_ot', 'reject_ot'].includes(params.action)) {
    handleApprovalAction(userId, params);
  }
  // Other postback actions can be added here
}
