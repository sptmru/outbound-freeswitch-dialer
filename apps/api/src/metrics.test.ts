import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
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
});
