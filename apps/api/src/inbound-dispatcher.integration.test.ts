import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
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
import { dispatchInboundOffers, ignoreInboundOffer, readInboundOffer } from "./inbound-dispatcher.js";
import { registerCallOfferRoutes } from "./dashboard/call-offers.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "./security.js";
import type { AppConfig } from "./config.js";
import { prepareAutoNext } from "./auto-next.js";
import { createLiveEventHub, startDatabaseLiveEventListener } from "./live-events.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const schema = `e01_${randomUUID().replaceAll("-", "")}`;
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
      "insert into campaigns(name,status,auto_advance_to_next_lead_enabled) values('E01','active',true) returning id"
    )
  ).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'E01') returning id", [campaign])
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
        "insert into users(email,name,role,password_hash) values($1,'E01','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const id = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','E01',true) returning id",
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
  await admitInboundQueue(f.pool, r.uuid);
  return r.uuid;
}
async function due(f: Fixture, a: Agent, callId: string) {
  return (
    await f.pool.query(
      `insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,created_at)
    values($1,'inbound',$2,1,$3,1,1,clock_timestamp()-interval '1 second',clock_timestamp()-interval '20 seconds') returning id`,
      [callId, a.id, a.session]
    )
  ).rows[0].id as string;
}
async function noMediaChange(f: Fixture) {
  return (
    await f.pool.query(`select
    (select count(*)::int from call_operations) operations,
    (select count(*)::int from call_participants) participants,
    (select count(*)::int from call_legs) legs,
    (select count(*)::int from call_capacity_reservations) capacity,
    (select count(*)::int from agent_call_slots where state<>'free') occupied,
    (select coalesce(sum(attempt_count),0)::int from contacts) attempts`)
  ).rows[0];
}
test(
  "E01.1 DB: twenty recipients share the FIFO call; eligibility matrix, no slots/legs/sends",
  options,
  async () => {
    const f = await fixture();
    try {
      const oldest = await queued(f, { arrivedUs: Date.now() * 1000 - 3000000 });
      await queued(f);
      const agents: Agent[] = [];
      for (let i = 0; i < 20; i++) agents.push(await f.agent());
      const bad: Agent[] = [];
      for (let i = 0; i < 9; i++) bad.push(await f.agent());
      const other = (
        await f.pool.query("insert into campaigns(name,status) values('other','active') returning id")
      ).rows[0].id;
      await f.pool.query("update agents set availability_status='paused' where id=$1", [bad[0].id]);
      await f.pool.query("update agent_desk_sessions set campaign_id=$2 where id=$1", [
        bad[1].session,
        other
      ]);
      await f.pool.query(
        "update agent_desk_sessions set created_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [bad[2].session]
      );
      await f.pool.query("update agent_desk_sessions set ready=false where id=$1", [bad[3].session]);
      await f.pool.query(
        "update agent_desk_sessions set verified_at=clock_timestamp()-interval '1 minute' where id=$1",
        [bad[4].session]
      );
      await f.pool.query(
        "update agent_call_slots set state='reserved',reservation_id=$2,call_id=$3 where agent_id=$1",
        [bad[5].id, randomUUID(), oldest]
      );
      await f.pool.query("update users set is_active=false where id=$1", [bad[6].user]);
      await f.pool.query("update agent_desk_sessions set actor_auth_version=2 where id=$1", [bad[7].session]);
      await f.pool.query(
        "update agent_desk_sessions set ready=false,verified_generation=null,verified_endpoint=null,verified_at=null where id=$1",
        [bad[8].session]
      );
      const before = await noMediaChange(f);
      await f.pool.query(
        "update agent_desk_sessions set verified_at=clock_timestamp() where agent_id=any($1::uuid[])",
        [agents.map((a) => a.id)]
      );
      for (const a of agents) assert.equal((await dispatchInboundOffers(f.pool, a.id))?.callId, oldest);
      for (const a of bad) assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_offers where state='pending'")).rows[0].n,
        20
      );
      assert.deepEqual(await noMediaChange(f), before);
      // No executor is injected: the only operations/legs are D04 customer waiting.
      for (const a of agents) await dispatchInboundOffers(f.pool, a.id);
      assert.equal((await f.pool.query("select count(*)::int n from call_offers")).rows[0].n, 20);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E01.2/E01.4 DB: own Ignore replay, winner cancellation/requeue, session/campaign changes and FIFO",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        b = await f.agent();
      const call = await queued(f, { arrivedUs: Date.now() * 1000 - 3000000 }),
        next = await queued(f);
      const before = await noMediaChange(f);
      const offer = await dispatchInboundOffers(f.pool, a.id),
        other = await dispatchInboundOffers(f.pool, b.id);
      const input = mutation(a);
      assert.deepEqual(await ignoreInboundOffer(f.pool, actor(a), offer!.id, input), {
        status: "applied",
        revision: "1"
      });
      assert.equal((await dispatchInboundOffers(f.pool, a.id))?.callId, next);
      assert.deepEqual(await ignoreInboundOffer(f.pool, actor(a), offer!.id, input), {
        status: "applied",
        revision: "1"
      });
      assert.equal((await readInboundOffer(f.pool, actor(a), a.session)).offer?.callId, next);
      await assert.rejects(
        ignoreInboundOffer(f.pool, actor(a), offer!.id, { ...input, expectedRevision: "2" }),
        /idempotency_conflict/
      );
      assert.equal((await readInboundOffer(f.pool, actor(b), b.session)).offer?.id, other!.id);
      // E02 safe-cleanup/requeue boundary is a seeded state, not E02 media proof.
      await f.pool.query(
        "update call_offers set state='canceled',reason='winner_accepted',closed_at=clock_timestamp() where id=$1",
        [other!.id]
      );
      await f.pool.query("update calls set state='connecting' where id=$1", [call]);
      await f.pool.query("update calls set state='queued' where id=$1", [call]);
      assert.equal((await dispatchInboundOffers(f.pool, b.id))?.callId, call);
      assert.equal((await f.pool.query("select count(*)::int n from call_offer_exclusions")).rows[0].n, 1);
      await f.pool.query(
        "update agent_desk_sessions set revoked_at=clock_timestamp(),ready=false where id=$1",
        [a.session]
      );
      await dispatchInboundOffers(f.pool, a.id);
      a.session = (
        await f.pool.query(
          `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at,actor_auth_version)
      values($1,$2,2,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',2,clock_timestamp(),1) returning id`,
          [a.id, f.campaign, randomUUID()]
        )
      ).rows[0].id;
      await f.pool.query("update agent_desk_sessions set campaign_id=null,revision=revision+1 where id=$1", [
        a.session
      ]);
      await dispatchInboundOffers(f.pool, a.id);
      await f.pool.query("update agent_desk_sessions set campaign_id=$2,revision=revision+1 where id=$1", [
        a.session,
        f.campaign
      ]);
      assert.equal((await dispatchInboundOffers(f.pool, a.id))?.callId, next);
      assert.equal(
        (await f.pool.query("select state from calls where id=$1", [call])).rows[0].state,
        "queued"
      );
      assert.deepEqual(await noMediaChange(f), before);
      assert.equal(
        (await f.pool.query("select reason from call_offer_exclusions where agent_id=$1", [a.id])).rows[0]
          .reason,
        "user_ignored"
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E01.3/E01.4 DB: late timer, persistent expiry, refreshed snapshot and same deferred auto identity",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        b = await f.agent();
      const call = await queued(f, { arrivedUs: Date.now() * 1000 - 3000000 }),
        next = await queued(f);
      const expired = await due(f, a, call);
      const contact = (
        await f.pool.query(
          "insert into contacts(campaign_id,phone_number,normalized_phone_number) values($1,'+14155550199','+14155550199') returning id",
          [f.campaign]
        )
      ).rows[0].id;
      const source = (
        await f.pool.query(
          "insert into calls(agent_id,campaign_id,contact_id,destination_number,normalized_destination_number,state,ended_at) values($1,$2,$3,'+14155550199','+14155550199','completed',clock_timestamp()) returning id",
          [a.id, f.campaign, contact]
        )
      ).rows[0].id;
      const auto = { ...mutation(a), startReason: "automatic" as const, sourceCallId: source };
      async function prepare() {
        const c = await f.pool.connect();
        try {
          return await withCallAdmission(
            c,
            { agentIds: [a.id], callIds: [source], campaignIds: [f.campaign] },
            (admission) =>
              prepareAutoNext(admission, {
                actorUserId: a.user,
                agentId: a.id,
                campaignId: f.campaign,
                intent: auto,
                fingerprint: "a".repeat(64)
              })
          );
        } finally {
          c.release();
        }
      }
      const first = await prepare();
      assert.equal(first.result?.status, "deferred");
      assert.equal(
        (await f.pool.query("select state from call_offers where id=$1", [expired])).rows[0].state,
        "expired"
      );
      assert.deepEqual(await ignoreInboundOffer(f.pool, actor(a), expired, mutation(a)), {
        conflict: "offer_expired"
      });
      const offered = await dispatchInboundOffers(f.pool, a.id);
      assert.equal(offered?.callId, next);
      assert.equal((await dispatchInboundOffers(f.pool, b.id))?.callId, call);
      assert.equal((await prepare()).id, first.id);
      await ignoreInboundOffer(f.pool, actor(a), offered!.id, mutation(a));
      const ready = await prepare();
      assert.equal(ready.id, first.id);
      assert.equal(ready.result, undefined);
      assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_offers where agent_id=$1", [a.id])).rows[0].n,
        2
      );
      assert.equal(
        (await f.pool.query("select count(*)::int n from calls where ended_at is null")).rows[0].n,
        2
      );
      assert.equal(
        (await f.pool.query("select attempt_count from contacts where id=$1", [contact])).rows[0]
          .attempt_count,
        0
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E01.3 DB: snapshot commits overdue closure, timer-independent conflict and immutable history",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        call = await queued(f);
      const id = await due(f, a, call);
      assert.equal((await readInboundOffer(f.pool, actor(a), a.session)).offer, null);
      assert.equal(
        (await f.pool.query("select state from call_offers where id=$1", [id])).rows[0].state,
        "expired"
      );
      assert.equal((await readInboundOffer(f.pool, actor(a), a.session)).offer, null);
      const client = await f.pool.connect();
      try {
        const decision = await withCallAdmission(
          client,
          { agentIds: [a.id], callIds: [call], campaignIds: [f.campaign] },
          (a2) =>
            a2.eligibility({
              agentId: a.id,
              userId: a.user,
              campaignId: f.campaign,
              deskSessionId: a.session,
              expectedRevision: "1",
              bindingGeneration: "1",
              offerId: id
            })
        );
        assert.equal(decision.reason, "offer_expired");
      } finally {
        client.release();
      }
      await assert.rejects(
        f.pool.query("update call_offers set state='pending',reason=null,closed_at=null where id=$1", [id]),
        /immutable/
      );
      assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
    } finally {
      await f.cleanup();
    }
  }
);

