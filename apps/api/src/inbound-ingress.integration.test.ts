import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { importIngressRecord, reconcileIngress } from "./inbound-ingress.js";
import { readIngressRecords, startIngressAgent } from "./ingress-agent.js";
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
  "D03 skips 128-slot terminal history and repairs either incomplete ACK checkpoint",
  options,
  async () => {
    const f = await fixture();
    const directory = await mkdtemp("/tmp/inbound-reconcile-");
    const socket = join(directory, "agent.sock");
    let disappeared: string | undefined;
    const command = async (text: string) => {
      if (disappeared && text === `uuid_exists ${disappeared}`) return "false";
      assert.equal(text, "show channels as json");
      return "{}";
    };
    const agent = await startIngressAgent(socket, command, 128, 0);
    try {
      const incomplete: string[] = [];
      for (let i = 0; i < 128; i++) {
        const uuid = randomUUID();
        agent.journal.capture({
          uuid,
          arrivedUs: Date.now() * 1000,
          did: f.row.did,
          numberId: f.row.numberId,
          routeRevision: f.row.routeRevision,
          queueId: f.row.queueId,
          queueRevision: f.row.queueRevision,
          campaignId: f.row.campaignId,
          timeoutMs: f.row.timeoutMs,
          routeData: f.row.routeData,
          callingNumber: f.row.callingNumber
        });
        const row = agent.journal.terminal(uuid);
        await importIngressRecord(f.pool, row);
        // Simulate one crash before the SQLite ACK and one after it but before SQL records it.
        if (i > 0) agent.journal.acknowledge(uuid, row.sequence);
        if (i > 1) {
          await f.pool.query(
            "update inbound_ingress_evidence set acknowledged_sequence=$2 where ingress_id=$1",
            [uuid, row.sequence]
          );
        } else incomplete.push(uuid);
      }
      const replayed: string[] = [];
      const hooks = {
        async beforeImport(row: IngressRecord) {
          replayed.push(row.uuid);
        },
        async afterImport() {}
      };
      const legacy = await readIngressRecords(socket);
      assert.equal(legacy.length, 128);
      assert.ok(legacy.every((row) => row.sequence === 2 && row.terminalUs !== null));
      await reconcileIngress(f.pool, socket, command, undefined, hooks);
      assert.deepEqual(replayed, incomplete);
      assert.equal(agent.journal.status().unacknowledged, 0);
      assert.equal(
        (await f.pool.query("select 1 from inbound_ingress_evidence where acknowledged_sequence<>2"))
          .rowCount,
        0
      );
      replayed.length = 0;
      await reconcileIngress(f.pool, socket, command, undefined, hooks);
      assert.deepEqual(replayed, []);

      await f.pool.query("insert into call_legs(call_id,type) values($1,'agent')", [incomplete[0]]);
      await reconcileIngress(f.pool, socket, command, undefined, hooks);
      assert.deepEqual(replayed, [incomplete[0]], "An exact ACK cannot bypass pending D04 cleanup");
      await f.pool.query("update call_legs set ended_at=clock_timestamp() where call_id=$1", [incomplete[0]]);

      const {
        journalId: _journalId,
        sequence: _sequence,
        terminalUs: _terminalUs,
        terminalReason: _terminalReason,
        ...capture
      } = f.row;
      const live = agent.journal.capture({ ...capture, arrivedUs: Date.now() * 1000 });
      await importIngressRecord(f.pool, live);
      agent.journal.acknowledge(live.uuid, live.sequence);
      await f.pool.query("update inbound_ingress_evidence set acknowledged_sequence=$2 where ingress_id=$1", [
        live.uuid,
        live.sequence
      ]);
      // The initial live ACK never hides a missing hangup hook.
      disappeared = live.uuid;
      await reconcileIngress(f.pool, socket, command);
      const evidence = (
        await f.pool.query(
          "select terminal_at,acknowledged_sequence from inbound_ingress_evidence where ingress_id=$1",
          [live.uuid]
        )
      ).rows[0];
      assert.ok(evidence.terminal_at);
      assert.equal(evidence.acknowledged_sequence, "2");
    } finally {
      await agent.close();
      await rm(directory, { recursive: true, force: true });
      await f.cleanup();
    }
  }
);
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
        /Terminal (ingress|inbound)/
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
      let a: ReturnType<typeof importIngressRecord> | undefined;
      let b: ReturnType<typeof importIngressRecord> | undefined;
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
      const history = (
        await f.pool.query(
          "select * from schema_migrations where filename<'035_durable_ingress.sql' order by filename"
        )
      ).rows;
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
