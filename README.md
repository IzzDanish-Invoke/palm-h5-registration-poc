# Tencent Palm H5 Visitor Registration POC

This Node.js POC validates a six-digit visitor session against Tencent's hierarchical user tags before opening the existing Palm H5 registration flow. The server resolves the exact `Visitor` parent and direct session child, creates or fully updates the Tencent user with both tags, and returns only a short-lived user token and public SDK parameters.

## Setup

The project reads configuration directly from the `.env` file in the project root. There is no `.env.example` file and no copy command to run.

Open `.env` and make sure it contains these variables:

```dotenv
PALM_APP_ID=your_app_id
PALM_SECRET_ID=your_secret_id
PALM_SECRET_KEY=your_secret_key
PALM_OPENAPI_HOST=open.intl.palm.tencent.com
PALM_SDK_LOADER_URL=https://app.intl.palm.tencent.com/palm_h5/loader/palm-mobile-manager.js
PALM_VISITOR_TAG_NAME=Visitor
PALM_SESSION_CODE_LENGTH=6
ADMIN_CLEANUP_KEY=replace_with_a_strong_random_value
PORT=3000
```

Do not commit `.env`; it contains Tencent credentials and is already excluded by `.gitignore`.

Install and run the project:

```bash
npm test
npm start
```

Then open `http://localhost:3000`.

For a phone, the Mac's `localhost` will not work from the phone. Use the Mac's local network address or expose port 3000 through an HTTPS tunnel, for example:

```bash
cloudflared tunnel --url http://localhost:3000
```

Open the generated HTTPS URL on the phone.

Required Tencent tag structure:

```text
Visitor                    (level 0)
├── 123456                 (level 1)
└── another six-digit tag  (level 1)
```

Exact names and Tencent `UserTagId` values are used. A matching code elsewhere in the tree is rejected. The server prefers `DescribeUserTagTree` and automatically falls back to paginated `DescribeUserTagList` when the Tencent role lacks tag-tree permission.

## API

### Prepare registration

`POST /api/visitor-registration/prepare`

```bash
curl -X POST http://localhost:3000/api/visitor-registration/prepare \
  -H 'Content-Type: application/json' \
  -d '{
    "icNumber":"900101-14-5678",
    "userName":"Visitor Name",
    "phoneNo":"0123456789",
    "sessionCode":"123456"
  }'
```

The server normalizes IC and phone values, validates the tag hierarchy, creates or updates the user without clearing optional fields, and obtains a user-bound token. The response contains `token`, `appId`, normalized user fields, and `sessionCode`; it never contains Tencent server credentials or server access tokens. The public route is limited to 10 attempts per source IP per minute.

### Preview session cleanup (default and recommended first call)

`POST /api/admin/session-tags/:sessionCode/cleanup`

```bash
curl -X POST http://localhost:3000/api/admin/session-tags/123456/cleanup \
  -H "Authorization: Bearer $ADMIN_CLEANUP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"deleteOrphanVisitors":true,"dryRun":true}'
```

### Apply session cleanup

```bash
curl -X POST http://localhost:3000/api/admin/session-tags/123456/cleanup \
  -H "Authorization: Bearer $ADMIN_CLEANUP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"deleteOrphanVisitors":true,"dryRun":false}'
```

Cleanup paginates through users, removes only the expired tag using complete user updates, and deletes the tag only when every update succeeds. It then deletes explicit `Visitor` users with no remaining direct six-digit Visitor child. Dry-run makes no Tencent mutations. Already-removed tags/users are treated as completed so retries are safe. A partial result uses HTTP `207`; authentication failures use `401`.

## Security and operations

- `PALM_SECRET_ID`, `PALM_SECRET_KEY`, TC3 signing, and both server/user token creation stay server-side.
- Normal management calls reuse a cached `client_credential` token and include `X-Palm-Openapi-Token`.
- API starts are serialized at least 50 ms apart to respect 20 requests/second/AppId; bulk mutations additionally use concurrency 4.
- Logs contain action/RequestId and cleanup counts. Route errors are sanitized and identity values are not logged.
- There is no automatic cleanup scheduler. Cleanup is a manually authorized operation and is destructive when `dryRun` is false.

## Troubleshooting preparation errors

Open **Technical result** under the form after a failure. It shows the safe application code, HTTP status, failed Tencent action, Tencent error code, and RequestId. If `DescribeUserTagTree` is unavailable, the server automatically tries `DescribeUserTagList`. Any permission error shown after that identifies the exact Tencent action that still needs access. The response never includes secrets, tokens, authorization headers, IC numbers, or phone numbers.

## Tests

```bash
npm test
```

The dependency-free mocked tests cover exact/wrong-parent/fuzzy tag resolution, new and existing users, optional-field preservation, invalid-code safety, selective cleanup, active-session preservation, update failure behavior, orphan deletion, dry-run, idempotency, pagination, and frontend secret exposure.

## Tencent API assumptions

The supplied Palm OpenAPI requirements do not specify every response container name or the documented not-found error codes. The implementation accepts the common response containers (`User`, `UserInfo`, `UserList`, `Users`, `Data`, `Items`) and treats Tencent codes/messages containing `not found`, `not exist`, or `non-exist` as idempotent missing resources. User tag IDs may be strings or objects in `UserTagList`. Before production rollout, confirm these shapes and the `DescribeUserTagTree` availability against the tenant's Palm OpenAPI documentation or captured sandbox responses.

`ModifyUser` is treated as a full update. The documented mutable identity fields (`UserName`, `PhoneNo`, `PhysicalCardNo`, `CustomFieldValue`, and all tag IDs) are sent together with `PartialFailure: false`.
