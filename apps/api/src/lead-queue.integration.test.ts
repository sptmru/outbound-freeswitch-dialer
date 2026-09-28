import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import pg from "pg";
import { __testing as callsTesting } from "./dashboard/calls.js";
import { getLeadQueue } from "./dashboard/responders.js";
import { runMigrations } from "./db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL next-lead ordering", { skip: !databaseUrl }, () => {
  it("claims the displayed next lead across tied import timestamps and skips concurrent claims", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    const campaignId = randomUUID();
    const contactIds = Array.from({ length: 60 }, () => randomUUID()).sort();
    const retryPolicy = { maxAttempts: 3, retryDelaySeconds: 900 };
    try {
      await runMigrations(pool);
      await pool.query("insert into campaigns (id, name, status) values ($1, $2, 'active')", [
        campaignId,
        "Tied import ordering regression"
      ]);
      // One statement gives every contact the same created_at, as in a CSV import.
      // Reverse UUID order prevents heap order from accidentally satisfying the test.
      await pool.query(
        `insert into contacts (id, campaign_id, phone_number, normalized_phone_number)
         select id, $1, '+1415555' || lpad(ordinality::text, 4, '0'),
                '+1415555' || lpad(ordinality::text, 4, '0')
         from unnest($2::uuid[]) with ordinality as input(id, ordinality)`,
        [campaignId, [...contactIds].reverse()]
      );

      const firstAgent = await pool.connect();
      const secondAgent = await pool.connect();
      try {
        await firstAgent.query("begin");
        await secondAgent.query("begin");
        const queue = await getLeadQueue(pool, campaignId, retryPolicy);
        const first = await callsTesting.getNextCallableContactForUpdate(firstAgent, campaignId, retryPolicy);
        assert.equal(first?.id, queue[0]?.id);
        const second = await callsTesting.getNextCallableContactForUpdate(
          secondAgent,
          campaignId,
          retryPolicy
        );
        assert.equal(second?.id, queue[1]?.id);
      } finally {
        await firstAgent.query("rollback");
        await secondAgent.query("rollback");
        firstAgent.release();
        secondAgent.release();
      }

      const client = await pool.connect();
      try {
        // Traverse beyond the desk's 25-row limit, checking both fresh and retry ties.
        for (const attempt of [0, 1]) {
          if (attempt) {
            await pool.query(
              `update contacts set status = 'new', attempt_count = 1,
                 last_attempted_at = now() - interval '1 hour' where campaign_id = $1`,
              [campaignId]
            );
          }
          for (const expectedId of contactIds) {
            const queue = await getLeadQueue(pool, campaignId, retryPolicy);
            await client.query("begin");
            const next = await callsTesting.getNextCallableContactForUpdate(client, campaignId, retryPolicy);
            assert.equal(next?.id, queue.find((lead) => lead.status === "ready")?.id);
            assert.equal(next?.id, expectedId);
            await client.query("update contacts set status = 'completed' where id = $1", [next!.id]);
            await client.query("commit");
          }
          assert.equal(
            await callsTesting.getNextCallableContactForUpdate(client, campaignId, retryPolicy),
            null
          );
        }
      } finally {
        await client.query("rollback");
        client.release();
      }
    } finally {
      await pool.query("delete from campaigns where id = $1", [campaignId]);
      await pool.end();
    }
  });
});
