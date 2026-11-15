# C07 — Eligibility serialization and supervisor migration boundary

Task: [C07 #20](https://github.com/sptmru/outbound-freeswitch-dialer/issues/20).
Base: `bcf415f`, local branch `feat/c07-eligibility-supervisor`.
Status: **partial implementation; C07 remains open**. No inbound enablement,
deployment or provider testing is supplied by this change.

## Implemented SQL protocol

`apps/api/src/eligibility.ts` supplies a short `READ COMMITTED` mutation transaction:
admission `(72202,0)` → campaign parents when needed → sorted user media and user
parents → sorted agents → sorted slots → Desk/transfer/offer/intent writes.
Lock/statement/idle limits are 250/500/1000 ms. No ESL, network or filesystem work
belongs in its callback. Call it with an idle pool, outside existing transactions
and session media locks. It cannot authorize a media send or enable cutover.

`PATCH /agent/availability` now serializes pause/resume with admission and
rechecks active user/auth version after locking. Pause
cancels only the actor's pending offers and pending/deferred automatic intents.
A pending recipient transfer is canceled without changing the source call.
Accepted offers, started intents, connecting transfers and every occupied slot
are retained. Resume cannot resurrect canceled work. Offers already past deadline
become `expired` / `deadline_elapsed`, preserving the permanent exclusion; other
eligibility cancellations create no Ignore exclusion.

`changeDeskEligibility` is an internal adapter for D01, with authenticated user,
auth version, controlling session, revision, binding generation and database lease
checks after gate acquisition. Campaign change or clearing readiness increments
the revision and invalidates pending work atomically. It never sets positive
readiness, provisions a SIP identity, takes over a controller or frees media.
D01 must call this protocol from its eventual authenticated Desk routes and
server-side binding verification; this change adds no new public Desk route.

Legacy registration reconciliation and Sofia registration event writes now use
admission before ordered agent/slot locks. Their shared-username `registered` flag
remains legacy telemetry; it does not attest a per-Desk-generation SIP endpoint.
Actual verified binding publication, stale binding fencing, registration freshness
and lifecycle remain D01 integration work.

User updates/deletion acquire admission before the existing user-media lock.
Credential/session revocation also revokes the controller, clears readiness and
cancels pending work, preserving occupied slots. Campaign audio claims acquire
admission before their existing campaign audio advisory lock. Maintenance-sensitive
legacy supervisor starts take the shared maintenance row before admission/media,
recheck target UUIDs and reject an occupied pre-SIP/transfer-recipient slot even
when `calls.agent_id` does not identify the actor.

Agent Desk availability reads project obsolete `wrap_up` as `available` without
an uncoordinated read-side UPDATE. Native admission uses the same product policy;
legacy outbound creation still clears stored wrap-up in its existing transaction.

## Open supervisor and inventory work

The existing supervisor start/mode/stop functions still use the legacy sender;
mode/stop still hold the old session media lock across ESL. They do not implement
the native C03 durable-operation/uncertainty protocol or C02 supervisor capacity
accounting. They are explicitly refused when `call_admission_migration` records
native reconciliation, before contacting FreeSWITCH, with HTTP 409 and
`Live monitoring is temporarily unavailable`. Start repeats this check under
admission. This is a fail-closed migration boundary, not supervisor completion.
I05 must drain legacy work before changing that marker; the marker is not a
supported live toggle or an enable command.

Remaining C07 work is concrete:

1. Implement native supervisor start/change/stop intent producers and C03 drivers,
   including fixed UUID/job evidence, occupied-endpoint exclusion, uncertainty,
   C02 capacity and replacement only after confirmed old-leg/sender cleanup.
2. Remove the legacy session-media execution path from the enabled protocol;
   rerun both supervisor/Desk commit orders and mode replacement with actual FS.
3. Complete A01's inventory for enabled writers, including campaign administration,
   maintenance, authentication, registration and release paths. Prove the mixed
   lock schedules and feature-off regressions; do not enable inbound based on the
   guards or SQL-only tests in this slice.

These are unfinished implementation/verification obligations in C07, not missing
provider access and not criteria delegated to D01 or I05. D01 retains only its
own product controller/binding integration; I05 retains deployment/bootstrap.

## Verification and acceptance mapping

`eligibility.integration.test.ts` runs in quality with `TEST_DATABASE_URL` and in
`test:inbound:db`. It uses a separate Node admission process, separate PostgreSQL
backends, pre-commit barriers and observed `pg_blocking_pids` blocking. The matrix
executes the real mutation functions against C01 reservation admission, in both
commit orders and with either first writer rolled back (12 schedules). It checks
slots, operation count, pending work and exclusions. Additional cases retain an
accepted reservation, preserve another transfer source/recipient's work, expire
an elapsed offer, reject a stale revision, and keep legacy wrap-up display and
admission consistent. Real legacy supervisor validation with a simulated ESL
adapter rejects occupied pre-SIP slots and maintenance with zero originates;
native-cutover guards refuse all three legacy supervisor entry points before ESL.

| Criterion | Result in this slice                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C07.1     | SQL mutation/admission races verified; product D01 endpoint lifecycle is not implemented here.                                                                               |
| C07.2     | Open: native supervisor driver/capacity migration and mandatory DB + FS endpoint/mode regression are unfinished. Guards are tested, not counted as completion.               |
| C07.3     | Partial: eligibility/auth/audio lock edges and supervisor-start maintenance are migrated; enabled-writer inventory and supervisor replacement/release schedules remain open. |

All admission-worker media is absent; its operation row is a persisted simulated
command intent, with no ESL transport. A SQL reservation is not an established
browser conversation. The pinned FS image is available locally, but no C07 FS
matrix has been implemented/run. Browser/WebRTC, provider, load/soak, hosted CI,
target enablement, drain/rollback and production are unverified.

Local checks on 2026-11-15:

- `bash /tmp/c07-quality-pg16.sh`: full `npm run quality`, disposable pinned PG16,
  passed 358 API tests with zero skips, 135 web tests, 76 ops tests and all builds;
  `/tmp/outbound-inbound-db.BmVYfzWa/result.txt`. Final clock/lock refinements were
  checked separately on the final source below.
- `npm run test:inbound:db:isolated`: after increasing the child/outer bounded
  timeouts to 180/240 seconds, passed 64/64 PG17 DB tests with zero skips;
  `/tmp/outbound-inbound-db.bfSGNRja/result.txt` and `c07-eligibility-report.json`.
- `bash /tmp/c07-final-verification.sh`: final-source PG17 C07 DB matrix plus
  availability, registration, auth, supervisor and ESL-event unit regressions:
  60/60, zero skips. `/tmp/outbound-inbound-db.I7bfI23p/result.txt` and
  `c07-eligibility-report.json`. This includes one DB-clock stamp per offer/transfer
  cancellation and bounded auth/supervisor-start lock acquisition.
- `npm run test:voicemail:db`: passed 8/8 real PostgreSQL voicemail regressions,
  zero skips; `/tmp/c07-voicemail.log`.
- Final `npm run lint`, `npm run format:check`, TypeScript test compilation,
  `bash -n scripts/test-inbound-db.sh` and `git diff --check`: passed.
- The first `npm run test:inbound:db:isolated` exceeded the existing total runner
  deadline; it is not a passing full run. Its partial evidence is retained at
  `/tmp/outbound-inbound-db.VrWhBn0e`. An additional supervisor fixture initially
  used the invalid leg state `active`; it was corrected to the schema's `answered`
  and is covered by the passing final-source run.

Temporary wrappers derive from `scripts/test-inbound-db.sh`, pin root to this
checkout and change only the test command and, for PG16, the cached image digest
to `sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`.
Containers use `--network none`, no published ports and private test Unix sockets.
Cleanup removed them. Docker/local TCP fixtures required execution outside the
restricted sandbox. Evidence is local temporary data, not hosted artifacts.
