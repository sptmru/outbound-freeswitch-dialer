import type { BrowserMediaTelemetryRequest } from "./types";

type AudioRtpStats = RTCStats & {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  packetsReceived?: number;
  packetsLost?: number;
  packetsDiscarded?: number;
  packetsSent?: number;
  bytesSent?: number;
  jitter?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  concealedSamples?: number;
  totalSamplesReceived?: number;
  concealmentEvents?: number;
  totalAudioEnergy?: number;
  totalSamplesDuration?: number;
  roundTripTime?: number;
  localCandidateId?: string;
  remoteCandidateId?: string;
  selectedCandidatePairId?: string;
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  mimeType?: string;
  nominated?: boolean;
  selected?: boolean;
  state?: string;
};

export const microphoneConstraints: MediaTrackConstraints = {
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true
};

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.max(...present) : null;
}

function codecName(report: RTCStatsReport, codecId: string | undefined): string | null {
  if (!codecId) return null;
  const codec = report.get(codecId) as AudioRtpStats | undefined;
  return typeof codec?.mimeType === "string" ? codec.mimeType.replace(/^audio\//i, "") : null;
}

function isAudio(stats: AudioRtpStats): boolean {
  return stats.kind === "audio" || stats.mediaType === "audio";
}

export class BrowserMediaTelemetryCollector {
  private readonly startedAt = new Date();
  private sampleInFlight: Promise<void> | null = null;
  private sampleCount = 0;
  private microphone: BrowserMediaTelemetryRequest["microphone"] = {
    sampleRate: null,
    sampleSize: null,
    channelCount: null,
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    latencySeconds: null
  };
  private inbound: BrowserMediaTelemetryRequest["inbound"] = {
    codec: null,
    packetsReceived: null,
    packetsLost: null,
    packetsDiscarded: null,
    jitterSecondsMax: null,
    jitterBufferDelaySeconds: null,
    jitterBufferEmittedCount: null,
    concealedSamples: null,
    totalSamplesReceived: null,
    concealmentEvents: null,
    audioEnergy: null,
    audioDurationSeconds: null
  };
  private outbound: BrowserMediaTelemetryRequest["outbound"] = {
    codec: null,
    packetsSent: null,
    bytesSent: null,
    remotePacketsLost: null,
    remoteJitterSecondsMax: null,
    roundTripTimeSecondsMax: null
  };
  private connection: BrowserMediaTelemetryRequest["connection"] = {
    localCandidateType: null,
    remoteCandidateType: null,
    protocol: null,
    relayProtocol: null
  };

  constructor(private readonly peerConnection: RTCPeerConnection) {
    this.captureMicrophoneSettings();
  }

  sample(): Promise<void> {
    if (this.sampleInFlight) return this.sampleInFlight;
    this.sampleInFlight = this.captureSample().finally(() => {
      this.sampleInFlight = null;
    });
    return this.sampleInFlight;
  }

  private async captureSample(): Promise<void> {
    const report = await this.peerConnection.getStats();
    const inbound: AudioRtpStats[] = [];
    const outbound: AudioRtpStats[] = [];
    const remoteInbound: AudioRtpStats[] = [];
    let selectedPair: AudioRtpStats | undefined;

    report.forEach((raw) => {
      const stats = raw as AudioRtpStats;
      if (stats.type === "inbound-rtp" && isAudio(stats)) inbound.push(stats);
      if (stats.type === "outbound-rtp" && isAudio(stats)) outbound.push(stats);
      if (stats.type === "remote-inbound-rtp" && isAudio(stats)) remoteInbound.push(stats);
      if (stats.type === "transport" && stats.selectedCandidatePairId) {
        selectedPair = report.get(stats.selectedCandidatePairId) as AudioRtpStats | undefined;
      }
      if (
        stats.type === "candidate-pair" &&
        (stats.selected || (stats.nominated && stats.state === "succeeded"))
      ) {
        selectedPair = stats;
      }
    });

    this.sampleCount += 1;
    this.captureMicrophoneSettings();
    this.inbound = {
      codec: inbound.map((item) => codecName(report, item.codecId)).find(Boolean) ?? this.inbound.codec,
      packetsReceived:
        sum(inbound.map((item) => nullableNumber(item.packetsReceived))) ?? this.inbound.packetsReceived,
      packetsLost: sum(inbound.map((item) => nullableNumber(item.packetsLost))) ?? this.inbound.packetsLost,
      packetsDiscarded:
        sum(inbound.map((item) => nullableNumber(item.packetsDiscarded))) ?? this.inbound.packetsDiscarded,
      jitterSecondsMax: maximum([
        this.inbound.jitterSecondsMax,
        ...inbound.map((item) => nullableNumber(item.jitter))
      ]),
      jitterBufferDelaySeconds:
        sum(inbound.map((item) => nullableNumber(item.jitterBufferDelay))) ??
        this.inbound.jitterBufferDelaySeconds,
      jitterBufferEmittedCount:
        sum(inbound.map((item) => nullableNumber(item.jitterBufferEmittedCount))) ??
        this.inbound.jitterBufferEmittedCount,
      concealedSamples:
        sum(inbound.map((item) => nullableNumber(item.concealedSamples))) ?? this.inbound.concealedSamples,
      totalSamplesReceived:
        sum(inbound.map((item) => nullableNumber(item.totalSamplesReceived))) ??
        this.inbound.totalSamplesReceived,
      concealmentEvents:
        sum(inbound.map((item) => nullableNumber(item.concealmentEvents))) ?? this.inbound.concealmentEvents,
      audioEnergy:
        sum(inbound.map((item) => nullableNumber(item.totalAudioEnergy))) ?? this.inbound.audioEnergy,
      audioDurationSeconds:
        sum(inbound.map((item) => nullableNumber(item.totalSamplesDuration))) ??
        this.inbound.audioDurationSeconds
    };
    this.outbound = {
      codec: outbound.map((item) => codecName(report, item.codecId)).find(Boolean) ?? this.outbound.codec,
      packetsSent: sum(outbound.map((item) => nullableNumber(item.packetsSent))) ?? this.outbound.packetsSent,
      bytesSent: sum(outbound.map((item) => nullableNumber(item.bytesSent))) ?? this.outbound.bytesSent,
      remotePacketsLost:
        sum(remoteInbound.map((item) => nullableNumber(item.packetsLost))) ?? this.outbound.remotePacketsLost,
      remoteJitterSecondsMax: maximum([
        this.outbound.remoteJitterSecondsMax,
        ...remoteInbound.map((item) => nullableNumber(item.jitter))
      ]),
      roundTripTimeSecondsMax: maximum([
        this.outbound.roundTripTimeSecondsMax,
        ...remoteInbound.map((item) => nullableNumber(item.roundTripTime))
      ])
    };

    if (selectedPair) {
      const local = selectedPair.localCandidateId
        ? (report.get(selectedPair.localCandidateId) as AudioRtpStats | undefined)
        : undefined;
      const remote = selectedPair.remoteCandidateId
        ? (report.get(selectedPair.remoteCandidateId) as AudioRtpStats | undefined)
        : undefined;
      this.connection = {
        localCandidateType: local?.candidateType ?? this.connection.localCandidateType,
        remoteCandidateType: remote?.candidateType ?? this.connection.remoteCandidateType,
        protocol: local?.protocol ?? selectedPair.protocol ?? this.connection.protocol,
        relayProtocol: local?.relayProtocol ?? this.connection.relayProtocol
      };
    }
  }

  snapshot(): BrowserMediaTelemetryRequest | null {
    if (this.sampleCount === 0) return null;
    return {
      schemaVersion: 1,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      sampleCount: this.sampleCount,
      microphone: this.microphone,
      inbound: this.inbound,
      outbound: this.outbound,
      connection: this.connection
    };
  }

  private captureMicrophoneSettings(): void {
    const track = this.peerConnection.getSenders().find((sender) => sender.track?.kind === "audio")?.track;
    const settings = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    if (!settings) return;
    this.microphone = {
      sampleRate: nullableNumber(settings.sampleRate),
      sampleSize: nullableNumber(settings.sampleSize),
      channelCount: nullableNumber(settings.channelCount),
      echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
      noiseSuppression: typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
      autoGainControl: typeof settings.autoGainControl === "boolean" ? settings.autoGainControl : null,
      latencySeconds: nullableNumber(settings.latency)
    };
  }
}
