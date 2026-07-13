export const callStates = [
  "created",
  "agent_ringing",
  "agent_answered",
  "customer_dialing",
  "customer_ringing",
  "bridged",
  "voicemail_signal_detected",
  "voicemail_drop_requested",
  "voicemail_playback_started",
  "agent_released",
  "voicemail_playback_completed",
  "completed",
  "failed",
  "canceled"
] as const;

export type CallState = (typeof callStates)[number];

export const callOutcomes = [
  "answered",
  "not_answered",
  "busy",
  "failed",
  "voicemail_detected",
  "voicemail_dropped",
  "agent_canceled",
  "customer_hung_up",
  "suppressed"
] as const;

export type CallOutcome = (typeof callOutcomes)[number];

export const callRecordingStatuses = [
  "disabled",
  "pending",
  "recording",
  "finalizing",
  "available",
  "expired",
  "failed"
] as const;

export type CallRecordingStatus = (typeof callRecordingStatuses)[number];

export const callPcapStatuses = ["pending", "capturing", "available", "failed", "expired"] as const;

export type CallPcapStatus = (typeof callPcapStatuses)[number];

export const userRoles = ["agent", "admin"] as const;

export type UserRole = (typeof userRoles)[number];

export const agentAvailabilityStatuses = ["available", "paused", "wrap_up"] as const;

export type AgentAvailabilityStatus = (typeof agentAvailabilityStatuses)[number];

export type CampaignStatus = "active" | "paused" | "draft" | "archived";

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "api";
  uptimeSeconds: number;
  checks: {
    postgres: HealthCheck;
    freeswitchEsl: HealthCheck;
    freeswitchEventListener: HealthCheck;
  };
}

export interface HealthCheck {
  status: "ok" | "error" | "skipped";
  message?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}

export interface AdminAuditResponse {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    id: string;
    actorName: string;
    actorEmail: string;
    method: string;
    route: string;
    statusCode: number;
    sourceIp: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface LeadSummary {
  id: string;
  name: string;
  company: string;
  phoneNumber: string;
  status: "ready" | "calling" | "retry_wait" | "exhausted" | "suppressed" | "completed";
  fields: Array<{ label: string; value: string }>;
}

export interface AgentDeskResponse {
  user: PublicUser;
  availability: {
    status: AgentAvailabilityStatus;
    wrapUpUntil: string | null;
  };
  campaign: {
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    callableLeads: number;
    manualDialingEnabled: boolean;
    callRecordingEnabled: boolean;
    earlyMediaAvmdEnabled: boolean;
  } | null;
  availableCampaigns: Array<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    callableLeads: number;
  }>;
  softphone: {
    registered: boolean;
    microphoneAllowed: boolean;
    status: "ready" | "in_call" | "offline";
  };
  metrics: {
    todayCalls: number;
    voicemailsDropped: number;
    suppressed: number;
  };
  voicemailJobs: Array<{
    callId: string;
    leadName: string;
    phoneNumber: string;
    status: "requested" | "playing" | "completed" | "interrupted" | "failed";
    requestedAt: string;
    updatedAt: string;
  }>;
  recentCalls: Array<{
    id: string;
    phoneNumber: string;
    leadName: string;
    outcome: CallOutcome | null;
    state: CallState;
    createdAt: string;
  }>;
  leads: LeadSummary[];
  recordings: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  activeCall: {
    id: string;
    state: CallState;
    outcome?: CallOutcome;
    leadName: string;
    phoneNumber: string;
    durationSeconds: number;
    status: "dialing" | "ringing" | "bridged" | "voicemail_drop" | "completed";
    voicemailSignal: "none" | "possible" | "detected";
    recordingId: string | null;
    recordingName: string;
    callRecordingEnabled: boolean;
    callRecordingStatus: CallRecordingStatus;
    actions: {
      dropVoicemail: CallActionAvailability;
      sendDtmf: CallActionAvailability;
    };
    timeline: Array<{ at: string; label: string }>;
  } | null;
}

export interface UpdateAgentAvailabilityRequest {
  status: Exclude<AgentAvailabilityStatus, "wrap_up">;
  campaignId?: string;
}

