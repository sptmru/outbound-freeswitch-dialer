# C01 — Common admission and fenced slots

Task: [C01 #14](https://github.com/sptmru/outbound-freeswitch-dialer/issues/14).
Base: `1e51246` (`dev`); local branch `feat/c01-admission-gate`.

`apps/api/src/call-admission.ts` implements the internal SQL admission protocol.
It is not mounted in a public route or called by legacy call/event workers. The
migration marker remains pending by default; this change does not enable inbound,
transfers or new outbound admission. C02–C07/D/E/G implement their path-specific
capacity, operations, contact, offer, transfer and execution policies on this base.

## Transaction and lock contract

`withCallAdmission(client, resources, work)` owns BEGIN/COMMIT/ROLLBACK on an
**idle, dedicated** client supplied by the caller. Never nest it in another
transaction or wrap it in a legacy user-media session lock. An executor may
already hold its required rank-0 execution locks on that same client, acquired
outside the transaction. This module does not acquire or release execution locks.

1. Discover existing call owners, open participants/transfers, active supervisor
   actors and their agent/user/campaign identities. This is only a candidate set.
2. Begin explicitly at `READ COMMITTED`. Set local lock/statement/idle transaction
   limits to 250/500/1000 ms. Pool acquisition/reserves remain C03's responsibility.
3. For starts, take the existing `ops.call_start_paused` shared row lock before
   admission; reject maintenance without running the callback.
4. Acquire transaction advisory lock `(72202, 0)`. Refuse if
   `call_admission_migration` is absent or still requires reconciliation.
5. Acquire sorted campaign audio locks using the existing voicemail namespace,
   campaign parent rows, user-media `(72201, hashtext(userId))` locks and user
   parent rows, agent rows, slot rows, then call rows. IDs are lowercase,
   deduplicated and sorted independently within each group.
6. Rediscover and compare the complete set before running the callback. A changed
   owner/participant/transfer/supervisor set throws `AdmissionDiscoveryChanged`
   and rolls back, including when a new owner would sort after the old set.
7. The callback may perform short SQL child/operation, capacity, then contact
   writes in A01 order. Never acquire an earlier rank, lease another connection,
   perform ESL/files/network work, or wait for a user. Commit before execution.

The callback is deliberately an internal transaction interface, not an API
security boundary or sandbox for arbitrary SQL. Its consumers must declare all
parent/agent/call resources, authenticate the actor and preserve the lock graph.
For a new outbound call, preallocate/declare its UUID and insert it in the callback
after parent locks, before reserving its slot; rollback removes that uncommitted
call too. C04 owns integrating this sequence with contact/offer/operation writes.
A changed set is **not automatically retried**: release the full rank-0 execution
set, rediscover, reacquire and retry with a bounded policy. No callback or command
is silently replayed. Lock/statement failures roll back and return to the caller.
The DB idle deadline bounds an abandoned callback, not an ESL execution timeout.

## Authoritative eligibility and slot lifecycle

`eligibility` reads after gate and row acquisition. It validates the authenticated
user-to-agent relation, active user/campaign, pause/wrap-up, exact controlling Desk
session/revision/campaign, current verified binding and lease, reconciled free
slot, legacy interactive occupancy and supervisor exclusion. Deadline/lease
checks use PostgreSQL `clock_timestamp()`: transaction-start `now()` is too old
when the request waited for admission.

For an offer it additionally checks the exact call/agent/session/revision/binding,
pending state, fixed offer deadline, persistent exclusion, live queued inbound
and queue deadline/fallback, or an offered live transfer. Transfers may cross
campaigns; inbound must match the selected campaign. Offer dispatch, single-winner
call transitions and transfer-source validation remain E/G responsibilities.

`queuedCallIds` returns eligible durable inbound in arrival/ID order even before
an offer exists. Persistent ignore/expiry exclusions survive Desk/campaign changes.
An expired pending offer is also excluded before its expiry worker runs. C01 does
not renew deadlines or manufacture exclusions; E01 persists the expiry. C05 must
use this result as the automatic priority veto. Manual starts retain their own
atomic dismissal policy in C04; `reserve` alone does not implement that workflow.

`reserve` rechecks eligibility and matches any supplied offer to the requested
call, then claims a reconciled free slot before SIP exists. B02's trigger issues
a new UUID and increments the bigint generation. `transition` matches the complete
`(agent_id,call_id,reservation_id,generation)` token and refuses lifecycle regression;
uncertain cannot return to connecting. `release` requires that full token,
caller-confirmed media cleanup **and no unresolved call operation**, including
past-deadline pending/executing/uncertain operations. No lease/TTL frees occupancy.
A stale token is a no-op; rollback preserves the current reservation.

The caller's cleanup assertion still requires real FS/command evidence. These
SQL methods perform no `uuid_exists` probe and do not turn a command ACK into
absence proof. Reconciliation/cutover must account for FS orphans and legacy sends.
There is no bulk-free or marker-enabling command in this module. I05 owns guarded
cutover after all competing legacy writers have been migrated; changing the marker
alone is insufficient authorization to enable routing.

## Verification and boundaries

`npm run test:inbound:db:isolated` includes `call-admission.integration.test.ts`
and its separate-process SQL participant `tests/fixtures/inbound/admission-worker.mjs`.
The same tests run in the API/quality gate when `TEST_DATABASE_URL` is supplied.
The dedicated runner refuses a missing/unsafe URL; ordinary API tests explicitly
skip environment-backed suites without it.

| Criterion | Concrete DB evidence                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01.1     | Distinct Node processes and PG backends, outbound and inbound reservation contenders, both winners plus first-writer rollback; server-observed blocking, exactly one slot/operation, no SIP leg, losing offer/contact/capacity effects or command sends. Inbound test participants prepare/accept their candidate offer inside the gate; this is not the E02 HTTP/media acceptance workflow. |
| C01.2     | Campaign, pause, session, binding, user and occupancy changes commit while a waiter is blocked. A fixed offer deadline passes while it waits, checked against DB time without an expiry worker. Expired history and unseen queued calls exercise the shared queue query.                                                                                                                     |
| C01.3     | Unresolved past-deadline operation retains uncertain occupancy despite cleanup flag; definitive simulated resolution permits release, new generation and reservation; old/wrong tokens and rolled-back release preserve the newer claim.                                                                                                                                                     |
| C01.4     | Participant and supervisor changes after discovery abort before callback. Explicit rediscovery/retry succeeds once. Existing audio/media advisory locks and migrated SQL supervisor/finalizer schedules complete with no inversion, in both orders. Maintenance closure/start uses compatible shared locks in both orders; bounded gate timeout rolls back.                                  |

The tests inspect actual `calls`, slots, participants, legs, offers/exclusions,
transfers, operations, contacts, auto intents, capacity and supervisor rows. Reports
`c01-*-report.json` retain snapshots, assertions, process/backend IDs and DB version;
the runner retains base revision, source hashes, isolation and container cleanup.
Child processes have finite lifetimes and are reaped before schema teardown.
All media is absent; test-only reconciliation and cleanup are explicitly simulated.

C01 does not migrate the actual legacy supervisor/audio/finalization route/event
implementations. In particular the old session media wrapper must not be wrapped
around admission. C04–C07 must use this protocol and rerun their integrated races
before enablement. No browser/WebRTC, FreeSWITCH/SIP/RTP, provider, load/soak,
target-storage performance, deployment/rollback, hosted CI or production proof is
supplied by this SQL change. Those gates remain in their owning tasks.

## Local verification — 2026-11-15

Node.js 23.7.0 (required >=22). Changes are local and uncommitted on the branch
above. No push, PR, deployment, production mutation or provider call occurred.

| Command / environment                                                            | Result / retained evidence                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bash /tmp/c01-quality-pg16.sh`                                                  | PASS: full `npm run quality` with disposable PostgreSQL 16; OpenAPI, lint, formatting, types, 312 API tests with zero skips, 135 web and 76 ops tests, all builds. `/tmp/outbound-inbound-db.n8l54ovK/result.txt` and `c01-*-report.json`. |
| `npm run test:inbound:db:isolated`                                               | PASS: final code, pinned PostgreSQL 17, 22/22 DB tests with zero skips. `/tmp/outbound-inbound-db.Y8LCTqSb/result.txt` and `c01-*-report.json`.                                                                                            |
| `git diff --check`; `bash -n scripts/test-inbound-db.sh`; focused Prettier check | PASS.                                                                                                                                                                                                                                      |

The temporary PG16 wrapper derives from `scripts/test-inbound-db.sh`, changing
only root resolution, the final command to `timeout 300 npm run quality` and the
cached PostgreSQL image digest to
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`.
Both containers used `--network none`, no published ports and private test Unix
sockets, and were removed. Schema cleanup and worker exit assertions passed.
Docker and local test sockets required execution outside the restricted sandbox;
the initial sandbox attempt was denied Docker socket access before tests ran.
Artifacts are local temporary evidence, not hosted uploads. No independent
voicemail DB runner was needed: this task changes no voicemail implementation or
schema; existing voicemail API/unit regressions passed in quality. Browser E2E,
FS/RTP, provider, load, target/rollback and hosted-CI gates were not run.
