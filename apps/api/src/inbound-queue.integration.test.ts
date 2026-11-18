import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { importIngressRecord } from "./inbound-ingress.js";
import type { IngressRecord } from "./ingress-journal.js";
import { admitInboundQueue, readInboundQueue, persistInboundQueueEvent } from "./inbound-queue.js";
import { withCallAdmission } from "./call-admission.js";
import { deleteRecording } from "./dashboard/recordings.js";
import { prepareAutoNext } from "./auto-next.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const schema = `d04_${randomUUID().replaceAll("-", "")}`;
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
      "insert into campaigns(name,status,auto_advance_to_next_lead_enabled) values('D04','active',true) returning id"
    )
  ).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'D04') returning id", [campaign])
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
        "insert into users(email,name,role,password_hash) values($1,'D04','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const id = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','D04',true) returning id",
        [user, randomUUID()]
      )
    ).rows[0].id;
    const session = (
      await pool.query(
        "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at) values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp()) returning id",
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
test(
  "D04.1/D04.2 DB: immutable recovered arrival/FIFO and context without outbound lead claims",
  options,
  async () => {
    const f = await fixture();
    try {
      const contact = (
        await f.pool.query(
          "insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number,status,attempt_count) values($1,'Known','+14155550199','+14155550199','calling',2) returning *",
          [f.campaign]
        )
      ).rows[0];
      const arrival = Date.now() * 1000 - 2000000;
      const a = await f.seed({
        uuid: "11111111-1111-4111-8111-111111111111",
        arrivedUs: arrival,
        callingNumber: "+1 (415) 555-0199"
      });
      const b = await f.seed({
        uuid: "22222222-2222-4222-8222-222222222222",
        arrivedUs: arrival,
        callingNumber: "anonymous"
      });
      const c = await f.seed({ arrivedUs: arrival - 1000000, callingNumber: "+14155550200" });
      for (const r of [b, a, c]) await admitInboundQueue(f.pool, r.uuid);
      const first = await admitInboundQueue(f.pool, a.uuid);
      assert.equal((await admitInboundQueue(f.pool, a.uuid))?.id, first?.id);
      await f.pool.query("update inbound_queues set queue_timeout_ms=45000 where id=$1", [f.queue]);
      await importIngressRecord(f.pool, a);
      const rows = await readInboundQueue(f.pool, f.campaign);
      assert.deepEqual(
        rows.map((r) => r.id),
        [c.uuid, a.uuid, b.uuid]
      );
      assert.equal(rows[1].inbound_context_contact_id, contact.id);
      assert.equal(rows[0].inbound_context_contact_id, null);
      assert.equal(rows[2].inbound_context_contact_id, null);
      assert.equal(rows[1].route_snapshot.configuration.queue_timeout_ms, 60000);
      assert.deepEqual((await f.pool.query("select * from contacts")).rows, [contact]);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from calls where contact_id is not null or agent_id is not null"
          )
        ).rows[0].n,
        0
      );
      assert.equal((await f.pool.query("select count(*)::int as n from call_offers")).rows[0].n, 0);
      assert.equal(
        (await f.pool.query("select count(*)::int as n from call_capacity_reservations")).rows[0].n,
        9
      );
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "D04.3 DB: capacity rejection is terminal/distinct with zero partial operation, participant or permit",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query("update inbound_queues set max_waiting_calls=1 where id=$1", [f.queue]);
      const a = await f.seed(),
        b = await f.seed();
      await admitInboundQueue(f.pool, a.uuid);
      assert.equal(await admitInboundQueue(f.pool, b.uuid), null);
      const call = (await f.pool.query("select * from calls where id=$1", [b.uuid])).rows[0];
      assert.equal(call.inbound_end_reason, "capacity_exceeded");
      assert.equal(call.state, "failed");
      for (const t of [
        "call_operations",
        "call_participants",
        "call_capacity_reservations",
        "inbound_queue_admissions"
      ])
        assert.equal(
          (await f.pool.query(`select count(*)::int as n from ${t} where call_id=$1`, [b.uuid])).rows[0].n,
          0
        );
      await f.end(a.uuid);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_capacity_reservations where state<>'released'"
          )
        ).rows[0].n,
        0
      );
    } finally {
      await f.cleanup();
    }
  }
);
for (const admitted of [false, true])
  test(
    `D04.2/D04.3 DB: cancel admitted=${admitted}, duplicate/late answer and bridge cannot resurrect`,
    options,
    async () => {
      const f = await fixture();
      try {
        const row = await f.seed();
        if (admitted) await admitInboundQueue(f.pool, row.uuid);
        await persistInboundQueueEvent(f.pool, {
          variable_outbound_dialer_ingress_uuid: row.uuid,
          "unique-id": row.uuid,
          "event-name": "CHANNEL_ANSWER"
        });
        let c = (await f.pool.query("select * from calls where id=$1", [row.uuid])).rows[0];
        assert.ok(c.pstn_answered_at);
        assert.equal(c.agent_connected_at, null);
        await f.end(row.uuid, "CHANNEL_HANGUP", "ORIGINATOR_CANCEL");
        await f.end(row.uuid, "CHANNEL_DESTROY", "ORIGINATOR_CANCEL");
        c = (await f.pool.query("select * from calls where id=$1", [row.uuid])).rows[0];
        assert.equal(
          c.inbound_end_reason,
          admitted ? "caller_canceled_in_queue" : "caller_canceled_before_admission"
        );
        for (const event of ["CHANNEL_ANSWER", "CHANNEL_BRIDGE", "CHANNEL_CREATE"])
          await persistInboundQueueEvent(f.pool, {
            variable_outbound_dialer_ingress_uuid: row.uuid,
            "unique-id": row.uuid,
            "event-name": event,
            "other-leg-unique-id": randomUUID()
          });
        const after = (await f.pool.query("select * from calls where id=$1", [row.uuid])).rows[0];
        assert.deepEqual(after, c);
        assert.equal(
          await admitInboundQueue(f.pool, row.uuid)?.then((r) => r?.state ?? null),
          admitted ? "canceled" : null
        );
        await importIngressRecord(f.pool, {
          ...row,
          sequence: 2,
          terminalUs: Date.now() * 1000,
          terminalReason: "channel_absent_on_recovery"
        });
        await importIngressRecord(f.pool, row);
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int as n from call_capacity_reservations where state<>'released'"
            )
          ).rows[0].n,
          0
        );
      } finally {
        await f.cleanup();
      }
    }
  );
