import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type pg from "pg";
import { callOutcomes } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { canOriginateCustomerLeg, sendFreeSwitchApiCommand } from "./esl.js";
import { setFreeSwitchEventListenerSubscribed } from "./esl-listener-state.js";

const registry = new Registry();
const requestStartedAt = new WeakMap<FastifyRequest, bigint>();

collectDefaultMetrics({
  prefix: "outbound_dialer_process_",
  register: registry
});

const httpRequests = new Counter({
  name: "outbound_dialer_http_requests_total",
  help: "HTTP requests handled by the API.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [registry]
});

const httpRequestDuration = new Histogram({
  name: "outbound_dialer_http_request_duration_seconds",
  help: "API HTTP request duration in seconds.",
  labelNames: ["method", "route"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

const databaseSnapshotUp = new Gauge({
  name: "outbound_dialer_database_metrics_up",
  help: "Whether the most recent application metrics query against PostgreSQL succeeded.",
  registers: [registry]
});
const databasePoolConnections = new Gauge({
  name: "outbound_dialer_database_pool_connections",
  help: "PostgreSQL application-pool connections by state.",
  labelNames: ["state"] as const,
  registers: [registry]
});
const databasePoolWaitingRequests = new Gauge({
  name: "outbound_dialer_database_pool_waiting_requests",
  help: "Requests waiting for a PostgreSQL application-pool connection.",
  registers: [registry]
});
const metricsSnapshotLastRefresh = gauge(
  "outbound_dialer_metrics_snapshot_last_refresh_timestamp_seconds",
  "Unix timestamp of the most recent successful background metrics snapshot refresh."
);
const metricsSnapshotRefreshFailures = new Counter({
  name: "outbound_dialer_metrics_snapshot_refresh_failures_total",
  help: "Unexpected failures while refreshing the background metrics snapshot.",
  registers: [registry]
});

const mediaCoverageValues = ["eligible", "complete", "partial", "missing"] as const;
const mediaLegTypes = ["agent", "customer"] as const;
const mediaDirections = ["inbound", "outbound"] as const;
const mediaPacketKinds = ["all", "media"] as const;
const codecDirections = ["read", "write"] as const;
const codecValues = ["PCMU", "PCMA", "G729", "OPUS", "G722", "L16", "OTHER", "UNKNOWN"] as const;
const terminalStatistics = ["average", "p50", "p95", "max"] as const;
const terminalCoverageValues = ["measured", "unmeasured"] as const;
const terminalSourceValues = [
  "freeswitch_customer_terminal",
  "active_call_reconciliation",
  "background_job",
  "api",
  "voicemail_custom",
  "unknown"
] as const;
type MediaStatistic = "average" | "p10" | "p95";

const activeCalls = gauge(
  "outbound_dialer_active_calls",
  "Current non-terminal calls excluding voicemail playback continuing after agent release."
);
const activeSupervisorSessions = gauge(
  "outbound_dialer_active_supervisor_sessions",
  "Current administrator live-call monitoring sessions, kept separate from product calls."
);
const stuckCalls = gauge(
  "outbound_dialer_stuck_calls",
  "Current non-terminal calls older than the configured threshold."
);
const registeredAgents = gauge(
  "outbound_dialer_registered_agents",
  "Agents currently registered with FreeSWITCH."
);
const freeSwitchActiveChannels = gauge(
  "outbound_dialer_freeswitch_active_channels",
  "Current channels reported by FreeSWITCH."
);
const freeSwitchRegistrations = gauge(
  "outbound_dialer_freeswitch_registrations",
  "Current registrations reported by FreeSWITCH."
);
const totalAgents = gauge("outbound_dialer_agents", "Agents currently stored in PostgreSQL.");
const callsAttemptedWindow = gauge(
  "outbound_dialer_calls_attempted_window",
  "Calls created during the monitoring window."
);
const callsAnsweredWindow = gauge(
  "outbound_dialer_calls_answered_window",
  "Calls answered during the monitoring window."
);
const callsFailedWindow = gauge(
  "outbound_dialer_calls_failed_window",
  "Calls failed during the monitoring window."
);
const recordingFailuresWindow = gauge(
  "outbound_dialer_recording_failures_window",
  "Call recording failures during the monitoring window."
);
const recordingFinalizationBacklog = gauge(
  "outbound_dialer_recording_finalization_backlog",
  "Terminal calls whose enabled recording is still pending, recording, or finalizing."
);
const activeVoicemailJobs = gauge(
  "outbound_dialer_voicemail_jobs_active",
  "Voicemail drops currently requested, playing, or continuing after the agent was released."
);
const stuckVoicemailJobs = gauge(
  "outbound_dialer_voicemail_jobs_stuck",
  "Active voicemail drops older than the configured stuck-call threshold."
);
const callOutcomesWindow = new Gauge({
  name: "outbound_dialer_call_outcomes_window",
  help: "Terminal call outcomes during the last 24 hours.",
  labelNames: ["outcome"] as const,
  registers: [registry]
});
const mediaQualityCallsWindow = labeledGauge(
  "outbound_dialer_media_quality_calls_window",
  "Answered calls eligible for media quality analysis during the last 15 minutes, grouped by coverage.",
  ["coverage"]
);
const mediaOneWaySuspectedCallsWindow = labeledGauge(
  "outbound_dialer_media_one_way_suspected_calls_window",
  "Answered calls with strongly asymmetric RTP packet flow during the last 15 minutes.",
  ["leg_type"]
);
const mediaPacketsWindow = labeledGauge(
  "outbound_dialer_media_packets_window",
  "RTP packet totals captured from completed call legs during the last 15 minutes.",
  ["leg_type", "direction", "kind"]
);
const mediaJitterLossRateWindow = labeledGauge(
  "outbound_dialer_media_inbound_jitter_loss_rate_window",
  "FreeSWITCH-reported inbound jitter loss rate during the last 15 minutes.",
  ["leg_type", "statistic"]
);
const mediaJitterMaxVarianceWindow = labeledGauge(
  "outbound_dialer_media_inbound_jitter_max_variance_window",
  "FreeSWITCH-reported inbound jitter maximum variance during the last 15 minutes.",
  ["leg_type", "statistic"]
);
const mediaMosWindow = labeledGauge(
  "outbound_dialer_media_mos_window",
  "FreeSWITCH-reported inbound MOS during the last 15 minutes.",
  ["leg_type", "statistic"]
);
const mediaQualityPercentageWindow = labeledGauge(
  "outbound_dialer_media_quality_percentage_window",
  "FreeSWITCH-reported inbound quality percentage during the last 15 minutes.",
  ["leg_type", "statistic"]
);
const mediaCodecsWindow = labeledGauge(
  "outbound_dialer_media_codecs_window",
  "Completed call legs by normalized negotiated codec during the last 15 minutes.",
  ["leg_type", "direction", "codec"]
);
const terminalFinalizationSamplesWindow = gauge(
  "outbound_dialer_terminal_finalization_samples_window",
  "Customer terminal events with measured persistence latency during the last 15 minutes."
);
const terminalFinalizationDurationMilliseconds = labeledGauge(
  "outbound_dialer_terminal_finalization_duration_milliseconds",
  "Hangup-to-durable-terminal latency statistics during the last 15 minutes.",
  ["statistic"]
);
const terminalFinalizationCoverageWindow = labeledGauge(
  "outbound_dialer_terminal_finalization_coverage_window",
  "FreeSWITCH customer terminal calls grouped by finalization latency coverage during the last 15 minutes.",
  ["status"]
);
const terminalCallsWindow = labeledGauge(
  "outbound_dialer_terminal_calls_window",
  "Terminal calls during the last 15 minutes grouped by bounded terminal source.",
  ["source"]
);
const registrationReconciliationUp = gauge(
  "outbound_dialer_registration_reconciliation_up",
  "Whether the latest agent registration reconciliation succeeded."
);
const registrationReconciliationLastRun = gauge(
  "outbound_dialer_registration_reconciliation_last_run_timestamp_seconds",
  "Unix timestamp of the latest successful agent registration reconciliation."
);
const registrationReconciledAgents = labeledGauge(
  "outbound_dialer_registration_reconciled_agents",
  "Agent registrations observed in the synchronized reconciliation snapshot.",
  ["source"]
);
const registrationDriftAgents = gauge(
  "outbound_dialer_registration_drift_agents",
  "Symmetric difference between PostgreSQL and FreeSWITCH registration identities before correction."
);
const registrationCorrectionsLastRun = gauge(
  "outbound_dialer_registration_corrections_last_run",
  "Agent rows corrected by the latest registration reconciliation."
);
const activeCallReconciliationUp = gauge(
  "outbound_dialer_active_call_reconciliation_up",
  "Whether the latest active-call reconciliation completed without errors."
);
const activeCallReconciliationLastRun = gauge(
  "outbound_dialer_active_call_reconciliation_last_run_timestamp_seconds",
  "Unix timestamp of the latest active-call reconciliation attempt."
);
const activeCallReconciliationDatabaseCalls = gauge(
  "outbound_dialer_active_call_reconciliation_database_calls",
  "Database active calls checked by the latest FreeSWITCH reconciliation."
);
const activeCallsMissingInFreeSwitch = gauge(
  "outbound_dialer_active_calls_missing_in_freeswitch",
  "Mature database active calls whose customer channel was missing in FreeSWITCH during reconciliation."
);
const activeCallsClosedLastRun = gauge(
  "outbound_dialer_active_calls_closed_last_run",
  "Database active calls closed by the latest FreeSWITCH reconciliation."
);
const pcapCaptureEnabled = gauge(
  "outbound_dialer_pcap_capture_enabled",
  "Whether automatic per-call PCAP capture is enabled."
);
const pcapCapturesActive = gauge(
  "outbound_dialer_pcap_captures_active",
  "Per-call PCAP captures currently running."
);
const pcapCaptureFailuresWindow = gauge(
  "outbound_dialer_pcap_capture_failures_window",
  "Per-call PCAP captures that failed during the monitoring window."
);
const pcapStorageBytes = gauge(
  "outbound_dialer_pcap_storage_bytes",
  "Bytes occupied by available per-call PCAP files."
);
const voicemailDropsWindow = gauge(
  "outbound_dialer_voicemail_drops_window",
  "Voicemail drops with confirmed playback completion during the monitoring window."
);
const retentionEnabled = gauge(
  "outbound_dialer_retention_enabled",
  "Whether automatic call and recording retention is enabled."
);
const retentionLastSuccess = gauge(
  "outbound_dialer_retention_last_success_timestamp_seconds",
  "Unix timestamp of the most recent successful retention run."
);
const retentionFailures = new Counter({
  name: "outbound_dialer_retention_failures_total",
  help: "Automatic retention runs that failed.",
  registers: [registry]
});
const retentionDeletedCalls = new Counter({
  name: "outbound_dialer_retention_deleted_calls_total",
  help: "Call rows deleted by automatic retention.",
  registers: [registry]
});
const retentionDeletedRecordings = new Counter({
  name: "outbound_dialer_retention_deleted_recordings_total",
  help: "Call recording files deleted or confirmed absent by automatic retention.",
  registers: [registry]
});
const retentionDeletedPcaps = new Counter({
  name: "outbound_dialer_retention_deleted_pcaps_total",
  help: "Per-call PCAP files deleted or confirmed absent by automatic retention.",
  registers: [registry]
});

const eslListenerConnected = gauge(
  "outbound_dialer_esl_listener_connected",
  "Whether the long-lived FreeSWITCH ESL event listener is subscribed."
);
const eslListenerEnabled = gauge(
  "outbound_dialer_esl_listener_enabled",
  "Whether the FreeSWITCH ESL event listener is enabled by configuration."
);
const eslReconnects = new Counter({
  name: "outbound_dialer_esl_reconnects_total",
  help: "FreeSWITCH ESL listener disconnects that scheduled a reconnect.",
  registers: [registry]
});
const eslEvents = new Counter({
  name: "outbound_dialer_esl_events_processed_total",
  help: "FreeSWITCH ESL events successfully processed by event name.",
  labelNames: ["event_name"] as const,
  registers: [registry]
});
const eslEventErrors = new Counter({
  name: "outbound_dialer_esl_event_errors_total",
  help: "FreeSWITCH ESL events that failed during persistence.",
  registers: [registry]
});
const eslPersistenceQueueDepth = gauge(
  "outbound_dialer_esl_persistence_queue_depth",
  "FreeSWITCH ESL events currently waiting for ordered persistence, including the event being processed."
);
const eslPersistenceQueueCapacity = gauge(
  "outbound_dialer_esl_persistence_queue_capacity",
  "Configured maximum number of FreeSWITCH ESL events retained for ordered persistence."
);
const eslPersistenceRetries = new Counter({
  name: "outbound_dialer_esl_persistence_retries_total",
  help: "FreeSWITCH ESL persistence retries after transient failures.",
  registers: [registry]
});
const eslPersistenceOverflows = new Counter({
  name: "outbound_dialer_esl_persistence_overflows_total",
  help: "FreeSWITCH ESL listener disconnects caused by a full persistence queue.",
  registers: [registry]
});

const sipTrunkConfigured = new Gauge({
  name: "outbound_dialer_sip_trunk_configured",
  help: "Whether required SIP trunk configuration is present.",
  labelNames: ["mode"] as const,
  registers: [registry]
});
const sipTrunkReady = new Gauge({
  name: "outbound_dialer_sip_trunk_ready",
  help: "Whether the SIP trunk is ready. IP-auth mode reflects configuration readiness.",
  labelNames: ["mode"] as const,
  registers: [registry]
});

eslListenerConnected.set(0);

export function registerMetrics(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  const refreshIntervalMilliseconds = (config.METRICS_REFRESH_INTERVAL_SECONDS ?? 15) * 1_000;
  let refreshTimer: NodeJS.Timeout | null = null;
  let refreshPromise: Promise<void> | null = null;

  const refreshSnapshot = (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = Promise.all([
      refreshDatabaseMetrics(pool, config.MONITORING_STUCK_CALL_SECONDS),
      refreshSipTrunkMetrics(config),
      refreshFreeSwitchRuntimeMetrics(config)
    ])
      .then((results) => {
        if (results.every(Boolean)) {
          metricsSnapshotLastRefresh.set(Date.now() / 1_000);
        } else {
          metricsSnapshotRefreshFailures.inc();
        }
      })
      .catch(() => {
        metricsSnapshotRefreshFailures.inc();
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  eslListenerEnabled.set(config.FREESWITCH_ESL_ENABLED ? 1 : 0);
  retentionEnabled.set(config.RETENTION_ENABLED ? 1 : 0);
  pcapCaptureEnabled.set(config.PCAP_CAPTURE_ENABLED ? 1 : 0);
  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    httpRequests.inc({ method: request.method, route, status_class: statusClass });

    const startedAt = requestStartedAt.get(request);
    if (startedAt) {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      httpRequestDuration.observe({ method: request.method, route }, durationSeconds);
    }
  });

  app.addHook("onReady", async () => {
    void refreshSnapshot();
    refreshTimer = setInterval(() => void refreshSnapshot(), refreshIntervalMilliseconds);
    refreshTimer.unref();
  });

  app.addHook("onClose", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  });

  app.get("/metrics", async (_request, reply) => {
    retentionEnabled.set(config.RETENTION_ENABLED ? 1 : 0);
    pcapCaptureEnabled.set(config.PCAP_CAPTURE_ENABLED ? 1 : 0);
    setDatabasePoolMetrics(pool);
    return reply.header("Content-Type", registry.contentType).send(await registry.metrics());
  });
}

function setDatabasePoolMetrics(pool: pg.Pool): void {
  databasePoolConnections.set({ state: "total" }, pool.totalCount ?? 0);
  databasePoolConnections.set({ state: "idle" }, pool.idleCount ?? 0);
  databasePoolWaitingRequests.set(pool.waitingCount ?? 0);
}

export function setFreeSwitchEventListenerConnected(connected: boolean): void {
  setFreeSwitchEventListenerSubscribed(connected);
  eslListenerConnected.set(connected ? 1 : 0);
}

export function configureFreeSwitchEventQueueMetrics(capacity: number): void {
  eslPersistenceQueueCapacity.set(capacity);
  eslPersistenceQueueDepth.set(0);
}

export function setFreeSwitchEventQueueDepth(depth: number): void {
  eslPersistenceQueueDepth.set(depth);
}

export function recordFreeSwitchPersistenceRetry(): void {
  eslPersistenceRetries.inc();
}

export function recordFreeSwitchPersistenceOverflow(): void {
  eslPersistenceOverflows.inc();
}

export function recordFreeSwitchEslReconnect(): void {
  eslReconnects.inc();
}

export function recordFreeSwitchEventProcessed(eventName: string | undefined): void {
  eslEvents.inc({ event_name: normalizeEventName(eventName) });
}

export function recordFreeSwitchEventError(): void {
  eslEventErrors.inc();
}

export function recordRetentionSuccess(result: {
  calls: number;
  recordingFiles: number;
  pcapFiles: number;
}): void {
  retentionLastSuccess.set(Date.now() / 1000);
  retentionDeletedCalls.inc(result.calls);
  retentionDeletedRecordings.inc(result.recordingFiles);
  retentionDeletedPcaps.inc(result.pcapFiles);
}

export function recordRetentionFailure(): void {
  retentionFailures.inc();
}

async function refreshDatabaseMetrics(pool: pg.Pool, stuckCallSeconds: number): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("begin transaction read only");
    await client.query("set local statement_timeout = '10s'");
    // A refresh is deliberately serialized onto at most one pool connection at
    // a time. Running these independent reads with Promise.all can consume most
    // of the default application pool and delay product traffic.
    let previousQuery: Promise<unknown> = Promise.resolve();
    const query = <Row extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
      const result = previousQuery.then(() => client!.query<Row>(text, values));
      // Preserve a rejection in the chain so a failed query prevents every
      // later monitoring scan from starting during this refresh.
      previousQuery = result;
      return result;
    };
    const [
      snapshot,
      window,
      outcomes,
      telephonyState,
      terminalLatency,
      terminalSources,
      mediaCoverage,
      mediaLegs,
      mediaCodecs
    ] = await Promise.all([
      query<{
        active_calls: string;
        active_supervisor_sessions: string;
        active_voicemail_jobs: string;
        recording_finalization_backlog: string;
        registered_agents: string;
        stuck_calls: string;
        stuck_voicemail_jobs: string;
        total_agents: string;
      }>(
        `
          select
            (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled', 'agent_released')) as active_calls,
            (select count(*) from call_supervisor_sessions where state in ('connecting', 'active')) as active_supervisor_sessions,
            (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled', 'agent_released') and created_at < now() - ($1 * interval '1 second')) as stuck_calls,
            (select count(*) from calls where ended_at is null and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')) as active_voicemail_jobs,
            (select count(*) from calls where ended_at is null and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released') and coalesce(voicemail_drop_requested_at, created_at) < now() - ($1 * interval '1 second')) as stuck_voicemail_jobs,
            (select count(*) from calls where ended_at is not null and call_recording_enabled = true and call_recording_status in ('pending', 'recording', 'finalizing')) as recording_finalization_backlog,
            (select count(*) from agents where registered = true) as registered_agents,
            (select count(*) from agents) as total_agents
        `,
        [stuckCallSeconds]
      ),
      query<{
        answered: string;
        attempted: string;
        failed: string;
        recording_failures: string;
        pcap_active: string;
        pcap_failures: string;
        pcap_storage_bytes: string;
        voicemail_drops: string;
      }>(`
        select
          (select count(*) from calls where created_at >= now() - interval '15 minutes') as attempted,
          (select count(*) from calls where answered_at >= now() - interval '15 minutes') as answered,
          (select count(*) from calls where ended_at >= now() - interval '15 minutes' and (state = 'failed' or outcome = 'failed')) as failed,
          (select count(*) from call_events where created_at >= now() - interval '24 hours' and event_type in ('call_recording_failed', 'call_recording_integrity_failed')) as recording_failures,
          (select count(*) from call_pcaps where status = 'capturing') as pcap_active,
          (select count(*) from call_pcaps where updated_at >= now() - interval '24 hours' and status = 'failed') as pcap_failures,
          (select coalesce(sum(file_size_bytes), 0) from call_pcaps where status = 'available') as pcap_storage_bytes,
          (select count(*) from calls where voicemail_playback_completed_at >= now() - interval '24 hours' and outcome = 'voicemail_dropped') as voicemail_drops
      `),
      query<{ count: string; outcome: string }>(
        `
          select outcome, count(*) as count
          from calls
          where ended_at >= now() - interval '24 hours'
            and outcome = any($1::text[])
          group by outcome
          order by outcome
        `,
        [Array.from(callOutcomes)]
      ),
      query<{
        active_call_reconcile_status: string | null;
        active_calls_closed_last_run: number | null;
        active_calls_db_count: number | null;
        active_calls_missing_in_freeswitch: number | null;
        active_calls_reconciled_at_seconds: string | null;
        registration_corrections_last_run: number | null;
        registration_db_count: number | null;
        registration_drift_count: number | null;
        registration_freeswitch_count: number | null;
        registration_reconcile_status: string | null;
        registration_reconciled_at_seconds: string | null;
      }>(`
        select
          registration_db_count,
          registration_freeswitch_count,
          registration_drift_count,
          registration_corrections_last_run,
          registration_reconcile_status,
          extract(epoch from registration_reconciled_at)::text as registration_reconciled_at_seconds,
          active_calls_db_count,
          active_calls_missing_in_freeswitch,
          active_calls_closed_last_run,
          active_call_reconcile_status,
          extract(epoch from active_calls_reconciled_at)::text as active_calls_reconciled_at_seconds
        from telephony_observability_state
        where singleton = true
      `),
      query<{
        average_latency_ms: string | null;
        max_latency_ms: string | null;
        measured_calls: string;
        p50_latency_ms: string | null;
        p95_latency_ms: string | null;
        terminal_samples: string;
        unmeasured_calls: string;
      }>(`
        select
          count(*) filter (
            where terminal_source = 'freeswitch_customer_terminal'
              and finalization_latency_ms is not null
          ) as terminal_samples,
          avg(finalization_latency_ms) filter (
            where terminal_source = 'freeswitch_customer_terminal'
          )::text as average_latency_ms,
          percentile_cont(0.50) within group (order by finalization_latency_ms) filter (
            where terminal_source = 'freeswitch_customer_terminal'
          )::text as p50_latency_ms,
          percentile_cont(0.95) within group (order by finalization_latency_ms) filter (
            where terminal_source = 'freeswitch_customer_terminal'
          )::text as p95_latency_ms,
          max(finalization_latency_ms) filter (
            where terminal_source = 'freeswitch_customer_terminal'
          )::text as max_latency_ms,
          count(*) filter (
            where terminal_source = 'freeswitch_customer_terminal'
              and finalization_latency_ms is not null
          ) as measured_calls,
          count(*) filter (
            where terminal_source = 'freeswitch_customer_terminal'
              and finalization_latency_ms is null
          ) as unmeasured_calls
        from calls
        where terminal_persisted_at >= now() - interval '15 minutes'
      `),
      query<{ count: string; terminal_source: string | null }>(`
        select terminal_source, count(*) as count
        from calls
        where terminal_persisted_at >= now() - interval '15 minutes'
        group by terminal_source
      `),
      query<{
        complete_calls: string;
        eligible_calls: string;
        missing_calls: string;
        partial_calls: string;
      }>(`
        with eligible_calls as (
          select id
          from calls
          where answered_at is not null
            and ended_at >= now() - interval '15 minutes'
            and ended_at >= answered_at + interval '10 seconds'
        ), coverage as (
          select
            eligible_calls.id,
            count(call_media_stats.call_id) filter (
              where coalesce(
                call_media_stats.inbound_media_packet_count,
                call_media_stats.inbound_packet_count
              ) is not null
                and coalesce(
                  call_media_stats.outbound_media_packet_count,
                  call_media_stats.outbound_packet_count
                ) is not null
            ) as observed_legs
          from eligible_calls
          left join call_media_stats on call_media_stats.call_id = eligible_calls.id
          group by eligible_calls.id
        )
        select
          count(*) as eligible_calls,
          count(*) filter (where observed_legs >= 2) as complete_calls,
          count(*) filter (where observed_legs = 1) as partial_calls,
          count(*) filter (where observed_legs = 0) as missing_calls
        from coverage
      `),
      query<{
        inbound_all_packets: string;
        inbound_jitter_loss_rate_average: string | null;
        inbound_jitter_loss_rate_p95: string | null;
        inbound_jitter_max_variance_average: string | null;
        inbound_jitter_max_variance_p95: string | null;
        inbound_media_packets: string;
        inbound_mos_average: string | null;
        inbound_mos_p10: string | null;
        inbound_quality_percentage_average: string | null;
        inbound_quality_percentage_p10: string | null;
        leg_type: string;
        outbound_all_packets: string;
        outbound_media_packets: string;
        suspected_one_way_calls: string;
      }>(`
        select
          media.leg_type,
          count(*) filter (
            where (
              coalesce(media.inbound_media_packet_count, media.inbound_packet_count, 0) <= 5
              and coalesce(media.outbound_media_packet_count, media.outbound_packet_count, 0) >= 50
            ) or (
              coalesce(media.outbound_media_packet_count, media.outbound_packet_count, 0) <= 5
              and coalesce(media.inbound_media_packet_count, media.inbound_packet_count, 0) >= 50
            )
          ) as suspected_one_way_calls,
          coalesce(sum(media.inbound_packet_count), 0) as inbound_all_packets,
          coalesce(sum(media.outbound_packet_count), 0) as outbound_all_packets,
          coalesce(sum(media.inbound_media_packet_count), 0) as inbound_media_packets,
          coalesce(sum(media.outbound_media_packet_count), 0) as outbound_media_packets,
          avg(media.inbound_jitter_loss_rate)::text as inbound_jitter_loss_rate_average,
          percentile_cont(0.95) within group (order by media.inbound_jitter_loss_rate)::text
            as inbound_jitter_loss_rate_p95,
          avg(media.inbound_jitter_max_variance)::text as inbound_jitter_max_variance_average,
          percentile_cont(0.95) within group (order by media.inbound_jitter_max_variance)::text
            as inbound_jitter_max_variance_p95,
          avg(media.inbound_mos)::text as inbound_mos_average,
          percentile_cont(0.10) within group (order by media.inbound_mos)::text as inbound_mos_p10,
          avg(media.inbound_quality_percentage)::text as inbound_quality_percentage_average,
          percentile_cont(0.10) within group (order by media.inbound_quality_percentage)::text
            as inbound_quality_percentage_p10
        from call_media_stats media
        join calls on calls.id = media.call_id
        where calls.answered_at is not null
          and calls.ended_at >= now() - interval '15 minutes'
          and calls.ended_at >= calls.answered_at + interval '10 seconds'
        group by media.leg_type
      `),
      query<{ codec: string | null; codec_direction: string; count: string; leg_type: string }>(`
        select leg_type, 'read' as codec_direction, read_codec as codec, count(*) as count
        from call_media_stats
        where captured_at >= now() - interval '15 minutes'
        group by leg_type, read_codec
        union all
        select leg_type, 'write' as codec_direction, write_codec as codec, count(*) as count
        from call_media_stats
        where captured_at >= now() - interval '15 minutes'
        group by leg_type, write_codec
      `)
    ]);

    const current = snapshot.rows[0];
    const recent = window.rows[0];
    activeCalls.set(toNumber(current?.active_calls));
    activeSupervisorSessions.set(toNumber(current?.active_supervisor_sessions));
    stuckCalls.set(toNumber(current?.stuck_calls));
    activeVoicemailJobs.set(toNumber(current?.active_voicemail_jobs));
    stuckVoicemailJobs.set(toNumber(current?.stuck_voicemail_jobs));
    recordingFinalizationBacklog.set(toNumber(current?.recording_finalization_backlog));
    registeredAgents.set(toNumber(current?.registered_agents));
    totalAgents.set(toNumber(current?.total_agents));
    callsAttemptedWindow.set(toNumber(recent?.attempted));
    callsAnsweredWindow.set(toNumber(recent?.answered));
    callsFailedWindow.set(toNumber(recent?.failed));
    recordingFailuresWindow.set(toNumber(recent?.recording_failures));
    pcapCapturesActive.set(toNumber(recent?.pcap_active));
    pcapCaptureFailuresWindow.set(toNumber(recent?.pcap_failures));
    pcapStorageBytes.set(toNumber(recent?.pcap_storage_bytes));
    voicemailDropsWindow.set(toNumber(recent?.voicemail_drops));
    callOutcomesWindow.reset();
    for (const outcome of callOutcomes) {
      callOutcomesWindow.set({ outcome }, 0);
    }
    for (const outcome of outcomes.rows) {
      if (callOutcomes.includes(outcome.outcome as (typeof callOutcomes)[number])) {
        callOutcomesWindow.set({ outcome: outcome.outcome }, toNumber(outcome.count));
      }
    }
    setTelephonyStateMetrics(telephonyState.rows[0]);
    setTerminalMetrics(terminalLatency.rows[0], terminalSources.rows);
    setMediaMetrics(mediaCoverage.rows[0], mediaLegs.rows, mediaCodecs.rows);
    await client.query("commit");
    databaseSnapshotUp.set(1);
    return true;
  } catch {
    if (client) await client.query("rollback").catch(() => undefined);
    databaseSnapshotUp.set(0);
    return false;
  } finally {
    client?.release();
  }
}

