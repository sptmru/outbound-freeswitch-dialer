import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import type pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import {
  supervisorFixture,
  limitedExecutor,
  supervisorHttp,
  mockSupervisorEsl
} from "../../../tests/fixtures/inbound/supervisor.mjs";
import {
  admitSupervisorMutation,
  supervisorExecutor,
  persistCoordinatedSupervisorEvent,
  settleSupervisor
} from "./supervisor-coordination.js";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { defaultCapacityLimits } from "./call-capacity.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use isolated runner" : false,
  timeout: 60000
};
const fixture = () => supervisorFixture(databaseConfig(testDatabaseUrl()));
const request = (a: any, callId: string) => ({
  action: "start" as const,
  actorUserId: a.userId,
  actorAuthVersion: a.version,
  callId,
  key: randomUUID(),
  endpoint: a.endpoint
});
async function record(name: string, value: unknown) {
  if (process.env.INBOUND_TEST_ARTIFACTS)
    await writeFile(`${process.env.INBOUND_TEST_ARTIFACTS}/c07-${name}.json`, JSON.stringify(value, null, 2));
}

test(
  "C07.2 real HTTP/C03 start, mode replacement, exact old-event fencing, stop, replay and native capacity",
  options,
  async () => {
    const f = await fixture(),
      actor = await f.actor(),
      s = await f.seed(),
      ex = await limitedExecutor(f, databaseConfig(testDatabaseUrl()));
    const live = new Set([s.agentUuid, s.customerUuid]);
    const peer = await mockSupervisorEsl(
      async (command: string) => {
        const isOrig = command.startsWith("bgapi originate"),
          leg = isOrig ? command.match(/origination_uuid=([a-f0-9-]+)/)![1] : command.split(" ")[2];
        const op = (
          await f.pool.query("select * from call_operations where target_uuid=$1 and command_kind=$2", [
            leg,
            isOrig ? "originate" : "hangup"
          ])
        ).rows[0];
        if (isOrig) live.add(leg);
        else live.delete(leg);
        await persistCoordinatedSupervisorEvent(f.pool, {
          sessionId: op.request.supervisorSessionId,
          supervisorLegUuid: leg,
          eventName: isOrig ? "CHANNEL_ANSWER" : "CHANNEL_HANGUP_COMPLETE"
        });
        return "+OK\n";
      },
      { contact: () => actor.endpoint.route, exists: (id: string) => live.has(id) }
    );
    const config = {
      FREESWITCH_DOMAIN: "fixture.invalid",
      FREESWITCH_ESL_HOST: peer.host,
      FREESWITCH_ESL_PORT: peer.port,
      FREESWITCH_ESL_PASSWORD: peer.password,
      FREESWITCH_ESL_ENABLED: true
    } as AppConfig;
    const adapter = supervisorExecutor(
      f.pool,
      ex.executor,
      config,
      peer,
      async (cmd) => (await sendFreeSwitchApiCommand(config, cmd)).body
    );
    const http = await supervisorHttp(f, actor, { config, adapter });
    try {
      const key = randomUUID(),
        start = await http.api("start", s.callId, { key });
      assert.equal(start.statusCode, 201, start.body);
      const id = start.json().id;
      let session = (await f.pool.query("select * from call_supervisor_sessions where id=$1", [id])).rows[0];
      assert.equal(session.state, "active");
      assert.equal(session.mode, "listen");
      const old = session.supervisor_leg_uuid;
      assert.equal((await http.api("start", s.callId, { key })).json().id, id);
      assert.equal(peer.sent.length, 1);
      assert.equal(
        (await http.api("start", s.callId)).statusCode,
        409,
        "another key is refused rather than creating an unrecorded successful alias"
      );
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
            [id]
          )
        ).rows[0].n,
        1
      );
      const changed = await http.api("mode", id, { mode: "whisper" });
      assert.equal(changed.statusCode, 200, changed.body);
      session = (await f.pool.query("select * from call_supervisor_sessions where id=$1", [id])).rows[0];
      assert.equal(session.state, "active");
      assert.equal(session.mode, "whisper");
      assert.equal(session.generation, "2");
      assert.notEqual(session.supervisor_leg_uuid, old);
      assert.equal(live.has(old), false);
      assert.equal(peer.sent.length, 3);
      assert.match(peer.sent[2], /eavesdrop_whisper_bleg=true/);
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: id,
        supervisorLegUuid: old,
        eventName: "CHANNEL_ANSWER"
      });
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: id,
        supervisorLegUuid: old,
        eventName: "CHANNEL_HANGUP_COMPLETE"
      });
      assert.equal(
        (await f.pool.query("select state from call_supervisor_sessions where id=$1", [id])).rows[0].state,
        "active"
      );
      const join = await http.api("mode", id, { mode: "join" });
      assert.equal(join.statusCode, 200, join.body);
      assert.equal(peer.sent.length, 5);
      assert.match(peer.sent[4], /eavesdrop_whisper_aleg=true/);
      const stopKey = randomUUID(),
        stopped = await http.api("stop", id, { key: stopKey });
      assert.equal(stopped.statusCode, 204, stopped.body);
      assert.equal((await http.api("stop", id, { key: stopKey })).statusCode, 204);
      assert.equal(peer.sent.length, 6);
      assert.equal(
        (await f.pool.query("select state from call_supervisor_sessions where id=$1", [id])).rows[0].state,
        "ended"
      );
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
            [id]
          )
        ).rows[0].n,
        0
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
          .state,
        "reserved"
      );
      assert.equal(
        (await f.pool.query("select ended_at from calls where id=$1", [s.callId])).rows[0].ended_at,
        null
      );
      const unauthorized = await http.api("start", s.callId, { headers: {} });
      assert.equal(unauthorized.statusCode, 401);
      await record("supervisor-http", {
        sent: peer.sent,
        sessions: (await f.pool.query("select * from call_supervisor_sessions")).rows,
        legs: (await f.pool.query("select * from supervisor_leg_evidence")).rows
      });
    } finally {
      await http.close();
      await peer.close();
      await ex.close();
      await f.cleanup();
    }
  }
);

