# Bilibili Login Cookie Report Contract

Cross-repository contract between **PiliPlus** (reporter) and **Synapse** (sink).
Companion to `docs/bilibili-settings-sync-contract.md`; the two surfaces are
deliberately independent.

## What this endpoint is

`POST /api/bilibili-reports/cookie` is a **report-only sink**. A client calls it
once, immediately after a Bilibili login completes, and archives the cookie that
just worked.

| | settings/search sync | login cookie report |
|---|---|---|
| Requires a Synapse account / OAuth token | yes (`bilibili:sync`) | **no** |
| Requires a prior bind (`/uid`) | yes | **no** |
| Identity of the caller | Synapse user + device | **device id only** |
| Direction | read + write | **write only** |
| Storage key | `userId` (+ UID) | `(clientId, deviceId, bilibiliUid)` |

## Request

```http
POST /api/bilibili-reports/cookie
Content-Type: application/json
X-Device-Id: <same value as body.device_id>
X-Synapse-Device-Id: <legacy alias, same value>
```

```json
{
  "client_id": "piliplus",
  "device_id": "…",
  "uid": "12345",
  "cookie": "SESSDATA=…; bili_jct=…; DedeUserID=12345",
  "isPrimary": true,
  "device": { "platform": "Android", "model": "Pixel 9" },
  "permissions": { "notification": "granted" },
  "client": { "client_id": "piliplus", "client_version": "…", "platform": "Android" }
}
```

## Gates

1. **Client allow-list** — `client_id` must be registered for device reports
   (`REPORT_CLIENT_ALLOW_LIST`, currently `piliplus`). Unknown clients get 403
   `BILIBILI_REPORT_CLIENT_UNKNOWN`.
2. **Device id** — `^[A-Za-z0-9_-]{8,128}$`, and the body value must equal the
   `X-Device-Id` / `X-Synapse-Device-Id` header
   (403 `BILIBILI_REPORT_DEVICE_MISMATCH`). A report cannot claim somebody else's
   device id from the header while sending its own in the body.
3. **Rate limit** — `bilibiliReportLimiter`: 12 requests / 5 min per IP.
4. **Server-side truth** — the claimed `uid` is never trusted. The cookie is
   replayed against `https://api.bilibili.com/x/web-interface/nav`; a cookie that
   is not logged in, or whose `mid` differs from the claimed UID, is rejected with
   401 `BILIBILI_COOKIE_INVALID` and nothing is written.
5. **Quota** — at most 32 distinct UIDs per `(clientId, deviceId)`
   (409 `BILIBILI_REPORT_DEVICE_LIMIT`); an already-known UID may always refresh.
6. **Size** — cookie ≤ 8192 chars (413 `BILIBILI_COOKIE_TOO_LARGE`), device
   snapshot ≤ 16 KiB, ≤ 512 permission entries.

First-visit IP verification is bypassed for this path **on purpose** (declared as
`securityBypass.ipVerification` on the `bilibili-cookie-report-routes` module):
the reporter is an app client with no session and no interactive human-check UI,
and a report that pops a captcha would no longer be silent. Abuse is limited to
spamming one's own valid cookies, which the allow-list, the per-device quota, and
the per-IP limiter cover.

## Storage and response

The cookie is stored as AES-GCM ciphertext only (`credentialCiphertext`,
`credentialIv`, `credentialTag`, `credentialKeyVersion`, all `select: false`),
encrypted with `encryptCredential()` and the `BILIBILI_COOKIE_ENCRYPTION_KEY`.
Every accepted report bumps `reportCount` and `lastReportedAt`; the first one
sets `firstReportedAt`.

```json
{ "success": true, "data": { "accepted": true, "uid": "12345", "status": "active", "reportedAt": "…", "reportCount": 3 } }
```

Errors use the sync envelope: `{ success: false, error, code }`. Neither the
cookie, nor an upstream Bilibili body, nor a ciphertext fragment is ever echoed
into a response, a log line, or audit metadata (`cookie` is a redacted audit
field).

## Read surface

`GET /api/admin/bilibili-reports?page=&limit=&search=` (admin JWT, same chain as
the rest of `/api/admin`) returns metadata only: `clientId`, `deviceId`, `uid`,
`isPrimary`, `status`, `reportCount`, `firstReportedAt`, `lastReportedAt`,
`deviceSummary`, `permissionsCount`, `client`, `userId`. The listing never
returns the cookie.

## Reveal surface (superadmin + security session)

The admin panel `/admin/bilibili-data` can decrypt a stored cookie on demand. It
is the only endpoint in this area that returns plaintext, and it is fenced:

| gate | behaviour |
|---|---|
| `authenticateSuperAdmin` | plain `admin` keeps metadata-only access |
| `requireSecuritySession` | a fresh step-up (password / TOTP / passkey) is mandatory; `x-verification-token` header, TTL from `security.session.ttlSeconds` |
| payload capture | `suppressAuditPayloadCapture(req)` keeps the plaintext out of `AUDIT_LOG_CAPTURE_PAYLOADS` |
| audit | one `privacy.bilibili{Report,Account}Reveal` entry per request with counts + identifiers only, never the cookie |
| batch | `items` is required, ≤ 50 rows; more is `413 BILIBILI_REVEAL_ITEMS_TOO_MANY` |
| caching | `Cache-Control: no-store` |
| per-row failures | `undecryptable` (ciphertext does not match any key in the chain) / `not-found` — the batch still returns `200` |

```http
POST /api/admin/bilibili-reports/credentials
x-verification-token: <step-up token>
{ "items": [{ "clientId": "piliplus", "deviceId": "…", "uid": "12345" }] }
```

```json
{ "success": true, "data": [{ "clientId": "piliplus", "deviceId": "…", "uid": "12345", "status": "active", "lastReportedAt": "…", "cookie": "SESSDATA=…" }] }
```

`POST /api/admin/bilibili-accounts/credentials` behaves identically and is keyed
by `(userId, uid)`. Both are `POST` on purpose: the record set belongs in the
body, because URLs end up in access logs, browser history, `Referer` and the
unconditionally-captured audit `detail.query`.

Decryption reuses the single key chain in `decryptStoredCredential()`
(current `KL.BILIBILI_CRED` subkey first, then the legacy env keys and the
`config.jwtSecret` derivation), so a rotation never strands old rows.

## Reporter behaviour (PiliPlus)

- Fires on every completed Bilibili login: QR scan, password, SMS, and pasted
  cookie, whether the account becomes the main account or not, plus the main
  session-establishment callback.
- Silent: no dialog, no toast, no Bilibili interceptor, no OAuth token, no
  first-visit captcha UI. Failures are recorded as crash breadcrumbs only.
- One report per login event: duplicate triggers for the same UID inside a 45 s
  window collapse into the first one (the login page callback and the main
  account callback both fire for a single login).
- Kill switch: `SettingBoxKey.synapseCookieReportEnabled` (default on), exposed
  in the Synapse settings dialog.

## Tests

- `src/tests/bilibiliCookieReport.test.ts` — allow-list, device id format/header
  agreement, empty and oversized cookie, UID mismatch (fail closed, no write),
  per-device quota, ciphertext-only write, metadata-only listing, controller
  envelope, admin gating.
- `src/tests/bilibiliCredentialReveal.test.ts` — round-trip decrypt, foreign-key
  `undecryptable`, `not-found`, empty/oversized batch rejection, account
  `(userId, uid)` keying, `no-store` + audit-without-plaintext, failure-path audit.
- PiliPlus: `test/services/synapse_cookie_report_test.dart` — payload shape,
  cookie serialization, per-login dedupe window, error classification.
