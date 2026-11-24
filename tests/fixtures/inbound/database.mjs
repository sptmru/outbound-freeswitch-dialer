import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { assertLedger, checkpoints } from "./controls.mjs";

export function testDatabaseUrl(env = process.env) {
  const value = env.TEST_DATABASE_URL;
  assert.ok(value, "TEST_DATABASE_URL is required; no DATABASE_URL fallback (use test:inbound:db:isolated)");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid TEST_DATABASE_URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "Expected PostgreSQL test URL");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Test DB must be loopback");
  assert.match(
    url.pathname,
    /^\/(?:test|test_[a-z0-9_]+|[a-z0-9_]+_test)$/,
    "Expected explicit test database name"
  );
  for (const key of url.searchParams.keys()) assert.equal(key, "host", "Unsupported test DB URL option");
  assert.ok(url.searchParams.getAll("host").length <= 1, "Duplicate test DB host option");
  const host = url.searchParams.get("host");
  if (host)
    assert.match(
      host,
      /^\/tmp\/outbound-inbound-db\.[A-Za-z0-9]+\/socket$/,
      "Only isolated runner socket allowed"
    );
  if (env.DATABASE_URL) {
    // Refuse aliases that designate the same configured application DB, not just identical strings.
    const app = new URL(env.DATABASE_URL);
    const canonicalHost = (u) =>
      u.searchParams.get("host") ?? (u.hostname === "localhost" ? "127.0.0.1" : u.hostname);
    assert.ok(
      canonicalHost(app) !== canonicalHost(url) ||
        (app.port || "5432") !== (url.port || "5432") ||
        app.pathname !== url.pathname,
      "TEST_DATABASE_URL must not designate DATABASE_URL"
    );
  }
  return value;
}

export function databaseConfig(value, schema) {
  return {
    connectionString: value,
    max: 3,
    connectionTimeoutMillis: 2000,
    query_timeout: 8000,
    options: `-c statement_timeout=7000 -c lock_timeout=6000${schema ? ` -c search_path=${schema}` : ""}`
  };
}

export async function createFixtureLogin(admin, config, role, connectionLimit) {
  const password = randomBytes(24).toString("hex");
  assert.ok(Number.isSafeInteger(connectionLimit) && connectionLimit > 0);
  await admin.query(
    `create role ${pg.escapeIdentifier(role)} login password ${pg.escapeLiteral(password)} connection limit ${connectionLimit}`
  );
  if (config.connectionString) {
    const url = new URL(config.connectionString);
    url.username = role;
    url.password = password;
    return { ...config, connectionString: url.href };
  }
  return { ...config, user: role, password };
}

export async function prepareInboundArtifacts(env = process.env) {
  if (env.INBOUND_TEST_ARTIFACTS) await mkdir(env.INBOUND_TEST_ARTIFACTS, { recursive: true });
}

export async function createDatabaseFixture(env = process.env) {
  const value = testDatabaseUrl(env);
  const schema = `inbound_fixture_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Pool(databaseConfig(value));
  const pool = new pg.Pool(databaseConfig(value, schema));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE claims(resource text PRIMARY KEY, operation text UNIQUE NOT NULL);
      CREATE TABLE work(operation text PRIMARY KEY, state text NOT NULL);
      CREATE TABLE ledger(sequence bigint GENERATED ALWAYS AS IDENTITY, operation text NOT NULL, stage text NOT NULL);
    `);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
    throw error;
  }
  const children = [];
  const transcript = [];
  function worker(operation) {
    const child = fork(new URL("worker.mjs", import.meta.url), [schema, operation], {
      env: { PATH: process.env.PATH, TEST_DATABASE_URL: value },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.push(child);
    const completed = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    const messages = [];
    let failure;
    let output = "";
    let waiter;
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      failure = error;
      waiter?.();
    });
    child.on("exit", (code, signal) => {
      failure ??= new Error(`Worker ${operation} exited (${code ?? signal}): ${output}`);
      waiter?.();
    });
    child.on("message", (message) => {
      transcript.push({ operation, ...message });
      messages.push(message);
      waiter?.();
    });
    return {
      child,
      async finished() {
        const { code, signal } = await completed;
        assert.equal(code, 0, `Worker ${operation} failed (${code ?? signal}): ${output}`);
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      },
      send(type, extra = {}) {
        child.send({ type, ...extra });
      },
      async wait(type) {
        const deadline = Date.now() + 10000;
        while (true) {
          const index = messages.findIndex((message) => message.type === type);
          if (index >= 0) return messages.splice(index, 1)[0];
          if (failure) throw failure;
          assert.ok(Date.now() < deadline, `Worker ${operation} checkpoint timeout: ${type}`);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.min(100, deadline - Date.now()));
            waiter = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          waiter = undefined;
        }
      }
    };
  }
  return {
    pool,
    schema,
    transcript,
    worker,
    async snapshot() {
      return {
        claims: (await pool.query("SELECT * FROM claims ORDER BY resource")).rows,
        work: (await pool.query("SELECT * FROM work ORDER BY operation")).rows,
        ledger: (await pool.query("SELECT operation,stage FROM ledger ORDER BY sequence")).rows
      };
    },
    async cleanup() {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        })
      );
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1", [schema]))
            .rows[0].n,
          0
        );
      } finally {
        await admin.end();
      }
      return {
        schemaRemoved: true,
        workersExited: children.every((c) => c.exitCode !== null || c.signalCode !== null)
      };
    }
  };
}

export async function assertBlocked(pool, blocked, blocker) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query("SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked", [
      blocked,
      blocker
    ]);
    if (rows[0].blocked) return;
    // Poll observable server lock state; this delay never determines the race order.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected real PostgreSQL blocking was not observed");
}

