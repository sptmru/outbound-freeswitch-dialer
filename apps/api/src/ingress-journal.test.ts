import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { captureFromDump, IngressJournal, type IngressCapture } from "./ingress-journal.js";
import { ingressRequest, startIngressAgent } from "./ingress-agent.js";
import { __testing } from "./esl-events.js";
import type { AppConfig } from "./config.js";
import type pg from "pg";
const capture = (): IngressCapture => ({
  uuid: randomUUID(),
  arrivedUs: Date.now() * 1000,
  did: "+12025550100",
  routeRevision: "1",
  numberId: randomUUID(),
  queueId: randomUUID(),
  queueRevision: "1",
  campaignId: randomUUID(),
  timeoutMs: 60000,
  routeData: "e30",
  callingNumber: "unknown"
});
function dump(row: IngressCapture) {
  return [
    `Unique-ID: ${row.uuid}`,
    "Call-Direction: inbound",
    `Caller-Channel-Created-Time: ${row.arrivedUs}`,
    "Caller-Caller-ID-Number: unknown",
    ...Object.entries({
      ingress_protocol: "d03-v1",
      ingress_uuid: row.uuid,
      validated_did: row.did,
      route_revision: row.routeRevision,
      number_id: row.numberId,
      queue_id: row.queueId,
      queue_revision: row.queueRevision,
      campaign_id: row.campaignId,
      route_data: row.routeData,
      queue_timeout_ms: row.timeoutMs
    }).map(([k, v]) => `variable_outbound_dialer_${k}: ${v}`)
  ].join("\n");
}
test("D03 U: authoritative dump rejects UUID, direction and caller-header authority forgery", () => {
  const row = capture(),
    source = dump(row);
  assert.deepEqual(captureFromDump(row.uuid, source), row);
  for (const invalid of [
    source.replace(row.uuid, randomUUID()),
    source.replace("Call-Direction: inbound", "Call-Direction: outbound"),
    source.replace(
      "variable_outbound_dialer_ingress_protocol:",
      "variable_sip_h_X-outbound_dialer_ingress_protocol:"
    )
  ])
    assert.throws(() => captureFromDump(row.uuid, invalid));
});
test("D03.3 U: journal restart, exact terminal ACK, stale ACK and exhaustion preserve captured work", async () => {
  const dir = await mkdtemp("/tmp/d03-journal-");
  let journal: IngressJournal | undefined;
  try {
    journal = new IngressJournal(join(dir, "db"), 1);
    const row = capture();
    const first = journal.capture(row);
    journal.acknowledge(row.uuid, 1);
    assert.throws(() => journal!.capture(capture()), /exhausted/);
    const terminal = journal.terminal(row.uuid);
    assert.equal(terminal.sequence, 2);
    journal.acknowledge(row.uuid, 1);
    assert.throws(() => journal!.capture(capture()), /exhausted/);
    journal.close();
    journal = new IngressJournal(join(dir, "db"), 1);
    assert.equal(journal.id, first.journalId);
    assert.deepEqual(journal.records(), [terminal]);
    assert.equal(journal.capture(row).terminalUs, terminal.terminalUs);
    assert.throws(() => journal!.capture({ ...row, did: "+12025550101" }), /identity/);
    journal.acknowledge(row.uuid, 2);
    journal.capture(capture());
    assert.equal(journal.records().length, 1);
  } finally {
    journal?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("D03.3 U: locked SQLite fails within bounded busy timeout without deleting receipt", async () => {
  const dir = await mkdtemp("/tmp/d03-lock-");
  const journal = new IngressJournal(join(dir, "db"), 1),
    lock = new DatabaseSync(join(dir, "db"));
  try {
    const row = capture();
    journal.capture(row);
    lock.exec("BEGIN IMMEDIATE");
    const before = Date.now();
    assert.throws(() => journal.terminal(row.uuid), /locked/);
    assert.ok(Date.now() - before < 500);
    lock.exec("ROLLBACK");
    assert.equal(journal.records()[0].terminalUs, null);
  } finally {
    lock.close();
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("D03 U: Unix control socket is private; network capture cannot ACK and unknown ESL cannot end work", async () => {
  const dir = await mkdtemp("/tmp/d03-agent-");
  const socket = join(dir, "agent.sock");
  const row = capture();
  let exists = "unknown";
  const agent = await startIngressAgent(
    socket,
    async (cmd) => (cmd.startsWith("uuid_dump") ? dump(row) : exists),
    1,
    0
  );
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    agent.journal.capture(row);
    const denied = await fetch(`http://127.0.0.1:${agent.capturePort}/ack`, {
      method: "POST",
      body: new URLSearchParams({ uuid: row.uuid, sequence: "1" })
    });
    assert.equal(denied.status, 404);
    assert.equal(agent.journal.status().unacknowledged, 1);
    await assert.rejects(ingressRequest(socket, "/terminal", { uuid: row.uuid }), /unavailable/);
    assert.equal(agent.journal.records()[0].terminalUs, null);
    exists = "false";
    const ended = JSON.parse(await ingressRequest(socket, "/terminal", { uuid: row.uuid }));
    assert.equal(ended.sequence, 2);
    await ingressRequest(socket, "/ack", { uuid: row.uuid, sequence: "1" });
    assert.equal(agent.journal.status().unacknowledged, 1);
  } finally {
    await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("D03 U: initial tagged ingress precedes all generic call lookup/event handlers", async () => {
  const id = randomUUID();
  let queries = 0;
  const pool = {
    query: async () => {
      queries++;
      throw new Error("Generic handler must not run");
    }
  } as unknown as pg.Pool;
  for (const event of ["CHANNEL_CREATE", "CHANNEL_ANSWER", "CHANNEL_HANGUP_COMPLETE", "CHANNEL_BRIDGE"]) {
    await __testing.persistFreeSwitchEvent({} as AppConfig, pool, {
      body: "",
      headers: {
        "event-name": event,
        variable_outbound_dialer_ingress_protocol: "d03-v1",
        variable_outbound_dialer_ingress_uuid: id,
        variable_outbound_dialer_call_id: id
      }
    });
  }
  assert.equal(queries, 0);
});

test("D03.3 U: actual SQLITE_FULL rolls back capture without inventing a receipt", async () => {
  const dir = await mkdtemp("/tmp/d03-full-");
  const journal = new IngressJournal(join(dir, "db"), 1);
  try {
    const pages = Number(journal.db.prepare("PRAGMA page_count").get()!.page_count);
    journal.db.exec(`PRAGMA max_page_count=${pages}`);
    const row = capture();
    row.routeData = Buffer.from(JSON.stringify({ padding: "x".repeat(2800) })).toString("base64url");
    assert.throws(() => journal.capture(row), /full/);
    assert.equal(journal.records().length, 0);
  } finally {
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
