import { useEffect, useRef, useState } from "react";
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
export function TransferControls({
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
  const call = desk.activeCall;
  const source =
    !!call && desk.coordination?.slot.callId === call.id && desk.coordination.slot.state === "active";
  const canRequest =
    source &&
    !!mutation &&
    desk.coordination?.actions.transfer.allowed &&
    (!transfer || !unfinished.has(transfer.state));
  const scope = `${call?.id}/${mutation?.deskSessionId}/${mutation?.expectedRevision}/${mutation?.bindingGeneration}/${transfer?.id}/${transfer?.state}`;
  const latest = useRef(scope);
  latest.current = scope;
  const mounted = useRef(true);
  const [targets, setTargets] = useState<TransferTargetsResponse | null>(null);
  const [recipient, setRecipient] = useState("");
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const retry = useRef<{ signature: string; input: DeskMutationRequest } | null>(null);
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
    if (transfer?.state !== "offered") return;
    const timer = window.setTimeout(
      () => {
        void refresh().catch(() => undefined);
      },
      Math.max(0, Date.parse(transfer.deadlineAt) - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [transfer?.id, transfer?.state, transfer?.deadlineAt, scope]);

  async function perform(kind: "targets" | "create" | "cancel") {
    if (!mutation || !call || lock.current || busy) return;
    if (
      kind === "create" &&
      (!canRequest || !targets?.items.some((t) => t.agentId === recipient && t.available))
    )
      return;
    if (kind === "cancel" && (!source || transfer?.state !== "offered")) return;
    lock.current = true;
    setPending(true);
    const captured = scope;
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
      if (mounted.current) setPending(false);
    }
  }

  if (!desk.coordination || (!transfer && !canRequest && !feedback)) return null;
  return (
    <section className="panel call-offer-card" aria-label="Call transfer" aria-busy={pending}>
      <h2>Call transfer</h2>
      {transfer && <p role="status">{transferStatus(transfer.state)}</p>}
      {source && transfer?.state === "offered" && (
        <button type="button" disabled={busy || pending || !mutation} onClick={() => void perform("cancel")}>
          Cancel transfer
        </button>
      )}
      {canRequest && (
        <>
          <button type="button" disabled={busy || pending} onClick={() => void perform("targets")}>
            Choose colleague
          </button>
          {targets && (
            <>
              <label>
                Transfer recipient
                <select value={recipient} onChange={(event) => setRecipient(event.target.value)}>
                  <option value="">Select a colleague</option>
                  {targets.items.map((target) => (
                    <option key={target.agentId} value={target.agentId} disabled={!target.available}>
                      {target.name}
                      {target.available ? "" : " — unavailable"}
                    </option>
                  ))}
                </select>
              </label>
              {!targets.items.some((target) => target.available) && (
                <p>No colleagues are currently available.</p>
              )}
              <p>Colleagues may have another campaign selected. This call keeps its original campaign.</p>
              <button
                type="button"
                disabled={
                  busy ||
                  pending ||
                  !targets.items.some((target) => target.agentId === recipient && target.available)
                }
                onClick={() => void perform("create")}
              >
                Request transfer
              </button>
            </>
          )}
        </>
      )}
      {source && !mutation && <p>{actionUnavailable("not_controller")}</p>}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
