import { SessionState, type Invitation } from "sip.js";

/** Watch only a dialog whose signaling transport was lost. A correlated SIP 481
 * confirms that dialog no longer exists. Timeouts/errors never end media. */
export function watchRecoveredDialog(
  invitation: Pick<Invitation, "state" | "invite">,
  isCurrent: () => boolean,
  ended: () => void
) {
  let stopped = false;
  let connected = false;
  let interval: number | null = null;
  type Attempt = object;
  let pending: Attempt | null = null;
  const invalidate = () => {
    pending = null;
  };
  const stopInterval = () => {
    if (interval !== null) window.clearInterval(interval);
    interval = null;
    invalidate();
  };
  const probe = async () => {
    if (stopped) return;
    if (!isCurrent() || invitation.state === SessionState.Terminated) {
      stopped = true;
      stopInterval();
      return;
    }
    if (!connected || invitation.state !== SessionState.Established || pending) return;
    const attempt: Attempt = {};
    pending = attempt;
    const finish = (status?: number) => {
      if (pending !== attempt) return;
      pending = null;
      if (
        status !== 481 ||
        stopped ||
        !connected ||
        !isCurrent() ||
        invitation.state !== SessionState.Established
      )
        return;
      stopped = true;
      stopInterval();
      ended();
    };
    try {
      await invitation.invite({
        // An offerless re-INVITE checks the exact dialog. With no local SDP
        // offer, SIP.js rejects timeouts without rolling back/ending media.
        withoutSdp: true,
        requestDelegate: {
          onAccept: () => finish(),
          onRedirect: () => finish(),
          onReject: (response) => finish(response.message.statusCode)
        }
      });
      // SIP.js owns the INVITE transaction (including ACK/timeout and its
      // pending-reINVITE flag). Do not dispose it on a transport change.
    } catch {
      finish();
    }
  };
  return {
    connected() {
      if (stopped) return;
      connected = true;
      if (interval === null) interval = window.setInterval(() => void probe(), 5000);
      void probe();
    },
    disconnected() {
      connected = false;
      stopInterval();
    },
    stop() {
      stopped = true;
      connected = false;
      stopInterval();
    }
  };
}
