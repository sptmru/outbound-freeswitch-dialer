import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing, reconcileAgentRegistrations } from "./agent-registrations.js";

const config = {
  FREESWITCH_ESL_ENABLED: true
} as AppConfig;

describe("agent registration reconciliation", () => {
  it("parses and deduplicates User and Auth-User registration rows", () => {
    assert.deepEqual(
      __testing.parseRegisteredSipUsernames(`
Registrations:
User:       agent_qmj4ws@dialer.sptm.online
Auth-User:  agent_qmj4ws

User:       agent_xgaqxhe@dialer.sptm.online
Auth-User:  agent_xgaqxhe
Total items returned: 2
`),
      ["agent_qmj4ws", "agent_xgaqxhe"]
    );
  });

  it("reconciles database registration and availability state from the live table", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("select sip_username")) {
          return Promise.resolve({ rowCount: 1, rows: [{ sip_username: "agent_stale" }] });
        }
        if (sql.includes("telephony_observability_state")) {
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        return Promise.resolve({ rowCount: 2, rows: [] });
      }
    } as unknown as pg.Pool;

    const changed = await reconcileAgentRegistrations(config, pool, async (_config, command) => {
      assert.equal(command, "sofia status profile internal-webrtc reg");
      return {
        body: "User: agent_qmj4ws@dialer.sptm.online\nAuth-User: agent_qmj4ws\n",
        headers: {},
        raw: ""
      };
    });

    assert.equal(changed, 2);
    assert.equal(queries.length, 3);
    const update = queries.find((query) => query.sql.includes("update agents"));
    assert.deepEqual(update?.params, [["agent_qmj4ws"]]);
    assert.match(update?.sql ?? "", /set registered = sip_username = any\(\$1::text\[\]\)/);
    assert.match(update?.sql ?? "", /last_registered_at/);
    assert.match(update?.sql ?? "", /last_unregistered_at/);
    assert.match(
      update?.sql ?? "",
      /when sip_username = any\(\$1::text\[\]\) and status = 'offline' then 'ready'/
    );
    assert.match(update?.sql ?? "", /then 'offline'/);
    const observability = queries.find((query) => query.sql.includes("registration_drift_count"));
    assert.deepEqual(observability?.params, [1, 1, 2, 2]);
  });

  it("clears stale registrations when FreeSWITCH returns an empty table", async () => {
    const pool = {
      query: (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("select sip_username")) {
          return Promise.resolve({ rowCount: 1, rows: [{ sip_username: "agent_qmj4ws" }] });
        }
        if (sql.includes("update agents")) {
          assert.deepEqual(params, [[]]);
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
    } as unknown as pg.Pool;

    const changed = await reconcileAgentRegistrations(config, pool, async () => ({
      body: "Total items returned: 0\n",
      headers: {},
      raw: ""
    }));

    assert.equal(changed, 1);
  });

  it("calculates registration drift as a symmetric set difference", () => {
    assert.equal(__testing.symmetricDifferenceSize(["agent_a", "agent_b"], ["agent_b", "agent_c"]), 2);
    assert.equal(__testing.symmetricDifferenceSize(["agent_a", "agent_a"], ["agent_a"]), 0);
  });

  it("records a failed reconciliation without replacing the last success timestamp", async () => {
    const queries: string[] = [];
    const pool = {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
    } as unknown as pg.Pool;

    await assert.rejects(
      reconcileAgentRegistrations(config, pool, async () => {
        throw new Error("ESL unavailable");
      }),
      /ESL unavailable/
    );

    const failedState = queries.find((sql) => sql.includes("registration_reconcile_status"));
    assert.match(failedState ?? "", /values \(true, 'failed', now\(\)\)/);
    assert.doesNotMatch(failedState ?? "", /registration_reconciled_at\s*=/);
  });
});
