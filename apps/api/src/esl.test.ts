import assert from "node:assert/strict";
import net from "node:net";
import { describe, it, type TestContext } from "node:test";
import type { AppConfig } from "./config.js";
import { __testing, sendFreeSwitchApiCommand } from "./esl.js";
import type { DurableCommand } from "./call-executor.js";

async function eslFixture(t: TestContext, onCommand: (socket: net.Socket) => void): Promise<AppConfig> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.write("Content-Type: auth/request\n\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("auth ")) {
          socket.write("Content-Type: command/reply\nReply-Text: +OK accepted\n\n");
        } else if (frame === "connect") {
          socket.write("Content-Type: command/reply\nReply-Text: +OK connected\n\n");
        } else {
          onCommand(socket);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    FREESWITCH_ESL_HOST: "127.0.0.1",
    FREESWITCH_ESL_PORT: (server.address() as net.AddressInfo).port,
    FREESWITCH_ESL_PASSWORD: "fixture-only"
  } as AppConfig;
}

describe("ESL command transport", () => {
  it("rejects promptly when the peer closes before a response", { timeout: 2_000 }, async (t) => {
    const fixture = await eslFixture(t, (socket) => socket.end());
    await assert.rejects(
      sendFreeSwitchApiCommand(fixture, "status"),
      /ESL connection closed before command response/
    );
  });

  it("rejects a truncated response on peer close", { timeout: 2_000 }, async (t) => {
    const fixture = await eslFixture(t, (socket) =>
      socket.end("Content-Type: api/response\nContent-Length: 10\n\n+OK")
    );
    await assert.rejects(
      sendFreeSwitchApiCommand(fixture, "status"),
      /ESL connection closed before command response/
    );
  });

  it("accepts a complete response followed immediately by close", async (t) => {
    const fixture = await eslFixture(t, (socket) =>
      socket.end("Content-Type: api/response\nContent-Length: 4\n\n+OK\n")
    );
    assert.equal((await sendFreeSwitchApiCommand(fixture, "status")).body, "+OK\n");
  });

  it("preserves FreeSWITCH error responses", async (t) => {
    const fixture = await eslFixture(t, (socket) =>
      socket.end("Content-Type: api/response\nContent-Length: 11\n\n-ERR denied")
    );
    await assert.rejects(sendFreeSwitchApiCommand(fixture, "status"), /-ERR denied/);
  });

  it("times out an open silent connection", { timeout: 2_000 }, async (t) => {
    const fixture = await eslFixture(t, () => undefined);
    await assert.rejects(
      __testing.sendFreeSwitchCommand(fixture, "api status", 100),
      /ESL command timed out/
    );
  });

  it("bounds total time even while partial data keeps arriving", { timeout: 2_000 }, async (t) => {
    let chunks = 0;
    const fixture = await eslFixture(t, (socket) => {
      const timer = setInterval(() => {
        chunks += 1;
        socket.write("x");
      }, 20);
      socket.on("close", () => clearInterval(timer));
      t.after(() => clearInterval(timer));
    });
    await assert.rejects(
      __testing.sendFreeSwitchCommand(fixture, "api status", 250),
      /ESL command timed out/
    );
    assert.ok(chunks >= 2);
  });
});

