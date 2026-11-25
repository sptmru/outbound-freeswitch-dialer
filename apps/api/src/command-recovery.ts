import assert from "node:assert/strict";
import type pg from "pg";
import { withCallAdmission } from "./call-admission.js";
import { updateAgentCallSlot, type SlotToken } from "./agent-call-slots.js";
import type { CallExecutor, DurableCommand } from "./call-executor.js";
import { ingressUuid } from "./ingress-journal.js";

export const commandReceiptAckIntervalMs = 1000;

export async function commandJournalPath(command: (text: string) => Promise<string>) {
  const directory = (await command("global_getvar conf_dir")).trim();
  assert.match(directory, /^\/[A-Za-z0-9_/.-]+$/);
  assert.ok(!directory.split("/").includes(".."));
  return `${directory}/scripts/outbound-command.lua`;
}
export function parseCommandReceipt(raw: string) {
  const [core, state, body = "", producer = ""] = raw.trim().split("|");
  assert.match(core, ingressUuid);
  assert.ok(["obsolete", "revoked", "started", "completed"].includes(state));
  assert.match(body, /^(?:[0-9a-f]{2}){0,4096}$/);
  assert.ok(["", "started", "completed", "failed", "finished"].includes(producer));
  return { core, state, body: Buffer.from(body, "hex").toString("utf8"), producer };
}

/** Caller owns C03's rank-0 lock. Receipts are native execution facts, not
 * synthesized positive ESL events. Revocation CAS or changed incarnation is a
 * producer fence; an unjournalled legacy sender remains deliberately unknown.
 */
export async function recoverCommandReceipts(
  pool: pg.Pool,
  executor: Pick<CallExecutor, "inspectCall">,
  callId: string,
  command: (text: string) => Promise<string>,
  current: () => boolean
) {
  return executor.inspectCall(callId, async (db, signal) => {
    const valid = () => !signal.aborted && current();
    if (!valid()) return;
    const rows = (
      await db.query(
        `select o.*,a.transport_protocol,f.core_uuid from call_operations o
       join call_execution_attempts a on a.operation_id=o.id left join call_command_fences f on f.operation_id=o.id
       where o.call_id=$1 and o.resolved_at is null order by o.created_at,o.id limit 16`,
        [callId]
      )
    ).rows;
    let script: string | undefined;
    for (const row of rows) {
      if (!valid()) return;
      if (row.transport_protocol !== "fs-fenced-v1") continue;
      let state = "unarmed";
      let receipt: ReturnType<typeof parseCommandReceipt> | undefined;
      if (row.core_uuid) {
        script ??= await commandJournalPath(command);
        receipt = parseCommandReceipt(
          await command(`lua ${script} inspect ${row.core_uuid} ${row.command_uuid} ${row.id}`)
        );
        assert.ok(receipt.state === "obsolete" || receipt.core === row.core_uuid);
        state = receipt.state;
      }
      if (!valid()) return;
      if (["unarmed", "revoked", "obsolete"].includes(state)) {
        await withCallAdmission(db, { callIds: [callId] }, async () => {
          if (!valid()) throw new Error("recovery_observation_changed");
          await db.query(
            `update call_operations set state='failed',resolved_at=clock_timestamp(),
             result=$2,resolution_evidence=$3 where id=$1 and resolved_at is null`,
            [
              row.id,
              { outcome: "interrupted", fence: state, core: receipt?.core ?? null },
              `H01 native sender fence: ${state}; no old frame or producer may act`
            ]
          );
        });
      } else if (receipt?.state === "completed") {
        const r = row.request;
        const eventType = r.h01Cleanup
          ? "recovery_cleanup_job"
          : r.transferOfferAcceptance
            ? "transfer_command_job"
            : r.inboundConnection
              ? "inbound_connection_job"
              : r.inboundFallback
                ? "inbound_fallback_job"
                : r.inboundWaiting
                  ? "inbound_wait_job"
                  : r.controlAction
                    ? "native_command_job"
                    : r.supervisorSessionId
                      ? "supervisor_command_job"
                      : r.admission && row.command_kind === "originate"
                        ? "coordinated_outbound_job"
                        : null;
        if (eventType)
          await db.query(
            `insert into call_events(call_id,event_type,freeswitch_event_name,raw_json)
          select $1,$2,'RECOVERY_NATIVE_RECEIPT',$3 where not exists(select 1 from call_events where call_id=$1 and event_type=$2 and raw_json->>'jobUuid'=$4)`,
            [
              callId,
              eventType,
              {
                jobUuid: row.command_uuid,
                operationId: row.id,
                body: receipt.body,
                core: receipt.core,
                source: "native-command-journal"
              },
              row.command_uuid
            ]
          );
        // Native producer completion survives customer channel destruction.
        const event = row.request.inboundFallback
          ? row.command_kind === "forward_external"
            ? receipt.producer === "finished"
              ? "inbound_forward_finished"
              : null
            : ["completed", "failed"].includes(receipt.producer)
              ? `inbound_fallback_${receipt.producer}`
              : null
          : row.request.inboundWaiting && receipt.producer === "started"
            ? "inbound_waiting_started"
            : null;
        if (event)
          await db.query(
            `insert into call_events(call_id,event_type,freeswitch_event_name,raw_json)
           select $1,$2,'RECOVERY_NATIVE_RECEIPT',$3 where not exists(select 1 from call_events where call_id=$1 and event_type=$2 and raw_json->>'operationId'=$4)`,
            [
              callId,
              event,
              {
                operationId: row.id,
                jobUuid: row.command_uuid,
                core: receipt.core,
                headers: { "outbound-dialer-operation-id": row.id },
                source: "native-command-journal"
              },
              row.id
            ]
          );
        await recoverBridgeEffect(db, row, command, valid);
      }
    }
    await acknowledgeCallReceipts(db, signal, callId, command, script);
  });
}

