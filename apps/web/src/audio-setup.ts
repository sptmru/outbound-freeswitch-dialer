export type MicrophoneProcessingProfile = "office" | "headset" | "natural";

export type AudioSignalStatus = "idle" | "listening" | "good" | "quiet" | "clipping";
export type NetworkReadinessStatus = "ready" | "limited" | "failed";

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export interface AppliedMicrophoneSettings {
  autoGainControl: boolean | null;
  channelCount: number | null;
  deviceId: string | null;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  sampleRate: number | null;
}

export interface AudioCheckResult {
  appliedSettings: AppliedMicrophoneSettings;
  inputPeakPercent: number;
  networkDetail: string;
  networkStatus: NetworkReadinessStatus;
  signalDetail: string;
  signalStatus: Exclude<AudioSignalStatus, "idle" | "listening">;
}

export const microphoneProcessingProfiles: Array<{
  description: string;
  id: MicrophoneProcessingProfile;
  label: string;
}> = [
  {
    id: "office",
    label: "Office",
    description: "Echo, noise and automatic level correction"
  },
  {
    id: "headset",
    label: "Headset",
    description: "Echo and noise correction without automatic gain"
  },
  {
    id: "natural",
    label: "Natural",
    description: "No browser processing; use with a controlled microphone"
  }
];

export function buildMicrophoneConstraints(
  profile: MicrophoneProcessingProfile,
  deviceId: string
): MediaTrackConstraints {
  const processing =
    profile === "office"
      ? { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
      : profile === "headset"
        ? { autoGainControl: false, echoCancellation: true, noiseSuppression: true }
        : { autoGainControl: false, echoCancellation: false, noiseSuppression: false };

  return {
    ...processing,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  };
}

export function readAppliedMicrophoneSettings(track: MediaStreamTrack): AppliedMicrophoneSettings {
  const settings = track.getSettings?.() ?? {};
  return {
    autoGainControl: typeof settings.autoGainControl === "boolean" ? settings.autoGainControl : null,
    channelCount: finiteNumber(settings.channelCount),
    deviceId: typeof settings.deviceId === "string" && settings.deviceId ? settings.deviceId : null,
    echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
    noiseSuppression: typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
    sampleRate: finiteNumber(settings.sampleRate)
  };
}

export function classifyAudioSignal(input: {
  clippedSamples: number;
  maxPeak: number;
  maxRms: number;
  totalSamples: number;
}): Pick<AudioCheckResult, "inputPeakPercent" | "signalDetail" | "signalStatus"> {
  const inputPeakPercent = Math.round(Math.min(1, input.maxPeak) * 100);
  const clippingRate = input.totalSamples ? input.clippedSamples / input.totalSamples : 0;
  if (input.maxPeak >= 0.995 || clippingRate >= 0.001) {
    return {
      inputPeakPercent,
      signalStatus: "clipping",
      signalDetail: "Input clipped. Move the microphone away or lower its input level."
    };
  }
  if (input.maxRms < 0.015 || input.maxPeak < 0.08) {
    return {
      inputPeakPercent,
      signalStatus: "quiet",
      signalDetail: "Input is quiet. Move the microphone closer or raise its input level."
    };
  }
  return {
    inputPeakPercent,
    signalStatus: "good",
    signalDetail: "Microphone level is in a usable range."
  };
}

export function classifyNetworkReadiness(input: {
  candidateTypes: Set<string>;
  registered: boolean;
}): Pick<AudioCheckResult, "networkDetail" | "networkStatus"> {
  if (!input.registered) {
    return {
      networkStatus: "failed",
      networkDetail: "SIP signaling is not connected. Reconnect the phone before calling."
    };
  }
  if (input.candidateTypes.has("relay")) {
    return {
      networkStatus: "ready",
      networkDetail: "SIP signaling and a TURN relay route are available."
    };
  }
  if (input.candidateTypes.has("srflx")) {
    return {
      networkStatus: "ready",
      networkDetail: "SIP signaling and a public UDP candidate are available."
    };
  }
  if (input.candidateTypes.has("host")) {
    return {
      networkStatus: "limited",
      networkDetail: "SIP signaling works, but only a local ICE candidate was confirmed."
    };
  }
  return {
    networkStatus: "failed",
    networkDetail: "SIP signaling works, but the browser could not gather an ICE media route."
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
