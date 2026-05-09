/**
 * api.js — POST helper for Apps Script Web App
 *
 * CORS GOTCHA — DO NOT CHANGE WITHOUT TESTING:
 *   Apps Script does not return Access-Control-Allow-Origin headers.
 *   We avoid CORS preflight by sending requests as text/plain.
 *   The body is still JSON-encoded text, just with a "wrong" Content-Type.
 *
 * The Apps Script doPost reads e.postData.contents (which is the raw body)
 * and parses it as JSON. So this works as long as both sides agree.
 */

/**
 * Build the backend URL.
 * Reads `?backend=...` from the page URL or LIFF state.
 * Each customer's tenant has a different Apps Script URL.
 */
// Fallback when LIFF Endpoint URL can't carry a ?backend= param.
// Single-tenant deployment — for multi-tenant, prefer ?backend= query param.
const DEFAULT_BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwIXi2HjDTeLr6ZG49FuJstrCV5ZmpuAhbcFQ-OkAy_nCoLbDzavxV0n73Cxqlsgsml/exec';

function getBackendUrl() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get('backend') || params.get('b') || DEFAULT_BACKEND_URL;
  return decodeURIComponent(url);
}

/**
 * POST a request to the backend.
 *
 * @param {string} action  e.g. 'submitLeave'
 * @param {object} payload
 * @param {string} idToken from liff.getIDToken()
 * @returns {Promise<object>} the `data` field of a successful response
 * @throws {Error} on network or backend errors
 */
async function apiPost(action, payload, idToken) {
  const url = getBackendUrl();
  const body = JSON.stringify({ action, idToken, payload: payload || {} });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      // text/plain avoids CORS preflight
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error('network_error: ' + err.message);
  }

  if (!res.ok) {
    throw new Error(`http_${res.status}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error('invalid_json_response');
  }

  if (!json.ok) {
    throw new Error(json.error || 'unknown_error');
  }
  return json.data;
}

/**
 * Convenience wrappers.
 */
async function apiSubmitLeave(payload, idToken) {
  return apiPost('submitLeave', payload, idToken);
}

async function apiSubmitOT(payload, idToken) {
  return apiPost('submitOT', payload, idToken);
}

async function apiGetMyQuota(idToken) {
  return apiPost('getMyQuota', {}, idToken);
}

async function apiGetMyHistory(idToken, limit) {
  return apiPost('getMyHistory', { limit: limit || 10 }, idToken);
}

async function apiListPendingApprovals(idToken) {
  return apiPost('listPendingApprovals', {}, idToken);
}

async function apiActOnApproval(payload, idToken) {
  return apiPost('actOnApproval', payload, idToken);
}

async function apiGetMySlip(idToken, period) {
  return apiPost('getMySlip', { period }, idToken);
}

async function apiListMyPeriods(idToken) {
  return apiPost('listMyPeriods', {}, idToken);
}

async function apiGetMySlipPdf(idToken, period) {
  return apiPost('getMySlipPdf', { period }, idToken);
}

async function apiPing(idToken) {
  return apiPost('ping', {}, idToken);
}

async function apiGetMe(idToken) {
  return apiPost('getMe', {}, idToken);
}

async function apiOnboardEmployee(payload, idToken) {
  return apiPost('onboardEmployee', payload, idToken);
}

async function apiListEmployees(idToken) {
  return apiPost('listEmployees', {}, idToken);
}

async function apiPairEmployee(payload, idToken) {
  return apiPost('pairEmployee', payload, idToken);
}

async function apiGetLeaveForRespond(idToken, leaveId) {
  return apiPost('getLeaveForRespond', { leave_id: leaveId }, idToken);
}

async function apiRespondInfoRequest(idToken, payload) {
  return apiPost('respondInfoRequest', payload, idToken);
}

async function apiSubmitConditionalEvidence(idToken, payload) {
  return apiPost('submitConditionalEvidence', payload, idToken);
}

async function apiUploadEvidence(idToken, payload) {
  return apiPost('uploadEvidence', payload, idToken);
}

// HR / Admin
async function apiHrListEmployees(idToken)              { return apiPost('hrListEmployees', {}, idToken); }
async function apiHrUpsertEmployee(idToken, payload)    { return apiPost('hrUpsertEmployee', payload, idToken); }
async function apiHrListAllowances(idToken, payload)    { return apiPost('hrListAllowances', payload || {}, idToken); }
async function apiHrUpsertAllowance(idToken, payload)   { return apiPost('hrUpsertAllowance', payload, idToken); }
async function apiHrDeleteAllowance(idToken, payload)   { return apiPost('hrDeleteAllowance', payload, idToken); }
async function apiHrListRecurringDeductions(idToken)    { return apiPost('hrListRecurringDeductions', {}, idToken); }
async function apiHrUpsertRecurringDeduction(idToken, payload) { return apiPost('hrUpsertRecurringDeduction', payload, idToken); }
async function apiHrDeleteRecurringDeduction(idToken, payload) { return apiPost('hrDeleteRecurringDeduction', payload, idToken); }
async function apiHrListHolidays(idToken)               { return apiPost('hrListHolidays', {}, idToken); }
async function apiHrUpsertHoliday(idToken, payload)     { return apiPost('hrUpsertHoliday', payload, idToken); }
async function apiHrDeleteHoliday(idToken, payload)     { return apiPost('hrDeleteHoliday', payload, idToken); }
async function apiHrListLeaveQuota(idToken, payload)    { return apiPost('hrListLeaveQuota', payload || {}, idToken); }
async function apiHrUpsertLeaveQuota(idToken, payload)  { return apiPost('hrUpsertLeaveQuota', payload, idToken); }
async function apiListPendingChanges(idToken)           { return apiPost('listPendingChanges', {}, idToken); }
async function apiApprovePendingChange(idToken, payload){ return apiPost('approvePendingChange', payload, idToken); }
async function apiRejectPendingChange(idToken, payload) { return apiPost('rejectPendingChange', payload, idToken); }

// Expose for both ES module and plain script tag use
if (typeof window !== 'undefined') {
  window.PayrollApi = {
    apiPost,
    apiSubmitLeave,
    apiSubmitOT,
    apiGetMyQuota,
    apiGetMyHistory,
    apiListPendingApprovals,
    apiActOnApproval,
    apiGetMySlip,
    apiListMyPeriods,
    apiGetMySlipPdf,
    apiPing,
    apiGetMe,
    apiOnboardEmployee,
    apiListEmployees,
    apiPairEmployee,
    apiGetLeaveForRespond,
    apiRespondInfoRequest,
    apiSubmitConditionalEvidence,
    apiUploadEvidence,
    apiHrListEmployees,
    apiHrUpsertEmployee,
    apiHrListAllowances,
    apiHrUpsertAllowance,
    apiHrDeleteAllowance,
    apiHrListRecurringDeductions,
    apiHrUpsertRecurringDeduction,
    apiHrDeleteRecurringDeduction,
    apiHrListHolidays,
    apiHrUpsertHoliday,
    apiHrDeleteHoliday,
    apiHrListLeaveQuota,
    apiHrUpsertLeaveQuota,
    apiListPendingChanges,
    apiApprovePendingChange,
    apiRejectPendingChange,
    getBackendUrl,
  };
}
