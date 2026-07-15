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

const activeCalls = gauge(
  "outbound_dialer_active_calls",
  "Current non-terminal calls excluding voicemail playback continuing after agent release."
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

  app.get("/metrics", async (_request, reply) => {
    retentionEnabled.set(config.RETENTION_ENABLED ? 1 : 0);
    pcapCaptureEnabled.set(config.PCAP_CAPTURE_ENABLED ? 1 : 0);
    await Promise.all([
      refreshDatabaseMetrics(pool, config.MONITORING_STUCK_CALL_SECONDS),
      refreshSipTrunkMetrics(config),
      refreshFreeSwitchRuntimeMetrics(config)
    ]);
    return reply.header("Content-Type", registry.contentType).send(await registry.metrics());
  });
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

async function refreshDatabaseMetrics(pool: pg.Pool, stuckCallSeconds: number): Promise<void> {
  try {
    const [snapshot, window, outcomes] = await Promise.all([
      pool.query<{
        active_calls: string;
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
            (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled', 'agent_released') and created_at < now() - ($1 * interval '1 second')) as stuck_calls,
            (select count(*) from calls where ended_at is null and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')) as active_voicemail_jobs,
            (select count(*) from calls where ended_at is null and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released') and coalesce(voicemail_drop_requested_at, created_at) < now() - ($1 * interval '1 second')) as stuck_voicemail_jobs,
            (select count(*) from calls where ended_at is not null and call_recording_enabled = true and call_recording_status in ('pending', 'recording', 'finalizing')) as recording_finalization_backlog,
            (select count(*) from agents where registered = true) as registered_agents,
            (select count(*) from agents) as total_agents
        `,
        [stuckCallSeconds]
      ),
      pool.query<{
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
      pool.query<{ count: string; outcome: string }>(
        `
          select outcome, count(*) as count
          from calls
          where ended_at >= now() - interval '24 hours'
            and outcome = any($1::text[])
          group by outcome
          order by outcome
        `,
        [Array.from(callOutcomes)]
      )
    ]);

    const current = snapshot.rows[0];
    const recent = window.rows[0];
    activeCalls.set(toNumber(current?.active_calls));
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
    databaseSnapshotUp.set(1);
  } catch {
    databaseSnapshotUp.set(0);
  }
}

async function refreshSipTrunkMetrics(config: AppConfig): Promise<void> {
  const mode = config.SIP_TRUNK_MODE;
  const configured = canOriginateCustomerLeg(config);
  sipTrunkConfigured.reset();
  sipTrunkReady.reset();
  sipTrunkConfigured.set({ mode }, configured ? 1 : 0);

  if (!configured) {
    sipTrunkReady.set({ mode }, 0);
    return;
  }
  if (mode === "ip_auth") {
    sipTrunkReady.set({ mode }, 1);
    return;
  }

  try {
    const response = await sendFreeSwitchApiCommand(config, "sofia status gateway sip-trunk");
    const value = (response.body || response.raw).toLowerCase();
    sipTrunkReady.set({ mode }, /\breged\b/.test(value) ? 1 : 0);
  } catch {
    sipTrunkReady.set({ mode }, 0);
  }
}

async function refreshFreeSwitchRuntimeMetrics(
  config: AppConfig,
  sendApiCommand: typeof sendFreeSwitchApiCommand = sendFreeSwitchApiCommand
): Promise<void> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    freeSwitchActiveChannels.set(0);
    freeSwitchRegistrations.set(0);
    return;
  }

  const [channels, registrations] = await Promise.all([
    readFreeSwitchCount(config, "show channels count", sendApiCommand),
    readFreeSwitchCount(config, "show registrations count", sendApiCommand)
  ]);
  freeSwitchActiveChannels.set(channels);
  freeSwitchRegistrations.set(registrations);
}

async function readFreeSwitchCount(
  config: AppConfig,
  command: string,
  sendApiCommand: typeof sendFreeSwitchApiCommand
): Promise<number> {
  try {
    const response = await sendApiCommand(config, command);
    return parseFreeSwitchCount(response.body || response.raw);
  } catch {
    return 0;
  }
}

function parseFreeSwitchCount(value: string): number {
  const match = value.match(/(?:^|\n)\s*(\d+)\s+total\.\s*(?:$|\n)/i);
  return match ? Number(match[1]) : 0;
}

function gauge(name: string, help: string): Gauge {
  return new Gauge({ name, help, registers: [registry] });
}

function normalizeEventName(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  return normalized || "UNKNOWN";
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const __testing = {
  metrics: () => registry.metrics(),
  normalizeEventName,
  parseFreeSwitchCount,
  refreshDatabaseMetrics,
  refreshFreeSwitchRuntimeMetrics,
  toNumber
};
