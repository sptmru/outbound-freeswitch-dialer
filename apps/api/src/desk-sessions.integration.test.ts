import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { migrateAgentSipSecretEncryption } from "./users.js";
import { decryptSecret } from "./auth/crypto.js";
import { DeskSessions, type DeskActor, type DeskTelephony } from "./desk-sessions.js";
import type { AppConfig } from "./config.js";
import { registerDeskSessionRoutes } from "./dashboard/desk-sessions.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "./security.js";
import { withCallAdmission } from "./call-admission.js";
import type { DeskSessionSnapshot } from "@outbound-dialer/shared";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const mutation = (s: DeskSessionSnapshot) => ({
  deskSessionId: s.id,
  expectedRevision: s.revision,
  bindingGeneration: s.bindingGeneration,
  idempotencyKey: randomUUID()
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture() {
  const schema = `d01_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  await admin.query(`create schema ${schema}`);
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  const user = (
    await pool.query(
      "insert into users(email,name,role,password_hash) values($1,'D01','agent','fixture') returning *",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0];
  const agent = (
    await pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','D01',true) returning id",
      [user.id, randomUUID()]
    )
  ).rows[0];
  await pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [agent.id]
  );
  const campaignId = (
    await pool.query("insert into campaigns(name,status) values('D01','active') returning id")
  ).rows[0].id;
  const callId = (
    await pool.query(
      "insert into calls(campaign_id,destination_number,normalized_destination_number,state) values($1,'+14155550100','+14155550100','created') returning id",
      [campaignId]
    )
  ).rows[0].id;
  const actor: DeskActor = { agentId: agent.id, userId: user.id, authVersion: user.auth_version };
  const config = {
    JWT_SECRET: "d01-disposable-test",
    JWT_EXPIRES_SECONDS: 3600,
    FREESWITCH_DOMAIN: "fixture.invalid",
    PUBLIC_APP_URL: "https://desk.example.test",
    corsOrigins: ["https://desk.example.test"]
  } as AppConfig;
  let contactMode = "valid";
  const removed: string[] = [];
  const provisioned: string[] = [];
  const telephony: DeskTelephony = {
    provision: async (username) => {
      provisioned.push(username);
    },
    lookup: async (username) =>
      contactMode === "error"
        ? Promise.reject(new Error("fixture"))
        : contactMode === "valid"
          ? `sofia/internal-webrtc/sip:${username}@127.0.0.2:5060`
          : contactMode,
    remove: async (username) => {
      removed.push(username);
    }
  };
  const service = new DeskSessions(pool, config, telephony);
  const create = (expectedRevision: string | null = null) =>
    service.create(actor, { campaignId, expectedRevision, idempotencyKey: randomUUID() });
  const update = (s: DeskSessionSnapshot, extra = {}) =>
    service.update(actor, { ...mutation(s), campaignId: s.campaignId, ready: true, ...extra });
  const eligible = async (s: DeskSessionSnapshot, campaign = campaignId) => {
    const client = await pool.connect();
    try {
      return await withCallAdmission(client, { agentIds: [actor.agentId], campaignIds: [campaign] }, (a) =>
        a.eligibility({ ...mutation(s), agentId: actor.agentId, userId: actor.userId, campaignId: campaign })
      );
    } finally {
      client.release();
    }
  };
  return {
    pool,
    actor,
    user,
    config,
    service,
    telephony,
    removed,
    provisioned,
    campaignId,
    callId,
    create,
    update,
    eligible,
    contact: (value: string) => (contactMode = value),
    async cleanup() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  };
}

test(
  "D01.1 DB: only current Desk, matching campaign and fresh exact contact are eligible; registration flag cannot attest readiness",
  options,
  async () => {
    const f = await fixture();
    try {
      let result = await f.create();
      let s = result.session!;
      assert.ok(result.sip);
      assert.equal(s.ready, false);
      assert.equal((await f.eligible(s)).reason, "endpoint_unavailable");
      const identity = (await f.pool.query("select * from agent_desk_sessions where id=$1", [s.id])).rows[0];
      assert.ok(identity.sip_secret_encrypted.startsWith("v1."));
      assert.ok(!identity.sip_secret_encrypted.includes(result.sip.password));
      f.config.SIP_SECRET_ENCRYPTION_KEY = "d01-disposable-v2-key";
      f.config.SIP_SECRET_WRITE_VERSION = "v2";
      assert.equal(await migrateAgentSipSecretEncryption(f.pool, f.config), 1);
      const encrypted = (
        await f.pool.query("select sip_secret_encrypted from agent_desk_sessions where id=$1", [s.id])
      ).rows[0].sip_secret_encrypted;
      assert.ok(encrypted.startsWith("v2."));
      assert.equal(decryptSecret(f.config, encrypted), result.sip.password);
      s = (await f.update(s)).session!;
      assert.equal(s.ready, true);
      assert.equal((await f.eligible(s)).eligible, true);
      const wrongCampaign = (
        await f.pool.query("insert into campaigns(name,status) values('Wrong','active') returning id")
      ).rows[0].id;
      assert.equal((await f.eligible(s, wrongCampaign)).reason, "revision_conflict");
      await f.pool.query(
        "update agent_desk_sessions set verified_at=clock_timestamp()-interval '16 seconds' where id=$1",
        [s.id]
      );
      assert.equal((await f.eligible(s)).reason, "endpoint_unavailable");
      s = (await f.update(s)).session!;
      for (const contact of [
        "error",
        "-ERR USER_NOT_REGISTERED",
        `sofia/internal-webrtc/sip:${result.sip!.username}@127.0.0.3:5060`,
        "endpoint1,endpoint2"
      ]) {
        f.contact(contact);
        s = (await f.update(s)).session!;
        assert.equal(s.ready, false);
        assert.equal((await f.eligible(s)).eligible, false);
        f.contact("valid");
        s = (await f.update(s)).session!;
        assert.equal(s.ready, true);
      }
      const leave = await f.service.leave(f.actor, mutation(s));
      assert.equal(leave.session, null);
      assert.equal((await f.eligible(s)).reason, "not_controller");
      assert.deepEqual(f.removed, [result.sip!.username]);
      result = await f.create();
      s = (await f.update(result.session!)).session!;
      await f.pool.query(
        "update agent_desk_sessions set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=$1",
        [s.id]
      );
      assert.equal((await f.eligible(s)).reason, "not_controller");
      await f.service.reconcile();
      assert.ok(
        (await f.pool.query("select revoked_at from agent_desk_sessions where id=$1", [s.id])).rows[0]
          .revoked_at
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D01.2 DB: idempotent takeover cancels old work; delayed verification/PATCH/DELETE and cleanup cannot alter new generation",
  options,
  async () => {
    const f = await fixture();
    try {
      const input = { campaignId: f.campaignId, expectedRevision: null, idempotencyKey: randomUUID() };
      const first = await f.service.create(f.actor, input);
      assert.deepEqual(await f.service.create(f.actor, input), first);
      await assert.rejects(f.service.create(f.actor, { ...input, campaignId: null }), /idempotency_conflict/);
      const old = (await f.update(first.session!)).session!;
      const queue = (
        await f.pool.query("insert into inbound_queues(campaign_id,name) values($1,'D01') returning id", [
          f.campaignId
        ])
      ).rows[0].id;
      const inbound = (
        await f.pool.query(
          `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+14155550100','+14155550100','inbound','queued','+14155550101','+14155550100','+14155550101',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
          [f.campaignId, queue]
        )
      ).rows[0].id;
      await f.pool.query(
        "insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,$2,'inbound',1,$3,$4,$5,clock_timestamp()+interval '20 seconds')",
        [inbound, f.actor.agentId, old.id, old.revision, old.bindingGeneration]
      );
      await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
        f.callId
      ]);
      await f.pool.query(
        "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key) values($1,$2,$3,$4,$5,$6)",
        [f.actor.agentId, f.callId, f.campaignId, old.id, old.revision, randomUUID()]
      );
      const lookupStarted = deferred(),
        release = deferred();
      const delayed = new DeskSessions(f.pool, f.config, {
        ...f.telephony,
        lookup: async (username) => {
          lookupStarted.resolve();
          await release.promise;
          return `sofia/internal-webrtc/sip:${username}@127.0.0.2:5060`;
        }
      });
      const updating = delayed.update(f.actor, { ...mutation(old), campaignId: f.campaignId, ready: true });
      const rejected = assert.rejects(updating, /not_controller/);
      await lookupStarted.promise;
      const next = await f.create(old.revision);
      release.resolve();
      await rejected;
      assert.equal(next.session!.ready, false);
      assert.notEqual(next.sip!.username, first.sip!.username);
      assert.equal(
        (await f.pool.query("select state from call_offers where call_id=$1", [inbound])).rows[0].state,
        "canceled"
      );
      assert.equal(
        (await f.pool.query("select state from agent_auto_next_intents where source_call_id=$1", [f.callId]))
          .rows[0].state,
        "canceled"
      );
      await assert.rejects(f.update(old), /not_controller/);
      await assert.rejects(f.service.leave(f.actor, mutation(old)), /not_controller/);
      let current = (await f.update(next.session!)).session!;
      await f.service.cleanup();
      assert.equal((await f.eligible(current)).eligible, true);
      assert.ok(!f.removed.includes(next.sip!.username));
      // Changed auth invalidates current identity; old JWT/version cannot mutate it.
      await f.pool.query("update users set auth_version=auth_version+1 where id=$1", [f.user.id]);
      assert.equal((await f.eligible(current)).reason, "not_controller");
      await assert.rejects(f.update(current), /session_revoked/);
      await f.service.reconcile();
      current = (await f.pool.query("select * from agent_desk_sessions where id=$1", [current.id])).rows[0];
      assert.equal(current.ready, false);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "D01.3 DB: occupied-state takeover matrix; leave/heartbeat/registration loss never changes slot ownership",
  options,
  async () => {
    for (const state of ["reserved", "connecting", "active", "releasing", "uncertain"]) {
      const f = await fixture();
      try {
        const created = await f.create();
        const s = (await f.update(created.session!)).session!;
        await f.pool.query(
          "update agent_call_slots set state='reserved',call_id=$2,reservation_id=$3 where agent_id=$1",
          [f.actor.agentId, f.callId, randomUUID()]
        );
        await f.pool.query("update agent_call_slots set state=$2 where agent_id=$1", [
          f.actor.agentId,
          state
        ]);
        const slot = (
          await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.actor.agentId])
        ).rows[0];
        await assert.rejects(f.create(s.revision), /slot_occupied/);
        f.contact("error");
        await f.service.reconcile();
        const fresh = (await f.pool.query("select revision from agent_desk_sessions where id=$1", [s.id]))
          .rows[0].revision;
        await f.service.leave(f.actor, { ...mutation(s), expectedRevision: fresh });
        await f.service.cleanup();
        assert.equal(f.removed.length, 0);
        assert.deepEqual(
          (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.actor.agentId])).rows[0],
          slot
        );
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "D01.1 API: authenticated scope, CSRF, strict bodies, path identity, no-store and replay",
  options,
  async () => {
    const f = await fixture();
    const app = Fastify();
    try {
      await app.register(cookie);
      registerCookieCsrfProtection(app, f.config);
      app.setErrorHandler((error, _request, reply) =>
        reply.code(error instanceof ZodError ? 400 : 500).send({ message: "Invalid request" })
      );
      registerDeskSessionRoutes(app, f.config, f.pool, f.service);
      const token = signAuthToken(f.config, { sub: f.user.id, email: f.user.email, role: "agent", ver: 1 });
      const body = { campaignId: f.campaignId, expectedRevision: null, idempotencyKey: randomUUID() };
      const send = (
        method: "POST" | "PATCH" | "DELETE",
        url: string,
        payload: unknown,
        headers: Record<string, string> = { authorization: `Bearer ${token}` }
      ) =>
        app.inject({
          method,
          url,
          payload: JSON.stringify(payload),
          headers: { "content-type": "application/json", ...headers }
        });
      assert.equal((await send("POST", "/agent/desk-sessions", body, {})).statusCode, 401);
      assert.equal(
        (
          await send("POST", "/agent/desk-sessions", body, {
            cookie: `${SESSION_COOKIE_NAME}=${token}`,
            origin: "https://evil.example"
          })
        ).statusCode,
        403
      );
      assert.equal(
        (await send("POST", "/agent/desk-sessions", { ...body, verifiedEndpoint: "spoof" })).statusCode,
        400
      );
      const response = await send("POST", "/agent/desk-sessions", body);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      const first = response.json();
      assert.equal(
        (await send("POST", "/agent/desk-sessions", body)).json().sip.username,
        first.sip.username
      );
      const input = { ...mutation(first.session), campaignId: f.campaignId, ready: true };
      assert.equal((await send("PATCH", `/agent/desk-sessions/${randomUUID()}`, input)).statusCode, 409);
      const other = (
        await f.pool.query(
          "insert into users(email,name,role,password_hash) values($1,'Other','admin','fixture') returning *",
          [`${randomUUID()}@example.test`]
        )
      ).rows[0];
      const otherAgent = (
        await f.pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','Other') returning id",
          [other.id, randomUUID()]
        )
      ).rows[0];
      void otherAgent;
      const otherToken = signAuthToken(f.config, {
        sub: other.id,
        email: other.email,
        role: "admin",
        ver: 1
      });
      assert.equal(
        (
          await send("PATCH", `/agent/desk-sessions/${first.session.id}`, input, {
            authorization: `Bearer ${otherToken}`
          })
        ).statusCode,
        409
      );
      const update = await send("PATCH", `/agent/desk-sessions/${first.session.id}`, input);
      assert.equal(update.statusCode, 200, update.body);
      assert.equal(update.json().session.ready, true);
      const again = await send("PATCH", `/agent/desk-sessions/${first.session.id}`, input);
      assert.deepEqual(again.json(), update.json());
      const before = (
        await f.pool.query("select expires_at from agent_desk_sessions where id=$1", [first.session.id])
      ).rows[0];
      await send("PATCH", `/agent/desk-sessions/${first.session.id}`, input);
      assert.deepEqual(
        (await f.pool.query("select expires_at from agent_desk_sessions where id=$1", [first.session.id]))
          .rows[0],
        before
      );
      f.contact("error");
      await f.service.reconcile();
      const conflict = await send("PATCH", `/agent/desk-sessions/${first.session.id}`, {
        ...input,
        idempotencyKey: randomUUID()
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().code, "revision_conflict");
      assert.equal(conflict.json().session.id, first.session.id);
      f.contact("valid");
      const recovered = await send("PATCH", `/agent/desk-sessions/${first.session.id}`, {
        ...mutation(conflict.json().session),
        campaignId: f.campaignId,
        ready: true
      });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.json().session.ready, true);
      const stored = (await f.pool.query("select result from agent_desk_mutations")).rows;
      assert.ok(!JSON.stringify(stored).includes(first.sip.password));
      assert.equal(
        (await send("DELETE", `/agent/desk-sessions/${first.session.id}`, mutation(recovered.json().session)))
          .statusCode,
        200
      );
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

// Two independent PostgreSQL connections; commit/rollback barriers, not timing races.
test("D01.2 DB races: takeover versus admission in both commit orders and rollback", options, async () => {
  for (const first of ["takeover", "admission"]) {
    for (const rollback of [false, true]) {
      const f = await fixture();
      const one = await f.pool.connect(),
        two = await f.pool.connect();
      try {
        const s = (await f.update((await f.create()).session!)).session!;
        const pid1 = (await one.query("select pg_backend_pid() as pid")).rows[0].pid;
        const pid2 = (await two.query("select pg_backend_pid() as pid")).rows[0].pid;
        const checkpoint = deferred(),
          release = deferred();
        const wrapped = (client: pg.PoolClient, held: boolean) =>
          ({
            query: client.query.bind(client),
            connect: async () => ({
              query: async (...args: unknown[]) => {
                if (held && args[0] === "commit") {
                  checkpoint.resolve();
                  await release.promise;
                  if (rollback) throw new Error("fixture_rollback");
                }
                return (client.query as (...args: unknown[]) => Promise<unknown>)(...args);
              },
              release: () => {}
            })
          }) as unknown as pg.Pool;
        const takeover = (db: pg.Pool) =>
          new DeskSessions(db, f.config, f.telephony).create(f.actor, {
            campaignId: f.campaignId,
            expectedRevision: s.revision,
            idempotencyKey: randomUUID()
          });
        const admission = async (client: pg.PoolClient, held: boolean) =>
          withCallAdmission(
            client,
            {
              agentIds: [f.actor.agentId],
              campaignIds: [f.campaignId],
              callIds: [f.callId],
              startsCall: true
            },
            async (a) => {
              const decision = await a.eligibility({
                ...mutation(s),
                agentId: f.actor.agentId,
                userId: f.actor.userId,
                campaignId: f.campaignId
              });
              if (!decision.eligible) throw new Error(decision.reason!);
              const result = await a.reserve(
                {
                  ...mutation(s),
                  agentId: f.actor.agentId,
                  userId: f.actor.userId,
                  campaignId: f.campaignId
                },
                f.callId
              );
              if (held) {
                checkpoint.resolve();
                await release.promise;
                if (rollback) throw new Error("fixture_rollback");
              }
              return result;
            }
          );
        const firstPromise = first === "takeover" ? takeover(wrapped(one, true)) : admission(one, true);
        const firstResult = firstPromise.then(
          () => "committed",
          (e) => (e as Error).message
        );
        await checkpoint.promise;
        const secondPromise = first === "takeover" ? admission(two, false) : takeover(wrapped(two, false));
        const secondResult = secondPromise.then(
          () => "committed",
          (e) => (e as Error).message
        );
        await assertBlocked(f.pool, pid2, pid1);
        release.resolve();
        assert.equal(await firstResult, rollback ? "fixture_rollback" : "committed");
        assert.equal(
          await secondResult,
          rollback ? "committed" : first === "takeover" ? "not_controller" : "slot_occupied"
        );
        const slot = (
          await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.actor.agentId])
        ).rows[0];
        assert.equal(
          slot.state,
          (first === "admission" && !rollback) || (first === "takeover" && rollback) ? "reserved" : "free"
        );
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int as n from agent_desk_sessions where revoked_at is null",
              []
            )
          ).rows[0].n,
          1
        );
      } finally {
        one.release();
        two.release();
        await f.cleanup();
      }
    }
  }
});