for (const first of ["dispatch", "claim"] as const)
  for (const overdue of [true, false])
    for (const rollback of [false, true])
      test(
        `E01.3 DB: controlled expiry/claim order=${first} overdue=${overdue} rollback=${rollback}, post-lock revalidation`,
        options,
        async () => {
          const f = await fixture();
          const c = await f.pool.connect();
          const d = await f.pool.connect();
          try {
            const a = await f.agent(),
              call = await queued(f);
            const id = overdue ? await due(f, a, call) : (await dispatchInboundOffers(f.pool, a.id))!.id;
            let entered!: () => void, release!: () => void;
            const held = new Promise<void>((r) => (entered = r)),
              gate = new Promise<void>((r) => (release = r));
            let pid = 0;
            const hold = async (db: pg.PoolClient) => {
              pid = (await db.query("select pg_backend_pid() pid")).rows[0].pid;
              entered();
              await gate;
              if (rollback) throw new Error("leading rollback");
            };
            const claim = () =>
              withCallAdmission(
                c,
                { agentIds: [a.id], callIds: [call], campaignIds: [f.campaign] },
                async (admission) => {
                  const decision = await admission.eligibility({
                    agentId: a.id,
                    userId: a.user,
                    campaignId: f.campaign,
                    deskSessionId: a.session,
                    expectedRevision: "1",
                    bindingGeneration: "1",
                    offerId: id
                  });
                  if (first === "claim") await hold(c);
                  if (!decision.eligible) return decision.reason;
                  const token = await admission.reserve(
                    {
                      agentId: a.id,
                      userId: a.user,
                      campaignId: f.campaign,
                      deskSessionId: a.session,
                      expectedRevision: "1",
                      bindingGeneration: "1",
                      offerId: id
                    },
                    call
                  );
                  await c.query(
                    "update call_offers set state='accepted',reason='accepted',closed_at=clock_timestamp() where id=$1",
                    [id]
                  );
                  return token;
                }
              );
            const dispatch = () =>
              dispatchInboundOffers(
                f.pool,
                a.id,
                first === "dispatch" ? async (ad) => hold(ad.client) : undefined
              );
            const leading = (first === "claim" ? claim() : dispatch()).catch((error) => {
              if (!rollback) throw error;
              assert.match(error.message, /leading rollback/);
            });
            await held;
            // Different pool/backend waits on the actual common advisory lock.
            const trailing = first === "claim" ? dispatch() : claim();
            try {
              // Discover the blocked admission backend without timing-based sleeps.
              const until = Date.now() + 180;
              let blocked = 0;
              do {
                blocked =
                  (
                    await d.query(
                      "select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid)) limit 1",
                      [pid]
                    )
                  ).rows[0]?.pid ?? 0;
              } while (!blocked && Date.now() < until);
              assert.ok(blocked, "competing transaction reached admission lock");
              await assertBlocked(f.pool, blocked, pid);
            } finally {
              release();
            }
            await leading;
            await trailing;
            const row = (await f.pool.query("select state from call_offers where id=$1", [id])).rows[0];
            assert.equal(
              row.state,
              overdue ? "expired" : rollback && first === "claim" ? "pending" : "accepted"
            );
            assert.equal(
              (await f.pool.query("select count(*)::int n from call_offer_exclusions")).rows[0].n,
              overdue ? 1 : 0
            );
            // Rollback cannot leak a new offer, exclusion or slot.
            const b = await f.agent();
            const before = await f.pool.query("select * from call_offers order by id");
            await assert.rejects(
              dispatchInboundOffers(f.pool, b.id, async () => {
                throw new Error("forced rollback");
              }),
              /forced rollback/
            );
            assert.deepEqual((await f.pool.query("select * from call_offers order by id")).rows, before.rows);
          } finally {
            c.release();
            d.release();
            await f.cleanup();
          }
        }
      );

