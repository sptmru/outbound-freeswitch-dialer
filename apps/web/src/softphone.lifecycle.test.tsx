import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "./types";

const mocks = vi.hoisted(() => ({
  fetchProvisioning: vi.fn(),
  createDesk: vi.fn(),
  updateDesk: vi.fn(),
  leaveDesk: vi.fn(),
  register: vi.fn(),
  registerers: [] as Array<{ stateListener?: (state: string) => void }>,
  start: vi.fn(),
  reconnect: vi.fn(),
  stop: vi.fn(),
  submitTelemetry: vi.fn(),
  unregister: vi.fn(),
  userAgents: [] as Array<{
    options: {
      delegate?: { onInvite?: (invitation: never) => void; onDisconnect?: (error?: Error) => void };
    };
  }>
}));

vi.mock("./api", () => ({
  fetchSoftphoneProvisioning: mocks.fetchProvisioning,
  createDeskSession: mocks.createDesk,
  updateDeskSession: mocks.updateDesk,
  leaveDeskSession: mocks.leaveDesk,
  submitBrowserMediaTelemetry: mocks.submitTelemetry
}));

vi.mock("./browser-media", () => ({
  BrowserMediaTelemetryCollector: class {},
  microphoneConstraints: { echoCancellation: true }
}));

vi.mock("sip.js", () => {
  class UserAgent {
    static makeURI() {
      return { user: "agent" };
    }

    options: {
      delegate?: { onInvite?: (invitation: never) => void; onDisconnect?: (error?: Error) => void };
    };

    constructor(options: { delegate?: { onInvite?: (invitation: never) => void } }) {
      this.options = options;
      mocks.userAgents.push(this);
    }

    start() {
      return mocks.start();
    }

    reconnect() {
      return mocks.reconnect();
    }

    stop() {
      return mocks.stop();
    }
  }

  class Registerer {
    stateChange: { addListener: (listener: (state: string) => void) => void };

    constructor() {
      const record: { stateListener?: (state: string) => void } = {};
      mocks.registerers.push(record);
      this.stateChange = {
        addListener: (listener) => {
          record.stateListener = listener;
        }
      };
    }

    register(options: unknown) {
      return mocks.register(options);
    }

    unregister() {
      return mocks.unregister();
    }
  }

  return {
    Invitation: class {},
    Registerer,
    RegistererState: { Registered: "Registered", Terminated: "Terminated", Unregistered: "Unregistered" },
    SessionState: { Established: "Established", Terminated: "Terminated" },
    UserAgent
  };
});

import { useSoftphoneRegistration } from "./softphone";

