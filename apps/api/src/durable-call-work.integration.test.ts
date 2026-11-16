import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { assertBlocked, databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const fingerprint = "a".repeat(64);
const migrationDirectory = new URL("../db/migrations/", import.meta.url);
async function fixture(upgrade = false) {
  const schema = `b04_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
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
    if (!upgrade) await runMigrations(pool);
    else {
      await pool.query(
        "create table schema_migrations(filename text primary key,checksum_sha256 text,applied_at timestamptz not null default now())"
      );
      for (const name of (await readdir(migrationDirectory))
        .filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "028_")
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
    }
    const agentIds: string[] = [];
    const sessions: string[] = [];
    const campaign = (await pool.query("insert into campaigns(name) values('B04') returning id")).rows[0]
      .id as string;
    for (let n = 0; n < 3; n++) {
      const user = (
        await pool.query(
          "insert into users(email,name,role,password_hash) values($1,'B04','agent','fixture') returning id",
          [`${randomUUID()}@fixture.invalid`]
        )
      ).rows[0].id;
      const agent = (
        await pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','B04') returning id",
          [user, randomUUID()]
        )
      ).rows[0].id as string;
      agentIds.push(agent);
      sessions.push(
        (
          await pool.query(
            "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at) values($1,$2,1,$3,now()+interval '1 hour') returning id",
            [agent, campaign, randomUUID()]
          )
        ).rows[0].id as string
      );
    }
    const call = (
      await pool.query(
        "insert into calls(agent_id,campaign_id,destination_number,normalized_destination_number,state) values($1,$2,'fixture','fixture','bridged') returning id",
        [agentIds[0], campaign]
      )
    ).rows[0].id as string;
    const participant = (
      await pool.query(
        "insert into call_participants(call_id,role,agent_id) values($1,'agent',$2) returning id",
        [call, agentIds[0]]
      )
    ).rows[0].id as string;
    const before = (await pool.query("select * from calls where id=$1", [call])).rows[0];
    if (upgrade) await runMigrations(pool);
    await runMigrations(pool);
    const after = (await pool.query("select * from calls where id=$1", [call])).rows[0];
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
    assert.equal(after.inbound_context_contact_id, null);
    assert.equal(after.inbound_end_reason, null);
    return { pool, cleanup, agentIds, sessions, campaign, call, participant };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rejectsCode(promise: Promise<unknown>, code = "23514") {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && "code" in error && error.code === code
  );
}
async function offer(
  db: Fixture,
  agentIndex = 1,
  attempt = 1,
  kind = "inbound",
  transfer: string | null = null
) {
  return (
    await db.pool.query(
      "insert into call_offers(call_id,kind,transfer_id,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,$2,$3,$4,$5,$6,1,1,now()+interval '30 seconds') returning id",
      [db.call, kind, transfer, db.agentIds[agentIndex], attempt, db.sessions[agentIndex]]
    )
  ).rows[0].id as string;
}
async function transfer(db: Fixture, attempt = 1) {
  return (
    await db.pool.query(
      "insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at) values($1,$2,$3,$4,$5,now()+interval '30 seconds') returning id",
      [db.call, attempt, db.agentIds[0], db.participant, db.agentIds[1]]
    )
  ).rows[0].id as string;
}
async function operation(db: Fixture, key = randomUUID(), uuid = randomUUID()) {
  return (
    await db.pool.query(
      "insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at) values($1,'fixture',$2,$3,'originate',1,$4,now()+interval '30 seconds') returning id",
      [db.call, key, fingerprint, uuid]
    )
  ).rows[0].id as string;
}
async function ingress(db: Fixture, id = randomUUID(), terminal = false) {
  await db.pool.query(
    "insert into inbound_ingress_evidence(ingress_id,journal_id,arrived_at,validated_did,route_revision,queue_deadline_at,evidence_sequence,terminal_at,terminal_reason) values($1,'journal-1',now()-interval '1 second','+14155550100',1,now()+interval '60 seconds',1,case when $2 then now() end,case when $2 then 'channel_absent_on_recovery' end)",
    [id, terminal]
  );
  return id;
}
async function report(db: Fixture, name: string) {
  if (!process.env.INBOUND_TEST_ARTIFACTS) return;
  await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
  const snapshot: Record<string, unknown> = {
    status: "passed",
    database: (await db.pool.query("select version() as v")).rows[0].v,
    media: "none; real PostgreSQL, synthetic call/journal/command evidence"
  };
  for (const table of [
    "call_offers",
    "call_offer_exclusions",
    "call_transfers",
    "call_operations",
    "agent_auto_next_intents",
    "inbound_ingress_evidence"
  ])
    snapshot[table] = (await db.pool.query(`select * from ${table}`)).rows;
  await writeFile(
    `${process.env.INBOUND_TEST_ARTIFACTS}/b04-${name}.json`,
    JSON.stringify(snapshot, null, 2) + "\n"
  );
}

for (const upgrade of [false, true])
  test(
    `B04.1 ${upgrade ? "upgrade from 027" : "fresh"}: direct conflicts, retained history and stable identities`,
    options,
    async () => {
      const db = await fixture(upgrade);
      try {
        const id = await offer(db);
        await rejectsCode(offer(db, 1, 2), "23505");
        const t = await transfer(db);
        await rejectsCode(offer(db, 1, 1, "transfer", t), "23505"); // shared across offer kinds
        await rejectsCode(transfer(db, 2), "23505");
        await rejectsCode(
          db.pool.query("update call_offers set deadline_at=deadline_at+interval '1 second' where id=$1", [
            id
          ])
        );
        await rejectsCode(
          db.pool.query(
            "update call_offers set state='expired',closed_at=now(),reason='winner_accepted' where id=$1",
            [id]
          )
        );
        await db.pool.query(
          "update call_offers set state='canceled',closed_at=now(),reason='winner_accepted' where id=$1",
          [id]
        );
        await offer(db, 1, 2);
        await rejectsCode(
          db.pool.query("update call_offers set state='pending',closed_at=null,reason=null where id=$1", [id])
        );
        await db.pool.query(
          "update call_transfers set state='declined',closed_at=now(),reason='manual_outbound_started' where id=$1",
          [t]
        );
        await transfer(db, 2);
        const key = randomUUID(),
          uuid = randomUUID(),
          op = await operation(db, key, uuid);
        await rejectsCode(operation(db, key), "23505");
        await rejectsCode(operation(db, randomUUID(), uuid), "23505");
        for (const column of ["request_fingerprint", "command_uuid", "generation", "idempotency_key"]) {
          const value =
            column === "generation"
              ? "2"
              : column === "request_fingerprint"
                ? `'${"b".repeat(64)}'`
                : `'${randomUUID()}'`;
          await rejectsCode(db.pool.query(`update call_operations set ${column}=${value} where id=$1`, [op]));
        }
        const entry = await ingress(db);
        await rejectsCode(ingress(db, entry), "23505");
        await rejectsCode(
          db.pool.query("update call_offers set desk_session_id=$2 where id=$1", [id, db.sessions[2]])
        );
        assert.equal(
          (await db.pool.query("select count(*)::int as n from call_offer_exclusions")).rows[0].n,
          0
        );
        assert.equal((await db.pool.query("select count(*)::int as n from call_offers")).rows[0].n, 2);
        assert.equal((await db.pool.query("select count(*)::int as n from call_transfers")).rows[0].n, 2);
        await report(db, upgrade ? "upgrade" : "fresh");
      } finally {
        await db.cleanup();
      }
    }
  );

test(
  "B04.1 real unique-index races: both commit orders and rollback for offers/transfers/operations/ingress",
  options,
  async () => {
    const db = await fixture();
    try {
      for (const entity of ["offer", "transfer", "operation", "ingress"])
        for (const first of [0, 1])
          for (const rollback of [false, true]) {
            const one = await db.pool.connect(),
              two = await db.pool.connect();
            try {
              await one.query("begin");
              await two.query("begin");
              const ids = [randomUUID(), randomUUID()];
              const shared = randomUUID();
              let sql: string, values: unknown[][];
              if (entity === "offer") {
                sql =
                  "insert into call_offers(id,call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,$2,'inbound',$3,$4,$5,1,1,now()+interval '30 seconds')";
                values = ids.map((id, i) => [id, db.call, db.agentIds[1], i + 1, db.sessions[1]]);
              } else if (entity === "transfer") {
                sql =
                  "insert into call_transfers(id,call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at) values($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')";
                values = ids.map((id, i) => [
                  id,
                  db.call,
                  i + 1,
                  db.agentIds[0],
                  db.participant,
                  db.agentIds[1]
                ]);
              } else if (entity === "operation") {
                sql =
                  "insert into call_operations(id,call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at) values($1,$2,'race',$3,$4,'bridge',1,$5,now()+interval '30 seconds')";
                values = ids.map((id) => [id, db.call, shared, fingerprint, randomUUID()]);
              } else {
                sql =
                  "insert into inbound_ingress_evidence(ingress_id,journal_id,arrived_at,validated_did,route_revision,queue_deadline_at,evidence_sequence) values($1,'race',now(),'+14155550100',1,now()+interval '60 seconds',1)";
                values = ids.map(() => [shared]);
              }
              const clients = [one, two],
                winner = clients[first],
                waiter = clients[1 - first];
              const pid = (await winner.query("select pg_backend_pid() as pid")).rows[0].pid;
              const waiterPid = (await waiter.query("select pg_backend_pid() as pid")).rows[0].pid;
              await winner.query(sql, values[first]);
              // Attach rejection immediately; wait on actual PG lock state, not sleep ordering.
              const pending = waiter.query(sql, values[1 - first]).then(
                () => "inserted",
                (e: { code: string }) => e.code
              );
              await assertBlocked(db.pool, waiterPid, pid);
              await winner.query(rollback ? "rollback" : "commit");
              assert.equal(await pending, rollback ? "inserted" : "23505");
              await waiter.query(rollback ? "commit" : "rollback");
              const expected = rollback ? ids[1 - first] : ids[first];
              if (entity === "offer") {
                assert.equal(
                  (await db.pool.query("select id from call_offers where state='pending'")).rows[0].id,
                  expected
                );
                await db.pool.query(
                  "update call_offers set state='canceled',closed_at=now(),reason='winner_accepted'"
                );
              } else if (entity === "transfer") {
                assert.equal(
                  (await db.pool.query("select id from call_transfers where closed_at is null")).rows[0].id,
                  expected
                );
                await db.pool.query(
                  "update call_transfers set state='canceled',closed_at=now(),reason='test_cleanup' where closed_at is null"
                );
              } else if (entity === "operation") {
                assert.equal(
                  (await db.pool.query("select id from call_operations where idempotency_key=$1", [shared]))
                    .rows[0].id,
                  expected
                );
              } else
                assert.equal(
                  (
                    await db.pool.query(
                      "select count(*)::int as n from inbound_ingress_evidence where ingress_id=$1",
                      [shared]
                    )
                  ).rows[0].n,
                  1
                );
              // New attempt numbers must not collide with retained closed history.
              if (entity === "offer" || entity === "transfer") {
                await db.pool.query("update calls set state='completed',ended_at=now() where id=$1", [
                  db.call
                ]);
                await db.pool.query(`delete from ${entity === "offer" ? "call_offers" : "call_transfers"}`);
                // Separate call for next schedule; terminal call identity is never reopened.
                db.call = (
                  await db.pool.query(
                    "insert into calls(campaign_id,destination_number,normalized_destination_number,state) values($1,'fixture','fixture','bridged') returning id",
                    [db.campaign]
                  )
                ).rows[0].id as string;
                db.participant = (
                  await db.pool.query(
                    "insert into call_participants(call_id,role,agent_id) values($1,'agent',$2) returning id",
                    [db.call, db.agentIds[0]]
                  )
                ).rows[0].id as string;
              }
            } finally {
              await one.query("rollback");
              await two.query("rollback");
              one.release();
              two.release();
            }
          }
      await report(db, "races");
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "B04.2 ignore/expiry exclusions survive attempts and Desk/campaign replacement; winner cancellation and rollback do not exclude",
  options,
  async () => {
    const db = await fixture();
    try {
      for (const [agentIndex, state, reason] of [
        [1, "ignored", "manual_outbound_started"],
        [2, "expired", "deadline_elapsed"]
      ] as const) {
        const id = await offer(db, agentIndex);
        const client = await db.pool.connect();
        try {
          await client.query("begin");
          await client.query("update call_offers set state=$2,closed_at=now(),reason=$3 where id=$1", [
            id,
            state,
            reason
          ]);
          assert.equal(
            (
              await client.query("select count(*)::int as n from call_offer_exclusions where agent_id=$1", [
                db.agentIds[agentIndex]
              ])
            ).rows[0].n,
            1
          );
          await client.query("rollback");
        } finally {
          client.release();
        }
        assert.equal(
          (
            await db.pool.query("select count(*)::int as n from call_offer_exclusions where agent_id=$1", [
              db.agentIds[agentIndex]
            ])
          ).rows[0].n,
          0
        );
        await db.pool.query("update call_offers set state=$2,closed_at=now(),reason=$3 where id=$1", [
          id,
          state,
          reason
        ]);
        const before = (
          await db.pool.query("select * from call_offer_exclusions where agent_id=$1", [
            db.agentIds[agentIndex]
          ])
        ).rows[0];
        await db.pool.query(
          "update agent_desk_sessions set ready=false,revoked_at=now(),revision=revision+1 where id=$1",
          [db.sessions[agentIndex]]
        );
        const campaign = (
          await db.pool.query("insert into campaigns(name) values('new Desk campaign') returning id")
        ).rows[0].id;
        db.sessions[agentIndex] = (
          await db.pool.query(
            "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at) values($1,$2,2,$3,now()+interval '1 hour') returning id",
            [db.agentIds[agentIndex], campaign, randomUUID()]
          )
        ).rows[0].id as string;
        const next = await offer(db, agentIndex, 2); // stale dispatcher candidate; exclusion remains authoritative
        assert.deepEqual(
          (
            await db.pool.query("select * from call_offer_exclusions where agent_id=$1", [
              db.agentIds[agentIndex]
            ])
          ).rows[0],
          before
        );
        assert.equal(
          (
            await db.pool.query(
              "select id from call_offers o where o.id=$1 and not exists(select 1 from call_offer_exclusions e where e.call_id=o.call_id and e.agent_id=o.agent_id)",
              [next]
            )
          ).rowCount,
          0
        );
        await rejectsCode(
          db.pool.query("delete from call_offer_exclusions where agent_id=$1", [db.agentIds[agentIndex]])
        );
        await rejectsCode(
          db.pool.query("update call_offer_exclusions set reason='user_ignored' where agent_id=$1", [
            db.agentIds[agentIndex]
          ])
        );
        await rejectsCode(db.pool.query("delete from call_offers where id=$1", [id]));
      }
      const winnerCanceled = await offer(db, 0);
      await db.pool.query(
        "update call_offers set state='canceled',closed_at=now(),reason='winner_accepted' where id=$1",
        [winnerCanceled]
      );
      await rejectsCode(
        db.pool.query(
          "insert into call_offer_exclusions(call_id,agent_id,offer_id,reason,excluded_at) values($1,$2,$3,'user_ignored',now())",
          [db.call, db.agentIds[0], winnerCanceled]
        )
      );
      await offer(db, 0, 2);
      assert.equal(
        (await db.pool.query("select count(*)::int as n from call_offer_exclusions")).rows[0].n,
        2
      );
      await db.pool.query(
        "update call_offers set state='ignored',closed_at=now(),reason='user_ignored' where agent_id=$1 and state='pending'",
        [db.agentIds[0]]
      );
      assert.equal(
        (await db.pool.query("select reason from call_offer_exclusions where agent_id=$1", [db.agentIds[0]]))
          .rows[0].reason,
        "user_ignored"
      );
      await report(db, "exclusions");
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "B04.3 terminal-only ingress, lost-ACK replay, checkpoints, uncertain-operation retention and source-intent deduplication",
  options,
  async () => {
    const db = await fixture();
    try {
      const entry = await ingress(db, randomUUID(), true);
      assert.equal(
        (await db.pool.query("select call_id from inbound_ingress_evidence where ingress_id=$1", [entry]))
          .rows[0].call_id,
        null
      );
      await rejectsCode(db.pool.query("delete from inbound_ingress_evidence where ingress_id=$1", [entry]));
      await rejectsCode(
        db.pool.query(
          "update inbound_ingress_evidence set terminal_at=null,terminal_reason=null where ingress_id=$1",
          [entry]
        )
      );
      await rejectsCode(
        db.pool.query("update inbound_ingress_evidence set call_id=$2 where ingress_id=$1", [entry, db.call])
      );
      // Persist history and import checkpoint atomically, then lose the external ACK.
      const client = await db.pool.connect();
      let terminal: string;
      try {
        await client.query("begin");
        terminal = (
          await client.query(
            "insert into calls(destination_number,normalized_destination_number,state,ended_at) values('fixture','fixture','completed',now()) returning id"
          )
        ).rows[0].id as string;
        await client.query(
          "update inbound_ingress_evidence set call_id=$2,imported_sequence=evidence_sequence where ingress_id=$1",
          [entry, terminal]
        );
        await client.query("commit");
      } finally {
        client.release();
      }
      const before = (
        await db.pool.query("select * from inbound_ingress_evidence where ingress_id=$1", [entry])
      ).rows[0];
      const replay = await db.pool.connect(); // independent importer connection, post-commit retry
      try {
        await replay.query(
          "insert into inbound_ingress_evidence(ingress_id,journal_id,arrived_at,validated_did,route_revision,queue_deadline_at,evidence_sequence,terminal_at,terminal_reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(ingress_id) do nothing",
          [
            entry,
            before.journal_id,
            before.arrived_at,
            before.validated_did,
            before.route_revision,
            before.queue_deadline_at,
            before.evidence_sequence,
            before.terminal_at,
            before.terminal_reason
          ]
        );
        assert.deepEqual(
          (await replay.query("select * from inbound_ingress_evidence where ingress_id=$1", [entry])).rows[0],
          before
        );
        // A stale live journal snapshot must not overwrite committed terminal evidence.
        await rejectsCode(
          replay.query(
            "update inbound_ingress_evidence set terminal_at=null,terminal_reason=null,evidence_sequence=2 where ingress_id=$1",
            [entry]
          )
        );
        assert.equal(
          (await replay.query("select count(*)::int as n from calls where id=$1", [terminal!])).rows[0].n,
          1
        );
        await replay.query(
          "update inbound_ingress_evidence set acknowledged_sequence=imported_sequence where ingress_id=$1",
          [entry]
        );
      } finally {
        replay.release();
      }
      await rejectsCode(
        db.pool.query("update calls set state='queued',ended_at=null where id=$1", [terminal!])
      );
      await rejectsCode(db.pool.query("update calls set ended_at=null where id=$1", [terminal!]));
      await rejectsCode(
        db.pool.query("update inbound_ingress_evidence set imported_sequence=0 where ingress_id=$1", [entry])
      );
      await rejectsCode(
        db.pool.query(
          "update inbound_ingress_evidence set queue_deadline_at=queue_deadline_at+interval '1 minute' where ingress_id=$1",
          [entry]
        )
      );
      const live = await ingress(db);
      await rejectsCode(
        db.pool.query("update inbound_ingress_evidence set acknowledged_sequence=1 where ingress_id=$1", [
          live
        ])
      );
      await db.pool.query(
        "update inbound_ingress_evidence set imported_sequence=1,acknowledged_sequence=1 where ingress_id=$1",
        [live]
      );
      await rejectsCode(db.pool.query("delete from inbound_ingress_evidence where ingress_id=$1", [live]));
      await rejectsCode(
        db.pool.query(
          "update inbound_ingress_evidence set terminal_at=now(),terminal_reason='hangup' where ingress_id=$1",
          [live]
        )
      );
      await db.pool.query(
        "update inbound_ingress_evidence set evidence_sequence=2,terminal_at=now(),terminal_reason='hangup' where ingress_id=$1",
        [live]
      );
      await rejectsCode(db.pool.query("delete from inbound_ingress_evidence where ingress_id=$1", [live]));
      const key = randomUUID(),
        uuid = randomUUID(),
        op = await operation(db, key, uuid);
      await db.pool.query("update call_operations set state='executing' where id=$1", [op]);
      await db.pool.query("update call_operations set state='uncertain' where id=$1", [op]);
      for (const state of ["pending", "executing"])
        await rejectsCode(db.pool.query("update call_operations set state=$2 where id=$1", [op, state]));
      await rejectsCode(db.pool.query("delete from call_operations where id=$1", [op]));
      await rejectsCode(db.pool.query("delete from calls where id=$1", [db.call]), "23503");
      await rejectsCode(operation(db, key), "23505");
      assert.deepEqual(
        (await db.pool.query("select state,command_uuid from call_operations where id=$1", [op])).rows[0],
        { state: "uncertain", command_uuid: uuid }
      );
      await rejectsCode(
        db.pool.query(
          "update call_operations set state='succeeded',resolved_at=now(),result='{}' where id=$1",
          [op]
        )
      );
      await db.pool.query(
        "update call_operations set state='succeeded',resolved_at=now(),result=$2,resolution_evidence='synthetic fixture bridge observation' where id=$1",
        [op, { callId: db.call }]
      );
      await rejectsCode(operation(db, key), "23505"); // completed result still owns its retry key
      await rejectsCode(db.pool.query("delete from call_operations where id=$1", [op]));
      await rejectsCode(
        db.pool.query("update call_operations set state='pending',resolved_at=null where id=$1", [op])
      );
      const source = terminal!,
        retry = randomUUID();
      await db.pool.query(
        "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key,state,reason) values($1,$2,$3,$4,1,$5,'deferred','incoming_pending')",
        [db.agentIds[1], source, db.campaign, db.sessions[1], retry]
      );
      await rejectsCode(
        db.pool.query(
          "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key) values($1,$2,$3,$4,1,$5)",
          [db.agentIds[1], source, db.campaign, db.sessions[1], randomUUID()]
        ),
        "23505"
      );
      await rejectsCode(
        db.pool.query("delete from agent_auto_next_intents where idempotency_key=$1", [retry])
      );
      await db.pool.query(
        "update agent_auto_next_intents set state='started',started_call_id=$2,operation_id=$3,closed_at=now(),reason=null where idempotency_key=$1",
        [retry, db.call, op]
      );
      await rejectsCode(
        db.pool.query(
          "update agent_auto_next_intents set state='pending',closed_at=null,started_call_id=null,operation_id=null where idempotency_key=$1",
          [retry]
        )
      );
      const canceledRetry = randomUUID();
      await db.pool.query(
        "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key,state,reason,closed_at) values($1,$2,$3,$4,1,$5,'canceled','desk_changed',now())",
        [db.agentIds[2], source, db.campaign, db.sessions[2], canceledRetry]
      );
      await rejectsCode(
        db.pool.query(
          "update agent_auto_next_intents set state='deferred',closed_at=null where idempotency_key=$1",
          [canceledRetry]
        )
      );
      // Explicit retention order: acknowledged terminal evidence can be pruned;
      // unresolved terminal evidence and operations still block deletion.
      await db.pool.query("delete from inbound_ingress_evidence where ingress_id=$1", [entry]);
      await report(db, "replay-retention");
    } finally {
      await db.cleanup();
    }
  }
);
