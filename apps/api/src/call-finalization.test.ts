import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { finalizeCallTransaction, repairFinalizedCallTransaction } from "./call-finalization.js";

describe("transactional call finalization", () => {
  it("commits the call, event, legs, contact, and agent cleanup as one transaction", async () => {
    const queries: Query[] = [];
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: "22222222-2222-4222-8222-222222222222" }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: "22222222-2222-4222-8222-222222222222",
            answered_at: new Date("2026-07-17T06:00:00.000Z"),
            contact_id: "33333333-3333-4333-8333-333333333333",
            ended_at: null,
            outcome: null,
            state: "bridged",
            voicemail_signal_status: "none"
          }
        ]);
      }
      if (sql.includes("returning outcome")) {
        return rows([{ outcome: "customer_hung_up" }]);
      }
      return rows([]);
    });

    const result = await finalizeCallTransaction(pool, {
      callId: "11111111-1111-4111-8111-111111111111",
      event: {
        customerLegUuid: "44444444-4444-4444-8444-444444444444",
        eventType: "freeswitch_channel_hangup",
        freeswitchEventName: "CHANNEL_HANGUP",
        freeswitchEventUuid: "55555555-5555-4555-8555-555555555555",
        raw: { headers: { "event-uuid": "55555555-5555-4555-8555-555555555555" } },
        state: "completed"
      },
      resolve: () => ({ outcome: "customer_hung_up", state: "completed" }),
      terminal: {
        eventAt: new Date("2026-07-17T06:00:01.000Z"),
        eventName: "CHANNEL_HANGUP",
        source: "freeswitch_customer_terminal"
      }
    });

    assert.equal(result.status, "finalized");
    assert.deepEqual(
      queries.map((query) => commandName(query.sql)),
      [
        "begin",
        "find_owner",
        "lock_agent",
        "lock_call",
        "insert_event",
        "finalize_call",
        "end_legs",
        "lock_contact",
        "update_contact",
        "finish_agent",
        "commit"
      ]
    );
    const event = queries.find((query) => query.sql.includes("insert into call_events"));
    assert.match(event?.sql ?? "", /on conflict \(freeswitch_event_uuid\)/);
    assert.equal(event?.params[6], "55555555-5555-4555-8555-555555555555");
  });

  it("rolls back when cleanup fails after the terminal call update", async () => {
    const queries: Query[] = [];
    const failure = Object.assign(new Error("connection lost during contact cleanup"), { code: "08006" });
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: "22222222-2222-4222-8222-222222222222" }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: "22222222-2222-4222-8222-222222222222",
            answered_at: null,
            contact_id: "33333333-3333-4333-8333-333333333333",
            ended_at: null,
            outcome: null,
            state: "customer_dialing",
            voicemail_signal_status: null
          }
        ]);
      }
      if (sql.includes("returning outcome")) {
        return rows([{ outcome: "failed" }]);
      }
      if (sql.includes("update contacts")) {
        throw failure;
      }
      return rows([]);
    });

    await assert.rejects(
      finalizeCallTransaction(pool, {
        callId: "11111111-1111-4111-8111-111111111111",
        resolve: () => ({ outcome: "failed", state: "failed" }),
        terminal: { source: "freeswitch_customer_terminal" }
      }),
      failure
    );

    assert.ok(queries.some((query) => query.sql.includes("update calls")));
    assert.equal(queries.at(-1)?.sql, "rollback");
    assert.ok(!queries.some((query) => query.sql === "commit"));
  });

  it("repairs cleanup on replay without replacing the winning terminal outcome", async () => {
    const queries: Query[] = [];
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: "22222222-2222-4222-8222-222222222222" }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: "22222222-2222-4222-8222-222222222222",
            answered_at: null,
            contact_id: "33333333-3333-4333-8333-333333333333",
            ended_at: new Date("2026-07-17T06:00:00.000Z"),
            outcome: "busy",
            state: "completed",
            voicemail_signal_status: null
          }
        ]);
      }
      return rows([]);
    });

    const result = await finalizeCallTransaction(pool, {
      callId: "11111111-1111-4111-8111-111111111111",
      event: {
        eventType: "freeswitch_channel_hangup_complete",
        freeswitchEventName: "CHANNEL_HANGUP_COMPLETE",
        freeswitchEventUuid: "55555555-5555-4555-8555-555555555555",
        state: "completed"
      },
      persistEventWhenAlreadyFinalized: true,
      resolve: () => ({ outcome: "answered", state: "completed" })
    });

    assert.equal(result.status, "already_finalized");
    assert.equal(result.outcome, "busy");
    assert.ok(queries.some((query) => query.sql.includes("insert into call_events")));
    assert.ok(!queries.some((query) => query.sql.includes("update calls")));
    const contact = queries.find((query) => query.sql.includes("update contacts"));
    assert.deepEqual(contact?.params, [
      "33333333-3333-4333-8333-333333333333",
      "new",
      "11111111-1111-4111-8111-111111111111"
    ]);
    assert.match(contact?.sql ?? "", /not exists/);
    assert.match(contact?.sql ?? "", /active_call\.id <> \$3/);
    assert.ok(queries.some((query) => query.sql.includes("update agents")));
    assert.equal(queries.at(-1)?.sql, "commit");
  });

  it("repairs a terminal state that lost its ended_at write", async () => {
    const queries: Query[] = [];
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: null }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: null,
            answered_at: null,
            contact_id: null,
            ended_at: null,
            outcome: "failed",
            state: "failed",
            voicemail_signal_status: null
          }
        ]);
      }
      if (sql.includes("returning outcome")) {
        return rows([{ outcome: "failed" }]);
      }
      return rows([]);
    });

    assert.equal(await repairFinalizedCallTransaction(pool, "11111111-1111-4111-8111-111111111111"), true);
    const update = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(update?.params.slice(0, 3), [
      "11111111-1111-4111-8111-111111111111",
      "failed",
      "failed"
    ]);
    assert.equal(queries.at(-1)?.sql, "commit");
  });

  it("repairs ended_at with a non-terminal state and missing outcome", async () => {
    const queries: Query[] = [];
    const endedAt = new Date("2026-07-17T06:00:00.000Z");
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: null }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: null,
            answered_at: null,
            contact_id: null,
            ended_at: endedAt,
            outcome: null,
            state: "customer_dialing",
            voicemail_signal_status: null
          }
        ]);
      }
      if (sql.includes("returning outcome")) {
        return rows([{ outcome: "failed" }]);
      }
      return rows([]);
    });

    assert.equal(await repairFinalizedCallTransaction(pool, "11111111-1111-4111-8111-111111111111"), true);
    const update = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(update?.params.slice(0, 3), [
      "11111111-1111-4111-8111-111111111111",
      "failed",
      "failed"
    ]);
    assert.match(update?.sql ?? "", /ended_at = coalesce\(ended_at, stamp\.persisted_at\)/);
    assert.equal(queries.at(-1)?.sql, "commit");
  });

  it("uses a retry-safe outcome when a completed call lost its outcome and end timestamp", async () => {
    const queries: Query[] = [];
    const pool = transactionalPool((sql, params) => {
      queries.push({ params, sql });
      if (sql === "select agent_id from calls where id = $1") {
        return rows([{ agent_id: null }]);
      }
      if (sql.includes("from calls") && sql.includes("for update")) {
        return rows([
          {
            agent_id: null,
            answered_at: null,
            contact_id: null,
            ended_at: null,
            outcome: null,
            state: "completed",
            voicemail_signal_status: null
          }
        ]);
      }
      if (sql.includes("returning outcome")) {
        return rows([{ outcome: "not_answered" }]);
      }
      return rows([]);
    });

    assert.equal(await repairFinalizedCallTransaction(pool, "11111111-1111-4111-8111-111111111111"), true);
    const update = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(update?.params.slice(0, 3), [
      "11111111-1111-4111-8111-111111111111",
      "completed",
      "not_answered"
    ]);
  });
});

interface Query {
  params: readonly unknown[];
  sql: string;
}

function transactionalPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) =>
      Promise.resolve().then(() => handler(sql, params)),
    release: () => undefined
  } as unknown as pg.PoolClient;
  return { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}

function commandName(sql: string): string {
  if (sql === "begin" || sql === "commit" || sql === "rollback") return sql;
  if (sql === "select agent_id from calls where id = $1") return "find_owner";
  if (sql.includes("select id from agents") && sql.includes("for update")) return "lock_agent";
  if (sql.includes("from calls") && sql.includes("for update")) return "lock_call";
  if (sql.includes("insert into call_events")) return "insert_event";
  if (sql.includes("update calls")) return "finalize_call";
  if (sql.includes("update call_legs")) return "end_legs";
  if (sql.includes("select id from contacts") && sql.includes("for update")) return "lock_contact";
  if (sql.includes("update contacts")) return "update_contact";
  if (sql.includes("update agents")) return "finish_agent";
  return "unknown";
}