const config = {
  FREESWITCH_DOMAIN: "dialer.local",
  SIP_TRUNK_MODE: "registration",
  SIP_TRUNK_PROXY: "sip.example.com",
  SIP_TRUNK_USERNAME: "agent",
  SIP_TRUNK_CALLER_ID: undefined,
  FREESWITCH_RINGBACK_TONE: "%(400,200,400,450);%(400,2000,400,450)",
  FREESWITCH_TRUNK_JITTER_BUFFER_MSEC: "120:200:20",
  FREESWITCH_WEBRTC_REWRITE_TIMESTAMPS: true
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
    assert.match(
      command,
      /rtp_rewrite_timestamps=true,rtp_autoflush_during_bridge=true,rtp_notimer_during_bridge=false/
    );
    assert.match(
      command,
      /jitterbuffer_msec=120:200:20,rtp_jitter_buffer_during_bridge=true,rtp_jitter_buffer_plc=true,rtp_media_autofix_timing=true,rtp_autoflush_during_bridge=false/
    );
  });

  it("uses a per-call Caller ID instead of the global trunk default", () => {
    const command = __testing.buildAgentBridgeOriginateCommand(
      { ...config, SIP_TRUNK_CALLER_ID: "15550000000" },
      {
        agentLegUuid: "11111111-1111-4111-8111-111111111111",
        callId: "22222222-2222-4222-8222-222222222222",
        callerId: "15551112222",
        customerLegUuid: "33333333-3333-4333-8333-333333333333",
        destinationNumber: "+14155550100",
        sipUsername: "agent1000"
      }
    );

    assert.match(command, /origination_caller_id_number=15551112222/);
    assert.doesNotMatch(command, /origination_caller_id_number=15550000000/);
  });

  it("keeps the global Caller ID fallback when no per-call value is supplied", () => {
    const command = __testing.buildAgentBridgeOriginateCommand(
      { ...config, SIP_TRUNK_CALLER_ID: "15550000000" },
      {
        agentLegUuid: "11111111-1111-4111-8111-111111111111",
        callId: "22222222-2222-4222-8222-222222222222",
        customerLegUuid: "33333333-3333-4333-8333-333333333333",
        destinationNumber: "+14155550100",
        sipUsername: "agent1000"
      }
    );

    assert.match(command, /origination_caller_id_number=15550000000/);
  });

  it("can disable the trunk jitter buffer and WebRTC timestamp rewriting for rollback", () => {
    const command = __testing.buildAgentBridgeOriginateCommand(
      {
        ...config,
        FREESWITCH_TRUNK_JITTER_BUFFER_MSEC: "off",
        FREESWITCH_WEBRTC_REWRITE_TIMESTAMPS: false
      },
      {
        agentLegUuid: "11111111-1111-4111-8111-111111111111",
        callId: "22222222-2222-4222-8222-222222222222",
        customerLegUuid: "33333333-3333-4333-8333-333333333333",
        destinationNumber: "+14155550100",
        sipUsername: "agent1000"
      }
    );

    assert.doesNotMatch(command, /jitterbuffer_msec=/);
    assert.doesNotMatch(command, /rtp_jitter_buffer_/);
    assert.doesNotMatch(command, /rtp_rewrite_timestamps=/);
    assert.doesNotMatch(command, /rtp_notimer_during_bridge=/);
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

  it("builds supervisor monitoring as server-enforced listen-only by default", () => {
    const command = __testing.buildSupervisorEavesdropOriginateCommand(config, {
      callId: "11111111-1111-4111-8111-111111111111",
      mode: "listen",
      sessionId: "22222222-2222-4222-8222-222222222222",
      sipUsername: "supervisor_123",
      supervisorLegUuid: "33333333-3333-4333-8333-333333333333",
      targetAgentLegUuid: "44444444-4444-4444-8444-444444444444"
    });

    assert.match(command, /eavesdrop_enable_dtmf=false/);
    assert.match(command, /eavesdrop_bridge_aleg=true,eavesdrop_bridge_bleg=true/);
    assert.doesNotMatch(command, /eavesdrop_whisper_/);
    assert.doesNotMatch(command, /outbound_dialer_call_id=/);
    assert.match(command, /&eavesdrop\(44444444-4444-4444-8444-444444444444\)$/);
  });

  it("limits whisper to the agent and requires both mux directions for join", () => {
    const input = {
      callId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      sipUsername: "supervisor_123",
      supervisorLegUuid: "33333333-3333-4333-8333-333333333333",
      targetAgentLegUuid: "44444444-4444-4444-8444-444444444444"
    };
    const whisper = __testing.buildSupervisorEavesdropOriginateCommand(config, {
      ...input,
      mode: "whisper"
    });
    const join = __testing.buildSupervisorEavesdropOriginateCommand(config, {
      ...input,
      mode: "join"
    });

    assert.doesNotMatch(whisper, /eavesdrop_whisper_aleg=true/);
    assert.match(whisper, /eavesdrop_whisper_bleg=true/);
    assert.match(join, /eavesdrop_whisper_aleg=true/);
    assert.match(join, /eavesdrop_whisper_bleg=true/);
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

it("E04.3 native outbound constructor replaces AOR lookup with the exact controlling contact and correlation", () => {
  const endpoint =
    "sofia/internal-webrtc/sip:desk_11111111111141118111111111111111@127.0.0.1:7443;transport=ws";
  const operation = {
    id: "44444444-4444-4444-8444-444444444444",
    call_id: "22222222-2222-4222-8222-222222222222",
    command_kind: "originate",
    target_uuid: "11111111-1111-4111-8111-111111111111",
    request: {
      endpoint,
      sipUsername: "desk_11111111111141118111111111111111",
      customerUuid: "33333333-3333-4333-8333-333333333333",
      destinationNumber: "+14155550100",
      intent: { deskSessionId: "55555555-5555-4555-8555-555555555555", bindingGeneration: "2" }
    }
  } as unknown as DurableCommand;
  const config = {
    FREESWITCH_DOMAIN: "fixture.invalid",
    SIP_TRUNK_MODE: "registration",
    SIP_TRUNK_PROXY: "fixture.invalid",
    SIP_TRUNK_USERNAME: "fixture-only",
    SIP_TRUNK_CALLER_ID: "15551112222",
    FREESWITCH_WEBRTC_REWRITE_TIMESTAMPS: true,
    FREESWITCH_TRUNK_JITTER_BUFFER_MSEC: "off"
  } as unknown as AppConfig;
  const input = {
    callId: operation.call_id,
    agentLegUuid: operation.target_uuid!,
    customerLegUuid: String(operation.request.customerUuid),
    destinationNumber: "+14155550100",
    sipUsername: "legacy-agent",
    serviceOperation: operation
  };
  const command = __testing.buildAgentBridgeOriginateCommand(config, input);
  assert.ok(command.includes(`}${endpoint} &bridge(`));
  assert.ok(!command.includes("user/"));
  assert.ok(command.includes(`Operation-ID=${operation.id}`));
  assert.ok(command.includes("rtp_rewrite_timestamps=true"));
  assert.ok(command.includes("bridge_early_media=true"));
  assert.ok(command.includes("origination_caller_id_number=15551112222"));
  assert.ok(command.includes("sofia/gateway/sip-trunk/14155550100"));
  assert.throws(() =>
    __testing.buildAgentBridgeOriginateCommand(config, {
      ...input,
      callId: "66666666-6666-4666-8666-666666666666"
    })
  );
});
