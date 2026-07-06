export const callStates = [
  "created",
  "agent_ringing",
  "agent_answered",
  "customer_dialing",
  "customer_ringing",
  "bridged",
  "voicemail_signal_detected",
  "voicemail_drop_requested",
  "voicemail_playback_started",
  "agent_released",
  "voicemail_playback_completed",
  "completed",
  "failed",
  "canceled"
] as const;

export type CallState = (typeof callStates)[number];

export const callOutcomes = [
  "answered",
  "not_answered",
  "busy",
  "failed",
  "voicemail_detected",
  "voicemail_dropped",
  "agent_canceled",
  "customer_hung_up",
  "suppressed"
] as const;

export type CallOutcome = (typeof callOutcomes)[number];

export const userRoles = ["agent", "admin"] as const;

export type UserRole = (typeof userRoles)[number];

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "api";
  uptimeSeconds: number;
  checks: {
    postgres: HealthCheck;
    freeswitchEsl: HealthCheck;
  };
}

export interface HealthCheck {
  status: "ok" | "error" | "skipped";
  message?: string;
}
