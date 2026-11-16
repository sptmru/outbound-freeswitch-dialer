import type pg from "pg";
import { z } from "zod";
import { withCallAdmission } from "./call-admission.js";
import type { DeskActor } from "./desk-sessions.js";

export const serviceInviteSchema = z
  .object({
    callId: z.guid(),
    operationId: z.guid(),
    deskSessionId: z.guid(),
    bindingGeneration: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((s) => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n),
    legUuid: z.guid(),
    dialogId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/)
  })
  .strict();

/** This consumes media authorization, never accepts an offer or changes ownership.
 * SQL-only, serialized with takeover/terminal/release. No transaction spans SIP.
 */
export async function authorizeServiceInvite(
  pool: pg.Pool,
  actor: DeskActor,
  input: z.infer<typeof serviceInviteSchema>
): Promise<boolean> {
  const db = await pool.connect();
  try {
    return await withCallAdmission(db, { callIds: [input.callId], agentIds: [actor.agentId] }, async () => {
      const allowed = await db.query(
        `select 1 from call_operations o
        join calls c on c.id=o.call_id
        join agents a on a.id=$6 join users u on u.id=a.user_id
        join agent_desk_sessions d on d.id=$3 and d.agent_id=a.id
        join agent_call_slots s on s.agent_id=a.id and s.call_id=c.id
        join call_participants p on p.id=s.participant_id and p.call_id=c.id and p.agent_id=a.id
        join call_legs l on l.call_id=c.id and l.participant_id=p.id and l.freeswitch_uuid=$5
        where o.id=$2 and c.id=$1 and c.ended_at is null and l.ended_at is null and p.left_at is null
          and u.id=$7 and u.is_active and u.auth_version=$8 and d.actor_auth_version=u.auth_version
          and d.revoked_at is null and d.expires_at>clock_timestamp() and d.ready
          and d.binding_generation=$4 and d.verified_generation=d.binding_generation
          and d.verified_at>clock_timestamp()-interval '15 seconds'
          and d.verified_endpoint=d.endpoint_pin and d.verified_endpoint=o.request->>'endpoint'
          and o.request->>'sipUsername'=d.sip_username
          and o.request->>'actorUserId'=u.id::text
          and o.request->>'actorAuthVersion'=u.auth_version::text
          and o.request->'intent'->>'deskSessionId'=d.id::text
          and o.request->'intent'->>'bindingGeneration'=d.binding_generation::text
          and o.target_uuid::text=l.freeswitch_uuid and o.generation=s.generation
          and o.request->'slot'->>'agentId'=s.agent_id::text
          and o.request->'slot'->>'callId'=c.id::text
          and o.request->'slot'->>'reservationId'=s.reservation_id::text
          and o.request->'slot'->>'generation'=s.generation::text
          and s.state in ('reserved','connecting','active') and not s.reconciliation_required
          and o.state in ('executing','uncertain','succeeded') and o.deadline_at>clock_timestamp()
          and exists(select 1 from call_execution_attempts where operation_id=o.id)
          and (
            (o.command_kind='originate' and c.direction='outbound' and c.agent_id=a.id
              and o.request->'admission'->>'operationId'=o.id::text
              and o.request->'admission'->>'callId'=c.id::text)
            or (o.command_kind='originate' and o.request->>'inboundConnection'='true'
              and o.request->>'connectionAction'='originate' and c.state='connecting'
              and exists(select 1 from inbound_connection_attempts x join call_offers f on f.id=x.offer_id
                where x.operation_id=o.id and x.participant_id=p.id and x.agent_id=a.id
                  and x.settled_at is null and x.deadline_at>clock_timestamp() and f.state='accepted'))
            or (o.command_kind in ('originate','rebridge') and exists(select 1 from call_transfers t
              where t.operation_id=o.id and t.call_id=c.id and t.recipient_agent_id=a.id
                and t.state in ('connecting','switching') and t.closed_at is null and t.deadline_at>clock_timestamp()
                and exists(select 1 from call_offers f where f.transfer_id=t.id and f.agent_id=a.id
                  and f.state='accepted' and f.desk_session_id=d.id and f.binding_generation=d.binding_generation)))
          )`,
        [
          input.callId,
          input.operationId,
          input.deskSessionId,
          input.bindingGeneration,
          input.legUuid,
          actor.agentId,
          actor.userId,
          actor.authVersion
        ]
      );
      if (!allowed.rowCount) return false;
      await db.query(
        "insert into service_invite_dialogs(operation_id,dialog_id) values($1,$2) on conflict do nothing",
        [input.operationId, input.dialogId]
      );
      return (
        (
          await db.query("select 1 from service_invite_dialogs where operation_id=$1 and dialog_id=$2", [
            input.operationId,
            input.dialogId
          ])
        ).rowCount === 1
      );
    });
  } finally {
    db.release();
  }
}
