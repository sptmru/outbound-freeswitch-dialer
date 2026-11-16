import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { assertBlocked, databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import {
  AdmissionDiscoveryChanged,
  AdmissionError,
  type CallAdmission,
  discoverAdmissionResources,
  withCallAdmission,
  type AdmissionEligibility,
  type AdmissionResources
} from "./call-admission.js";
import type { SlotToken } from "./agent-call-slots.js";
import { lockCampaignVoicemail } from "./dashboard/recordings.js";
import { lockUserMediaAction } from "./user-media-lock.js";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
async function fixture() {
  const schema = `c01_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  const children: ReturnType<typeof fork>[] = [];
  const transcript: unknown[] = [];
  const cleanup = async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    await pool.end();
    try {
      await admin.query(`drop schema ${schema} cascade`);
      assert.equal((await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount, 0);
    } finally {
      await admin.end();
    }
  };
  try {
    await runMigrations(pool);
  } catch (error) {
    await cleanup();
    throw error;
  }
  async function seed() {
    const user = (
      await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'C01','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const agentId = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','C01') returning id",
        [user, randomUUID()]
      )
    ).rows[0].id;
    const campaignId = (
      await pool.query("insert into campaigns(name,status) values('C01','active') returning id")
    ).rows[0].id;
    const deskSessionId = (
      await pool.query(
        `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at)
      values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp()) returning id`,
        [agentId, campaignId, randomUUID()]
      )
    ).rows[0].id;
    // Explicit test-only reconciliation. No FS absence or target cutover claim.
    await pool.query(
      "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
      [agentId]
    );
    const queue = (
      await pool.query("insert into inbound_queues(campaign_id,name) values($1,'C01') returning id", [
        campaignId
      ])
    ).rows[0].id;
    const makeCall = async (inbound = false) =>
      (
        await pool.query(
          inbound
            ? `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+14155550100','+14155550100','inbound','queued','+14155550101','+14155550100','+14155550101',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`
            : "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
          inbound ? [campaignId, queue] : [campaignId]
        )
      ).rows[0].id as string;
    const input: AdmissionEligibility = {
      agentId,
      userId: user,
      campaignId,
      deskSessionId,
      expectedRevision: "1",
      bindingGeneration: "1"
    };
    const resources = (...callIds: string[]): AdmissionResources => ({
      agentIds: [agentId],
      callIds,
      campaignIds: [campaignId]
    });
    return { input, resources, makeCall };
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
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let output = "";
    child.stdout!.on("data", (c) => (output += c));
    child.stderr!.on("data", (c) => (output += c));
    child.on("message", (m: any) => {
      messages.push(m);
      transcript.push(m);
      wake?.();
    });
    child.on("error", (e) => {
      failure = e;
      wake?.();
    });
    const completion = new Promise<void>((resolve) =>
      child.on("exit", (code) => {
        if (code) failure = new Error(output || `worker exit ${code}`);
        wake?.();
        resolve();
      })
    );
    return {
      send: (type: string) => child.send({ type }),
      async wait(type: string) {
        const deadline = Date.now() + 5000;
        while (true) {
          const index = messages.findIndex((m) => m.type === type);
          if (index >= 0) return messages.splice(index, 1)[0];
          if (failure) throw failure;
          assert.ok(Date.now() < deadline, `worker checkpoint ${type}: ${output}`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 50);
            wake = () => {
              clearTimeout(timer);
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
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "calls",
          "agent_call_slots",
          "call_participants",
          "call_legs",
          "call_offers",
          "call_offer_exclusions",
          "call_transfers",
          "call_operations",
          "contacts",
          "call_capacity_reservations",
          "call_supervisor_sessions",
          "agent_auto_next_intents"
        ].map(async (table) => [table, (await pool.query(`select * from ${table}`)).rows])
      )
    );
  async function report(name: string, checks: unknown) {
    if (!process.env.INBOUND_TEST_ARTIFACTS) return;
    await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
    await writeFile(
      `${process.env.INBOUND_TEST_ARTIFACTS}/c01-${name}-report.json`,
      JSON.stringify(
        {
          status: "passed",
          database: (await pool.query("select version()")).rows[0].version,
          media: "none; SQL-only participants, zero ESL sends",
          checks,
          transcript,
          snapshot: await snapshot()
        },
        null,
        2
      ) + "\n"
    );
  }
  const enable = () =>
    pool.query(
      "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
    );
  return { pool, seed, worker, cleanup, report, snapshot, enable };
}
async function rejectReason(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (e: unknown) => e instanceof AdmissionError && e.reason === reason);
}

