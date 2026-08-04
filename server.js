import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
loadDotEnv(join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const APP_ID = Number(process.env.PALM_APP_ID);
const SECRET_ID = process.env.PALM_SECRET_ID || '';
const SECRET_KEY = process.env.PALM_SECRET_KEY || '';
const HOST = process.env.PALM_OPENAPI_HOST || 'open.intl.palm.tencent.com';
const VERSION = '2025-07-15';
const SERVICE = 'palm';
const SDK_LOADER_URL = process.env.PALM_SDK_LOADER_URL ||
  'https://app.intl.palm.tencent.com/palm_h5/loader/palm-mobile-manager.js';

function loadDotEnv(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional
  }
}


function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function buildPalmHeaders(action, bodyText) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const nonce = randomUUID();
  const contentType = 'application/json';
  const signedHeaders = 'content-type;host;x-palm-appid;x-tc-nonce;x-tc-timestamp';
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${HOST}\n` +
    `x-palm-appid:${APP_ID}\n` +
    `x-tc-nonce:${nonce}\n` +
    `x-tc-timestamp:${timestamp}\n`;

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(bodyText)
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const secretDate = hmac(Buffer.from(`TC3${SECRET_KEY}`, 'utf8'), date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');

  return {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    Host: HOST,
    'X-Palm-AppId': String(APP_ID),
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': VERSION,
    'X-TC-Nonce': nonce
  };
}

async function createUserToken(userId) {
  const body = {
    AppId: APP_ID,
    SecretId: SECRET_ID,
    SecretKeyHash: sha256Hex(SECRET_KEY),
    GrantType: 'client_credential_user',
    UserId: userId
  };
  const bodyText = JSON.stringify(body);
  const response = await fetch(`https://${HOST}/`, {
    method: 'POST',
    headers: buildPalmHeaders('CreateAccessToken', bodyText),
    body: bodyText
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

  if (!response.ok || payload?.Response?.Error || !payload?.Response?.AccessToken) {
    const error = new Error(payload?.Response?.Error?.Message || `Palm API failed with HTTP ${response.status}`);
    error.code = payload?.Response?.Error?.Code || 'PalmApiError';
    error.requestId = payload?.Response?.RequestId;
    error.httpStatus = response.status;
    throw error;
  }
  return payload.Response;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const clean = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const path = join(__dirname, 'public', clean);
  if (!path.startsWith(join(__dirname, 'public'))) return false;
  try {
    let content = await readFile(path);
    if (extname(path) === '.html') {
      content = Buffer.from(content.toString('utf8').replaceAll('__PALM_SDK_LOADER_URL__', SDK_LOADER_URL));
    }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, { appId: APP_ID, sdkLoaderUrl: SDK_LOADER_URL });
    }

    if (req.method === 'POST' && req.url === '/api/palm-token') {
      if (!APP_ID || !SECRET_ID || !SECRET_KEY) {
        return json(res, 500, { error: 'Server credentials are missing. Configure .env first.' });
      }
      const { userId } = await readJson(req);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(userId || ''))) {
        return json(res, 400, { error: 'userId must be 1-64 characters: letters, digits, hyphen, underscore.' });
      }
      const token = await createUserToken(userId);
      return json(res, 200, {
        accessToken: token.AccessToken,
        expiresIn: Number(token.ExpiresIn),
        requestId: token.RequestId
      });
    }

    if (req.method === 'GET' && await serveStatic(req, res)) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 500, {
      error: error.message || 'Unexpected server error',
      code: error.code,
      requestId: error.requestId
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Palm H5 POC: http://localhost:${PORT}`);
  console.log(`SDK loader: ${SDK_LOADER_URL}`);
});
