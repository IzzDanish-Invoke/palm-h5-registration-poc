import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPalmClient, PalmApiError } from './palm-api.js';
import { createVisitorService, ServiceError } from './visitor-service.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
loadDotEnv(join(__dirname, '.env'));

const config = {
  port: Number(process.env.PORT || 3000),
  appId: Number(process.env.PALM_APP_ID),
  secretId: process.env.PALM_SECRET_ID || '',
  secretKey: process.env.PALM_SECRET_KEY || '',
  host: process.env.PALM_OPENAPI_HOST || 'open.intl.palm.tencent.com',
  sdkLoaderUrl: process.env.PALM_SDK_LOADER_URL || 'https://app.intl.palm.tencent.com/palm_h5/loader/palm-mobile-manager.js',
  visitorTagName: process.env.PALM_VISITOR_TAG_NAME || 'Visitor',
  sessionCodeLength: Number(process.env.PALM_SESSION_CODE_LENGTH || 6),
  adminCleanupKey: process.env.ADMIN_CLEANUP_KEY || ''
};

function loadDotEnv(path) {
  try {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* .env is optional */ }
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
    if (size > 32_768) throw new ServiceError(400, 'INVALID_REQUEST', 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ServiceError(400, 'INVALID_REQUEST', 'Request body must be valid JSON.'); }
}

function normalizePhone(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  let national;
  if (/^\+60\d{4,20}$/.test(compact)) national = compact.slice(3);
  else if (/^60\d{4,20}$/.test(compact)) national = compact.slice(2);
  else if (/^0\d{4,20}$/.test(compact)) national = compact.slice(1);
  else if (/^\d{4,20}$/.test(compact)) national = compact;
  return national ? `(+60)${national}` : null;
}

function authorized(value, expected) {
  if (!expected || !value?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function createAttemptLimiter({ limit = 10, windowMs = 60_000 } = {}) {
  const attempts = new Map();
  return function check(key) {
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter(time => now - time < windowMs);
    recent.push(now);
    attempts.set(key, recent);
    if (attempts.size > 10_000) attempts.clear();
    return recent.length <= limit;
  };
}

async function serveStatic(req, res, sdkLoaderUrl) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const clean = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const publicRoot = resolve(__dirname, 'public');
  const path = resolve(publicRoot, `.${clean.startsWith('/') ? clean : `/${clean}`}`);
  if (path !== publicRoot && !path.startsWith(`${publicRoot}/`)) return false;
  try {
    let content = await readFile(path);
    if (extname(path) === '.html') content = Buffer.from(content.toString('utf8').replaceAll('__PALM_SDK_LOADER_URL__', sdkLoaderUrl));
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
    res.end(content);
    return true;
  } catch { return false; }
}

export function safeError(error) {
  if (error instanceof ServiceError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof PalmApiError) {
    if (error.code === 'PALM_NOT_CONFIGURED') return { status: 500, code: 'SERVER_NOT_CONFIGURED', message: 'Visitor registration is temporarily unavailable.' };
    const conflict = /duplicate|already.?exist|conflict|userid.?exist|phone.*(?:bound|exist)/i.test(`${error.code} ${error.message}`);
    const permissionDenied = /no.?permission|unauthorizedoperation|access.?denied/i.test(`${error.code} ${error.message}`);
    const authenticationFailed = /authfailure|invalid.*(?:secret|credential|signature)/i.test(`${error.code} ${error.message}`) && !permissionDenied;
    const action = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.action || '') ? error.action : undefined;
    const upstreamCode = /^[A-Za-z0-9_.-]{1,128}$/.test(error.code || '') ? error.code : 'TENCENT_API_ERROR';
    const requestId = /^[A-Za-z0-9-]{1,128}$/.test(error.requestId || '') ? error.requestId : undefined;
    return {
      status: conflict ? 409 : permissionDenied || authenticationFailed ? 500 : 502,
      code: conflict
        ? 'TENCENT_USER_CONFLICT'
        : permissionDenied
          ? 'TENCENT_PERMISSION_DENIED'
          : authenticationFailed
            ? 'TENCENT_AUTHENTICATION_FAILED'
            : 'TENCENT_API_ERROR',
      message: conflict
        ? 'The visitor information conflicts with an existing Tencent user.'
        : permissionDenied
          ? `Tencent Palm credentials do not have permission to call ${action || 'the required API'}.`
          : authenticationFailed
            ? 'Tencent Palm rejected the configured server credentials.'
            : `Tencent Palm could not complete ${action || 'the preparation request'}.`,
      details: { action, upstreamCode, requestId }
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' };
}

export function createApp({ appConfig = config, palmClient, logger = console } = {}) {
  const palm = palmClient || createPalmClient({
    appId: appConfig.appId, secretId: appConfig.secretId, secretKey: appConfig.secretKey,
    host: appConfig.host, logger
  });
  const visitor = createVisitorService({ palm, visitorTagName: appConfig.visitorTagName, sessionCodeLength: appConfig.sessionCodeLength, logger });
  const allowPrepare = createAttemptLimiter();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/api/visitor-registration/prepare') {
        const clientIp = String(req.socket.remoteAddress || 'unknown');
        if (!allowPrepare(clientIp)) return json(res, 429, { code: 'RATE_LIMITED', message: 'Too many registration attempts. Please wait and try again.' });
        const body = await readJson(req);
        const phoneNo = normalizePhone(body.phoneNo);
        const prepared = await visitor.prepareRegistration({ ...body, phoneNo: phoneNo || body.phoneNo });
        return json(res, 200, { ...prepared, appId: appConfig.appId });
      }

      const cleanupMatch = url.pathname.match(/^\/api\/admin\/session-tags\/([^/]+)\/cleanup$/);
      if (req.method === 'POST' && cleanupMatch) {
        if (!authorized(req.headers.authorization, appConfig.adminCleanupKey)) return json(res, 401, { code: 'UNAUTHORIZED', message: 'A valid admin cleanup key is required.' });
        const body = await readJson(req);
        const options = {
          deleteOrphanVisitors: body.deleteOrphanVisitors === undefined ? true : body.deleteOrphanVisitors === true,
          dryRun: body.dryRun === undefined ? true : body.dryRun === true
        };
        const report = await visitor.cleanupSession(decodeURIComponent(cleanupMatch[1]), options);
        return json(res, report.userUpdateFailures.length || report.userDeleteFailures.length ? 207 : 200, report);
      }

      if (req.method === 'GET' && await serveStatic(req, res, appConfig.sdkLoaderUrl)) return;
      json(res, 404, { code: 'NOT_FOUND', message: 'Not found.' });
    } catch (error) {
      const safe = safeError(error);
      logger.error?.('Request failed', { path: req.url, code: safe.code, requestId: error.requestId });
      json(res, safe.status, {
        code: safe.code,
        message: safe.message,
        ...(safe.details ? { details: safe.details } : {})
      });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createApp().listen(config.port, '0.0.0.0', () => {
    console.log(`Palm H5 POC: http://localhost:${config.port}`);
    console.log(`SDK loader: ${config.sdkLoaderUrl}`);
  });
}