function setTelephonyStateMetrics(
  state:
    | {
        active_call_reconcile_status: string | null;
        active_calls_closed_last_run: number | null;
        active_calls_db_count: number | null;
        active_calls_missing_in_freeswitch: number | null;
        active_calls_reconciled_at_seconds: string | null;
        registration_corrections_last_run: number | null;
        registration_db_count: number | null;
        registration_drift_count: number | null;
        registration_freeswitch_count: number | null;
        registration_reconcile_status: string | null;
        registration_reconciled_at_seconds: string | null;
      }
    | undefined
): void {
  registrationReconciliationUp.set(state?.registration_reconcile_status === "ok" ? 1 : 0);
  registrationReconciliationLastRun.set(toNumber(state?.registration_reconciled_at_seconds));
  registrationReconciledAgents.reset();
  registrationReconciledAgents.set({ source: "postgres" }, toNumber(state?.registration_db_count));
  registrationReconciledAgents.set({ source: "freeswitch" }, toNumber(state?.registration_freeswitch_count));
  registrationDriftAgents.set(toNumber(state?.registration_drift_count));
  registrationCorrectionsLastRun.set(toNumber(state?.registration_corrections_last_run));

  activeCallReconciliationUp.set(state?.active_call_reconcile_status === "ok" ? 1 : 0);
  activeCallReconciliationLastRun.set(toNumber(state?.active_calls_reconciled_at_seconds));
  activeCallReconciliationDatabaseCalls.set(toNumber(state?.active_calls_db_count));
  activeCallsMissingInFreeSwitch.set(toNumber(state?.active_calls_missing_in_freeswitch));
  activeCallsClosedLastRun.set(toNumber(state?.active_calls_closed_last_run));
}

