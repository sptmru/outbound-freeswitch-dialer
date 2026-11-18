import assert from "node:assert/strict";
import type pg from "pg";
import { CoalescedTask } from "./coalesced-task.js";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { ingressRequest, readIngressRecords, type IngressCommand } from "./ingress-agent.js";
import { captureFromDump, validateIngress, ingressUuid, type IngressRecord } from "./ingress-journal.js";
import { setIngressStatus, recordIngressImportFailure } from "./metrics.js";

const timestamp = (parameter: number) =>
  `('epoch'::timestamptz + ($${parameter}::bigint/1000000)*interval '1 second' + ($${parameter}::bigint%1000000)*interval '1 microsecond')`;
export function ingressSnapshot(row: IngressRecord) {
  return {
    numberId: row.numberId,
    campaignId: row.campaignId,
    queueId: row.queueId,
    queueRevision: row.queueRevision,
    timeoutMs: row.timeoutMs,
    configuration: JSON.parse(Buffer.from(row.routeData, "base64url").toString("utf8"))
  };
}
// No ESL, journal I/O, offers, capacity or media side effects inside this transaction.
// D03 owns only the pre-queue received/history state. D04 must integrate admission
// and terminal cleanup before it can advance this state or acknowledge admission.
export async function importIngressRecord(
  pool: pg.Pool,
  row: IngressRecord,
  checkpoint?: (point: "before-insert" | "after-commit", uuid?: string) => Promise<void>
) {
  validateIngress(row);
  assert.match(row.journalId, ingressUuid);
  assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > 0);
  assert.equal(row.terminalUs === null, row.terminalReason === null);
  if (row.terminalUs !== null) {
    assert.ok(Number.isSafeInteger(row.terminalUs) && row.terminalUs >= row.arrivedUs);
    assert.equal(row.terminalReason, "channel_absent_on_recovery");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='500ms'");
    await client.query("set local statement_timeout='1500ms'");
    // Rank-1 admission serialization, then campaign, then call. No slot/agent claims;
    // history import remains possible before I05's admission migration marker clears.
    await client.query("select pg_advisory_xact_lock(72202,0)");
    await client.query("select id from campaigns where id=$1 for share", [row.campaignId]);
    const existing = (
      await client.query("select * from inbound_ingress_evidence where ingress_id=$1 for update", [row.uuid])
    ).rows[0];
    const snapshot = ingressSnapshot(row);
    if (existing) {
      assert.equal(existing.journal_id, row.journalId, "Journal identity changed");
      assert.equal(existing.validated_did, row.did, "DID changed");
      assert.equal(existing.route_revision, row.routeRevision, "Route changed");
      assert.deepEqual(existing.route_snapshot, snapshot, "Route snapshot changed");
      assert.equal(existing.calling_number, row.callingNumber, "Caller identity changed");
      const sameTime = await client.query(
        `select arrived_at=${timestamp(2)} as same from inbound_ingress_evidence where ingress_id=$1`,
        [row.uuid, row.arrivedUs]
      );
      assert.ok(sameTime.rows[0].same, "Arrival changed");
    }
    await checkpoint?.("before-insert", row.uuid);
    // Insert live evidence first. B04 requires a terminal call before linking
    // terminal evidence, so both links and terminal transition commit together.
    await client.query(
      `insert into inbound_ingress_evidence
      (ingress_id,journal_id,arrived_at,validated_did,route_revision,queue_deadline_at,evidence_sequence,route_snapshot,calling_number)
      values($1,$2,${timestamp(3)},$4,$5,${timestamp(3)}+$6::int*interval '1 millisecond',$7,$8,$9)
      on conflict(ingress_id) do nothing`,
      [
        row.uuid,
        row.journalId,
        row.arrivedUs,
        row.did,
        row.routeRevision,
        row.timeoutMs,
        1,
        snapshot,
        row.callingNumber
      ]
    );
    const terminal = existing?.terminal_at != null || row.terminalUs !== null;
    await client.query(
      `insert into calls(id,direction,campaign_id,inbound_queue_id,original_did,
      calling_number,called_number,destination_number,normalized_destination_number,arrived_at,queue_deadline_at,state,created_at)
      values($1,'inbound',$2,$3,$4,$5,$4,$4,$4,${timestamp(6)},${timestamp(6)}+$7::int*interval '1 millisecond','received',${timestamp(6)})
      on conflict(id) do nothing`,
      [row.uuid, row.campaignId, row.queueId, row.did, row.callingNumber, row.arrivedUs, row.timeoutMs]
    );
    const call = (
      await client.query("select state,direction,ended_at from calls where id=$1 for update", [row.uuid])
    ).rows[0];
    assert.equal(call.direction, "inbound");
    assert.ok(
      call.state === "received" ||
        call.ended_at ||
        (await client.query("select 1 from inbound_queue_admissions where call_id=$1", [row.uuid])).rowCount,
      "D04 admitted lifecycle requires its own terminal coordinator"
    );
    if (terminal && !call.ended_at) {
      assert.equal(call.state, "received", "Admitted ingress requires D04 terminal coordination");
      await client.query(
        `update calls set state='failed',outcome='failed',ended_at=${timestamp(2)},updated_at=clock_timestamp() where id=$1`,
        [row.uuid, row.terminalUs]
      );
    }
    const sequence = Math.max(Number(existing?.evidence_sequence ?? 0), row.sequence);
    await client.query(
      `update inbound_ingress_evidence set call_id=$1,evidence_sequence=$2,imported_sequence=$2,
      terminal_at=coalesce(terminal_at,case when $3::bigint is not null then ${timestamp(3)} end),
      terminal_reason=coalesce(terminal_reason,$4) where ingress_id=$1`,
      [row.uuid, sequence, row.terminalUs, row.terminalReason]
    );
    await client.query("commit");
    await checkpoint?.("after-commit", row.uuid);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function reconcileIngress(
  pool: pg.Pool,
  socket: string,
  command: IngressCommand,
  checkpoint?: (point: "before-insert" | "after-commit", uuid?: string) => Promise<void>,
  queue?: { beforeImport(row: IngressRecord): Promise<void>; afterImport(row: IngressRecord): Promise<void> }
) {
  setIngressStatus(JSON.parse(await ingressRequest(socket, "/status")));
  // Begin with the independent journal, including entries with no calls row.
  for (let row of (await readIngressRecords(socket)).sort(
    (a, b) => Number(b.terminalUs !== null) - Number(a.terminalUs !== null)
  )) {
    if (row.terminalUs === null) {
      const exists = (await command(`uuid_exists ${row.uuid}`)).trim();
      assert.ok(exists === "true" || exists === "false", "Unknown FS discovery response");
      if (exists === "false") row = JSON.parse(await ingressRequest(socket, "/terminal", { uuid: row.uuid }));
      else {
        let liveCapture;
        try {
          liveCapture = captureFromDump(row.uuid, await command(`uuid_dump ${row.uuid}`));
        } catch (error) {
          // A channel may close between the two reads. A dump error alone never
          // establishes absence; require another definite native existence check.
          if ((await command(`uuid_exists ${row.uuid}`)).trim() !== "false") throw error;
          row = JSON.parse(await ingressRequest(socket, "/terminal", { uuid: row.uuid }));
        }
        if (liveCapture)
          assert.deepEqual(
            liveCapture,
            Object.fromEntries(
              Object.entries(row).filter(
                ([key]) => !["sequence", "journalId", "terminalUs", "terminalReason"].includes(key)
              )
            ),
            "Fresh live identity mismatch"
          );
      }
    }
    await queue?.beforeImport(row);
    await importIngressRecord(pool, row, checkpoint);
    await queue?.afterImport(row);
    // A delayed live ACK cannot acknowledge a newer terminal sequence (journal CAS).
    await ingressRequest(socket, "/ack", { uuid: row.uuid, sequence: String(row.sequence) });
    await pool.query(
      `update inbound_ingress_evidence set acknowledged_sequence=greatest(acknowledged_sequence,$2)
      where ingress_id=$1 and imported_sequence >= $2`,
      [row.uuid, row.sequence]
    );
  }
  // Independently scan FS, not just calls. uuid_dump validates every candidate;
  // arbitrary channels are ignored and cannot grant admission or create media.
  const discovery = JSON.parse(await command("show channels as json"));
  assert.ok(Array.isArray(discovery.rows ?? []));
  assert.ok((discovery.rows?.length ?? 0) <= 200, "FS channel discovery exceeded hard maximum");
  for (const channel of discovery.rows ?? []) {
    if (!ingressUuid.test(channel.uuid ?? "")) continue;
    let dump;
    try {
      dump = await command(`uuid_dump ${channel.uuid}`);
    } catch (error) {
      if ((await command(`uuid_exists ${channel.uuid}`)).trim() === "false") continue;
      throw error;
    }
    if (!dump.includes("variable_outbound_dialer_ingress_protocol: d03-v1")) continue;
    // Captured work can replay after the original capture window. An unknown,
    // old channel cannot manufacture a new durability receipt during recovery.
    await ingressRequest(socket, "/discover", { uuid: channel.uuid });
  }
  const status = JSON.parse(await ingressRequest(socket, "/status"));
  setIngressStatus(status);
  return status;
}
export function startIngressReconciler(
  pool: pg.Pool,
  config: AppConfig,
  logger: { error(value: unknown, message?: string): void }
) {
  if (!config.FREESWITCH_INGRESS_ENABLED || !config.FREESWITCH_ESL_ENABLED) return () => {};
  const task = new CoalescedTask(
    async () => {
      await reconcileIngress(pool, config.FREESWITCH_INGRESS_SOCKET, async (cmd) =>
        (await sendFreeSwitchApiCommand(config, cmd, 1000)).body.trim()
      );
    },
    () => {
      recordIngressImportFailure();
      logger.error({}, "D03 ingress import failed; journal evidence retained");
    }
  );
  const timer = setInterval(() => task.request(), 1000);
  timer.unref();
  task.request();
  return () => {
    clearInterval(timer);
    task.stop();
  };
}
// Initial tagged ingress is handled before generic call-ID/leg handlers. Fresh
// journal/discovery remains authority; late ESL events cannot resurrect history.
export function isInitialIngressEvent(headers: Record<string, string>) {
  return (
    headers["variable_outbound_dialer_ingress_protocol"] === "d03-v1" &&
    ingressUuid.test(headers["variable_outbound_dialer_ingress_uuid"] ?? "")
  );
}
