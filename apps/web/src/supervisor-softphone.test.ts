import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "./types";

const mocks = vi.hoisted(() => ({
  fetchProvisioning: vi.fn(),
  register: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  unregister: vi.fn(),
  userAgents: [] as Array<{ options: { delegate?: { onInvite?: (invitation: never) => void } } }>
}));

vi.mock("./api", () => ({ fetchSupervisorProvisioning: mocks.fetchProvisioning }));

vi.mock("sip.js", () => {
  class UserAgent {
    static makeURI() {
      return { user: "supervisor" };
    }

    options: { delegate?: { onInvite?: (invitation: never) => void } };

    constructor(options: { delegate?: { onInvite?: (invitation: never) => void } }) {
      this.options = options;
      mocks.userAgents.push(this);
    }

    start() {
      return mocks.start();
    }

    stop() {
      return mocks.stop();
    }
  }

  class Registerer {
    stateChange = { addListener: vi.fn() };

    register() {
      return mocks.register();
    }

    unregister() {
      return mocks.unregister();
    }
  }

  return {
    Invitation: class {},
    Registerer,
    RegistererState: { Registered: "Registered", Terminated: "Terminated" },
    SessionState: { Established: "Established", Terminated: "Terminated" },
    UserAgent
  };
});

import { __testing, useSupervisorSoftphone } from "./supervisor-softphone";

const user: PublicUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.test",
  name: "Admin",
  role: "admin",
  isActive: true
};

describe("supervisor softphone safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userAgents.length = 0;
    mocks.fetchProvisioning.mockResolvedValue({
      sipUri: "sip:supervisor_test@dialer.local",
      sipUsername: "supervisor_test",
      sipPassword: "secret",
      displayName: "Admin (supervisor)",
      websocketUrl: "wss://dialer.local/freeswitch-ws",
      domain: "dialer.local",
      iceServers: []
    });
    mocks.register.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    mocks.unregister.mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  it("accepts only explicit supervisor modes", () => {
    expect(__testing.parseSupervisorMode("listen")).toBe("listen");
    expect(__testing.parseSupervisorMode("whisper")).toBe("whisper");
    expect(__testing.parseSupervisorMode("join")).toBe("join");
    expect(__testing.parseSupervisorMode("")).toBeNull();
    expect(__testing.parseSupervisorMode("3")).toBeNull();
  });

  it("answers listen-only invitations without microphone capture constraints", async () => {
    const { unmount } = renderHook(() => useSupervisorSoftphone(user));
    await waitFor(() => expect(mocks.userAgents).toHaveLength(1));
    const invitation = createInvitation("listen");

    mocks.userAgents[0]?.options.delegate?.onInvite?.(invitation as never);

    await waitFor(() => expect(invitation.accept).toHaveBeenCalledTimes(1));
    expect(invitation.accept).toHaveBeenCalledWith({
      sessionDescriptionHandlerOptions: { constraints: { audio: false, video: false } }
    });
    unmount();
  });

  it("uses the saved microphone profile only when a speaking mode requests capture", async () => {
    window.localStorage.setItem("outbound_dialer_audio_processing_profile", "headset");
    window.localStorage.setItem("outbound_dialer_audio_input_id", "usb-mic");
    const { unmount } = renderHook(() => useSupervisorSoftphone(user));
    await waitFor(() => expect(mocks.userAgents).toHaveLength(1));
    const invitation = createInvitation("whisper");

    mocks.userAgents[0]?.options.delegate?.onInvite?.(invitation as never);

    await waitFor(() => expect(invitation.accept).toHaveBeenCalledTimes(1));
    expect(invitation.accept.mock.calls[0]?.[0]).toMatchObject({
      sessionDescriptionHandlerOptions: {
        constraints: {
          audio: {
            autoGainControl: false,
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            deviceId: { exact: "usb-mic" }
          },
          video: false
        }
      }
    });
    unmount();
  });
});

function createInvitation(mode: "listen" | "whisper" | "join") {
  return {
    accept: vi.fn().mockResolvedValue(undefined),
    bye: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
    request: {
      getHeader: (name: string) =>
        name === "X-Outbound-Dialer-Supervisor-Session-ID"
          ? "99999999-9999-4999-8999-999999999999"
          : name === "X-Outbound-Dialer-Supervisor-Mode"
            ? mode
            : undefined
    },
    state: "Initial",
    stateChange: { addListener: vi.fn() }
  };
}
