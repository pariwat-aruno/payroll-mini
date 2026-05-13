/**
 * liff-bridge.js — LIFF SDK initialization with local-dev mock
 *
 * In production: uses real LIFF SDK loaded from <script>
 * In local dev (no LIFF available): uses a mock so the page works in browser
 *
 * Detection: if `window.liff` exists after a 1s timeout → real LIFF
 *            otherwise → use mock
 */

const MOCK_PROFILE = {
  userId: 'U_mock_local_dev_1234567890',
  displayName: 'Pui (Mock)',
  pictureUrl: '',
  statusMessage: '',
};

const MOCK_ID_TOKEN = 'mock.id.token.for.local.dev';

let _liffReady = false;
let _useMock = false;

/**
 * Initialize LIFF (or mock).
 * @param {string} liffId — from URL ?liffId=... or hardcoded for dev
 * @returns {Promise<void>}
 */
async function liffInit(liffId) {
  if (typeof liff === 'undefined') {
    // No LIFF SDK loaded → assume local dev
    console.warn('[LIFF] SDK not loaded, using mock');
    _useMock = true;
    _liffReady = true;
    return;
  }

  try {
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) {
      liff.login();  // redirects, doesn't return
      return;
    }
    _liffReady = true;
  } catch (err) {
    console.error('[LIFF] init failed:', err);
    // fall back to mock if dev, otherwise re-throw
    if (_isLocalDev()) {
      _useMock = true;
      _liffReady = true;
    } else {
      throw err;
    }
  }
}

function _isLocalDev() {
  return ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
}

/**
 * Get user profile.
 * @returns {Promise<{userId, displayName, pictureUrl}>}
 */
async function liffGetProfile() {
  if (!_liffReady) throw new Error('liff_not_initialized');
  if (_useMock) return { ...MOCK_PROFILE };
  return await liff.getProfile();
}

/**
 * Get ID token (used for backend verification).
 * @returns {string}
 */
function liffGetIDToken() {
  if (!_liffReady) throw new Error('liff_not_initialized');
  if (_useMock) return MOCK_ID_TOKEN;
  return liff.getIDToken();
}

/**
 * Close the LIFF window (returns to LINE chat).
 */
function liffClose() {
  if (_useMock) {
    alert('(mock) liff.closeWindow called');
    return;
  }
  liff.closeWindow();
}

/**
 * Are we in mock mode? (UI can show a banner)
 */
function liffIsMock() {
  return _useMock;
}

/**
 * Are we running inside LINE's in-app webview?
 * Useful for showing "open in external browser" fallbacks when the LINE
 * webview blocks features like getUserMedia.
 */
function liffIsInClient() {
  if (_useMock) return false;
  try { return typeof liff !== 'undefined' && liff.isInClient && liff.isInClient(); }
  catch (e) { return false; }
}

if (typeof window !== 'undefined') {
  window.LiffBridge = {
    liffInit,
    liffGetProfile,
    liffGetIDToken,
    liffClose,
    liffIsMock,
    liffIsInClient,
  };
}
