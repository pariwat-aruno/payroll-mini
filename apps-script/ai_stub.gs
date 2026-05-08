/**
 * ai_stub.gs — AI integration stub
 *
 * Currently NOT functional. This file exists to define the interface
 * and to make the place where AI fits in obvious.
 *
 * Use case (post-MVP, onboarding only):
 *   Owner uploads photos of historical leave forms / pay slips
 *   → AI parses → returns structured records
 *   → Owner reviews → import into the system
 *
 * Why we deferred:
 *   - The payroll core works without AI
 *   - SME customers don't have API keys
 *   - Need real customer feedback before deciding BYOK vs hosted
 *
 * To implement (Claude Code's job, post-MVP):
 *   1. Add ANTHROPIC_API_KEY to PropertiesService
 *   2. Replace _mockParseLeaveImage with a real Claude API call
 *   3. Add idempotency (don't re-parse same image twice)
 *   4. Add cost tracking (log token usage to Audit_Log)
 *   5. Add quota/budget controls
 */

/**
 * Parse a handwritten leave form image.
 *
 * @param {string} imageBase64 - base64-encoded image
 * @returns {{ ok: true, parsed: object } | { ok: false, error: string }}
 */
function aiParseLeaveImage(imageBase64) {
  if (!_isAIEnabled()) {
    return { ok: false, error: 'ai_not_enabled' };
  }
  // TODO: real impl — call Anthropic API with vision
  return _mockParseLeaveImage(imageBase64);
}

/**
 * Parse an old pay slip photo (for YTD migration).
 *
 * @param {string} imageBase64
 * @returns {{ ok: true, parsed: object } | { ok: false, error: string }}
 */
function aiParseSlipImage(imageBase64) {
  if (!_isAIEnabled()) {
    return { ok: false, error: 'ai_not_enabled' };
  }
  // TODO: real impl
  return _mockParseSlipImage(imageBase64);
}

/* ============================================================
 * Internal: enablement check + mocks
 * ============================================================ */

function _isAIEnabled() {
  const key = PropertiesService.getScriptProperties()
    .getProperty('ANTHROPIC_API_KEY');
  return !!key && key !== 'PASTE_HERE' && key.length > 10;
}

function _mockParseLeaveImage(imageBase64) {
  // Returns shape that real impl should match
  return {
    ok: true,
    parsed: {
      employee_name: '[mock] สมชาย ใจดี',
      leave_type: 'sick',
      start_date: '2026-05-01',
      end_date: '2026-05-02',
      reason: '[mock] ไข้',
      _confidence: 0.0,
      _source: 'mock',
    },
  };
}

function _mockParseSlipImage(imageBase64) {
  return {
    ok: true,
    parsed: {
      employee_name: '[mock] สมชาย ใจดี',
      period: '2026-04',
      gross: 0,
      net: 0,
      tax: 0,
      sso: 0,
      _confidence: 0.0,
      _source: 'mock',
    },
  };
}
