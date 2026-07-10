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

export const userRoles = ["agent", "admin"] as const;

export type UserRole = (typeof userRoles)[number];

export type CampaignStatus = "active" | "paused" | "draft";

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "api";
  uptimeSeconds: number;
  checks: {
    postgres: HealthCheck;
    freeswitchEsl: HealthCheck;
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
}

export interface LeadSummary {
  id: string;
  name: string;
  company: string;
  phoneNumber: string;
  status: "ready" | "calling" | "suppressed" | "completed";
  fields: Array<{ label: string; value: string }>;
}

export interface AgentDeskResponse {
  user: PublicUser;
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
    actions: {
      dropVoicemail: CallActionAvailability;
      sendDtmf: CallActionAvailability;
    };
    timeline: Array<{ at: string; label: string }>;
  } | null;
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
  };
  campaigns: Array<{
    id: string;
    name: string;
    status: CampaignStatus;
    loaded: number;
    callable: number;
    earlyMediaAvmdEnabled: boolean;
  }>;
  recordings: Array<{
    id: string;
    name: string;
    durationSeconds: number;
    fileSizeBytes: number;
    runtimeFilePath: string;
    status: string;
  }>;
  users: PublicUser[];
  callHistory: Array<{
    id: string;
    leadName: string;
    agentName: string;
    phoneNumber: string;
    campaignName: string;
    state: CallState;
    outcome: CallOutcome | null;
    createdAt: string;
    durationSeconds: number;
    callRecordingPath: string | null;
  }>;
  suppression: Array<{
    id: string;
    phoneNumber: string;
    reason: string;
  }>;
}

export interface CallDetailResponse {
  call: AdminOverviewResponse["callHistory"][number] & {
    startedAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
    manualDial: boolean;
  };
  timeline: Array<{
    at: string;
    eventType: string;
    state: string;
    label: string;
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
  agentCredentials?: {
    sipUsername: string;
    sipPassword: string;
  };
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
  | "ready"
  | "not_configured"
  | "registration_failed"
  | "dns_error"
  | "error"
  | "unknown";

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
