import { expect, test } from "@playwright/test";

const campaignId = "11111111-1111-4111-8111-111111111111";

test("keeps an authenticated admin on Agent Desk while an interactive call is active", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: class {
        addEventListener() {}
        close() {}
      }
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.reject(
            new DOMException("Microphone is intentionally blocked in this test", "NotAllowedError")
          )
      }
    });
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: adminUser } });
      return;
    }
    if (url.pathname === "/api/agent/desk") {
      await route.fulfill({ json: activeDesk });
      return;
    }
    if (url.pathname === "/api/admin/overview") {
      await route.fulfill({ json: adminOverview });
      return;
    }
    if (url.pathname === "/api/admin/csv-imports") {
      await route.fulfill({
        json: { imports: [], page: 1, pageSize: 20, total: 0, totalPages: 0 }
      });
      return;
    }

    await route.fulfill({ status: 404, json: { error: `Unhandled test route: ${url.pathname}` } });
  });

  await page.goto(`/settings?campaignId=${campaignId}`);

  await expect(page).toHaveURL(
    (url) => url.pathname === "/" && url.searchParams.get("campaignId") === campaignId
  );
  await expect(page.getByRole("heading", { name: "Agent desk" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Campaigns" })).toBeDisabled();

  await page.evaluate((selectedCampaignId) => {
    window.history.pushState({}, "", `/call-history?campaignId=${selectedCampaignId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, campaignId);

  await expect(page).toHaveURL(
    (url) => url.pathname === "/" && url.searchParams.get("campaignId") === campaignId
  );
  await expect(page.getByRole("heading", { name: "Agent desk" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Call history" })).toBeDisabled();
});

const adminUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "admin@example.com",
  name: "Admin Example",
  role: "admin",
  isActive: true
};

const activeDesk = {
  user: adminUser,
  availability: { status: "available", wrapUpUntil: null },
  campaign: {
    id: campaignId,
    name: "Selected campaign",
    status: "active",
    callableLeads: 4,
    manualDialingEnabled: true,
    callRecordingEnabled: true,
    earlyMediaAvmdEnabled: false
  },
  availableCampaigns: [{ id: campaignId, name: "Selected campaign", status: "active", callableLeads: 4 }],
  softphone: { registered: true, microphoneAllowed: true, status: "in_call" },
  metrics: { todayCalls: 1, voicemailsDropped: 0, suppressed: 0 },
  voicemailJobs: [],
  recentCalls: [],
  leads: [],
  recordings: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Default voicemail",
      status: "default"
    }
  ],
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
    callRecordingEnabled: true,
    callRecordingStatus: "recording",
    actions: {
      dropVoicemail: { allowed: true, reason: null },
      sendDtmf: { allowed: true, reason: null }
    },
    timeline: []
  }
};

const adminOverview = {
  user: adminUser,
  stats: {
    campaigns: 1,
    activeAgents: 1,
    callsToday: 1,
    suppressionEntries: 0,
    liveCalls: 1,
    attemptedCallsToday: 1,
    answeredCallsToday: 1,
    contactRate: 100,
    voicemailDropsToday: 0,
    voicemailDropCompletionRate: 0,
    failedCallsToday: 0,
    callsPerHour: 1,
    agentUtilization: 100,
    outcomeDistribution: []
  },
  campaigns: [],
  recordings: [],
  users: [],
  calls: 1,
  recordingFiles: 0,
  pcapFiles: 0
};
