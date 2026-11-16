# Durable inbound queue admission (D04)

Task [D04 #24](https://github.com/sptmru/outbound-freeswitch-dialer/issues/24),
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).

`inbound-queue.ts` implements the staged SQL admission service, queue/context reader,
C03 waiting driver and concrete ESL lifecycle adapter. `createInboundQueueCoordinator`
requires an explicitly supplied C03 executor with its bounded role/pool and the
private journal socket. It does not create roles, clear reconciliation markers or
start an automatic worker. The default `server.ts` still starts D03 capture/import
only; `FREESWITCH_INGRESS_ENABLED=true` alone does not activate queue admission.
I05 owns coherent bootstrap, scheduling, feature/drain controls and enablement.
Replace the pre-queue reconciler with this coordinator when integrating that stage;
do not run independent competing lifecycle owners. Nothing here deploys or enables
inbound calling, browser acceptance or transfers.

## Atomic queue contract

D03 first imports the internally validated ingress UUID and immutable DID, original
microsecond arrival, campaign/queue revisions and queue configuration snapshot.
`admitInboundQueue` enters C01 maintenance/admission/parent locks, checks the
reconciliation marker and rereads that evidence. It commits these together:

- `calls.state='queued'`, without an agent owner or interactive slot;
- one concrete customer participation and leg with the existing ingress UUID;
- one immutable C03 `play_audio` operation with fixed operation/job/target UUIDs;
- C02 `queue_waiting`, `customer_channel` and `trunk_call` reservations;
- `inbound_queue_admissions` and `inbound_queue_admitted` audit evidence.

The captured route/flow version and original queue deadline are never recomputed
from current routing. Current capacity limits can refuse new work after a limit
reduction; existing claims survive. `readInboundQueue` orders in PostgreSQL by
`arrived_at,id`, including recovered older calls and equal arrivals. C05 uses the
same order and sees the committed queued call before any offer exists. Its own
ordered transaction decides priority; an auto-next decision committed earlier is
not retroactively displaced. Neither an offer nor a browser refresh owns admission.

A savepoint rolls back every partial operation/participant/claim on capacity
failure, then commits a terminal `capacity_exceeded` history/audit. It refuses
before answer using the existing bounded native guard/503 continuation. It does
not recursively invoke an overflow flow or borrow unreserved media. Other errors
roll back the transaction and preserve D03's evidence for retry.

Caller identity is optional context: known, unknown and withheld callers are valid.
Input goes through the existing normalizer and strict phone validation. A match
in the captured campaign populates `inbound_context_contact_id`; outbound
`contact_id` stays null. There are no writes to contact status, `attempt_count`,
retry clocks or ownership, and inbound does not claim the outbound active-contact
unique index. This internal reader does not add a public history/Desk route;
E03/H03 own the product-facing views.

Migration `036_inbound_queue_admission.sql` is additive. Previous call writers
receive null new columns; previous migrations/checksums are unchanged. Admission
identity remains immutable and is retained until explicit drained retention.
Captured queue deadlines and terminal state/outcome/clocks cannot regress.
Compatibility with retained native histories still follows B03/I05 exclusions.

## Commit, receipt and bounded waiting media

After COMMIT, the coordinator sends `/admit` over the private Unix journal socket.
The SQLite admission identity survives daemon restart, cannot change, and cannot
attach to a terminal capture. Network `/admission` can only read
`admitted:<operation UUID>`; network `/admit` is refused. A lost post-commit receipt
is replayable. A capture/import ACK alone never authorizes answer or media.

The original ingress Lua hook may park after seeing this receipt; its original
three-second native pre-admission deadline remains armed. C03 alone sends one
fixed `uuid_transfer` into the repo-owned `inbound-wait` context. Its continuation
checks the receipt against that exact operation and existing durable channel,
releases the native pre-admission permit with `uuid_limit_release`, replaces the
pre-admission scheduler task, answers and emits
`outbound_dialer::inbound_waiting_started`, then plays bounded waiting audio.
The trunk guard remains counted. The absolute native deadline rounds the original
queue deadline down to whole seconds, so it never extends the queue budget.
A missing worker/receipt, expired deadline or failed transfer cannot start media.

The isolated context avoids the base image's `default` context SRTP policy on
plain PSTN RTP. Browser security and provider media policy are not overridden.
The command contains only fixed UUIDs, an integer deadline and a validated literal
server path (or `tone`); no browser-supplied ESL is accepted. A configured waiting
recording is snapshotted into the durable request and pinned by the admission row;
media deactivation/unlink returns `in_use` while the call is live or any command
is unresolved, even after queue configuration changes. Without one, waiting uses a
440 Hz tone. F02 owns broader inbound audio assignment/storage administration.
F03 owns queue-timeout/fallback flows; D04's native deadline provides a safe finite
hangup even if that worker does not exist. It does not execute no-answer flows.

C03 verifies the exact BACKGROUND_JOB plus a persisted matching waiting-start or
concrete terminal effect. ACK, absence probe, timeout or expired operation alone
cannot release an uncertain sender's claims. A pending sender is canceled on
customer terminal before any attempt. Sent uncertainty stays counted until its
fixed job and cleanup evidence resolve. The coordinator also checks at most eight
unresolved SQL waiting operations per sweep, including receipts recycled after
terminal ACK; it never resends uncertain work. I05/H01 retain production scheduler,
missing-event/epoch and distributed recovery obligations.

