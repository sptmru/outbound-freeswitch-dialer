import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "./metrics.js";

describe("monitoring metric helpers", () => {
  it("normalizes ESL event names into bounded Prometheus label values", () => {
    assert.equal(__testing.normalizeEventName("CHANNEL_HANGUP_COMPLETE"), "CHANNEL_HANGUP_COMPLETE");
    assert.equal(__testing.normalizeEventName("custom::event"), "CUSTOM__EVENT");
    assert.equal(__testing.normalizeEventName(undefined), "UNKNOWN");
  });

  it("converts PostgreSQL counts without emitting NaN", () => {
    assert.equal(__testing.toNumber("12"), 12);
    assert.equal(__testing.toNumber(undefined), 0);
    assert.equal(__testing.toNumber("invalid"), 0);
  });
});
