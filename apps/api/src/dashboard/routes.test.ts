import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PublicUser } from "@outbound-dialer/shared";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { getAgentCampaign, getAgentCampaignForDialerAction } from "./campaigns.js";
import {
  createDialerCall,
  createDialerCallFailureMessage,
  dropVoicemailForCall,
  sendDtmfForCall,
  syncFreeSwitchOriginate
} from "./calls.js";
import { CsvImportError, importContactsFromCsv, parseCsv } from "./csv.js";
import { validateDialableNumber } from "./manual-dial.js";
import { normalizePhoneNumber } from "./phone.js";
import { __testing } from "./routes.js";

const selectedCampaignId = "11111111-1111-4111-8111-111111111111";

const config = {
  DEFAULT_PHONE_COUNTRY_CODE: "US"
} as AppConfig;

describe("dashboard route helpers", () => {
  it("streams the requested audio byte range before completing the async route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-audio-"));
    const filePath = join(directory, "recording.wav");
    const audio = Buffer.from("RIFF-test-audio-body");
    await writeFile(filePath, audio);

    const app = Fastify();
    app.get("/audio", async (request, reply) =>
      __testing.sendAudioFile(request, reply, filePath, "recording.wav", audio.length)
    );

    try {
      const response = await app.inject({
        method: "GET",
        url: "/audio",
        headers: { range: "bytes=5-8" }
      });

      assert.equal(response.statusCode, 206);
      assert.equal(response.headers["content-range"], `bytes 5-8/${audio.length}`);
      assert.equal(response.headers["content-length"], "4");
      assert.deepEqual(response.rawPayload, audio.subarray(5, 9));
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("streams the complete audio file when no byte range is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-audio-"));
    const filePath = join(directory, "recording.wav");
    const audio = Buffer.from("RIFF-complete-audio-body");
    await writeFile(filePath, audio);

    const app = Fastify();
    app.get("/audio", async (request, reply) =>
      __testing.sendAudioFile(request, reply, filePath, "recording.wav", audio.length)
    );

    try {
      const response = await app.inject({ method: "GET", url: "/audio" });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-length"], String(audio.length));
      assert.deepEqual(response.rawPayload, audio);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("streams a PCAP as a protected attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-pcap-download-"));
    const filePath = join(directory, "capture.pcap");
    const capture = Buffer.alloc(64, 7);
    await writeFile(filePath, capture);
    const app = Fastify();
    app.get("/pcap", async (_request, reply) =>
      __testing.sendDownloadFile(reply, filePath, "capture.pcap", capture.length)
    );

    try {
      const response = await app.inject({ method: "GET", url: "/pcap" });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "application/vnd.tcpdump.pcap");
      assert.equal(response.headers["content-disposition"], 'attachment; filename="capture.pcap"');
      assert.deepEqual(response.rawPayload, capture);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("parses quoted CSV fields and escaped quotes", () => {
    const parsed = parseCsv('Name,Phone,Company\n"Doe, Jane","+1 415 555 0100","Acme ""Labs"""');

    assert.deepEqual(parsed.headers, ["Name", "Phone", "Company"]);
    assert.deepEqual(parsed.rows, [["Doe, Jane", "+1 415 555 0100", 'Acme "Labs"']]);
  });

  it("neutralizes spreadsheet formulas in exported CSV cells", () => {
    assert.equal(
      __testing.csvCell('=HYPERLINK("https://example.test")'),
      '"\'=HYPERLINK(""https://example.test"")"'
    );
    assert.equal(__testing.csvCell("\t@SUM(1,2)"), '"\'\t@SUM(1,2)"');
    assert.equal(__testing.csvCell("Normal contact"), '"Normal contact"');
  });

  it("parses BOM-prefixed CRLF CSV without shifting columns", () => {
    const parsed = parseCsv("\uFEFFname,phone\r\nJane,+14155550100\r\n");

    assert.deepEqual(parsed.headers, ["name", "phone"]);
    assert.deepEqual(parsed.rows, [["Jane", "+14155550100"]]);
  });

  it("rejects blank CSV headers instead of shifting row values", () => {
    assert.throws(() => parseCsv("name,,phone\nJane,ignored,+14155550100"), {
      message: "CSV header names cannot be blank"
    });
  });

  it("requires both name and phone CSV columns", async () => {
    const pool = createTransactionalPool({ clientHandler: () => rows([]) });

    await assert.rejects(
      importContactsFromCsv(pool, selectedCampaignId, "contacts.csv", parseCsv("phone\n+14155550100"), "US"),
      (error: unknown) =>
        error instanceof CsvImportError && error.message === "CSV must include a name column"
    );
    await assert.rejects(
      importContactsFromCsv(pool, selectedCampaignId, "contacts.csv", parseCsv("name\nJane"), "US"),
      (error: unknown) =>
        error instanceof CsvImportError && error.message === "CSV must include a phone column"
    );
  });

  it("reports blank CSV names as row failures", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("insert into csv_imports")) {
          return rows([{ id: "import-1" }]);
        }
        return rows([]);
      }
    });

    const result = await importContactsFromCsv(
      pool,
      selectedCampaignId,
      "contacts.csv",
      parseCsv("name,phone\n,+14155550100"),
      "US"
    );

    assert.equal(result.failedRows, 1);
    assert.equal(result.importedRows, 0);
    assert.ok(
      queries.some(
        (query) =>
          query.sql.includes("insert into csv_import_failures") && query.params[2] === "Name is required"
      )
    );
    assert.ok(!queries.some((query) => query.sql.includes("insert into contacts")));
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
      assert.deepEqual(params, [selectedCampaignId, false, null, 2_147_483_647, 0]);
      return rows([]);
    });

    const campaign = await getAgentCampaignForDialerAction(pool, selectedCampaignId);

    assert.equal(campaign, null);
  });

  it("keeps fallback behavior for default desk campaign selection", async () => {
    const pool = createQueryPool((_sql, params) => {
      assert.deepEqual(params, [null, true, null, 2_147_483_647, 0]);
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
      assert.deepEqual(params, [selectedCampaignId, true, userId, 2_147_483_647, 0]);
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
        if (sql.includes("select registered, availability_status from agents")) {
          return rows([{ registered: true, availability_status: "available" }]);
        }
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
      earlyMediaAvmdEnabled: false,
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
        if (sql.includes("select registered, availability_status from agents")) {
          return rows([{ registered: true, availability_status: "available" }]);
        }
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
              call_recording_enabled: true,
              early_media_avmd_enabled: true
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
        earlyMediaAvmdEnabled: false,
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
    assert.equal(
      createDialerCallFailureMessage("no_callable_contacts"),
      "No callable contacts are available"
    );
    assert.equal(
      createDialerCallFailureMessage("agent_not_registered"),
      "The browser phone must be connected before starting a call"
    );
    assert.equal(createDialerCallFailureMessage("agent_paused"), "Resume calling before starting a call");
    assert.equal(
      createDialerCallFailureMessage("agent_wrap_up"),
      "Finish wrap-up or mark yourself ready before starting a call"
    );
    assert.equal(createDialerCallFailureMessage("lead_not_callable"), "Lead is not callable");
  });

  for (const [availabilityStatus, reason] of [
    ["paused", "agent_paused"],
    ["wrap_up", "agent_wrap_up"]
  ] as const) {
    it(`refuses to reserve a call while the agent is ${availabilityStatus}`, async () => {
      const queries: string[] = [];
      const pool = createTransactionalPool({
        clientHandler: (sql) => {
          queries.push(sql);
          if (sql.includes("select registered, availability_status")) {
            return rows([{ registered: true, availability_status: availabilityStatus }]);
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
        earlyMediaAvmdEnabled: false,
        eventType: "manual_dial_started"
      });

      assert.deepEqual(result, { ok: false, reason });
      assert.ok(queries.includes("rollback"));
      assert.ok(!queries.some((sql) => sql.includes("insert into calls")));
    });
  }

  it("refuses to reserve a call while the browser phone is unregistered", async () => {
    const queries: string[] = [];
    const pool = createTransactionalPool({
      clientHandler: (sql) => {
        queries.push(sql);
        return sql.includes("select registered, availability_status from agents")
          ? rows([{ registered: false, availability_status: "available" }])
          : rows([]);
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
      earlyMediaAvmdEnabled: false,
      eventType: "manual_dial_started"
    });

    assert.deepEqual(result, { ok: false, reason: "agent_not_registered" });
    assert.ok(queries.includes("rollback"));
    assert.ok(!queries.some((sql) => sql.includes("insert into calls")));
  });

  it("infers agent-ended outcomes from the persisted call state", () => {
    assert.equal(__testing.inferAgentEndOutcome("customer_ringing"), "agent_canceled");
    assert.equal(__testing.inferAgentEndOutcome("bridged"), "answered");
    assert.equal(__testing.inferAgentEndOutcome("voicemail_signal_detected"), "answered");
  });

  it("only enables customer media actions for a connected customer leg", () => {
    assert.deepEqual(__testing.getActiveCallActions("customer_ringing", "customer-uuid"), {
      dropVoicemail: { allowed: false, reason: "Available after the customer answers" },
      sendDtmf: { allowed: false, reason: "Available after the customer answers" }
    });
    assert.deepEqual(__testing.getActiveCallActions("bridged", null), {
      dropVoicemail: { allowed: false, reason: "Waiting for the customer connection" },
      sendDtmf: { allowed: false, reason: "Waiting for the customer connection" }
    });
    assert.deepEqual(__testing.getActiveCallActions("bridged", "customer-uuid"), {
      dropVoicemail: { allowed: true, reason: null },
      sendDtmf: { allowed: true, reason: null }
    });
  });

  it("enforces customer media action eligibility in the mutation helpers", async () => {
    const pool = createQueryPool(() =>
      rows([
        {
          agent_id: "agent-1",
          contact_id: null,
          agent_leg_uuid: "agent-leg",
          customer_leg_uuid: "customer-leg",
          state: "customer_ringing",
          selected_recording_id: null,
          runtime_file_path: "/recordings/default.wav"
        }
      ])
    );

    assert.deepEqual(
      await dropVoicemailForCall(pool, config, userRow().id, "44444444-4444-4444-8444-444444444444"),
      { ok: false, statusCode: 409, message: "Voicemail drop is available after the customer answers" }
    );
    assert.deepEqual(
      await sendDtmfForCall(pool, config, userRow().id, "44444444-4444-4444-8444-444444444444", "1"),
      { ok: false, statusCode: 409, message: "DTMF is available after the customer answers" }
    );
  });

  it("builds an admin call detail with an ordered event timeline", async () => {
    const createdAt = new Date("2026-07-10T08:00:00.000Z");
    const endedAt = new Date("2026-07-10T08:01:00.000Z");
    const pool = createQueryPool((sql, params) => {
      assert.deepEqual(params, ["44444444-4444-4444-8444-444444444444"]);
      if (sql.includes("from calls")) {
        return rows([
          {
            id: "44444444-4444-4444-8444-444444444444",
            lead_name: "Jane",
            agent_name: "Alex",
            phone_number: "+14155550100",
            campaign_name: "Follow-up",
            state: "completed",
            outcome: "answered",
            created_at: createdAt,
            started_at: createdAt,
            answered_at: createdAt,
            ended_at: endedAt,
            manual_dial: false,
            duration_seconds: 60,
            call_recording_path: null,
            call_recording_enabled: false,
            voicemail_signal_status: null,
            voicemail_confidence: null,
            campaign_id: selectedCampaignId,
            agent_user_id: userRow().id
          }
        ]);
      }
      if (sql.includes("from call_events")) {
        return rows([
          {
            event_type: "freeswitch_channel_answer",
            state: "bridged",
            reason_code: null,
            freeswitch_event_name: "CHANNEL_ANSWER",
            api_command_name: null,
            agent_leg_uuid: "agent-leg",
            customer_leg_uuid: "customer-leg",
            raw_json: { headers: { "hangup-cause": "NORMAL_CLEARING" } },
            created_at: createdAt
          }
        ]);
      }
      if (sql.includes("from call_legs")) {
        return rows([
          {
            type: "agent",
            state: "ended",
            freeswitch_uuid: "agent-leg",
            sip_uri: "user/agent-1",
            started_at: createdAt,
            answered_at: createdAt,
            ended_at: endedAt
          },
          {
            type: "customer",
            state: "ended",
            freeswitch_uuid: "customer-leg",
            sip_uri: "sofia/gateway/provider/+14155550100",
            started_at: createdAt,
            answered_at: createdAt,
            ended_at: endedAt
          }
        ]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const detail = await __testing.getCallDetail(pool, "44444444-4444-4444-8444-444444444444");

    assert.equal(detail?.call.outcome, "answered");
    assert.equal(detail?.call.phoneNumber, "+14155550100");
    assert.equal(detail?.call.hangupCause, "NORMAL_CLEARING");
    assert.deepEqual(detail?.timeline, [
      {
        at: createdAt.toISOString(),
        eventType: "freeswitch_channel_answer",
        state: "bridged",
        label: "Freeswitch Channel Answer",
        reasonCode: null,
        freeSwitchEventName: "CHANNEL_ANSWER",
        apiCommandName: null,
        agentLegUuid: "agent-leg",
        customerLegUuid: "customer-leg"
      }
    ]);
    assert.equal(detail?.legs.length, 2);
    assert.equal(detail?.legs[0]?.hangupCause, "NORMAL_CLEARING");
  });

  it("resolves a persisted call recording without exposing unrelated call data", async () => {
    const callId = "44444444-4444-4444-8444-444444444444";
    const recordingPath = `/var/lib/freeswitch/storage/recordings/calls/${callId}.wav`;
    const pool = createQueryPool((sql, params) => {
      assert.match(sql, /select call_recording_path/);
      assert.match(sql, /call_recording_status = 'available'/);
      assert.deepEqual(params, [callId]);
      return rows([{ call_recording_path: recordingPath }]);
    });

    assert.deepEqual(await __testing.getCallRecordingAudioFile(pool, callId), { filePath: recordingPath });
  });

  it("returns an explicit empty desk state instead of demo campaign data", async () => {
    const pool = createQueryPool((sql) => {
      if (sql.includes("update agents") && sql.includes("availability_status")) {
        return rows([]);
      }
      if (sql.includes("select availability_status")) {
        return rows([{ availability_status: "available", wrap_up_until: null }]);
      }
      if (sql.includes("from campaigns")) {
        return rows([]);
      }
      if (sql.includes("from calls") && sql.includes("join agents")) {
        return rows([]);
      }
      if (sql.includes("from recordings")) {
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
    assert.deepEqual(result.recordings, []);
    assert.deepEqual(result.availability, { status: "available", wrapUpUntil: null });
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
    query: (sql: string, params: readonly unknown[] = []) =>
      Promise.resolve(options.clientHandler(sql, params)),
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

function campaignRow(
  overrides: Partial<{
    agent_registered: boolean;
    call_recording_enabled: boolean;
    early_media_avmd_enabled: boolean;
    callable_leads: string;
    id: string;
    manual_dialing_enabled: boolean;
    name: string;
    status: "active" | "paused" | "draft";
  }> = {}
) {
  return {
    id: selectedCampaignId,
    name: "Selected campaign",
    status: "active" as const,
    manual_dialing_enabled: true,
    call_recording_enabled: false,
    early_media_avmd_enabled: false,
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
    isActive: true,
    ...overrides
  };
}
