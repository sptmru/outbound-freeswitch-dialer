import { describe, expect, it } from "vitest";
import { EventTape } from "../../../../tests/fixtures/inbound/controls.mjs";

describe("A07 reusable browser event fixture (simulated presence, no media)", () => {
  it("delivers controlled duplicate/out-of-order refreshes to a browser event target", () => {
    const target = new EventTarget();
    const seen: number[] = [];
    target.addEventListener("refresh", (event) => seen.push((event as CustomEvent).detail.sequence));
    const tape = new EventTape([{ sequence: 1 }, { sequence: 2 }]);
    const deliver = (detail: { sequence: number }) =>
      target.dispatchEvent(new CustomEvent("refresh", { detail }));
    tape.replay([1, 0, 1], deliver);
    expect(seen).toEqual([2, 1, 2]);
    tape.reset();
    tape.next(deliver);
    expect(seen).toEqual([2, 1, 2, 1]);
  });
});