function setTerminalMetrics(
  latency:
    | {
        average_latency_ms: string | null;
        max_latency_ms: string | null;
        measured_calls: string;
        p50_latency_ms: string | null;
        p95_latency_ms: string | null;
        terminal_samples: string;
        unmeasured_calls: string;
      }
    | undefined,
  sources: Array<{ count: string; terminal_source: string | null }>
): void {
  terminalFinalizationSamplesWindow.set(toNumber(latency?.terminal_samples));
  terminalFinalizationDurationMilliseconds.reset();
  const durationValues = new Map<string, unknown>([
    ["average", latency?.average_latency_ms],
    ["p50", latency?.p50_latency_ms],
    ["p95", latency?.p95_latency_ms],
    ["max", latency?.max_latency_ms]
  ]);
  for (const statistic of terminalStatistics) {
    const value = toOptionalNumber(durationValues.get(statistic));
    if (value !== null) terminalFinalizationDurationMilliseconds.set({ statistic }, value);
  }

  terminalFinalizationCoverageWindow.reset();
  const coverageCounts: Record<(typeof terminalCoverageValues)[number], number> = {
    measured: toNumber(latency?.measured_calls),
    unmeasured: toNumber(latency?.unmeasured_calls)
  };
  for (const status of terminalCoverageValues) {
    terminalFinalizationCoverageWindow.set({ status }, coverageCounts[status]);
  }

  terminalCallsWindow.reset();
  const counts = new Map<(typeof terminalSourceValues)[number], number>(
    terminalSourceValues.map((source) => [source, 0])
  );
  for (const source of sources) {
    const normalized = normalizeTerminalSource(source.terminal_source);
    counts.set(normalized, (counts.get(normalized) ?? 0) + toNumber(source.count));
  }
  for (const source of terminalSourceValues) {
    terminalCallsWindow.set({ source }, counts.get(source) ?? 0);
  }
}

