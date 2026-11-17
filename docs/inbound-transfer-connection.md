# G02 — Agent transfer connection and cleanup

Issue: [G02 #35](https://github.com/sptmru/outbound-freeswitch-dialer/issues/35).
Branch: `feat/g02-safe-agent-rebridge`. Base: `1a5d905`.

The staged `transferConnectionExecutor` consumes G01's immutable accepted intent.
It is supplied explicitly as the `transferConnection` dependency of
`registerCallOfferRoutes`. The default server bootstrap does not install it;
I05 owns activation. No environment variable, production route or deployment
setting changes here. G03 owns browser transfer controls and G04 owns supervisory
handover integration. A live supervisor currently refuses switching safely.

## Durable progression

Each transfer has fixed C03 operations for customer/source preparation, recipient
originate, customer park, new bridge and source cleanup. Child operations have
unique `transfer-execution:<root operation ID>` scopes and stable step keys.
The accepted root request is never rewritten. Preparations must succeed before
the root can originate; each later command requires its predecessor to succeed.
All actual sends use the C03 dedicated execution connection, per-call lock and
single-send transport. SQL transactions never span ESL. Acquisition and discovery
races roll back and rediscover with a bounded retry.

Preparations set `hangup_after_bridge=false` and `park_after_bridge=true`, following
A05. Preparations clear `park_timeout` with an empty assignment: zero means immediate
expiry in [pinned FreeSWITCH park code](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/switch_ivr.c#L908). Recipient originate targets the exact pinned verified Desk contact, with the
E04 operation/controller/binding headers. It parks before the customer is detached.
The original customer UUID, product call ID and campaign survive the transfer.
After confirmed cleanup, separate durable restore steps return the surviving
conversation to `hangup_after_bridge=true` and `park_after_bridge=false`, including
pre-switch recipient failure. A subsequent transfer prepares the flags again.

Only an already attempted command can receive correlated park/bridge evidence.
Channels carry `outbound_dialer_transfer_id`; stale transfer markers and wrong peers
are rejected. Correlation does not compare FreeSWITCH and PostgreSQL wall clocks.
Both a fixed completed `BACKGROUND_JOB` and its concrete effect are required.
Bridge resolution also verifies the current customer bridge peer. A command ACK,
SSE, expiry, a new execution-lock owner or early `uuid_exists=false` cannot resolve
uncertainty. Late events never reopen terminal calls or change ownership.

Confirmed bridge updates the owner, starts recipient participation and closes
source participation. It does not free the source slot. Exact source cleanup
requires a completed fixed cleanup job and channel absence/terminal evidence;
only then can its fenced slot and overlap permit release. Restoring an occupied
slot to active after resolved connection uncertainty is an internal evidence-based
operation, separate from ordinary admission transitions. Cleanup retains the
original reservation/generation, so an old event cannot release a reused slot.

Before switching, recipient failure cancels unstarted children, cleans only the
recipient and keeps the source conversation. If switching fails or the source
has disappeared, the worker uses fixed critical cleanup commands and records a
truthful technical termination; it does not promise to restore an absent source.
An unresolved sender retains both reservations and capacity for reconciliation.
The 10-second connection deadline does not authorize release or a blind resend.
After acceptance, E04 media authorization uses that operation deadline; the earlier
20-second offer deadline no longer revokes a valid connection budget. A DB test
accepts near offer expiry and checks authorization after the offer deadline passes.
Unstarted cleanup has a separate bounded 30-second command deadline. Missing jobs
or unreachable FS remain explicit uncertainty requiring recovery, never success.

Completed/failed transfer history is also revisited after customer termination:
parked agent legs still require exact cleanup. Browser-channel capacity remains
held by the live recipient; transfer-overlap capacity ends with source cleanup.
Existing C06 cleanup owns fenced release and pause preservation.

## Verification commands

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=G02 npm run test:inbound:db:isolated
npm run test:transfers:freeswitch
npm run quality
git diff --check
```

The DB suite labels simulated job/media boundaries explicitly. The FS runner
extends the isolated E02 product-entrypoint lab with local UDP/PCMU endpoints,
real G01 intents, C03 execution and ESL persistence. Readiness/pinned endpoints
are explicit fixtures; this is not browser/provider/deployment acceptance.
Final results, criterion mapping and artifact locations follow after validation.

## Local acceptance record — 2026-11-17

Node 22.13.0, pinned FreeSWITCH 1.10.12 and PostgreSQL 17.11; disposable tmpfs DB,
network-none containers, local UDP/PCMU endpoints, no published ports or provider
traffic. Base revision remains `1a5d905ca3c7e6c6931b0ff0f2e438728aeee4b3`;
implementation is local and uncommitted.

`PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH npm run test:transfers:freeswitch`
**passed all 38 groups**. Artifact: `/tmp/outbound-e02.JWsCXyNf/report.json`.
The retained `source-sha256.txt` matches the final runtime sources. Final snapshots
contain zero unresolved operations, occupied slots or unreleased capacity; actual
FreeSWITCH channel inventory converged to zero. Containers were removed.

| Criterion | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G02.1     | Real inbound/outbound A → B → A transfers retain the customer UUID, call and campaign. Each confirmed handover checks owner, participation, exact slots and decoded 440/660/880 Hz audio in both directions. Old UUID hangup replay cannot end the new conversation. The outbound source conversation is explicitly seeded and uses real originated source/customer channels; initial outbound admission is not reimplemented by this fixture.                                                                                                        |
| G02.2     | Actual recipient SIP 486 and 180/no-answer/CANCEL preserve fresh source audio in both directions. Customer termination before originate cancels accepted transfers in both directions. Eight source-loss cases cover before originate, before park, after park and bridge-before-result persistence: the first two terminate with `failed/transfer_switch_failed`; the prepared-recipient cases recover with two-way audio. Every case resolves fixed cleanup jobs and releases resources.                                                            |
| G02.3     | Real bridge bytes held at a TCP relay survive termination of the C03 PostgreSQL lock backend. Replacement work does not resend or release either occupied reservation before the original job/effect arrives; recovery records one execution attempt. The after-bridge source-loss cases deliberately lose the command result before persistence. DB tests separately prove missing-job retention, wrong peer/transfer-marker rejection, both customer-terminal/handover commit orders, rollback and post-lock revalidation using `pg_blocking_pids`. |
| G02.4     | DB tests separate bridge from old-leg cleanup and retain source occupancy until cleanup. FS cases check source-slot/overlap release and replay old finalization while the source has a new real SIP conversation and a selected pause: the new slot, media and pause survive. Capacity-limit rollback remains covered by G01's real acceptance producer in the full DB gate; transfer-overlap release leaves the current recipient's browser capacity occupied until its own cleanup.                                                                 |

Source-loss and source-reuse conversations are explicitly seeded with real
originated channels for both product directions. The initial incoming happy path
uses actual product ingress/journal/admission; this distinction is retained in the
fixture source and reports. All G01 intents, G02 steps, C03 sends and ESL facts in
these scenarios use the production modules.

The FS gate also passes the seven existing E02 groups, including early INVITE before
HTTP completion, delayed originate bytes/lost response, terminal customer/late answer
and bounded rejected-connect fallback. Readiness and endpoint pinning are explicit
SQL fixtures. These results do not establish browser WebRTC, actual provider,
recording continuity (H02), target storage/load, hosted CI, deployment, rollback or
production acceptance. G03/G04/H01 and I01–I05 retain their own requirements.

No product bootstrap, provider route, production data, commit, push or PR was changed.

## Final regression gates

All commands below ran with Node 22.13.0. The quality wrapper uses the same
network-none disposable PostgreSQL fixture as `test:inbound:db:isolated`, supplies
`TEST_DATABASE_URL` and runs `npm run quality`; it never reads the application DB.
The focused DB command was:

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='G02|E04' npm run test:inbound:db:isolated
```

| Command                                                                                                               | Result and retained evidence                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH=/tmp/node-v22.13.0-linux-x64/bin:/tmp/f02-ffmpeg:$PATH INBOUND_PG_STORAGE=tmpfs bash /tmp/g02-final-quality.sh` | **PASS:** OpenAPI, lint, formatting, typecheck, **504 API / zero skips**, **183 web**, **78 ops**, all builds. `/tmp/outbound-inbound-db.iaZuH3WW/result.txt`, image/isolation metadata, source hashes and successful fixture teardown.      |
| `test:inbound:db:isolated` with the G02/E04 pattern above                                                             | **PASS:** 40 tests, zero skips. `/tmp/outbound-inbound-db.ijxu8ci0/result.txt`. Includes the actual G01 producer's late-Accept deadline test, both terminal/handover commit orders, rollback and authorization revocation.                   |
| `npm run test:service-invites:freeswitch`                                                                             | **PASS:** 24 real Chromium/FreeSWITCH groups. `/tmp/outbound-d01.LlNSSFIp`. Accepted-transfer operations are seeded here; this gate verifies E04 media authorization and two registered endpoints, not the complete G02 browser transfer UI. |
| `npm run test:executor:freeswitch`                                                                                    | **PASS:** five C03 groups, including before-send, delayed-send, lost ACK, reserved critical execution and backlog drain. `/tmp/outbound-c03.ViljkJJP`.                                                                                       |
| `npm run test:cleanup:freeswitch`                                                                                     | **PASS:** seven C06 groups, including both voicemail completion orders, a new source call/pause and native HTTP end/voicemail/lost-response cleanup. `/tmp/outbound-c06.hoYyuA9D`.                                                           |
| `npm run test:voicemail:db`                                                                                           | **PASS:** 8/8 isolated PostgreSQL tests, zero skips. `/tmp/g02-voicemail-db.log`.                                                                                                                                                            |
| `git diff --check`                                                                                                    | **PASS.**                                                                                                                                                                                                                                    |

An earlier broad run observed `hints.onRefresh` being undefined in the unchanged
E03.1 `App.test.tsx` test. Its focused repeat passed 70/70 and the final full web
suite passed 183/183. No web source or test was changed for that observation.

The final FS fixture extension explicitly checks unanswered accepted recipients in
both directions: each observed `-ERR NO_ANSWER`, an actual SIP CANCEL, the same
source bridge/owner, decoded audio in both directions and a released recipient slot.
This fixture-only extension followed the passing full quality gate; application and
API/web/ops test sources were unchanged. The final 38-group FS run, full lint/format
checks and patch hygiene passed after the extension.
