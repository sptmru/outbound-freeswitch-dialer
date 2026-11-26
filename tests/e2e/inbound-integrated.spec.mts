import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { browserFixture, password } from "../fixtures/i01/server.mjs";

type Fixture = Awaited<ReturnType<typeof browserFixture>>;

async function login(
  browser: Browser,
  f: Fixture,
  actor: { email: string; campaignId?: string },
  path = "/"
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = new URL(path, f.origin);
  url.searchParams.set("campaignId", actor.campaignId ?? f.campaignId);
  await page.goto(url.href);
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  return page;
}

const offerButton = (page: Page, name = "Accept") => page.getByRole("button", { name, exact: true });
const dial = (page: Page) => page.getByRole("textbox", { name: "Manual call" });
const manualCall = (page: Page) =>
  page
    .locator("form")
    .filter({ has: dial(page) })
    .getByRole("button", { name: "Call", exact: true });
const hangup = (page: Page) => page.getByRole("button", { name: "Hang up", exact: true });
const transfer = (page: Page, recipient: string) =>
  (async () => {
    await page.getByRole("button", { name: "Transfer", exact: true }).click();
    await page.getByLabel("Transfer to colleague").selectOption(recipient);
    await page.getByRole("button", { name: "Send request" }).click();
  })();

const test = base.extend<{ f: Fixture }>({
  f: async ({ browser }, use) => {
    const f = await browserFixture();
    try {
      await use(f);
    } finally {
      try {
        await Promise.all(browser.contexts().map((context) => context.close()));
      } finally {
        await f.close();
      }
    }
  }
});

async function awaitExpiry(f: Fixture, callId: string, agent: { id: string }) {
  await expect
    .poll(
      () =>
        f.one(
          "select deadline_at<=clock_timestamp() as due from call_offers where call_id=$1 and agent_id=$2",
          [callId, agent.id]
        ),
      { timeout: 23_000 }
    )
    .toEqual({ due: true });
  await f.dispatch(agent);
}

test("I01.1 ring-all, stale loser, tab reload and terminal inbound history", async ({ browser, f }) => {
  const [alice, bob] = await Promise.all([login(browser, f, f.alice), login(browser, f, f.bob)]);
  const id = await f.arrive();
  await expect(offerButton(alice)).toBeEnabled();
  await expect(offerButton(bob)).toBeEnabled();
  const tab = await bob.context().newPage();
  await tab.goto(bob.url());
  await expect(offerButton(tab)).toBeEnabled();

  // Both browser mutations reach Fastify with the offer they each saw.
  const agents = [alice, bob];
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  for (const page of agents) {
    await page.route("**/api/agent/call-offers/*/accept", async (route) => {
      if (++requests === agents.length) release();
      await bothArrived;
      await route.continue();
    });
  }
  const replies = agents.map((page) =>
    page.waitForResponse((r) => r.url().endsWith("/accept") && r.request().method() === "POST")
  );
  await Promise.all([offerButton(alice).click(), offerButton(bob).click()]);
  const statuses = (await Promise.all(replies)).map((r) => r.status());
  expect([...statuses].sort()).toEqual([200, 409]);
  expect(await f.query("select state from call_offers where call_id=$1 order by state", [id])).toEqual([
    { state: "accepted" },
    { state: "canceled" }
  ]);
  expect(
    await f.one("select count(*)::int as n from inbound_connection_attempts where call_id=$1", [id])
  ).toEqual({ n: 1 });
  await tab.reload();
  await expect(offerButton(tab)).toHaveCount(0);
  await f.connectInbound(id);
  await expect(hangup(agents[statuses.indexOf(200)]!)).toBeEnabled();
  expect(await f.one("select state from calls where id=$1", [id])).toEqual({ state: "agent_connected" });
  await f.endInbound(id);
  await expect
    .poll(() => f.one("select ended_at is not null as ended from calls where id=$1", [id]))
    .toEqual({ ended: true });
  const admin = await login(browser, f, f.admin, "/call-history");
  await expect(admin.getByRole("button", { name: /415.*555.*0199/ }).first()).toBeVisible();
});

