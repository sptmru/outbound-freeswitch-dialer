import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AcceptCallOfferResponse, DeskMutationRequest } from "@outbound-dialer/shared";
import { AdmissionError, type CallAdmission } from "./call-admission.js";
import { enqueueCallCommand } from "./call-executor.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import { withOfferRecipient } from "./inbound-dispatcher.js";
import type { DeskActor } from "./desk-sessions.js";

export const inboundConnectionPolicy = Object.freeze({
  connectMs: 10000,
  retries: 2,
  retryInitialMs: 500,
  retryMaxMs: 2000
});
export function inboundRetryDelay(attempt: number, now: number, deadline: number) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > inboundConnectionPolicy.retries) return null;
  const ms = Math.min(
    inboundConnectionPolicy.retryMaxMs,
    inboundConnectionPolicy.retryInitialMs * 2 ** (attempt - 1)
  );
  return now + ms + inboundConnectionPolicy.connectMs <= deadline ? ms : null;
}
const route = "/agent/call-offers/:offerId/accept";

/** SQL-only winner. Every command/UUID/slot/capacity claim commits before wake.
 * Exact HTTP replay returns the original connecting identity, even after cleanup.
 */
export async function acceptInboundOffer(
  pool: pg.Pool,
  actor: DeskActor,
  offerId: string,
  input: DeskMutationRequest,
  checkpoint?: (a: CallAdmission) => Promise<void>
): Promise<AcceptCallOfferResponse | { conflict: string }> {
  const found = (
    await pool.query("select call_id from call_offers where id=$1 and agent_id=$2 and kind='inbound'", [
      offerId,
      actor.agentId
    ])
  ).rows[0];
  if (!found) throw new AdmissionError("not_owner");
  const fingerprint = requestFingerprint("POST", route, offerId, input);
  try {
    return await withOfferRecipient(pool, actor.agentId, [found.call_id], async (a, desk) => {
      const db = a.client;
      const user = (
        await db.query("select u.* from users u join agents a on a.user_id=u.id where u.id=$1 and a.id=$2", [
          actor.userId,
          actor.agentId
        ])
      ).rows[0];
      if (!user?.is_active || user.auth_version !== actor.authVersion)
        throw new AdmissionError("session_revoked");
      const old = (
        await db.query(
          `select m.request_fingerprint,o.request->'response' as response from call_offer_accept_mutations m
      join inbound_connection_attempts x on x.offer_id=m.offer_id join call_operations o on o.id=x.operation_id
      where m.actor_user_id=$1 and m.idempotency_key=$2`,
          [actor.userId, input.idempotencyKey]
        )
      ).rows[0];
      if (old) {
        if (old.request_fingerprint !== fingerprint) throw new AdmissionError("idempotency_conflict");
        return old.response as AcceptCallOfferResponse;
      }
      // A fresh key for the same accepted offer is also a replay, never a new attempt.
      const accepted = (
        await db.query(
          `select o.request from inbound_connection_attempts x join call_operations o on o.id=x.operation_id where x.offer_id=$1`,
          [offerId]
        )
      ).rows[0];
      if (accepted) {
        const previous = accepted.request.intent;
        if (
          previous.deskSessionId !== input.deskSessionId ||
          previous.expectedRevision !== input.expectedRevision ||
          previous.bindingGeneration !== input.bindingGeneration
        )
          throw new AdmissionError("revision_conflict");
        await recordMutation();
        return accepted.request.response as AcceptCallOfferResponse;
      }
      if (a.startPaused) throw new AdmissionError("maintenance");
      if (!desk || desk.id !== input.deskSessionId || desk.actor_auth_version !== actor.authVersion)
        throw new AdmissionError("not_controller");
      const call = (
        await db.query(
          `select *,queue_deadline_at>=clock_timestamp()+interval '10 seconds' as budget from calls where id=$1`,
          [found.call_id]
        )
      ).rows[0];
      const eligibility = {
        agentId: actor.agentId,
        userId: actor.userId,
        campaignId: call.campaign_id,
        ...input,
        offerId
      };
      const decision = await a.eligibility(eligibility);
      if (!decision.eligible) return { conflict: decision.reason! };
      const previous = (
        await db.query(
          "select * from inbound_connection_attempts where call_id=$1 order by attempt desc limit 1",
          [call.id]
        )
      ).rows[0];
      const due =
        !previous ||
        (previous.outcome === "requeued" &&
          (await db.query("select $1::timestamptz<=clock_timestamp() as due", [previous.retry_at])).rows[0]
            .due);
      if (!call.budget || !due || (previous?.attempt ?? 0) >= 3) return { conflict: "offer_closed" };
      // Waiting admission must have finished. No connection command can overtake it.
      if (
        !(
          await db.query(
            `select 1 from inbound_queue_admissions q join call_operations o on o.id=q.operation_id
      join call_legs l on l.call_id=q.call_id and l.type='customer'
      where q.call_id=$1 and o.state='succeeded' and l.freeswitch_uuid=$1::text and l.ended_at is null`,
            [call.id]
          )
        ).rowCount
      )
        return { conflict: "coordination_unavailable" };
      const participantId = randomUUID(),
        agentUuid = randomUUID(),
        operationId = randomUUID(),
        bridgeId = randomUUID(),
        guardId = randomUUID();
      await db.query(
        "insert into call_participants(id,call_id,role,agent_id,joined_at) values($1,$2,'agent',$3,clock_timestamp())",
        [participantId, call.id, actor.agentId]
      );
      const slot = await a.reserve(eligibility, call.id, participantId);
      await a.transition(slot, "connecting");
      const leg = (
        await db.query(
          "insert into call_legs(call_id,type,participant_id,freeswitch_uuid,sip_uri,state) values($1,'agent',$2,$3,$4,'created') returning id",
          [call.id, participantId, agentUuid, desk.verified_endpoint]
        )
      ).rows[0].id;
      const response: AcceptCallOfferResponse = {
        status: "connecting",
        revision: desk.revision,
        callId: call.id,
        operationId,
        offerId
      };
      const deadline = (await db.query("select clock_timestamp()+interval '10 seconds' as at")).rows[0].at;
      const request = {
        inboundConnection: true,
        rootOperationId: operationId,
        participantId,
        agentUuid,
        slot,
        endpoint: desk.verified_endpoint,
        sipUsername: desk.sip_username,
        actorUserId: actor.userId,
        actorAuthVersion: actor.authVersion,
        intent: input,
        response
      };
      for (const [id, kind, action, parent, target] of [
        [operationId, "originate", "originate", null, agentUuid],
        [bridgeId, "bridge", "bridge", operationId, call.id],
        [guardId, "play_audio", "cancel_guard", bridgeId, call.id]
      ] as const)
        await enqueueCallCommand(a, {
          id,
          callId: call.id,
          scope: `inbound-connection:${offerId}`,
          key: action,
          fingerprint,
          kind,
          generation: slot.generation,
          commandUuid: randomUUID(),
          targetUuid: target,
          request: { ...request, connectionAction: action, dependsOn: parent },
          deadline
        });
      await db.query(
        "insert into inbound_connection_attempts(offer_id,call_id,agent_id,attempt,participant_id,operation_id,bridge_operation_id,guard_operation_id,deadline_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          offerId,
          call.id,
          actor.agentId,
          (previous?.attempt ?? 0) + 1,
          participantId,
          operationId,
          bridgeId,
          guardId,
          deadline
        ]
      );
      await recordMutation();
      await db.query(
        "update call_offers set state='accepted',reason='user_accepted',closed_at=clock_timestamp() where id=$1",
        [offerId]
      );
      await db.query(
        `with stamp as materialized(select clock_timestamp() at)
        update call_offers set state=case when deadline_at<=stamp.at then 'expired' else 'canceled' end,
          reason=case when deadline_at<=stamp.at then 'deadline_elapsed' else 'winner_accepted' end,
          closed_at=stamp.at from stamp where call_id=$1 and kind='inbound' and state='pending'`,
        [call.id]
      );
      await db.query(
        "update calls set state='connecting',agent_id=$2,updated_at=clock_timestamp() where id=$1",
        [call.id, actor.agentId]
      );
      await db.query("update agents set status='in_call',wrap_up_until=null where id=$1", [actor.agentId]);
      await a.capacity.claim({
        kind: "browser",
        callId: call.id,
        agentId: actor.agentId,
        operationId,
        generation: slot.generation,
        callLegId: leg
      });
      await db.query(
        "insert into call_events(call_id,agent_id,event_type,state,raw_json) values($1,$2,'inbound_offer_accepted','connecting',$3)",
        [call.id, actor.agentId, response]
      );
      await checkpoint?.(a);
      return response;
      async function recordMutation() {
        await db.query(
          "insert into call_offer_accept_mutations(actor_user_id,idempotency_key,offer_id,request_fingerprint) values($1,$2,$3,$4)",
          [actor.userId, input.idempotencyKey, offerId, fingerprint]
        );
      }
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["55P03", "57014"].includes(String(error.code))
    )
      return { conflict: "coordination_unavailable" };
    throw error;
  }
}
