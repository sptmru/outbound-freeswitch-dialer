# E04 — Authorized service INVITEs

Task: [E04 #28](https://github.com/sptmru/outbound-freeswitch-dialer/issues/28).
Branch: `feat/e04-service-invite-authorization`, base `937ae12`.
Changes are local and uncommitted. No provider traffic or deployment is enabled.

## Media authorization

A native service INVITE is a request to connect an already accepted operation.
It cannot accept an offer or change the product owner. The browser requires all
of these headers before requesting media:

- `X-Outbound-Dialer-Call-ID`: product call UUID.
- `X-Outbound-Dialer-Operation-ID`: durable recipient originate operation UUID.
- `X-Outbound-Dialer-Desk-Session-ID`: controlling Desk UUID.
- `X-Outbound-Dialer-Binding-Generation`: canonical positive PostgreSQL bigint,
  retained as a string.
- `X-Outbound-Dialer-Leg-ID`: fixed FreeSWITCH agent-leg UUID.
- SIP `Call-ID`: the physical SIP dialog identifier, separate from product call ID.

Missing, duplicate, malformed, foreign-session or stale-generation headers fail
before SIP answer or peer creation. Native headers delivered to a legacy browser
mode are refused; they cannot downgrade to the feature-off auto-answer path.

`POST /agent/service-invites/authorize` consumes strict `ServiceInviteRequest`
and returns `{authorized: true, ...input}` or `409 service_invite_unavailable`.
Authentication and cookie-origin protection use the existing API policy. All
responses carry `Cache-Control: no-store`. The request has `callId`,
`operationId`, `deskSessionId`, `bindingGeneration`, `legUuid`, and `dialogId`.
Extra fields and noncanonical/overflow generations are rejected with HTTP 400.

Inside common admission, the server checks current actor/auth version,
unrevoked/unexpired Desk, recent verified pinned contact, exact operation
endpoint and SIP identity, full slot token and participant, live concrete leg,
operation generation/deadline/state, and persisted C03 sender identity.
A queued/pending intent without sender evidence cannot authorize media.
Inbound additionally requires E02's accepted offer and open connection attempt;
outbound requires the persisted C04/C05 admission identity. Transfer requires
an accepted recipient offer and its connecting/switching transfer operation.
For this seam, `call_transfers.operation_id` identifies the fixed recipient
media operation; G01/G02 must preserve these identities when integrating it.

Heartbeat revision changes after admission do not invalidate a matching binding.
No new offer/owner/slot/capacity, send, or contact attempt is created here.
A call ending or slot entering release before the admission lock is acquired
causes post-lock rejection. Failure never releases occupied resources.

Migration `039_service_invite_authorization.sql` adds `service_invite_dialogs`.
The primary key permits one physical dialog per operation. An exact HTTP retry
can recover the same dialog result only while current authorization still holds;
a different dialog cannot reuse it after reload/reconnect or ambiguous HTTP loss.
The identity is immutable and cannot be deleted while its call or operation is
unresolved. It cascades with drained operation retention; H04 owns integration
of the broader native retention graph. The upgrade does not grant old rows any
media authorization and leaves previous schema/history unchanged.

## Browser and command lifecycle

The softphone reserves its local invitation before awaiting HTTP authorization.
Concurrent delivery cannot replace that reservation. Authorization has a 2500 ms
abort bound; unmount aborts pending requests. Before answer, it rechecks the exact
invitation, registration lifetime, current binding and every echoed identity.
Late responses and canceled/replaced invitations cannot attach audio or clear a
newer call. A consumed operation cannot create another local media session.
An established dialog survives registration/heartbeat loss under D01's recovery
protocol without requesting a replacement media session. Confirmed terminal
signaling closes its microphone/peer/audio; browser cleanup never releases DB
reservations. SIP REFER is explicitly rejected, including the library's default
automatic-follow behavior.

`serviceInviteCommand` builds one fixed UUID/header set and the exact
D01-verified `sofia/internal-webrtc/...` contact. E02 uses this constructor;
`OriginateAgentBridgeCallInput.serviceOperation` applies it to the existing
outbound bridge constructor while retaining customer/trunk, early-media and
configured timestamp policy. Identity mismatches throw. The legacy constructor
remains available only to the feature-off path; native code never uses AOR
`user/<username>` routing. The native endpoint timeout remains four seconds.
G02 can reuse the same primitive with its own action-specific C03 validator.

## Verification and boundaries

```bash
npm --workspace @outbound-dialer/shared run build
npm run quality
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run test:service-invites:freeswitch
npm run test:acceptance:freeswitch
npm run test:voicemail:db
git diff --check
```

The focused browser unit gate is:

```bash
npm --workspace @outbound-dialer/web test -- src/service-invites.test.ts src/softphone.lifecycle.test.tsx
```

| Criterion | Evidence supplied                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E04.1     | Header/lifecycle matrix; exact actor/operation/leg/binding API checks, pending-offer refusal, stale/revoked/expired/moved/terminal/uncertain state; real FS negative delivery with zero peer creation and unchanged offer ownership.                                                                                                                                                                                    |
| E04.2     | Held real E02 Accept HTTP response with native SQL authorization before response delivery; unsent-intent rejection; observed PostgreSQL blocking for competing dialogs and release, both commit orders and rollback; browser held authorization/cancellation/replay; actual FS duplicate delivery, one peer and no ended-operation reconnection.                                                                        |
| E04.3     | Pinned constructor unit checks, existing outbound constructor regression, and actual Chromium WSS/DTLS-SRTP with two registered Desk identities for inbound/outbound/transfer-shaped accepted reservations; stale PATCH/DELETE, old-tab reload/close, occupied takeover and reconnect preserve the same media. Both decoded audio directions and browser RTP/DTLS statistics are asserted separately from mocked tests. |

`test:service-invites:freeswitch` reuses the D01 disposable lab with an E04
matrix. It uses the production softphone, HTTP auth/Desk/authorization handlers,
PostgreSQL schema, pinned FreeSWITCH 1.10.12 and Chromium. Three cases use seeded
accepted operation/slot/participant/sender state; the transfer case has a real
source endpoint and overlap claims but no G02 switch executor. An obsolete
revoked directory is deliberately reprovisioned to simulate delayed cleanup:
that real registered endpoint must receive no service INVITEs. The old browser
really reloads and closes. Known 440 Hz customer and 880 Hz microphone fixtures
are decoded on opposite endpoints; PCMU thresholds and native timing are unchanged.
The separate E02 DB/API check uses the actual acceptance transaction/HTTP route;
its sender checkpoint is simulated and is not FS proof.

The E04 lab's PostgreSQL storage is explicit bounded tmpfs. Artifacts under
`/tmp/outbound-d01.*` retain source/image hashes, network isolation, safe SIP
metadata, commands/events, media measurements, SQL authorization identity and
container teardown. No `.env`, provider, host-published port or production service
is used. Tmpfs establishes local correctness, not target-disk performance or
crash durability. A failed disk-backed/intermediate run is never a passing gate.

The default `server.ts`/Desk snapshot still does not install native executors or
publish `coordination`. I05 owns that bootstrap and coordinated rollout/drain;
G01/G02 own real transfer production/switching, H01/H04 recovery/retention,
and I01–I05 broader integrated/browser/load/provider/far-end/target acceptance.
These checks do not establish production activation, actual provider calls,
physical-device audio, target-storage performance, hosted CI, backup/restore,
or rollback. Final results and artifacts are recorded in the issue handoff.

## Verified local result — 2026-11-16

- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: **132/132**, zero
  skips, PostgreSQL 17.11; `/tmp/outbound-inbound-db.4x5HSlY7/`.
- `npm run test:service-invites:freeswitch`: **24/24** groups, three authorized
  dialogs, one browser peer per shape, zero browser errors; occupied slots,
  retained capacity, unresolved operations and unresolved connections all zero.
  `/tmp/outbound-d01.9O0V3i1N/browser-report.json`, SHA-256
  `3603a1a525f40aadfdc80630196315d3c679c48c62adb1c5f706f656e16f0df7`.
  Real Chromium 149.0.7827.55, FreeSWITCH 1.10.12 and decoded 440/880 Hz audio;
  no provider or full G02 transfer executor.
- `npm run test:acceptance:freeswitch`: **7/7**, including actual INVITE/bridge
  before the delayed real Accept HTTP response and replay/lost-ACK/failure
  cleanup; `/tmp/outbound-e02.rbiAKRpW/`. This uses UDP SIP media, independently
  of the Chromium matrix above.
- `npm run test:voicemail:db`: **8/8**, zero skips, separate disposable PostgreSQL
  fixture; `/tmp/e04-voicemail-final.log`.
- `npm run quality`: **PASS** OpenAPI/lint/format/types/tests/builds; API 304
  passed / 131 DB skips without `TEST_DATABASE_URL`, web 175/175, operations
  78/78; `/tmp/e04-quality-final.log`. The complete DB result above is separate.
- Focused header/lifecycle tests: **20/20**, including late allow after the
  2500 ms abort deadline; `/tmp/e04-web-final.log`.
- Shell/JavaScript syntax, final documentation formatting and
  `git diff --check`: **PASS**. Disposable containers were removed.

Intermediate diagnostics were not passes. They include a disk-backed browser
fixture's `25P03` idle-transaction termination, test-only obsolete-schema,
terminal-dialog-selection and HTTP-barrier mistakes, and one browser `NO_ANSWER`
during concurrent quality work. Final sequential runs retain the original
application budgets and media thresholds. This does not establish a root cause
for host contention or replace the target-storage/load gates in I03–I05.
All changes remain local/uncommitted; the activation and external-acceptance
boundaries above remain open in their owning tasks.
