import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { deleteCampaign, resetCampaignLeads } from "./campaigns.js";

describe("campaign lifecycle", () => {
  it("archives a campaign without deleting historical attribution", async () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.includes("select id from campaigns")) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: "campaign-1" }] });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
      release: () => undefined
    } as unknown as pg.PoolClient;
    const pool = {
      connect: () => Promise.resolve(client)
    } as unknown as pg.Pool;

    const result = await deleteCampaign(pool, "campaign-1");

    assert.equal(result, "archived");
    assert.ok(queries.some((sql) => sql.includes("set status = 'archived'")));
    assert.ok(!queries.some((sql) => /delete\s+from\s+campaigns/i.test(sql)));
    assert.ok(!queries.some((sql) => sql.includes("set campaign_id = null")));
    assert.ok(queries.includes("commit"));
  });

  it("resets campaign lead eligibility while preserving call history", async () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.includes("select id from campaigns")) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: "campaign-1" }] });
        }
        if (sql.includes("from calls")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (sql.includes("update contacts")) {
          return Promise.resolve({ rowCount: 3, rows: [] });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
      release: () => undefined
    } as unknown as pg.PoolClient;
    const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;

    const result = await resetCampaignLeads(pool, "campaign-1");

    assert.deepEqual(result, { resetCount: 3 });
    const resetQuery = queries.find((sql) => sql.includes("update contacts")) ?? "";
    assert.match(resetQuery, /status = 'new'/);
    assert.match(resetQuery, /attempt_count = 0/);
    assert.match(resetQuery, /last_attempted_at = null/);
    assert.ok(!queries.some((sql) => /delete\s+from\s+calls/i.test(sql)));
    assert.ok(queries.includes("commit"));
  });

  it("refuses to reset leads while the campaign has an active call", async () => {
    const queries: string[] = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        if (sql.includes("select id from campaigns")) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: "campaign-1" }] });
        }
        if (sql.includes("from calls")) {
          return Promise.resolve({ rowCount: 1, rows: [{ exists: 1 }] });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
      release: () => undefined
    } as unknown as pg.PoolClient;
    const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;

    assert.equal(await resetCampaignLeads(pool, "campaign-1"), "active_call");
    assert.ok(!queries.some((sql) => sql.includes("update contacts")));
    assert.ok(queries.includes("rollback"));
  });
});