test(
  "C07.2 unresolved supervisor sender retains endpoint/capacity; fixed job plus exact channel reconciles without resend",
  options,
  async () => {
    const f = await fixture(),
      a = await f.actor(),
      s = await f.seed(),
      ex = await limitedExecutor(f, databaseConfig(testDatabaseUrl()));
    const peer = await mockSupervisorEsl(async () => "+OK\n", {
      contact: () => a.endpoint.route,
      exists: () => true
    });
    const config = { FREESWITCH_DOMAIN: "fixture.invalid" } as AppConfig;
    const adapter = supervisorExecutor(f.pool, ex.executor, config, peer, async (cmd) =>
      cmd.startsWith("sofia_contact") ? a.endpoint.route : "true"
    );
    try {
      const admission = await admitSupervisorMutation(f.pool, request(a, s.callId));
      await adapter.wakeExecutor(admission.rootId);
      const op = (await f.pool.query("select * from call_operations where id=$1", [admission.rootId]))
        .rows[0];
      assert.equal(op.state, "uncertain");
      assert.equal(peer.sent.length, 1);
      await settleSupervisor(f.pool, s.callId);
      assert.equal(
        (await f.pool.query("select state from call_supervisor_sessions where id=$1", [admission.session.id]))
          .rows[0].state,
        "connecting"
      );
      await assert.rejects(
        admitSupervisorMutation(f.pool, {
          action: "stop",
          actorUserId: a.userId,
          actorAuthVersion: a.version,
          sessionId: admission.session.id,
          key: randomUUID()
        }),
        /finish/
      );
      assert.equal(
        (
          await f.pool.query(
            "select 1 from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
            [admission.session.id]
          )
        ).rowCount,
        1
      );
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: admission.session.id,
        supervisorLegUuid: op.target_uuid,
        eventName: "CHANNEL_ANSWER"
      });
      await adapter.wakeExecutor(admission.rootId);
      assert.equal(
        (await f.pool.query("select state from call_operations where id=$1", [op.id])).rows[0].state,
        "succeeded"
      );
      assert.equal(peer.sent.length, 1);
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: admission.session.id,
        supervisorLegUuid: op.target_uuid,
        eventName: "CHANNEL_HANGUP"
      });
      assert.equal(
        (await f.pool.query("select state from call_supervisor_sessions where id=$1", [admission.session.id]))
          .rows[0].state,
        "active",
        "HANGUP alone does not attest media cleanup"
      );
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: admission.session.id,
        supervisorLegUuid: op.target_uuid,
        eventName: "CHANNEL_HANGUP_COMPLETE"
      });
      assert.equal(
        (await f.pool.query("select state from call_supervisor_sessions where id=$1", [admission.session.id]))
          .rows[0].state,
        "ended"
      );
      await record("supervisor-uncertainty", { operation: op, physicalSends: peer.sent.length });
    } finally {
      await peer.close();
      await ex.close();
      await f.cleanup();
    }
  }
);

