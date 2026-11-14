import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { assertBlocked, databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import {
  occupiedSlotStates,
  releaseAgentCallSlot,
  reserveAgentCallSlot,
  updateAgentCallSlot
} from "./agent-call-slots.js";

const migrationDirectory = new URL("../db/migrations/", import.meta.url);
const migrationName = "026_desk_slots_capacity.sql";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};

async function fixture(upgrade = false) {
  const schema = `b02_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 4 });
  const cleanup = async () => {
    await pool.end();
    try {
      await admin.query(`drop schema ${schema} cascade`);
      assert.equal((await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount, 0);
    } finally {
      await admin.end();
    }
  };
  try {
    if (upgrade) {
      await pool.query(
        "create table schema_migrations(filename text primary key,checksum_sha256 text,applied_at timestamptz not null default now())"
      );
      for (const name of (await readdir(migrationDirectory))
        .filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < migrationName)
        .sort()) {
        const sql = await readFile(new URL(name, migrationDirectory), "utf8");
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
    } else await runMigrations(pool);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { pool, cleanup };
}

async function agent(pool: pg.Pool, paused = false) {
  const user = (
    await pool.query(
      "insert into users(email,name,role,password_hash) values($1,'B02','agent','fixture') returning id",
      [`${randomUUID()}@fixture.invalid`]
    )
  ).rows[0].id as string;
  return (
    await pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,availability_status) values($1,$2,'fixture','fixture','B02',$3) returning id",
      [user, randomUUID(), paused ? "paused" : "available"]
    )
  ).rows[0].id as string;
}

async function call(pool: pg.Pool, agentId: string | null = null, state = "created") {
  return (
    await pool.query(
      "insert into calls(agent_id,destination_number,normalized_destination_number,state) values($1,'+14155550100','+14155550100',$2) returning id",
      [agentId, state]
    )
  ).rows[0].id as string;
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && "code" in error && error.code === code
  );
}

async function report(pool: pg.Pool, name: string, assertions: string[]) {
  if (!process.env.INBOUND_TEST_ARTIFACTS) return;
  await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
  await writeFile(
    `${process.env.INBOUND_TEST_ARTIFACTS}/b02-${name}-report.json`,
    JSON.stringify(
      {
        status: "passed",
        baseRevision: "4c8987b19f62d9811c68bf332ee208606c5bc92d",
        name,
        database: (await pool.query("select version() as version")).rows[0].version,
        media: "none; schema and persistence primitives only; no FS/provider evidence",
        assertions,
        slots: (await pool.query("select * from agent_call_slots order by agent_id")).rows,
        capacity: (await pool.query("select * from call_capacity_reservations order by id")).rows,
        admission: (await pool.query("select * from call_admission_migration")).rows
      },
      null,
      2
    ) + "\n"
  );
}

test(
  "B02.1 fresh schema: controller, slot, resource uniqueness and ownership constraints",
  options,
  async () => {
    const db = await fixture();
    const { pool } = db;
    try {
      const a = await agent(pool),
        b = await agent(pool);
      const disposable = await agent(pool);
      await pool.query("delete from agents where id=$1", [disposable]);
      assert.equal(
        (await pool.query("select * from agent_call_slots where agent_id=$1", [disposable])).rowCount,
        0
      );
      const c = await call(pool),
        other = await call(pool);
      const session = async (id: string, generation = 1, username = randomUUID(), revoked = false) =>
        pool.query(
          "insert into agent_desk_sessions(agent_id,binding_generation,sip_username,expires_at,revoked_at) values($1,$2,$3,now()+interval '20 seconds',case when $4 then now() end) returning *",
          [id, generation, username, revoked]
        );
      const s = (await session(a)).rows[0];
      assert.equal(s.ready, false);
      assert.equal(s.revision, "1");
      assert.equal(s.verified_generation, null);
      await rejectsCode(session(a, 2), "23505");
      await rejectsCode(session(b, 1, s.sip_username), "23505");
      await rejectsCode(session(a, 1, randomUUID(), true), "23505");
      await rejectsCode(pool.query("insert into agent_call_slots(agent_id) values($1)", [a]), "23505");
      for (const sql of [
        "update agent_desk_sessions set ready=true where id=$1",
        "update agent_desk_sessions set verified_generation=1,verified_at=now() where id=$1",
        "update agent_desk_sessions set verified_endpoint='sip:fixture@127.0.0.1',verified_generation=2,verified_at=now() where id=$1",
        "update agent_desk_sessions set expires_at=created_at where id=$1"
      ])
        await rejectsCode(pool.query(sql, [s.id]), "23514");
      await pool.query(
        "update agent_desk_sessions set verified_endpoint='sip:fixture@127.0.0.1',verified_generation=1,verified_at=now(),ready=true where id=$1",
        [s.id]
      );
      await rejectsCode(
        pool.query("update agent_desk_sessions set revoked_at=now() where id=$1", [s.id]),
        "23514"
      );
      await pool.query("update agent_desk_sessions set revoked_at=now(),ready=false where id=$1", [s.id]);
      await session(a, 2);
      await rejectsCode(
        pool.query("update agent_desk_sessions set revoked_at=null where id=$1", [s.id]),
        "23505"
      );

      const op = randomUUID();
      const reserve = (operation = op, resource = "customer_channel", scope = "deployment", units = 1) =>
        pool.query(
          "insert into call_capacity_reservations(operation_id,call_id,agent_id,resource_type,scope_id,units) values($1,$2,$3,$4,$5,$6) returning *",
          [operation, c, a, resource, scope, units]
        );
      const r = (await reserve()).rows[0];
      assert.match(r.id, /^[a-f0-9-]{36}$/);
      assert.equal(r.operation_id, op);
      assert.equal(r.call_id, c);
      assert.equal(r.agent_id, a);
      await rejectsCode(reserve(), "23505");
      await reserve(op, "browser_channel");
      await reserve(op, "queue_waiting", randomUUID());
      for (const units of [0, -1])
        await rejectsCode(reserve(randomUUID(), "customer_channel", "deployment", units), "23514");
      await rejectsCode(reserve(randomUUID(), "invalid"), "23514");
      await rejectsCode(reserve(randomUUID(), "trunk_call", ""), "23514");
      await rejectsCode(
        pool.query("update call_capacity_reservations set call_id=$2 where id=$1", [r.id, other]),
        "23514"
      );
      await rejectsCode(
        pool.query("update call_capacity_reservations set units=2 where id=$1", [r.id]),
        "23514"
      );
      const leg = (
        await pool.query("insert into call_legs(call_id,type) values($1,'customer') returning id", [other])
      ).rows[0].id;
      await rejectsCode(
        pool.query(
          "insert into call_capacity_reservations(operation_id,call_id,call_leg_id,resource_type,scope_id) values($1,$2,$3,'customer_channel','deployment')",
          [randomUUID(), c, leg]
        ),
        "23503"
      );
      for (const state of ["in_use", "releasing", "uncertain"]) {
        await pool.query("update call_capacity_reservations set state=$2 where id=$1", [r.id, state]);
        assert.equal(
          (
            await pool.query(
              "select sum(units)::int as units from call_capacity_reservations where state<>'released' and resource_type='customer_channel'"
            )
          ).rows[0].units,
          1
        );
      }
      await rejectsCode(
        pool.query("update call_capacity_reservations set state='released' where id=$1", [r.id]),
        "23514"
      );
      await pool.query(
        "update call_capacity_reservations set state='released',released_at=now() where id=$1",
        [r.id]
      );
      await rejectsCode(reserve(), "23505");
      await rejectsCode(
        pool.query("update call_capacity_reservations set state='reserved',released_at=null where id=$1", [
          r.id
        ]),
        "23514"
      );
      await report(pool, "constraints", [
        "B02.1 duplicate controllers/generations/SIP identities/slots/capacity rejected; controller revocation and pinned verification",
        "B02.1 ownership/FK/units/lifecycle constraints; released operation/resource cannot be reused; uncertain usage counted"
      ]);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "B02.1 concurrent unique claims: both commit orders and rollback on real PostgreSQL",
  options,
  async () => {
    const db = await fixture();
    const { pool } = db;
    try {
      const a = await agent(pool),
        c = await call(pool);
      const clients = await Promise.all([pool.connect(), pool.connect()]);
      try {
        for (const kind of ["controller", "slot", "capacity"] as const) {
          for (const [first, rollback] of [
            [0, false],
            [1, false],
            [0, true]
          ] as const) {
            const one = clients[first]!,
              two = clients[1 - first]!;
            const p1 = (await one.query("select pg_backend_pid() as pid")).rows[0].pid;
            const p2 = (await two.query("select pg_backend_pid() as pid")).rows[0].pid;
            assert.notEqual(p1, p2);
            const op = randomUUID();
            if (kind === "slot") await pool.query("delete from agent_call_slots where agent_id=$1", [a]);
            const insert = (client: pg.PoolClient, suffix: number) => {
              if (kind === "controller")
                return client.query(
                  "insert into agent_desk_sessions(agent_id,binding_generation,sip_username,expires_at) values($1,$2,$3,now()+interval '20 seconds')",
                  [a, suffix + 1, randomUUID()]
                );
              if (kind === "slot")
                return client.query("insert into agent_call_slots(agent_id) values($1)", [a]);
              return client.query(
                "insert into call_capacity_reservations(operation_id,call_id,resource_type,scope_id) values($1,$2,'customer_channel','deployment')",
                [op, c]
              );
            };
            await one.query("begin");
            await two.query("begin");
            await insert(one, first);
            const competing = insert(two, 1 - first).then(
              () => ({ code: "ok" }),
              (e: { code: string }) => ({ code: e.code })
            );
            await assertBlocked(pool, p2, p1);
            await one.query(rollback ? "rollback" : "commit");
            assert.equal((await competing).code, rollback ? "ok" : "23505");
            await two.query(rollback ? "commit" : "rollback");
            const table =
              kind === "controller"
                ? "agent_desk_sessions"
                : kind === "slot"
                  ? "agent_call_slots"
                  : "call_capacity_reservations";
            assert.equal((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, 1);
            await pool.query(`delete from ${table}`);
          }
        }
      } finally {
        for (const client of clients) {
          await client.query("rollback");
          client.release();
        }
      }
      await report(pool, "concurrency", [
        "B02.1 three unique constraints x both commit orders + rollback; pg_blocking_pids proves blocked backend before commit; exactly one persisted winner"
      ]);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "B02.2 full-token release, all occupied states, reservation generation, rollback and stale release race",
  options,
  async () => {
    const db = await fixture();
    const { pool } = db;
    const client = await pool.connect();
    try {
      const a = await agent(pool),
        b = await agent(pool),
        c = await call(pool),
        other = await call(pool);
      assert.equal(await reserveAgentCallSlot(client, a, c), null);
      // Explicit simulated reconciliation, not FS absence proof.
      await pool.query(
        "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
        [a]
      );
      let token = (await reserveAgentCallSlot(client, a, c, randomUUID()))!;
      assert.ok(token);
      // Recipient has a slot for a call whose calls.agent_id is NULL.
      await rejectsCode(pool.query("delete from agents where id=$1", [a]), "23503");
      assert.equal(token.generation, "2");
      for (const state of occupiedSlotStates) {
        assert.equal(await updateAgentCallSlot(client, token, state), true);
        assert.equal(await reserveAgentCallSlot(client, a, other), null);
        const snapshot = (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows;
        for (const wrong of [
          { ...token, agentId: b },
          { ...token, callId: other },
          { ...token, reservationId: randomUUID() },
          { ...token, generation: "999" }
        ]) {
          assert.equal(await releaseAgentCallSlot(client, wrong, true), false);
          assert.equal(await updateAgentCallSlot(client, wrong, "active"), false);
        }
        assert.equal(await releaseAgentCallSlot(client, token, false), false);
        assert.deepEqual(
          (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows,
          snapshot
        );
        assert.equal(await releaseAgentCallSlot(client, token, true), true);
        const next = (await reserveAgentCallSlot(client, a, c))!;
        assert.equal(BigInt(next.generation), BigInt(token.generation) + 1n);
        assert.notEqual(next.reservationId, token.reservationId);
        assert.equal(await releaseAgentCallSlot(client, token, true), false);
        token = next;
      }
      await rejectsCode(
        pool.query("update agent_call_slots set call_id=$2 where agent_id=$1", [a, other]),
        "23514"
      );
      await rejectsCode(
        pool.query("update agent_call_slots set generation=generation+1 where agent_id=$1", [a]),
        "23514"
      );
      await rejectsCode(
        pool.query("update agent_call_slots set state='invalid' where agent_id=$1", [a]),
        "23514"
      );
      assert.equal(await releaseAgentCallSlot(client, token, true), true);
      const beforeRollback = (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows;
      await client.query("begin");
      assert.ok(await reserveAgentCallSlot(client, a, c));
      await client.query("rollback");
      assert.deepEqual(
        (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows,
        beforeRollback
      );

      token = (await reserveAgentCallSlot(client, a, c))!;
      const occupied = (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows;
      await pool.query(
        "insert into agent_desk_sessions(agent_id,binding_generation,sip_username,created_at,expires_at) values($1,1,$2,now()-interval '40 seconds',now()-interval '20 seconds')",
        [a, randomUUID()]
      );
      await pool.query("update agent_desk_sessions set revoked_at=now() where agent_id=$1", [a]);
      assert.deepEqual(
        (await pool.query("select * from agent_call_slots where agent_id=$1", [a])).rows,
        occupied
      );
      // The stale finalizer sees the old occupied row while its release/replacement
      // is uncommitted, waits, then revalidates against the new reservation.
      const stale = await pool.connect();
      try {
        await client.query("begin");
        assert.equal(await releaseAgentCallSlot(client, token, true), true);
        const newToken = (await reserveAgentCallSlot(client, a, c))!;
        const p1 = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
        const p2 = (await stale.query("select pg_backend_pid() as pid")).rows[0].pid;
        const pending = releaseAgentCallSlot(stale, token, true);
        await assertBlocked(pool, p2, p1);
        await client.query("commit");
        assert.equal(await pending, false);
        assert.equal(
          (await pool.query("select reservation_id from agent_call_slots where agent_id=$1", [a])).rows[0]
            .reservation_id,
          newToken.reservationId
        );
        assert.equal(await releaseAgentCallSlot(client, newToken, true), true);
      } finally {
        stale.release();
      }
      await pool.query("delete from agent_call_slots where agent_id=$1", [b]);
      await pool.query(
        "insert into agent_call_slots(agent_id,state,reservation_id,generation,reconciliation_required) values($1,'free',null,9007199254740993,false)",
        [b]
      );
      const large = (await reserveAgentCallSlot(client, b, other))!;
      assert.equal(large.generation, "9007199254740994");
      assert.equal(await releaseAgentCallSlot(client, large, true), true);
      await report(pool, "fencing", [
        "B02.2 five occupied states; wrong agent/call/reservation/generation no-op; false cleanup no-op; monotonic generation and unique reservation",
        "B02.2 rollback preserves free row and generation; stale finalizer blocked by newer reservation then revalidates without releasing it"
      ]);
    } finally {
      await client.query("rollback");
      client.release();
      await db.cleanup();
    }
  }
);

test(
  "B02.3 upgrade: active, released voicemail, uncertain/orphan legs and supervisor retain ownership and capacity",
  options,
  async () => {
    const db = await fixture(true);
    const { pool } = db;
    try {
      const activeAgent = await agent(pool, true),
        vmAgent = await agent(pool, true),
        uncertainAgent = await agent(pool),
        idleAgent = await agent(pool);
      const active = await call(pool, activeAgent, "bridged"),
        vm = await call(pool, vmAgent, "agent_released"),
        uncertain = await call(pool, uncertainAgent, "customer_dialing");
      await pool.query(
        "update calls set agent_released_at=now(),voicemail_drop_requested_at=now(),voicemail_playback_started_at=now() where id=$1",
        [vm]
      );
      const orphan = await call(pool, uncertainAgent, "completed");
      await pool.query("update calls set ended_at=now() where id=$1", [orphan]);
      for (const [callId, type, state, ended] of [
        [active, "agent", "answered", false],
        [active, "customer", "answered", false],
        [vm, "agent", "ended", true],
        [vm, "customer", "answered", false],
        [orphan, "customer", "answered", false]
      ] as const) {
        await pool.query(
          "insert into call_legs(call_id,type,freeswitch_uuid,state,ended_at) values($1,$2,$3,$4,case when $5 then now() end)",
          [callId, type, randomUUID(), state, ended]
        );
      }
      const user = (await pool.query("select user_id from agents where id=$1", [idleAgent])).rows[0].user_id;
      await pool.query(
        "insert into call_supervisor_sessions(call_id,actor_user_id,mode,state,supervisor_leg_uuid,target_agent_leg_uuid,target_customer_leg_uuid) values($1,$2,'listen','active',$3,$4,$5)",
        [active, user, randomUUID(), randomUUID(), randomUUID()]
      );
      const snapshot = async () => ({
        agents: (await pool.query("select * from agents order by id")).rows,
        calls: (await pool.query("select * from calls order by id")).rows,
        legs: (await pool.query("select * from call_legs order by id")).rows,
        supervisors: (await pool.query("select * from call_supervisor_sessions order by id")).rows
      });
      const before = await snapshot();
      const checksums = (await pool.query("select * from schema_migrations order by filename")).rows;
      await runMigrations(pool);
      await runMigrations(pool);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await pool.query("select * from schema_migrations where filename<$1 order by filename", [
            migrationName
          ])
        ).rows,
        checksums
      );
      const slots = (await pool.query("select * from agent_call_slots")).rows;
      assert.equal(slots.length, 4);
      assert.ok(slots.every((s) => s.state === "uncertain" && s.reconciliation_required && s.reservation_id));
      assert.equal(slots.find((s) => s.agent_id === activeAgent)?.call_id, active);
      assert.equal(slots.find((s) => s.agent_id === uncertainAgent)?.call_id, uncertain);
      assert.equal(slots.find((s) => s.agent_id === vmAgent)?.call_id, null);
      assert.equal(slots.find((s) => s.agent_id === idleAgent)?.call_id, null);
      assert.equal((await pool.query("select * from agent_desk_sessions")).rowCount, 0);
      assert.equal(
        (await pool.query("select reconciliation_required from call_admission_migration")).rows[0]
          .reconciliation_required,
        true
      );
      const claims = (await pool.query("select * from call_capacity_reservations")).rows;
      assert.equal(claims.length, 11); // four customer + four trunk + two browser + one supervisor
      assert.ok(claims.every((r) => r.state === "uncertain" && r.origin === "legacy_backfill"));
      for (const id of [active, vm, uncertain, orphan]) {
        assert.deepEqual(
          claims
            .filter((r) => r.call_id === id && ["customer_channel", "trunk_call"].includes(r.resource_type))
            .map((r) => r.resource_type)
            .sort(),
          ["customer_channel", "trunk_call"]
        );
      }
      assert.equal(claims.filter((r) => r.call_id === vm && r.resource_type === "browser_channel").length, 0);
      assert.equal(
        (
          await pool.query(
            "select indexdef from pg_indexes where schemaname=current_schema() and indexname='calls_one_active_per_agent_idx'"
          )
        ).rowCount,
        1
      );
      await rejectsCode(call(pool, activeAgent), "23505");
      // Old writer can still create a call after this snapshot: it does not refresh
      // new claims. The durable reconciliation marker must therefore remain closed.
      await call(pool, vmAgent);
      assert.equal(
        (await pool.query("select reconciliation_required from call_admission_migration")).rows[0]
          .reconciliation_required,
        true
      );
      await agent(pool);
      assert.equal((await pool.query("select * from agent_call_slots where state='free'")).rowCount, 0);
      await report(pool, "upgrade", [
        "B02.3 exact 001–025 upgrade, runner twice and unchanged prior checksums/agents/pause/calls/legs/supervisors",
        "B02.3 active and uncertain owners pinned; released voicemail customer/trunk retained without duplicate browser claim; terminal residual customer counted",
        "B02.3 11 uncertain resource claims, no false free slots/controllers, new agents uncertain, legacy index retained, legacy writers require final reconciliation"
      ]);
    } finally {
      await db.cleanup();
    }
  }
);
