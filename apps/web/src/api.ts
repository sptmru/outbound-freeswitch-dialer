import type {
  AdminAnalyticsResponse,
  AdminOverviewResponse,
  AdminAuditResponse,
  AdminCampaignListResponse,
  AdminRecordingListResponse,
  AdminUserListResponse,
  AdminSystemSettings,
  BrowserMediaTelemetryRequest,
  UpdateAdminSystemSettingsRequest,
  AgentDeskResponse,
  CampaignContactListItem,
  CampaignContactsResponse,
  CallAvmdReview,
  CallDetailResponse,
  CallHistoryResponse,
  CreateCampaignRequest,
  CreateContactRequest,
  CreateRecordingResponse,
  CreateSuppressionRequest,
  CreateUserRequest,
  CreateUserResponse,
  DeleteResponse,
  DropVoicemailRequest,
  CsvImportDetailResponse,
  CsvImportHistoryResponse,
  EndCallRequest,
  FreeSwitchDiagnosticsResponse,
  FreeSwitchSafeTestResponse,
  ImportCsvRequest,
  ImportCsvResponse,
  ManualDialValidationResponse,
  MediaTicketResponse,
  MutationResponse,
  PublicUser,
  SuppressionImportResponse,
  SuppressionListResponse,
  SendDtmfRequest,
  SoftphoneProvisioningResponse,
  StartLeadCallRequest,
  StartNextCallRequest,
  StartManualCallRequest,
  SuppressContactRequest,
  UpdateCampaignRequest,
  UpdateAgentAvailabilityRequest,
  UpsertCallAvmdReviewRequest,
  UpdateUserRequest,
  UpdateUserResponse
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

type LoginResponse = {
  token: string;
  user: PublicUser;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const hasBody = options.body !== undefined && options.body !== null;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(hasBody && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      isRecord(errorBody) && typeof errorBody.error === "string"
        ? errorBody.error
        : isRecord(errorBody) && typeof errorBody.message === "string"
          ? errorBody.message
          : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, errorBody);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function fetchMe(): Promise<{ user: PublicUser }> {
  return apiFetch<{ user: PublicUser }>("/auth/me");
}

export async function logout(): Promise<void> {
  return apiFetch<void>("/auth/logout", { method: "POST" });
}

/**
 * Native EventSource reconnects automatically after transient failures. The
 * caller keeps a periodic HTTP refresh as a fallback for blocked/unsupported
 * SSE connections and closes this subscription when the session ends.
 */
export function subscribeAgentEvents(input: {
  onConnectionChange?: (connected: boolean) => void;
  onRefresh: (event: AgentLiveRefreshEvent) => void;
}): () => void {
  const source = new EventSource(`${API_BASE_URL}/agent/events`, { withCredentials: true });
  source.addEventListener("open", () => input.onConnectionChange?.(true));
  source.addEventListener("refresh", (event) => {
    const fallback: AgentLiveRefreshEvent = { source: "database", occurredAt: new Date().toISOString() };
    if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
      input.onRefresh(fallback);
      return;
    }
    try {
      const parsed = JSON.parse(event.data) as unknown;
      input.onRefresh(
        isRecord(parsed) && typeof parsed.source === "string" && typeof parsed.occurredAt === "string"
          ? { source: parsed.source, occurredAt: parsed.occurredAt }
          : fallback
      );
    } catch {
      input.onRefresh(fallback);
    }
  });
  source.addEventListener("error", () => input.onConnectionChange?.(false));
  return () => source.close();
}

export type AgentLiveRefreshEvent = {
  source: string;
  occurredAt: string;
};

export async function fetchAgentDesk(campaignId?: string): Promise<AgentDeskResponse> {
  const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
  return apiFetch<AgentDeskResponse>(`/agent/desk${query}`);
}

export async function updateAgentAvailability(
  input: UpdateAgentAvailabilityRequest
): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>("/agent/availability", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function fetchSoftphoneProvisioning(): Promise<SoftphoneProvisioningResponse> {
  return apiFetch<SoftphoneProvisioningResponse>("/agent/softphone/provisioning");
}

export async function submitBrowserMediaTelemetry(
  callId: string,
  input: BrowserMediaTelemetryRequest
): Promise<void> {
  return apiFetch<void>(`/agent/calls/${encodeURIComponent(callId)}/browser-media`, {
    method: "PUT",
    body: JSON.stringify(input),
    keepalive: true
  });
}

export async function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  return apiFetch<AdminOverviewResponse>("/admin/overview");
}

export type AdminAnalyticsFilters = {
  from: string;
  to: string;
  timeZone: string;
  campaignId?: string;
};

export async function fetchAdminAnalytics(filters: AdminAnalyticsFilters): Promise<AdminAnalyticsResponse> {
  const query = toQuery(filters);
  return apiFetch<AdminAnalyticsResponse>(`/admin/analytics?${query}`);
}

export async function fetchAdminAudit(
  filters: {
    page?: number;
    pageSize?: number;
    actorId?: string;
    method?: "DELETE" | "PATCH" | "POST" | "PUT";
    dateFrom?: string;
    dateTo?: string;
  } = {}
): Promise<AdminAuditResponse> {
  const query = toQuery(filters);
  return apiFetch<AdminAuditResponse>(`/admin/audit-events${query ? `?${query}` : ""}`);
}

export async function fetchCallDetail(callId: string): Promise<CallDetailResponse> {
  return apiFetch<CallDetailResponse>(`/admin/calls/${callId}`);
}

export async function upsertCallAvmdReview(
  callId: string,
  input: UpsertCallAvmdReviewRequest
): Promise<CallAvmdReview> {
  return apiFetch<CallAvmdReview>(`/admin/calls/${encodeURIComponent(callId)}/avmd-review`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export async function getCallRecordingAudioUrl(callId: string): Promise<string> {
  const ticket = await apiFetch<MediaTicketResponse>(`/admin/calls/${callId}/recording-ticket`, {
    method: "POST"
  });
  return `${API_BASE_URL}${ticket.url}`;
}

export type CallHistoryFilters = {
  page?: number;
  pageSize?: number;
  q?: string;
  campaignId?: string;
  agentId?: string;
  outcome?: string;
  from?: string;
  to?: string;
  voicemail?: "drop" | "signal";
  recording?: "available" | "missing";
  avmdReview?: "needs_review" | "reviewed" | "uncertain";
};

export type AdminLibraryFilters = {
  page?: number;
  pageSize?: number;
  q?: string;
};

function toQuery(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export async function fetchCallHistory(filters: CallHistoryFilters = {}): Promise<CallHistoryResponse> {
  const query = toQuery(filters);
  return apiFetch<CallHistoryResponse>(`/admin/calls${query ? `?${query}` : ""}`);
}

export async function downloadCallHistoryCsv(
  filters: Omit<CallHistoryFilters, "page" | "pageSize"> = {}
): Promise<Blob> {
  const query = toQuery(filters);
  const response = await fetch(`${API_BASE_URL}/admin/calls/export.csv${query ? `?${query}` : ""}`, {
    credentials: "include"
  });
  if (!response.ok) {
    throw new ApiError("Could not export call history", response.status, await response.text());
  }
  return response.blob();
}

export async function downloadCallPcap(callId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/admin/calls/${encodeURIComponent(callId)}/pcap`, {
    credentials: "include"
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      isRecord(body) && typeof body.message === "string" ? body.message : "Could not download PCAP capture";
    throw new ApiError(message, response.status, body);
  }
  return response.blob();
}

export async function fetchFreeSwitchDiagnostics(): Promise<FreeSwitchDiagnosticsResponse> {
  return apiFetch<FreeSwitchDiagnosticsResponse>("/admin/freeswitch/diagnostics");
}

export async function runFreeSwitchSafeTest(): Promise<FreeSwitchSafeTestResponse> {
  return apiFetch<FreeSwitchSafeTestResponse>("/admin/freeswitch/safe-test", {
    method: "POST"
  });
}

export async function fetchSystemSettings(): Promise<AdminSystemSettings> {
  return apiFetch<AdminSystemSettings>("/admin/system-settings");
}

export async function updateSystemSettings(
  input: UpdateAdminSystemSettingsRequest
): Promise<AdminSystemSettings> {
  return apiFetch<AdminSystemSettings>("/admin/system-settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function fetchAdminCampaigns(
  filters: AdminLibraryFilters = {}
): Promise<AdminCampaignListResponse> {
  const query = toQuery(filters);
  return apiFetch<AdminCampaignListResponse>(`/admin/campaigns${query ? `?${query}` : ""}`);
}

export async function fetchAdminRecordings(
  filters: AdminLibraryFilters = {}
): Promise<AdminRecordingListResponse> {
  const query = toQuery(filters);
  return apiFetch<AdminRecordingListResponse>(`/admin/recordings${query ? `?${query}` : ""}`);
}

export async function fetchAdminUsers(filters: AdminLibraryFilters = {}): Promise<AdminUserListResponse> {
  const query = toQuery(filters);
  return apiFetch<AdminUserListResponse>(`/admin/users${query ? `?${query}` : ""}`);
}

export async function fetchCsvImports(filters: AdminLibraryFilters = {}): Promise<CsvImportHistoryResponse> {
  const query = toQuery(filters);
  return apiFetch<CsvImportHistoryResponse>(`/admin/csv-imports${query ? `?${query}` : ""}`);
}

export async function fetchCsvImportDetail(
  importId: string,
  filters: { failurePage?: number; failurePageSize?: number } = {}
): Promise<CsvImportDetailResponse> {
  const query = toQuery(filters);
  return apiFetch<CsvImportDetailResponse>(`/admin/csv-imports/${importId}${query ? `?${query}` : ""}`);
}

export async function fetchCampaignContacts(
  campaignId: string,
  filters: {
    q?: string;
    status?: "all" | "ready" | "suppressed" | "completed";
    page?: number;
    pageSize?: number;
  } = {}
): Promise<CampaignContactsResponse> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  if (filters.page) {
    params.set("page", String(filters.page));
  }
  if (filters.pageSize) {
    params.set("pageSize", String(filters.pageSize));
  }
  const query = params.toString();
  return apiFetch<CampaignContactsResponse>(
    `/admin/campaigns/${campaignId}/contacts${query ? `?${query}` : ""}`
  );
}

export async function validateManualDial(
  phoneNumber: string,
  campaignId?: string
): Promise<ManualDialValidationResponse> {
  return apiFetch<ManualDialValidationResponse>("/agent/manual-dial/validate", {
    method: "POST",
    body: JSON.stringify({ phoneNumber, campaignId })
  });
}

export async function startManualCall(input: StartManualCallRequest): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>("/agent/manual-dial/start", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function startNextCall(input: StartNextCallRequest = {}): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>("/agent/call-next", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function startLeadCall(
  contactId: string,
  input: StartLeadCallRequest = {}
): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/leads/${contactId}/call`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function endCall(callId: string, input: EndCallRequest = {}): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/calls/${callId}/end`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function dropVoicemail(
  callId: string,
  input: DropVoicemailRequest = {}
): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/calls/${callId}/drop-voicemail`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function sendDtmf(callId: string, input: SendDtmfRequest): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/calls/${callId}/dtmf`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createCampaign(
  input: CreateCampaignRequest
): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]>> {
  return apiFetch<MutationResponse<AdminOverviewResponse["campaigns"][number]>>("/admin/campaigns", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function deleteCampaign(campaignId: string): Promise<DeleteResponse> {
  return apiFetch<DeleteResponse>(`/admin/campaigns/${campaignId}`, {
    method: "DELETE"
  });
}

export async function updateCampaign(
  campaignId: string,
  input: UpdateCampaignRequest
): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]>> {
  return apiFetch<MutationResponse<AdminOverviewResponse["campaigns"][number]>>(
    `/admin/campaigns/${campaignId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    }
  );
}

export async function uploadRecording(input: {
  file: File;
  name: string;
  makeDefault: boolean;
}): Promise<CreateRecordingResponse> {
  const formData = new FormData();
  formData.set("name", input.name);
  formData.set("makeDefault", String(input.makeDefault));
  formData.set("file", input.file);

  return apiFetch<CreateRecordingResponse>("/admin/recordings", {
    method: "POST",
    body: formData
  });
}

export async function setDefaultRecording(
  recordingId: string
): Promise<MutationResponse<AdminOverviewResponse["recordings"][number]>> {
  return apiFetch<MutationResponse<AdminOverviewResponse["recordings"][number]>>(
    `/admin/recordings/${recordingId}/default`,
    {
      method: "PATCH"
    }
  );
}

export async function deleteRecording(recordingId: string): Promise<DeleteResponse> {
  return apiFetch<DeleteResponse>(`/admin/recordings/${recordingId}`, {
    method: "DELETE"
  });
}

export async function getRecordingAudioUrl(recordingId: string): Promise<string> {
  const ticket = await apiFetch<MediaTicketResponse>(`/admin/recordings/${recordingId}/audio-ticket`, {
    method: "POST"
  });
  return `${API_BASE_URL}${ticket.url}`;
}

export async function createUser(input: CreateUserRequest): Promise<CreateUserResponse> {
  return apiFetch<CreateUserResponse>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function deleteUser(userId: string): Promise<DeleteResponse> {
  return apiFetch<DeleteResponse>(`/admin/users/${userId}`, {
    method: "DELETE"
  });
}

export async function updateUser(userId: string, input: UpdateUserRequest): Promise<UpdateUserResponse> {
  return apiFetch<UpdateUserResponse>(`/admin/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function createContact(
  input: CreateContactRequest
): Promise<MutationResponse<AgentDeskResponse["leads"][number]>> {
  return apiFetch<MutationResponse<AgentDeskResponse["leads"][number]>>("/admin/contacts", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createSuppression(
  input: CreateSuppressionRequest
): Promise<MutationResponse<AdminOverviewResponse["suppression"][number]>> {
  return apiFetch<MutationResponse<AdminOverviewResponse["suppression"][number]>>("/admin/suppression", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function deleteSuppression(suppressionId: string): Promise<DeleteResponse> {
  return apiFetch<DeleteResponse>(`/admin/suppression/${suppressionId}`, {
    method: "DELETE"
  });
}

export async function fetchSuppression(
  filters: { q?: string; page?: number; pageSize?: number } = {}
): Promise<SuppressionListResponse> {
  const query = toQuery(filters);
  return apiFetch<SuppressionListResponse>(`/admin/suppression${query ? `?${query}` : ""}`);
}

export async function importSuppressionCsvFile(file: File): Promise<SuppressionImportResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<SuppressionImportResponse>("/admin/suppression/import-csv-file", {
    method: "POST",
    body: formData
  });
}

export async function suppressContact(
  contactId: string,
  input: SuppressContactRequest = {}
): Promise<MutationResponse<CampaignContactListItem>> {
  return apiFetch<MutationResponse<CampaignContactListItem>>(`/admin/contacts/${contactId}/suppress`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function completeContact(contactId: string): Promise<MutationResponse<CampaignContactListItem>> {
  return apiFetch<MutationResponse<CampaignContactListItem>>(`/admin/contacts/${contactId}/complete`, {
    method: "POST"
  });
}

export async function importCampaignCsv(
  campaignId: string,
  input: ImportCsvRequest
): Promise<ImportCsvResponse> {
  return apiFetch<ImportCsvResponse>(`/admin/campaigns/${campaignId}/import-csv`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function importCampaignCsvFile(campaignId: string, file: File): Promise<ImportCsvResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<ImportCsvResponse>(`/admin/campaigns/${campaignId}/import-csv-file`, {
    method: "POST",
    body: formData
  });
}
