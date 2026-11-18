import type { AgentDeskResponse, DeskMutationRequest } from "../../types";
import type { SoftphoneRuntime } from "../../softphone";

/** Revisions are canonical PostgreSQL bigint strings, never JS numbers. */
export function olderDesk(next: AgentDeskResponse, current: AgentDeskResponse | null): boolean {
  const a = next.coordination;
  const b = current?.coordination;
  if (!b || current?.user.id !== next.user.id) return false;
  if (!a) return true;
  return BigInt(a.revision) < BigInt(b.revision);
}

export function controllerMutation(
  desk: AgentDeskResponse,
  phone: Pick<SoftphoneRuntime, "deskSession" | "registered">,
  idempotencyKey = crypto.randomUUID()
): DeskMutationRequest | null {
  const session = desk.coordination?.session;
  if (
    !phone.registered ||
    !session ||
    session.id !== phone.deskSession?.id ||
    session.revision !== desk.coordination?.revision ||
    session.revision !== phone.deskSession.revision ||
    session.bindingGeneration !== phone.deskSession.bindingGeneration ||
    session.campaignId !== desk.campaign?.id ||
    !session.ready ||
    !session.endpointVerified ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    return null;
  return {
    deskSessionId: session.id,
    expectedRevision: session.revision,
    bindingGeneration: session.bindingGeneration,
    idempotencyKey
  };
}

export function conflictMessage(error: unknown): string | null {
  const body = (error as { body?: { code?: string } } | null)?.body;
  switch (body?.code) {
    case "offer_closed":
    case "offer_expired":
      return "This offer has ended. The desk has been refreshed.";
    case "revision_conflict":
    case "not_controller":
      return "Your desk changed. Review the current state before trying again.";
    case "slot_occupied":
      return "A call is already in progress. The desk has been refreshed.";
    case "not_owner":
      return "Call ownership changed. The desk has been refreshed.";
    case "transfer_in_progress":
      return "A transfer is already in progress. The desk has been refreshed.";
    case "capacity_exhausted":
      return "Calling capacity is busy. Please try again shortly.";
    case "coordination_unavailable":
      return "Calling is temporarily unavailable. Please try again shortly.";
    case "endpoint_unavailable":
      return "Your browser phone is not ready. Check your phone connection.";
    case "call_outcome_uncertain":
      return "The call is still being checked. Please wait for the desk to update.";
    default:
      return null;
  }
}

export function actionUnavailable(reason: string | null | undefined): string {
  switch (reason) {
    case "incoming_pending":
      return "Automatic next call is waiting for incoming calls.";
    case "not_controller":
    case "revision_conflict":
      return "Refresh your desk before calling.";
    case "endpoint_unavailable":
      return "Your browser phone is not ready yet.";
    case "slot_occupied":
      return "A call is already in progress.";
    case "capacity_exhausted":
      return "Calling capacity is busy. Please try again shortly.";
    case "paused":
      return "Resume calling before starting a call.";
    default:
      return "This action is currently unavailable. Refresh the desk before trying again.";
  }
}
