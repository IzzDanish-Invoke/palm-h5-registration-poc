import { createHash, createHmac, randomUUID } from 'node:crypto';

const VERSION = '2025-07-15';
const SERVICE = 'palm';

export class PalmApiError extends Error {
  constructor(message, { code = 'TENCENT_API_ERROR', requestId, httpStatus, action } = {}) {
    super(message);
    this.name = 'PalmApiError';
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
    this.action = action;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

/** Creates a server-only Tencent Palm API client. */
export function createPalmClient({ appId, secretId, secretKey, host, fetchImpl = fetch, logger = console }) {
  let serverToken;
  let serverTokenExpiresAt = 0;
  let serverTokenPromise;
  let throttleTail = Promise.resolve();
  let lastStartedAt = 0;

  function assertConfigured() {
    if (!appId || !secretId || !secretKey || !host) {
      throw new PalmApiError('Tencent Palm server configuration is incomplete.', { code: 'PALM_NOT_CONFIGURED', action: 'Configuration' });
    }
  }

  function buildHeaders(action, bodyText, openapiToken) {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const nonce = randomUUID();
    const contentType = 'application/json';
    const signedHeaders = 'content-type;host;x-palm-appid;x-tc-nonce;x-tc-timestamp';
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-palm-appid:${appId}\nx-tc-nonce:${nonce}\nx-tc-timestamp:${timestamp}\n`;
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(bodyText)].join('\n');
    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const secretDate = hmac(Buffer.from(`TC3${secretKey}`, 'utf8'), date);
    const secretService = hmac(secretDate, SERVICE);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = hmac(secretSigning, stringToSign, 'hex');
    const headers = {
      Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': contentType,
      Host: host,
      'X-Palm-AppId': String(appId),
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
      'X-TC-Nonce': nonce
    };
    if (openapiToken) headers['X-Palm-Openapi-Token'] = openapiToken;
    return headers;
  }

  async function throttle() {
    const previous = throttleTail;
    let release;
    throttleTail = new Promise(resolve => { release = resolve; });
    await previous;
    const waitMs = Math.max(0, 50 - (Date.now() - lastStartedAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastStartedAt = Date.now();
    release();
  }

  async function getServerAccessToken() {
    if (serverToken && Date.now() < serverTokenExpiresAt) return serverToken;
    if (!serverTokenPromise) {
      serverTokenPromise = (async () => {
        const response = await callPalmApi('CreateAccessToken', {
          AppId: appId,
          SecretId: secretId,
          SecretKeyHash: sha256Hex(secretKey),
          GrantType: 'client_credential'
        }, { skipAccessToken: true });
        if (!response.AccessToken) {
          throw new PalmApiError('Tencent did not return a server access token.', {
            code: 'MISSING_ACCESS_TOKEN', action: 'CreateAccessToken', requestId: response.RequestId
          });
        }
        serverToken = response.AccessToken;
        const lifetime = Math.max(1, Number(response.ExpiresIn) || 300);
        serverTokenExpiresAt = Date.now() + Math.max(1, lifetime - 30) * 1000;
        return serverToken;
      })().finally(() => { serverTokenPromise = undefined; });
    }
    return serverTokenPromise;
  }

  async function callPalmApi(action, payload, options = {}) {
    assertConfigured();
    const openapiToken = options.skipAccessToken ? undefined : await getServerAccessToken();
    const bodyText = JSON.stringify(payload ?? {});
    await throttle();
    let response;
    try {
      response = await fetchImpl(`https://${host}/`, {
        method: 'POST',
        headers: buildHeaders(action, bodyText, openapiToken),
        body: bodyText
      });
    } catch {
      throw new PalmApiError('Unable to reach the Tencent Palm API.', { code: 'TENCENT_NETWORK_ERROR', action });
    }
    const text = await response.text();
    let envelope;
    try { envelope = JSON.parse(text); } catch { envelope = undefined; }
    const palmResponse = envelope?.Response;
    const apiError = palmResponse?.Error;
    if (!response.ok || apiError || !palmResponse) {
      const requestId = palmResponse?.RequestId;
      const code = apiError?.Code || 'TENCENT_API_ERROR';
      logger.error?.('Palm API error', { action, code, requestId });
      throw new PalmApiError(apiError?.Message || `Tencent Palm API failed with HTTP ${response.status}.`, {
        code, requestId, httpStatus: response.status, action
      });
    }
    logger.info?.('Palm API request', { action, requestId: palmResponse.RequestId });
    return palmResponse;
  }

  const wrappers = {
    callPalmApi,
    describeUserTagList: payload => callPalmApi('DescribeUserTagList', payload),
    describeUserTagTree: (payload = {}) => callPalmApi('DescribeUserTagTree', payload),
    describeUser: userId => callPalmApi('DescribeUser', { UserId: userId }),
    describeUserList: payload => callPalmApi('DescribeUserList', payload),
    createUser: payload => callPalmApi('CreateUser', payload),
    modifyUser: payload => callPalmApi('ModifyUser', payload),
    deleteUser: userId => callPalmApi('DeleteUser', { UserId: userId }),
    deleteUserTag: userTagId => callPalmApi('DeleteUserTag', { UserTagId: userTagId }),
    createUserAccessToken: async userId => {
      const response = await callPalmApi('CreateAccessToken', {
        AppId: appId,
        SecretId: secretId,
        SecretKeyHash: sha256Hex(secretKey),
        GrantType: 'client_credential_user',
        UserId: userId
      }, { skipAccessToken: true });
      if (!response.AccessToken) {
        throw new PalmApiError('Tencent did not return a user access token.', {
          code: 'MISSING_ACCESS_TOKEN', action: 'CreateAccessToken', requestId: response.RequestId
        });
      }
      return response;
    }
  };
  return wrappers;
}
