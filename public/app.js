const form = document.querySelector('#registrationForm');
const button = document.querySelector('#startBtn');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const icNumberEl = document.querySelector('#icNumber');
const sessionCodeEl = document.querySelector('#sessionCode');
const SDK = window.PalmMobileManager?.PalmMobileManager;

icNumberEl.addEventListener('input', () => {
  icNumberEl.value = formatIcNumber(icNumberEl.value.replace(/\D/g, '').slice(0, 12));
});
sessionCodeEl.addEventListener('input', () => {
  sessionCodeEl.value = sessionCodeEl.value.replace(/\D/g, '').slice(0, 6);
});

setStatus(SDK ? 'SDK loaded. Ready for a mobile camera test.' : 'SDK loader did not initialize. Check the loader URL and browser console.', SDK ? 'ready' : 'error');

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  const icNumber = icNumberEl.value;
  const userName = document.querySelector('#userName').value.trim();
  const phoneNo = normalizeMalaysianPhone(document.querySelector('#phoneNo').value);
  const sessionCode = sessionCodeEl.value;
  if (!/^\d{12}$/.test(icNumber.replace(/\D/g, ''))) return setStatus('Enter a complete 12-digit IC number.', 'error');
  if (!userName) return setStatus('Enter a valid full name.', 'error');
  if (!phoneNo) return setStatus('Enter a valid Malaysian phone number.', 'error');
  if (!/^\d{6}$/.test(sessionCode)) return setStatus('Enter the six-digit visitor session code.', 'error');
  if (!SDK) return setStatus('Palm SDK is unavailable. Check the loader request.', 'error');

  button.disabled = true;
  resultEl.textContent = 'Validating visitor session…';
  setStatus('Preparing secure registration…', 'working');
  try {
    const response = await fetch('/api/visitor-registration/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icNumber, userName, phoneNo, sessionCode })
    });
    const responseText = await response.text();
    let payload;
    try { payload = JSON.parse(responseText); }
    catch {
      throw Object.assign(new Error(`The preparation endpoint returned an invalid response (HTTP ${response.status}).`), {
        code: 'INVALID_SERVER_RESPONSE', httpStatus: response.status
      });
    }
    if (!response.ok) {
      throw Object.assign(new Error(payload.message || `Registration preparation failed (HTTP ${response.status}).`), payload, {
        httpStatus: response.status
      });
    }
    setStatus('Session confirmed. Opening camera flow…', 'working');
    const result = await SDK.start({
      token: payload.token, appId: payload.appId, userId: payload.userId,
      userName: payload.userName, phoneNo: payload.phoneNo, mode: 'registration',
      enableManager: true, palmDirection: 'palm_direction_unspecified'
    }, callbackResult => console.log('[PalmMobileManager callback]', callbackResult));
    resultEl.textContent = JSON.stringify(result, null, 2);
    setStatus(result?.code === 0 ? 'Registration flow completed. Verify the palm status in PalmAI.' : describeCode(result?.code, result?.message), result?.code === 0 ? 'success' : 'error');
  } catch (error) {
    resultEl.textContent = JSON.stringify({
      message: error.message,
      code: error.code || 'PREPARATION_FAILED',
      httpStatus: error.httpStatus,
      action: error.details?.action,
      upstreamCode: error.details?.upstreamCode,
      requestId: error.details?.requestId
    }, null, 2);
    setStatus(describePreparationError(error), 'error');
  } finally { button.disabled = false; }
});

function formatIcNumber(digits) {
  return [digits.slice(0, 6), digits.slice(6, 8), digits.slice(8, 12)].filter(Boolean).join('-');
}

function normalizeMalaysianPhone(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  let national;
  if (/^\+60\d{4,20}$/.test(compact)) national = compact.slice(3);
  else if (/^60\d{4,20}$/.test(compact)) national = compact.slice(2);
  else if (/^0\d{4,20}$/.test(compact)) national = compact.slice(1);
  else if (/^\d{4,20}$/.test(compact)) national = compact;
  return national ? `(+60)${national}` : null;
}

function setStatus(message, type) { statusEl.textContent = message; statusEl.dataset.type = type; }

function describePreparationError(error) {
  const friendly = describeCode(error.code, error.message);
  const details = error.details || {};
  const context = [
    details.action ? `Step: ${details.action}` : '',
    details.upstreamCode ? `Tencent code: ${details.upstreamCode}` : '',
    details.requestId ? `Request ID: ${details.requestId}` : '',
    error.httpStatus ? `HTTP ${error.httpStatus}` : ''
  ].filter(Boolean);
  return context.length ? `${friendly} ${context.join(' · ')}` : friendly;
}

function describeCode(code, fallback = 'Registration failed.') {
  const descriptions = {
    INVALID_SESSION_CODE: 'The visitor session code is invalid or has expired.',
    SESSION_TAG_NOT_UNDER_VISITOR: 'This code cannot be used for visitor registration.',
    VISITOR_TAG_NOT_CONFIGURED: 'Visitor registration is temporarily unavailable.',
    RATE_LIMITED: 'Too many attempts. Please wait before trying again.',
    TENCENT_PERMISSION_DENIED: 'Server setup issue: the Tencent credentials lack permission for this operation.',
    TENCENT_AUTHENTICATION_FAILED: 'Server setup issue: Tencent rejected the configured credentials.',
    TENCENT_API_ERROR: 'Tencent Palm could not complete registration preparation.',
    INVALID_SERVER_RESPONSE: 'The registration server returned an unexpected response.',
    10001: 'Invalid SDK parameters.', 10003: 'Camera permission was denied.',
    10007: 'Another palm session is already active.', 10012: 'The user token is invalid or expired.',
    10019: 'The phone number format is invalid.', 10022: 'Tenant-side user registration is disabled.',
    10023: 'That phone number already belongs to another user.', 10024: 'Tenant-side palm registration is disabled.',
    10100: 'Liveness detection failed. Retry in good lighting.', 10101: 'Palm image quality was insufficient.',
    10102: 'Liveness verification failed.', 10103: 'This palm is already registered.',
    10104: 'A highly similar palm already exists.', 10401: 'The SDK gateway rejected authorization.',
    10500: 'Network error while using the SDK.'
  };
  return descriptions[code] || descriptions[Number(code)] || fallback;
}
