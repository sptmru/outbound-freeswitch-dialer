import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { deleteCampaign } from "./campaigns.js";

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
});
