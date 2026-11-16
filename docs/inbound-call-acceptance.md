# E02 — Inbound acceptance and connection

Task: [E02 #26](https://github.com/sptmru/outbound-freeswitch-dialer/issues/26).
Base `eb0fb50fa53e607bd3e5daedef943b0166754043`, branch
`feat/e02-inbound-acceptance`. Changes are local and uncommitted.

## Transaction and HTTP contract

`POST /agent/call-offers/:offerId/accept` accepts the existing strict
`DeskMutationRequest`: `deskSessionId`, `expectedRevision`, `bindingGeneration`,
`idempotencyKey`. Authentication derives the actor; cookie mutations use existing
Origin/CSRF protection. Responses have `Cache-Control: no-store`.

Acceptance requires an explicitly supplied native `wakeExecutor` dependency.
The default `server.ts` does not install one: an authenticated request fails with
`409 coordination_unavailable` before mutation. I05 owns bootstrap and enablement.
E03/E04 own browser controls, service INVITE correlation/answering and browser media.

Under the common admission lock graph, acceptance rechecks the active actor/auth
version, controlling Desk/revision, fresh D01-verified contact, campaign/readiness,
free reconciled slot, offer/queue deadlines and phase, permanent exclusion, prior
connection attempts and the completed D04 waiting operation. A new attempt needs
at least the fixed 10000 ms connection budget within the original queue deadline.

One transaction creates the winning participant, fenced slot, concrete leg UUID,
C03 command/Job-UUID identities, browser capacity and acceptance replay identity;
it expires already-due competitors and closes other competing pending inbound offers as `canceled/winner_accepted`
and cancels the winner's open automatic intent. No contact attempt is touched.
The admitted customer/queue/trunk claims remain retained through connection.
Capacity/backlog rejection rolls the entire claim back. Bounded database lock or
statement contention returns `409 coordination_unavailable`, requiring a refetch;
SQL budgets are not extended for a burst of competing accepts.

The committed response is always
`{status: "connecting", revision, callId, operationId, offerId}`. Exact actor/key
replay returns that original response, including after terminal cleanup or Desk
replacement. A changed fingerprint conflicts. A new key for the same accepted
offer with the same original Desk snapshot returns the existing operation. Neither
path creates another participant or originate. A replay is not send authority.

## Native connection and evidence

`inboundConnectionExecutor(pool, executor, esl)` is an explicit staged dependency.
`wakeExecutor(rootId)` and the bounded `reconcile()` entry point use C03's existing
separate executor pool, per-call execution lock, fixed single-send jobs and total
transport deadlines. `reconcile()` selects at most eight unresolved connection
attempts. It starts no daemon and creates no pool/role. The runtime owner must
schedule it, stop scheduling before closing pools and retain H01/I05's distributed
restart/epoch and activation gates.

The fixed chain is:

1. `originate` the exact full `sofia/internal-webrtc/...` contact validated by D01's
   `verifiedDeskContact`, with the fixed agent UUID, a four-second endpoint timeout
   and `&park()`. SIP headers include `X-Outbound-Dialer-Call-ID`,
   `X-Outbound-Dialer-Operation-ID`, `X-Outbound-Dialer-Desk-Session-ID` and
   `X-Outbound-Dialer-Binding-Generation`. E04 must consume these in the browser.
2. Only after the fixed originate job and actual answered leg, run the dependent
   `uuid_bridge <customer UUID> <agent UUID>`. Waiting audio stops at this native
   bridge boundary. A command ACK or agent answer cannot set `agent_connected_at`.
3. D04's trusted ESL adapter requires the exact peer UUID, accepted offer, current
   participant/slot reservation/generation and attempted bridge operation. Only that
   event sets `agent_connected`, participation connection time and the slot `active`.
   Duplicate/early/late events cannot invent a connection or revive terminal state.
4. After confirmed bridge, the dependent `sched_del <customer UUID>` cancels the
   original queue hangup guard. A failed guard cancellation retains conservative
   native timing; it never triggers a second originate. The queue permit is released
   after connection work resolves. The customer/trunk and browser claims remain
   until their own terminal cleanup.

Fixed BACKGROUND_JOB evidence is retained by both the command socket and the
independent ESL observer. Reconciliation never resends uncertain work. Only after
a completed fixed job can a trusted `uuid_exists=false` observation prove that
that single-frame sender's concrete agent leg is absent. A missing job, an early
absence observation, an expired deadline or HTTP loss cannot release claims.
A customer hangup after originate finishes closes the connection attempt and
requires cleanup of any late/live agent leg, even though terminal call history
correctly refused its late answer update.

Command syntax: [FreeSWITCH CLI/API reference](https://developer.signalwire.com/freeswitch/reference/cli-and-api/).
The pinned local FS run, rather than reference prose, establishes the exercised behavior.

## Failure, requeue and retention

Failure cancels only never-started descendants. Uncertain/sent jobs keep the slot
and capacity occupied until fixed job and concrete effect evidence resolve. A live
agent leg gets a fixed C03 `uuid_kill` cleanup job, with the critical partition;
no requeue precedes exact cleanup. Cleanup of old generations cannot free a newer
reservation. A concurrent duplicate wake does not mark a healthy connecting slot
uncertain merely because its sender is running.

After safe cleanup, the matching slot release updates the agent status through
the existing pause-preserving `finishAgentCall`; it cannot alter a newer occupied
reservation. At most two retries follow the initial attempt. Backoff is
500 ms then 1000 ms (exponential, capped at 2000 ms), and retry is allowed only when
`now + backoff + 10000 <= original queue_deadline_at`. Dispatch suppresses offers
until the persisted backoff expires. The original arrival/deadline and admitted
queue permit remain unchanged; requeue does not allocate another permit even if
limits were lowered. Ignore/expiry exclusions survive. Exhaustion or insufficient
original budget transitions to `fallback`; F03 owns its execution. The existing
native queue guard still bounds waiting if a coordinator is unavailable.

Migration `038_inbound_acceptance.sql` adds `inbound_connection_attempts` and
`call_offer_accept_mutations`, immutable identity/settlement and drained-retention
guards. It leaves old data/checksums, feature flags and reconciliation markers
unchanged. H04 must delete drained replay rows before attempts, then their
operations/participants/offers during eventual retention. No rollback reverses
this forward-only migration.

## Validation

```bash
# All DB suites; explicit disposable memory-backed PostgreSQL, no application DB.
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
# Focus only E02 during development; unrelated files have no selected tests.
INBOUND_TEST_PATTERN=E02 INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
# Real isolated product entrypoint, journal, C03, API, native SIP and decoded RTP.
npm run test:acceptance:freeswitch
npm run test:queue:freeswitch
npm run quality
git diff --check
```

| Criterion | Evidence supplied by focused suites                                                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E02.1     | Twenty independent processes/backends, observed `pg_blocking_pids`, one winning participant/slot/originate intent, unchanged losing claims; real FS fixed UUID/job/INVITE and replay assertions.                                    |
| E02.2     | Both lock/commit orders and leading rollback against fallback, customer hangup, another call and the real manual outbound producer; real customer hangup during connect with controlled late agent answer and cleanup before reuse. |
| E02.3     | Authenticated API returns `connecting` before send; strict owner/session/payload checks, early/duplicate bridge events; native bridge clock, real held bytes/lost ACK and request replay with one physical originate.               |
| E02.4     | Fake-time retry boundary decisions, persisted cooldown, uncertainty, exclusions and retained queue capacity; actual repeated SIP failures, late answer, fixed cleanup, three-attempt bound and unchanged arrival/deadline.          |

Additional DB tests cover complete rollback on capacity/backlog refusal and a
populated 037→038 upgrade, unchanged settings/history/checksums, immutable
identities and terminal replay. Ordinary quality without `TEST_DATABASE_URL`
skips DB suites; the isolated result must be reported separately.

The FS runner uses digest-pinned FreeSWITCH 1.10.12 and PostgreSQL 17, network
`none`, no published ports, no `.env` and disposable fixtures. Artifacts under
`/tmp/outbound-e02.*` retain source hashes, isolation/image identity, native
commands/events, SQL snapshots, decoded tone measurements and cleanup records.
Both RTP directions use controlled UDP/PCMU clients, not browser WebRTC. The
connected call is kept past its original queue deadline to verify guard removal.
The DB test-process limit is 300 s (360 s outer isolated runner), expanded from
180/240 s to accommodate the additional migration/race matrix. Application
lock, statement, command and retry budgets are unchanged.

Provider trust/DID/billing/far-end acceptance, browser service INVITEs/WebRTC,
production disk performance/crash durability, target load/soak, hosted CI,
deployment/drain/restore/rollback and I01–I05 remain separate. Local tmpfs evidence
is not target storage or production acceptance. Final command results and artifact
paths belong in the issue handoff and the verified-result appendix below.

## Verified local result — 2026-11-16

- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: **125/125**, no skips,
  including eight E02 groups; `/tmp/outbound-inbound-db.NJynOcZc/`.
- `npm run test:acceptance:freeswitch`: **7/7** native groups;
  `/tmp/outbound-e02.o3DZnTlN/`. Both decoded directions contain 2400 samples:
  660 Hz agent→customer and 880 Hz customer→agent. Final occupied slots, capacity,
  unresolved operations and actual channels are zero. Report SHA-256:
  `a1635191683d7823feddbfbe5e9265ea6da7313a84acdb8a8485ce09b7ccc7c2`.
- `npm run test:queue:freeswitch`: **9/9**; `/tmp/outbound-d04.CZIhgPxs/`.
- `npm run test:voicemail:db`: **8/8**, no skips, isolated PostgreSQL 16;
  `/tmp/e02-voicemail.log`.
- `npm run quality`: **passed**, API 302 passed / 124 DB skips without
  `TEST_DATABASE_URL`, web 152/152, ops 78/78, OpenAPI/static checks/builds;
  `/tmp/e02-quality-complete.log`. The complete isolated DB result above is separate.
- Runtime/DB source hashes match the final source; TypeScript, ESLint, formatting,
  shell syntax and `git diff --check` passed. Disposable containers were removed.

Earlier failed fixture/timing/cleanup diagnostics remain at their original local
artifact paths. An initial full DB process reached its 180 s harness limit after
120 passing tests; the final full run completed in 197.339 s under the expanded
harness cap with unchanged application budgets. No failed run is counted as a pass.
All changes remain local/uncommitted. The browser/provider/production and staged
activation boundaries above remain open in their owning tasks.
