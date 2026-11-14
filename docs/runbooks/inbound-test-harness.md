# Inbound test harness (A07)

This is test infrastructure, not product inbound admission or transfer behavior.
The fixture self-check deliberately uses a small `claims` / `work` / `ledger`
model. Future B–I tasks must test their actual migrations, routes, tables and media
paths; passing this harness does not satisfy their acceptance criteria.

## Commands and evidence levels

| Command                                                                          | Prerequisites                                                                                 | Evidence / boundaries                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test tests/inbound-harness.test.mjs`                                     | Node >=22, `npm ci`                                                                           | U: URL/runner safety, ledger invariant failures, deterministic event replay, local SIP source guard and CI wiring                                                                                 |
| `npm run test:inbound:db`                                                        | Explicit local `TEST_DATABASE_URL` pointing to a disposable test DB; CREATE SCHEMA permission | DB: required, fails before compilation if URL absent/unsafe; never reads `.env` or falls back to `DATABASE_URL`                                                                                   |
| `npm run test:inbound:db:isolated`                                               | Linux Docker, cached pinned PostgreSQL image, Node >=22, `npm ci`                             | DB: creates/removes its own network-isolated container and Unix socket; no published ports; retained artifacts in printed `/tmp/outbound-inbound-db.*` directory                                  |
| `npm --workspace @outbound-dialer/api test`                                      | Node >=22, `npm ci`; optional `TEST_DATABASE_URL`                                             | Existing API tests plus top-level `inbound-harness.integration.test.ts`; harness explicitly skips when URL absent, rejects unsafe URL when present                                                |
| `npm --workspace @outbound-dialer/web test -- src/test/inbound-fixtures.test.ts` | `npm ci`                                                                                      | U: jsdom EventTarget, simulated presence/events; no SIP or media                                                                                                                                  |
| `npm run build && npm run test:e2e`                                              | Chromium installed via `npx playwright install --with-deps chromium`                          | B: Vite preview plus routed API fixtures; A07 browser test replays events across contexts. No integrated product API or SIP/RTP. I01 must supply a real isolated test API for integrated journeys |
| `npm run test:prototype:desk-binding`                                            | Linux, Docker, `nsenter` privilege, pinned FS and PG images                                   | FS + DB: A04 two real UDP SIP clients; simulated Desk controls, not browser WebRTC or provider                                                                                                    |
| `npm run test:prototype:rebridge`                                                | Same Linux/FS/PG dependencies                                                                 | FS + DB: A05 actual UDP SIP/RTP, known tones, decoded recordings, process/ESL faults; not browser/provider                                                                                        |
| `npm run test:prototype:budgets`                                                 | Linux Docker, pinned PG image                                                                 | DB saturation with delayed **simulated ESL** and representative SQL control lanes; not product API load, SIP/RTP load or I03 acceptance                                                           |

`test:load:inbound` is reserved for I03 and remains unimplemented. Existing
`test:load:desk` and `test:load:sip-rtp` require their own configured test environment;
they are not substitutes for inbound/transfer workloads. No new A07 command accepts
an external dial target. Real-provider tests/load require separate authorization
under I04/I05; this runbook gives none.

The isolated DB runner pins
`postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
The local FS fixtures pin
`safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6`.
They never attach to the product Compose stack. The DB runner removes its owned
container/volume on success and failure; artifacts remain until explicitly removed.

For a separately provisioned disposable CI database:

```bash
# Example has disposable fixture credentials only; never copy a populated app .env.
export TEST_DATABASE_URL=postgresql://fixture:fixture@127.0.0.1/outbound_dialer_test
export INBOUND_TEST_ARTIFACTS=test-results/inbound-db
npm run test:inbound:db
```

The URL guard allows only loopback PostgreSQL, an explicit `test`, `test_*` or
`*_test` database name, and the isolated runner's `/tmp/outbound-inbound-db.*/socket`
override. It rejects other URL options and a URL designating the configured
application `DATABASE_URL`, including localhost aliases. The guard is a mistake
prevention measure: the operator must still provision a disposable database, never
a production database or a proxy to one. It creates only a random
`inbound_fixture_<hex>` schema and never truncates application tables.

