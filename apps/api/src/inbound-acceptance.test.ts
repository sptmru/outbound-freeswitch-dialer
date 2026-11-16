import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { inboundConnectionPolicy, inboundRetryDelay } from "./inbound-acceptance.js";
import { inboundConnectionCommand } from "./inbound-connection.js";
import type { DurableCommand } from "./call-executor.js";
test("E02.4 U: fake-time retry/backoff has three attempts and original-deadline inclusive bound", () => {
  assert.equal(inboundRetryDelay(1, 1000, 11500), 500);
  assert.equal(inboundRetryDelay(1, 1000, 11499), null);
  assert.equal(inboundRetryDelay(2, 1000, 12000), 1000);
  for (const n of [0, 3, 4, 1.1]) assert.equal(inboundRetryDelay(n, 0, 100000), null);
  assert.equal(inboundConnectionPolicy.connectMs, 10000);
  assert.equal(inboundRetryDelay(2, 90000, 100000), null);
});
test("E02 U: fixed originate/bridge/guard/cleanup commands use one verified D01 contact and correlation", () => {
  const username = `desk_${randomUUID().replaceAll("-", "")}`,
    agentUuid = randomUUID(),
    callId = randomUUID();
  const endpoint = `sofia/internal-webrtc/sip:${username}@127.0.0.2:5080;transport=udp`;
  const op = {
    id: randomUUID(),
    call_id: callId,
    target_uuid: agentUuid,
    request: {
      inboundConnection: true,
      agentUuid,
      endpoint,
      sipUsername: username,
      connectionAction: "originate",
      intent: { deskSessionId: randomUUID(), bindingGeneration: "9007199254740993" }
    }
  } as unknown as DurableCommand;
  const command = inboundConnectionCommand(op);
  assert.ok(command.startsWith(`originate {origination_uuid=${agentUuid},`));
  assert.ok(command.endsWith(`${endpoint} &park()`));
  assert.ok(command.includes(`sip_h_X-Outbound-Dialer-Operation-ID=${op.id}`));
  assert.ok(command.includes(`sip_h_X-Outbound-Dialer-Leg-ID=${agentUuid}`));
  for (const bad of [
    `${endpoint},${endpoint}`,
    `${endpoint}|${endpoint}`,
    `${endpoint}\nshutdown`,
    endpoint.replace("internal-webrtc", "external"),
    "{execute_on_answer=system}" + endpoint
  ])
    assert.throws(() => inboundConnectionCommand({ ...op, request: { ...op.request, endpoint: bad } }));
  assert.equal(
    inboundConnectionCommand({ ...op, request: { ...op.request, connectionAction: "bridge" } }),
    `uuid_bridge ${callId} ${agentUuid}`
  );
  assert.equal(
    inboundConnectionCommand({ ...op, request: { ...op.request, connectionAction: "cancel_guard" } }),
    `sched_del ${callId}`
  );
  assert.equal(
    inboundConnectionCommand({ ...op, request: { ...op.request, connectionAction: "cleanup" } }),
    `uuid_kill ${agentUuid} NORMAL_CLEARING`
  );
});
