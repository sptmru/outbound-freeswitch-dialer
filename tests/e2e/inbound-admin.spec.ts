import { expect, test, type Page } from "@playwright/test";

// Stateful HTTP fixtures: browser behavior only, not product DB/FS/provider evidence.
async function fixture(page: Page, role = "admin") {
  const data: Record<string, any[]> = { numbers: [], queues: [], flows: [] };
  const requests: any[] = [];
  const state = { fail: "", application: "pending", uploadFail: false, previewFail: false };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.includes("/recordings")) {
      if (path.includes("audio-ticket")) {
        await route.fulfill(
          state.previewFail
            ? { status: 403, json: { message: "Preview denied" } }
            : { json: { url: "/fixture-audio.wav" } }
        );
        return;
      }
      if (request.method() === "POST") {
        requests.push({ upload: request.postData() });
        await route.fulfill(
          state.uploadFail
            ? { status: 400, json: { message: "Unsupported audio" } }
            : { json: { id: "audio" } }
        );
        return;
      }
      await route.fulfill({
        json: {
          items: [
            { id: "audio", campaignId: "campaign", name: "Greeting", status: "ready", durationSeconds: 5 }
          ],
          page: 1,
          totalPages: 1
        }
      });
      return;
    }
    const match = path.match(/inbound-(numbers|queues|flows)(?:\/(.+))?$/)!;
    if (!match) {
      await route.fulfill({ status: 404 });
      return;
    }
    const [, kind, id] = match;
    if (request.method() === "GET") {
      await route.fulfill({ json: { items: data[kind] } });
      return;
    }
    const body = request.postDataJSON();
    requests.push({ kind, id, method: request.method(), body });
    if (state.fail) {
      await route.fulfill({ status: 409, json: { code: state.fail, message: state.fail } });
      return;
    }
    if (request.method() === "DELETE") {
      data[kind] = data[kind].filter((v) => v.id !== id);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    const previous = data[kind].find((v) => v.id === id);
    const revision = String(Number(previous?.revision ?? 0) + 1);
    const item = {
      ...body,
      id: id ?? `${kind}-${data[kind].length}`,
      revision,
      versionId: `version-${revision}`,
      apply: {
        desiredRevision: revision,
        appliedRevision: state.application === "applied" ? revision : null,
        status: state.application,
        error: state.application === "error" ? "reload failed; last-good retained" : null
      }
    };
    data[kind] = [...data[kind].filter((v) => v.id !== id), item];
    await route.fulfill({ json: item });
  });
  await page.goto(`/tests/fixtures/f05/index.html${role === "agent" ? "?agent" : ""}`);
  if (role === "admin") await expect(page.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  return { data, requests, state };
}
async function queue(page: Page) {
  await page.getByRole("button", { name: "Queues", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared queue");
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption("campaign");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: "Shared queue", exact: true })).toBeVisible();
}
async function number(page: Page, name = "Main", did = "+14155550100") {
  await page.getByRole("button", { name: "Numbers", exact: true }).click();
  await page.getByLabel("Number label").fill(name);
  await page.getByLabel("International DID").fill(did);
  await page.getByLabel("Shared queue").selectOption("queues-0");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("button", { name: `${name} · ${did}` })).toBeVisible();
}
test("F05.1 CRUD: two DIDs share a saved queue and survive page reload", async ({ page }) => {
  const f = await fixture(page);
  await queue(page);
  await number(page);
  await number(page, "Second", "+14155550101");
  expect(f.data.numbers.map((v) => v.queueId)).toEqual(["queues-0", "queues-0"]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Second · +14155550101" })).toBeVisible();
  await page.getByRole("button", { name: "Second · +14155550101" }).click();
  await page.getByLabel("Number label").fill("Updated");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("button", { name: "Updated · +14155550101" }).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await expect(page.getByRole("button", { name: "Updated · +14155550101" })).toHaveCount(0);
  expect(f.requests.at(-1).body.expectedRevision).toBe("2");
});
test("F05.1 agent component cannot load configuration or mutate", async ({ page }) => {
  const f = await fixture(page, "agent");
  await expect(page.getByText("Admin access required")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  expect(f.requests).toHaveLength(0);
});
for (const mode of ["audio", "forward", "combined"])
  test(`F05.2 ${mode} flow edits, preview and immutable version assignment`, async ({ page }) => {
    const f = await fixture(page);
    await page.getByRole("button", { name: "Flows", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(mode);
    await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption("campaign");
    await page
      .getByLabel("Step 1 action")
      .selectOption(mode === "forward" ? "forward_external" : "play_audio");
    if (mode === "forward") await page.getByLabel("Step 1 international target").fill("+1 (415) 555-0199");
    else await page.getByLabel("Step 1 audio", { exact: true }).selectOption("audio");
    if (mode === "combined") {
      await page.getByRole("button", { name: "Add step" }).click();
      await page.getByLabel("Step 2 action").selectOption("forward_external");
      await page.getByLabel("Step 2 international target").fill("+14155550199");
    }
    await expect(page.getByText(/^Flow preview:/)).toBeVisible();
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByText("Editing revision 1")).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(`${mode} v2`);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.getByRole("button", { name: `${mode} v2` })).toBeVisible();
    expect(f.data.flows[0].revision).toBe("2");
    await queue(page);
    await page.getByRole("button", { name: "Shared queue", exact: true }).click();
    await page.getByLabel("No-answer flow").selectOption("version-2");
    await page.getByLabel("Overflow policy").selectOption("flow");
    await page.getByLabel("Overflow flow").selectOption("version-2");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect.poll(() => f.data.queues[0].noAnswerFlowVersionId).toBe("version-2");
  });
test("F05.2 invalid continuation, missing audio, time budget and keyboard controls", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Invalid");
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption("campaign");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("Hangup must be the last step");
  await page.getByLabel("Step 1 action").selectOption("play_audio");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(f.requests).toHaveLength(0);
  await page.getByLabel("Step 1 audio", { exact: true }).selectOption("audio");
  await page.getByLabel("Total flow timeout (ms)").fill("1000");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("Step timeouts exceed");
  await page.getByRole("button", { name: "Remove step 2" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Step 2 action")).toHaveCount(0);
});
test("F05.2 upload failure and preview authorization failure are visible; outbound assignment is false", async ({
  page
}) => {
  const f = await fixture(page);
  f.state.uploadFail = true;
  await page.getByRole("button", { name: "Upload inbound audio" }).click();
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption("campaign");
  await page
    .getByLabel("Audio file")
    .setInputFiles({ name: "greeting.wav", mimeType: "audio/wav", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Upload audio", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unsupported audio");
  expect(f.requests[0].upload).toContain('name="useForCampaign"\r\n\r\nfalse');
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await queue(page);
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  await page.getByLabel("Waiting audio").selectOption("audio");
  f.state.previewFail = true;
  await page.getByRole("button", { name: "Preview audio" }).click();
  await expect(page.getByRole("alert")).toContainText("Preview denied");
});
for (const application of ["pending", "applied", "error"])
  test(`F05.3 ${application} application and disabled route are distinct from saved state`, async ({
    page
  }) => {
    const f = await fixture(page);
    f.state.application = application;
    await queue(page);
    await number(page);
    await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        application === "pending"
          ? /Pending application ·/
          : application === "applied"
            ? /Applied to FreeSWITCH ·/
            : /Application failed ·/
      )
    ).toBeVisible();
    await expect(page.getByText(/Provider delivery is not verified here/)).toBeVisible();
    if (application === "error") {
      f.data.numbers[0].apply = {
        desiredRevision: "1",
        appliedRevision: "1",
        status: "applied",
        error: null
      };
      await page.getByRole("button", { name: "Reload saved configuration" }).click();
      await expect(page.getByText(/Applied to FreeSWITCH ·/)).toBeVisible();
    }
  });
test("F05.3 conflict retains draft and retry identity; explicit reload recovers", async ({ page }) => {
  const f = await fixture(page);
  await queue(page);
  await number(page);
  await page.getByRole("button", { name: "Main · +14155550100" }).click();
  await page.getByLabel("Number label").fill("Draft");
  f.state.fail = "revision_conflict";
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is preserved");
  await expect(page.getByLabel("Number label")).toHaveValue("Draft");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.poll(() => f.requests.length).toBe(4);
  expect(f.requests[2].body.idempotencyKey).toBe(f.requests[3].body.idempotencyKey);
  f.state.fail = "";
  await page.getByRole("button", { name: "Reload saved configuration" }).click();
  await page.getByRole("button", { name: "Main · +14155550100" }).click();
  await expect(page.getByLabel("Number label")).toHaveValue("Main");
});
test("F05.4 lower queue limit and explicit bounded overflow feedback", async ({ page }) => {
  const f = await fixture(page);
  await queue(page);
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  await page.getByLabel("Maximum waiting calls").fill("1");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.poll(() => f.data.queues[0].configuration.maxWaitingCalls).toBe(1);
  await expect(page.getByText(/Lower limits preserve admitted calls/)).toContainText("capacity_exceeded");
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  await page.getByLabel("Overflow policy").selectOption("flow");
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(f.data.queues[0].configuration.overflowPolicy).toBe("reject");
  await expect(page.getByLabel("Overflow flow")).toBeVisible();
});

test("F05.2 server validation identifies invalid international number and missing asset without losing edits", async ({
  page
}) => {
  const f = await fixture(page);
  await queue(page);
  await page.getByRole("button", { name: "Numbers", exact: true }).click();
  await page.getByLabel("Number label").fill("Invalid number");
  await page.getByLabel("International DID").fill("sip:bad@example.test");
  await page.getByLabel("Shared queue").selectOption("queues-0");
  await page.route("**/api/admin/inbound-numbers", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          json: { message: "Validation failed", issues: [{ message: "Invalid international DID" }] }
        })
      : route.fallback()
  );
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid international DID");
  await expect(page.getByLabel("International DID")).toHaveValue("sip:bad@example.test");
  await page.getByRole("button", { name: "Queues", exact: true }).click();
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  await page.getByLabel("Waiting audio").selectOption("audio");
  f.state.fail = "audio_unavailable";
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("selected audio is missing");
  await page.getByLabel("Maximum waiting calls").fill("201");
  const before = f.requests.length;
  await page.getByRole("button", { name: "Save configuration" }).click();
  expect(f.requests).toHaveLength(before);
});

