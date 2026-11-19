import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const ingressUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export interface IngressCapture {
  uuid: string;
  arrivedUs: number;
  did: string;
  routeRevision: string;
  numberId: string;
  queueId: string;
  queueRevision: string;
  campaignId: string;
  timeoutMs: number;
  callingNumber: string;
  routeData: string;
}
export interface IngressRecord extends IngressCapture {
  journalId: string;
  sequence: number;
  terminalUs: number | null;
  terminalReason: string | null;
}
export function validateIngress(row: IngressCapture) {
  for (const id of [row.uuid, row.numberId, row.queueId, row.campaignId]) assert.match(id, ingressUuid);
  assert.ok(Number.isSafeInteger(row.arrivedUs) && row.arrivedUs > 0);
  assert.match(row.did, /^\+[1-9][0-9]{6,14}$/);
  for (const revision of [row.routeRevision, row.queueRevision]) assert.match(revision, /^[1-9][0-9]{0,17}$/);
  assert.ok(Number.isInteger(row.timeoutMs) && row.timeoutMs >= 15000 && row.timeoutMs <= 300000);
  assert.ok(typeof row.routeData === "string" && row.routeData.length <= 4096);
  assert.match(row.routeData, /^[A-Za-z0-9_-]+$/);
  const route = JSON.parse(Buffer.from(row.routeData, "base64url").toString("utf8"));
  assert.ok(route && typeof route === "object" && !Array.isArray(route));
  assert.ok(typeof row.callingNumber === "string" && row.callingNumber.length <= 64);
}
export function captureFromDump(uuid: string, dump: string): IngressCapture {
  assert.match(uuid, ingressUuid);
  const fields = Object.fromEntries(
    dump.split(/\r?\n/).flatMap((line) => {
      const at = line.indexOf(": ");
      if (at < 0) return [];
      return [[line.slice(0, at).toLowerCase(), decodeURIComponent(line.slice(at + 2))]];
    })
  );
  const variable = (key: string) => fields[`variable_outbound_dialer_${key}`];
  assert.equal(fields["unique-id"], uuid);
  assert.equal(fields["call-direction"], "inbound");
  assert.equal(variable("ingress_protocol"), "d03-v1");
  assert.equal(variable("ingress_uuid"), uuid);
  const row = {
    uuid,
    arrivedUs: Number(fields["caller-channel-created-time"]),
    did: variable("validated_did"),
    routeRevision: variable("route_revision"),
    numberId: variable("number_id"),
    queueId: variable("queue_id"),
    queueRevision: variable("queue_revision"),
    campaignId: variable("campaign_id"),
    timeoutMs: Number(variable("queue_timeout_ms")),
    routeData: variable("route_data"),
    callingNumber: (fields["caller-caller-id-number"] ?? "unknown").slice(0, 64)
  };
  validateIngress(row);
  return row;
}

