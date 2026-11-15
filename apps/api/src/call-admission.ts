import type pg from "pg";
import {
  releaseAgentCallSlot,
  reserveAgentCallSlot,
  updateAgentCallSlot,
  type OccupiedSlotState,
  type SlotToken
} from "./agent-call-slots.js";
import { lockUserMediaAction } from "./user-media-lock.js";
import { lockCampaignVoicemail } from "./dashboard/recordings.js";
import { CallCapacity } from "./call-capacity.js";

// A01 namespace; distinct from user media (72201) and execution (A05/C03).
export const ADMISSION_LOCK_NAMESPACE = 72_202;
export class AdmissionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export class AdmissionDiscoveryChanged extends AdmissionError {
  constructor() {
    super("discovery_changed");
  }
}
export interface AdmissionResources {
  agentIds?: string[];
  callIds?: string[];
  campaignIds?: string[];
  userIds?: string[];
  audioCampaignIds?: string[];
}
const sorted = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))].sort();

// Discovery is not authorization. Re-read this exact set under the ordered locks.
// The caller must also rediscover/reacquire rank-0 execution locks on a changed set.
export async function discoverAdmissionResources(client: pg.PoolClient, input: AdmissionResources) {
  const callIds = sorted(input.callIds ?? []);
  const calls = (
    await client.query(`select id,agent_id,campaign_id from calls where id=any($1::uuid[]) order by id`, [
      callIds
    ])
  ).rows;
  const participants = (
    await client.query(
      `select id,call_id,agent_id,role,left_at from call_participants
     where call_id=any($1::uuid[]) order by id`,
      [callIds]
    )
  ).rows;
  const transfers = (
    await client.query(
      `select id,call_id,source_agent_id,recipient_agent_id from call_transfers
     where call_id=any($1::uuid[]) and closed_at is null order by id`,
      [callIds]
    )
  ).rows;
  const supervisors = (
    await client.query(
      `select id,call_id,actor_user_id from call_supervisor_sessions
     where call_id=any($1::uuid[]) and state in ('connecting','active') order by id`,
      [callIds]
    )
  ).rows;
  const agentIds = sorted(
    [
      ...(input.agentIds ?? []),
      ...calls.map((r) => r.agent_id),
      ...participants.map((r) => r.agent_id),
      ...transfers.flatMap((r) => [r.source_agent_id, r.recipient_agent_id])
    ].filter(Boolean)
  );
  const agents = (
    await client.query(`select id,user_id from agents where id=any($1::uuid[]) order by id`, [agentIds])
  ).rows;
  return {
    callIds,
    agentIds,
    campaignIds: sorted(
      [
        ...(input.campaignIds ?? []),
        ...(input.audioCampaignIds ?? []),
        ...calls.map((r) => r.campaign_id)
      ].filter(Boolean)
    ),
    userIds: sorted([
      ...(input.userIds ?? []),
      ...agents.map((r) => r.user_id),
      ...supervisors.map((r) => r.actor_user_id)
    ]),
    fingerprint: JSON.stringify({ calls, participants, transfers, supervisors, agents })
  };
}
export interface AdmissionEligibility {
  agentId: string;
  userId: string;
  campaignId: string;
  deskSessionId: string;
  expectedRevision: string;
  bindingGeneration: string;
  offerId?: string;
}
export interface EligibilityResult {
  eligible: boolean;
  reason: string | null;
  // Eligible durable inbound includes calls with no offers, and excludes ignored/expired pairs.
  queuedCallIds: string[];
}

