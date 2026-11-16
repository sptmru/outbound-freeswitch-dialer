import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { importIngressRecord } from "./inbound-ingress.js";
import type { IngressRecord } from "./ingress-journal.js";
import { admitInboundQueue, persistInboundQueueEvent } from "./inbound-queue.js";
import { withCallAdmission } from "./call-admission.js";
import { dispatchInboundOffers, ignoreInboundOffer } from "./inbound-dispatcher.js";
import { registerCallOfferRoutes } from "./dashboard/call-offers.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "./security.js";
import type { AppConfig } from "./config.js";
import { acceptInboundOffer } from "./inbound-acceptance.js";
import { settleInboundConnection, validateInboundConnection } from "./inbound-connection.js";
import { admitManualOutbound } from "./manual-outbound.js";
import { type DurableCommand } from "./call-executor.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const schema = `e02_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const config = databaseConfig(testDatabaseUrl(), schema);
  const pool = new pg.Pool({ ...config, max: 8 });
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  const campaign = (
    await pool.query(
      "insert into campaigns(name,status,auto_advance_to_next_lead_enabled) values('E02','active',true) returning id"
    )
  ).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'E02') returning id", [campaign])
  ).rows[0].id;
  const journalId = randomUUID();
  const row = (changes: Partial<IngressRecord> = {}): IngressRecord => ({
    uuid: randomUUID(),
    journalId,
    sequence: 1,
    arrivedUs: Date.now() * 1000 - 1000000,
    did: "+12025550100",
    routeRevision: "1",
    numberId: randomUUID(),
    queueId: queue,
    queueRevision: "1",
    campaignId: campaign,
    timeoutMs: 60000,
    routeData: Buffer.from(
      JSON.stringify({
        queue_timeout_ms: 60000,
        max_waiting_calls: 40,
        no_answer_flow_version_id: randomUUID()
      })
    ).toString("base64url"),
    callingNumber: "unknown",
    terminalUs: null,
    terminalReason: null,
    ...changes
  });
  const seed = async (changes: Partial<IngressRecord> = {}) => {
    const r = row(changes);
    await importIngressRecord(pool, r);
    return r;
  };
  async function end(id: string, event = "CHANNEL_DESTROY", cause = "NORMAL_CLEARING") {
    await persistInboundQueueEvent(pool, {
      variable_outbound_dialer_ingress_uuid: id,
      "unique-id": id,
      "event-name": event,
      "event-uuid": randomUUID(),
      "hangup-cause": cause
    });
  }
  async function agent() {
    const user = (
      await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'E02','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const id = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','E02',true) returning id",
        [user, randomUUID()]
      )
    ).rows[0].id;
    const session = (
      await pool.query(
        "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at,actor_auth_version) values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp(),1) returning id",
        [id, campaign, randomUUID()]
      )
    ).rows[0].id;
    await pool.query(
      "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
      [id]
    );
    return { id, user, session };
  }
  return {
    pool,
    config,
    campaign,
    queue,
    row,
    seed,
    end,
    agent,
    async cleanup() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Agent = Awaited<ReturnType<Fixture["agent"]>>;
const actor = (agent: Agent) => ({ userId: agent.user, agentId: agent.id, authVersion: 1 });
const mutation = (agent: Agent) => ({
  deskSessionId: agent.session,
  expectedRevision: "1",
  bindingGeneration: "1",
  idempotencyKey: randomUUID()
});
async function queued(f: Fixture, changes: Partial<IngressRecord> = {}) {
  const r = await f.seed(changes);
  const op = await admitInboundQueue(f.pool, r.uuid);
  await f.pool.query(
    "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='synthetic waiting fixture; no FS proof' where id=$1",
    [op!.id]
  );
  return r.uuid;
}
async function worker(f: Fixture, a: Agent, offerId: string, hold = false) {
  const child = fork(
    new URL("../../../tests/fixtures/inbound/accept-worker.mjs", import.meta.url),
    [JSON.stringify({ config: f.config, actor: actor(a), offerId, intent: mutation(a), hold })],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  // The worker imports the same compiled product entry point in its own OS process.
  const messages: Array<Record<string, any>> = [];
  let wake: (() => void) | undefined,
    output = "",
    exited = false;
  child.stderr!.on("data", (b) => (output += b));
  child.on("message", (m) => {
    messages.push(m as Record<string, any>);
    wake?.();
  });
  const exit = once(child, "exit").then(([code]) => {
    exited = true;
    wake?.();
    assert.equal(code, 0, output);
  });
  return {
    child,
    exit,
    send: (type: string, extra = {}) => child.send({ type, ...extra }),
    async wait(type: string) {
      const deadline = Date.now() + 10000;
      while (true) {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return messages.splice(i, 1)[0];
        assert.ok(!exited, output);
        assert.ok(Date.now() < deadline, `worker ${type}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  };
}
async function counts(f: Fixture) {
  return (
    await f.pool.query(`select
    (select count(*)::int from inbound_connection_attempts) attempts,
    (select count(*)::int from call_participants where role='agent') participants,
    (select count(*)::int from agent_call_slots where state<>'free') slots,
    (select count(*)::int from call_operations where command_kind='originate') originates,
    (select count(*)::int from contacts where attempt_count>0) contacts,
    (select count(*)::int from call_execution_attempts) sends`)
  ).rows[0];
}
test(
  "E02.1 DB: twenty independent claimants have one winner and fixed intent; duplicate keys/response replay",
  options,
  async () => {
    const f = await fixture(),
      workers: Awaited<ReturnType<typeof worker>>[] = [];
    try {
      const callId = await queued(f),
        agents: Agent[] = [],
        offers: string[] = [];
      for (let i = 0; i < 20; i++) {
        const a = await f.agent();
        agents.push(a);
        offers.push((await dispatchInboundOffers(f.pool, a.id))!.id);
      }
      for (let i = 0; i < 20; i++) workers.push(await worker(f, agents[i], offers[i], i === 0));
      const ready = await Promise.all(workers.map((w) => w.wait("ready")));
      assert.equal(new Set(ready.map((r) => r.backend)).size, 20);
      workers[0].send("start");
      await workers[0].wait("claimed");
      for (const w of workers.slice(1)) w.send("start");
      await Promise.all(ready.slice(1).map((r) => assertBlocked(f.pool, r.backend, ready[0].backend)));
      assert.deepEqual(await counts(f), {
        attempts: 0,
        participants: 0,
        slots: 0,
        originates: 0,
        contacts: 0,
        sends: 0
      });
      workers[0].send("finish");
      const results = await Promise.all(workers.map((w) => w.wait("result")));
      assert.equal(
        results.filter((r) => r.result?.status === "connecting").length,
        1,
        JSON.stringify(results)
      );
      assert.ok(
        results
          .slice(1)
          .every((r) => ["offer_closed", "coordination_unavailable"].includes(r.result?.conflict)),
        JSON.stringify(results)
      );
      assert.deepEqual(await counts(f), {
        attempts: 1,
        participants: 1,
        slots: 1,
        originates: 1,
        contacts: 0,
        sends: 0
      });
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_offers where state='canceled' and reason='winner_accepted'"
          )
        ).rows[0].n,
        19
      );
      const response = results[0].result,
        input = mutation(agents[0]);
      assert.deepEqual(await acceptInboundOffer(f.pool, actor(agents[0]), offers[0], input), response);
      assert.deepEqual(await acceptInboundOffer(f.pool, actor(agents[0]), offers[0], input), response);
      await assert.rejects(
        acceptInboundOffer(f.pool, actor(agents[0]), offers[0], { ...input, expectedRevision: "2" }),
        /idempotency_conflict/
      );
      assert.equal(
        (await f.pool.query("select agent_connected_at from calls where id=$1", [callId])).rows[0]
          .agent_connected_at,
        null
      );
    } finally {
      await Promise.all(workers.map((w) => w.exit));
      await f.cleanup();
    }
  }
);

test(
  "E02.2 DB: acceptance/timeout/hangup/other-call both commit orders and leading rollback",
  options,
  async () => {
    for (const transition of ["timeout", "hangup", "other-call"] as const)
      for (const acceptFirst of [true, false])
        for (const rollback of [false, true]) {
          const f = await fixture();
          let leader: pg.PoolClient | undefined, follower: pg.PoolClient | undefined;
          let release = () => {};
          try {
            const a = await f.agent(),
              callId = await queued(f),
              offer = (await dispatchInboundOffers(f.pool, a.id))!,
              input = mutation(a);
            const second = transition === "other-call" ? await queued(f) : null;
            let held!: () => void;
            const hold = new Promise<void>((r) => (release = r)),
              claimed = new Promise<void>((r) => (held = r));
            leader = await f.pool.connect();
            follower = await f.pool.connect();
            const leaderPid = (await leader.query("select pg_backend_pid() pid")).rows[0].pid;
            const followerPid = (await follower.query("select pg_backend_pid() pid")).rows[0].pid;
            // Route both domain functions through fixed real sessions so the barrier is observable.
            const facade = (c: pg.PoolClient) =>
              ({
                query: f.pool.query.bind(f.pool),
                connect: async () =>
                  Object.assign(Object.create(c), { query: c.query.bind(c), release: () => {} })
              }) as unknown as pg.Pool;
            const acceptance = (pool: pg.Pool, checkpoint?: () => Promise<void>) =>
              acceptInboundOffer(pool, actor(a), offer.id, input, checkpoint);
            const rival = async (pool: pg.Pool, checkpoint?: () => Promise<void>) => {
              const db = await pool.connect();
              try {
                return await withCallAdmission(
                  db,
                  { callIds: [callId, ...(second ? [second] : [])], agentIds: [a.id] },
                  async (admission) => {
                    const call = (await db.query("select * from calls where id=$1", [callId])).rows[0];
                    if (transition === "timeout" && call.state === "queued")
                      await db.query(
                        "update calls set state='fallback',fallback_started_at=clock_timestamp() where id=$1",
                        [callId]
                      );
                    if (transition === "hangup")
                      await db.query(
                        "update calls set state='completed',ended_at=clock_timestamp(),inbound_end_reason='customer_hung_up' where id=$1",
                        [callId]
                      );
                    if (transition === "other-call") {
                      const d = await admission.eligibility({
                        ...actor(a),
                        campaignId: f.campaign,
                        ...input
                      });
                      if (d.eligible)
                        await admission.reserve({ ...actor(a), campaignId: f.campaign, ...input }, second!);
                    }
                    await checkpoint?.();
                    return { rival: true };
                  }
                );
              } finally {
                db.release();
              }
            };
            const first = (acceptFirst ? acceptance : rival)(facade(leader), async () => {
              held();
              await hold;
              if (rollback) throw new Error("leading_rollback");
            });
            const firstResult = first.catch((e) => ({ error: e.message }));
            await Promise.race([
              claimed,
              firstResult.then((result) => {
                throw new Error(
                  `Leader ended before checkpoint ${transition}/${acceptFirst}/${rollback}: ${JSON.stringify(result)}`
                );
              })
            ]);
            const next = (async () => {
              for (let i = 0; i < 3; i++) {
                try {
                  return await (acceptFirst ? rival : acceptance)(facade(follower));
                } catch (e) {
                  if (e instanceof Error && e.message === "discovery_changed" && i < 2) continue;
                  throw e;
                }
              }
            })();
            await assertBlocked(f.pool, followerPid, leaderPid);
            release();
            await firstResult;
            await next;
            const state = (await f.pool.query("select * from calls where id=$1", [callId])).rows[0];
            const n = await counts(f);
            assert.ok(n.slots <= 1);
            if (transition === "hangup") assert.ok(state.ended_at || (!acceptFirst && rollback));
            if (transition === "timeout" && !acceptFirst && !rollback) {
              assert.equal(state.state, "fallback");
              assert.equal(n.attempts, 0);
            }
            if (acceptFirst && !rollback && transition !== "hangup") assert.equal(n.attempts, 1);
            if (!acceptFirst && rollback) assert.equal(n.attempts, 1);
          } finally {
            release();
            leader?.release(true);
            follower?.release(true);
            await f.cleanup();
          }
        }
  }
);

test(
  "E02.2 DB/API: actual manual outbound admission and failed admission preserve arbitration",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        callId = await queued(f),
        offer = (await dispatchInboundOffers(f.pool, a.id))!;
      await f.pool.query("update campaigns set manual_dialing_enabled=true where id=$1", [f.campaign]);
      const request = {
        actorUserId: a.user,
        actorAuthVersion: 1,
        route: "/agent/manual-dial/start" as const,
        campaignId: f.campaign,
        phoneNumber: "+14155550199",
        intent: { ...mutation(a), startReason: "manual" as const }
      };
      const config = {
        DEFAULT_PHONE_COUNTRY_CODE: "US",
        CONTACT_MAX_ATTEMPTS: 3,
        CONTACT_RETRY_DELAY_SECONDS: 900
      } as unknown as AppConfig;
      await admitManualOutbound(f.pool, config, request);
      assert.equal(
        ((await acceptInboundOffer(f.pool, actor(a), offer.id, mutation(a))) as { conflict: string })
          .conflict,
        "slot_occupied"
      );
      assert.equal(
        (await f.pool.query("select state from calls where id=$1", [callId])).rows[0].state,
        "queued"
      );
      assert.equal(
        (await f.pool.query("select count(*)::int n from inbound_connection_attempts")).rows[0].n,
        0
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E02.3 DB/API: authenticated connecting before send; replay, wrong owner, stale binding, early/duplicate bridge",
  options,
  async () => {
    const f = await fixture();
    const app = Fastify();
    try {
      const a = await f.agent(),
        b = await f.agent(),
        callId = await queued(f),
        offer = (await dispatchInboundOffers(f.pool, a.id))!,
        input = mutation(a);
      const config = {
        JWT_EXPIRES_SECONDS: 3600,
        JWT_SECRET: "e02-test-secret-at-least-32-characters",
        PUBLIC_APP_URL: "https://example.test",
        corsOrigins: []
      } as unknown as AppConfig;
      await app.register(cookie);
      registerCookieCsrfProtection(app, config);
      app.setErrorHandler((error, _request, reply) =>
        reply
          .code(error instanceof ZodError ? 400 : 500)
          .send({ message: error instanceof Error ? error.message : String(error) })
      );
      let wakes = 0;
      registerCallOfferRoutes(app, config, f.pool, {
        async wakeExecutor() {
          wakes++;
        }
      });
      const token = signAuthToken(config, { sub: a.user, role: "agent", ver: 1, email: "e02@example.test" });
      const url = `/agent/call-offers/${offer.id}/accept`,
        headers = { authorization: `Bearer ${token}` };
      assert.equal(
        (await app.inject({ method: "POST", url, headers, payload: { ...input, agentId: b.id } })).statusCode,
        400
      );
      assert.equal(
        (await app.inject({ method: "POST", url, headers, payload: { ...input, bindingGeneration: "2" } }))
          .statusCode,
        409
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
            payload: input
          })
        ).statusCode,
        403
      );
      const disabled = Fastify();
      try {
        registerCallOfferRoutes(disabled, config, f.pool);
        const denied = await disabled.inject({ method: "POST", url, headers, payload: input });
        assert.equal(denied.statusCode, 409);
        assert.equal(denied.json().code, "coordination_unavailable");
        assert.equal((await counts(f)).attempts, 0);
        assert.equal(
          (await f.pool.query("select state from call_offers where id=$1", [offer.id])).rows[0].state,
          "pending"
        );
      } finally {
        await disabled.close();
      }
      const response = await app.inject({ method: "POST", url, headers, payload: input });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "connecting");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(wakes, 1);
      const op = (
        await f.pool.query("select * from call_operations where id=$1", [response.json().operationId])
      ).rows[0] as DurableCommand;
      const uuid = String(op.request.agentUuid);
      const bridge = async () =>
        persistInboundQueueEvent(f.pool, {
          variable_outbound_dialer_ingress_uuid: callId,
          "unique-id": callId,
          "event-name": "CHANNEL_BRIDGE",
          "event-uuid": randomUUID(),
          "other-leg-unique-id": uuid
        });
      await bridge();
      assert.equal(
        (await f.pool.query("select agent_connected_at from calls where id=$1", [callId])).rows[0]
          .agent_connected_at,
        null
      );
      const db = await f.pool.connect();
      try {
        await withCallAdmission(db, { callIds: [callId] }, async (a) => {
          assert.equal(await validateInboundConnection(op, a), true);
        });
      } finally {
        db.release();
      }
      const x = (await f.pool.query("select * from inbound_connection_attempts")).rows[0];
      await f.pool.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,1,0,0)",
        [x.bridge_operation_id, randomUUID()]
      );
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [x.bridge_operation_id]);
      await bridge();
      const connected = (await f.pool.query("select * from calls where id=$1", [callId])).rows[0];
      assert.equal(connected.state, "agent_connected");
      assert.ok(connected.agent_connected_at);
      await bridge();
      assert.equal(
        (
          await f.pool.query("select agent_connected_at from calls where id=$1", [callId])
        ).rows[0].agent_connected_at.getTime(),
        connected.agent_connected_at.getTime()
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [a.id])).rows[0].state,
        "active"
      );
      assert.deepEqual(
        (await app.inject({ method: "POST", url, headers, payload: input })).json(),
        response.json()
      );
      assert.equal((await counts(f)).originates, 1);
      await assert.rejects(acceptInboundOffer(f.pool, actor(b), offer.id, mutation(b)), /not_owner/);
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

test(
  "E02.4 DB: never-sent cleanup, uncertainty blocks reuse, bounded backoff/requeue retains capacity/exclusions",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        b = await f.agent(),
        expiredAgent = await f.agent(),
        callId = await queued(f);
      const ignored = (await dispatchInboundOffers(f.pool, b.id))!;
      await ignoreInboundOffer(f.pool, actor(b), ignored.id, mutation(b));
      await f.pool.query(
        `insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,created_at)
        values($1,'inbound',$2,1,$3,1,1,clock_timestamp()-interval '1 second',clock_timestamp()-interval '20 seconds')`,
        [callId, expiredAgent.id, expiredAgent.session]
      );
      const original = (
        await f.pool.query("select arrived_at,queue_deadline_at from calls where id=$1", [callId])
      ).rows[0];
      let lastRoot: string | undefined;
      for (let n = 1; n <= 3; n++) {
        await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [
          a.session
        ]);
        const offer = (await dispatchInboundOffers(f.pool, a.id))!;
        assert.ok(offer);
        const result = await acceptInboundOffer(f.pool, actor(a), offer.id, mutation(a));
        assert.ok("operationId" in result);
        lastRoot = result.operationId;
        if (n === 1) {
          await f.pool.query(
            "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,1,0,0)",
            [lastRoot, randomUUID()]
          );
          await f.pool.query("update call_operations set state='uncertain' where id=$1", [lastRoot]);
          await settleInboundConnection(f.pool, lastRoot);
          assert.equal((await counts(f)).slots, 1);
          assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
          await f.pool.query(
            "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='synthetic exact sender/job failure' where id=$1",
            [lastRoot]
          );
          const p = (
            await f.pool.query(
              "select participant_id from inbound_connection_attempts where operation_id=$1",
              [lastRoot]
            )
          ).rows[0].participant_id;
          await f.pool.query(
            "update call_legs set state='ended',ended_at=clock_timestamp() where participant_id=$1",
            [p]
          );
          await f.pool.query(
            "update call_participants set left_at=clock_timestamp(),end_reason='synthetic terminal' where id=$1",
            [p]
          );
        } else
          await f.pool.query(
            "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='never attempted fixture cancellation' where id=$1",
            [lastRoot]
          );
        await settleInboundConnection(f.pool, lastRoot);
        assert.equal((await counts(f)).slots, 0);
        assert.equal(
          (await f.pool.query("select status from agents where id=$1", [a.id])).rows[0].status,
          "ready"
        );
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where call_id=$1 and resource_type='queue_waiting' and state<>'released'",
              [callId]
            )
          ).rows[0].n,
          1
        );
        assert.deepEqual(
          (await f.pool.query("select arrived_at,queue_deadline_at from calls where id=$1", [callId]))
            .rows[0],
          original
        );
        assert.equal(await dispatchInboundOffers(f.pool, b.id), null);
        assert.equal(await dispatchInboundOffers(f.pool, expiredAgent.id), null);
        if (n < 3) {
          assert.equal(await dispatchInboundOffers(f.pool, a.id), null); // original fixed cooldown
          const deadline = Date.now() + 2000;
          while (
            !(
              await f.pool.query(
                "select retry_at<=clock_timestamp() due from inbound_connection_attempts where operation_id=$1",
                [lastRoot]
              )
            ).rows[0].due
          ) {
            assert.ok(Date.now() < deadline);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
      assert.equal(
        (await f.pool.query("select state from calls where id=$1", [callId])).rows[0].state,
        "fallback"
      );
      assert.equal((await counts(f)).attempts, 3);
      assert.equal((await f.pool.query("select count(*)::int n from call_offer_exclusions")).rows[0].n, 2);
      assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      assert.ok(lastRoot);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E02.2 DB: actual manual producer versus inbound accept, both lock orders and rollback",
  options,
  async () => {
    for (const manualFirst of [true, false])
      for (const rollback of [false, true]) {
        const f = await fixture();
        let leader: pg.PoolClient | undefined, follower: pg.PoolClient | undefined;
        let release = () => {};
        try {
          const a = await f.agent(),
            callId = await queued(f),
            offer = (await dispatchInboundOffers(f.pool, a.id))!,
            input = mutation(a);
          await f.pool.query("update campaigns set manual_dialing_enabled=true where id=$1", [f.campaign]);
          leader = await f.pool.connect();
          follower = await f.pool.connect();
          const pid = (await leader.query("select pg_backend_pid() pid")).rows[0].pid,
            otherPid = (await follower.query("select pg_backend_pid() pid")).rows[0].pid;
          let held!: () => void;
          const hold = new Promise<void>((r) => (release = r)),
            claimed = new Promise<void>((r) => (held = r));
          const facade = (c: pg.PoolClient, checkpoint = false) =>
            ({
              query: f.pool.query.bind(f.pool),
              connect: async () =>
                Object.assign(Object.create(c), {
                  release: () => {},
                  query: async (sql: string, values?: unknown[]) => {
                    if (sql === "commit" && checkpoint) {
                      held();
                      await hold;
                      if (rollback) throw new Error("leading_rollback");
                    }
                    return c.query(sql, values);
                  }
                })
            }) as unknown as pg.Pool;
          const manual = (pool: pg.Pool) =>
            admitManualOutbound(
              pool,
              {
                DEFAULT_PHONE_COUNTRY_CODE: "US",
                CONTACT_MAX_ATTEMPTS: 3,
                CONTACT_RETRY_DELAY_SECONDS: 900
              } as AppConfig,
              {
                actorUserId: a.user,
                actorAuthVersion: 1,
                route: "/agent/manual-dial/start",
                campaignId: f.campaign,
                phoneNumber: "+14155550199",
                intent: { ...input, startReason: "manual" }
              }
            );
          const accept = (pool: pg.Pool) => acceptInboundOffer(pool, actor(a), offer.id, input);
          const first = (manualFirst ? manual : accept)(facade(leader, true)).catch((e) => ({
            error: e.message
          }));
          await Promise.race([
            claimed,
            first.then((r) => {
              throw new Error(`leader failed: ${JSON.stringify(r)}`);
            })
          ]);
          const next = (manualFirst ? accept : manual)(facade(follower)).catch((e) => ({ error: e.message }));
          await assertBlocked(f.pool, otherPid, pid);
          release();
          const one = await first,
            two = await next;
          if (rollback) assert.ok("error" in one && one.error === "leading_rollback");
          else assert.ok(!("error" in one), JSON.stringify(one));
          const acceptWins = manualFirst ? rollback : !rollback;
          assert.equal((await counts(f)).attempts, acceptWins ? 1 : 0);
          assert.equal((await counts(f)).slots, 1);
          const call = (await f.pool.query("select * from calls where id=$1", [callId])).rows[0];
          assert.equal(call.state, acceptWins ? "connecting" : "queued");
          if (!rollback && !manualFirst) assert.ok("error" in two && two.error === "slot_occupied");
          if (rollback) assert.ok(!("error" in two), JSON.stringify(two));
        } finally {
          release();
          leader?.release(true);
          follower?.release(true);
          await f.cleanup();
        }
      }
  }
);

test(
  "E02 DB: capacity/backlog refusal rolls back all winner side effects and preserves the pending offer",
  options,
  async () => {
    for (const kind of ["capacity", "backlog"]) {
      const f = await fixture();
      try {
        const a = await f.agent(),
          callId = await queued(f),
          offer = (await dispatchInboundOffers(f.pool, a.id))!;
        if (kind === "capacity")
          await f.pool.query(`insert into system_settings(key,value_json) values('calls.capacity_limits',
        '{"queue":40,"channels":1,"trunk":32,"forwarding":4,"supervisor":4,"transferOverlap":4,"fsChannels":80,"fsTrunk":40,"preAdmission":8}')`);
        else
          await f.pool.query(
            `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at)
        select $1,'e02-backlog',n::text,repeat('0',64),'originate',1,gen_random_uuid(),clock_timestamp()+interval '1 hour' from generate_series(1,48)n`,
            [callId]
          );
        const before = await counts(f);
        await assert.rejects(
          acceptInboundOffer(f.pool, actor(a), offer.id, mutation(a)),
          kind === "capacity" ? /capacity_exceeded/ : /execution_backlog_full/
        );
        assert.deepEqual(await counts(f), before);
        assert.equal(
          (await f.pool.query("select state from call_offers where id=$1", [offer.id])).rows[0].state,
          "pending"
        );
        assert.equal(
          (await f.pool.query("select state from calls where id=$1", [callId])).rows[0].state,
          "queued"
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_offer_accept_mutations")).rows[0].n,
          0
        );
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "E02 migration 038: populated 037 upgrade, immutable identity, unchanged flags/history and terminal replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        callId = await queued(f),
        offer = (await dispatchInboundOffers(f.pool, a.id))!,
        input = mutation(a);
      await f.pool.query(`drop table call_offer_accept_mutations;drop table inbound_connection_attempts;
      drop function preserve_inbound_accept_mutation();drop function preserve_inbound_connection();
      delete from schema_migrations where filename='038_inbound_acceptance.sql'`);
      const tables = [
        "calls",
        "call_offers",
        "call_participants",
        "call_legs",
        "agent_call_slots",
        "call_capacity_reservations",
        "system_settings",
        "call_admission_migration",
        "schema_migrations"
      ];
      const before = Object.fromEntries(
        await Promise.all(tables.map(async (t) => [t, (await f.pool.query(`select * from ${t}`)).rows]))
      );
      await runMigrations(f.pool);
      for (const t of tables)
        assert.deepEqual(
          (
            await f.pool.query(
              t === "schema_migrations"
                ? "select * from schema_migrations where filename<'038_inbound_acceptance.sql'"
                : `select * from ${t}`
            )
          ).rows,
          before[t],
          t
        );
      const result = await acceptInboundOffer(f.pool, actor(a), offer.id, input);
      assert.ok("operationId" in result);
      await assert.rejects(f.pool.query("update inbound_connection_attempts set attempt=2"), /identity/);
      await assert.rejects(
        f.pool.query("update call_offer_accept_mutations set request_fingerprint=repeat('1',64)"),
        /identity/
      );
      await assert.rejects(f.pool.query("delete from call_offer_accept_mutations"), /identity/);
      await settleInboundConnection(f.pool, result.operationId); // initial pending deadline is live; no implicit failure
      assert.equal((await counts(f)).slots, 1);
      await f.end(callId);
      await settleInboundConnection(f.pool, result.operationId);
      await f.pool.query(
        "update agent_desk_sessions set revoked_at=clock_timestamp(),ready=false where id=$1",
        [a.session]
      );
      assert.deepEqual(await acceptInboundOffer(f.pool, actor(a), offer.id, input), result);
      assert.equal((await counts(f)).originates, 1);
      await runMigrations(f.pool);
    } finally {
      await f.cleanup();
    }
  }
);
