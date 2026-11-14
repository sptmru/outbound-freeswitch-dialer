import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOverviewResponse } from "../../types";
import { VoicemailUpload } from "./voicemail-upload";
import { CampaignCard } from "../campaigns/campaign-card";

const api = vi.hoisted(() => ({
  uploadRecording: vi.fn(),
  setCampaignVoicemail: vi.fn(),
  getCampaignRecordingsExportUrl: vi.fn(() => "/export"),
  resetCampaignLeads: vi.fn(),
  updateCampaign: vi.fn()
}));
vi.mock("../../api", () => api);
const campaign: AdminOverviewResponse["campaigns"][number] = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Campaign A",
  status: "active",
  voicemailRecordingId: null,
  loaded: 0,
  callable: 0,
  attempted: 0,
  outcomeDistribution: [],
  manualDialingEnabled: true,
  callRecordingEnabled: false,
  earlyMediaAvmdEnabled: false,
  autoAdvanceToNextLeadEnabled: false
};
const recording: AdminOverviewResponse["recordings"][number] = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Message A",
  campaignId: campaign.id,
  campaignName: campaign.name,
  isAssigned: false,
  status: "ready",
  durationSeconds: 3,
  fileSizeBytes: 100
};

describe("campaign voicemail management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.uploadRecording.mockResolvedValue({ item: recording });
    api.setCampaignVoicemail.mockResolvedValue({});
  });

  it("requires a campaign and sends its ownership and assignment preference with the upload", async () => {
    const uploaded = vi.fn().mockResolvedValue(undefined);
    render(<VoicemailUpload campaigns={[campaign]} onUploaded={uploaded} onCancel={vi.fn()} />);
    const file = new File(["audio"], "message.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Voicemail file"), { target: { files: [file] } });
    expect(screen.getByRole("button", { name: "Upload voicemail" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: campaign.id } });
    fireEvent.click(screen.getByLabelText("Use for this campaign"));
    fireEvent.submit(screen.getByLabelText("Voicemail file").closest("form")!);
    await waitFor(() => expect(uploaded).toHaveBeenCalledOnce());
    expect(api.uploadRecording).toHaveBeenCalledWith({
      file,
      name: "message",
      campaignId: campaign.id,
      useForCampaign: false
    });
  });

  it("keeps a failed upload open and preserves the selected campaign", async () => {
    api.uploadRecording.mockRejectedValue(new Error("Invalid audio"));
    const uploaded = vi.fn();
    render(
      <VoicemailUpload
        campaigns={[campaign]}
        initialCampaignId={campaign.id}
        onUploaded={uploaded}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Campaign")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Voicemail file"), {
      target: { files: [new File(["bad"], "bad.wav")] }
    });
    fireEvent.submit(screen.getByLabelText("Voicemail file").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid audio");
    expect(uploaded).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Campaign")).toHaveValue(campaign.id);
  });

  it("offers only owned messages, supports disabling voicemail and preselects upload ownership", async () => {
    const changed = vi.fn().mockResolvedValue(undefined);
    render(
      <CampaignCard
        campaign={{ ...campaign, voicemailRecordingId: recording.id }}
        recordings={[
          recording,
          { ...recording, id: "other", campaignId: "other", name: "Other campaign message" }
        ]}
        onChanged={changed}
      />
    );
    expect(screen.queryByRole("option", { name: "Other campaign message" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Voicemail for Campaign A" }), {
      target: { value: "" }
    });
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(api.setCampaignVoicemail).toHaveBeenCalledWith(campaign.id, null);
    fireEvent.click(screen.getByRole("button", { name: "Upload voicemail for this campaign" }));
    expect(screen.getByLabelText("Campaign")).toHaveValue(campaign.id);
    expect(screen.getByLabelText("Campaign")).toBeDisabled();
  });
});