// Committed resolution authorizes exact, replayable ACK. The execution lock
// excludes current senders. Incoming ESL events only invalidate observations.
async function acknowledgeCallReceipts(
  db: pg.PoolClient,
  signal: AbortSignal,
  callId: string,
  command: (text: string) => Promise<string>,
  script?: string
) {
  const resolved = (
    await db.query(
      `select o.id,o.command_uuid,f.core_uuid from call_operations o join call_command_fences f on f.operation_id=o.id
       where o.call_id=$1 and o.resolved_at is not null and not exists(select 1 from call_command_receipt_acks a where a.operation_id=o.id)
       order by o.created_at,o.id limit 16`,
      [callId]
    )
  ).rows;
  for (const row of resolved) {
    if (signal.aborted) return;
    script ??= await commandJournalPath(command);
    if (signal.aborted) return;
    if ((await command(`lua ${script} ack ${row.core_uuid} ${row.command_uuid} ${row.id}`)).trim() !== "+OK")
      throw new Error("Native command journal ACK failed");
    if (signal.aborted) return;
    await db.query("insert into call_command_receipt_acks(operation_id) values($1) on conflict do nothing", [
      row.id
    ]);
  }
}

export async function acknowledgeResolvedCommandReceipts(
  pool: pg.Pool,
  executor: Pick<CallExecutor, "inspectCall">,
  command: (text: string) => Promise<string>
) {
  const pending = await pool.query<{ call_id: string }>(
    `select o.call_id from call_command_fences f join call_operations o on o.id=f.operation_id
     where o.resolved_at is not null and not exists(select 1 from call_command_receipt_acks a where a.operation_id=o.id)
     group by o.call_id order by min(o.resolved_at),o.call_id limit 16`
  );
  const errors: Array<{ callId: string; error: unknown }> = [];
  for (const { call_id: callId } of pending.rows) {
    try {
      await executor.inspectCall(callId, (db, signal) =>
        acknowledgeCallReceipts(db, signal, callId, command)
      );
    } catch (error) {
      errors.push({ callId, error });
    }
  }
  return errors;
}