Native command references: [SignalWire API reference](https://developer.signalwire.com/freeswitch/reference/cli-and-api/).

## Lifecycle and evidence boundaries

The ESL adapter runs before initial-ingress and generic outbound handlers. It
correlates the durable customer UUID or an existing concrete agent leg. A customer
`CHANNEL_ANSWER`/verified waiting-start sets `pstn_answered_at`, while the call
stays queued and `agent_connected_at` remains null. Agent answer cannot set the
customer answer clock. Outbound voicemail custom events are not inbound phases.

A later `CHANNEL_BRIDGE` can connect an agent only with the exact peer UUID,
connecting call, accepted offer, matching participant/slot reservation/generation
and persisted attempted bridge operation for the current owner. E02 owns creation/execution of that
winning acceptance; D04 consumes its evidence. A bare bridge/answer does not
invent an agent or revive terminal history. Waiting, connection and terminal
clocks remain separate.

Native CANCEL before/after admission, queue abandonment, `queue_timeout`, capacity rejection and
recovered channel absence have distinct `inbound_end_reason` values. Journal-only
recovered absence does not fabricate a native cause/time. HANGUP closes product
queue eligibility; COMPLETE/DESTROY establishes concrete leg cleanup. Ordinary create/answer/bridge evidence does not request cleanup or move a
connecting slot to uncertainty. C06 then releases exact claims only when operations are resolved. Journal discovery can
also establish absence of the fixed non-originated customer UUID, while retaining
any command uncertainty. Duplicate/out-of-order/late events cannot reopen a call
or mutate terminal clocks/outcome. Contact lifecycle remains untouched.

## Verification

```bash
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run test:queue:freeswitch
npm run test:ingress:freeswitch
npm run quality
git diff --check
```

Use Node 22.13+. tmpfs is an explicit disposable PostgreSQL reference environment,
not production-disk performance, power-loss durability or storage acceptance.
The ordinary quality command without `TEST_DATABASE_URL` skips DB tests; run the
isolated DB runner separately and report its actual result.

| Criterion | Verification supplied                                                                                                                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D04.1     | Real PG original/equal/recovered arrivals, immutable route/deadline, no-offer priority; separate DB sessions with `pg_blocking_pids`, both ingress/auto-next lock orders and rollback.                                                                                     |
| D04.2     | PG context/no outbound mutation; real product-entrypoint/journal/C03/ESL adapter SIP answer and decoded 440 Hz RTP for known/unknown/withheld callers; real later agent bridge with an explicitly seeded E02 winner/slot/intent.                                           |
| D04.3     | DB CANCEL/terminal/late-event permutations, overflow with zero partial state, pending cancellation and retained uncertain claims; actual SIP CANCEL before/after COMMIT, overflow preserving the admitted call, late event replay and final zero occupied claims/channels. |

The FS runner uses pinned FreeSWITCH 1.10.12 and PostgreSQL 17 in a network-none
namespace, publishes no ports, reads no `.env`, and uses the repository entrypoint,
Lua, publisher, migrations and command executor. Artifact hashes, native events,
SQL snapshots, SIP/RTP measurements and disposable cleanup are retained under
`/tmp/outbound-d04.*`. The later bridge seeds the future E02 acceptance, rather
than claiming an implemented acceptance HTTP/browser workflow. All fixtures are
removed; local artifacts are not hosted CI uploads.

Issue #24 records actual commands, results and final artifact paths. Provider DID,
caller-ID trust, billing/far-end audio, browser WebRTC, twenty-agent load/soak,
production disk, deployment/drain/restore/rollback and I01–I05 remain separate.

## Verified local result — 2026-11-16

Base `b5a7bbd0e7a9f052e7279336fca356570cc4f5bf`, branch
`feat/d04-inbound-queue-admission`; changes local and uncommitted. Node 22.13,
PostgreSQL 17.11 with explicit tmpfs storage, pinned FreeSWITCH 1.10.12.

- Isolated inbound DB: **100/100**, no skips; `/tmp/outbound-inbound-db.IUKhPVsS/`.
- D04 FS: **9/9**; `/tmp/outbound-d04.Q0V62YHy/`. Decoded agent bridge audio:
  660 Hz, 2400 samples; final occupied slots, capacity, unresolved operations and
  channels all zero. Report SHA-256
  `81c8c87b9d092e9a9c092cee1c4dbdb7541bbf7c377d743734d38b75df78675a`.
- D03 FS regression: **8/8**; `/tmp/outbound-d03.tD20kv1Z/`.
- C06 FS regression: **7/7**; `/tmp/outbound-c06.mirbISxu/`.
- Separate voicemail PostgreSQL 16 suite: **8/8**, no skips.
- `npm run quality`: passed; API **298 passed / 99 skipped** without
  `TEST_DATABASE_URL`, web **152/152**, ops **78/78**, all static checks/builds.
  The dedicated DB result above is separate from these skips.
- Source hashes, focused fixture lint/format and `git diff --check`: passed.

All containers, fixture schemas and executor role were removed. Artifacts remain
local. The unresolved provider/browser/production/I01–I05 boundaries above remain
unchanged; E02's accepted winner is a test fixture, not an implemented product
acceptance API. No target-storage performance or hosted CI run is claimed.
