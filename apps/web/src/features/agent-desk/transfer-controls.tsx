import { useEffect, useId, useRef, useState } from "react";
import { PhoneForwarded } from "lucide-react";
import { cancelTransfer, createTransfer, fetchTransferTargets } from "../../api";
import type {
  AgentDeskResponse,
  DeskMutationRequest,
  TransferSnapshot,
  TransferTargetsResponse
} from "../../types";
import { actionUnavailable, conflictMessage } from "./coordination";

const unfinished = new Set(["offered", "connecting", "switching", "uncertain"]);
export function transferStatus(state: TransferSnapshot["state"]): string {
  switch (state) {
    case "offered":
      return "Transfer offered. Waiting for a response.";
    case "connecting":
      return "Connecting colleague…";
    case "switching":
      return "Switching call… Waiting for confirmed handover.";
    case "uncertain":
      return "Checking transfer… Please wait for confirmed call state.";
    case "completed":
      return "Transfer completed.";
    case "declined":
      return "Transfer declined. The source conversation continues.";
    case "expired":
      return "Transfer timed out. The source conversation continues.";
    case "canceled":
      return "Transfer canceled.";
    case "failed":
      return "Transfer failed. Review the current call before trying again.";
  }
}

/** Transfer HTTP results never change ownership or end browser media. */
export function useTransferControls({
  desk,
  mutation,
  busy,
  refresh
}: {
  desk: AgentDeskResponse;
  mutation: DeskMutationRequest | null;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const transfer = desk.coordination?.transfer;
  const offer = desk.coordination?.offer;
  const slot = desk.coordination?.slot;
  const call = desk.activeCall;
  const source = !!call && slot?.callId === call.id && slot.state === "active";
  const canRequest =
    source &&
    !!mutation &&
    desk.coordination?.actions.transfer.allowed &&
    (!transfer || !unfinished.has(transfer.state));
  const scope = `${call?.id}/${slot?.callId}/${slot?.state}/${mutation?.deskSessionId}/${mutation?.expectedRevision}/${mutation?.bindingGeneration}/${transfer?.id}/${transfer?.state}`;
  const latest = useRef(scope);
  latest.current = scope;
  const mounted = useRef(true);
  const pickerId = useId();
  const actionRef = useRef<HTMLButtonElement>(null);
  const recipientRef = useRef<HTMLSelectElement>(null);
  const [targets, setTargets] = useState<TransferTargetsResponse | null>(null);
  const [recipient, setRecipient] = useState("");
  const [pending, setPending] = useState<{ kind: "targets" | "create" | "cancel"; scope: string } | null>(
    null
  );
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const retry = useRef<{ signature: string; input: DeskMutationRequest } | null>(null);
  const selectedTargetAvailable = targets?.items.some(
    (target) => target.agentId === recipient && target.available
  );
  const loading = pending?.kind === "targets" && pending.scope === scope;
  const expanded = canRequest && (targets !== null || loading);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setTargets(null);
    setRecipient("");
    setFeedback(null);
  }, [scope]);
  useEffect(() => {
    if (targets && document.activeElement === actionRef.current) recipientRef.current?.focus();
  }, [targets]);
  useEffect(() => {
    if (transfer?.state !== "offered") return;
    const timer = window.setTimeout(
      () => {
        void refresh().catch(() => undefined);
      },
      Math.max(0, Date.parse(transfer.deadlineAt) - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [transfer?.id, transfer?.state, transfer?.deadlineAt, scope]);

  function closePicker() {
    actionRef.current?.focus();
    setTargets(null);
    setRecipient("");
  }

  async function perform(kind: "targets" | "create" | "cancel") {
    if (!mutation || !call || lock.current || busy) return;
    if (kind === "targets" && !canRequest) return;
    if (kind === "create" && (!canRequest || !selectedTargetAvailable)) return;
    if (kind === "cancel" && (!source || transfer?.state !== "offered")) return;
    lock.current = true;
    const captured = scope;
    setPending({ kind, scope: captured });
    const current = () => mounted.current && latest.current === captured;
    const signature = `${scope}/${kind}/${kind === "cancel" ? transfer?.id : recipient}`;
    if (kind !== "targets" && retry.current?.signature !== signature)
      retry.current = { signature, input: mutation };
    try {
      if (kind === "targets") {
        const result = await fetchTransferTargets(call.id, mutation.deskSessionId);
        if (!current()) return;
        if (result.revision !== mutation.expectedRevision) {
          setFeedback("Your desk changed. Refreshing available colleagues…");
          await refresh();
          return;
        }
        setTargets(result);
        setRecipient("");
        setFeedback(null);
      } else {
        if (kind === "create")
          await createTransfer(call.id, { ...retry.current!.input, recipientAgentId: recipient });
        else await cancelTransfer(call.id, transfer!.id, retry.current!.input);
        if (!current()) return;
        retry.current = null;
        setTargets(null);
        setFeedback(
          kind === "create" ? "Transfer requested. Updating desk…" : "Transfer canceled. Updating desk…"
        );
        await refresh();
      }
    } catch (error) {
      if (!current()) return;
      setTargets(null); // availability was a hint; a failed create must rediscover it.
      setFeedback(
        conflictMessage(error) ??
          (error instanceof Error ? error.message : "Could not update transfer. Refresh and try again.")
      );
      try {
        await refresh();
      } catch {
        /* Poll/SSE can retry without changing media. */
      }
    } finally {
      lock.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const action = canRequest && (
    <button
      ref={actionRef}
      className="secondary-action"
      type="button"
      aria-controls={expanded ? pickerId : undefined}
      aria-expanded={expanded}
      aria-disabled={loading || undefined}
      disabled={busy || (pending !== null && !loading)}
      onClick={() => (expanded ? !pending && closePicker() : void perform("targets"))}
    >
      <PhoneForwarded size={17} aria-hidden="true" />
      Transfer
    </button>
  );
  const isRecipientOffer = offer?.state === "pending" && offer.transferId === transfer?.id;
  const status = transfer && !isRecipientOffer ? transferStatus(transfer.state) : null;
  const canCancel = source && transfer?.state === "offered";
  const details = (expanded || status || canCancel || feedback) && (
    <section className="transfer-details" aria-label="Call transfer">
      {expanded && (
        <div className="transfer-picker" id={pickerId} aria-busy={loading}>
          {loading && <p role="status">Loading colleagues…</p>}
          {targets && (
            <>
              <label>
                Transfer to colleague
                <select
                  ref={recipientRef}
                  value={recipient}
                  disabled={busy || pending !== null}
                  onChange={(event) => setRecipient(event.target.value)}
                >
                  <option value="">Select a colleague</option>
                  {targets.items.map((target) => (
                    <option key={target.agentId} value={target.agentId} disabled={!target.available}>
                      {target.name}
                      {target.available ? "" : " — unavailable"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="transfer-picker-actions">
                <button
                  className="secondary-action"
                  type="button"
                  disabled={pending !== null}
                  onClick={closePicker}
                >
                  Cancel
                </button>
                <button
                  className="primary-action"
                  type="button"
                  disabled={busy || pending !== null || !selectedTargetAvailable}
                  onClick={() => void perform("create")}
                >
                  {pending?.kind === "create" ? "Sending…" : "Send request"}
                </button>
              </div>
              {!targets.items.some((target) => target.available) && (
                <p role="status">No colleagues are currently available.</p>
              )}
            </>
          )}
        </div>
      )}
      {(status || canCancel) && (
        <div className="transfer-progress">
          {status && <p role="status">{status}</p>}
          {canCancel && (
            <button
              className="secondary-action"
              type="button"
              disabled={busy || pending !== null || !mutation}
              onClick={() => void perform("cancel")}
            >
              Cancel transfer
            </button>
          )}
        </div>
      )}
      {source && !mutation && <p>{actionUnavailable("not_controller")}</p>}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
  return { action, details };
}
