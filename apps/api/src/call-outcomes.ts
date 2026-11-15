export function resolveCustomerHangupOutcome(input: {
  answered: boolean;
  hangupCause?: string;
  voicemailDetected: boolean;
}): "busy" | "customer_hung_up" | "failed" | "not_answered" | "voicemail_detected" {
  const normalized = input.hangupCause?.toUpperCase() ?? "";
  if (input.answered) {
    return input.voicemailDetected ? "voicemail_detected" : "customer_hung_up";
  }
  if (normalized === "USER_BUSY") {
    return "busy";
  }
  if (["NO_ANSWER", "NO_USER_RESPONSE", "CALL_REJECTED", "ORIGINATOR_CANCEL"].includes(normalized)) {
    return "not_answered";
  }
  return "failed";
}
