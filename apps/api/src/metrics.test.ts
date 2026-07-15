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

describe("application metrics", () => {
  it("counts only calls with confirmed voicemail playback completion", async () => {
    const queries: string[] = [];
    const pool = {
      query: (sql: string) => {
        queries.push(sql);
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
    assert.deepEqual(queryParameters.at(-1)?.[0], [
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
