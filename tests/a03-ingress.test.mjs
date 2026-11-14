import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initialize,
  openJournal,
  validateRecord,
  importRecord,
  capture
} from "../scripts/a03-ingress-journal.mjs";

const record = () => ({
  uuid: "11111111-1111-4111-8111-111111111111",
  arrived_us: 1_800_000_000_000_000,
  state: 1,
  did: "+12025550100",
  revision: "fixture-v1",
  cause: "NORMAL_CLEARING"
});

test("A03 duplicate capture preserves terminal evidence and expired requests cannot claim slots", () => {
  const directory = mkdtempSync(join(tmpdir(), "a03-capture-"));
  try {
    initialize(join(directory, "journal.sqlite"), 1);
    const db = openJournal(join(directory, "journal.sqlite"));
    try {
      const input = new URLSearchParams({ uuid: record().uuid, arrived_us: String(Date.now() * 1000) });
      capture(db, input);
      const second = new URLSearchParams(input);
      second.set("uuid", "22222222-2222-4222-8222-222222222222");
      assert.throws(() => capture(db, second), /Journal exhausted/);
      input.set("cause", "ORIGINATOR_CANCEL");
      input.set("ended_us", String(Date.now() * 1000));
      capture(db, input, true);
      capture(db, input);
      const saved = db.prepare("SELECT * FROM ingress").get();
      assert.equal(saved.state, 2);
      assert.equal(saved.cause, "ORIGINATOR_CANCEL");
      assert.equal(saved.arrived_us, Number(input.get("arrived_us")));
      db.exec("UPDATE ingress SET state=0");
      second.set("arrived_us", String((Date.now() - 1000) * 1000));
      assert.throws(() => capture(db, second), /Capture deadline elapsed/);
      assert.equal(db.prepare("SELECT state FROM ingress").get().state, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("A03 journal initializes finite slots and prevents duplicate active identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "a03-unit-"));
  try {
    initialize(join(directory, "journal.sqlite"), 2);
    const db = openJournal(join(directory, "journal.sqlite"));
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM ingress WHERE state=0").get().n, 2);
      const claim = db.prepare("UPDATE ingress SET state=1,uuid=? WHERE slot=?");
      claim.run(record().uuid, 0);
      assert.throws(() => claim.run(record().uuid, 1), /UNIQUE/);
      assert.equal(db.prepare("PRAGMA max_page_count").get().max_page_count, 64);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("A03 malformed identity/route/age and uncertain ESL evidence cannot reach INSERT", async () => {
  for (const changes of [
    { uuid: "forged" },
    { arrived_us: 0 },
    { did: "+12025550999" },
    { revision: "untrusted" },
    { state: 0 }
  ])
    assert.throws(() => validateRecord({ ...record(), ...changes }));
  const client = { query: () => assert.fail("No SQL allowed without definite channel evidence") };
  await assert.rejects(importRecord(client, record(), undefined));
  await assert.rejects(importRecord(client, record(), true, "before-insert"), /before first INSERT/);
});

test("A03 failed INSERT rolls back; lost post-commit ack never rolls back a committed call", async () => {
  const statements = [];
  let fail = true;
  const client = {
    query: async (sql) => {
      statements.push(sql.trim().split(/\s+/)[0]);
      if (sql.includes("INSERT") && fail) throw new Error("DB unavailable");
      return { rowCount: 1, rows: [{ terminal: false }] };
    }
  };
  await assert.rejects(importRecord(client, record(), true), /DB unavailable/);
  assert.deepEqual(statements, ["BEGIN", "INSERT", "ROLLBACK"]);
  statements.length = 0;
  fail = false;
  await assert.rejects(importRecord(client, record(), true, "after-commit"), /before acknowledgement/);
  assert.deepEqual(statements, ["BEGIN", "INSERT", "COMMIT"]);
});
