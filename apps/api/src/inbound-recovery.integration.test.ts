import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import pg from "pg";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import {
  createFixtureLogin,
  databaseConfig,
  testDatabaseUrl
} from "../../../tests/fixtures/inbound/database.mjs";
import { CallExecutor, EXECUTION_LOCK_NAMESPACE, enqueueCallCommand } from "./call-executor.js";
import { persistCoordinatedCallEvent } from "./call-cleanup.js";
import {
  recoverQuiescentCall,
  createLifecycleRecovery,
  RecoveryObservationChanged
} from "./inbound-recovery.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  const role = `h01_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  const database = await createFixtureLogin(
    admin,
    { connectionString: testDatabaseUrl(), options: `-c search_path=${f.schema}` },
    role,
    8
  );
  await f.pool.query(
    `grant usage on schema ${f.schema} to ${role}; grant all on all tables in schema ${f.schema} to ${role}; grant usage,select on all sequences in schema ${f.schema} to ${role}`
  );
  const executor = await CallExecutor.create(database, 0);
  return {
    ...f,
    executor,
    database,
    async cleanup() {
      await executor.close();
      await f.cleanup();
      await admin.query(`drop role ${role}`);
      await admin.end();
    }
  };
}

test(
  "H01.3 live orphan gets one fixed cleanup intent and retains occupancy until concrete absence",
  options,
  async () => {
    const f = await fixture();
    try {
      const c = await f.seed();
      const probe = async (cmd: string) => (cmd.endsWith(c.customerUuid) ? "false" : "true");
      await recoverQuiescentCall(f.pool, f.executor, c.callId, probe, () => true);
      const snap = await f.snapshot();
      const work = snap.call_operations.filter((o: any) => o.request.h01Cleanup);
      assert.equal(work.length, 1);
      assert.equal(work[0].target_uuid, c.agentUuid);
      assert.notEqual(snap.agent_call_slots[0].state, "free");
      await recoverQuiescentCall(f.pool, f.executor, c.callId, probe, () => true);
      assert.equal((await f.snapshot()).call_operations.filter((o: any) => o.request.h01Cleanup).length, 1);
      await f.pool.query(
        "update call_operations set state='succeeded',resolved_at=clock_timestamp(),result='{}',resolution_evidence='simulated fixed cleanup job completion; no FS proof' where id=$1",
        [work[0].id]
      );
      await recoverQuiescentCall(
        f.pool,
        f.executor,
        c.callId,
        async () => "false",
        () => true
      );
      assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
      assert.ok((await f.snapshot()).call_capacity_reservations.every((r: any) => r.state === "released"));
    } finally {
      await f.cleanup();
    }
  }
);

