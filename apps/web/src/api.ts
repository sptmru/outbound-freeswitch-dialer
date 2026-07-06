import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CreateCampaignRequest,
  CreateContactRequest,
  CreateSuppressionRequest,
  ManualDialValidationResponse,
  MutationResponse,
  PublicUser
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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
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

export async function fetchAgentDesk(): Promise<AgentDeskResponse> {
  return apiFetch<AgentDeskResponse>("/agent/desk");
}

export async function fetchAdminOverview(): Promise<AdminOverviewResponse> {
  return apiFetch<AdminOverviewResponse>("/admin/overview");
}

export async function validateManualDial(
  phoneNumber: string
): Promise<ManualDialValidationResponse> {
  return apiFetch<ManualDialValidationResponse>("/agent/manual-dial/validate", {
    method: "POST",
    body: JSON.stringify({ phoneNumber })
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