test(
  "D04.3 DB: no absence/ACK/terminal shortcut releases capacity of an unresolved waiting sender",
  options,
  async () => {
    const f = await fixture();
    try {
      const row = await f.seed();
      const op = (await admitInboundQueue(f.pool, row.uuid))!;
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [op.id]);
      await f.end(row.uuid);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_capacity_reservations where state='uncertain'"
          )
        ).rows[0].n,
        3
      );
      assert.equal(
        (await f.pool.query("select state from call_operations where id=$1", [op.id])).rows[0].state,
        "uncertain"
      );
      await assert.rejects(
        f.pool.query("update calls set ended_at=null,state='queued' where id=$1", [row.uuid]),
        /Terminal inbound/
      );
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "D04 admission rollback and bootstrap/maintenance gates leave no partial queue/capacity or commands",
  options,
  async () => {
    const f = await fixture();
    try {
      const row = await f.seed();
      await assert.rejects(
        admitInboundQueue(f.pool, row.uuid, async () => {
          throw new Error("rollback checkpoint");
        }),
        /rollback checkpoint/
      );
      assert.equal(
        (await f.pool.query("select state from calls where id=$1", [row.uuid])).rows[0].state,
        "received"
      );
      for (const t of [
        "call_operations",
        "call_participants",
        "call_capacity_reservations",
        "inbound_queue_admissions"
      ])
        assert.equal((await f.pool.query(`select count(*)::int as n from ${t}`)).rows[0].n, 0);
      await f.pool.query("update call_admission_migration set reconciliation_required=true");
      await assert.rejects(admitInboundQueue(f.pool, row.uuid), /coordination_unavailable/);
      await f.pool.query("update call_admission_migration set reconciliation_required=false");
      await f.pool.query(
        "insert into system_settings(key,value_json) values('ops.call_start_paused','true') on conflict(key) do update set value_json='true'"
      );
      await assert.rejects(admitInboundQueue(f.pool, row.uuid), /maintenance/);
    } finally {
      await f.cleanup();
    }
  }
);
for (const inboundFirst of [false, true])
  for (const rollback of [false, true])
    test(
      `D04.1 DB: inbound/auto-next ordered locks inboundFirst=${inboundFirst}, rollback=${rollback}`,
      options,
      async () => {
        const f = await fixture();
        const inbound = new pg.Pool({ ...f.config, max: 1 }),
          auto = new pg.Pool({ ...f.config, max: 1 });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let ready!: () => void;
        const reached = new Promise<void>((r) => (ready = r));
        let one: Promise<unknown> | undefined, two: Promise<unknown> | undefined;
        try {
          const row = await f.seed(),
            agent = await f.agent();
          const lead = (
            await f.pool.query(
              "insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number,status) values($1,'source','+14155550198','+14155550198','completed') returning id",
              [f.campaign]
            )
          ).rows[0].id;
          const source = (
            await f.pool.query(
              "insert into calls(campaign_id,agent_id,contact_id,destination_number,normalized_destination_number,state,ended_at) values($1,$2,$3,'+14155550198','+14155550198','completed',clock_timestamp()-interval '2 seconds') returning id",
              [f.campaign, agent.id, lead]
            )
          ).rows[0].id;
          const intent = {
            startReason: "automatic" as const,
            idempotencyKey: randomUUID(),
            sourceCallId: source,
            deskSessionId: agent.session,
            expectedRevision: "1",
            bindingGeneration: "1"
          };
          const pause = async () => {
            ready();
            await gate;
            if (rollback) throw new Error("controlled rollback");
          };
          const runInbound = (first: boolean) =>
            admitInboundQueue(inbound, row.uuid, first ? pause : undefined);
          const runAuto = async (first: boolean) => {
            const c = await auto.connect();
            try {
              return await withCallAdmission(
                c,
                { agentIds: [agent.id], userIds: [agent.user], campaignIds: [f.campaign], callIds: [source] },
                async (a) => {
                  const result = await prepareAutoNext(a, {
                    actorUserId: agent.user,
                    agentId: agent.id,
                    campaignId: f.campaign,
                    intent,
                    fingerprint: "a".repeat(64)
                  });
                  if (first) await pause();
                  return result;
                }
              );
            } finally {
              c.release();
            }
          };
          const pidI = (await inbound.query("select pg_backend_pid() as p")).rows[0].p;
          const pidA = (await auto.query("select pg_backend_pid() as p")).rows[0].p;
          one = (inboundFirst ? runInbound(true) : runAuto(true)).catch((e) => {
            if (!rollback) throw e;
            assert.match(e.message, /controlled rollback/);
            return null;
          });
          await reached;
          two = inboundFirst ? runAuto(false) : runInbound(false);
          await assertBlocked(f.pool, inboundFirst ? pidA : pidI, inboundFirst ? pidI : pidA);
          release();
          const results = await Promise.all([one, two]);
          const automatic = results[inboundFirst ? 1 : 0] as Awaited<
            ReturnType<typeof prepareAutoNext>
          > | null;
          if (inboundFirst) {
            assert.equal(automatic?.result?.status, rollback ? undefined : "deferred");
          } else if (!rollback) {
            assert.equal(automatic?.result, undefined);
          }
          assert.equal((await f.pool.query("select count(*)::int as n from call_offers")).rows[0].n, 0);
          assert.equal(
            (await f.pool.query("select count(*)::int as n from call_capacity_reservations")).rows[0].n,
            inboundFirst && rollback ? 0 : 3
          );
        } finally {
          release();
          await Promise.allSettled([one, two]);
          await inbound.end();
          await auto.end();
          await f.cleanup();
        }
      }
    );

