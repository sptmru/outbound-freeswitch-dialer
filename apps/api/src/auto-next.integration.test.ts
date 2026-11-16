import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import type { AppConfig } from "./config.js";
import {
  type AutomaticOutboundRequest,
  type CoordinatedOutboundRequest,
  type ManualOutboundRequest,
  type ManualOutboundRoute
} from "./manual-outbound.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "./security.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const config = {
  JWT_SECRET: "c05-isolated-test-only-signing-secret",
  JWT_EXPIRES_SECONDS: 3600,
  CONTACT_MAX_ATTEMPTS: 3,
  CONTACT_RETRY_DELAY_SECONDS: 900,
  DEFAULT_PHONE_COUNTRY_CODE: "US",
  PUBLIC_APP_URL: "https://desk.example.test",
  corsOrigins: [],
  FREESWITCH_ESL_ENABLED: true
} as unknown as AppConfig;
async function fixture(upgrade = false) {
  const schema = `c05_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  const children: ReturnType<typeof fork>[] = [];
  const executorCleanup: Array<() => Promise<void>> = [];
  const roles: string[] = [];
  if (!upgrade) await runMigrations(pool);
  else {
    const directory = new URL("../db/migrations/", import.meta.url);
    await pool.query(
      "create table schema_migrations(filename text primary key,checksum_sha256 text,applied_at timestamptz not null default now())"
    );
    for (const name of (await readdir(directory))
      .filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "030_")
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      if (/^\s*--\s*outbound-dialer:no-transaction\b/m.test(sql)) {
        for (const statement of sql
          .split(/^\s*--\s*outbound-dialer:statement\s*$/m)
          .map((s) => s.trim())
          .filter(Boolean))
          await pool.query(statement);
      } else await pool.query(sql);
      await pool.query("insert into schema_migrations(filename,checksum_sha256) values($1,$2)", [
        name,
        createHash("sha256").update(sql).digest("hex")
      ]);
    }
  }
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  await pool.query(
    "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict do nothing"
  );
  async function agent(campaignId: string) {
    const user = (
      await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'C05','agent','fixture') returning *",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0];
    const a = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','C05',true) returning id",
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
  async function seed(
    kind: "inbound" | "transfer" | "none" = "inbound",
    expired = false,
    sourceState = "completed"
  ) {
    const campaignId = (
      await pool.query(
        "insert into campaigns(name,status,manual_dialing_enabled,auto_advance_to_next_lead_enabled) values('C05','active',true,true) returning id"
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
      await pool.query("insert into inbound_queues(campaign_id,name) values($1,'C05') returning id", [
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
        "insert into calls(campaign_id,destination_number,normalized_destination_number,agent_id,contact_id,state,ended_at) values($1,'+14155550103','+14155550103',$2,$3,$4,case when $4='completed' then clock_timestamp() else null end) returning id",
        [campaignId, actor.agentId, contactId, sourceState]
      )
    ).rows[0].id;
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
    return {
      completed: completed as string,
      actor,
      other,
      source,
      callId,
      campaignId,
      contactId,
      offerId,
      otherOffer,
      transferId,
      request
    };
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
        `${process.env.INBOUND_TEST_ARTIFACTS}/c05-${name}.json`,
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
  async function api(req: CoordinatedOutboundRequest, headers?: Record<string, string>) {
    const user = (await pool.query("select * from users where id=$1", [req.actorUserId])).rows[0];
    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.auth_version
    });
    const { route, contactId, actorUserId: _actor, ...payload } = req as ManualOutboundRequest;
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
      const role = `c05_exec_${randomUUID().replaceAll("-", "")}`;
      roles.push(role);
      await admin.query(`create role ${role} login connection limit 8`);
      await pool.query(
        `grant usage on schema ${schema} to ${role};grant all on all tables in schema ${schema} to ${role};grant usage,select on all sequences in schema ${schema} to ${role}`
      );
      const url = new URL(testDatabaseUrl());
      url.username = role;
      const executor = await CallExecutor.create(databaseConfig(url.toString(), schema), 0);
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

type Seed = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["seed"]>>;
function automatic(f: Seed): AutomaticOutboundRequest {
  return {
    actorUserId: f.actor.user.id,
    campaignId: f.campaignId,
    route: "/agent/call-next",
    intent: {
      startReason: "automatic",
      sourceCallId: f.completed,
      deskSessionId: f.actor.session,
      expectedRevision: "1",
      bindingGeneration: "1",
      idempotencyKey: randomUUID()
    }
  };
}
async function exclude(db: Awaited<ReturnType<typeof fixture>>, f: Seed, state: "ignored" | "expired") {
  assert.ok(f.offerId);
  await db.pool.query("update call_offers set state=$2,reason=$3,closed_at=clock_timestamp() where id=$1", [
    f.offerId,
    state,
    state === "expired" ? "deadline_elapsed" : "user_ignored"
  ]);
}
function noDialChanges(before: any, after: any) {
  for (const table of [
    "calls",
    "contacts",
    "call_operations",
    "call_participants",
    "call_legs",
    "agent_call_slots",
    "call_capacity_reservations",
    "call_offers",
    "call_transfers"
  ])
    assert.deepEqual(after[table], before[table], table);
}

test(
  "C05.1/C05.3: queued work without offers defers before contact selection; ignore/expiry reevaluates same FIFO intent",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const state of ["ignored", "expired"] as const) {
        const f = await db.seed("inbound"),
          req = automatic(f);
        const before = await db.snapshot();
        let response = await db.api(req);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().status, "deferred");
        const id = response.json().intent.id;
        noDialChanges(before, await db.snapshot());
        assert.equal(db.wakes.length, checks.length);
        // Close actor's offer; unseen second FIFO call still defers the SAME intent.
        await exclude(db, f, state);
        const unseen = (
          await db.pool.query(
            `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
        select campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,clock_timestamp(),clock_timestamp()+interval '1 hour' from calls where id=$1 returning id`,
            [f.callId]
          )
        ).rows[0].id;
        response = await db.api(req);
        assert.equal(response.json().intent.id, id, response.body);
        assert.equal(
          (await db.pool.query("select count(*) from call_operations")).rows[0].count,
          String(checks.length)
        );
        // Persistent exclusion survives queue reentry and does not use Desk identity.
        await db.pool.query("update calls set queue_exited_at=clock_timestamp() where id=$1", [f.callId]);
        await db.pool.query("update calls set queue_exited_at=null where id=$1", [f.callId]);
        await db.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
          unseen
        ]);
        response = await db.api(req);
        assert.equal(response.json().status, "started", response.body);
        assert.equal(
          (
            await db.pool.query("select id from agent_auto_next_intents where source_call_id=$1", [
              f.completed
            ])
          ).rows[0].id,
          id
        );
        assert.equal(
          (await db.pool.query("select attempt_count from contacts where id=$1", [f.contactId])).rows[0]
            .attempt_count,
          1
        );
        checks.push({ state, id, result: response.json() });
      }
      await db.report("fifo-exclusions", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.2 DB/API: workers/tabs share source identity across keys; terminal replay and changed fingerprint",
  options,
  async () => {
    const db = await fixture();
    try {
      const f = await db.seed("none");
      await db.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
        f.callId
      ]);
      const req = automatic(f),
        second = { ...req, intent: { ...req.intent, idempotencyKey: randomUUID() } };
      const workers = [
        db.worker({ mode: "automatic", config, request: req }),
        db.worker({ mode: "automatic", config, request: second })
      ];
      await Promise.all(workers.map((w) => w.wait("ready")));
      workers[0].send("start");
      const firstBackend = await workers[0].wait("connected");
      await workers[0].wait("before-commit");
      workers[1].send("start");
      const secondBackend = await workers[1].wait("connected");
      await assertBlocked(db.pool, secondBackend.backend, firstBackend.backend);
      workers[0].send("commit");
      const first = await workers[0].wait("committed");
      await workers[1].wait("before-commit");
      workers[1].send("commit");
      const other = await workers[1].wait("committed");
      await Promise.all(workers.map((w) => w.exited));
      assert.equal(first.result.callId, other.result.callId);
      assert.equal(other.result.replayed, true);
      const id = first.result.callId;
      await db.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [id]);
      await db.pool.query("update system_settings set value_json='true' where key='ops.call_start_paused'");
      assert.equal((await db.api(req)).json().callId, id);
      const changed = await db.api({ ...req, intent: { ...req.intent, expectedRevision: "2" } });
      assert.equal(changed.statusCode, 409, changed.body);
      assert.equal(changed.json().code, "idempotency_conflict");
      assert.equal(
        (await db.pool.query("select attempt_count from contacts where id=$1", [f.contactId])).rows[0]
          .attempt_count,
        1
      );
      assert.equal((await db.pool.query("select count(*) from call_operations")).rows[0].count, "1");
      assert.equal(db.wakes.length, 0);
      await db.report("source-replay", {
        first,
        other,
        firstBackend,
        secondBackend,
        changed: changed.json()
      });
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.1 DB: enqueue versus automatic admission, both commit orders and first writer rollback",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const autoFirst of [false, true])
        for (const rollback of [false, true]) {
          const f = await db.seed("none"),
            req = automatic(f);
          await db.pool.query("update calls set state='received' where id=$1", [f.callId]);
          const enqueue = {
            mode: "sql",
            agentId: f.actor.agentId,
            callId: f.callId,
            campaignId: f.campaignId,
            statements: [{ sql: "update calls set state='queued' where id=$1", values: [f.callId] }]
          };
          const auto = { mode: "automatic", config, request: req };
          const w1 = db.worker(autoFirst ? auto : enqueue),
            w2 = db.worker(autoFirst ? enqueue : auto);
          await Promise.all([w1.wait("ready"), w2.wait("ready")]);
          w1.send("start");
          const p1 = await w1.wait("connected");
          await w1.wait("before-commit");
          w2.send("start");
          const p2 = await w2.wait("connected");
          await assertBlocked(db.pool, p2.backend, p1.backend);
          w1.send(rollback ? "rollback" : "commit");
          const first = await w1.wait(rollback ? "rejected" : "committed");
          await w2.wait("before-commit");
          w2.send("commit");
          const second = await w2.wait("committed");
          await Promise.all([w1.exited, w2.exited]);
          const shouldStart = autoFirst ? !rollback : rollback;
          const intents = (
            await db.pool.query("select * from agent_auto_next_intents where source_call_id=$1", [
              f.completed
            ])
          ).rows;
          if (shouldStart) {
            assert.equal(intents[0].state, "started");
            const a = await db.pool.connect();
            try {
              const { withCallAdmission } = await import("./call-admission.js");
              const decision = await withCallAdmission(
                a,
                { agentIds: [f.actor.agentId], userIds: [f.actor.user.id], campaignIds: [f.campaignId] },
                (a) =>
                  a.eligibility({
                    agentId: f.actor.agentId,
                    userId: f.actor.user.id,
                    campaignId: f.campaignId,
                    deskSessionId: f.actor.session,
                    expectedRevision: "1",
                    bindingGeneration: "1"
                  })
              );
              assert.equal(decision.reason, "slot_occupied");
            } finally {
              a.release();
            }
          } else if (!autoFirst) assert.equal(intents[0].state, "deferred");
          else assert.equal(intents.length, 0);
          assert.equal(
            (await db.pool.query("select attempt_count from contacts where id=$1", [f.contactId])).rows[0]
              .attempt_count,
            shouldStart ? 1 : 0
          );
          assert.equal(db.wakes.length, 0);
          checks.push({ autoFirst, rollback, p1, p2, first, second, shouldStart });
        }
      await db.report("enqueue-races", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.4 DB/API: cancellation/revision/source matrix and confirmed outbound voicemail release",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const change of [
        "pause",
        "revision",
        "campaign",
        "controller",
        "binding",
        "disabled",
        "manual",
        "inbound",
        "handover",
        "foreign",
        "transferred_in",
        "transferred_out",
        "wrong_session",
        "unfinished",
        "unconfirmed_vm",
        "confirmed_vm"
      ]) {
        const f = await db.seed(
            "none",
            false,
            change.endsWith("_vm") ? "agent_released" : change === "unfinished" ? "bridged" : "completed"
          ),
          req = automatic(f);
        await db.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
          f.callId
        ]);
        if (change === "pause")
          await db.pool.query("update agents set availability_status='paused' where id=$1", [
            f.actor.agentId
          ]);
        if (change === "revision")
          await db.pool.query("update agent_desk_sessions set revision=2 where id=$1", [f.actor.session]);
        if (change === "campaign")
          await db.pool.query("update agent_desk_sessions set campaign_id=null where id=$1", [
            f.actor.session
          ]);
        if (change === "controller")
          await db.pool.query(
            "update agent_desk_sessions set revoked_at=clock_timestamp(),ready=false where id=$1",
            [f.actor.session]
          );
        if (change === "binding")
          await db.pool.query(
            "update agent_desk_sessions set binding_generation=2,ready=false,verified_endpoint=null,verified_generation=null,verified_at=null where id=$1",
            [f.actor.session]
          );
        if (change === "disabled")
          await db.pool.query("update campaigns set auto_advance_to_next_lead_enabled=false where id=$1", [
            f.campaignId
          ]);
        if (change === "manual")
          await db.pool.query("update calls set manual_dial=true where id=$1", [f.completed]);
        if (change === "inbound") req.intent.sourceCallId = f.callId;
        if (change === "handover" || change === "foreign")
          await db.pool.query("update calls set agent_id=$2 where id=$1", [f.completed, f.other.agentId]);
        if (change === "wrong_session") req.intent.deskSessionId = f.other.session;
        if (change === "transferred_in" || change === "transferred_out") {
          const sourceAgent = change === "transferred_in" ? f.other.agentId : f.actor.agentId;
          const recipient = change === "transferred_in" ? f.actor.agentId : f.other.agentId;
          const participant = (
            await db.pool.query(
              "insert into call_participants(call_id,role,agent_id) values($1,'agent',$2) returning id",
              [f.completed, sourceAgent]
            )
          ).rows[0].id;
          await db.pool.query(
            `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at,state,reason,closed_at)
          values($1,1,$2,$3,$4,clock_timestamp()+interval '1 hour','completed','transfer_completed',clock_timestamp())`,
            [f.completed, sourceAgent, participant, recipient]
          );
        }
        if (change.endsWith("_vm")) {
          await db.pool.query("update contacts set status='calling' where id=$1", [f.contactId]);
          await db.pool.query(
            "insert into contacts(campaign_id,phone_number,normalized_phone_number) values($1,'+14155550104','+14155550104')",
            [f.campaignId]
          );
          await db.pool.query(
            "update calls set state='agent_released',ended_at=null,agent_released_at=clock_timestamp() where id=$1",
            [f.completed]
          );
          if (change === "confirmed_vm") {
            await db.pool.query(
              "insert into call_events(call_id,agent_id,event_type,state) values($1,$2,'agent_released','agent_released')",
              [f.completed, f.actor.agentId]
            );
            await db.pool.query(
              "insert into call_legs(call_id,type,freeswitch_uuid,state,ended_at) values($1,'agent',$2,'ended',clock_timestamp())",
              [f.completed, randomUUID()]
            );
          }
        }
        const before = await db.snapshot(),
          response = await db.api(req);
        assert.equal(response.statusCode, change === "confirmed_vm" ? 200 : 409, response.body);
        if (change !== "confirmed_vm") noDialChanges(before, await db.snapshot());
        else assert.equal(response.json().status, "started", response.body);
        checks.push({ change, response: response.json() });
      }
      await db.report("source-cancellation", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.4 DB/API: deferred intent is canceled by manual or accepted inbound/transfer and never resurrects",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const kind of ["manual", "inbound", "transfer"] as const) {
        const f = await db.seed(kind === "transfer" ? "transfer" : "inbound"),
          req = automatic(f);
        const first = await db.api(req);
        assert.equal(first.json().status, "deferred", first.body);
        if (kind === "manual") {
          const response = await db.api(f.request("/agent/manual-dial/start"));
          assert.equal(response.statusCode, 200, response.body);
        } else {
          const w = db.worker({
            mode: "accept",
            agentId: f.actor.agentId,
            userId: f.actor.user.id,
            callId: f.callId,
            campaignId: f.campaignId,
            deskSessionId: f.actor.session,
            expectedRevision: "1",
            bindingGeneration: "1",
            offerId: f.offerId,
            transferId: f.transferId
          });
          await w.wait("ready");
          w.send("start");
          await w.wait("connected");
          await w.wait("before-commit");
          w.send("commit");
          await w.wait("committed");
          await w.exited;
        }
        const stored = (
          await db.pool.query("select * from agent_auto_next_intents where source_call_id=$1", [f.completed])
        ).rows[0];
        assert.equal(stored.state, "canceled");
        const before = await db.snapshot(),
          response = await db.api(req);
        assert.equal(response.statusCode, 409, response.body);
        noDialChanges(before, await db.snapshot());
        checks.push({ kind, reason: stored.reason, response: response.json() });
      }
      await db.report("eager-cancellation", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.3/C05.4 DB: expiry/revision while automatic waiter blocks is revalidated after commit or rollback",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const change of ["expiry", "revision", "pause", "disabled"] as const)
        for (const rollback of [false, true]) {
          const f = await db.seed("inbound"),
            req = automatic(f);
          const statements =
            change === "expiry"
              ? [
                  {
                    sql: "update call_offers set state='expired',reason='deadline_elapsed',closed_at=clock_timestamp() where id=$1",
                    values: [f.offerId]
                  }
                ]
              : change === "revision"
                ? [
                    {
                      sql: "update agent_desk_sessions set revision=2 where id=$1",
                      values: [f.actor.session]
                    }
                  ]
                : change === "pause"
                  ? [
                      {
                        sql: "update agents set availability_status='paused' where id=$1",
                        values: [f.actor.agentId]
                      }
                    ]
                  : [
                      {
                        sql: "update campaigns set auto_advance_to_next_lead_enabled=false where id=$1",
                        values: [f.campaignId]
                      }
                    ];
          const first = db.worker({
            mode: "sql",
            agentId: f.actor.agentId,
            callId: f.callId,
            campaignId: f.campaignId,
            statements
          });
          const second = db.worker({ mode: "automatic", config, request: req });
          await Promise.all([first.wait("ready"), second.wait("ready")]);
          first.send("start");
          const p1 = await first.wait("connected");
          await first.wait("before-commit");
          second.send("start");
          const p2 = await second.wait("connected");
          await assertBlocked(db.pool, p2.backend, p1.backend);
          first.send(rollback ? "rollback" : "commit");
          await first.wait(rollback ? "rejected" : "committed");
          await second.wait("before-commit");
          second.send("commit");
          const result = await second.wait("committed");
          await Promise.all([first.exited, second.exited]);
          assert.equal(
            result.result.status,
            rollback ? "deferred" : change === "expiry" ? "started" : "canceled"
          );
          assert.equal(
            (await db.pool.query("select attempt_count from contacts where id=$1", [f.contactId])).rows[0]
              .attempt_count,
            !rollback && change === "expiry" ? 1 : 0
          );
          checks.push({ change, rollback, p1, p2, result });
        }
      await db.report("post-lock-revalidation", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05 API/executor: late inbound preserves admitted operation; exact intent/token driver sends once; auth and CSRF fail closed",
  options,
  async () => {
    const db = await fixture();
    try {
      const f = await db.seed("none"),
        req = automatic(f);
      await db.pool.query("update calls set state='received' where id=$1", [f.callId]);
      const { manualOutboundExecutor } = await import("./manual-outbound.js");
      const executor = await db.executor();
      let sends = 0;
      const driver = {
        async send() {
          sends++;
          return {
            state: "succeeded" as const,
            result: { fixture: "C05 simulated ESL" },
            evidence: "simulated exact-UUID result"
          };
        }
      };
      const adapter = manualOutboundExecutor(executor, {
        ...driver,
        async reconcile() {
          return null;
        }
      });
      db.setWake(async (id) => {
        // Queue is committed after the outbound reservation, before possible send.
        await db.pool.query("update calls set state='queued' where id=$1", [f.callId]);
        await adapter.wakeExecutor(id);
      });
      const response = await db.api(req);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "started");
      assert.equal(sends, 1);
      const retry = await db.api(req);
      assert.equal(retry.json().callId, response.json().callId);
      assert.equal(sends, 1);
      const before = await db.snapshot();
      assert.equal((await db.api(req, {})).statusCode, 401);
      const user = f.actor.user,
        token = signAuthToken(config, {
          sub: user.id,
          email: user.email,
          role: user.role,
          ver: user.auth_version
        });
      assert.equal(
        (
          await db.api(req, {
            cookie: `${SESSION_COOKIE_NAME}=${token}`,
            origin: "https://foreign.example.test"
          })
        ).statusCode,
        403
      );
      const spoof = await db.api({ ...req, actorUserId: f.other.user.id });
      assert.equal(spoof.statusCode, 409, spoof.body);
      noDialChanges(before, await db.snapshot());
      await db.report("executor-auth", { result: response.json(), sends, media: "simulated only" });
    } finally {
      await db.cleanup();
    }
  }
);

test("C05.4 U: automatic source metadata is required and cannot carry manual selectors; legacy remains ambiguous", async () => {
  const { startNextCallSchema } = await import("./call-coordination-contracts.js");
  const intent = {
    startReason: "automatic",
    sourceCallId: randomUUID(),
    deskSessionId: randomUUID(),
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  };
  assert.equal(startNextCallSchema.safeParse({ intent }).success, true);
  const { sourceCallId: _source, ...missingSource } = intent;
  void _source;
  assert.equal(startNextCallSchema.safeParse({ intent: missingSource }).success, false);
  assert.equal(
    startNextCallSchema.safeParse({ intent: { ...intent, confirmCompletedLead: true } }).success,
    false
  );
  assert.equal(startNextCallSchema.safeParse({ intent, phoneNumber: "+14155550100" }).success, false);
  assert.equal(startNextCallSchema.parse({}).intent, undefined);
});

test(
  "C05 migration: upgrade preserves old identities/history; unknown legacy intent cancels; immutable fingerprint and binding",
  options,
  async () => {
    const db = await fixture(true);
    try {
      const f = await db.seed("none"),
        req = automatic(f);
      const old = (
        await db.pool.query(
          `insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key,state,reason)
      values($1,$2,$3,$4,1,$5,'deferred','incoming_pending') returning *`,
          [f.actor.agentId, f.completed, f.campaignId, f.actor.session, req.intent.idempotencyKey]
        )
      ).rows[0];
      const before = await db.snapshot();
      await runMigrations(db.pool);
      await runMigrations(db.pool);
      const upgraded = (await db.pool.query("select * from agent_auto_next_intents where id=$1", [old.id]))
        .rows[0];
      for (const [key, value] of Object.entries(old)) assert.deepEqual(upgraded[key], value, key);
      assert.equal(upgraded.request_fingerprint, null);
      assert.equal(upgraded.binding_generation, null);
      const response = await db.api(req);
      assert.equal(response.statusCode, 409, response.body);
      const after = await db.snapshot();
      for (const row of after.calls) {
        assert.equal(row.inbound_context_contact_id, null);
        assert.equal(row.inbound_end_reason, null);
        delete row.inbound_context_contact_id;
        delete row.inbound_end_reason;
      }
      noDialChanges(before, after);
      const canceled = (await db.pool.query("select * from agent_auto_next_intents where id=$1", [old.id]))
        .rows[0];
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.reason, "unknown_legacy_identity");
      await assert.rejects(
        db.pool.query("update agent_auto_next_intents set request_fingerprint=$2 where id=$1", [
          old.id,
          "0".repeat(64)
        ]),
        { code: "23514" }
      );
      await db.report("migration-upgrade", { old, upgraded, canceled });
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C05.4 DB: explicit manual versus automatic source callback, both commit orders and rollback",
  options,
  async () => {
    const db = await fixture();
    try {
      const checks = [];
      for (const autoFirst of [false, true])
        for (const rollback of [false, true]) {
          const f = await db.seed("none");
          await db.pool.query("update calls set state='received' where id=$1", [f.callId]);
          const auto = { mode: "automatic", config, request: automatic(f) },
            manual = { mode: "manual", config, request: f.request("/agent/call-next") };
          const w1 = db.worker(autoFirst ? auto : manual),
            w2 = db.worker(autoFirst ? manual : auto);
          await Promise.all([w1.wait("ready"), w2.wait("ready")]);
          w1.send("start");
          const p1 = await w1.wait("connected");
          await w1.wait("before-commit");
          w2.send("start");
          const p2 = await w2.wait("connected");
          await assertBlocked(db.pool, p2.backend, p1.backend);
          w1.send(rollback ? "rollback" : "commit");
          await w1.wait(rollback ? "rejected" : "committed");
          let second;
          if (autoFirst && !rollback) second = await w2.wait("rejected");
          else {
            await w2.wait("before-commit");
            w2.send("commit");
            second = await w2.wait("committed");
          }
          await Promise.all([w1.exited, w2.exited]);
          assert.equal(
            (await db.pool.query("select attempt_count from contacts where id=$1", [f.contactId])).rows[0]
              .attempt_count,
            1
          );
          assert.equal(
            (
              await db.pool.query(
                "select count(*) from call_operations where call_id in(select id from calls where campaign_id=$1)",
                [f.campaignId]
              )
            ).rows[0].count,
            "1"
          );
          const intent = (
            await db.pool.query("select * from agent_auto_next_intents where source_call_id=$1", [
              f.completed
            ])
          ).rows[0];
          if ((autoFirst && !rollback) || (!autoFirst && rollback)) assert.equal(intent.state, "started");
          else if (!autoFirst) assert.equal(intent.state, "canceled");
          else assert.equal(intent, undefined);
          checks.push({ autoFirst, rollback, p1, p2, second });
        }
      // Even a first callback arriving after a newer manual call ENDS is stale.
      const f = await db.seed("none"),
        req = automatic(f);
      await db.pool.query("update calls set state='received' where id=$1", [f.callId]);
      const manual = await db.api(f.request("/agent/manual-dial/start"));
      assert.equal(manual.statusCode, 200, manual.body);
      const newCall = manual.json().callId;
      await db.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
        newCall
      ]);
      await db.pool.query(
        "update call_operations set state='succeeded',resolved_at=clock_timestamp(),result='{}',resolution_evidence='fixture cleanup' where call_id=$1",
        [newCall]
      );
      const client = await db.pool.connect();
      try {
        const { withCallAdmission } = await import("./call-admission.js");
        const slot = (
          await db.pool.query("select * from agent_call_slots where agent_id=$1", [f.actor.agentId])
        ).rows[0];
        await withCallAdmission(client, { agentIds: [f.actor.agentId], callIds: [newCall] }, (a) =>
          a.release(
            {
              agentId: f.actor.agentId,
              callId: newCall,
              reservationId: slot.reservation_id,
              generation: slot.generation
            },
            true
          )
        );
      } finally {
        client.release();
      }
      const before = await db.snapshot(),
        late = await db.api(req);
      assert.equal(late.statusCode, 409, late.body);
      assert.equal(late.json().message, "work_superseded");
      noDialChanges(before, await db.snapshot());
      await db.report("manual-auto-races", { checks, late: late.json() });
    } finally {
      await db.cleanup();
    }
  }
);