function worker(schema: string, input: object) {
  const child = fork(
    new URL("../../../tests/fixtures/inbound/admission-worker.mjs", import.meta.url),
    [schema, JSON.stringify(input)],
    {
      env: { PATH: process.env.PATH, TEST_DATABASE_URL: testDatabaseUrl() },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    }
  );
  const messages: any[] = [],
    done = once(child, "exit");
  let notify: (() => void) | undefined;
  let error: Error | undefined;
  child.on("message", (m) => {
    messages.push(m);
    notify?.();
  });
  child.on("error", (e) => {
    error = e;
    notify?.();
  });
  return {
    child,
    done,
    async wait(type: string) {
      const deadline = Date.now() + 5000;
      while (true) {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return messages.splice(i, 1)[0];
        if (error) throw error;
        assert.ok(Date.now() < deadline, `worker ${type}: ${JSON.stringify(messages)}`);
        await new Promise<void>((r) => {
          const t = setTimeout(r, 20);
          notify = () => {
            clearTimeout(t);
            r();
          };
        });
      }
    }
  };
}

test(
  "C07.2 supervisor versus pre-SIP Desk in separate processes: both commit orders and either rollback; one endpoint claim",
  options,
  async () => {
    const evidence = [];
    for (const first of ["supervisor", "desk"])
      for (const rollback of [false, true]) {
        const f = await fixture(),
          a = await f.actor(),
          s = await f.seed();
        const deskCall = (
          await f.pool.query(
            "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
            [f.campaignId]
          )
        ).rows[0].id;
        const w = worker(f.schema, {
          agentId: a.agentId,
          userId: a.userId,
          campaignId: a.campaignId,
          deskSessionId: a.deskSessionId,
          expectedRevision: "1",
          bindingGeneration: "1",
          callId: deskCall,
          key: randomUUID()
        });
        const client = await f.pool.connect(),
          pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
        let held!: () => void, go!: () => void;
        const holding = new Promise<void>((r) => (held = r)),
          release = new Promise<void>((r) => (go = r));
        const pool = {
          connect: async () => ({
            query: async (sql: string, params?: any[]) => {
              if (sql === "commit" && first === "supervisor") {
                held();
                await release;
                if (rollback) throw new Error("fixture_rollback");
              }
              return client.query(sql, params);
            },
            release: () => undefined
          })
        } as unknown as pg.Pool;
        let attempt: Promise<any> | undefined;
        try {
          const ready = await w.wait("ready");
          assert.notEqual(ready.pid, process.pid);
          if (first === "supervisor") {
            attempt = admitSupervisorMutation(pool, request(a, s.callId)).catch((e) => ({
              error: e.message
            }));
            await holding;
            w.child.send({ type: "go" });
            await assertBlocked(f.pool, ready.backend, pid);
            go();
            await attempt;
            if (rollback) {
              await w.wait("before-commit");
              w.child.send({ type: "commit" });
              await w.wait("committed");
            } else assert.equal((await w.wait("rejected")).reason, "supervisor_session");
          } else {
            w.child.send({ type: "go" });
            await w.wait("before-commit");
            attempt = admitSupervisorMutation(pool, request(a, s.callId)).catch((e) => ({
              error: e.message
            }));
            await assertBlocked(f.pool, pid, ready.backend);
            w.child.send({ type: rollback ? "rollback" : "commit" });
            await w.wait(rollback ? "rejected" : "committed");
            const result = await attempt;
            if (!rollback) assert.match(result.error, /own Agent Desk/);
          }
          await w.done;
          const supervisorWon = (first === "supervisor" && !rollback) || (first === "desk" && rollback);
          assert.equal(
            (
              await f.pool.query(
                "select count(*)::int as n from call_supervisor_sessions where state in ('connecting','active')"
              )
            ).rows[0].n,
            supervisorWon ? 1 : 0
          );
          assert.equal(
            (await f.pool.query("select state from agent_call_slots where agent_id=$1", [a.agentId])).rows[0]
              .state,
            supervisorWon ? "free" : "reserved"
          );
          assert.equal(
            (
              await f.pool.query(
                "select count(*)::int as n from call_capacity_reservations where resource_type='supervisor_channel' and state<>'released'"
              )
            ).rows[0].n,
            supervisorWon ? 1 : 0
          );
          evidence.push({ first, rollback, supervisorWon, backend: ready.backend, process: ready.pid });
        } finally {
          go();
          if (w.child.exitCode === null && w.child.signalCode === null) {
            w.child.kill("SIGKILL");
            await w.done;
          }
          await attempt;
          client.release();
          await f.cleanup();
        }
      }
    await record("supervisor-desk-races", evidence);
  }
);

