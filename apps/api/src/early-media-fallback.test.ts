import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "./config.js";
import { createEarlyMediaFallbackController } from "./early-media-fallback.js";

const callId = "11111111-1111-4111-8111-111111111111";
const agentLegUuid = "22222222-2222-4222-8222-222222222222";
const customerLegUuid = "33333333-3333-4333-8333-333333333333";
const tone = "%(400,200,400,450);%(400,2000,400,450)";

const config = {
  FREESWITCH_EARLY_MEDIA_FALLBACK_DELAY_MS: 700,
  FREESWITCH_RINGBACK_TONE: tone
} as AppConfig;

function frame(eventName: string, legType: "agent" | "customer", legUuid: string) {
  return {
    headers: {
      "event-name": eventName,
      "unique-id": legUuid,
      variable_outbound_dialer_call_id: callId,
      variable_outbound_dialer_leg_type: legType
    }
  };
}

function createHarness(mediaPacketCounts: number[] = []) {
  const commands: string[] = [];
  let scheduled: (() => void) | null = null;
  const controller = createEarlyMediaFallbackController(
    config,
    { info: () => undefined, warn: () => undefined },
    {
      clearTimer: () => {
        scheduled = null;
      },
      sendApiCommand: async (_config, command) => {
        commands.push(command);
        return {
          body: command.includes("rtp_audio_in_media_packet_count")
            ? String(mediaPacketCounts.shift() ?? 0)
            : "+OK Success\n",
          headers: {},
          raw: ""
        };
      },
      setTimer: (callback) => {
        scheduled = callback;
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      }
    }
  );
  return {
    commands,
    controller,
    fireTimer: () => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    },
    hasTimer: () => scheduled !== null
  };
}

describe("early media fallback", () => {
  it("does not generate local ringback when callee RTP arrives during the grace period", async () => {
    const harness = createHarness([8]);
    harness.controller.handle(frame("CHANNEL_CREATE", "agent", agentLegUuid));
    harness.controller.handle(frame("CHANNEL_CREATE", "customer", customerLegUuid));
    assert.equal(harness.hasTimer(), true);

    harness.fireTimer();
    await harness.controller.waitForIdle();

    assert.deepEqual(harness.commands, [
      `uuid_set_media_stats ${customerLegUuid}`,
      `uuid_getvar ${customerLegUuid} rtp_audio_in_media_packet_count`
    ]);
    assert.equal(harness.hasTimer(), false);
  });

  it("actively generates local ringback after zero-RTP silence and stops it when callee RTP appears", async () => {
    const harness = createHarness([0, 12]);
    harness.controller.handle(frame("CHANNEL_CREATE", "agent", agentLegUuid));
    harness.controller.handle(frame("CHANNEL_CREATE", "customer", customerLegUuid));

    harness.fireTimer();
    await harness.controller.waitForIdle();
    assert.deepEqual(harness.commands, [
      `uuid_set_media_stats ${customerLegUuid}`,
      `uuid_getvar ${customerLegUuid} rtp_audio_in_media_packet_count`,
      `uuid_setvar ${customerLegUuid} api_on_answer uuid_break ${agentLegUuid} all`,
      `uuid_broadcast ${agentLegUuid} tone_stream://${tone};loops=-1 aleg`
    ]);
    assert.equal(
      harness.commands.some((command) => command.includes("uuid_displace")),
      false
    );
    assert.equal(harness.hasTimer(), true);

    harness.fireTimer();
    await harness.controller.waitForIdle();
    assert.deepEqual(harness.commands, [
      `uuid_set_media_stats ${customerLegUuid}`,
      `uuid_getvar ${customerLegUuid} rtp_audio_in_media_packet_count`,
      `uuid_setvar ${customerLegUuid} api_on_answer uuid_break ${agentLegUuid} all`,
      `uuid_broadcast ${agentLegUuid} tone_stream://${tone};loops=-1 aleg`,
      `uuid_set_media_stats ${customerLegUuid}`,
      `uuid_getvar ${customerLegUuid} rtp_audio_in_media_packet_count`,
      `uuid_break ${agentLegUuid} all`
    ]);
  });

  it("cancels a pending fallback when the customer answers", async () => {
    const harness = createHarness();
    harness.controller.handle(frame("CHANNEL_CREATE", "agent", agentLegUuid));
    harness.controller.handle(frame("CHANNEL_CREATE", "customer", customerLegUuid));
    harness.controller.handle(frame("CHANNEL_ANSWER", "customer", customerLegUuid));

    assert.equal(harness.hasTimer(), false);
    harness.fireTimer();
    await harness.controller.waitForIdle();
    assert.deepEqual(harness.commands, []);
  });

  it("stops an active fallback when the customer answers", async () => {
    const harness = createHarness([0]);
    harness.controller.handle(frame("CHANNEL_CREATE", "agent", agentLegUuid));
    harness.controller.handle(frame("CHANNEL_CREATE", "customer", customerLegUuid));
    harness.fireTimer();
    await harness.controller.waitForIdle();

    harness.controller.handle(frame("CHANNEL_ANSWER", "customer", customerLegUuid));
    await harness.controller.waitForIdle();

    assert.equal(harness.commands.at(-1), `uuid_break ${agentLegUuid} all`);
    assert.equal(harness.hasTimer(), false);
  });
});