test("H01.2 separate recovery processes serialize concrete observation and replay", options, async () => {
  const f = await fixture();
  let child: ReturnType<typeof fork> | undefined;
  try {
    const s = await f.seed();
    child = fork(new URL("../../../tests/fixtures/inbound/recovery-worker.mjs", import.meta.url), [], {
      env: {
        ...process.env,
        INBOUND_FIXTURE_WORKER_CONFIG: JSON.stringify({ database: f.database, callId: s.callId })
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    const exited = once(child, "exit");
    assert.equal((await once(child, "message"))[0].type, "ready");
    const probing = once(child, "message");
    child.send({ type: "go" });
    assert.equal((await probing)[0].type, "probing");
    assert.deepEqual(
      await recoverQuiescentCall(
        f.pool,
        f.executor,
        s.callId,
        async () => {
          throw new Error("competing process must not observe");
        },
        () => true
      ),
      { status: "deferred", reason: "call_execution_busy" }
    );
    const done = once(child, "message");
    child.send({ type: "resume" });
    const reply = (await done)[0];
    assert.equal(reply.type, "done", JSON.stringify(reply));
    assert.deepEqual(reply.result, { status: "inspected", value: "observed_absence" });
    await exited;
    await recoverQuiescentCall(
      f.pool,
      f.executor,
      s.callId,
      async () => "false",
      () => true
    );
    assert.equal(
      (await f.snapshot()).call_events.filter((e: any) => e.event_type === "lifecycle_recovery_absent")
        .length,
      2
    );
    assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await f.cleanup();
  }
});

test(
  "H01.2 lost execution connection aborts observations without a replacement-session write",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = await f.seed();
      const before = await f.snapshot();
      let pid = 0;
      let abortSignal: AbortSignal;
      const guarded = {
        inspectCall<T>(id: string, work: (db: pg.PoolClient, signal: AbortSignal) => Promise<T>) {
          return f.executor.inspectCall(id, async (db: pg.PoolClient, signal: AbortSignal) => {
            pid = (await db.query("select pg_backend_pid() as pid")).rows[0].pid;
            abortSignal = signal;
            return work(db, signal);
          });
        }
      };
      const result = await recoverQuiescentCall(
        f.pool,
        guarded,
        s.callId,
        async () => {
          const aborted = abortSignal.aborted ? Promise.resolve() : once(abortSignal, "abort");
          await f.pool.query("select pg_terminate_backend($1)", [pid]);
          await aborted;
          return "false";
        },
        () => true
      );
      assert.deepEqual(result, { status: "deferred", reason: "execution_lock_lost" });
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.executor.stats.running, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test("H01.2 manual terminal correction and a newer slot survive repeated old recovery", options, async () => {
  const f = await fixture();
  try {
    const old = await f.seed();
    await f.pool.query(
      "update calls set state='completed',outcome='answered',ended_at=clock_timestamp(),manual_status_locked_at=clock_timestamp() where id=$1",
      [old.callId]
    );
    const terminal = (await f.snapshot()).calls[0];
    await recoverQuiescentCall(
      f.pool,
      f.executor,
      old.callId,
      async () => "false",
      () => true
    );
    assert.deepEqual((await f.snapshot()).calls[0], terminal);
    const newer = await f.seed();
    const slot = (await f.snapshot()).agent_call_slots[0];
    await recoverQuiescentCall(
      f.pool,
      f.executor,
      old.callId,
      async () => {
        throw new Error("ended legs need no fresh absence");
      },
      () => true
    );
    assert.deepEqual((await f.snapshot()).agent_call_slots[0], slot);
    assert.equal(slot.call_id, newer.callId);
    assert.equal((await f.snapshot()).agents[0].status, "in_call");
  } finally {
    await f.cleanup();
  }
});

for (const state of [
  "queued",
  "connecting",
  "agent_connected",
  "fallback",
  "bridged",
  "voicemail_playback_started"
])
  test(
    `H01.1 quiescent ${state}: lost terminal events converge without resetting deadlines or inventing success`,
    options,
    async () => {
      const f = await fixture();
      try {
        const s = await f.seed({ inbound: true });
        await f.pool.query("update calls set state=$2 where id=$1", [s.callId, state]);
        const before = (
          await f.pool.query("select queue_deadline_at,arrived_at,campaign_id from calls where id=$1", [
            s.callId
          ])
        ).rows[0];
        const commands: string[] = [];
        const recover = () =>
          recoverQuiescentCall(
            f.pool,
            f.executor,
            s.callId,
            async (cmd) => {
              commands.push(cmd);
              return "false";
            },
            () => true
          );
        assert.deepEqual(await recover(), { status: "inspected", value: "observed_absence" });
        const snap = await f.snapshot();
        assert.equal(snap.calls[0].state, "failed");
        assert.equal(snap.calls[0].terminal_source, "lifecycle_recovery");
        assert.equal(snap.agent_call_slots[0].state, "free");
        assert.ok(snap.call_capacity_reservations.every((r: any) => r.state === "released"));
        assert.ok(snap.call_legs.every((l: any) => l.ended_at));
        assert.ok(commands.every((cmd) => cmd.startsWith("uuid_exists ")));
        assert.deepEqual(
          (
            await f.pool.query("select queue_deadline_at,arrived_at,campaign_id from calls where id=$1", [
              s.callId
            ])
          ).rows[0],
          before
        );
        assert.equal(
          snap.call_events.filter((e: any) => e.event_type === "lifecycle_recovery_absent").length,
          2
        );
        await recover();
        for (const uuid of [s.customerUuid, s.agentUuid])
          await persistCoordinatedCallEvent(f.pool, {
            callId: s.callId,
            legUuid: uuid,
            eventName: "CHANNEL_ANSWER",
            eventUuid: randomUUID()
          });
        assert.deepEqual(
          (await f.snapshot()).calls,
          snap.calls,
          "late positive events cannot resurrect the call"
        );
        assert.equal(
          (await f.snapshot()).call_events.filter((e: any) => e.event_type === "lifecycle_recovery_absent")
            .length,
          2
        );
      } finally {
        await f.cleanup();
      }
    }
  );

test(
  "H01.2/H01.3 attempted/expired uncertainty retains every permit and never probes absence",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = await f.seed({ unresolved: true });
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [s.operationId]);
      await f.pool.query(
        `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,state,created_at,deadline_at)
        values($1,'h01-expired','old',$2,'originate',1,$3,'uncertain',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,
        [s.callId, "a".repeat(64), randomUUID()]
      );
      const before = await f.snapshot();
      assert.deepEqual(
        await recoverQuiescentCall(
          f.pool,
          f.executor,
          s.callId,
          async () => {
            throw new Error("absence cannot resolve an unknown sender");
          },
          () => true
        ),
        { status: "inspected", value: "uncertain_sender" }
      );
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.executor.stats.waiters, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H01.2 pending recipient absence cannot cancel a live customer; terminal customer cancels only unattempted work",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = await f.seed({ unresolved: true });
      const before = await f.snapshot();
      const probe = (customer: boolean) => async (cmd: string) =>
        cmd.endsWith(s.customerUuid) && customer ? "true" : "false";
      assert.deepEqual(await recoverQuiescentCall(f.pool, f.executor, s.callId, probe(true), () => true), {
        status: "inspected",
        value: "pending_sender"
      });
      assert.deepEqual(await f.snapshot(), before);
      await recoverQuiescentCall(f.pool, f.executor, s.callId, probe(false), () => true);
      assert.equal((await f.snapshot()).call_operations[0].state, "canceled");
      assert.equal((await f.snapshot()).call_execution_attempts.length, 0);
      assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H01.2 new event during probes and unknown native reply produce no partial cleanup",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = await f.seed();
      const before = await f.snapshot();
      await assert.rejects(
        recoverQuiescentCall(
          f.pool,
          f.executor,
          s.callId,
          async () => "-ERR unavailable",
          () => true
        ),
        /Unknown recovery/
      );
      let current = true;
      await assert.rejects(
        recoverQuiescentCall(
          f.pool,
          f.executor,
          s.callId,
          async () => {
            current = false;
            return "false";
          },
          () => current
        ),
        RecoveryObservationChanged
      );
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H01.2 admission committed during probes is revalidated before absence can release",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = await f.seed();
      let admitted = false;
      await recoverQuiescentCall(
        f.pool,
        f.executor,
        s.callId,
        async () => {
          if (!admitted) {
            admitted = true;
            await f.transaction(s.callId, (a: any) =>
              enqueueCallCommand(a, {
                id: randomUUID(),
                callId: s.callId,
                scope: "h01-race",
                key: randomUUID(),
                fingerprint: "c".repeat(64),
                kind: "hangup",
                generation: s.slot.generation,
                commandUuid: randomUUID(),
                targetUuid: s.customerUuid,
                request: {},
                deadline: new Date(Date.now() + 30000)
              })
            );
          }
          return "false";
        },
        () => true
      );
      // The new command cannot send while inspection owns rank 0. Its unattempted
      // intent is canceled with the terminal customer, rather than sent after reuse.
      assert.equal(
        (await f.snapshot()).call_operations.find((o: any) => o.idempotency_scope === "h01-race").state,
        "canceled"
      );
      assert.equal((await f.snapshot()).call_execution_attempts.length, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H01.2 competing execution lock excludes recovery; recovery uses a bounded critical seat",
  options,
  async () => {
    const f = await fixture();
    const holder = await f.pool.connect();
    try {
      const s = await f.seed();
      const key = (
        await holder.query("select lock_key from call_execution_keys where call_id=$1", [s.callId])
      ).rows[0].lock_key;
      await holder.query("select pg_advisory_lock($1,$2)", [EXECUTION_LOCK_NAMESPACE, key]);
      assert.deepEqual(
        await recoverQuiescentCall(
          f.pool,
          f.executor,
          s.callId,
          async () => {
            throw new Error("probe while sender owns lock");
          },
          () => true
        ),
        { status: "deferred", reason: "call_execution_busy" }
      );
      await holder.query("select pg_advisory_unlock($1,$2)", [EXECUTION_LOCK_NAMESPACE, key]);
      await f.executor.inspectCall(s.callId, async (db: pg.PoolClient) => {
        assert.deepEqual(await f.executor.inspectCall(s.callId, async () => true), {
          status: "deferred",
          reason: "executor_saturated"
        });
        const other = (
          await f.pool.query("select state from pg_stat_activity where pid=$1", [
            (await db.query("select pg_backend_pid() as pid")).rows[0].pid
          ])
        ).rows[0];
        assert.equal(other.state, "idle", "ESL observation holds no SQL transaction");
      });
      assert.equal(f.executor.stats.running, 0);
      assert.equal(f.executor.stats.waiters, 0);
    } finally {
      holder.release();
      await f.cleanup();
    }
  }
);

test(
  "H01 orchestrator requires idle subscribed evidence, imports first and rotates past eight stuck calls",
  options,
  async () => {
    const f = await fixture();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 9; i++)
        ids.push(
          (
            await f.pool.query(
              `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
             values($1,'+14155550100','+14155550100','inbound','queued','+14155550100','unknown','+14155550100',(select id from inbound_queues limit 1),clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') returning id`,
              [f.campaignId]
            )
          ).rows[0].id
        );
      const phases: string[] = [];
      const workers = {
        ingress: {
          async reconcile() {
            phases.push("ingress");
          }
        },
        connection: {
          async wakeExecutor() {
            throw new Error("unexpected root");
          }
        },
        transfer: {
          async wakeExecutor() {
            throw new Error("unexpected root");
          }
        },
        control: {
          async wakeExecutor() {
            throw new Error("unexpected root");
          }
        },
        fallback: {
          async tick(id: string) {
            phases.push(id);
          }
        }
      };
      const recovery = createLifecycleRecovery(f.pool, f.executor, workers, async () => {
        throw new Error("no known leg");
      });
      assert.equal(
        (await recovery.reconcile({ async waitForIdle() {}, ticket: () => null })).status,
        "backlog"
      );
      assert.deepEqual(phases, []);
      const barrier = { async waitForIdle() {}, ticket: () => () => true };
      const first = await recovery.reconcile(barrier);
      const second = await recovery.reconcile(barrier);
      assert.equal(first.calls.length, 8);
      assert.equal(second.calls.length, 1);
      assert.ok(
        [...first.calls, ...second.calls].every((c) => !c.error),
        JSON.stringify([first, second])
      );
      assert.equal(new Set([...first.calls, ...second.calls].map((c) => c.callId)).size, 9);
      assert.equal(phases[0], "ingress");
      assert.equal(phases[9], "ingress");
    } finally {
      await f.cleanup();
    }
  }
);
