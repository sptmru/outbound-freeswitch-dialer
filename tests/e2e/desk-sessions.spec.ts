import { expect, test } from "@playwright/test";
const campaignId = "11111111-1111-4111-8111-111111111111";
const user = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "d01@example.test",
  name: "D01 Agent",
  role: "admin",
  isActive: true
};
const unavailable = { allowed: false, reason: "endpoint_unavailable" };

test("D01.1 B: Desk enter/register/leave uses one fenced session; non-Desk route has no heartbeat (simulated SIP/API)", async ({
  page
}) => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let session = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: "1",
    bindingGeneration: "1",
    campaignId,
    endpointVerified: false,
    ready: false,
    expiresAt: new Date(Date.now() + 30000).toISOString()
  };
  const desk = {
    user,
    availability: { status: "available", wrapUpUntil: null },
    campaign: {
      id: campaignId,
      name: "D01 campaign",
      status: "active",
      callableLeads: 0,
      manualDialingEnabled: true,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false
    },
    availableCampaigns: [{ id: campaignId, name: "D01 campaign", status: "active", callableLeads: 0 }],
    softphone: { registered: true, microphoneAllowed: true, status: "ready" },
    metrics: { todayCalls: 0, voicemailsDropped: 0, suppressed: 0 },
    voicemailJobs: [],
    recentCalls: [],
    leads: [],
    recordings: [],
    activeCall: null,
    coordination: {
      contractVersion: 1,
      revision: "1",
      session: null,
      slot: { state: "free", callId: null, reservationId: null, generation: "1" },
      offer: null,
      transfer: null,
      autoNextIntent: null,
      actions: {
        manualStart: unavailable,
        autoNext: unavailable,
        accept: unavailable,
        ignore: unavailable,
        transfer: unavailable
      }
    }
  };
  await page.addInitScript(() => {
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: class extends EventTarget {
        close() {}
      }
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => new AudioContext().createMediaStreamDestination().stream,
        enumerateDevices: async () => [],
        addEventListener() {},
        removeEventListener() {}
      }
    });
  });
  await page.routeWebSocket("wss://fixture.invalid/", (socket) =>
    socket.onMessage((raw) => {
      const request = raw.toString();
      if (!request.startsWith("REGISTER ")) return;
      const header = (key: string) =>
        request.split("\r\n").find((line) => line.toLowerCase().startsWith(`${key.toLowerCase()}:`)) ?? "";
      socket.send(
        [
          "SIP/2.0 200 OK",
          header("Via"),
          header("To") + ";tag=fixture",
          header("From"),
          header("Call-ID"),
          header("CSeq"),
          header("Contact") + ";expires=60",
          "Content-Length: 0",
          "",
          ""
        ].join("\r\n")
      );
    })
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user } });
    if (path === "/api/agent/desk") return route.fulfill({ json: desk });
    if (path === "/api/admin/overview")
      return route.fulfill({
        json: {
          user,
          stats: {
            campaigns: 1,
            activeAgents: 1,
            callsToday: 0,
            suppressionEntries: 0,
            liveCalls: 0,
            outcomeDistribution: []
          },
          campaigns: [],
          recordings: [],
          users: [],
          calls: 0,
          recordingFiles: 0,
          pcapFiles: 0
        }
      });
    if (path === "/api/admin/csv-imports")
      return route.fulfill({ json: { imports: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } });

    if (path.startsWith("/api/agent/desk-sessions")) {
      const body = route.request().postDataJSON();
      const method = route.request().method();
      calls.push({ method, body });
      if (method === "POST")
        return route.fulfill({
          json: {
            revision: "1",
            session,
            sip: {
              username: "desk_0123456789abcdef0123456789abcdef",
              password: "fixture-only",
              domain: "fixture.invalid",
              websocketUrl: "wss://fixture.invalid/",
              iceServers: []
            }
          }
        });
      expect(body.deskSessionId).toBe(session.id);
      expect(body.bindingGeneration).toBe("1");
      expect(body.expectedRevision).toBe(session.revision);
      session = {
        ...session,
        revision: String(Number(session.revision) + 1),
        ready: body.ready === true,
        endpointVerified: body.ready === true
      };
      return route.fulfill({
        json: { revision: session.revision, session: method === "DELETE" ? null : session }
      });
    }
    if (path === "/api/agent/call-history")
      return route.fulfill({ json: { calls: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return route.fulfill({ status: 404, json: { message: `Unhandled fixture route: ${path}` } });
  });
  await page.goto(`/?campaignId=${campaignId}`);
  await expect(page.getByRole("heading", { name: "Agent desk" })).toBeVisible();
  await expect.poll(() => calls.some((c) => c.method === "PATCH" && c.body.ready === true)).toBe(true);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  await page.getByRole("button", { name: "Call history", exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === "DELETE").length).toBe(1);
  const afterLeave = calls.length;
  // Advance the browser's interval without sleeping; a closed Desk sends no PATCH.
  await page.clock.install();
  await page.clock.fastForward(10000);
  expect(calls).toHaveLength(afterLeave);
});