export class CallAdmission {
  private open = true;
  readonly capacity: CallCapacity;
  constructor(
    readonly client: pg.PoolClient,
    private readonly resources: Awaited<ReturnType<typeof discoverAdmissionResources>>,
    readonly startPaused = false
  ) {
    this.capacity = new CallCapacity(client, (callId, agentId) => {
      if (!this.open) throw new AdmissionError("transaction_closed");
      if (callId) this.assertCall(callId);
      if (agentId) this.assertAgent(agentId);
    });
  }
  close() {
    this.open = false;
  }
  private assertAgent(agentId: string) {
    if (!this.open) throw new AdmissionError("transaction_closed");
    if (!this.resources.agentIds.includes(agentId.toLowerCase()))
      throw new AdmissionError("agent_not_locked");
  }
  private assertCall(callId: string) {
    if (!this.open) throw new AdmissionError("transaction_closed");
    if (!this.resources.callIds.includes(callId.toLowerCase())) throw new AdmissionError("call_not_locked");
  }
  // Executor intent participates in the same open, ordered admission transaction.
  assertExecutionCall(callId: string) {
    this.assertCall(callId);
  }
  async eligibility(input: AdmissionEligibility): Promise<EligibilityResult> {
    this.assertAgent(input.agentId);
    if (
      !this.resources.campaignIds.includes(input.campaignId.toLowerCase()) ||
      !this.resources.userIds.includes(input.userId.toLowerCase())
    )
      throw new AdmissionError("parent_not_locked");
    const result = await this.client.query(
      `
      select case
        when not u.is_active then 'session_revoked'
        when c.status <> 'active' then 'campaign_unavailable'
        when a.availability_status='paused' then 'paused'
        when a.availability_status='wrap_up' and a.wrap_up_until > clock_timestamp() then 'wrap_up'
        when d.id is null or d.revoked_at is not null or d.expires_at <= clock_timestamp() then 'not_controller'
        when d.campaign_id is distinct from c.id or d.revision <> $5::bigint then 'revision_conflict'
        when d.binding_generation <> $6::bigint or not d.ready or d.verified_generation is distinct from d.binding_generation
          or d.verified_endpoint is null then 'endpoint_unavailable'
        when s.agent_id is null or s.reconciliation_required then 'coordination_unavailable'
        when s.state <> 'free' then 'slot_occupied'
        when exists(select 1 from call_supervisor_sessions where actor_user_id=u.id and state in ('connecting','active')) then 'supervisor_session'
        when exists(select 1 from calls where agent_id=a.id and ended_at is null and agent_released_at is null
          and state not in ('completed','failed','canceled','agent_released')) then 'slot_occupied'
        else null end as reason
      from agents a join users u on u.id=a.user_id join campaigns c on c.id=$3
      left join agent_desk_sessions d on d.id=$4 and d.agent_id=a.id
      left join agent_call_slots s on s.agent_id=a.id
      where a.id=$1 and u.id=$2`,
      [
        input.agentId,
        input.userId,
        input.campaignId,
        input.deskSessionId,
        input.expectedRevision,
        input.bindingGeneration
      ]
    );
    let reason: string | null = result.rows[0]?.reason ?? (result.rowCount ? null : "session_revoked");
    if (!reason && input.offerId) {
      const offer = await this.client.query(
        `
        select o.*,c.state as call_state,c.ended_at,c.queue_deadline_at,c.campaign_id,
          c.queue_exited_at,c.fallback_started_at,
          o.deadline_at <= clock_timestamp() as expired,
          c.queue_deadline_at <= clock_timestamp() as queue_expired,
          exists(select 1 from call_offer_exclusions e where e.call_id=o.call_id and e.agent_id=o.agent_id) as excluded,
          t.state as transfer_state,t.deadline_at <= clock_timestamp() as transfer_expired
        from call_offers o join calls c on c.id=o.call_id
        left join call_transfers t on t.id=o.transfer_id where o.id=$1 and o.agent_id=$2`,
        [input.offerId, input.agentId]
      );
      const o = offer.rows[0];
      if (o) this.assertCall(o.call_id);
      if (!o || o.state !== "pending" || o.ended_at || o.excluded) reason = "offer_closed";
      else if (
        o.desk_session_id !== input.deskSessionId ||
        o.desk_revision !== input.expectedRevision ||
        o.binding_generation !== input.bindingGeneration
      )
        reason = "revision_conflict";
      else if (o.expired) reason = "offer_expired";
      else if (
        o.kind === "inbound" &&
        (o.call_state !== "queued" ||
          o.queue_expired ||
          o.queue_exited_at ||
          o.fallback_started_at ||
          o.campaign_id !== input.campaignId)
      )
        reason = "offer_closed";
      else if (o.kind === "transfer" && (o.transfer_state !== "offered" || o.transfer_expired))
        reason = "offer_closed";
    }
    const queuedCallIds: string[] = reason
      ? []
      : (
          await this.client.query(
            `
      select c.id from calls c where c.direction='inbound' and c.campaign_id=$1 and c.state='queued'
        and c.ended_at is null and c.queue_exited_at is null and c.fallback_started_at is null
        and c.queue_deadline_at > clock_timestamp()
        and not exists(select 1 from call_offer_exclusions e where e.call_id=c.id and e.agent_id=$2)
        and not exists(select 1 from call_offers o where o.call_id=c.id and o.agent_id=$2
          and o.kind='inbound' and o.state='pending' and o.deadline_at <= clock_timestamp())
      order by c.arrived_at,c.id`,
            [input.campaignId, input.agentId]
          )
        ).rows.map((r) => r.id);
    return { eligible: !reason, reason, queuedCallIds };
  }
  async reserve(input: AdmissionEligibility, callId: string, participantId: string | null = null) {
    this.assertCall(callId);
    const decision = await this.eligibility(input);
    if (!decision.eligible) throw new AdmissionError(decision.reason!);
    if (input.offerId) {
      const offer = await this.client.query("select call_id from call_offers where id=$1", [input.offerId]);
      if (offer.rows[0]?.call_id !== callId) throw new AdmissionError("offer_closed");
    }
    const call = (await this.client.query("select ended_at,state from calls where id=$1", [callId])).rows[0];
    if (!call || call.ended_at || ["completed", "failed", "canceled"].includes(call.state))
      throw new AdmissionError("call_closed");
    const token = await reserveAgentCallSlot(this.client, input.agentId, callId, participantId);
    if (!token) throw new AdmissionError("slot_occupied");
    if (input.offerId)
      await this.client.query(
        "update agent_auto_next_intents set state='canceled',reason='offer_accepted',closed_at=clock_timestamp() where agent_id=$1 and closed_at is null",
        [input.agentId]
      );
    return token;
  }
  async transition(token: SlotToken, state: OccupiedSlotState) {
    this.assertAgent(token.agentId);
    this.assertCall(token.callId);
    // Never regress a live/uncertain reservation to a fresh connecting attempt.
    const allowed: Record<OccupiedSlotState, OccupiedSlotState[]> = {
      reserved: ["reserved", "connecting", "releasing", "uncertain"],
      connecting: ["connecting", "active", "releasing", "uncertain"],
      active: ["active", "releasing", "uncertain"],
      releasing: ["releasing", "uncertain"],
      uncertain: ["uncertain", "releasing"]
    };
    const row = (
      await this.client.query("select state from agent_call_slots where agent_id=$1", [token.agentId])
    ).rows[0];
    if (!row || !allowed[row.state as OccupiedSlotState]?.includes(state)) return false;
    return updateAgentCallSlot(this.client, token, state);
  }
  async release(token: SlotToken, cleanupConfirmed: boolean) {
    this.assertAgent(token.agentId);
    this.assertCall(token.callId);
    if (!cleanupConfirmed) return false;
    // A caller flag cannot override a durable unresolved command (even past deadline).
    const unresolved = await this.client.query(
      "select 1 from call_operations where call_id=$1 and resolved_at is null limit 1",
      [token.callId]
    );
    if (unresolved.rowCount) return false;
    return releaseAgentCallSlot(this.client, token, true);
  }
}

