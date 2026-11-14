# A06 — Resource, deadline and acceptance budgets

Date: 2026-11-14. Task: [A06 #7](https://github.com/sptmru/outbound-freeswitch-dialer/issues/7),
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Base: `958aa29ff6545798958c63945833b40c4e0b57fe`.
Branch: `prototype/a06-resource-budgets`.

Selected design specification plus an isolated PostgreSQL prototype. These values
are inputs to B–I implementation, not deployed settings or a measured product SLA.
The executable specification is `scripts/a06-budgets.mjs`; no new environment
variables, product schema, API behavior or FS configuration are introduced.
`.env.example` remains the deployment variable inventory. C02/C03/D02 must implement
and validate these bounds through the existing config/Compose/deploy path before
enablement; I03/I04/I05 retain load, provider and target gates.

## Selection and prerequisite contracts

Read AGENTS.md, source plan sections 2, 5.3.1, 5.8, 6.2, 13.5, requirements,
architecture, implementation status, environment documentation and ADR 0001.
Knowledge preflight included task/repository search, exact `sendFreeSwitchCommand`
lookup and executor/slow-ESL incidents. Fetched all 46 task bodies and the tracker;
A01–A05 were individually closed with reason `completed`. A06 depends on A02–A05
in both its description and Dependency links, and is the first remaining ID.
A02's owner-approved local scope satisfies this dependency; I04 owns deferred
provider obligations. The final recheck found no assignee/start comments and no
open repository PRs; its timeline contained only issue cross-references. The
connector's search ignored `is:pr`, so its REST fetch of `/pulls?state=open` supplied
the authoritative empty PR list. Started from a clean tree and posted a start
comment before creating the branch. No commit/push/PR/deployment is part of A06.

Inherited contracts:

- [A02](inbound-ingress-prototype.md): trusted local ingress, distinct PSTN answer
  boundary; no provider acceptance.
- [A03](inbound-durable-ingress-prototype.md): commit before receipt/answer; bounded
  external journal requests; no direct synchronous Lua/Dbh SQLite retries; terminal
  acknowledgement before recycling. The lab's four slots are not the product budget.
- [A04](inbound-desk-binding-prototype.md): generation-specific verified endpoint,
  occupied-slot takeover refusal; heartbeat expiry never releases occupied work.
- [A05](inbound-rebridge-executor-prototype.md): same leased DB execution session,
  no transaction during ESL; uncertain commands retain claims until trusted sender,
  transport, exact job and channel evidence permits release. Timeouts are not absence.

## Counting and overload specification — A06.1

All counters include **reserved + executing/live + uncertain** usage, across all
processes and call directions. Claims for several resources succeed atomically
under common admission or all roll back. A number in a web form cannot override
physical or deployment caps. Validation uses integer values only; zero, negative,
nonfinite and fractional limits are rejected. The table gives the initial value
and supported validation range, not permission to increase capacity without I03.

| Resource/key                | Initial; validation range                                                | Unit and scope                                              | Accounting and overload action                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queue`                     | 40; 1–200                                                                | call permits per queue **and** 40 deployment-wide initially | Waiting calls plus accepted/connecting calls holding a return permit. At capacity reject new admission as `capacity_exceeded`; never grow through requeue.                                                                                                                                                                                             |
| `fsChannels`                | 80; 16–200                                                               | simultaneous physical channels, single FS instance          | Native hard guard includes pre-admission, browser, customer, supervisor and overlap legs. Refuse new channel at guard; preserve admitted channels. Multiple FS instances require partitioned guards, not 80 each.                                                                                                                                      |
| `channels`                  | 72; 1–184                                                                | deployment-wide DB channel claims                           | Customer/browser legs each cost 1; waiting/playback costs the existing customer 1, no extra browser. New leg refused if any needed claim fails. Includes outbound and uncertain legs.                                                                                                                                                                  |
| `preAdmission`              | 8; 1–16                                                                  | FS channels before DB admission                             | Separate native guard acquired immediately on channel arrival, before journaling/answer; held until DB claims commit or channel termination. Refuse before answer, local target SIP 503 within 3 s.                                                                                                                                                    |
| `fsTrunk`                   | 40; 2–80                                                                 | simultaneous external legs at FS                            | Includes unadmitted ingress. Native enforcement plus provider cap; refuse excess ingress before answer.                                                                                                                                                                                                                                                |
| `trunk`                     | 32; 1–64                                                                 | DB external-leg claims deployment-wide                      | Inbound customer and outbound customer each 1; forwarding adds another 1 while inbound remains. Unknown outcome retains both. At capacity reject start or take forwarding failure continuation.                                                                                                                                                        |
| `forwarding`                | 4; 1–8                                                                   | external destination legs deployment-wide                   | Additional subset of `trunk` and `channels`; reserve all three before send, never recursive forwarding/overflow.                                                                                                                                                                                                                                       |
| `supervisor`                | 4; 1–8                                                                   | supervisor legs deployment-wide                             | Additional subset of channels; refuse new supervision, do not displace conversation. End and confirm old supervisor before transfer per A05.                                                                                                                                                                                                           |
| `transferOverlap`           | 4; 1–8                                                                   | extra recipient browser legs deployment-wide                | Existing source/customer continue consuming claims; accepted recipient needs its own slot/channel and one overlap permit. If unavailable, preserve source and decline/refuse transfer.                                                                                                                                                                 |
| Interactive slots           | 1 per agent; fixed, 20 test agents                                       | agent                                                       | Reserved/connecting/active/releasing/uncertain occupy the slot. Offers do not occupy slots; ordinary occupied takeover is rejected.                                                                                                                                                                                                                    |
| Offers                      | 1 open per agent, 20 open globally in initial fixture                    | offer                                                       | Ring-all creates rows/notifications, not 20 SIP legs. Lifetime call-agent exclusions are bounded by agent count; never prune before call termination.                                                                                                                                                                                                  |
| Transfer requests           | 1 unfinished per call                                                    | request                                                     | Repeated idempotency key returns existing attempt; decline/expiry never creates an automatic new attempt.                                                                                                                                                                                                                                              |
| Flow                        | 3 actions; 1–3                                                           | actions per immutable flow version                          | At most one forward and two playbacks; no cycles or nested flow references. Validate sum of worst-case durations ≤ `flowMs`; default 30 s audio + 20 s forward + 30 s failure audio = 80 s.                                                                                                                                                            |
| `journalSlots`              | 4096; 64–16384                                                           | preallocated live/unacknowledged records per FS spool       | One original UUID per record, bounded metadata/terminal update; no TTL eviction. Reject new captures at exhaustion. Terminal updates retain reserved room.                                                                                                                                                                                             |
| `journalMiB`                | 64; 8–256                                                                | SQLite database MiB per spool                               | 4096-byte pages, DELETE journal; reserve equally sized rollback space plus 64 MiB headroom, initial dedicated spool quota 256 MiB. Stop new capture if free headroom <64 MiB. Cap metadata at 1024 bytes, incoming body 2048 bytes, eight HTTP requests, 1 s I/O timeout. Disk/write failure refuses admission, never answers without durable receipt. |
| `backlog`                   | 64; 8–256                                                                | unstarted durable operations deployment-wide                | 48 normal +16 critical/recovery positions; all replicas share admission counter, not 64 each. Running 8 are separate. Reject new manual work or defer auto intent without media claims when normal partition full; do not drop sent/uncertain work.                                                                                                    |
| Local execution wait        | 0 normal queued connections; 1 diagnostic waiter per worker in prototype | DB acquisition                                              | Select work only when a local token is available; lock contention is nonblocking try-lock, defer without holding a connection. Never allocate a connection per backlog row.                                                                                                                                                                            |
| Event persistence           | 1000; 100–10000                                                          | bounded pending events per listener                         | Preserve order and existing overflow disconnect/reconnect/reconcile policy. Initial retry 250 ms, max 30 s; no silent discard, no unbounded retry queue.                                                                                                                                                                                               |
| Retained operations/history | 90 days; 1–365                                                           | terminal, acknowledged records                              | Retention is age-bounded only after resolution/ack; unresolved evidence is protected. Disk high-water 80% stops new starts/import growth that cannot be stored, alerts and leaves existing call controls usable; 90% requires operator recovery. H04 owns implementation/restore proof.                                                                |

Cross-validation: `channels + preAdmission <= fsChannels` and
`trunk + preAdmission <= fsTrunk`, and physical guards must respect provider limits.
The defaults leave 72+8=80 channels and 32+8=40 external legs. An unadmitted channel
is physically counted once but conservatively has reserved headroom until DB commit.
The DB claim commits **before** releasing the pre-admission guard; transient double
accounting is safe. FS restart invalidates physical claims only through reconciled
FS-epoch evidence, never a counter reset on API restart. A global FS hard guard is
still needed before scripts run; transport/rate controls for rejected SIP attempts
remain D02, rather than an assumed Lua guarantee.

Examples at the queue boundary: 39 permits +1 succeeds; 40+1 and 41+1 fail. A
connection failure requeues using its already retained permit (`delta=0`) even if
the limit was lowered below use. Release the return permit only on confirmed
connection, terminal state or definitive fallback. Requeue never resets arrival or
deadline. Every resource has the same `limit−1/limit/limit+1` unit specification.
An uncertain leg cannot be subtracted to make room. Lowering limits changes future
admission only; no eviction or loss of hangup/control authority is allowed.

At a full channel/trunk/queue limit, overflow can play audio on its existing channel
only after durable admission and within its own permitted time. It cannot create a
forwarding leg without all reservations. Otherwise terminate with the configured
technical/capacity outcome; distinguish that from `queue_timeout` and no agents.
A failed/exhausted pre-admission journal has no durable per-attempt history guarantee;
A03's documented loss boundary remains, and I04.5 must verify provider retry behavior.
Unacknowledged evidence is not deleted to meet a storage/retention limit.

## Deadlines, retries and validation

Absolute times derive from original durable arrival, offer or operation timestamps;
HTTP replay, redispatch, campaign changes and process restart never extend them.
These are selected initial values; implementing tasks must validate the stated
ranges and cross-field relationships, and expose admin values only where appropriate.

| Key                                    | Default; validation range                  | Scope and action at deadline                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offerMs`                              | 15000; 5000–30000 ms                       | Per call-agent offer; close `expired`, permanent call-agent no-reoffer exclusion.                                                                                                                                                                       |
| `queueMs`                              | 60000; 15000–300000 ms                     | Original ingress arrival; closes acceptance and begins fallback atomically.                                                                                                                                                                             |
| `connectMs`                            | 10000; 6000–15000 ms                       | Each accepted connection incl. acquire/command/endpoint verification; retain uncertain claims pending reconciliation.                                                                                                                                   |
| `transferMs`                           | 20000; 5000–30000 ms                       | Pending recipient decision; source conversation continues. Acceptance starts a separate bounded connect attempt, not another transfer offer.                                                                                                            |
| `forwardMs`                            | 20000; 5000–30000 ms                       | Far-end ringing; late answer cannot escape operation/flow deadline. Retain claims until cleanup, then configured failure continuation.                                                                                                                  |
| `playbackMs` / `flowMs`                | 30000 /90000; 1000–60000 /1000–180000 ms   | Per audio action / total post-queue flow, including acquire, ring, retries and cleanup. Never reset on action failure. Uncertain cleanup stops further actions.                                                                                         |
| `retries`                              | 2 retries after initial; 1–2               | Only definitively failed, cleaned-up connections. Backoff `retryInitialMs`=500 (250–1000 ms), exponential capped by `retryMaxMs`=2000 (1000–5000 ms). Never retry sent/uncertain work, ignore/expiry exclusions or a transfer invitation automatically. |
| `heartbeatMs` / `deskLeaseMs`          | 5000 /20000; 1000–10000 /5000–60000 ms     | Session readiness only; lease ≥3 heartbeats. Expiry does not release a slot or execution reservation.                                                                                                                                                   |
| `captureMs` / `journalHttpMs`          | 750 /1000; 250–1000 /500–1500 ms           | Capture must commit before capture deadline; outer bounded transport response. Retain A03 local total SIP refusal budget 3000 ms; provider timing unverified.                                                                                           |
| `acquireMs` / `lockMs` / `statementMs` | 250 /250 /500; 50–500 /50–500 /100–1000 ms | Fail/defer unstarted work; release connection immediately on lock/statement failure. No ESL under transaction.                                                                                                                                          |
| `commandMs`                            | 5000; 1000–5000 ms                         | Total transport deadline, not renewed by bytes/activity. Originate job/channel completion has its separate operation deadline. Timeout retains uncertainty, never blind resend.                                                                         |
| `recoveryMs`                           | 30000; 10000–60000 ms                      | From restored DB/ESL availability to convergence **or explicit unresolved/operator-required classification**. Missing trusted evidence blocks reuse; deadline cannot manufacture absence or authorize release.                                          |

Retry eligibility additionally requires `now + backoff + connectMs <= original
queue deadline`; at most three physical connection attempts total and no immediate
failure loop. Connect must exceed command timeout, connect must be shorter than
queue wait, and retry initial must not exceed its cap. Flow validation rejects a
configured action sequence whose worst-case bounds exceed the total deadline.

## Dedicated pools and deployment budget — A06.2

Choose separate bounded pools and database login roles per workload. Startup must
reject a replica configuration exceeding the aggregate equation; adding replicas
requires repartitioning or approved capacity testing. Database role connection
limits are the backstop against accidental extra replicas. Ordinary application
roles must not be superusers or consume PostgreSQL's reserved slots.

| Owner                 | Replicas | Per replica | Aggregate | Reserve purpose                                                        |
| --------------------- | -------- | ----------- | --------- | ---------------------------------------------------------------------- |
| API admission         | 2        | 4           | 8         | Shared admission, ingress, explicit controls                           |
| API heartbeat         | 2        | 1           | 2         | Desk/binding liveness                                                  |
| API event persistence | 2        | 2           | 4         | Ordered ESL hangup/terminal/event writes                               |
| API recovery          | 2        | 1           | 2         | Reconciliation, release/control persistence                            |
| Worker executors      | 2        | 4           | 8         | 3 ordinary +1 critical (hangup/recovery) command sequences per worker  |
| Total application     |          |             | **24**    | Dedicated role caps 8/2/4/2/8 respectively                             |
| PostgreSQL reserved   |          |             | 3         | Admin emergency use only                                               |
| Other clients         |          |             | 10        | Migrator/exporters/diagnostics incl. prototype's two observer sessions |
| Remaining headroom    |          |             | **63**    | `max_connections=100`; require at least 20 unused by configuration     |

`2*(4+1+2+1) + 2*4 + 3 + 10 + 20 <= 100`. `validateBudgets`
rejects an excessive replica count or exhausted headroom. Splitting role pools
provides reserves; increasing the existing shared `max:10` alone does not.

Lease one executor connection only for one serialized command sequence, holding
the session advisory lock and using that **same connection** for final persistence
and unlock. Never hold SQL transactions over ESL. A saturated executor pool does
not acquire a second connection to save its result. Pools use 250 ms acquisition,
250 ms lock and 500 ms statement deadlines. Local tokens bound lock holders before
pool acquisition. No heartbeat, HTTP or offered call owns an executor connection.
Critical tokens cannot be borrowed by ordinary work; all-saturated fault scenarios
still preserve DB control writes while critical ESL is explicitly delayed and
reported. Product C03 must test priority scheduling and real hangup latency.

## Acceptance targets and prototype evidence — A06.3

Define these targets before I03; exceeding them fails acceptance, never resets
through a retry. Percentiles use nearest rank over all offered observations,
including scheduler/queue time and errors; publish samples and errors separately.

| Measurement                | p95               | p99     | Start/end definition                                                                                                |
| -------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Admission                  | 100 ms            | 250 ms  | API request accepted for processing through durable claim commit                                                    |
| Offer delivery             | 500 ms            | 1000 ms | Durable eligible queue/agent boundary through offer visible in connected Desk                                       |
| Connection                 | 2000 ms           | 5000 ms | Successful explicit acceptance through confirmed browser/customer two-way media                                     |
| Protected DB control paths | 100 ms            | 250 ms  | Offered task through commit incl. scheduling, pool and SQL waits                                                    |
| Active-call control        | 500 ms            | 1000 ms | Authorized hangup through actual terminal FS evidence under normal ESL                                              |
| Recovery                   | 30000 ms deadline |         | Restored dependencies through convergence or explicit retained uncertainty                                          |
| Acquisition / backlog      | 250 ms timeout    |         | At most one bounded diagnostic waiter per executor replica; zero residual waiters; ≤64 durable unstarted operations |

I03 reference capacity: 20 eligible agents, initial one shared queue, 20 active
conversations, up to four transfer overlaps/supervisors/forwarding legs within
**all** shared limits. Single Linux x86-64 host, at least 4 dedicated vCPU, 8 GiB RAM,
SSD storage (fsync p99 ≤10 ms) and local DB; allocate PG 2 vCPU/512 MiB minimum for
the prototype, at least 2 GiB for full acceptance. Document contention/co-tenants.
No capacity extrapolation from this development machine is permitted.

I03 reference workloads: fixed seed `606`, 5 offered calls/s for 60 s (expected
bounded rejections above sustainable service rate), 20-call synchronized burst,
normal completed-call rate 1/s for 10 min with 10 s fixture conversations, then
30 min bounded soak with faults. Heartbeats every 5 s for 20 agents; control-plane
fault workload 40 tasks/s per lane per API replica for 3 s. SIP/RTP runs must retain
known audio/recording and browser observations separately. Correctness budgets are
**zero** duplicate assignments/dials/bridges, unrelated offer closures or unexplained
post-recovery slots/legs/claims; retained uncertainty is explicitly enumerated and
blocks enablement until resolved. CPU <80% sustained, RSS below each declared
container limit, no monotonic journal/backlog growth, zero unexplained acquisition
failures in healthy protected paths. Fault-injected acquisition failures are expected
and counted; they must not consume critical reserves.

### Reproduce and inspect

```bash
node tests/a06-budgets.test.mjs
bash -n scripts/test-a06-budgets.sh
npm run test:prototype:budgets
```

The runner creates only a disposable, network-disabled PostgreSQL container with
no published ports and a private Unix-socket directory. It never reads `.env` or
`DATABASE_URL`. The digest-pinned PostgreSQL image, base SHA, source hashes,
container isolation/resources, DB version, host CPU/RAM and Node version are saved
beside `report.json`, `result.txt` and local container logs. The container and its
volume are removed on exit; evidence remains in the printed `/tmp/outbound-a06.*`.

Two separate worker OS processes each hold all four execution connections, with
real advisory locks, through delayed **simulated** ESL over a local Unix socket.
Two separate API OS processes run each of four independently pooled control lanes.
IPC and observed sockets/`pg_stat_activity` provide checkpoints, not sleeps as proof
of saturation. No transaction is open while the eight commands wait. The DB role
cap rejects a ninth execution connection with `53300`. Each exhausted local pool
fails acquisition near 250 ms and removes its waiter. Per lane/replica, 120 offered
tasks at 40/s commit while all eight execution connections remain leased: 960 total.
Admission uses a shared transaction gate; the other lanes persist durable progress.
These are representative SQL paths, not product route, dispatcher or media tests.

Wave 1 replies after all control writes complete. Wave 2 never replies: all eight
commands time out at 5 s and persist `uncertain` using the original backend IDs.
Only the fixture coordinator resolves them after sender exit/transport closure
and its exact one-command ledger; this deterministic stub is conclusive only for
simulated actions. Physical FS jobs require A05's full independent evidence.
The 65th backlog insertion rolls back at 64. After reconciliation all 16 unique
commands have one ledger entry each, no uncertainty, execution locks or backlog
remain. This is a finite DB isolation prototype; it does not prove cross-process
call/offer races, which belong to A07/C01 onward.

Offer delivery, real connection, full 20-agent media/load/soak, journal capacity,
physical FS guards and provider timings are **unmeasured here**. Their targets are
selected in this document; I03/I04 must measure them against implemented product.
A06 completion records R/U plus the required DB prototype, not later acceptance.

### Recorded local result — 2026-11-14

Final source-hashed prototype: `/tmp/outbound-a06.JM8guqtS/report.json`,
`source-sha256.txt`, `isolation.txt`, `result.txt`, `postgres.log`.
PostgreSQL 17.11, digest pinned by runner; Node 23.7.0; Linux x86-64,
4 available AMD EPYC-Genoa CPUs, 8,116,498,432 bytes host RAM. PostgreSQL was
limited to 2 CPUs/512 MiB with `max_connections=100`; no network or published ports.
The host was shared, including a concurrent local quality run; this is not a
dedicated performance acceptance host.

| SQL lane                     | Replica 0 p95/p99 (ms) | Replica 1 p95/p99 (ms) |
| ---------------------------- | ---------------------- | ---------------------- |
| Admission                    | 8.701 /14.549          | 10.129 /19.434         |
| Heartbeat                    | 7.054 /14.377          | 7.803 /15.472          |
| Event persistence            | 7.379 /13.259          | 7.227 /11.804          |
| Recovery/control persistence | 8.525 /14.444          | 7.561 /13.322          |

Each cell has 120 observations; all eight lanes passed 100/250 ms p95/p99.
Healthy pool acquisition p99 was 0.081–0.605 ms. Four injected exhausted-pool
acquisitions failed in 250.102–251.115 ms, leaving no waiters. Wave 2's five-second
command deadline plus persistence completed in 5002.451–5003.900 ms. After definitive
stub evidence and worker reap, all eight uncertain operations reconciled in 12.591 ms.
The latter excludes the preceding fault duration and is not a real FS recovery SLA.

Persisted assertions: 960 distinct control writes, 16 unique simulated commands,
zero duplicate sends, identical acquisition/persistence backend per operation,
zero residual execution locks, uncertainty or backlog. The 65th backlog claim was
refused at 64; the ninth execution connection was refused by PostgreSQL. No existing
call rows or production state were involved. Containers/volumes were removed.

| Criterion | Evidence/result                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A06.1     | R tables/counting/overload review and U tests for every limit boundary, lowering/requeue/uncertainty, atomic multi-resource refusal, FS headroom and retry deadline/exclusions: PASS. Product enforcement remains C02/D02. |
| A06.2     | Real PostgreSQL + four separate workload processes, eight held execution sessions, protected SQL progress, global role refusal, pool deadline and same-session persistence: PASS. No product ESL or hangup proof claimed.  |
| A06.3     | Concrete acceptance/rate/duration/hardware/zero-error budgets fixed above, raw local DB measurements and artifacts retained: PASS for A06 specification/prototype scope. I03/I04/I05 results remain open.                  |

Validation commands:

- `node tests/a06-budgets.test.mjs`: 5 passed.
- `bash -n scripts/test-a06-budgets.sh`: passed.
- `npm run test:prototype:budgets`: passed, final artifact directory above.
- `env -u TEST_DATABASE_URL -u DATABASE_URL npm run quality`: passed with local
  test-socket access: OpenAPI, lint, formatting, types, 262 API tests, 134 web tests,
  65 operations/specification tests and all workspace builds. Log:
  `/tmp/outbound-a06-quality-unrestricted.log`. Existing conditional product DB
  integration suites were not exercised because `TEST_DATABASE_URL` was unset;
  the independent A06 container run is the DB evidence for this task.
- The initial sandboxed quality attempt failed existing ESL/registration transport
  tests because `listen EPERM 127.0.0.1`; the same command passed with socket access.
- `git diff --check`: passed.

No browser journey, real SIP/RTP, provider, full load/soak or deployment check was
run. A06 introduces only an executable specification and a disposable prototype;
its passing checks cannot establish the future feature's runtime acceptance.
