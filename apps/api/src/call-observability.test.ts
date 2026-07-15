import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { __testing, persistCallMediaStats } from "./call-observability.js";

describe("call observability", () => {
  it("parses FreeSWITCH microsecond event timestamps without precision drift", () => {
    assert.equal(
      __testing.parseFreeSwitchEventTimestamp({ "event-date-timestamp": "1784092290123456" })?.toISOString(),
      "2026-07-15T05:11:30.123Z"
    );
    assert.equal(__testing.parseFreeSwitchEventTimestamp({ "event-date-timestamp": "invalid" }), null);
    assert.equal(
      __testing
        .parseFreeSwitchEventTimestamp({
          "event-date-timestamp": "invalid",
          "event-date-gmt": "Wed%2C+15+Jul+2026+05%3A11%3A30+GMT"
        })
        ?.toISOString(),
      "2026-07-15T05:11:30.000Z"
    );
  });

  it("persists the bounded media fields from CHANNEL_HANGUP_COMPLETE", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
    } as unknown as pg.Pool;

    const persisted = await persistCallMediaStats(pool, {
      callId: "11111111-1111-4111-8111-111111111111",
      eventName: "CHANNEL_HANGUP_COMPLETE",
      legType: "customer",
      legUuid: "22222222-2222-4222-8222-222222222222",
      frame: {
        body: "",
        headers: {
          "channel-read-codec-name": "PCMU",
          "channel-write-codec-name": "PCMU",
          "event-date-timestamp": "1784092290123456",
          variable_rtp_audio_in_jitter_loss_rate: "0.25",
          variable_rtp_audio_in_media_packet_count: "250",
          variable_rtp_audio_in_mos: "4.42",
          variable_rtp_audio_in_packet_count: "260",
          variable_rtp_audio_out_media_packet_count: "240",
          variable_rtp_audio_out_packet_count: "245",
          variable_sip_gateway_name: "sip-trunk"
        }
      }
    });

    assert.equal(persisted, true);
    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /on conflict \(call_id, leg_type\) do update/);
    assert.equal(queries[0]?.params[5], "PCMU");
    assert.equal(queries[0]?.params[7], "sip-trunk");
    assert.equal(queries[0]?.params[11], "260");
    assert.equal(queries[0]?.params[21], 0.25);
    assert.equal(queries[0]?.params[24], 4.42);
  });

  it("does not create a media observation when the event has no RTP counters", async () => {
    const pool = {
      query: () => Promise.reject(new Error("query should not run"))
    } as unknown as pg.Pool;
    assert.equal(
      await persistCallMediaStats(pool, {
        callId: "11111111-1111-4111-8111-111111111111",
        eventName: "CHANNEL_HANGUP_COMPLETE",
        legType: "agent",
        legUuid: null,
        frame: { body: "", headers: {} }
      }),
      false
    );
  });
});
