/** B05 v1 contract. Availability of types does not enable the C/D/E/F/G handlers. */
export type DeskRevision = string;
export type BindingGeneration = string;

export const offerStates = [
  "pending",
  "accepted",
  "ignored",
  "expired",
  "declined",
  "canceled",
  "failed"
] as const;
export type OfferState = (typeof offerStates)[number];
export const transferStates = [
  "offered",
  "connecting",
  "switching",
  "uncertain",
  "completed",
  "declined",
  "expired",
  "canceled",
  "failed"
] as const;
export type TransferState = (typeof transferStates)[number];
export const operationStates = [
  "pending",
  "executing",
  "uncertain",
  "succeeded",
  "failed",
  "canceled"
] as const;
export type OperationState = (typeof operationStates)[number];
export const autoNextIntentStates = ["pending", "deferred", "started", "canceled"] as const;
export type AutoNextIntentState = (typeof autoNextIntentStates)[number];
export const inboundPhases = [
  "received",
  "queued",
  "connecting",
  "agent_connected",
  "fallback",
  "audio_playing",
  "forwarding",
  "completed",
  "failed",
  "canceled"
] as const;
export type InboundPhase = (typeof inboundPhases)[number];
export type InteractiveSlotState = "free" | "reserved" | "connecting" | "active" | "releasing" | "uncertain";

/** Server-derived actor/route/resource scope; client must not supply an actor or SIP destination. */
export interface DeskMutationRequest {
  deskSessionId: string;
  expectedRevision: DeskRevision;
  bindingGeneration: BindingGeneration;
  idempotencyKey: string;
}
export interface ManualStartIntent extends DeskMutationRequest {
  startReason: "manual";
}
export interface AutomaticStartIntent extends DeskMutationRequest {
  startReason: "automatic";
  sourceCallId: string;
}
export type OutboundStartIntent = ManualStartIntent | AutomaticStartIntent;

export interface CreateDeskSessionRequest {
  idempotencyKey: string;
  /** null means no current controller; a takeover must name the current revision. */
  expectedRevision: DeskRevision | null;
  campaignId: string | null;
}
export interface UpdateDeskSessionRequest extends DeskMutationRequest {
  campaignId: string | null;
  ready: boolean;
}
export interface DeskSessionSnapshot {
  id: string;
  revision: DeskRevision;
  bindingGeneration: BindingGeneration;
  campaignId: string | null;
  endpointVerified: boolean;
  ready: boolean;
  expiresAt: string;
}
export interface DeskSessionResponse {
  /** D01 create only; authenticated controller credentials, never persisted in mutation results. */
  sip?: {
    username: string;
    password: string;
    domain: string;
    websocketUrl: string;
    iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  };
  revision: DeskRevision;
  session: DeskSessionSnapshot | null;
}
export interface CallOfferSnapshot {
  id: string;
  callId: string;
  kind: "inbound" | "transfer";
  transferId: string | null;
  state: OfferState;
  deadlineAt: string;
  campaignId: string;
  callingNumber: string;
  closureReason: string | null;
}
export interface CallOffersResponse {
  revision: DeskRevision;
  offer: CallOfferSnapshot | null;
}
export interface TransferSnapshot {
  id: string;
  callId: string;
  sourceAgentId: string;
  recipientAgentId: string;
  state: TransferState;
  deadlineAt: string;
}
export interface DeferredAutoNextIntentSnapshot {
  id: string;
  sourceCallId: string;
  state: "deferred";
  reason: "incoming_pending";
  callId: null;
}
export type AutoNextIntentSnapshot =
  | { id: string; sourceCallId: string; state: "pending"; reason: null; callId: null }
  | DeferredAutoNextIntentSnapshot
  | { id: string; sourceCallId: string; state: "started"; reason: null; callId: string }
  | { id: string; sourceCallId: string; state: "canceled"; reason: string; callId: null };
export interface CoordinationActionAvailability {
  allowed: boolean;
  reason: string | null;
}
export interface DeskCoordination {
  contractVersion: 1;
  revision: DeskRevision;
  session: DeskSessionSnapshot | null;
  slot: {
    state: InteractiveSlotState;
    callId: string | null;
    reservationId: string | null;
    generation: string;
  };
  offer: CallOfferSnapshot | null;
  transfer: TransferSnapshot | null;
  autoNextIntent: AutoNextIntentSnapshot | null;
  actions: {
    manualStart: CoordinationActionAvailability;
    autoNext: CoordinationActionAvailability;
    accept: CoordinationActionAvailability;
    ignore: CoordinationActionAvailability;
    transfer: CoordinationActionAvailability;
  };
}
export interface CreateTransferRequest extends DeskMutationRequest {
  recipientAgentId: string;
}
export interface TransferTargetsResponse {
  revision: DeskRevision;
  items: Array<{ agentId: string; name: string; available: boolean; reason: string | null }>;
}
/** Acceptance is a reservation/connection attempt, never a confirmed bridge. */
export interface AcceptCallOfferResponse {
  status: "connecting";
  revision: DeskRevision;
  callId: string;
  operationId: string;
  offerId: string;
}
export type CoordinationMutationResponse =
  | AcceptCallOfferResponse
  | { status: "started"; revision: DeskRevision; callId: string; operationId: string }
  | {
      status: "deferred";
      revision: DeskRevision;
      reason: "incoming_pending";
      intent: DeferredAutoNextIntentSnapshot;
    }
  | { status: "applied"; revision: DeskRevision };
