import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { flowError, InboundAdmin } from "./inbound-admin";
import type { InboundFlowAction } from "@outbound-dialer/shared";
import type { AdminOverviewResponse } from "../../types";

describe("F05 forms", () => {
  it("F05.1 denies non-administrators before loading", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<InboundAdmin role="agent" admin={{} as AdminOverviewResponse} onChanged={async () => {}} />);
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it.each([
    [[], "Choose one"],
    [[{ type: "hangup" }, { type: "play_audio", recordingId: "a", timeoutMs: 1000 }], "last step"],
    [[{ type: "play_audio", recordingId: "", timeoutMs: 1000 }], "Choose audio"],
    [[{ type: "forward_external", target: " ", timeoutMs: 5000 }], "international"],
    [
      [
        { type: "forward_external", target: "+14155550199", timeoutMs: 5000 },
        { type: "forward_external", target: "+14155550198", timeoutMs: 5000 }
      ],
      "one forwarding"
    ],
    [
      [
        { type: "play_audio", recordingId: "a", timeoutMs: 60000 },
        { type: "play_audio", recordingId: "b", timeoutMs: 60000 }
      ],
      "total flow timeout"
    ]
  ])("F05.2 rejects invalid finite sequence %#", (actions, message) => {
    expect(flowError({ flowTimeoutMs: 90000, actions: actions as InboundFlowAction[] })).toContain(message);
  });
  it("F05.2 accepts bounded audio, forward and combined continuations", () => {
    const audio: InboundFlowAction = { type: "play_audio", recordingId: "a", timeoutMs: 10000 };
    const forward: InboundFlowAction = { type: "forward_external", target: "+14155550199", timeoutMs: 20000 };
    for (const actions of [[audio], [forward], [audio, forward, audio]])
      expect(flowError({ flowTimeoutMs: 90000, actions })).toBeNull();
  });
});
