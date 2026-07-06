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
  };
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
  activeCall: {
    id: string;
    state: CallState;
    outcome?: CallOutcome;
    leadName: string;
    phoneNumber: string;
    durationSeconds: number;
    status: "dialing" | "ringing" | "bridged" | "voicemail_drop" | "completed";
    voicemailSignal: "none" | "possible" | "detected";
    recordingName: string;
    timeline: Array<{ at: string; label: string }>;
  } | null;
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
    status: string;
    loaded: number;
    callable: number;
  }>;
  recordings: Array<{
    id: string;
    name: string;
    durationSeconds: number;
    status: string;
  }>;
  users: PublicUser[];
  callHistory: Array<{
    id: string;
    leadName: string;
    agentName: string;
    outcome: CallOutcome;
    durationSeconds: number;
  }>;
  suppression: Array<{
    id: string;
    phoneNumber: string;
    reason: string;
  }>;
}

export interface CreateCampaignRequest {
  name: string;
  status: "active" | "paused" | "draft";
  manualDialingEnabled: boolean;
  callRecordingEnabled: boolean;
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

export interface MutationResponse<T> {
  item: T;
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
