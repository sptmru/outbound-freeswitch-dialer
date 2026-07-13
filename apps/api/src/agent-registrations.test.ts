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
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0]?.params, [["agent_qmj4ws"]]);
    assert.match(queries[0]?.sql ?? "", /set registered = sip_username = any\(\$1::text\[\]\)/);
    assert.match(queries[0]?.sql ?? "", /last_registered_at/);
    assert.match(queries[0]?.sql ?? "", /last_unregistered_at/);
    assert.match(queries[0]?.sql ?? "", /when sip_username = any\(\$1::text\[\]\) and status = 'offline' then 'ready'/);
    assert.match(queries[0]?.sql ?? "", /then 'offline'/);
  });

  it("clears stale registrations when FreeSWITCH returns an empty table", async () => {
    const pool = {
      query: (_sql: string, params: readonly unknown[] = []) => {
        assert.deepEqual(params, [[]]);
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
});
