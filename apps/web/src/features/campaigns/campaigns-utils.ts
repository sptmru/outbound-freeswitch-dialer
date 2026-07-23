import type { AdminOverviewResponse } from "../../types";

export function getValidCampaignId(
  campaignId: string,
  campaigns: AdminOverviewResponse["campaigns"]
): string {
  if (campaigns.some((campaign) => campaign.id === campaignId)) {
    return campaignId;
  }
  return campaigns[0]?.id ?? "";
}
