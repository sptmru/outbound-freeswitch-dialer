import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "./config.js";
import { __testing } from "./esl.js";

const config = {
  FREESWITCH_DOMAIN: "dialer.local",
  SIP_TRUNK_MODE: "registration",
  SIP_TRUNK_PROXY: "sip.example.com",
  SIP_TRUNK_USERNAME: "agent",
  SIP_TRUNK_CALLER_ID: undefined,
  FREESWITCH_RINGBACK_TONE: "%(400,200,400,450);%(400,2000,400,450)"
} as AppConfig;

describe("ESL helpers", () => {
  it("strips non-digits from trunk dial strings", () => {
    assert.equal(
      __testing.buildCustomerDialString(config, "+1 (415) 555-0100"),
      "sofia/gateway/sip-trunk/14155550100"
    );
  });

  it("builds ip-auth dial strings without preserving leading plus", () => {
    assert.equal(
      __testing.buildCustomerDialString(
        {
          ...config,
          SIP_TRUNK_MODE: "ip_auth",
          SIP_TRUNK_PROXY: "10.0.0.10"
        },
        "+374 98 603 436"
      ),
      "sofia/external/37498603436@10.0.0.10"
    );
  });

  it("escapes originate variable delimiters", () => {
    assert.equal(__testing.escapeOriginateVariable("a,b{c}"), "abc");
  });

  it("passes customer early media through for the fallback controller", () => {
    const command = __testing.buildAgentBridgeOriginateCommand(config, {
      agentLegUuid: "11111111-1111-4111-8111-111111111111",
      callId: "22222222-2222-4222-8222-222222222222",
      customerLegUuid: "33333333-3333-4333-8333-333333333333",
      destinationNumber: "+14155550100",
      sipUsername: "agent1000"
    });

    assert.match(command, /bridge_early_media=true/);
    assert.doesNotMatch(command, /ringback=/);
    assert.doesNotMatch(command, /instant_ringback=true/);
    assert.match(command, /sip_h_X-Outbound-Dialer-Call-ID=22222222-2222-4222-8222-222222222222/);
    assert.match(
      command,
      /bridge\(\{[^}]*absolute_codec_string=\^\^:PCMU:PCMA:G729[^}]*\}sofia\/gateway\/sip-trunk\//
    );
    assert.match(command, /ignore_early_media=false,media_bug_answer_req=false/);
  });

  it("parses bgapi job UUIDs from command response body", () => {
    assert.equal(
      __testing.parseJobUuid({
        body: "+OK Job-UUID: 22222222-2222-4222-8222-222222222222\n",
        headers: {},
        raw: ""
      }),
      "22222222-2222-4222-8222-222222222222"
    );
  });

  it("waits for full content-length before parsing ESL responses", () => {
    assert.equal(__testing.parseEslResponse("Content-Type: api/response\nContent-Length: 5\n\n+O"), null);
    assert.deepEqual(__testing.parseEslResponse("Content-Type: api/response\nContent-Length: 5\n\n+OK\n!"), {
      body: "+OK\n!",
      headers: {
        "content-length": "5",
        "content-type": "api/response"
      },
      raw: "Content-Type: api/response\nContent-Length: 5\n\n+OK\n!"
    });
  });
});
