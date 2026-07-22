import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import {
  persistSupervisorFreeSwitchEvent,
  startSupervisorSession,
  stopSupervisorSession,
  updateSupervisorSessionMode
} from "./supervisor.js";

const actorUserId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const supervisorLegUuid = "44444444-4444-4444-8444-444444444444";
const agentLegUuid = "55555555-5555-4555-8555-555555555555";
const customerLegUuid = "66666666-6666-4666-8666-666666666666";

const config = {
  FREESWITCH_DOMAIN: "dialer.local",
  FREESWITCH_ESL_ENABLED: true
} as AppConfig;

describe("supervisor call control", () => {
  it("validates registration and both target legs before starting listen-only monitoring", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from users") && sql.includes("role = 'admin'")) {
        return rows([{ id: actorUserId }]);
      }
      if (sql.includes("from admin_supervisor_endpoints") && sql.includes("where user_id")) {
        return rows([
          {
            user_id: actorUserId,
            sip_username: "supervisor_test",
            sip_password_encrypted: "unused",
            display_name: "Supervisor"
          }
        ]);
      }
      if (sql.includes("from calls") && sql.includes("join agents") && sql.includes("agents.user_id = $1")) {
        return rows([]);
      }
      if (sql.includes("left join call_legs agent_leg")) {
        return rows([
          {
            id: callId,
            state: "bridged",
            ended_at: null,
            agent_user_id: "77777777-7777-4777-8777-777777777777",
            agent_leg_uuid: agentLegUuid,
            agent_leg_ended_at: null,
            customer_leg_uuid: customerLegUuid,
            customer_leg_ended_at: null
          }
        ]);
      }
      if (sql.includes("insert into call_supervisor_sessions")) {
        return rows([
          {
            id: sessionId,
            call_id: callId,
            mode: "listen",
            state: "connecting",
            started_at: new Date("2026-07-22T08:00:00Z"),
            connected_at: null,
            ended_at: null,
            failure_reason: null,
            supervisor_leg_uuid: supervisorLegUuid
          }
        ]);
      }
      if (sql.includes("update call_supervisor_sessions")) return rows([]);
      if (["begin", "commit", "rollback"].includes(sql) || sql.includes("pg_advisory_xact_lock")) {
        return rows([]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    };
    const pool = poolWithQuery(query);
    const apiCommands: string[] = [];
    const session = await startSupervisorSession(
      pool,
      config,
      { actorUserId, callId },
      {
        createUuid: async () => supervisorLegUuid,
        sendApiCommand: async (_config, command) => {
          apiCommands.push(command);
          return {
            body: command.includes("sofia status") ? "User: supervisor_test@dialer.local\n" : "true\n",
            headers: {},
            raw: ""
          };
        },
        originate: async (_config, input) => {
          assert.equal(input.mode, "listen");
          assert.equal(input.targetAgentLegUuid, agentLegUuid);
          return {
            command: "originate supervisor",
            jobUuid: "88888888-8888-4888-8888-888888888888",
            supervisorLegUuid
          };
        }
      }
    );

    assert.equal(session.mode, "listen");
    assert.deepEqual(apiCommands, [
      "sofia status profile internal-webrtc reg",
      `uuid_exists ${agentLegUuid}`,
      `uuid_exists ${customerLegUuid}`
    ]);
    assert.ok(queries.some((sql) => sql.includes("insert into call_supervisor_sessions")));
  });

  it("marks only the current supervisor leg active or ended", async () => {
    const values: unknown[][] = [];
    const pool = {
      query: async (_sql: string, params?: unknown[]) => {
        values.push(params ?? []);
        return rows([]);
      }
    } as unknown as pg.Pool;

    await persistSupervisorFreeSwitchEvent(pool, {
      eventName: "CHANNEL_ANSWER",
      sessionId,
      supervisorLegUuid
    });
    await persistSupervisorFreeSwitchEvent(pool, {
      eventName: "CHANNEL_HANGUP_COMPLETE",
      sessionId,
      supervisorLegUuid,
      hangupCause: "NORMAL_CLEARING"
    });

    assert.deepEqual(values[0], [sessionId, supervisorLegUuid]);
    assert.deepEqual(values[1], [sessionId, supervisorLegUuid, "NORMAL_CLEARING"]);
  });

  it("does not report a stop until FreeSWITCH confirms the leg is gone", async () => {
    const queries: string[] = [];
    const pool = poolWithQuery(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from call_supervisor_sessions")) {
        return rows([
          {
            id: sessionId,
            call_id: callId,
            mode: "listen",
            state: "active",
            started_at: new Date(),
            connected_at: new Date(),
            ended_at: null,
            failure_reason: null,
            supervisor_leg_uuid: supervisorLegUuid
          }
        ]);
      }
      return rows([]);
    });
    const commands: string[] = [];
    await stopSupervisorSession(pool, config, { actorUserId, sessionId }, async (_config, command) => {
      commands.push(command);
      return { body: command.startsWith("uuid_exists") ? "true" : "+OK", headers: {}, raw: "" };
    });

    assert.deepEqual(commands, [
      `uuid_exists ${supervisorLegUuid}`,
      `uuid_kill ${supervisorLegUuid} NORMAL_CLEARING`
    ]);
    assert.ok(queries.some((sql) => sql.includes("set state = 'ended'")));
  });

  it("leaves the current mode authoritative when FreeSWITCH cannot stop its leg", async () => {
    const queries: string[] = [];
    const pool = poolWithQuery(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from call_supervisor_sessions")) {
        return rows([
          {
            id: sessionId,
            call_id: callId,
            mode: "listen",
            state: "active",
            started_at: new Date(),
            connected_at: new Date(),
            ended_at: null,
            failure_reason: null,
            supervisor_leg_uuid: supervisorLegUuid
          }
        ]);
      }
      if (sql.includes("from admin_supervisor_endpoints") && sql.includes("where user_id")) {
        return rows([
          {
            user_id: actorUserId,
            sip_username: "supervisor_test",
            sip_password_encrypted: "unused",
            display_name: "Supervisor"
          }
        ]);
      }
      if (sql.includes("left join call_legs agent_leg")) {
        return rows([
          {
            id: callId,
            state: "bridged",
            ended_at: null,
            agent_user_id: "77777777-7777-4777-8777-777777777777",
            agent_leg_uuid: agentLegUuid,
            agent_leg_ended_at: null,
            customer_leg_uuid: customerLegUuid,
            customer_leg_ended_at: null
          }
        ]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await assert.rejects(
      updateSupervisorSessionMode(
        pool,
        config,
        { actorUserId, mode: "join", sessionId },
        {
          createUuid: async () => "99999999-9999-4999-8999-999999999999",
          sendApiCommand: async (_config, command) => {
            if (command.includes("sofia status")) {
              return { body: "User: supervisor_test@dialer.local\n", headers: {}, raw: "" };
            }
            if (command === `uuid_kill ${supervisorLegUuid} NORMAL_CLEARING`) {
              throw new Error("ESL command failed");
            }
            return { body: "true", headers: {}, raw: "" };
          }
        }
      ),
      /previous supervisor connection was stopped/
    );

    assert.equal(
      queries.some((sql) => sql.includes("set mode = $3")),
      false
    );
  });

  it("does not replace or clear a supervisor leg while its background originate is pending", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from call_supervisor_sessions")) {
        return rows([
          {
            id: sessionId,
            call_id: callId,
            mode: "listen",
            state: "connecting",
            started_at: new Date(),
            connected_at: null,
            ended_at: null,
            failure_reason: null,
            supervisor_leg_uuid: supervisorLegUuid,
            updated_at: new Date()
          }
        ]);
      }
      if (sql.includes("set state = 'ended'")) return rows([]);
      throw new Error(`Unexpected query: ${sql}`);
    };
    const pool = poolWithQuery(query);

    await assert.rejects(
      updateSupervisorSessionMode(pool, config, { actorUserId, mode: "join", sessionId }),
      /finish connecting before changing mode/
    );
    await assert.rejects(
      stopSupervisorSession(pool, config, { actorUserId, sessionId }, async () => ({
        body: "false",
        headers: {},
        raw: ""
      })),
      /attempt to finish before stopping/
    );

    assert.equal(
      queries.some((sql) => sql.includes("set mode = $3")),
      false
    );
    assert.equal(
      queries.some((sql) => sql.includes("set state = 'ended'")),
      false
    );
  });
});

function rows<T>(items: T[]) {
  return { rowCount: items.length, rows: items };
}

function poolWithQuery(
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>
): pg.Pool {
  const clientQuery = async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("pg_advisory_unlock")) return rows([{ unlocked: true }]);
    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_xact_lock")) return rows([]);
    return query(sql, params);
  };
  return {
    query,
    connect: async () => ({ query: clientQuery, release: () => undefined })
  } as unknown as pg.Pool;
}
