# Root repair verification — 2026-10-07

This pass reviewed the existing fe-api and be-core register and the coordinator's working diff in `.codex-worktrees/Synapse-audit-all-20261007`. It did not expand the audit. No local builds, tests, lint, dependency installation, staging, commits or pushes were run. The regression cases below are written and statically inspected; only CI on the integrated HEAD can establish their result.

## Additional corrections within the assigned repair

- **fe-api-02:** `authRequestGeneration` now shares in-flight `/auth/me` reads and tracks an active authentication transition. A background read cannot inspect the old cookie while login/session exchange/register/TOTP/logout is in progress. Login checks cancellation again after fingerprint collection, before posting credentials. Hook logout clears local identity immediately; its late network result no longer clears a newly logged-in account. Old read success/error and loading updates cannot modify a newer store session. Both hook and store reads use the shared generation boundary.
- **fe-api-01:** `useAdminScope` now checks both account/session key and cache revision before applying effect/explicit-refresh results. This also prevents two overlapping manual refreshes from restoring an older permission set.
- **fe-api-09:** fingerprint prompt state is keyed to account plus authentication generation. Same-account logout/re-login also discards stale reads/dismiss responses; old prompt data cannot flash on a new identity. Error/finally updates use the same guard.
- **be-core-03:** each queue job gets a rejection handler immediately, before the scheduler awaits another database claim. Failure to persist a terminal job state is logged and left to lease recovery rather than creating an unhandled rejection during that claim. Existing retry scheduling waits for active jobs and retains the concurrency limit.

## Existing changes reviewed

| Register | Static disposition |
| --- | --- |
| fe-api-03, 11 | WS identity key causes a new handshake after login. CONNECTING/OPEN reuse, old-socket callback guards, timer cleanup and detached callbacks prevent duplicate active sockets and stale close interference. |
| fe-api-04 | Passkey removal rethrows backend/network failure. A later list refresh failure does not relabel a confirmed deletion as failed. |
| fe-api-05 | Already covered at `cb9fb199`: JSON body cloning/consumption remains inside the timeout lifecycle. No changes made here. |
| fe-api-06 | Shared API and TTS axios error handlers emit the challenge event without clearing the currently stored verification token. Existing `!originalRequest` handling was retained. |
| fe-api-07 | API base URL trims trailing slashes before manual `/api/...` concatenation. |
| fe-api-08 | LogShare validates IDs before opening the database and merges through one readwrite transaction; errors abort/reject, old data is never separately cleared. Public import reports only newly committed IDs and handles file read failure. |
| fe-api-10 | Provider configuration exposes an error and refresh action, retries with bounded backoff, and LoginPage offers retry. Configured disabled and temporary unknown states remain distinguishable. |
| be-core-01, 13 | Both IPv4 CIDR implementations special-case prefix 0; parser trims the network input. |
| be-core-02 | Only inaccurate CSP comments were corrected. Runtime-injected styles remain supported and script nonce policy remains unchanged. |
| be-core-04 | Vivo polling has a bounded overall deadline and rejects repeated invalid progress. |
| be-core-05 | Standalone blocks unlisted browser origins before routes as well as in CORS; explicit origins and origin-less local CLI calls remain supported. |
| be-core-06 | Duplicate registration history is capped at 1000 entries in Mongo and file fallback; logged string fields are bounded. |
| be-core-07 | WAF rejects uninspected deep bodies rather than silently skipping the subtree, including relaxed content fields. |
| be-core-08, 09, 12 | File reads release their descriptor in finally; Bilibili cache has an entry cap and expired-hit deletion; asset restore checks filename boundaries internally. |
| be-core-10, 11 | TOTPDebugger is retained for existing tests, with no production call path; the empty unused middleware file is removed. |
| be-core-14, 15 | Design observations only; no signature-system consolidation or resource-limiter contract change. |

## Added CI regression cases

- `frontend/src/tests/auditApiAuth.test.tsx`: late success after logout, late 401 after switch, shared reads, reads during login, canceled login during fingerprint collection, delayed logout after new identity.
- `auditApiAdminScope.test.tsx`: same-role account switch and overlapping refresh revision ordering.
- `auditApiWebSocket.test.tsx`: repeated connect reuse, login handshake, stale close/message callbacks, heartbeat ownership.
- `auditApiImport.test.ts`: invalid key rejection, atomic rollback/rejection on quota failure, legacy import merge and committed-ID count. Uses a small transactional test double; no IndexedDB dependency added.
- `auditApiPasskey.test.tsx`: removal rejection propagation versus independent list refresh failure.
- `auditApiProviders.test.ts`: transient failure, bounded automatic retry and subsequent manual refresh.
- `auditApiVerification.test.ts`: both axios 403 paths retain the current verification token; configured URL normalization.
- `auditApiFingerprint.test.tsx`: same-account logout/re-login discards the old prompt.
- `src/tests/auditCoreAccess.test.ts`: exact standalone origin allowlist and WAF depth rejection/ordinary nested acceptance.
- `src/tests/auditCoreQueue.test.ts`: claim retry without another enqueue, waiting for active jobs before retry, concurrency bound and immediate job-rejection handling.

Integration note: the coordinator owns the remote merge and final CI. This worker did not modify LoginPage or fetch helpers, and did not merge remote changes.
