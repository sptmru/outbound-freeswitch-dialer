import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { assertBlocked, databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import {
  CapacityError,
  defaultCapacityLimits,
  type CapacityKind,
  type CapacityLimits,
  type CapacityRequest
} from "./call-capacity.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
async function fixture() {
  const schema = `c02_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  const children: ReturnType<typeof fork>[] = [];
  const transcript: unknown[] = [];
  const cleanup = async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        const exited = once(c, "exit");
        c.kill("SIGKILL");
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
    await pool.query(
      "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
    );
    await pool.query(
      "create table capacity_command_ledger(operation_id uuid primary key references call_operations(id),reservation_ids uuid[] not null)"
    );
  } catch (e) {
    await cleanup();
    throw e;
  }
  const campaign = (
    await pool.query("insert into campaigns(name,status) values('C02','active') returning id")
  ).rows[0].id;
  const queue = (
    await pool.query(
      "insert into inbound_queues(campaign_id,name,max_waiting_calls) values($1,'C02',200) returning id",
      [campaign]
    )
  ).rows[0].id;
  async function candidate(kind: CapacityKind, queueId = queue): Promise<CapacityRequest> {
    const inbound = kind === "inbound" || kind === "forward";
    const callId = (
      await pool.query(
        inbound
          ? `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+14155550100','+14155550100','inbound','queued','+14155550101','+14155550100','+14155550101',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`
          : "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
        inbound ? [campaign, queueId] : [campaign]
      )
    ).rows[0].id;
    const input: CapacityRequest = { kind, callId, operationId: randomUUID(), generation: "1" };
    if (["browser", "transfer", "supervisor"].includes(kind)) {
      const user = (
        await pool.query(
          "insert into users(email,name,role,password_hash) values($1,'C02','admin','fixture') returning id",
          [`${randomUUID()}@example.test`]
        )
      ).rows[0].id;
      input.agentId = (
        await pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','C02') returning id",
          [user, randomUUID()]
        )
      ).rows[0].id;
      if (kind === "supervisor")
        input.supervisorSessionId = (
          await pool.query(
            `insert into call_supervisor_sessions(call_id,actor_user_id,mode,state,supervisor_leg_uuid,target_agent_leg_uuid,target_customer_leg_uuid)
        values($1,$2,'listen','connecting',$3,$4,$5) returning id`,
            [callId, user, randomUUID(), randomUUID(), randomUUID()]
          )
        ).rows[0].id;
    }
    return input;
  }
  async function gate<T>(inputs: CapacityRequest[], work: (a: CallAdmission) => Promise<T>) {
    const c = await pool.connect();
    try {
      return await withCallAdmission(
        c,
        {
          callIds: inputs.map((i) => i.callId),
          agentIds: inputs.flatMap((i) => (i.agentId ? [i.agentId] : []))
        },
        work
      );
    } finally {
      c.release();
    }
  }
  async function operation(i: CapacityRequest) {
    await pool.query(
      `insert into call_operations(id,call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at)
      values($1,$2,'c02',$1::uuid::text,$3,'originate',$4,$5,clock_timestamp()+interval '10 seconds')`,
      [i.operationId, i.callId, "a".repeat(64), i.generation, randomUUID()]
    );
  }
  async function claim(i: CapacityRequest) {
    await operation(i);
    return gate([i], (a) => a.capacity.claim(i));
  }
  const resolve = (i: CapacityRequest) =>
    pool.query(
      "update call_operations set state='failed',resolution_evidence='fixture confirmed cleanup, no FS',resolved_at=clock_timestamp() where call_id=$1 and resolved_at is null",
      [i.callId]
    );
  const reset = async () => {
    // Test isolation only; runtime cleanup is exercised through full-token release below.
    await pool.query(
      "update call_operations set state='failed',resolution_evidence='fixture teardown',resolved_at=clock_timestamp() where resolved_at is null"
    );
    await pool.query(
      "update call_capacity_reservations set state='released',released_at=clock_timestamp() where state<>'released'"
    );
    await pool.query("update inbound_queues set max_waiting_calls=200 where id=$1", [queue]);
  };
  function worker(i: CapacityRequest) {
    const c = fork(
      new URL("../../../tests/fixtures/inbound/capacity-worker.mjs", import.meta.url),
      [schema, JSON.stringify(i)],
      {
        env: { PATH: process.env.PATH, TEST_DATABASE_URL: testDatabaseUrl() },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );
    children.push(c);
    const messages: any[] = [];
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let output = "";
    c.stdout!.on("data", (d) => (output += d));
    c.stderr!.on("data", (d) => (output += d));
    c.on("message", (m: any) => {
      messages.push(m);
      transcript.push(m);
      wake?.();
    });
    c.on("error", (e) => {
      failure = e;
      wake?.();
    });
    const completion = new Promise<void>((r) =>
      c.on("exit", (code) => {
        if (code) failure = new Error(output || `worker exit ${code}`);
        wake?.();
        r();
      })
    );
    return {
      send: (type: string) => c.send({ type }),
      async wait(type: string) {
        const deadline = Date.now() + 5000;
        while (true) {
          const n = messages.findIndex((m) => m.type === type);
          if (n >= 0) return messages.splice(n, 1)[0];
          if (failure) throw failure;
          assert.ok(Date.now() < deadline, `worker ${type}: ${output}`);
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 50);
            wake = () => {
              clearTimeout(timer);
              r();
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
  async function snapshot() {
    return Object.fromEntries(
      await Promise.all(
        [
          "calls",
          "call_operations",
          "call_capacity_reservations",
          "capacity_command_ledger",
          "agent_call_slots",
          "call_participants",
          "call_legs",
          "call_offers",
          "call_offer_exclusions",
          "call_transfers",
          "contacts",
          "agent_auto_next_intents"
        ].map(async (t) => [t, (await pool.query(`select * from ${t}`)).rows])
      )
    );
  }
  async function report(name: string, checks: unknown) {
    if (!process.env.INBOUND_TEST_ARTIFACTS) return;
    await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
    await writeFile(
      `${process.env.INBOUND_TEST_ARTIFACTS}/c02-${name}-report.json`,
      JSON.stringify(
        {
          status: "passed",
          database: (await pool.query("select version()")).rows[0].version,
          media: "simulated ledger, no ESL/SIP/RTP",
          checks,
          transcript,
          snapshot: await snapshot()
        },
        null,
        2
      ) + "\n"
    );
  }
  return {
    pool,
    candidate,
    gate,
    operation,
    claim,
    resolve,
    reset,
    worker,
    snapshot,
    report,
    cleanup,
    queue,
    campaign
  };
}
const capacityError = (reason: string, resource?: string) => (e: unknown) =>
  e instanceof CapacityError && e.reason === reason && (!resource || e.resource === resource);

test(
  "C02.1 cross-process limit-1/limit/limit+1 for every DB budget; both winners, rollback, replay and atomic losing side effects",
  options,
  async () => {
    const f = await fixture();
    try {
      const checks = [];
      const cases: {
        resource: string;
        key?: keyof CapacityLimits;
        kinds: [CapacityKind, CapacityKind];
        seed: CapacityKind;
      }[] = [
        { resource: "channels", key: "channels", kinds: ["browser", "outbound_customer"], seed: "browser" },
        {
          resource: "trunk",
          key: "trunk",
          kinds: ["inbound", "outbound_customer"],
          seed: "outbound_customer"
        },
        { resource: "forwarding", key: "forwarding", kinds: ["forward", "forward"], seed: "forward" },
        {
          resource: "supervisor",
          key: "supervisor",
          kinds: ["supervisor", "supervisor"],
          seed: "supervisor"
        },
        {
          resource: "transferOverlap",
          key: "transferOverlap",
          kinds: ["transfer", "transfer"],
          seed: "transfer"
        },
        { resource: "queue", key: "queue", kinds: ["inbound", "inbound"], seed: "inbound" },
        { resource: "queue_waiting", kinds: ["inbound", "inbound"], seed: "inbound" }
      ];
      for (const entry of cases)
        for (const [first, rollback] of [
          [0, false],
          [1, false],
          [0, true]
        ] as const) {
          await f.reset();
          await f.gate([], (a) =>
            a.capacity.configure({ ...defaultCapacityLimits, ...(entry.key ? { [entry.key]: 2 } : {}) })
          );
          if (!entry.key)
            await f.pool.query("update inbound_queues set max_waiting_calls=2 where id=$1", [f.queue]);
          const seed = await f.candidate(entry.seed);
          await f.claim(seed);
          const candidates = await Promise.all(entry.kinds.map((k) => f.candidate(k)));
          const before = await f.snapshot();
          const workers = candidates.map((i) => f.worker(i));
          const ready = await Promise.all(workers.map((w) => w.wait("ready")));
          assert.notEqual(ready[0].pid, ready[1].pid);
          assert.notEqual(ready[0].backend, ready[1].backend);
          const one = workers[first]!,
            two = workers[1 - first]!;
          one.send("go");
          await one.wait("claimed");
          two.send("go");
          await assertBlocked(f.pool, ready[1 - first].backend, ready[first].backend);
          assert.deepEqual(
            await f.snapshot(),
            before,
            "no uncommitted operation, claim, or fake send is visible"
          );
          one.send(rollback ? "rollback" : "commit");
          const winner = rollback ? two : one,
            loser = rollback ? one : two;
          if (rollback) {
            assert.equal((await one.wait("rejected")).reason, "fixture_rollback");
            await two.wait("claimed");
            two.send("commit");
          }
          const committed = await winner.wait("committed");
          await winner.wait("sent");
          if (!rollback) {
            const rejection = await loser.wait("rejected");
            assert.equal(rejection.reason, "capacity_exceeded");
            assert.equal(rejection.resource, entry.resource);
          }
          await Promise.all(workers.map((w) => w.finished()));
          const winningInput = candidates[rollback ? 1 - first : first]!;
          const losingInput = candidates[rollback ? first : 1 - first]!;
          const after = await f.snapshot();
          const usage = await f.gate([], (a) => a.capacity.usage());
          const types: Record<string, string[]> = {
            channels: ["customer_channel", "browser_channel", "supervisor_channel"],
            trunk: ["trunk_call"],
            forwarding: ["external_forward"],
            supervisor: ["supervisor_channel"],
            transferOverlap: ["transfer_overlap"],
            queue: ["queue_waiting"],
            queue_waiting: ["queue_waiting"]
          };
          assert.equal(
            usage
              .filter((r) => types[entry.resource]!.includes(r.resource_type))
              .reduce((n, r) => n + Number(r.used), 0),
            2,
            "persisted usage reaches exactly the configured limit"
          );
          assert.equal(after.call_operations.filter((r: any) => r.id === losingInput.operationId).length, 0);
          assert.equal(
            after.call_capacity_reservations.filter((r: any) => r.operation_id === losingInput.operationId)
              .length,
            0
          );
          assert.equal(
            after.capacity_command_ledger.filter((r: any) => r.operation_id === winningInput.operationId)
              .length,
            1
          );
          assert.equal(
            after.capacity_command_ledger.filter((r: any) => r.operation_id === losingInput.operationId)
              .length,
            0
          );
          for (const table of [
            "calls",
            "contacts",
            "call_offers",
            "call_transfers",
            "agent_call_slots",
            "call_participants",
            "call_legs",
            "agent_auto_next_intents"
          ])
            assert.deepEqual(after[table], before[table]);
          const replay = await f.gate([winningInput], (a) => a.capacity.claim(winningInput));
          assert.equal(replay.replayed, true);
          assert.deepEqual(replay.tokens, committed.result.tokens);
          assert.deepEqual(await f.snapshot(), after);
          checks.push({ resource: entry.resource, first, rollback, ready, usage, tokens: replay.tokens });
        }
      await f.report("limits", checks);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "C02.2 connecting return permits, queue isolation, post-wait lower limits preserve admitted work and VM retains customer/trunk",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.gate([], (a) => a.capacity.configure({ ...defaultCapacityLimits, queue: 3 }));
      await f.pool.query("update inbound_queues set max_waiting_calls=2 where id=$1", [f.queue]);
      const original = await f.candidate("inbound");
      const first = await f.claim(original);
      await f.pool.query("update calls set state='connecting' where id=$1", [original.callId]);
      await f.gate([original], async (a) => {
        for (const t of first.tokens) assert.equal(await a.capacity.transition(t, "in_use"), true);
      });
      const second = await f.candidate("inbound");
      await f.claim(second);
      const full = await f.candidate("inbound");
      await f.operation(full);
      await assert.rejects(
        f.gate([full], (a) => a.capacity.claim(full)),
        capacityError("capacity_exceeded", "queue_waiting")
      );
      await f.resolve(original); // Simulated failed connection cleanup, preserving its return permit.
      await f.pool.query("update calls set state='queued' where id=$1", [original.callId]);
      assert.deepEqual((await f.gate([original], (a) => a.capacity.claim(original))).tokens, first.tokens);
      const otherQueue = (
        await f.pool.query("insert into inbound_queues(campaign_id,name) values($1,'other') returning id", [
          f.campaign
        ])
      ).rows[0].id;
      const other = await f.candidate("inbound", otherQueue);
      await f.claim(other);
      const globalFull = await f.candidate("inbound", otherQueue);
      await f.operation(globalFull);
      await assert.rejects(
        f.gate([globalFull], (a) => a.capacity.claim(globalFull)),
        capacityError("capacity_exceeded", "queue")
      );
      const candidate = await f.candidate("outbound_customer");
      const waiter = f.worker(candidate);
      const ready = await waiter.wait("ready");
      const c = await f.pool.connect();
      try {
        await withCallAdmission(c, {}, async (a) => {
          await a.capacity.configure({ ...defaultCapacityLimits, queue: 1, channels: 1, trunk: 1 });
          waiter.send("go");
          await assertBlocked(
            f.pool,
            ready.backend,
            (await c.query("select pg_backend_pid() as pid")).rows[0].pid
          );
        });
      } finally {
        c.release();
      }
      assert.equal((await waiter.wait("rejected")).resource, "channels");
      await waiter.finished();
      assert.equal((await f.gate([original], (a) => a.capacity.claim(original))).replayed, true);
      const retained = (
        await f.pool.query("select * from call_capacity_reservations where state<>'released'")
      ).rows;
      assert.equal(retained.length, 9, "lowering limits evicts no admitted claim");
      // Released outbound voicemail frees browser only, not its still-live customer/trunk.
      await f.reset();
      await f.gate([], (a) => a.capacity.configure({ ...defaultCapacityLimits, channels: 2, trunk: 1 }));
      const vm = await f.candidate("outbound_customer");
      const customer = await f.claim(vm);
      const browser = {
        ...vm,
        kind: "browser" as const,
        operationId: randomUUID(),
        agentId: (await f.candidate("browser")).agentId
      };
      const br = await f.claim(browser);
      await f.resolve(vm);
      await f.gate([browser], (a) => a.capacity.release(br.tokens[0]!, true));
      await f.pool.query(
        "update calls set state='agent_released',agent_released_at=clock_timestamp() where id=$1",
        [vm.callId]
      );
      const next = await f.candidate("outbound_customer");
      await f.operation(next);
      await assert.rejects(
        f.gate([next], (a) => a.capacity.claim(next)),
        capacityError("capacity_exceeded", "trunk")
      );
      assert.equal(
        (
          await f.pool.query(
            "select 1 from call_capacity_reservations where id=any($1::uuid[]) and state<>'released'",
            [customer.tokens.map((t) => t.id)]
          )
        ).rowCount,
        2
      );
      await f.report("requeue-lowering-vm", { retained, customer, browser: br });
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "C02.3 lost ACK and late commands retain all budgets; token cleanup/replay never releases a newer generation; rollback and eventual baseline",
  options,
  async () => {
    const f = await fixture();
    try {
      const input = await f.candidate("forward");
      input.generation = "9007199254740993";
      const result = await f.claim(input);
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [input.operationId]);
      await f.gate([input], async (a) => {
        for (const t of result.tokens) {
          assert.equal(await a.capacity.transition(t, "uncertain"), true);
          assert.equal(await a.capacity.release(t, true), false);
          assert.equal(await a.capacity.transition(t, "in_use"), false);
        }
      });
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [input.operationId]);
      assert.equal((await f.gate([input], (a) => a.capacity.claim(input))).replayed, true);
      await f.resolve(input);
      await f.gate([input], async (a) => {
        for (const t of result.tokens) {
          assert.equal(await a.capacity.release(t, false), false);
          assert.equal(await a.capacity.release({ ...t, generation: "1" }, true), false);
        }
      });
      const c = await f.pool.connect();
      try {
        await assert.rejects(
          withCallAdmission(c, { callIds: [input.callId] }, async (a) => {
            assert.equal(await a.capacity.release(result.tokens[0]!, true), true);
            throw new Error("rollback_cleanup");
          }),
          /rollback_cleanup/
        );
      } finally {
        c.release();
      }
      assert.equal(
        (
          await f.pool.query(
            "select 1 from call_capacity_reservations where operation_id=$1 and state<>'released'",
            [input.operationId]
          )
        ).rowCount,
        3
      );
      const newer = { ...input, operationId: randomUUID(), generation: "9007199254740994" };
      await f.claim(newer);
      await f.resolve(newer);
      await f.gate([input], async (a) => {
        for (const t of result.tokens) {
          assert.equal(await a.capacity.release(t, true), true);
          assert.equal(await a.capacity.release(t, true), false);
          assert.equal(await a.capacity.transition(t, "in_use"), false);
        }
      });
      assert.equal(
        (
          await f.pool.query(
            "select 1 from call_capacity_reservations where operation_id=$1 and state<>'released'",
            [newer.operationId]
          )
        ).rowCount,
        3
      );
      const replay = await f.gate([input], (a) => a.capacity.claim(input));
      assert.equal(replay.usable, false);
      await assert.rejects(
        f.gate([input], (a) => a.capacity.claim({ ...input, kind: "outbound_customer" })),
        capacityError("direction_mismatch")
      );
      await assert.rejects(
        f.gate([input], (a) => a.capacity.claim({ ...input, kind: "inbound" })),
        capacityError("capacity_replay_conflict")
      );
      await assert.rejects(
        f.gate([input], (a) => a.capacity.claim({ ...input, generation: "2" })),
        capacityError("operation_mismatch")
      );
      const nextTokens = (await f.gate([newer], (a) => a.capacity.claim(newer))).tokens;
      await f.gate([newer], async (a) => {
        for (const t of nextTokens) assert.equal(await a.capacity.release(t, true), true);
      });
      assert.deepEqual(await f.gate([], (a) => a.capacity.usage()), []);
      let closed: CallAdmission | undefined;
      await f.gate([], async (a) => {
        closed = a;
      });
      await assert.rejects(closed!.capacity.limits(), /transaction_closed/);
      await f.report("cleanup-replay", { result, replay, nextTokens });
    } finally {
      await f.cleanup();
    }
  }
);