export async function harnessSelfCheck(env = process.env) {
  const report = {
    seed: 7,
    node: process.version,
    revision: env.GITHUB_SHA ?? "local/uncommitted; see runner base-revision.txt",
    media: "simulated ESL, no SIP/RTP/provider",
    scenarios: [],
    status: "running"
  };
  let fixture;
  let failure;
  try {
    report.sourceHashes = {};
    for (const file of ["database.mjs", "worker.mjs", "controls.mjs"]) {
      report.sourceHashes[file] = createHash("sha256")
        .update(await readFile(new URL(file, import.meta.url)))
        .digest("hex");
    }
    fixture = await createDatabaseFixture(env);
    report.database = (await fixture.pool.query("SELECT version() AS version")).rows[0].version;
    for (const [first, second, rollback] of [
      ["a", "b", false],
      ["b", "a", false],
      ["a", "b", true]
    ]) {
      await fixture.pool.query("TRUNCATE claims, work, ledger RESTART IDENTITY");
      const one = fixture.worker(first),
        two = fixture.worker(second);
      const readyOne = await one.wait("before-claim"),
        readyTwo = await two.wait("before-claim");
      assert.notEqual(readyOne.pid, readyTwo.pid);
      one.send("resume");
      await one.wait("before-commit");
      two.send("resume");
      await two.wait("claiming");
      await assertBlocked(fixture.pool, readyTwo.backend, readyOne.backend);
      assert.deepEqual(await fixture.snapshot(), { claims: [], work: [], ledger: [] });
      one.send(rollback ? "rollback" : "resume");
      const winner = rollback ? two : one,
        loser = rollback ? one : two;
      if (rollback) {
        await one.wait("rolled-back");
        await two.wait("before-commit");
        two.send("resume");
      }
      await winner.wait("before-send");
      if (!rollback) await loser.wait("lost");
      let snapshot = await fixture.snapshot();
      assert.equal(snapshot.claims.length, 1);
      assert.equal(snapshot.work[0].state, "claimed");
      assert.equal(snapshot.ledger.length, 0);
      winner.send("resume");
      await winner.wait("after-send-before-ack");
      snapshot = await fixture.snapshot();
      assert.deepEqual(
        snapshot.ledger.map((r) => r.stage),
        ["sent"]
      );
      assert.equal(snapshot.work[0].state, "uncertain");
      winner.send("resume");
      await winner.wait("after-bridge-before-persistence");
      snapshot = await fixture.snapshot();
      assert.deepEqual(
        snapshot.ledger.map((r) => r.stage),
        ["sent", "ack", "bridge"]
      );
      assert.equal(snapshot.work[0].state, "uncertain");
      winner.send("resume");
      await winner.wait("done");
      await winner.finished();
      await loser.finished();
      snapshot = await fixture.snapshot();
      assert.equal(snapshot.work.length, 1);
      assert.equal(snapshot.work[0].operation, rollback ? second : first);
      assert.equal(snapshot.work[0].state, "persisted");
      assertLedger(snapshot.ledger);
      assert.throws(() => assertLedger([...snapshot.ledger, snapshot.ledger[0]]), /duplicate sent/);
      // The invariant checker also detects an actual corrupted persisted fixture.
      await fixture.pool.query("INSERT INTO ledger(operation,stage) VALUES($1,'sent')", [
        snapshot.work[0].operation
      ]);
      const corrupted = await fixture.snapshot();
      assert.throws(() => assertLedger(corrupted.ledger), /duplicate sent/);
      report.scenarios.push({ first, second, rollback, winner: snapshot.work[0].operation, snapshot });
    }
    for (const checkpoint of checkpoints) assert.ok(fixture.transcript.some((m) => m.type === checkpoint));
    // Harness crashes, not product recovery tests. Uncommitted state rolls back;
    // committed effects remain uncertain until a future domain reconciler resolves them.
    for (const boundary of checkpoints) {
      await fixture.pool.query("TRUNCATE claims, work, ledger RESTART IDENTITY");
      const worker = fixture.worker("a");
      for (const checkpoint of checkpoints) {
        await worker.wait(checkpoint);
        if (checkpoint === boundary) break;
        worker.send("resume");
      }
      await worker.stop();
      const snapshot = await fixture.snapshot();
      const uncommitted = ["before-claim", "before-commit"].includes(boundary);
      assert.equal(snapshot.claims.length, uncommitted ? 0 : 1);
      assert.equal(snapshot.work.length, uncommitted ? 0 : 1);
      if (!uncommitted)
        assert.equal(snapshot.work[0].state, boundary === "before-send" ? "claimed" : "uncertain");
      assert.equal(
        snapshot.ledger.length,
        boundary === "after-send-before-ack" ? 1 : boundary === "after-bridge-before-persistence" ? 3 : 0
      );
      assertLedger(snapshot.ledger);
      report.scenarios.push({ boundary, crash: true, snapshot });
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    failure = error;
  } finally {
    try {
      if (fixture) report.cleanup = await fixture.cleanup();
    } catch (error) {
      report.status = "failed";
      report.cleanupError = error.stack;
      failure ??= error;
    } finally {
      report.transcript = fixture?.transcript ?? [];
      if (env.INBOUND_TEST_ARTIFACTS) {
        await mkdir(env.INBOUND_TEST_ARTIFACTS, { recursive: true });
        await writeFile(
          `${env.INBOUND_TEST_ARTIFACTS}/harness-report.json`,
          JSON.stringify(report, null, 2) + "\n"
        );
      }
    }
  }
  if (failure) throw failure;
  return report;
}
