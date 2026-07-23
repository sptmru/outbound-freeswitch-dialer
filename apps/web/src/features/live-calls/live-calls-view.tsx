import { useEffect, useRef, useState } from "react";
import { Headphones, Mic, PhoneCall, PhoneOff, Play, Shield, Users } from "lucide-react";
import {
  fetchAdminLiveCalls,
  startSupervisorSession,
  stopSupervisorSession,
  updateSupervisorMode
} from "../../api";
import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatDuration } from "../../lib/formatters";
import type { SupervisorSoftphoneRuntime } from "../../supervisor-softphone";
import type { AdminLiveCallsResponse, SupervisorMode } from "../../types";

export function LiveCallsView({
  refreshVersion,
  softphone
}: {
  refreshVersion: number;
  softphone: SupervisorSoftphoneRuntime;
}) {
  const requestId = useRef(0);
  const [data, setData] = useState<AdminLiveCallsResponse>({ calls: [], activeSession: null });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"start" | "mode" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const refresh = async (showLoading = false) => {
      const currentRequest = ++requestId.current;
      if (showLoading) setLoading(true);
      try {
        const next = await fetchAdminLiveCalls();
        if (!stopped && currentRequest === requestId.current) {
          setData(next);
          setError(null);
        }
      } catch (loadError) {
        if (!stopped && currentRequest === requestId.current) {
          setError(getErrorMessage(loadError, "Could not load live calls"));
        }
      } finally {
        if (!stopped && currentRequest === requestId.current) setLoading(false);
      }
    };
    void refresh(true);
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      stopped = true;
      requestId.current += 1;
      window.clearInterval(interval);
    };
  }, [refreshVersion]);

  async function start(callId: string) {
    setPending("start");
    setError(null);
    try {
      const session = await startSupervisorSession(callId);
      setData((current) => ({ ...current, activeSession: session }));
    } catch (startError) {
      setError(getErrorMessage(startError, "Could not start live monitoring"));
    } finally {
      setPending(null);
    }
  }

  async function changeMode(mode: SupervisorMode) {
    const session = data.activeSession;
    if (!session || session.mode === mode) return;
    if (
      mode === "join" &&
      !window.confirm("Join this conversation? Both the agent and customer will hear your microphone.")
    ) {
      return;
    }
    setPending("mode");
    setError(null);
    try {
      const updated = await updateSupervisorMode(session.id, mode);
      setData((current) => ({ ...current, activeSession: updated }));
    } catch (modeError) {
      setError(getErrorMessage(modeError, "Could not change supervisor mode"));
    } finally {
      setPending(null);
    }
  }

  async function stop() {
    const session = data.activeSession;
    if (!session) return;
    setPending("stop");
    setError(null);
    try {
      await stopSupervisorSession(session.id);
      setData((current) => ({ ...current, activeSession: null }));
    } catch (stopError) {
      setError(getErrorMessage(stopError, "Could not stop live monitoring"));
    } finally {
      setPending(null);
    }
  }

  const activeCall = data.activeSession
    ? (data.calls.find((call) => call.id === data.activeSession?.callId) ?? null)
    : null;
  const phoneReady = softphone.registered;
  return (
    <div className="live-calls-view">
      <section className="panel supervisor-safety-panel">
        <PanelHeader
          icon={Shield}
          title="Supervisor audio"
          meta={phoneReady ? "Phone connected" : "Connecting phone"}
        />
        <p>
          Monitoring always starts listen-only. Microphone access is requested only for coaching or joining,
          and FreeSWITCH enforces the selected mode.
        </p>
        <div className="supervisor-safety-badges">
          <StatusBadge
            label={phoneReady ? "● Supervisor phone ready" : "● Supervisor phone offline"}
            tone={phoneReady ? "good" : "bad"}
          />
          <StatusBadge
            label={softphone.microphoneActive ? "● Microphone live" : "● Microphone off"}
            tone={softphone.microphoneActive ? "bad" : "neutral"}
          />
        </div>
        {softphone.error && (
          <p className="form-error" role="alert">
            {softphone.error}
          </p>
        )}
        {softphone.audioPlaybackState === "blocked" && (
          <button
            className="secondary-action compact-action"
            onClick={() => void softphone.retryRemoteAudio()}
            type="button"
          >
            <Play size={15} />
            Play live audio
          </button>
        )}
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {data.activeSession && (
        <section className="panel active-supervisor-session" aria-live="polite">
          <PanelHeader
            icon={Headphones}
            title={activeCall ? `${activeCall.agentName} · ${activeCall.leadName}` : "Live monitoring"}
            meta={data.activeSession.state === "active" ? "Connected" : "Connecting"}
          />
          <div className="supervisor-mode-grid" role="group" aria-label="Supervisor mode">
            <button
              className={data.activeSession.mode === "listen" ? "mode-button active" : "mode-button"}
              disabled={pending !== null || data.activeSession.state !== "active"}
              onClick={() => void changeMode("listen")}
              type="button"
            >
              <Headphones size={17} />
              <strong>Listen</strong>
              <span>Microphone off</span>
            </button>
            <button
              className={data.activeSession.mode === "whisper" ? "mode-button active" : "mode-button"}
              disabled={pending !== null || data.activeSession.state !== "active"}
              onClick={() => void changeMode("whisper")}
              type="button"
            >
              <Mic size={17} />
              <strong>Coach agent</strong>
              <span>Only the agent hears you</span>
            </button>
            <button
              className={
                data.activeSession.mode === "join" ? "mode-button danger active" : "mode-button danger"
              }
              disabled={pending !== null || data.activeSession.state !== "active"}
              onClick={() => void changeMode("join")}
              type="button"
            >
              <Users size={17} />
              <strong>Join call</strong>
              <span>Both parties hear you</span>
            </button>
          </div>
          <button
            className="secondary-action supervisor-stop"
            disabled={pending !== null || data.activeSession.state !== "active"}
            onClick={() => void stop()}
            type="button"
          >
            <PhoneOff size={16} />
            {pending === "stop"
              ? "Disconnecting"
              : data.activeSession.state === "connecting"
                ? "Connecting"
                : "Stop monitoring"}
          </button>
        </section>
      )}

      <section className="panel">
        <PanelHeader icon={PhoneCall} title="Active conversations" meta={`${data.calls.length} available`} />
        {loading ? (
          <p className="empty-copy">Loading live calls</p>
        ) : data.calls.length === 0 ? (
          <p className="empty-copy">No connected agent calls are available right now.</p>
        ) : (
          <div className="live-call-list">
            {data.calls.map((call) => {
              const selected = data.activeSession?.callId === call.id;
              return (
                <article className={selected ? "live-call-row selected" : "live-call-row"} key={call.id}>
                  <div>
                    <strong>{call.agentName}</strong>
                    <span>
                      {call.leadName} · {call.phoneNumber}
                    </span>
                    <small>
                      {call.campaignName} · {formatDuration(call.durationSeconds)}
                    </small>
                  </div>
                  <div className="live-call-actions">
                    {call.activeSupervisorCount > 0 && (
                      <span>
                        {call.activeSupervisorCount} supervisor{call.activeSupervisorCount === 1 ? "" : "s"}
                      </span>
                    )}
                    <button
                      className="primary-action compact-action"
                      disabled={!phoneReady || pending !== null || Boolean(data.activeSession)}
                      onClick={() => void start(call.id)}
                      type="button"
                    >
                      <Headphones size={15} />
                      {selected ? "Listening" : "Listen"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
