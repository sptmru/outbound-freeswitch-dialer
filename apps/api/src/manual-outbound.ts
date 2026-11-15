import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ManualStartIntent } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { AdmissionDiscoveryChanged, withCallAdmission } from "./call-admission.js";
import { enqueueCallCommand, ExecutionError } from "./call-executor.js";
import { idempotencyScope, requestFingerprint } from "./call-coordination-contracts.js";
import { normalizePhoneNumber } from "./dashboard/phone.js";

export type ManualOutboundRoute =
  "/agent/manual-dial/start" | "/agent/call-next" | "/agent/leads/:contactId/call";
export interface ManualOutboundRequest {
  actorUserId: string;
  actorAuthVersion?: number;
  route: ManualOutboundRoute;
  contactId?: string;
  campaignId?: string;
  phoneNumber?: string;
  confirmCompletedLead?: boolean;
  confirmRetryWait?: boolean;
  intent: ManualStartIntent;
}
export interface ManualOutboundAdmission {
  status: "started";
  replayed: boolean;
  callId: string;
  campaignId: string;
  operationId: string;
  revision: string;
}
export class ManualOutboundError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Internal SQL producer. No ESL, background daemon, deployment cutover or legacy
 * retry upgrade. The HTTP integration must supply a working executor before use.
 * All inputs other than actor/route/resource come from the strict B05 schemas.
 */
