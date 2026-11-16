import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDesk } from "./agent-desk";
import {
  ApiError,
  acceptCallOffer,
  ignoreCallOffer,
  fetchAgentDesk,
  startNextCall,
  startManualCall,
  startLeadCall
} from "../../api";
import { coordinatedDesk, deferredDesk, readyPhone } from "../../test/coordination-fixtures";
import { controllerMutation, olderDesk } from "./coordination";
import type { AgentDeskResponse } from "../../types";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  acceptCallOffer: vi.fn(),
  ignoreCallOffer: vi.fn(),
  fetchAgentDesk: vi.fn(),
  startNextCall: vi.fn(),
  startManualCall: vi.fn(),
  startLeadCall: vi.fn()
}));

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
function mount(desk = coordinatedDesk()) {
  const phone = readyPhone(desk);
  phone.startBrowserRingback = vi.fn();
  phone.stopBrowserRingback = vi.fn();
  const changed = vi.fn();
  const props = {
    desk,
    manualDialNumber: "+15557654321",
    onCampaignChange: vi.fn(),
    onDeskChanged: changed,
    onManualDialNumberChange: vi.fn(),
    softphone: phone
  };
  const view = render(<AgentDesk {...props} />);
  return {
    ...view,
    props,
    changed,
    phone,
    snapshot: (next: AgentDeskResponse) =>
      view.rerender(
        <AgentDesk {...props} desk={next} softphone={{ ...phone, deskSession: next.coordination?.session }} />
      )
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  vi.stubGlobal(
    "Audio",
    class {
      loop = false;
      volume = 0;
      play = play;
      pause = pause;
      removeAttribute() {}
    }
  );
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() })
  );
  vi.mocked(fetchAgentDesk).mockResolvedValue(coordinatedDesk());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("E03 Agent Desk offers", () => {
  it("E03.1 repeats snapshots without auto acceptance or overlapping ringtone; Ignore and stale replay stop it", async () => {
    const desk = coordinatedDesk();
    const view = mount(desk);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    view.snapshot(structuredClone(desk));
    view.snapshot(structuredClone(desk));
    expect(acceptCallOffer).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(1);
    vi.mocked(ignoreCallOffer).mockResolvedValue({ status: "applied", revision: "1" });
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(ignoreCallOffer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    view.snapshot(structuredClone(desk));
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("E03.1 expires without a mutation; another winner and exit stop audio; a stale card does not revive", async () => {
    vi.useFakeTimers();
    const desk = coordinatedDesk();
    const view = mount(desk);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const gone = structuredClone(desk);
    gone.coordination!.offer = null;
    view.snapshot(gone);
    expect(pause).toHaveBeenCalledTimes(1);
    view.snapshot(desk);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    const later = coordinatedDesk();
    later.coordination!.offer!.id = "99999999-9999-4999-8999-999999999999";
    view.snapshot(later);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(acceptCallOffer).not.toHaveBeenCalled();
    expect(ignoreCallOffer).not.toHaveBeenCalled();
    view.unmount();
    expect(pause).toHaveBeenCalledTimes(2);
  });
  it("E03.1 autoplay denial keeps actionable buttons and permits a user sound retry", async () => {
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    mount();
    await screen.findByRole("button", { name: "Enable ringtone" });
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Enable ringtone" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enable ringtone" })).toBeNull());
    expect(acceptCallOffer).not.toHaveBeenCalled();
  });
  for (const kind of ["next", "lead", "number"] as const) {
    it(`E03.2 ${kind} sends one manual start with pending offer; no separate Ignore`, async () => {
      const desk = coordinatedDesk();
      const view = mount(desk);
      const api = kind === "next" ? startNextCall : kind === "lead" ? startLeadCall : startManualCall;
      vi.mocked(api).mockResolvedValue({
        status: "started",
        revision: "1",
        callId: "call",
        operationId: "op"
      });
      if (kind === "next") fireEvent.click(screen.getByRole("button", { name: "Start next call" }));
      else if (kind === "lead")
        fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Call" }));
      else
        fireEvent.click(
          within(screen.getByLabelText("Manual call").closest("form")!).getByRole("button", {
            name: "Call"
          })
        );
      await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
      const args = vi.mocked(api).mock.calls[0];
      const input = args[args.length - 1] as { intent: { startReason: string } };
      expect(input.intent).toMatchObject({
        startReason: "manual",
        deskSessionId: desk.coordination!.session!.id,
        expectedRevision: "1",
        bindingGeneration: "1"
      });
      expect(ignoreCallOffer).not.toHaveBeenCalled();
      await waitFor(() => expect(view.changed).toHaveBeenCalled());
    });
  }
  it("E03.2 failed manual admission preserves the offer/number and refetches; network retry keeps request identity", async () => {
    mount();
    vi.mocked(startManualCall).mockRejectedValue(new ApiError("busy", 409, { code: "capacity_exhausted" }));
    fireEvent.click(
      within(screen.getByLabelText("Manual call").closest("form")!).getByRole("button", {
        name: "Call"
      })
    );
    await screen.findByText("Calling capacity is busy. Please try again shortly.");
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(fetchAgentDesk).toHaveBeenCalled();
    expect(screen.getByLabelText("Manual call")).toHaveValue("+15557654321");
    fireEvent.click(
      within(screen.getByLabelText("Manual call").closest("form")!).getByRole("button", {
        name: "Call"
      })
    );
    await waitFor(() => expect(startManualCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startManualCall).mock.calls[0][0]).toEqual(vi.mocked(startManualCall).mock.calls[1][0]);
    expect(ignoreCallOffer).not.toHaveBeenCalled();
  });
  it("E03.3 deferred automatic work retries the same server source without ringback, and revision cancels timer", async () => {
    vi.useFakeTimers();
    const desk = deferredDesk();
    const view = mount(desk);
    vi.mocked(startNextCall).mockResolvedValue({
      status: "deferred",
      revision: "1",
      reason: "incoming_pending",
      intent: desk.coordination!.autoNextIntent as any
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(startNextCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startNextCall).mock.calls[0]).toEqual(vi.mocked(startNextCall).mock.calls[1]);
    expect(vi.mocked(startNextCall).mock.calls[0][0]?.intent).toMatchObject({
      startReason: "automatic",
      sourceCallId: desk.coordination!.autoNextIntent!.sourceCallId
    });
    expect(view.phone.startBrowserRingback).not.toHaveBeenCalled();
    const next = structuredClone(desk);
    next.coordination!.revision = "2"; // controller no longer matches
    view.snapshot(next);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(startNextCall).toHaveBeenCalledTimes(2);
  });
  it("E03.3 manual next invalidates deferred source even when server refuses the manual attempt", async () => {
    vi.useFakeTimers();
    const desk = deferredDesk();
    mount(desk);
    vi.mocked(startNextCall).mockRejectedValue(new ApiError("busy", 409, { code: "capacity_exhausted" }));
    fireEvent.click(screen.getByRole("button", { name: "Start next call" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(startNextCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startNextCall).mock.calls[0][0]?.intent?.startReason).toBe("manual");
  });
  it("E03.3 inbound/handover completion has no auto source and starts nothing", async () => {
    vi.useFakeTimers();
    const desk = coordinatedDesk();
    desk.campaign!.autoAdvanceToNextLeadEnabled = true;
    desk.coordination!.slot.state = "active";
    const view = mount(desk);
    const done = structuredClone(desk);
    done.coordination!.slot.state = "free";
    view.snapshot(done);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(startNextCall).not.toHaveBeenCalled();
  });
  it("E03.4 duplicate Accept creates one request; conflict refreshes without hanging up any media", async () => {
    const view = mount();
    let reject!: (e: unknown) => void;
    vi.mocked(acceptCallOffer).mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      })
    );
    const button = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(acceptCallOffer).toHaveBeenCalledTimes(1);
    await act(async () => reject(new ApiError("expired", 409, { code: "offer_expired" })));
    await screen.findByText("This offer has ended. The desk has been refreshed.");
    expect(fetchAgentDesk).toHaveBeenCalled();
    expect(view.phone.startBrowserRingback).not.toHaveBeenCalled();
  });
  it("E03.4 server action availability and exact controller gate starts without treating a pending offer as occupancy", () => {
    const desk = coordinatedDesk();
    const phone = readyPhone(desk);
    expect(controllerMutation(desk, phone)).not.toBeNull();
    phone.deskSession = { ...phone.deskSession!, bindingGeneration: "2" };
    expect(controllerMutation(desk, phone)).toBeNull();
    const view = mount(desk);
    expect(screen.getByRole("button", { name: "Start next call" })).toBeEnabled();
    const blocked = structuredClone(desk);
    blocked.coordination!.actions.manualStart.allowed = false;
    blocked.coordination!.actions.accept.allowed = false;
    view.snapshot(blocked);
    expect(screen.getByRole("button", { name: "Start next call" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    const stale = structuredClone(desk);
    stale.coordination!.revision = "9007199254740993";
    expect(olderDesk(desk, stale)).toBe(true);
    expect(olderDesk({ ...desk, coordination: undefined }, desk)).toBe(true);
  });
});

it("E03.3 source/campaign change or Desk exit invalidates a late automatic response before ringback", async () => {
  vi.useFakeTimers();
  const desk = deferredDesk();
  const view = mount(desk);
  let resolve!: (value: any) => void;
  vi.mocked(startNextCall).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const changed = structuredClone(desk);
  changed.coordination!.autoNextIntent = null;
  view.snapshot(changed);
  await act(async () => resolve({ status: "started", revision: "1", callId: "late", operationId: "late" }));
  expect(view.phone.startBrowserRingback).not.toHaveBeenCalled();
  expect(view.changed).not.toHaveBeenCalled();
  const next = deferredDesk();
  next.coordination!.session!.campaignId = "other";
  next.campaign!.id = "other";
  view.snapshot(next);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(startNextCall).toHaveBeenCalledTimes(1);
});
it("E03.4 successful Accept shows connecting; HTTP loss keeps the same immutable retry identity", async () => {
  const view = mount();
  vi.mocked(acceptCallOffer).mockRejectedValueOnce(new TypeError("Network response lost"));
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await screen.findByText("Network response lost");
  vi.mocked(acceptCallOffer).mockResolvedValueOnce({
    status: "connecting",
    revision: "1",
    callId: "call",
    operationId: "op",
    offerId: view.props.desk.coordination!.offer!.id
  });
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await screen.findByText("Connecting…");
  expect(vi.mocked(acceptCallOffer).mock.calls[0]).toEqual(vi.mocked(acceptCallOffer).mock.calls[1]);
  expect(view.phone.startBrowserRingback).not.toHaveBeenCalled();
});
it("E03.1 terminal snapshots with the same offer id cannot be reopened by a stale pending snapshot", async () => {
  const desk = coordinatedDesk();
  const view = mount(desk);
  const closed = structuredClone(desk);
  closed.coordination!.offer!.state = "canceled";
  view.snapshot(closed);
  view.snapshot(desk);
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});

it("E03.3 confirmed voicemail-release source can advance once while background playback continues", async () => {
  vi.useFakeTimers();
  const desk = deferredDesk();
  desk.coordination!.offer = null;
  desk.coordination!.actions.autoNext = { allowed: true, reason: null };
  const source = desk.coordination!.autoNextIntent!;
  desk.coordination!.autoNextIntent = { ...source, state: "pending", reason: null, callId: null };
  desk.voicemailJobs = [
    {
      callId: source.sourceCallId,
      leadName: "Previous lead",
      phoneNumber: "+15551234567",
      status: "playing",
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];
  const view = mount(desk);
  vi.mocked(startNextCall).mockResolvedValue({
    status: "started",
    revision: "1",
    callId: "next",
    operationId: "op"
  });
  const reserved = structuredClone(desk);
  reserved.coordination!.slot = {
    state: "reserved",
    callId: "next",
    reservationId: "reservation",
    generation: "2"
  };
  vi.mocked(fetchAgentDesk).mockResolvedValue(reserved);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(startNextCall).toHaveBeenCalledTimes(1);
  expect(vi.mocked(startNextCall).mock.calls[0][0]?.intent).toMatchObject({
    startReason: "automatic",
    sourceCallId: source.sourceCallId
  });
  expect(view.phone.startBrowserRingback).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Previous lead")).toBeInTheDocument();
});
