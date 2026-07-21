import { describe, expect, it } from "vitest";
import { buildMicrophoneConstraints, classifyAudioSignal, classifyNetworkReadiness } from "./audio-setup";

describe("audio setup", () => {
  it("builds profile-specific constraints for the selected microphone", () => {
    expect(buildMicrophoneConstraints("office", "mic-2")).toEqual({
      autoGainControl: true,
      channelCount: 1,
      deviceId: { exact: "mic-2" },
      echoCancellation: true,
      noiseSuppression: true
    });
    expect(buildMicrophoneConstraints("headset", "")).toEqual({
      autoGainControl: false,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    });
    expect(buildMicrophoneConstraints("natural", "")).toEqual({
      autoGainControl: false,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false
    });
  });

  it("distinguishes quiet, usable and clipping microphone input", () => {
    expect(
      classifyAudioSignal({ clippedSamples: 0, maxPeak: 0.04, maxRms: 0.008, totalSamples: 1000 })
    ).toMatchObject({ signalStatus: "quiet" });
    expect(
      classifyAudioSignal({ clippedSamples: 0, maxPeak: 0.55, maxRms: 0.09, totalSamples: 1000 })
    ).toMatchObject({ signalStatus: "good", inputPeakPercent: 55 });
    expect(
      classifyAudioSignal({ clippedSamples: 2, maxPeak: 0.999, maxRms: 0.4, totalSamples: 1000 })
    ).toMatchObject({ signalStatus: "clipping" });
  });

  it("reports signaling and the strongest gathered ICE route separately", () => {
    expect(classifyNetworkReadiness({ candidateTypes: new Set(["relay"]), registered: true })).toMatchObject({
      networkStatus: "ready"
    });
    expect(classifyNetworkReadiness({ candidateTypes: new Set(["host"]), registered: true })).toMatchObject({
      networkStatus: "limited"
    });
    expect(classifyNetworkReadiness({ candidateTypes: new Set(["srflx"]), registered: false })).toMatchObject(
      { networkStatus: "failed" }
    );
  });
});
