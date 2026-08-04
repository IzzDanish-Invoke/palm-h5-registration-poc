# Tencent Palm H5 Registration POC

A minimal end-to-end test site for visitor palm registration using the Tencent Palm Mobile Manager Web SDK.

## Architecture

1. Browser submits visitor details to this server.
2. Server calls `CreateAccessToken` with `GrantType=client_credential_user` and the visitor `UserId`.
3. Browser receives only the short-lived token.
4. Browser starts `PalmMobileManager` with `mode: 'registration'` and `enableManager: true`.

The Management Module is expected to query/create the user and run the registration UI.

## Setup

```bash
cp .env.example .env
# Edit .env with your real PALM_APP_ID, PALM_SECRET_ID and PALM_SECRET_KEY
npm start
```

Open `http://localhost:3000` on the Mac for a loader test.

## Test on a phone

A phone cannot reach the Mac's `localhost`. Use one of these:

### Same Wi-Fi (HTTP may not be sufficient for the host page on all mobile browsers)

Find the Mac IP and open `http://MAC_IP:3000`. The SDK camera itself is inside Tencent's HTTPS iframe, but an HTTPS tunnel is the safer test route.

### HTTPS tunnel (recommended)

Use a tunnel such as Cloudflare Tunnel or ngrok to expose port 3000 over HTTPS, then open the generated HTTPS URL on the phone.

Example with Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

## Important checks

- Loader URL: `https://app.intl.palm.tencent.com/palm_h5/loader/palm-mobile-manager.js`
- The loader must produce `window.PalmMobileManager.PalmMobileManager`.
- Camera permission must be allowed.
- Use a new `userId` and preferably a phone number not already bound to another user.
- Tencent tenant settings must permit in-app user creation and palm registration.
- A successful callback code `0` can also represent user exit; confirm registration using `DescribeUserPalm` or the PalmAI admin console.

## Common result codes

- `10012`: token invalid/expired
- `10022`: user registration disabled in tenant
- `10023`: phone already exists
- `10024`: palm registration disabled in tenant
- `10103`: palm already registered
- `10401`: gateway authorization failure
- `10500`: network error

## Security

Never put `SecretId` or `SecretKey` in browser JavaScript. This POC keeps both in `.env` on the server.
