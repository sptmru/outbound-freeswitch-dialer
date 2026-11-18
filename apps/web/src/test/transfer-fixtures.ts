import { coordinatedDesk } from "./coordination-fixtures";
import type { AgentDeskResponse, TransferSnapshot } from "../types";
export const targetId = "99999999-9999-4999-8999-999999999999";
export function transferSnapshot(state: TransferSnapshot["state"] = "offered"): TransferSnapshot {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    callId: "44444444-4444-4444-8444-444444444444",
    sourceAgentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    recipientAgentId: targetId,
    state,
    deadlineAt: new Date(Date.now() + 20000).toISOString()
  };
}
export function transferSource(direction: "inbound" | "outbound" = "inbound"): AgentDeskResponse {
  const desk = coordinatedDesk();
  desk.coordination!.offer = null;
  desk.coordination!.slot = {
    state: "active",
    callId: transferSnapshot().callId,
    reservationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    generation: "1"
  };
  desk.coordination!.actions.transfer = { allowed: true, reason: null };
  desk.coordination!.actions.manualStart = { allowed: false, reason: "slot_occupied" };
  desk.campaign!.autoAdvanceToNextLeadEnabled = true;
  desk.activeCall = {
    id: transferSnapshot().callId,
    state: "bridged",
    status: "bridged",
    manualDial: false,
    leadName: direction === "inbound" ? "Inbound customer" : "Outbound customer",
    phoneNumber: "+15551234567",
    durationSeconds: 30,
    voicemailSignal: "none",
    recordingId: null,
    recordingName: "None",
    callRecordingEnabled: false,
    callRecordingStatus: "disabled",
    actions: {
      dropVoicemail: { allowed: false, reason: "No recording" },
      sendDtmf: { allowed: true, reason: null }
    },
    supervisor: { active: false, mode: null },
    timeline: []
  };
  return desk;
}
export function transferRecipient(): AgentDeskResponse {
  const desk = coordinatedDesk();
  desk.user.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  desk.user.name = "Recipient";
  desk.campaign!.id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  desk.campaign!.name = "Recipient campaign";
  desk.coordination!.session!.campaignId = desk.campaign!.id;
  desk.coordination!.session!.id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  desk.coordination!.offer!.kind = "transfer";
  desk.coordination!.offer!.transferId = transferSnapshot().id;
  desk.coordination!.transfer = transferSnapshot();
  return desk;
}