describe("softphone registration lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("outbound_dialer_audio_input_id");
    window.localStorage.removeItem("outbound_dialer_audio_output_id");
    window.localStorage.removeItem("outbound_dialer_audio_processing_profile");
    mocks.registerers.length = 0;
    mocks.userAgents.length = 0;
    mocks.start.mockResolvedValue(undefined);
    mocks.reconnect.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    mocks.register.mockResolvedValue(undefined);
    mocks.unregister.mockResolvedValue(undefined);
    mocks.fetchProvisioning.mockResolvedValue(provisioning());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves an established call on transport loss and confirms a refresh without a new Registered event", async () => {
    setGetUserMedia(async () => mediaStream());
    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    act(() => mocks.registerers[0].stateListener?.("Registered"));
    let changed: ((state: string) => void) | undefined;
    const invitation = {
      state: "Established",
      invite: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
      bye: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      remoteIdentity: { displayName: "Existing call" },
      request: { getHeader: () => undefined },
      stateChange: {
        addListener: (listener: (state: string) => void) => {
          changed = listener;
        }
      }
    };
    await act(async () => {
      mocks.userAgents[0].options.delegate?.onInvite?.(invitation as never);
    });
    act(() => changed?.("Established"));
    expect(result.current.callState).toBe("active");
    vi.useFakeTimers();
    act(() => mocks.userAgents[0].options.delegate?.onDisconnect?.(new Error("WSS lost")));
    expect(result.current.registered).toBe(false);
    expect(result.current.callState).toBe("active");
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(invitation.bye).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    const refreshed = mocks.register.mock.calls[1][0] as { requestDelegate: { onAccept: () => void } };
    act(() => refreshed.requestDelegate.onAccept());
    expect(result.current.registered).toBe(true);
    expect(result.current.callState).toBe("active");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    unmount();
    const calls = mocks.register.mock.calls.length;
    act(() => refreshed.requestDelegate.onAccept());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(mocks.register).toHaveBeenCalledTimes(calls);
    expect(invitation.bye).toHaveBeenCalledTimes(1);
  });

  it("bounds failed reconnect attempts and preserves media after exhaustion and registration failure", async () => {
    setGetUserMedia(async () => mediaStream());
    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const invitation = {
      state: "Established",
      invite: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
      bye: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      remoteIdentity: { displayName: "Existing call" },
      request: { getHeader: () => undefined },
      stateChange: { addListener: vi.fn() }
    };
    await act(async () => {
      mocks.userAgents[0].options.delegate?.onInvite?.(invitation as never);
    });
    vi.useFakeTimers();
    mocks.reconnect.mockRejectedValue(new Error("offline"));
    act(() => mocks.userAgents[0].options.delegate?.onDisconnect?.(new Error("WSS lost")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.reconnect).toHaveBeenCalledTimes(5);
    expect(result.current.error).toBe("Reconnect attempts exhausted");
    act(() => mocks.registerers[0].stateListener?.("Terminated"));
    expect(invitation.bye).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    unmount();
  });

  it("D01 native Desk uses generation credentials, verifies after REGISTER and leaves its own binding", async () => {
    setGetUserMedia(async () => mediaStream());
    const session = {
      id: "10000000-0000-4000-8000-000000000001",
      revision: "1",
      bindingGeneration: "2",
      campaignId: null,
      endpointVerified: false,
      ready: false,
      expiresAt: "2099-11-15T12:00:00Z"
    };
    mocks.createDesk.mockResolvedValue({
      revision: "1",
      session,
      sip: {
        username: "desk_fixture",
        password: "fixture-only",
        domain: "fixture.invalid",
        websocketUrl: "wss://fixture.invalid",
        iceServers: []
      }
    });
    mocks.updateDesk.mockResolvedValue({
      revision: "2",
      session: { ...session, revision: "2", endpointVerified: true, ready: true }
    });
    mocks.leaveDesk.mockResolvedValue({ revision: "3", session: null });
    const { result, unmount } = renderHook(() =>
      useSoftphoneRegistration(user, { campaignId: null, expectedRevision: null })
    );
    await waitFor(() => expect(mocks.register).toHaveBeenCalled());
    expect(mocks.fetchProvisioning).not.toHaveBeenCalled();
    expect(mocks.userAgents[0].options).toEqual(
      expect.objectContaining({ contactName: "desk_fixture", authorizationUsername: "desk_fixture" })
    );
    expect(result.current.deskSession?.ready).toBe(false);
    await act(async () => {
      mocks.registerers[0].stateListener?.("Registered");
    });
    await waitFor(() => expect(result.current.deskSession?.ready).toBe(true));
    expect(mocks.updateDesk).toHaveBeenCalledWith(
      expect.objectContaining({ deskSessionId: session.id, bindingGeneration: "2", ready: true })
    );
    unmount();
    await waitFor(() =>
      expect(mocks.leaveDesk).toHaveBeenCalledWith(
        expect.objectContaining({ deskSessionId: session.id, expectedRevision: "2", bindingGeneration: "2" })
      )
    );
  });

  it("uses the saved microphone and processing profile for registration capture", async () => {
    window.localStorage.setItem("outbound_dialer_audio_input_id", "usb-mic");
    window.localStorage.setItem("outbound_dialer_audio_processing_profile", "headset");
    setGetUserMedia(async () => mediaStream());

    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        channelCount: 1,
        deviceId: { exact: "usb-mic" },
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });
    unmount();
  });

  it("keeps a Registered event that arrives before the initial register promise resolves", async () => {
    setGetUserMedia(async () => mediaStream());
    const request = deferred<void>();
    mocks.register.mockReturnValue(request.promise);
    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalled());
    act(() => mocks.registerers[0].stateListener?.("Registered"));
    await act(async () => {
      request.resolve();
      await request.promise;
    });
    expect(result.current.registered).toBe(true);
    unmount();
  });

  it("stops microphone tracks that resolve after the desk unmounts", async () => {
    const microphone = deferred<MediaStream>();
    const stopTrack = vi.fn();
    setGetUserMedia(() => microphone.promise);

    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      microphone.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
      await microphone.promise;
    });

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(mocks.fetchProvisioning).not.toHaveBeenCalled();
  });

  it("does not construct SIP resources when provisioning resolves after cancellation", async () => {
    setGetUserMedia(async () => mediaStream());
    const provisioningRequest = deferred<ReturnType<typeof provisioning>>();
    mocks.fetchProvisioning.mockReturnValue(provisioningRequest.promise);

    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.fetchProvisioning).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      provisioningRequest.resolve(provisioning());
      await provisioningRequest.promise;
    });

    expect(mocks.userAgents).toHaveLength(0);
    expect(mocks.registerers).toHaveLength(0);
  });

  it("disposes SIP resources instead of registering when start resolves after cancellation", async () => {
    setGetUserMedia(async () => mediaStream());
    const startRequest = deferred<void>();
    mocks.start.mockReturnValue(startRequest.promise);

    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      startRequest.resolve();
      await startRequest.promise;
    });

    expect(mocks.unregister).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("rejects late invitations and cleans up when REGISTER resolves after cancellation", async () => {
    setGetUserMedia(async () => mediaStream());
    const registerRequest = deferred<void>();
    mocks.register.mockReturnValue(registerRequest.promise);

    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const onInvite = mocks.userAgents[0]?.options.delegate?.onInvite;
    unmount();

    const reject = vi.fn().mockResolvedValue(undefined);
    onInvite?.({ reject } as never);
    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));

    await act(async () => {
      registerRequest.resolve();
      await registerRequest.promise;
    });

    expect(mocks.unregister).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalled();
  });

  it("closes the registerer and transport when REGISTER is rejected", async () => {
    setGetUserMedia(async () => mediaStream());
    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const options = mocks.register.mock.calls[0]?.[0] as {
      requestDelegate?: {
        onReject?: (response: { message: { reasonPhrase: string; statusCode: number } }) => void;
      };
    };

    act(() => {
      options.requestDelegate?.onReject?.({ message: { reasonPhrase: "Forbidden", statusCode: 403 } });
    });

    await waitFor(() => expect(result.current.state).toBe("failed"));
    await waitFor(() => expect(mocks.unregister).toHaveBeenCalledTimes(1));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("terminates an invitation whose accept resolves after leaving the desk", async () => {
    setGetUserMedia(async () => mediaStream());
    const acceptRequest = deferred<void>();
    const { unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const onInvite = mocks.userAgents[0]?.options.delegate?.onInvite;
    const reject = vi.fn().mockResolvedValue(undefined);
    const invitation = {
      accept: vi.fn().mockReturnValue(acceptRequest.promise),
      bye: vi.fn().mockResolvedValue(undefined),
      reject,
      remoteIdentity: { displayName: "Outbound call" },
      request: { getHeader: () => undefined },
      state: "Initial",
      stateChange: { addListener: vi.fn() }
    };
    onInvite?.(invitation as never);
    await waitFor(() => expect(invitation.accept).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      acceptRequest.resolve();
      await acceptRequest.promise;
    });

    expect(reject.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.stop).toHaveBeenCalled();
  });

  it("reports unavailable audio when SIP.js exposes no peer connection", async () => {
    setGetUserMedia(async () => mediaStream());
    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const onInvite = mocks.userAgents[0]?.options.delegate?.onInvite;
    let sessionListener: ((state: string) => void) | undefined;
    const invitation = {
      accept: vi.fn().mockResolvedValue(undefined),
      bye: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      remoteIdentity: { displayName: "Outbound call" },
      request: { getHeader: () => undefined },
      sessionDescriptionHandler: {},
      state: "Established",
      stateChange: {
        addListener: (listener: (state: string) => void) => {
          sessionListener = listener;
        }
      }
    };
    onInvite?.(invitation as never);
    await waitFor(() => expect(invitation.accept).toHaveBeenCalledTimes(1));
    act(() => sessionListener?.("Established"));

    await waitFor(() => expect(result.current.audioPlaybackState).toBe("unavailable"));
    expect(result.current.error).toMatch(/remote audio connection/);
    unmount();
  });

  it("reports blocked remote audio and retries playback after a user gesture", async () => {
    setGetUserMedia(async () => mediaStream());
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new Error("Autoplay blocked"))
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "MediaStream",
      class {
        addTrack() {}
      }
    );

    const { result, unmount } = renderHook(() => useSoftphoneRegistration(user));
    await waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    const onInvite = mocks.userAgents[0]?.options.delegate?.onInvite;
    let sessionListener: ((state: string) => void) | undefined;
    const invitation = {
      accept: vi.fn().mockResolvedValue(undefined),
      bye: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      remoteIdentity: { displayName: "Outbound call" },
      request: { getHeader: () => undefined },
      sessionDescriptionHandler: { peerConnection: { getReceivers: () => [] } },
      stateChange: {
        addListener: (listener: (state: string) => void) => {
          sessionListener = listener;
        }
      }
    };
    onInvite?.(invitation as never);
    await waitFor(() => expect(invitation.accept).toHaveBeenCalledTimes(1));

    act(() => sessionListener?.("Established"));
    await waitFor(() => expect(result.current.audioPlaybackState).toBe("blocked"));

    await act(async () => {
      await result.current.retryRemoteAudio();
    });
    expect(play).toHaveBeenCalledTimes(2);
    expect(result.current.audioPlaybackState).toBe("playing");
    unmount();
    play.mockRestore();
  });
});

const user: PublicUser = {
  id: "99999999-9999-4999-8999-999999999999",
  email: "agent@example.com",
  name: "Agent Example",
  role: "agent",
  isActive: true
};

function provisioning() {
  return {
    sipUri: "sip:agent_1000@dialer.local",
    sipUsername: "agent_1000",
    sipPassword: "not-a-real-secret",
    displayName: "Agent Example",
    websocketUrl: "wss://dialer.example.test/freeswitch-ws",
    domain: "dialer.local",
    iceServers: []
  };
}

function mediaStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function setGetUserMedia(implementation: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(implementation) }
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
