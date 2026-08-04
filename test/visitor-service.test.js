import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVisitorService, ServiceError } from '../visitor-service.js';
import { safeError } from '../server.js';
import { PalmApiError } from '../palm-api.js';

const visitorTag = { UserTagId: 'visitor', UserTagName: 'Visitor', ParentTagId: '', Level: 0 };
const sessionTag = { UserTagId: 'session-123', UserTagName: '123456', ParentTagId: 'visitor', Level: 1 };
const otherSessionTag = { UserTagId: 'session-654', UserTagName: '654321', ParentTagId: 'visitor', Level: 1 };

function tree(...extra) {
  return { UserTagTree: [{ ...visitorTag, Children: [sessionTag, otherSessionTag] }, ...extra] };
}

function basePalm(overrides = {}) {
  return {
    describeUserTagTree: async () => tree(),
    describeUserTagList: async () => ({ UserTagList: [], TotalCount: 0 }),
    describeUser: async () => { throw Object.assign(new Error('not found'), { code: 'ResourceNotFound' }); },
    createUser: async () => ({}), modifyUser: async () => ({}),
    createUserAccessToken: async () => ({ AccessToken: 'short-user-token' }),
    describeUserList: async () => ({ UserList: [], TotalCount: 0 }),
    deleteUserTag: async () => ({}), deleteUser: async () => ({}),
    ...overrides
  };
}

const validInput = {
  icNumber: '900101-14-5678', userName: 'Visitor Name',
  phoneNo: '(+60)123456789', sessionCode: '123456'
};

test('resolves an exact session code directly under Visitor', async () => {
  const service = createVisitorService({ palm: basePalm() });
  const result = await service.resolveVisitorSessionTags('123456');
  assert.equal(result.visitor.UserTagId, 'visitor');
  assert.equal(result.session.UserTagId, 'session-123');
});

test('rejects a six-digit tag under another parent', async () => {
  const palm = basePalm({ describeUserTagTree: async () => tree({ UserTagId: 'other', UserTagName: 'Other', Level: 0, Children: [{ ...sessionTag, ParentTagId: 'other' }] }) });
  // Remove the valid child, leaving only the wrong-parent exact match.
  palm.describeUserTagTree = async () => ({ UserTagTree: [{ ...visitorTag, Children: [] }, { UserTagId: 'other', UserTagName: 'Other', Level: 0, Children: [{ ...sessionTag, ParentTagId: 'other' }] }] });
  await assert.rejects(createVisitorService({ palm }).resolveVisitorSessionTags('123456'), error => error.code === 'SESSION_TAG_NOT_UNDER_VISITOR');
});

test('does not accept fuzzy tag matches', async () => {
  const palm = basePalm({ describeUserTagTree: async () => ({ UserTagTree: [{ ...visitorTag, Children: [{ ...sessionTag, UserTagName: '1234567' }] }] }) });
  await assert.rejects(createVisitorService({ palm }).resolveVisitorSessionTags('123456'), error => error.code === 'INVALID_SESSION_CODE');
});

test('falls back to paginated DescribeUserTagList when tag-tree permission is denied', async () => {
  const offsets = [];
  const filler = Array.from({ length: 98 }, (_, index) => ({
    UserTagId: `filler-${index}`,
    UserTagName: `Tag ${index}`,
    ParentTagId: '',
    Level: 0
  }));
  const listVisitorTag = {
    UserTagId: 'visitor',
    UserTagName: 'Visitor',
    PathNodes: [{ UserTagId: 'visitor', UserTagName: 'Visitor' }]
  };
  const palm = basePalm({
    describeUserTagTree: async () => {
      throw Object.assign(new Error('Authentication user has no access permission'), {
        code: 'AuthFailure.AuthRoleWithNoPermission', action: 'DescribeUserTagTree'
      });
    },
    describeUserTagList: async ({ Offset }) => {
      offsets.push(Offset);
      return Offset === 0
        ? { UserTagList: [listVisitorTag, ...filler, otherSessionTag], TotalCount: 101 }
        : { UserTagList: [sessionTag], TotalCount: 101 };
    }
  });
  const resolved = await createVisitorService({ palm, logger: {} }).resolveVisitorSessionTags('123456');
  assert.equal(resolved.session.UserTagId, 'session-123');
  assert.deepEqual(offsets, [0, 100]);
});

test('new user receives both required tag IDs before a token is issued', async () => {
  const calls = [];
  const palm = basePalm({
    createUser: async payload => { calls.push(['create', payload]); },
    createUserAccessToken: async id => { calls.push(['token', id]); return { AccessToken: 'token' }; }
  });
  await createVisitorService({ palm }).prepareRegistration(validInput);
  assert.deepEqual(calls[0][1].UserTagIdList, ['visitor', 'session-123']);
  assert.deepEqual(calls.map(call => call[0]), ['create', 'token']);
});

test('existing user retains tags and optional full-update fields', async () => {
  let modified;
  const palm = basePalm({
    describeUser: async () => ({ User: {
      UserId: '900101145678', UserName: 'Old', PhoneNo: '(+60)11111',
      PhysicalCardNo: 'card-1', CustomFieldValue: 'custom',
      UserTagList: [{ UserTagId: 'contractor' }, { UserTagId: 'visitor' }]
    } }),
    modifyUser: async payload => { modified = payload; }
  });
  await createVisitorService({ palm }).prepareRegistration(validInput);
  assert.deepEqual(modified.UserTagIdList, ['contractor', 'visitor', 'session-123']);
  assert.equal(modified.PhysicalCardNo, 'card-1');
  assert.equal(modified.CustomFieldValue, 'custom');
  assert.equal(modified.PartialFailure, false);
});

