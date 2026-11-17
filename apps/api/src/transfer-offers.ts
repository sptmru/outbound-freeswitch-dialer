import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  AcceptCallOfferResponse,
  CreateTransferRequest,
  CreateTransferResponse,
  DeskMutationRequest,
  TransferSnapshot,
  TransferTargetsResponse
} from "@outbound-dialer/shared";
import {
  AdmissionDiscoveryChanged,
  AdmissionError,
  withCallAdmission,
  type CallAdmission
} from "./call-admission.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import { enqueueCallCommand } from "./call-executor.js";
import { expireInboundOffers } from "./call-offer-expiry.js";
import type { DeskActor } from "./desk-sessions.js";

export const transferOfferTimeoutMs = 20000;
type Desk = pg.QueryResultRow;
type TransferResponse = {
  status: "applied";
  revision: string;
  transfer?: TransferSnapshot;
  offerId?: string;
};

/** Discover both controllers and every pending source before the common lock order.
 * No network/media work occurs here. Changed graphs roll back and rediscover.
 */
async function withTransfer<T>(
  pool: pg.Pool,
  agentIds: string[],
  callId: string,
  work: (a: CallAdmission, desks: Desk[]) => Promise<T>
) {
  const db = await pool.connect();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const discover = async () => {
        const desks = (
          await db.query(
            "select *,expires_at>clock_timestamp() as controller_live from agent_desk_sessions where agent_id=any($1::uuid[]) and revoked_at is null order by agent_id",
            [agentIds]
          )
        ).rows;
        const pending = (
          await db.query(
            "select distinct call_id from call_offers where agent_id=any($1::uuid[]) and state='pending' order by call_id",
            [agentIds]
          )
        ).rows.map((r) => r.call_id);
        return { desks, pending };
      };
      const before = await discover();
      const identity = (x: typeof before) =>
        JSON.stringify({
          pending: x.pending,
          desks: x.desks.map((d) => [d.id, d.campaign_id, d.revision, d.binding_generation])
        });
      try {
        return await withCallAdmission(
          db,
          {
            startsCall: true,
            allowPausedReplay: true,
            agentIds,
            campaignIds: before.desks.map((d) => d.campaign_id).filter(Boolean),
            callIds: [...new Set([callId, ...before.pending])]
          },
          async (a) => {
            const fresh = await discover();
            if (identity(before) !== identity(fresh)) throw new AdmissionDiscoveryChanged();
            await expireInboundOffers(db, agentIds, [callId]);
            return work(a, fresh.desks);
          }
        );
      } catch (error) {
        if (!(error instanceof AdmissionDiscoveryChanged) || attempt === 2) throw error;
      }
    }
    throw new AdmissionDiscoveryChanged();
  } finally {
    db.release();
  }
}
async function verifyActor(a: CallAdmission, actor: DeskActor) {
  const row = (
    await a.client.query(
      "select 1 from agents a join users u on u.id=a.user_id where a.id=$1 and u.id=$2 and u.is_active and u.auth_version=$3",
      [actor.agentId, actor.userId, actor.authVersion]
    )
  ).rowCount;
  if (!row) throw new AdmissionError("session_revoked");
}
function controller(
  desks: Desk[],
  actor: DeskActor,
  input: Pick<DeskMutationRequest, "deskSessionId"> & Partial<DeskMutationRequest>
) {
  const d = desks.find((d) => d.agent_id === actor.agentId);
  if (!d || d.id !== input.deskSessionId || d.actor_auth_version !== actor.authVersion || !d.controller_live)
    throw new AdmissionError("not_controller");
  if (
    input.expectedRevision !== undefined &&
    (d.revision !== input.expectedRevision || d.binding_generation !== input.bindingGeneration)
  )
    throw new AdmissionError("revision_conflict");
  return d;
}
async function source(a: CallAdmission, callId: string, agentId: string, participantId?: string) {
  const row = (
    await a.client.query(
      `select c.*,p.id as source_participant_id,l.freeswitch_uuid as source_uuid,customer.freeswitch_uuid as customer_uuid,
      s.reservation_id as source_reservation_id,s.generation as source_generation
    from calls c join agent_call_slots s on s.call_id=c.id and s.agent_id=c.agent_id
    join call_participants p on p.id=s.participant_id and p.call_id=c.id and p.agent_id=c.agent_id
    join call_legs l on l.participant_id=p.id and l.call_id=c.id and l.type='agent'
    join call_legs customer on customer.call_id=c.id and customer.type='customer'
    where c.id=$1 and c.agent_id=$2 and c.ended_at is null and c.agent_released_at is null
      and p.origin='native' and c.state in ('bridged','agent_connected')
      and s.state='active' and not s.reconciliation_required and p.connected_at is not null and p.left_at is null
      and l.ended_at is null and customer.ended_at is null and l.freeswitch_uuid is not null and customer.freeswitch_uuid is not null
      and ($3::uuid is null or p.id=$3)`,
      [callId, agentId, participantId ?? null]
    )
  ).rows[0];
  if (!row) throw new AdmissionError("not_owner");
  return row;
}
async function recipient(a: CallAdmission, desks: Desk[], agentId: string, offerId?: string) {
  const d = desks.find((d) => d.agent_id === agentId);
  if (!d?.campaign_id) throw new AdmissionError("endpoint_unavailable");
  const user = (await a.client.query("select user_id from agents where id=$1", [agentId])).rows[0];
  const input = {
    agentId,
    userId: user.user_id,
    campaignId: d.campaign_id,
    deskSessionId: d.id,
    expectedRevision: d.revision,
    bindingGeneration: d.binding_generation,
    offerId
  };
  const decision = await a.eligibility(input);
  if (!decision.eligible) throw new AdmissionError(decision.reason!);
  return { desk: d, input };
}
const snapshot = (t: Desk): TransferSnapshot => ({
  id: t.id,
  callId: t.call_id,
  sourceAgentId: t.source_agent_id,
  recipientAgentId: t.recipient_agent_id,
  state: t.state,
  deadlineAt: t.deadline_at.toISOString()
});
async function replay<T>(
  a: CallAdmission,
  actor: DeskActor,
  key: string,
  fingerprint: string
): Promise<T | undefined> {
  const r = (
    await a.client.query(
      "select * from transfer_offer_mutations where actor_user_id=$1 and idempotency_key=$2",
      [actor.userId, key]
    )
  ).rows[0];
  if (!r) return undefined;
  if (r.request_fingerprint !== fingerprint) throw new AdmissionError("idempotency_conflict");
  return r.response;
}
async function remember(
  a: CallAdmission,
  actor: DeskActor,
  input: DeskMutationRequest,
  fingerprint: string,
  transferId: string,
  response: unknown
) {
  await a.client.query(
    "insert into transfer_offer_mutations(actor_user_id,idempotency_key,transfer_id,request_fingerprint,response) values($1,$2,$3,$4,$5)",
    [actor.userId, input.idempotencyKey, transferId, fingerprint, response]
  );
}

