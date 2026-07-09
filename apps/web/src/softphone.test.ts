import { describe, expect, it } from "vitest";
import type { SoftphoneRuntime } from "./softphone";
import { __testing } from "./softphone";

describe("softphone runtime helpers", () => {
  it("formats rejected REGISTER responses with SIP status details", () => {
    expect(__testing.formatRegisterRejectError(403, "Forbidden")).toBe("REGISTER rejected 403 Forbidden");
    expect(__testing.formatRegisterRejectError()).toBe("REGISTER rejected");
  });

  it("builds a terminal registration failure state without leaving a call active", () => {
    expect(
      __testing.toRegistrationFailureRuntime(
        runtime({ callState: "active", registered: true }),
        "SIP registration rejected",
        "REGISTER rejected 403 Forbidden"
      )
    ).toMatchObject({
      callState: "none",
      detail: "SIP registration rejected",
      error: "REGISTER rejected 403 Forbidden",
      incomingCallLabel: null,
      label: "Softphone offline",
      registered: false,
      state: "failed"
    });
  });

  it("keeps registered identity details when a softphone call ends", () => {
    expect(
      __testing.toCallIdleRuntime(runtime({ callState: "active", registered: true }), "agent_1000@dialer.local")
    ).toMatchObject({
      callState: "none",
      detail: "agent_1000@dialer.local",
      incomingCallLabel: null,
      label: "Softphone registered",
      registered: true
    });
  });
});

function runtime(overrides: Partial<SoftphoneRuntime> = {}): SoftphoneRuntime {
  return {
    answerIncomingCall: async () => undefined,
    callState: "none",
    declineIncomingCall: async () => undefined,
    detail: "Ready for calls",
    error: null,
    hangUpSoftphoneCall: async () => undefined,
    incomingCallLabel: null,
    label: "Softphone registered",
    microphoneAllowed: true,
    registered: true,
    state: "registered",
    ...overrides
  };
}
