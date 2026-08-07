import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, formatCallLifecycleStatus } from "./App";
import type {
  AdminAnalyticsResponse,
  AdminOverviewResponse,
  AgentDeskResponse,
  CallDetailResponse,
  PublicUser
} from "./types";

const apiMocks = vi.hoisted(() => ({
  dropVoicemail: vi.fn(),
  endCall: vi.fn(),
  fetchAdminAnalytics: vi.fn(),
  fetchAdminLiveCalls: vi.fn(),
  fetchAdminCampaigns: vi.fn(),
  fetchAdminOverview: vi.fn(),
  fetchAgentDesk: vi.fn(),
  fetchCampaignContacts: vi.fn(),
  fetchCallDetail: vi.fn(),
  fetchCallHistory: vi.fn(),
  fetchCsvImportDetail: vi.fn(),
  fetchCsvImports: vi.fn(),
  fetchMe: vi.fn(),
  fetchSystemSettings: vi.fn(),
  getCallRecordingAudioUrl: vi.fn(),
  logout: vi.fn(),
  resetCampaignLeads: vi.fn(),
  sendDtmf: vi.fn(),
  startLeadCall: vi.fn(),
  startManualCall: vi.fn(),
  startNextCall: vi.fn(),
  startSupervisorSession: vi.fn(),
  stopSupervisorSession: vi.fn(),
  subscribeAgentEvents: vi.fn(),
  updateAgentAvailability: vi.fn(),
  upsertCallAvmdReview: vi.fn(),
  updateSystemSettings: vi.fn(),
  updateSupervisorMode: vi.fn(),
  useSoftphoneRegistration: vi.fn(),
  useSupervisorSoftphone: vi.fn()
}));

describe("call lifecycle status labels", () => {
  it.each([
    ["created", null, "Calling"],
    ["customer_ringing", null, "Ringing"],
    ["agent_answered", null, "Answered"],
    ["bridged", null, "In progress"],
    ["failed", "failed", "Failed"],
    ["completed", "not_answered", "No answer"],
    ["canceled", "agent_canceled", "Cancelled"],
    ["completed", "answered", "Completed"],
    ["completed", "voicemail_dropped", "Completed (voicemail dropped)"]
  ] as const)("maps %s / %s to %s", (state, outcome, label) => {
    expect(formatCallLifecycleStatus(state, outcome)).toBe(label);
  });
});

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    dropVoicemail: apiMocks.dropVoicemail,
    endCall: apiMocks.endCall,
    fetchAdminAnalytics: apiMocks.fetchAdminAnalytics,
    fetchAdminLiveCalls: apiMocks.fetchAdminLiveCalls,
    fetchAdminCampaigns: apiMocks.fetchAdminCampaigns,
    fetchAdminOverview: apiMocks.fetchAdminOverview,
    fetchAgentDesk: apiMocks.fetchAgentDesk,
    fetchCampaignContacts: apiMocks.fetchCampaignContacts,
    fetchCallDetail: apiMocks.fetchCallDetail,
    fetchCallHistory: apiMocks.fetchCallHistory,
    fetchCsvImportDetail: apiMocks.fetchCsvImportDetail,
    fetchCsvImports: apiMocks.fetchCsvImports,
    fetchMe: apiMocks.fetchMe,
    fetchSystemSettings: apiMocks.fetchSystemSettings,
    getCallRecordingAudioUrl: apiMocks.getCallRecordingAudioUrl,
    logout: apiMocks.logout,
    resetCampaignLeads: apiMocks.resetCampaignLeads,
    sendDtmf: apiMocks.sendDtmf,
    startLeadCall: apiMocks.startLeadCall,
    startManualCall: apiMocks.startManualCall,
    startNextCall: apiMocks.startNextCall,
    startSupervisorSession: apiMocks.startSupervisorSession,
    stopSupervisorSession: apiMocks.stopSupervisorSession,
    subscribeAgentEvents: apiMocks.subscribeAgentEvents,
    updateAgentAvailability: apiMocks.updateAgentAvailability,
    upsertCallAvmdReview: apiMocks.upsertCallAvmdReview,
    updateSystemSettings: apiMocks.updateSystemSettings,
    updateSupervisorMode: apiMocks.updateSupervisorMode
  };
});

vi.mock("./softphone", () => ({
  useSoftphoneRegistration: apiMocks.useSoftphoneRegistration
}));

vi.mock("./supervisor-softphone", () => ({
  useSupervisorSoftphone: apiMocks.useSupervisorSoftphone
}));

const softphoneRuntime = {
  registered: false,
  microphoneAllowed: true,
  audioSetup: {
    appliedSettings: {
      autoGainControl: true,
      channelCount: 1,
      deviceId: "default",
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48_000
    },
    checkError: null,
    checkResult: null,
    checking: false,
    inputDevices: [{ deviceId: "mic-1", label: "USB microphone" }],
    inputLevel: 0,
    outputDevices: [{ deviceId: "speaker-1", label: "USB headset" }],
    outputSelectionSupported: true,
    processingProfile: "office",
    selectedInputId: "",
    selectedOutputId: "",
    signalStatus: "idle"
  },
  state: "idle",
  callState: "none",
  audioPlaybackState: "idle",
  label: "Softphone offline",
  detail: "Not registered in tests",
  error: null,
  incomingCallLabel: null,
  refreshAudioDevices: async () => undefined,
  runAudioCheck: async () => undefined,
  selectMicrophone: () => undefined,
  selectSpeaker: async () => undefined,
  setMicrophoneProcessingProfile: () => undefined,
  answerIncomingCall: async () => undefined,
  declineIncomingCall: async () => undefined,
  hangUpSoftphoneCall: async () => undefined,
  retryRemoteAudio: async () => undefined,
  startBrowserRingback: vi.fn(),
  stopBrowserRingback: vi.fn()
};

const supervisorSoftphoneRuntime = {
  registered: true,
  state: "registered",
  callState: "none",
  mode: null,
  sessionId: null,
  microphoneActive: false,
  audioPlaybackState: "idle",
  error: null,
  retryRemoteAudio: async () => undefined
};

