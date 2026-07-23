import { useState } from "react";
import type { FormEvent } from "react";
import { Ban, Mic, PhoneCall, PhoneForwarded, PhoneOff, Users } from "lucide-react";

import { updateAgentAvailability } from "../../api";
import { Metric, StatusBadge } from "../../components/ui-primitives";
import { AudioSetupPanel } from "../audio/audio-setup-panel";
import type { SoftphoneRuntime } from "../../softphone";
import type { AgentDeskResponse } from "../../types";

export type AgentDeskWithCampaign = AgentDeskResponse & {
  campaign: NonNullable<AgentDeskResponse["campaign"]>;
};

export function useEffectiveAvailability(
  availability: AgentDeskResponse["availability"]
): AgentDeskResponse["availability"]["status"] {
  return availability.status === "wrap_up" ? "available" : availability.status;
}

export function callStartBlockedMessage(desk: AgentDeskResponse, softphone: SoftphoneRuntime): string {
  if (softphone.audioSetup.checking) {
    return "Wait for the audio and network check to finish";
  }
  if (!softphone.registered) {
    return "The browser phone is not ready yet";
  }
  if (desk.availability.status === "paused") {
    return "Resume calling before starting a call";
  }
  return "Calling is not available yet";
}

export function AvailabilityControl({
  desk,
  disabled = false,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged
}: {
  desk: AgentDeskResponse;
  disabled?: boolean;
  onAvailabilityChangeFailed?: () => void;
  onAvailabilityChangeStarted?: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
}) {
  const status = useEffectiveAvailability(desk.availability);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = status === "paused";
  const statusLabel = paused ? "Paused" : "Ready";
  const actionLabel = paused ? "Resume calling" : "Pause";

  async function toggleAvailability() {
    const nextStatus = status === "available" ? "paused" : "available";
    setPending(true);
    setError(null);
    onAvailabilityChangeStarted?.(nextStatus);
    try {
      onDeskChanged(
        await updateAgentAvailability({
          status: nextStatus,
          campaignId: desk.campaign?.id
        })
      );
    } catch (updateError) {
      onAvailabilityChangeFailed?.();
      setError(updateError instanceof Error ? updateError.message : "Could not change availability");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="availability-control">
      <StatusBadge label={statusLabel} tone={status === "available" ? "good" : "neutral"} />
      <button
        className="pill-action"
        disabled={disabled || pending}
        onClick={() => void toggleAvailability()}
        type="button"
      >
        {pending ? "Saving" : actionLabel}
      </button>
      {error && (
        <small className="form-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export function AgentStatusPanel({
  canStartCalls,
  callStartPending,
  desk,
  manualDialNumber,
  mode,
  onCampaignChange,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged,
  onManualDialNumberChange,
  onStartManualCall,
  softphone
}: {
  canStartCalls: boolean;
  callStartPending: boolean;
  desk: AgentDeskWithCampaign;
  manualDialNumber: string;
  mode: "ready" | "active";
  onCampaignChange: (campaignId: string) => Promise<void>;
  onAvailabilityChangeFailed?: () => void;
  onAvailabilityChangeStarted?: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
  onStartManualCall: (phoneNumber: string) => Promise<void>;
  softphone: SoftphoneRuntime;
}) {
  const [campaignPending, setCampaignPending] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [manualDialError, setManualDialError] = useState<string | null>(null);
  const phoneStatus = getPhoneStatusCopy(softphone);

  async function changeCampaign(campaignId: string) {
    setCampaignPending(true);
    setCampaignError(null);
    try {
      await onCampaignChange(campaignId);
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "Could not switch campaign");
    } finally {
      setCampaignPending(false);
    }
  }

  async function startManualDial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartCalls) {
      setManualDialError(callStartBlockedMessage(desk, softphone));
      return;
    }

    setManualDialError(null);
    try {
      await onStartManualCall(manualDialNumber);
      onManualDialNumberChange("");
    } catch (error) {
      setManualDialError(error instanceof Error ? error.message : "Could not start call");
    }
  }

  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <label className="campaign-selector">
        Campaign
        <select
          disabled={
            campaignPending || callStartPending || mode === "active" || desk.availableCampaigns.length <= 1
          }
          onChange={(event) => void changeCampaign(event.target.value)}
          value={desk.campaign.id}
        >
          {desk.availableCampaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name} ({campaign.callableLeads})
            </option>
          ))}
        </select>
      </label>
      {campaignError && (
        <p className="form-error" role="alert">
          {campaignError}
        </p>
      )}
      <div className="status-stack">
        <AvailabilityControl
          desk={desk}
          disabled={callStartPending || mode === "active"}
          onAvailabilityChangeFailed={onAvailabilityChangeFailed}
          onAvailabilityChangeStarted={onAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
        />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{phoneStatus.label}</strong>
          <span>{phoneStatus.detail}</span>
        </div>
      </div>
      <div className="softphone-actions">
        {softphone.callState === "active" && (
          <button
            className="danger-action compact-action"
            onClick={() => void softphone.hangUpSoftphoneCall()}
            type="button"
          >
            <PhoneOff size={16} />
            Hang up
          </button>
        )}
      </div>
      <AudioSetupPanel softphone={softphone} />
      {desk.campaign.manualDialingEnabled && (
        <form className="inline-manual-dial" onSubmit={startManualDial}>
          <label htmlFor="manual-dial-number">Manual call</label>
          <div className="inline-manual-dial-controls">
            <input
              autoComplete="tel"
              id="manual-dial-number"
              inputMode="tel"
              onChange={(event) => {
                onManualDialNumberChange(event.target.value);
                setManualDialError(null);
              }}
              placeholder="+1 415 555 0000"
              type="tel"
              value={manualDialNumber}
            />
            <button
              className="primary-action teal-action"
              disabled={callStartPending || !manualDialNumber.trim() || !canStartCalls}
              type="submit"
            >
              <PhoneCall size={17} />
              {callStartPending ? "Starting" : "Call"}
            </button>
          </div>
          {manualDialError && (
            <p className="form-error" role="alert">
              {manualDialError}
            </p>
          )}
        </form>
      )}
      <div className="status-metric-list">
        <Metric label="Callable leads" value={desk.campaign.callableLeads} icon={Users} />
        <Metric label="Calls today" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="Blocked numbers" value={desk.metrics.suppressed} icon={Ban} />
      </div>
    </article>
  );
}

