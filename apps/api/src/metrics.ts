import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { canOriginateCustomerLeg, sendFreeSwitchApiCommand } from "./esl.js";

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

const activeCalls = gauge("outbound_dialer_active_calls", "Current non-terminal calls.");
const stuckCalls = gauge("outbound_dialer_stuck_calls", "Current non-terminal calls older than the configured threshold.");
const registeredAgents = gauge("outbound_dialer_registered_agents", "Agents currently registered with FreeSWITCH.");
const totalAgents = gauge("outbound_dialer_agents", "Agents currently stored in PostgreSQL.");
const callsAttemptedWindow = gauge("outbound_dialer_calls_attempted_window", "Calls created during the monitoring window.");
const callsAnsweredWindow = gauge("outbound_dialer_calls_answered_window", "Calls answered during the monitoring window.");
const callsFailedWindow = gauge("outbound_dialer_calls_failed_window", "Calls failed during the monitoring window.");
const recordingFailuresWindow = gauge(
  "outbound_dialer_recording_failures_window",
  "Call recording failures during the monitoring window."
);
const voicemailDropsWindow = gauge(
  "outbound_dialer_voicemail_drops_window",
  "Completed voicemail drops during the monitoring window."
);

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
    await Promise.all([refreshDatabaseMetrics(pool, config.MONITORING_STUCK_CALL_SECONDS), refreshSipTrunkMetrics(config)]);
    return reply.header("Content-Type", registry.contentType).send(await registry.metrics());
  });
}

export function setFreeSwitchEventListenerConnected(connected: boolean): void {
  eslListenerConnected.set(connected ? 1 : 0);
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

async function refreshDatabaseMetrics(pool: pg.Pool, stuckCallSeconds: number): Promise<void> {
  try {
    const [snapshot, window] = await Promise.all([
      pool.query<{
        active_calls: string;
        registered_agents: string;
        stuck_calls: string;
        total_agents: string;
      }>(
        `
          select
            (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled')) as active_calls,
            (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled') and created_at < now() - ($1 * interval '1 second')) as stuck_calls,
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
        voicemail_drops: string;
      }>(`
        select
          (select count(*) from calls where created_at >= now() - interval '15 minutes') as attempted,
          (select count(*) from calls where answered_at >= now() - interval '15 minutes') as answered,
          (select count(*) from calls where ended_at >= now() - interval '15 minutes' and (state = 'failed' or outcome = 'failed')) as failed,
          (select count(*) from call_events where created_at >= now() - interval '24 hours' and event_type = 'call_recording_failed') as recording_failures,
          (select count(*) from call_events where created_at >= now() - interval '24 hours' and event_type = 'voicemail_playback_completed') as voicemail_drops
      `)
    ]);

    const current = snapshot.rows[0];
    const recent = window.rows[0];
    activeCalls.set(toNumber(current?.active_calls));
    stuckCalls.set(toNumber(current?.stuck_calls));
    registeredAgents.set(toNumber(current?.registered_agents));
    totalAgents.set(toNumber(current?.total_agents));
    callsAttemptedWindow.set(toNumber(recent?.attempted));
    callsAnsweredWindow.set(toNumber(recent?.answered));
    callsFailedWindow.set(toNumber(recent?.failed));
    recordingFailuresWindow.set(toNumber(recent?.recording_failures));
    voicemailDropsWindow.set(toNumber(recent?.voicemail_drops));
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

function gauge(name: string, help: string): Gauge {
  return new Gauge({ name, help, registers: [registry] });
}

function normalizeEventName(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return normalized || "UNKNOWN";
}

function toNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const __testing = {
  normalizeEventName,
  toNumber
};