test(
  "C07.2 concurrent supervisors compete for one native channel permit; rejected and stale commands never send",
  options,
  async () => {
    const f = await fixture(),
      a = await f.actor(),
      b = await f.actor(),
      s = await f.seed();
    const db = await f.pool.connect();
    try {
      const { withCallAdmission } = await import("./call-admission.js");
      await withCallAdmission(db, { callIds: [s.callId] }, async (admission) => {
        await admission.capacity.configure({ ...defaultCapacityLimits, supervisor: 1 });
      });
      const results = await Promise.allSettled([
        admitSupervisorMutation(f.pool, request(a, s.callId)),
        admitSupervisorMutation(f.pool, request(b, s.callId))
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      const first = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>;
      const ex = await limitedExecutor(f, databaseConfig(testDatabaseUrl()));
      const peer = await mockSupervisorEsl(async () => "-ERR rejected\n");
      const adapter = supervisorExecutor(
        f.pool,
        ex.executor,
        { FREESWITCH_DOMAIN: "fixture.invalid" } as AppConfig,
        peer,
        async (cmd) => (cmd.startsWith("sofia_contact") ? "different contact" : "false")
      );
      try {
        await adapter.wakeExecutor(first.value.rootId);
        assert.equal(peer.sent.length, 0, "changed registration fenced before physical originate");
        assert.equal(
          (await f.pool.query("select state from call_operations where id=$1", [first.value.rootId])).rows[0]
            .state,
          "failed"
        );
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where supervisor_session_id is not null and state<>'released'"
            )
          ).rows[0].n,
          0
        );
        const rejected = await admitSupervisorMutation(f.pool, request(a, s.callId));
        const rejectAdapter = supervisorExecutor(
          f.pool,
          ex.executor,
          { FREESWITCH_DOMAIN: "fixture.invalid" } as AppConfig,
          peer,
          async (cmd) =>
            cmd.startsWith("sofia_contact")
              ? a.endpoint.route
              : cmd.includes(s.agentUuid) || cmd.includes(s.customerUuid)
                ? "true"
                : "false"
        );
        await rejectAdapter.wakeExecutor(rejected.rootId);
        assert.equal(peer.sent.length, 1);
        assert.equal(
          (await f.pool.query("select state from call_operations where id=$1", [rejected.rootId])).rows[0]
            .state,
          "failed"
        );
        assert.equal(
          (
            await f.pool.query("select state from call_supervisor_sessions where id=$1", [
              rejected.session.id
            ])
          ).rows[0].state,
          "failed"
        );
        await record("supervisor-capacity", {
          results: results.map((r) => r.status),
          physicalSends: peer.sent.length
        });
      } finally {
        await peer.close();
        await ex.close();
      }
    } finally {
      db.release();
      await f.cleanup();
    }
  }
);

