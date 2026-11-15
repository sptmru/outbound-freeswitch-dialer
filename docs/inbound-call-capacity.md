# C02 — Shared call capacity

Task: [C02 #15](https://github.com/sptmru/outbound-freeswitch-dialer/issues/15).
Base: `444b2f4` (`dev`); branch `feat/c02-call-capacity`.

`apps/api/src/call-capacity.ts` supplies internal SQL helpers through
`CallAdmission.capacity`. C01 owns the transaction, declared parents, ordered
locks, reconciliation marker and post-wait reads. No public route, dispatcher,
ESL sender, legacy start/release integration or feature enablement is added.
C03–C07 and D/E/F/G still own those consumers and their runtime evidence.

## Resource bundles

One durable `call_operations` UUID and generation identifies one immutable bundle.
Create the operation under admission before calling `capacity.claim`; commit the
operation, call/slot/offer/contact changes and capacity together before execution.
Use separate operations for separate concrete legs. No connection or transaction
is retained for the conversation, a human response or ESL. Operation idempotency
and actual command sending remain C03's responsibility.

| `kind`              | Resource rows, one unit each                                                        |
| ------------------- | ----------------------------------------------------------------------------------- |
| `inbound`           | `queue_waiting` scoped to the original queue UUID, `customer_channel`, `trunk_call` |
| `outbound_customer` | `customer_channel`, `trunk_call`                                                    |
| `browser`           | `browser_channel`                                                                   |
| `supervisor`        | `supervisor_channel`                                                                |
| `transfer`          | Recipient `browser_channel` plus `transfer_overlap`                                 |
| `forward`           | Additional `customer_channel`, `trunk_call`, `external_forward`                     |

Customer, browser and supervisor rows share **one deployment-wide channel budget**.
Overlap and forwarding are additional subset limits, not extra physical channels.
Every `trunk_call` scope is included in the aggregate trunk budget; new claims use
`default`, consistent with the initial single-trunk model and legacy backfill.
Media/subset scopes are `deployment`. Queue checks enforce both the per-queue
`inbound_queues.max_waiting_calls` and deployment queue budget across all queues.
Ring-all offers create no channel claims. Playback uses its already retained
customer channel. A forward adds to the original inbound customer/trunk usage;
transfer overlap adds to the still-connected source/customer usage. The calling
flow must retain those existing claims until their concrete cleanup is confirmed.

`reserved`, `in_use`, `releasing` and `uncertain` all count, including
`origin='legacy_backfill'`. No TTL or agent-slot release reduces capacity. In
particular, releasing an outbound voicemail agent's browser claim leaves the
customer/trunk claims counted until that background playback ends and cleanup is
confirmed. Unknown FS-only or late legacy work still requires the B02/C01 cutover
reconciliation; SQL alone cannot inventory it.

## Shared policy and atomic claims

A06 defaults are: deployment queue 40, channels 72, trunk 32, forwarding 4,
supervisor 4, overlap 4. The declared FS channel/trunk caps are 80/40 and reserved
pre-admission headroom is 8. Values and maxima are validated as integers, including
`channels + preAdmission <= fsChannels` and `trunk + preAdmission <= fsTrunk`.

The internal `configure` method stores a complete validated policy at
`system_settings.key='calls.capacity_limits'` under the same admission gate.
Absent that key, every worker reads the same A06 defaults. An invalid stored
policy fails closed. Limits are read from SQL after acquiring the gate, rather
than cached independently by API replicas. Lowering a limit never updates or
releases existing claims; only a positive new allocation exceeding it is refused.
Replay of an existing bundle remains possible above a reduced limit.

This is a database policy contract, not a new configuration/deployment interface.
D02/F01 must connect the authorized `.env`/Compose/deploy and administrator apply
paths to it and validate applied FS safeguards. There are no new environment
variables, public settings routes or independent rollout commands here. Queue
configuration writers must also use common admission; they must not hold a queue
row lock while waiting for the gate. All capacity consumers must declare their
call/agent parents to C01 before child/capacity writes. Direct SQL is an internal
trust boundary, not an API authorization boundary.

`claim` checks every required budget before the first capacity insert. Refusal
throws `CapacityError('capacity_exceeded', resource)` with `channels`, `trunk`,
`forwarding`, `supervisor`, `transferOverlap`, `queue` or `queue_waiting`. Let the
error unwind the admission transaction so any earlier operation/slot/offer/contact
writes roll back too. SQL/FK failures likewise require rollback. No ESL command
can be sent from this callback. The resource bundle includes the stable call,
operation/generation and optional agent/concrete-leg/supervisor identities. A
changed replay conflicts; a replay returns the existing reservation UUIDs and
never adds units or revives released rows. `usable=false` means at least one row
was released. Neither `usable=true` nor an HTTP/command ACK authorizes another
send: replay must still follow the durable execution/reconciliation protocol.

## Queue return, release and overflow

Keep the original queue permit during `connecting`, including failed connection
cleanup and return to `queued`. Requeue reuses it even when another arrival has
filled the remaining queue or a limit was lowered. The flow releases that permit
only when return is no longer possible, preserving original arrival/deadline and
all exclusion/retry rules. C02 does not move calls between lifecycle states.

`transition` and `release` match the complete reservation token:
`(id, operationId, callId, generation)`. Bigint generations remain decimal strings.
Released rows cannot be reused; releasing/uncertain rows cannot regress to live
states. `release` requires caller-confirmed concrete cleanup and refuses while
**any** operation for that call is unresolved. A delayed rebridge/forward must
therefore resolve before its potentially reused media resources can be freed.
Duplicate or wrong-token release is a no-op, and rollback restores occupancy.
The cleanup assertion performs no FS query and is not itself absence evidence.
Legacy backfill rows retain their existing UUIDs and can be released only through
the same full-token/cleanup contract after reconciliation.

`capacityFailureContinuation` is a pure finite decision: unadmitted overflow is
rejected; admitted failure may continue to a configured playback only with an
existing customer claim and a bounded absolute flow deadline. Otherwise it hangs
up. It cannot return forward or a nested flow and allocates no resources. F03/F04
must execute the configured continuation once, enforce the A06 30-second playback
bound within the original 90-second maximum flow deadline, and reserve any new
media before sending. No recursive overflow or unreserved retry is allowed.

FS safeguards are a separate layer: **DB accounting cannot bound channels created
before API admission**. D02 must apply and verify native total/trunk and separate
pre-admission guards on the pinned image. Declared `fsChannels`, `fsTrunk` and
`preAdmission` numbers here validate headroom only; they do not configure FS or
prove provider behavior. C02's required acceptance level is DB/U; D02 and I02–I05
retain the FS/provider/load/enablement gates.

## Acceptance evidence

The isolated runner and DB-backed API gate include
`apps/api/src/call-capacity.integration.test.ts` and separate-process
`tests/fixtures/inbound/capacity-worker.mjs`. Tests use actual product tables,
explicit IPC checkpoints and `pg_blocking_pids`, with no race-order sleeps.
Each worker records a simulated command only after commit and after checking
its durable reservations; there is no ESL transport or media.

| Criterion  | Assertions                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C02.1 DB   | Seven budgets configured to two units, seeded at limit minus one; two OS/PG workers contend for the final place. Both winner orders and first-writer rollback; mixed inbound/outbound/browser types; exact persisted usage at limit; losing operation/claims/send absent; unchanged calls/contacts/offers/slots/participants; replay returns identical UUIDs with no extra send. |
| C02.2 DB   | Connecting call retains a queue return permit while another arrival fills the queue. Simulated failed connection returns without allocating another permit; separate queue and deployment limits both apply. A waiter observes a committed reduction below usage; admitted claims remain. Released outbound VM retains customer/trunk and blocks another trunk allocation.       |
| C02.3 DB/U | Lost ACK represented by durable uncertainty retains all forward claims; even cleanup assertion cannot release unresolved work. False/wrong/stale token, repeated release, cleanup rollback, large bigint generations and released replay; newer claims survive older cleanup, eventual confirmed cleanup reaches zero usage. Pure overflow and policy-range/headroom tests.      |

Reports `c02-{limits,requeue-lowering-vm,cleanup-replay}-report.json` retain SQL
snapshots, process/backend IDs, observations and PostgreSQL version. The existing
runner captures source hashes/base revision and container cleanup. Fixture
reconciliation, failed connection/ACK and media absence are simulated SQL; these
are not browser/FS/provider acceptance results. Feature-off legacy regressions
remain required with a real isolated database.

## Local verification — 2026-11-15

Node.js 23.7.0 (required >=22). Changes remain local and uncommitted on the
branch above, based on `444b2f4028b9e9d508e0604b43ffc357d25443f4`.

| Command / environment                                                            | Result / evidence                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bash /tmp/c02-quality-pg16.sh`                                                  | PASS: full `npm run quality` with disposable PostgreSQL 16.16; OpenAPI, lint, formatting, types, 317 API tests (zero skips), 135 web tests, 76 ops tests, all builds. `/tmp/outbound-inbound-db.bFU8zZV4/result.txt` and C02 JSON reports. |
| `npm run test:inbound:db:isolated`                                               | PASS: final assertions on pinned PostgreSQL 17.11, 25/25 tests, zero skips. `/tmp/outbound-inbound-db.sJ1k1L1K/result.txt` and C02 JSON reports.                                                                                           |
| Focused Prettier check; `bash -n scripts/test-inbound-db.sh`; `git diff --check` | PASS.                                                                                                                                                                                                                                      |

The temporary PG16 wrapper derives from `scripts/test-inbound-db.sh`, changing
only root resolution, the final command to `timeout 300 npm run quality`, and the
cached image digest to
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`.
Both containers used `--network none`, no published ports and private test Unix
sockets, and were removed. Reports retain the actual DB version, source hashes,
base revision, process/backend identities and snapshots; schema/worker cleanup
assertions passed. The first development run exposed a UUID/text parameter cast
error in the new test fixture; that was corrected before the passing runs.

No browser E2E/WebRTC, FreeSWITCH/SIP/RTP, physical hard-cap, provider,
load/soak, target-storage, deployment/rollback, hosted CI or production acceptance
was run or counted as passed. The independent voicemail DB runner was not needed:
this task changes no voicemail implementation or schema; its existing regressions
passed in quality, and C02 separately checks retained VM customer/trunk accounting.
There was no commit, push, PR, deployment, production mutation or provider call.