function setMediaMetrics(
  coverage:
    | {
        complete_calls: string;
        eligible_calls: string;
        missing_calls: string;
        partial_calls: string;
      }
    | undefined,
  legs: Array<{
    inbound_all_packets: string;
    inbound_jitter_loss_rate_average: string | null;
    inbound_jitter_loss_rate_p95: string | null;
    inbound_jitter_max_variance_average: string | null;
    inbound_jitter_max_variance_p95: string | null;
    inbound_media_packets: string;
    inbound_mos_average: string | null;
    inbound_mos_p10: string | null;
    inbound_quality_percentage_average: string | null;
    inbound_quality_percentage_p10: string | null;
    leg_type: string;
    outbound_all_packets: string;
    outbound_media_packets: string;
    suspected_one_way_calls: string;
  }>,
  codecs: Array<{ codec: string | null; codec_direction: string; count: string; leg_type: string }>
): void {
  mediaQualityCallsWindow.reset();
  const coverageCounts: Record<(typeof mediaCoverageValues)[number], number> = {
    eligible: toNumber(coverage?.eligible_calls),
    complete: toNumber(coverage?.complete_calls),
    partial: toNumber(coverage?.partial_calls),
    missing: toNumber(coverage?.missing_calls)
  };
  for (const value of mediaCoverageValues) {
    mediaQualityCallsWindow.set({ coverage: value }, coverageCounts[value]);
  }

  mediaOneWaySuspectedCallsWindow.reset();
  mediaPacketsWindow.reset();
  mediaJitterLossRateWindow.reset();
  mediaJitterMaxVarianceWindow.reset();
  mediaMosWindow.reset();
  mediaQualityPercentageWindow.reset();
  for (const legType of mediaLegTypes) {
    mediaOneWaySuspectedCallsWindow.set({ leg_type: legType }, 0);
    for (const direction of mediaDirections) {
      for (const kind of mediaPacketKinds) {
        mediaPacketsWindow.set({ leg_type: legType, direction, kind }, 0);
      }
    }
  }

  for (const leg of legs) {
    if (!isMediaLegType(leg.leg_type)) continue;
    const legType = leg.leg_type;
    mediaOneWaySuspectedCallsWindow.set({ leg_type: legType }, toNumber(leg.suspected_one_way_calls));
    mediaPacketsWindow.set(
      { leg_type: legType, direction: "inbound", kind: "all" },
      toNumber(leg.inbound_all_packets)
    );
    mediaPacketsWindow.set(
      { leg_type: legType, direction: "outbound", kind: "all" },
      toNumber(leg.outbound_all_packets)
    );
    mediaPacketsWindow.set(
      { leg_type: legType, direction: "inbound", kind: "media" },
      toNumber(leg.inbound_media_packets)
    );
    mediaPacketsWindow.set(
      { leg_type: legType, direction: "outbound", kind: "media" },
      toNumber(leg.outbound_media_packets)
    );
    setOptionalStatistic(mediaJitterLossRateWindow, legType, "average", leg.inbound_jitter_loss_rate_average);
    setOptionalStatistic(mediaJitterLossRateWindow, legType, "p95", leg.inbound_jitter_loss_rate_p95);
    setOptionalStatistic(
      mediaJitterMaxVarianceWindow,
      legType,
      "average",
      leg.inbound_jitter_max_variance_average
    );
    setOptionalStatistic(mediaJitterMaxVarianceWindow, legType, "p95", leg.inbound_jitter_max_variance_p95);
    setOptionalStatistic(mediaMosWindow, legType, "average", leg.inbound_mos_average);
    setOptionalStatistic(mediaMosWindow, legType, "p10", leg.inbound_mos_p10);
    setOptionalStatistic(
      mediaQualityPercentageWindow,
      legType,
      "average",
      leg.inbound_quality_percentage_average
    );
    setOptionalStatistic(mediaQualityPercentageWindow, legType, "p10", leg.inbound_quality_percentage_p10);
  }

  mediaCodecsWindow.reset();
  const codecCounts = new Map<string, number>();
  for (const legType of mediaLegTypes) {
    for (const direction of codecDirections) {
      for (const codec of codecValues) {
        codecCounts.set(`${legType}:${direction}:${codec}`, 0);
      }
    }
  }
  for (const codec of codecs) {
    if (!isMediaLegType(codec.leg_type) || !isCodecDirection(codec.codec_direction)) continue;
    const normalized = normalizeCodec(codec.codec);
    const key = `${codec.leg_type}:${codec.codec_direction}:${normalized}`;
    codecCounts.set(key, (codecCounts.get(key) ?? 0) + toNumber(codec.count));
  }
  for (const legType of mediaLegTypes) {
    for (const direction of codecDirections) {
      for (const codec of codecValues) {
        mediaCodecsWindow.set(
          { leg_type: legType, direction, codec },
          codecCounts.get(`${legType}:${direction}:${codec}`) ?? 0
        );
      }
    }
  }
}