test(
  "C07.3 maintenance/supervisor and campaign-audio/release mixed locks: both commit orders and either rollback",
  options,
  async () => {
    const { lockCampaignVoicemail } = await import("./dashboard/recordings.js");
    const { persistCoordinatedCallEvent } = await import("./call-cleanup.js");
    const evidence = [];
    for (const pair of [
      ["maintenance", "supervisor"],
      ["audio", "release"]
    ])
      for (const reverse of [false, true])
        for (const rollback of [false, true]) {
          const f = await fixture(),
            a = await f.actor(),
            s = await f.seed();
          await f.pool.query(
            "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict(key) do update set value_json='false'"
          );
          const clients = await Promise.all([f.pool.connect(), f.pool.connect()]);
          const pids = await Promise.all(
            clients.map(async (c) => (await c.query("select pg_backend_pid() pid")).rows[0].pid)
          );
          let held!: () => void, go!: () => void;
          const holding = new Promise<void>((r) => (held = r)),
            release = new Promise<void>((r) => (go = r));
          function wrapped(index: number) {
            return {
              query: f.pool.query.bind(f.pool),
              connect: async () => ({
                query: async (sql: string, params?: any[]) => {
                  if (sql === "commit" && index === 0) {
                    held();
                    await release;
                    if (rollback) throw new Error("fixture_rollback");
                  }
                  return clients[index].query(sql, params);
                },
                release: () => {}
              })
            } as unknown as pg.Pool;
          }
          async function action(kind: string, pool: pg.Pool) {
            if (kind === "supervisor") return admitSupervisorMutation(pool, request(a, s.callId));
            if (kind === "release")
              return persistCoordinatedCallEvent(pool, {
                callId: s.callId,
                legUuid: s.agentUuid,
                eventName: "CHANNEL_HANGUP_COMPLETE",
                eventUuid: randomUUID()
              });
            const db = await pool.connect();
            try {
              await db.query("begin");
              await db.query("set local lock_timeout='250ms'");
              await db.query("set local statement_timeout='500ms'");
              if (kind === "audio") await lockCampaignVoicemail(db, f.campaignId);
              else
                await db.query(
                  "update system_settings set value_json='true' where key='ops.call_start_paused'"
                );
              await db.query("commit");
              return kind;
            } catch (e) {
              await db.query("rollback");
              throw e;
            } finally {
              db.release();
            }
          }
          const order = reverse ? [...pair].reverse() : pair;
          let first: Promise<any> | undefined, second: Promise<any> | undefined;
          try {
            first = action(order[0], wrapped(0)).catch((e) => ({ error: e.message }));
            await holding;
            second = action(order[1], wrapped(1)).catch((e) => ({ error: e.message }));
            await assertBlocked(f.pool, pids[1], pids[0]);
            go();
            const results = await Promise.all([first, second]);
            assert.equal(Boolean(results[0]?.error), rollback);
            if (pair[0] === "maintenance" && !reverse) assert.equal(Boolean(results[1]?.error), !rollback);
            else assert.equal(Boolean(results[1]?.error), false, JSON.stringify(results));
            const slot = (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId]))
              .rows[0];
            assert.equal(
              slot.state,
              pair[0] === "audio" && !(order[0] === "release" && rollback) ? "free" : "reserved"
            );
            evidence.push({
              order,
              rollback,
              pids,
              first: results[0]?.error ?? "committed",
              second: results[1]?.error ?? "committed",
              slot: slot.state
            });
          } finally {
            go();
            await first;
            await second;
            clients.forEach((c) => c.release());
            await f.cleanup();
          }
        }
    await record("mixed-locks", evidence);
  }
);