test("I01.1 ignore and expiry survive refresh, campaign eligibility and loss of SSE", async ({
  browser,
  f
}) => {
  const [alice, bob] = await Promise.all([login(browser, f, f.alice), login(browser, f, f.bob)]);
  const id = await f.arrive("+14155550199", [f.alice, f.bob], 5000);
  await expect(offerButton(alice, "Ignore")).toBeEnabled();
  await offerButton(alice, "Ignore").focus();
  await alice.keyboard.press("Enter");
  await expect(offerButton(alice)).toHaveCount(0);
  await awaitExpiry(f, id, f.bob);
  await expect(offerButton(bob)).toHaveCount(0);
  await bob.reload();
  await expect(dial(bob)).toBeVisible();
  await f.dispatch(f.alice, f.bob);
  expect(await f.query("select state,reason from call_offers where call_id=$1 order by state", [id])).toEqual(
    [
      { state: "expired", reason: "deadline_elapsed" },
      { state: "ignored", reason: "user_ignored" }
    ]
  );

  const c = await f.actor("Carol");
  const wrong = await f.actor("Dana", f.otherId);
  const carol = await login(browser, f, c);
  await carol.route("**/api/agent/events", (r) => r.abort("failed"));
  await carol.clock.install();
  await carol.clock.setFixedTime(Date.now());
  await carol.reload();
  await expect(dial(carol)).toBeVisible();
  await carol.clock.runFor(250);
  await expect(offerButton(carol)).toHaveCount(0);
  await f.dispatch(c, wrong);
  expect(
    await f.one("select count(*)::int as n from call_offers where call_id=$1 and agent_id=$2", [id, wrong.id])
  ).toEqual({ n: 0 });
  await carol.clock.fastForward(30_100);
  await expect(offerButton(carol)).toBeEnabled();
  await f.endInbound(id);
});

test("I01.1 manual override dismisses only the actor's inbound offer", async ({ browser, f }) => {
  const [alice, bob] = await Promise.all([login(browser, f, f.alice), login(browser, f, f.bob)]);
  const id = await f.arrive();
  await expect(offerButton(alice)).toBeEnabled();
  await expect(offerButton(bob)).toBeEnabled();
  await f.query(
    "insert into suppression_entries(phone_number,normalized_phone_number,reason) values($1,$1,'I01 fixture')",
    ["+14155550176"]
  );
  await dial(alice).fill("+14155550176");
  const rejected = alice.waitForResponse((r) => r.url().endsWith("/manual-dial/start"));
  await manualCall(alice).click();
  const rejection = await rejected;
  expect(rejection.status()).toBe(409);
  expect(await rejection.json()).toMatchObject({ message: "suppressed" });
  await expect(offerButton(alice)).toBeEnabled();
  expect(
    await f.one("select state from call_offers where call_id=$1 and agent_id=$2", [id, f.alice.id])
  ).toEqual({ state: "pending" });
  await dial(alice).fill("+14155550174");
  const response = alice.waitForResponse(
    (r) => r.url().endsWith("/manual-dial/start") && r.request().method() === "POST"
  );
  await manualCall(alice).click();
  expect((await response).ok()).toBeTruthy();
  await expect(offerButton(alice)).toHaveCount(0);
  await expect(offerButton(bob)).toBeEnabled();
  expect(await f.query("select state,reason from call_offers where call_id=$1 order by state", [id])).toEqual(
    [
      { state: "ignored", reason: "manual_outbound_started" },
      { state: "pending", reason: null }
    ]
  );
  expect(await f.one("select direction from calls where agent_id=$1 and manual_dial", [f.alice.id])).toEqual({
    direction: "outbound"
  });

  await dial(bob).fill("+14155550175");
  const bobStart = bob.waitForResponse((r) => r.url().endsWith("/manual-dial/start"));
  await manualCall(bob).click();
  expect((await bobStart).ok()).toBe(true);
  const waiting = await f.arrive("+14155550197");
  expect(await f.one("select count(*)::int as n from call_offers where call_id=$1", [waiting])).toEqual({
    n: 0
  });
  expect(await f.one("select state from calls where id=$1", [waiting])).toEqual({ state: "queued" });
});

