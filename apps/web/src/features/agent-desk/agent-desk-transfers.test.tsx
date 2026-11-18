import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AgentDesk } from "./agent-desk";
import * as api from "../../api";
import { readyPhone } from "../../test/coordination-fixtures";
import { targetId, transferRecipient, transferSnapshot, transferSource } from "../../test/transfer-fixtures";
import type { AgentDeskResponse, TransferSnapshot } from "../../types";
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  fetchTransferTargets: vi.fn(),
  createTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  fetchAgentDesk: vi.fn(),
  acceptCallOffer: vi.fn(),
  ignoreCallOffer: vi.fn(),
  startNextCall: vi.fn(),
  endCall: vi.fn(),
  dropVoicemail: vi.fn(),
  sendDtmf: vi.fn()
}));
function mount(desk = transferSource()) {
  const changed = vi.fn();
  const props = {
    desk,
    manualDialNumber: "+15557654321",
    onCampaignChange: vi.fn(),
    onDeskChanged: changed,
    onManualDialNumberChange: vi.fn(),
    softphone: readyPhone(desk)
  };
  const view = render(<AgentDesk {...props} />);
  return {
    ...view,
    changed,
    snapshot(next: AgentDeskResponse) {
      view.rerender(<AgentDesk {...props} desk={next} softphone={readyPhone(next)} />);
    }
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "Audio",
    class {
      play() {
        return Promise.resolve();
      }
      pause() {}
      removeAttribute() {}
    }
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:transfer");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.mocked(api.fetchAgentDesk).mockResolvedValue(transferSource());
  vi.mocked(api.fetchTransferTargets).mockResolvedValue({
    revision: "1",
    items: [
      { agentId: targetId, name: "Colleague", available: true, reason: null },
      { agentId: "busy", name: "Busy colleague", available: false, reason: "slot_occupied" }
    ]
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const direction of ["inbound", "outbound"] as const) {
  it(`G03.1 ${direction} recipient hint, single create/cancel, source controls retained`, async () => {
    const desk = transferSource(direction);
    const view = mount(desk);
    vi.mocked(api.createTransfer).mockResolvedValue({
      status: "applied",
      revision: "1",
      transfer: transferSnapshot(),
      offerId: "offer"
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose colleague" }));
    await screen.findByRole("option", { name: "Colleague" });
    expect(screen.getByRole("option", { name: /Busy colleague/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Transfer recipient"), { target: { value: targetId } });
    fireEvent.click(screen.getByRole("button", { name: "Request transfer" }));
    await waitFor(() => expect(api.createTransfer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createTransfer).mock.calls[0]).toEqual([
      desk.activeCall!.id,
      expect.objectContaining({ recipientAgentId: targetId, expectedRevision: "1" })
    ]);
    const pending = structuredClone(desk);
    pending.coordination!.transfer = transferSnapshot();
    view.snapshot(pending);
    expect(screen.getByRole("button", { name: "Hang up" })).toBeEnabled();
    vi.mocked(api.cancelTransfer).mockResolvedValue({
      status: "applied",
      revision: "1",
      transfer: transferSnapshot("canceled")
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    await waitFor(() => expect(api.cancelTransfer).toHaveBeenCalledTimes(1));
    expect(api.endCall).not.toHaveBeenCalled();
  });
}
it("G03.1 busy target and HTTP loss refetch, rediscovery retains mutation identity", async () => {
  mount();
  vi.mocked(api.createTransfer).mockRejectedValue(new TypeError("Response lost"));
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Choose colleague" }));
    await screen.findByLabelText("Transfer recipient");
    fireEvent.change(screen.getByLabelText("Transfer recipient"), { target: { value: targetId } });
    fireEvent.click(screen.getByRole("button", { name: "Request transfer" }));
    await screen.findByText("Response lost");
  }
  expect(api.createTransfer).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.createTransfer).mock.calls[0]).toEqual(vi.mocked(api.createTransfer).mock.calls[1]);
  expect(api.fetchAgentDesk).toHaveBeenCalledTimes(2);
});
for (const state of [
  "offered",
  "connecting",
  "switching",
  "uncertain",
  "completed",
  "declined",
  "expired",
  "canceled",
  "failed"
] as TransferSnapshot["state"][]) {
  it(`G03.1/G03.3 authoritative ${state} feedback never invents handover`, () => {
    const desk = transferSource();
    desk.coordination!.transfer = transferSnapshot(state);
    mount(desk);
    expect(screen.getByLabelText("Call transfer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hang up" })).toBeEnabled();
    if (state !== "offered") expect(screen.queryByRole("button", { name: "Cancel transfer" })).toBeNull();
  });
}
for (const kind of ["accept", "ignore"] as const) {
  it(`G03.1 recipient ${kind} uses transfer-capable endpoint and preserves campaign`, async () => {
    mount(transferRecipient());
    expect(screen.getByText("Your selected campaign will not change.")).toBeInTheDocument();
    vi.mocked(api.acceptCallOffer).mockResolvedValue({
      status: "connecting",
      revision: "1",
      callId: "call",
      offerId: "offer",
      operationId: "op"
    });
    vi.mocked(api.ignoreCallOffer).mockResolvedValue({ status: "applied", revision: "1" });
    fireEvent.click(screen.getByRole("button", { name: kind === "accept" ? "Accept" : "Decline" }));
    await waitFor(() =>
      expect(kind === "accept" ? api.acceptCallOffer : api.ignoreCallOffer).toHaveBeenCalledTimes(1)
    );
  });
}
it("G03.3 delayed create/target responses cannot act in a replacement Desk", async () => {
  const desk = transferSource();
  const view = mount(desk);
  let resolve!: (v: Awaited<ReturnType<typeof api.fetchTransferTargets>>) => void;
  vi.mocked(api.fetchTransferTargets).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose colleague" }));
  const next = structuredClone(desk);
  next.coordination!.revision = "2";
  next.coordination!.session!.revision = "2";
  view.snapshot(next);
  await act(async () =>
    resolve({
      revision: "1",
      items: [{ agentId: targetId, name: "Late colleague", available: true, reason: null }]
    })
  );
  expect(screen.queryByRole("option", { name: "Late colleague" })).toBeNull();
  expect(api.createTransfer).not.toHaveBeenCalled();
});
it("G03.3 confirmed handover disables obsolete call controls and null never launches auto next", async () => {
  vi.useFakeTimers();
  const desk = transferSource();
  desk.coordination!.transfer = transferSnapshot("switching");
  const view = mount(desk);
  const done = structuredClone(desk);
  done.coordination!.transfer = transferSnapshot("completed");
  done.coordination!.slot = { state: "free", callId: null, reservationId: null, generation: "1" };
  view.snapshot(done);
  expect(screen.getByRole("button", { name: "Hang up" })).toBeDisabled();
  done.activeCall = null;
  view.snapshot(structuredClone(done));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(api.startNextCall).not.toHaveBeenCalled();
});

it("G03.3 timeout refetches server state without declaring expiry or ending source media", async () => {
  vi.useFakeTimers();
  const desk = transferSource();
  desk.coordination!.transfer = transferSnapshot();
  mount(desk);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20001);
  });
  expect(api.fetchAgentDesk).toHaveBeenCalledTimes(1);
  expect(api.cancelTransfer).not.toHaveBeenCalled();
  expect(api.endCall).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Hang up" })).toBeEnabled();
});
it("G03.3 stale owner action refetches and delayed control result cannot restore the old call", async () => {
  const desk = transferSource();
  const view = mount(desk);
  let resolve!: (v: AgentDeskResponse) => void;
  vi.mocked(api.endCall).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
  const done = structuredClone(desk);
  done.activeCall = null;
  done.coordination!.slot = { state: "free", callId: null, reservationId: null, generation: "1" };
  vi.mocked(api.fetchAgentDesk).mockResolvedValue(done);
  view.snapshot(done);
  await act(async () => resolve(desk));
  expect(view.changed).toHaveBeenCalledWith(done);
  expect(view.changed).not.toHaveBeenCalledWith(desk);
  view.snapshot(desk);
  vi.mocked(api.endCall).mockRejectedValueOnce(new api.ApiError("not_owner", 409, { code: "not_owner" }));
  fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
  await waitFor(() => expect(api.fetchAgentDesk).toHaveBeenCalledTimes(2));
});

it("G03.3 late Accept cannot overwrite a failed transfer with Connecting feedback", async () => {
  const desk = transferRecipient();
  const view = mount(desk);
  let resolve!: (value: Awaited<ReturnType<typeof api.acceptCallOffer>>) => void;
  vi.mocked(api.acceptCallOffer).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  const failed = structuredClone(desk);
  failed.coordination!.offer!.state = "accepted";
  failed.coordination!.transfer = transferSnapshot("failed");
  view.snapshot(failed);
  await act(async () =>
    resolve({
      status: "connecting",
      revision: "1",
      callId: transferSnapshot().callId,
      offerId: desk.coordination!.offer!.id,
      operationId: "op"
    })
  );
  expect(
    screen.getByText("Transfer failed. Review the current call before trying again.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Connecting…")).toBeNull();
  expect(view.changed).not.toHaveBeenCalled();
});

for (const control of ["hangup", "voicemail", "dtmf"] as const) {
  it(`G04.1 ${control} sends current Desk authority and refetches an accepted operation`, async () => {
    const desk = transferSource();
    desk.activeCall!.recordingId = "recording";
    desk.activeCall!.actions!.dropVoicemail = { allowed: true, reason: null };
    const fn =
      control === "hangup" ? api.endCall : control === "voicemail" ? api.dropVoicemail : api.sendDtmf;
    vi.mocked(fn).mockResolvedValue({
      status: "accepted",
      callId: desk.activeCall!.id,
      operationId: "operation",
      revision: "1"
    });
    const done = structuredClone(desk);
    done.activeCall = null;
    vi.mocked(api.fetchAgentDesk).mockResolvedValue(done);
    const view = mount(desk);
    fireEvent.click(
      screen.getByRole("button", {
        name: control === "hangup" ? "Hang up" : control === "voicemail" ? "Drop voicemail" : "5"
      })
    );
    await waitFor(() => expect(fn).toHaveBeenCalledOnce());
    expect(vi.mocked(fn).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        intent: expect.objectContaining({
          deskSessionId: desk.coordination!.session!.id,
          expectedRevision: "1",
          bindingGeneration: "1",
          idempotencyKey: expect.any(String)
        })
      })
    );
    await waitFor(() => expect(view.changed).toHaveBeenCalledWith(done));
    expect(view.changed).not.toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
  });
}
