# C05 — Durable automatic next-lead intents

Task: [C05 #18](https://github.com/sptmru/outbound-freeswitch-dialer/issues/18).
Base: `4d5b2f6`; local branch: `feat/c05-durable-auto-next`.

## Admission and replay

`POST /agent/call-next` accepts the existing B05 `intent.startReason: automatic`
contract through `createDialerCall` and the shared outbound producer. It requires
`sourceCallId`, `deskSessionId`, `expectedRevision`, `bindingGeneration` and
`idempotencyKey`. It uses the same optional, server-owned native executor seam as
C04. No new route, environment variable or client-selected execution authority is
introduced. Cookie-origin, authentication and current auth-version checks remain.

The source must be this agent's outbound campaign contact call, with manual dial
false, matching campaign, and a terminal completion or confirmed voicemail agent
release. The latter requires persisted release time/event and an ended agent leg;
customer playback may continue and retains its own capacity. Inbound completion,
manual numbers, another agent's call, an unfinished source, and transferred calls
are invalid sources. A completed transfer excludes both the previous and eventual
owner from treating handover as campaign progression.

Under C01 ordered admission and database time:

1. Recheck actor and replay source identity before mutable eligibility. One row per
   `(agent_id, source_call_id)` survives tab retries, alternate retry keys and the
   resulting call's completion. Another source cannot reuse its key. Changed
   campaign/session/revision/binding payload conflicts. Started replay returns the
   original call/operation even during maintenance; it never sends again.
2. Check campaign auto-advance, current controller/revision/binding, registration,
   readiness, pause, occupancy, supervision and source validity. Canceled intent is
   terminal. A stale callback is never upgraded to manual.
3. Check eligible durable queued inbound before selecting/locking any contact.
   Offers need not exist. Persist the same intent as `deferred/incoming_pending`
   without a call, attempt, operation-to-dial, slot, capacity claim or executor wake.
   Pending transfer offers also defer automatic work without declining the source.
4. Persistent `(call_id, agent_id)` ignore/expiry exclusions apply regardless of
   Desk identity or queue reentry. Expired pending offers do not veto auto work.
   Repeating the same deferred request reevaluates the FIFO queue; another eligible
   call still defers. No excluded call is silently reopened.
5. Otherwise use C04 contact validation and C01/C02/C03 claims in the same commit:
   one contact attempt, call, concrete participants/legs, slot, capacity plan and
   fixed originate operation. Mark the intent `started` with those identities.
   Automatic work never dismisses an offer as manual. Pre-commit errors roll back
   the entire transaction. Post-commit wake failure leaves durable work retained.
6. If outbound commits first, later inbound observes occupancy and cannot cancel
   it. The C03 pre-send validator rechecks the persisted auto intent, current
   controller/token and enabled flag; later queue arrival is not a veto.

C04 manual claim cancels open intents atomically. C01 `reserve` cancels open
intents on explicit offer acceptance, for inbound and transfer alike. Revision,
campaign, controller, binding, pause or eligibility loss observed on retry cancels
rather than restarts automatic work. A newer admitted call or accepted offer since
source completion also prevents a first late callback from dialing after that work
has ended. Future D01 lifecycle mutations must revoke/revise controllers under the
same gate; E01/E02/G01 must use these shared exclusion/reservation operations.

## Storage and compatibility

Migration `030_auto_next_identity.sql` adds nullable `request_fingerprint` and
`binding_generation` to existing B04 storage. Nullable columns preserve previous
writers and historical rows; C05 requires both for execution. Unknown legacy pending
identity is canceled instead of guessed. B04 immutable source/terminal guards remain.
Migrations are forward-only. No applied migration was edited.

The feature remains staged. `server.ts` still installs no native executor seam;
v1 starts fail closed before mutation in that bootstrap. The legacy feature-off
browser remains unchanged; it cannot bypass the native cutover fence. E03 owns the
new browser callback/retry/ringback workflow, D01 owns controlling-session lifecycle,
C06/C07 own remaining release/eligibility integration, and H01 owns scheduling and
recovery. This task introduces no running retry worker and no native activation.
Same-intent reevaluation is available through repeated authenticated HTTP requests.

## Evidence

`apps/api/src/auto-next.integration.test.ts` is discovered by ordinary API tests and
`scripts/run-inbound-db.mjs`. It uses the existing process checkpoints in
`tests/fixtures/inbound/manual-outbound-worker.mjs`, distinct PostgreSQL backends,
`pg_blocking_pids`, explicit commit/rollback and bounded worker cleanup. Simulated
executor sends are counted separately from actual FreeSWITCH media.

| Criterion | Local verification                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C05.1     | Enqueue/admission in both commit orders and first-writer rollback; no-offer queue deferral; persisted attempt/slot/operation state; later inbound excludes the occupied agent and does not veto C03 send.             |
| C05.2     | Separate OS workers and keys share one source result/attempt; changed fingerprint conflicts; HTTP replay after terminal completion and during maintenance returns the original result without wake.                   |
| C05.3     | Ignore and expiry preserve exclusions across queue reentry; second unseen FIFO call still defers the same intent; explicit expiry/revision changes while blocked are revalidated.                                     |
| C05.4     | Source/eligibility/cancellation matrix, manual and inbound/transfer acceptance cancellation, stale revisions, confirmed versus unconfirmed voicemail release; API actor/auth/CSRF and B05 strict payload regressions. |

Final commands, outcomes and local artifacts are recorded after verification.
Local tmpfs PostgreSQL and simulated ESL prove SQL/API coordination, not disk-crash
durability, browser/WebRTC, FreeSWITCH/SIP/RTP, provider behavior, hosted CI,
load/soak, deployment, rollback or production acceptance. Those gates remain open.

## Verified local result — 2026-11-15

C05.1–C05.4 passed at their required U/DB/API level. Node.js 23.7.0
(required >=22); PostgreSQL 16.16 and 17.11; simulated ESL only.

- `INBOUND_PG_STORAGE=tmpfs bash /tmp/c05-focused.sh`: PASS, 10/10 C05
  tests, zero skips. Artifacts: `/tmp/outbound-inbound-db.tgBjDaRh/`.
- `INBOUND_PG_STORAGE=tmpfs bash /tmp/c05-quality-pg16.sh`: PASS, full
  `npm run quality`: OpenAPI, lint, format, type checks, 343 API tests with zero
  skips, 135 web tests, 76 ops tests, and all builds.
  Artifacts: `/tmp/outbound-inbound-db.1MpxoWeK/` (includes `runner.sh`).
- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: PASS,
  49/49 tests with zero skips on PostgreSQL 17.11.
  Artifacts: `/tmp/outbound-inbound-db.o5aNfQRF/`, including `c05-*.json`.
- Focused ESLint, API/test TypeScript compilation, OpenAPI check,
  `bash -n scripts/test-inbound-db.sh`, and `git diff --check`: PASS.

The focused wrapper derives from `scripts/test-inbound-db.sh`, changing root
resolution and the final invocation to
`timeout 120 node --test apps/api/dist-test/auto-next.integration.test.js` after
compilation with `node node_modules/typescript/bin/tsc -p apps/api/tsconfig.test.json`.
The quality wrapper changes root resolution, the PG image digest to
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`
and the final invocation to `timeout 300 npm run quality`. Both isolated versions
used `--network none`, no published ports and private test Unix sockets; containers,
schemas and restricted executor roles were removed. Source hashes and snapshots
retain concrete calls, attempts, operations, slots, participants, capacity and process
identities. Docker/test sockets required sandbox escalation. Artifacts are temporary
local evidence, not hosted uploads.

Initial test fixtures violated session verification/revocation checks, tried to
regress a terminal source, reused an active voicemail contact and used the wrong
cleanup evidence column. Those fixture errors were corrected without weakening
schema guards, assertions or budgets. Final passing results above include the
corrected fixtures and manual/automatic race regression.

`npm run test:voicemail:db`: PASS, 8/8 tests, zero skips, disposable
network-isolated PostgreSQL; output `/tmp/c05-voicemail-db-result.txt`.
This covers existing campaign voicemail DB lifecycle with simulated commands,
not FreeSWITCH playback or far-end delivery. No browser E2E, FreeSWITCH/SIP/RTP,
provider, full load/soak, target-storage, hosted-CI, deployment/rollback or production
run was performed. No commit, push, PR, deployment or production mutation occurred.