export async function createTransferOffer(
  pool: pg.Pool,
  actor: DeskActor,
  callId: string,
  input: CreateTransferRequest
): Promise<CreateTransferResponse> {
  return withTransfer(pool, [actor.agentId, input.recipientAgentId], callId, async (a, desks) => {
    await verifyActor(a, actor);
    const fingerprint = requestFingerprint("POST", "/agent/calls/:callId/transfers", callId, input);
    const old = await replay<CreateTransferResponse>(a, actor, input.idempotencyKey, fingerprint);
    if (old) return old;
    const d = controller(desks, actor, input);
    if (a.startPaused) throw new AdmissionError("maintenance");
    if (actor.agentId === input.recipientAgentId) throw new AdmissionError("not_owner");
    const c = await source(a, callId, actor.agentId);
    await recipient(a, desks, input.recipientAgentId);
    if (
      (await a.client.query("select 1 from call_transfers where call_id=$1 and closed_at is null", [callId]))
        .rowCount
    )
      throw new AdmissionError("transfer_in_progress");
    if (
      (
        await a.client.query("select 1 from call_offers where agent_id=$1 and state='pending'", [
          input.recipientAgentId
        ])
      ).rowCount
    )
      throw new AdmissionError("incoming_pending");
    const t = (
      await a.client.query(
        `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,deadline_at)
      values($1,coalesce((select max(attempt) from call_transfers where call_id=$1),0)+1,$2,$3,$4,clock_timestamp()+make_interval(secs=>$5/1000.0)) returning *`,
        [callId, actor.agentId, c.source_participant_id, input.recipientAgentId, transferOfferTimeoutMs]
      )
    ).rows[0];
    const rd = desks.find((d) => d.agent_id === input.recipientAgentId)!;
    const offer = (
      await a.client.query(
        `insert into call_offers(call_id,kind,transfer_id,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at)
      values($1,'transfer',$2,$3,coalesce((select max(attempt) from call_offers where call_id=$1 and agent_id=$3 and kind='transfer'),0)+1,$4,$5,$6,$7) returning id`,
        [callId, t.id, input.recipientAgentId, rd.id, rd.revision, rd.binding_generation, t.deadline_at]
      )
    ).rows[0];
    const response: CreateTransferResponse = {
      status: "applied",
      revision: d.revision,
      transfer: snapshot(t),
      offerId: offer.id
    };
    await remember(a, actor, input, fingerprint, t.id, response);
    return response;
  });
}