/** Internal SQL-only transaction. Supply an idle dedicated client; never nest it,
 * lease a second client, wait on ESL/files/user input, or acquire earlier ranks in work.
 * Discovery changes roll back, they do NOT automatically replay work. The execution
 * owner must release rank 0, rediscover and retry from rank 0 with a bounded policy.
 */
export async function withCallAdmission<T>(
  client: pg.PoolClient,
  input: AdmissionResources & { startsCall?: boolean; allowPausedReplay?: boolean },
  work: (admission: CallAdmission) => Promise<T>
): Promise<T> {
  const discovered = await discoverAdmissionResources(client, input);
  let admission: CallAdmission | undefined;
  await client.query("begin isolation level read committed");
  try {
    await client.query("set local lock_timeout='250ms'");
    await client.query("set local statement_timeout='500ms'");
    await client.query("set local idle_in_transaction_session_timeout='1000ms'");
    let startPaused = false;
    if (input.startsCall) {
      await client.query(
        "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict(key) do nothing"
      );
      const maintenance = await client.query(
        "select value_json='true'::jsonb as paused from system_settings where key='ops.call_start_paused' for share"
      );
      startPaused = Boolean(maintenance.rows[0]?.paused);
      if (startPaused && !input.allowPausedReplay) throw new AdmissionError("maintenance");
    }
    await client.query("select pg_advisory_xact_lock($1,0)", [ADMISSION_LOCK_NAMESPACE]);
    const marker = await client.query(
      "select 1 from call_admission_migration where not reconciliation_required and reconciled_at is not null"
    );
    if (!marker.rowCount) throw new AdmissionError("coordination_unavailable");
    for (const id of sorted(input.audioCampaignIds ?? [])) await lockCampaignVoicemail(client, id);
    for (const id of discovered.campaignIds)
      await client.query("select id from campaigns where id=$1 for share", [id]);
    for (const id of discovered.userIds) await lockUserMediaAction(client, id);
    for (const id of discovered.userIds)
      await client.query("select id from users where id=$1 for share", [id]);
    for (const id of discovered.agentIds)
      await client.query("select id from agents where id=$1 for update", [id]);
    for (const id of discovered.agentIds)
      await client.query("select agent_id from agent_call_slots where agent_id=$1 for update", [id]);
    for (const id of discovered.callIds)
      await client.query("select id from calls where id=$1 for update", [id]);
    const current = await discoverAdmissionResources(client, input);
    if (JSON.stringify(current) !== JSON.stringify(discovered)) throw new AdmissionDiscoveryChanged();
    admission = new CallAdmission(client, discovered, startPaused);
    const result = await work(admission);
    admission.close();
    await client.query("commit");
    return result;
  } catch (error) {
    admission?.close();
    await client.query("rollback");
    throw error;
  }
}
