import type pg from "pg";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();
const registers = [metricsRegistry];

function gauge(name: string, help: string) {
  return new Gauge({ name: `outbound_dialer_${name}`, help, registers });
}

function labeledGauge<L extends string>(name: string, help: string, label: L) {
  return new Gauge({ name: `outbound_dialer_${name}`, help, labelNames: [label], registers });
}

const admissionReasons = [
  "lock_timeout",
  "statement_timeout",
  "maintenance",
  "coordination_unavailable",
  "discovery_changed",
  "slot_occupied",
  "revision_conflict",
  "endpoint_unavailable",
  "not_controller",
  "session_revoked",
  "campaign_unavailable",
  "paused",
  "supervisor_session",
  "offer_expired",
  "offer_closed",
  "call_closed",
  "capacity_exceeded",
  "execution_backlog_full",
  "idempotency_conflict",
  "other"
] as const;
const admissionConflicts = new Counter({
  name: "outbound_dialer_admission_conflicts_total",
  help: "Admission rollbacks grouped by bounded operational reason.",
  labelNames: ["reason"] as const,
  registers
});
for (const reason of admissionReasons) admissionConflicts.inc({ reason }, 0);

const admissionLockDuration = new Histogram({
  name: "outbound_dialer_admission_lock_wait_seconds",
  help: "Elapsed time acquiring the global call admission advisory lock, including failed acquisitions.",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers
});
export function recordAdmissionConflict(error: unknown) {
  const reason = error as { code?: string; reason?: string } | null;
  const value =
    reason?.code === "55P03"
      ? "lock_timeout"
      : reason?.code === "57014"
        ? "statement_timeout"
        : reason?.reason;
  admissionConflicts.inc({ reason: admissionReasons.find((entry) => entry === value) ?? "other" });
}
export function recordAdmissionLockWait(seconds: number) {
  admissionLockDuration.observe(seconds);
}

const capacityRejections = new Counter({
  name: "outbound_dialer_capacity_rejections_total",
  help: "Native capacity decisions refusing a new reservation by bounded limit.",
  labelNames: ["limit"] as const,
  registers
});
const capacityLimits = [
  "channels",
  "trunk",
  "forwarding",
  "supervisor",
  "transferOverlap",
  "queue",
  "queue_waiting"
] as const;
for (const limit of capacityLimits) capacityRejections.inc({ limit }, 0);

export function recordCapacityRejection(limit: (typeof capacityLimits)[number]) {
  capacityRejections.inc({ limit });
}

const serviceInvites = new Counter({
  name: "outbound_dialer_service_invite_authorizations_total",
  help: "Service invite authorization outcomes; binding/correlation refusals do not establish a media failure.",
  labelNames: ["outcome"] as const,
  registers
});
export function recordServiceInviteAuthorization(
  outcome: "authorized" | "binding_or_correlation_mismatch" | "dialog_conflict" | "admission_unavailable"
) {
  serviceInvites.inc({ outcome });
}

const executorSources = new Set<() => { running: number; connections: number; waiters: number }>();
export function registerExecutorMetrics(
  source: () => { running: number; connections: number; waiters: number }
) {
  executorSources.add(source);
  return () => {
    executorSources.delete(source);
  };
}

const executorDeferrals = new Counter({
  name: "outbound_dialer_executor_pressure_total",
  help: "Executor work deferred because no local seat, pool connection or replica seat was available.",
  labelNames: ["reason"] as const,
  registers
});
const executorPressureReasons = [
  "executor_saturated",
  "execution_acquisition_timeout",
  "executor_replica_occupied"
] as const;
for (const reason of executorPressureReasons) executorDeferrals.inc({ reason }, 0);

export function recordExecutorPressure(reason: (typeof executorPressureReasons)[number]) {
  executorDeferrals.inc({ reason });
  return { status: "deferred", reason } as const;
}

const executorAcquisition = new Histogram({
  name: "outbound_dialer_executor_pool_acquisition_seconds",
  help: "Time spent acquiring an executor PostgreSQL connection.",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers
});
export function startExecutorAcquisition() {
  return executorAcquisition.startTimer();
}

new Gauge({
  name: "outbound_dialer_executor_local",
  help: "Executor instances, occupied seats, open connections and waiters in the scrape process.",
  labelNames: ["state"] as const,
  registers,
  collect() {
    const totals = { instances: executorSources.size, running: 0, connections: 0, waiters: 0 };
    for (const source of executorSources) {
      const stats = source();
      totals.running += stats.running;
      totals.connections += stats.connections;
      totals.waiters += stats.waiters;
    }
    for (const [state, count] of Object.entries(totals)) this.set({ state }, count);
  }
});