## Reusable controls and failure checks

`tests/fixtures/inbound/database.mjs` exports `createDatabaseFixture`,
`assertBlocked`, `harnessSelfCheck`, and explicit DB URL validation.
`fixture.worker(operation)` launches a separate OS process/PG session. The sample
worker supports `a` and `b`; it models fixture ownership only. Its control messages
are available in `fixture.transcript`. Always put `fixture.cleanup()` in `finally`.
Workers have a 15-second deadline, die on parent disconnect, and are killed/reaped
before schema cleanup. SQL/lock/acquisition waits and the dedicated runner are bounded.

| Checkpoint                        | Fixture observable state                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `before-claim`                    | No transaction/claim yet                                                                        |
| `before-commit`                   | Exclusive fixture-table lock and uncommitted claim/work; another PG backend demonstrably blocks |
| `before-send`                     | One committed claim/work, no ledger send                                                        |
| `after-send-before-ack`           | One simulated send, `uncertain` persisted work; no ACK yet                                      |
| `after-bridge-before-persistence` | Simulated ACK/bridge evidence exists while work remains `uncertain`                             |

Continue with `worker.send("resume")`, roll back before commit with
`worker.send("rollback")`, or crash at any boundary with `await worker.stop()`.
Use `await worker.wait(checkpoint)` to establish order. `assertBlocked` polls
`pg_blocking_pids`; its short polling interval is not a scheduling barrier.
The self-check runs A→B and B→A commit orders, rollback→competing commit, and
SIGKILL at all five checkpoints. It checks visible rows, command counts, retained
uncertainty, rollback, distinct OS/backend PIDs, zero loser effects and cleanup.
It inserts a duplicate persisted send deliberately and requires `assertLedger`
to throw. The ledger deliberately has no uniqueness constraint so the checker
cannot be accidentally proven by a constraint rejecting the corrupt fixture.

`controls.mjs` is environment-independent and typed for API/web/Playwright imports.
`EventTape` delivers cloned events only on explicit `next`/`replay` calls, supports
duplicate/out-of-order indices and reset, and records fixed seed `7`. There is no
random timing or autonomous delivery; future randomized workloads must record
their own deterministic seed. `assertLedger` checks chronology and duplicate
effects. Future domain tests should pass actual collected commands/snapshots,
not substitute the fixture's minimal state model for product state.

`sip.mjs` exposes `localSipClient`, reusing A04's Digest REGISTER, INVITE/SDP and
RTP counters. It refuses non-loopback source addresses before opening sockets;
the transport destination stays fixed at local `127.0.0.1:5080`. A04 now consumes
this common entry point. A05 retains its specialized tone/decoded-WAV endpoint
in `scripts/a05-media.mjs`; do not equate packet counts with decoded two-way audio.
Use these clients only inside the existing A04/A05 network-none namespace runners.

## Discovery, CI and retained artifacts

- Root `tests/*.test.mjs` discovers U/script checks through `test:ops` and `quality`.
- API TypeScript compiles the new integration test. `scripts/run-api-tests.mjs`
  recursively discovers all `dist-test/**/*.test.js`, including future nested
  domain suites, and fails if none exist. The required DB command selects the
  harness file explicitly. When `TEST_DATABASE_URL` is set, API files run serially:
  existing suites share schema migrations and otherwise can deadlock a
  `CREATE INDEX CONCURRENTLY` against another migration advisory-lock waiter.
  Tests without a DB retain parallel file execution. This does not serialize
  workers/connections inside a race test or change application migration behavior.
- Vitest discovers `apps/web/src/test/inbound-fixtures.test.ts`; Playwright
  `--list` includes `tests/e2e/inbound-fixtures.spec.ts`.
  Anonymous Playwright tests share `tests/e2e/fixtures.ts`, which supplies explicit
  `401` bootstrap responses and blocks other API requests. Login rendering cannot
  accidentally depend on a reachable API or the local Vite proxy configuration.
