import type { AgentDeskResponse, DeskCoordination } from "../types";
import type { SoftphoneRuntime } from "../softphone";

export function coordinatedDesk(): AgentDeskResponse {
  const id = "11111111-1111-4111-8111-111111111111";
  const session = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: "1",
    bindingGeneration: "1",
    campaignId: id,
    endpointVerified: true,
    ready: true,
    expiresAt: new Date(Date.now() + 600000).toISOString()
  };
  const allowed = { allowed: true, reason: null };
  const coordination: DeskCoordination = {
    contractVersion: 1,
    revision: "1",
    session,
    slot: { state: "free", callId: null, reservationId: null, generation: "1" },
    offer: {
      id: "33333333-3333-4333-8333-333333333333",
      callId: "44444444-4444-4444-8444-444444444444",
      kind: "inbound",
      transferId: null,
      state: "pending",
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      campaignId: id,
      callingNumber: "+15551234567",
      closureReason: null
    },
    transfer: null,
    autoNextIntent: null,
    actions: {
      manualStart: allowed,
      autoNext: { allowed: false, reason: "incoming_pending" },
      accept: allowed,
      ignore: allowed,
      transfer: { allowed: false, reason: "unavailable" }
    }
  };
  return {
    user: {
      id: "55555555-5555-4555-8555-555555555555",
      name: "Test Agent",
      email: "test@example.test",
      role: "agent",
      isActive: true
    },
    availability: { status: "available", wrapUpUntil: null },
    campaign: {
      id,
      name: "Campaign One",
      status: "active",
      callableLeads: 2,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    },
    availableCampaigns: [{ id, name: "Campaign One", status: "active", callableLeads: 2 }],
    softphone: { registered: true, microphoneAllowed: true, status: "ready" },
    metrics: { todayCalls: 0, voicemailsDropped: 0, suppressed: 0 },
    voicemailJobs: [],
    recentCalls: [],
    recordings: [],
    activeCall: null,
    leads: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        name: "Test Lead",
        company: "",
        phoneNumber: "+15557654321",
        status: "ready",
        fields: []
      }
    ],
    coordination
  };
}
export function readyPhone(desk: AgentDeskResponse): SoftphoneRuntime {
  return {
    deskSession: desk.coordination!.session,
    registered: true,
    microphoneAllowed: true,
    state: "registered",
    callState: "none",
    audioPlaybackState: "idle",
    label: "Ready",
    detail: "Test fixture",
    error: null,
    incomingCallLabel: null,
    answerIncomingCall: async () => undefined,
    declineIncomingCall: async () => undefined,
    hangUpSoftphoneCall: async () => undefined,
    retryRemoteAudio: async () => undefined,
    startBrowserRingback: () => undefined,
    stopBrowserRingback: () => undefined,
    audioSetup: {
      appliedSettings: null,
      checkError: null,
      checkResult: null,
      checking: false,
      inputDevices: [],
      inputLevel: 0,
      outputDevices: [],
      outputSelectionSupported: false,
      processingProfile: "office",
      selectedInputId: "",
      selectedOutputId: "",
      signalStatus: "idle"
    },
    refreshAudioDevices: async () => undefined,
    runAudioCheck: async () => undefined,
    selectMicrophone: () => undefined,
    selectSpeaker: async () => undefined,
    setMicrophoneProcessingProfile: () => undefined
  };
}
export function deferredDesk(): AgentDeskResponse {
  const desk = coordinatedDesk();
  desk.campaign!.autoAdvanceToNextLeadEnabled = true;
  desk.coordination!.autoNextIntent = {
    id: "77777777-7777-4777-8777-777777777777",
    sourceCallId: "88888888-8888-4888-8888-888888888888",
    state: "deferred",
    reason: "incoming_pending",
    callId: null
  };
  return desk;
}
