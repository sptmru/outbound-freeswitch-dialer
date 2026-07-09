import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CampaignContactListItem,
  CampaignContactsResponse,
  CreateCampaignRequest,
  CreateContactRequest,
  CreateRecordingResponse,
  CreateSuppressionRequest,
  CreateUserRequest,
  CreateUserResponse,
  DeleteResponse,
  CsvImportDetailResponse,
  CsvImportHistoryResponse,
  EndCallRequest,
  FreeSwitchDiagnosticsResponse,
  FreeSwitchSafeTestResponse,
  ImportCsvRequest,
  ImportCsvResponse,
  ManualDialValidationResponse,
  MutationResponse,
  PublicUser,
  SoftphoneProvisioningResponse,
  StartNextCallRequest,
  StartManualCallRequest,
  SuppressContactRequest,
  UpdateCampaignRequest
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "outbound_dialer_token";

type LoginResponse = {
  token: string;
  user: PublicUser;
};

export function getStoredToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const isFormData = options.body instanceof FormData;
  const hasBody = options.body !== undefined && options.body !== null;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(hasBody && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      typeof errorBody.error === "string"
        ? errorBody.error
        : typeof errorBody.message === "string"
          ? errorBody.message
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
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

export async function fetchAgentDesk(campaignId?: string): Promise<AgentDeskResponse> {
  const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
  return apiFetch<AgentDeskResponse>(`/agent/desk${query}`);
}

export async function fetchSoftphoneProvisioning(): Promise<SoftphoneProvisioningResponse> {
  return apiFetch<SoftphoneProvisioningResponse>("/agent/softphone/provisioning");
}

export async function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  return apiFetch<AdminOverviewResponse>("/admin/overview");
}

export async function fetchFreeSwitchDiagnostics(): Promise<FreeSwitchDiagnosticsResponse> {
  return apiFetch<FreeSwitchDiagnosticsResponse>("/admin/freeswitch/diagnostics");
}

export async function runFreeSwitchSafeTest(): Promise<FreeSwitchSafeTestResponse> {
  return apiFetch<FreeSwitchSafeTestResponse>("/admin/freeswitch/safe-test", {
    method: "POST"
  });
}

export async function fetchCsvImports(): Promise<CsvImportHistoryResponse> {
  return apiFetch<CsvImportHistoryResponse>("/admin/csv-imports");
}

export async function fetchCsvImportDetail(importId: string): Promise<CsvImportDetailResponse> {
  return apiFetch<CsvImportDetailResponse>(`/admin/csv-imports/${importId}`);
}

export async function fetchCampaignContacts(
  campaignId: string,
  filters: { q?: string; status?: "all" | "ready" | "suppressed" | "completed" } = {}
): Promise<CampaignContactsResponse> {
  const params = new URLSearchParams();
  if (filters.q) {
    params.set("q", filters.q);
  }
  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  const query = params.toString();
  return apiFetch<CampaignContactsResponse>(`/admin/campaigns/${campaignId}/contacts${query ? `?${query}` : ""}`);
}

export async function validateManualDial(phoneNumber: string): Promise<ManualDialValidationResponse> {
  return apiFetch<ManualDialValidationResponse>("/agent/manual-dial/validate", {
    method: "POST",
    body: JSON.stringify({ phoneNumber })
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

export async function startLeadCall(contactId: string): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/leads/${contactId}/call`, {
    method: "POST"
  });
}

export async function endCall(callId: string, input: EndCallRequest = {}): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>(`/agent/calls/${callId}/end`, {
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
  return apiFetch<MutationResponse<AdminOverviewResponse["campaigns"][number]>>(`/admin/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function uploadRecording(input: {
  file: File;
  name: string;
  makeDefault: boolean;
}): Promise<CreateRecordingResponse> {
  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("name", input.name);
  formData.set("makeDefault", String(input.makeDefault));

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

export async function createContact(input: CreateContactRequest): Promise<MutationResponse<AgentDeskResponse["leads"][number]>> {
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
