// Real schema and product authorization; claims/acceptance/sender evidence are
// explicitly seeded here. This is NOT an E02/G02 executor or provider fixture.
import { randomUUID } from "node:crypto";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
import { enqueueCallCommand } from "../../../apps/api/dist-test/call-executor.js";

export async function serviceOperation(f, seeded, sessionId, direction = "outbound", accepted = true) {
  const d = (await f.pool.query("select * from agent_desk_sessions where id=$1", [sessionId])).rows[0];
  const u = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
  const slot =
    seeded.slot ??
    (
      await f.pool.query(
        "select agent_id,call_id,reservation_id,generation from agent_call_slots where agent_id=$1",
        [f.agentId]
      )
    ).rows.map((s) => ({
      agentId: s.agent_id,
      callId: s.call_id,
      reservationId: s.reservation_id,
      generation: s.generation
    }))[0];
  const id = randomUUID(),
    bridge = randomUUID(),
    guard = randomUUID();
  const db = await f.pool.connect();
  try {
    await withCallAdmission(db, { callIds: [seeded.callId], agentIds: [f.agentId] }, async (a) => {
      await enqueueCallCommand(a, {
        id,
        callId: seeded.callId,
        scope: "service-invite-fixture",
        key: randomUUID(),
        fingerprint: "d".repeat(64),
        kind: direction === "transfer" ? "rebridge" : "originate",
        generation: slot.generation,
        commandUuid: randomUUID(),
        targetUuid: seeded.agentUuid,
        deadline: new Date(Date.now() + 60000),
        request: {
          slot,
          participantId: seeded.participantId,
          agentUuid: seeded.agentUuid,
          intent: {
            deskSessionId: d.id,
            bindingGeneration: d.binding_generation,
            expectedRevision: d.revision
          },
          endpoint: d.verified_endpoint,
          sipUsername: d.sip_username,
          actorUserId: u.id,
          actorAuthVersion: u.auth_version,
          ...(direction === "outbound" ? { admission: { operationId: id, callId: seeded.callId } } : {}),
          ...(direction === "inbound"
            ? { inboundConnection: true, connectionAction: "originate", rootOperationId: id }
            : {})
        }
      });
      if (direction === "inbound") {
        await db.query("update calls set state='connecting' where id=$1", [seeded.callId]);
        for (const [child, kind] of [
          [bridge, "bridge"],
          [guard, "play_audio"]
        ]) {
          await enqueueCallCommand(a, {
            id: child,
            callId: seeded.callId,
            scope: "service-invite-fixture",
            key: randomUUID(),
            fingerprint: "d".repeat(64),
            kind,
            generation: slot.generation,
            commandUuid: randomUUID(),
            targetUuid: seeded.customerUuid,
            request: {},
            deadline: new Date(Date.now() + 60000)
          });
          await db.query(
            "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='fixture only; no executor' where id=$1",
            [child]
          );
        }
      }
      if (direction === "transfer") {
        // The caller must create the source participant and real overlap slots.
        // Make a fresh transfer only when no prior unfinished request exists.
        await db.query(
          "update call_transfers set state='canceled',closed_at=clock_timestamp(),reason='fixture_replaced_before_send' where id=$1",
          [seeded.transferId]
        );
        const old = (await db.query("select * from call_transfers where id=$1", [seeded.transferId])).rows[0];
        seeded.transferId = randomUUID();
        await db.query(
          "insert into call_transfers(id,call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,operation_id,state,deadline_at) values($1,$2,2,$3,$4,$5,$6,'connecting',clock_timestamp()+interval '1 minute')",
          [seeded.transferId, seeded.callId, old.source_agent_id, old.source_participant_id, f.agentId, id]
        );
      }
      if (direction !== "outbound") {
        const offer = randomUUID();
        await db.query(
          `insert into call_offers(id,call_id,kind,transfer_id,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,state,reason,closed_at)
          values($1,$2,$3,$4,$5,1,$6,$7,$8,clock_timestamp()+interval '1 minute',$9,$10,case when $9='accepted' then clock_timestamp() end)`,
          [
            offer,
            seeded.callId,
            direction === "transfer" ? "transfer" : "inbound",
            seeded.transferId ?? null,
            f.agentId,
            d.id,
            d.revision,
            d.binding_generation,
            accepted ? "accepted" : "pending",
            accepted ? "user_accepted" : null
          ]
        );
        if (direction === "inbound")
          await db.query(
            "insert into inbound_connection_attempts(offer_id,call_id,agent_id,attempt,participant_id,operation_id,bridge_operation_id,guard_operation_id,deadline_at) values($1,$2,$3,1,$4,$5,$6,$7,clock_timestamp()+interval '1 minute')",
            [offer, seeded.callId, f.agentId, seeded.participantId, id, bridge, guard]
          );
      }
      await db.query("update call_operations set state='uncertain' where id=$1", [id]);
      await db.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
        [id, randomUUID()]
      );
    });
  } finally {
    db.release();
  }
  const operation = (await f.pool.query("select * from call_operations where id=$1", [id])).rows[0];
  const input = {
    callId: seeded.callId,
    operationId: id,
    deskSessionId: d.id,
    bindingGeneration: d.binding_generation,
    legUuid: seeded.agentUuid,
    dialogId: randomUUID()
  };
  return { operation, input };
}
