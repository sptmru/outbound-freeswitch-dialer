import type { AutomaticStartIntent, DeferredAutoNextIntentSnapshot } from "@outbound-dialer/shared";
import type { CallAdmission } from "./call-admission.js";
import { ManualOutboundError, type ManualOutboundAdmission } from "./manual-outbound.js";

export type AutoNextWaiting =
  | {
      status: "deferred";
      revision: string;
      reason: "incoming_pending";
      intent: DeferredAutoNextIntentSnapshot;
    }
  | { status: "canceled"; revision: string; reason: string };

/** Called only inside ordered admission with source, agent, user and campaign
 * locked. A source identity outlives tabs, retry keys and the resulting call.
 * No ESL and no contact selection is allowed before this decision.
 */
export async function prepareAutoNext(
  a: CallAdmission,
  input: {
    actorUserId: string;
    agentId: string;
    campaignId: string;
    intent: AutomaticStartIntent;
    fingerprint: string;
  }
): Promise<{ id: string; result?: AutoNextWaiting | ManualOutboundAdmission }> {
  const { agentId, campaignId, intent } = input,
    c = a.client;
  a.assertExecutionCall(intent.sourceCallId);
  const old = (
    await c.query(
      `select * from agent_auto_next_intents where (agent_id=$1 and source_call_id=$2) or idempotency_key=$3 order by id for update`,
      [agentId, intent.sourceCallId, intent.idempotencyKey]
    )
  ).rows;
  if (old.length > 1 || old.some((i) => i.agent_id !== agentId || i.source_call_id !== intent.sourceCallId))
    throw new ManualOutboundError("idempotency_conflict");
  let stored = old[0];
  if (stored?.request_fingerprint && stored.request_fingerprint !== input.fingerprint)
    throw new ManualOutboundError("idempotency_conflict");
  if (stored?.state === "started") {
    const op = (await c.query("select request from call_operations where id=$1", [stored.operation_id]))
      .rows[0];
    if (!op?.request.admission) throw new ManualOutboundError("coordination_unavailable");
    return { id: stored.id, result: { ...op.request.admission, replayed: true } };
  }
  const canceled = (reason: string): AutoNextWaiting => ({
    status: "canceled",
    revision: intent.expectedRevision,
    reason
  });
  if (stored?.state === "canceled") return { id: stored.id, result: canceled(stored.reason) };
  // Owner must still be the agent and there must be no completed handover. A
  // transferred-in call and a handed-over participation are never completions.
  // Voicemail is eligible only after the persisted confirmed agent release.
  const source = (
    await c.query(
      `select c.* from calls c where c.id=$1
    and c.agent_id=$2 and c.campaign_id=$3 and c.direction='outbound' and not c.manual_dial and c.contact_id is not null
    and ((c.ended_at is not null and c.state in ('completed','failed','canceled'))
      or (c.agent_released_at is not null and c.state in ('agent_released','voicemail_playback_started','voicemail_playback_completed')
        and exists(select 1 from call_events e where e.call_id=c.id and e.agent_id=$2 and e.event_type='agent_released')
        and exists(select 1 from call_legs l where l.call_id=c.id and l.type='agent' and l.state='ended' and l.ended_at is not null)))
    and not exists(select 1 from call_transfers t where t.call_id=c.id and t.state='completed')`,
      [intent.sourceCallId, agentId, campaignId]
    )
  ).rows[0];
  if (!source) throw new ManualOutboundError("invalid_source");
  if (
    !stored &&
    !(
      await c.query("select 1 from agent_desk_sessions where id=$1 and agent_id=$2", [
        intent.deskSessionId,
        agentId
      ])
    ).rowCount
  )
    throw new ManualOutboundError("not_controller");
  if (!stored) {
    stored = (
      await c.query(
        `insert into agent_auto_next_intents(agent_id,source_call_id,campaign_id,desk_session_id,desk_revision,idempotency_key,request_fingerprint,binding_generation)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [
          agentId,
          intent.sourceCallId,
          campaignId,
          intent.deskSessionId,
          intent.expectedRevision,
          intent.idempotencyKey,
          input.fingerprint,
          intent.bindingGeneration
        ]
      )
    ).rows[0];
  }
  async function cancel(reason: string) {
    await c.query(
      "update agent_auto_next_intents set state='canceled',reason=$2,closed_at=clock_timestamp() where id=$1",
      [stored.id, reason]
    );
    return { id: stored.id as string, result: canceled(reason) };
  }
  if (!stored.request_fingerprint || !stored.binding_generation) return cancel("unknown_legacy_identity");
  const campaign = (
    await c.query("select auto_advance_to_next_lead_enabled from campaigns where id=$1", [campaignId])
  ).rows[0];
  if (!campaign?.auto_advance_to_next_lead_enabled) return cancel("automatic_disabled");
  const decision = await a.eligibility({
    agentId,
    userId: input.actorUserId,
    campaignId,
    deskSessionId: intent.deskSessionId,
    expectedRevision: intent.expectedRevision,
    bindingGeneration: intent.bindingGeneration
  });
  if (!decision.eligible) return cancel(decision.reason!);
  if (!(await c.query("select 1 from agents where id=$1 and registered", [agentId])).rowCount)
    return cancel("endpoint_unavailable");
  if (a.startPaused) throw new ManualOutboundError("maintenance");
  // A deferred callback cannot survive another admitted call even when that call
  // has already ended. Native acceptance/manual paths cancel eagerly as well.
  if (
    (
      await c.query(
        `select 1 from calls where agent_id=$1 and id<>$2 and created_at>= $3
    union all select 1 from call_offers where agent_id=$1 and state='accepted' and closed_at >= $3 limit 1`,
        [agentId, intent.sourceCallId, source.agent_released_at ?? source.ended_at]
      )
    ).rowCount
  )
    return cancel("work_superseded");
  const pendingTransfer = await c.query(
    `select 1 from call_offers where agent_id=$1 and kind='transfer' and state='pending' and deadline_at>clock_timestamp()`,
    [agentId]
  );
  if (decision.queuedCallIds.length || pendingTransfer.rowCount) {
    await c.query(
      "update agent_auto_next_intents set state='deferred',reason='incoming_pending' where id=$1",
      [stored.id]
    );
    return {
      id: stored.id,
      result: {
        status: "deferred",
        revision: intent.expectedRevision,
        reason: "incoming_pending",
        intent: {
          id: stored.id,
          sourceCallId: intent.sourceCallId,
          state: "deferred",
          reason: "incoming_pending",
          callId: null
        }
      }
    };
  }
  return { id: stored.id };
}
