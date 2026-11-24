import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import {
  assertBlocked,
  createFixtureLogin,
  databaseConfig,
  testDatabaseUrl
} from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import type { AppConfig } from "./config.js";
import { type ManualOutboundRequest, type ManualOutboundRoute } from "./manual-outbound.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "./security.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const config = {
  JWT_SECRET: "c04-isolated-test-only-signing-secret",
  JWT_EXPIRES_SECONDS: 3600,
  CONTACT_MAX_ATTEMPTS: 3,
  CONTACT_RETRY_DELAY_SECONDS: 900,
  DEFAULT_PHONE_COUNTRY_CODE: "US",
  PUBLIC_APP_URL: "https://desk.example.test",
  corsOrigins: [],
  FREESWITCH_ESL_ENABLED: true
} as unknown as AppConfig;
const routes: ManualOutboundRoute[] = [
  "/agent/manual-dial/start",
  "/agent/leads/:contactId/call",
  "/agent/call-next"
];
async function fixture() {
  const schema = `c04_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  const children: ReturnType<typeof fork>[] = [];
  const executorCleanup: Array<() => Promise<void>> = [];
  const roles: string[] = [];
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  await pool.query(
    "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict do nothing"
  );
  async function agent(campaignId: string) {
    const user = (
      await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'C04','agent','fixture') returning *",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0];
    const a = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','C04',true) returning id",
        [user.id, randomUUID()]
      )
    ).rows[0].id;
    const session = (
      await pool.query(
        `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at)
      values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp()) returning id`,
        [a, campaignId, randomUUID()]
      )
    ).rows[0].id;
    await pool.query(
      "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
      [a]
    );
    return { user, agentId: a as string, session: session as string };
  }
  async function seed(kind: "inbound" | "transfer" | "none" = "inbound", expired = false) {
    const campaignId = (
      await pool.query(
        "insert into campaigns(name,status,manual_dialing_enabled) values('C04','active',true) returning id"
      )
    ).rows[0].id as string;
    const actor = await agent(campaignId),
      other = await agent(campaignId),
      source = await agent(campaignId);
    const contactId = (
      await pool.query(
        "insert into contacts(campaign_id,phone_number,normalized_phone_number) values($1,'+14155550100','+14155550100') returning id",
        [campaignId]
      )
    ).rows[0].id as string;
    const queue = (
      await pool.query("insert into inbound_queues(campaign_id,name) values($1,'C04') returning id", [
        campaignId
      ])
    ).rows[0].id;
    const callId = (
      await pool.query(
        `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+14155550101','+14155550101','inbound','queued','+14155550102','+14155550101','+14155550102',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
        [campaignId, queue]
      )
    ).rows[0].id as string;
    let transferId: string | null = null;
    if (kind === "transfer") {
      await pool.query("update calls set state='agent_connected',agent_id=$2 where id=$1", [
        callId,
        source.agentId
      ]);
      const participant = (
        await pool.query(
          "insert into call_participants(call_id,role,agent_id,joined_at,connected_at) values($1,'agent',$2,clock_timestamp(),clock_timestamp()) returning id",
          [callId, source.agentId]
        )
      ).rows[0].id;
      await pool.query(
        "insert into call_legs(call_id,type,participant_id,freeswitch_uuid,state) values($1,'agent',$2,$3,'answered')",
        [callId, participant, randomUUID()]
      );
      await pool.query(
        "update agent_call_slots set state='reserved',reservation_id=$2,call_id=$3,participant_id=$4 where agent_id=$1",
        [source.agentId, randomUUID(), callId, participant]
      );
      await pool.query("update agent_call_slots set state='active' where agent_id=$1", [source.agentId]);
      transferId = (
        await pool.query(
          `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at)
        values($1,1,$2,$3,$4,clock_timestamp()+interval '1 hour') returning id`,
          [callId, source.agentId, participant, actor.agentId]
        )
      ).rows[0].id;
    }
    async function offer(who: typeof actor) {
      return (
        await pool.query(
          `insert into call_offers(call_id,agent_id,kind,transfer_id,attempt,desk_session_id,desk_revision,binding_generation,created_at,deadline_at)
        values($1,$2,$3,$4,1,$5,1,1,clock_timestamp()-interval '2 hours',clock_timestamp()+case when $6 then -interval '1 hour' else interval '1 hour' end) returning id`,
          [callId, who.agentId, kind, transferId, who.session, expired]
        )
      ).rows[0].id as string;
    }
    const offerId = kind === "none" ? null : await offer(actor);
    const otherOffer = kind === "inbound" ? await offer(other) : null;
    const completed = (
      await pool.query(
        "insert into calls(campaign_id,destination_number,normalized_destination_number,agent_id,state,ended_at) values($1,'+14155550103','+14155550103',$2,'completed',clock_timestamp()) returning id",
        [campaignId, actor.agentId]
      )
    ).rows[0].id;
    await pool.query(
      `insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key,state,reason)
      values($1,$2,$3,$4,1,$5,'deferred','incoming_pending')`,
      [actor.agentId, completed, campaignId, actor.session, randomUUID()]
    );
    const request = (route: ManualOutboundRoute): ManualOutboundRequest => ({
      actorUserId: actor.user.id,
      route,
      ...(route === "/agent/leads/:contactId/call" ? { contactId } : { campaignId }),
      ...(route === "/agent/manual-dial/start" ? { phoneNumber: "001 (415) 555-0100" } : {}),
      intent: {
        deskSessionId: actor.session,
        expectedRevision: "1",
        bindingGeneration: "1",
        idempotencyKey: randomUUID(),
        startReason: "manual"
      }
    });
    return { actor, other, source, callId, campaignId, contactId, offerId, otherOffer, transferId, request };
  }
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "calls",
          "agents",
          "contacts",
          "agent_desk_sessions",
          "agent_call_slots",
          "call_offers",
          "call_offer_exclusions",
          "call_transfers",
          "call_participants",
          "call_legs",
          "call_operations",
          "call_execution_keys",
          "call_capacity_reservations",
          "agent_auto_next_intents",
          "call_events"
        ].map(async (t) => [
          t,
          (await pool.query(`select to_jsonb(t) as row from ${t} t order by to_jsonb(t)::text`)).rows.map(
            (r) => r.row
          )
        ])
      )
    );
  async function report(name: string, checks: unknown) {
    if (process.env.INBOUND_TEST_ARTIFACTS)
      await writeFile(
        `${process.env.INBOUND_TEST_ARTIFACTS}/c04-${name}.json`,
        JSON.stringify(
          {
            status: "passed",
            database: (await pool.query("select version()")).rows[0].version,
            media: "none; executor wake simulated, zero physical ESL sends",
            checks,
            snapshot: await snapshot()
          },
          null,
          2
        ) + "\n"
      );
  }
  const wakes: string[] = [];
  let runWake: (id: string) => Promise<void> = async () => {};
  const app = Fastify();
  await app.register(cookie);
  registerCookieCsrfProtection(app, config);
  app.setErrorHandler((e, _req, reply) =>
    e instanceof ZodError ? reply.code(400).send({ message: "Validation failed" }) : reply.send(e)
  );
  registerDashboardRoutes(app, config, pool, undefined, {
    async wakeExecutor(id) {
      wakes.push(id);
      await runWake(id);
    }
  });
  async function api(req: ManualOutboundRequest, headers?: Record<string, string>) {
    const user = (await pool.query("select * from users where id=$1", [req.actorUserId])).rows[0];
    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.auth_version
    });
    const { route, contactId, actorUserId: _actor, ...payload } = req;
    void _actor;
    return app.inject({
      method: "POST",
      url: route.replace(":contactId", contactId ?? ""),
      headers: headers ?? { authorization: `Bearer ${token}` },
      payload
    });
  }
  function worker(input: object) {
    const child = fork(
      new URL("../../../tests/fixtures/inbound/manual-outbound-worker.mjs", import.meta.url),
      [schema, JSON.stringify(input)],
      {
        env: { PATH: process.env.PATH, TEST_DATABASE_URL: testDatabaseUrl() },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );
    children.push(child);
    const messages: any[] = [];
    let wake: (() => void) | undefined;
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("message", (m) => {
      messages.push(m);
      wake?.();
    });
    const exited = once(child, "exit");
    return {
      send: (type: string) => child.send({ type }),
      exited,
      async wait(type: string) {
        const deadline = Date.now() + 5000;
        while (true) {
          const i = messages.findIndex((m) => m.type === type);
          if (i >= 0) return messages.splice(i, 1)[0];
          assert.ok(Date.now() < deadline, `${type}: ${output} ${JSON.stringify(messages)}`);
          await new Promise<void>((r) => {
            const t = setTimeout(r, 20);
            wake = () => {
              clearTimeout(t);
              r();
            };
          });
          wake = undefined;
        }
      }
    };
  }
  return {
    pool,
    setWake(wake: (id: string) => Promise<void>) {
      runWake = wake;
    },
    async executor() {
      const { CallExecutor } = await import("./call-executor.js");
      const role = `c04_exec_${randomUUID().replaceAll("-", "")}`;
      roles.push(role);
      const database = await createFixtureLogin(admin, databaseConfig(testDatabaseUrl(), schema), role, 8);
      await pool.query(
        `grant usage on schema ${schema} to ${role};grant all on all tables in schema ${schema} to ${role};grant usage,select on all sequences in schema ${schema} to ${role}`
      );
      const executor = await CallExecutor.create(database, 0);
      executorCleanup.push(() => executor.close());
      return executor;
    },
    seed,
    snapshot,
    report,
    api,
    wakes,
    worker,
    async cleanup() {
      await app.close();
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null) {
          const p = once(c, "exit");
          c.kill("SIGKILL");
          await p;
        }
      for (const close of executorCleanup) await close();
      await pool.end();
      try {
        await admin.query(`drop schema ${schema} cascade`);
        assert.equal(
          (await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount,
          0
        );
      } finally {
        for (const role of roles) await admin.query(`drop role ${role}`);
        await admin.end();
      }
    }
  };
}