export interface CallActionAvailability {
  allowed: boolean;
  reason: string | null;
}

export interface SoftphoneProvisioningResponse {
  sipUri: string;
  sipUsername: string;
  sipPassword: string;
  displayName: string;
  websocketUrl: string;
  domain: string;
}

export interface AdminOverviewResponse {
  user: PublicUser;
  stats: {
    campaigns: number;
    activeAgents: number;
    callsToday: number;
    suppressionEntries: number;
    liveCalls: number;
    attemptedCallsToday: number;
    answeredCallsToday: number;
    contactRate: number;
    voicemailDropsToday: number;
    voicemailDropCompletionRate: number;
    failedCallsToday: number;
    callsPerHour: number;
    agentUtilization: number;
    outcomeDistribution: Array<{ outcome: string; count: number }>;
  };
  campaigns: Array<{
    id: string;
    name: string;
    status: CampaignStatus;
    loaded: number;
    callable: number;
    attempted: number;
    outcomeDistribution: Array<{ outcome: string; count: number }>;
    manualDialingEnabled: boolean;
    callRecordingEnabled: boolean;
    earlyMediaAvmdEnabled: boolean;
  }>;
  recordings: Array<{
    id: string;
    name: string;
    durationSeconds: number;
    fileSizeBytes: number;
    status: string;
  }>;
  users: Array<PublicUser & { agentRegistered: boolean | null }>;
  callHistory: CallHistoryItem[];
  suppression: Array<{
    id: string;
    phoneNumber: string;
    reason: string;
    createdAt: string;
  }>;
}

export interface AdminLibraryPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type AdminCampaignListResponse = AdminLibraryPage<AdminOverviewResponse["campaigns"][number]>;

export type AdminRecordingListResponse = AdminLibraryPage<AdminOverviewResponse["recordings"][number]>;

export type AdminUserListResponse = AdminLibraryPage<AdminOverviewResponse["users"][number]>;

export interface CallHistoryItem {
  id: string;
  leadName: string;
  agentName: string;
  phoneNumber: string;
  campaignName: string;
  campaignId: string | null;
  agentId: string | null;
  state: CallState;
  outcome: CallOutcome | null;
  createdAt: string;
  durationSeconds: number;
  recordingAvailable: boolean;
  pcapStatus: CallPcapStatus | null;
  pcapAvailable: boolean;
  voicemailSignal: string | null;
}