test(
  "C01.1 cross-process starts and inbound acceptance reservations: both winners and rollback; pre-SIP slot, one operation, no loser effects",
  options,
  async () => {
    const db = await fixture();
    try {
      await db.enable();
      const checks = [];
      for (const inbound of [false, true])
        for (const [order, rollback] of [
          [0, false],
          [1, false],
          [0, true]
        ] as const) {
          const f = await db.seed();
          const calls = [await f.makeCall(inbound), await f.makeCall(inbound)];
          const before = await db.snapshot();
          const workers = calls.map((callId, i) =>
            db.worker({ ...f.input, callId, inbound, key: `request-${i}` })
          );
          const ready = await Promise.all(workers.map((w) => w.wait("ready")));
          assert.notEqual(ready[0].pid, ready[1].pid);
          assert.notEqual(ready[0].backend, ready[1].backend);
          const first = workers[order],
            second = workers[1 - order];
          first.send("resume");
          await first.wait("before-commit");
          second.send("resume");
          await assertBlocked(db.pool, ready[1 - order].backend, ready[order].backend);
          first.send(rollback ? "rollback" : "commit");
          if (rollback) {
            assert.equal((await first.wait("rejected")).reason, "fixture_rollback");
            await second.wait("before-commit");
            second.send("commit");
          }
          const winner = rollback ? second : first;
          const committed = await winner.wait("committed");
          if (!rollback) assert.equal((await second.wait("rejected")).reason, "slot_occupied");
          await Promise.all(workers.map((w) => w.finished()));
          const after = await db.snapshot();
          assert.equal(after.call_operations.length - before.call_operations.length, 1);
          assert.equal(after.call_legs.length, 0);
          assert.equal(after.call_participants.length, 0);
          assert.deepEqual(after.contacts, before.contacts);
          assert.deepEqual(after.call_capacity_reservations, before.call_capacity_reservations);
          assert.equal(after.call_offers.length - before.call_offers.length, inbound ? 1 : 0);
          const slot = after.agent_call_slots.find((s: any) => s.agent_id === f.input.agentId)!;
          assert.equal(slot.state, "reserved");
          assert.equal(slot.call_id, committed.token.callId);
          assert.equal(slot.generation, "2");
          checks.push({
            inbound,
            order,
            rollback,
            winner: slot.call_id,
            operations: 1,
            legs: 0,
            commands: 0
          });
        }
      await db.report("cross-process", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C01.2 READ COMMITTED post-gate revalidation: campaign, pause, controller, binding, user, offer DB deadline and occupancy",
  options,
  async () => {
    const db = await fixture();
    try {
      const client = await db.pool.connect();
      try {
        await rejectReason(
          withCallAdmission(client, {}, async () => true),
          "coordination_unavailable"
        );
      } finally {
        client.release();
      }
      await db.enable();
      const checks = [];
      for (const mutation of ["campaign", "pause", "session", "binding", "user", "deadline", "occupancy"]) {
        const f = await db.seed();
        const call = await f.makeCall(true);
        const offer = (
          await db.pool.query(
            "insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,$2,'inbound',1,$3,1,1,clock_timestamp()+$4::interval) returning id",
            [
              call,
              f.input.agentId,
              f.input.deskSessionId,
              mutation === "deadline" ? "150 milliseconds" : "1 hour"
            ]
          )
        ).rows[0].id;
        const blocker = await db.pool.connect(),
          waiter = await db.pool.connect();
        try {
          await blocker.query("begin");
          await blocker.query("select pg_advisory_xact_lock(72202,0)");
          const waiterPid = (await waiter.query("select pg_backend_pid() as pid")).rows[0].pid,
            blockerPid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
          const pending = withCallAdmission(waiter, f.resources(call), (a) =>
            a.eligibility({ ...f.input, offerId: offer })
          );
          // Attach immediately so timeouts cannot become unhandled rejections.
          const observed = pending.then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          await assertBlocked(db.pool, waiterPid, blockerPid);
          if (mutation === "campaign")
            await blocker.query("update agent_desk_sessions set campaign_id=null where id=$1", [
              f.input.deskSessionId
            ]);
          if (mutation === "pause")
            await blocker.query("update agents set availability_status='paused' where id=$1", [
              f.input.agentId
            ]);
          if (mutation === "session")
            await blocker.query(
              "update agent_desk_sessions set revoked_at=clock_timestamp(),ready=false where id=$1",
              [f.input.deskSessionId]
            );
          if (mutation === "binding")
            await blocker.query("update agent_desk_sessions set ready=false where id=$1", [
              f.input.deskSessionId
            ]);
          if (mutation === "user")
            await blocker.query("update users set is_active=false where id=$1", [f.input.userId]);
          if (mutation === "deadline") {
            // Poll database time until the fixed deadline passes while the waiter
            // is demonstrably blocked. No expiry worker or state mutation assists it.
            while (
              !(
                await blocker.query(
                  "select deadline_at <= clock_timestamp() as expired from call_offers where id=$1",
                  [offer]
                )
              ).rows[0].expired
            ) {
              /* database clock barrier */
            }
          }
          if (mutation === "occupancy")
            await blocker.query(
              "update agent_call_slots set state='reserved',reservation_id=$2,call_id=$3 where agent_id=$1",
              [f.input.agentId, randomUUID(), call]
            );
          await blocker.query("commit");
          const result = await observed;
          if ("error" in result) throw result.error;
          assert.equal(result.value.eligible, false);
          const expected: Record<string, string> = {
            campaign: "revision_conflict",
            pause: "paused",
            session: "not_controller",
            binding: "endpoint_unavailable",
            user: "session_revoked",
            deadline: "offer_expired",
            occupancy: "slot_occupied"
          };
          assert.equal(result.value.reason, expected[mutation]);
          checks.push({ mutation, reason: result.value.reason });
        } finally {
          await blocker.query("rollback");
          blocker.release();
          waiter.release();
        }
      }
      // A deadline already past when the gate is acquired is rejected using DB clock.
      const f = await db.seed(),
        call = await f.makeCall(true);
      const offer = (
        await db.pool.query(
          "insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,created_at,deadline_at) values($1,$2,'inbound',1,$3,1,1,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second') returning id",
          [call, f.input.agentId, f.input.deskSessionId]
        )
      ).rows[0].id;
      const c = await db.pool.connect();
      try {
        assert.equal(
          (
            await withCallAdmission(c, f.resources(call), (a) =>
              a.eligibility({ ...f.input, offerId: offer })
            )
          ).reason,
          "offer_expired"
        );
        assert.deepEqual(
          (await withCallAdmission(c, f.resources(call), (a) => a.eligibility(f.input))).queuedCallIds,
          []
        );
        // E01 admission now persists due expiry before making its decision.
        assert.equal(
          (await c.query("select state from call_offers where id=$1", [offer])).rows[0].state,
          "expired"
        );
        assert.equal(
          (await c.query("select reason from call_offer_exclusions where offer_id=$1", [offer])).rows[0]
            .reason,
          "deadline_elapsed"
        );
        await c.query("update agent_desk_sessions set revision=revision+1 where id=$1", [
          f.input.deskSessionId
        ]);
        assert.deepEqual(
          (
            await withCallAdmission(c, f.resources(call), (a) =>
              a.eligibility({ ...f.input, expectedRevision: "2" })
            )
          ).queuedCallIds,
          []
        );
        const unseen = await f.makeCall(true);
        assert.deepEqual(
          (
            await withCallAdmission(c, f.resources(call), (a) =>
              a.eligibility({ ...f.input, expectedRevision: "2" })
            )
          ).queuedCallIds,
          [unseen]
        );
      } finally {
        c.release();
      }
      await db.report("revalidation", checks);
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C01.3 fenced transition/release retains expired uncertain operations and rejects stale generations",
  options,
  async () => {
    const db = await fixture();
    try {
      await db.enable();
      const f = await db.seed(),
        one = await f.makeCall(),
        two = await f.makeCall();
      const c = await db.pool.connect();
      try {
        let completedContext: CallAdmission | undefined;
        const token = await withCallAdmission(c, f.resources(one, two), (a) => {
          completedContext = a;
          return a.reserve(f.input, one);
        });
        await rejectReason(completedContext!.eligibility(f.input), "transaction_closed");
        const operation = (
          await c.query(
            `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,state,created_at,deadline_at)
        values($1,'C01','uncertain',$2,'originate',2,$3,'uncertain',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour') returning id`,
            [one, "a".repeat(64), randomUUID()]
          )
        ).rows[0].id;
        await withCallAdmission(c, f.resources(one, two), async (a) => {
          assert.equal(await a.transition(token, "uncertain"), true);
          assert.equal(await a.transition(token, "connecting"), false);
          assert.equal(await a.release(token, true), false);
          assert.equal(await a.release(token, false), false);
        });
        await c.query(
          "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='fixture: definitively absent, no live command' where id=$1",
          [operation]
        );
        let newer: SlotToken | undefined;
        await withCallAdmission(c, f.resources(one, two), async (a) => {
          assert.equal(await a.release(token, true), true);
          newer = await a.reserve(f.input, two);
          assert.equal(newer.generation, "3");
        });
        for (const stale of [
          token,
          { ...newer!, reservationId: randomUUID() },
          { ...newer!, generation: "2" },
          { ...newer!, callId: one }
        ])
          await withCallAdmission(c, f.resources(one, two), async (a) => {
            assert.equal(await a.release(stale, true), false);
            assert.equal(await a.transition(stale, "active"), false);
          });
        assert.equal(
          (await c.query("select call_id from agent_call_slots where agent_id=$1", [f.input.agentId])).rows[0]
            .call_id,
          two
        );
        await assert.rejects(
          withCallAdmission(c, f.resources(one, two), async (a) => {
            await a.release(newer!, true);
            throw new Error("rollback");
          }),
          /rollback/
        );
        assert.equal(
          (await c.query("select call_id from agent_call_slots where agent_id=$1", [f.input.agentId])).rows[0]
            .call_id,
          two
        );
        await withCallAdmission(c, f.resources(one, two), async (a) => {
          assert.equal(await a.release(newer!, true), true);
        });
        await c.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [two]);
        await rejectReason(
          withCallAdmission(c, f.resources(one, two), (a) => a.reserve(f.input, two)),
          "call_closed"
        );
        await db.report("fencing", {
          expiredUncertainRetained: true,
          newGeneration: "3",
          staleReleases: 4,
          rollbackRetained: true
        });
      } finally {
        c.release();
      }
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C01.4 ordered audio/media/agent/slot/call locks; changed participant discovery rolls back and retries from rank zero",
  options,
  async () => {
    const db = await fixture();
    try {
      await db.enable();
      const f = await db.seed(),
        target = await db.seed(),
        call = await f.makeCall();
      const a = await db.pool.connect(),
        b = await db.pool.connect();
      try {
        // Emulate a transfer committing after discovery but before this worker's gate.
        await b.query("begin");
        await b.query("select pg_advisory_xact_lock(72202,0)");
        const apid = (await a.query("select pg_backend_pid() as pid")).rows[0].pid;
        const pending = withCallAdmission(a, f.resources(call), async () => {
          throw new Error("must rediscover before callback");
        });
        const observed = pending.then(
          () => null,
          (error) => error
        );
        await assertBlocked(db.pool, apid, (await b.query("select pg_backend_pid() as pid")).rows[0].pid);
        await b.query("insert into call_participants(call_id,role,agent_id) values($1,'agent',$2)", [
          call,
          target.input.agentId
        ]);
        await b.query("commit");
        assert.ok((await observed) instanceof AdmissionDiscoveryChanged);
        const discovered = await discoverAdmissionResources(a, f.resources(call));
        assert.ok(discovered.agentIds.includes(target.input.agentId));
        await withCallAdmission(
          a,
          { ...f.resources(call), audioCampaignIds: [f.input.campaignId] },
          async (admission) => {
            await admission.client.query(
              "insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at) values($1,'C01','retry',$2,'release_agent',1,$3,clock_timestamp()+interval '10 seconds')",
              [call, "a".repeat(64), randomUUID()]
            );
          }
        );
        // Asset-only editor skips admission and never asks for an earlier rank.
        for (const reverse of [false, true]) {
          await b.query("begin");
          if (reverse) await lockUserMediaAction(b, f.input.userId);
          else await lockCampaignVoicemail(b, f.input.campaignId);
          const run = withCallAdmission(
            a,
            { ...f.resources(call), audioCampaignIds: [f.input.campaignId] },
            async () => true
          ).then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          const apid = (a as any).processID;
          const bpid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
          await assertBlocked(db.pool, apid, bpid);
          await b.query("commit");
          const result = await run;
          if ("error" in result) throw result.error;
          assert.equal(result.value, true);
        }
        assert.equal(
          (
            await db.pool.query(
              "select count(*)::int as n from call_operations where idempotency_scope='C01'"
            )
          ).rows[0].n,
          1
        );
        // A migrated supervisor starter and finalizer contend at admission in
        // both orders. User-media is acquired only after admission, then calls/children.
        for (const supervisorFirst of [true, false]) {
          const holder = supervisorFirst ? a : b,
            waiter = supervisorFirst ? b : a;
          let unlock!: () => void, entered!: () => void;
          const held = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          const acquired = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
          const waiterPid = (await waiter.query("select pg_backend_pid() as pid")).rows[0].pid;
          const first = withCallAdmission(
            holder,
            { ...f.resources(call), audioCampaignIds: [f.input.campaignId] },
            async (ctx) => {
              if (supervisorFirst)
                await ctx.client.query(
                  `insert into call_supervisor_sessions(call_id,actor_user_id,mode,state,supervisor_leg_uuid,target_agent_leg_uuid,target_customer_leg_uuid)
              values($1,$2,'listen','connecting',$3,$4,$5)`,
                  [call, f.input.userId, randomUUID(), randomUUID(), randomUUID()]
                );
              else
                await ctx.client.query(
                  "update call_participants set left_at=clock_timestamp() where call_id=$1 and left_at is null",
                  [call]
                );
              entered();
              await held;
            }
          );
          const firstObserved = first.then(
            () => null,
            (error) => error
          );
          await acquired;
          const second = withCallAdmission(
            waiter,
            { ...f.resources(call), audioCampaignIds: [f.input.campaignId] },
            async () => true
          ).then(
            () => null,
            (error) => error
          );
          await assertBlocked(db.pool, waiterPid, holderPid);
          unlock();
          assert.equal(await firstObserved, null);
          // Changed supervisor/participant discovery requires an explicit retry, never a late earlier-rank lock.
          assert.ok((await second) instanceof AdmissionDiscoveryChanged);
          await withCallAdmission(
            waiter,
            { ...f.resources(call), audioCampaignIds: [f.input.campaignId] },
            async () => true
          );
          await db.pool.query(
            "update call_supervisor_sessions set state='ended',ended_at=clock_timestamp() where call_id=$1",
            [call]
          );
          if (supervisorFirst)
            await db.pool.query("update call_participants set left_at=null where call_id=$1", [call]);
        }
        await db.report("lock-order", {
          changedSetRollback: true,
          boundedExplicitRetry: true,
          operations: 1,
          audioAndSupervisorMediaWaits: 2
        });
      } finally {
        await b.query("rollback");
        a.release();
        b.release();
      }
    } finally {
      await db.cleanup();
    }
  }
);

test(
  "C01 bounded gate timeout rolls back; maintenance takes compatible shared lock before admission in both orders",
  options,
  async () => {
    const db = await fixture();
    try {
      await db.enable();
      const f = await db.seed(),
        call = await f.makeCall();
      const a = await db.pool.connect(),
        b = await db.pool.connect();
      try {
        await b.query("begin");
        await b.query("select pg_advisory_xact_lock(72202,0)");
        const failed = withCallAdmission(a, f.resources(call), async () => {
          throw new Error("must not enter");
        });
        await assert.rejects(failed, (e: any) => e.code === "55P03");
        await b.query("rollback");
        assert.equal((await a.query("select txid_current_if_assigned() as tx")).rows[0].tx, null);
        await db.pool.query(
          "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict(key) do update set value_json='false'"
        );
        const apid = (await a.query("select pg_backend_pid() as pid")).rows[0].pid,
          bpid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
        await b.query("begin");
        await b.query("update system_settings set value_json='true' where key='ops.call_start_paused'");
        const blockedStart = withCallAdmission(
          a,
          { ...f.resources(call), startsCall: true },
          async () => true
        ).then(
          () => null,
          (error) => error
        );
        await assertBlocked(db.pool, apid, bpid);
        await b.query("commit");
        assert.equal((await blockedStart).reason, "maintenance");
        await db.pool.query(
          "update system_settings set value_json='false' where key='ops.call_start_paused'"
        );
        let release!: () => void, enter!: () => void;
        const hold = new Promise<void>((resolve) => {
            release = resolve;
          }),
          entered = new Promise<void>((resolve) => {
            enter = resolve;
          });
        const start = withCallAdmission(a, { ...f.resources(call), startsCall: true }, async () => {
          enter();
          await hold;
        });
        const startObserved = start.then(
          () => null,
          (error) => error
        );
        await entered;
        const maintenance = b.query(
          "update system_settings set value_json='true' where key='ops.call_start_paused'"
        );
        await assertBlocked(db.pool, bpid, apid);
        release();
        assert.equal(await startObserved, null);
        await maintenance;
        await rejectReason(
          withCallAdmission(a, { ...f.resources(call), startsCall: true }, async () => true),
          "maintenance"
        );
        await db.report("bounds-maintenance", {
          lockTimeout: "55P03",
          idleAfterRollback: true,
          maintenanceBothOrders: true,
          commands: 0
        });
      } finally {
        await b.query("rollback");
        a.release();
        b.release();
      }
    } finally {
      await db.cleanup();
    }
  }
);
