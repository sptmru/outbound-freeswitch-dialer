import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { getAgentAvailability, setAgentAvailability } from "./agent-availability.js";
import { changeDeskEligibility } from "./eligibility.js";
import { withCallAdmission } from "./call-admission.js";
import {
  startSupervisorSession,
  stopSupervisorSession,
  updateSupervisorSessionMode
} from "./dashboard/supervisor.js";
import type { AppConfig } from "./config.js";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
test(
  "C07.1 real eligibility mutations serialize with cross-process admission, preserve occupied slots and roll back",
  options,
  async () => {
    const schema = `c07_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
    const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
    const children: ReturnType<typeof fork>[] = [];
    const evidence: unknown[] = [];
    try {
      await admin.query(`create schema ${schema}`);
      await runMigrations(pool);
      await pool.query(
        "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
      );
      async function seed(expired = false) {
        const user = (
          await pool.query(
            "insert into users(email,name,role,password_hash) values($1,'C07','admin','fixture') returning id,auth_version",
            [`${randomUUID()}@example.test`]
          )
        ).rows[0];
        const agentId = (
          await pool.query(
            "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','C07',true) returning id",
            [user.id, randomUUID()]
          )
        ).rows[0].id;
        const campaignId = (
          await pool.query("insert into campaigns(name,status) values('C07','active') returning id")
        ).rows[0].id;
        const nextCampaign = (
          await pool.query("insert into campaigns(name,status) values('C07 next','active') returning id")
        ).rows[0].id;
        const deskSessionId = (
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
          await pool.query("insert into inbound_queues(campaign_id,name) values($1,'C07') returning id", [
            campaignId
          ])
        ).rows[0].id;
        const callId = (
          await pool.query(
            `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
        values($1,'+14155550100','+14155550100','inbound','queued','+14155550101','+14155550100','+14155550101',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
            [campaignId, queueId]
          )
        ).rows[0].id;
        const offerId = (
          await pool.query(
            `insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,created_at,deadline_at)
        values($1,$2,'inbound',1,$3,1,1,clock_timestamp()-interval '20 seconds',clock_timestamp()+case when $4 then interval '-10 seconds' else interval '1 hour' end) returning id`,
            [callId, agentId, deskSessionId, expired]
          )
        ).rows[0].id;
        const sourceId = (
          await pool.query(
            "insert into calls(campaign_id,destination_number,normalized_destination_number,state,ended_at) values($1,'+14155550100','+14155550100','completed',clock_timestamp()) returning id",
            [campaignId]
          )
        ).rows[0].id;
        await pool.query(
          "insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key) values($1,$2,$3,$4,1,$5)",
          [agentId, sourceId, campaignId, deskSessionId, randomUUID()]
        );
        const input = {
          agentId,
          userId: user.id,
          campaignId,
          deskSessionId,
          expectedRevision: "1",
          bindingGeneration: "1",
          callId,
          key: randomUUID()
        };
        const mutate = (db: pg.Pool, kind: string) =>
          kind === "pause"
            ? setAgentAvailability(db, agentId, "paused", { userId: user.id, authVersion: user.auth_version })
            : changeDeskEligibility(db, {
                actorUserId: user.id,
                actorAuthVersion: user.auth_version,
                agentId,
                deskSessionId,
                expectedRevision: "1",
                bindingGeneration: "1",
                ...(kind === "campaign" ? { campaignId: nextCampaign } : { clearReadiness: true })
              });
        return { input, mutate, offerId };
      }
      function worker(input: object) {
        const child = fork(
          new URL("../../../tests/fixtures/inbound/admission-worker.mjs", import.meta.url),
          [schema, JSON.stringify(input)],
          {
            env: { PATH: process.env.PATH, TEST_DATABASE_URL: testDatabaseUrl() },
            stdio: ["ignore", "pipe", "pipe", "ipc"]
          }
        );
        children.push(child);
        const messages: any[] = [];
        let wake: (() => void) | undefined;
        let failure: Error | undefined;
        let output = "";
        child.stderr!.on("data", (c) => (output += c));
        child.on("message", (m) => {
          messages.push(m);
          wake?.();
        });
        child.on("error", (e) => {
          failure = e;
          wake?.();
        });
        const done = once(child, "exit");
        child.on("exit", (code) => {
          if (code) failure = new Error(output || `exit ${code}`);
          wake?.();
        });
        return {
          child,
          done,
          async wait(type: string) {
            const deadline = Date.now() + 5000;
            while (true) {
              const index = messages.findIndex((m) => m.type === type);
              if (index >= 0) return messages.splice(index, 1)[0];
              if (failure) throw failure;
              assert.ok(Date.now() < deadline, `missing worker ${type}: ${JSON.stringify(messages)}`);
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 50);
                wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
            }
          }
        };
      }
      for (const kind of ["pause", "campaign", "readiness"])
        for (const first of ["mutation", "admission"])
          for (const rollback of [false, true]) {
            const f = await seed();
            const client = await pool.connect();
            const backend = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
            let reached!: () => void, proceed!: () => void;
            const held = new Promise<void>((r) => (reached = r)),
              release = new Promise<void>((r) => (proceed = r));
            // Observe the real public mutation at its COMMIT, after all its SQL writes.
            const db = {
              connect: async () => ({
                query: async (sql: string, params?: any[]) => {
                  if (sql === "commit" && first === "mutation") {
                    reached();
                    await release;
                    if (rollback) throw new Error("fixture_rollback");
                  }
                  return client.query(sql, params);
                },
                release: () => undefined
              })
            } as unknown as pg.Pool;
            const w = worker(f.input);
            const ready = await w.wait("ready");
            assert.notEqual(ready.pid, process.pid);
            assert.notEqual(ready.backend, backend);
            let mutation: Promise<unknown> | undefined;
            try {
              if (first === "mutation") {
                mutation = f.mutate(db, kind).catch((e) => {
                  if (e.message !== "fixture_rollback") throw e;
                  return "rolled_back";
                });
                await held;
                w.child.send({ type: "go" });
                await assertBlocked(pool, ready.backend, backend);
                proceed();
                await mutation;
                if (rollback) {
                  await w.wait("before-commit");
                  w.child.send({ type: "commit" });
                  await w.wait("committed");
                } else {
                  const result = await w.wait("rejected");
                  assert.equal(result.reason, kind === "pause" ? "paused" : "revision_conflict");
                }
              } else {
                w.child.send({ type: "go" });
                await w.wait("before-commit");
                mutation = f.mutate(db, kind);
                await assertBlocked(pool, backend, ready.backend);
                w.child.send({ type: rollback ? "rollback" : "commit" });
                await w.wait(rollback ? "rejected" : "committed");
                await mutation;
              }
              await w.done;
              const slot = (
                await pool.query("select * from agent_call_slots where agent_id=$1", [f.input.agentId])
              ).rows[0];
              const admitted = (first === "admission" && !rollback) || (first === "mutation" && rollback);
              assert.equal(slot.state, admitted ? "reserved" : "free");
              assert.equal(
                (
                  await pool.query("select count(*)::int as n from call_operations where call_id=$1", [
                    f.input.callId
                  ])
                ).rows[0].n,
                admitted ? 1 : 0
              );
              const offer = (await pool.query("select * from call_offers where id=$1", [f.offerId])).rows[0];
              assert.equal(offer.state, first === "mutation" && rollback ? "pending" : "canceled");
              const intent = (
                await pool.query("select * from agent_auto_next_intents where agent_id=$1", [f.input.agentId])
              ).rows[0];
              assert.equal(intent.state, first === "mutation" && rollback ? "pending" : "canceled");
              assert.equal(
                (await pool.query("select 1 from call_offer_exclusions where call_id=$1", [f.input.callId]))
                  .rowCount,
                0
              );
              evidence.push({
                kind,
                first,
                rollback,
                slot,
                offerState: offer.state,
                intentState: intent.state,
                admitted,
                process: ready.pid,
                backend: ready.backend
              });
            } finally {
              proceed();
              if (w.child.exitCode === null && w.child.signalCode === null) {
                w.child.kill("SIGKILL");
                await w.done;
              }
              await mutation?.catch(() => {});
              client.release();
            }
          }
      for (const kind of ["pause", "campaign", "readiness"]) {
        const f = await seed();
        const client = await pool.connect();
        try {
          await withCallAdmission(
            client,
            { agentIds: [f.input.agentId], callIds: [f.input.callId], campaignIds: [f.input.campaignId] },
            async (a) => {
              await a.reserve({ ...f.input, offerId: f.offerId }, f.input.callId);
              await client.query(
                "update call_offers set state='accepted',reason='explicit_accept',closed_at=clock_timestamp() where id=$1",
                [f.offerId]
              );
            }
          );
        } finally {
          client.release();
        }
        const before = (
          await pool.query("select * from agent_call_slots where agent_id=$1", [f.input.agentId])
        ).rows;
        await f.mutate(pool, kind);
        assert.deepEqual(
          (await pool.query("select * from agent_call_slots where agent_id=$1", [f.input.agentId])).rows,
          before
        );
        assert.equal(
          (await pool.query("select state from call_offers where id=$1", [f.offerId])).rows[0].state,
          "accepted"
        );
      }
      const elapsed = await seed(true);
      await elapsed.mutate(pool, "pause");
      assert.equal(
        (await pool.query("select state from call_offers where id=$1", [elapsed.offerId])).rows[0].state,
        "expired"
      );
      assert.equal(
        (await pool.query("select reason from call_offer_exclusions where offer_id=$1", [elapsed.offerId]))
          .rows[0].reason,
        "deadline_elapsed"
      );
      const stale = await seed();
      assert.equal(
        await setAgentAvailability(pool, stale.input.agentId, "paused", {
          userId: stale.input.userId,
          authVersion: 999
        }),
        null
      );
      assert.equal(
        (await pool.query("select availability_status from agents where id=$1", [stale.input.agentId]))
          .rows[0].availability_status,
        "available"
      );
      assert.equal(
        (await pool.query("select state from call_offers where id=$1", [stale.offerId])).rows[0].state,
        "pending"
      );
      const staleSession = (
        await pool.query("select * from agent_desk_sessions where id=$1", [stale.input.deskSessionId])
      ).rows;
      await assert.rejects(
        changeDeskEligibility(pool, {
          ...stale.input,
          actorUserId: stale.input.userId,
          actorAuthVersion: 1,
          expectedRevision: "2",
          clearReadiness: true
        }),
        /revision_conflict/
      );
      assert.deepEqual(
        (await pool.query("select * from agent_desk_sessions where id=$1", [stale.input.deskSessionId])).rows,
        staleSession
      );
      const source = await seed(),
        recipient = await seed();
      await pool.query(
        "update call_offers set state='canceled',reason='fixture',closed_at=clock_timestamp() where id=$1",
        [recipient.offerId]
      );
      const participant = (
        await pool.query(
          "insert into call_participants(call_id,agent_id,role,joined_at) values($1,$2,'agent',clock_timestamp()) returning id",
          [source.input.callId, source.input.agentId]
        )
      ).rows[0].id;
      const transfer = (
        await pool.query(
          `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at)
      values($1,1,$2,$3,$4,clock_timestamp()+interval '1 hour') returning id`,
          [source.input.callId, source.input.agentId, participant, recipient.input.agentId]
        )
      ).rows[0].id;
      await pool.query(
        `insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,transfer_id)
      values($1,$2,'transfer',1,$3,1,1,clock_timestamp()+interval '1 hour',$4)`,
        [source.input.callId, recipient.input.agentId, recipient.input.deskSessionId, transfer]
      );
      const beforeSource = (await pool.query("select * from calls where id=$1", [source.input.callId])).rows;
      await recipient.mutate(pool, "pause");
      assert.equal(
        (await pool.query("select state from call_transfers where id=$1", [transfer])).rows[0].state,
        "canceled"
      );
      assert.equal(
        (await pool.query("select state from call_offers where transfer_id=$1", [transfer])).rows[0].state,
        "canceled"
      );
      assert.deepEqual(
        (await pool.query("select * from calls where id=$1", [source.input.callId])).rows,
        beforeSource
      );
      assert.equal(
        (await pool.query("select state from call_offers where id=$1", [source.offerId])).rows[0].state,
        "pending"
      );
      assert.equal(
        (
          await pool.query("select state from agent_auto_next_intents where agent_id=$1", [
            source.input.agentId
          ])
        ).rows[0].state,
        "pending"
      );
      assert.equal(
        (await pool.query("select count(*)::int as n from call_capacity_reservations")).rows[0].n,
        0
      );
      assert.equal((await pool.query("select count(*)::int as n from call_legs")).rows[0].n, 0);
      const wrap = await seed();
      await pool.query(
        "update agents set availability_status='wrap_up',wrap_up_until=clock_timestamp()+interval '1 hour' where id=$1",
        [wrap.input.agentId]
      );
      assert.deepEqual(await getAgentAvailability(pool, wrap.input.userId), {
        status: "available",
        wrapUpUntil: null
      });
      const wrapClient = await pool.connect();
      try {
        const decision = await withCallAdmission(
          wrapClient,
          { agentIds: [wrap.input.agentId], campaignIds: [wrap.input.campaignId] },
          (a) => a.eligibility(wrap.input)
        );
        assert.equal(decision.eligible, true);
      } finally {
        wrapClient.release();
      }
      const monitoringActor = await seed();
      const monitorClient = await pool.connect();
      try {
        await withCallAdmission(
          monitorClient,
          {
            agentIds: [monitoringActor.input.agentId],
            callIds: [monitoringActor.input.callId],
            campaignIds: [monitoringActor.input.campaignId]
          },
          (a) => a.reserve(monitoringActor.input, monitoringActor.input.callId)
        );
      } finally {
        monitorClient.release();
      }
      const target = (
        await pool.query(
          "insert into calls(agent_id,campaign_id,destination_number,normalized_destination_number,state) values($1,$2,'+14155550100','+14155550100','bridged') returning id",
          [source.input.agentId, source.input.campaignId]
        )
      ).rows[0].id;
      for (const type of ["agent", "customer"])
        await pool.query(
          "insert into call_legs(call_id,type,state,freeswitch_uuid) values($1,$2,'answered',$3)",
          [target, type, randomUUID()]
        );
      await pool.query(
        "insert into admin_supervisor_endpoints(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,'c07_supervisor','fixture','fixture','C07')",
        [monitoringActor.input.userId]
      );
      await pool.query("update call_admission_migration set reconciliation_required=true");
      let originates = 0;
      const dependencies = {
        createUuid: async () => randomUUID(),
        sendApiCommand: async (_config: AppConfig, command: string) => ({
          body: command.startsWith("sofia") ? "User: c07_supervisor@fixture.invalid" : "true",
          headers: {},
          raw: ""
        }),
        originate: async () => {
          originates++;
          throw new Error("unreserved send");
        }
      };
      const legacyConfig = { FREESWITCH_ESL_ENABLED: true } as AppConfig;
      await assert.rejects(
        startSupervisorSession(
          pool,
          legacyConfig,
          { actorUserId: monitoringActor.input.userId, callId: target },
          dependencies
        ),
        /Finish your own Agent Desk call/
      );
      assert.equal(originates, 0);
      await pool.query(
        "insert into system_settings(key,value_json) values('ops.call_start_paused','true') on conflict(key) do update set value_json='true'"
      );
      await assert.rejects(
        startSupervisorSession(
          pool,
          legacyConfig,
          { actorUserId: monitoringActor.input.userId, callId: target },
          dependencies
        ),
        /maintenance/
      );
      assert.equal(originates, 0);
      await pool.query("update call_admission_migration set reconciliation_required=false");
      // A native-cutover route must refuse the legacy sender before any ESL/provisioning.
      const config = {} as AppConfig;
      for (const action of [
        () => startSupervisorSession(pool, config, { actorUserId: randomUUID(), callId: randomUUID() }),
        () => stopSupervisorSession(pool, config, { actorUserId: randomUUID(), sessionId: randomUUID() }),
        () =>
          updateSupervisorSessionMode(pool, config, {
            actorUserId: randomUUID(),
            sessionId: randomUUID(),
            mode: "join"
          })
      ])
        await assert.rejects(action, /Live monitoring is temporarily unavailable/);
      if (process.env.INBOUND_TEST_ARTIFACTS) {
        await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
        await writeFile(
          `${process.env.INBOUND_TEST_ARTIFACTS}/c07-eligibility-report.json`,
          JSON.stringify(
            {
              database: (await pool.query("select version() as v")).rows[0].v,
              evidence,
              media: "none; SQL admission worker, no ESL sends; native supervisor explicitly blocked"
            },
            null,
            2
          )
        );
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const done = once(child, "exit");
          child.kill("SIGKILL");
          await done;
        }
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  }
);
