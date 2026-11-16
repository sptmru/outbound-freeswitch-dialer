import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { importIngressRecord } from "./inbound-ingress.js";
import type { IngressRecord } from "./ingress-journal.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
async function fixture() {
  const schema = `d03_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const config = databaseConfig(testDatabaseUrl(), schema),
    pool = new pg.Pool({ ...config, max: 8 });
  await runMigrations(pool);
  const campaignId = (await pool.query("insert into campaigns(name) values('D03') returning id")).rows[0].id;
  const queueId = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'D03') returning id", [
      campaignId
    ])
  ).rows[0].id;
  const row: IngressRecord = {
    uuid: randomUUID(),
    journalId: randomUUID(),
    sequence: 1,
    arrivedUs: Date.now() * 1000 + 123,
    did: "+12025550100",
    routeRevision: "1",
    numberId: randomUUID(),
    queueId,
    queueRevision: "1",
    campaignId,
    timeoutMs: 60000,
    routeData: "e30",
    callingNumber: "unknown",
    terminalUs: null,
    terminalReason: null
  };
  return {
    pool,
    config,
    row,
    terminal: () => ({
      ...row,
      sequence: 2,
      terminalUs: row.arrivedUs + 1000000,
      terminalReason: "channel_absent_on_recovery"
    }),
    async cleanup() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  };
}
test(
  "D03.1 DB: before-INSERT and after-COMMIT faults replay one identity, original microsecond arrival/route/deadline",
  options,
  async () => {
    const f = await fixture();
    try {
      for (const point of ["before-insert", "after-commit"] as const) {
        await assert.rejects(
          importIngressRecord(f.pool, f.row, async (p) => {
            if (p === point) throw new Error(point);
          }),
          new RegExp(point)
        );
        assert.equal(
          (await f.pool.query("select count(*)::int as n from calls")).rows[0].n,
          point === "before-insert" ? 0 : 1
        );
      }
      await importIngressRecord(f.pool, f.row);
      await importIngressRecord(f.pool, f.row);
      const rows = (
        await f.pool.query(
          "select c.*,extract(epoch from arrived_at)*1000000 as us,extract(epoch from queue_deadline_at-arrived_at)*1000 as timeout from calls c"
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].us), f.row.arrivedUs);
      assert.equal(Number(rows[0].timeout), 60000);
      assert.equal(rows[0].id, f.row.uuid);
      for (const change of [
        { arrivedUs: f.row.arrivedUs + 1 },
        { routeRevision: "2" },
        { timeoutMs: 61000 },
        { journalId: randomUUID() }
      ])
        await assert.rejects(importIngressRecord(f.pool, { ...f.row, ...change }));
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "D03.2 DB: terminal-first missing history imports once and stale live replay cannot resurrect or schedule work",
  options,
  async () => {
    const f = await fixture();
    try {
      await importIngressRecord(f.pool, f.terminal());
      await importIngressRecord(f.pool, f.row);
      await importIngressRecord(f.pool, f.terminal());
      const call = (await f.pool.query("select * from calls")).rows[0];
      assert.equal(call.state, "failed");
      assert.ok(call.ended_at);
      assert.equal(call.agent_connected_at, null);
      const evidence = (await f.pool.query("select * from inbound_ingress_evidence")).rows[0];
      assert.equal(evidence.evidence_sequence, "2");
      assert.equal(evidence.call_id, f.row.uuid);
      for (const table of [
        "call_operations",
        "call_offers",
        "call_capacity_reservations",
        "call_participants"
      ])
        assert.equal((await f.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0);
      await assert.rejects(
        f.pool.query("update calls set state='received',ended_at=null where id=$1", [f.row.uuid]),
        /Terminal ingress/
      );
    } finally {
      await f.cleanup();
    }
  }
);
for (const terminalFirst of [false, true])
  test(
    `D03.1/D03.2 DB: separate workers live/terminal order terminalFirst=${terminalFirst}`,
    options,
    async () => {
      const f = await fixture();
      const first = new pg.Pool({ ...f.config, max: 1 }),
        second = new pg.Pool({ ...f.config, max: 1 });
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      let reached!: () => void;
      const ready = new Promise<void>((r) => (reached = r));
      let a: Promise<void> | undefined, b: Promise<void> | undefined;
      try {
        const pidA = (await first.query("select pg_backend_pid() as pid")).rows[0].pid;
        const pidB = (await second.query("select pg_backend_pid() as pid")).rows[0].pid;
        a = importIngressRecord(first, terminalFirst ? f.terminal() : f.row, async (point) => {
          if (point === "before-insert") {
            reached();
            await gate;
          }
        });
        await ready;
        b = importIngressRecord(second, terminalFirst ? f.row : f.terminal());
        await assertBlocked(f.pool, pidB, pidA);
        resume();
        await Promise.all([a, b]);
        assert.equal(
          (await f.pool.query("select count(*)::int as n from calls where ended_at is not null")).rows[0].n,
          1
        );
      } finally {
        resume();
        await Promise.allSettled([a, b]);
        await first.end();
        await second.end();
        await f.cleanup();
      }
    }
  );

test(
  "D03 migration 035 preserves populated 034 evidence and previous checksums; old writers remain compatible",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query(`drop table inbound_ingress_route_snapshots;
      drop function guard_published_ingress_route();
      drop trigger inbound_ingress_snapshot_guard on inbound_ingress_evidence;
      drop function guard_ingress_snapshot();
      alter table inbound_ingress_evidence drop column route_snapshot,drop column calling_number;
      delete from schema_migrations where filename='035_durable_ingress.sql'`);
      const history = (await f.pool.query("select * from schema_migrations order by filename")).rows;
      await f.pool.query(
        `insert into inbound_ingress_evidence(ingress_id,journal_id,arrived_at,validated_did,route_revision,queue_deadline_at,evidence_sequence)
      values($1,'pre-035',now(),'+12025550100',1,now()+interval '1 minute',1)`,
        [f.row.uuid]
      );
      const old = (await f.pool.query("select * from inbound_ingress_evidence")).rows[0];
      await runMigrations(f.pool);
      await runMigrations(f.pool);
      assert.deepEqual((await f.pool.query("select * from inbound_ingress_evidence")).rows[0], {
        ...old,
        route_snapshot: null,
        calling_number: null
      });
      assert.deepEqual(
        (
          await f.pool.query(
            "select * from schema_migrations where filename<'035_durable_ingress.sql' order by filename"
          )
        ).rows,
        history
      );
      await f.pool.query("update inbound_ingress_evidence set imported_sequence=1 where ingress_id=$1", [
        f.row.uuid
      ]);
    } finally {
      await f.cleanup();
    }
  }
);
test(
  "D03.1 DB: published route pins queue/campaign before first call; queue edits cannot change captured deadline",
  options,
  async () => {
    const f = await fixture();
    try {
      const data = { id: f.row.queueId, campaign_id: f.row.campaignId, queue_timeout_ms: 60000 };
      f.row.routeData = Buffer.from(JSON.stringify(data)).toString("base64url");
      await f.pool.query(
        `insert into inbound_ingress_route_snapshots(configuration_hash,number_id,queue_id,campaign_id,snapshot)
      values($1,$2,$3,$4,$5)`,
        ["a".repeat(64), f.row.numberId, f.row.queueId, f.row.campaignId, data]
      );
      await assert.rejects(f.pool.query("delete from inbound_queues where id=$1", [f.row.queueId]), {
        code: "23503"
      });
      const other = (await f.pool.query("insert into campaigns(name) values('other') returning id")).rows[0]
        .id;
      await assert.rejects(
        f.pool.query("update inbound_queues set campaign_id=$2 where id=$1", [f.row.queueId, other]),
        { code: "23503" }
      );
      await f.pool.query("update inbound_queues set queue_timeout_ms=45000 where id=$1", [f.row.queueId]);
      await importIngressRecord(f.pool, f.row);
      await importIngressRecord(f.pool, f.terminal());
      const result = (
        await f.pool.query(
          "select extract(epoch from queue_deadline_at-arrived_at)*1000 as timeout from calls"
        )
      ).rows[0];
      assert.equal(Number(result.timeout), 60000);
      await assert.rejects(f.pool.query("delete from inbound_ingress_route_snapshots"), /drained retention/);
    } finally {
      await f.cleanup();
    }
  }
);