test(
  "C04.1 DB/API: three routes × offer kinds atomically dismiss only actor, preserve customer/source, reserve intent/slot/capacity",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const route of routes)
        for (const kind of ["inbound", "transfer", "none"] as const) {
          const f = await db.seed(kind),
            before = await db.snapshot();
          const response = await db.api(f.request(route));
          assert.equal(response.statusCode, 200, response.body);
          const result = response.json();
          const after = await db.snapshot();
          assert.deepEqual(
            after.calls.find((r: any) => r.id === f.callId),
            before.calls.find((r: any) => r.id === f.callId)
          );
          for (const t of ["call_participants", "call_legs"])
            assert.deepEqual(
              after[t].filter((r: any) => r.call_id === f.callId),
              before[t].filter((r: any) => r.call_id === f.callId)
            );
          assert.deepEqual(
            after.agent_call_slots.find((r: any) => r.agent_id === f.source.agentId),
            before.agent_call_slots.find((r: any) => r.agent_id === f.source.agentId)
          );
          if (f.otherOffer)
            assert.deepEqual(
              after.call_offers.find((r: any) => r.id === f.otherOffer),
              before.call_offers.find((r: any) => r.id === f.otherOffer)
            );
          if (f.offerId) {
            const o = after.call_offers.find((r: any) => r.id === f.offerId);
            assert.equal(o.state, kind === "inbound" ? "ignored" : "declined");
            assert.equal(o.reason, "manual_outbound_started");
          }
          if (f.transferId)
            assert.equal(after.call_transfers.find((r: any) => r.id === f.transferId).state, "declined");
          assert.equal(after.call_operations.filter((r: any) => r.call_id === result.callId).length, 1);
          assert.equal(
            after.call_capacity_reservations.filter((r: any) => r.call_id === result.callId).length,
            3
          );
          assert.equal(after.call_participants.filter((r: any) => r.call_id === result.callId).length, 2);
          assert.equal(
            after.agent_call_slots.find((r: any) => r.agent_id === f.actor.agentId).call_id,
            result.callId
          );
          assert.equal(
            after.agent_auto_next_intents.find((r: any) => r.agent_id === f.actor.agentId).reason,
            "manual_outbound_started"
          );
          assert.equal(
            after.contacts.find((r: any) => r.id === f.contactId).attempt_count,
            route === "/agent/manual-dial/start" ? 0 : 1
          );
          assert.equal(db.wakes.filter((id) => id === result.operationId).length, 1);
          if (kind === "none")
            assert.equal(after.call_offer_exclusions.filter((r: any) => r.call_id === f.callId).length, 0);
          checks.push({ route, kind, result });
        }
      await db.report("route-matrix", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test("C04.2 DB/API failures roll back complete state; expiry keeps deadline cause", options, async () => {
  const db = await fixture();
  try {
    const cases = [
      "suppressed",
      "paused",
      "maintenance",
      "readiness",
      "campaign",
      "manual-disabled",
      "retry",
      "attempts",
      "calling",
      "authorization",
      "db-failure",
      "capacity",
      "stale-revision",
      "wrong-controller"
    ];
    const checks = [];
    for (const route of routes)
      for (const kind of ["inbound", "transfer"] as const)
        for (const fail of cases) {
          if (
            (fail === "manual-disabled" && route !== "/agent/manual-dial/start") ||
            (["retry", "attempts", "calling"].includes(fail) && route === "/agent/manual-dial/start")
          )
            continue;
          const f = await db.seed(kind),
            request = f.request(route);
          if (fail === "suppressed")
            await db.pool.query(
              "insert into suppression_entries(phone_number,normalized_phone_number,reason) values('+14155550100','+14155550100','fixture') on conflict do nothing"
            );
          if (fail === "paused")
            await db.pool.query("update agents set availability_status='paused' where id=$1", [
              f.actor.agentId
            ]);
          if (fail === "maintenance")
            await db.pool.query(
              "update system_settings set value_json='true' where key='ops.call_start_paused'"
            );
          if (fail === "readiness")
            await db.pool.query("update agent_desk_sessions set ready=false where id=$1", [f.actor.session]);
          if (fail === "campaign")
            await db.pool.query("update campaigns set status='paused' where id=$1", [f.campaignId]);
          if (fail === "manual-disabled")
            await db.pool.query("update campaigns set manual_dialing_enabled=false where id=$1", [
              f.campaignId
            ]);
          if (fail === "retry")
            await db.pool.query("update contacts set last_attempted_at=clock_timestamp() where id=$1", [
              f.contactId
            ]);
          if (fail === "attempts")
            await db.pool.query("update contacts set attempt_count=3 where id=$1", [f.contactId]);
          if (fail === "calling")
            await db.pool.query("update contacts set status='calling' where id=$1", [f.contactId]);
          if (fail === "authorization")
            await db.pool.query("update users set is_active=false where id=$1", [f.actor.user.id]);
          if (fail === "stale-revision") request.intent.expectedRevision = "2";
          if (fail === "wrong-controller") request.intent.deskSessionId = f.other.session;
          if (fail === "db-failure")
            await db.pool.query(
              `create function c04_fail() returns trigger language plpgsql as $$ begin raise exception 'fixture commit failure'; end $$;
        create constraint trigger c04_fail before_never after insert on call_events deferrable initially deferred for each row execute function c04_fail()`.replace(
                " before_never",
                ""
              )
            );
          if (fail === "capacity")
            await db.pool.query(
              `insert into system_settings(key,value_json) values('calls.capacity_limits',$1) on conflict(key) do update set value_json=excluded.value_json`,
              [
                {
                  queue: 40,
                  channels: 1,
                  trunk: 32,
                  forwarding: 4,
                  supervisor: 4,
                  transferOverlap: 4,
                  fsChannels: 80,
                  fsTrunk: 40,
                  preAdmission: 8
                }
              ]
            );
          const before = await db.snapshot(),
            wakeCount = db.wakes.length;
          const response = await db.api(request);
          assert.ok(response.statusCode >= 400, `${route} ${kind} ${fail}: ${response.body}`);
          assert.deepEqual(await db.snapshot(), before, `${route} ${kind} ${fail}`);
          assert.equal(db.wakes.length, wakeCount);
          if (fail === "db-failure")
            await db.pool.query("drop trigger c04_fail on call_events;drop function c04_fail()");
          await db.pool.query(
            "update system_settings set value_json='false' where key='ops.call_start_paused'"
          );
          await db.pool.query("delete from system_settings where key='calls.capacity_limits'");
          await db.pool.query("delete from suppression_entries where normalized_phone_number='+14155550100'");
          checks.push({ route, kind, fail, status: response.statusCode });
        }
    const f = await db.seed("inbound", true);
    const response = await db.api(f.request("/agent/manual-dial/start"));
    assert.equal(response.statusCode, 200, response.body);
    const expired = (await db.pool.query("select state,reason from call_offers where id=$1", [f.offerId]))
      .rows[0];
    assert.deepEqual(expired, { state: "expired", reason: "deadline_elapsed" });
    await db.report("failure-matrix", checks);
  } finally {
    await db.cleanup();
  }
});

test(
  "C04.3 cross-process manual versus own acceptance: inbound/transfer, both commit orders and rollback",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const kind of ["inbound", "transfer"] as const)
        for (const first of ["manual", "accept"] as const)
          for (const rollback of [false, true]) {
            const f = await db.seed(kind),
              sourceBefore = await db.snapshot();
            const manual = db.worker({
              mode: "manual",
              config,
              request: f.request("/agent/leads/:contactId/call")
            });
            const accept = db.worker({
              mode: "accept",
              agentId: f.actor.agentId,
              userId: f.actor.user.id,
              campaignId: f.campaignId,
              callId: f.callId,
              deskSessionId: f.actor.session,
              expectedRevision: "1",
              bindingGeneration: "1",
              offerId: f.offerId,
              transferId: f.transferId
            });
            await Promise.all([manual.wait("ready"), accept.wait("ready")]);
            const winner = first === "manual" ? manual : accept,
              loser = first === "manual" ? accept : manual;
            winner.send("start");
            const w = await winner.wait("connected");
            await winner.wait("before-commit");
            loser.send("start");
            const l = await loser.wait("connected");
            assert.notEqual(w.backend, l.backend);
            assert.notEqual(w.pid, l.pid);
            await assertBlocked(db.pool, l.backend, w.backend);
            winner.send(rollback ? "rollback" : "commit");
            const winResult = await winner.wait(rollback ? "rejected" : "committed");
            if (rollback) {
              await loser.wait("before-commit");
              loser.send("commit");
            }
            const loseResult = await loser.wait(rollback ? "committed" : "rejected");
            await Promise.all([winner.exited, loser.exited]);
            if (!rollback)
              assert.ok(
                ["slot_occupied", "offer_closed"].includes(loseResult.reason),
                JSON.stringify(loseResult)
              );
            const after = await db.snapshot(),
              manualWon = (first === "manual") !== rollback;
            assert.equal(
              after.contacts.find((r: any) => r.id === f.contactId).attempt_count,
              manualWon ? 1 : 0
            );
            const slot = after.agent_call_slots.find((r: any) => r.agent_id === f.actor.agentId);
            const offer = after.call_offers.find((r: any) => r.id === f.offerId);
            assert.equal(offer.state, manualWon ? (kind === "inbound" ? "ignored" : "declined") : "accepted");
            assert.equal(slot.call_id === f.callId, !manualWon);
            assert.equal(
              after.call_operations.filter((r: any) => r.request?.slot?.agentId === f.actor.agentId).length,
              manualWon ? 1 : 0
            );
            assert.equal(
              after.call_capacity_reservations.filter((r: any) => r.agent_id === f.actor.agentId).length,
              manualWon ? 3 : 0
            );
            if (kind === "transfer") {
              assert.deepEqual(
                after.calls.find((r: any) => r.id === f.callId),
                sourceBefore.calls.find((r: any) => r.id === f.callId)
              );
              assert.deepEqual(
                after.agent_call_slots.find((r: any) => r.agent_id === f.source.agentId),
                sourceBefore.agent_call_slots.find((r: any) => r.agent_id === f.source.agentId)
              );
              assert.deepEqual(
                after.call_participants.filter((r: any) => r.call_id === f.callId),
                sourceBefore.call_participants.filter((r: any) => r.call_id === f.callId)
              );
              assert.deepEqual(
                after.call_legs.filter((r: any) => r.call_id === f.callId),
                sourceBefore.call_legs.filter((r: any) => r.call_id === f.callId)
              );
            }
            checks.push({ kind, first, rollback, w, l, winResult, loseResult });
          }
      await db.report("own-accept-races", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C04.3 other inbound winner and concurrent source terminal/transfer closure preserve valid manual start",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const mode of ["other", "terminal"] as const)
        for (const first of ["manual", "transition"] as const) {
          const f = await db.seed(mode === "other" ? "inbound" : "transfer");
          const manual = db.worker({
            mode: "manual",
            config,
            request: f.request("/agent/manual-dial/start")
          });
          const transition = db.worker({
            mode: mode === "other" ? "accept" : "terminal",
            agentId: f.other.agentId,
            userId: f.other.user.id,
            campaignId: f.campaignId,
            callId: f.callId,
            deskSessionId: f.other.session,
            expectedRevision: "1",
            bindingGeneration: "1",
            offerId: f.otherOffer
          });
          await Promise.all([manual.wait("ready"), transition.wait("ready")]);
          const winner = first === "manual" ? manual : transition,
            loser = first === "manual" ? transition : manual;
          winner.send("start");
          const w = await winner.wait("connected");
          await winner.wait("before-commit");
          loser.send("start");
          const l = await loser.wait("connected");
          await assertBlocked(db.pool, l.backend, w.backend);
          winner.send("commit");
          await winner.wait("committed");
          // Changed source membership requires bounded rediscovery, which leases no second connection.
          await loser.wait("before-commit");
          loser.send("commit");
          await loser.wait("committed");
          await Promise.all([winner.exited, loser.exited]);
          const snapshot = await db.snapshot();
          assert.equal(
            snapshot.call_operations.filter((r: any) => r.request?.slot?.agentId === f.actor.agentId).length,
            1
          );
          assert.notEqual(
            snapshot.agent_call_slots.find((r: any) => r.agent_id === f.actor.agentId).call_id,
            f.callId
          );
          if (mode === "other") {
            assert.equal(
              snapshot.agent_call_slots.find((r: any) => r.agent_id === f.other.agentId).call_id,
              f.callId
            );
            assert.equal(snapshot.calls.find((r: any) => r.id === f.callId).agent_id, f.other.agentId);
          } else {
            assert.equal(
              snapshot.call_transfers.find((r: any) => r.id === f.transferId).state,
              first === "manual" ? "declined" : "canceled"
            );
            assert.equal(snapshot.calls.find((r: any) => r.id === f.callId).state, "completed");
          }
          checks.push({ mode, first, w, l });
        }
      await db.report("source-races", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C04.4 durable replay after terminal failure, changed payload conflict, duplicate workers and no unseen-call exclusions",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const route of routes) {
        const f = await db.seed("none"),
          req = f.request(route);
        const one = db.worker({ mode: "manual", config, request: req }),
          two = db.worker({ mode: "manual", config, request: req });
        await Promise.all([one.wait("ready"), two.wait("ready")]);
        one.send("start");
        const a = await one.wait("connected");
        await one.wait("before-commit");
        two.send("start");
        const b = await two.wait("connected");
        await assertBlocked(db.pool, b.backend, a.backend);
        one.send("commit");
        const result = (await one.wait("committed")).result;
        await two.wait("before-commit");
        two.send("commit");
        const duplicate = (await two.wait("committed")).result;
        await Promise.all([one.exited, two.exited]);
        assert.equal(duplicate.callId, result.callId);
        assert.equal(duplicate.operationId, result.operationId);
        // Simulated definitive before-send failure, not runtime or provider proof.
        await db.pool.query(
          "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='fixture definitive no-send failure' where id=$1",
          [result.operationId]
        );
        await db.pool.query(
          "update calls set state='failed',outcome='failed',ended_at=clock_timestamp() where id=$1",
          [result.callId]
        );
        await db.pool.query("update system_settings set value_json='true' where key='ops.call_start_paused'");
        const before = await db.snapshot();
        const response = await db.api(req);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().callId, result.callId);
        assert.equal(db.wakes.length, 0);
        assert.deepEqual(await db.snapshot(), before);
        const changed = structuredClone(req);
        changed.intent.bindingGeneration = "2";
        const conflict = await db.api(changed);
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.json().code, "idempotency_conflict");
        assert.deepEqual(await db.snapshot(), before);
        assert.equal(before.call_offer_exclusions.filter((r: any) => r.call_id === f.callId).length, 0);
        await db.pool.query(
          "update system_settings set value_json='false' where key='ops.call_start_paused'"
        );
        checks.push({ route, result, duplicate });
      }
      // Once committed, failure cannot resurrect the pending offer or declined source transfer.
      for (const kind of ["inbound", "transfer"] as const) {
        const f = await db.seed(kind),
          req = f.request("/agent/manual-dial/start");
        const response = await db.api(req);
        assert.equal(response.statusCode, 200, response.body);
        const result = response.json();
        const before = await db.pool.query("select * from call_offers where id=$1", [f.offerId]);
        await db.pool.query(
          "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='fixture definitive no-send failure' where id=$1",
          [result.operationId]
        );
        assert.equal((await db.api(req)).json().callId, result.callId);
        assert.deepEqual(
          (await db.pool.query("select * from call_offers where id=$1", [f.offerId])).rows,
          before.rows
        );
      }
      await db.report("durable-replay", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C04 API authentication, actor spoofing, CSRF and automatic intent stay fail closed",
  options,
  async () => {
    const db = await fixture();
    try {
      for (const route of routes) {
        const f = await db.seed("inbound"),
          req = f.request(route),
          before = await db.snapshot();
        assert.equal((await db.api(req, {})).statusCode, 401);
        assert.equal(
          (await db.api({ ...req, intent: { ...req.intent, agentId: f.other.agentId } } as any)).statusCode,
          400
        );
        const token = signAuthToken(config, {
          sub: f.actor.user.id,
          email: f.actor.user.email,
          role: "agent",
          ver: 1
        });
        assert.equal(
          (
            await db.api(req, {
              cookie: `${SESSION_COOKIE_NAME}=${token}`,
              origin: "https://untrusted.example.test"
            })
          ).statusCode,
          403
        );
        if (route === "/agent/call-next")
          assert.equal(
            (
              await db.api({
                ...req,
                intent: { ...req.intent, startReason: "automatic", sourceCallId: f.callId }
              } as any)
            ).statusCode,
            409
          );
        assert.deepEqual(await db.snapshot(), before);
        assert.equal(db.wakes.length, 0);
      }
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C04.2 actual contact lock contention and confirmation rules; C03 pre-send native token revalidation",
  options,
  async () => {
    const { withCallAdmission } = await import("./call-admission.js");
    const { validateManualOutboundCommand } = await import("./manual-outbound.js");
    const db = await fixture();
    try {
      for (const route of routes.slice(1)) {
        const f = await db.seed("inbound"),
          req = f.request(route),
          blocker = await db.pool.connect();
        try {
          await blocker.query("begin");
          await blocker.query("select id from contacts where id=$1 for update", [f.contactId]);
          const before = await db.snapshot();
          const response = await db.api(req);
          assert.equal(response.statusCode, 409, response.body);
          assert.deepEqual(await db.snapshot(), before);
        } finally {
          await blocker.query("rollback");
          blocker.release();
        }
      }
      const f = await db.seed("inbound"),
        req = f.request("/agent/leads/:contactId/call");
      await db.pool.query("update contacts set status='completed' where id=$1", [f.contactId]);
      assert.equal((await db.api(req)).statusCode, 409);
      req.confirmCompletedLead = true;
      const response = await db.api(req);
      assert.equal(response.statusCode, 200, response.body);
      const op = (
        await db.pool.query("select * from call_operations where id=$1", [response.json().operationId])
      ).rows[0];
      const client = await db.pool.connect();
      const valid = () =>
        withCallAdmission(client, { callIds: [op.call_id] }, (a) => validateManualOutboundCommand(op, a));
      try {
        assert.equal(await valid(), true);
        await db.pool.query("update agent_desk_sessions set ready=false where id=$1", [f.actor.session]);
        assert.equal(await valid(), false);
        await db.pool.query("update agent_desk_sessions set ready=true where id=$1", [f.actor.session]);
        await db.pool.query("update agents set availability_status='paused' where id=$1", [f.actor.agentId]);
        assert.equal(await valid(), false);
        await db.pool.query("update agents set availability_status='available' where id=$1", [
          f.actor.agentId
        ]);
        assert.equal(
          await withCallAdmission(client, { callIds: [op.call_id] }, (a) =>
            validateManualOutboundCommand({ ...op, generation: "999" }, a)
          ),
          false
        );
      } finally {
        client.release();
      }
      assert.equal(db.wakes.length, 1);
      await db.report("contention-and-revalidation", {
        contactLocks: "FOR UPDATE held by separate connection; zero failed-start mutations",
        nativeToken: true
      });
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C04.4 HTTP -> real C03 executor with simulated ESL: one send, post-commit failure and stale pre-send state never restore offers",
  options,
  async () => {
    const { manualOutboundExecutor } = await import("./manual-outbound.js");
    const db = await fixture();
    try {
      const executor = await db.executor(),
        sends: string[] = [];
      const dispatcher = manualOutboundExecutor(executor, {
        async send(op) {
          sends.push(op.id);
          return {
            state: "failed",
            result: { reason: "simulated originate failure" },
            evidence: "fixture definitive before-send rejection"
          };
        },
        async reconcile() {
          return null;
        }
      });
      db.setWake(dispatcher.wakeExecutor);
      const f = await db.seed("inbound"),
        req = f.request("/agent/manual-dial/start");
      const response = await db.api(req);
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.deepEqual(sends, [result.operationId]);
      assert.equal(
        (await db.pool.query("select state from call_operations where id=$1", [result.operationId])).rows[0]
          .state,
        "failed"
      );
      assert.equal(
        (await db.pool.query("select state from call_offers where id=$1", [f.offerId])).rows[0].state,
        "ignored"
      );
      assert.equal((await db.api(req)).json().callId, result.callId);
      assert.equal(sends.length, 1);
      // A committed offer dismissal survives revalidation cancellation too.
      const g = await db.seed("transfer");
      db.setWake(async (id) => {
        await db.pool.query("update agent_desk_sessions set ready=false where id=$1", [g.actor.session]);
        await dispatcher.wakeExecutor(id);
      });
      const stale = await db.api(g.request("/agent/manual-dial/start"));
      assert.equal(stale.statusCode, 200, stale.body);
      assert.equal(
        (await db.pool.query("select state from call_operations where id=$1", [stale.json().operationId]))
          .rows[0].state,
        "canceled"
      );
      assert.equal(sends.length, 1);
      assert.equal(
        (await db.pool.query("select state from call_transfers where id=$1", [g.transferId])).rows[0].state,
        "declined"
      );
      // Wake transport failure retains the committed operation for scheduler discovery.
      const h = await db.seed("inbound");
      db.setWake(async () => {
        throw new Error("fixture scheduler unavailable");
      });
      const wakeRequest = h.request("/agent/manual-dial/start"),
        wakeFailure = await db.api(wakeRequest);
      assert.equal(wakeFailure.statusCode, 200, wakeFailure.body);
      assert.equal(
        (
          await db.pool.query("select state from call_operations where id=$1", [
            wakeFailure.json().operationId
          ])
        ).rows[0].state,
        "pending"
      );
      assert.equal((await db.api(wakeRequest)).json().callId, wakeFailure.json().callId);
      assert.equal(sends.length, 1);
      await db.report("real-executor", {
        sends,
        failed: result,
        canceled: stale.json(),
        pending: wakeFailure.json(),
        physicalESL: 0
      });
    } finally {
      await db.cleanup();
    }
  }
);

test("C04.2 authenticated version is rechecked after waiting for admission", options, async () => {
  const db = await fixture();
  try {
    const f = await db.seed("inbound"),
      request = f.request("/agent/manual-dial/start");
    request.actorAuthVersion = 1;
    const blocker = await db.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(72202,0)");
      const backend = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
      const worker = db.worker({ mode: "manual", config, request });
      await worker.wait("ready");
      worker.send("start");
      const waiter = await worker.wait("connected");
      await assertBlocked(db.pool, waiter.backend, backend);
      await blocker.query("update users set auth_version=auth_version+1 where id=$1", [f.actor.user.id]);
      const before = await db.snapshot();
      await blocker.query("commit");
      assert.equal((await worker.wait("rejected")).reason, "session_revoked");
      await worker.exited;
      assert.deepEqual(await db.snapshot(), before);
      assert.equal(db.wakes.length, 0);
      await db.report("auth-version-race", { backend, waiter });
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
  } finally {
    await db.cleanup();
  }
});
