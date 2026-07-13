import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CoalescedTask } from "./coalesced-task.js";

describe("CoalescedTask", () => {
  it("runs at most one task concurrently and coalesces repeated requests", async () => {
    let releaseFirst!: () => void;
    const firstRunBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const errors: unknown[] = [];
    const task = new CoalescedTask(
      async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (runs === 1) {
          await firstRunBlocked;
        }
        active -= 1;
      },
      (error) => errors.push(error)
    );

    task.request();
    task.request();
    task.request();
    releaseFirst();
    await task.waitForIdle();

    assert.equal(runs, 2);
    assert.equal(maxActive, 1);
    assert.deepEqual(errors, []);
  });
});
