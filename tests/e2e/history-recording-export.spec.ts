import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const campaignId = "11111111-1111-4111-8111-111111111111";
const user = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "admin@example.com",
  name: "Admin Example",
  role: "admin",
  isActive: true
};
const campaign = {
  id: campaignId,
  name: "Archived campaign",
  status: "archived",
  loaded: 1,
  callable: 0,
  attempted: 1,
  outcomeDistribution: [],
  voicemailRecordingId: null,
  manualDialingEnabled: false,
  callRecordingEnabled: false,
  earlyMediaAvmdEnabled: false,
  autoAdvanceToNextLeadEnabled: false
};

test("downloads a campaign ZIP from history and reports unavailable recordings inline", async ({
  page,
  baseURL
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", {
      value: class extends EventTarget {
        close() {}
      }
    });
  });
  const archive = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
  let available = false;
  const exportRequests: string[] = [];
  // Native browser downloads bypass Playwright request interception. Serve the
  // attachment over HTTP and proxy the built app from the existing preview server.
  const server = createServer(async (request, response) => {
    if (request.url === `/api/admin/campaigns/${campaignId}/recordings.zip`) {
      exportRequests.push(request.method!);
      response.writeHead(available ? 200 : 404, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="campaign-${campaignId}-recordings.zip"`
      });
      response.end(request.method === "HEAD" || !available ? undefined : archive);
      return;
    }
    try {
      const upstream = await fetch(`${baseURL}${request.url}`);
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream"
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  try {
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const responses: Record<string, unknown> = {
        "/api/auth/me": { user },
        "/api/agent/desk": {
          user,
          availability: { status: "available", wrapUpUntil: null },
          campaign: null,
          availableCampaigns: [],
          softphone: { registered: false, microphoneAllowed: false, status: "offline" },
          metrics: { todayCalls: 0, voicemailsDropped: 0, suppressed: 0 },
          voicemailJobs: [],
          recentCalls: [],
          leads: [],
          recordings: [],
          activeCall: null
        },
        "/api/admin/overview": {
          user,
          stats: {},
          campaigns: [campaign],
          recordings: [],
          users: [],
          callHistory: [],
          suppression: []
        },
        "/api/admin/csv-imports": { imports: [], page: 1, pageSize: 20, total: 0, totalPages: 0 },
        "/api/admin/calls": { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }
      };
      if (url.pathname === `/api/admin/campaigns/${campaignId}/recordings.zip`) {
        expect(url.search).toBe("");
        await route.continue();
        return;
      }
      if (url.pathname in responses) {
        await route.fulfill({ json: responses[url.pathname] });
        return;
      }
      await route.fulfill({ status: 404, json: { error: `Unhandled test route: ${url.pathname}` } });
    });

    await page.goto(`http://127.0.0.1:${address.port}/call-history`);
    const downloadButton = page.getByRole("button", { name: "Download campaign recordings" });
    await expect(downloadButton).toBeDisabled();
    await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption(campaignId);
    await page.getByLabel("History from date").fill("2026-09-01");
    await downloadButton.click();
    await expect(page.getByRole("alert")).toHaveText("No downloadable recordings found for this campaign.");
    expect(exportRequests).toEqual(["HEAD"]);

    available = true;
    const downloaded = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`campaign-${campaignId}-recordings.zip`);
    expect(await download.failure()).toBeNull();
    expect(await readFile((await download.path())!)).toEqual(archive);
    expect(exportRequests).toEqual(["HEAD", "HEAD", "GET"]);
    await expect(page).toHaveURL(/\/call-history$/);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