// This class runs only in the independent journal process, never in FreeSWITCH.
export class IngressJournal {
  readonly db: DatabaseSync;
  readonly id: string;
  constructor(
    path: string,
    readonly slots = 128
  ) {
    assert.ok(Number.isInteger(slots) && slots > 0 && slots <= 128);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL; PRAGMA max_page_count=2048;
      CREATE TABLE IF NOT EXISTS metadata(id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(uuid TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        ack INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(evidence)")
        .all()
        .some((r) => r.name === "admission")
    )
      this.db.exec("ALTER TABLE evidence ADD COLUMN admission TEXT");
    if (!this.db.prepare("SELECT id FROM metadata").get())
      this.db.prepare("INSERT INTO metadata VALUES (?)").run(randomUUID());
    this.id = String(this.db.prepare("SELECT id FROM metadata").get()!.id);
  }
  records(): IngressRecord[] {
    return this.db
      .prepare("SELECT record FROM evidence ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.record)));
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLITE_FULL/IOERR may have already rolled back the transaction.
      // Preserve the original storage error instead of masking it with ROLLBACK.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }
  capture(input: IngressCapture, nowUs = Date.now() * 1000): IngressRecord {
    validateIngress(input);
    return this.transaction(() => {
      const old = this.db.prepare("SELECT record FROM evidence WHERE uuid=?").get(input.uuid);
      if (old) {
        const existing: IngressRecord = JSON.parse(String(old.record));
        for (const key of Object.keys(input) as (keyof IngressCapture)[])
          assert.equal(input[key], existing[key], "Ingress identity mismatch");
        return existing;
      }
      assert.ok(nowUs >= input.arrivedUs && nowUs <= input.arrivedUs + 750000, "Capture deadline elapsed");
      if (Number(this.db.prepare("SELECT count(*) AS n FROM evidence").get()!.n) >= this.slots) {
        // Only terminal evidence whose exact sequence was acknowledged may recycle.
        const free = this.db
          .prepare("SELECT uuid,record FROM evidence WHERE ack=sequence")
          .all()
          .find((r) => JSON.parse(String(r.record)).terminalUs !== null);
        assert.ok(free, "Journal exhausted");
        this.db.prepare("DELETE FROM evidence WHERE uuid=?").run(String(free.uuid));
      }
      const row: IngressRecord = {
        ...input,
        journalId: this.id,
        sequence: 1,
        terminalUs: null,
        terminalReason: null
      };
      this.db
        .prepare("INSERT INTO evidence(uuid,sequence,record) VALUES (?,1,?)")
        .run(input.uuid, JSON.stringify(row));
      assert.ok(Date.now() * 1000 <= input.arrivedUs + 750000, "Capture deadline elapsed");
      return row;
    });
  }
  terminal(uuid: string): IngressRecord {
    return this.transaction(() => {
      const found = this.db.prepare("SELECT record FROM evidence WHERE uuid=?").get(uuid);
      assert.ok(found, "Missing durable capture");
      const row: IngressRecord = JSON.parse(String(found.record));
      if (row.terminalUs === null) {
        row.terminalUs = Math.max(row.arrivedUs, Date.now() * 1000);
        row.terminalReason = "channel_absent_on_recovery";
        row.sequence++;
        this.db
          .prepare("UPDATE evidence SET sequence=?,record=? WHERE uuid=?")
          .run(row.sequence, JSON.stringify(row), uuid);
      }
      return row;
    });
  }
  admit(uuid: string, operationId: string) {
    assert.match(operationId, ingressUuid);
    this.transaction(() => {
      const r = this.db.prepare("SELECT record,admission FROM evidence WHERE uuid=?").get(uuid);
      assert.ok(r && JSON.parse(String(r.record)).terminalUs === null, "Live capture required");
      assert.ok(r.admission === null || r.admission === operationId, "Admission identity changed");
      this.db.prepare("UPDATE evidence SET admission=? WHERE uuid=?").run(operationId, uuid);
    });
  }
  admission(uuid: string) {
    const row = this.db.prepare("SELECT record,admission FROM evidence WHERE uuid=?").get(uuid);
    return row && JSON.parse(String(row.record)).terminalUs === null && row.admission
      ? `admitted:${row.admission}`
      : "pending";
  }
  acknowledge(uuid: string, sequence: number) {
    assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
    this.db
      .prepare("UPDATE evidence SET ack=max(ack,?) WHERE uuid=? AND sequence=?")
      .run(sequence, uuid, sequence);
  }
  needsTerminalImport(uuid: string, sequence: number) {
    const row = this.db.prepare("SELECT ack,sequence,record FROM evidence WHERE uuid=?").get(uuid);
    return Boolean(
      row &&
      row.sequence === sequence &&
      Number(row.ack) < sequence &&
      JSON.parse(String(row.record)).terminalUs !== null
    );
  }
  status() {
    const all = this.db.prepare("SELECT record,ack,sequence FROM evidence").all();
    const pending: IngressRecord[] = all
      .filter((r) => Number(r.ack) < Number(r.sequence))
      .map((r) => JSON.parse(String(r.record)));
    return {
      capacity: this.slots,
      used: all.filter(
        (r) => JSON.parse(String(r.record)).terminalUs === null || Number(r.ack) < Number(r.sequence)
      ).length,
      retained: all.length,
      unacknowledged: pending.length,
      oldestArrivedUs: pending.length ? Math.min(...pending.map((r) => r.arrivedUs)) : null,
      oldestPendingUs: pending.length ? Math.min(...pending.map((r) => r.terminalUs ?? r.arrivedUs)) : null
    };
  }

  close() {
    this.db.close();
  }
}