const configurationEnabled = gauge(
  "inbound_configuration_enabled",
  "Whether inbound configuration publishing is configured."
);
const dbFreshnessBudget = gauge(
  "inbound_database_freshness_budget_seconds",
  "Maximum expected interval between successful inbound SQL snapshots."
);
const lastDbSnapshot = gauge(
  "inbound_database_last_success_timestamp_seconds",
  "Unix time of the last successful inbound SQL snapshot."
);
const queue = labeledGauge(
  "inbound_queue_calls",
  "Current admitted inbound queue calls by durable state.",
  "state"
);
const queueOldest = gauge(
  "inbound_queue_oldest_arrival_timestamp_seconds",
  "Original arrival time of the oldest current queued call, or zero."
);
const wait = labeledGauge(
  "inbound_queue_wait_seconds_window",
  "Wait from capture to queue exit for admitted calls exiting in the last 15 minutes.",
  "statistic"
);
const offers = new Gauge({
  name: "outbound_dialer_call_offers",
  help: "Pending offers, or offer closures in the last 15 minutes, by kind and bounded outcome.",
  labelNames: ["kind", "outcome"] as const,
  registers
});
const connections = labeledGauge(
  "inbound_connection_outcomes_window",
  "Settled inbound connection attempts in the last 15 minutes by confirmed outcome.",
  "outcome"
);
const transfers = labeledGauge(
  "call_transfer_outcomes_window",
  "Terminal transfers in the last 15 minutes by durable state.",
  "outcome"
);
const flow = new Gauge({
  name: "outbound_dialer_inbound_flow_outcomes_window",
  help: "Resolved no-answer operations in the last 15 minutes by action and observed outcome.",
  labelNames: ["action", "outcome"] as const,
  registers
});
const autoDeferred = gauge(
  "auto_next_deferred_incoming",
  "Current auto-next intents held for incoming work."
);
const uncertain = labeledGauge(
  "call_uncertain",
  "Current unresolved execution, slot and capacity evidence.",
  "record"
);
const uncertaintyDeadline = gauge(
  "call_uncertainty_oldest_deadline_timestamp_seconds",
  "Oldest deadline of an executing or uncertain command, or zero."
);
const uncertainSlotOldest = gauge(
  "call_uncertain_slot_oldest_timestamp_seconds",
  "Last update time of the oldest uncertain slot, or zero."
);
const pending = labeledGauge(
  "executor_pending_operations",
  "Durable unstarted commands by reserved priority class.",
  "priority"
);
const capacity = labeledGauge(
  "call_capacity_reserved_units",
  "Units charged to the native DB capacity ledger, including uncertain and releasing claims.",
  "resource"
);
const configState = labeledGauge(
  "inbound_configuration_state",
  "Persisted configuration reconciliation state, independent of provider delivery.",
  "state"
);
const revision = labeledGauge(
  "inbound_configuration_revision",
  "Persisted inbound configuration revision; zero if no revision has been applied.",
  "state"
);
const configVerified = gauge(
  "inbound_configuration_last_verified_timestamp_seconds",
  "Last verified local XML revision timestamp, or zero when unverified."
);

export function configureInboundMetrics(enabled: boolean, refreshIntervalSeconds: number) {
  configurationEnabled.set(Number(enabled));
  dbFreshnessBudget.set(2 * refreshIntervalSeconds + 15);
}

