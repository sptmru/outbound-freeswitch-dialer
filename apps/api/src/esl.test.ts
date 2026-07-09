import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "./config.js";
import { __testing } from "./esl.js";

const config = {
  FREESWITCH_DOMAIN: "dialer.local",
  SIP_TRUNK_MODE: "registration",
  SIP_TRUNK_PROXY: "sip.example.com",
  SIP_TRUNK_USERNAME: "agent",
  SIP_TRUNK_CALLER_ID: undefined
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
