# A05 — Customer-leg rebridge and executor uncertainty

Task: [A05 #6](https://github.com/sptmru/outbound-freeswitch-dialer/issues/6),
under [tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Date: 2026-11-14. Base: `7d33b34`. Branch: `prototype/a05-rebridge-executor`.

This is an isolated protocol prototype, not product inbound/transfer implementation.
A01 and A04 were fetched from GitHub and verified closed as completed, including
their completion reports. A05 was the first open task by ID; its description and
Dependency links both require A01/A04. A repository-wide open-PR query was empty;
the final issue/comment recheck found no assignee or start comment. The working tree
was clean before creating the branch and posting the start comment.

## Selected media protocol and evidence boundaries

The lab derives its configuration from the A04/A02 renderer. It enables `mod_sndfile`
for real WAV capture, 16 maximum channels and loopback RTP ports 20000–20040.
Its authenticated session identities register with actual SIP Digest; destinations
come from `sofia_contact a04-loopback/<username>@a04.invalid` and A04's strict
single-contact validator. The inbound fixture is an actual endpoint-originated SIP
INVITE into an answer/park dialplan; the outbound fixture has FS originate the
customer leg. These are UDP/PCMU fixtures, without a browser or provider.

1. Keep the customer's original FS UUID. Set `hangup_after_bridge=false` and
   `park_after_bridge=true` on retained and replaceable legs. The product's existing
   `hangup_after_bridge=true` origination must not be reused unchanged for transfers.
2. Start one stereo recorder on the customer before the initial bridge. Customer,
   source and recipient send distinct 440/660/880 Hz tones over actual RTP.
3. Prepare the recipient on its exact verified endpoint and wait for its actual
   `CHANNEL_PARK`. Keep the source conversation until the switching boundary.
4. Park the customer with `uuid_park`; observe `CHANNEL_PARK`, including the source's
   automatic return to park. If the source already ended, observe the customer's
   automatic park instead of redundantly parking an already parked channel.
5. Execute `uuid_bridge <customer> <recipient>`. Require the actual `CHANNEL_BRIDGE`,
   the expected `bridge_uuid`, and decoded RTP at both endpoints. An API response
   or a set `bridge_uuid` alone is insufficient.
6. End only the source UUID. Replay its late UUID-targeted hangup after handover;
   require the same customer UUID, recipient bridge and fresh two-way RTP.
7. Inspect `uuid_buglist` before/after; there must be exactly one customer recorder.
   Stop and decode the stereo PCM WAV, checking for all three known tones over
   400 ms windows. A surviving media-bug entry or good endpoint RTP cannot substitute
   for usable recorded content.

The matrix removes the source before recipient preparation, after recipient park
but before customer park, after customer park, and after the new bridge. Each
direction has those four boundaries. Recovery uses the prepared recipient within
the 15-second lab scenario bound. That includes setup/media measurement and is not
an approved production SLA. No return to an absent source is promised. Product
G02/H01 must retain uncertainty when the recipient/customer outcome is unresolved;
if neither agent can serve the call, use a bounded technical termination and retain
the actual cause. An FS restart cannot preserve a live customer channel.

### Recording verification

The runner fails if decoded recording content fails, while retaining passing
channel/RTP assertions and continuing the remaining recording cases. Earlier
fixture revisions sometimes failed the post-switch 880 Hz recording check despite
correct endpoint RTP and a surviving `session_record` bug. They also issued commands
before observing all park/bridge transitions and sometimes parked an already parked
customer. Those failed runs are retained; they do not establish an upstream FS defect.

The selected protocol waits for every originated leg's `CHANNEL_PARK` and the actual
`CHANNEL_BRIDGE`, and observes automatic customer park after source loss instead of
parking it again. Both directions and all four boundaries subsequently passed the
unchanged recording threshold. `recording_follow_transfer=true` and
`RECORD_USE_THREAD=false` were diagnostic experiments; neither is in the final code.
The final result below supersedes the failed fixture runs without claiming a source
fix to FreeSWITCH or production recording acceptance.

The [pinned FS recording implementation](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/switch_ivr_async.c)
and [official recording documentation](https://developer.signalwire.com/freeswitch/media-and-codecs/audio-files/)
are reference material; runtime WAV/ESL artifacts decide this gate. A surviving media
bug or packet count must never replace decoded recording verification.

### Supervision policy

End the existing supervisor session at handover before detaching the source and
confirm its leg ended. Require a new explicit supervisor action against the new
owner/bridge. Never carry whisper/join authority silently to the recipient. Existing
supervisor permission, media exclusion and session fencing remain required.
This lab does not exercise a supervisor client or establish whisper/recording privacy;
G04/I02 must implement and verify that policy. One retained customer recorder is the
chosen design, subject to the recording gate above; no per-agent recorder is started.

## Selected executor protocol

`scripts/a05-executor.mjs` creates only the disposable `a05_operations` table.
Each fixture call has one durable operation and an integer lock key allocated by
PostgreSQL identity, uniquely mapped to its UUID. Advisory namespace `72203` is
separate from A01's proposed admission namespace `72202`. There is no UUID hashing
collision. Product C03 needs a persistent per-call key registry shared by all
operations, ordered by call ID for multi-call sequences; a key must not change for
each operation. The lab schema is not a product migration.

The old worker is a separate OS process with a dedicated `pg.Client`. It acquires
`pg_advisory_lock(72203,key)` outside a transaction, commits the operation as
`uncertain` before any possible send, and holds that session through command/result
handling. It latches connection errors permanently; it never reconnects to regain
authority. It checks the same connection immediately before sending. All ESL is
outside SQL transactions. Stable `origination_uuid` and `Job-UUID` are persisted
before the operation can be sent.

This pre-send check does **not** close the DB-to-ESL race. A real TCP fault relay
holds command bytes independently of the DB session and the stopped old process.
It proves that an old command can reach FS after a replacement obtains the advisory
lock. The relay is test fault injection, not a production fencing gateway.

Replacement/reconciliation acquires the same advisory key and must leave the claim
`uncertain`, with no resend, release or generation advance. Neither TTL, a successful
new lock acquisition, a query failure, nor `uuid_exists=false` permits reuse.
The schema also rejects premature `released` updates with PostgreSQL CHECK `23514`.

The independent lab coordinator permits release only after all applicable evidence:

- The old sender has exited and been reaped by its parent, so it cannot resume.
- Its transport and the relay are closed; no queued bytes remain.
- For every physical send, the exact `BACKGROUND_JOB` has completed, the exact leg's
  `CHANNEL_HANGUP_COMPLETE` has arrived and `uuid_exists` confirms absence.
- The command/INVITE/channel ledger accounts for zero or one send and creation.

These are coordinator-observed facts, not boolean claims accepted from an API client.
Only then can a guarded DB update release the reservation and a new reservation
advance generation. Confirmed absence without quiescing the old sender is explicitly
tested as unsafe. Production cannot infer remote process death from a lease or PID:
C03 must supply equivalent trusted process/transport quiescence or keep the slot
uncertain for operator recovery. Unknown jobs, missing completion evidence, lost
event history or unreachable workers fail closed. FS restart/epoch recovery and
distributed supervisor enforcement remain H01/I02 work.

## Reproduction

```bash
node tests/a05-rebridge.test.mjs
bash -n scripts/test-a05-rebridge.sh
npm run test:prototype:rebridge
npm run quality
git diff --check
```

The runner requires Linux, Node >=22, Docker, `nsenter`, `timeout` and these cached
images:

- FS: `safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6`
- PG: `postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`

It creates a `--network none` namespace anchor and puts only disposable FS and PG
containers in it. No ports are published, PG uses only a private Unix socket, and
the process never reads `.env`, `DATABASE_URL` or `TEST_DATABASE_URL`. A 300-second
probe limit and EXIT trap remove those containers and the temporary PG volume.
Private `/tmp/outbound-a05.*` artifacts remain on success or failure.
The `local-sip-rtp` CI job sets `A05_ARTIFACT_DIR` to a private directory under
`$RUNNER_TEMP`. On exit the shell runner stages the current report, logs, WAVs,
and provenance files there with ownership assigned to the GitHub Actions runner.

`report.json` records scenario outcomes, actual ESL sends/responses, stable UUID/job
IDs, DB snapshots before/after uncertainty, worker IPC and exit evidence, channel
events, decoded RTP and recording measurements, plus zero-channel cleanup. The
directory also retains WAV files, logs, network/image evidence, base revision and
source hashes. Fixture XML/registrar files contain disposable credentials; do not
publish those files. The independent U suite checks the media oracle against silence,
wrong tones, noise, invalid/compressed WAV and codec conversion. It supplies no FS/DB
acceptance evidence.

| Criterion     | Runtime check                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A05.1 FS      | Two directions × four source boundaries; same UUID, actual bridge, fresh decoded audio in both directions, old UUID teardown replay, one customer media bug and decoded three-tone recording. Recording failure leaves the criterion open.                                                                          |
| A05.2 FS + DB | Stop/resume a real worker (`SIGSTOP`/`SIGCONT` and `/proc` state barrier), terminate its actual PG backend, acquire the lock on another connection, reject release/reuse, then reconcile sends/jobs/terminal events and reap. Modes: before send, bytes delayed past lock loss, lost response after job completion. |
| A05.3 FS + R  | Source disappears at each declared boundary; bounded recipient recovery and cleanup are asserted; absent-source fallback, supervisor policy and unsupported cases are stated above. Recording limitations remain explicit.                                                                                          |

## Handoff

Final command results and the retained artifact path are recorded below and in A05.
Until every required check passes, leave A05 open and its tracker item unchecked.
No commit, push, PR, deployment, product schema change or provider call is included.
A06/B03/C03/G02 consume the verified local protocol, with the product integration
and distributed recovery boundaries above. No prototype result substitutes for their
own required runtime checks.

### Verified result — 2026-11-14

Final run: `2026-11-14T09:20:09.050Z` (13:20 Asia/Yerevan), Node `v23.7.0`,
FS `1.10.12`, the pinned images above. All 12 groups passed: three executor faults,
eight direction/source-boundary media+recording cases, and final cleanup.
All runtime source hashes match the final local code. Earlier failed fixture runs
are not counted as acceptance evidence.

- A05.1 passed (FS): eight retained-customer bridges, decoded two-way RTP, late
  old-leg hangup rejection and eight stereo WAV files containing all three tones.
- A05.2 passed (FS + DB): physical send/actual INVITE counts were 0, 1, 1; claims
  stayed uncertain under replacement lock ownership, including observed absence
  before the delayed send. Premature release violated CHECK `23514`; generation
  advanced only after process/transport/job/terminal reconciliation. The final
  generation-2 reservation is intentionally created by each fixture to demonstrate
  reuse; its snapshot is retained and its disposable database is then removed.
- A05.3 passed (FS + R): all four source-loss boundaries in both directions recovered
  to the prepared recipient, with full scenario durations 1449–1519 ms, below the
  15-second lab bound. Supervisor teardown/new-session policy and unsupported
  distributed/FS-restart cases are documented above; supervisor media itself was
  not exercised by this task.
- Cleanup passed: `show channels count` converged to `0 total.` within five seconds;
  fixture endpoint error lists were empty and the three disposable containers were
  removed. FS's SQL-backed channel inventory may lag live UUID/terminal events;
  final cleanup explicitly waits for that inventory instead of assuming synchronous
  deletion.

Artifact: `/tmp/outbound-a05.pIKaji8L/report.json`.
SHA-256: `60cf16dd5e3248fc0821a5d4e331381ba8eb58b361714f26a28e6beb4ecc929e`.
Runtime log: `/tmp/outbound-a05-final-runtime.log`.

| Command                                                                 | Result                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node tests/a05-rebridge.test.mjs`                                      | Passed, three U tests.                                                                                                       |
| `bash -n scripts/test-a05-rebridge.sh`                                  | Passed.                                                                                                                      |
| `npm run test:prototype:rebridge`                                       | Passed, exit 0, 12 groups, actual isolated FS + PG.                                                                          |
| `npm run quality`                                                       | Passed, exit 0: OpenAPI, lint, format, typecheck, API 262, web 134, ops 60, all builds. Log `/tmp/outbound-a05-quality.log`. |
| Focused ESLint and Prettier checks after final cleanup/document changes | Passed.                                                                                                                      |
| `git diff --check`                                                      | Passed.                                                                                                                      |

The Docker/namespace runner and quality gate ran with permission for local Docker
and loopback fixture listeners. `TEST_DATABASE_URL` was unset: the optional general
application DB integration suites were not supplied a database. A05's separate
runner did use real disposable PostgreSQL and separate backend connections.
Browser E2E, general FS regressions, provider, load/soak and target deployment were
not run. A05 completion is local FS + DB/R prototype evidence, not product, browser,
distributed production recovery, provider or rollout acceptance. Changes remain
local and uncommitted.
