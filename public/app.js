const form = document.querySelector('#registrationForm');
const button = document.querySelector('#startBtn');
const statusEl = document.querySelector('#status');
const resultEl = document.querySelector('#result');
const userIdEl = document.querySelector('#userId');

userIdEl.addEventListener('input', () => {
  const digits = userIdEl.value.replace(/\D/g, '').slice(0, 12);
  userIdEl.value = formatIcNumber(digits);
});

const config = await fetch('/api/config').then(r => r.json());
const SDK = window.PalmMobileManager?.PalmMobileManager;

if (SDK) {
  setStatus('SDK loaded. Ready for a mobile camera test.', 'ready');
} else {
  setStatus('SDK loader did not initialize. Check the loader URL and browser console.', 'error');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;

  const userId = userIdEl.value.replace(/\D/g, '');
  const userName = document.querySelector('#userName').value.trim();
  const phoneInput = document.querySelector('#phoneNo').value.trim();
  const phoneNo = normalizeMalaysianPhone(phoneInput);

  if (!/^\d{12}$/.test(userId)) {
    return setStatus('Enter a complete 12-digit IC number.', 'error');
  }
  if (!userName || userName !== userName.trim()) {
    return setStatus('Enter a valid full name.', 'error');
  }
  if (!phoneNo) {
    return setStatus('Enter a phone number using digits (for example, 0123456789).', 'error');
  }
  if (!SDK) {
    return setStatus('Palm SDK is unavailable. Check the loader request.', 'error');
  }

  button.disabled = true;
  resultEl.textContent = 'Requesting a user-bound token…';
  setStatus('Preparing secure registration…', 'working');

  try {
    const tokenResponse = await fetch('/api/palm-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw Object.assign(new Error(tokenPayload.error || 'Token request failed'), tokenPayload);
    }

    setStatus('Token ready. Opening camera flow…', 'working');
    const params = {
      token: tokenPayload.accessToken,
      userId,
      userName,
      phoneNo,
      appId: Number(config.appId),
      mode: 'registration',
      enableManager: true,
      palmDirection: 'palm_direction_unspecified'
    };

    const result = await SDK.start(params, (callbackResult) => {
      console.log('[PalmMobileManager callback]', callbackResult);
    });

    resultEl.textContent = JSON.stringify(result, null, 2);
    if (result?.code === 0) {
      setStatus('Registration flow completed. Verify the user palm status in PalmAI.', 'success');
    } else {
      setStatus(describeCode(result?.code, result?.message), 'error');
    }
  } catch (error) {
    console.error(error);
    resultEl.textContent = JSON.stringify({
      message: error.message,
      code: error.code,
      requestId: error.requestId
    }, null, 2);
    setStatus(describeCode(error.code, error.message), 'error');
  } finally {
    button.disabled = false;
  }
});

function formatIcNumber(digits) {
  const parts = [digits.slice(0, 6), digits.slice(6, 8), digits.slice(8, 12)];
  return parts.filter(Boolean).join('-');
}

function normalizeMalaysianPhone(value) {
  const compact = value.replace(/[\s()-]/g, '');
  let nationalNumber;

  if (/^\+60\d{4,20}$/.test(compact)) {
    nationalNumber = compact.slice(3);
  } else if (/^60\d{4,20}$/.test(compact)) {
    nationalNumber = compact.slice(2);
  } else if (/^0\d{4,20}$/.test(compact)) {
    nationalNumber = compact.slice(1);
  } else if (/^\d{4,20}$/.test(compact)) {
    nationalNumber = compact;
  } else {
    return null;
  }

  return `(+60)${nationalNumber}`;
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.dataset.type = type;
}

function describeCode(code, fallback = 'Registration failed.') {
  const descriptions = {
    10001: 'Invalid SDK parameters. Check AppId and visitor field formats.',
    10003: 'Camera permission was denied.',
    10007: 'Another palm session is already active.',
    10012: 'The user token is invalid or expired.',
    10019: 'The phone number format is invalid.',
    10022: 'Tenant-side user registration is disabled.',
    10023: 'That phone number already belongs to another user.',
    10024: 'Tenant-side palm registration is disabled.',
    10100: 'Liveness detection failed. Retry in good lighting.',
    10101: 'Palm image quality was insufficient. Retry with the full palm visible.',
    10102: 'Liveness video upload or verification failed.',
    10103: 'This palm is already registered.',
    10104: 'A highly similar palm already exists.',
    10401: 'The SDK gateway rejected authorization.',
    10500: 'Network error while using the SDK.'
  };
  return descriptions[Number(code)] || fallback || `Registration failed (${code}).`;
}