function setOptionalStatistic(
  metric: Gauge,
  legType: (typeof mediaLegTypes)[number],
  statistic: MediaStatistic,
  rawValue: unknown
): void {
  const value = toOptionalNumber(rawValue);
  if (value !== null) metric.set({ leg_type: legType, statistic }, value);
}

function normalizeCodec(value: string | null): (typeof codecValues)[number] {
  if (!value?.trim()) return "UNKNOWN";
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (["PCMU", "ULAW", "G711U", "G711ULAW"].includes(normalized)) return "PCMU";
  if (["PCMA", "ALAW", "G711A", "G711ALAW"].includes(normalized)) return "PCMA";
  if (normalized.startsWith("G729")) return "G729";
  if (normalized === "OPUS") return "OPUS";
  if (normalized.startsWith("G722")) return "G722";
  if (normalized.startsWith("L16")) return "L16";
  return "OTHER";
}

function normalizeTerminalSource(value: string | null): (typeof terminalSourceValues)[number] {
  if (value && (terminalSourceValues as readonly string[]).includes(value)) {
    return value as (typeof terminalSourceValues)[number];
  }
  if (["background_job_failure", "originate_failure", "originate_watchdog"].includes(value ?? "")) {
    return "background_job";
  }
  if (value === "agent_api") {
    return "api";
  }
  if (value?.includes("voicemail") || value?.includes("playback")) {
    return "voicemail_custom";
  }
  return "unknown";
}

