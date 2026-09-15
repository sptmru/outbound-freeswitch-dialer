import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOverviewResponse } from "../../types";
import { CreateContactForm } from "./campaign-forms";

const apiMocks = vi.hoisted(() => ({ createCampaign: vi.fn(), createContact: vi.fn() }));
vi.mock("../../api", () => apiMocks);

const campaign: AdminOverviewResponse["campaigns"][number] = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Follow-up",
  status: "active",
  loaded: 0,
  callable: 0,
  attempted: 0,
  outcomeDistribution: [],
  manualDialingEnabled: true,
  callRecordingEnabled: false,
  earlyMediaAvmdEnabled: false,
  autoAdvanceToNextLeadEnabled: false
};

function fillForm(zohoLeadId: string) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(<CreateContactForm campaigns={[campaign]} selectedCampaignId={campaign.id} onChanged={onChanged} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jane Doe" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+14155550100" } });
  fireEvent.change(screen.getByLabelText("Zoho Lead ID"), { target: { value: zohoLeadId } });
  return onChanged;
}

describe("manual lead Zoho ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createContact.mockResolvedValue({});
  });

  it("saves the exact trimmed ID as lead_id and clears it after success", async () => {
    const onChanged = fillForm(" 51445000042207511 ");
    expect(screen.getByLabelText("Zoho Lead ID")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Zoho Lead ID")).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Add lead" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(apiMocks.createContact).toHaveBeenCalledWith({
      campaignId: campaign.id,
      name: "Jane Doe",
      phoneNumber: "+14155550100",
      company: undefined,
      fields: [{ label: "lead_id", value: "51445000042207511" }]
    });
    expect(screen.getByLabelText("Zoho Lead ID")).toHaveValue("");
  });

  it.each(["", "   "])("allows creating a lead without a Zoho ID (%s)", async (id) => {
    const onChanged = fillForm(id);
    fireEvent.click(screen.getByRole("button", { name: "Add lead" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(apiMocks.createContact).toHaveBeenCalledWith(expect.objectContaining({ fields: undefined }));
  });

  it("keeps the ID when saving fails so it can be retried", async () => {
    apiMocks.createContact.mockRejectedValueOnce(new Error("Could not add lead"));
    const onChanged = fillForm("51445000042207511");
    fireEvent.click(screen.getByRole("button", { name: "Add lead" }));
    expect(await screen.findByText("Could not add lead")).toBeInTheDocument();
    expect(screen.getByLabelText("Zoho Lead ID")).toHaveValue("51445000042207511");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
