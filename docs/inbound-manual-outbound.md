# C04 — Explicit manual outbound admission

Task: [C04 #17](https://github.com/sptmru/outbound-freeswitch-dialer/issues/17),
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Base: `81f7898`.
Local branch: `feat/c04-manual-outbound-admission`.

## Implementation and activation boundary

`createDialerCall` supports the B05 manual intent through `admitManualOutbound`.
All three existing POST routes select that path for explicit manual intents:
`/agent/manual-dial/start`, `/agent/leads/:contactId/call` and `/agent/call-next`.
Automatic intent remains rejected until C05. The native response is B05's
`{status: "started", revision, callId, operationId}`: admitted work, never an
established conversation.

The route registration accepts a server-owned `wakeExecutor` dependency.
`manualOutboundExecutor` connects that dependency to the actual C03 `CallExecutor`
and composes mandatory native token validation with the trusted command driver.
A server-owned driver must target the exact persisted verified contact and fixed
agent/customer/job UUIDs, preserve correlation and establish command-specific FS
evidence. It must not use the legacy shared-user originate helper or equate ACK
with conversation. Deferred/uncertain commands remain durable for scheduler and
reconciliation; wake failure cannot roll back committed admission.

The current `server.ts` intentionally supplies no native execution dependency:
its v1 starts return `409 coordination_unavailable` before mutation. This change
adds no running worker, environment variable, role provisioning or alternate
release flow. Wiring/provisioning the protected C03 pools and native driver,
controlling-session lifecycle (D01), all release/competing paths (C05–C07),
recovery and the I01–I05 gates are still required before product activation.
Do not enable the reconciliation marker merely to make an HTTP request succeed.
The local DB/API fixtures explicitly install a simulated wake or a real C03
executor with simulated ESL; they do not prove a deployed calling workflow.

## Transaction and compatibility

1. Normalize phone input through the existing strict parser; fingerprint the
   normalized semantic request, route/resource and complete intent under an
   authenticated actor scope. A retry key is never a new execution authority.
2. Discover pending customer/source calls, all source/recipient agents and parent
   resources. Acquire maintenance, global admission, campaign, media/user, agent,
   slot and call locks through C01. A changed resource graph rolls back and
   rediscovery is bounded to three attempts.
3. Recheck actor activity/auth version. Stored identity returns before mutable
   readiness, occupancy and contact checks, including after completion and during
   maintenance. Different payload with the same scoped key conflicts. Maintenance
   remains locked before admission: `allowPausedReplay` permits reading only;
   a new producer must reject `admission.startPaused` before writes.
4. Validate controller, campaign/revision, exact binding, readiness/registration,
   pause/wrap-up, supervision, occupancy, active campaign, manual dialing policy,
   suppression and contact retry/confirmation rules. Contact selection retains
   `FOR UPDATE SKIP LOCKED` and current ordering.
5. Create call, concrete participants and fixed leg UUIDs. Reserve one fenced
   pre-SIP slot and one C03 originate operation. The combined `outbound` capacity
   plan atomically reserves browser, customer and trunk resources for that same
   operation. Lock child work before capacity rows.
6. Close only the actor's pending inbound offer as `ignored` or pending transfer
   as `declined`, with `manual_outbound_started`. B04 captures the inbound
   exclusion. Independently elapsed deadlines keep `deadline_elapsed`; an ended
   source or already closed transfer retains its outcome. No source/customer,
   other-agent offer, source slot, participant or media command is modified.
7. Cancel only the actor's deferred automatic work and increment a selected
   contact attempt in the same commit. Any pre-commit failure rolls everything
   back. Unseen queued calls get no invented offer/exclusion.
8. After commit, wake C03 once. Its native validator rechecks the full slot token,
   current actor/auth version, campaign, controller, endpoint and both fixed leg
   identities. A stale operation cannot send. Post-commit failure/cancellation
   retains dismissal and conservative capacity/slot ownership until confirmed
   cleanup through the owning release/recovery paths.

Legacy requests also acquire the global admission lock, campaign lock and bounded
SQL deadlines. They keep existing outbound behavior while reconciliation is
required and no coordinated work exists. Once native admission is reconciled,
**all** requests missing intent fail as `legacy_initiator_required`; they cannot
race a future controller/offer insertion, invent a manual initiator, or bypass
native capacity and replay. There is no automatic legacy-to-native retry.

No schema/shared type change or migration is needed. Existing feature-off readers,
OpenAPI responses and web behavior remain available. No deployment took place.

## Acceptance evidence

`manual-outbound.integration.test.ts` runs inside the ordinary API/quality gate
with `TEST_DATABASE_URL` and the fail-closed isolated inbound runner. Its worker
is `tests/fixtures/inbound/manual-outbound-worker.mjs`.

| Criterion | Concrete local evidence                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C04.1     | Nine DB/API cases: three routes × inbound/transfer/no offer; one call/operation, two concrete participants, three capacity claims, one slot, only actor closure/auto cancellation and correct contact attempt. Full source call/slot/participant/leg and other offer snapshots stay equal.                                                                                                                                                                  |
| C04.2     | Parameterized rollback matrix: suppression, pause, maintenance, endpoint readiness, campaign/manual policy, retry/attempt/contact state, inactive actor, revision/controller, capacity and deferred pre-commit DB failure. Complete product-state snapshots and wake ledger stay equal. Separate real contact-lock contender, completed-contact confirmation and persisted past-deadline fixture. Authentication, CSRF and actor spoofing are also checked. |
| C04.3     | Two OS processes and distinct PG backends. Manual versus own inbound/transfer acceptance: both commit orders and first-writer rollback. Server-observed blocking via `pg_blocking_pids`; stale loser cannot claim/displace or alter source. Other-agent acceptance and source-terminal/transfer closure pass in both orders with bounded graph rediscovery.                                                                                                 |
| C04.4     | Duplicate workers return one call/operation/attempt. API retry after terminal failure and during maintenance returns the original identity; changed fingerprint conflicts. Unseen queued calls stay unexcluded. HTTP -> real C03 executor with a restricted login and simulated driver sends once, persists failure, cancels stale endpoint work without send and retains committed intent on wake failure. Dismissal is never restored.                    |

Reports `c04-*.json` retain PostgreSQL version, complete fixture snapshots,
process/backend IDs, request/operation identities and assertions. The isolated
runner also retains revision, source hashes, storage/isolation and container
cleanup. Fixtures have finite worker lifetimes and remove schemas/roles/containers.
No arbitrary sleeps establish a race or expiry outcome.

Commands and final artifacts are recorded below after verification. tmpfs database
runs prove local SQL/API/executor behavior, not disk crash durability or target
storage performance. No browser/WebRTC, physical SIP/RTP, provider, hosted CI,
full load/soak, deployment/rollback or production acceptance is claimed by C04.
Those are separate gates; inbound routing remains disabled.

## Verified local result — 2026-11-15

All C04.1–C04.4 DB/API criteria passed with the staged execution dependency.
Node.js 23.7.0 (required >=22); PostgreSQL 16.16 and 17.11; simulated ESL only.
Changes are local and uncommitted on the branch above.

- `INBOUND_PG_STORAGE=tmpfs bash /tmp/c04-quality-pg16.sh`: PASS, full
  `npm run quality`, OpenAPI/lint/format/types, 333 API tests with zero skips,
  135 web tests, 76 ops tests and all builds. Nine C04 tests are included.
  Artifacts: `/tmp/outbound-inbound-db.dkM8LcDU/`.
- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: PASS,
  39/39 tests, zero skips, final code on PostgreSQL 17.11.
  Artifacts: `/tmp/outbound-inbound-db.yoHv0Il0/`, including `c04-*.json`.
- Focused ESLint/Prettier, `bash -n scripts/test-inbound-db.sh` and
  `git diff --check`: PASS.

The temporary PG16 wrapper derives from `scripts/test-inbound-db.sh`, changing
only root resolution, the PG image digest to
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`
and the final invocation to `timeout 300 npm run quality`. Both DBs used
`--network none`, no published ports and private test Unix sockets; containers
and test schemas/roles were removed. Docker/test sockets required sandbox
escalation. Artifacts are local temporary evidence, not hosted uploads.

Initial fixture runs failed on an incorrect contact column, incomplete suppression
fixture, invalid test number formatting, unsupported test leg state and a contender
that omitted required graph rediscovery. Those fixture failures were corrected;
no assertion, timeout or application budget was weakened. Final evidence above is
from passing runs. The earlier 38-test PG17 run preceded the final auth-version
race; the reported final run includes all 39 tests.

No voicemail implementation/schema changed; voicemail API/unit regressions passed
in quality. The separate `test:voicemail:db`, browser E2E, FS/SIP/RTP, provider,
full load/soak, target storage, deployment/rollback and hosted-CI runs were not
performed. No commit, push, PR, deployment, provider call or production mutation
occurred. Native runtime activation remains subject to the boundaries above.