export interface CallHistoryResponse {
  items: CallHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CallDetailResponse {
  call: AdminOverviewResponse["callHistory"][number] & {
    startedAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
    manualDial: boolean;
    voicemailSignal: string | null;
    voicemailConfidence: number | null;
    recordingStatus: CallRecordingStatus;
    recordingDurationSeconds: number | null;
    recordingFileSizeBytes: number | null;
    recordingIntegrityCheckedAt: string | null;
    recordingFailureReason: string | null;
    pcapStatus: CallPcapStatus | null;
    pcapFileSizeBytes: number | null;
    pcapStartedAt: string | null;
    pcapEndedAt: string | null;
    pcapFailureReason: string | null;
    pcapAvailable: boolean;
    lastReasonCode: string | null;
    hangupCause: string | null;
  };
  legs: Array<{
    type: "agent" | "customer";
    state: string;
    freeswitchUuid: string | null;
    sipUri: string | null;
    startedAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
    hangupCause: string | null;
    reasonCode: string | null;
  }>;
  timeline: Array<{
    at: string;
    eventType: string;
    state: string;
    label: string;
    reasonCode: string | null;
    freeSwitchEventName: string | null;
    apiCommandName: string | null;
    agentLegUuid: string | null;
    customerLegUuid: string | null;
  }>;
}

export interface CreateRecordingResponse {
  item: AdminOverviewResponse["recordings"][number];
}

export interface CreateCampaignRequest {
  name: string;
  status: CampaignStatus;
  manualDialingEnabled: boolean;
  callRecordingEnabled: boolean;
  earlyMediaAvmdEnabled: boolean;
}

export interface UpdateCampaignRequest {
  name: string;
  status: CampaignStatus;
  manualDialingEnabled: boolean;
  callRecordingEnabled: boolean;
  earlyMediaAvmdEnabled: boolean;
}

export interface CreateContactRequest {
  campaignId: string;
  name: string;
  phoneNumber: string;
  company?: string;
  fields?: Array<{ label: string; value: string }>;
}

export interface CreateSuppressionRequest {
  phoneNumber: string;
  reason?: string;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  role: UserRole;
  password: string;
}

export interface CreateUserResponse {
  user: PublicUser;
}

export interface UpdateUserRequest {
  email?: string;
  name?: string;
  role?: UserRole;
  isActive?: boolean;
  password?: string;
}

export interface UpdateUserResponse {
  user: PublicUser;
}

export interface MediaTicketResponse {
  url: string;
  expiresAt: string;
}

export interface SuppressionListResponse {
  items: AdminOverviewResponse["suppression"];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SuppressionImportResponse {
  filename: string;
  totalRows: number;
  importedRows: number;
  updatedRows: number;
  failedRows: number;
  failures: Array<{ rowNumber: number; reason: string }>;
}

export interface RetentionRunResponse {
  dryRun: boolean;
  callRetentionDays: number;
  recordingRetentionDays: number;
  pcapRetentionDays: number;
  calls: number;
  recordingFiles: number;
  pcapFiles: number;
}

export interface ImportCsvRequest {
  filename: string;
  csvText: string;
}

export interface ImportCsvResponse {
  importId: string;
  filename: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  duplicateRows: number;
  detectedColumns: string[];
}

export interface CsvImportSummary {
  id: string;
  campaignId: string;
  campaignName: string;
  filename: string;
  status: string;
  totalRows: number;
  importedRows: number;
  failedRows: number;
  duplicateRows: number;
  createdAt: string;
  completedAt?: string;
}

export interface CsvImportHistoryResponse {
  imports: CsvImportSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CsvImportFailure {
  id: string;
  rowNumber: number;
  reason: string;
  row: Record<string, string>;
}

export interface CsvImportDetailResponse {
  import: CsvImportSummary;
  failures: CsvImportFailure[];
}

export type CampaignContactStatus = "ready" | "suppressed" | "completed";

export interface CampaignContactListItem {
  id: string;
  name: string;
  company: string;
  phoneNumber: string;
  status: CampaignContactStatus;
  createdAt: string;
  fields: Array<{ label: string; value: string }>;
}

export interface CampaignContactsResponse {
  contacts: CampaignContactListItem[];
  total: number;
}

export interface SuppressContactRequest {
  reason?: string;
}

export interface StartManualCallRequest {
  phoneNumber: string;
  campaignId?: string;
}

export interface StartNextCallRequest {
  campaignId?: string;
}

export interface EndCallRequest {
  campaignId?: string;
}

export interface DropVoicemailRequest {
  campaignId?: string;
  recordingId?: string;
}

export interface SendDtmfRequest {
  digit: string;
  campaignId?: string;
}

export interface MutationResponse<T> {
  item: T;
}

export interface DeleteResponse {
  ok: true;
}

export interface ManualDialValidationResponse {
  normalizedNumber: string;
  allowed: boolean;
  reason: string;
  checks: Array<{
    label: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>;
}

export type FreeSwitchTrunkStatus =
  "ready" | "not_configured" | "registration_failed" | "dns_error" | "error" | "unknown";

export interface FreeSwitchDiagnosticsResponse {
  checkedAt: string;
  esl: HealthCheck;
  trunk: {
    mode: "registration" | "ip_auth";
    configured: boolean;
    status: FreeSwitchTrunkStatus;
    summary: string;
    gatewayName?: string;
    proxyConfigured: boolean;
    usernameConfigured: boolean;
    callerIdConfigured: boolean;
    raw?: string;
  };
  controlPlane: {
    safeTestAvailable: boolean;
    listenerEnabled: boolean;
    lastSafeTestAt?: string;
  };
}

export interface FreeSwitchSafeTestResponse {
  ok: boolean;
  checkedAt: string;
  uuidCreated: boolean;
  apiStatusOk: boolean;
  bgapiStatusQueued: boolean;
  generatedUuid?: string;
  jobUuid?: string;
  message: string;
}
