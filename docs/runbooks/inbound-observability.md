# Inbound Observability and Recovery

[H05 #42](https://github.com/sptmru/outbound-freeswitch-dialer/issues/42) adds
operator signals to the existing private API `/metrics`, Prometheus rules and
Grafana overview. Use the [deployment runbook](deployment.md) for authorized
changes and [H01 recovery](../inbound-lifecycle-recovery.md) for the evidence
required to reconcile a call.

## Read the signals

- `outbound_dialer_inbound_configuration_enabled` and
  `outbound_dialer_ingress_configured` report configured switches.
  `outbound_dialer_inbound_configuration_revision{state="desired"}` is the
  saved revision. The applied revision plus a fresh
  `outbound_dialer_inbound_configuration_last_verified_timestamp_seconds`
  records verified local XML. Verify delivery, caller ID and audio at the
  endpoints when performing I02 or I04. A saved route, import, offer
  acceptance, successful command reply or SIP authorization is an earlier
  lifecycle stage than an established conversation.
- `outbound_dialer_inbound_queue_calls` counts the queued and connecting states.
  Queue wait is measured from original capture through recorded queue exit
  for admitted calls. Read the 15-minute p95 alongside the sample count.
  `outbound_dialer_call_offers` reports current pending offers and 15-minute
  closures. `manual_outbound_started` identifies dismissals and transfer
  declines committed with manual dialing. `expired` differs from Ignore,
  and neither measure counts customer abandonment. The deferred auto-next
  gauge is a current count of intents waiting on incoming work.
- Inbound connection outcomes use settled attempts with confirmed bridge or
  cleanup evidence. Transfer outcomes come from terminal transfer rows. No-answer action
  outcomes come from resolved playback, hangup and forwarding operations.
  A flow that ran more than one action can contribute multiple operation
  outcomes. Use Call History and the call's original queue exit alongside
  these counts when diagnosing an individual journey.
- Read the admission lock histogram and conflict counter alongside the
  capacity-rejection counter and capacity ledger. The lock histogram times
  acquisition of the common advisory lock, including failed attempts. A
  service INVITE refusal can indicate stale Desk, actor, slot or leg
  correlation, or a conflicting dialog. Use the authenticated Desk and live
  FreeSWITCH leg/bridge evidence to establish whether media connected.
- SQL-backed readings are cached. Confirm
  `outbound_dialer:inbound_database_fresh == 1` before using them for recovery.
  Each SQL, trunk and switch collector can refresh independently, with one
  outstanding run per collector. SQL freshness uses
  `2 * METRICS_REFRESH_INTERVAL_SECONDS + 15` seconds. The default
  `METRICS_REFRESH_INTERVAL_SECONDS` is 15 seconds (supported range 3–300).
  The API scrape reads cached values and in-process pool gauges. It performs
  no SQL, journal or ESL I/O.
- Outcome and backlog counts sourced from PostgreSQL are shared across API
  replicas. Inspect a single fresh scrape target or deduplicate before
  aggregation. Executor seats and pool counters are local to a process.
  An API process with zero local executor instances reports no local
  executor. A separate staged worker needs its own scrape endpoint to
  expose its process metrics.

Prometheus labels use fixed enums and HTTP route templates. Use the restricted
application logs and database to correlate a call, operation or fixed job UUID.
New ESL persistence and service INVITE refusal diagnostics allowlist their
fields. Collect timestamps, structured event names and correlation IDs. Keep
phone numbers, raw SIP, dialog IDs, authorization headers and command/error
payloads out of shared incident artifacts.

## Configuration and limits

Use the existing `.env` and Compose settings in
[environment configuration](../environment-configuration.md),
[versioned FreeSWITCH configuration](../inbound-freeswitch-configuration.md)
and [durable ingress](../inbound-durable-ingress.md). H05 introduces no
environment variables. The baseline stays feature-off unless enabled through
the authorized I05 procedure.

- `FREESWITCH_INBOUND_CONFIG_ENABLED` and `FREESWITCH_INGRESS_ENABLED`
  default to `false`. Publishing/import also require
  `FREESWITCH_ESL_ENABLED`. `FREESWITCH_INGRESS_SOCKET` defaults to
  `/var/lib/outbound-dialer/ingress/agent.sock`. The journal independently
  publishes status over that private socket; the API polls every five seconds.
  A 20-second age or failed poll marks the journal observation unhealthy.
- `FREESWITCH_INGRESS_JOURNAL_SLOTS` defaults to 128 and supports 1–128.
  Capture has a 750 ms journal deadline. The generated dialplan sets the
  pre-admission guard using `FREESWITCH_INBOUND_WAIT_SECONDS`
  (1–3 seconds, default 3). Measure end-to-end refusal timing in the relevant
  local or provider scenario. The pre-admission guard defaults to 8 channels.
  A full/unavailable journal refuses new captures. The same occupied slots
  retain live and unacknowledged evidence.
- Compare the stored `calls.capacity_limits` with the applied FreeSWITCH
  safeguards. Current DB defaults are 40 queue permits, 72 total charged
  channels, 32 trunk units, 4 forwarding, 4 supervisor and 4 transfer-overlap
  units. The corresponding FS policy defaults are 80 channels, 40 trunk
  channels and 8 pre-admission places. Per-queue limits also apply. A lower
  configured limit restricts new reservations and preserves existing ones.
- The executor reserves three ordinary seats and one critical seat per
  replica, with two fixed replica indices and an eight-connection database
  role ceiling. Its separate pool acquisition budget is 250 ms; the pending
  caps are 48 ordinary and 16 critical. The common admission lock budget is
  250 ms. See [C03](../inbound-command-execution.md) and
  [A06](../inbound-resource-budgets.md) for protected lanes and load gates.

## Diagnose and recover

| Signal                                                                                  | What to inspect and preserve                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IngressJournalUnavailable`, `IngressJournalFull`, `IngressCaptureFailures`             | Check the journal agent, Unix socket, shared mount, disk headroom and ESL access. Preserve the SQLite spool before attempting recovery. Compare used space with actual capacity. A pre-capture refusal can leave no call row.                                                                                                                                                                                                                                                                             |
| `IngressImportFailures`, `IngressImportStale`, `IngressImportLag`                       | A healthy status poll can coexist with a failed or stuck import. Compare pending updates, original capture and exact journal/SQL sequences. The lag gauge uses the timestamp of the unacknowledged capture or terminal update. During a mixed-version rollout, an older agent reports only arrival time, which may overstate terminal-update lag. Verify DB and ESL availability. Resume replay against the existing spool; SQL commit precedes exact journal ACK. Preserve arrivals/deadlines on replay. |
| `InboundCallUncertaintyStuck`                                                           | Check operations more than 60 seconds past deadline, or slots unchanged in uncertainty for more than 60 seconds. Match the SQL operation, fixed Job-UUID, exact legs/reservation and switch incarnation. Use the producer receipt and exact effect/terminal evidence from H01. A deadline, a new lock owner or a missing channel alone leaves a potentially sent command unresolved. Preserve claims until exact cleanup.                                                                                 |
| `InboundConfigurationApplyFailed`, `InboundConfigurationVerificationStale`              | Compare desired, applied and verified revisions. Inspect the restricted `inbound_freeswitch_configuration.apply_error` diagnostic and live XML marker. Check the publisher, generated-directory writer, ESL and last-good rollback. Repeat verification before declaring the revision applied.                                                                                                                                                                                                            |
| `CallExecutorPressure`, `ApplicationDatabasePoolWaiters`, `InboundMetricsDatabaseStale` | Check executor-local seats, admission lock wait, connection acquisition, DB waiters and durable pending operations. Investigate slow ESL and unavailable dependencies. Preserve the critical seats for cleanup and let the existing admission guards reject excess starts. Keep old worker and sender evidence before restart.                                                                                                                                                                            |

Drain under authorized I05 scope. Stop new ingress and transfers through the
verified route/admission controls and keep API, ESL, journal and recovery paths
available for existing work. Confirm exact terminal state and zero unresolved
operations, occupied slots, unreleased capacity and pending journal ACKs before
a rollback that requires a completed drain. Stop if uncertainty or pending
evidence remains. Preserve the journal, command receipts and forward-only
database history. See [H04 retention and restore](../inbound-retention.md).

## Scenario walk-through

1. H01 journal suspension, full journal and PostgreSQL outage. Confirm the
   switch refuses uncaptured ingress before media. Distinguish a missing
   journal observation from a fresh observation with pending updates and
   a stale importer. Recover the same receipt across API restart, verify
   exactly one SQL history row and original deadline, then compare exact
   ACK sequences.
2. H01 lost sender reply and transfer/playback restart. Inspect the fixed
   command and current switch incarnation. Follow persisted producer and
   exact-leg evidence through recovery. Wait for exact terminal cleanup
   before reusing capacity. Record resolved work, retained holds and the
   reason for any remaining hold.
3. D02 forced reload/verification failure and I02 acceptance checks. Compare
   saved revision, live XML marker and last-good route. A corrected revision
   needs a fresh marker plus a separate call. For the I02 call, correlate the
   controlling Desk binding with accepted operation, concrete agent leg and
   confirmed bridge, then verify audio at both endpoints and terminal cleanup.
   The H01/E02 runs exercise selected cases on pinned local FreeSWITCH.
   Record completion of the full matrix in [I02 #44](https://github.com/sptmru/outbound-freeswitch-dialer/issues/44).

Use [production acceptance](../acceptance-checklist.md) to record provider
delivery, actual alert delivery to a named receiver, target deployment and
rollback.

## Verification status

| Scope                | Evidence                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented locally  | Private scrape, bounded labels, safe diagnostics, Prometheus rules and Grafana source panels. Migration `047_inbound_metrics_indexes.sql` adds indexes for active work and recent outcomes.                                                                                                                             |
| Local checks         | `INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='H05\|H01' npm run test:inbound:db:isolated` passed against PostgreSQL 17. The local H01 recovery, D02 configuration and E04 browser/FreeSWITCH commands exercised replay, last-good routing, and confirmed local media with the pinned FreeSWITCH image.                |
| Prometheus           | Rules and generated configuration validated with the Compose-pinned Prometheus image. `tests/fixtures/h05-prometheus.test.yml` exercises fresh and stale samples, terminal update lag, feature-off, failed apply, uncertainty and pool pressure. The generated Alertmanager configuration passed `amtool check-config`. |
| Remaining acceptance | The full I02 matrix, I03 load and soak, I04 provider and far-end acceptance, I05 deployment/drain/rollback and delivery to the target alert receiver each have their own evidence requirement.                                                                                                                          |

Reproduce the rule tests from the repository root:

```bash
docker run --rm --network none \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" --workdir /repo \
  --entrypoint /bin/promtool prom/prometheus:v3.12.0 \
  test rules tests/fixtures/h05-prometheus.test.yml
```
