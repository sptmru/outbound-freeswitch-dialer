import type { BrowserMediaTelemetryRequest } from "@outbound-dialer/shared";
import type pg from "pg";
import { z } from "zod";

const nullableCounter = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const nullableMetric = z.number().finite().nonnegative().max(1_000_000_000).nullable();
const nullableShortText = z.string().trim().min(1).max(80).nullable();

export const browserMediaTelemetrySchema = z
  .object({
    schemaVersion: z.literal(1),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    sampleCount: z.number().int().positive().max(100_000),
    microphone: z.object({
      sampleRate: z.number().int().positive().max(384_000).nullable(),
      sampleSize: z.number().int().positive().max(64).nullable(),
      channelCount: z.number().int().positive().max(32).nullable(),
      echoCancellation: z.boolean().nullable(),
      noiseSuppression: z.boolean().nullable(),
      autoGainControl: z.boolean().nullable(),
      latencySeconds: nullableMetric
    }),
    inbound: z.object({
      codec: nullableShortText,
      packetsReceived: nullableCounter,
      packetsLost: nullableCounter,
      packetsDiscarded: nullableCounter,
      jitterSecondsMax: nullableMetric,
      jitterBufferDelaySeconds: nullableMetric,
      jitterBufferEmittedCount: nullableCounter,
      concealedSamples: nullableCounter,
      totalSamplesReceived: nullableCounter,
      concealmentEvents: nullableCounter,
      audioEnergy: nullableMetric,
      audioDurationSeconds: nullableMetric
    }),
    outbound: z.object({
      codec: nullableShortText,
      packetsSent: nullableCounter,
      bytesSent: nullableCounter,
      remotePacketsLost: nullableCounter,
      remoteJitterSecondsMax: nullableMetric,
      roundTripTimeSecondsMax: nullableMetric
    }),
    connection: z.object({
      localCandidateType: nullableShortText,
      remoteCandidateType: nullableShortText,
      protocol: nullableShortText,
      relayProtocol: nullableShortText
    })
  })
  .strict()
  .superRefine((value, context) => {
    const startedAt = new Date(value.startedAt).getTime();
    const endedAt = new Date(value.endedAt).getTime();
    if (endedAt < startedAt) {
      context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt must not precede startedAt" });
    }
    if (endedAt - startedAt > 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "Browser media sample cannot exceed 24 hours"
      });
    }
  }) satisfies z.ZodType<BrowserMediaTelemetryRequest>;

