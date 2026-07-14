import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PcapOperationCoordinator } from "./pcap-operation-coordinator.js";

describe("PCAP supervisor operation coordination", () => {
  it("coalesces concurrent starts for one call", async () => {
    const coordinator = new PcapOperationCoordinator();
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = async () => {
      starts += 1;
      await gate;
      return { running: true };
    };

    const first = coordinator.run("call-1", "start", start);
    const second = coordinator.run("call-1", "start", start);
    release();

    assert.deepEqual(await Promise.all([first, second]), [{ running: true }, { running: true }]);
    assert.equal(starts, 1);
  });

  it("runs stop only after an in-flight start completes", async () => {
    const coordinator = new PcapOperationCoordinator();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const start = coordinator.run("call-1", "start", async () => {
      order.push("start-begin");
      await gate;
      order.push("start-end");
    });
    const stop = coordinator.run("call-1", "stop", async () => {
      order.push("stop");
    });
    release();
    await Promise.all([start, stop]);

    assert.deepEqual(order, ["start-begin", "start-end", "stop"]);
  });
});