- `.github/workflows/ci.yml` supplies its disposable PostgreSQL service, runs the
  strict DB command and quality, and uploads `test-results/inbound-db/` on success
  or failure. Browser CI builds the web app, installs Chromium, runs Playwright,
  retains traces/screenshots on failure and uploads its HTML report/test results.
- `.github/workflows/inbound-fixtures.yml` runs on pull requests and supports manual
  dispatch once available on the default branch. Its local-SIP/RTP job
  installs Node/npm dependencies, fetches pinned FS/PG images and runs A05 in
  isolated namespaces. Its separate bounded-saturation job runs A06 with pinned
  PG. Both have finite job/command deadlines and always upload sanitized evidence.
  Neither job receives provider/deployment credentials or changes deployment jobs.

The saturation job uses a bounded 256 MiB tmpfs for disposable PGDATA, within the
existing 512 MiB/2 CPU container limit. PostgreSQL keeps `fsync=on` and
`synchronous_commit=on`; every A06 SQL/lock/pool/latency budget is unchanged. This
isolates connection/executor scheduling from the host Docker-volume WAL flush
latency. It proves resource isolation against simulated ESL, not durable storage
performance or database-restart survival. I03 must measure the target storage.
For storage diagnostics, use `A06_PG_STORAGE=volume npm run test:prototype:budgets`;
that mode keeps the same budgets and fails on slow storage. It never falls back to
tmpfs or retries a failed measurement. `storage.txt`, `isolation.txt` and the JSON
report identify the selected storage mode and PostgreSQL settings.

Worker SQL failures carry SQLSTATE, lane/sequence/stage and stack to the parent
before pool cleanup. Failed/aborted workers fail the current checkpoint promptly;
the report retains bounded stderr, exit status, PostgreSQL activity and WAL timing
even when cleanup has to kill other workers. The shell prints failed-run output
and records owned-container removal. `tests/a06-worker-monitor.test.mjs` covers
early errors, abrupt exits, normal completion and invalid storage selection.

The DB report contains seed, eight scenario snapshots, checkpoint transcript,
status/error and schema/process cleanup assertions. Reports omit connection URLs.
The disposable runner also saves base revision, source hashes, image identity,
isolation mode, command output, PostgreSQL log and container-removal output.
Keep stdout/stderr and reports for failed runs; a fail-fast URL error happens
before fixture allocation and has only its explicit stderr diagnostic.

CI wiring is not evidence of a hosted CI execution. Record the actual command,
base revision plus uncommitted source hashes, Node/PG/FS/browser versions, seed,
artifact path, result and cleanup for each local/CI run. Distinguish configured CI,
locally executed CI-equivalent checks, hosted CI and provider acceptance.

## Consumed design decisions

- A01: [lock inventory/compatibility](../inbound-locks-and-compatibility.md).
  The self-check's exclusive table lock is fixture-only, not the product lock graph.
- A02/A03: [local ingress boundary](../inbound-ingress-prototype.md) and
  [durable journal](../inbound-durable-ingress-prototype.md). ESL replay is not a
  substitute for journal durability. A03's real FS+DB faults remain its own runner.
- A04: [session-scoped SIP binding](../inbound-desk-binding-prototype.md).
- A05: [rebridge and uncertain executor effects](../inbound-rebridge-executor-prototype.md).
- A06: [finite resources and protected DB lanes](../inbound-resource-budgets.md).
  Harness deadlines are fixture watchdogs, not new production budgets.

I01–I05 remain separate enablement gates. No provider trust/DID, billing, browser
two-way media, target deployment, or product inbound behavior is established by A07.

## Local verification record — 2026-11-14

