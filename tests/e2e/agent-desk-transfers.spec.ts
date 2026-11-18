import { test, expect, type Page } from "@playwright/test";
import {
  targetId,
  transferSource,
  transferRecipient,
  transferSnapshot
} from "../../apps/web/src/test/transfer-fixtures";
import type { AgentDeskResponse, TransferSnapshot } from "../../apps/web/src/types";

// Shared simulated HTTP state for two agents. Media/controller are explicit fixtures.
function server(direction: "inbound" | "outbound" = "inbound") {
  const source = transferSource(direction),
    recipient = transferRecipient();
  recipient.coordination!.offer = null;
  recipient.coordination!.transfer = null;
  const state = {
    desks: [source, recipient],
    requests: [] as Array<{ path: string; method: string; body: any }>,
    busyTarget: false,
    failManual: false,
    hold: null as Promise<void> | null
  };
  function transition(status: TransferSnapshot["state"]) {
    for (const desk of state.desks) desk.coordination!.transfer = transferSnapshot(status);
    if (status !== "offered") state.desks[1].coordination!.offer = null;
  }
  async function install(page: Page, agent: number) {
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      HTMLMediaElement.prototype.pause = () => {};
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        await route.fulfill({
          json: path.endsWith("transfer-targets")
            ? {
                revision: "1",
                items: [
                  {
                    agentId: targetId,
                    name: "Colleague",
                    available: !state.busyTarget,
                    reason: state.busyTarget ? "slot_occupied" : null
                  }
                ]
              }
            : state.desks[agent]
        });
        return;
      }
      const body = request.postDataJSON();
      state.requests.push({ path, method: request.method(), body });
      if (state.hold) await state.hold;
      const failed = path.endsWith("/transfers")
        ? state.busyTarget
        : state.failManual && !/accept|ignore/.test(path);
      if (failed) {
        await route.fulfill({
          status: 409,
          json: { code: "slot_occupied", message: "Availability changed", revision: "1" }
        });
        return;
      }
      if (request.method() === "DELETE") transition("canceled");
      else if (path.endsWith("/transfers")) {
        transition("offered");
        const offer = transferRecipient().coordination!.offer!;
        state.desks[1].coordination!.offer = offer;
        await route.fulfill({
          json: { status: "applied", revision: "1", transfer: transferSnapshot(), offerId: offer.id }
        });
        return;
      } else if (path.endsWith("/accept")) {
        transition("connecting");
        state.desks[1].coordination!.slot = {
          state: "connecting",
          callId: transferSnapshot().callId,
          reservationId: "reservation",
          generation: "1"
        };
        await route.fulfill({
          json: {
            status: "connecting",
            revision: "1",
            callId: transferSnapshot().callId,
            offerId: "offer",
            operationId: "operation"
          }
        });
        return;
      } else if (path.endsWith("/ignore")) transition("declined");
      else {
        transition("declined"); // same server transaction as manual start, no separate decline
        state.desks[1].coordination!.slot = {
          state: "reserved",
          callId: "outbound",
          reservationId: "reservation",
          generation: "1"
        };
        await route.fulfill({
          json: { status: "started", revision: "1", callId: "outbound", operationId: "operation" }
        });
        return;
      }
      await route.fulfill({
        json: { status: "applied", revision: "1", transfer: state.desks[agent].coordination!.transfer }
      });
    });
    await page.goto("/tests/fixtures/e03/index.html");
    await expect(page.getByRole("button", { name: "Refresh snapshot" })).toBeVisible();
    if (agent === 0) await expect(page.getByRole("button", { name: "Choose colleague" })).toBeVisible();
    else await expect(page.getByLabel("Manual call")).toBeVisible();
  }
  async function offer(page: Page) {
    await page.getByRole("button", { name: "Choose colleague" }).click();
    await page.getByLabel("Transfer recipient").selectOption(targetId);
    await page.getByRole("button", { name: "Request transfer" }).click();
    await expect(page.getByRole("button", { name: "Cancel transfer" })).toBeVisible();
  }
  return { state, transition, install, offer };
}
async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh snapshot" }).click();
}
async function publish(page: Page, desk: AgentDeskResponse) {
  await page.evaluate((d) => window.e03.snapshot(d), desk);
}
for (const direction of ["inbound", "outbound"] as const) {
  for (const result of ["completed", "declined", "canceled", "expired", "failed"] as const) {
    test(`G03.1/G03.3 paired ${direction} ${result}, cross-campaign labels and source continuity`, async ({
      page,
      context
    }) => {
      const sim = server(direction),
        target = await context.newPage();
      await sim.install(page, 0);
      await sim.install(target, 1);
      await sim.offer(page);
      await refresh(target);
      await expect(target.getByText("Call campaign: Campaign One")).toBeVisible();
      await expect(target.getByText("Your selected campaign will not change.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
      if (result === "declined") await target.getByRole("button", { name: "Decline", exact: true }).click();
      else if (result === "canceled") await page.getByRole("button", { name: "Cancel transfer" }).click();
      else if (result === "expired") {
        sim.transition("expired");
        await refresh(target);
        await refresh(page);
      } else {
        let release!: () => void;
        sim.state.hold = new Promise((r) => {
          release = r;
        });
        await target.getByRole("button", { name: "Accept", exact: true }).dblclick();
        await expect.poll(() => sim.state.requests.filter((r) => r.path.endsWith("/accept")).length).toBe(1);
        await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
        release();
        sim.state.hold = null;
        await expect(target.getByText("Connecting…", { exact: true }).first()).toBeVisible();
        await refresh(page);
        await expect(page.getByText("Connecting colleague…")).toBeVisible();
        // Reconnect/reload recovers server progress, with no new mutation.
        await target.reload();
        await expect(target.getByText("Connecting colleague…")).toBeVisible();
        sim.transition("switching");
        await refresh(page);
        await expect(page.getByText(/Waiting for confirmed handover/)).toBeVisible();
        await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
        sim.transition(result);
        if (result === "completed") {
          sim.state.desks[1].activeCall = sim.state.desks[0].activeCall;
          sim.state.desks[1].coordination!.slot.state = "active";
          sim.state.desks[0].activeCall = null;
          sim.state.desks[0].coordination!.slot = {
            state: "free",
            callId: null,
            reservationId: null,
            generation: "1"
          };
        } else
          sim.state.desks[1].coordination!.slot = {
            state: "free",
            callId: null,
            reservationId: null,
            generation: "1"
          };
      }
      await refresh(page);
      await refresh(target);
      const text = {
        completed: "Transfer completed.",
        declined: "Transfer declined. The source conversation continues.",
        canceled: "Transfer canceled.",
        expired: "Transfer timed out. The source conversation continues.",
        failed: "Transfer failed. Review the current call before trying again."
      }[result];
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      if (result === "completed") {
        await expect(page.getByRole("button", { name: "Hang up", exact: true })).toHaveCount(0);
        await expect(target.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
        await page.clock.install();
        await page.clock.fastForward(10000);
        expect(sim.state.requests.some((r) => r.path.endsWith("/call-next"))).toBe(false);
      } else await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
      expect(sim.state.requests.some((r) => /end|hangup/.test(r.path))).toBe(false);
    });
  }
}
for (const kind of ["next", "lead", "number"] as const) {
  for (const succeeds of [true, false]) {
    test(`G03.2 paired recipient manual ${kind} ${succeeds ? "success" : "failure"} sends one request`, async ({
      page,
      context
    }) => {
      const sim = server(),
        target = await context.newPage();
      await sim.install(page, 0);
      await sim.install(target, 1);
      await sim.offer(page);
      await refresh(target);
      sim.state.failManual = !succeeds;
      const before = sim.state.requests.length;
      let release!: () => void;
      sim.state.hold = new Promise((r) => {
        release = r;
      });
      const button =
        kind === "next"
          ? target.getByRole("button", { name: "Start next call" })
          : kind === "lead"
            ? target.getByRole("table").getByRole("button", { name: "Call", exact: true })
            : target.locator("form.inline-manual-dial").getByRole("button", { name: "Call", exact: true });
      await button.click();
      await expect.poll(() => sim.state.requests.length).toBe(before + 1);
      await expect(target.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
      release();
      sim.state.hold = null;
      if (succeeds) await expect(target.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0);
      else {
        await expect(
          target.getByText("A call is already in progress. The desk has been refreshed.")
        ).toBeVisible();
        await expect(target.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
      }
      await refresh(page);
      await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
      expect(sim.state.requests).toHaveLength(before + 1);
      expect(sim.state.requests.at(-1)!.body.intent.startReason).toBe("manual");
      expect(sim.state.requests.at(-1)!.path).not.toMatch(/accept|ignore|transfers/);
      expect(sim.state.desks[0].activeCall?.id).toBe(transferSnapshot().callId);
    });
  }
}
test("G03.1 target becomes busy after list; failed request keeps source and refreshes", async ({ page }) => {
  const sim = server();
  await sim.install(page, 0);
  await page.getByRole("button", { name: "Choose colleague" }).click();
  await page.getByLabel("Transfer recipient").selectOption(targetId);
  sim.state.busyTarget = true;
  await page.getByRole("button", { name: "Request transfer" }).click();
  await expect(page.getByText("A call is already in progress. The desk has been refreshed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Choose colleague" }).click();
  await expect(page.getByRole("option", { name: "Colleague — unavailable" })).toHaveAttribute("disabled", "");
  await expect(page.getByRole("button", { name: "Request transfer" })).toBeDisabled();
});
test("G03.3 late create response cannot restore source controls after confirmed handover", async ({
  page
}) => {
  const sim = server();
  await sim.install(page, 0);
  await page.getByRole("button", { name: "Choose colleague" }).click();
  await page.getByLabel("Transfer recipient").selectOption(targetId);
  let release!: () => void;
  sim.state.hold = new Promise((r) => {
    release = r;
  });
  await page.getByRole("button", { name: "Request transfer" }).click();
  await expect.poll(() => sim.state.requests.length).toBe(1);
  const done = structuredClone(sim.state.desks[0]);
  done.activeCall = null;
  done.coordination!.transfer = transferSnapshot("completed");
  done.coordination!.slot = { state: "free", callId: null, reservationId: null, generation: "1" };
  await publish(page, done);
  release();
  await expect(page.getByText("Transfer completed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toHaveCount(0);
  await expect(page.getByText("Transfer requested. Updating desk…")).toHaveCount(0);
});