test(
  "D01 migration 033 upgrades a live 032 controller without inheriting readiness or freeing its reservation; history and replay survive",
  options,
  async () => {
    const f = await fixture();
    try {
      const created = await f.create();
      const session = (await f.update(created.session!)).session!;
      await f.pool.query(
        "update agent_call_slots set state='reserved',call_id=$2,reservation_id=$3 where agent_id=$1",
        [f.actor.agentId, f.callId, randomUUID()]
      );
      const before = (
        await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.actor.agentId])
      ).rows[0];
      const history = (
        await f.pool.query(
          "select * from schema_migrations where filename<'033_desk_session_lifecycle.sql' order by filename"
        )
      ).rows;
      // Reconstruct 032 with genuine current-controller and occupied-slot data.
      await f.pool.query(`drop table agent_desk_mutations;
      alter table agent_desk_sessions drop column endpoint_pin,drop column actor_auth_version,drop column registration_cleaned_at,drop column registration_checked_at;
      delete from schema_migrations where filename='033_desk_session_lifecycle.sql'`);
      await runMigrations(f.pool);
      const upgraded = (await f.pool.query("select * from agent_desk_sessions where id=$1", [session.id]))
        .rows[0];
      assert.equal(upgraded.ready, false);
      assert.equal(upgraded.actor_auth_version, null);
      assert.equal(upgraded.endpoint_pin, upgraded.verified_endpoint);
      assert.ok(upgraded.sip_secret_encrypted.startsWith("v1."));
      await f.service.reconcile();
      assert.deepEqual(
        (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.actor.agentId])).rows[0],
        before
      );
      await runMigrations(f.pool);
      assert.deepEqual(
        (
          await f.pool.query(
            "select * from schema_migrations where filename<'033_desk_session_lifecycle.sql' order by filename"
          )
        ).rows,
        history
      );
    } finally {
      await f.cleanup();
    }
  }
);