test(
  "D04 DB: captured deadline and live waiting recording survive later configuration edits",
  options,
  async () => {
    const f = await fixture();
    try {
      const id = (
        await f.pool.query(
          "insert into recordings(campaign_id,name,file_path,runtime_file_path) values($1,'waiting','/fixture/wait.wav','/runtime/wait.wav') returning id",
          [f.campaign]
        )
      ).rows[0].id;
      const row = await f.seed({
        routeData: Buffer.from(JSON.stringify({ waiting_audio_id: id })).toString("base64url")
      });
      const op = (await admitInboundQueue(f.pool, row.uuid))!;
      assert.equal(op.request.audio, "/runtime/wait.wav");
      assert.equal((await deleteRecording(f.pool, id)).status, "in_use");
      await assert.rejects(
        f.pool.query("update calls set queue_deadline_at=queue_deadline_at+interval '1 second' where id=$1", [
          row.uuid
        ]),
        /deadline is immutable/
      );
      await f.end(row.uuid);
      // F02 also pins captured ingress until its terminal journal sequence is
      // imported. Native call terminal state alone must not orphan that capture.
      assert.equal((await deleteRecording(f.pool, id)).status, "in_use");
      await importIngressRecord(f.pool, {
        ...row,
        sequence: 2,
        terminalUs: Date.now() * 1000,
        terminalReason: "channel_absent_on_recovery"
      });
      assert.equal((await deleteRecording(f.pool, id)).status, "deleted");
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H01 recovered ingress absence cannot turn an earlier connected external participant into forwarding success",
  options,
  async () => {
    const f = await fixture();
    try {
      const row = await f.seed();
      await admitInboundQueue(f.pool, row.uuid);
      await f.pool.query(
        "insert into call_participants(call_id,role,origin,connected_at) values($1,'external','native',clock_timestamp())",
        [row.uuid]
      );
      await persistInboundQueueEvent(
        f.pool,
        {
          variable_outbound_dialer_ingress_uuid: row.uuid,
          "unique-id": row.uuid,
          "event-name": "INGRESS_ABSENT"
        },
        "",
        true
      );
      const terminal = (await f.pool.query("select * from calls where id=$1", [row.uuid])).rows[0];
      assert.equal(terminal.state, "failed");
      assert.equal(terminal.outcome, "failed");
      assert.equal(terminal.inbound_end_reason, "channel_absent_on_recovery");
      assert.equal(terminal.terminal_source, "lifecycle_recovery");
      const count = (
        await f.pool.query("select count(*)::int n from call_events where call_id=$1", [row.uuid])
      ).rows[0].n;
      await persistInboundQueueEvent(
        f.pool,
        {
          variable_outbound_dialer_ingress_uuid: row.uuid,
          "unique-id": row.uuid,
          "event-name": "INGRESS_ABSENT"
        },
        "",
        true
      );
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_events where call_id=$1", [row.uuid])).rows[0]
          .n,
        count,
        "acknowledged journal snapshots are idempotent"
      );
    } finally {
      await f.cleanup();
    }
  }
);