export async function admitManualOutbound(
  pool: pg.Pool,
  config: AppConfig,
  input: ManualOutboundRequest
): Promise<ManualOutboundAdmission> {
  const client = await pool.connect();
  try {
    // Normalize before fingerprinting, but defer all mutable validation until after replay.
    const phone =
      input.route === "/agent/manual-dial/start"
        ? normalizePhoneNumber(input.phoneNumber ?? "", config.DEFAULT_PHONE_COUNTRY_CODE)
        : null;
    if (phone && !phone.ok) throw new ManualOutboundError("invalid_number");
    const scope = idempotencyScope(input.actorUserId, "POST", input.route, input.contactId ?? null);
    const fingerprint = requestFingerprint("POST", input.route, input.contactId ?? null, {
      campaignId: input.campaignId ?? null,
      phoneNumber: phone?.ok ? phone.number : null,
      confirmCompletedLead: input.confirmCompletedLead === true,
      confirmRetryWait: input.confirmRetryWait === true,
      intent: input.intent
    });
    // A changed pending offer/transfer discovery requires reacquiring the complete graph.
    // No callback work is retried after commit or after any possible ESL send.
    for (let attempt = 0; attempt < 3; attempt++) {
      const actor = (
        await client.query(
          `select a.id as agent_id,d.campaign_id from agents a
         left join agent_desk_sessions d on d.id=$2 and d.agent_id=a.id
         where a.user_id=$1`,
          [input.actorUserId, input.intent.deskSessionId]
        )
      ).rows[0];
      if (!actor) throw new ManualOutboundError("not_controller");
      const selected = input.contactId
        ? (await client.query("select campaign_id from contacts where id=$1", [input.contactId])).rows[0]
        : null;
      const campaignId = input.contactId ? selected?.campaign_id : (input.campaignId ?? actor.campaign_id);
      if (!campaignId) throw new ManualOutboundError("campaign_unavailable");
      const pendingCalls = async () =>
        (
          await client.query(
            `select distinct call_id from (
          select call_id from call_offers where agent_id=$1 and state='pending'
          union select call_id from call_transfers where recipient_agent_id=$1 and closed_at is null
        ) work order by call_id`,
            [actor.agent_id]
          )
        ).rows.map((r) => r.call_id as string);
      const offeredCalls = await pendingCalls();
      const callId = randomUUID();
      try {
        return await withCallAdmission(
          client,
          {
            startsCall: true,
            allowPausedReplay: true,
            agentIds: [actor.agent_id],
            userIds: [input.actorUserId],
            campaignIds: [campaignId],
            callIds: [...offeredCalls, callId]
          },
          async (admission) => {
            if (JSON.stringify(await pendingCalls()) !== JSON.stringify(offeredCalls))
              throw new AdmissionDiscoveryChanged();
            const active = (
              await client.query("select is_active,auth_version from users where id=$1", [input.actorUserId])
            ).rows[0];
            if (
              !active?.is_active ||
              (input.actorAuthVersion !== undefined && active.auth_version !== input.actorAuthVersion)
            )
              throw new ManualOutboundError("session_revoked");
            const old = (
              await client.query(
                "select * from call_operations where idempotency_scope=$1 and idempotency_key=$2",
                [scope, input.intent.idempotencyKey]
              )
            ).rows[0];
            if (old) {
              if (old.request_fingerprint !== fingerprint)
                throw new ManualOutboundError("idempotency_conflict");
              return { ...old.request.admission, replayed: true } as ManualOutboundAdmission;
            }
            if (admission.startPaused) throw new ManualOutboundError("maintenance");
            const eligibility = {
              agentId: actor.agent_id as string,
              userId: input.actorUserId,
              campaignId,
              deskSessionId: input.intent.deskSessionId,
              expectedRevision: input.intent.expectedRevision,
              bindingGeneration: input.intent.bindingGeneration
            };
            const decision = await admission.eligibility(eligibility);
            if (!decision.eligible) throw new ManualOutboundError(decision.reason!);
            const agent = (
              await client.query("select registered,caller_id from agents where id=$1", [actor.agent_id])
            ).rows[0];
            if (!agent.registered) throw new ManualOutboundError("endpoint_unavailable");
            const campaign = (await client.query("select * from campaigns where id=$1", [campaignId]))
              .rows[0];
            if (!campaign || campaign.status !== "active")
              throw new ManualOutboundError("campaign_unavailable");
            if (phone && !campaign.manual_dialing_enabled)
              throw new ManualOutboundError("manual_dialing_disabled");
            let contact = null;
            if (!phone) {
              contact = (
                await client.query(
                  `select * from contacts where campaign_id=$1
                and ($2::uuid is null or id=$2) and status not in ('calling','suppressed')
                and ((status='completed' and $3) or (status<>'completed' and attempt_count<$4
                  and ($5 or last_attempted_at is null or last_attempted_at <= clock_timestamp()-make_interval(secs=>$6))))
                and not exists(select 1 from suppression_entries s where s.normalized_phone_number=contacts.normalized_phone_number)
              order by last_attempted_at asc nulls first,created_at,id limit 1 for update skip locked`,
                  [
                    campaignId,
                    input.contactId ?? null,
                    input.contactId && input.confirmCompletedLead === true ? true : false,
                    config.CONTACT_MAX_ATTEMPTS,
                    input.contactId && input.confirmRetryWait === true ? true : false,
                    config.CONTACT_RETRY_DELAY_SECONDS
                  ]
                )
              ).rows[0];
              if (!contact) throw new ManualOutboundError("lead_not_callable");
            }
            const normalized = phone?.ok
              ? phone
              : normalizePhoneNumber(contact.normalized_phone_number, config.DEFAULT_PHONE_COUNTRY_CODE);
            if (!normalized.ok) throw new ManualOutboundError("invalid_number");
            if (
              (
                await client.query("select 1 from suppression_entries where normalized_phone_number=$1", [
                  normalized.number
                ])
              ).rowCount
            )
              throw new ManualOutboundError("suppressed");
            const desk = (
              await client.query(
                "select verified_endpoint,sip_username from agent_desk_sessions where id=$1",
                [input.intent.deskSessionId]
              )
            ).rows[0];
            const callerId = agent.caller_id?.trim() || config.SIP_TRUNK_CALLER_ID?.trim() || null;
            await client.query(
              `insert into calls(id,campaign_id,contact_id,destination_number,normalized_destination_number,
              caller_id,calling_number,called_number,state,manual_dial,call_recording_enabled,call_recording_status,early_media_avmd_enabled)
             values($1,$2,$3,$4,$4,$5,$5,$4,'created',$6,$7,case when $7 then 'pending' else 'disabled' end,$8)`,
              [
                callId,
                campaignId,
                contact?.id ?? null,
                normalized.number,
                callerId,
                !!phone,
                campaign.call_recording_enabled,
                campaign.early_media_avmd_enabled
              ]
            );
            const participantId = randomUUID(),
              customerId = randomUUID();
            await client.query(
              `insert into call_participants(id,call_id,role,agent_id,external_number)
            values($1,$2,'agent',$3,null),($4,$2,'customer',null,$5)`,
              [participantId, callId, actor.agent_id, customerId, normalized.number]
            );
            const slot = await admission.reserve(eligibility, callId, participantId);
            const agentUuid = randomUUID(),
              customerUuid = randomUUID();
            await client.query(
              `insert into call_legs(call_id,type,participant_id,freeswitch_uuid,sip_uri,state)
            values($1,'agent',$2,$3,$4,'created'),($1,'customer',$5,$6,null,'created')`,
              [callId, participantId, agentUuid, desk.verified_endpoint, customerId, customerUuid]
            );
            await client.query("update calls set agent_id=$2 where id=$1", [callId, actor.agent_id]);
            const operationId = randomUUID();
            const result: ManualOutboundAdmission = {
              status: "started",
              replayed: false,
              callId,
              campaignId,
              operationId,
              revision: input.intent.expectedRevision
            };
            await enqueueCallCommand(admission, {
              id: operationId,
              callId,
              scope,
              key: input.intent.idempotencyKey,
              fingerprint,
              kind: "originate",
              generation: slot.generation,
              commandUuid: randomUUID(),
              targetUuid: agentUuid,
              request: {
                admission: result,
                slot,
                actorUserId: input.actorUserId,
                actorAuthVersion: active.auth_version,
                intent: input.intent,
                endpoint: desk.verified_endpoint,
                sipUsername: desk.sip_username,
                customerUuid,
                destinationNumber: normalized.number,
                callerId
              },
              deadline: (await client.query("select clock_timestamp()+interval '5 seconds' as deadline"))
                .rows[0].deadline
            });
            // Lock child work at rank 6 before rank-7 capacity rows. Discovery has
            // already locked every affected customer/source call and participant.
            await client.query(
              "select id from call_offers where agent_id=$1 and state='pending' order by id for update",
              [actor.agent_id]
            );
            await client.query(
              "select id from call_transfers where recipient_agent_id=$1 and closed_at is null order by id for update",
              [actor.agent_id]
            );
            await client.query(
              "select id from agent_auto_next_intents where agent_id=$1 and closed_at is null order by id for update",
              [actor.agent_id]
            );
            await admission.capacity.claim({
              kind: "outbound",
              callId,
              operationId,
              generation: slot.generation,
              agentId: actor.agent_id
            });
            // All resource checks precede dismissal. Expiry/terminal source keeps its own cause.
            await client.query(
              `update call_offers o set
            state=case when o.deadline_at<=clock_timestamp() then 'expired'
              when c.ended_at is not null then 'canceled'
              when o.kind='inbound' then 'ignored'
              when t.state='offered' and t.deadline_at>clock_timestamp() then 'declined' else 'canceled' end,
            reason=case when o.deadline_at<=clock_timestamp() then 'deadline_elapsed'
              when c.ended_at is not null then 'call_closed'
              when o.kind='inbound' or (t.state='offered' and t.deadline_at>clock_timestamp()) then 'manual_outbound_started'
              else 'transfer_closed' end,closed_at=clock_timestamp()
            from calls c left join call_transfers t on t.call_id=c.id and t.closed_at is null
            where o.call_id=c.id and o.agent_id=$1 and o.state='pending'`,
              [actor.agent_id]
            );
            await client.query(
              `update call_transfers t set state=case
              when c.ended_at is not null then 'canceled' when t.deadline_at<=clock_timestamp() then 'expired' else 'declined' end,
            reason=case when c.ended_at is not null then 'call_closed' when t.deadline_at<=clock_timestamp() then 'deadline_elapsed'
              else 'manual_outbound_started' end,closed_at=clock_timestamp()
            from calls c where t.call_id=c.id and t.recipient_agent_id=$1 and t.state='offered' and t.closed_at is null`,
              [actor.agent_id]
            );
            await client.query(
              `update agent_auto_next_intents set state='canceled',reason='manual_outbound_started',closed_at=clock_timestamp()
            where agent_id=$1 and closed_at is null`,
              [actor.agent_id]
            );
            if (contact)
              await client.query(
                `update contacts set status='calling',attempt_count=attempt_count+1,last_attempted_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,
                [contact.id]
              );
            await client.query(
              "update agents set status='in_call',availability_status='available',wrap_up_until=null,updated_at=clock_timestamp() where id=$1",
              [actor.agent_id]
            );
            await client.query(
              `insert into call_events(call_id,agent_id,event_type,state,raw_json)
            values($1,$2,'manual_outbound_admitted','created',$3)`,
              [callId, actor.agent_id, { route: input.route, operationId }]
            );
            return result;
          }
        );
      } catch (error) {
        if (error instanceof AdmissionDiscoveryChanged && attempt < 2) continue;
        throw error;
      }
    }
    throw new ExecutionError("discovery_changed");
  } finally {
    client.release();
  }
}

/** Action-specific C03 validation. A future execution adapter must call this
 * under the executor's admission transaction before any native originate.
 * Possession of an operation ID or a prior HTTP result is not send authority.
 */
export async function validateManualOutboundCommand(
  operation: import("./call-executor.js").DurableCommand,
  admission: import("./call-admission.js").CallAdmission
): Promise<boolean> {
  admission.assertExecutionCall(operation.call_id);
  const request = operation.request;
  const token = request.slot as import("./agent-call-slots.js").SlotToken | undefined;
  const intent = request.intent as ManualStartIntent | undefined;
  if (
    operation.command_kind !== "originate" ||
    !token ||
    !intent ||
    token.callId !== operation.call_id ||
    token.generation !== operation.generation
  )
    return false;
  const row = (
    await admission.client.query(
      `select 1
    from calls c join agents a on a.id=c.agent_id join users u on u.id=a.user_id
    join campaigns p on p.id=c.campaign_id join agent_call_slots s on s.agent_id=a.id
    join agent_desk_sessions d on d.id=$5 and d.agent_id=a.id
    where c.id=$1 and c.direction='outbound' and c.ended_at is null and c.state='created'
      and a.id=$2 and u.id=$9 and u.is_active and u.auth_version=$12 and a.registered and a.availability_status='available'
      and p.status='active' and (not c.manual_dial or p.manual_dialing_enabled)
      and s.call_id=c.id and s.generation=$3 and s.reservation_id=$4 and s.state='reserved' and not s.reconciliation_required
      and d.revoked_at is null and d.expires_at>clock_timestamp() and d.ready and d.campaign_id=c.campaign_id
      and d.revision=$6 and d.binding_generation=$7 and d.verified_generation=d.binding_generation and d.verified_endpoint=$8
      and not exists(select 1 from suppression_entries where normalized_phone_number=c.normalized_destination_number)
      and not exists(select 1 from call_supervisor_sessions where actor_user_id=u.id and state in ('connecting','active'))
      and not exists(select 1 from system_settings where key='ops.call_start_paused' and value_json='true'::jsonb)
      and exists(select 1 from call_legs where call_id=c.id and type='agent' and freeswitch_uuid=$10)
      and exists(select 1 from call_legs where call_id=c.id and type='customer' and freeswitch_uuid=$11)
      and (c.contact_id is null or exists(select 1 from contacts where id=c.contact_id and status='calling'))`,
      [
        operation.call_id,
        token.agentId,
        token.generation,
        token.reservationId,
        intent.deskSessionId,
        intent.expectedRevision,
        intent.bindingGeneration,
        request.endpoint,
        request.actorUserId,
        operation.target_uuid,
        request.customerUuid,
        request.actorAuthVersion
      ]
    )
  ).rows[0];
  return Boolean(row);
}

/** C04 integration with the C03 executor. The adapter is server-owned and must
 * implement exact endpoint/UUID command construction and verified FS results.
 * Deferred/uncertain work remains durable for the scheduler/reconciler; no raw
 * legacy originate, retries or cleanup are substituted on failure.
 */
export function manualOutboundExecutor(
  executor: import("./call-executor.js").CallExecutor,
  driver: import("./call-executor.js").CommandDriver
) {
  return {
    async wakeExecutor(operationId: string) {
      await executor.run(operationId, "normal", {
        ...driver,
        async validate(operation, admission) {
          return (
            (await validateManualOutboundCommand(operation, admission)) &&
            (!driver.validate || (await driver.validate(operation, admission)))
          );
        }
      });
    }
  };
}
