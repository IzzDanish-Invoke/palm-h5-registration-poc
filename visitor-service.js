export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

const SESSION_RE = /^\d{6}$/;

function collectTags(value, found = [], seen = new Set(), foundIds = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (value.UserTagId != null && value.UserTagName != null && !foundIds.has(String(value.UserTagId))) {
    found.push(value);
    foundIds.add(String(value.UserTagId));
  }
  for (const [key, nested] of Object.entries(value)) {
    // PathNodes repeats ancestors for navigation; it is not another tag definition.
    if (key !== 'PathNodes') collectTags(nested, found, seen, foundIds);
  }
  return found;
}

function exactOne(tags, name) {
  const matches = tags.filter(tag => String(tag.UserTagName) === name);
  return matches.length === 1 ? matches[0] : { matches: matches.length };
}

function levelOf(tag) {
  if (tag?.Level != null) return Number(tag.Level);
  if (Array.isArray(tag?.PathNodes) && tag.PathNodes.length) {
    const ownIndex = tag.PathNodes.findIndex(node => String(node.UserTagId) === String(tag.UserTagId));
    return ownIndex >= 0 ? ownIndex : tag.PathNodes.length - 1;
  }
  // DescribeUserTagList omits Level and ParentTagId for top-level tags.
  if (tag?.ParentTagId == null || String(tag.ParentTagId) === '') return 0;
  return NaN;
}

function parentIdOf(tag) {
  if (tag?.ParentTagId != null && String(tag.ParentTagId) !== '') return String(tag.ParentTagId);
  if (Array.isArray(tag?.PathNodes)) {
    const ownIndex = tag.PathNodes.findIndex(node => String(node.UserTagId) === String(tag.UserTagId));
    if (ownIndex > 0) return String(tag.PathNodes[ownIndex - 1].UserTagId);
  }
  return undefined;
}

function isLevel(tag, expected) {
  return levelOf(tag) === expected;
}

function tagId(value) {
  if (value == null) return undefined;
  return String(typeof value === 'object' ? value.UserTagId ?? value.TagId ?? value.Id : value);
}

export function userTagIds(user) {
  return [...new Set((user?.UserTagList || user?.UserTagIdList || []).map(tagId).filter(Boolean))];
}

export function fullUserUpdate(user, overrides = {}) {
  const payload = {
    UserId: String(user.UserId),
    UserName: overrides.UserName ?? user.UserName ?? '',
    PhoneNo: overrides.PhoneNo ?? user.PhoneNo ?? '',
    UserTagIdList: overrides.UserTagIdList ?? userTagIds(user),
    PartialFailure: false
  };
  for (const field of ['PhysicalCardNo', 'CustomFieldValue']) {
    if (Object.hasOwn(user, field)) payload[field] = user[field];
  }
  return payload;
}

function responseUser(response) {
  if (!response) return null;
  for (const key of ['User', 'UserInfo', 'Data']) {
    if (response[key]?.UserId != null) return response[key];
  }
  return response.UserId != null ? response : null;
}

function listUsers(response) {
  for (const key of ['UserList', 'Users', 'Data', 'Items']) {
    if (Array.isArray(response?.[key])) return response[key];
  }
  return [];
}

function totalUsers(response) {
  const value = response?.TotalCount ?? response?.Total;
  return value == null ? null : Number(value);
}

