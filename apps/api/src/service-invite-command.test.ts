import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { serviceInviteCommand } from "./service-invite-command.js";
import type { DurableCommand } from "./call-executor.js";

test("E04.3 U: inbound, native outbound and transfer share exact pinned endpoint and immutable media identities", () => {
  const username = `desk_${randomUUID().replaceAll("-", "")}`;
  const endpoint = `sofia/internal-webrtc/sip:${username}@127.0.0.1:1234;transport=ws`;
  const op = {
    id: randomUUID(),
    call_id: randomUUID(),
    target_uuid: randomUUID(),
    request: {
      endpoint,
      sipUsername: username,
      intent: { deskSessionId: randomUUID(), bindingGeneration: "9007199254740993" }
    }
  } as unknown as DurableCommand;
  for (const command_kind of ["originate", "rebridge"] as const) {
    const command = serviceInviteCommand({ ...op, command_kind });
    assert.ok(command.endsWith(`${endpoint} &park()`));
    assert.ok(command.includes("media_webrtc=true"));
    assert.ok(command.includes(`sip_h_X-Outbound-Dialer-Leg-ID=${op.target_uuid}`));
    assert.ok(command.includes(`sip_h_X-Outbound-Dialer-Operation-ID=${op.id}`));
    assert.ok(command.includes("Binding-Generation=9007199254740993"));
    assert.ok(!command.includes("user/"));
  }
  for (const change of [
    { endpoint: `user/${username}@fixture.invalid` },
    { endpoint: `${endpoint}|sofia/external/attacker` },
    { endpoint: `{execute_on_answer=system}${endpoint}` },
    { intent: { ...(op.request.intent as object), bindingGeneration: "1},execute_on_answer=system" } }
  ])
    assert.throws(() => serviceInviteCommand({ ...op, request: { ...op.request, ...change } }));
  assert.throws(() => serviceInviteCommand({ ...op, id: "bad" }));
});