async function recoverBridgeEffect(
  db: pg.PoolClient,
  op: DurableCommand,
  command: (text: string) => Promise<string>,
  current: () => boolean
) {
  const r = op.request;
  if (!r.inboundConnection && !r.transferOfferAcceptance) return;
  const uuid = String(r.agentUuid);
  if (!ingressUuid.test(uuid) || (await command(`uuid_exists ${uuid}`)).trim() !== "true") return;
  const action = String(r.transferAction ?? r.connectionAction ?? "originate");
  const dump = Object.fromEntries(
    (await command(`uuid_dump ${uuid}`)).split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf(": ");
      return separator < 0
        ? []
        : [[line.slice(0, separator).toLowerCase(), line.slice(separator + 2).trim()]];
    })
  );
  if (dump["unique-id"] !== uuid) return;
  // Live channel profile timing is authoritative. CDR epoch variables are not
  // guaranteed to exist before the channel has ended.
  const answered = /^[1-9][0-9]*$/.test(dump["caller-channel-answered-time"] ?? "");
  let effect = action === "originate" && answered;
  if (
    r.transferOfferAcceptance &&
    (await command(`uuid_getvar ${uuid} outbound_dialer_transfer_id`)).trim() !== r.transferId
  )
    return;
  if (action === "park")
    effect = (await command(`uuid_getvar ${op.call_id} current_application`)).trim() === "park";
  if (action === "bridge") effect = (await command(`uuid_getvar ${op.call_id} bridge_uuid`)).trim() === uuid;
  if (!effect || !current()) return;
  await withCallAdmission(db, { callIds: [op.call_id] }, async () => {
    if (!current()) throw new Error("recovery_observation_changed");
    const leg = (
      await db.query(
        "select l.*,p.left_at from call_legs l join call_participants p on p.id=l.participant_id where l.call_id=$1 and l.freeswitch_uuid=$2 and p.id=$3",
        [op.call_id, uuid, r.participantId]
      )
    ).rows[0];
    const call = (await db.query("select * from calls where id=$1", [op.call_id])).rows[0];
    if (!leg || leg.ended_at || leg.left_at || call.ended_at) return;
    if (answered)
      await db.query(
        "update call_legs set state='answered',answered_at=coalesce(answered_at,clock_timestamp()) where id=$1",
        [leg.id]
      );
    if (r.transferOfferAcceptance)
      await db.query(
        `insert into call_events(call_id,event_type,freeswitch_event_name,raw_json)
       select $1,'transfer_command_effect','RECOVERY_NATIVE_EFFECT',$2 where not exists(select 1 from call_events where call_id=$1 and event_type='transfer_command_effect' and raw_json->>'operationId'=$3)`,
        [op.call_id, { operationId: op.id, source: "native-probe-after-completed-journal-receipt" }, op.id]
      );
    else if (action === "bridge" && call.state === "connecting") {
      const slot = r.slot as SlotToken;
      if (call.agent_id !== slot.agentId || !(await updateAgentCallSlot(db, slot, "active"))) return;
      await db.query(
        "update call_participants set connected_at=coalesce(connected_at,clock_timestamp()) where id=$1",
        [leg.participant_id]
      );
      await db.query(
        "update calls set state='agent_connected',agent_connected_at=coalesce(agent_connected_at,clock_timestamp()),queue_exited_at=coalesce(queue_exited_at,clock_timestamp()) where id=$1",
        [op.call_id]
      );
      await db.query(
        "insert into call_events(call_id,event_type,freeswitch_event_name,raw_json) values($1,'inbound_connection_recovered','RECOVERY_NATIVE_EFFECT',$2)",
        [op.call_id, { operationId: op.id, peer: uuid }]
      );
    }
  });
}
