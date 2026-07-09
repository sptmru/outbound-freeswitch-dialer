import type pg from "pg";
import type { ManualDialValidationResponse } from "@outbound-dialer/shared";
import type { AppConfig } from "../config.js";
import { getAgentCampaign } from "./campaigns.js";
import { normalizePhoneNumber } from "./phone.js";
import { findSuppression } from "./suppression.js";

export async function validateDialableNumber(
  pool: pg.Pool,
  config: AppConfig,
  phoneNumber: string,
  campaignId?: string
): Promise<ManualDialValidationResponse> {
  const normalized = normalizePhoneNumber(phoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
  const [suppression, manualDialing] = await Promise.all([
    normalized.ok ? findSuppression(pool, normalized.number) : Promise.resolve(null),
    getManualDialingCheck(pool, campaignId)
  ]);
  const allowed = normalized.ok && !suppression && manualDialing.status !== "fail";
  const normalizedFailureReason = normalized.ok ? "" : normalized.reason;

  return {
    normalizedNumber: normalized.ok ? normalized.number : "",
    allowed,
    reason: allowed
      ? "Number is callable"
      : !normalized.ok
        ? normalizedFailureReason
      : suppression
        ? suppression.reason ?? "Number is suppressed"
        : manualDialing.status === "fail"
          ? manualDialing.detail
          : "Number is not callable",
    checks: [
      {
        label: "Phone number",
        status: normalized.ok ? "pass" : "fail",
        detail: normalized.ok ? `Normalized to ${normalized.number}` : normalizedFailureReason
      },
      {
        label: "Suppression list",
        status: suppression ? "fail" : "pass",
        detail: suppression ? (suppression.reason ?? "Number is suppressed") : "No matching suppression entry"
      },
      {
        label: "Manual dialing",
        status: manualDialing.status,
        detail: manualDialing.detail
      }
    ]
  };
}

async function getManualDialingCheck(
  pool: pg.Pool,
  campaignId?: string
): Promise<{ status: "pass" | "warn" | "fail"; detail: string }> {
  if (!campaignId) {
    return { status: "warn", detail: "Campaign was not checked" };
  }

  const campaign = await getAgentCampaign(pool, campaignId, { allowFallback: false });
  if (!campaign) {
    return { status: "fail", detail: "Selected campaign is not active" };
  }
  if (!campaign.manual_dialing_enabled) {
    return { status: "fail", detail: "Manual dialing is disabled for this campaign" };
  }
  return { status: "pass", detail: "Manual dialing allowed" };
}
