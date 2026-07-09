import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AgentDeskResponse, PublicUser } from "./types";

const apiMocks = vi.hoisted(() => ({
  dropVoicemail: vi.fn(),
  fetchAgentDesk: vi.fn(),
  fetchMe: vi.fn(),
  getStoredToken: vi.fn()
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    dropVoicemail: apiMocks.dropVoicemail,
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

  it("drops voicemail with the selected active-call recording", async () => {
    const activeDesk = deskResponse({
      activeCall: {
        id: "33333333-3333-4333-8333-333333333333",
        state: "bridged",
        leadName: "Avery Johnson",
        phoneNumber: "+15551234567",
        durationSeconds: 12,
        status: "bridged",
        voicemailSignal: "detected",
        recordingId: "44444444-4444-4444-8444-444444444444",
        recordingName: "Default voicemail",
        timeline: []
      },
      recordings: [
        recordingRow({
          id: "44444444-4444-4444-8444-444444444444",
          name: "Default voicemail",
          status: "default"
        }),
        recordingRow({
          id: "55555555-5555-4555-8555-555555555555",
          name: "Alternate voicemail",
          status: "ready"
        })
      ]
    });
    apiMocks.fetchAgentDesk.mockResolvedValue(activeDesk);
    apiMocks.dropVoicemail.mockResolvedValue(deskResponse({ activeCall: null }));

    render(<App />);

    const recordingSelect = await screen.findByDisplayValue("Default voicemail (default)");
    fireEvent.change(recordingSelect, { target: { value: "55555555-5555-4555-8555-555555555555" } });
    fireEvent.click(screen.getByRole("button", { name: /Drop voicemail/ }));

    await waitFor(() => {
      expect(apiMocks.dropVoicemail).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
        campaignId: "11111111-1111-4111-8111-111111111111",
        recordingId: "55555555-5555-4555-8555-555555555555"
      });
    });
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
    recordings: [recordingRow()],
    activeCall: null,
    ...overrides
  };
}

function recordingRow(
  overrides: Partial<AgentDeskResponse["recordings"][number]> = {}
): AgentDeskResponse["recordings"][number] {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Default voicemail",
    status: "default",
    ...overrides
  };
}
