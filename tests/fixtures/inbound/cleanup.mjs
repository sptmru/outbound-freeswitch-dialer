// Shared disposable PostgreSQL/FS fixture; never reads application configuration.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { fork } from "node:child_process";
import { once } from "node:events";
import { runMigrations } from "../../../apps/api/dist-test/db.js";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
import { reserveAgentCallSlot } from "../../../apps/api/dist-test/agent-call-slots.js";
import { enqueueCallCommand } from "../../../apps/api/dist-test/call-executor.js";

export async function cleanupFixture(config, { onPoolError } = {}) {
  const children = [];
  const transcript = [];
  const schema = `c06_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(config);
  if (onPoolError) admin.on("error", onPoolError);
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({
    ...config,
    max: 8,
    options: `${config.options ?? ""} -c search_path=${schema}`
  });
  if (onPoolError) pool.on("error", onPoolError);
  try {
    await runMigrations(pool);
  } catch (error) {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    throw error;
  }
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  const campaignId = (
    await pool.query(
      "insert into campaigns(name,status,manual_dialing_enabled) values('C06','active',true) returning id"
    )
  ).rows[0].id;
  const userId = (
    await pool.query(
      "insert into users(email,name,role,password_hash) values($1,'C06','agent','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0].id;
  const agentId = (
    await pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered,status) values($1,$2,'fixture','fixture','C06',true,'in_call') returning id",
      [userId, randomUUID()]
    )
  ).rows[0].id;
  const sessionId = (
    await pool.query(
      `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at)
    values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp()) returning id`,
      [agentId, campaignId, randomUUID()]
    )
  ).rows[0].id;
  await pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [agentId]
  );
  const queueId = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'C06') returning id", [
      campaignId
    ])
  ).rows[0].id;
  const input = {
    agentId,
    userId,
    campaignId,
    deskSessionId: sessionId,
    expectedRevision: "1",
    bindingGeneration: "1"
  };
  async function transaction(callId, work) {
    const client = await pool.connect();
    try {
      return await withCallAdmission(client, { callIds: [callId], agentIds: [agentId] }, work);
    } finally {
      client.release();
    }
  }
  let phoneSequence = 100;
  async function seed({
    unresolved = false,
    vm = false,
    inbound = false,
    agentUuid = randomUUID(),
    customerUuid = randomUUID()
  } = {}) {
    const callId = randomUUID(),
      participantId = randomUUID(),
      customerId = randomUUID();
    const contactId = inbound
      ? null
      : (
          await pool.query(
            "insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number,status) values($1,'C06',$2,$2,'calling') returning id",
            [campaignId, `+14155550${++phoneSequence}`]
          )
        ).rows[0].id;
    let slot, operationId, tokens;
    await transaction(callId, async (a) => {
      await a.client.query(
        `insert into calls(id,campaign_id,agent_id,contact_id,destination_number,normalized_destination_number,state,direction,
        original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at,pstn_answered_at,answered_at)
        values($1,$2,$3,$4,'+14155550100','+14155550100',$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp(),clock_timestamp())`,
        [
          callId,
          campaignId,
          agentId,
          contactId,
          vm ? "voicemail_playback_started" : "bridged",
          inbound ? "inbound" : "outbound",
          inbound ? "+14155550101" : null,
          inbound ? "+14155550100" : null,
          inbound ? "+14155550101" : null,
          inbound ? queueId : null,
          inbound ? new Date() : null,
          inbound ? new Date(Date.now() + 60000) : null
        ]
      );
      await a.client.query(
        `insert into call_participants(id,call_id,role,agent_id) values($1,$2,'agent',$3),($4,$2,'customer',null)`,
        [participantId, callId, agentId, customerId]
      );
      slot = await reserveAgentCallSlot(a.client, agentId, callId, participantId);
      assert.ok(slot);
      await a.client.query(
        `insert into call_legs(call_id,participant_id,type,freeswitch_uuid,state) values($1,$2,'agent',$3,'answered'),($1,$4,'customer',$5,'answered')`,
        [callId, participantId, agentUuid, customerId, customerUuid]
      );
      operationId = randomUUID();
      await enqueueCallCommand(a, {
        id: operationId,
        callId,
        scope: "c06",
        key: randomUUID(),
        fingerprint: "a".repeat(64),
        kind: "originate",
        generation: slot.generation,
        commandUuid: randomUUID(),
        targetUuid: agentUuid,
        request: { slot, customerUuid },
        deadline: new Date(Date.now() + 60000)
      });
      tokens = (
        await a.capacity
          .claim({ kind: "outbound", callId, operationId, generation: slot.generation, agentId })
          .catch(async (error) => {
            if (!inbound) throw error;
            return a.capacity.claim({
              kind: "browser",
              callId,
              operationId,
              generation: slot.generation,
              agentId
            });
          })
      ).tokens;
      if (!unresolved)
        await a.client.query(
          "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='fixture sender quiesced' where id=$1",
          [operationId]
        );
      await a.client.query("update agents set status='in_call' where id=$1", [agentId]);
    });
    return {
      callId,
      participantId,
      customerId,
      contactId,
      slot,
      operationId,
      tokens,
      agentUuid,
      customerUuid
    };
  }
  async function snapshot() {
    return Object.fromEntries(
      await Promise.all(
        [
          "calls",
          "call_participants",
          "call_legs",
          "agent_call_slots",
          "call_operations",
          "call_execution_attempts",
          "call_capacity_reservations",
          "contacts",
          "agents",
          "call_events",
          "call_offers",
          "call_transfers",
          "agent_auto_next_intents"
        ].map(async (t) => [t, (await pool.query(`select * from ${t}`)).rows])
      )
    );
  }
  function worker(input) {
    const child = fork(new URL("./cleanup-worker.mjs", import.meta.url), [schema, JSON.stringify(input)], {
      env: { PATH: process.env.PATH, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(child);
    const messages = [];
    let failure,
      output = "",
      wake;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("message", (m) => {
      messages.push(m);
      transcript.push(m);
      wake?.();
    });
    child.on("error", (e) => {
      failure = e;
      wake?.();
    });
    const completion = new Promise((resolve) =>
      child.on("exit", (code) => {
        if (code) failure = new Error(output || `exit ${code}`);
        wake?.();
        resolve();
      })
    );
    return {
      send: (type) => child.send({ type }),
      async wait(type) {
        const deadline = Date.now() + 5000;
        while (true) {
          const i = messages.findIndex((m) => m.type === type);
          if (i >= 0) return messages.splice(i, 1)[0];
          if (failure) throw failure;
          assert.ok(Date.now() < deadline, `worker ${type}: ${output}`);
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 50);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
          wake = undefined;
        }
      },
      async finished() {
        await completion;
        if (failure) throw failure;
      }
    };
  }
  return {
    pool,
    schema,
    agentId,
    userId,
    campaignId,
    input,
    transaction,
    seed,
    snapshot,
    worker,
    transcript,
    async cleanup() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      await pool.end();
      try {
        await admin.query(`drop schema ${schema} cascade`);
        assert.equal(
          (await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount,
          0
        );
      } finally {
        await admin.end();
      }
    }
  };
}
