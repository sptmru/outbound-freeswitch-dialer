# C03 — Durable command execution

Task: [C03 #16](https://github.com/sptmru/outbound-freeswitch-dialer/issues/16),
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Base: `170d948edf47b96ccc7dff48bcff613bf23adf08`.
Local branch: `feat/c03-durable-command-executor`.

This implements the internal executor, protected pools and ESL transport. It does
not enable routing, start a background service or migrate legacy producers.
C04–C07 and D–G must integrate action-specific validation and call paths.
Existing application pool/roles/env remain unchanged. Deployment, target storage,
browser/provider, recovery epochs and I01–I05 acceptance remain separate.

## Admission and replay

Call `enqueueCallCommand` within `withCallAdmission`, with the call locked, in
the same transaction as slot/contact/capacity claims. B04's `call_operations`
fixes scope/key, fingerprint, generation (bigint string), command UUID, target
UUID, request and absolute deadline. Callers compute the fingerprint from the
complete normalized semantic request. Only server-owned command builders may
consume the request; never accept raw ESL or reconciliation results from a browser.

Replay returns the original identity/result; a conflicting call/kind/fingerprint
fails. Replay is not send authority. Under global admission, at most 48 normal and
16 critical pending operations exist, 64 total across replicas. Hangup/release are
critical; normal work cannot borrow that partition. `execution_backlog_full`
rolls back unstarted admission, rather than dropping uncertainty to create room.

C06 adds optional immutable `request.dependsOn` to its control chains. C03 defers
an unstarted child until its same-call predecessor succeeds, independently of the
caller's chosen run order. A failed/canceled predecessor never authorizes agent
release. C06 cancels never-sent children under admission. Driver send/reconcile
callbacks receive the executor's leased PostgreSQL client for verified evidence
persistence without acquiring a second connection. The transport destroys its
command socket before calling the action verifier.

Migration `029_call_execution.sql` adds an immutable integer key per call and an
immutable sender attempt per operation. Namespace `72203` holds per-call session
locks; `72204` holds deployment execution seats. Every operation/reconciliation
for the call uses its same key. Existing operations remain unchanged and readable;
legacy rows without a C03 key fail as `operation_not_enqueued` instead of being
blindly adopted. Keys/attempts cascade only after their owning call/operation can
be deleted through existing retention guards. Migrations remain forward-only.

## Execution and failure protocol

1. Obtain a local seat before allocating a connection: replica 0 or 1, three normal
   and one reserved critical/recovery seat each. Saturation defers with zero queued
   connection acquisitions. PostgreSQL seat locks fence accidental duplicate replicas.
2. Lease one dedicated connection; acquire seat and call locks with nonblocking
   `pg_try_advisory_lock`. Busy calls defer. Reread durable state; terminal replay
   returns its result. Any other sent/unresolved operation blocks later effects.
3. Under common ordered admission, reread operation/deadline and call state. An
   ended call cannot start ordinary effects. The integrating action supplies
   SQL-only `driver.validate(operation, admission)` for its full slot/generation,
   participant, ownership and endpoint checks. Denied/expired unstarted commands
   become canceled without an execution attempt or send.
4. Persist immutable owner/backend/replica/seat and **uncertain before possible
   send**. Commit before transport. Check the same session and permanent loss
   latch. No transaction or admission lock stays open during ESL.
5. Send once with persisted `Job-UUID` and target identity. `createCommandDriver`
   authenticates, subscribes before sending, matches the exact BACKGROUND_JOB,
   then invokes the action-specific verifier. ACK alone cannot resolve work.
   Framing/size, peer end/close and abort handling are bounded; no automatic retry.
6. Bound total transport time by 5 s and the original DB deadline; activity cannot
   extend it. Persist a verified result on the original connection, then unlock
   and release. Never lease a second connection to save a result, nor retain a
   connection for a conversation or an offer awaiting human input.

Loss is permanently latched for the sequence and aborts the driver. Reconnecting
cannot restore send authority; late results after abort are ignored. Timeout,
ambiguous COMMIT or transport failure requires rereading/reconciling durable
uncertainty. Capacity stays retained.

The DB-to-ESL gap remains real: bytes may reach FS after session loss and a
replacement lock acquisition. `uuid_exists=false`, TTL expiry or generation
advance cannot prove safe reuse. Reconciliation runs under the same seat/call locks
and invokes **only** `driver.reconcile`, never `send`, for uncertain/executing work.
Its separate 5 s inspection remains available after the original deadline.

The trusted adapter must independently account for the old sender's inability to
resume, quiescent/closed transport and every exact job/channel completion/absence
as selected by A05. Missing evidence returns `null`. An HTTP boolean cannot supply
these facts. Production distributed sender-death, missing event history and FS
restart/epoch integration remain H01/I02; until supported, retain uncertainty for
operator recovery. C01/C02 prevent cleanup while any call operation is unresolved.

`verify` establishes a command-specific outcome. A completed originate job is not
browser conversation proof; bridge/rebridge adapters need actual channel/media
evidence. The C03 FS fixture checks originate/job/terminal signaling and critical
hangup, not browser audio.

## Physical connection budget

`CallExecutor.create` owns a separate pool of max 4 per worker: 250 ms acquisition,
250 ms lock and 500 ms statement budgets. Its dedicated nonsuperuser login must
have CONNECTION LIMIT in 1–8; use 8 for the two-replica deployment. Unbounded roles
and other replica IDs are rejected. Startup options enforce timeout settings even
when the supplied connection options contain other values.

`createCallControlPools` creates independent per-API pools: admission 4, heartbeat
1, events 2, recovery 1. Two replicas use distinct login role caps 8/2/4/2, separate
from the executor login. Invalid partitions are rejected. A06's aggregate allowance
is 24 application connections plus its reserved DB headroom. These are internal
factory inputs, not deployed environment variables. Provision roles and integrate
actual handlers through the existing `.env`/Compose/deploy path in owning tasks.

No backlog row or pending offer owns a connection. Call-lock contention is a
nonblocking deferral. A scheduler must use finite concurrency, prioritize critical
control/reconciliation and back off deferred work. The executor exposes explicit
deferral reasons and running/connections/waiters statistics; it does not start an
automatic retry daemon or bypass rejection through a manual retry.

## Reproduction and evidence

```bash
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run test:executor:freeswitch
npm run quality
git diff --check
```

DB storage defaults to a Docker volume; `INBOUND_PG_STORAGE=tmpfs` explicitly
selects bounded 256 MiB memory-backed PGDATA. `storage.txt` records the mode;
fsync/synchronous_commit, deadlines and assertions remain unchanged. tmpfs proves
pool/concurrency isolation, not target disk performance or crash durability.
An initial volume run passed C03 but failed existing C02.1 with `lock_timeout`
instead of `capacity_exceeded`; evidence remains at
`/tmp/outbound-inbound-db.GfvbsWsw`. The exact storage root cause was not established.
No application budget or C02 assertion was relaxed.

Runners create disposable DBs, ignore `.env`/application DATABASE_URL, publish no
ports and remove containers/volumes. The FS runner uses the existing digest-pinned
FreeSWITCH 1.10.12 lab and actual UDP SIP target in a network-disabled namespace,
with a TCP fault relay. Provider traffic is impossible. Artifacts retain base SHA,
source hashes, image/version/isolation, DB snapshots, jobs/channels, process exits
and cleanup. Do not publish disposable fixture credentials.

| Criterion | Evidence                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C03.1     | DB: both process commit orders and rollback, identity/conflict. Actual FS + product executor: before-send failure, lost ACK, resumed sender, zero/one physical INVITE/job, no blind replay.                                                                                                                                                          |
| C03.2     | Terminate actual lock backend with SIGSTOP/SIGCONT sender and delayed bytes. Replacement observes absence but retains uncertainty/capacity; resolve only after sender reap, closed relay and exact job/terminal/absence evidence.                                                                                                                    |
| C03.3     | Four OS processes: two worker replicas × four held sessions; two API/control replicas × separate 4/1/2/1 pools. 960 protected SQL commits at 40 tasks/s per lane/replica, 100/250 ms p95/p99; same backend persists results. Separate FS run: six delayed normal commands, reserved critical hangup reaches actual terminal evidence within 1000 ms. |
| C03.4     | 48+16 backlog bound/refused 65th; actual FS drain, one exact job per operation, terminal replay; zero unresolved operations, capacity, execution locks and channels after confirmed cleanup.                                                                                                                                                         |

Protected SQL load exercises admission, actual Desk expiry updates, simulated
hangup event writes and recovery reads, with durable per-lane ledgers. It does not
exercise future HTTP handlers or twenty-agent/browser load acceptance. Transport
unit tests cover fragmented events, ACK/UUID checks, clean close and total abort
under partial traffic. Existing fresh/upgrade/legacy suites include migration 029.
Final commands/artifacts are recorded in the issue handoff. Hosted CI, browser/
WebRTC, provider, full media/load/soak, target storage, deployment/rollback and
production acceptance remain unrun.

## Verified local result — 2026-11-15

All four C03 criteria passed at their required DB/FS/bounded load levels. Source
hashes match the final implementation; changes remain local and uncommitted.
Node 23.7.0 (required >=22), pinned FreeSWITCH 1.10.12 and PostgreSQL 16.16/17.11.

- `INBOUND_PG_STORAGE=tmpfs bash /tmp/c03-quality-pg16.sh`: PASS, full `npm run
quality`, 324 API tests with zero skips, 135 web and 76 ops tests, all static
  checks/builds. Artifacts: `/tmp/outbound-inbound-db.jDWCbUPy/`.
  The wrapper derives from the isolated runner, changing root resolution, PG
  digest to `sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`
  and final invocation to `timeout 300 npm run quality`.
- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: PASS, 30/30 tests,
  zero skips, PostgreSQL 17.11. Artifacts: `/tmp/outbound-inbound-db.nUB9fJbM/`.
  Four-process workload persisted all 960 writes while eight executors remained
  held; worst lane p95/p99 5.699/8.287 ms versus 100/250 ms targets. PG16 worst
  lane p95/p99 was 7.772/13.276 ms. All result writes used the original lock backend.
- `npm run test:executor:freeswitch`: PASS, five groups at
  `/tmp/outbound-c03.af4PKt64/`. Before-send/delayed-send/lost-ACK physical sends
  and real INVITEs were 0/1/1. Delayed delivery occurred after replacement observed
  channel absence; capacity stayed retained until exact cleanup. Critical hangup
  reached actual terminal evidence in 58.237 ms with six delayed normal transports.
  While the fault remained, 64 pending operations filled both partitions and the
  next was rejected; fault removal drained each once. Terminal replay added no
  job. Final unresolved operations, unreleased capacity, execution locks and live
  channels were zero. Process reap and container-removal records are retained.
- Focused ESLint/Prettier, shell syntax and `git diff --check`: PASS.

The initial volume failure above remains a separate failed measurement, not a
target-storage pass. Earlier fixture runs exposed a missing BACKGROUND_JOB observer
subscription and an observer-delivery race; the final runner explicitly subscribes
and waits for independent job delivery before asserting counts. Those failures do
not establish a FreeSWITCH or executor defect. No deadline/assertion was weakened.