test('invalid code performs no user mutation and issues no token', async () => {
  let mutations = 0;
  const palm = basePalm({ createUser: async () => { mutations++; }, createUserAccessToken: async () => { mutations++; } });
  await assert.rejects(createVisitorService({ palm }).prepareRegistration({ ...validInput, sessionCode: '999999' }), ServiceError);
  assert.equal(mutations, 0);
});

test('cleanup removes only the expired tag and preserves active and unrelated tags', async () => {
  let update;
  const user = { UserId: 'u1', UserName: 'One', PhoneNo: '(+60)11111', UserTagList: ['visitor', 'session-123', 'session-654', 'contractor'] };
  const palm = basePalm({
    describeUserList: async ({ UserTagId }) => UserTagId === 'session-123' ? { UserList: [user], TotalCount: 1 } : { UserList: [{ ...user, UserTagList: ['visitor', 'session-654', 'contractor'] }], TotalCount: 1 },
    modifyUser: async payload => { update = payload; }
  });
  const report = await createVisitorService({ palm, logger: {} }).cleanupSession('123456', { dryRun: false });
  assert.deepEqual(update.UserTagIdList, ['visitor', 'session-654', 'contractor']);
  assert.equal(report.orphanVisitorsFound, 0);
  assert.equal(report.sessionTagDeleted, true);
});

test('tag is not deleted when a user update fails', async () => {
  let tagDeletes = 0;
  const palm = basePalm({
    describeUserList: async () => ({ UserList: [{ UserId: 'u1', UserTagList: ['visitor', 'session-123'] }], TotalCount: 1 }),
    modifyUser: async () => { throw new Error('failure'); },
    deleteUserTag: async () => { tagDeletes++; }
  });
  const report = await createVisitorService({ palm, logger: {} }).cleanupSession('123456', { dryRun: false });
  assert.equal(tagDeletes, 0);
  assert.equal(report.sessionTagDeleted, false);
  assert.equal(report.userUpdateFailures.length, 1);
});

test('orphan Visitor-only user is deleted after cleanup', async () => {
  const deleted = [];
  let queries = 0;
  const palm = basePalm({
    describeUserList: async () => ++queries === 1
      ? { UserList: [{ UserId: 'u1', UserTagList: ['visitor', 'session-123'] }], TotalCount: 1 }
      : { UserList: [{ UserId: 'u1', UserTagList: ['visitor', 'contractor'] }], TotalCount: 1 },
    deleteUser: async id => { deleted.push(id); }
  });
  const report = await createVisitorService({ palm, logger: {} }).cleanupSession('123456', { dryRun: false });
  assert.deepEqual(deleted, ['u1']);
  assert.equal(report.orphanVisitorsDeleted, 1);
});

test('dry-run performs no Tencent mutations', async () => {
  let mutations = 0;
  const palm = basePalm({
    describeUserList: async () => ({ UserList: [{ UserId: 'u1', UserTagList: ['visitor', 'session-123'] }], TotalCount: 1 }),
    modifyUser: async () => { mutations++; }, deleteUserTag: async () => { mutations++; }, deleteUser: async () => { mutations++; }
  });
  const report = await createVisitorService({ palm, logger: {} }).cleanupSession('123456');
  assert.equal(mutations, 0);
  assert.equal(report.dryRun, true);
});

test('cleanup is idempotent when the session tag was already deleted', async () => {
  const palm = basePalm({ describeUserTagTree: async () => ({ UserTagTree: [{ ...visitorTag, Children: [otherSessionTag] }] }) });
  const report = await createVisitorService({ palm, logger: {} }).cleanupSession('123456', { dryRun: false, deleteOrphanVisitors: false });
  assert.equal(report.sessionTagDeleted, true);
  assert.equal(report.sessionTagId, null);
});

test('DescribeUserList pagination retrieves every page', async () => {
  const offsets = [];
  const palm = basePalm({ describeUserList: async ({ Offset }) => {
    offsets.push(Offset);
    const count = Offset === 0 ? 100 : 1;
    return { UserList: Array.from({ length: count }, (_, i) => ({ UserId: `u${Offset + i}` })), TotalCount: 101 };
  } });
  const users = await createVisitorService({ palm }).allUsersForTag('visitor');
  assert.equal(users.length, 101);
  assert.deepEqual(offsets, [0, 100]);
});

test('public preparation errors never expose secrets or tokens', () => {
  const secret = 'very-secret-value';
  const response = safeError(Object.assign(new Error(secret), { code: 'RemoteFailure', requestId: 'request-id' }));
  const text = JSON.stringify({ code: response.code, message: response.message });
  assert.equal(response.status, 500);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('secret-id'), false);
  assert.equal(text.includes('short-user-token'), false);
});

test('Tencent permission failures identify the failed action and RequestId safely', () => {
  const response = safeError(new PalmApiError('Authentication user has no access permission', {
    code: 'AuthFailure.AuthRoleWithNoPermission',
    action: 'DescribeUserTagTree',
    requestId: 'request-123'
  }));
  assert.equal(response.status, 500);
  assert.equal(response.code, 'TENCENT_PERMISSION_DENIED');
  assert.deepEqual(response.details, {
    action: 'DescribeUserTagTree',
    upstreamCode: 'AuthFailure.AuthRoleWithNoPermission',
    requestId: 'request-123'
  });
});

test('frontend source contains no server credential or management-token values', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PALM_SECRET|SecretKey|SecretId|Openapi-Token/);
});