const config = {
  JWT_SECRET: "e01-isolated-test-signing-secret",
  JWT_EXPIRES_SECONDS: 3600,
  PUBLIC_APP_URL: "https://desk.example.test",
  corsOrigins: []
} as unknown as AppConfig;
test(
  "E01 API: actor/controller scoping, strict payloads, CSRF and durable Ignore replay",
  options,
  async () => {
    const f = await fixture(),
      app = Fastify();
    await app.register(cookie);
    registerCookieCsrfProtection(app, config);
    app.setErrorHandler((error, _request, reply) =>
      error instanceof ZodError ? reply.code(400).send({ message: "Validation failed" }) : reply.send(error)
    );
    registerCallOfferRoutes(app, config, f.pool);
    try {
      const a = await f.agent(),
        b = await f.agent(),
        call = await queued(f);
      const offer = (await dispatchInboundOffers(f.pool, a.id))!;
      const token = signAuthToken(config, { sub: a.user, email: "e01@example.test", role: "agent", ver: 1 });
      const headers = { authorization: `Bearer ${token}` },
        payload = mutation(a),
        url = `/agent/call-offers/${offer.id}/ignore`;
      const before = (await f.pool.query("select * from call_offers order by id")).rows;
      assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
      assert.equal(
        (await app.inject({ method: "POST", url, headers, payload: { ...payload, agentId: b.id } }))
          .statusCode,
        400
      );
      assert.equal(
        (await app.inject({ method: "POST", url, headers, payload: { ...payload, expectedRevision: "2" } }))
          .statusCode,
        409
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...payload, deskSessionId: b.session }
          })
        ).statusCode,
        409
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: "https://evil.test" },
            payload
          })
        ).statusCode,
        403
      );
      const bToken = signAuthToken(config, { sub: b.user, email: "b@example.test", role: "agent", ver: 1 });
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${bToken}` },
            payload: mutation(b)
          })
        ).statusCode,
        409
      );
      const wrong = await app.inject({ url: `/agent/call-offers?deskSessionId=${b.session}`, headers });
      assert.equal(wrong.statusCode, 409);
      assert.deepEqual((await f.pool.query("select * from call_offers order by id")).rows, before);
      const snap = await app.inject({ url: `/agent/call-offers?deskSessionId=${a.session}`, headers });
      assert.equal(snap.statusCode, 200, snap.body);
      assert.equal(snap.headers["cache-control"], "no-store");
      assert.equal(snap.json().offer.callId, call);
      const ignored = await app.inject({ method: "POST", url, headers, payload });
      assert.equal(ignored.statusCode, 200, ignored.body);
      const next = await queued(f);
      await dispatchInboundOffers(f.pool, a.id);
      const retry = await app.inject({ method: "POST", url, headers, payload });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual(retry.json(), ignored.json());
      assert.equal(
        (await app.inject({ url: `/agent/call-offers?deskSessionId=${a.session}`, headers })).json().offer
          .callId,
        next
      );
      assert.equal(
        (await app.inject({ method: "POST", url, headers, payload: mutation(a) })).json().code,
        "offer_closed"
      );
      assert.equal((await f.pool.query("select count(*)::int n from call_offer_mutations")).rows[0].n, 1);
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

test(
  "E01.1/E01.4 DB: microsecond FIFO/tie, becoming free, all excluded and original queue deadline",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent(),
        base = Date.now() * 1000 - 3000000;
      const one = await queued(f, { uuid: "11111111-1111-4111-8111-111111111111", arrivedUs: base });
      const two = await queued(f, { uuid: "22222222-2222-4222-8222-222222222222", arrivedUs: base });
      const earlier = await queued(f, { arrivedUs: base - 1 });
      await f.pool.query("update agents set availability_status='paused' where id=$1", [a.id]);
      assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      await f.pool.query("update agents set availability_status='available' where id=$1", [a.id]);
      for (const id of [earlier, one, two]) {
        const offer = (await dispatchInboundOffers(f.pool, a.id))!;
        assert.equal(offer.callId, id);
        await ignoreInboundOffer(f.pool, actor(a), offer.id, mutation(a));
      }
      for (let i = 0; i < 3; i++) assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      assert.equal((await f.pool.query("select count(*)::int n from call_offers")).rows[0].n, 3);
      assert.equal(
        (await f.pool.query("select count(*)::int n from calls where state='queued' and ended_at is null"))
          .rows[0].n,
        3
      );
      const ending = await queued(f, { arrivedUs: Date.now() * 1000 - 14800000, timeoutMs: 15000 });
      // Deterministic deadline boundary observed from the database, no timer sleep.
      while (
        (
          await f.pool.query("select queue_deadline_at>clock_timestamp() live from calls where id=$1", [
            ending
          ])
        ).rows[0].live
      ) {
        // Observe the original database deadline before exercising dispatch.
      }
      assert.equal(await dispatchInboundOffers(f.pool, a.id), null);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_offers where call_id=$1", [ending])).rows[0].n,
        0
      );
      // F03 owns no-answer execution; E01 preserves the original waiting call/deadline.
      assert.equal(
        (await f.pool.query("select ended_at from calls where id=$1", [ending])).rows[0].ended_at,
        null
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E01 refresh: committed offers/exclusions flow through PostgreSQL and live-events; rollback publishes no hint",
  options,
  async () => {
    const f = await fixture();
    let stop: (() => void) | undefined;
    try {
      const a = await f.agent(),
        call = await queued(f),
        hub = createLiveEventHub(),
        events: string[] = [];
      let ready!: () => void;
      const subscribed = new Promise<void>((r) => (ready = r));
      const logger = {
        info: () => ready(),
        error: (error: unknown) => {
          throw error;
        }
      } as unknown as Parameters<typeof startDatabaseLiveEventListener>[2];
      stop = startDatabaseLiveEventListener(f.pool, hub, logger);
      await subscribed;
      const listener = await f.pool.connect();
      await listener.query("listen outbound_dialer_changes");
      async function fence() {
        // NOTIFY on a separate channel payload forms an ordered commit fence. All
        // earlier transaction hints are delivered on the same listener connection.
        const done = new Promise<void>((resolve) => {
          const unsub = hub.subscribe((e) => {
            events.push(e.source);
            if (e.source === "e01-fence") {
              unsub();
              resolve();
            }
          });
        });
        await listener.query("select pg_notify('outbound_dialer_changes','e01-fence')");
        await done;
      }
      await assert.rejects(
        dispatchInboundOffers(f.pool, a.id, async () => {
          throw new Error("rollback");
        }),
        /rollback/
      );
      await fence();
      assert.deepEqual(events, ["e01-fence"]);
      events.length = 0;
      const offer = (await dispatchInboundOffers(f.pool, a.id))!;
      await fence();
      assert.ok(events.includes("call_offers"));
      events.length = 0;
      await ignoreInboundOffer(f.pool, actor(a), offer.id, mutation(a));
      await fence();
      assert.ok(events.includes("call_offer_exclusions"));
      assert.equal((await readInboundOffer(f.pool, actor(a), a.session)).offer, null);
      assert.equal(
        (await f.pool.query("select state from calls where id=$1", [call])).rows[0].state,
        "queued"
      );
      await listener.query("unlisten outbound_dialer_changes");
      listener.release();
    } finally {
      stop?.();
      await f.cleanup();
    }
  }
);

test(
  "E01.1/E01.3 DB: captured offer timeout survives edits and is capped by original queue deadline",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent();
      const call = await queued(f, {
        routeData: Buffer.from(
          JSON.stringify({
            queue_timeout_ms: 60000,
            max_waiting_calls: 40,
            offer_timeout_ms: 5000,
            no_answer_flow_version_id: randomUUID()
          })
        ).toString("base64url")
      });
      await f.pool.query("update inbound_queues set offer_timeout_ms=30000 where id=$1", [f.queue]);
      const offer = (await dispatchInboundOffers(f.pool, a.id))!;
      assert.equal(offer.callId, call);
      const budget = (
        await f.pool.query(
          "select extract(epoch from deadline_at-created_at)*1000 ms from call_offers where id=$1",
          [offer.id]
        )
      ).rows[0].ms;
      assert.ok(Number(budget) >= 5000 && Number(budget) < 5500, budget);
      await ignoreInboundOffer(f.pool, actor(a), offer.id, mutation(a));
      const near = await queued(f, { timeoutMs: 15000, arrivedUs: Date.now() * 1000 - 12000000 });
      const limited = (await dispatchInboundOffers(f.pool, a.id))!;
      assert.equal(limited.callId, near);
      assert.equal(
        (
          await f.pool.query(
            "select o.deadline_at=c.queue_deadline_at capped from call_offers o join calls c on c.id=o.call_id where o.id=$1",
            [limited.id]
          )
        ).rows[0].capped,
        true
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "E01 migration 037: populated 036 upgrade preserves call/offer/exclusion state and feature flags",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.agent();
      await queued(f);
      const offer = (await dispatchInboundOffers(f.pool, a.id))!;
      // Reconstruct the immediately previous schema in this disposable fixture.
      await f.pool.query(`drop table service_invite_dialogs;
      drop function preserve_service_invite_dialog();
      delete from schema_migrations where filename='039_service_invite_authorization.sql';
      drop table call_offer_accept_mutations;
      drop table inbound_connection_attempts;
      drop function preserve_inbound_accept_mutation();
      drop function preserve_inbound_connection();
      delete from schema_migrations where filename='038_inbound_acceptance.sql';
      drop table call_offer_mutations;
      drop trigger notify_call_offers_changed on call_offers;
      drop trigger notify_call_offer_exclusions_changed on call_offer_exclusions;
      drop trigger notify_agent_auto_next_intents_changed on agent_auto_next_intents;
      drop trigger notify_agent_auto_next_intents_updated on agent_auto_next_intents;
      delete from schema_migrations where filename='037_inbound_offer_dispatch.sql'`);
      const before = (await f.pool.query("select * from call_offers order by id")).rows;
      const previous = (await f.pool.query("select * from schema_migrations order by filename")).rows;
      const settings = (await f.pool.query("select * from system_settings order by key")).rows;
      await runMigrations(f.pool);
      assert.deepEqual((await f.pool.query("select * from call_offers order by id")).rows, before);
      assert.deepEqual(
        (
          await f.pool.query(
            "select * from schema_migrations where filename<'037_inbound_offer_dispatch.sql' order by filename"
          )
        ).rows,
        previous
      );
      assert.deepEqual((await f.pool.query("select * from system_settings order by key")).rows, settings);
      await ignoreInboundOffer(f.pool, actor(a), offer.id, mutation(a));
      assert.equal((await f.pool.query("select count(*)::int n from call_offer_mutations")).rows[0].n, 1);
      await runMigrations(f.pool);
      assert.equal((await f.pool.query("select count(*)::int n from call_offer_exclusions")).rows[0].n, 1);
    } finally {
      await f.cleanup();
    }
  }
);
