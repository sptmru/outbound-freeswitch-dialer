import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AgentDeskResponse, PublicUser } from "./types";

const apiMocks = vi.hoisted(() => ({
  fetchAgentDesk: vi.fn(),
  fetchMe: vi.fn(),
  getStoredToken: vi.fn()
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchAgentDesk: apiMocks.fetchAgentDesk,
    fetchMe: apiMocks.fetchMe,
    getStoredToken: apiMocks.getStoredToken
  };
});

vi.mock("./softphone", () => ({
  useSoftphoneRegistration: () => ({
    registered: false,
    microphoneAllowed: true,
    state: "idle",
    callState: "none",
    label: "Softphone offline",
    detail: "Not registered in tests",
    error: null,
    incomingCallLabel: null,
    answerIncomingCall: async () => undefined,
    declineIncomingCall: async () => undefined,
    hangUpSoftphoneCall: async () => undefined
  })
}));

describe("App Agent Desk empty states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getStoredToken.mockReturnValue("test-token");
    apiMocks.fetchMe.mockResolvedValue({ user: userRow() });
  });

  it("renders an explicit no-campaign state instead of demo data", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ campaign: null, leads: [] }));

    render(<App />);

    expect(await screen.findByText("No active campaign is available")).toBeInTheDocument();
    expect(screen.getByText("Create or activate a campaign, then import leads.")).toBeInTheDocument();
    expect(screen.getByText("Manual dialing unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Solar Follow-up")).not.toBeInTheDocument();
    expect(screen.queryByText("Avery Johnson")).not.toBeInTheDocument();
  });

  it("renders an empty lead queue for active campaigns with no leads", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ leads: [] }));

    render(<App />);

    expect(await screen.findByText("No leads are queued for this campaign.")).toBeInTheDocument();
    expect(screen.getByText("Callable leads")).toBeInTheDocument();
    expect(screen.queryByText(/Recommended next:/)).not.toBeInTheDocument();
  });

  it("renders the simplified next lead recommendation", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "Solar Follow-up",
            phoneNumber: "+15551234567",
            status: "ready",
            fields: [{ label: "Voicemail", value: "Intro voicemail" }]
          }
        ]
      })
    );

    render(<App />);

    expect(await screen.findByText("Next lead")).toBeInTheDocument();
    expect(screen.getByText("Avery Johnson, +15551234567")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start next call/ })).toBeInTheDocument();
    expect(screen.queryByText(/Recommended next:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default voicemail/)).not.toBeInTheDocument();
  });
});

function userRow(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    email: "agent@example.com",
    name: "Agent Example",
    role: "agent",
    ...overrides
  };
}

function deskResponse(overrides: Partial<AgentDeskResponse> = {}): AgentDeskResponse {
  const campaign = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Selected campaign",
    status: "active" as const,
    callableLeads: 0,
    manualDialingEnabled: true,
    callRecordingEnabled: false
  };

  return {
    user: userRow(),
    campaign,
    availableCampaigns: [
      {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        callableLeads: campaign.callableLeads
      }
    ],
    softphone: {
      registered: false,
      microphoneAllowed: true,
      status: "ready"
    },
    metrics: {
      todayCalls: 0,
      voicemailsDropped: 0,
      suppressed: 0
    },
    leads: [],
    activeCall: null,
    ...overrides
  };
}