describe("App Agent Desk empty states", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("outbound_dialer_selected_campaign_id");
    apiMocks.fetchMe.mockResolvedValue({ user: userRow() });
    apiMocks.fetchCsvImports.mockResolvedValue({
      imports: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0
    });
    apiMocks.fetchAdminAnalytics.mockResolvedValue(adminAnalyticsResponse());
    apiMocks.fetchAdminLiveCalls.mockResolvedValue({ calls: [], activeSession: null });
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse());
    apiMocks.fetchAdminCampaigns.mockResolvedValue({
      items: adminResponse().campaigns,
      page: 1,
      pageSize: 25,
      total: adminResponse().campaigns.length,
      totalPages: 1
    });
    apiMocks.fetchCampaignContacts.mockResolvedValue({
      contacts: [],
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 0
    });
    apiMocks.fetchSystemSettings.mockResolvedValue(systemSettings());
    apiMocks.updateSystemSettings.mockImplementation(async (input) => ({ ...systemSettings(), ...input }));
    apiMocks.fetchCallHistory.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0
    });
    apiMocks.getCallRecordingAudioUrl.mockResolvedValue("/api/media/ticketed-recording");
    apiMocks.logout.mockResolvedValue(undefined);
    apiMocks.resetCampaignLeads.mockResolvedValue({ item: null, resetCount: 0 });
    apiMocks.sendDtmf.mockResolvedValue(deskResponse({ activeCall: activeCallRow() }));
    apiMocks.startLeadCall.mockResolvedValue(deskResponse());
    apiMocks.startManualCall.mockResolvedValue(deskResponse());
    apiMocks.startNextCall.mockResolvedValue(deskResponse());
    apiMocks.startSupervisorSession.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      callId: "33333333-3333-4333-8333-333333333333",
      mode: "listen",
      state: "connecting",
      startedAt: "2026-07-22T08:00:00.000Z",
      connectedAt: null,
      endedAt: null,
      failureReason: null
    });
    apiMocks.stopSupervisorSession.mockResolvedValue(undefined);
    apiMocks.subscribeAgentEvents.mockReturnValue(() => undefined);
    apiMocks.updateAgentAvailability.mockResolvedValue(
      deskResponse({ availability: { status: "paused", wrapUpUntil: null } })
    );
    apiMocks.upsertCallAvmdReview.mockResolvedValue({
      actualParty: "machine",
      notes: "Clear mailbox greeting",
      reviewedByName: "Admin Example",
      reviewedAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z"
    });
    apiMocks.updateSupervisorMode.mockImplementation(async (sessionId, mode) => ({
      id: sessionId,
      callId: "33333333-3333-4333-8333-333333333333",
      mode,
      state: "connecting",
      startedAt: "2026-07-22T08:00:00.000Z",
      connectedAt: null,
      endedAt: null,
      failureReason: null
    }));
    apiMocks.useSoftphoneRegistration.mockReturnValue(softphoneRuntime);
    apiMocks.useSupervisorSoftphone.mockReturnValue(supervisorSoftphoneRuntime);
  });

  it("restores the shared page and selected campaign from the URL", async () => {
    const admin = userRow({ role: "admin" });
    const campaignId = "77777777-7777-4777-8777-777777777777";
    const campaign = {
      id: campaignId,
      name: "Restored campaign",
      status: "active" as const,
      callableLeads: 4,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    window.localStorage.setItem(
      "outbound_dialer_selected_campaign_id",
      "88888888-8888-4888-8888-888888888888"
    );
    window.history.replaceState({}, "", `/call-history?campaignId=${campaignId}`);
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        user: admin,
        campaign,
        availableCampaigns: [campaign]
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Call history" })).toBeInTheDocument();
    expect(apiMocks.fetchAgentDesk).toHaveBeenCalledWith(campaignId);
    expect(window.location.pathname).toBe("/call-history");
    expect(new URLSearchParams(window.location.search).get("campaignId")).toBe(campaignId);
  });

  it("restores the last selected campaign in a new tab without a campaign URL", async () => {
    const campaignId = "77777777-7777-4777-8777-777777777777";
    const campaign = {
      id: campaignId,
      name: "Remembered campaign",
      status: "active" as const,
      callableLeads: 4,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    window.localStorage.setItem("outbound_dialer_selected_campaign_id", campaignId);
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        campaign,
        availableCampaigns: [campaign]
      })
    );

    render(<App />);

    expect(await screen.findByDisplayValue("Remembered campaign (4)")).toBeInTheDocument();
    expect(apiMocks.fetchAgentDesk).toHaveBeenCalledWith(campaignId);
    expect(new URLSearchParams(window.location.search).get("campaignId")).toBe(campaignId);
  });

  it("updates the browser URL when navigating between admin pages", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));

    expect(window.location.pathname).toBe("/campaigns");
    expect(new URLSearchParams(window.location.search).get("campaignId")).toBe(
      "11111111-1111-4111-8111-111111111111"
    );

    window.history.pushState({}, "", "/settings?campaignId=11111111-1111-4111-8111-111111111111");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("starts administrator monitoring in listen-only mode from Live calls", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminLiveCalls.mockResolvedValue({
      calls: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          agentName: "Agent One",
          leadName: "Customer One",
          phoneNumber: "+15550100",
          campaignName: "Campaign One",
          state: "bridged",
          startedAt: "2026-07-22T08:00:00.000Z",
          answeredAt: "2026-07-22T08:00:05.000Z",
          durationSeconds: 30,
          activeSupervisorCount: 0,
          monitoredByCurrentAdmin: false
        }
      ],
      activeSession: null
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Live calls" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Live calls" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Listen" }));

    await waitFor(() =>
      expect(apiMocks.startSupervisorSession).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333")
    );
    expect(await screen.findByRole("button", { name: /Microphone off/ })).toBeInTheDocument();
  });

  it("supports keyboard navigation and moves focus to the new page heading", async () => {
    const admin = userRow({ role: "admin" });
    const keyboard = userEvent.setup();
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));

    render(<App />);
    const navigation = await screen.findByRole("navigation", { name: "Primary navigation" });
    const campaigns = within(navigation).getByRole("button", { name: "Campaigns" });
    campaigns.focus();
    await keyboard.keyboard("{Enter}");

    const heading = await screen.findByRole("heading", { level: 1, name: "Campaigns" });
    expect(heading).toHaveFocus();
    expect(document.title).toBe("Campaigns · Dialer");
  });

  it("redirects an admin deep link to Agent Desk while an interactive call is active", async () => {
    const admin = userRow({ role: "admin" });
    window.history.replaceState({}, "", "/settings?campaignId=11111111-1111-4111-8111-111111111111");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin, activeCall: activeCallRow() }));

    render(<App />);

    expect(await screen.findByRole("button", { name: "Campaigns" })).toBeDisabled();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(apiMocks.useSoftphoneRegistration).toHaveBeenLastCalledWith(admin);
  });

  it("rejects browser history navigation away from an active admin call", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin, activeCall: activeCallRow() }));

    render(<App />);
    expect(await screen.findByRole("button", { name: "Campaigns" })).toBeDisabled();

    act(() => {
      window.history.pushState({}, "", "/settings?campaignId=11111111-1111-4111-8111-111111111111");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).not.toBeInTheDocument();
    expect(apiMocks.useSoftphoneRegistration).toHaveBeenLastCalledWith(admin);
  });

  it("keeps the Analytics campaign filter separate from the Agent Desk campaign", async () => {
    const admin = userRow({ role: "admin" });
    const deskCampaignId = "11111111-1111-4111-8111-111111111111";
    const campaign = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Archived analytics campaign",
      status: "archived" as const,
      loaded: 80,
      callable: 32,
      attempted: 48,
      outcomeDistribution: [],
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    window.history.replaceState(
      {},
      "",
      `/analytics?campaignId=${deskCampaignId}&analyticsCampaignId=${campaign.id}`
    );
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ campaigns: [campaign] }));
    const analytics = adminAnalyticsResponse();
    apiMocks.fetchAdminAnalytics.mockResolvedValue({
      ...analytics,
      agentPerformance: [
        ...analytics.agentPerformance,
        {
          ...analytics.agentPerformance[0]!,
          id: "88888888-8888-4888-8888-888888888888",
          name: "Offline Agent",
          registered: false
        },
        {
          ...analytics.agentPerformance[0]!,
          id: "77777777-7777-4777-8777-777777777777",
          name: "Calling Agent",
          activeCall: true
        }
      ]
    });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeInTheDocument();
    expect(await screen.findByText("44 answered / 100 attempts")).toBeInTheDocument();
    expect(screen.getByText("31 connected calls / 100 attempts")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quality evidence" })).toBeInTheDocument();
    expect(screen.getByText("AVMD review evidence")).toBeInTheDocument();
    expect(screen.getByText("Provider observations")).toBeInTheDocument();
    expect(screen.getByText("Browser playout")).toBeInTheDocument();
    expect(screen.getByText("host -> host")).toBeInTheDocument();
    expect(screen.getByText("Registration count drift")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("On call")).toBeInTheDocument();
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    expect(apiMocks.fetchAdminAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: campaign.id,
        from: expect.any(String),
        timeZone: expect.any(String),
        to: expect.any(String)
      })
    );

    expect(screen.getByLabelText("Campaign")).toHaveValue(campaign.id);
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "" } });
    await waitFor(() =>
      expect(apiMocks.fetchAdminAnalytics).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ campaignId: expect.anything() })
      )
    );
    expect(window.location.pathname).toBe("/analytics");
    expect(new URLSearchParams(window.location.search).get("campaignId")).toBe(deskCampaignId);
    expect(new URLSearchParams(window.location.search).has("analyticsCampaignId")).toBe(false);
    expect(window.localStorage.getItem("outbound_dialer_selected_campaign_id")).toBe(deskCampaignId);
  });

  it("saves admin runtime policies from Settings", async () => {
    const admin = userRow({ role: "admin" });
    window.history.replaceState({}, "", "/settings");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));

    render(<App />);
    const attempts = await screen.findByLabelText("Contact attempts");
    fireEvent.change(attempts, { target: { value: "" } });
    expect(attempts).toHaveValue("");
    fireEvent.change(attempts, { target: { value: "50" } });
    expect(attempts).toHaveValue("50");
    fireEvent.click(screen.getByLabelText("Slack alerts"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(apiMocks.updateSystemSettings).toHaveBeenCalled());
    expect(apiMocks.updateSystemSettings.mock.calls[0]?.[0]).toMatchObject({
      contactMaxAttempts: 50,
      defaultPhoneCountryCode: "US",
      pcapCaptureEnabled: false,
      alertmanagerSlackEnabled: true
    });
    expect(apiMocks.updateSystemSettings.mock.calls[0]?.[0]).not.toHaveProperty("alertmanagerApplyStatus");
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });

  it("polls Alertmanager apply status until the saved configuration is applied", async () => {
    const admin = userRow({ role: "admin" });
    const pending = {
      ...systemSettings(),
      alertmanagerApplyStatus: {
        state: "pending" as const,
        lastAttemptAt: "2026-07-17T10:00:00.000Z",
        lastSuccessAt: null,
        error: null
      }
    };
    const applied = {
      ...systemSettings(),
      alertmanagerApplyStatus: {
        state: "applied" as const,
        lastAttemptAt: "2026-07-17T10:00:00.000Z",
        lastSuccessAt: "2026-07-17T10:00:01.000Z",
        error: null
      }
    };
    window.history.replaceState({}, "", "/settings");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchSystemSettings.mockResolvedValueOnce(pending).mockResolvedValue(applied);

    render(<App />);
    expect(
      await screen.findByText("Alertmanager configuration is saved; runtime reload is pending.")
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Alertmanager configuration applied/, undefined, { timeout: 3_500 })
    ).toBeInTheDocument();
    expect(apiMocks.fetchSystemSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps Settings usable while rolling against an API without apply status", async () => {
    const admin = userRow({ role: "admin" });
    const { alertmanagerApplyStatus: _status, ...legacySettings } = systemSettings();
    window.history.replaceState({}, "", "/settings");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchSystemSettings.mockResolvedValue(legacySettings);

    render(<App />);
    expect(
      await screen.findByText("Alertmanager apply status is unavailable during the API upgrade.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  });

  it("shows unavailable quality evidence without converting missing observations to zero", async () => {
    const admin = userRow({ role: "admin" });
    window.history.replaceState({}, "", "/analytics");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminAnalytics.mockResolvedValue(
      adminAnalyticsResponse({
        avmdQuality: {
          eligibleCalls: 0,
          reviewedCalls: 0,
          uncertainReviews: 0,
          reviewCoverageRate: 0,
          truePositives: 0,
          falsePositives: 0,
          trueNegatives: 0,
          falseNegatives: 0,
          precision: null,
          recall: null,
          falsePositiveRate: null
        },
        mediaQuality: {
          answeredCalls: 4,
          observedCalls: 0,
          coverageRate: 0,
          suspectedOneWayCalls: 0,
          averageMos: null,
          p95JitterLossRate: null,
          averageQualityPercentage: null,
          providers: [],
          browser: {
            observedCalls: 0,
            coverageRate: 0,
            averageInboundLossRate: null,
            averageConcealedSampleRate: null,
            averageJitterBufferMs: null,
            p95JitterMs: null,
            p95RoundTripTimeMs: null,
            paths: []
          },
          legs: []
        },
        telephonyReliability: {
          finalizationSamples: 0,
          averageFinalizationMs: null,
          p95FinalizationMs: null,
          maxFinalizationMs: null,
          registrationDatabaseCount: null,
          registrationFreeSwitchCount: null,
          registrationDriftCount: null,
          registrationCorrectionsLastRun: null,
          registrationReconciledAt: null,
          activeCallsDatabaseCount: null,
          activeCallsMissingInFreeSwitch: null,
          activeCallsClosedLastRun: null,
          activeCallsReconciledAt: null,
          reconciliationClosures: 0
        }
      })
    );

    render(<App />);

    expect(
      await screen.findByText("Media telemetry was not observed for answered calls.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("preselects the active Agent Desk campaign in Add lead and CSV import", async () => {
    const admin = userRow({ role: "admin" });
    const selectedCampaignId = "77777777-7777-4777-8777-777777777777";
    const selectedDeskCampaign = {
      id: selectedCampaignId,
      name: "Selected second campaign",
      status: "active" as const,
      callableLeads: 4,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    const adminCampaigns: AdminOverviewResponse["campaigns"] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "First campaign",
        status: "active",
        loaded: 10,
        callable: 8,
        attempted: 2,
        outcomeDistribution: [],
        manualDialingEnabled: true,
        callRecordingEnabled: false,
        earlyMediaAvmdEnabled: false,
        autoAdvanceToNextLeadEnabled: false
      },
      {
        id: selectedCampaignId,
        name: selectedDeskCampaign.name,
        status: "active",
        loaded: 5,
        callable: 4,
        attempted: 1,
        outcomeDistribution: [],
        manualDialingEnabled: true,
        callRecordingEnabled: false,
        earlyMediaAvmdEnabled: false,
        autoAdvanceToNextLeadEnabled: false
      }
    ];
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        user: admin,
        campaign: selectedDeskCampaign,
        availableCampaigns: [selectedDeskCampaign]
      })
    );
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ campaigns: adminCampaigns }));
    apiMocks.fetchAdminCampaigns.mockResolvedValue({
      items: adminCampaigns,
      page: 1,
      pageSize: 25,
      total: adminCampaigns.length,
      totalPages: 1
    });
    apiMocks.fetchCampaignContacts.mockImplementation(
      async (_campaignId: string, filters: { page?: number; pageSize?: number }) => ({
        contacts: [],
        page: filters.page ?? 1,
        pageSize: filters.pageSize ?? 50,
        total: 51,
        totalPages: 2
      })
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));

    const addLeadPanel = screen.getByRole("heading", { name: "Add lead" }).closest("article");
    const csvImportPanel = screen.getByRole("heading", { name: "CSV import" }).closest("article");
    expect(addLeadPanel).not.toBeNull();
    expect(csvImportPanel).not.toBeNull();
    expect(within(addLeadPanel!).getByRole("combobox", { name: "Campaign" })).toHaveValue(selectedCampaignId);
    expect(within(csvImportPanel!).getByRole("combobox", { name: "Campaign" })).toHaveValue(
      selectedCampaignId
    );
    const contactsPanel = screen.getByRole("heading", { name: "Campaign contacts" }).closest("article");
    expect(contactsPanel).not.toBeNull();
    expect(within(contactsPanel!).getByRole("combobox", { name: "Campaign" })).toHaveValue(
      selectedCampaignId
    );
    await waitFor(() =>
      expect(apiMocks.fetchCampaignContacts).toHaveBeenCalledWith(
        selectedCampaignId,
        expect.objectContaining({ page: 1, pageSize: 50 })
      )
    );
    fireEvent.click(within(contactsPanel!).getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(apiMocks.fetchCampaignContacts).toHaveBeenLastCalledWith(
        selectedCampaignId,
        expect.objectContaining({ page: 2, pageSize: 50 })
      )
    );
  });

  it("hydrates the cookie session without a browser-stored bearer token", async () => {
    window.localStorage.setItem("outbound_dialer_token", "legacy-token-that-must-be-ignored");
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());

    render(<App />);

    expect(await screen.findByText("Agent desk")).toBeInTheDocument();
    expect(apiMocks.fetchMe).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiMocks.subscribeAgentEvents).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("outbound_dialer_token")).toBeNull();
  });

  it("pages through every reported CSV import failure", async () => {
    const admin = userRow({ role: "admin" });
    const csvImport = {
      id: "33333333-3333-4333-8333-333333333333",
      campaignId: "11111111-1111-4111-8111-111111111111",
      campaignName: "Selected campaign",
      filename: "contacts.csv",
      status: "completed_with_errors",
      totalRows: 8,
      importedRows: 3,
      failedRows: 5,
      duplicateRows: 0,
      createdAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z"
    };
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchCsvImports.mockResolvedValue({
      imports: [csvImport],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1
    });
    apiMocks.fetchCsvImportDetail.mockImplementation(
      async (_importId: string, filters: { failurePage?: number; failurePageSize?: number }) => {
        const failurePage = filters.failurePage ?? 1;
        return {
          import: csvImport,
          failures: [
            {
              id: `failure-${failurePage}`,
              rowNumber: failurePage === 1 ? 2 : 4,
              reason: "Invalid phone number",
              row: { name: "Alex", phone: "invalid" }
            }
          ],
          failurePage,
          failurePageSize: filters.failurePageSize ?? 50,
          failureTotalPages: 2
        };
      }
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: /contacts\.csv/ }));

    expect(await screen.findByText("Row 2")).toBeInTheDocument();
    const detail = screen.getByText("Row 2").closest<HTMLElement>(".import-detail");
    expect(detail).not.toBeNull();
    fireEvent.click(within(detail!).getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Row 4")).toBeInTheDocument();
    expect(apiMocks.fetchCsvImportDetail).toHaveBeenLastCalledWith(csvImport.id, {
      failurePage: 2,
      failurePageSize: 50
    });
  });

  it("refreshes desk state when the live event stream emits a refresh", async () => {
    let emitRefresh: (() => void) | undefined;
    apiMocks.subscribeAgentEvents.mockImplementation(({ onRefresh }: { onRefresh: () => void }) => {
      emitRefresh = onRefresh;
      return () => undefined;
    });
    apiMocks.fetchAgentDesk.mockResolvedValueOnce(deskResponse({ leads: [] })).mockResolvedValueOnce(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Live Lead",
            company: "Unmapped company",
            phoneNumber: "+15551234567",
            status: "ready",
            fields: []
          }
        ]
      })
    );

    render(<App />);
    expect(await screen.findByText("No leads are queued for this campaign.")).toBeInTheDocument();
    act(() => emitRefresh?.());

    expect(await screen.findByText("Live Lead, +15551234567")).toBeInTheDocument();
    expect(apiMocks.fetchAgentDesk).toHaveBeenCalledTimes(2);
  });

  it("uses the live-event source to avoid refreshing an unrelated admin view", async () => {
    const admin = userRow({ role: "admin" });
    let emitRefresh: ((event: { source: string; occurredAt: string }) => void) | undefined;
    window.history.replaceState({}, "", "/recordings");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.subscribeAgentEvents.mockImplementation(
      ({ onRefresh }: { onRefresh: (event: { source: string; occurredAt: string }) => void }) => {
        emitRefresh = onRefresh;
        return () => undefined;
      }
    );

    render(<App />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Voicemail recordings" })
    ).toBeInTheDocument();
    expect(apiMocks.fetchAdminOverview).toHaveBeenCalledTimes(1);

    act(() => emitRefresh?.({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" }));
    await waitFor(() => expect(apiMocks.fetchAgentDesk).toHaveBeenCalledTimes(2));
    expect(apiMocks.fetchAdminOverview).toHaveBeenCalledTimes(1);

    act(() => emitRefresh?.({ source: "recordings", occurredAt: "2026-07-17T10:00:01.000Z" }));
    await waitFor(() => expect(apiMocks.fetchAdminOverview).toHaveBeenCalledTimes(2));
  });

  it("refreshes the visible call-history query when a call event arrives", async () => {
    const admin = userRow({ role: "admin" });
    let emitRefresh: ((event: { source: string; occurredAt: string }) => void) | undefined;
    const first = callHistoryRow({ leadName: "Initial history lead" });
    const refreshed = callHistoryRow({
      id: "77777777-7777-4777-8777-777777777777",
      leadName: "Live history lead"
    });
    window.history.replaceState({}, "", "/call-history");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ callHistory: [first] }));
    apiMocks.fetchCallHistory
      .mockResolvedValueOnce({ items: [first], page: 1, pageSize: 25, total: 1, totalPages: 1 })
      .mockResolvedValue({ items: [refreshed], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    apiMocks.subscribeAgentEvents.mockImplementation(
      ({ onRefresh }: { onRefresh: (event: { source: string; occurredAt: string }) => void }) => {
        emitRefresh = onRefresh;
        return () => undefined;
      }
    );

    render(<App />);
    expect(await screen.findByText("Initial history lead")).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.fetchCallHistory).toHaveBeenCalledTimes(1));
    act(() => emitRefresh?.({ source: "call_events", occurredAt: "2026-07-17T10:00:00.000Z" }));

    expect(await screen.findByText("Live history lead", undefined, { timeout: 2_500 })).toBeInTheDocument();
    expect(apiMocks.fetchCallHistory).toHaveBeenCalledTimes(2);
  });

  it("refreshes the active analytics query when a call event arrives", async () => {
    const admin = userRow({ role: "admin" });
    let emitRefresh: ((event: { source: string; occurredAt: string }) => void) | undefined;
    const initial = adminAnalyticsResponse();
    const refreshed = {
      ...initial,
      summary: { ...initial.summary, answered: 77, attempts: 123 }
    };
    window.history.replaceState({}, "", "/analytics");
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminAnalytics.mockResolvedValueOnce(initial).mockResolvedValue(refreshed);
    apiMocks.subscribeAgentEvents.mockImplementation(
      ({ onRefresh }: { onRefresh: (event: { source: string; occurredAt: string }) => void }) => {
        emitRefresh = onRefresh;
        return () => undefined;
      }
    );

    render(<App />);
    expect(await screen.findByText("44 answered / 100 attempts")).toBeInTheDocument();
    act(() => emitRefresh?.({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" }));

    expect(await screen.findByText("77 answered / 123 attempts")).toBeInTheDocument();
    expect(apiMocks.fetchAdminAnalytics).toHaveBeenCalledTimes(2);
  });

  it("does not let a background refresh cancel an explicit campaign switch", async () => {
    const nextCampaignId = "77777777-7777-4777-8777-777777777777";
    const nextDeskRequest = deferred<AgentDeskResponse>();
    let emitRefresh: ((event: { source: string; occurredAt: string }) => void) | undefined;
    const initialDesk = deskResponse();
    const nextCampaign = {
      id: nextCampaignId,
      name: "Explicit campaign",
      status: "active" as const,
      callableLeads: 0,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    const availableCampaigns = [
      ...initialDesk.availableCampaigns,
      {
        id: nextCampaign.id,
        name: nextCampaign.name,
        status: nextCampaign.status,
        callableLeads: nextCampaign.callableLeads
      }
    ];
    apiMocks.fetchAgentDesk
      .mockResolvedValueOnce({ ...initialDesk, availableCampaigns })
      .mockReturnValueOnce(nextDeskRequest.promise);
    apiMocks.subscribeAgentEvents.mockImplementation(
      ({ onRefresh }: { onRefresh: (event: { source: string; occurredAt: string }) => void }) => {
        emitRefresh = onRefresh;
        return () => undefined;
      }
    );

    render(<App />);
    const selector = await screen.findByLabelText("Campaign");
    fireEvent.change(selector, { target: { value: nextCampaignId } });
    act(() => emitRefresh?.({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" }));
    await act(async () => {
      nextDeskRequest.resolve({ ...initialDesk, campaign: nextCampaign, availableCampaigns });
      await nextDeskRequest.promise;
    });

    expect(selector).toHaveValue(nextCampaignId);
    expect(apiMocks.fetchAgentDesk).toHaveBeenCalledTimes(2);
  });

  it("lets an idle agent choose audio devices, select processing, and run the readiness check", async () => {
    const runAudioCheck = vi.fn().mockResolvedValue(undefined);
    const selectMicrophone = vi.fn();
    const selectSpeaker = vi.fn().mockResolvedValue(undefined);
    const setMicrophoneProcessingProfile = vi.fn();
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      audioSetup: {
        ...softphoneRuntime.audioSetup,
        checkResult: {
          appliedSettings: softphoneRuntime.audioSetup.appliedSettings!,
          inputPeakPercent: 6,
          networkDetail: "SIP signaling and a TURN relay route are available.",
          networkStatus: "ready" as const,
          signalDetail: "Input is quiet. Move the microphone closer or raise its input level.",
          signalStatus: "quiet" as const
        },
        inputLevel: 0.06,
        signalStatus: "quiet" as const
      },
      registered: true,
      runAudioCheck,
      selectMicrophone,
      selectSpeaker,
      setMicrophoneProcessingProfile
    });

    render(<App />);
    fireEvent.click(await screen.findByText("Audio setup"));
    fireEvent.change(screen.getByLabelText("Microphone"), { target: { value: "mic-1" } });
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "speaker-1" } });
    fireEvent.change(screen.getByLabelText("Microphone processing"), { target: { value: "headset" } });
    fireEvent.click(screen.getByRole("button", { name: "Run audio and network check" }));

    expect(selectMicrophone).toHaveBeenCalledWith("mic-1");
    expect(selectSpeaker).toHaveBeenCalledWith("speaker-1");
    expect(setMicrophoneProcessingProfile).toHaveBeenCalledWith("headset");
    expect(runAudioCheck).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Too quiet")).not.toHaveLength(0);
    expect(screen.getByText("Network ready")).toBeInTheDocument();
    expect(screen.getByText(/TURN relay route/)).toBeInTheDocument();
    expect(screen.getByText(/Echo on · Noise on · Auto gain on/)).toBeInTheDocument();
  });

  it("does not let an older live refresh overwrite a call mutation", async () => {
    const liveRefresh = deferred<AgentDeskResponse>();
    let emitRefresh: ((event: { source: string; occurredAt: string }) => void) | undefined;
    const staleDesk = deskResponse();
    const activeDesk = deskResponse({ activeCall: activeCallRow() });
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValueOnce(staleDesk).mockReturnValueOnce(liveRefresh.promise);
    apiMocks.startManualCall.mockResolvedValue(activeDesk);
    apiMocks.subscribeAgentEvents.mockImplementation(
      ({ onRefresh }: { onRefresh: (event: { source: string; occurredAt: string }) => void }) => {
        emitRefresh = onRefresh;
        return () => undefined;
      }
    );

    render(<App />);
    const phoneNumber = await screen.findByLabelText("Manual call");
    act(() => emitRefresh?.({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" }));
    await waitFor(() => expect(apiMocks.fetchAgentDesk).toHaveBeenCalledTimes(2));

    fireEvent.change(phoneNumber, { target: { value: "+1 415 555 0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    expect(await screen.findByRole("button", { name: "Hang up" })).toBeInTheDocument();

    await act(async () => {
      liveRefresh.resolve(staleDesk);
      await liveRefresh.promise;
    });
    expect(screen.getByRole("button", { name: "Hang up" })).toBeInTheDocument();
  });

  it("clears the rendered session only after calling the logout endpoint", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());

    render(<App />);
    fireEvent.click(await screen.findByTitle("Log out"));

    await waitFor(() => expect(apiMocks.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: /Sign in/ })).toBeInTheDocument();
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

  it("starts a manual call directly from Agent status", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());

    render(<App />);

    const phoneNumber = await screen.findByLabelText("Manual call");
    fireEvent.change(phoneNumber, { target: { value: "+1 415 555 0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(softphoneRuntime.startBrowserRingback).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(apiMocks.startManualCall).toHaveBeenCalledWith({
        campaignId: "11111111-1111-4111-8111-111111111111",
        phoneNumber: "+1 415 555 0000"
      });
    });
    expect(screen.queryByText("Pre-call checks")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check number" })).not.toBeInTheDocument();
  });

  it("stops browser ringback when call creation fails", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());
    apiMocks.startManualCall.mockRejectedValue(new Error("Trunk unavailable"));

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Manual call"), {
      target: { value: "+1 415 555 0000" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Call" }));

    await screen.findByText("Trunk unavailable");
    expect(softphoneRuntime.startBrowserRingback).toHaveBeenCalledTimes(1);
    expect(softphoneRuntime.stopBrowserRingback).toHaveBeenCalledTimes(1);
  });

  it("confirms before calling a completed lead again", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "completed",
            fields: []
          }
        ]
      })
    );

    render(<App />);
    fireEvent.click(
      within(await screen.findByRole("table", { name: "Next leads" })).getByRole("button", { name: "Call" })
    );

    expect(confirm).toHaveBeenCalledWith(
      "This lead has already been called. Are you sure you want to call them again?"
    );
    await waitFor(() => {
      expect(apiMocks.startLeadCall).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", {
        confirmCompletedLead: true,
        confirmRetryWait: false
      });
    });
  });

  it("does not call a completed lead when repeat confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "completed",
            fields: []
          }
        ]
      })
    );

    render(<App />);
    fireEvent.click(
      within(await screen.findByRole("table", { name: "Next leads" })).getByRole("button", { name: "Call" })
    );

    expect(apiMocks.startLeadCall).not.toHaveBeenCalled();
  });

  it("shows the last call result and confirms before calling a lead during retry timeout", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "retry_wait",
            lastCallState: "completed",
            lastCallOutcome: "busy",
            fields: []
          }
        ]
      })
    );

    render(<App />);
    const leadTable = within(await screen.findByRole("table", { name: "Next leads" }));
    expect(leadTable.getByText("No answer")).toBeInTheDocument();
    fireEvent.click(leadTable.getByRole("button", { name: "Call" }));

    expect(confirm).toHaveBeenCalledWith(
      "This lead is still in the retry timeout. Are you sure you want to call them now?"
    );
    await waitFor(() => {
      expect(apiMocks.startLeadCall).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", {
        confirmCompletedLead: false,
        confirmRetryWait: true
      });
    });
  });

  it("does not call a lead during retry timeout when confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "retry_wait",
            lastCallState: "failed",
            lastCallOutcome: "failed",
            fields: []
          }
        ]
      })
    );

    render(<App />);
    fireEvent.click(
      within(await screen.findByRole("table", { name: "Next leads" })).getByRole("button", {
        name: "Call"
      })
    );

    expect(apiMocks.startLeadCall).not.toHaveBeenCalled();
  });

  it("does not start a manual and queued call concurrently", async () => {
    const queuedCall = deferred<AgentDeskResponse>();
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "ready",
            fields: []
          }
        ]
      })
    );
    apiMocks.startNextCall.mockReturnValue(queuedCall.promise);

    render(<App />);
    const manualNumber = await screen.findByLabelText("Manual call");
    const manualForm = manualNumber.closest("form");
    expect(manualForm).not.toBeNull();
    fireEvent.change(manualNumber, { target: { value: "+1 415 555 0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Start next call" }));

    const manualCall = within(manualForm!).getByRole("button", { name: "Starting" });
    expect(manualCall).toBeDisabled();
    fireEvent.click(manualCall);
    expect(apiMocks.startManualCall).not.toHaveBeenCalled();
    expect(apiMocks.startNextCall).toHaveBeenCalledTimes(1);

    await act(async () => {
      queuedCall.resolve(deskResponse());
      await queuedCall.promise;
    });
  });

  it("lets an agent pause and resume calling from the status panel", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse());

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentAvailability).toHaveBeenCalledWith({
        status: "paused",
        campaignId: "11111111-1111-4111-8111-111111111111"
      });
    });
    expect(await screen.findByRole("button", { name: "Resume calling" })).toBeInTheDocument();
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
  });

  it("treats legacy wrap-up state as ready for the next call", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({ ...softphoneRuntime, registered: true });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        availability: { status: "wrap_up", wrapUpUntil: "2099-07-13T10:00:00.000Z" },
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "",
            phoneNumber: "+15551234567",
            status: "ready",
            fields: []
          }
        ]
      })
    );

    render(<App />);

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start next call/ })).toBeEnabled();
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
    expect(within(screen.getByRole("table", { name: "Next leads" })).getAllByRole("cell")).toHaveLength(2);
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

  it("advances the active call timer every second without resetting on answer", async () => {
    vi.useFakeTimers();
    apiMocks.fetchAgentDesk
      .mockResolvedValueOnce(
        deskResponse({
          activeCall: activeCallRow({ durationSeconds: 8, state: "customer_ringing", status: "ringing" })
        })
      )
      .mockResolvedValue(
        deskResponse({
          activeCall: activeCallRow({ durationSeconds: 10, state: "bridged", status: "bridged" })
        })
      );

    try {
      render(<App />);
      await vi.waitFor(() => expect(screen.getByLabelText("Call duration 00:08")).toBeInTheDocument());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByLabelText("Call duration 00:09")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByLabelText("Call duration 00:10")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByLabelText("Call duration 00:11")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when call-action eligibility is missing", async () => {
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({ activeCall: activeCallRow({ actions: undefined as never }) })
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /Drop voicemail/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
    expect(
      screen.getAllByText("Call controls are unavailable. Refresh the Agent Desk before continuing.").length
    ).toBeGreaterThan(0);
  });

  it("serializes call-control mutations", async () => {
    const ending = deferred<AgentDeskResponse>();
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ activeCall: activeCallRow() }));
    apiMocks.endCall.mockReturnValue(ending.promise);

    render(<App />);
    const hangUp = await screen.findByRole("button", { name: "Hang up" });
    fireEvent.click(hangUp);
    fireEvent.click(hangUp);

    await waitFor(() => expect(apiMocks.endCall).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Drop voicemail/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(apiMocks.sendDtmf).not.toHaveBeenCalled();

    await act(async () => {
      ending.resolve(deskResponse({ activeCall: null }));
      await ending.promise;
    });
  });

  it("shows blocked browser audio honestly and offers a playback retry", async () => {
    const retryRemoteAudio = vi.fn().mockResolvedValue(undefined);
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      registered: true,
      callState: "active",
      audioPlaybackState: "blocked",
      retryRemoteAudio
    });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ activeCall: activeCallRow() }));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Your browser blocked call audio");
    expect(screen.queryByText(/Stable media/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play call audio" }));
    expect(retryRemoteAudio).toHaveBeenCalledTimes(1);
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

  it("automatically starts the next lead after an active call ends when the campaign enables it", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      registered: true,
      state: "registered"
    });
    const campaign = {
      ...deskResponse().campaign!,
      callableLeads: 1,
      autoAdvanceToNextLeadEnabled: true
    };
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ campaign, activeCall: activeCallRow() }));
    apiMocks.endCall.mockResolvedValue(deskResponse({ campaign, activeCall: null }));
    apiMocks.startNextCall.mockResolvedValue(deskResponse({ campaign, activeCall: activeCallRow() }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Hang up" }));

    await waitFor(() => {
      expect(apiMocks.startNextCall).toHaveBeenCalledTimes(1);
      expect(apiMocks.startNextCall).toHaveBeenCalledWith({ campaignId: campaign.id });
    });
  });

  it("pauses during an active call without ending it and blocks automatic next-lead calling", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      registered: true,
      state: "registered"
    });
    const campaign = {
      ...deskResponse().campaign!,
      callableLeads: 1,
      autoAdvanceToNextLeadEnabled: true
    };
    const activeCall = activeCallRow();
    const pausedAvailability = { status: "paused" as const, wrapUpUntil: null };
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ campaign, activeCall }));
    apiMocks.updateAgentAvailability.mockResolvedValue(
      deskResponse({ campaign, activeCall, availability: pausedAvailability })
    );
    apiMocks.endCall.mockResolvedValue(
      deskResponse({ campaign, activeCall: null, availability: pausedAvailability })
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentAvailability).toHaveBeenCalledWith({
        status: "paused",
        campaignId: campaign.id
      });
    });
    expect(apiMocks.endCall).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Resume calling" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
    await waitFor(() => expect(apiMocks.endCall).toHaveBeenCalledTimes(1));
    expect(apiMocks.startNextCall).not.toHaveBeenCalled();
  });

  it("resumes during an active call and allows automatic next-lead calling after it ends", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      registered: true,
      state: "registered"
    });
    const campaign = {
      ...deskResponse().campaign!,
      callableLeads: 1,
      autoAdvanceToNextLeadEnabled: true
    };
    const activeCall = activeCallRow();
    const pausedAvailability = { status: "paused" as const, wrapUpUntil: null };
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({ campaign, activeCall, availability: pausedAvailability })
    );
    apiMocks.updateAgentAvailability.mockResolvedValue(deskResponse({ campaign, activeCall }));
    apiMocks.endCall.mockResolvedValue(deskResponse({ campaign, activeCall: null }));
    apiMocks.startNextCall.mockResolvedValue(deskResponse({ campaign, activeCall }));

    render(<App />);
    const resume = await screen.findByRole("button", { name: "Resume calling" });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);

    await waitFor(() => {
      expect(apiMocks.updateAgentAvailability).toHaveBeenCalledWith({
        status: "available",
        campaignId: campaign.id
      });
    });
    expect(apiMocks.endCall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
    await waitFor(() => expect(apiMocks.startNextCall).toHaveBeenCalledTimes(1));
  });

  it("does not automatically start the next lead after a manual call ends", async () => {
    apiMocks.useSoftphoneRegistration.mockReturnValue({
      ...softphoneRuntime,
      registered: true,
      state: "registered"
    });
    const campaign = {
      ...deskResponse().campaign!,
      callableLeads: 1,
      autoAdvanceToNextLeadEnabled: true
    };
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({ campaign, activeCall: activeCallRow({ manualDial: true }) })
    );
    apiMocks.endCall.mockResolvedValue(deskResponse({ campaign, activeCall: null }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Hang up" }));

    await waitFor(() => {
      expect(apiMocks.endCall).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.startNextCall).not.toHaveBeenCalled();
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
    expect(screen.queryByText(/Phone connecting/)).not.toBeInTheDocument();
  });

  it.each([
    ["Suppression", "/suppression", "Suppression"],
    ["Call history", "/call-history", "Call history"],
    ["Recordings", "/recordings", "Voicemail recordings"]
  ])("does not show phone connection status on %s", async (_page, path, heading) => {
    const admin = userRow({ role: "admin" });
    window.history.replaceState({}, "", path);
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.useSoftphoneRegistration).toHaveBeenLastCalledWith(null));
    expect(screen.queryByText(/Phone connecting/)).not.toBeInTheDocument();
    expect(screen.getByText("● Ready")).toBeInTheDocument();
  });

  it("keeps admin on Agent Desk while a call is active", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin, activeCall: activeCallRow() }));

    render(<App />);

    expect(await screen.findByRole("button", { name: "Campaigns" })).toBeDisabled();
    expect(screen.getAllByTitle("Finish the active call first")).toHaveLength(7);
  });

  it("uses Dialer campaign branding and hides the unmapped company placeholder", async () => {
    const admin = userRow({ role: "admin" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(
      deskResponse({
        user: admin,
        activeCall: activeCallRow(),
        leads: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Avery Johnson",
            company: "Unmapped company",
            phoneNumber: "+15551234567",
            status: "calling",
            fields: []
          }
        ]
      })
    );

    render(<App />);

    expect(await screen.findByText("Dialer")).toBeInTheDocument();
    expect(screen.getByText("Campaign")).toBeInTheDocument();
    expect(screen.queryByText("Relay")).not.toBeInTheDocument();
    expect(screen.queryByText("Unmapped company")).not.toBeInTheDocument();
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
            attempted: 2,
            outcomeDistribution: [],
            manualDialingEnabled: true,
            callRecordingEnabled: true,
            earlyMediaAvmdEnabled: true,
            autoAdvanceToNextLeadEnabled: false
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

  it("confirms and resets every lead from campaign settings", async () => {
    const admin = userRow({ role: "admin" });
    const campaign: AdminOverviewResponse["campaigns"][number] = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Selected campaign",
      status: "active",
      loaded: 10,
      callable: 3,
      attempted: 7,
      outcomeDistribution: [],
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      autoAdvanceToNextLeadEnabled: false
    };
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ campaigns: [campaign] }));
    apiMocks.fetchAdminCampaigns.mockResolvedValue({
      items: [campaign],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1
    });
    apiMocks.resetCampaignLeads.mockResolvedValue({ item: campaign, resetCount: 7 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));
    const recordingExport = await screen.findByRole("link", { name: "Download recordings" });
    expect(recordingExport).toHaveAttribute(
      "href",
      "/api/admin/campaigns/11111111-1111-4111-8111-111111111111/recordings.zip"
    );
    expect(recordingExport).toHaveAttribute("target", "_blank");
    expect(recordingExport).not.toHaveAttribute("download");
    fireEvent.click(await screen.findByTitle("Edit campaign"));
    fireEvent.click(screen.getByRole("button", { name: "Reset Leads" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Reset all 10 leads in "Selected campaign"?')
    );
    await waitFor(() =>
      expect(apiMocks.resetCampaignLeads).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111")
    );
    expect(await screen.findByText("7 leads reset.")).toBeInTheDocument();
  });

  it("does not offer AVMD classification without a playable recording", async () => {
    const admin = userRow({ role: "admin" });
    const call = callHistoryRow({ avmdReviewStatus: "needs_review", recordingAvailable: false });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ callHistory: [call] }));
    apiMocks.fetchCallHistory.mockResolvedValue({
      items: [call],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1
    });
    apiMocks.fetchCallDetail.mockResolvedValue(callDetailResponse(call));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Call history" }));
    fireEvent.click(await screen.findByRole("button", { name: /Avery Johnson/ }));

    expect(
      await screen.findByText("Review unavailable: this call has no playable recording.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save review" })).not.toBeInTheDocument();
  });

  it("plays a call recording and keeps technical events collapsed until requested", async () => {
    const admin = userRow({ role: "admin" });
    const call = callHistoryRow({ recordingAvailable: true, avmdReviewStatus: "needs_review" });
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ callHistory: [call] }));
    apiMocks.fetchCallHistory.mockResolvedValue({
      items: [call],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1
    });
    apiMocks.fetchCallDetail.mockResolvedValue({
      call: {
        ...call,
        startedAt: call.createdAt,
        answeredAt: call.createdAt,
        endedAt: call.createdAt,
        manualDial: false,
        voicemailSignal: null,
        voicemailConfidence: null,
        avmdAttempted: true,
        recordingStatus: "available",
        recordingDurationSeconds: 60,
        recordingFileSizeBytes: 128_000,
        recordingIntegrityCheckedAt: call.createdAt,
        recordingFailureReason: null,
        pcapFileSizeBytes: null,
        pcapStartedAt: call.createdAt,
        pcapEndedAt: call.createdAt,
        pcapFailureReason: null,
        pcapStatus: "available",
        pcapAvailable: true,
        lastReasonCode: null,
        hangupCause: null,
        freeswitchTerminalAt: call.createdAt,
        terminalPersistedAt: call.createdAt,
        terminalSource: "freeswitch_channel_event",
        terminalEventName: "CHANNEL_HANGUP_COMPLETE",
        finalizationLatencyMs: 42
      },
      avmdReview: null,
      mediaQuality: [
        {
          legType: "customer",
          capturedAt: call.createdAt,
          readCodec: "PCMU",
          writeCodec: "PCMU",
          sipGateway: "primary-trunk",
          sipProfile: "external",
          inboundPacketCount: 120,
          outboundPacketCount: 118,
          inboundMediaPacketCount: 120,
          outboundMediaPacketCount: 118,
          inboundSkipPacketCount: 0,
          inboundJitterLossRate: 0.01,
          inboundJitterMaxVariance: 0.02,
          inboundMos: 4.2,
          inboundQualityPercentage: 93,
          suspectedOneWayAudio: false
        }
      ],
      legs: [],
      timeline: [
        {
          at: call.createdAt,
          eventType: "CHANNEL_ANSWER",
          state: "bridged",
          label: "Customer connected",
          reasonCode: null,
          freeSwitchEventName: "CHANNEL_ANSWER",
          apiCommandName: null,
          agentLegUuid: null,
          customerLegUuid: null
        }
      ],
      timelineTotal: 125,
      timelineTruncated: true
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Call history" }));
    fireEvent.change(await screen.findByLabelText("AVMD review"), {
      target: { value: "needs_review" }
    });
    await waitFor(() =>
      expect(apiMocks.fetchCallHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ avmdReview: "needs_review" })
      )
    );
    expect(screen.getByText("Needs AVMD review")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Avery Johnson/ }));

    const player = await screen.findByLabelText("Call recording for Avery Johnson");
    expect(screen.getByText("Recording length")).toBeInTheDocument();
    expect(screen.getByText("Recording size")).toBeInTheDocument();
    expect(screen.getByText("Integrity checked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PCAP" })).toBeInTheDocument();
    expect(screen.getByText("Filtered to this call's SIP signaling and media ports.")).toBeInTheDocument();
    expect(screen.getByText(/This review evaluates the detector/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Voicemail / machine" }));
    fireEvent.change(screen.getByLabelText(/Review note/), {
      target: { value: "Clear mailbox greeting" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() =>
      expect(apiMocks.upsertCallAvmdReview).toHaveBeenCalledWith(call.id, {
        actualParty: "machine",
        notes: "Clear mailbox greeting"
      })
    );
    expect(await screen.findByText("AVMD review saved")).toBeInTheDocument();
    expect(player).toHaveAttribute("src", "/api/media/ticketed-recording");
    expect(screen.queryByText("Customer connected")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show technical details" }));
    expect(await screen.findByText("Customer connected")).toBeInTheDocument();
    expect(screen.getByText("Showing the latest 1 of 125 recorded events.")).toBeInTheDocument();
    expect(screen.getByText("Terminal persistence")).toBeInTheDocument();
    expect(screen.getByText("primary-trunk")).toBeInTheDocument();
    expect(screen.getByText("external")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide technical details" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(apiMocks.fetchCallDetail).toHaveBeenCalledWith(call.id);
  });

  it("ignores a late call-detail response after another call is selected", async () => {
    const admin = userRow({ role: "admin" });
    const first = callHistoryRow({ id: "11111111-1111-4111-8111-111111111111", leadName: "First Lead" });
    const second = callHistoryRow({ id: "22222222-2222-4222-8222-222222222222", leadName: "Second Lead" });
    const firstRequest = deferred<CallDetailResponse>();
    const firstDetail = callDetailResponse(first);
    const secondDetail = callDetailResponse(second);
    firstDetail.call.hangupCause = "FIRST_DETAIL";
    secondDetail.call.hangupCause = "SECOND_DETAIL";
    apiMocks.fetchMe.mockResolvedValue({ user: admin });
    apiMocks.fetchAgentDesk.mockResolvedValue(deskResponse({ user: admin }));
    apiMocks.fetchAdminOverview.mockResolvedValue(adminResponse({ callHistory: [first, second] }));
    apiMocks.fetchCallHistory.mockResolvedValue({
      items: [first, second],
      page: 1,
      pageSize: 25,
      total: 2,
      totalPages: 1
    });
    apiMocks.fetchCallDetail.mockImplementation((callId: string) =>
      callId === first.id ? firstRequest.promise : Promise.resolve(secondDetail)
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Call history" }));
    fireEvent.click(await screen.findByRole("button", { name: /First Lead/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second Lead/ }));
    expect(await screen.findByText("SECOND_DETAIL")).toBeInTheDocument();

    await act(async () => {
      firstRequest.resolve(firstDetail);
      await firstRequest.promise;
    });
    expect(screen.getByText("SECOND_DETAIL")).toBeInTheDocument();
    expect(screen.queryByText("FIRST_DETAIL")).not.toBeInTheDocument();
  });
});

function systemSettings() {
  return {
    defaultPhoneCountryCode: "US",
    contactMaxAttempts: 3,
    contactRetryDelaySeconds: 900,
    callHistoryExportMaxRows: 50000,
    callLogRetentionDays: 7,
    callRecordingRetentionDays: 30,
    pcapRetentionDays: 7,
    retentionEnabled: true,
    pcapCaptureEnabled: false,
    sipTrunkCallerId: null,
    alertmanagerRepeatInterval: "4h",
    alertmanagerWebhookEnabled: false,
    alertmanagerSlackEnabled: false,
    alertmanagerTelegramEnabled: false,
    availableAlertChannels: { webhook: true, slack: true, telegram: true },
    alertmanagerApplyStatus: {
      state: "applied" as const,
      lastAttemptAt: "2026-07-16T12:00:00.000Z",
      lastSuccessAt: "2026-07-16T12:00:00.000Z",
      error: null
    },
    updatedAt: null
  };
}

function userRow(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    email: "agent@example.com",
    name: "Agent Example",
    role: "agent",
    isActive: true,
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
    earlyMediaAvmdEnabled: false,
    autoAdvanceToNextLeadEnabled: false
  };

  return {
    user: userRow(),
    availability: {
      status: "available",
      wrapUpUntil: null
    },
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
    recentCalls: [],
    voicemailJobs: [],
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
    manualDial: false,
    state: "bridged",
    leadName: "Avery Johnson",
    phoneNumber: "+15551234567",
    durationSeconds: 12,
    status: "bridged",
    voicemailSignal: "detected",
    recordingId: "44444444-4444-4444-8444-444444444444",
    recordingName: "Default voicemail",
    callRecordingEnabled: true,
    callRecordingStatus: "recording",
    actions: {
      dropVoicemail: { allowed: true, reason: null },
      sendDtmf: { allowed: true, reason: null }
    },
    supervisor: { active: false, mode: null },
    timeline: [],
    ...overrides
  };
}

function adminResponse(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    user: userRow({ role: "admin" }),
    stats: {
      campaigns: 0,
      activeAgents: 0,
      callsToday: 0,
      suppressionEntries: 0,
      liveCalls: 0,
      attemptedCallsToday: 0,
      answeredCallsToday: 0,
      contactRate: 0,
      voicemailDropsToday: 0,
      voicemailDropCompletionRate: 0,
      failedCallsToday: 0,
      callsPerHour: 0,
      agentUtilization: 0,
      outcomeDistribution: []
    },
    campaigns: [],
    recordings: [],
    users: [],
    callHistory: [],
    suppression: [],
    ...overrides
  };
}

function adminAnalyticsResponse(overrides: Partial<AdminAnalyticsResponse> = {}): AdminAnalyticsResponse {
  return {
    filters: {
      from: "2026-07-09T00:00:00.000Z",
      to: "2026-07-15T23:59:59.999Z",
      campaignId: null,
      timeZone: "Asia/Yerevan"
    },
    summary: {
      attempts: 100,
      uniqueContacts: 72,
      answered: 44,
      answerRate: 44,
      connected: 31,
      contactRate: 31,
      averageTalkSeconds: 84,
      failed: 12,
      voicemailCompleted: 18,
      voicemailCompletionRate: 90
    },
    funnel: [
      { stage: "Attempts", count: 100 },
      { stage: "Answered", count: 44 },
      { stage: "Connected", count: 31 },
      { stage: "Completed", count: 82 }
    ],
    dailyTrend: [
      {
        date: "2026-07-14",
        attempts: 45,
        answered: 20,
        connected: 14,
        failed: 6,
        voicemailCompleted: 8,
        averageTalkSeconds: 79
      },
      {
        date: "2026-07-15",
        attempts: 55,
        answered: 24,
        connected: 17,
        failed: 6,
        voicemailCompleted: 10,
        averageTalkSeconds: 88
      }
    ],
    campaignPerformance: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Selected campaign",
        status: "active",
        loaded: 80,
        callable: 32,
        attemptedContacts: 48,
        attempts: 70,
        answered: 32,
        connected: 23,
        contactRate: 32.9,
        averageTalkSeconds: 91,
        retryEfficiency: 18.2,
        voicemailCompleted: 12
      }
    ],
    agentPerformance: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        name: "Agent Example",
        isActive: true,
        registered: true,
        availabilityStatus: "available",
        activeCall: false,
        attempts: 70,
        answered: 32,
        connected: 23,
        contactRate: 32.9,
        averageTalkSeconds: 91,
        voicemailDrops: 12,
        failed: 7
      }
    ],
    dataQuality: {
      snapshotAt: "2026-07-15T12:00:00.000Z",
      totalContacts: 120,
      callable: 72,
      suppressed: 8,
      exhausted: 16,
      importedRows: 105,
      rejectedRows: 5,
      duplicateRows: 3,
      invalidRows: 2
    },
    voicemail: {
      requested: 20,
      started: 20,
      agentReleased: 19,
      completed: 18,
      failedOrInterrupted: 2,
      completionRate: 90,
      averageReleaseSeconds: 3
    },
    avmdQuality: {
      eligibleCalls: 20,
      reviewedCalls: 12,
      uncertainReviews: 2,
      reviewCoverageRate: 60,
      truePositives: 5,
      falsePositives: 1,
      trueNegatives: 4,
      falseNegatives: 2,
      precision: 83.3,
      recall: 71.4,
      falsePositiveRate: 20
    },
    mediaQuality: {
      answeredCalls: 44,
      observedCalls: 30,
      coverageRate: 68.2,
      suspectedOneWayCalls: 2,
      averageMos: 4.12,
      p95JitterLossRate: 0.04,
      averageQualityPercentage: 91.5,
      providers: [{ provider: "primary-trunk", count: 30 }],
      browser: {
        observedCalls: 26,
        coverageRate: 59.1,
        averageInboundLossRate: 0.2,
        averageConcealedSampleRate: 0.1,
        averageJitterBufferMs: 24,
        p95JitterMs: 38,
        p95RoundTripTimeMs: 112,
        paths: [{ path: "host -> host", count: 26 }]
      },
      legs: [
        {
          legType: "agent",
          observedCalls: 28,
          averageMos: 4.2,
          p95JitterLossRate: 0.03,
          averageQualityPercentage: 93,
          codecs: [{ codec: "OPUS", count: 28 }]
        },
        {
          legType: "customer",
          observedCalls: 30,
          averageMos: 4.04,
          p95JitterLossRate: 0.05,
          averageQualityPercentage: 90,
          codecs: [{ codec: "PCMU", count: 30 }]
        }
      ]
    },
    telephonyReliability: {
      finalizationSamples: 32,
      averageFinalizationMs: 42,
      p95FinalizationMs: 120,
      maxFinalizationMs: 340,
      registrationDatabaseCount: 3,
      registrationFreeSwitchCount: 2,
      registrationDriftCount: 1,
      registrationCorrectionsLastRun: 1,
      registrationReconciledAt: "2026-07-15T12:00:00.000Z",
      activeCallsDatabaseCount: 2,
      activeCallsMissingInFreeSwitch: 1,
      activeCallsClosedLastRun: 1,
      activeCallsReconciledAt: "2026-07-15T12:00:00.000Z",
      reconciliationClosures: 3
    },
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
    campaignId: "11111111-1111-4111-8111-111111111111",
    agentId: "99999999-9999-4999-8999-999999999999",
    state: "completed",
    outcome: "answered",
    createdAt: "2026-07-10T08:00:00.000Z",
    durationSeconds: 72,
    recordingAvailable: false,
    pcapStatus: null,
    pcapAvailable: false,
    voicemailSignal: null,
    avmdReviewStatus: null,
    ...overrides
  };
}

function callDetailResponse(call: AdminOverviewResponse["callHistory"][number]): CallDetailResponse {
  return {
    call: {
      ...call,
      startedAt: call.createdAt,
      answeredAt: call.createdAt,
      endedAt: call.createdAt,
      manualDial: false,
      voicemailSignal: null,
      voicemailConfidence: null,
      avmdAttempted: true,
      recordingStatus: call.recordingAvailable ? "available" : "disabled",
      recordingDurationSeconds: null,
      recordingFileSizeBytes: null,
      recordingIntegrityCheckedAt: null,
      recordingFailureReason: null,
      pcapFileSizeBytes: null,
      pcapStartedAt: null,
      pcapEndedAt: null,
      pcapFailureReason: null,
      pcapStatus: null,
      pcapAvailable: false,
      lastReasonCode: null,
      hangupCause: null,
      freeswitchTerminalAt: null,
      terminalPersistedAt: null,
      terminalSource: null,
      terminalEventName: null,
      finalizationLatencyMs: null
    },
    avmdReview: null,
    mediaQuality: [],
    browserMedia: null,
    legs: [],
    timeline: [],
    timelineTotal: 0,
    timelineTruncated: false
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
