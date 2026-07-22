import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PublicUser } from "@outbound-dialer/shared";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { signAuthToken } from "../auth/tokens.js";
import { getAgentCampaign, getAgentCampaignForDialerAction } from "./campaigns.js";
import {
  createDialerCall,
  createDialerCallFailureMessage,
  dropVoicemailForCall,
  sendDtmfForCall,
  syncFreeSwitchOriginate
} from "./calls.js";
import { CsvImportError, importContactsFromCsv, importSuppressionFromCsv, parseCsv } from "./csv.js";
import { validateDialableNumber } from "./manual-dial.js";
import { normalizePhoneNumber } from "./phone.js";
import { calculateActiveCallDuration, getCallHistoryPage } from "./responders.js";
import { __testing, registerDashboardRoutes } from "./routes.js";

const selectedCampaignId = "11111111-1111-4111-8111-111111111111";

const config = {
  DEFAULT_PHONE_COUNTRY_CODE: "US"
} as AppConfig;

describe("dashboard route helpers", () => {
  it("keeps active call duration anchored to the call start", () => {
    const startedAt = new Date("2026-07-21T08:00:00.000Z");

    assert.equal(calculateActiveCallDuration(startedAt, new Date("2026-07-21T08:00:12.900Z").getTime()), 12);
    assert.equal(calculateActiveCallDuration(null), 0);
  });

  it("rejects an oversized legacy JSON CSV body before authentication or database work", async () => {
    const app = Fastify();
    const pool = {
      query: () => {
        throw new Error("database must not be reached");
      }
    } as unknown as pg.Pool;
    registerDashboardRoutes(
      app,
      {
        CSV_UPLOAD_MAX_BYTES: 65_536,
        CSV_IMPORT_MAX_ROWS: 100,
        DEFAULT_PHONE_COUNTRY_CODE: "US"
      } as AppConfig,
      pool
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: `/admin/campaigns/${selectedCampaignId}/import-csv`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ filename: "large.csv", csvText: "a".repeat(200_000) })
      });
      assert.equal(response.statusCode, 413, response.body);
    } finally {
      await app.close();
    }
  });

  it("rejects an oversized multipart CSV before buffering or campaign queries", async () => {
    const app = Fastify();
    await app.register(multipart);
    const queries: string[] = [];
    const pool = createQueryPool((sql) => {
      queries.push(sql);
      if (sql.includes("from users")) {
        return rows([
          {
            id: userRow().id,
            email: userRow().email,
            name: userRow().name,
            role: "admin",
            is_active: true,
            auth_version: 1,
            password_hash: "unused",
            created_at: new Date(),
            updated_at: new Date()
          }
        ]);
      }
      throw new Error(`Unexpected query after oversized upload: ${sql}`);
    });
    const routeConfig = {
      CSV_UPLOAD_MAX_BYTES: 65_536,
      CSV_IMPORT_MAX_ROWS: 100,
      DEFAULT_PHONE_COUNTRY_CODE: "US",
      JWT_SECRET: "multipart-test-secret",
      JWT_EXPIRES_SECONDS: 3_600
    } as AppConfig;
    registerDashboardRoutes(app, routeConfig, pool);
    const token = signAuthToken(routeConfig, {
      sub: userRow().id,
      email: userRow().email,
      role: "admin",
      ver: 1
    });
    const boundary = "outbound-dialer-csv-boundary";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.csv"\r\nContent-Type: text/csv\r\n\r\n${"a".repeat(70_000)}\r\n--${boundary}--\r\n`
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: `/admin/campaigns/${selectedCampaignId}/import-csv-file`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length)
        },
        payload: body
      });
      assert.equal(response.statusCode, 413, response.body);
      assert.equal(queries.filter((sql) => sql.includes("from users")).length, 1);
      assert.equal(
        queries.some((sql) => sql.includes("from campaigns")),
        false
      );
    } finally {
      await app.close();
    }
  });

  it("fails closed before creating a call while certificate maintenance owns the start gate", async () => {
    const queries: string[] = [];
    const pool = createTransactionalPool({
      clientHandler: (sql) => {
        queries.push(sql);
        if (sql.includes("value_json = 'true'::jsonb")) return rows([{ paused: true }]);
        if (sql.includes("insert into calls")) throw new Error("call must not be created");
        return rows([]);
      }
    });

    const result = await createDialerCall(pool, config, {
      agentId: "22222222-2222-4222-8222-222222222222",
      campaignId: selectedCampaignId,
      contactId: "next",
      sipUsername: "agent-test",
      manualDial: false,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      eventType: "agent_next_call_started"
    });

    assert.deepEqual(result, { ok: false, reason: "maintenance" });
    assert.match(queries.join("\n"), /for share/);
    assert.ok(queries.some((sql) => sql.trim() === "rollback"));
    assert.ok(!queries.some((sql) => sql.includes("insert into calls")));
    assert.equal(
      createDialerCallFailureMessage("maintenance" as never),
      "Calling is temporarily paused for certificate maintenance"
    );
  });

  it("serializes Agent Desk call starts against an active supervisor session", async () => {
    const actorUserId = "11111111-1111-4111-8111-111111111111";
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("select is_active from users")) return rows([{ is_active: true }]);
        if (sql.includes("from call_supervisor_sessions")) return rows([{ id: "active-supervisor" }]);
        return rows([]);
      }
    });

    const result = await createDialerCall(pool, config, {
      actorUserId,
      agentId: "22222222-2222-4222-8222-222222222222",
      campaignId: selectedCampaignId,
      contactId: "next",
      sipUsername: "agent-test",
      manualDial: false,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      eventType: "agent_next_call_started"
    });

    assert.deepEqual(result, { ok: false, reason: "supervisor_session" });
    assert.ok(queries.some((query) => query.sql.includes("pg_advisory_xact_lock")));
    assert.ok(queries.some((query) => query.sql === "rollback"));
    assert.ok(!queries.some((query) => query.sql.includes("insert into calls")));
  });

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
    assert.equal(
      __testing.callHistoryCsvRows([["Normal contact"], ["=SUM(1,2)"]]),
      '"Normal contact"\n"\'=SUM(1,2)"\n'
    );
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

  it("rejects CSV payloads above independent byte and row limits", () => {
    assert.throws(() => parseCsv("name,phone\nJane,+14155550100", { maxBytes: 12 }), {
      message: "CSV exceeds configured limit of 12 bytes"
    });
    assert.throws(() => parseCsv("name,phone\nJane,+14155550100\nJohn,+14155550101", { maxRows: 1 }), {
      message: "CSV exceeds configured limit of 1 data rows"
    });
  });

  it("bounds CSV structure without restricting arbitrary field names", () => {
    assert.deepEqual(parseCsv("name,phone,arbitrary CRM field\nJane,+14155550100,kept").headers, [
      "name",
      "phone",
      "arbitrary CRM field"
    ]);
    assert.throws(() => parseCsv("a,b,c\n1,2,3", { maxColumns: 2 }), {
      message: "CSV exceeds structural limit of 2 columns"
    });
    assert.throws(() => parseCsv("a,b\n1,2\n3,4", { maxCells: 4 }), {
      message: "CSV exceeds structural limit of 4 cells"
    });
    assert.throws(() => parseCsv("name,phone\nabcdef,+14155550100", { maxCellCharacters: 5 }), {
      message: "CSV cell exceeds structural limit of 5 characters"
    });
    assert.throws(() => parseCsv("name,Name\nJane,Duplicate"), {
      message: "CSV header names must be unique"
    });
    assert.throws(() => parseCsv("name,phone\nJane,+14155550100,extra"), {
      message: "CSV row 2 has more values than the header row"
    });
    assert.throws(() => parseCsv('name,phone\n"Jane,+14155550100'), {
      message: "CSV contains an unterminated quoted field"
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
      queries.some((query) => {
        if (!query.sql.includes("insert into csv_import_failures")) return false;
        const failures = JSON.parse(String(query.params[1])) as Array<{ reason: string }>;
        return failures[0]?.reason === "Name is required";
      })
    );
    assert.ok(!queries.some((query) => query.sql.includes("insert into contacts")));
  });

  it("imports contacts and records duplicates with set-based queries", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("insert into csv_imports")) return rows([{ id: "import-1" }]);
        if (sql.includes("insert into contacts")) {
          return rows([{ normalized_phone_number: "+14155550100" }]);
        }
        return rows([]);
      }
    });

    const result = await importContactsFromCsv(
      pool,
      selectedCampaignId,
      "contacts.csv",
      parseCsv(
        "name,phone,team\nJane,+14155550100,A\nJane duplicate,+14155550100,B\nExisting,+14155550101,C"
      ),
      "US"
    );

    assert.deepEqual(
      {
        importedRows: result.importedRows,
        duplicateRows: result.duplicateRows,
        failedRows: result.failedRows
      },
      { importedRows: 1, duplicateRows: 2, failedRows: 2 }
    );
    const contactInsert = queries.find((query) => query.sql.includes("insert into contacts"));
    assert.equal(JSON.parse(String(contactInsert?.params[1])).length, 2);
    assert.match(contactInsert?.sql ?? "", /order by normalized_phone_number/);
    const failureInsert = queries.find((query) => query.sql.includes("insert into csv_import_failures"));
    const failures = JSON.parse(String(failureInsert?.params[1])) as Array<{ reason: string }>;
    assert.equal(failures.length, 2);
    assert.ok(failures.every((failure) => failure.reason === "Duplicate phone number in this campaign"));
  });

  it("chunks large contact imports into bounded sorted JSONB parameters", async () => {
    const contactPayloadSizes: number[] = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        if (sql.includes("insert into csv_imports")) return rows([{ id: "import-chunked" }]);
        if (sql.includes("insert into contacts")) {
          const payload = JSON.parse(String(params[1])) as Array<{ normalized_phone_number: string }>;
          contactPayloadSizes.push(payload.length);
          return rows(payload.map((row) => ({ normalized_phone_number: row.normalized_phone_number })));
        }
        return rows([]);
      }
    });
    const parsed = {
      headers: ["name", "phone", "any custom field"],
      rows: Array.from({ length: 1_001 }, (_, index) => [
        `Contact ${index}`,
        `+1202555${String(index + 1_000).padStart(4, "0")}`,
        `value ${index}`
      ])
    };

    const result = await importContactsFromCsv(pool, selectedCampaignId, "chunked.csv", parsed, "US");

    assert.equal(result.importedRows, 1_001);
    assert.deepEqual(contactPayloadSizes, [1_000, 1]);
  });

  it("upserts unique suppression entries while preserving per-row audit events", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("insert into suppression_entries")) {
          return rows([
            {
              id: "11111111-1111-4111-8111-111111111111",
              normalized_phone_number: "+14155550100",
              inserted: true
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              normalized_phone_number: "+14155550101",
              inserted: false
            }
          ]);
        }
        return rows([]);
      }
    });

    const result = await importSuppressionFromCsv(pool, {
      actorUserId: "33333333-3333-4333-8333-333333333333",
      filename: "suppression.csv",
      parsed: parseCsv("phone,reason\n+14155550100,first\n+14155550100,last\n+14155550101,existing"),
      defaultCountryCode: "US"
    });

    assert.deepEqual(
      { importedRows: result.importedRows, updatedRows: result.updatedRows, failedRows: result.failedRows },
      { importedRows: 1, updatedRows: 2, failedRows: 0 }
    );
    const upsert = queries.find((query) => query.sql.includes("insert into suppression_entries"));
    assert.match(upsert?.sql ?? "", /order by normalized_phone_number/);
    const uniqueRows = JSON.parse(String(upsert?.params[0])) as Array<{ reason: string }>;
    assert.deepEqual(
      uniqueRows.map((row) => row.reason),
      ["last", "existing"]
    );
    const events = queries.find((query) => query.sql.includes("insert into suppression_events"));
    assert.equal(JSON.parse(String(events?.params[0])).length, 3);
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
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        queries.push({ sql, params });
        if (sql === "select agent_id from calls where id = $1") {
          return rows([{ agent_id: "33333333-3333-4333-8333-333333333333" }]);
        }
        if (sql.includes("voicemail_signal_status") && sql.includes("for update")) {
          return rows([
            {
              agent_id: "33333333-3333-4333-8333-333333333333",
              answered_at: null,
              contact_id: "22222222-2222-4222-8222-222222222222",
              ended_at: null,
              outcome: null,
              state: "created",
              voicemail_signal_status: null
            }
          ]);
        }
        if (sql.includes("returning outcome")) {
          return rows([{ outcome: "failed" }]);
        }
        return rows([]);
      }
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

    assert.equal(queries[0]?.sql, "begin");
    assert.ok(
      queries.some((query) => query.sql.includes("select id from agents") && query.sql.includes("for update"))
    );
    assert.ok(queries.some((query) => query.sql.includes("set state = $2")));
    const legs = queries.find((query) => query.sql.includes("update call_legs"));
    assert.doesNotMatch(legs?.sql ?? "", /type = 'customer'/);
    const event = queries.find((query) => query.sql.includes("insert into call_events"));
    assert.deepEqual(event?.params.slice(2, 5), ["freeswitch_originate_skipped", "failed", null]);
    assert.equal(event?.params[7], "bgapi originate");
    assert.equal(queries.at(-1)?.sql, "commit");
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
        if (sql === "select agent_id from calls where id = $1") {
          return rows([{ agent_id: "33333333-3333-4333-8333-333333333333" }]);
        }
        if (sql.includes("select registered, availability_status from agents")) {
          return rows([{ registered: true, availability_status: "available" }]);
        }
        if (sql.includes("voicemail_signal_status") && sql.includes("for update")) {
          return rows([
            {
              agent_id: "33333333-3333-4333-8333-333333333333",
              answered_at: null,
              contact_id: "22222222-2222-4222-8222-222222222222",
              ended_at: null,
              outcome: null,
              state: "created",
              voicemail_signal_status: null
            }
          ]);
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
        if (sql.includes("returning outcome")) {
          return rows([{ outcome: "failed" }]);
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
    assert.ok(clientQueries.some((query) => query.sql.includes("set state = $2")));
    assert.ok(clientQueries.some((query) => query.sql === "commit"));
  });

  it("requires explicit confirmation to select a completed lead again", async () => {
    const contactQueries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalPool({
      clientHandler: (sql, params) => {
        if (sql.includes("select registered, availability_status from agents")) {
          return rows([{ registered: true, availability_status: "available" }]);
        }
        if (sql.includes("from calls") && sql.includes("for update")) {
          return rows([]);
        }
        if (sql.includes("from contacts") && sql.includes("for update of contacts")) {
          contactQueries.push({ sql, params });
          return params[1] === true
            ? rows([
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  campaign_id: selectedCampaignId,
                  phone_number: "+1 415 555 0100",
                  normalized_phone_number: "+14155550100",
                  call_recording_enabled: false,
                  early_media_avmd_enabled: false
                }
              ])
            : rows([]);
        }
        if (sql.includes("from recordings")) {
          return rows([]);
        }
        if (sql.includes("insert into calls")) {
          return rows([{ id: "44444444-4444-4444-8444-444444444444" }]);
        }
        return rows([]);
      }
    });

    const result = await createDialerCall(pool, { ...config, FREESWITCH_ESL_ENABLED: false } as AppConfig, {
      agentId: "33333333-3333-4333-8333-333333333333",
      campaignId: null,
      contactId: "22222222-2222-4222-8222-222222222222",
      sipUsername: "agent1000",
      manualDial: false,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      confirmCompletedLead: true,
      eventType: "lead_call_started"
    });

    assert.equal(result.ok, true);
    assert.equal(contactQueries.length, 1);
    assert.equal(contactQueries[0]?.params[1], true);
    assert.match(contactQueries[0]?.sql ?? "", /contacts\.status = 'completed' and \$2 = true/);
    assert.match(contactQueries[0]?.sql ?? "", /contacts\.status not in \('calling', 'suppressed'\)/);
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
      createDialerCallFailureMessage("supervisor_session"),
      "Stop live-call monitoring before starting an Agent Desk call"
    );
    assert.equal(
      createDialerCallFailureMessage("session_revoked"),
      "Your session is no longer authorized to start calls; sign in again"
    );
    assert.equal(createDialerCallFailureMessage("lead_not_callable"), "Lead is not callable");
  });

  for (const [availabilityStatus, reason] of [["paused", "agent_paused"]] as const) {
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
            avmd_attempted: true,
            freeswitch_terminal_at: endedAt,
            terminal_persisted_at: endedAt,
            terminal_source: "freeswitch_customer_terminal",
            terminal_event_name: "CHANNEL_HANGUP",
            finalization_latency_ms: 12,
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
            created_at: createdAt,
            total_count: "125"
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
      if (sql.includes("from call_avmd_reviews")) {
        return rows([]);
      }
      if (sql.includes("from call_media_stats")) {
        return rows([]);
      }
      if (sql.includes("from call_browser_media_stats")) {
        return rows([]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const detail = await __testing.getCallDetail(pool, "44444444-4444-4444-8444-444444444444");

    assert.equal(detail?.call.outcome, "answered");
    assert.equal(detail?.call.phoneNumber, "+14155550100");
    assert.equal(detail?.call.hangupCause, "NORMAL_CLEARING");
    assert.equal(detail?.call.avmdAttempted, true);
    assert.equal(detail?.call.finalizationLatencyMs, 12);
    assert.equal(detail?.timelineTotal, 125);
    assert.equal(detail?.timelineTruncated, true);
    assert.deepEqual(detail?.mediaQuality, []);
    assert.equal(detail?.browserMedia, null);
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

  it("paginates campaign contacts and reports the complete filtered total", async () => {
    const createdAt = new Date("2026-07-16T08:00:00.000Z");
    const pool = createQueryPool((sql, params) => {
      assert.match(sql, /limit \$4 offset \$5/);
      assert.deepEqual(params, [selectedCampaignId, "alex", "ready", 25, 25]);
      return rows([
        {
          id: "22222222-2222-4222-8222-222222222222",
          display_name: "Alex Contact",
          phone_number: "+14155550100",
          mapped_fields_json: {},
          company: null,
          contact_status: "ready",
          created_at: createdAt,
          total_count: "53"
        }
      ]);
    });

    const result = await __testing.getCampaignContacts(pool, selectedCampaignId, {
      q: " alex ",
      status: "ready",
      page: 2,
      pageSize: 25
    });

    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 25);
    assert.equal(result.total, 53);
    assert.equal(result.totalPages, 3);
    assert.equal(result.contacts[0]?.name, "Alex Contact");
  });

  it("paginates CSV import failures without hiding the remaining pages", async () => {
    const createdAt = new Date("2026-07-16T08:00:00.000Z");
    const pool = createQueryPool((sql, params) => {
      if (sql.includes("from csv_imports")) {
        assert.deepEqual(params, ["33333333-3333-4333-8333-333333333333"]);
        return rows([
          {
            id: "33333333-3333-4333-8333-333333333333",
            campaign_id: selectedCampaignId,
            campaign_name: "Selected campaign",
            filename: "contacts.csv",
            status: "completed_with_errors",
            total_rows: 8,
            imported_rows: 3,
            failed_rows: 5,
            field_mapping_json: { duplicateRows: 0 },
            created_at: createdAt,
            completed_at: createdAt
          }
        ]);
      }
      assert.match(sql, /from csv_import_failures/);
      assert.match(sql, /limit \$2 offset \$3/);
      assert.deepEqual(params, ["33333333-3333-4333-8333-333333333333", 2, 2]);
      return rows([
        {
          id: "44444444-4444-4444-8444-444444444444",
          row_number: 4,
          reason: "Invalid phone number",
          row_json: { name: "Alex", phone: "invalid" }
        }
      ]);
    });

    const detail = await __testing.getCsvImportDetail(pool, "33333333-3333-4333-8333-333333333333", {
      failurePage: 2,
      failurePageSize: 2
    });

    assert.equal(detail?.failurePage, 2);
    assert.equal(detail?.failurePageSize, 2);
    assert.equal(detail?.failureTotalPages, 3);
    assert.equal(detail?.failures[0]?.rowNumber, 4);
  });

  it("binds and maps the AVMD review call-history filter", async () => {
    const createdAt = new Date("2026-07-10T08:00:00.000Z");
    const pool = createQueryPool((sql, params) => {
      assert.match(sql, /\$9 = 'needs_review'/);
      assert.match(sql, /limit \$14 offset \$15/);
      assert.deepEqual(params, [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "needs_review",
        null,
        null,
        null,
        null,
        25,
        0
      ]);
      return rows([
        {
          id: "44444444-4444-4444-8444-444444444444",
          lead_name: "Jane",
          agent_name: "Alex",
          phone_number: "+14155550100",
          campaign_name: "Follow-up",
          campaign_id: selectedCampaignId,
          agent_user_id: userRow().id,
          state: "completed",
          outcome: "answered",
          created_at: createdAt,
          duration_seconds: 60,
          recording_available: true,
          pcap_status: null,
          pcap_available: false,
          voicemail_signal_status: "none",
          avmd_review_status: "needs_review",
          total_count: "1"
        }
      ]);
    });

    const result = await getCallHistoryPage(pool, {
      page: 1,
      pageSize: 25,
      avmdReview: "needs_review"
    });
    assert.equal(result.items[0]?.avmdReviewStatus, "needs_review");
  });

  it("keeps export keysets self-contained at PostgreSQL timestamp precision", async () => {
    const snapshotId = "44444444-4444-4444-8444-444444444444";
    const cursorId = "55555555-5555-4555-8555-555555555555";
    const snapshotCreatedAt = "2026-07-10T08:00:00.123456Z";
    const cursorCreatedAt = "2026-07-10T08:00:00.123001Z";
    const pool = createQueryPool((sql, params) => {
      assert.match(sql, /calls\.created_at < \$10/);
      assert.match(sql, /calls\.created_at < \$12/);
      assert.deepEqual(params, [
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        snapshotCreatedAt,
        snapshotId,
        cursorCreatedAt,
        cursorId,
        1_000,
        0
      ]);
      assert.equal(
        params.some((value) => (value as unknown) instanceof Date),
        false
      );
      return rows([]);
    });

    await getCallHistoryPage(pool, {
      page: 1,
      pageSize: 1_000,
      snapshot: { createdAt: snapshotCreatedAt, id: snapshotId },
      cursor: { createdAt: cursorCreatedAt, id: cursorId }
    });
  });

  it("streams call-history export with a stable keyset order without holding a pool client", async () => {
    const commands: string[] = [];
    const pool = {
      query: async (sql: string) => {
        commands.push(sql.trim().replace(/\s+/g, " "));
        assert.match(sql, /order by calls\.created_at desc, calls\.id desc/);
        return rows([
          {
            id: "44444444-4444-4444-8444-444444444444",
            lead_name: "=Unsafe lead",
            agent_name: "Alex",
            phone_number: "+14155550100",
            campaign_name: "Follow-up",
            campaign_id: selectedCampaignId,
            agent_user_id: userRow().id,
            state: "completed",
            outcome: "answered",
            created_at: new Date("2026-07-10T08:00:00.000Z"),
            duration_seconds: 60,
            recording_available: true,
            pcap_status: null,
            pcap_available: false,
            voicemail_signal_status: "none",
            avmd_review_status: "reviewed",
            total_count: "1"
          }
        ]);
      }
    } as unknown as pg.Pool;

    const exported = await __testing.openCallHistoryCsvExport(pool, {}, 100);
    assert.ok(exported.stream);
    let csv = "";
    for await (const chunk of exported.stream) csv += chunk.toString();

    assert.equal(commands.length, 1);
    assert.doesNotMatch(commands[0] ?? "", /begin|commit|rollback/i);
    assert.match(csv, /"created_at","lead","phone"/);
    assert.match(csv, /"'=Unsafe lead"/);
  });

  it("rejects an oversized call-history export without reserving a pool client", async () => {
    const commands: string[] = [];
    const pool = {
      query: async (sql: string) => {
        commands.push(sql.trim().replace(/\s+/g, " "));
        return rows([
          {
            id: "44444444-4444-4444-8444-444444444444",
            phone_number: "+14155550100",
            state: "completed",
            created_at: new Date("2026-07-10T08:00:00.000Z"),
            recording_available: false,
            pcap_status: null,
            pcap_available: false,
            total_count: "101"
          }
        ]);
      }
    } as unknown as pg.Pool;

    const exported = await __testing.openCallHistoryCsvExport(pool, {}, 100);

    assert.equal(exported.stream, null);
    assert.equal(exported.total, 101);
    assert.equal(commands.length, 1);
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
    auto_advance_to_next_lead_enabled: boolean;
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
    auto_advance_to_next_lead_enabled: false,
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