function isMediaLegType(value: string): value is (typeof mediaLegTypes)[number] {
  return (mediaLegTypes as readonly string[]).includes(value);
}

function isCodecDirection(value: string): value is (typeof codecDirections)[number] {
  return (codecDirections as readonly string[]).includes(value);
}

async function refreshSipTrunkMetrics(config: AppConfig): Promise<boolean> {
  const mode = config.SIP_TRUNK_MODE;
  const configured = canOriginateCustomerLeg(config);
  sipTrunkConfigured.reset();
  sipTrunkReady.reset();
  sipTrunkConfigured.set({ mode }, configured ? 1 : 0);

  if (!configured) {
    sipTrunkReady.set({ mode }, 0);
    return true;
  }
  if (mode === "ip_auth") {
    sipTrunkReady.set({ mode }, 1);
    return true;
  }

  try {
    const response = await sendFreeSwitchApiCommand(config, "sofia status gateway sip-trunk");
    const value = (response.body || response.raw).toLowerCase();
    sipTrunkReady.set({ mode }, /\breged\b/.test(value) ? 1 : 0);
    return true;
  } catch {
    sipTrunkReady.set({ mode }, 0);
    return false;
  }
}

async function refreshFreeSwitchRuntimeMetrics(
  config: AppConfig,
  sendApiCommand: typeof sendFreeSwitchApiCommand = sendFreeSwitchApiCommand
): Promise<boolean> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    freeSwitchActiveChannels.set(0);
    freeSwitchRegistrations.set(0);
    return true;
  }

  try {
    const [channels, registrations] = await Promise.all([
      readFreeSwitchCount(config, "show channels count", sendApiCommand),
      readFreeSwitchCount(config, "show registrations count", sendApiCommand)
    ]);
    freeSwitchActiveChannels.set(channels);
    freeSwitchRegistrations.set(registrations);
    return true;
  } catch {
    freeSwitchActiveChannels.set(0);
    freeSwitchRegistrations.set(0);
    return false;
  }
}