test("F05.2 authorized local WAV preview decodes; failed media fetch is visible", async ({ page }) => {
  await fixture(page);
  await queue(page);
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  await page.getByLabel("Waiting audio").selectOption("audio");
  const wav = Buffer.alloc(44 + 16000);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
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
  for (let i = 0; i < 8000; i++)
    wav.writeInt16LE(Math.round(6000 * Math.sin((i * 2 * Math.PI * 440) / 8000)), 44 + i * 2);
  await page.route("**/api/fixture-audio.wav", (route) =>
    route.fulfill({ contentType: "audio/wav", body: wav })
  );
  await page.getByRole("button", { name: "Preview audio" }).click();
  const audio = page.locator("audio");
  await expect.poll(() => audio.evaluate((v: HTMLAudioElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  expect(await audio.evaluate((v: HTMLAudioElement) => v.duration)).toBe(1);
  await page.screenshot({ path: "/tmp/f05-queue-preview.png", fullPage: true });
  await page.route("**/api/fixture-audio.wav", (route) => route.fulfill({ status: 404 }));
  await page.getByRole("button", { name: "Preview audio" }).click();
  await expect(page.getByRole("alert")).toContainText("Audio preview failed");
});

test("F05.1/F05.3 enabled number requires disable/save before deletion; queue and flow deletion", async ({
  page
}) => {
  const f = await fixture(page);
  await queue(page);
  await number(page);
  await page.getByRole("button", { name: "Main · +14155550100" }).click();
  await page.getByLabel("Enabled in configuration").check();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("button", { name: "Main · +14155550100" }).click();
  await expect(page.getByRole("button", { name: "Delete configuration" })).toBeDisabled();
  await page.getByLabel("Enabled in configuration").uncheck();
  await expect(page.getByRole("button", { name: "Delete configuration" })).toBeDisabled();
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("button", { name: "Main · +14155550100" }).click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await expect.poll(() => f.data.numbers.length).toBe(0);
  await page.getByRole("button", { name: "Queues", exact: true }).click();
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  f.state.fail = "configuration_in_use";
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("still referenced");
  f.state.fail = "";
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await expect.poll(() => f.data.queues.length).toBe(0);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Unused flow");
  await page.getByRole("combobox", { name: "Campaign", exact: true }).selectOption("campaign");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByRole("button", { name: "Unused flow", exact: true }).click();
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await expect.poll(() => f.data.flows.length).toBe(0);
});

test("F05 browser layout remains usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await queue(page);
  await page.getByRole("button", { name: "Shared queue", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Save configuration" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Save configuration" })).toBeInViewport();
});