export async function readTransferTargets(
  pool: pg.Pool,
  actor: DeskActor,
  callId: string,
  deskSessionId: string
): Promise<TransferTargetsResponse> {
  // Bounded hint only; each create request revalidates its one selected recipient.
  const candidates = (
    await pool.query("select id,display_name from agents where id<>$1 order by id limit 100", [actor.agentId])
  ).rows;
  return withTransfer(pool, [actor.agentId, ...candidates.map((r) => r.id)], callId, async (a, desks) => {
    await verifyActor(a, actor);
    const d = controller(desks, actor, { deskSessionId });
    await source(a, callId, actor.agentId);
    const items: TransferTargetsResponse["items"] = [];
    for (const row of candidates) {
      let reason: string | null = a.startPaused ? "coordination_unavailable" : null;
      if (!reason)
        try {
          await recipient(a, desks, row.id);
          if (
            (
              await a.client.query("select 1 from call_offers where agent_id=$1 and state='pending'", [
                row.id
              ])
            ).rowCount
          )
            reason = "incoming_pending";
        } catch (error) {
          if (!(error instanceof AdmissionError)) throw error;
          reason = error.reason;
        }
      items.push({ agentId: row.id, name: row.display_name, available: reason === null, reason });
    }
    return { revision: d.revision, items };
  });
}

