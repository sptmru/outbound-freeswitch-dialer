import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { serviceOperation } from "../../../tests/fixtures/inbound/service-invite.mjs";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { authorizeServiceInvite } from "./service-invites.js";
import { registerServiceInviteRoutes } from "./dashboard/service-invites.js";
import { signAuthToken } from "./auth/tokens.js";
import { runMigrations } from "./db.js";
import { registerCookieCsrfProtection } from "./security.js";
import type { AppConfig } from "./config.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture(inbound = false, accepted = true) {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  const d = f.input.deskSessionId;
  await f.pool.query(
    "update agent_desk_sessions set actor_auth_version=1,endpoint_pin=verified_endpoint where id=$1",
    [d]
  );
  const seeded = await f.seed({ inbound });
  const { input } = await serviceOperation(f, seeded, d, inbound ? "inbound" : "outbound", accepted);
  return { ...f, seeded, input, actor: { agentId: f.agentId, userId: f.userId, authVersion: 1 } };
}
test(
  "E04.1 DB/API: exact actor/operation/leg/binding, accepted inbound and durable one-dialog replay",
  options,
  async () => {
    for (const inbound of [false, true]) {
      const f = await fixture(inbound);
      try {
        const baseline = await f.snapshot();
        for (const key of ["callId", "operationId", "deskSessionId", "legUuid"] as const)
          assert.equal(
            await authorizeServiceInvite(f.pool, f.actor, { ...f.input, [key]: randomUUID() }),
            false,
            key
          );
        assert.equal(
          await authorizeServiceInvite(f.pool, f.actor, { ...f.input, bindingGeneration: "2" }),
          false
        );
        assert.equal(
          await authorizeServiceInvite(f.pool, { ...f.actor, userId: randomUUID() }, f.input),
          false
        );
        assert.equal(await authorizeServiceInvite(f.pool, { ...f.actor, authVersion: 2 }, f.input), false);
        assert.equal((await f.pool.query("select * from service_invite_dialogs")).rowCount, 0);
        assert.equal(await authorizeServiceInvite(f.pool, f.actor, f.input), true);
        assert.equal(
          await authorizeServiceInvite(f.pool, f.actor, f.input),
          true,
          "lost-response same-dialog replay"
        );
        assert.equal(
          await authorizeServiceInvite(f.pool, f.actor, { ...f.input, dialogId: randomUUID() }),
          false,
          "new SIP session cannot reuse operation"
        );
        assert.deepEqual(
          await f.snapshot(),
          baseline,
          "authorization never mutates offers/owner/slots/sends"
        );
        assert.equal((await f.pool.query("select * from service_invite_dialogs")).rowCount, 1);
        await assert.rejects(f.pool.query("delete from service_invite_dialogs"), /must survive/);
        await assert.rejects(
          f.pool.query("update service_invite_dialogs set dialog_id='replacement'"),
          /must survive/
        );
      } finally {
        await f.cleanup();
      }
    }
  }
);
test(
  "E04.1 DB: unaccepted, unready, stale, moved, terminal and uncertain cleanup never authorize media",
  options,
  async () => {
    const pending = await fixture(true, false);
    try {
      const before = await pending.snapshot();
      assert.equal(await authorizeServiceInvite(pending.pool, pending.actor, pending.input), false);
      assert.deepEqual(await pending.snapshot(), before, "SIP delivery never accepts a pending offer");
    } finally {
      await pending.cleanup();
    }
    const f = await fixture(true);
    try {
      // Restore every independently committed negative case before the next check.
      const deny = async (sql: string) => {
        await f.pool.query(sql, [f.input.operationId]);
        assert.equal(await authorizeServiceInvite(f.pool, f.actor, f.input), false, sql);
      };
      for (const [sql, restore] of [
        [
          "update agent_desk_sessions set ready=false where id=(select request->'intent'->>'deskSessionId' from call_operations where id=$1)::uuid",
          "update agent_desk_sessions set ready=true"
        ],
        [
          "update agent_desk_sessions set verified_endpoint='sip:moved@127.0.0.1' where id=(select request->'intent'->>'deskSessionId' from call_operations where id=$1)::uuid",
          "update agent_desk_sessions set verified_endpoint=endpoint_pin"
        ],
        [
          "update agent_call_slots set state='uncertain' where call_id=(select call_id from call_operations where id=$1)",
          "update agent_call_slots set state='reserved'"
        ],
        [
          "update users set is_active=false where id=(select request->>'actorUserId' from call_operations where id=$1)::uuid",
          "update users set is_active=true"
        ],
        [
          "update agent_desk_sessions set verified_at=clock_timestamp()-interval '1 minute' where id=(select request->'intent'->>'deskSessionId' from call_operations where id=$1)::uuid",
          "update agent_desk_sessions set verified_at=clock_timestamp()"
        ],
        [
          "update call_legs set ended_at=clock_timestamp() where freeswitch_uuid=(select target_uuid::text from call_operations where id=$1)",
          "update call_legs set ended_at=null"
        ],
        [
          "update calls set ended_at=clock_timestamp() where id=(select call_id from call_operations where id=$1)",
          "select 1"
        ]
      ]) {
        await deny(sql!);
        await f.pool.query(restore!);
      }
      assert.equal((await f.pool.query("select * from service_invite_dialogs")).rowCount, 0);
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "E04.2 DB: concurrent dialogs revalidate after lock, both winning orders and rollback",
  options,
  async () => {
    for (const winnerCommits of [true, false])
      for (const reverse of [false, true]) {
        const f = await fixture();
        const first = await f.pool.connect(),
          second = await f.pool.connect();
        try {
          const firstPid = (await first.query("select pg_backend_pid() as p")).rows[0].p;
          const secondPid = (await second.query("select pg_backend_pid() as p")).rows[0].p;
          const a = { ...f.input, dialogId: reverse ? "B" : "A" },
            b = { ...f.input, dialogId: reverse ? "A" : "B" };
          await first.query("begin");
          await first.query("select pg_advisory_xact_lock(72202,0)");
          await first.query("insert into service_invite_dialogs(operation_id,dialog_id) values($1,$2)", [
            a.operationId,
            a.dialogId
          ]);
          const pending = authorizeServiceInvite(
            { connect: async () => second } as unknown as pg.Pool,
            f.actor,
            b
          );
          await assertBlocked(f.pool, secondPid, firstPid);
          await first.query(winnerCommits ? "commit" : "rollback");
          assert.equal(await pending, !winnerCommits);
          assert.equal(await authorizeServiceInvite(f.pool, f.actor, winnerCommits ? a : b), true);
          assert.equal(
            (await f.pool.query("select count(*)::int n from service_invite_dialogs")).rows[0].n,
            1
          );
        } finally {
          await first.query("rollback");
          first.release();
          await f.cleanup();
        }
      }
  }
);
test(
  "E04.1/H05.1 API: strict contract, authentication, CSRF, no-store and safe diagnostics",
  options,
  async () => {
    const f = await fixture();
    const config = {
      JWT_SECRET: "e04-test-only",
      JWT_EXPIRES_SECONDS: 3600,
      PUBLIC_APP_URL: "https://desk.test",
      corsOrigins: ["https://desk.test"]
    } as unknown as AppConfig;
    const log: string[] = [];
    const app = Fastify({ logger: { stream: { write: (line: string) => log.push(line) } } });
    await app.register(cookie);
    registerCookieCsrfProtection(app, config);
    registerServiceInviteRoutes(app, config, f.pool);
    app.setErrorHandler((e, _req, reply) =>
      reply.code(e instanceof ZodError ? 400 : 500).send({ message: String(e) })
    );
    const user = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.auth_version
    });
    const request = (
      payload: object,
      headers: Record<string, string> = { authorization: `Bearer ${token}` }
    ) => app.inject({ method: "POST", url: "/agent/service-invites/authorize", payload, headers });
    try {
      assert.equal((await request(f.input, {} as never)).statusCode, 401);
      for (const payload of [
        { ...f.input, extra: true },
        { ...f.input, bindingGeneration: "bad" },
        { ...f.input, bindingGeneration: "01" },
        { ...f.input, bindingGeneration: "9223372036854775808" },
        { ...f.input, dialogId: "bad\r\nheader" }
      ])
        assert.equal((await request(payload)).statusCode, 400);
      assert.equal(
        (await request(f.input, { cookie: `outbound_dialer_session=${token}` } as never)).statusCode,
        403
      );
      assert.equal(
        (await request(f.input, { cookie: `outbound_dialer_session=${token}`, origin: "https://desk.test" }))
          .statusCode,
        200
      );
      const result = await request(f.input);
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.deepEqual(result.json(), { authorized: true, ...f.input });
      const dialogId = "private-dialog-+12025550100-fixture";
      const refusal = await request({ ...f.input, bindingGeneration: "2", dialogId });
      assert.equal(refusal.statusCode, 409);
      const event = log
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "service_invite_authorization_refused");
      assert.equal(event?.callId, f.input.callId);
      assert.equal(event?.operationId, f.input.operationId);
      assert.ok(!log.join("").includes(dialogId));
      assert.ok(!log.join("").includes(token));
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);

test(
  "E04.1 DB: revoked/expired controller and terminal-first arbitration fail closed after lock",
  options,
  async () => {
    for (const commit of [true, false]) {
      const f = await fixture();
      const holder = await f.pool.connect(),
        waiter = await f.pool.connect();
      try {
        const h = (await holder.query("select pg_backend_pid() p")).rows[0].p,
          w = (await waiter.query("select pg_backend_pid() p")).rows[0].p;
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(72202,0)");
        await holder.query("update agent_call_slots set state='releasing' where agent_id=$1", [f.agentId]);
        const pending = authorizeServiceInvite(
          { connect: async () => waiter } as unknown as pg.Pool,
          f.actor,
          f.input
        );
        await assertBlocked(f.pool, w, h);
        await holder.query(commit ? "commit" : "rollback");
        assert.equal(await pending, !commit, "post-lock release revalidation");
      } finally {
        await holder.query("rollback");
        holder.release();
        await f.cleanup();
      }
    }
    for (const clause of [
      "revoked_at=clock_timestamp(),ready=false",
      "created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'"
    ]) {
      const f = await fixture();
      try {
        await f.pool.query(`update agent_desk_sessions set ${clause} where id=$1`, [f.input.deskSessionId]);
        assert.equal(await authorizeServiceInvite(f.pool, f.actor, f.input), false);
        assert.equal((await f.pool.query("select * from service_invite_dialogs")).rowCount, 0);
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "E04 DB: additive 038 to 039 upgrade preserves existing calls, slots, operations and migration checksums",
  options,
  async () => {
    const f = await fixture();
    try {
      // Reconstruct the previous schema: 039 adds only this table/function/trigger.
      await f.pool.query(
        "drop table service_invite_dialogs; drop function preserve_service_invite_dialog(); delete from schema_migrations where filename='039_service_invite_authorization.sql'"
      );
      const before = await f.snapshot(),
        history = (
          await f.pool.query("select * from schema_migrations where filename<'039' order by filename")
        ).rows;
      await runMigrations(f.pool);
      assert.deepEqual(await f.snapshot(), before);
      assert.deepEqual(
        (await f.pool.query("select * from schema_migrations where filename<'039' order by filename")).rows,
        history
      );
      assert.equal(
        (await f.pool.query("select * from service_invite_dialogs")).rowCount,
        0,
        "upgrade never grants legacy operations media authorization"
      );
      assert.equal(await authorizeServiceInvite(f.pool, f.actor, f.input), true);
    } finally {
      await f.cleanup();
    }
  }
);
