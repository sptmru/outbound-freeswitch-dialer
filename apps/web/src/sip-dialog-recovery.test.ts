import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionState, type Invitation } from "sip.js";
import { watchRecoveredDialog } from "./sip-dialog-recovery";

function fixture() {
  let current = true;
  const delegates: Array<NonNullable<Parameters<Invitation["invite"]>[0]>["requestDelegate"]> = [];
  const dispose = vi.fn();
  const invite = vi.fn((options: Parameters<Invitation["invite"]>[0]) => {
    delegates.push(options?.requestDelegate);
    return Promise.resolve({ dispose });
  });
  const invitation = { state: SessionState.Established, invite };
  const ended = vi.fn();
  const watcher = watchRecoveredDialog(
    invitation as unknown as Pick<Invitation, "state" | "invite">,
    () => current,
    ended
  );
  const reply = (index: number, status: number) => {
    const response = { message: { statusCode: status } } as never;
    if (status < 300) delegates[index]?.onAccept?.(response);
    else if (status < 400) delegates[index]?.onRedirect?.(response);
    else delegates[index]?.onReject?.(response);
  };
  return {
    watcher,
    invitation,
    invite,
    dispose,
    ended,
    reply,
    stale: () => {
      current = false;
    }
  };
}
describe("recovered SIP dialog terminal evidence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("probes only after reconnect; success, other errors and timeouts retain media", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.invite).not.toHaveBeenCalled();
    f.watcher.connected();
    await Promise.resolve();
    for (const status of [200, 302, 408, 415, 500, 503]) {
      f.reply(f.invite.mock.calls.length - 1, status);
      expect(f.ended).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
    }
    const count = f.invite.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.invite).toHaveBeenCalledTimes(count); // one outstanding transaction
    expect(f.invite).toHaveBeenCalledWith(expect.objectContaining({ withoutSdp: true }));
    expect(f.ended).not.toHaveBeenCalled();
    f.reply(count - 1, 481);
    expect(f.ended).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.invite).toHaveBeenCalledTimes(count);
    f.watcher.stop();
  });
  it("rejects late replies from a disconnected flow", async () => {
    const f = fixture();
    f.watcher.connected();
    await Promise.resolve();
    f.watcher.disconnected();
    expect(f.dispose).not.toHaveBeenCalled(); // SIP.js owns the pending INVITE/ACK lifecycle.
    f.watcher.connected();
    await Promise.resolve();
    f.reply(0, 481);
    expect(f.ended).not.toHaveBeenCalled();
    f.reply(1, 200);
    await vi.advanceTimersByTimeAsync(5000);
    f.reply(2, 481);
    expect(f.ended).toHaveBeenCalledTimes(1);
  });
  it("fences a replaced invitation and stops its timer", async () => {
    const f = fixture();
    f.watcher.connected();
    await Promise.resolve();
    f.stale();
    f.reply(0, 481);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.ended).not.toHaveBeenCalled();
    expect(f.invite).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores a request that resolves after unmount without publishing termination", async () => {
    const f = fixture();
    let resolve!: (request: { dispose: typeof f.dispose }) => void;
    f.invite.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    f.watcher.connected();
    f.watcher.stop();
    resolve({ dispose: f.dispose });
    await Promise.resolve();
    f.invite.mock.calls[0][0]?.requestDelegate?.onReject?.({ message: { statusCode: 481 } } as never);
    expect(f.ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.invite).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
  });
  it("retries rejected and synchronously failing sends without terminating", async () => {
    const f = fixture();
    f.invite.mockRejectedValueOnce(new Error("offline"));
    f.watcher.connected();
    await Promise.resolve();
    f.invite.mockImplementationOnce(() => {
      throw new Error("transport changed");
    });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.invite).toHaveBeenCalledTimes(3);
    expect(f.ended).not.toHaveBeenCalled();
    f.watcher.stop();
  });
  it("waits for establishment and stops after normal termination", async () => {
    const f = fixture();
    f.invitation.state = SessionState.Establishing;
    f.watcher.connected();
    expect(f.invite).not.toHaveBeenCalled();
    f.invitation.state = SessionState.Established;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.invite).toHaveBeenCalledTimes(1);
    f.invitation.state = SessionState.Terminated;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
    f.reply(0, 481);
    expect(f.ended).not.toHaveBeenCalled();
  });
});
