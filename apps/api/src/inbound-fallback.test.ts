import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { inboundFallbackCommand } from "./inbound-fallback.js";
import type { DurableCommand } from "./call-executor.js";
test("F03 U: fixed retained leg, bounded deadline and safe immutable audio path", () => {
  const id = randomUUID();
  const op: DurableCommand = {
    id: randomUUID(),
    call_id: id,
    target_uuid: id,
    command_uuid: randomUUID(),
    command_kind: "play_audio",
    generation: "1",
    state: "pending",
    deadline_at: new Date(),
    result: null,
    request: { inboundFallback: true, audio: "/a02/file.wav", deadlineEpoch: "1794839000" }
  };
  assert.equal(
    inboundFallbackCommand(op),
    `uuid_transfer ${id} inbound_fallback:${op.id}:1794839000:/a02/file.wav XML inbound-fallback`
  );
  for (const audio of [
    null,
    "/a02/../secret",
    "http://example.test/a.wav",
    "/a02/a.wav XML default",
    "/a02/a.wav\napi status"
  ])
    assert.throws(() => inboundFallbackCommand({ ...op, request: { ...op.request, audio } }));
  for (const deadlineEpoch of ["NaN", "0", "1794839000;status"])
    assert.throws(() => inboundFallbackCommand({ ...op, request: { ...op.request, deadlineEpoch } }));
  assert.throws(() => inboundFallbackCommand({ ...op, target_uuid: randomUUID() }));
  assert.equal(inboundFallbackCommand({ ...op, command_kind: "hangup" }), `uuid_kill ${id} NORMAL_CLEARING`);
});
