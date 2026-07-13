import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { finishAgentCall, getAgentAvailability, setAgentAvailability } from "./agent-availability.js";

describe("agent availability", () => {
  it("expires completed wrap-up before returning desk availability", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("select availability_status")) {
        return rows([{ availability_status: "available", wrap_up_until: null }]);
      }
      return rows([]);
    });

    const availability = await getAgentAvailability(pool, "user-1");

    assert.deepEqual(availability, { status: "available", wrapUpUntil: null });
    assert.match(queries[0]?.sql ?? "", /availability_status = 'wrap_up'/);
    assert.match(queries[0]?.sql ?? "", /wrap_up_until <= now\(\)/);
  });

  it("does not change availability while an interactive call is active", async () => {
    const pool = queryPool((sql) => {
      assert.match(sql, /not exists/);
      assert.match(sql, /'agent_released'/);
      return rows([]);
    });

    assert.equal(await setAgentAvailability(pool, "agent-1", "paused"), null);
  });

  it("starts configured wrap-up after an ordinary terminal call", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      return rows([]);
    });

    await finishAgentCall(pool, "agent-1", 30);

    assert.deepEqual(queries[0]?.params, ["agent-1", false, 30]);
    assert.match(queries[0]?.sql ?? "", /then 'wrap_up'/);
    assert.match(queries[0]?.sql ?? "", /make_interval\(secs => \$3::integer\)/);
  });

  it("preserves a pause selected while background voicemail is still playing", async () => {
    let sql = "";
    const pool = queryPool((query) => {
      sql = query;
      return rows([]);
    });

    await finishAgentCall(pool, "agent-1", 30, { skipWrapUp: true });

    assert.ok(sql.indexOf("availability_status = 'paused'") < sql.indexOf("$2::boolean"));
  });
});

function queryPool(
  handler: (sql: string, params: readonly unknown[]) => pg.QueryResult<pg.QueryResultRow>
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T extends pg.QueryResultRow>(items: T[]): pg.QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: items.length,
    oid: 0,
    fields: [],
    rows: items
  };
}
