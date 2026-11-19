import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
const callId = "33333333-3333-4333-8333-333333333333";
const item = {
  id: callId,
  leadName: "Inbound caller",
  agentName: "Agent B",
  phoneNumber: "+14155550100",
  campaignName: "Fixed campaign",
  campaignId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  state: "completed",
  outcome: "answered",
  createdAt: "2026-11-18T01:00:00Z",
  durationSeconds: 90,
  recordingAvailable: true,
  avmdReviewStatus: null,
  context: {
    direction: "inbound",
    did: "+12025550100",
    queueId: "44444444-4444-4444-8444-444444444444",
    queueName: "Shared queue",
    queueWaitMs: 10000,
    queueExit: "timeout",
    flowOutcome: "connected",
    terminalReason: "external_forward_completed",
    participantCount: 3,
    transferCount: 1,
    agentTalkMs: 40000,
    manualCorrectionAt: null
  }
};
const pageOf = (items: unknown[]) => ({ items, total: items.length, truncated: false });
const detail = {
  call: {
    ...item,
    recordingStatus: "available",
    recordingDurationSeconds: 90,
    recordingFileSizeBytes: null,
    pcapFileSizeBytes: null,
    voicemailConfidence: null,
    endedAt: "2026-11-18T01:01:30Z",
    answeredAt: "2026-11-18T01:00:01Z"
  },
  avmdReview: null,
  legs: [],
  mediaQuality: [],
  browserMedia: null,
  timeline: [],
  timelineTotal: 0,
  timelineTruncated: false,
  journey: {
    participants: pageOf([
      {
        id: "p1",
        role: "agent",
        agentName: "Agent A",
        connectedAt: "2026-11-18T01:00:10Z",
        leftAt: "2026-11-18T01:00:30Z",
        connectedMs: 20000,
        media: { inboundPackets: 100, outboundPackets: 120 },
        browserMedia: { sampleCount: 5 }
      },
      {
        id: "p2",
        role: "agent",
        agentName: "Agent B",
        connectedAt: "2026-11-18T01:00:30Z",
        leftAt: "2026-11-18T01:00:50Z",
        connectedMs: 20000
      }
    ]),
    offers: pageOf([
      {
        id: "o1",
        agentName: "Agent A",
        kind: "inbound",
        state: "ignored",
        reason: "manual_outbound_started"
      },
      { id: "o2", agentName: "Agent B", kind: "inbound", state: "accepted", reason: "accepted" }
    ]),
    transfers: pageOf([
      {
        id: "t1",
        sourceName: "Agent A",
        recipientName: "Agent B",
        state: "declined",
        reason: "manual_outbound_started"
      }
    ]),
    steps: pageOf([
      { id: "s1", step: "0", action: "forward_external", state: "succeeded", outcome: "connected" }
    ])
  }
};

test("H03.3 B: inbound history filters, participation, playback and CSV keep customer and offer outcomes separate", async ({
  page
}) => {
  const requests: URL[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === "/api/admin/inbound-queues")
      return route.fulfill({ json: { items: [{ id: item.context.queueId, name: "Shared queue" }] } });
    if (url.pathname === "/api/admin/calls/export.csv")
      return route.fulfill({
        contentType: "text/csv",
        body: "call_id,direction,queue_exit,flow_outcome\n" + callId + ",inbound,timeout,connected\n"
      });
    if (url.pathname === "/api/admin/calls")
      return route.fulfill({ json: { items: [item], page: 1, pageSize: 25, total: 1, totalPages: 1 } });
    if (url.pathname === `/api/admin/calls/${callId}`) return route.fulfill({ json: detail });
    if (url.pathname === `/api/admin/calls/${callId}/recording-ticket`)
      return route.fulfill({ json: { url: "/fixture.wav", expiresAt: "2030-01-01T00:00:00Z" } });
    if (url.pathname === "/api/fixture.wav") {
      const wav = Buffer.alloc(16044);
      wav.write("RIFF");
      wav.writeUInt32LE(16036, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(16000, 40);
      return route.fulfill({ body: wav, contentType: "audio/wav" });
    }
    return route.fulfill({ status: 404, json: { message: "Unknown fixture route" } });
  });
  await page.goto("/tests/fixtures/h03/index.html");
  await expect(page.getByRole("button", { name: /Inbound caller/ })).toBeVisible();
  await page.getByRole("combobox", { name: "Direction", exact: true }).selectOption("inbound");
  await page.getByRole("combobox", { name: "Queue", exact: true }).selectOption(item.context.queueId);
  await page.getByRole("textbox", { name: "DID", exact: true }).fill("+12025550100");
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption(item.agentId);
  await expect
    .poll(() =>
      requests
        .filter((r) => r.pathname === "/api/admin/calls")
        .at(-1)
        ?.searchParams.get("did")
    )
    .toBe("+12025550100");
  await page.getByRole("button", { name: /Inbound caller/ }).click();
  const journey = page.getByRole("region", { name: "Call journey" });
  await expect(journey).toContainText("Shared queue");
  await expect(journey).toContainText("timeout");
  await expect(journey).toContainText("connected");
  await expect(journey.getByRole("row")).toHaveCount(3);
  await expect(journey).toContainText("Agent A → Agent B · declined · manual_outbound_started");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/call-history/);
  expect(await readFile((await download.path())!, "utf8")).toContain(`${callId},inbound,timeout,connected`);
  const exportUrl = requests.find((r) => r.pathname.endsWith("export.csv"))!;
  expect(exportUrl.searchParams.get("queueId")).toBe(item.context.queueId);
  expect(exportUrl.searchParams.get("direction")).toBe("inbound");
  expect(exportUrl.searchParams.get("did")).toBe("+12025550100");
  expect(exportUrl.searchParams.get("agentId")).toBe(item.agentId);
  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBe(1);
  await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(0);
});
