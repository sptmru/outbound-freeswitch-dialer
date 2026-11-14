import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { releaseAgentCallSlot } from "./agent-call-slots.js";

test("B02.2 absent cleanup evidence cannot release or query a slot, including an expired lease", async () => {
  const client = {
    query() {
      throw new Error("Must not access DB without cleanup confirmation");
    }
  } as unknown as pg.PoolClient;
  assert.equal(
    await releaseAgentCallSlot(
      client,
      {
        agentId: "agent",
        callId: "call",
        reservationId: "reservation",
        generation: "9007199254740993"
      },
      false
    ),
    false
  );
});