async function readFreeSwitchCount(
  config: AppConfig,
  command: string,
  sendApiCommand: typeof sendFreeSwitchApiCommand
): Promise<number> {
  const response = await sendApiCommand(config, command);
  const value = response.body || response.raw;
  if (!/(?:^|\n)\s*\d+\s+total\.\s*(?:$|\n)/i.test(value)) {
    throw new Error(`FreeSWITCH returned an invalid count for ${command}`);
  }
  return parseFreeSwitchCount(value);
}

function parseFreeSwitchCount(value: string): number {
  const match = value.match(/(?:^|\n)\s*(\d+)\s+total\.\s*(?:$|\n)/i);
  return match ? Number(match[1]) : 0;
}

function gauge(name: string, help: string): Gauge {
  return new Gauge({ name, help, registers: [registry] });
}

function labeledGauge(name: string, help: string, labelNames: readonly string[]): Gauge {
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

function normalizeEventName(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  return normalized || "UNKNOWN";
}

function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: unknown): number {
  return toOptionalNumber(value) ?? 0;
}

export const __testing = {
  metrics: () => registry.metrics(),
  normalizeCodec,
  normalizeEventName,
  normalizeTerminalSource,
  parseFreeSwitchCount,
  refreshDatabaseMetrics,
  refreshFreeSwitchRuntimeMetrics,
  setDatabasePoolMetrics,
  toNumber
};
