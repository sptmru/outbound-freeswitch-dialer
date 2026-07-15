import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import {
  __testing,
  configureFreeSwitchEventQueueMetrics,
  recordFreeSwitchPersistenceOverflow,
  recordFreeSwitchPersistenceRetry,
  setFreeSwitchEventQueueDepth
} from "./metrics.js";

function emptyObservabilityResult(sql: string): { rowCount: number; rows: unknown[] } | undefined {
  if (sql.includes("from telephony_observability_state")) {
    return { rowCount: 0, rows: [] };
  }
  if (sql.includes("as terminal_samples")) {
    return {
      rowCount: 1,
      rows: [{ measured_calls: "0", terminal_samples: "0", unmeasured_calls: "0" }]
    };
  }
  if (sql.includes("group by terminal_source")) return { rowCount: 0, rows: [] };
  if (sql.includes("with eligible_calls as")) {
    return {
      rowCount: 1,
      rows: [{ complete_calls: "0", eligible_calls: "0", missing_calls: "0", partial_calls: "0" }]
    };
  }
  if (sql.includes("group by media.leg_type")) return { rowCount: 0, rows: [] };
  if (sql.includes("codec_direction")) return { rowCount: 0, rows: [] };
  return undefined;
}

describe("application metrics", () => {
  it("counts only calls with confirmed voicemail playback completion", async () => {
    const queries: string[] = [];
    const pool = {
      query: (sql: string) => {
        queries.push(sql);
        const observability = emptyObservabilityResult(sql);
        if (observability) return Promise.resolve(observability);
        if (sql.includes("group by outcome")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (sql.includes("active_calls")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ active_calls: "0", registered_agents: "0", stuck_calls: "0", total_agents: "0" }]
          });
        }
        return Promise.resolve({
          rowCount: 1,
          rows: [
            { answered: "0", attempted: "0", failed: "0", recording_failures: "0", voicemail_drops: "0" }
          ]
        });
      }
    } as unknown as pg.Pool;

    await __testing.refreshDatabaseMetrics(pool, 120);

    const windowQuery = queries.find((sql) => sql.includes("voicemail_drops"));
    assert.match(windowQuery ?? "", /voicemail_playback_completed_at/);
    assert.match(windowQuery ?? "", /outcome = 'voicemail_dropped'/);
    assert.doesNotMatch(windowQuery ?? "", /event_type = 'voicemail_playback_completed'/);
  });

  it("exports bounded current-work and outcome snapshot gauges", async () => {
    const queries: string[] = [];
    const queryParameters: unknown[][] = [];
    const pool = {
      query: (sql: string, parameters: unknown[] = []) => {
        queries.push(sql);
        queryParameters.push(parameters);
        const observability = emptyObservabilityResult(sql);
        if (observability) return Promise.resolve(observability);
        if (sql.includes("group by outcome")) {
          return Promise.resolve({
            rowCount: 2,
            rows: [
              { count: "4", outcome: "answered" },
              { count: "2", outcome: "busy" }
            ]
          });
        }
        if (sql.includes("active_calls")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                active_calls: "5",
                active_voicemail_jobs: "2",
                recording_finalization_backlog: "3",
                registered_agents: "1",
                stuck_calls: "1",
                stuck_voicemail_jobs: "1",
                total_agents: "4"
              }
            ]
          });
        }
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              answered: "0",
              attempted: "0",
              failed: "0",
              pcap_active: "0",
              pcap_failures: "0",
              pcap_storage_bytes: "0",
              recording_failures: "0",
              voicemail_drops: "0"
            }
          ]
        });
      }
    } as unknown as pg.Pool;

    await __testing.refreshDatabaseMetrics(pool, 120);

    const snapshotQuery = queries.find((sql) => sql.includes("active_voicemail_jobs"));
    assert.match(snapshotQuery ?? "", /state not in \('completed', 'failed', 'canceled', 'agent_released'\)/);
    assert.match(
      snapshotQuery ?? "",
      /state in \('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released'\)/
    );
    assert.match(snapshotQuery ?? "", /call_recording_status in \('pending', 'recording', 'finalizing'\)/);
    const outcomeQueryIndex = queries.findIndex((sql) => sql.includes("group by outcome"));
    assert.deepEqual(queryParameters[outcomeQueryIndex]?.[0], [
      "answered",
      "not_answered",
      "busy",
      "failed",
      "voicemail_detected",
      "voicemail_dropped",
      "agent_canceled",
      "customer_hung_up",
      "suppressed"
    ]);

    const metrics = await __testing.metrics();
    assert.match(metrics, /outbound_dialer_voicemail_jobs_active 2/);
    assert.match(metrics, /outbound_dialer_voicemail_jobs_stuck 1/);
    assert.match(metrics, /outbound_dialer_recording_finalization_backlog 3/);
    assert.match(metrics, /outbound_dialer_call_outcomes_window\{outcome="answered"\} 4/);
    assert.match(metrics, /outbound_dialer_call_outcomes_window\{outcome="busy"\} 2/);
    assert.match(metrics, /outbound_dialer_call_outcomes_window\{outcome="failed"\} 0/);
    assert.doesNotMatch(metrics, /outbound_dialer_call_outcomes_window\{outcome="pending"\}/);
  });

  it("exports bounded media, terminal finalization, and reconciliation metrics", async () => {
    const pool = {
      query: (sql: string) => {
        if (sql.includes("from telephony_observability_state")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                active_call_reconcile_status: "ok",
                active_calls_closed_last_run: 1,
                active_calls_db_count: 3,
                active_calls_missing_in_freeswitch: 1,
                active_calls_reconciled_at_seconds: "1710000010",
                registration_corrections_last_run: 2,
                registration_db_count: 4,
                registration_drift_count: 2,
                registration_freeswitch_count: 5,
                registration_reconcile_status: "ok",
                registration_reconciled_at_seconds: "1710000000"
              }
            ]
          });
        }
        if (sql.includes("as terminal_samples")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                average_latency_ms: "120",
                max_latency_ms: "500",
                measured_calls: "8",
                p50_latency_ms: "90",
                p95_latency_ms: "410",
                terminal_samples: "8",
                unmeasured_calls: "2"
              }
            ]
          });
        }
        if (sql.includes("group by terminal_source")) {
          return Promise.resolve({
            rowCount: 2,
            rows: [
              { count: "8", terminal_source: "freeswitch_customer_terminal" },
              { count: "2", terminal_source: "unbounded-provider-value" }
            ]
          });
        }
        if (sql.includes("with eligible_calls as")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ complete_calls: "8", eligible_calls: "10", missing_calls: "1", partial_calls: "1" }]
          });
        }
        if (sql.includes("group by media.leg_type")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                inbound_all_packets: "1000",
                inbound_jitter_loss_rate_average: "0.5",
                inbound_jitter_loss_rate_p95: "1.5",
                inbound_jitter_max_variance_average: "2",
                inbound_jitter_max_variance_p95: "8",
                inbound_media_packets: "900",
                inbound_mos_average: "4.1",
                inbound_mos_p10: "3.6",
                inbound_quality_percentage_average: "96",
                inbound_quality_percentage_p10: "89",
                leg_type: "customer",
                outbound_all_packets: "1200",
                outbound_media_packets: "1100",
                suspected_one_way_calls: "1"
              }
            ]
          });
        }
        if (sql.includes("codec_direction")) {
          return Promise.resolve({
            rowCount: 3,
            rows: [
              { codec: "PCMU", codec_direction: "read", count: "5", leg_type: "customer" },
              { codec: "G.729a", codec_direction: "write", count: "2", leg_type: "customer" },
              { codec: "provider-special", codec_direction: "write", count: "3", leg_type: "customer" }
            ]
          });
        }
        if (sql.includes("group by outcome")) return Promise.resolve({ rowCount: 0, rows: [] });
        if (sql.includes("active_voicemail_jobs")) {
          return Promise.resolve({ rowCount: 1, rows: [{ active_calls: "0" }] });
        }
        return Promise.resolve({ rowCount: 1, rows: [{ attempted: "0" }] });
      }
    } as unknown as pg.Pool;

    await __testing.refreshDatabaseMetrics(pool, 120);

    const metrics = await __testing.metrics();
    assert.match(metrics, /outbound_dialer_registration_reconciliation_up 1/);
    assert.match(metrics, /outbound_dialer_registration_drift_agents 2/);
    assert.match(metrics, /outbound_dialer_active_calls_missing_in_freeswitch 1/);
    assert.match(
      metrics,
      /outbound_dialer_terminal_finalization_duration_milliseconds\{statistic="p95"\} 410/
    );
    assert.match(metrics, /outbound_dialer_terminal_calls_window\{source="unknown"\} 2/);
    assert.match(metrics, /outbound_dialer_media_quality_calls_window\{coverage="complete"\} 8/);
    assert.match(metrics, /outbound_dialer_media_one_way_suspected_calls_window\{leg_type="customer"\} 1/);
    assert.match(
      metrics,
      /outbound_dialer_media_codecs_window\{leg_type="customer",direction="write",codec="G729"\} 2/
    );
    assert.match(
      metrics,
      /outbound_dialer_media_codecs_window\{leg_type="customer",direction="write",codec="OTHER"\} 3/
    );
    assert.doesNotMatch(metrics, /provider-special/);
  });

  it("exports ESL queue depth, capacity, retries, and overflows", async () => {
    configureFreeSwitchEventQueueMetrics(77);
    setFreeSwitchEventQueueDepth(3);
    recordFreeSwitchPersistenceRetry();
    recordFreeSwitchPersistenceOverflow();

    const metrics = await __testing.metrics();

    assert.match(metrics, /outbound_dialer_esl_persistence_queue_capacity 77/);
    assert.match(metrics, /outbound_dialer_esl_persistence_queue_depth 3/);
    assert.match(metrics, /outbound_dialer_esl_persistence_retries_total [1-9][0-9]*/);
    assert.match(metrics, /outbound_dialer_esl_persistence_overflows_total [1-9][0-9]*/);
  });

  it("exports FreeSWITCH active channels and registrations", async () => {
    const commands: string[] = [];
    const config = { FREESWITCH_ESL_ENABLED: true } as AppConfig;

    await __testing.refreshFreeSwitchRuntimeMetrics(config, async (_config, command) => {
      commands.push(command);
      return {
        body: command === "show channels count" ? "\n5 total.\n" : "\n7 total.\n",
        headers: {},
        raw: ""
      };
    });

    const metrics = await __testing.metrics();
    assert.deepEqual(commands, ["show channels count", "show registrations count"]);
    assert.match(metrics, /outbound_dialer_freeswitch_active_channels 5/);
    assert.match(metrics, /outbound_dialer_freeswitch_registrations 7/);
  });

  it("parses FreeSWITCH count responses defensively", () => {
    assert.equal(__testing.parseFreeSwitchCount("0 total."), 0);
    assert.equal(__testing.parseFreeSwitchCount("\n123 total.\n"), 123);
    assert.equal(__testing.parseFreeSwitchCount("-ERR command failed"), 0);
  });
});