export async function upsertBrowserMediaTelemetry(
  pool: pg.Pool,
  input: { callId: string; userId: string; telemetry: BrowserMediaTelemetryRequest }
): Promise<boolean> {
  const result = await pool.query<{ owned: boolean }>(
    `
      with owned_call as (
        select calls.id
        from calls
        join agents on agents.id = calls.agent_id
        where calls.id = $1
          and agents.user_id = $2
      ), upserted as (
      insert into call_browser_media_stats (
        call_id, schema_version, started_at, ended_at, captured_at, sample_count,
        microphone_sample_rate, microphone_sample_size, microphone_channel_count,
        microphone_echo_cancellation, microphone_noise_suppression,
        microphone_auto_gain_control, microphone_latency_seconds,
        inbound_codec, inbound_packets_received, inbound_packets_lost,
        inbound_packets_discarded, inbound_jitter_seconds_max,
        inbound_jitter_buffer_delay_seconds, inbound_jitter_buffer_emitted_count,
        inbound_concealed_samples, inbound_total_samples_received,
        inbound_concealment_events, inbound_audio_energy, inbound_audio_duration_seconds,
        outbound_codec, outbound_packets_sent, outbound_bytes_sent,
        outbound_remote_packets_lost, outbound_remote_jitter_seconds_max,
        outbound_round_trip_time_seconds_max, local_candidate_type,
        remote_candidate_type, transport_protocol, relay_protocol
      )
      select
        owned_call.id,
        ($3::jsonb->>'schemaVersion')::integer,
        ($3::jsonb->>'startedAt')::timestamptz,
        ($3::jsonb->>'endedAt')::timestamptz,
        now(),
        ($3::jsonb->>'sampleCount')::integer,
        ($3::jsonb#>>'{microphone,sampleRate}')::integer,
        ($3::jsonb#>>'{microphone,sampleSize}')::integer,
        ($3::jsonb#>>'{microphone,channelCount}')::integer,
        ($3::jsonb#>>'{microphone,echoCancellation}')::boolean,
        ($3::jsonb#>>'{microphone,noiseSuppression}')::boolean,
        ($3::jsonb#>>'{microphone,autoGainControl}')::boolean,
        ($3::jsonb#>>'{microphone,latencySeconds}')::double precision,
        $3::jsonb#>>'{inbound,codec}',
        ($3::jsonb#>>'{inbound,packetsReceived}')::bigint,
        ($3::jsonb#>>'{inbound,packetsLost}')::bigint,
        ($3::jsonb#>>'{inbound,packetsDiscarded}')::bigint,
        ($3::jsonb#>>'{inbound,jitterSecondsMax}')::double precision,
        ($3::jsonb#>>'{inbound,jitterBufferDelaySeconds}')::double precision,
        ($3::jsonb#>>'{inbound,jitterBufferEmittedCount}')::bigint,
        ($3::jsonb#>>'{inbound,concealedSamples}')::bigint,
        ($3::jsonb#>>'{inbound,totalSamplesReceived}')::bigint,
        ($3::jsonb#>>'{inbound,concealmentEvents}')::bigint,
        ($3::jsonb#>>'{inbound,audioEnergy}')::double precision,
        ($3::jsonb#>>'{inbound,audioDurationSeconds}')::double precision,
        $3::jsonb#>>'{outbound,codec}',
        ($3::jsonb#>>'{outbound,packetsSent}')::bigint,
        ($3::jsonb#>>'{outbound,bytesSent}')::bigint,
        ($3::jsonb#>>'{outbound,remotePacketsLost}')::bigint,
        ($3::jsonb#>>'{outbound,remoteJitterSecondsMax}')::double precision,
        ($3::jsonb#>>'{outbound,roundTripTimeSecondsMax}')::double precision,
        $3::jsonb#>>'{connection,localCandidateType}',
        $3::jsonb#>>'{connection,remoteCandidateType}',
        $3::jsonb#>>'{connection,protocol}',
        $3::jsonb#>>'{connection,relayProtocol}'
      from owned_call
      on conflict (call_id) do update set
        schema_version = excluded.schema_version,
        started_at = least(call_browser_media_stats.started_at, excluded.started_at),
        ended_at = greatest(call_browser_media_stats.ended_at, excluded.ended_at),
        captured_at = excluded.captured_at,
        sample_count = excluded.sample_count,
        microphone_sample_rate = excluded.microphone_sample_rate,
        microphone_sample_size = excluded.microphone_sample_size,
        microphone_channel_count = excluded.microphone_channel_count,
        microphone_echo_cancellation = excluded.microphone_echo_cancellation,
        microphone_noise_suppression = excluded.microphone_noise_suppression,
        microphone_auto_gain_control = excluded.microphone_auto_gain_control,
        microphone_latency_seconds = excluded.microphone_latency_seconds,
        inbound_codec = excluded.inbound_codec,
        inbound_packets_received = excluded.inbound_packets_received,
        inbound_packets_lost = excluded.inbound_packets_lost,
        inbound_packets_discarded = excluded.inbound_packets_discarded,
        inbound_jitter_seconds_max = excluded.inbound_jitter_seconds_max,
        inbound_jitter_buffer_delay_seconds = excluded.inbound_jitter_buffer_delay_seconds,
        inbound_jitter_buffer_emitted_count = excluded.inbound_jitter_buffer_emitted_count,
        inbound_concealed_samples = excluded.inbound_concealed_samples,
        inbound_total_samples_received = excluded.inbound_total_samples_received,
        inbound_concealment_events = excluded.inbound_concealment_events,
        inbound_audio_energy = excluded.inbound_audio_energy,
        inbound_audio_duration_seconds = excluded.inbound_audio_duration_seconds,
        outbound_codec = excluded.outbound_codec,
        outbound_packets_sent = excluded.outbound_packets_sent,
        outbound_bytes_sent = excluded.outbound_bytes_sent,
        outbound_remote_packets_lost = excluded.outbound_remote_packets_lost,
        outbound_remote_jitter_seconds_max = excluded.outbound_remote_jitter_seconds_max,
        outbound_round_trip_time_seconds_max = excluded.outbound_round_trip_time_seconds_max,
        local_candidate_type = excluded.local_candidate_type,
        remote_candidate_type = excluded.remote_candidate_type,
        transport_protocol = excluded.transport_protocol,
        relay_protocol = excluded.relay_protocol,
        updated_at = now()
      where excluded.sample_count >= call_browser_media_stats.sample_count
      returning call_id
      )
      select exists(select 1 from owned_call) as owned
    `,
    [input.callId, input.userId, JSON.stringify(input.telemetry)]
  );
  return result.rows[0]?.owned === true;
}
