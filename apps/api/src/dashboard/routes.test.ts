import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { __testing } from "./routes.js";

const selectedCampaignId = "11111111-1111-4111-8111-111111111111";

const config = {
  DEFAULT_PHONE_COUNTRY_CODE: "US"
} as AppConfig;

describe("dashboard route helpers", () => {
  it("parses quoted CSV fields and escaped quotes", () => {
    const parsed = __testing.parseCsv('Name,Phone,Company\n"Doe, Jane","+1 415 555 0100","Acme ""Labs"""');

    assert.deepEqual(parsed.headers, ["Name", "Phone", "Company"]);
    assert.deepEqual(parsed.rows, [["Doe, Jane", "+1 415 555 0100", 'Acme "Labs"']]);
  });

  it("normalizes international phone numbers with 00 prefix", () => {
    assert.deepEqual(__testing.normalizePhoneNumber("0014155550100", "US"), {
      ok: true,
      number: "+14155550100"
    });
  });

  it("marks manual dial validation as blocked when selected campaign disables manual dialing", async () => {
    const pool = createQueryPool((sql) => {
      if (sql.includes("from suppression_entries")) {
        return rows([]);
      }
      if (sql.includes("from campaigns")) {
        return rows([campaignRow({ manual_dialing_enabled: false })]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await __testing.validateDialableNumber(pool, config, "+1 415 555 0100", selectedCampaignId);

    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Manual dialing is disabled for this campaign");
    assert.deepEqual(result.checks.at(-1), {
      label: "Manual dialing",
      status: "fail",
      detail: "Manual dialing is disabled for this campaign"
    });
  });

  it("does not fall back to another campaign for dialer actions when campaignId is selected", async () => {
    const pool = createQueryPool((_sql, params) => {
      assert.deepEqual(params, [selectedCampaignId, false]);
      return rows([]);
    });

    const campaign = await __testing.getAgentCampaignForDialerAction(pool, selectedCampaignId);

    assert.equal(campaign, null);
  });

  it("keeps fallback behavior for default desk campaign selection", async () => {
    const pool = createQueryPool((_sql, params) => {
      assert.deepEqual(params, [null, true]);
      return rows([campaignRow()]);
    });

    const campaign = await __testing.getAgentCampaign(pool);

    assert.equal(campaign?.id, selectedCampaignId);
  });

  it("fails and releases a call when originate is skipped because trunk is not configured", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("returning contact_id")) {
        return rows([{ contact_id: "22222222-2222-4222-8222-222222222222" }]);
      }
      return rows([]);
    });

    await __testing.syncFreeSwitchOriginate(
      pool,
      {
        FREESWITCH_ESL_ENABLED: false
      } as AppConfig,
      {
        agentId: "33333333-3333-4333-8333-333333333333",
        callId: "44444444-4444-4444-8444-444444444444",
        destinationNumber: "+1 415 555 0100",
        sipUsername: "agent1000"
      }
    );

    assert.match(queries[0]?.sql ?? "", /set state = 'failed'/);
    assert.match(queries[1]?.sql ?? "", /update call_legs/);
    assert.doesNotMatch(queries[1]?.sql ?? "", /type = 'customer'/);
    assert.match(queries[4]?.sql ?? "", /insert into call_events/);
    assert.deepEqual(queries[4]?.params.slice(2, 5), [
      "freeswitch_originate_skipped",
      "failed",
      "bgapi originate"
    ]);
  });
});

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}

function campaignRow(overrides: Partial<{
  agent_registered: boolean;
  call_recording_enabled: boolean;
  callable_leads: string;
  id: string;
  manual_dialing_enabled: boolean;
  name: string;
  status: "active" | "paused" | "draft";
}> = {}) {
  return {
    id: selectedCampaignId,
    name: "Selected campaign",
    status: "active" as const,
    manual_dialing_enabled: true,
    call_recording_enabled: false,
    callable_leads: "0",
    agent_registered: false,
    ...overrides
  };
}
