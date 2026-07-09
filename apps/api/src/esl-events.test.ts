import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "./esl-events.js";

describe("FreeSWITCH event helpers", () => {
  it("extracts complete ESL frames and leaves partial frames buffered", () => {
    const input =
      "Content-Type: text/event-plain\nContent-Length: 4\n\nbody" +
      "Content-Type: text/event-plain\nContent-Length: 5\n\npa";

    const result = __testing.extractFrames(input);

    assert.deepEqual(result.frames, [
      {
        body: "body",
        headers: {
          "content-length": "4",
          "content-type": "text/event-plain"
        }
      }
    ]);
    assert.equal(result.rest, "Content-Type: text/event-plain\nContent-Length: 5\n\npa");
  });

  it("maps terminal events including CHANNEL_DESTROY to terminal call states", () => {
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP", "NORMAL_CLEARING"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP_COMPLETE", "USER_BUSY"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_DESTROY"), "failed");
    assert.equal(__testing.mapEventToLegState("CHANNEL_DESTROY"), "ended");
  });

  it("maps agent and customer answer events to the correct call states", () => {
    assert.equal(__testing.mapEventToCallState("CHANNEL_ANSWER", undefined, "agent"), "agent_answered");
    assert.equal(__testing.mapEventToCallState("CHANNEL_ANSWER", undefined, "customer"), "bridged");
    assert.equal(__testing.mapEventToCallState("CHANNEL_BRIDGE"), "bridged");
  });

  it("ignores AMD human results and detects machine results", () => {
    assert.equal(
      __testing.mapVoicemailDetectionSignal({
        body: "",
        headers: {
          "amd-result": "HUMAN",
          "event-subclass": "amd::result"
        }
      }),
      null
    );

    assert.deepEqual(
      __testing.mapVoicemailDetectionSignal({
        body: "",
        headers: {
          "amd-confidence": "75",
          "amd-result": "MACHINE",
          "event-subclass": "amd::result"
        }
      }),
      {
        confidence: 75,
        eventType: "voicemail_machine_detected",
        signalType: "machine",
        status: "detected"
      }
    );
  });
});
