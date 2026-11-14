// Environment-independent fixtures, shared by node:test, Vitest and Playwright.
export const checkpoints = Object.freeze([
  "before-claim",
  "before-commit",
  "before-send",
  "after-send-before-ack",
  "after-bridge-before-persistence"
]);

export function invariant(condition, message) {
  if (!condition) throw new Error(`Fixture invariant: ${message}`);
}

export function assertLedger(rows) {
  const seen = new Map();
  for (const { operation, stage } of rows) {
    invariant(["sent", "ack", "bridge"].includes(stage), "unknown ledger stage");
    const stages = seen.get(operation) ?? [];
    invariant(!stages.includes(stage), `duplicate ${stage} for ${operation}`);
    invariant(stage === "sent" || stages.includes("sent"), "effect without send");
    invariant(stage !== "bridge" || stages.includes("ack"), "bridge without ACK");
    stages.push(stage);
    seen.set(operation, stages);
  }
}

// Explicit advances replace timing sleeps. Replays may intentionally duplicate/reorder events.
export class EventTape {
  constructor(events, seed = 7) {
    invariant(Number.isSafeInteger(seed) && seed >= 0, "invalid seed");
    this.events = structuredClone(events);
    this.seed = seed;
    this.cursor = 0;
  }
  next(deliver) {
    if (this.cursor === this.events.length) return false;
    deliver(structuredClone(this.events[this.cursor++]));
    return true;
  }
  replay(indices, deliver) {
    for (const index of indices) {
      invariant(Number.isInteger(index) && index >= 0 && index < this.events.length, "event index");
      deliver(structuredClone(this.events[index]));
    }
  }
  reset() {
    this.cursor = 0;
  }
}
