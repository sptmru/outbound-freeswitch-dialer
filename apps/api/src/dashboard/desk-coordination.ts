import type { DeskCoordination } from "@outbound-dialer/shared";
import type pg from "pg";

type DeskRow = {
  revision: string;
  session: DeskCoordination["session"];
  slot: DeskCoordination["slot"];
  offer: DeskCoordination["offer"];
  transfer: DeskCoordination["transfer"];
  intent: DeskCoordination["autoNextIntent"];
  ready: boolean;
  paused: boolean;
  eligible: boolean;
};

/** One statement keeps the controller, offer, ownership and revision coherent. */
export async function readDeskCoordination(
  pool: pg.Pool,
  userId: string,
  campaignId: string | null
): Promise<DeskCoordination | null> {
  const {
    rows: [row]
  } = await pool.query<DeskRow>(
    `select coalesce(d.revision::text,s.generation::text) as revision,
      case when d.id is not null then jsonb_build_object(
        'id',d.id,'revision',d.revision::text,'bindingGeneration',d.binding_generation::text,
        'campaignId',d.campaign_id,'endpointVerified',d.verified_endpoint is not null,
        'ready',d.ready and d.actor_auth_version=u.auth_version and d.expires_at>statement_timestamp(),
        'expiresAt',d.expires_at) end as session,
      jsonb_build_object('state',s.state,'callId',s.call_id,'reservationId',s.reservation_id,
        'generation',s.generation::text) as slot,
      o.payload as offer,t.payload as transfer,i.payload as intent,
      coalesce(d.ready and d.actor_auth_version=u.auth_version and d.campaign_id=$2
        and d.expires_at>statement_timestamp() and d.verified_generation=d.binding_generation
        and d.verified_at>statement_timestamp()-interval '15 seconds',false) as ready,
      exists(select 1 from system_settings where key='ops.call_start_paused' and value_json='true') as paused,
      a.availability_status='available' and not s.reconciliation_required and
        exists(select 1 from campaigns where id=$2 and status='active') and not exists(
          select 1 from call_supervisor_sessions where actor_user_id=u.id and state in ('connecting','active')) as eligible
    from users u join agents a on a.user_id=u.id join agent_call_slots s on s.agent_id=a.id
    left join agent_desk_sessions d on d.agent_id=a.id and d.revoked_at is null
    left join lateral (
      select jsonb_build_object('id',o.id,'callId',o.call_id,'kind',o.kind,'transferId',o.transfer_id,
        'state',o.state,'deadlineAt',o.deadline_at,'campaignId',c.campaign_id,
        'callingNumber',coalesce(case when c.direction='outbound' then c.normalized_destination_number
          else c.calling_number end,'unknown'),'closureReason',o.reason) as payload
      from call_offers o join calls c on c.id=o.call_id
      left join call_transfers t on t.id=o.transfer_id
      where o.agent_id=a.id and o.state='pending' and o.deadline_at>statement_timestamp()
        and c.ended_at is null and o.desk_session_id=d.id and o.desk_revision=d.revision
        and o.binding_generation=d.binding_generation and d.campaign_id=$2
        and ((o.kind='inbound' and c.campaign_id=$2 and c.state='queued'
          and c.queue_deadline_at>statement_timestamp() and c.queue_exited_at is null
          and exists(select 1 from inbound_queue_admissions q join call_operations w on w.id=q.operation_id
            join call_legs l on l.call_id=q.call_id and l.type='customer'
            where q.call_id=c.id and w.state='succeeded' and l.freeswitch_uuid=c.id::text and l.ended_at is null))
          or (o.kind='transfer' and t.state='offered' and t.deadline_at>statement_timestamp()))
      limit 1
    ) o on true
    left join lateral (
      select jsonb_build_object('id',id,'callId',call_id,'sourceAgentId',source_agent_id,
        'recipientAgentId',recipient_agent_id,'state',state,'deadlineAt',deadline_at) as payload
      from call_transfers where (source_agent_id=a.id and call_id=s.call_id)
        or (recipient_agent_id=a.id and id::text=o.payload->>'transferId')
      order by (closed_at is null) desc,created_at desc,id desc limit 1
    ) t on true
    left join lateral (
      select jsonb_build_object('id',idempotency_key,'sourceCallId',source_call_id,
        'state',state,'reason',reason,'callId',started_call_id) as payload
      from agent_auto_next_intents where agent_id=a.id and campaign_id=$2
        and desk_session_id=d.id and desk_revision=d.revision and binding_generation=d.binding_generation
      order by created_at desc,id desc limit 1
    ) i on true
    where u.id=$1 and u.is_active`,
    [userId, campaignId]
  );
  if (!row) return null;
  const action = (allowed: boolean, reason: string) => ({ allowed, reason: allowed ? null : reason });
  const idle = row.ready && row.eligible && !row.paused && row.slot.state === "free";
  const automaticWait = row.intent?.state === "deferred" || Boolean(row.offer);
  return {
    contractVersion: 1,
    revision: row.revision,
    session: row.session,
    slot: row.slot,
    offer: row.offer,
    transfer: row.transfer,
    autoNextIntent: row.intent,
    actions: {
      manualStart: action(idle, "unavailable"),
      autoNext: action(idle && !automaticWait, automaticWait ? "incoming_pending" : "unavailable"),
      accept: action(idle && Boolean(row.offer), "unavailable"),
      ignore: action(row.ready && Boolean(row.offer), "unavailable"),
      transfer: action(row.ready && !row.paused && row.slot.state === "active", "unavailable")
    }
  };
}
