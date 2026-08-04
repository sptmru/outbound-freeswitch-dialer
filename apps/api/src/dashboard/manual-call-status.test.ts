import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { setManualCallStatus, terminalStateForOutcome } from "./manual-call-status.js";

const callId = "44444444-4444-4444-8444-444444444444";
const userId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

describe("manual call status", () => {
  it("maps manual outcomes to consistent terminal states", () => {
    assert.equal(terminalStateForOutcome("answered"), "completed");
    assert.equal(terminalStateForOutcome("not_answered"), "completed");
    assert.equal(terminalStateForOutcome("failed"), "failed");
    assert.equal(terminalStateForOutcome("agent_canceled"), "canceled");
    assert.equal(terminalStateForOutcome("suppressed"), "canceled");
  });

  it("atomically sets and audits the first manual outcome", async () => {
    const lockedAt = new Date("2026-08-04T08:00:00.000Z");
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("from calls") && sql.includes("join agents")) {
        return rows([{ agent_id: agentId }]);
      }
      if (sql.includes("select id from agents")) return rows([{ id: agentId }]);
      if (sql.includes("select state, outcome, ended_at")) {
        return rows([
          {
            state: "failed",
            outcome: "failed",
            ended_at: new Date("2026-08-04T07:59:00.000Z"),
            manual_status_locked_at: null
          }
        ]);
      }
      if (sql.includes("update calls")) {
        return rows([{ state: "completed", outcome: "answered", manual_status_locked_at: lockedAt }]);
      }
      return rows([]);
    });

    const result = await setManualCallStatus(pool, { callId, outcome: "answered", userId });

    assert.deepEqual(result, {
      status: "updated",
      response: {
        callId,
        state: "completed",
        outcome: "answered",
        manualStatusLockedAt: lockedAt.toISOString()
      }
    });
    const update = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(update?.params, [callId, "completed", "answered", userId]);
    assert.match(update?.sql ?? "", /manual_status_locked_at = clock_timestamp\(\)/);
    const event = queries.find((query) => query.sql.includes("manual_status_set"));
    assert.equal(event?.params[1], agentId);
    assert.match(String(event?.params[3]), /"previousOutcome":"failed"/);
    assert.equal(queries.at(-1)?.sql, "commit");
  });

  it("rejects status changes before the call is terminal", async () => {
    const pool = createPool((sql) => {
      if (sql.includes("from calls") && sql.includes("join agents")) {
        return rows([{ agent_id: agentId }]);
      }
      if (sql.includes("select id from agents")) return rows([{ id: agentId }]);
      if (sql.includes("select state, outcome, ended_at")) {
        return rows([
          {
            state: "bridged",
            outcome: null,
            ended_at: null,
            manual_status_locked_at: null
          }
        ]);
      }
      return rows([]);
    });

    assert.deepEqual(await setManualCallStatus(pool, { callId, outcome: "answered", userId }), {
      status: "active"
    });
  });

  it("is idempotent for the same locked outcome and rejects a different one", async () => {
    const lockedAt = new Date("2026-08-04T08:00:00.000Z");
    const makePool = () =>
      createPool((sql) => {
        if (sql.includes("from calls") && sql.includes("join agents")) {
          return rows([{ agent_id: agentId }]);
        }
        if (sql.includes("select id from agents")) return rows([{ id: agentId }]);
        if (sql.includes("select state, outcome, ended_at")) {
          return rows([
            {
              state: "completed",
              outcome: "answered",
              ended_at: lockedAt,
              manual_status_locked_at: lockedAt
            }
          ]);
        }
        return rows([]);
      });

    assert.deepEqual(await setManualCallStatus(makePool(), { callId, outcome: "answered", userId }), {
      status: "already_set",
      response: {
        callId,
        state: "completed",
        outcome: "answered",
        manualStatusLockedAt: lockedAt.toISOString()
      }
    });
    assert.deepEqual(await setManualCallStatus(makePool(), { callId, outcome: "busy", userId }), {
      status: "locked"
    });
  });
});

function createPool(handler: (sql: string, params: readonly unknown[]) => pg.QueryResult<never>): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params)),
    release: () => undefined
  };
  return {
    connect: () => Promise.resolve(client)
  } as unknown as pg.Pool;
}

function rows<T extends object>(items: T[]): pg.QueryResult<never> {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: items.length,
    rows: items
  } as unknown as pg.QueryResult<never>;
}