export function AgentNoCampaignStatus({
  desk,
  onDeskChanged,
  softphone
}: {
  desk: AgentDeskResponse;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  softphone: SoftphoneRuntime;
}) {
  const phoneStatus = getPhoneStatusCopy(softphone);
  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <div className="status-stack">
        {desk.activeCall ? (
          <StatusBadge label="In call" tone="good" />
        ) : (
          <AvailabilityControl desk={desk} onDeskChanged={onDeskChanged} />
        )}
        <StatusBadge label="Manual dialing unavailable" tone="neutral" />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{phoneStatus.label}</strong>
          <span>{phoneStatus.detail}</span>
        </div>
      </div>
      <div className="status-metric-list">
        <Metric label="Callable leads" value={0} icon={Users} />
        <Metric label="Calls today" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="Blocked numbers" value={desk.metrics.suppressed} icon={Ban} />
      </div>
    </article>
  );
}

function getPhoneStatusCopy(softphone: SoftphoneRuntime): { detail: string; label: string } {
  if (softphone.registered) {
    return { label: "Phone ready", detail: "Calls will connect in this browser." };
  }
  if (!softphone.microphoneAllowed) {
    return {
      label: "Microphone access needed",
      detail: "Allow microphone access in your browser, then reload this page."
    };
  }
  if (softphone.state === "requesting_microphone" || softphone.state === "registering") {
    return { label: "Connecting phone", detail: "This usually takes a few seconds." };
  }
  return {
    label: "Phone unavailable",
    detail: "Reload the page. If it stays offline, contact an administrator."
  };
}