for (const inbound of [true, false]) {
  for (const outcome of ["completed", "declined", "canceled", "expired", "failed", "manual"] as const) {
    test(`I01.2 ${inbound ? "inbound" : "outbound"} transfer ${outcome} retains persisted attribution`, async ({
      browser,
      f
    }) => {
      const call = await f.seedConnected(inbound);
      const [alice, bob] = await Promise.all([login(browser, f, f.alice), login(browser, f, f.bob)]);
      await transfer(alice, f.bob.id);
      await expect(offerButton(bob)).toBeEnabled();
      if (outcome === "declined") await offerButton(bob, "Decline").click();
      if (outcome === "canceled") await alice.getByRole("button", { name: "Cancel transfer" }).click();
      if (outcome === "expired") await awaitExpiry(f, call.callId, f.bob);
      if (outcome === "manual") {
        await dial(bob).fill("+14155550175");
        await manualCall(bob).click();
      }
      if (outcome === "completed" || outcome === "failed") {
        const accepted = bob.waitForResponse(
          (r) => r.url().endsWith("/accept") && r.request().method() === "POST"
        );
        await offerButton(bob).click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        const { operationId } = await response.json();
        await expect(hangup(alice)).toBeEnabled();
        await f.finishTransfer(call, operationId, outcome === "completed");
      }
      await expect
        .poll(() => f.one("select state from call_transfers where call_id=$1", [call.callId]))
        .toEqual({ state: outcome === "manual" ? "declined" : outcome });
      const current = outcome === "completed" ? bob : alice;
      const owner = outcome === "completed" ? f.bob : f.alice;
      expect(await f.one("select agent_id from calls where id=$1", [call.callId])).toEqual({
        agent_id: owner.id
      });
      if (outcome === "manual") {
        expect(await f.one("select reason from call_transfers where call_id=$1", [call.callId])).toEqual({
          reason: "manual_outbound_started"
        });
        expect(await f.one("select direction,manual_dial from calls where agent_id=$1", [f.bob.id])).toEqual({
          direction: "outbound",
          manual_dial: true
        });
      }
      await current.reload();
      await expect(hangup(current)).toBeEnabled();
      if (outcome === "completed") {
        await expect(hangup(alice)).toHaveCount(0);
        const stale = await alice.request.post(`${f.origin}/api/agent/calls/${call.callId}/dtmf`, {
          headers: { origin: f.origin },
          data: {
            digit: "1",
            intent: {
              deskSessionId: f.alice.sessionId,
              expectedRevision: "1",
              bindingGeneration: "1",
              idempotencyKey: randomUUID()
            }
          }
        });
        expect(stale.status()).toBe(409);
        expect(await stale.json()).toMatchObject({ code: "not_controller" });
        const end = current.waitForResponse(
          (r) => r.url().endsWith("/end") && r.request().method() === "POST"
        );
        await hangup(current).click();
        const endResponse = await end;
        expect(endResponse.ok()).toBe(true);
        expect(
          await f.one(
            "select command_kind,request->>'actorUserId' as actor from call_operations where id=$1",
            [(await endResponse.json()).operationId]
          )
        ).toEqual({ command_kind: "hangup", actor: f.bob.userId });
      }
    });
  }
}

test("I01.3 persisted history, playback ticket and CSV require the admin role", async ({ browser, f }) => {
  await f.query("update campaigns set call_recording_enabled=true where id=$1", [f.campaignId]);
  const id = await f.arrive("+14155550198", []);
  await f.endInbound(id);
  await f.recording(id);
  const [admin, alice] = await Promise.all([
    login(browser, f, f.admin, "/call-history"),
    login(browser, f, f.alice)
  ]);
  await admin.getByRole("combobox", { name: "Direction", exact: true }).selectOption("inbound");
  await admin
    .getByRole("button", { name: /415.*555.*0198/ })
    .first()
    .click();
  await expect(admin.getByRole("region", { name: "Call journey" })).toContainText("I01 queue");
  const audio = admin.locator("audio");
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBe(1);
  const downloadPromise = admin.waitForEvent("download");
  await admin.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, "utf8")).toContain(id);
  expect((await alice.request.get(f.origin + "/api/admin/calls")).status()).toBe(403);
  expect(
    (
      await alice.request.post(f.origin + `/api/admin/calls/${id}/recording-ticket`, {
        headers: { origin: f.origin }
      })
    ).status()
  ).toBe(403);
});

test("I01.4 pause, direct lead and next-lead starts use persisted Desk state", async ({ browser, f }) => {
  const lead = await f.lead("I01 first lead", "+14155550121");
  await f.lead("I01 second lead", "+14155550122");
  const [alice, bob] = await Promise.all([login(browser, f, f.alice), login(browser, f, f.bob)]);
  await alice.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Start next call" })).toBeDisabled();
  expect(await f.one("select availability_status from agents where id=$1", [f.alice.id])).toEqual({
    availability_status: "paused"
  });
  await alice.getByRole("button", { name: "Resume calling" }).click();
  const row = alice.getByRole("row").filter({ hasText: "I01 first lead" });
  await row.getByRole("button", { name: "Call", exact: true }).click();
  await expect
    .poll(() => f.one("select contact_id from calls where agent_id=$1", [f.alice.id]))
    .toEqual({ contact_id: lead.id });
  await bob.getByRole("button", { name: "Start next call" }).click();
  await expect
    .poll(() => f.one("select destination_number from calls where agent_id=$1", [f.bob.id]))
    .toEqual({ destination_number: "+14155550122" });
  await bob.reload();
  await expect(hangup(bob)).toBeVisible();
});

