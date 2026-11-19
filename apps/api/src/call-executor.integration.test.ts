import assert from "node:assert/strict";
import { __testing as metrics } from "./metrics.js";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { withCallAdmission } from "./call-admission.js";
import { CallExecutor, enqueueCallCommand, type CommandIntent, type CommandDriver } from "./call-executor.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture() {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `c03_${suffix}`,
    role = `exec_${suffix}`;
  const roles = [role];
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 8 });
  const children: ReturnType<typeof fork>[] = [];
  const executors: CallExecutor[] = [];
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  await admin.query(`create role ${role} login connection limit 8`);
  await pool.query(
    `grant usage on schema ${schema} to ${role};grant all on all tables in schema ${schema} to ${role};grant usage,select on all sequences in schema ${schema} to ${role}`
  );
  await pool.query(`create table executor_persistence(operation_id uuid,pid integer,state text);
    create function capture_executor_persistence() returns trigger language plpgsql as $$ begin
    insert into executor_persistence values(new.id,pg_backend_pid(),new.state);return new;end $$;
    create trigger executor_persistence after update on call_operations for each row execute function capture_executor_persistence()`);
  await pool.query(`grant all on executor_persistence to ${role}`);
  const campaign = (
    await pool.query("insert into campaigns(name,status) values('C03','active') returning id")
  ).rows[0].id;
  const database = {
    ...databaseConfig(testDatabaseUrl(), schema),
    connectionString: undefined,
    ...(() => {
      const url = new URL(testDatabaseUrl());
      return {
        host: url.searchParams.get("host") ?? url.hostname,
        port: Number(url.port || 5432),
        database: url.pathname.slice(1),
        user: role
      };
    })()
  };
  async function executor(replica = 0) {
    const e = await CallExecutor.create(database, replica);
    executors.push(e);
    return e;
  }
  async function intent(kind: CommandIntent["kind"] = "originate"): Promise<CommandIntent> {
    const callId = (
      await pool.query(
        "insert into calls(campaign_id,destination_number,normalized_destination_number) values($1,'+14155550100','+14155550100') returning id",
        [campaign]
      )
    ).rows[0].id;
    return {
      id: randomUUID(),
      callId,
      scope: "c03",
      key: randomUUID(),
      fingerprint: "c".repeat(64),
      kind,
      generation: "9007199254740993",
      commandUuid: randomUUID(),
      targetUuid: randomUUID(),
      request: { fixture: true },
      deadline: new Date(Date.now() + 60000)
    };
  }
  async function enqueue(i: CommandIntent) {
    const c = await pool.connect();
    try {
      return await withCallAdmission(c, { callIds: [i.callId] }, (a) => enqueueCallCommand(a, i));
    } finally {
      c.release();
    }
  }
  function worker(config: Record<string, unknown>) {
    const child = fork(
      new URL(
        config.load
          ? "../../../tests/fixtures/inbound/executor-load-worker.mjs"
          : "../../../tests/fixtures/inbound/executor-worker.mjs",
        import.meta.url
      ),
      [JSON.stringify({ database, ...config })],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    );
    children.push(child);
    const events: any[] = [];
    let wake: (() => void) | undefined;
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("message", (m) => {
      events.push(m);
      wake?.();
    });
    const finished = once(child, "exit");
    return {
      child,
      finished,
      send: (type: string) => child.send({ type }),
      async wait(type: string) {
        const deadline = Date.now() + 8000;
        while (true) {
          const failure = events.find((e) => e.type === "failure");
          if (failure && type !== "failure") throw new Error(JSON.stringify(failure));
          const at = events.findIndex((e) => e.type === type);
          if (at >= 0) return events.splice(at, 1)[0];
          assert.ok(Date.now() < deadline, `checkpoint ${type}: ${output} ${JSON.stringify(events)}`);
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 20);
            wake = () => {
              clearTimeout(timer);
              r();
            };
          });
          wake = undefined;
        }
      }
    };
  }
  async function snapshot() {
    return Object.fromEntries(
      await Promise.all(
        [
          "calls",
          "call_operations",
          "call_execution_keys",
          "call_execution_attempts",
          "call_capacity_reservations",
          "agent_call_slots",
          "call_participants",
          "call_offers",
          "contacts"
        ].map(async (t) => [t, (await pool.query(`select * from ${t}`)).rows])
      )
    );
  }
  async function report(name: string, evidence: unknown) {
    if (!process.env.INBOUND_TEST_ARTIFACTS) return;
    await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
    await writeFile(
      `${process.env.INBOUND_TEST_ARTIFACTS}/c03-${name}.json`,
      JSON.stringify(
        {
          database: (await pool.query("select version()")).rows[0].version,
          media: "simulated, no FS/provider",
          evidence,
          snapshot: await snapshot()
        },
        null,
        2
      ) + "\n"
    );
  }
  return {
    pool,
    admin,
    database,
    role,
    schema,
    executor,
    intent,
    enqueue,
    worker,
    snapshot,
    report,
    async controlConfigs() {
      const configs: Record<string, typeof database> = {};
      for (const [lane, cap] of Object.entries({ admission: 8, heartbeat: 2, events: 4, recovery: 2 })) {
        const name = `${role}_${lane}`;
        roles.push(name);
        await admin.query(`create role ${name} login connection limit ${cap}`);
        await pool.query(
          `grant usage on schema ${schema} to ${name};grant all on all tables in schema ${schema} to ${name};grant usage,select on all sequences in schema ${schema} to ${name}`
        );
        configs[lane] = { ...database, user: name };
      }
      return configs;
    },
    async cleanup() {
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null) {
          const exited = once(c, "exit");
          c.kill("SIGCONT");
          c.kill("SIGKILL");
          await exited;
        }
      await Promise.all(executors.map((e) => e.close()));
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      for (const name of roles) await admin.query(`drop role ${name}`);
      await admin.end();
    }
  };
}
const noSend: CommandDriver = {
  send: async () => {
    throw new Error("unexpected resend");
  },
  reconcile: async () => null
};
test(
  "C03 unstarted deadline, ended call and SQL token revalidation cancel without send; unsafe executor role rejected",
  options,
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        CallExecutor.create({ ...f.database, user: "postgres" }, 0),
        /executor_role_requires_connection_limit/
      );
      const e = await f.executor();
      const expired = await f.intent();
      expired.deadline = new Date(Date.now() + 200);
      await f.enqueue(expired);
      await f.pool.query(
        "select pg_sleep(greatest(0,extract(epoch from (deadline_at-clock_timestamp()))+.01)) from call_operations where id=$1",
        [expired.id]
      );
      const closed = await f.intent();
      await f.enqueue(closed);
      await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
        closed.callId
      ]);
      const invalid = await f.intent();
      await f.enqueue(invalid);
      for (const i of [expired, closed, invalid]) {
        const r = await e.run(i.id, "normal", {
          ...noSend,
          validate: async (_op, a) => {
            assert.ok(
              (await a.client.query("select xact_start from pg_stat_activity where pid=pg_backend_pid()"))
                .rows[0].xact_start
            );
            return false;
          }
        });
        assert.equal(r.status, "terminal");
        if (r.status === "terminal") assert.equal(r.operation.state, "canceled");
      }
      assert.equal((await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n, 0);
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "C03.3 two worker and two control processes: 24 partitioned connections, eight held executors and 960 protected writes",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query(
        "create table c03_control_ledger(replica integer,lane text,sequence integer,primary key(replica,lane,sequence))"
      );
      const configs = await f.controlConfigs();
      const desks: string[] = [];
      for (let replica = 0; replica < 2; replica++) {
        const user = (
          await f.pool.query(
            "insert into users(email,name,role,password_hash) values($1,'C03 load','agent','fixture') returning id",
            [`${randomUUID()}@example.test`]
          )
        ).rows[0].id;
        const agent = (
          await f.pool.query(
            "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','C03 load') returning id",
            [user, randomUUID()]
          )
        ).rows[0].id;
        desks.push(
          (
            await f.pool.query(
              "insert into agent_desk_sessions(agent_id,binding_generation,sip_username,expires_at) values($1,1,$2,clock_timestamp()+interval '20 seconds') returning id",
              [agent, randomUUID()]
            )
          ).rows[0].id
        );
      }
      const calls: string[] = [];
      const operations: string[][] = [];
      for (let replica = 0; replica < 2; replica++) {
        const batch = [];
        for (let n = 0; n < 4; n++) {
          const i = await f.intent(n === 3 ? "hangup" : "originate");
          await f.enqueue(i);
          batch.push(i.id);
          calls.push(i.callId);
        }
        operations.push(batch);
      }
      const controls = [0, 1].map((replica) =>
        f.worker({
          load: true,
          pools: configs,
          executorUser: f.role,
          replica,
          deskId: desks[replica],
          callId: calls[replica * 4]
        })
      );
      const ready = await Promise.all(controls.map((w) => w.wait("ready")));
      const workers = [0, 1].map((replica) =>
        f.worker({ load: true, operations: operations[replica], replica })
      );
      const holding = await Promise.all(workers.map((w) => w.wait("holding")));
      assert.equal(new Set([...ready, ...holding].map((r) => r.pid)).size, 4);
      const held = (
        await f.pool.query(
          "select a.backend_pid,p.xact_start,p.state from call_execution_attempts a join pg_stat_activity p on p.pid=a.backend_pid"
        )
      ).rows;
      assert.equal(held.length, 8);
      for (const row of held) {
        assert.equal(row.xact_start, null);
        assert.equal(row.state, "idle");
      }
      for (const w of controls) w.send("start");
      const results = await Promise.all(controls.map((w) => w.wait("done")));
      const percentiles = [];
      for (let replica = 0; replica < 2; replica++)
        for (const [lane, raw] of Object.entries(results[replica].samples)) {
          const values = (raw as number[]).slice().sort((a, b) => a - b);
          assert.equal(values.length, 120);
          const p95 = values[Math.ceil(values.length * 0.95) - 1],
            p99 = values[Math.ceil(values.length * 0.99) - 1];
          assert.ok(p95 <= 100, `${lane} p95 ${p95}`);
          assert.ok(p99 <= 250, `${lane} p99 ${p99}`);
          assert.equal(results[replica].stats[lane].waiters, 0);
          percentiles.push({ replica, lane, p95, p99 });
        }
      assert.equal((await f.pool.query("select count(*)::int n from c03_control_ledger")).rows[0].n, 960);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_operations where state='uncertain'")).rows[0].n,
        8,
        "commands still held throughout control measurements"
      );
      for (const w of workers) w.send("complete");
      const completed = await Promise.all(workers.map((w) => w.wait("done")));
      for (const r of completed) {
        assert.equal(r.results.length, 4);
        assert.ok(r.results.every((s: any) => s.status === "terminal"));
        assert.equal(r.stats.running, 0);
        assert.equal(r.stats.waiters, 0);
      }
      await Promise.all([...controls, ...workers].map((w) => w.finished));
      const persisted = (
        await f.pool.query(
          "select a.backend_pid,l.pid from executor_persistence l join call_execution_attempts a using(operation_id)"
        )
      ).rows;
      for (const row of persisted) assert.equal(row.pid, row.backend_pid);
      await f.report("process-load", { ready, holding, held, percentiles, results, completed, persisted });
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "C03.1 admission enqueue has one fixed identity: both process commit orders, rollback, conflict and bounded partitions",
  options,
  async () => {
    const f = await fixture();
    try {
      for (const [first, rollback] of [
        [0, false],
        [1, false],
        [0, true]
      ] as const) {
        const i = await f.intent();
        const workers = [0, 1].map(() =>
          f.worker({ enqueue: i, database: { ...f.database, user: "postgres" } })
        );
        const ready = await Promise.all(workers.map((w) => w.wait("ready")));
        workers[first].send("go");
        await workers[first].wait("enqueued");
        workers[1 - first].send("go");
        await assertBlocked(f.pool, ready[1 - first].backend, ready[first].backend);
        assert.equal((await f.pool.query("select 1 from call_operations where id=$1", [i.id])).rowCount, 0);
        workers[first].send(rollback ? "rollback" : "commit");
        if (rollback) assert.equal((await workers[first].wait("failure")).message, "fixture_rollback");
        else await workers[first].wait("done");
        const second = await workers[1 - first].wait("enqueued");
        assert.equal(second.result.replayed, !rollback);
        workers[1 - first].send("commit");
        await workers[1 - first].wait("done");
        await Promise.all(workers.map((w) => w.finished));
        const replay = await f.enqueue({ ...i, id: randomUUID(), commandUuid: randomUUID() });
        assert.equal(replay.operation.id, i.id);
        assert.equal(replay.operation.command_uuid, i.commandUuid);
        await assert.rejects(f.enqueue({ ...i, fingerprint: "d".repeat(64) }), /idempotency_conflict/);
      }
      // All normal/critical partitions share the one database counter across replicas.
      const normal = Number(
        (await f.pool.query("select count(*) from call_operations where state='pending'")).rows[0].count
      );
      for (let n = normal; n < 48; n++) await f.enqueue(await f.intent());
      const refused = await f.intent();
      await assert.rejects(f.enqueue(refused), /execution_backlog_full/);
      assert.equal(
        (await f.pool.query("select 1 from call_execution_keys where call_id=$1", [refused.callId])).rowCount,
        0
      );
      for (let n = 0; n < 16; n++) await f.enqueue(await f.intent("hangup"));
      await assert.rejects(f.enqueue(await f.intent("hangup")), /execution_backlog_full/);
      assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 64);
      await f.report("enqueue", { normal: 48, critical: 16, commitOrders: 2, rollback: true });
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "C03.1/C03.2 same-call serialization, lost lock, resume, no blind replay; uncertainty retains capacity",
  options,
  async () => {
    const f = await fixture();
    try {
      const i = await f.intent();
      await f.enqueue(i);
      const c = await f.pool.connect();
      let tokens;
      try {
        tokens = await withCallAdmission(c, { callIds: [i.callId] }, (a) =>
          a.capacity.claim({
            callId: i.callId,
            operationId: i.id,
            generation: i.generation,
            kind: "outbound_customer"
          })
        );
      } finally {
        c.release();
      }
      const w = f.worker({ operationId: i.id, replica: 0 });
      await w.wait("ready");
      w.send("go");
      await w.wait("sending");
      const attempt = (
        await f.pool.query("select * from call_execution_attempts where operation_id=$1", [i.id])
      ).rows[0];
      const activity = (
        await f.pool.query("select state,xact_start from pg_stat_activity where pid=$1", [
          attempt.backend_pid
        ])
      ).rows[0];
      assert.equal(activity.xact_start, null);
      assert.equal(activity.state, "idle");
      const other = await f.executor(1);
      assert.deepEqual(await other.run(i.id, "normal", noSend), {
        status: "deferred",
        reason: "call_execution_busy"
      });
      w.child.kill("SIGSTOP");
      const stopDeadline = Date.now() + 3000;
      while (!/^State:\s+T/m.test(await readFile(`/proc/${w.child.pid}/status`, "utf8")))
        assert.ok(Date.now() < stopDeadline);
      assert.equal(
        (await f.pool.query("select pg_terminate_backend($1) as ok", [attempt.backend_pid])).rows[0].ok,
        true
      );
      // Server termination completes before replacement; take the same rank-0 lock.
      let result;
      const until = Date.now() + 3000;
      do {
        result = await other.run(i.id, "normal", noSend);
        assert.ok(Date.now() < until);
      } while (result.status === "deferred");
      assert.equal(result.status, "uncertain");
      const next = {
        ...i,
        id: randomUUID(),
        key: randomUUID(),
        commandUuid: randomUUID(),
        kind: "hangup" as const
      };
      await f.enqueue(next);
      assert.deepEqual(await other.run(next.id, "critical", noSend), {
        status: "deferred",
        reason: "call_outcome_uncertain"
      });
      const release = await f.pool.connect();
      try {
        assert.equal(
          await withCallAdmission(release, { callIds: [i.callId] }, (a) =>
            a.capacity.release(tokens!.tokens[0]!, true)
          ),
          false
        );
      } finally {
        release.release();
      }
      w.child.kill("SIGCONT");
      w.send("complete");
      await w.wait("done");
      await w.finished;
      assert.equal(
        (await f.pool.query("select state from call_operations where id=$1", [i.id])).rows[0].state,
        "uncertain"
      );
      // Trusted fixture coordinator has reaped sender and accounts for zero physical sends.
      const resolved = await other.run(i.id, "critical", {
        ...noSend,
        reconcile: async () => ({
          state: "failed",
          result: { sent: 0 },
          evidence: "simulated coordinator: sender reaped, no transport sends"
        })
      });
      assert.equal(resolved.status, "terminal");
      assert.equal(
        (
          await f.pool.query("select count(*)::int n from call_execution_attempts where operation_id=$1", [
            i.id
          ])
        ).rows[0].n,
        1
      );
      await f.report("lock-loss", { attempt, activity, replacement: result, resolved });
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "C03.3/C03.4/H05.2 bounded replicas, critical reserve, SQL progress, same-session persistence, deadline and backlog drain",
  options,
  async () => {
    const f = await fixture();
    try {
      const executors = await Promise.all([f.executor(0), f.executor(1)]);
      const starts = Array.from({ length: 8 }, () => deferred<void>()),
        finishes = Array.from({ length: 8 }, () => deferred<void>());
      const work = [];
      const inputs = [];
      for (let n = 0; n < 8; n++) {
        const i = await f.intent(n % 4 === 3 ? "hangup" : "originate");
        await f.enqueue(i);
        inputs.push(i);
        work.push(
          executors[Math.floor(n / 4)].run(i.id, n % 4 === 3 ? "critical" : "normal", {
            send: async () => {
              starts[n].resolve();
              await finishes[n].promise;
              return { state: "succeeded", result: { simulated: true }, evidence: "simulated completion" };
            },
            reconcile: noSend.reconcile
          })
        );
      }
      await Promise.all(starts.map((s) => s.promise));
      const states = (
        await f.pool.query(
          "select a.backend_pid,p.xact_start,p.state from call_execution_attempts a join pg_stat_activity p on p.pid=a.backend_pid"
        )
      ).rows;
      assert.equal(states.length, 8);
      for (const s of states) {
        assert.equal(s.xact_start, null);
        assert.equal(s.state, "idle");
      }
      const ninth = await f.intent();
      await f.enqueue(ninth);
      for (const e of executors) {
        assert.deepEqual(await e.run(ninth.id, "normal", noSend), {
          status: "deferred",
          reason: "executor_saturated"
        });
        assert.equal(e.stats.waiters, 0);
      }
      assert.equal(await metrics.refreshDatabaseMetrics(f.pool, 900), true);
      const scrape = await metrics.metrics();
      assert.match(scrape, /executor_local\{state="running"\} 8/);
      assert.match(scrape, /executor_local\{state="waiters"\} 0/);
      assert.ok(
        Number(scrape.match(/executor_pool_acquisition_seconds_count\{outcome="acquired"\} (\d+)/)?.[1]) >= 8
      );
      assert.ok(
        Number(scrape.match(/executor_pressure_total\{reason="executor_saturated"\} (\d+)/)?.[1]) >= 2
      );
      assert.match(scrape, /executor_pending_operations\{priority="normal"\} 1/);
      assert.match(scrape, /call_uncertain\{record="operation"\} 8/);
      // Dedicated login hard limit, not merely a local max:4 setting.
      const extra = new pg.Client(f.database);
      extra.on("error", () => {});
      await assert.rejects(extra.connect(), { code: "53300" });
      await extra.end();
      const samples: number[] = [];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let n = 0; n < 30; n++) {
            const begin = performance.now();
            const c = await f.pool.connect();
            try {
              await withCallAdmission(c, {}, async (a) => {
                await a.client.query("select 1");
              });
            } finally {
              c.release();
            }
            samples.push(performance.now() - begin);
          }
        })
      );
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1],
        p99 = samples[Math.ceil(samples.length * 0.99) - 1];
      assert.ok(p95 <= 100, `p95 ${p95}`);
      assert.ok(p99 <= 250, `p99 ${p99}`);
      for (const done of finishes) done.resolve();
      assert.ok((await Promise.all(work)).every((r) => r.status === "terminal"));
      const persistence = (await f.pool.query("select * from executor_persistence")).rows;
      for (const row of persistence)
        assert.equal(
          row.pid,
          (
            await f.pool.query("select backend_pid from call_execution_attempts where operation_id=$1", [
              row.operation_id
            ])
          ).rows[0].backend_pid
        );
      let sends = 0;
      const driver: CommandDriver = {
        send: async () => {
          sends++;
          return { state: "succeeded", result: { simulated: true }, evidence: "simulated drain" };
        },
        reconcile: noSend.reconcile
      };
      assert.equal((await executors[0].run(ninth.id, "normal", driver)).status, "terminal");
      assert.equal((await executors[1].run(ninth.id, "normal", driver)).status, "terminal");
      assert.equal(sends, 1);
      const timeout = await f.intent();
      timeout.deadline = new Date(Date.now() + 1000);
      await f.enqueue(timeout);
      const expired = await executors[0].run(timeout.id, "normal", {
        send: async (_o, signal) => {
          await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
          return null;
        },
        reconcile: noSend.reconcile
      });
      assert.equal(expired.status, "uncertain");
      assert.equal((await executors[1].run(timeout.id, "normal", noSend)).status, "uncertain");
      for (const e of executors) {
        assert.equal(e.stats.running, 0);
        assert.equal(e.stats.waiters, 0);
      }
      await f.report("saturation", {
        states,
        p95,
        p99,
        samples,
        persistence,
        timeout: expired,
        stats: executors.map((e) => e.stats)
      });
    } finally {
      await f.cleanup();
    }
  }
);
