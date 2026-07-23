import { Activity } from "lucide-react";
import { microphoneProcessingProfiles } from "../../audio-setup";
import type { MicrophoneProcessingProfile } from "../../audio-setup";
import type { SoftphoneRuntime } from "../../softphone";
import { StatusBadge } from "../../components/ui-primitives";

export function AudioSetupPanel({ softphone }: { softphone: SoftphoneRuntime }) {
  const setup = softphone.audioSetup;
  const controlsDisabled = setup.checking || softphone.callState !== "none";
  const applied = setup.checkResult?.appliedSettings ?? setup.appliedSettings;
  const signalTone =
    setup.signalStatus === "good"
      ? "good"
      : setup.signalStatus === "quiet"
        ? "warn"
        : setup.signalStatus === "clipping"
          ? "bad"
          : "neutral";
  const signalLabel =
    setup.signalStatus === "listening"
      ? "Listening"
      : setup.signalStatus === "good"
        ? "Level good"
        : setup.signalStatus === "quiet"
          ? "Too quiet"
          : setup.signalStatus === "clipping"
            ? "Clipping"
            : "Not checked";

  return (
    <details className="audio-setup-panel">
      <summary>
        <span>Audio setup</span>
        <StatusBadge label={signalLabel} tone={signalTone} />
      </summary>
      <div className="audio-setup-content">
        <div className="audio-device-grid">
          <label>
            Microphone
            <select
              disabled={controlsDisabled}
              onChange={(event) => softphone.selectMicrophone(event.target.value)}
              value={setup.selectedInputId}
            >
              <option value="">System default</option>
              {setup.inputDevices
                .filter((device) => device.deviceId && device.deviceId !== "default")
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Speaker
            <select
              disabled={controlsDisabled || !setup.outputSelectionSupported}
              onChange={(event) => void softphone.selectSpeaker(event.target.value)}
              value={setup.selectedOutputId}
            >
              <option value="">System default</option>
              {setup.outputDevices
                .filter((device) => device.deviceId && device.deviceId !== "default")
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
            </select>
            {!setup.outputSelectionSupported && (
              <small>Speaker selection is unavailable in this browser.</small>
            )}
          </label>
        </div>
        <label>
          Microphone processing
          <select
            disabled={controlsDisabled}
            onChange={(event) =>
              softphone.setMicrophoneProcessingProfile(event.target.value as MicrophoneProcessingProfile)
            }
            value={setup.processingProfile}
          >
            {microphoneProcessingProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} — {profile.description}
              </option>
            ))}
          </select>
        </label>
        <div className="microphone-level-row">
          <div>
            <span>Input level</span>
            <strong>{Math.round(setup.inputLevel * 100)}%</strong>
          </div>
          <div
            aria-label="Microphone input level"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(setup.inputLevel * 100)}
            className={`microphone-level-meter ${signalTone}`}
            role="progressbar"
          >
            <span style={{ width: `${Math.round(setup.inputLevel * 100)}%` }} />
          </div>
        </div>
        <button
          className="secondary-action compact-action"
          disabled={controlsDisabled || !softphone.microphoneAllowed}
          onClick={() => void softphone.runAudioCheck()}
          type="button"
        >
          <Activity size={16} />
          {setup.checking ? "Checking audio and network" : "Run audio and network check"}
        </button>
        {setup.checkResult && (
          <div className="audio-check-results" aria-live="polite">
            <div>
              <StatusBadge label={signalLabel} tone={signalTone} />
              <small>{setup.checkResult.signalDetail}</small>
            </div>
            <div>
              <StatusBadge
                label={
                  setup.checkResult.networkStatus === "ready"
                    ? "Network ready"
                    : setup.checkResult.networkStatus === "limited"
                      ? "Network limited"
                      : "Network failed"
                }
                tone={
                  setup.checkResult.networkStatus === "ready"
                    ? "good"
                    : setup.checkResult.networkStatus === "limited"
                      ? "warn"
                      : "bad"
                }
              />
              <small>{setup.checkResult.networkDetail}</small>
            </div>
          </div>
        )}
        {applied && (
          <div className="applied-dsp-settings">
            <span>Applied by browser</span>
            <small>
              Echo {formatAppliedSetting(applied.echoCancellation)} · Noise{" "}
              {formatAppliedSetting(applied.noiseSuppression)} · Auto gain{" "}
              {formatAppliedSetting(applied.autoGainControl)}
              {applied.sampleRate ? ` · ${applied.sampleRate.toLocaleString()} Hz` : ""}
              {applied.channelCount ? ` · ${applied.channelCount} channel` : ""}
            </small>
          </div>
        )}
        {setup.checkError && (
          <small className="form-error" role="alert">
            {setup.checkError}
          </small>
        )}
      </div>
    </details>
  );
}

function formatAppliedSetting(value: boolean | null): string {
  return value === null ? "unknown" : value ? "on" : "off";
}
