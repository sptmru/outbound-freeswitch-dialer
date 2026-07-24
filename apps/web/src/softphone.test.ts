import { describe, expect, it, vi } from "vitest";
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
      __testing.toCallIdleRuntime(
        runtime({ callState: "active", registered: true }),
        "agent_1000@dialer.local"
      )
    ).toMatchObject({
      callState: "none",
      detail: "agent_1000@dialer.local",
      incomingCallLabel: null,
      label: "Softphone registered",
      registered: true
    });
  });

  it("sends SIP unregister before stopping the user-agent transport", async () => {
    const actions: string[] = [];
    await __testing.stopSoftphoneRegistration(
      {
        unregister: async () => {
          actions.push("unregister-started");
          await Promise.resolve();
          actions.push("unregister-finished");
        }
      },
      {
        stop: async () => {
          actions.push("transport-stopped");
        }
      }
    );

    expect(actions).toEqual(["unregister-started", "unregister-finished", "transport-stopped"]);
  });

  it("routes call audio to the selected speaker when the browser supports it", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    await __testing.applyAudioOutput({ setSinkId } as unknown as HTMLAudioElement, "speaker-2");
    expect(setSinkId).toHaveBeenCalledWith("speaker-2");
  });

  it("stops browser ringback when remote media is already flowing", () => {
    const stopBrowserRingback = vi.fn();
    __testing.stopBrowserRingbackOnRemoteAudio({ muted: false } as MediaStreamTrack, stopBrowserRingback);
    expect(stopBrowserRingback).toHaveBeenCalledTimes(1);
  });

  it("waits for the first remote-media unmute before stopping browser ringback", () => {
    const stopBrowserRingback = vi.fn();
    let onUnmute: (() => void) | undefined;
    const track = {
      muted: true,
      addEventListener: vi.fn(
        (event: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
          expect(event).toBe("unmute");
          expect(options).toEqual({ once: true });
          onUnmute =
            typeof listener === "function"
              ? () => listener(new Event("unmute"))
              : () => listener.handleEvent(new Event("unmute"));
        }
      )
    } as unknown as MediaStreamTrack;

    __testing.stopBrowserRingbackOnRemoteAudio(track, stopBrowserRingback);
    expect(stopBrowserRingback).not.toHaveBeenCalled();
    onUnmute?.();
    expect(stopBrowserRingback).toHaveBeenCalledTimes(1);
  });
});

function runtime(overrides: Partial<SoftphoneRuntime> = {}): SoftphoneRuntime {
  return {
    answerIncomingCall: async () => undefined,
    audioSetup: {
      appliedSettings: null,
      checkError: null,
      checkResult: null,
      checking: false,
      inputDevices: [],
      inputLevel: 0,
      outputDevices: [],
      outputSelectionSupported: true,
      processingProfile: "office",
      selectedInputId: "",
      selectedOutputId: "",
      signalStatus: "idle"
    },
    audioPlaybackState: "idle",
    callState: "none",
    declineIncomingCall: async () => undefined,
    detail: "Ready for calls",
    error: null,
    hangUpSoftphoneCall: async () => undefined,
    incomingCallLabel: null,
    label: "Softphone registered",
    microphoneAllowed: true,
    refreshAudioDevices: async () => undefined,
    registered: true,
    retryRemoteAudio: async () => undefined,
    runAudioCheck: async () => undefined,
    selectMicrophone: () => undefined,
    selectSpeaker: async () => undefined,
    setMicrophoneProcessingProfile: () => undefined,
    startBrowserRingback: () => undefined,
    state: "registered",
    stopBrowserRingback: () => undefined,
    ...overrides
  };
}
