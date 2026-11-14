import { expect, test } from "./fixtures";
import { EventTape } from "../fixtures/inbound/controls.mjs";

test("A07 event replay crosses browser context with simulated presence and no SIP/media", async ({
  page
}) => {
  // Harness self-check only. No product route, API or real media claim.
  await page.goto("/");
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as typeof window & { fixtureSeen: number[] }).fixtureSeen = seen;
    window.addEventListener("fixture-refresh", (event) => seen.push((event as CustomEvent).detail.sequence));
  });
  const tape = new EventTape([{ sequence: 1 }, { sequence: 2 }]);
  const replay: Array<{ sequence: number }> = [];
  tape.replay([1, 0, 1], (event) => replay.push(event));
  for (const detail of replay)
    await page.evaluate((data) => {
      window.dispatchEvent(new CustomEvent("fixture-refresh", { detail: data }));
    }, detail);
  expect(
    await page.evaluate(() => (window as typeof window & { fixtureSeen: number[] }).fixtureSeen)
  ).toEqual([2, 1, 2]);
});
