import type { EligibilityResult } from "./call-admission.js";

/** Legacy/null Desk auth snapshots cannot become new offer recipients. The
 * admission result supplies the current DB availability/binding/slot decision.
 */
export function inboundOfferBlockReason(
  decision: Pick<EligibilityResult, "eligible" | "reason"> | null,
  controllerAuthVersion: number | null | undefined,
  currentAuthVersion: number
): string | null {
  if (!decision?.eligible) return decision?.reason ?? "not_controller";
  if (controllerAuthVersion == null || controllerAuthVersion !== currentAuthVersion) return "not_controller";
  return null;
}

export function inboundOfferTimeoutMs(value: unknown): number {
  if (value === undefined) return 15000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5000 || value > 30000)
    throw new Error("Invalid captured offer_timeout_ms");
  return value;
}
