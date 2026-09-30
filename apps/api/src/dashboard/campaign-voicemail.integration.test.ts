import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { runMigrations } from "../db.js";
import type { AppConfig } from "../config.js";
import { dropVoicemailForCall } from "./calls.js";
import { buildAgentDeskResponse } from "./responders.js";
import {
  createRecording,
  deleteRecording,
  getRecordingAudioFile,
  getRecordingsPage,
  lockCampaignVoicemail,
  restoreDeletedRecording,
  setCampaignVoicemail
} from "./recordings.js";

const socket = process.env.VOICEMAIL_TEST_PG_SOCKET;
// Never connect through DATABASE_URL or the application's environment.
if (socket && !socket.startsWith("/tmp/outbound-voicemail-test-"))
  throw new Error("Expected an isolated voicemail fixture socket");
const pool = new pg.Pool({
  host: socket,
  user: "postgres",
  database: "voicemail_test",
  max: 12,
  statement_timeout: 5000
});
const config = {} as AppConfig;

describe("campaign voicemail PostgreSQL integration", { skip: !socket }, () => {
  before(async () => {
    await runMigrations(pool);
    await runMigrations(pool);
  });
  after(async () => {
    await pool.end();
  });

  async function fixture() {
    const campaignId = randomUUID(),
      userId = randomUUID(),
      agentId = randomUUID(),
      callId = randomUUID();
    await pool.query("insert into campaigns (id, name, status) values ($1, 'VM campaign', 'active')", [
      campaignId
    ]);
    await pool.query(
      "insert into users (id, email, name, role, password_hash) values ($1, $2, 'VM agent', 'agent', 'fixture')",
      [userId, `${userId}@example.test`]
    );
    await pool.query(
      `insert into agents (id, user_id, sip_username, sip_password_hash, sip_password_encrypted, display_name)
      values ($1, $2, $3, 'fixture', 'fixture', 'VM agent')`,
      [agentId, userId, agentId]
    );
    await pool.query(
      `insert into calls (id, agent_id, campaign_id, destination_number, normalized_destination_number, state, started_at)
      values ($1, $2, $3, '+12025550100', '+12025550100', 'bridged', now())`,
      [callId, agentId, campaignId]
    );
    for (const type of ["agent", "customer"])
      await pool.query(
        "insert into call_legs (call_id, type, freeswitch_uuid, state) values ($1, $2, $3, 'answered')",
        [callId, type, randomUUID()]
      );
    const upload = (name: string, useForCampaign = false) =>
      createRecording(pool, {
        name,
        campaignId,
        useForCampaign,
        filePath: `/fixture/${name}.wav`,
        runtimeFilePath: `/fixture/${name}.wav`,
        durationSeconds: 3,
        fileSizeBytes: 100
      });
    const commands: string[] = [];
    const send = async (_config: AppConfig, command: string) => {
      commands.push(command);
      return { body: "+OK", headers: {}, raw: "" };
    };
    const drop = () => dropVoicemailForCall(pool, config, userId, callId, send);
    return { campaignId, userId, agentId, callId, upload, drop, commands, send };
  }

  async function waitingLock() {
    for (let i = 0; i < 100; i++) {
      const result = await pool.query(
        "select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())"
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Expected the competing operation to wait for the campaign lock");
  }

  it("hides legacy audio, enforces ownership in API and database, and never falls back", async () => {
    const f = await fixture(),
      other = await fixture();
    const legacy = (
      await pool.query(
        "insert into recordings (name, file_path, runtime_file_path, is_default) values ('Legacy', '/fixture/legacy.wav', '/fixture/legacy.wav', true) returning id"
      )
    ).rows[0].id;
    await pool.query("update calls set recording_id = $2 where id = $1", [f.callId, legacy]);
    const recording = await f.upload("owned");
    assert.equal(await getRecordingAudioFile(pool, legacy), null);
    assert.ok(
      !(await getRecordingsPage(pool, { page: 1, pageSize: 100 })).items.some((r) => r.id === legacy)
    );
    const scoped = await getRecordingsPage(pool, { page: 1, pageSize: 100, campaignId: f.campaignId });
    assert.deepEqual(
      scoped.items.map((r) => r.id),
      [recording.id]
    );
    await assert.rejects(setCampaignVoicemail(pool, other.campaignId, recording.id), /not available/);
    await assert.rejects(setCampaignVoicemail(pool, f.campaignId, legacy), /not available/);
    await assert.rejects(
      pool.query("update campaigns set voicemail_recording_id = $2 where id = $1", [
        other.campaignId,
        recording.id
      ]),
      /campaigns_voicemail_ownership/
    );
    assert.equal((await f.drop()).ok, false);
    assert.equal(f.commands.length, 0);
    const desk = await buildAgentDeskResponse(
      pool,
      { id: f.userId, email: "fixture@example.test", name: "VM agent", role: "agent", isActive: true },
      other.campaignId
    );
    assert.deepEqual(desk.recordings, []);
    assert.equal(desk.activeCall?.recordingId, null);
    assert.equal(desk.activeCall?.actions.dropVoicemail.allowed, false);
  });

  it("uses the latest assignment for an existing manual call and freezes it after claim", async () => {
    const f = await fixture(),
      other = await fixture();
    await pool.query("update calls set manual_dial = true where id = $1", [f.callId]);
    const a = await f.upload("A", true),
      b = await f.upload("B");
    assert.equal((await deleteRecording(pool, a.id)).status, "assigned");
    await setCampaignVoicemail(pool, f.campaignId, b.id);
    const desk = await buildAgentDeskResponse(
      pool,
      { id: f.userId, email: "fixture@example.test", name: "VM agent", role: "agent", isActive: true },
      other.campaignId
    );
    assert.equal(desk.activeCall?.recordingId, b.id);
    assert.equal(desk.activeCall?.recordingName, "B");
    assert.deepEqual(await f.drop(), { ok: true });
    await setCampaignVoicemail(pool, f.campaignId, a.id);
    assert.deepEqual(await f.drop(), { ok: true });
    assert.equal(f.commands.filter((c) => c.startsWith("uuid_transfer")).length, 1);
    assert.ok(f.commands.some((c) => c.endsWith("voicemail_drop_file /fixture/B.wav")));
    assert.equal(
      (await pool.query("select recording_id from calls where id = $1", [f.callId])).rows[0].recording_id,
      b.id
    );
    assert.equal((await deleteRecording(pool, b.id)).status, "in_use");
  });

  it("disables and enables voicemail during a call without touching the call", async () => {
    const f = await fixture();
    const a = await f.upload("toggle", true);
    await setCampaignVoicemail(pool, f.campaignId, null);
    assert.equal((await f.drop()).ok, false);
    assert.equal(f.commands.length, 0);
    await setCampaignVoicemail(pool, f.campaignId, a.id);
    assert.deepEqual(await f.drop(), { ok: true });
  });

  it("reads the committed replacement when drop waits for an admin transaction", async () => {
    const f = await fixture();
    await f.upload("old", true);
    const b = await f.upload("replacement");
    const admin = await pool.connect();
    try {
      await admin.query("begin");
      await lockCampaignVoicemail(admin, f.campaignId);
      const drop = f.drop();
      await waitingLock();
      await admin.query("update campaigns set voicemail_recording_id = $2 where id = $1", [
        f.campaignId,
        b.id
      ]);
      await admin.query("commit");
      assert.deepEqual(await drop, { ok: true });
      assert.ok(f.commands.some((c) => c.endsWith("voicemail_drop_file /fixture/replacement.wav")));
    } finally {
      await admin.query("rollback");
      admin.release();
    }
  });

  it("serializes duplicate requests and protects a claimed file while commands are in flight", async () => {
    const f = await fixture();
    const a = await f.upload("inflight", true),
      b = await f.upload("next");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const drop = dropVoicemailForCall(pool, config, f.userId, f.callId, async (config, command) => {
      if (command.includes("voicemail_drop_call_id")) {
        entered();
        await gate;
      }
      return f.send(config, command);
    });
    await started;
    try {
      await setCampaignVoicemail(pool, f.campaignId, b.id);
      assert.deepEqual(await f.drop(), { ok: true });
      assert.equal((await deleteRecording(pool, a.id)).status, "in_use");
    } finally {
      release();
    }
    assert.deepEqual(await drop, { ok: true });
    assert.equal(f.commands.filter((c) => c.startsWith("uuid_transfer")).length, 1);
    assert.ok(f.commands.some((c) => c.endsWith("voicemail_drop_file /fixture/inflight.wav")));
  });

  it("delete waiting behind assignment refuses to remove the newly assigned file", async () => {
    const f = await fixture();
    const a = await f.upload("delete-race");
    const admin = await pool.connect();
    try {
      await admin.query("begin");
      await lockCampaignVoicemail(admin, f.campaignId);
      const deletion = deleteRecording(pool, a.id);
      await waitingLock();
      await admin.query("update campaigns set voicemail_recording_id = $2 where id = $1", [
        f.campaignId,
        a.id
      ]);
      await admin.query("commit");
      assert.equal((await deletion).status, "assigned");
    } finally {
      await admin.query("rollback");
      admin.release();
    }
    await setCampaignVoicemail(pool, f.campaignId, null);
    assert.equal((await deleteRecording(pool, a.id)).status, "deleted");
    assert.equal(await getRecordingAudioFile(pool, a.id), null);
    await restoreDeletedRecording(pool, a.id);
    assert.equal(
      (await pool.query("select voicemail_recording_id from campaigns where id = $1", [f.campaignId])).rows[0]
        .voicemail_recording_id,
      null
    );
  });

  it("retries a rejected transfer using the new assignment, but never retries an ambiguous transfer", async () => {
    const f = await fixture();
    await f.upload("rejected", true);
    const b = await f.upload("retry");
    const rejected = await dropVoicemailForCall(pool, config, f.userId, f.callId, async () => {
      throw new Error("-ERR rejected");
    });
    assert.equal(rejected.ok, false);
    await setCampaignVoicemail(pool, f.campaignId, b.id);
    assert.deepEqual(await f.drop(), { ok: true });
    assert.ok(f.commands.some((c) => c.endsWith("voicemail_drop_file /fixture/retry.wav")));
    assert.equal(
      (
        await pool.query(
          "select raw_json from call_events where call_id = $1 and event_type = 'voicemail_drop_requested'",
          [f.callId]
        )
      ).rows[0].raw_json.recordingId,
      b.id
    );
    const g = await fixture();
    await g.upload("ambiguous", true);
    const newer = await g.upload("later");
    assert.equal(
      (
        await dropVoicemailForCall(pool, config, g.userId, g.callId, async () => {
          throw new Error("connection lost");
        })
      ).ok,
      false
    );
    await setCampaignVoicemail(pool, g.campaignId, newer.id);
    assert.deepEqual(await g.drop(), { ok: true });
    assert.equal(g.commands.length, 0);
  });

  it("rolls back failed uploads and disallows changes to archived campaigns", async () => {
    const f = await fixture();
    const a = await f.upload("keep", true);
    await assert.rejects(
      createRecording(pool, {
        name: "bad",
        campaignId: f.campaignId,
        useForCampaign: true,
        filePath: "/fixture/bad",
        runtimeFilePath: "/fixture/bad",
        durationSeconds: Number.NaN,
        fileSizeBytes: 100
      })
    );
    assert.equal(
      (await pool.query("select voicemail_recording_id from campaigns where id = $1", [f.campaignId])).rows[0]
        .voicemail_recording_id,
      a.id
    );
    await pool.query("update campaigns set status = 'archived' where id = $1", [f.campaignId]);
    await assert.rejects(f.upload("archived", true), /archived/);
    await assert.rejects(setCampaignVoicemail(pool, f.campaignId, null), /archived/);
  });
});
