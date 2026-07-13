import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AdminOverviewResponse, AgentDeskResponse, PublicUser } from "./types";

const apiMocks = vi.hoisted(() => ({
  dropVoicemail: vi.fn(),
  endCall: vi.fn(),
  fetchAdminOverview: vi.fn(),
  fetchAgentDesk: vi.fn(),
  fetchCallDetail: vi.fn(),
  fetchCsvImports: vi.fn(),
  fetchMe: vi.fn(),
  getStoredToken: vi.fn(),
  useSoftphoneRegistration: vi.fn()
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    dropVoicemail: apiMocks.dropVoicemail,
    endCall: apiMocks.endCall,
    fetchAdminOverview: apiMocks.fetchAdminOverview,
    fetchAgentDesk: apiMocks.fetchAgentDesk,
    fetchCallDetail: apiMocks.fetchCallDetail,
    fetchCsvImports: apiMocks.fetchCsvImports,
    fetchMe: apiMocks.fetchMe,
    getStoredToken: apiMocks.getStoredToken
  };
});

vi.mock("./softphone", () => ({
  useSoftphoneRegistration: apiMocks.useSoftphoneRegistration
}));

const softphoneRuntime = {
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
  };

describe("App Agent Desk empty states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("outbound_dialer_token", "test-token");
    apiMocks.getStoredToken.mockReturnValue("test-token");
    apiMocks.fetchMe.mockResolvedValue({ user: userRow() });
    apiMocks.fetchCsvImports.mockResolvedValue({ imports: [] });
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse());
    apiMocks.useSoftphoneRegistration.mockReturnValue(softphoneRuntime);
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
    expect(screen.queryByText("Company")).not.toBeInTheDocument();
    expect(screen.queryByText("Solar Follow-up")).not.toBeInTheDocument();
    expect(screen.queryByText(/Recommended next:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default voicemail/)).not.toBeInTheDocument();
  });

  it("drops voicemail with the selected active-call recording", async () => {
    const activeDesk = deskResponse({
      activeCall: activeCallRow({
        id: "33333333-3333-4333-8333-333333333333",
        state: "bridged",
        leadName: "Avery Johnson",
        phoneNumber: "+15551234567",
        durationSeconds: 12,
        status: "bridged",
        voicemailSignal: "detected",
        recordingId: "44444444-4444-4444-8444-444444444444",
        recordingName: "Default voicemail"
      }),
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

  it("disables unavailable call actions and formats the call timer", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        activeCall: activeCallRow({
          durationSeconds: 72,
          state: "customer_ringing",
          status: "ringing",
          actions: {
            dropVoicemail: { allowed: false, reason: "Wait until the customer is connected" },
            sendDtmf: { allowed: false, reason: "DTMF is available after the customer connects" }
          }
        })
      })
    );

    render(<App />);

    expect(await screen.findByLabelText("Call duration 01:12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Drop voicemail/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
    expect(screen.getByText("Wait until the customer is connected")).toBeInTheDocument();
  });

  it("ends a call without forcing an agent-selected outcome", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ activeCall: activeCallRow() }));
    apiMocks.endCall.mockResolvedValue(deskResponse({ activeCall: null }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Hang up" }));

    await waitFor(() => {
      expect(apiMocks.endCall).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
        campaignId: "11111111-1111-4111-8111-111111111111"
      });
    });
  });

  it("stops softphone registration and hides phone status outside Agent Desk", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));

    render(<App />);
    const campaigns = await screen.findByRole("button", { name: "Campaigns" });
    fireEvent.click(campaigns);

    await waitFor(() => expect(apiMocks.useSoftphoneRegistration).toHaveBeenLastCalledWith(null));
    expect(screen.queryByText("Phone offline")).not.toBeInTheDocument();
    expect(screen.queryByText("Mic ready")).not.toBeInTheDocument();
  });

  it("keeps admin on Agent Desk while a call is active", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin, activeCall: activeCallRow() }));

    render(<App />);

    expect(await screen.findByRole("button", { name: "Campaigns" })).toBeDisabled();
    expect(screen.getAllByTitle("Finish the active call first")).toHaveLength(5);
  });

  it("shows the campaign early-media AVMD warning only while the setting is enabled", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(
      adminResponse({
        campaigns: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Selected campaign",
            status: "active",
            loaded: 10,
            callable: 8,
            earlyMediaAvmdEnabled: true
          }
        ]
      })
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));

    expect(await screen.findByText("Early-media AVMD")).toBeInTheDocument();
    const createAvmdToggle = screen.getByRole("checkbox", { name: "AVMD in early media" });
    expect(createAvmdToggle).not.toBeChecked();
    expect(screen.queryByText(/slightly increases the chance of false positives/i)).not.toBeInTheDocument();

    fireEvent.click(createAvmdToggle);
    expect(screen.getByText(/slightly increases the chance of false positives/i)).toBeInTheDocument();
    fireEvent.click(createAvmdToggle);
    expect(screen.queryByText(/slightly increases the chance of false positives/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Edit campaign"));
    const editAvmdToggle = screen.getByRole("checkbox", { name: "Start AVMD during early media" });
    expect(editAvmdToggle).toBeChecked();
    expect(screen.getByText(/slightly increases the chance of false positives/i)).toBeInTheDocument();

    fireEvent.click(editAvmdToggle);
    expect(screen.queryByText(/slightly increases the chance of false positives/i)).not.toBeInTheDocument();
  });

  it("plays a call recording and keeps technical events collapsed until requested", async () => {
    const admin = userRow({ role: "admin" });
    const call = callHistoryRow({ callRecordingPath: `/recordings/calls/${callHistoryRow().id}.wav` });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ callHistory: [call] }));
    apiMocks.fetchCallDetail.mockResolvedValue({
      call: { ...call, startedAt: call.createdAt, answeredAt: call.createdAt, endedAt: call.createdAt, manualDial: false },
      timeline: [{ at: call.createdAt, eventType: "CHANNEL_ANSWER", state: "bridged", label: "Customer connected" }]
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Call history" }));
    fireEvent.click(await screen.findByRole("button", { name: /Avery Johnson/ }));

    const player = await screen.findByLabelText("Call recording for Avery Johnson");
    expect(player).toHaveAttribute(
      "src",
      `/api/admin/calls/${call.id}/recording?token=test-token`
    );
    expect(screen.queryByText("Customer connected")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show technical details" }));
    expect(await screen.findByText("Customer connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide technical details" })).toHaveAttribute("aria-expanded", "true");
    expect(apiMocks.fetchCallDetail).toHaveBeenCalledWith(call.id);
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
    callRecordingEnabled: false,
    earlyMediaAvmdEnabled: false
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

function activeCallRow(
  overrides: Partial<NonNullable<AgentDeskResponse["activeCall"]>> = {}
): NonNullable<AgentDeskResponse["activeCall"]> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    state: "bridged",
    leadName: "Avery Johnson",
    phoneNumber: "+15551234567",
    durationSeconds: 12,
    status: "bridged",
    voicemailSignal: "detected",
    recordingId: "44444444-4444-4444-8444-444444444444",
    recordingName: "Default voicemail",
    actions: {
      dropVoicemail: { allowed: true, reason: null },
      sendDtmf: { allowed: true, reason: null }
    },
    timeline: [],
    ...overrides
  };
}

function adminResponse(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    user: userRow({ role: "admin" }),
    stats: { campaigns: 0, activeAgents: 0, callsToday: 0, suppressionEntries: 0, liveCalls: 0 },
    campaigns: [],
    recordings: [],
    users: [],
    callHistory: [],
    suppression: [],
    ...overrides
  };
}

function callHistoryRow(
  overrides: Partial<AdminOverviewResponse["callHistory"][number]> = {}
): AdminOverviewResponse["callHistory"][number] {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    leadName: "Avery Johnson",
    agentName: "Agent Example",
    phoneNumber: "+15551234567",
    campaignName: "Selected campaign",
    state: "completed",
    outcome: "answered",
    createdAt: "2026-07-10T08:00:00.000Z",
    durationSeconds: 72,
    callRecordingPath: null,
    ...overrides
  };
}
