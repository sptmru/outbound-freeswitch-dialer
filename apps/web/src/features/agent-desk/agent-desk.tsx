import { useEffect, useRef, useState } from "react";

import {
  fetchAgentDesk,
  dropVoicemail,
  endCall,
  sendDtmf,
  startLeadCall,
  startManualCall,
  startNextCall,
  type CallStartResponse
} from "../../api";
import type { SoftphoneRuntime } from "../../softphone";
import type { AgentDeskResponse, LeadSummary } from "../../types";
import { CallOfferCard } from "./call-offer";
import { TransferControls } from "./transfer-controls";
import { actionUnavailable, conflictMessage, controllerMutation } from "./coordination";
import type { ManualStartIntent } from "../../types";
import { ActiveCall } from "./active-call";
import { NoCampaignPanel, RecentAgentCalls, VoicemailJobs } from "./agent-activity-panels";
import {
  AgentNoCampaignStatus,
  AgentStatusPanel,
  callStartBlockedMessage,
  useEffectiveAvailability
} from "./agent-status";
import type { AgentDeskWithCampaign } from "./agent-status";
import { LeadContextPanel, LeadQueue } from "./lead-queue";

export function AgentDesk({
  desk,
  manualDialNumber,
  onCampaignChange,
  onDeskChanged,
  onManualDialNumberChange,
  softphone
}: {
  desk: AgentDeskResponse;
  manualDialNumber: string;
  onCampaignChange: (campaignId: string) => Promise<void>;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
  softphone: SoftphoneRuntime;
}) {
  const [callNextPending, setCallNextPending] = useState(false);
  const callStartPendingRef = useRef(false);
  const [callNextError, setCallNextError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedOfferId, setDismissedOfferId] = useState<string | null>(null);
  const mounted = useRef(true);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const focusNotice = useRef(false);
  useEffect(() => {
    if (notice && focusNotice.current) {
      noticeRef.current?.focus();
      focusNotice.current = false;
    }
  }, [notice]);
  const context = `${desk.coordination?.session?.id}/${desk.coordination?.revision}/${desk.coordination?.session?.bindingGeneration}/${desk.campaign?.id}`;
  const latestContext = useRef(context);
  latestContext.current = context;
  const manualRetry = useRef<{ signature: string; intent: ManualStartIntent } | null>(null);
  const canceledAuto = useRef(new Set<string>());
  const autoSource = desk.coordination?.autoNextIntent;
  const authority = `${context}/${desk.activeCall?.id}/${desk.coordination?.slot.state}/${desk.coordination?.slot.callId}/${autoSource?.id}/${autoSource?.state}`;
  const latestAuthority = useRef(authority);
  latestAuthority.current = authority;
  const mutation = controllerMutation(desk, softphone);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function refreshDesk() {
    const captured = context;
    const next = await fetchAgentDesk(desk.campaign?.id);
    if (mounted.current && latestContext.current === captured) onDeskChanged(next);
  }

  function manualIntent(signature: string): ManualStartIntent | undefined {
    if (!desk.coordination) return undefined;
    if (!mutation) throw new Error("Your browser phone is not ready. Refresh the desk before calling.");
    if (autoSource) canceledAuto.current.add(autoSource.id);
    const scoped = `${context}/${signature}`;
    if (manualRetry.current?.signature !== scoped) {
      manualRetry.current = { signature: scoped, intent: { ...mutation, startReason: "manual" } };
    }
    return manualRetry.current.intent;
  }

  async function actionFailure(error: unknown) {
    const message = conflictMessage(error);
    if (message) {
      focusNotice.current = true;
      setNotice(message);
    }
    // No optimistic offer dismissal. Validation, HTTP loss and conflicts refetch.
    try {
      await refreshDesk();
    } catch {
      /* Poll/SSE remains the fallback. */
    }
    return message;
  }

  const [callControlPending, setCallControlPending] = useState<"hangup" | "voicemail" | "dtmf" | null>(null);
  const callControlPendingRef = useRef<typeof callControlPending>(null);
  const [endCallError, setEndCallError] = useState<string | null>(null);
  const previousActiveCallRef = useRef(
    desk.activeCall
      ? {
          id: desk.activeCall.id,
          manualDial: desk.activeCall.manualDial ?? desk.activeCall.leadName === "Manual dial"
        }
      : null
  );
  const campaign = desk.campaign;
  const availabilityStatus = useEffectiveAvailability(desk.availability);
  const autoAdvancePausedRef = useRef(availabilityStatus === "paused");
  const canStartCalls =
    softphone.registered &&
    (softphone.deskSession === undefined || softphone.deskSession?.ready === true) &&
    availabilityStatus === "available" &&
    !softphone.audioSetup.checking &&
    (!desk.coordination ||
      (mutation !== null &&
        desk.coordination.slot.state === "free" &&
        desk.coordination.actions.manualStart.allowed));

  useEffect(() => {
    autoAdvancePausedRef.current = availabilityStatus === "paused";
  }, [availabilityStatus]);

  function handleAvailabilityChangeStarted(status: "available" | "paused") {
    autoAdvancePausedRef.current = status === "paused";
  }

  function handleAvailabilityChangeFailed() {
    autoAdvancePausedRef.current = availabilityStatus === "paused";
  }

  async function callNext() {
    if (!campaign) {
      setCallNextError("No active campaign is available");
      return;
    }
    if (!canStartCalls) {
      setCallNextError(callStartBlockedMessage(desk, softphone));
      return;
    }
    setCallNextError(null);
    try {
      await runCallStart(() =>
        startNextCall({
          campaignId: campaign.id,
          ...(desk.coordination ? { intent: manualIntent("next") } : {})
        })
      );
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start next call");
    }
  }

  async function callLead(lead: LeadSummary) {
    if (!canStartCalls) {
      setCallNextError(callStartBlockedMessage(desk, softphone));
      return;
    }
    const confirmCompletedLead = lead.status === "completed";
    const confirmRetryWait = lead.status === "retry_wait";
    if (
      confirmCompletedLead &&
      !window.confirm("This lead has already been called. Are you sure you want to call them again?")
    ) {
      return;
    }
    if (
      confirmRetryWait &&
      !window.confirm("This lead is still in the retry timeout. Are you sure you want to call them now?")
    ) {
      return;
    }
    setCallNextError(null);
    try {
      await runCallStart(() =>
        startLeadCall(lead.id, {
          confirmCompletedLead,
          confirmRetryWait,
          ...(desk.coordination ? { intent: manualIntent(`lead/${lead.id}`) } : {})
        })
      );
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start lead call");
    }
  }

  async function callManual(phoneNumber: string) {
    if (!campaign) {
      throw new Error("No active campaign is available");
    }
    if (!canStartCalls) throw new Error(callStartBlockedMessage(desk, softphone));
    const started = await runCallStart(() =>
      startManualCall({
        campaignId: campaign.id,
        phoneNumber,
        ...(desk.coordination ? { intent: manualIntent(`number/${phoneNumber}`) } : {})
      })
    );
    return started === "started";
  }

  async function runCallStart(action: () => Promise<CallStartResponse>, automatic = false) {
    if (callStartPendingRef.current) return "busy";
    callStartPendingRef.current = true;
    setCallNextPending(true);
    setNotice(null);
    const captured = context;
    const capturedAuthority = authority;
    if (!desk.coordination) softphone.startBrowserRingback();
    try {
      const result = await action();
      if (
        !mounted.current ||
        latestContext.current !== captured ||
        latestAuthority.current !== capturedAuthority
      )
        return;
      if ("status" in result) {
        if (result.status === "deferred") {
          softphone.stopBrowserRingback();
          setNotice("Automatic next call is waiting for incoming calls.");
        } else {
          setDismissedOfferId(desk.coordination?.offer?.id ?? null);
          softphone.startBrowserRingback();
          setNotice("Starting call…");
        }
        await refreshDesk();
        if (result.status === "deferred") return "deferred";
      } else {
        if (!result.activeCall) softphone.stopBrowserRingback();
        onDeskChanged(result);
      }
      if (!automatic) manualRetry.current = null;
      return "started";
    } catch (error) {
      softphone.stopBrowserRingback();
      if (!mounted.current || latestContext.current !== captured) return;
      const expected = await actionFailure(error);
      if (!expected && !automatic) throw error;
      if (!expected && automatic) setNotice("Automatic next call is waiting for a desk refresh.");
      return false;
    } finally {
      callStartPendingRef.current = false;
      if (mounted.current) setCallNextPending(false);
    }
  }

  async function runOffer(action: () => Promise<unknown>, kind: "accept" | "ignore") {
    if (callStartPendingRef.current) return;
    callStartPendingRef.current = true;
    setCallNextPending(true);
    if (autoSource && kind === "accept") canceledAuto.current.add(autoSource.id);
    const captured = context;
    try {
      await action();
    } catch (error) {
      if (!mounted.current || latestContext.current !== captured) return;
      const expected = await actionFailure(error);
      if (!expected)
        setNotice(error instanceof Error ? error.message : "Could not update offer. Please try again.");
    } finally {
      callStartPendingRef.current = false;
      if (mounted.current) setCallNextPending(false);
    }
  }

  // Native progression requires a server-bound source. Call disappearance is
  // never evidence that inbound completion or a transfer can start outbound.
  useEffect(() => {
    if (
      !desk.coordination ||
      !mutation ||
      !autoSource ||
      canceledAuto.current.has(autoSource.id) ||
      !["pending", "deferred"].includes(autoSource.state) ||
      desk.activeCall ||
      desk.coordination.slot.state !== "free" ||
      !campaign?.autoAdvanceToNextLeadEnabled ||
      campaign.callableLeads <= 0 ||
      autoAdvancePausedRef.current ||
      !softphone.registered ||
      softphone.audioSetup.checking ||
      (!desk.coordination.actions.autoNext.allowed &&
        desk.coordination.actions.autoNext.reason !== "incoming_pending")
    )
      return;
    let stopped = false;
    let timer: number;
    const intent = {
      ...mutation,
      idempotencyKey: autoSource.id,
      startReason: "automatic" as const,
      sourceCallId: autoSource.sourceCallId
    };
    async function attempt() {
      if (
        stopped ||
        latestContext.current !== context ||
        canceledAuto.current.has(autoSource!.id) ||
        autoAdvancePausedRef.current
      )
        return;
      const outcome = await runCallStart(() => startNextCall({ campaignId: campaign!.id, intent }), true);
      if (!stopped && (outcome === "deferred" || outcome === "busy"))
        timer = window.setTimeout(() => void attempt(), 2000);
    }
    timer = window.setTimeout(() => void attempt(), 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [
    context,
    autoSource?.id,
    autoSource?.state,
    desk.activeCall?.id,
    desk.coordination?.slot.state,
    desk.coordination?.actions.autoNext.allowed,
    desk.coordination?.actions.autoNext.reason,
    campaign?.autoAdvanceToNextLeadEnabled,
    availabilityStatus,
    softphone.registered,
    softphone.audioSetup.checking,
    mutation !== null
  ]);

  useEffect(() => {
    const previousActiveCall = previousActiveCallRef.current;
    previousActiveCallRef.current = desk.activeCall
      ? {
          id: desk.activeCall.id,
          manualDial: desk.activeCall.manualDial ?? desk.activeCall.leadName === "Manual dial"
        }
      : null;
    if (
      desk.coordination ||
      !previousActiveCall ||
      previousActiveCall.manualDial ||
      desk.activeCall ||
      !campaign?.autoAdvanceToNextLeadEnabled ||
      campaign.callableLeads <= 0 ||
      autoAdvancePausedRef.current ||
      !canStartCalls
    ) {
      return;
    }
    void callNext();
  }, [desk.activeCall?.id]);

  async function hangUp(callId: string, browserEventTrusted: boolean) {
    softphone.stopBrowserRingback();
    await runCallControl(
      "hangup",
      () =>
        endCall(callId, {
          campaignId: campaign?.id,
          clientContext: {
            initiator: "agent_desk_hangup_button",
            browserEventTrusted,
            clientTimestamp: new Date().toISOString(),
            pagePath: `${window.location.pathname}${window.location.search}`.slice(0, 512),
            visibilityState: document.visibilityState,
            activeCallStatus: desk.activeCall?.id === callId ? desk.activeCall.status : "missing",
            softphoneCallState: softphone.callState
          }
        }),
      "Could not end call"
    );
  }

  async function handleDropVoicemail(callId: string) {
    await runCallControl(
      "voicemail",
      () => dropVoicemail(callId, { campaignId: campaign?.id }),
      "Could not drop voicemail"
    );
  }

  async function handleSendDtmf(callId: string, digit: string) {
    await runCallControl(
      "dtmf",
      () => sendDtmf(callId, { campaignId: campaign?.id, digit }),
      "Could not send DTMF"
    );
  }

  async function runCallControl(
    kind: NonNullable<typeof callControlPending>,
    action: () => Promise<AgentDeskResponse>,
    fallbackError: string
  ) {
    if (callControlPendingRef.current) {
      return;
    }
    callControlPendingRef.current = kind;
    setCallControlPending(kind);
    setEndCallError(null);
    const capturedAuthority = authority;
    try {
      const result = await action();
      if (!mounted.current) return;
      if (latestAuthority.current === capturedAuthority) onDeskChanged(result);
      else await refreshDesk();
    } catch (error) {
      if (!mounted.current) return;
      setEndCallError(conflictMessage(error) ?? (error instanceof Error ? error.message : fallbackError));
      if (kind === "voicemail" || desk.coordination) {
        try {
          await refreshDesk();
        } catch {
          /* Keep the action error; the normal live refresh will retry. */
        }
      }
    } finally {
      callControlPendingRef.current = null;
      setCallControlPending(null);
    }
  }

  const offerCard = (
    <>
      {desk.coordination && !desk.coordination.actions.manualStart.allowed && (
        <p role="status" className="desk-notice">
          {actionUnavailable(desk.coordination.actions.manualStart.reason)}
        </p>
      )}
      {notice && (
        <p ref={noticeRef} tabIndex={-1} role="status" className="desk-notice">
          {notice}
        </p>
      )}
      {desk.coordination &&
        ["reserved", "connecting", "uncertain"].includes(desk.coordination.slot.state) && (
          <p role="status" className="desk-notice">
            {desk.coordination.slot.state === "uncertain" ? "Checking call connection…" : "Connecting…"}
          </p>
        )}
      {desk.coordination && (
        <TransferControls
          desk={desk}
          mutation={mutation}
          busy={callNextPending || callControlPending !== null}
          refresh={refreshDesk}
        />
      )}
      {desk.coordination && (
        <CallOfferCard
          desk={desk}
          dismissedOfferId={dismissedOfferId}
          mutation={mutation}
          outputId={softphone.audioSetup.selectedOutputId}
          busy={callNextPending}
          run={runOffer}
          refresh={refreshDesk}
        />
      )}
    </>
  );

  if (!campaign) {
    return (
      <section className={desk.activeCall ? "agent-grid active-agent-grid" : "ready-desk-grid"}>
        {offerCard}
        <NoCampaignPanel />
        {desk.activeCall && (
          <ActiveCall
            desk={desk}
            controlPending={callControlPending}
            error={endCallError}
            onDropVoicemail={handleDropVoicemail}
            onHangUp={hangUp}
            onSendDtmf={handleSendDtmf}
            onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
            onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
            onDeskChanged={onDeskChanged}
            softphone={softphone}
          />
        )}
        <AgentNoCampaignStatus desk={desk} onDeskChanged={onDeskChanged} softphone={softphone} />
        <VoicemailJobs jobs={desk.voicemailJobs} />
        <RecentAgentCalls calls={desk.recentCalls} />
      </section>
    );
  }

  const campaignDesk = desk as AgentDeskWithCampaign;

  if (desk.activeCall) {
    const activeLead = desk.leads.find(
      (lead) => lead.status === "calling" || lead.phoneNumber === desk.activeCall?.phoneNumber
    );
    return (
      <section className="agent-grid active-agent-grid">
        {offerCard}
        <LeadQueue
          canStartCalls={canStartCalls}
          error={callNextError}
          leads={desk.leads}
          onCallLead={callLead}
          onCallNext={callNext}
          pending={callNextPending}
          showRecommendedCall={false}
        />
        <ActiveCall
          desk={desk}
          controlPending={callControlPending}
          error={endCallError}
          onDropVoicemail={handleDropVoicemail}
          onHangUp={hangUp}
          onSendDtmf={handleSendDtmf}
          onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
          onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
          softphone={softphone}
        />
        <LeadContextPanel lead={activeLead} />
        <VoicemailJobs jobs={desk.voicemailJobs} />
      </section>
    );
  }

  return (
    <section className="ready-desk-grid">
      {offerCard}
      <LeadQueue
        canStartCalls={canStartCalls}
        error={callNextError}
        leads={desk.leads}
        onCallLead={callLead}
        onCallNext={callNext}
        pending={callNextPending}
      />
      <AgentStatusPanel
        canStartCalls={canStartCalls}
        callStartPending={callNextPending}
        desk={campaignDesk}
        manualDialNumber={manualDialNumber}
        mode="ready"
        onCampaignChange={onCampaignChange}
        onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
        onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
        onDeskChanged={onDeskChanged}
        onManualDialNumberChange={onManualDialNumberChange}
        onStartManualCall={callManual}
        softphone={softphone}
      />
      <VoicemailJobs jobs={desk.voicemailJobs} />
      <RecentAgentCalls calls={desk.recentCalls} />
    </section>
  );
}
