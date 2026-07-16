import { describe, expect, it, vi } from "vitest";
import { BrowserMediaTelemetryCollector, microphoneConstraints } from "./browser-media";

describe("browser media telemetry", () => {
  it("requests mono browser audio processing without forcing an 8 kHz capture rate", () => {
    expect(microphoneConstraints).toEqual({
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    });
    expect(microphoneConstraints).not.toHaveProperty("sampleRate");
  });

  it("summarizes browser playout, remote receive, microphone and ICE evidence", async () => {
    const report = new Map<string, Record<string, unknown>>([
      ["in-codec", { id: "in-codec", type: "codec", mimeType: "audio/PCMU" }],
      ["out-codec", { id: "out-codec", type: "codec", mimeType: "audio/PCMU" }],
      [
        "inbound",
        {
          id: "inbound",
          type: "inbound-rtp",
          kind: "audio",
          codecId: "in-codec",
          packetsReceived: 1_000,
          packetsLost: 4,
          packetsDiscarded: 2,
          jitter: 0.018,
          jitterBufferDelay: 24,
          jitterBufferEmittedCount: 1_000,
          concealedSamples: 80,
          totalSamplesReceived: 80_000,
          concealmentEvents: 2,
          totalAudioEnergy: 12,
          totalSamplesDuration: 10
        }
      ],
      [
        "outbound",
        {
          id: "outbound",
          type: "outbound-rtp",
          kind: "audio",
          codecId: "out-codec",
          packetsSent: 900,
          bytesSent: 144_000
        }
      ],
      [
        "remote-inbound",
        {
          id: "remote-inbound",
          type: "remote-inbound-rtp",
          kind: "audio",
          packetsLost: 3,
          jitter: 0.022,
          roundTripTime: 0.11
        }
      ],
      ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
      [
        "pair",
        {
          id: "pair",
          type: "candidate-pair",
          localCandidateId: "local",
          remoteCandidateId: "remote"
        }
      ],
      [
        "local",
        {
          id: "local",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "udp"
        }
      ],
      ["remote", { id: "remote", type: "remote-candidate", candidateType: "host" }]
    ]);
    const getSettings = vi.fn(() => ({
      sampleRate: 48_000,
      sampleSize: 16,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      latency: 0.01
    }));
    const peerConnection = {
      getSenders: () => [{ track: { kind: "audio", getSettings } }],
      getStats: async () => report as unknown as RTCStatsReport
    } as unknown as RTCPeerConnection;

    const collector = new BrowserMediaTelemetryCollector(peerConnection);
    await collector.sample();
    const snapshot = collector.snapshot();

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      sampleCount: 1,
      microphone: {
        sampleRate: 48_000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      inbound: {
        codec: "PCMU",
        packetsReceived: 1_000,
        packetsLost: 4,
        packetsDiscarded: 2,
        jitterSecondsMax: 0.018,
        concealedSamples: 80,
        totalSamplesReceived: 80_000
      },
      outbound: {
        codec: "PCMU",
        packetsSent: 900,
        remotePacketsLost: 3,
        remoteJitterSecondsMax: 0.022,
        roundTripTimeSecondsMax: 0.11
      },
      connection: {
        localCandidateType: "relay",
        remoteCandidateType: "host",
        protocol: "udp",
        relayProtocol: "udp"
      }
    });

    report.clear();
    await collector.sample();
    expect(collector.snapshot()).toMatchObject({
      sampleCount: 2,
      inbound: { packetsReceived: 1_000, packetsLost: 4, concealedSamples: 80 },
      outbound: { packetsSent: 900, remotePacketsLost: 3 }
    });
  });
});
