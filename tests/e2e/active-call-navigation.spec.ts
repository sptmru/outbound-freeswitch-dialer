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

test("refreshes campaign voicemail during a call and drops without a recording override", async ({
  page
}) => {
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      constructor() {
        super();
        window.addEventListener("vm-test-refresh", () =>
          this.dispatchEvent(
            new MessageEvent("refresh", {
              data: JSON.stringify({ source: "campaigns", occurredAt: new Date().toISOString() })
            })
          )
        );
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEvents, configurable: true });
  });
  let assignment: string | null = "Campaign message A";
  let body: unknown;
  const desk = () => ({
    ...activeDesk,
    recordings: [],
    activeCall: {
      ...activeDesk.activeCall,
      recordingId: assignment ? activeDesk.activeCall.recordingId : null,
      recordingName: assignment ?? "No voicemail configured for this campaign",
      actions: {
        ...activeDesk.activeCall.actions,
        dropVoicemail: {
          allowed: Boolean(assignment),
          reason: assignment ? null : "No voicemail configured for this campaign"
        }
      }
    }
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: adminUser } });
    if (path === "/api/agent/desk") return route.fulfill({ json: desk() });
    if (path.endsWith("/drop-voicemail")) {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { ...desk(), activeCall: null } });
    }
    if (path === "/api/admin/overview") return route.fulfill({ json: adminOverview });
    if (path === "/api/admin/csv-imports")
      return route.fulfill({ json: { imports: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return route.fulfill({ status: 404, json: { message: "Unused fixture route" } });
  });
  await page.goto(`/desk?campaignId=${campaignId}`);
  await expect(page.getByText("Campaign message A", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Campaign message A" })).toHaveCount(0);
  assignment = null;
  await page.evaluate(() => window.dispatchEvent(new Event("vm-test-refresh")));
  await expect(page.getByRole("button", { name: "Drop voicemail" })).toBeDisabled();
  assignment = "Campaign message B";
  await page.evaluate(() => window.dispatchEvent(new Event("vm-test-refresh")));
  await expect(page.getByText("Campaign message B", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Drop voicemail" }).click();
  await expect.poll(() => body).toEqual({ campaignId });
});

test("uploads voicemail from the campaign card and disables its assignment", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: class {
        addEventListener() {}
        close() {}
      }
    });
  });
  const recordingId = "44444444-4444-4444-8444-444444444444";
  const campaign = {
    ...activeDesk.campaign,
    callable: 4,
    loaded: 4,
    attempted: 0,
    outcomeDistribution: [],
    autoAdvanceToNextLeadEnabled: false,
    voicemailRecordingId: null as string | null
  };
  const recordings: Array<{
    id: string;
    name: string;
    campaignId: string;
    campaignName: string;
    isAssigned: boolean;
    durationSeconds: number;
    fileSizeBytes: number;
    status: string;
  }> = [];
  let uploadedBody = "";
  let assignmentBody: unknown;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: adminUser } });
    if (path === "/api/agent/desk")
      return route.fulfill({ json: { ...activeDesk, activeCall: null, recordings: [] } });
    if (path === "/api/admin/overview")
      return route.fulfill({ json: { ...adminOverview, campaigns: [campaign], recordings } });
    if (path === "/api/admin/campaigns")
      return route.fulfill({ json: { items: [campaign], page: 1, pageSize: 25, total: 1, totalPages: 1 } });
    if (path === "/api/admin/csv-imports")
      return route.fulfill({ json: { imports: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    if (path.endsWith("/contacts"))
      return route.fulfill({ json: { contacts: [], page: 1, pageSize: 25, total: 0, totalPages: 0 } });
    if (path === "/api/admin/recordings" && route.request().method() === "POST") {
      uploadedBody = route.request().postData() ?? "";
      recordings.push({
        id: recordingId,
        name: "message",
        campaignId,
        campaignName: campaign.name,
        isAssigned: true,
        durationSeconds: 3,
        fileSizeBytes: 100,
        status: "assigned"
      });
      campaign.voicemailRecordingId = recordingId;
      return route.fulfill({ status: 201, json: { item: recordings[0] } });
    }
    if (path === `/api/admin/campaigns/${campaignId}/voicemail`) {
      assignmentBody = route.request().postDataJSON();
      campaign.voicemailRecordingId = null;
      recordings[0].isAssigned = false;
      return route.fulfill({ json: { campaignId, recordingId: null } });
    }
    return route.fulfill({ status: 404, json: { message: "Unused fixture route" } });
  });
  await page.goto(`/campaigns?campaignId=${campaignId}`);
  await page.getByRole("button", { name: "Upload voicemail for this campaign" }).click();
  const form = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Selected campaign", exact: true }) });
  await expect(form.getByRole("combobox", { name: "Campaign", exact: true })).toHaveValue(campaignId);
  await expect(form.getByRole("combobox", { name: "Campaign", exact: true })).toBeDisabled();
  await form
    .getByLabel("Voicemail file")
    .setInputFiles({ name: "message.wav", mimeType: "audio/wav", buffer: Buffer.from("fixture-audio") });
  await form.getByRole("button", { name: "Upload voicemail", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Voicemail for Selected campaign" });
  await expect(select).toHaveValue(recordingId);
  expect(uploadedBody).toContain(`name="campaignId"\r\n\r\n${campaignId}`);
  expect(uploadedBody.indexOf('name="campaignId"')).toBeLessThan(uploadedBody.indexOf('name="file"'));
  await page.screenshot({ path: testInfo.outputPath("campaign-voicemail.png"), fullPage: true });
  await select.selectOption("");
  await expect.poll(() => assignmentBody).toEqual({ recordingId: null });
  await expect(select).toHaveValue("");
});
