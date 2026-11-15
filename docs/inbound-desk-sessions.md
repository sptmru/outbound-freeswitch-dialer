# D01 — Controlling Desk sessions

Date: 2026-11-15. [Issue #21](https://github.com/sptmru/outbound-freeswitch-dialer/issues/21).
Original implementation: `feat/d01-desk-sessions`, base `4fc84ef`, merged by the
owner as `c363470`. The [browser recovery follow-up](inbound-desk-browser-recovery.md)
records real WSS/WebRTC evidence, the local fix and the remaining terminal
signaling failure. Its branch is `feat/d01-browser-recovery`; closure is reserved
for the owner. The evidence tables below describe the original implementation run.

D01 implements the authenticated lifecycle and its staged browser adapter. It does
not enable inbound routing or install the I05 bootstrap/native executors. The
normal API still omits `AgentDeskResponse.coordination`; the browser uses D01 only
when the server supplies that contract. Provider acceptance remains I04/I05.

## Selection

The working tree was clean. Read `AGENTS.md`, tracker #1, the full D01 issue,
source plan §9.1, requirements, architecture, implementation status, environment
contract, ADR 0001 and A04/C07 artifacts. Searched the KB for backlog selection,
`desk_sessions`, D01/A04 and similar registration incidents. Current GitHub REST
confirmed A01–C07 closed; D01 depends specifically on A04 #5, B02 #10, B05 #13,
C05 #18 and C07 #20. Their dependency statements and links were read. There is
no whole-phase prerequisite for D01. Native GitHub `blocked_by` is empty; it does
not override the issue text. An immediate second check found no assignee,
work-start comment or open PR; timeline contained issue cross-references only.
Posted the start comment before creating this branch. Only D01 was selected.

## HTTP and persistence

- `POST /agent/desk-sessions`: `CreateDeskSessionRequest`. An authenticated actor
  with a reconciled free slot can replace the named current revision. A missing
  controller requires `expectedRevision: null`. Legacy interactive calls and
  supervisor media also prevent takeover. Revocation, recipient-only pending
  offer/transfer cancellation and auto-intent cancellation commit together.
- `PATCH /agent/desk-sessions/:sessionId`: `UpdateDeskSessionRequest`, with path
  equal to `deskSessionId`. The server checks user activity/auth version, session,
  revision and binding generation under the common admission/media/agent/slot
  lock order. Campaign changes lock their active parent before media locks.
- `DELETE /agent/desk-sessions/:sessionId`: `DeskMutationRequest`. Clears readiness,
  revokes this generation and cancels its pending work; never frees a slot, hangs
  up a call, or removes an occupied endpoint.
- All routes retain cookie-origin protection and bearer support. Cross-agent IDs,
  injected destinations, secrets and extra fields are rejected. Success uses
  `Cache-Control: no-store`. `revision_conflict` can return the authenticated same
  session snapshot to resynchronize a reconciler-induced revision; it grants no
  different-generation authority.

Migration `033_desk_session_lifecycle.sql` adds `endpoint_pin`,
`actor_auth_version`, registration check/cleanup timestamps and
`agent_desk_mutations`. Pre-D01 rows retain evidence but lose readiness; no auth
version or free media state is fabricated. Existing migration history is unchanged.
The per-agent idempotency key records a canonical fingerprint and credential-free
result. Replays do not extend the lease; changed payloads conflict. Current-owner
create retries can reprovision and return their credentials. Revoked/expired
identities cannot recover credentials through old keys.

Credentials are server-generated per generation, encrypted through the existing
v1/v2 SIP secret mechanism, and included only in the owning current create response
as optional `DeskSessionResponse.sip`. That object includes `username`, `password`,
`domain`, `websocketUrl` and `iceServers`. Encryption migration also covers Desk
secrets. Directory entries are created by repo provisioning helpers; cleanup removes
only the obsolete username, reloads XML and issues exact
`sofia profile internal-webrtc flush_inbound_reg <old-user>@<domain>`.
It never flushes a whole profile or the current identity. Pre-D01 rows without
an authenticated controller version are never treated as cleanup authority for
a legacy agent directory; only server-issued D01 generation identities are removed.

## Verification, expiry and recovery

The A04 protocol uses a distinct `desk_<random UUID>` SIP identity for every
Desk generation. SIP.js sets that identity as `contactName`. Only native
`sofia_contact internal-webrtc/<identity>@<domain>` can attest a destination.
The parser accepts one matching profile/identity and safe encoded `fs_path`, and
rejects missing, malformed, multi-contact and dial-expression results. The first
contact pins the generation; a moved contact cannot silently replace the pin.
See the primary [FreeSWITCH registration implementation](https://github.com/signalwire/freeswitch/blob/master/src/mod/endpoints/mod_sofia/sofia_reg.c)
for encoded NAT `fs_path`; source capability is separate from runtime proof.

FS lookup/provisioning/cleanup runs outside database transactions. Applying lookup
results requires fresh session/revision/generation authority. Failed lookup clears
readiness and pending work. Agent-level `registered` never proves native readiness;
per-Desk identities are excluded from that legacy registration/drift count.

The lease is 30 seconds, browser heartbeat 5 seconds, and admission rejects
verification older than 15 seconds. Database time controls eligibility and expiry.
The background registration reconciler checks at most 20 sessions and cleans at
most 20 obsolete identities per pass, ordered fairly by last check. Each ESL
command uses the existing 5-second deadline. Expired idle controllers are revoked;
occupied slots survive expiry, auth loss, registration loss and DELETE. An
unrevoked authenticated _same_ occupied controller may renew its own generation
after expiry; ordinary occupied takeover remains forbidden in `reserved`,
`connecting`, `active`, `releasing` and `uncertain`.

The browser controller serializes updates, retains the exact key/payload after an
ambiguous HTTP failure, adopts a same-generation snapshot after definitive CAS
rejection, and closes a late-created session after unmount. Campaign changes do
not recreate SIP transport. A failed heartbeat disables native starts and never
releases media. Full service-INVITE acceptance correlation remains E04; native
Desk response/executor bootstrap and target enablement remain I05.

## Acceptance and evidence

| Criterion | Evidence delivered                                                                                                                                                                                                                                                          | Limit                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01.1     | Real PostgreSQL/API current controller, campaign mismatch, expiry, auth version, freshness, missing/moved/ambiguous contact, strict authorization/CSRF and leave. Chromium Desk enter/REGISTER/heartbeat/leave. Real FS exact-contact and ambiguous-registration scenarios. | Chromium uses simulated HTTP/SIP/media; no real browser WebRTC claim.                                                                                                            |
| D01.2     | Two real PostgreSQL connections, observed `pg_blocking_pids`, both takeover/admission commit orders and rollback; delayed lookup and stale PATCH/DELETE. Two Digest SIP identities, old refresh/unregister/close, precise obsolete cleanup.                                 | No production or provider acceptance.                                                                                                                                            |
| D01.3     | DB/API occupied-state matrix and unchanged full slot tokens. Pinned FS actual bidirectional decoded RTP for inbound/outbound/transfer-shaped reservations during expiry and same-controller recovery.                                                                       | Browser controls and reservation setup are simulated; actual browser WSS/WebRTC disconnect/reconnect during inbound/outbound/transfer reservations remains an open runtime gate. |

The FS fixture uses native D01 HTTP handlers, product schema, provisioning,
contact lookup and reconciliation; SIP clients and media are real. Its call and
transfer reservations are seeded, and terminal teardown is fixture-controlled.
It does not execute the future D/E/G product call-flow matrix.

Commands and final artifact paths/results are recorded below after validation.
The original handoff left D01 open with tracker #1 unchecked. The follow-up
above records the current browser evidence and remaining terminal signaling
failure; the owner decides closure. Neither run includes a push, PR, deployment,
provider call, production change or hosted CI execution.

### Recorded checks

Environment: Node v23.7.0; isolated PostgreSQL 16 and pinned FreeSWITCH
`1.10.12` image digest as recorded in each runner's `image(s).txt`. No application
`.env`, provider traffic, host-published ports or production services were used.

| Command                                                                                                  | Result / artifact                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run quality`                                                                                        | PASS: OpenAPI, lint, formatting, types, build; API 287 passed / 76 DB-dependent skips, web 141 passed, operations 76 passed. `/tmp/d01-quality-complete.log`. DB skips are covered separately below.                                                                |
| `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`                                              | PASS, 77/77, no skips. `/tmp/outbound-inbound-db.D9wlWSM6/` includes source hashes, image, isolation, race reports and teardown.                                                                                                                                    |
| `INBOUND_PG_STORAGE=tmpfs bash /tmp/d01-focused-db.sh`                                                   | PASS, 6/6 on final cleanup guard. `/tmp/outbound-inbound-db.ibtCF0sF/`. Temporary copy of the existing runner with only its test invocation replaced by `node --test apps/api/dist-test/desk-sessions.integration.test.js`; schema, isolation and limits unchanged. |
| `npm run test:desk:freeswitch`                                                                           | PASS, nine groups / 15 occupied media cases. `/tmp/outbound-d01.sQkv4CfS/report.json`, source hashes, image digests, isolation and cleanup logs. Real unregister/re-register, expiry and bidirectional decoded tone evidence; no browser WebRTC claim.              |
| `npm run test:voicemail:db`                                                                              | PASS, 8/8, no skips. `/tmp/d01-voicemail.log`.                                                                                                                                                                                                                      |
| `npm run test:e2e -- tests/e2e/desk-sessions.spec.ts`                                                    | PASS, Chromium 1/1 with actual rendered application and simulated API/SIP/media. `/tmp/d01-browser-final.log`.                                                                                                                                                      |
| `npm --workspace @outbound-dialer/web test -- src/desk-session.test.ts src/softphone.lifecycle.test.tsx` | PASS, 15/15. Exact replay, reconciler CAS recovery, late callback fencing, native SIP credential/contact selection and cleanup. Also included in final quality.                                                                                                     |
| `git diff --check`                                                                                       | PASS.                                                                                                                                                                                                                                                               |

The default disk-backed command `npm run test:inbound:db:isolated` did **not**
pass: 76/77 passed, with the existing C03.3 saturation scenario (eight held executions and two control
processes with four lanes) exceeding its unchanged 250 ms admission lock timeout.
Artifact: `/tmp/outbound-inbound-db.7I8B0SMg/`. D01's six DB/API/upgrade groups
passed there too. Earlier simultaneous runners also caused migration-lock
interference; final correctness runs used one PostgreSQL runner at a time.
The KB contains a previous Docker-volume WAL-flush incident with similar symptoms;
this session does not independently prove its cause or target-storage performance.
Tmpfs success is a correctness result and does not replace the failed volume/load
gate or target-storage acceptance. No timeout, fsync or resource threshold was
relaxed to obtain a green result.

Remaining mandatory D01 gate: an isolated **real browser WSS/WebRTC**
disconnect/reconnect matrix while inbound/outbound/transfer reservations are
occupied. The available FS fixture uses UDP SIP, whereas the Chromium fixture
simulates API/SIP; combining them is not end-to-end WebRTC proof. A suitable real
browser/FS fixture and its retained media/slot evidence are needed before closing
D01. I01–I05 retain their own broader product, provider, load and enablement gates.