export async function readInboundMetrics(client: pg.PoolClient) {
  return (
    await client.query<{ metric: string; label: string; detail: string; value: number | string }>(`
    with active_queue as (
      select state, arrived_at from calls
      where direction='inbound' and ended_at is null and queue_exited_at is null
        and state in ('queued','connecting')
    ), active_operations as (
      select state, deadline_at, case when command_kind in ('hangup','release_agent') then 'critical' else 'normal' end as priority
      from call_operations where resolved_at is null
    ), recent_wait as (
      select extract(epoch from (c.queue_exited_at-c.arrived_at)) as seconds
      from calls c join inbound_queue_admissions a on a.call_id=c.id
      where c.direction='inbound' and c.queue_exited_at>=now()-interval '15 minutes'
    ), recent_offers as (
      select kind, case when reason='manual_outbound_started' then 'manual_outbound_started' else state end as outcome
      from call_offers where closed_at>=now()-interval '15 minutes'
      union all
      select kind,state from call_offers where state='pending'
    ), recent_flow as (
      select o.command_kind, case
        when o.state='canceled' then 'canceled'
        when o.result->>'outcome' in ('completed','failed','interrupted','connected') then o.result->>'outcome'
        when o.state='failed' then 'failed'
        else 'other' end as outcome
      from call_operations o
      where o.resolved_at>=now()-interval '15 minutes' and o.request->>'inboundFallback'='true'
    )
    select 'queue' as metric, state as label, '' as detail, count(*)::double precision as value
      from active_queue group by state
    union all select 'queue_oldest','','',coalesce(extract(epoch from min(arrived_at)),0) from active_queue where state='queued'
    union all select 'wait','samples','',count(*) from recent_wait
    union all select 'wait','p95','',coalesce(percentile_cont(0.95) within group (order by seconds),0) from recent_wait
    union all select 'offer',kind,outcome,count(*) from recent_offers group by kind,outcome
    union all select 'connection',outcome,'',count(*) from inbound_connection_attempts
      where settled_at>=now()-interval '15 minutes' group by outcome
    union all select 'transfer',state,'',count(*) from call_transfers
      where closed_at>=now()-interval '15 minutes' group by state
    union all select 'flow',command_kind,outcome,count(*) from recent_flow group by command_kind,outcome
    union all select 'auto','','',count(*) from agent_auto_next_intents
      where closed_at is null and state='deferred' and reason='incoming_pending'
    union all select 'uncertain','operation','',count(*) from active_operations where state in ('executing','uncertain')
    union all select 'uncertain','slot','',count(*) from agent_call_slots where state='uncertain'
    union all select 'uncertain_slot_oldest','','',coalesce(extract(epoch from min(updated_at)),0)
      from agent_call_slots where state='uncertain'
    union all select 'uncertain','capacity','',count(*) from call_capacity_reservations where state<>'released' and state='uncertain'
    union all select 'uncertainty_deadline','','',coalesce(extract(epoch from min(deadline_at)),0)
      from active_operations where state in ('executing','uncertain')
    union all select 'pending',priority,'',count(*) from active_operations where state='pending' group by priority
    union all select 'capacity',resource_type,'',sum(units) from call_capacity_reservations
      where state<>'released' group by resource_type
    union all select 'config',case when apply_error is not null and error_revision=desired_revision then 'failed'
      when applied_revision=desired_revision and verified_at is not null then 'verified' else 'pending' end,'',1
      from inbound_freeswitch_configuration where singleton
    union all select 'revision','desired','',desired_revision from inbound_freeswitch_configuration where singleton
    union all select 'revision','applied','',coalesce(applied_revision,0) from inbound_freeswitch_configuration where singleton
    union all select 'verified_at','','',coalesce(extract(epoch from verified_at),0)
      from inbound_freeswitch_configuration where singleton
  `)
  ).rows;
}

export function publishInboundMetrics(rows: Awaited<ReturnType<typeof readInboundMetrics>>) {
  const values = new Map(
    rows.map(({ metric, label, detail, value }) => [JSON.stringify([metric, label, detail]), Number(value)])
  );
  const value = (metric: string, label = "", detail = "") =>
    values.get(JSON.stringify([metric, label, detail])) ?? 0;

  for (const state of ["queued", "connecting"]) queue.set({ state }, value("queue", state));
  queueOldest.set(value("queue_oldest"));
  for (const statistic of ["p95", "samples"]) wait.set({ statistic }, value("wait", statistic));
  for (const kind of ["inbound", "transfer"])
    for (const outcome of [
      "pending",
      "accepted",
      "ignored",
      "expired",
      "declined",
      "canceled",
      "failed",
      "manual_outbound_started"
    ])
      offers.set({ kind, outcome }, value("offer", kind, outcome));
  for (const outcome of ["connected", "requeued", "fallback", "ended"])
    connections.set({ outcome }, value("connection", outcome));
  for (const outcome of ["completed", "declined", "expired", "canceled", "failed"])
    transfers.set({ outcome }, value("transfer", outcome));
  for (const action of ["play_audio", "hangup", "forward_external"])
    for (const outcome of ["completed", "failed", "interrupted", "connected", "canceled", "other"])
      flow.set({ action, outcome }, value("flow", action, outcome));
  autoDeferred.set(value("auto"));
  for (const record of ["operation", "slot", "capacity"])
    uncertain.set({ record }, value("uncertain", record));
  uncertaintyDeadline.set(value("uncertainty_deadline"));
  uncertainSlotOldest.set(value("uncertain_slot_oldest"));
  for (const priority of ["normal", "critical"]) pending.set({ priority }, value("pending", priority));
  for (const resource of [
    "queue_waiting",
    "customer_channel",
    "browser_channel",
    "supervisor_channel",
    "transfer_overlap",
    "trunk_call",
    "external_forward"
  ])
    capacity.set({ resource }, value("capacity", resource));
  for (const state of ["pending", "verified", "failed"]) configState.set({ state }, value("config", state));
  for (const state of ["desired", "applied"]) revision.set({ state }, value("revision", state));
  configVerified.set(value("verified_at"));
  lastDbSnapshot.set(Date.now() / 1000);
}
