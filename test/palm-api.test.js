import test from 'node:test';
import assert from 'node:assert/strict';
import { createPalmClient, PalmApiError } from '../palm-api.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('management calls cache the server token, send it only on normal APIs, and preserve exact serialized bodies', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    if (options.headers['X-TC-Action'] === 'CreateAccessToken') {
      return response({ Response: { AccessToken: 'server-token', ExpiresIn: 300, RequestId: 'token-request' } });
    }
    return response({ Response: { RequestId: `request-${requests.length}` } });
  };
  const client = createPalmClient({ appId: 30019, secretId: 'id', secretKey: 'key', host: 'example.test', fetchImpl, logger: {} });
  await client.describeUser('user-1');
  await client.describeUser('user-2');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers['X-Palm-Openapi-Token'], undefined);
  assert.equal(requests[1].headers['X-Palm-Openapi-Token'], 'server-token');
  assert.equal(requests[2].headers['X-Palm-Openapi-Token'], 'server-token');
  assert.equal(requests[1].body, JSON.stringify({ UserId: 'user-1' }));
  assert.notEqual(requests[1].headers['X-TC-Nonce'], requests[2].headers['X-TC-Nonce']);
});

test('Palm client detects Tencent Response.Error', async () => {
  const fetchImpl = async (_url, options) => options.headers['X-TC-Action'] === 'CreateAccessToken'
    ? response({ Response: { AccessToken: 'server-token', ExpiresIn: 300 } })
    : response({ Response: { Error: { Code: 'BadTag', Message: 'bad tag' }, RequestId: 'request-1' } });
  const client = createPalmClient({ appId: 1, secretId: 'id', secretKey: 'key', host: 'example.test', fetchImpl, logger: {} });
  await assert.rejects(client.describeUserTagTree(), error => error instanceof PalmApiError && error.code === 'BadTag' && error.requestId === 'request-1');
});