export const coordinationErrorCodes = [
  "coordination_unavailable",
  "legacy_initiator_required",
  "revision_conflict",
  "idempotency_conflict",
  "not_controller",
  "slot_occupied",
  "offer_closed",
  "offer_expired",
  "not_owner",
  "endpoint_unavailable",
  "capacity_exhausted",
  "call_outcome_uncertain",
  "transfer_in_progress",
  "voicemail_unavailable"
] as const;
export type CoordinationErrorCode = (typeof coordinationErrorCodes)[number];
export interface CoordinationErrorResponse {
  message: string;
  code: CoordinationErrorCode;
  /** Null when rejected before an authoritative snapshot was read. Refetch Desk. */
  revision: DeskRevision | null;
}

export interface InboundQueueConfiguration {
  offerTimeoutMs: number;
  queueTimeoutMs: number;
  connectTimeoutMs: number;
  transferTimeoutMs: number;
  maxWaitingCalls: number;
  overflowPolicy: "reject" | "flow";
  overflowFlowVersionId: string | null;
}
export type InboundFlowAction =
  | { type: "play_audio"; recordingId: string; timeoutMs: number }
  | { type: "forward_external"; target: string; timeoutMs: number }
  | { type: "hangup" };
export interface InboundFlowDefinition {
  flowTimeoutMs: number;
  actions: InboundFlowAction[];
}
export interface InboundAdminMutation {
  idempotencyKey: string;
  expectedRevision: DeskRevision | null;
}
export interface SaveInboundNumberRequest extends InboundAdminMutation {
  label: string;
  did: string;
  queueId: string;
  enabled: boolean;
}
export interface SaveInboundQueueRequest extends InboundAdminMutation {
  name: string;
  campaignId: string;
  waitingRecordingId: string | null;
  noAnswerFlowVersionId: string | null;
  configuration: InboundQueueConfiguration;
}
export interface SaveInboundFlowRequest extends InboundAdminMutation {
  campaignId: string;
  name: string;
  definition: InboundFlowDefinition;
}
export interface InboundAppliedState {
  desiredRevision: string;
  appliedRevision: string | null;
  status: "pending" | "applied" | "error";
  error: string | null;
}
export interface InboundNumberSnapshot {
  label: string;
  id: string;
  revision: string;
  did: string;
  queueId: string;
  enabled: boolean;
  apply: InboundAppliedState;
}
export interface InboundQueueSnapshot {
  id: string;
  revision: string;
  name: string;
  campaignId: string;
  waitingRecordingId: string | null;
  noAnswerFlowVersionId: string | null;
  configuration: InboundQueueConfiguration;
  apply: InboundAppliedState;
}
export interface InboundFlowSnapshot {
  campaignId: string;
  id: string;
  revision: string;
  name: string;
  versionId: string;
  definition: InboundFlowDefinition;
}
export interface InboundNumbersResponse {
  items: InboundNumberSnapshot[];
}
export interface InboundQueuesResponse {
  items: InboundQueueSnapshot[];
}
export interface InboundFlowsResponse {
  items: InboundFlowSnapshot[];
}

// Equal-state replay is allowed. Consumers still need authorization, DB-time deadlines,
// admission locks, fixed UUIDs and FS evidence; these tables grant no execution rights.
export const offerTransitions: Record<OfferState, readonly OfferState[]> = {
  pending: ["accepted", "ignored", "expired", "declined", "canceled", "failed"],
  accepted: [],
  ignored: [],
  expired: [],
  declined: [],
  canceled: [],
  failed: []
};
export const transferTransitions: Record<TransferState, readonly TransferState[]> = {
  offered: ["connecting", "declined", "expired", "canceled", "failed"],
  connecting: ["switching", "uncertain", "failed", "canceled"],
  switching: ["completed", "uncertain", "failed"],
  uncertain: ["completed", "failed", "canceled"],
  completed: [],
  declined: [],
  expired: [],
  canceled: [],
  failed: []
};
export const operationTransitions: Record<OperationState, readonly OperationState[]> = {
  pending: ["executing", "failed", "canceled"],
  executing: ["uncertain", "succeeded", "failed", "canceled"],
  uncertain: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: []
};
export const autoNextIntentTransitions: Record<AutoNextIntentState, readonly AutoNextIntentState[]> = {
  pending: ["deferred", "started", "canceled"],
  deferred: ["started", "canceled"],
  started: [],
  canceled: []
};
export const inboundPhaseTransitions: Record<InboundPhase, readonly InboundPhase[]> = {
  received: ["queued", "failed", "canceled"],
  queued: ["connecting", "fallback", "completed", "failed", "canceled"],
  connecting: ["queued", "agent_connected", "fallback", "completed", "failed", "canceled"],
  agent_connected: ["completed", "failed", "canceled"],
  fallback: ["audio_playing", "forwarding", "completed", "failed", "canceled"],
  audio_playing: ["forwarding", "completed", "failed", "canceled"],
  forwarding: ["audio_playing", "completed", "failed", "canceled"],
  completed: [],
  failed: [],
  canceled: []
};
