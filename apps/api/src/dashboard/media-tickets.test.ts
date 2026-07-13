import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { createMediaTicket, hashTicket, verifyMediaTicket } from "./media-tickets.js";

describe("media access tickets", () => {
  it("stores only a hash and verifies a scoped short-lived ticket", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: sql.includes("returning 1") ? 1 : 0 };
      }
    } as unknown as pg.Pool;

    const created = await createMediaTicket(pool, {
      userId: "11111111-1111-4111-8111-111111111111",
      resourceType: "call_recording",
      resourceId: "22222222-2222-4222-8222-222222222222"
    });
    const insert = queries.find((query) => query.sql.includes("insert into media_access_tickets"));
    assert.ok(insert);
    assert.notEqual(insert.params[0], created.ticket);
    assert.equal(insert.params[0], hashTicket(created.ticket));
    assert.ok(created.expiresAt.getTime() > Date.now());

    assert.equal(
      await verifyMediaTicket(pool, {
        ticket: created.ticket,
        resourceType: "call_recording",
        resourceId: "22222222-2222-4222-8222-222222222222"
      }),
      true
    );
    const verification = queries.at(-1);
    assert.match(verification?.sql ?? "", /users\.is_active = true/);
    assert.match(verification?.sql ?? "", /set expires_at = least/);
    assert.deepEqual(verification?.params, [
      hashTicket(created.ticket),
      "call_recording",
      "22222222-2222-4222-8222-222222222222",
      14_400,
      60
    ]);
  });
});
