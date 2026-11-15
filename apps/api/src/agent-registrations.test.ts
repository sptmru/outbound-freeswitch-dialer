import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import {
  __testing,
  reconcileAgentRegistrations,
  startAgentRegistrationReconciler
} from "./agent-registrations.js";

const config = {
  FREESWITCH_ESL_ENABLED: true
} as AppConfig;

describe("agent registration reconciliation", () => {
  it(
    "runs the next reconciliation after a premature ESL close and logs the corrected identity",
    { timeout: 2_000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const sockets = new Set<net.Socket>();
      let connections = 0;
      const server = net.createServer((socket) => {
        const attempt = ++connections;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        socket.write("Content-Type: auth/request\n\n");
        socket.on("data", (chunk) => {
          const frame = chunk.toString();
          if (frame.startsWith("auth "))
            socket.write("Content-Type: command/reply\nReply-Text: +OK accepted\n\n");
          else if (frame.startsWith("connect"))
            socket.write("Content-Type: command/reply\nReply-Text: +OK connected\n\n");
          else if (attempt === 1) socket.end();
          else {
            const body = "User: agent1000@dialer.local\nAuth-User: agent1000\n";
            socket.end(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let stop: () => void = () => undefined;
      t.after(async () => {
        stop();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const entries: unknown[] = [];
      let reportFailure!: () => void;
      let reportSuccess!: () => void;
      const failed = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const succeeded = new Promise<void>((resolve) => {
        reportSuccess = resolve;
      });
      const pool = {
        query: async (sql: string) => ({
          rowCount: sql.includes("update agents") ? 1 : 0,
          rows: sql.includes("update agents")
            ? [
                {
                  id: "agent-1",
                  user_id: "user-1",
                  sip_username: "agent1000",
                  registered: true,
                  last_registered_at: null,
                  last_unregistered_at: null,
                  sip_password_encrypted: "private-fixture"
                }
              ]
            : []
        })
      } as unknown as pg.Pool;
      pool.connect = async () =>
        ({ query: pool.query.bind(pool), release: () => undefined }) as unknown as pg.PoolClient;
      stop = startAgentRegistrationReconciler(
        {
          ...config,
          FREESWITCH_ESL_HOST: "127.0.0.1",
          FREESWITCH_ESL_PORT: (server.address() as net.AddressInfo).port,
          FREESWITCH_ESL_PASSWORD: "fixture-only"
        },
        pool,
        {
          warn: () => reportFailure(),
          info: (entry, message) => {
            entries.push(entry);
            if (message === "FreeSWITCH agent registration state reconciled") reportSuccess();
          }
        }
      );
      await failed;
      t.mock.timers.tick(5_000);
      await succeeded;
      assert.equal(connections, 2);
      assert.deepEqual(entries[0], {
        event: "agent_registration_updated",
        source: "reconciliation",
        agentId: "agent-1",
        userId: "user-1",
        sipUsername: "agent1000",
        registered: true,
        lastRegisteredAt: null,
        lastUnregisteredAt: null
      });
      assert.doesNotMatch(JSON.stringify(entries), /private-fixture|sip_password/);
    }
  );

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
        if (sql.includes("from admin_supervisor_endpoints")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (sql.includes("select sip_username")) {
          return Promise.resolve({ rowCount: 1, rows: [{ sip_username: "agent_stale" }] });
        }
        if (sql.includes("telephony_observability_state")) {
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        return Promise.resolve({ rowCount: 2, rows: [] });
      }
    } as unknown as pg.Pool;
    pool.connect = async () =>
      ({ query: pool.query.bind(pool), release: () => undefined }) as unknown as pg.PoolClient;

    const changed = await reconcileAgentRegistrations(config, pool, async (_config, command) => {
      assert.equal(command, "sofia status profile internal-webrtc reg");
      return {
        body: "User: agent_qmj4ws@dialer.sptm.online\nAuth-User: agent_qmj4ws\n",
        headers: {},
        raw: ""
      };
    });

    assert.equal(changed, 2);
    assert.ok(queries.some((q) => q.sql.includes("pg_advisory_xact_lock")));
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
        if (sql.includes("from admin_supervisor_endpoints")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (sql.includes("select sip_username")) {
          return Promise.resolve({ rowCount: 1, rows: [{ sip_username: "agent_qmj4ws" }] });
        }
        if (sql.includes("update agents")) {
          assert.deepEqual(params, [[]]);
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
    } as unknown as pg.Pool;
    pool.connect = async () =>
      ({ query: pool.query.bind(pool), release: () => undefined }) as unknown as pg.PoolClient;

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
    pool.connect = async () =>
      ({ query: pool.query.bind(pool), release: () => undefined }) as unknown as pg.PoolClient;

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
