let subscribed = false;

export function setFreeSwitchEventListenerSubscribed(value: boolean): void {
  subscribed = value;
}

export function isFreeSwitchEventListenerSubscribed(): boolean {
  return subscribed;
}

const eventNames = [
  "BACKGROUND_JOB",
  "CHANNEL_CREATE",
  "CHANNEL_PROGRESS",
  "CHANNEL_PROGRESS_MEDIA",
  "CHANNEL_ANSWER",
  "CHANNEL_BRIDGE",
  "CHANNEL_PARK",
  "CHANNEL_HANGUP",
  "CHANNEL_HANGUP_COMPLETE",
  "CHANNEL_DESTROY",
  // FreeSWITCH treats every token after CUSTOM as a custom event subclass.
  // Keep CUSTOM and its explicit subclasses last so CHANNEL_* names remain
  // regular event subscriptions.
  "CUSTOM"
] as const;
const customSubclasses = [
  "avmd::beep",
  "amd::result",
  "sofia::register",
  "sofia::unregister",
  "sofia::expire",
  "outbound_dialer::inbound_captured",
  "outbound_dialer::inbound_waiting_started",
  "outbound_dialer::inbound_forward_finished",
  "outbound_dialer::inbound_fallback_started",
  "outbound_dialer::inbound_fallback_completed",
  "outbound_dialer::inbound_fallback_failed",
  "outbound_dialer::voicemail_playback_started",
  "outbound_dialer::voicemail_playback_completed",
  "outbound_dialer::voicemail_playback_failed"
] as const;

export const freeSwitchEventSubscription = [...eventNames, ...customSubclasses].join(" ");

export function normalizeEventName(value: string | undefined) {
  const name = value?.trim().toUpperCase();
  return eventNames.find((event) => event === name) ?? "UNKNOWN";
}

export function persistenceDiagnostic(headers: Record<string, string>, error: unknown) {
  const uuid = (value: string | undefined) =>
    value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
  const candidate = (error as { code?: unknown } | null)?.code;
  const code =
    typeof candidate === "string" && /^(?:0[8A]|22|23|25|40|42|53|55|57|58|XX)[A-Z0-9]{3}$/.test(candidate)
      ? candidate
      : undefined;
  return {
    eventName: normalizeEventName(headers["event-name"]),
    eventSubclass: customSubclasses.find((name) => name === headers["event-subclass"]),
    callId: uuid(
      headers["variable_outbound_dialer_call_id"] ?? headers["variable_outbound_dialer_ingress_uuid"]
    ),
    operationId: uuid(
      headers["outbound-dialer-operation-id"] ?? headers["variable_outbound_dialer_operation_id"]
    ),
    jobUuid: uuid(headers["job-uuid"]),
    code
  };
}