Issue [A07 #8](https://github.com/sptmru/outbound-freeswitch-dialer/issues/8), branch
`test/a07-inbound-harness`, base `3494ed34ba62d035eb4fc90e3c6b50be4583945a`.
This historical record describes the original local/uncommitted handoff; the
follow-up below records the subsequent merge, PR and new verification. The
original handoff left the issue open for A07.3 and did not complete the tracker.

| Criterion | Result and evidence                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A07.1     | PASS: eight real-PG harness scenarios, both commit orders, rollback, five process-crash boundaries, observable blocking, duplicate-send checker rejection and schema/process cleanup                                                                                 |
| A07.2     | PASS: strict command fails without a test URL; alias/unsafe/duplicate-host URLs rejected; optional API invocation reports the explicit skip; unavailable loopback DB produces a retained failed report                                                               |
| A07.3     | PARTIAL: required DB/quality/browser CI wiring and failure uploads implemented; clean local Node 22.13.0 `npm ci`, strict DB and full quality pass on PG 17.11. Hosted Actions execution remains pending. The existing A06 saturation runner fails as recorded below |
| A07.4     | PASS locally: runbook, script safety checks, simulated event/browser checks, real local SIP/RTP regressions, finite watchdogs and isolated cleanup; provider checks remain separately authorized future work                                                         |

Clean-source verification used `/tmp/a07-clean-source.rorNRsG3` with an independent
network-none PostgreSQL container. Logs, the strict DB report and cleanup evidence
are in `/tmp/outbound-inbound-db.zaemCp1V`: `npm-ci.log`, `required-db.log`,
`quality.log`, `harness-report.json`, `node-version.txt`, `final-source-sha256.txt`,
`base-revision.txt`, `postgres.log`, and `container-cleanup.txt`. Full quality passed
273 API tests (zero skipped), 135 web tests, 72 operations tests, static checks and
all workspace builds. The normal no-DB quality run separately passed and explicitly
skipped the optional A07 DB test. The final runner's watchdog error-handler change
is covered by the final focused runner checks rather than that clean-copy snapshot.

Local browser regression passed 6/6. A04 passed all six groups at
`/tmp/outbound-a04.wkEY4OKY`; A05 passed all twelve groups including zero actual
channels at `/tmp/outbound-a05.LIuOt3mS`. These FS regressions used Node 23.7.0,
PG 17.11 and the pinned FS image. They prove the local UDP SIP/RTP fixtures;
the browser suite uses mocked API/media, and supplies no WebRTC/provider proof.
Final Node 22.13.0 standalone DB verification passed all eight scenarios with
cleanup at `/tmp/outbound-inbound-db.VexKEbvs`; final Node 22 Playwright passed
6/6 (`/tmp/a07-node22-browser.log`). The unavailable-DB negative run retained
its failed report at `/tmp/a07-expected-db-failure/harness-report.json`.
The final worker lifecycle check additionally requires exit code zero for normal
completion, while crash scenarios retain their expected signal. It passed at
`/tmp/outbound-inbound-db.XskFGxPy`. The normal-disconnect handler and these exit
assertions were checked with this final focused DB run after the clean-copy gate.

Two fixture issues were found and addressed: the anonymous login test had no API
bootstrap fixture and stayed on `Loading dialer`; explicit `401` routing fixes its
environment dependency. Concurrent API-file migration bootstrap deadlocked
`CREATE INDEX CONCURRENTLY` against a migration advisory-lock waiter (`40P01`);
the DB-enabled API runner now serializes files while preserving concurrency inside
race tests. The initial traces/logs remain in `/tmp/a07-first-browser-failure` and
`/tmp/outbound-inbound-db.p9hevEo5`.

**Open saturation result:** `npm run test:prototype:budgets` failed twice, including
a separate run after the browser suite finished. Artifacts are
`/tmp/outbound-a06.oupt7R2t` and `/tmp/outbound-a06.gLrtAZ47`. PostgreSQL logged
`canceling statement due to lock timeout` for
`SELECT pg_advisory_xact_lock(72205,1)`; the parent reported
`Timed out: all protected control paths progress`. The underlying timing cause
has not been established. No A06 budgets, retries or production code were changed,
and no later run is substituted for either failure. Diagnose the saturation fixture
and execute the declared CI jobs before closing the A07.3 gate. Hosted CI requires
publishing the branch, which is outside this run's authorization.

## A07 follow-up — local verification and CI submission

The owner subsequently merged the harness into `dev` as
`1a56154b5c4562b6d30a175dc02ce77ab2761008` and approved a follow-up PR into `dev`.
Branch `fix/a07-saturation-ci` diagnoses the saturation failure, preserves worker
errors and enables isolated jobs on PRs. No target/provider or deployment work is
part of this follow-up.

Local controlled comparison identified the Docker-volume WAL flush bottleneck:
the admission worker failed with `55P03` while control sessions waited in COMMIT
on `WalSync` / `WALWrite`. The volume diagnostic still fails with unchanged
budgets (`/tmp/outbound-a06.Ec3xtksc`); the bounded tmpfs reference passes with
`fsync=on`, `synchronous_commit=on`, p95 ≤15.335 ms / p99 ≤39.683 ms and no leaks
(`/tmp/outbound-a06.jbLm9VeZ`). See the [A06 follow-up](../inbound-resource-budgets.md#a07-follow-up-reproducible-storage-and-worker-failures)
for the interpretation and target-storage acceptance boundary.

The owner also approved fixing the high Vite/Zod advisories exposed by the CI
audit. Vite is locked to 6.4.6 (including peer consumers through the root override)
and the API uses Zod 4.6.7. Route IDs use `z.guid()` to preserve the previous
UUID-shaped ID contract; Zod 4's stricter UUID version/variant validation would
reject previously accepted IDs. The HTTP 400 response retains
`{ message: "Validation failed", issues }`, with issue `path`, `code` and `message`;
individual issue codes/messages follow Zod 4. Regression checks cover that
envelope, normalized environment defaults/coercion, absent optional request fields
and the contact-field collection bound. See the [Zod migration guide](https://zod.dev/v4/changelog).

Final local CI-equivalent verification used Node 22.13.0, npm 10.9.2 and disposable
PostgreSQL 16 (matching the CI major). Clean `npm ci`, required
`npm run test:inbound:db` and `npm run quality` passed: 277 API tests with no skips,
135 web tests, 76 operations tests, formatting/lint/type checks and all workspace
builds (`/tmp/outbound-inbound-db.wDj3GatX`). The DB evidence includes all eight
harness scenarios and teardown. `npm audit --omit=dev --audit-level=high` passed
with zero high/critical findings and seven moderate findings
(`/tmp/a07-patched-production-audit.json`); this does not mean all advisories are
resolved. Chromium's six Playwright checks, example Compose validation and the
disposable hardened-proxy runtime check also passed locally
(`/tmp/a07-zod-browser.log`, `/tmp/a07-followup-proxy.log`). Browser fixtures use
mocked product endpoints/simulated presence and do not establish SIP/media proof.
The separate pinned FreeSWITCH/PostgreSQL lab passed all twelve A05 groups on
Node 22, including zero actual channels at teardown
(`/tmp/outbound-a05.hgDdkR88`, `/tmp/a07-followup-fs.log`); it provides local UDP
SIP/RTP evidence with no browser or provider traffic.

Follow-up PR: [#50](https://github.com/sptmru/outbound-freeswitch-dialer/pull/50).
GitHub's repository Actions permissions currently report `enabled: false`;
the PR has no hosted workflow execution. On 2026-11-14 the owner explicitly
instructed: "оставь actions выключенным, ты ж проверил все локально, закрой A07".
A07 is therefore accepted in the amended local scope: A07.1/A07.2/A07.4 have
the evidence above; for A07.3 the owner accepts local CI-equivalent execution and
reviewed workflow/artifact wiring instead of a hosted run. Hosted execution and
hosted artifact upload/download remain unverified, not reported as passed.
Actions stays disabled; the issue and tracker can be closed under that explicit
scope amendment. Provider, target-storage and I01–I05 gates remain separate.