export async function mutateTransferOffer(
  pool: pg.Pool,
  actor: DeskActor,
  id: string,
  input: DeskMutationRequest,
  action: "accept" | "ignore" | "cancel",
  callId?: string,
  checkpoint?: (a: CallAdmission) => Promise<void>
): Promise<TransferResponse | AcceptCallOfferResponse | { conflict: string }> {
  const found = (
    await pool.query(
      action === "cancel"
        ? "select t.*,o.id as offer_id from call_transfers t join call_offers o on o.transfer_id=t.id where t.id=$1 and t.call_id=$2 and t.source_agent_id=$3"
        : "select t.*,o.id as offer_id from call_offers o join call_transfers t on t.id=o.transfer_id where o.id=$1 and o.agent_id=$2",
      action === "cancel" ? [id, callId, actor.agentId] : [id, actor.agentId]
    )
  ).rows[0];
  if (!found) throw new AdmissionError("not_owner");
  return withTransfer(
    pool,
    [found.source_agent_id, found.recipient_agent_id],
    found.call_id,
    async (a, desks) => {
      await verifyActor(a, actor);
      const fingerprint = requestFingerprint(
        action === "cancel" ? "DELETE" : "POST",
        action === "cancel"
          ? "/agent/calls/:callId/transfers/:transferId"
          : `/agent/call-offers/:offerId/${action}`,
        id,
        { ...input, callId: callId ?? null }
      );
      const old = await replay<TransferResponse | AcceptCallOfferResponse>(
        a,
        actor,
        input.idempotencyKey,
        fingerprint
      );
      if (old) return old;
      const d = controller(desks, actor, input);
      const t = (await a.client.query("select * from call_transfers where id=$1", [found.id])).rows[0];
      const o = (await a.client.query("select * from call_offers where id=$1", [found.offer_id])).rows[0];
      if (action === "accept" && t.operation_id) {
        const op = (await a.client.query("select request from call_operations where id=$1", [t.operation_id]))
          .rows[0];
        if (
          op.request.intent.deskSessionId !== input.deskSessionId ||
          op.request.intent.expectedRevision !== input.expectedRevision ||
          op.request.intent.bindingGeneration !== input.bindingGeneration
        )
          throw new AdmissionError("revision_conflict");
        await remember(a, actor, input, fingerprint, t.id, op.request.response);
        return op.request.response as AcceptCallOfferResponse;
      }
      if (t.state !== "offered" || o.state !== "pending")
        return { conflict: t.state === "expired" ? "offer_expired" : "offer_closed" };
      if (
        action !== "cancel" &&
        (o.desk_session_id !== d.id ||
          o.desk_revision !== d.revision ||
          o.binding_generation !== d.binding_generation)
      )
        throw new AdmissionError("revision_conflict");
      let connectedSource: Desk;
      try {
        connectedSource = await source(a, t.call_id, t.source_agent_id, t.source_participant_id);
      } catch (error) {
        if (!(error instanceof AdmissionError)) throw error;
        await close("canceled", "call_closed");
        return { conflict: "offer_closed" };
      }
      if (action !== "accept") {
        await close(
          action === "ignore" ? "declined" : "canceled",
          action === "ignore" ? "user_declined" : "source_canceled"
        );
        const response = { status: "applied" as const, revision: d.revision as string };
        await remember(a, actor, input, fingerprint, t.id, response);
        return response;
      }
      if (a.startPaused) throw new AdmissionError("maintenance");
      const { desk: rd, input: eligibility } = await recipient(a, desks, actor.agentId, o.id);
      const participantId = randomUUID(),
        agentUuid = randomUUID(),
        operationId = randomUUID();
      await a.client.query(
        "insert into call_participants(id,call_id,role,agent_id,joined_at) values($1,$2,'agent',$3,clock_timestamp())",
        [participantId, t.call_id, actor.agentId]
      );
      const slot = await a.reserve(eligibility, t.call_id, participantId);
      await a.transition(slot, "connecting");
      const leg = (
        await a.client.query(
          "insert into call_legs(call_id,type,participant_id,freeswitch_uuid,sip_uri,state) values($1,'agent',$2,$3,$4,'created') returning id",
          [t.call_id, participantId, agentUuid, rd.verified_endpoint]
        )
      ).rows[0];
      const response: AcceptCallOfferResponse = {
        status: "connecting",
        revision: d.revision,
        callId: t.call_id,
        operationId,
        offerId: o.id
      };
      await enqueueCallCommand(a, {
        id: operationId,
        callId: t.call_id,
        scope: `transfer:${t.id}`,
        key: "accept",
        fingerprint,
        kind: "rebridge",
        generation: slot.generation,
        commandUuid: randomUUID(),
        targetUuid: agentUuid,
        request: {
          transferOfferAcceptance: true,
          transferId: t.id,
          participantId,
          agentUuid,
          slot,
          endpoint: rd.verified_endpoint,
          sipUsername: rd.sip_username,
          actorUserId: actor.userId,
          actorAuthVersion: actor.authVersion,
          intent: input,
          response,
          sourceParticipantId: t.source_participant_id,
          sourceAgentId: t.source_agent_id,
          sourceUuid: connectedSource.source_uuid,
          customerUuid: connectedSource.customer_uuid,
          sourceSlot: {
            agentId: t.source_agent_id,
            callId: t.call_id,
            reservationId: connectedSource.source_reservation_id,
            generation: connectedSource.source_generation
          }
        },
        deadline: (await a.client.query("select clock_timestamp()+interval '10 seconds' as at")).rows[0].at
      });
      await a.client.query("update call_transfers set state='connecting',operation_id=$2 where id=$1", [
        t.id,
        operationId
      ]);
      await a.client.query(
        "update call_offers set state='accepted',reason='user_accepted',closed_at=clock_timestamp() where id=$1",
        [o.id]
      );
      await a.client.query("update agents set status='in_call',wrap_up_until=null where id=$1", [
        actor.agentId
      ]);
      await a.capacity.claim({
        kind: "transfer",
        callId: t.call_id,
        operationId,
        generation: slot.generation,
        agentId: actor.agentId,
        callLegId: leg.id
      });
      await remember(a, actor, input, fingerprint, t.id, response);
      await checkpoint?.(a);
      return response;
      async function close(state: string, reason: string) {
        await a.client.query(
          "update call_transfers set state=$2,reason=$3,closed_at=clock_timestamp() where id=$1 and state='offered'",
          [t.id, state, reason]
        );
        await a.client.query(
          "update call_offers set state=$2,reason=$3,closed_at=clock_timestamp() where id=$1 and state='pending'",
          [o.id, state, reason]
        );
      }
    }
  );
}
