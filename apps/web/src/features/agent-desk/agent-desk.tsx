import { useEffect, useRef, useState } from "react";

import { dropVoicemail, endCall, sendDtmf, startLeadCall, startManualCall, startNextCall } from "../../api";
import type { SoftphoneRuntime } from "../../softphone";
import type { AgentDeskResponse, LeadSummary } from "../../types";
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
    softphone.registered && availabilityStatus === "available" && !softphone.audioSetup.checking;

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
      await runCallStart(() => startNextCall({ campaignId: campaign.id }));
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
      await runCallStart(() => startLeadCall(lead.id, { confirmCompletedLead, confirmRetryWait }));
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start lead call");
    }
  }

  async function callManual(phoneNumber: string) {
    if (!campaign) {
      throw new Error("No active campaign is available");
    }
    await runCallStart(() => startManualCall({ campaignId: campaign.id, phoneNumber }));
  }

  async function runCallStart(action: () => Promise<AgentDeskResponse>) {
    if (callStartPendingRef.current) {
      throw new Error("Another call is already starting");
    }
    callStartPendingRef.current = true;
    setCallNextPending(true);
    softphone.startBrowserRingback();
    try {
      const nextDesk = await action();
      if (!nextDesk.activeCall) {
        softphone.stopBrowserRingback();
      }
      onDeskChanged(nextDesk);
    } catch (error) {
      softphone.stopBrowserRingback();
      throw error;
    } finally {
      callStartPendingRef.current = false;
      setCallNextPending(false);
    }
  }

  useEffect(() => {
    const previousActiveCall = previousActiveCallRef.current;
    previousActiveCallRef.current = desk.activeCall
      ? {
          id: desk.activeCall.id,
          manualDial: desk.activeCall.manualDial ?? desk.activeCall.leadName === "Manual dial"
        }
      : null;
    if (
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

  async function handleDropVoicemail(callId: string, recordingId?: string) {
    await runCallControl(
      "voicemail",
      () => dropVoicemail(callId, { campaignId: campaign?.id, recordingId }),
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
    try {
      onDeskChanged(await action());
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : fallbackError);
    } finally {
      callControlPendingRef.current = null;
      setCallControlPending(null);
    }
  }

  if (!campaign) {
    return (
      <section className={desk.activeCall ? "agent-grid active-agent-grid" : "ready-desk-grid"}>
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
