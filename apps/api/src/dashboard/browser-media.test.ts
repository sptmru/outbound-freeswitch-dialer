import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserMediaTelemetryRequest } from "@outbound-dialer/shared";
import type pg from "pg";
import { browserMediaTelemetrySchema, upsertBrowserMediaTelemetry } from "./browser-media.js";

const telemetry: BrowserMediaTelemetryRequest = {
  schemaVersion: 1,
  startedAt: "2026-07-16T10:00:00.000Z",
  endedAt: "2026-07-16T10:01:00.000Z",
  sampleCount: 12,
  microphone: {
    sampleRate: 48_000,
    sampleSize: 16,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    latencySeconds: 0.01
  },
  inbound: {
    codec: "PCMU",
    packetsReceived: 3_000,
    packetsLost: 3,
    packetsDiscarded: 1,
    jitterSecondsMax: 0.02,
    jitterBufferDelaySeconds: 50,
    jitterBufferEmittedCount: 3_000,
    concealedSamples: 80,
    totalSamplesReceived: 480_000,
    concealmentEvents: 2,
    audioEnergy: 10,
    audioDurationSeconds: 60
  },
  outbound: {
    codec: "PCMU",
    packetsSent: 3_000,
    bytesSent: 480_000,
    remotePacketsLost: 2,
    remoteJitterSecondsMax: 0.018,
    roundTripTimeSecondsMax: 0.12
  },
  connection: {
    localCandidateType: "host",
    remoteCandidateType: "host",
    protocol: "udp",
    relayProtocol: null
  }
};

describe("browser media telemetry persistence", () => {
  it("validates bounded call summaries and rejects reversed timestamps", () => {
    assert.deepEqual(browserMediaTelemetrySchema.parse(telemetry), telemetry);
    assert.throws(() =>
      browserMediaTelemetrySchema.parse({
        ...telemetry,
        endedAt: "2026-07-16T09:59:00.000Z"
      })
    );
  });

  it("binds telemetry to a call owned by the authenticated agent", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [{ owned: true }] };
      }
    } as unknown as pg.Pool;

    assert.equal(
      await upsertBrowserMediaTelemetry(pool, {
        callId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        telemetry
      }),
      true
    );
    assert.match(queries[0]?.sql ?? "", /agents\.user_id = \$2/);
    assert.match(queries[0]?.sql ?? "", /on conflict \(call_id\) do update/);
    assert.equal(queries[0]?.params[0], "11111111-1111-4111-8111-111111111111");
    assert.equal(queries[0]?.params[1], "22222222-2222-4222-8222-222222222222");
    assert.deepEqual(JSON.parse(String(queries[0]?.params[2])), telemetry);
  });
});
