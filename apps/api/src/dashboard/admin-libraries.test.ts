import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { getCsvImportsPage, getUsers, getUsersPage } from "./admin-libraries.js";
import { getCampaigns, getCampaignsPage } from "./campaigns.js";
import { getRecordings, getRecordingsPage } from "./recordings.js";

describe("admin library pagination", () => {
  it("paginates and searches campaigns while preserving aggregate fields", async () => {
    const query = stubQuery([
      {
        id: "campaign-1",
        name: "Summer Sales",
        status: "active",
        loaded: "9",
        callable: "4",
        attempted: "5",
        outcome_distribution: [{ outcome: "answered", count: 2 }],
        manual_dialing_enabled: true,
        call_recording_enabled: false,
        early_media_avmd_enabled: true,
        total_count: "7"
      }
    ]);

    const page = await getCampaignsPage(
      query.pool,
      { q: "  sales  ", page: 2, pageSize: 3 },
      { maxAttempts: 5, retryDelaySeconds: 30 }
    );

    assert.deepEqual(query.params, [5, 30, "sales", 3, 3]);
    assert.match(query.sql, /count\(\*\) over\(\) as total_count/);
    assert.match(query.sql, /campaigns\.name ilike/);
    assert.equal(page.total, 7);
    assert.equal(page.totalPages, 3);
    assert.equal(page.items[0]?.attempted, 5);
  });

  it("paginates recordings and users with searchable fields", async () => {
    const recordingsQuery = stubQuery([
      {
        id: "recording-1",
        name: "Primary greeting",
        runtime_file_path: "/recordings/primary.wav",
        duration_seconds: 12,
        file_size_bytes: 4096,
        is_default: true,
        is_active: true,
        total_count: "4"
      }
    ]);
    const recordings = await getRecordingsPage(recordingsQuery.pool, {
      q: "primary",
      page: 2,
      pageSize: 2
    });
    assert.deepEqual(recordingsQuery.params, ["primary", 2, 2]);
    assert.equal(recordings.totalPages, 2);
    assert.equal(recordings.items[0]?.status, "default");

    const usersQuery = stubQuery([
      {
        id: "user-1",
        email: "agent@example.com",
        name: "Agent One",
        role: "agent",
        isActive: true,
        agentRegistered: false,
        callerId: "15551112222",
        total_count: "6"
      }
    ]);
    const users = await getUsersPage(usersQuery.pool, { q: "agent", page: 1, pageSize: 4 });
    assert.deepEqual(usersQuery.params, ["agent", 4, 0]);
    assert.match(usersQuery.sql, /users\.email ilike/);
    assert.equal(users.totalPages, 2);
    assert.equal(users.items[0]?.agentRegistered, false);
    assert.equal(users.items[0]?.callerId, "15551112222");
    assert.match(usersQuery.sql, /agents\.caller_id as "callerId"/);
    assert.ok(!("total_count" in (users.items[0] ?? {})));
  });

  it("keeps the CSV imports array while adding discoverable totals", async () => {
    const query = stubQuery([
      {
        id: "import-1",
        campaign_id: "campaign-1",
        campaign_name: "Summer Sales",
        filename: "leads.csv",
        status: "completed",
        total_rows: 10,
        imported_rows: 8,
        failed_rows: 1,
        field_mapping_json: { duplicateRows: 1 },
        created_at: new Date("2026-07-13T08:00:00.000Z"),
        completed_at: new Date("2026-07-13T08:01:00.000Z"),
        total_count: "21"
      }
    ]);

    const result = await getCsvImportsPage(query.pool, { q: "summer", page: 2, pageSize: 20 });

    assert.deepEqual(query.params, ["summer", 20, 20]);
    assert.equal(result.total, 21);
    assert.equal(result.totalPages, 2);
    assert.equal(result.imports[0]?.duplicateRows, 1);
  });

  it("loads complete legacy overview libraries instead of fixed silent slices", async () => {
    const campaignsQuery = stubQuery([]);
    await getCampaigns(campaignsQuery.pool);
    assert.deepEqual(campaignsQuery.params.slice(-2), [null, 0]);

    const recordingsQuery = stubQuery([]);
    await getRecordings(recordingsQuery.pool);
    assert.deepEqual(recordingsQuery.params, [null, null, 0]);

    const usersQuery = stubQuery([]);
    await getUsers(usersQuery.pool);
    assert.deepEqual(usersQuery.params, [null, null, 0]);
  });
});

function stubQuery(rows: unknown[]) {
  const captured = { sql: "", params: [] as unknown[] };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      captured.sql = sql;
      captured.params = params;
      return { rowCount: rows.length, rows };
    }
  } as unknown as pg.Pool;

  return {
    pool,
    get sql() {
      return captured.sql;
    },
    get params() {
      return captured.params;
    }
  };
}