test("I01.1 automatic next defers on inbound and explicit Next can override", async ({ browser, f }) => {
  const sourceLead = await f.lead("Previous lead", "+14155550123");
  const nextLead = await f.lead("Next lead", "+14155550124");
  const alice = await login(browser, f, f.alice);
  const id = await f.arrive();
  await expect(offerButton(alice)).toBeEnabled();
  const sourceId = await f.offerAutomaticNext(f.alice, sourceLead.id);
  await expect
    .poll(() =>
      f.one("select state,reason,started_call_id from agent_auto_next_intents where source_call_id=$1", [
        sourceId
      ])
    )
    .toEqual({ state: "deferred", reason: "incoming_pending", started_call_id: null });
  await expect(offerButton(alice)).toBeEnabled();
  await alice.getByRole("button", { name: "Start next call" }).click();
  await expect
    .poll(() =>
      f.one("select state,reason from call_offers where call_id=$1 and agent_id=$2", [id, f.alice.id])
    )
    .toEqual({ state: "ignored", reason: "manual_outbound_started" });
  expect(
    await f.one("select state from agent_auto_next_intents where source_call_id=$1", [sourceId])
  ).toEqual({ state: "canceled" });
  expect(await f.one("select agent_id from calls where contact_id=$1", [nextLead.id])).toEqual({
    agent_id: f.alice.id
  });
});

test("I01.3 admin saves a flow, queue limits and DID, and retries after invalid input", async ({
  browser,
  f
}) => {
  const audioId = await f.inboundAudio();
  const admin = await login(browser, f, f.admin, "/inbound");
  const save = admin.getByRole("button", { name: "Save configuration" });
  await admin.getByRole("button", { name: "Flows", exact: true }).click();
  await admin.getByLabel("Name", { exact: true }).fill("Hangup flow");
  await admin.getByLabel("Campaign", { exact: true }).selectOption(f.campaignId);
  await save.focus();
  await admin.keyboard.press("Enter");
  await expect(admin.getByRole("button", { name: "Hangup flow", exact: true })).toBeVisible();
  const version = await f.one("select id from inbound_flow_versions where campaign_id=$1", [f.campaignId]);
  await admin.getByRole("button", { name: "Queues", exact: true }).click();
  await admin.getByRole("button", { name: "I01 queue", exact: true }).click();
  await admin.getByLabel("No-answer flow").selectOption(version.id);
  await admin.getByLabel("Waiting audio").selectOption(audioId);
  await admin.getByRole("button", { name: "Preview audio" }).click();
  const preview = admin.getByLabel("Inbound audio preview");
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((el: HTMLAudioElement) => el.duration)).toBe(1);
  const waiting = admin.getByLabel("Maximum waiting calls");
  await waiting.fill("0");
  await save.click();
  expect(await waiting.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
  await waiting.fill("5");
  await save.click();
  await expect
    .poll(() =>
      f.one(
        "select max_waiting_calls,no_answer_flow_version_id,waiting_audio_id from inbound_queues where id=$1",
        [f.queueId]
      )
    )
    .toEqual({ max_waiting_calls: 5, no_answer_flow_version_id: version.id, waiting_audio_id: audioId });
  await admin.getByRole("button", { name: "Numbers", exact: true }).click();
  await admin.getByLabel("Number label").fill("Front desk");
  await admin.getByLabel("International DID").fill("+12025550170");
  await admin.getByLabel("Shared queue").selectOption(f.queueId);
  await save.click();
  const number = admin.getByRole("button", { name: "Front desk · +12025550170", exact: true });
  await expect(number).toBeVisible();
  await admin.reload();
  await expect(number).toBeVisible();
  expect(
    await f.one("select queue_id,enabled from inbound_numbers where normalized_did='+12025550170'")
  ).toEqual({ queue_id: f.queueId, enabled: false });
  await f.query(
    "update inbound_freeswitch_configuration set error_revision=desired_revision,apply_error='Fixture reload failed' where singleton"
  );
  await admin.getByRole("button", { name: "Reload saved configuration" }).click();
  await expect(admin.getByText("Fixture reload failed", { exact: false })).toBeVisible();
});
