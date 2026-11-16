import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { inboundWaitingCommand } from "./inbound-queue.js";
import type { DurableCommand } from "./call-executor.js";

test("D04 U: waiting transfer rejects injected destinations, paths and deadlines", () => {
  const id = randomUUID();
  const op: DurableCommand = {
    id: randomUUID(),
    call_id: id,
    target_uuid: id,
    command_uuid: randomUUID(),
    command_kind: "play_audio",
    generation: "1",
    state: "pending",
    deadline_at: new Date(Date.now() + 3000),
    result: null,
    request: { inboundWaiting: true, deadlineEpoch: "1794816000", audio: "tone" }
  };
  assert.match(inboundWaitingCommand(op), / XML inbound-wait$/);
  for (const audio of [
    "/runtime/../secret.wav",
    "/runtime/a.wav\napi status",
    "tone &park()",
    "/runtime/a.wav;hangup"
  ])
    assert.throws(() => inboundWaitingCommand({ ...op, request: { ...op.request, audio } }));
  for (const deadlineEpoch of ["NaN", "-1", "1794816000 XML default", "1794816000\napi status"])
    assert.throws(() => inboundWaitingCommand({ ...op, request: { ...op.request, deadlineEpoch } }));
  assert.throws(() => inboundWaitingCommand({ ...op, target_uuid: randomUUID() }));
  assert.throws(() => inboundWaitingCommand({ ...op, id: "bad\napi status" }));
});
