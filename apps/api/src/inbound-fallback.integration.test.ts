import Fastify from "fastify";
import { registerCallOfferRoutes } from "./dashboard/call-offers.js";
import { signAuthToken } from "./auth/tokens.js";
import type { AppConfig } from "./config.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { importIngressRecord } from "./inbound-ingress.js";
import type { IngressRecord } from "./ingress-journal.js";
import { admitInboundQueue, persistInboundQueueEvent } from "./inbound-queue.js";
import { dispatchInboundOffers } from "./inbound-dispatcher.js";
import { acceptInboundOffer } from "./inbound-acceptance.js";
import {
  advanceInboundFallback,
  resolveInboundFallback,
  persistInboundFallbackJob,
  persistInboundFallbackEvent,
  inboundFallbackCommand
} from "./inbound-fallback.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const schema = `f03_${randomUUID().replaceAll("-", "")}`;
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
      "insert into campaigns(name,status,auto_advance_to_next_lead_enabled) values('F03','active',true) returning id"
    )
  ).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'F03') returning id", [campaign])
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
        "insert into users(email,name,role,password_hash) values($1,'F03','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const id = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','F03',true) returning id",
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
async function due(f: Fixture, id: string) {
  const end = Date.now() + 20000;
  while (
    !(await f.pool.query("select queue_deadline_at<=clock_timestamp() as due from calls where id=$1", [id]))
      .rows[0].due
  ) {
    assert.ok(Date.now() < end, "original deadline elapsed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function flow(f: Fixture) {
  const r = (
    await f.pool.query(
      `insert into recordings(campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes) values($1,'F03','/tmp/f03.wav','/a02/f03.wav',1,16044) returning id`,
      [f.campaign]
    )
  ).rows[0];
  const p = (
    await f.pool.query("insert into inbound_flows(campaign_id,name) values($1,'F03') returning id", [
      f.campaign
    ])
  ).rows[0];
  const v = (
    await f.pool.query(
      `insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot) values($1,$2,1,20000,$3,'[]') returning *`,
      [
        p.id,
        f.campaign,
        JSON.stringify([
          { type: "play_audio", recordingId: r.id, timeoutMs: 5000 },
          { type: "play_audio", recordingId: r.id, timeoutMs: 5000 },
          { type: "hangup" }
        ])
      ]
    )
  ).rows[0];
  return v;
}
async function withFlow(f: Fixture, remainingMs = 1500) {
  const v = await flow(f);
  const id = await queued(f, {
    arrivedUs: Date.now() * 1000 - (60000 - remainingMs) * 1000,
    routeData: Buffer.from(
      JSON.stringify({ queue_timeout_ms: 60000, max_waiting_calls: 40, no_answer_flow_version_id: v.id })
    ).toString("base64url")
  });
  return { id, v };
}
const settle = async (f: Fixture, op: any, state = "succeeded") =>
  f.pool.query(
    "update call_operations set state=$2,result='{}',resolved_at=clock_timestamp(),resolution_evidence='synthetic fixed job/effect fixture' where id=$1",
    [op.id, state]
  );
test(
  "F03.1 DB: real acceptance versus fallback in both lock orders, delayed timer and HTTP replay",
  options,
  async () => {
    for (const acceptFirst of [true, false]) {
      const f = await fixture();
      let release = () => {};
      let leader: pg.PoolClient | undefined, follower: pg.PoolClient | undefined;
      try {
        const { id } = await withFlow(f, 12000),
          a = await f.agent(),
          offer = (await dispatchInboundOffers(f.pool, a.id))!,
          input = mutation(a);
        leader = await f.pool.connect();
        follower = await f.pool.connect();
        const leaderPid = (await leader.query("select pg_backend_pid() pid")).rows[0].pid,
          followerPid = (await follower.query("select pg_backend_pid() pid")).rows[0].pid;
        const facade = (c: pg.PoolClient) =>
          ({
            query: f.pool.query.bind(f.pool),
            connect: async () =>
              Object.assign(Object.create(c), { query: c.query.bind(c), release: () => {} })
          }) as pg.Pool;
        let held!: () => void;
        const ready = new Promise<void>((r) => (held = r)),
          hold = new Promise<void>((r) => (release = r));
        if (!acceptFirst) await due(f, id);
        const first = acceptFirst
          ? acceptInboundOffer(facade(leader), actor(a), offer.id, input, async () => {
              held();
              await hold;
            })
          : advanceInboundFallback(facade(leader), id, async () => {
              held();
              await hold;
            });
        await Promise.race([
          ready,
          first.then(() => {
            throw new Error("leader missed checkpoint");
          })
        ]);
        const second = acceptFirst
          ? advanceInboundFallback(facade(follower), id)
          : acceptInboundOffer(facade(follower), actor(a), offer.id, input);
        await assertBlocked(f.pool, followerPid, leaderPid);
        release();
        await first;
        await second;
        const c = (await f.pool.query("select * from calls where id=$1", [id])).rows[0];
        assert.equal(c.state, acceptFirst ? "connecting" : "fallback");
        const app = Fastify();
        try {
          const config = {
            JWT_EXPIRES_SECONDS: 3600,
            JWT_SECRET: "f03-test-secret-at-least-32-characters",
            PUBLIC_APP_URL: "https://example.test",
            corsOrigins: []
          } as unknown as AppConfig;
          let wakes = 0;
          registerCallOfferRoutes(app, config, f.pool, {
            async wakeExecutor() {
              wakes++;
            }
          });
          const token = signAuthToken(config, {
            sub: a.user,
            role: "agent",
            ver: 1,
            email: "f03@example.test"
          });
          for (let retry = 0; retry < 2; retry++) {
            const response = await app.inject({
              method: "POST",
              url: `/agent/call-offers/${offer.id}/accept`,
              headers: { authorization: `Bearer ${token}` },
              payload: input
            });
            assert.equal(response.statusCode, acceptFirst ? 200 : 409, response.body);
            if (acceptFirst) assert.equal(response.json().status, "connecting");
          }
          assert.equal(wakes, acceptFirst ? 2 : 0, "replay wakes existing identity only; no loser send");
        } finally {
          await app.close();
        }
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_operations where call_id=$1 and request->>'inboundFallback'='true'",
              [id]
            )
          ).rows[0].n,
          acceptFirst ? 0 : 1
        );
        await due(f, id);
        await advanceInboundFallback(f.pool, id);
        assert.equal(
          (await f.pool.query("select count(*)::int n from inbound_fallback_runs where call_id=$1", [id]))
            .rows[0].n,
          acceptFirst ? 0 : 1
        );
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
  "F03.1 DB: rollback leaves no fallback intent; concurrent restart uses one identity and saved version",
  options,
  async () => {
    const f = await fixture();
    try {
      const { id, v } = await withFlow(f);
      const replacement = await flow(f);
      await f.pool.query("update inbound_queues set no_answer_flow_version_id=$2 where id=$1", [
        f.queue,
        replacement.id
      ]);
      await due(f, id);
      await assert.rejects(
        advanceInboundFallback(f.pool, id, async () => {
          throw new Error("rollback");
        }),
        /rollback/
      );
      assert.equal((await f.pool.query("select count(*)::int n from inbound_fallback_runs")).rows[0].n, 0);
      const ops = await Promise.all([advanceInboundFallback(f.pool, id), advanceInboundFallback(f.pool, id)]);
      assert.equal(ops[0]!.id, ops[1]!.id);
      assert.equal(ops[0]!.request.flowVersionId, v.id);
      await assert.rejects(
        f.pool.query("update inbound_fallback_runs set deadline_at=deadline_at+interval '1 second'"),
        /identity/
      );
      await settle(f, ops[0]);
      const next = await advanceInboundFallback(f.pool, id);
      assert.equal(next!.request.step, 1);
      assert.notEqual(next!.id, ops[0]!.id);
      await settle(f, next);
      const end = await advanceInboundFallback(f.pool, id);
      assert.equal(end!.command_kind, "hangup");
      await settle(f, end);
      assert.equal(await advanceInboundFallback(f.pool, id), null);
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "F03.2/F03.3 DB: ACK is not playback completion, exact events, interrupted and terminal replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const { id } = await withFlow(f);
      await due(f, id);
      const op = (await advanceInboundFallback(f.pool, id))!;
      assert.match(inboundFallbackCommand(op), /^uuid_transfer /);
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      await persistInboundFallbackJob(f.pool, { jobUuid: op.command_uuid, body: "+OK", headers: {} });
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      // Attempt identity is a SQL fixture; FS tests separately exercise real C03 send.
      await f.pool.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
        [op.id, randomUUID()]
      );
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
      const event = (operationId: string, type: string) =>
        persistInboundFallbackEvent(f.pool, {
          "event-name": "CUSTOM",
          "event-subclass": `outbound_dialer::inbound_fallback_${type}`,
          "outbound-dialer-call-id": id,
          "unique-id": id,
          "outbound-dialer-operation-id": operationId,
          "event-uuid": randomUUID()
        });
      await persistInboundFallbackEvent(f.pool, {
        "event-name": "CUSTOM",
        "event-subclass": "outbound_dialer::inbound_fallback_completed",
        "outbound-dialer-call-id": id,
        "outbound-dialer-operation-id": op.id,
        "unique-id": randomUUID(),
        "event-uuid": randomUUID()
      });
      assert.equal(
        await resolveInboundFallback(op, f.pool),
        null,
        "foreign channel cannot complete the step"
      );
      await event(randomUUID(), "completed");
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      await event(op.id, "started");
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      await event(op.id, "completed");
      assert.equal((await resolveInboundFallback(op, f.pool))!.state, "succeeded");
      await settle(f, op);
      const next = (await advanceInboundFallback(f.pool, id))!;
      await persistInboundFallbackJob(f.pool, { jobUuid: next.command_uuid, body: "+OK", headers: {} });
      await f.end(id);
      assert.equal((await resolveInboundFallback(next, f.pool))!.result.outcome, "interrupted");
      await settle(f, next, "failed");
      assert.equal(await advanceInboundFallback(f.pool, id), null);
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "F03.3 DB: uncertain sender is never bypassed, rejected playback proceeds only to hangup",
  options,
  async () => {
    const f = await fixture();
    try {
      const { id } = await withFlow(f);
      await due(f, id);
      const op = (await advanceInboundFallback(f.pool, id))!;
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
      assert.equal((await advanceInboundFallback(f.pool, id))!.id, op.id);
      await persistInboundFallbackJob(f.pool, {
        jobUuid: op.command_uuid,
        body: "-ERR missing channel",
        headers: {}
      });
      assert.equal((await resolveInboundFallback(op, f.pool))!.state, "failed");
      await settle(f, op, "failed");
      assert.equal((await advanceInboundFallback(f.pool, id))!.command_kind, "hangup");
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "F03.3 DB: terminal absence without fixed job retains uncertainty; late job never replays audio",
  options,
  async () => {
    const f = await fixture();
    try {
      const { id } = await withFlow(f);
      await due(f, id);
      const op = (await advanceInboundFallback(f.pool, id))!;
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
      await f.end(id);
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      assert.equal((await advanceInboundFallback(f.pool, id))!.id, op.id);
      await persistInboundFallbackJob(f.pool, { jobUuid: randomUUID(), body: "+OK", headers: {} });
      assert.equal(await resolveInboundFallback(op, f.pool), null);
      await persistInboundFallbackJob(f.pool, { jobUuid: op.command_uuid, body: "+OK", headers: {} });
      assert.equal((await resolveInboundFallback(op, f.pool))!.result.outcome, "interrupted");
      await settle(f, op, "failed");
      assert.equal(await advanceInboundFallback(f.pool, id), null);
    } finally {
      await f.cleanup();
    }
  }
);

const forwardConfig = {
  SIP_TRUNK_MODE: "ip_auth" as const,
  SIP_TRUNK_PROXY: "127.0.0.1:5099",
  SIP_TRUNK_CALLER_ID: "+12025550100"
};
async function forwardFlow(f: Fixture) {
  const parent = (
    await f.pool.query("insert into inbound_flows(campaign_id,name) values($1,'F04') returning id", [
      f.campaign
    ])
  ).rows[0].id;
  const version = (
    await f.pool.query(
      `insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot) values($1,$2,1,20000,$3,'[]') returning id`,
      [
        parent,
        f.campaign,
        JSON.stringify([
          { type: "forward_external", target: "+14155550101", timeoutMs: 5000 },
          { type: "hangup" }
        ])
      ]
    )
  ).rows[0].id;
  const id = await queued(f, {
    arrivedUs: Date.now() * 1000 - 59000000,
    routeData: Buffer.from(
      JSON.stringify({ queue_timeout_ms: 60000, max_waiting_calls: 40, no_answer_flow_version_id: version })
    ).toString("base64url")
  });
  await due(f, id);
  return id;
}
for (const reverse of [false, true]) {
  test(
    `F04.2 DB: reserved identity replay, capacity limit race and rollback (reverse=${reverse})`,
    options,
    async () => {
      const f = await fixture();
      try {
        const { withCallAdmission } = await import("./call-admission.js");
        const { defaultCapacityLimits } = await import("./call-capacity.js");
        const client = await f.pool.connect();
        try {
          await withCallAdmission(client, {}, (a) =>
            a.capacity.configure({ ...defaultCapacityLimits, forwarding: 1 })
          );
        } finally {
          client.release();
        }
        const ids = [await forwardFlow(f), await forwardFlow(f)];
        if (reverse) ids.reverse();
        await assert.rejects(
          advanceInboundFallback(
            f.pool,
            ids[0]!,
            async () => {
              throw new Error("rollback");
            },
            forwardConfig
          ),
          /rollback/
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_participants where role='external'")).rows[0]
            .n,
          0
        );
        let release!: () => void, held!: () => void;
        const gate = new Promise<void>((r) => (release = r)),
          ready = new Promise<void>((r) => (held = r));
        const leader = await f.pool.connect(),
          follower = await f.pool.connect();
        const facade = (c: pg.PoolClient) =>
          ({
            query: f.pool.query.bind(f.pool),
            connect: async () =>
              Object.assign(Object.create(c), { query: c.query.bind(c), release: () => {} })
          }) as pg.Pool;
        const lp = (await leader.query("select pg_backend_pid() pid")).rows[0].pid,
          fp = (await follower.query("select pg_backend_pid() pid")).rows[0].pid;
        try {
          const first = advanceInboundFallback(
            facade(leader),
            ids[0]!,
            async () => {
              held();
              await gate;
            },
            forwardConfig
          );
          await Promise.race([
            ready,
            first.then(() => {
              throw new Error("missed checkpoint");
            })
          ]);
          const second = advanceInboundFallback(facade(follower), ids[1]!, undefined, forwardConfig);
          await assertBlocked(f.pool, fp, lp);
          release();
          const winner = (await first)!;
          assert.equal(await second, null);
          assert.equal(
            (await advanceInboundFallback(f.pool, ids[0]!, undefined, forwardConfig))!.id,
            winner.id
          );
          assert.equal(
            (
              await f.pool.query(
                "select count(*)::int n from call_capacity_reservations where operation_id=$1",
                [winner.id]
              )
            ).rows[0].n,
            3
          );
          assert.equal(
            (await f.pool.query("select count(*)::int n from call_participants where role='external'"))
              .rows[0].n,
            1
          );
          const loser = (
            await f.pool.query(
              "select * from call_operations where call_id=$1 and command_kind='forward_external'",
              [ids[1]]
            )
          ).rows[0];
          assert.equal(loser.result.reason, "capacity_exceeded");
          assert.equal(
            (await advanceInboundFallback(f.pool, ids[1]!, undefined, forwardConfig))!.command_kind,
            "hangup"
          );
        } finally {
          release();
          leader.release(true);
          follower.release(true);
        }
      } finally {
        await f.cleanup();
      }
    }
  );
}
test(
  "F04.1/F04.3 DB: terminal/late answer permutations retain ambiguity until native bridge finish",
  options,
  async () => {
    const { persistInboundForwardingEvent } = await import("./inbound-forwarding.js");
    const { reconcileCoordinatedCallCleanup } = await import("./call-cleanup.js");
    for (const terminalFirst of [true, false]) {
      const f = await fixture();
      try {
        const id = await forwardFlow(f),
          op = (await advanceInboundFallback(f.pool, id, undefined, forwardConfig))!;
        await f.pool.query(
          "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
          [op.id, randomUUID()]
        );
        await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
        if (terminalFirst) await f.end(id);
        await persistInboundQueueEvent(f.pool, {
          variable_outbound_dialer_call_id: id,
          "unique-id": String(op.request.externalUuid),
          "event-name": "CHANNEL_ANSWER",
          "event-uuid": randomUUID()
        });
        if (!terminalFirst) await f.end(id);
        await persistInboundQueueEvent(f.pool, {
          variable_outbound_dialer_call_id: id,
          "unique-id": String(op.request.externalUuid),
          "event-name": "CHANNEL_DESTROY",
          "event-uuid": randomUUID()
        });
        assert.equal(await resolveInboundFallback(op, f.pool), null);
        await persistInboundFallbackJob(f.pool, { jobUuid: op.command_uuid, body: "+OK", headers: {} });
        assert.equal(
          await resolveInboundFallback(op, f.pool),
          null,
          "transfer ACK cannot fence asynchronous Lua"
        );
        await reconcileCoordinatedCallCleanup(f.pool, id);
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where operation_id=$1 and state<>'released'",
              [op.id]
            )
          ).rows[0].n,
          3
        );
        await persistInboundForwardingEvent(f.pool, {
          "event-name": "CUSTOM",
          "event-subclass": "outbound_dialer::inbound_forward_finished",
          "outbound-dialer-call-id": id,
          "outbound-dialer-operation-id": op.id,
          "outbound-dialer-external-uuid": String(op.request.externalUuid),
          "event-uuid": randomUUID()
        });
        assert.equal((await resolveInboundFallback(op, f.pool))!.result.outcome, "failed");
        await settle(f, op, "failed");
        await reconcileCoordinatedCallCleanup(f.pool, id);
        assert.equal(await advanceInboundFallback(f.pool, id, undefined, forwardConfig), null);
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where call_id=$1 and state<>'released'",
              [id]
            )
          ).rows[0].n,
          0
        );
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "F04.1 DB: negative transfer result and unstarted cancellation safely take continuation",
  options,
  async () => {
    const { settleUnstartedForwarding } = await import("./inbound-forwarding.js");
    const { reconcileCoordinatedCallCleanup } = await import("./call-cleanup.js");
    for (const attempted of [true, false]) {
      const f = await fixture();
      try {
        const id = await forwardFlow(f),
          op = (await advanceInboundFallback(f.pool, id, undefined, forwardConfig))!;
        if (attempted) {
          await f.pool.query(
            "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
            [op.id, randomUUID()]
          );
          await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
          await persistInboundFallbackJob(f.pool, {
            jobUuid: op.command_uuid,
            body: "-ERR transfer refused",
            headers: {}
          });
          let probes = 0;
          const resolved = await resolveInboundFallback(op, f.pool, async () => {
            probes++;
            return true;
          });
          assert.equal(probes, 1);
          assert.equal(resolved!.result.outcome, "failed");
          await settle(f, op, "failed");
        } else {
          await settle(f, op, "canceled");
          await settleUnstartedForwarding(f.pool, id);
        }
        await reconcileCoordinatedCallCleanup(f.pool, id);
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where operation_id=$1 and state<>'released'",
              [op.id]
            )
          ).rows[0].n,
          0
        );
        assert.equal(
          (await advanceInboundFallback(f.pool, id, undefined, forwardConfig))!.command_kind,
          "hangup"
        );
      } finally {
        await f.cleanup();
      }
    }
  }
);
