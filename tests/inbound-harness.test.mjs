import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertLedger, EventTape, checkpoints } from "./fixtures/inbound/controls.mjs";
import { testDatabaseUrl } from "./fixtures/inbound/database.mjs";
import { localSipClient } from "./fixtures/inbound/sip.mjs";
import { apiTestArgs } from "../scripts/run-api-tests.mjs";

test("A07.2 dedicated runner fails without TEST_DATABASE_URL and never uses DATABASE_URL", () => {
  const result = spawnSync(process.execPath, ["scripts/run-inbound-db.mjs"], {
    env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://production.invalid/application" },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_DATABASE_URL is required; no DATABASE_URL fallback/);
});

test("A07.2 fixture permits only explicit local test databases and rejects application aliases", () => {
  const local = "postgresql://tester@127.0.0.1/outbound_dialer_test";
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: local }), local);
  for (const url of [
    undefined,
    "invalid",
    "https://localhost/test",
    "postgres://external.invalid/test",
    "postgres://localhost/application",
    "postgres://localhost/contest",
    "postgres://localhost/test?host=external.invalid",
    "postgres://localhost/test?host=/tmp/outbound-inbound-db.safe/socket&host=external.invalid",
    "postgres://localhost/test?options=-csearch_path=public"
  ]) {
    assert.throws(() => testDatabaseUrl({ TEST_DATABASE_URL: url }));
  }
  assert.throws(
    () =>
      testDatabaseUrl({
        TEST_DATABASE_URL: local,
        DATABASE_URL: "postgres://other:unused@localhost:5432/outbound_dialer_test"
      }),
    /must not designate/
  );
});

test("A07.1 ledger rejects duplicate effects and invalid chronology", () => {
  assert.equal(checkpoints.length, 5);
  assertLedger(["sent", "ack", "bridge"].map((stage) => ({ operation: "op", stage })));
  for (const stages of [["sent", "sent"], ["bridge"], ["sent", "bridge"], ["unknown"]])
    assert.throws(() => assertLedger(stages.map((stage) => ({ operation: "op", stage }))));
});

test("A07.1 replay explicitly duplicates/reorders without mutating fixture events", () => {
  const tape = new EventTape([{ id: 1 }, { id: 2 }], 7);
  const seen = [];
  tape.next((event) => {
    event.id = 99;
  });
  tape.replay([1, 0, 1], (event) => seen.push(event.id));
  assert.deepEqual(seen, [2, 1, 2]);
  tape.reset();
  assert.equal(
    tape.next((event) => seen.push(event.id)),
    true
  );
  tape.next(() => {});
  assert.equal(
    tape.next(() => {}),
    false
  );
  assert.throws(() => tape.replay([2], () => {}));
});

test("A07.3 CI discovers bounded DB fixture and retains failure evidence", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /npm run test:inbound:db/);
  assert.match(ci, /INBOUND_TEST_ARTIFACTS:/);
  assert.match(ci, /actions\/upload-artifact@v4/);
  const isolated = await readFile(".github/workflows/inbound-fixtures.yml", "utf8");
  assert.match(isolated, /pull_request:/);
  assert.match(isolated, /if: always\(\)/);
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(packageJson.scripts["test:inbound:db"]);
  assert.ok(packageJson.scripts["test:inbound:db:isolated"]);
});

test("A07.4 SIP fixture refuses external sources before opening sockets", () => {
  assert.throws(() => localSipClient({ source: "198.51.100.1" }), /loopback source/);
});

test("A07.3 API discovery includes nested compiled suites and serializes shared DB files only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a07-discovery-"));
  try {
    await mkdir(join(directory, "dashboard", "inbound"), { recursive: true });
    for (const name of ["top.test.js", "helper.js", "dashboard/inbound/race.test.js"])
      await writeFile(join(directory, name), "");
    const optional = await apiTestArgs(directory, {});
    assert.equal(optional.length, 3);
    assert.ok(optional.some((path) => path.endsWith("/dashboard/inbound/race.test.js")));
    assert.ok(!optional.includes("--test-concurrency=1"));
    const database = await apiTestArgs(directory, { TEST_DATABASE_URL: "fixture" });
    assert.equal(database[1], "--test-concurrency=1");
    await rm(join(directory, "top.test.js"));
    await rm(join(directory, "dashboard"), { recursive: true });
    await assert.rejects(apiTestArgs(directory, {}), /No compiled API tests/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
