import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Play, Shield, Voicemail } from "lucide-react";

import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import { formatDuration } from "../../lib/formatters";
import type { SoftphoneRuntime } from "../../softphone";
import type { AgentDeskResponse } from "../../types";
import { formatCallLifecycleStatus } from "../../lib/call-formatters";
import { AvailabilityControl } from "./agent-status";

export function ActiveCall({
  controlPending,
  desk,
  error,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged,
  onDropVoicemail,
  onHangUp,
  onSendDtmf,
  softphone
}: {
  controlPending: "hangup" | "voicemail" | "dtmf" | null;
  desk: AgentDeskResponse;
  error: string | null;
  onAvailabilityChangeFailed: () => void;
  onAvailabilityChangeStarted: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onDropVoicemail: (callId: string, recordingId?: string) => Promise<void>;
  onHangUp: (callId: string, browserEventTrusted: boolean) => Promise<void>;
  onSendDtmf: (callId: string, digit: string) => Promise<void>;
  softphone: SoftphoneRuntime;
}) {
  const activeCall = desk.activeCall as ActiveCallUi | null;
  const displayedDurationSeconds = useActiveCallDuration(activeCall);
  const defaultRecordingId = activeCall?.recordingId ?? desk.recordings[0]?.id ?? "";
  const [selectedRecordingId, setSelectedRecordingId] = useState(defaultRecordingId);
  useEffect(() => {
    setSelectedRecordingId(defaultRecordingId);
  }, [activeCall?.id, defaultRecordingId]);

  if (!activeCall) {
    return (
      <article className="panel active-call">
        <PanelHeader icon={Phone} title="Active call" meta="Ready" />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </article>
    );
  }

  const durationLabel = formatCallLifecycleStatus(activeCall.state, activeCall.outcome ?? null);
  const voicemailSignal = formatVoicemailSignal(activeCall.voicemailSignal);
  const selectedRecording = desk.recordings.find((recording) => recording.id === selectedRecordingId);
  const dropRecordingId = selectedRecording?.id ?? activeCall.recordingId ?? undefined;
  const unavailableAction = {
    allowed: false,
    reason: "Call controls are unavailable. Refresh the Agent Desk before continuing."
  };
  const dropEligibility = activeCall.actions?.dropVoicemail ?? unavailableAction;
  const dtmfEligibility = activeCall.actions?.sendDtmf ?? unavailableAction;
  const browserAudioCopy =
    activeCall.status !== "bridged"
      ? durationLabel
      : softphone.audioPlaybackState === "playing"
        ? "Browser audio playing · customer connected"
        : softphone.audioPlaybackState === "unavailable"
          ? "Browser call audio is unavailable"
          : softphone.audioPlaybackState === "blocked"
            ? "Browser blocked call audio playback"
            : "Customer connected · waiting for browser audio";
  return (
    <article aria-busy={controlPending !== null} className="panel active-call">
      <div className="call-status-line">
        <StatusBadge label={`● ${durationLabel}`} tone="good" />
        <span>Call {activeCall.id.slice(0, 8).toUpperCase()}</span>
      </div>
      {activeCall.supervisor?.active && (
        <div
          className={activeCall.supervisor.mode === "join" ? "supervisor-notice danger" : "supervisor-notice"}
          role="status"
        >
          <Shield size={17} />
          <div>
            <strong>
              {activeCall.supervisor.mode === "join"
                ? "Administrator joined this call"
                : activeCall.supervisor.mode === "whisper"
                  ? "Supervisor coaching is active"
                  : "Administrator is listening"}
            </strong>
            <span>
              {activeCall.supervisor.mode === "join"
                ? "The administrator can speak to you and the customer."
                : activeCall.supervisor.mode === "whisper"
                  ? "You can hear the supervisor; the customer cannot."
                  : "The administrator microphone is off."}
            </span>
          </div>
        </div>
      )}
      <div className="active-call-availability">
        <span>Next call</span>
        <AvailabilityControl
          desk={desk}
          onAvailabilityChangeFailed={onAvailabilityChangeFailed}
          onAvailabilityChangeStarted={onAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
        />
      </div>
      <div className="call-hero">
        <div>
          <h2>{activeCall.leadName}</h2>
          <p>{activeCall.phoneNumber}</p>
          {activeCall.campaignName && <small>{activeCall.campaignName}</small>}
        </div>
      </div>
      <div className="call-stage">
        <div className="call-stage-top">
          <span>{softphone.audioPlaybackState === "playing" ? "Live audio" : "Call audio"}</span>
          <strong aria-label={`Call duration ${formatDuration(displayedDurationSeconds)}`}>
            {formatDuration(displayedDurationSeconds)}
          </strong>
        </div>
        <div className="audio-waveform" aria-hidden="true">
          {[
            18, 32, 46, 28, 58, 40, 24, 52, 68, 44, 30, 54, 36, 20, 42, 62, 38, 24, 48, 32, 18, 40, 26, 52,
            34, 20, 44, 30
          ].map((height, index) => (
            <span key={`${height}-${index}`} style={{ height }} />
          ))}
        </div>
        <div className="call-stage-meta">
          <span aria-live="polite">{browserAudioCopy}</span>
          <b className={`recording-state recording-${activeCall.callRecordingStatus}`}>
            {activeCall.callRecordingStatus === "recording"
              ? "● REC"
              : activeCall.callRecordingStatus === "pending"
                ? "REC pending"
                : activeCall.callRecordingStatus === "failed"
                  ? "REC failed"
                  : "Not recorded"}
          </b>
        </div>
        {activeCall.status === "bridged" && softphone.audioPlaybackState === "blocked" && (
          <div className="audio-playback-warning" role="alert">
            <span>Your browser blocked call audio. Start playback to hear the customer.</span>
            <button
              className="secondary-action compact-action"
              onClick={() => void softphone.retryRemoteAudio()}
              type="button"
            >
              <Play size={15} />
              Play call audio
            </button>
          </div>
        )}
        {activeCall.status === "bridged" && softphone.audioPlaybackState === "unavailable" && (
          <div className="audio-playback-warning" role="alert">
            <span>
              The browser could not attach the customer audio stream. End the call and reconnect the phone.
            </span>
          </div>
        )}
      </div>
      <div className="handoff-card">
        <Voicemail size={18} />
        <div>
          <strong>Voicemail reached?</strong>
          <span>Start playback and release the agent leg.</span>
        </div>
      </div>
      <div className="signal-strip">
        <div className={`voicemail-signal ${activeCall.voicemailSignal}`}>
          <span>VM / beep signal</span>
          <strong>{voicemailSignal.label}</strong>
          <small>{voicemailSignal.detail}</small>
        </div>
        <div>
          <span>Recording</span>
          <label className="compact-select">
            <select
              disabled={controlPending !== null || desk.recordings.length === 0}
              onChange={(event) => setSelectedRecordingId(event.target.value)}
              value={selectedRecordingId}
            >
              {desk.recordings.map((recording) => (
                <option key={recording.id} value={recording.id}>
                  {recording.name}
                  {recording.status === "default" ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          {!desk.recordings.length && <strong>No voicemail recordings</strong>}
        </div>
      </div>
      <div className="call-actions call-actions-stacked">
        <button
          className="primary-action voicemail-primary-action"
          disabled={controlPending !== null || !dropRecordingId || !dropEligibility.allowed}
          onClick={() => onDropVoicemail(activeCall.id, dropRecordingId)}
          title={
            !dropEligibility.allowed
              ? (dropEligibility.reason ?? "Voicemail drop is not available yet")
              : undefined
          }
          type="button"
        >
          <Voicemail size={17} />
          {controlPending === "voicemail" ? "Dropping" : "Drop voicemail"}
        </button>
        <button
          className="danger-action"
          disabled={controlPending !== null}
          onClick={(event) => onHangUp(activeCall.id, event.nativeEvent.isTrusted)}
          type="button"
        >
          <PhoneOff size={17} />
          {controlPending === "hangup" ? "Ending" : "Hang up"}
        </button>
      </div>
      {!dropEligibility.allowed && dropEligibility.reason && (
        <p className="action-hint">{dropEligibility.reason}</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <details className="dtmf-panel">
        <summary>Keypad</summary>
        <div className="dtmf-pad" aria-label="DTMF keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
            <button
              disabled={controlPending !== null || !dtmfEligibility.allowed}
              key={digit}
              onClick={() => void onSendDtmf(activeCall.id, digit)}
              title={
                !dtmfEligibility.allowed ? (dtmfEligibility.reason ?? "DTMF is not available yet") : undefined
              }
              type="button"
            >
              {digit}
            </button>
          ))}
        </div>
      </details>
      {!dtmfEligibility.allowed && dtmfEligibility.reason && (
        <p className="action-hint">{dtmfEligibility.reason}</p>
      )}
      <div className="timeline">
        {activeCall.timeline.map((item) => (
          <div className="timeline-item" key={`${item.at}-${item.label}`}>
            <span>{item.at}</span>
            <p>{item.label}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function useActiveCallDuration(activeCall: ActiveCallUi | null): number {
  const callId = activeCall?.id ?? null;
  const serverDurationSeconds = activeCall?.durationSeconds ?? 0;
  const [durationSeconds, setDurationSeconds] = useState(serverDurationSeconds);
  const clockRef = useRef<{ callId: string; startedAt: number } | null>(null);

  useEffect(() => {
    if (!callId) {
      clockRef.current = null;
      setDurationSeconds(0);
      return;
    }

    const serverStartedAt = Date.now() - serverDurationSeconds * 1000;
    if (clockRef.current?.callId !== callId) {
      clockRef.current = { callId, startedAt: serverStartedAt };
    } else {
      clockRef.current.startedAt = Math.min(clockRef.current.startedAt, serverStartedAt);
    }
    setDurationSeconds(Math.floor((Date.now() - clockRef.current.startedAt) / 1000));
  }, [callId, serverDurationSeconds]);

  useEffect(() => {
    if (!callId) return undefined;
    const interval = window.setInterval(() => {
      const clock = clockRef.current;
      if (clock?.callId === callId) {
        setDurationSeconds(Math.floor((Date.now() - clock.startedAt) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [callId]);

  return callId ? durationSeconds : 0;
}

type ActiveCallUi = NonNullable<AgentDeskResponse["activeCall"]> & { campaignName?: string };

function formatVoicemailSignal(signal: NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"]): {
  detail: string;
  label: string;
} {
  if (signal === "detected") {
    return { detail: "Beep or voicemail signal detected", label: "Detected" };
  }
  if (signal === "possible") {
    return { detail: "Detection is not yet conclusive", label: "Possible VM" };
  }
  return { detail: "Listening during the connected call", label: "Listening" };
}
