import { test, expect, type Page } from "@playwright/test";
import { coordinatedDesk, deferredDesk } from "../../apps/web/src/test/coordination-fixtures";
import type { AgentDeskResponse } from "../../apps/web/src/types";

// Stateful HTTP simulator shared by pages; it is not the product API or DB.
async function browserPhone(page: Page, denied = false) {
  await page.addInitScript((deny) => {
    window.e03Sound = { plays: 0, pauses: 0, denied: deny };
    HTMLMediaElement.prototype.play = function () {
      window.e03Sound.plays++;
      return window.e03Sound.denied
        ? Promise.reject(new DOMException("Blocked", "NotAllowedError"))
        : Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      window.e03Sound.pauses++;
    };
  }, denied);
}
function server(initial = coordinatedDesk()) {
  const state = {
    desks: [structuredClone(initial), structuredClone(initial)],
    requests: [] as Array<{ path: string; body: any }>,
    fail: false,
    autoStart: false,
    hold: null as Promise<void> | null,
    winner: false
  };
  return {
    state,
    install: async (page: Page, agent = 0) => {
      await browserPhone(page);
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "GET") {
          await route.fulfill({ json: state.desks[agent] });
          return;
        }
        const body = route.request().postDataJSON();
        state.requests.push({ path, body });
        if (state.hold) await state.hold;
        if (state.fail || (path.endsWith("/accept") && state.winner)) {
          await route.fulfill({
            status: 409,
            json: {
              code: state.fail ? "capacity_exhausted" : "offer_closed",
              message: "state changed",
              revision: "1"
            }
          });
          return;
        }
        const desk = state.desks[agent];
        if (path.endsWith("/accept")) {
          state.winner = true;
          for (const d of state.desks) d.coordination!.offer = null;
          desk.coordination!.slot = {
            state: "connecting",
            callId: initial.coordination!.offer!.callId,
            reservationId: "reservation",
            generation: "1"
          };
          await route.fulfill({
            json: {
              status: "connecting",
              revision: "1",
              callId: desk.coordination!.slot.callId,
              operationId: "operation",
              offerId: initial.coordination!.offer!.id
            }
          });
          return;
        }
        if (path.endsWith("/ignore")) {
          desk.coordination!.offer = null;
          await route.fulfill({ json: { status: "applied", revision: "1" } });
          return;
        }
        if (body.intent?.startReason === "automatic" && !state.autoStart) {
          await route.fulfill({
            json: {
              status: "deferred",
              reason: "incoming_pending",
              revision: "1",
              intent: desk.coordination!.autoNextIntent
            }
          });
          return;
        }
        desk.coordination!.offer = null;
        desk.coordination!.slot = {
          state: "reserved",
          callId: "outbound",
          reservationId: "reservation",
          generation: "1"
        };
        await route.fulfill({
          json: { status: "started", revision: "1", callId: "outbound", operationId: "operation" }
        });
      });
      await page.goto("/tests/fixtures/e03/index.html");
      await expect(page.getByLabel("Manual call")).toBeVisible();
    }
  };
}
async function publish(page: Page, desk: AgentDeskResponse) {
  await page.evaluate((d) => window.e03.snapshot(d), desk);
}

