import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { __testing, dropVoicemailForCall } from "./calls.js";

const callId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const agentLegUuid = "33333333-3333-4333-8333-333333333333";
const customerLegUuid = "44444444-4444-4444-8444-444444444444";

describe("call lifecycle", () => {
  it("waits beyond FreeSWITCH originate timeouts and uses a short transient retry delay", () => {
    const config = {
      ORIGINATE_AGENT_WATCHDOG_SECONDS: 35,
      ORIGINATE_CUSTOMER_WATCHDOG_SECONDS: 50,
      ORIGINATE_WATCHDOG_RETRY_SECONDS: 5
    } as AppConfig;
    assert.equal(__testing.originateWatchdogDelayMilliseconds(config, "agent", false), 35_000);
    assert.equal(__testing.originateWatchdogDelayMilliseconds(config, "customer", false), 50_000);
    assert.equal(__testing.originateWatchdogDelayMilliseconds(config, "agent", true), 5_000);
  });

  it("prefers the agent Caller ID and falls back to the global trunk Caller ID", () => {
    assert.equal(__testing.resolveOutboundCallerId(" 15551112222 ", "15550000000"), "15551112222");
    assert.equal(__testing.resolveOutboundCallerId(null, " 15550000000 "), "15550000000");
    assert.equal(__testing.resolveOutboundCallerId("", ""), null);
  });

  it("does not fail voicemail background playback when the agent leg was intentionally released", async () => {
    for (const state of [
      "voicemail_drop_requested",
      "voicemail_playback_started",
      "agent_released",
      "voicemail_playback_completed"
    ] as const) {
      const queries: Query[] = [];
      const commands: string[] = [];
      const pool = {
        query: (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          return Promise.resolve(rows([{ ended_at: null, state }]));
        }
      } as unknown as pg.Pool;

      await __testing.closeMissingOriginateLeg(
        pool,
        {} as AppConfig,
        {
          agentId: userId,
          agentLegUuid,
          callId,
          customerLegUuid,
          jobUuid: "55555555-5555-4555-8555-555555555555"
        },
        "agent",
        0,
        async (_config, command) => {
          commands.push(command);
          return { body: "false", headers: {}, raw: "" };
        }
      );

      assert.equal(queries.length, 1, state);
      assert.deepEqual(commands, [], state);
    }
  });

  it("selects never-attempted contacts before retryable contacts and enforces retry limits", async () => {
    const queries: Query[] = [];
    const client = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve(rows([]));
      }
    } as unknown as pg.PoolClient;

    await __testing.getNextCallableContactForUpdate(client, "campaign-1", {
      maxAttempts: 3,
      retryDelaySeconds: 900
    });

    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0]?.params, ["campaign-1", 3, 900]);
    assert.match(queries[0]?.sql ?? "", /attempt_count < \$2/);
    assert.match(queries[0]?.sql ?? "", /make_interval\(secs => \$3\)/);
    assert.match(queries[0]?.sql ?? "", /last_attempted_at asc nulls first/);
    assert.match(queries[0]?.sql ?? "", /for update of contacts skip locked/);
  });

  it("applies retry limits to an explicitly selected contact", async () => {
    const queries: Query[] = [];
    const client = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve(rows([]));
      }
    } as unknown as pg.PoolClient;

    await __testing.getCallableContactForUpdate(
      client,
      "contact-1",
      {
        maxAttempts: 5,
        retryDelaySeconds: 60
      },
      false,
      false
    );

    assert.deepEqual(queries[0]?.params, ["contact-1", false, 5, 60, false]);
    assert.match(queries[0]?.sql ?? "", /contacts\.status = 'completed' and \$2 = true/);
    assert.match(queries[0]?.sql ?? "", /attempt_count < \$3/);
    assert.match(queries[0]?.sql ?? "", /last_attempted_at <=/);
  });

  it("allows an explicitly confirmed contact during the retry cooldown", async () => {
    const queries: Query[] = [];
    const client = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve(rows([]));
      }
    } as unknown as pg.PoolClient;

    await __testing.getCallableContactForUpdate(
      client,
      "contact-1",
      {
        maxAttempts: 5,
        retryDelaySeconds: 60
      },
      false,
      true
    );

    assert.deepEqual(queries[0]?.params, ["contact-1", false, 5, 60, true]);
    assert.match(queries[0]?.sql ?? "", /\$5 = true/);
    assert.match(queries[0]?.sql ?? "", /contacts\.attempt_count < \$3/);
  });

  it("claims a voicemail drop without ending the customer call before playback completes", async () => {
    const poolQueries: Query[] = [];
    const clientQueries: Query[] = [];
    const commands: string[] = [];
    const call = voicemailDropRow();
    const pool = createTransactionalPool({
      poolHandler: (sql, params) => {
        poolQueries.push({ sql, params });
        if (sql.includes("from calls")) {
          return rows([call]);
        }
        return rows([]);
      },
      clientHandler: (sql, params) => {
        clientQueries.push({ sql, params });
        if (sql.includes("from recordings") && sql.includes("for key share")) {
          return rows([{ runtime_file_path: "/recordings/default.wav" }]);
        }
        if (sql.includes("from calls")) {
          return rows([call]);
        }
        if (sql.includes("update calls")) {
          return rows([{}]);
        }
        return rows([]);
      }
    });

    const result = await dropVoicemailForCall(
      pool,
      {} as AppConfig,
      userId,
      callId,
      undefined,
      async (_config, command) => {
        commands.push(command);
        return { body: "+OK", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(commands, [
      `uuid_setvar ${customerLegUuid} voicemail_drop_call_id ${callId}`,
      `uuid_setvar ${customerLegUuid} voicemail_drop_file /recordings/default.wav`,
      `uuid_transfer ${customerLegUuid} voicemail_drop XML default`,
      `uuid_kill ${agentLegUuid}`
    ]);
    const claim = clientQueries.find((query) => query.sql.includes("update calls"));
    assert.match(claim?.sql ?? "", /state = 'voicemail_drop_requested'/);
    assert.doesNotMatch(claim?.sql ?? "", /ended_at\s*=/);
    assert.doesNotMatch(claim?.sql ?? "", /outcome\s*=/);
    assert.ok(clientQueries.some((query) => query.sql.includes("'voicemail_drop_requested'")));
    assert.ok(!clientQueries.some((query) => query.sql.includes("update call_legs")));
    assert.ok(!clientQueries.some((query) => query.sql.includes("update agents")));
    assert.ok(!clientQueries.some((query) => query.sql.includes("update contacts")));
    assert.ok(poolQueries.some((query) => query.sql.includes("update call_legs")));
    assert.ok(poolQueries.some((query) => query.sql.includes("update agents")));
  });

  it("treats a repeated voicemail drop request as idempotent", async () => {
    let connectCalls = 0;
    const pool = {
      query: () => Promise.resolve(rows([voicemailDropRow({ state: "voicemail_drop_requested" })])),
      connect: () => {
        connectCalls += 1;
        throw new Error("duplicate request must not open a transaction");
      }
    } as unknown as pg.Pool;

    const result = await dropVoicemailForCall(pool, {} as AppConfig, userId, callId);

    assert.deepEqual(result, { ok: true });
    assert.equal(connectCalls, 0);
  });
});

interface Query {
  params: readonly unknown[];
  sql: string;
}

function voicemailDropRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "55555555-5555-4555-8555-555555555555",
    agent_leg_uuid: agentLegUuid,
    contact_id: "66666666-6666-4666-8666-666666666666",
    customer_leg_uuid: customerLegUuid,
    effective_recording_id: "77777777-7777-4777-8777-777777777777",
    ended_at: null,
    outcome: null,
    runtime_file_path: "/recordings/default.wav",
    selected_recording_id: null,
    state: "bridged",
    ...overrides
  };
}

function createTransactionalPool(input: {
  clientHandler: (sql: string, params: readonly unknown[]) => QueryResult;
  poolHandler: (sql: string, params: readonly unknown[]) => QueryResult;
}): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(input.clientHandler(sql, params)),
    release: () => undefined
  } as unknown as pg.PoolClient;
  return {
    connect: () => Promise.resolve(client),
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(input.poolHandler(sql, params))
  } as unknown as pg.Pool;
}

interface QueryResult {
  rowCount: number;
  rows: unknown[];
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