test(
  "C07 migration 032 preserves active legacy sessions, upgrade history and replay; native leg evidence is immutable",
  options,
  async () => {
    const f = await fixture(),
      a = await f.actor(),
      s = await f.seed();
    try {
      const legacy = (
        await f.pool.query(
          "insert into call_supervisor_sessions(call_id,actor_user_id,mode,state,supervisor_leg_uuid,target_agent_leg_uuid,target_customer_leg_uuid) values($1,$2,'listen','active',$3,$4,$5) returning *",
          [s.callId, a.userId, randomUUID(), s.agentUuid, s.customerUuid]
        )
      ).rows[0];
      await f.pool.query(
        `drop table supervisor_leg_evidence;drop function guard_supervisor_leg_evidence();alter table call_supervisor_sessions drop column coordination_protocol,drop column generation,drop column control_root_id;delete from schema_migrations where filename='032_supervisor_coordination.sql'`
      );
      const history = (
        await f.pool.query(
          "select * from schema_migrations where filename<'032_supervisor_coordination.sql' order by filename"
        )
      ).rows;
      const { runMigrations } = await import("./db.js");
      await runMigrations(f.pool);
      await runMigrations(f.pool);
      const upgraded = (await f.pool.query("select * from call_supervisor_sessions where id=$1", [legacy.id]))
        .rows[0];
      for (const [key, value] of Object.entries(legacy)) assert.deepEqual(upgraded[key], value);
      assert.equal(upgraded.coordination_protocol, "legacy");
      assert.equal(upgraded.control_root_id, null);
      assert.deepEqual(
        (
          await f.pool.query(
            "select * from schema_migrations where filename<'032_supervisor_coordination.sql' order by filename"
          )
        ).rows,
        history
      );
      const b = await f.actor(),
        native = await admitSupervisorMutation(f.pool, request(b, s.callId));
      const leg = (
        await f.pool.query("select * from supervisor_leg_evidence where session_id=$1", [native.session.id])
      ).rows[0];
      await assert.rejects(
        f.pool.query(
          "update supervisor_leg_evidence set generation=generation+1 where supervisor_leg_uuid=$1",
          [leg.supervisor_leg_uuid]
        ),
        { code: "23514" }
      );
      await persistCoordinatedSupervisorEvent(f.pool, {
        sessionId: native.session.id,
        supervisorLegUuid: leg.supervisor_leg_uuid,
        eventName: "CHANNEL_DESTROY"
      });
      await assert.rejects(
        f.pool.query(
          "update supervisor_leg_evidence set ended_at=null,terminal_evidence=null where supervisor_leg_uuid=$1",
          [leg.supervisor_leg_uuid]
        ),
        { code: "23514" }
      );
      await record("migration", { legacy, upgraded, historyPreserved: true, terminalImmutable: true });
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "C07.3 user removal preserves occupied recipient/supervisor endpoints and revokes free controller work",
  options,
  async () => {
    const { __testing: auth } = await import("./auth/routes.js");
    const { withCallAdmission } = await import("./call-admission.js");
    for (const kind of ["recipient", "supervisor", "free"]) {
      const f = await fixture(),
        a = await f.actor(),
        s = await f.seed();
      try {
        if (kind === "recipient") {
          const db = await f.pool.connect();
          try {
            await withCallAdmission(
              db,
              { agentIds: [a.agentId], callIds: [s.callId], campaignIds: [f.campaignId] },
              (admission) =>
                admission.reserve(
                  {
                    agentId: a.agentId,
                    userId: a.userId,
                    campaignId: f.campaignId,
                    deskSessionId: a.deskSessionId,
                    expectedRevision: "1",
                    bindingGeneration: "1"
                  },
                  s.callId
                )
            );
          } finally {
            db.release();
          }
        } else if (kind === "supervisor") await admitSupervisorMutation(f.pool, request(a, s.callId));
        else
          await f.pool.query(
            "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key) values($1,$2,$3,$4,1,$5)",
            [a.agentId, s.callId, f.campaignId, a.deskSessionId, randomUUID()]
          );
        const result = await auth.deleteUser(
          f.pool,
          { FREESWITCH_ESL_ENABLED: false } as AppConfig,
          a.userId,
          { onProvisioningError: () => {} }
        );
        assert.equal(
          result,
          kind === "recipient" ? "active_call" : kind === "supervisor" ? "active_supervisor" : "deleted"
        );
        const desk = (await f.pool.query("select * from agent_desk_sessions where id=$1", [a.deskSessionId]))
          .rows[0];
        assert.equal(desk.ready, kind !== "free");
        assert.equal(Boolean(desk.revoked_at), kind === "free");
        const slot = (await f.pool.query("select * from agent_call_slots where agent_id=$1", [a.agentId]))
          .rows[0];
        assert.equal(slot.state, kind === "recipient" ? "reserved" : "free");
        if (kind === "free")
          assert.equal(
            (await f.pool.query("select state from agent_auto_next_intents where agent_id=$1", [a.agentId]))
              .rows[0].state,
            "canceled"
          );
      } finally {
        await f.cleanup();
      }
    }
  }
);
