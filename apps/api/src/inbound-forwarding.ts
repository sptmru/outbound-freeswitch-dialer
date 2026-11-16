import assert from "node:assert/strict";
import type pg from "pg";
import { normalizeInboundNumber } from "./inbound-configuration.js";
import { ingressUuid } from "./ingress-journal.js";
import type { DurableCommand } from "./call-executor.js";
import { withCallAdmission } from "./call-admission.js";

/** Explicit staged deployment policy. Caller identity is fixed, never copied from ingress. */
export interface ForwardingConfig {
  SIP_TRUNK_MODE: "ip_auth" | "registration";
  SIP_TRUNK_PROXY?: string;
  SIP_TRUNK_USERNAME?: string;
  SIP_TRUNK_CALLER_ID?: string;
}
export function forwardingDestination(target: string, config?: ForwardingConfig) {
  if (!config?.SIP_TRUNK_CALLER_ID || !config.SIP_TRUNK_PROXY) return null;
  try {
    const number = normalizeInboundNumber(target);
    const callerId = normalizeInboundNumber(config.SIP_TRUNK_CALLER_ID);
    if (number !== target || number === callerId) return null;
    if (!/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(config.SIP_TRUNK_PROXY)) return null;
    if (config.SIP_TRUNK_MODE === "registration" && !config.SIP_TRUNK_USERNAME) return null;
    return {
      callerId,
      dialString:
        config.SIP_TRUNK_MODE === "ip_auth"
          ? `sofia/external/${number.slice(1)}@${config.SIP_TRUNK_PROXY}`
          : `sofia/gateway/sip-trunk/${number.slice(1)}`
    };
  } catch {
    return null;
  }
}
export function inboundForwardingCommand(op: DurableCommand) {
  const r = op.request;
  assert.ok(ingressUuid.test(String(r.externalUuid)));
  assert.match(String(r.callerId), /^\+[1-9][0-9]{6,14}$/);
  assert.match(
    String(r.dialString),
    /^sofia\/(?:external\/[1-9][0-9]{6,14}@[a-zA-Z0-9.-]+(?::[0-9]{1,5})?|gateway\/sip-trunk\/[1-9][0-9]{6,14})$/
  );
  for (const value of [r.deadlineEpoch, r.flowDeadlineEpoch])
    assert.match(String(value), /^[1-9][0-9]{9,11}$/);
  return `uuid_transfer ${op.call_id} inbound_forward:${op.id}:${r.externalUuid}:${r.deadlineEpoch}:${r.flowDeadlineEpoch}:${r.callerId}:${r.dialString} XML inbound-forward`;
}
export async function persistInboundForwardingEvent(pool: pg.Pool, h: Record<string, string>) {
  if (h["event-name"] !== "CUSTOM" || h["event-subclass"] !== "outbound_dialer::inbound_forward_finished")
    return false;
  const id = h["outbound-dialer-operation-id"],
    callId = h["outbound-dialer-call-id"],
    external = h["outbound-dialer-external-uuid"];
  if (![id, callId, external].every((x) => ingressUuid.test(x ?? ""))) return true;
  await pool.query(
    `insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json)
    select o.call_id,'inbound_forward_finished','CUSTOM',$4,$5 from call_operations o
    where o.id=$1 and o.call_id=$2 and o.command_kind='forward_external' and o.request->>'externalUuid'=$3
    and exists(select 1 from call_execution_attempts where operation_id=o.id) on conflict do nothing`,
    [id, callId, external, h["event-uuid"] ?? null, { operationId: id, headers: h }]
  );
  return true;
}
/** Close only provably unstarted intents. No absence/timeout shortcut for attempted Lua. */
export async function settleUnstartedForwarding(pool: pg.Pool, callId: string) {
  const db = await pool.connect();
  try {
    await withCallAdmission(db, { callIds: [callId] }, async () => {
      await db.query(
        `update call_legs l set state='ended',ended_at=clock_timestamp()
      from call_operations o where o.call_id=$1 and o.command_kind='forward_external'
      and o.request->>'legId'=l.id::text and o.resolved_at is not null and l.ended_at is null
      and not exists(select 1 from call_execution_attempts where operation_id=o.id)`,
        [callId]
      );
      await db.query(
        `update call_participants p set left_at=l.ended_at,end_reason=coalesce(end_reason,'forward_never_attempted')
      from call_legs l where p.id=l.participant_id and p.call_id=$1 and p.role='external' and l.ended_at is not null and p.left_at is null`,
        [callId]
      );
    });
  } finally {
    db.release();
  }
}
