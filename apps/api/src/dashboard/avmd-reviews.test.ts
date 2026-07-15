import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { upsertCallAvmdReview } from "./avmd-reviews.js";

const callId = "11111111-1111-4111-8111-111111111111";
const reviewerUserId = "22222222-2222-4222-8222-222222222222";

describe("AVMD reviews", () => {
  it("upserts a trimmed review with reviewer provenance", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const reviewedAt = new Date("2026-07-15T10:00:00.000Z");
    const updatedAt = new Date("2026-07-15T10:01:00.000Z");
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("as avmd_attempted")) {
          return rows([
            { answered_at: reviewedAt, avmd_attempted: true, ended_at: updatedAt, state: "completed" }
          ]);
        }
        return rows([
          {
            actual_party: "machine",
            notes: "Confirmed greeting",
            reviewed_by_name: "Admin",
            reviewed_at: reviewedAt,
            updated_at: updatedAt
          }
        ]);
      }
    } as unknown as pg.Pool;

    const result = await upsertCallAvmdReview(pool, {
      callId,
      actualParty: "machine",
      notes: "  Confirmed greeting  ",
      reviewerUserId
    });

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(queries[1]?.params, [callId, "machine", "Confirmed greeting", reviewerUserId]);
    assert.deepEqual(result.review, {
      actualParty: "machine",
      notes: "Confirmed greeting",
      reviewedByName: "Admin",
      reviewedAt: reviewedAt.toISOString(),
      updatedAt: updatedAt.toISOString()
    });
  });

  it("rejects calls without a completed answer", async () => {
    const pool = {
      query: async () =>
        rows([{ answered_at: null, avmd_attempted: true, ended_at: new Date(), state: "failed" }])
    } as unknown as pg.Pool;
    assert.deepEqual(
      await upsertCallAvmdReview(pool, {
        callId,
        actualParty: "human",
        reviewerUserId
      }),
      { status: "not_eligible" }
    );
  });
});

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
