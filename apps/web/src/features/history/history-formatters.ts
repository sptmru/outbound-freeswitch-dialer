import type { AdminOverviewResponse, CallAvmdReview, CallDetailResponse } from "../../types";

export function formatRecordingStatus(status: CallDetailResponse["call"]["recordingStatus"]): string {
  switch (status) {
    case "disabled":
      return "Not enabled";
    case "pending":
      return "Pending";
    case "recording":
      return "Recording";
    case "finalizing":
      return "Verifying";
    case "available":
      return "Available";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
  }
}

export function historyDateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (endOfDay) {
    date.setDate(date.getDate() + 1);
    date.setMilliseconds(-1);
  }
  return date.toISOString();
}

export function formatAvmdReviewStatus(
  status: NonNullable<AdminOverviewResponse["callHistory"][number]["avmdReviewStatus"]>
): string {
  const labels = {
    needs_review: "Needs AVMD review",
    reviewed: "AVMD reviewed",
    uncertain: "AVMD uncertain"
  } as const;
  return labels[status];
}

export function formatAvmdPrediction(detail: CallDetailResponse): string {
  const signal = detail.call.voicemailSignal;
  const label = signal === "detected" ? "Detected" : signal === "possible" ? "Possible" : "No detection";
  return detail.call.voicemailConfidence === null
    ? label
    : `${label} · confidence ${detail.call.voicemailConfidence}`;
}

export function formatAvmdActualParty(actualParty: CallAvmdReview["actualParty"]): string {
  const labels = {
    human: "Human",
    machine: "Voicemail / machine",
    uncertain: "Uncertain"
  } as const;
  return labels[actualParty];
}

export function formatPcapStatus(status: NonNullable<CallDetailResponse["call"]["pcapStatus"]>): string {
  const labels = {
    pending: "Pending",
    capturing: "Capturing",
    available: "Available",
    failed: "Failed",
    expired: "Expired"
  } as const;
  return labels[status];
}

export function formatOutcomeFilterOption(outcome: string): string {
  const labels: Record<string, string> = {
    answered: "Answered",
    not_answered: "No answer",
    busy: "Busy",
    failed: "Failed",
    voicemail_detected: "Voicemail detected",
    voicemail_dropped: "Voicemail dropped",
    agent_canceled: "Agent cancelled",
    customer_hung_up: "Customer hung up",
    suppressed: "Suppressed"
  };
  return labels[outcome] ?? outcome.replaceAll("_", " ");
}