test("E03.1 repeated/out-of-order/reconnect snapshots, autoplay denial, keyboard Ignore and Desk exit", async ({
  page
}) => {
  const sim = server();
  await sim.install(page);
  await page.evaluate(() => {
    window.e03Sound.denied = true;
  });
  // Restart the fixture-owned audio with autoplay deliberately denied.
  await page.getByRole("button", { name: "Toggle Desk" }).click();
  await page.getByRole("button", { name: "Toggle Desk" }).click();
  await expect(page.getByRole("button", { name: "Enable ringtone" })).toBeVisible();
  const plays = await page.evaluate(() => window.e03Sound.plays);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Refresh snapshot" }).click();
  expect(await page.evaluate(() => window.e03Sound.plays)).toBe(plays);
  expect(sim.state.requests).toHaveLength(0);
  await page.evaluate(() => {
    window.e03Sound.denied = false;
  });
  await page.getByRole("button", { name: "Enable ringtone" }).click();
  await expect(page.getByRole("button", { name: "Enable ringtone" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ignore", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  const stale = coordinatedDesk();
  await publish(page, stale);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  expect(sim.state.requests).toHaveLength(1);
  expect(sim.state.requests[0].path).toMatch(/\/ignore$/);
  expect(await page.evaluate(() => window.e03Sound.pauses)).toBeGreaterThan(0);
});

test("E03.1 expiry and another winner remove the card/ringtone without acceptance", async ({ page }) => {
  const sim = server();
  await page.clock.install();
  await sim.install(page);
  await page.clock.fastForward(31000);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  expect(sim.state.requests).toHaveLength(0);
  await page.reload(); // expired server offer is still never auto-accepted
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
});

for (const offerKind of ["inbound", "transfer"] as const) {
  for (const action of ["next", "lead", "number"] as const) {
    for (const succeeds of [true, false]) {
      test(`E03.2 ${offerKind} + manual ${action} ${succeeds ? "success" : "failure"} uses one atomic request`, async ({
        page
      }) => {
        const desk = coordinatedDesk();
        desk.coordination!.offer!.kind = offerKind;
        if (offerKind === "transfer")
          desk.coordination!.offer!.transferId = "99999999-9999-4999-8999-999999999999";
        const sim = server(desk);
        sim.state.fail = !succeeds;
        // server.install waits for the incoming heading; start with inbound then publish transfer.
        sim.state.desks[0].coordination!.offer!.kind = "inbound";
        await sim.install(page);
        sim.state.desks[0] = desk;
        await publish(page, desk);
        let release!: () => void;
        sim.state.hold = new Promise((r) => {
          release = r;
        });
        const button =
          action === "next"
            ? page.getByRole("button", { name: "Start next call" })
            : action === "lead"
              ? page.getByRole("table").getByRole("button", { name: "Call", exact: true })
              : page.locator("form.inline-manual-dial").getByRole("button", { name: "Call", exact: true });
        await expect(button).toBeEnabled();
        await button.click();
        await expect.poll(() => sim.state.requests.length).toBe(1);
        await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
        release();
        if (succeeds) await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
        else {
          await expect(page.getByText("Calling capacity is busy. Please try again shortly.")).toBeVisible();
          await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
          if (action === "number") await expect(page.getByLabel("Manual call")).toHaveValue("+15557654321");
        }
        expect(sim.state.requests).toHaveLength(1);
        expect(sim.state.requests[0].body.intent).toMatchObject({
          startReason: "manual",
          expectedRevision: "1",
          bindingGeneration: "1",
          deskSessionId: desk.coordination!.session!.id
        });
        expect(sim.state.requests[0].path).not.toMatch(/ignore|decline|accept/);
      });
    }
  }
}

test("E03.3 automatic defer has no ringback, stable retry, explicit Next cancels stale timer", async ({
  page
}) => {
  const sim = server(deferredDesk());
  await page.clock.install();
  await sim.install(page);
  await expect.poll(() => sim.state.requests.length).toBe(1);
  await page.clock.fastForward(2001);
  await expect.poll(() => sim.state.requests.length).toBe(2);
  expect(sim.state.requests[0].body).toEqual(sim.state.requests[1].body);
  expect(sim.state.requests[0].body.intent.startReason).toBe("automatic");
  expect(await page.evaluate(() => window.e03.ringback)).toBe(0);
  await page.getByRole("button", { name: "Start next call" }).click();
  await expect.poll(() => sim.state.requests.length).toBe(3);
  expect(sim.state.requests[2].body.intent.startReason).toBe("manual");
  await page.clock.fastForward(10000);
  expect(sim.state.requests).toHaveLength(3);
});

test("E03.4 two agents and a stale tab: one winner, one request per double click, useful conflict feedback", async ({
  page,
  context
}) => {
  const sim = server();
  const second = await context.newPage();
  const stale = await context.newPage();
  await sim.install(page);
  await sim.install(second, 1);
  await sim.install(stale);
  await page.getByRole("button", { name: "Accept", exact: true }).dblclick();
  await expect(page.getByText("Connecting…").first()).toBeVisible();
  await second.getByRole("button", { name: "Refresh snapshot" }).click();
  await expect(second.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await stale.getByRole("button", { name: "Accept", exact: true }).focus();
  await stale.keyboard.press("Enter");
  await expect(stale.getByText("This offer has ended. The desk has been refreshed.")).toBeVisible();
  await expect(stale.getByText("This offer has ended. The desk has been refreshed.")).toBeFocused();
  expect(sim.state.requests.filter((r) => r.path.endsWith("/accept"))).toHaveLength(2);
  await expect(stale.getByRole("button", { name: "Refresh snapshot" })).toBeEnabled();
  await expect(stale.getByRole("alert")).toHaveCount(0);
});

test("E03.3 revision/campaign/source changes and inbound completion cancel automatic callbacks", async ({
  page
}) => {
  const sim = server(deferredDesk());
  await page.clock.install();
  await sim.install(page);
  await expect.poll(() => sim.state.requests.length).toBe(1);
  const next = structuredClone(sim.state.desks[0]);
  next.coordination!.revision = "2";
  next.coordination!.session!.revision = "2";
  next.coordination!.autoNextIntent = null; // inbound completion/handover has no eligible source
  next.campaign!.id = "99999999-9999-4999-8999-999999999999";
  next.coordination!.session!.campaignId = next.campaign!.id;
  await publish(page, next);
  await page.clock.fastForward(10000);
  expect(sim.state.requests).toHaveLength(1);
  const stale = structuredClone(sim.state.desks[0]);
  await publish(page, stale);
  await page.clock.fastForward(5000);
  expect(sim.state.requests).toHaveLength(1);
  expect(await page.evaluate(() => window.e03.ringback)).toBe(0);
});

test("E03.3 confirmed voicemail-release source fixture advances once without ending background playback", async ({
  page
}) => {
  const desk = deferredDesk();
  desk.coordination!.offer = null;
  const source = desk.coordination!.autoNextIntent!;
  desk.coordination!.autoNextIntent = { ...source, state: "pending", reason: null, callId: null };
  desk.coordination!.actions.autoNext = { allowed: true, reason: null };
  desk.voicemailJobs = [
    {
      callId: source.sourceCallId,
      leadName: "Previous lead",
      phoneNumber: "+15551234567",
      status: "playing",
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];
  const sim = server(desk);
  sim.state.autoStart = true;
  await page.clock.install();
  await sim.install(page);
  await expect.poll(() => sim.state.requests.length).toBe(1);
  await expect(page.getByText("Previous lead")).toBeVisible();
  expect(sim.state.requests[0].body.intent).toMatchObject({
    startReason: "automatic",
    sourceCallId: source.sourceCallId
  });
  await page.clock.fastForward(10000);
  expect(sim.state.requests).toHaveLength(1);
  expect(await page.evaluate(() => window.e03.ringback)).toBe(1);
});
