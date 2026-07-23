import type { AdminOverviewResponse } from "../types";

export function formatCallLifecycleStatus(
  state: AdminOverviewResponse["callHistory"][number]["state"],
  outcome: AdminOverviewResponse["callHistory"][number]["outcome"]
): string {
  if (outcome === "voicemail_dropped" || state === "voicemail_playback_completed") {
    return "Completed (voicemail dropped)";
  }
  if (outcome === "failed" || outcome === "suppressed" || state === "failed") {
    return "Failed";
  }
  if (outcome === "not_answered" || outcome === "busy") {
    return "No answer";
  }
  if (outcome === "agent_canceled" || state === "canceled") {
    return "Cancelled";
  }
  if (
    state === "completed" ||
    outcome === "answered" ||
    outcome === "customer_hung_up" ||
    outcome === "voicemail_detected"
  ) {
    return "Completed";
  }
  if (state === "agent_ringing" || state === "customer_ringing") {
    return "Ringing";
  }
  if (state === "agent_answered") {
    return "Answered";
  }
  if (
    state === "bridged" ||
    state === "voicemail_signal_detected" ||
    state === "voicemail_drop_requested" ||
    state === "voicemail_playback_started" ||
    state === "agent_released"
  ) {
    return "In progress";
  }
  return "Calling";
}
