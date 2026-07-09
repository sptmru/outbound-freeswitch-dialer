import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicUser } from "@outbound-dialer/shared";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { getAgentCampaign, getAgentCampaignForDialerAction } from "./campaigns.js";
import { createDialerCall, createDialerCallFailureMessage, syncFreeSwitchOriginate } from "./calls.js";
import { parseCsv } from "./csv.js";
import { validateDialableNumber } from "./manual-dial.js";
import { normalizePhoneNumber } from "./phone.js";
import { __testing } from "./routes.js";

const selectedCampaignId = "11111111-1111-4111-8111-111111111111";

const config = {
  DEFAULT_PHONE_COUNTRY_CODE: "US"
} as AppConfig;

describe("dashboard route helpers", () => {
  it("parses quoted CSV fields and escaped quotes", () => {
    const parsed = parseCsv('Name,Phone,Company\n"Doe, Jane","+1 415 555 0100","Acme ""Labs"""');

    assert.deepEqual(parsed.headers, ["Name", "Phone", "Company"]);
    assert.deepEqual(parsed.rows, [["Doe, Jane", "+1 415 555 0100", 'Acme "Labs"']]);
  });

  it("normalizes international phone numbers with 00 prefix", () => {
    assert.deepEqual(normalizePhoneNumber("0014155550100", "US"), {
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

    const result = await validateDialableNumber(pool, config, "+1 415 555 0100", selectedCampaignId);

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
      assert.deepEqual(params, [selectedCampaignId, false, null]);
      return rows([]);
    });

    const campaign = await getAgentCampaignForDialerAction(pool, selectedCampaignId);

    assert.equal(campaign, null);
  });

  it("keeps fallback behavior for default desk campaign selection", async () => {
    const pool = createQueryPool((_sql, params) => {
      assert.deepEqual(params, [null, true, null]);
      return rows([campaignRow()]);
    });

    const campaign = await getAgentCampaign(pool);

    assert.equal(campaign?.id, selectedCampaignId);
  });

  it("scopes server-side registration status to the current user", async () => {
    const userId = "99999999-9999-4999-8999-999999999999";
    const pool = createQueryPool((sql, params) => {
      assert.match(sql, /agents\.registered = true/);
      assert.match(sql, /agents\.user_id = \$3/);
      assert.deepEqual(params, [selectedCampaignId, true, userId]);
      return rows([campaignRow({ agent_registered: true })]);
    });

    const campaign = await getAgentCampaign(pool, selectedCampaignId, { userId });

    assert.equal(campaign?.agent_registered, true);
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

    await syncFreeSwitchOriginate(
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

  it("rolls back call creation when the agent already has an active call", async () => {
    const clientQueries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        clientQueries.push({ sql, params });
        if (sql.includes("from calls") && sql.includes("for update")) {
          return rows([{ id: "active-call" }]);
        }
        return rows([]);
      }
    });

    const result = await createDialerCall(pool, config, {
      agentId: "33333333-3333-4333-8333-333333333333",
      campaignId: selectedCampaignId,
      contactId: null,
      destinationNumber: "+14155550100",
      normalizedDestinationNumber: "+14155550100",
      sipUsername: "agent1000",
      manualDial: true,
      callRecordingEnabled: false,
      eventType: "manual_dial_started"
    });

    assert.deepEqual(result, { ok: false, reason: "active_call" });
    assert.ok(clientQueries.some((query) => query.sql === "rollback"));
    assert.ok(!clientQueries.some((query) => query.sql.includes("insert into calls")));
  });

  it("selects next contacts inside the call transaction with skip locked", async () => {
    const clientQueries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const poolQueries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        clientQueries.push({ sql, params });
        if (sql.includes("from calls") && sql.includes("for update")) {
          return rows([]);
        }
        if (sql.includes("from contacts") && sql.includes("skip locked")) {
          return rows([
            {
              id: "22222222-2222-4222-8222-222222222222",
              campaign_id: selectedCampaignId,
              phone_number: "+1 415 555 0100",
              normalized_phone_number: "+14155550100",
              call_recording_enabled: true
            }
          ]);
        }
        if (sql.includes("from recordings")) {
          return rows([]);
        }
        if (sql.includes("insert into calls")) {
          return rows([{ id: "44444444-4444-4444-8444-444444444444" }]);
        }
        return rows([]);
      },
      poolHandler: (sql, params) => {
        poolQueries.push({ sql, params });
        if (sql.includes("returning contact_id")) {
          return rows([{ contact_id: "22222222-2222-4222-8222-222222222222" }]);
        }
        return rows([]);
      }
    });

    const result = await createDialerCall(
      pool,
      {
        ...config,
        FREESWITCH_DOMAIN: "dialer.local",
        FREESWITCH_ESL_ENABLED: false
      } as AppConfig,
      {
        agentId: "33333333-3333-4333-8333-333333333333",
        campaignId: selectedCampaignId,
        contactId: "next",
        sipUsername: "agent1000",
        manualDial: false,
        callRecordingEnabled: false,
        eventType: "call_next_started"
      }
    );

    assert.deepEqual(result, {
      ok: true,
      callId: "44444444-4444-4444-8444-444444444444",
      campaignId: selectedCampaignId
    });
    assert.ok(clientQueries.some((query) => query.sql.includes("for update of contacts skip locked")));
    assert.ok(clientQueries.some((query) => query.sql === "commit"));
    assert.ok(poolQueries.some((query) => query.sql.includes("set state = 'failed'")));
  });

  it("maps call creation failure reasons to operator-facing messages", () => {
    assert.equal(createDialerCallFailureMessage("active_call"), "An active call is already in progress");
    assert.equal(createDialerCallFailureMessage("no_callable_contacts"), "No callable contacts are available");
    assert.equal(createDialerCallFailureMessage("lead_not_callable"), "Lead is not callable");
  });

  it("returns an explicit empty desk state instead of demo campaign data", async () => {
    const pool = createQueryPool((sql) => {
      if (sql.includes("from campaigns")) {
        return rows([]);
      }
      if (sql.includes("from calls") && sql.includes("join agents")) {
        return rows([]);
      }
      if (sql.includes("today_calls")) {
        return rows([{ today_calls: "0", voicemails_dropped: "0", suppressed: "0" }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const result = await __testing.buildAgentDeskResponse(pool, userRow());
    const serialized = JSON.stringify(result);

    assert.equal(result.campaign, null);
    assert.deepEqual(result.availableCampaigns, []);
    assert.deepEqual(result.leads, []);
    assert.equal(result.activeCall, null);
    assert.equal(result.softphone.status, "offline");
    assert.ok(!serialized.includes("campaign_demo_solar_followup"));
    assert.ok(!serialized.includes("+1 415 555 0148"));
  });
});

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function createTransactionalPool(options: {
  clientHandler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number };
  poolHandler?: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number };
}): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(options.clientHandler(sql, params)),
    release: () => undefined
  };
  return {
    connect: () => Promise.resolve(client),
    query: (sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(options.poolHandler ? options.poolHandler(sql, params) : rows([]))
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

function userRow(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    email: "agent@example.com",
    name: "Agent Example",
    role: "agent",
    ...overrides
  };
}
