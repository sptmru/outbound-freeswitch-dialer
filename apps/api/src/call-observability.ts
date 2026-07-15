import type pg from "pg";

export type CallLegType = "agent" | "customer";

type EslFrame = {
  body: string;
  headers: Record<string, string>;
};

const MEDIA_HEADER_NAMES = [
  "variable_rtp_audio_in_packet_count",
  "variable_rtp_audio_out_packet_count",
  "variable_rtp_audio_in_media_packet_count",
  "variable_rtp_audio_out_media_packet_count",
  "variable_rtp_audio_in_mos",
  "variable_rtp_audio_in_quality_percentage"
] as const;

export async function persistCallMediaStats(
  pool: pg.Pool,
  input: {
    callId: string;
    eventName: string;
    frame: EslFrame;
    legType: CallLegType;
    legUuid: string | null;
  }
): Promise<boolean> {
  const headers = input.frame.headers;
  if (!MEDIA_HEADER_NAMES.some((name) => hasNumericHeader(headers, name))) {
    return false;
  }

  const capturedAt = parseFreeSwitchEventTimestamp(headers) ?? new Date();
  await pool.query(
    `
      insert into call_media_stats (
        call_id,
        leg_type,
        freeswitch_uuid,
        source_event_name,
        captured_at,
        read_codec,
        write_codec,
        sip_gateway,
        sip_profile,
        codec_rate,
        codec_ptime,
        inbound_packet_count,
        outbound_packet_count,
        inbound_media_packet_count,
        outbound_media_packet_count,
        inbound_media_bytes,
        outbound_media_bytes,
        inbound_skip_packet_count,
        outbound_skip_packet_count,
        inbound_flaw_total,
        inbound_jitter_packet_count,
        inbound_jitter_loss_rate,
        inbound_jitter_burst_rate,
        inbound_jitter_max_variance,
        inbound_mos,
        inbound_quality_percentage
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
      )
      on conflict (call_id, leg_type) do update
      set freeswitch_uuid = coalesce(excluded.freeswitch_uuid, call_media_stats.freeswitch_uuid),
          source_event_name = excluded.source_event_name,
          captured_at = excluded.captured_at,
          read_codec = excluded.read_codec,
          write_codec = excluded.write_codec,
          sip_gateway = excluded.sip_gateway,
          sip_profile = excluded.sip_profile,
          codec_rate = excluded.codec_rate,
          codec_ptime = excluded.codec_ptime,
          inbound_packet_count = excluded.inbound_packet_count,
          outbound_packet_count = excluded.outbound_packet_count,
          inbound_media_packet_count = excluded.inbound_media_packet_count,
          outbound_media_packet_count = excluded.outbound_media_packet_count,
          inbound_media_bytes = excluded.inbound_media_bytes,
          outbound_media_bytes = excluded.outbound_media_bytes,
          inbound_skip_packet_count = excluded.inbound_skip_packet_count,
          outbound_skip_packet_count = excluded.outbound_skip_packet_count,
          inbound_flaw_total = excluded.inbound_flaw_total,
          inbound_jitter_packet_count = excluded.inbound_jitter_packet_count,
          inbound_jitter_loss_rate = excluded.inbound_jitter_loss_rate,
          inbound_jitter_burst_rate = excluded.inbound_jitter_burst_rate,
          inbound_jitter_max_variance = excluded.inbound_jitter_max_variance,
          inbound_mos = excluded.inbound_mos,
          inbound_quality_percentage = excluded.inbound_quality_percentage,
          updated_at = now()
    `,
    [
      input.callId,
      input.legType,
      input.legUuid,
      input.eventName,
      capturedAt,
      textHeader(headers, "channel-read-codec-name") ?? textHeader(headers, "variable_read_codec"),
      textHeader(headers, "channel-write-codec-name") ?? textHeader(headers, "variable_write_codec"),
      textHeader(headers, "variable_sip_gateway_name"),
      textHeader(headers, "variable_sip_profile_name") ?? textHeader(headers, "variable_sofia_profile_name"),
      integerHeader(headers, "variable_rtp_use_codec_rate") ??
        integerHeader(headers, "channel-read-codec-rate"),
      integerHeader(headers, "variable_rtp_use_codec_ptime"),
      integerHeader(headers, "variable_rtp_audio_in_packet_count"),
      integerHeader(headers, "variable_rtp_audio_out_packet_count"),
      integerHeader(headers, "variable_rtp_audio_in_media_packet_count"),
      integerHeader(headers, "variable_rtp_audio_out_media_packet_count"),
      integerHeader(headers, "variable_rtp_audio_in_media_bytes"),
      integerHeader(headers, "variable_rtp_audio_out_media_bytes"),
      integerHeader(headers, "variable_rtp_audio_in_skip_packet_count"),
      integerHeader(headers, "variable_rtp_audio_out_skip_packet_count"),
      integerHeader(headers, "variable_rtp_audio_in_flaw_total"),
      integerHeader(headers, "variable_rtp_audio_in_jitter_packet_count"),
      decimalHeader(headers, "variable_rtp_audio_in_jitter_loss_rate"),
      decimalHeader(headers, "variable_rtp_audio_in_jitter_burst_rate"),
      decimalHeader(headers, "variable_rtp_audio_in_jitter_max_variance"),
      decimalHeader(headers, "variable_rtp_audio_in_mos"),
      decimalHeader(headers, "variable_rtp_audio_in_quality_percentage")
    ]
  );
  return true;
}

export function parseFreeSwitchEventTimestamp(headers: Record<string, string>): Date | null {
  const raw = headers["event-date-timestamp"]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    try {
      const milliseconds = Number(BigInt(raw) / 1_000n);
      const parsed = new Date(milliseconds);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    } catch {
      // Fall through to the unambiguous GMT header.
    }
  }
  const gmt = headers["event-date-gmt"]?.trim();
  if (!gmt) return null;
  const decoded = decodeFreeSwitchHeader(gmt);
  const milliseconds = Date.parse(decoded);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function decodeFreeSwitchHeader(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function hasNumericHeader(headers: Record<string, string>, name: string): boolean {
  return integerHeader(headers, name) !== null || decimalHeader(headers, name) !== null;
}

function textHeader(headers: Record<string, string>, name: string): string | null {
  const value = headers[name]?.trim();
  return value ? value.slice(0, 160) : null;
}

function integerHeader(headers: Record<string, string>, name: string): string | null {
  const value = headers[name]?.trim();
  return value && /^\d+$/.test(value) ? value : null;
}

function decimalHeader(headers: Record<string, string>, name: string): number | null {
  const value = headers[name]?.trim();
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const __testing = {
  decimalHeader,
  decodeFreeSwitchHeader,
  integerHeader,
  parseFreeSwitchEventTimestamp,
  textHeader
};
