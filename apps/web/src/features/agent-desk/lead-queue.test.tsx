import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LeadSummary } from "../../types";
import { LeadQueue } from "./lead-queue";

const lead: LeadSummary = {
  id: "contact-1",
  name: "Jane Doe",
  company: "",
  phoneNumber: "+14155550100",
  status: "ready",
  fields: []
};

function renderQueue(overrides: Partial<LeadSummary>, showRecommendedCall = true) {
  const onCallLead = vi.fn().mockResolvedValue(undefined);
  const onCallNext = vi.fn().mockResolvedValue(undefined);
  render(
    <LeadQueue
      canStartCalls={false}
      error={null}
      leads={[{ ...lead, ...overrides }]}
      onCallLead={onCallLead}
      onCallNext={onCallNext}
      pending={false}
      showRecommendedCall={showRecommendedCall}
    />
  );
  return { onCallLead, onCallNext };
}

describe("lead queue Zoho CRM links", () => {
  it.each([true, false])(
    "opens the exact profile independently of calling controls (next leads: %s)",
    (showRecommendedCall) => {
      const { onCallLead, onCallNext } = renderQueue(
        { zohoLeadId: " 51445000042207511 " },
        showRecommendedCall
      );
      const link = screen.getByRole("link", {
        name: "Open Jane Doe in Zoho CRM (opens in a new tab)"
      });

      expect(link).toHaveAttribute(
        "href",
        "https://crm.zoho.com.au/crm/org7002688441/tab/Leads/51445000042207511"
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      fireEvent.click(link);
      expect(onCallLead).not.toHaveBeenCalled();
      expect(onCallNext).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, "", "   "])("hides the link for an absent or blank ID (%s)", (zohoLeadId) => {
    renderQueue({ zohoLeadId });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("encodes the ID as a single URL path segment", () => {
    renderQueue({ zohoLeadId: "id/with?query#fragment" });
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://crm.zoho.com.au/crm/org7002688441/tab/Leads/id%2Fwith%3Fquery%23fragment"
    );
  });
});
