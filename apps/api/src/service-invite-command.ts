import assert from "node:assert/strict";
import type { DurableCommand } from "./call-executor.js";
import { verifiedDeskContact } from "./desk-sessions.js";
import { ingressUuid } from "./ingress-journal.js";

/** Shared inbound/outbound/transfer endpoint primitive. The action-specific C03
 * validator still owns permission to send; this function never uses user/<aor>.
 */
export function serviceInviteCommand(op: DurableCommand, channelVariables: readonly string[] = []): string {
  const r = op.request;
  const intent = r.intent as { deskSessionId: string; bindingGeneration: string };
  const endpoint = String(r.endpoint);
  assert.ok(
    [op.id, op.call_id, op.target_uuid, intent?.deskSessionId].every(
      (v) => typeof v === "string" && ingressUuid.test(v)
    )
  );
  assert.ok(
    /^[1-9][0-9]{0,18}$/.test(intent.bindingGeneration) &&
      BigInt(intent.bindingGeneration) <= 9223372036854775807n
  );
  assert.equal(verifiedDeskContact(endpoint, String(r.sipUsername)), endpoint);
  assert.ok(channelVariables.every((v) => /^[a-z_]+=[a-z0-9_:.-]+$/.test(v)));
  const extra = channelVariables.length ? `,${channelVariables.join(",")}` : "";
  return `originate {origination_uuid=${op.target_uuid},originate_timeout=4,ignore_early_media=true,media_webrtc=${/transport=wss?/i.test(endpoint)},hangup_after_bridge=true,outbound_dialer_call_id=${op.call_id},sip_h_X-Outbound-Dialer-Call-ID=${op.call_id},sip_h_X-Outbound-Dialer-Operation-ID=${op.id},sip_h_X-Outbound-Dialer-Desk-Session-ID=${intent.deskSessionId},sip_h_X-Outbound-Dialer-Binding-Generation=${intent.bindingGeneration},sip_h_X-Outbound-Dialer-Leg-ID=${op.target_uuid}${extra}}${endpoint} &park()`;
}
