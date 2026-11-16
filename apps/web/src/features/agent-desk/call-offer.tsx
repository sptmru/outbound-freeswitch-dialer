import { useEffect, useRef, useState } from "react";
import type { AgentDeskResponse, DeskMutationRequest } from "../../types";
import { acceptCallOffer, ignoreCallOffer } from "../../api";
import { actionUnavailable } from "./coordination";
import { createRingbackWaveBlob } from "../../browser-ringback";

/** One mounted offer owns one audio element; snapshots cannot restart it. */
function useOfferRingtone(id: string | undefined, outputId: string) {
  const [blocked, setBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  async function play() {
    try {
      if (!audioRef.current) throw new Error("Audio is unavailable");
      await audioRef.current.play();
      setBlocked(false);
    } catch {
      setBlocked(true);
    }
  }
  useEffect(() => {
    if (!id) return;
    let url: string | undefined;
    let audio: HTMLAudioElement | undefined;
    let stopped = false;
    try {
      url = URL.createObjectURL(createRingbackWaveBlob());
      audio = new Audio(url);
      audio.loop = true;
      audio.volume = 0.2;
      audioRef.current = audio;
      const sink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      void (outputId && sink.setSinkId ? sink.setSinkId(outputId).catch(() => undefined) : Promise.resolve())
        .then(() => {
          if (!stopped) return audio!.play();
        })
        .then(() => {
          if (!stopped) setBlocked(false);
        })
        .catch(() => {
          if (!stopped) setBlocked(true);
        });
    } catch {
      setBlocked(true);
    }
    return () => {
      stopped = true;
      audioRef.current = null;
      audio?.pause();
      audio?.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, outputId]);
  return { blocked, play };
}

export function CallOfferCard({
  desk,
  dismissedOfferId,
  mutation,
  outputId,
  busy,
  run,
  refresh
}: {
  desk: AgentDeskResponse;
  dismissedOfferId: string | null;
  mutation: DeskMutationRequest | null;
  outputId: string;
  busy: boolean;
  run: (action: () => Promise<unknown>, kind: "accept" | "ignore") => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const offer = desk.coordination?.offer;
  const [now, setNow] = useState(Date.now);
  const closed = useRef(new Set<string>());
  const previous = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const retry = useRef<{ signature: string; input: DeskMutationRequest } | null>(null);
  if (previous.current && previous.current !== offer?.id) closed.current.add(previous.current);
  previous.current = offer?.id;
  if (offer && (offer.state !== "pending" || Date.parse(offer.deadlineAt) <= now))
    closed.current.add(offer.id);
  if (dismissedOfferId) closed.current.add(dismissedOfferId);
  const deadline = offer ? Date.parse(offer.deadlineAt) : 0;
  const visible = offer?.state === "pending" && deadline > now && !closed.current.has(offer.id);
  const ringtone = useOfferRingtone(visible ? offer.id : undefined, outputId);

  useEffect(() => {
    // A known closed card cannot be revived by a delayed equal-revision snapshot.
    setNow(Date.now());
    setFeedback(null);
  }, [offer?.id]);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(
      () => {
        closed.current.add(offer.id);
        setNow(Date.now());
        void refresh().catch(() => undefined);
      },
      Math.max(0, deadline - Date.now())
    );
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [visible, offer?.id, deadline]);

  async function act(kind: "accept" | "ignore") {
    if (!visible || !mutation || busy || pending || offer.kind !== "inbound") return;
    const signature = `${offer.id}/${kind}/${mutation.deskSessionId}/${mutation.expectedRevision}/${mutation.bindingGeneration}`;
    if (retry.current?.signature !== signature) retry.current = { signature, input: mutation };
    setPending(true);
    try {
      await run(async () => {
        await (kind === "accept" ? acceptCallOffer : ignoreCallOffer)(offer.id, retry.current!.input);
        closed.current.add(offer.id);
        setNow(Date.now());
        setFeedback(kind === "accept" ? "Connecting…" : "Offer ignored.");
        await refresh();
        retry.current = null;
      }, kind);
    } finally {
      setPending(false);
    }
  }

  if (!visible && !feedback) return null;
  return (
    <section className="panel call-offer-card" aria-label="Incoming offer">
      {visible && (
        <>
          <h2>{offer.kind === "transfer" ? "Transfer offer" : "Incoming call"}</h2>
          <strong>{offer.callingNumber}</strong>
          <p>{desk.availableCampaigns.find((c) => c.id === offer.campaignId)?.name ?? "Incoming campaign"}</p>
          <p>Waiting · respond within {Math.max(0, Math.ceil((deadline - now) / 1000))}s</p>
          {ringtone.blocked && (
            <p>
              Sound is off.{" "}
              <button type="button" onClick={() => void ringtone.play()}>
                Enable ringtone
              </button>
            </p>
          )}
          <div className="call-offer-actions">
            <button
              type="button"
              disabled={
                busy ||
                pending ||
                !mutation ||
                offer.kind !== "inbound" ||
                !desk.coordination?.actions.accept.allowed
              }
              onClick={() => void act("accept")}
            >
              Accept
            </button>
            <button
              type="button"
              disabled={
                busy ||
                pending ||
                !mutation ||
                offer.kind !== "inbound" ||
                !desk.coordination?.actions.ignore.allowed
              }
              onClick={() => void act("ignore")}
            >
              {offer.kind === "transfer" ? "Decline" : "Ignore"}
            </button>
          </div>
          {!desk.coordination?.actions.accept.allowed && (
            <p role="status">{actionUnavailable(desk.coordination?.actions.accept.reason)}</p>
          )}
        </>
      )}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
