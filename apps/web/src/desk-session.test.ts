import { describe, it, expect, vi } from "vitest";
import { DeskSessionController } from "./desk-session";
import type { DeskSessionResponse, DeskSessionSnapshot } from "./types";
const s: DeskSessionSnapshot = {
  id: "10000000-0000-4000-8000-000000000001",
  revision: "1",
  bindingGeneration: "1",
  campaignId: null,
  endpointVerified: false,
  ready: false,
  expiresAt: "2099-11-15T12:00:00Z"
};
const created: DeskSessionResponse = {
  revision: "1",
  session: s,
  sip: {
    username: "desk_fixture",
    password: "fixture-only",
    domain: "fixture.invalid",
    websocketUrl: "wss://fixture.invalid",
    iceServers: []
  }
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
describe("D01 browser Desk lifecycle (HTTP/SIP registration simulated)", () => {
  it("enters unready, serializes campaign/registration heartbeats and leaves only its generation", async () => {
    const changed = vi.fn();
    const api = {
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockImplementation(async (input) => ({
        revision: "2",
        session: {
          ...s,
          revision: "2",
          campaignId: input.campaignId,
          ready: input.ready,
          endpointVerified: input.ready
        }
      })),
      leave: vi.fn().mockResolvedValue({ revision: "3", session: null })
    };
    const controller = new DeskSessionController({ campaignId: null, expectedRevision: null }, changed, api);
    expect((await controller.start()).sipUsername).toBe("desk_fixture");
    expect(changed).toHaveBeenLastCalledWith(s);
    controller.setRegistered(true);
    controller.selectCampaign("campaign");
    await controller.heartbeat();
    expect(api.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deskSessionId: s.id,
        bindingGeneration: "1",
        expectedRevision: "1",
        campaignId: "campaign",
        ready: true
      })
    );
    await controller.close();
    await controller.heartbeat();
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.leave).toHaveBeenCalledWith(
      expect.objectContaining({ deskSessionId: s.id, expectedRevision: "2", bindingGeneration: "1" })
    );
    expect(changed).toHaveBeenLastCalledWith(null);
  });
  it("HTTP loss retries identical payload/key, displays unready, and never releases media", async () => {
    const changed = vi.fn();
    const api = {
      create: vi.fn().mockResolvedValue(created),
      update: vi
        .fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValue({
          revision: "2",
          session: { ...s, revision: "2", ready: true, endpointVerified: true }
        }),
      leave: vi.fn().mockResolvedValue({ revision: "3", session: null })
    };
    const controller = new DeskSessionController({ campaignId: null, expectedRevision: null }, changed, api);
    await controller.start();
    controller.setRegistered(true);
    await expect(controller.heartbeat()).rejects.toThrow("response lost");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    controller.selectCampaign("new campaign");
    await controller.heartbeat();
    expect(api.update.mock.calls[0]).toEqual(api.update.mock.calls[1]);
    await controller.heartbeat();
    expect(api.update.mock.calls[2][0].campaignId).toBe("new campaign");
    await controller.close();
  });
  it("reconciler revision rejection adopts only its own authenticated generation and retries with a new key", async () => {
    const changed = vi.fn();
    const conflict = Object.assign(new Error("revision_conflict"), {
      body: { code: "revision_conflict", session: { ...s, revision: "3" } }
    });
    const api = {
      create: vi.fn().mockResolvedValue(created),
      update: vi
        .fn()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValue({
          revision: "4",
          session: { ...s, revision: "4", ready: true, endpointVerified: true }
        }),
      leave: vi.fn().mockResolvedValue({ revision: "5", session: null })
    };
    const controller = new DeskSessionController({ campaignId: null, expectedRevision: null }, changed, api);
    await controller.start();
    controller.setRegistered(true);
    await expect(controller.heartbeat()).rejects.toThrow("revision_conflict");
    await controller.heartbeat();
    expect(api.update.mock.calls[1][0].expectedRevision).toBe("3");
    expect(api.update.mock.calls[1][0].idempotencyKey).not.toBe(api.update.mock.calls[0][0].idempotencyKey);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
    await controller.close();
  });
  it("late failed heartbeat after close cannot publish into a replacement Desk", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<DeskSessionResponse>((_resolve, rejectRequest) => (reject = rejectRequest));
    const changed = vi.fn();
    const api = {
      create: vi.fn().mockResolvedValue(created),
      update: vi.fn().mockReturnValueOnce(gate).mockResolvedValue({ revision: "2", session: s }),
      leave: vi.fn().mockResolvedValue({ revision: "3", session: null })
    };
    const controller = new DeskSessionController({ campaignId: null, expectedRevision: null }, changed, api);
    await controller.start();
    const heartbeat = controller.heartbeat();
    const rejection = expect(heartbeat).rejects.toThrow("late loss");
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    const closing = controller.close();
    reject(new Error("late loss"));
    await rejection;
    await closing;
    expect(changed.mock.calls.map((call) => call[0])).toEqual([s, null]);
  });
  it("late create after leaving Desk closes its own identity and never publishes readiness", async () => {
    const gate = deferred<DeskSessionResponse>();
    const changed = vi.fn();
    const api = {
      create: vi.fn().mockReturnValue(gate.promise),
      update: vi.fn(),
      leave: vi.fn().mockResolvedValue({ revision: "2", session: null })
    };
    const controller = new DeskSessionController({ campaignId: null, expectedRevision: null }, changed, api);
    const starting = controller.start();
    const rejection = expect(starting).rejects.toThrow("Desk closed");
    await controller.close();
    gate.resolve(created);
    await rejection;
    expect(api.leave).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(null);
  });
});