function isNotFound(error) {
  return /not.?found|not.?exist|non.?exist|does.?not.?exist/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function isPermissionDenied(error) {
  return /no.?permission|unauthorizedoperation|access.?denied/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function publicFailure(error) {
  return {
    code: 'TENCENT_API_ERROR',
    message: isNotFound(error) ? 'The Tencent user no longer exists.' : 'Tencent could not update this user.'
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function createVisitorService({ palm, visitorTagName = 'Visitor', sessionCodeLength = 6, logger = console }) {
  const sessionPattern = new RegExp(`^\\d{${sessionCodeLength}}$`);

  async function describeTags() {
    try {
      return collectTags(await palm.describeUserTagTree({}));
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      logger.info?.('Palm tag-tree access unavailable; using paginated tag list', {
        action: error.action,
        code: error.code,
        requestId: error.requestId
      });
    }

    const byId = new Map();
    for (let offset = 0; ; offset += 100) {
      const response = await palm.describeUserTagList({ Offset: offset, Limit: 100 });
      const page = collectTags(response);
      for (const tag of page) byId.set(String(tag.UserTagId), tag);
      const total = totalUsers(response);
      if (!page.length || (Number.isFinite(total) && byId.size >= total) || page.length < 100) break;
    }
    return [...byId.values()];
  }

  async function hierarchy(sessionCode, allowMissingSession = false) {
    if (!sessionPattern.test(String(sessionCode || '')) || !SESSION_RE.test(String(sessionCode || ''))) {
      throw new ServiceError(400, 'INVALID_SESSION_CODE', 'The visitor session code is invalid.');
    }
    const tags = await describeTags();
    const visitor = exactOne(tags, visitorTagName);
    if (visitor.matches !== undefined || !isLevel(visitor, 0)) {
      throw new ServiceError(500, 'VISITOR_TAG_NOT_CONFIGURED', 'Visitor registration is temporarily unavailable.');
    }
    const session = exactOne(tags, sessionCode);
    if (session.matches !== undefined) {
      if (allowMissingSession && session.matches === 0) return { visitor, session: null, tags };
      throw new ServiceError(404, 'INVALID_SESSION_CODE', 'The visitor session code is invalid.');
    }
    if (!isLevel(session, 1) || parentIdOf(session) !== String(visitor.UserTagId)) {
      throw new ServiceError(404, 'SESSION_TAG_NOT_UNDER_VISITOR', 'The session code is not valid for visitor registration.');
    }
    return { visitor, session, tags };
  }

  async function resolveVisitorSessionTags(sessionCode) {
    return hierarchy(sessionCode, false);
  }

  async function prepareRegistration(input) {
    const userId = String(input.icNumber || '').replace(/\D/g, '');
    const userName = String(input.userName || '').trim();
    const phoneNo = String(input.phoneNo || '').trim();
    const sessionCode = String(input.sessionCode || '');
    if (!/^\d{12}$/.test(userId)) throw new ServiceError(400, 'INVALID_IC_NUMBER', 'Enter a valid 12-digit Malaysian IC number.');
    if (!userName) throw new ServiceError(400, 'INVALID_USER_NAME', 'Enter the visitor name.');
    if (!/^\(\+60\)\d{4,20}$/.test(phoneNo)) throw new ServiceError(400, 'INVALID_PHONE_NUMBER', 'Enter a valid Malaysian phone number.');
    const { visitor, session } = await resolveVisitorSessionTags(sessionCode);
    let user;
    try { user = responseUser(await palm.describeUser(userId)); } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const requiredTags = [String(visitor.UserTagId), String(session.UserTagId)];
    if (!user) {
      await palm.createUser({ UserId: userId, UserName: userName, PhoneNo: phoneNo, UserTagIdList: requiredTags, PartialFailure: false });
    } else {
      const existingTags = userTagIds(user);
      const mergedTags = [...new Set([...existingTags, ...requiredTags])];
      const needsUpdate = user.UserName !== userName || user.PhoneNo !== phoneNo || mergedTags.length !== existingTags.length;
      if (needsUpdate) await palm.modifyUser(fullUserUpdate(user, { UserName: userName, PhoneNo: phoneNo, UserTagIdList: mergedTags }));
    }
    const tokenResponse = await palm.createUserAccessToken(userId);
    if (!tokenResponse.AccessToken) throw new Error('Tencent did not return a user access token.');
    return { token: tokenResponse.AccessToken, userId, userName, phoneNo, sessionCode };
  }

  async function allUsersForTag(userTagId) {
    const users = [];
    for (let offset = 0; ; offset += 100) {
      const response = await palm.describeUserList({ UserTagId: String(userTagId), Offset: offset, Limit: 100 });
      const page = listUsers(response);
      users.push(...page);
      const total = totalUsers(response);
      if (!page.length || (Number.isFinite(total) && users.length >= total) || page.length < 100) break;
    }
    return users;
  }

  async function cleanupSession(sessionCode, { deleteOrphanVisitors = true, dryRun = true } = {}) {
    const { visitor, session, tags } = await hierarchy(sessionCode, true);
    const report = {
      dryRun, sessionCode, sessionTagId: session ? String(session.UserTagId) : null,
      usersFound: 0, usersUpdated: 0, userUpdateFailures: [], sessionTagDeleted: !session,
      orphanVisitorsFound: 0, orphanVisitorsDeleted: 0, userDeleteFailures: []
    };
    if (session) {
      const affected = await allUsersForTag(session.UserTagId);
      report.usersFound = affected.length;
      const updateResults = await mapLimit(affected, 4, async user => {
        const current = userTagIds(user);
        if (!current.includes(String(session.UserTagId))) return { ok: true, changed: false };
        if (dryRun) return { ok: true, changed: true };
        try {
          await palm.modifyUser(fullUserUpdate(user, { UserTagIdList: current.filter(id => id !== String(session.UserTagId)) }));
          return { ok: true, changed: true };
        } catch (error) {
          return { ok: false, userId: String(user.UserId), ...publicFailure(error) };
        }
      });
      report.usersUpdated = updateResults.filter(result => result.ok && result.changed).length;
      report.userUpdateFailures = updateResults.filter(result => !result.ok).map(({ userId, code, message }) => ({ userId, code, message }));
      if (!report.userUpdateFailures.length && !dryRun) {
        try { await palm.deleteUserTag(session.UserTagId); report.sessionTagDeleted = true; }
        catch (error) { if (isNotFound(error)) report.sessionTagDeleted = true; else report.userUpdateFailures.push({ userId: null, ...publicFailure(error) }); }
      }
    }
    if (deleteOrphanVisitors && !report.userUpdateFailures.length && (report.sessionTagDeleted || dryRun)) {
      const visitorUsers = await allUsersForTag(visitor.UserTagId);
      const activeSessionIds = new Set(tags.filter(tag => isLevel(tag, 1) && parentIdOf(tag) === String(visitor.UserTagId) && SESSION_RE.test(String(tag.UserTagName)) && (!session || String(tag.UserTagId) !== String(session.UserTagId))).map(tag => String(tag.UserTagId)));
      const orphans = visitorUsers.filter(user => {
        const ids = userTagIds(user);
        if (!ids.includes(String(visitor.UserTagId))) return false;
        return !ids.some(id => activeSessionIds.has(id));
      });
      report.orphanVisitorsFound = orphans.length;
      if (dryRun) report.orphanVisitorsDeleted = orphans.length;
      else {
        const deleteResults = await mapLimit(orphans, 4, async user => {
          try { await palm.deleteUser(String(user.UserId)); return { ok: true }; }
          catch (error) { return isNotFound(error) ? { ok: true } : { ok: false, userId: String(user.UserId), ...publicFailure(error) }; }
        });
        report.orphanVisitorsDeleted = deleteResults.filter(result => result.ok).length;
        report.userDeleteFailures = deleteResults.filter(result => !result.ok).map(({ userId, code, message }) => ({ userId, code, message }));
      }
    }
    logger.info?.('Palm session cleanup', {
      sessionCode,
      sessionTagId: report.sessionTagId,
      usersProcessed: report.usersFound,
      usersUpdated: report.usersUpdated,
      updateFailures: report.userUpdateFailures.length,
      tagDeleted: report.sessionTagDeleted,
      orphansDeleted: report.orphanVisitorsDeleted,
      deleteFailures: report.userDeleteFailures.length,
      dryRun
    });
    return report;
  }

  return { resolveVisitorSessionTags, prepareRegistration, cleanupSession, allUsersForTag };
}
