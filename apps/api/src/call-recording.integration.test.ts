import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import type { AppConfig } from "./config.js";
import type { IngressRecord } from "./ingress-journal.js";
import { importIngressRecord } from "./inbound-ingress.js";
import { __testing as events } from "./esl-events.js";
import { runCallRecordingFinalization } from "./call-recording-finalizer.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { signAuthToken } from "./auth/tokens.js";
import { runRetention } from "./dashboard/retention.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const inspect = async () => ({ durationSeconds: 12, fileSizeBytes: 32044 });

async function fixture() {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  const queueId = (await f.pool.query("select id from inbound_queues limit 1")).rows[0].id;
  const directory = await mkdtemp("/tmp/h02-recording-");
  const config = { CALL_RECORDINGS_STORAGE_DIR: directory } as AppConfig;
  return {
    ...f,
    queueId,
    config,
    directory,
    async finish() {
      await f.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test(
  "H02.2 DB: no-media cancellation/queued abandonment versus missing expected and corrupt output; replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const cases = [
        { name: "early cancellation", state: "canceled", enabled: true, expected: false },
        {
          name: "queued abandonment before answer",
          state: "failed",
          enabled: true,
          expected: false,
          inbound: true
        },
        { name: "recording disabled", state: "completed", enabled: false, expected: true },
        { name: "answered but never started", state: "completed", enabled: true, expected: true },
        { name: "interrupted early media", state: "failed", enabled: true, expected: false, early: true },
        { name: "missing expected file", state: "completed", enabled: true, expected: true, file: "missing" },
        { name: "empty expected file", state: "completed", enabled: true, expected: true, file: "empty" },
        { name: "corrupt expected file", state: "completed", enabled: true, expected: true, file: "corrupt" },
        {
          name: "playable interrupted recording",
          state: "failed",
          enabled: true,
          expected: true,
          file: "valid"
        }
      ];
      const ids: string[] = [];
      for (const c of cases) {
        const id = randomUUID();
        ids.push(id);
        await f.pool.query(
          `insert into calls(id,campaign_id,destination_number,normalized_destination_number,state,ended_at,
        call_recording_enabled,call_recording_status,call_recording_path,answered_at,direction,inbound_queue_id,original_did,arrived_at,queue_deadline_at,calling_number,called_number)
        values($1,$2,'+14155550100','+14155550100',$3,now()-interval '10 seconds',$4,$5,$6,
        case when $7 then now()-interval '15 seconds' end,$8,$9,$10,$11,$12,'+14155550100','+12025550100')`,
          [
            id,
            f.campaignId,
            c.state,
            c.enabled,
            !c.enabled ? "disabled" : c.file ? "recording" : "pending",
            c.file ? join(f.directory, `${id}.wav`) : null,
            c.expected,
            c.inbound ? "inbound" : "outbound",
            c.inbound ? f.queueId : null,
            c.inbound ? "+12025550100" : null,
            c.inbound ? new Date(Date.now() - 20000) : null,
            c.inbound ? new Date(Date.now() + 20000) : null
          ]
        );
        if (c.file && c.file !== "missing")
          await writeFile(
            join(f.directory, `${id}.wav`),
            c.file === "valid" ? wav() : c.file === "empty" ? Buffer.alloc(0) : Buffer.from("broken WAV")
          );
        if (c.early)
          await f.pool.query(
            `insert into call_events(call_id,event_type,freeswitch_event_name,customer_leg_uuid)
         values($1,'freeswitch_channel_progress_media','CHANNEL_PROGRESS_MEDIA',$2)`,
            [id, randomUUID()]
          );
      }
      const result = await runCallRecordingFinalization(f.pool, process.env.FFPROBE_PATH ?? "ffprobe", {
        terminalGraceSeconds: 0
      });
      assert.deepEqual(result, { claimed: 8, failed: 5, available: 1, skipped: 2 });
      for (const [i, c] of cases.entries()) {
        const row = (await f.pool.query("select * from calls where id=$1", [ids[i]])).rows[0];
        assert.equal(
          row.call_recording_status,
          !c.enabled || (!c.expected && !c.early) ? "disabled" : c.file === "valid" ? "available" : "failed",
          c.name
        );
        const failed = (
          await f.pool.query(
            "select 1 from call_events where call_id=$1 and event_type='call_recording_integrity_failed'",
            [ids[i]]
          )
        ).rowCount;
        assert.equal(failed, row.call_recording_status === "failed" ? 1 : 0, c.name);
      }
      const snapshot = (await f.pool.query("select * from call_events order by id")).rows;
      assert.deepEqual(
        await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect }),
        { claimed: 0, failed: 0, available: 0, skipped: 0 }
      );
      assert.deepEqual((await f.pool.query("select * from call_events order by id")).rows, snapshot);
    } finally {
      await f.finish();
    }
  }
);

test(
  "H02.1 DB: exact retained customer, concurrent start/replay, lost response and owner/campaign changes never start another recorder",
  options,
  async () => {
    const f = await fixture();
    try {
      const c = await f.seed();
      await f.pool.query(
        "update calls set call_recording_enabled=true,call_recording_status='pending' where id=$1",
        [c.callId]
      );
      const sent: string[] = [];
      const send = async (_config: AppConfig, command: string) => {
        sent.push(command);
        throw new Error("ESL connection closed before command response");
      };
      for (const uuid of [c.agentUuid, randomUUID()])
        await events.startCallRecording(f.config, f.pool, { callId: c.callId, customerLegUuid: uuid }, send);
      assert.equal(sent.length, 0);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          events.startCallRecording(
            f.config,
            f.pool,
            { callId: c.callId, customerLegUuid: c.customerUuid },
            send
          )
        )
      );
      assert.equal(sent.length, 1);
      await f.pool.query("update calls set agent_id=null where id=$1", [c.callId]);
      await f.pool.query("update campaigns set call_recording_enabled=false where id=$1", [f.campaignId]);
      await events.startCallRecording(
        f.config,
        f.pool,
        { callId: c.callId, customerLegUuid: c.customerUuid },
        send
      );
      assert.equal(sent.length, 1);
      const row = (await f.pool.query("select * from calls where id=$1", [c.callId])).rows[0];
      assert.equal(row.call_recording_enabled, true);
      assert.equal(row.call_recording_path, join(f.directory, `${c.callId}.wav`));
      assert.equal(row.call_recording_status, "recording");
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_events where call_id=$1 and event_type='call_recording_start_uncertain'",
            [c.callId]
          )
        ).rows[0].n,
        1
      );
      // A terminal projection alone cannot finalize a still-live customer file.
      await f.pool.query(
        "update calls set state='completed',ended_at=now()-interval '10 seconds' where id=$1",
        [c.callId]
      );
      assert.equal(
        (await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect })).claimed,
        0
      );
      await f.pool.query(
        "update call_legs set state='ended',ended_at=now() where call_id=$1 and type='customer'",
        [c.callId]
      );
      assert.equal(
        (await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect }))
          .available,
        1
      );
    } finally {
      await f.finish();
    }
  }
);

test(
  "H02.1 DB: inbound initial import freezes campaign recording policy; live/terminal replays preserve it",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query("update campaigns set call_recording_enabled=true where id=$1", [f.campaignId]);
      const row: IngressRecord = {
        uuid: randomUUID(),
        journalId: randomUUID(),
        sequence: 1,
        arrivedUs: (Date.now() - 10000) * 1000,
        did: "+12025550100",
        routeRevision: "1",
        numberId: randomUUID(),
        queueId: f.queueId,
        queueRevision: "1",
        campaignId: f.campaignId,
        timeoutMs: 60000,
        routeData: "e30",
        callingNumber: "unknown",
        terminalUs: null,
        terminalReason: null
      };
      await importIngressRecord(f.pool, row);
      await f.pool.query("update campaigns set call_recording_enabled=false where id=$1", [f.campaignId]);
      await importIngressRecord(f.pool, row);
      await importIngressRecord(f.pool, {
        ...row,
        sequence: 2,
        terminalUs: row.arrivedUs + 1000000,
        terminalReason: "channel_absent_on_recovery"
      });
      const call = (await f.pool.query("select * from calls where id=$1", [row.uuid])).rows[0];
      assert.equal(call.call_recording_enabled, true);
      assert.equal(call.call_recording_status, "pending");
      assert.equal(
        (await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect })).failed,
        0
      );
      assert.equal(
        (await f.pool.query("select call_recording_status from calls where id=$1", [row.uuid])).rows[0]
          .call_recording_status,
        "disabled"
      );
    } finally {
      await f.finish();
    }
  }
);

test(
  "H02.3 API/DB: retained recording survives ownership/finalizer replay; admin tickets/ranges/ZIP and former/unrelated agents",
  options,
  async () => {
    const f = await fixture();
    const app = Fastify();
    try {
      const c = await f.seed({ inbound: true });
      const current = (
        await f.pool.query(
          "insert into users(email,name,password_hash,role) values($1,'H02','fixture','admin') returning *",
          [`${randomUUID()}@test`]
        )
      ).rows[0];
      const unrelated = (
        await f.pool.query(
          "insert into users(email,name,password_hash,role) values($1,'H02','fixture','agent') returning *",
          [`${randomUUID()}@test`]
        )
      ).rows[0];
      const unrelatedAgent = (
        await f.pool.query(
          "insert into users(email,name,password_hash,role) values($1,'H02','fixture','agent') returning *",
          [`${randomUUID()}@test`]
        )
      ).rows[0];
      const newAgent = (
        await f.pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','H02') returning id",
          [unrelated.id, randomUUID()]
        )
      ).rows[0].id;
      const file = join(f.directory, `${c.callId}.wav`);
      const data = wav();
      await writeFile(file, data);
      await f.pool.query(
        "update calls set agent_id=$2,call_recording_enabled=true,call_recording_status='recording',call_recording_path=$3,state='completed',ended_at=now()-interval '10 seconds' where id=$1",
        [c.callId, newAgent, file]
      );
      await f.pool.query("update call_legs set state='ended',ended_at=now() where call_id=$1", [c.callId]);
      await f.pool.query("update call_participants set left_at=now() where call_id=$1", [c.callId]);
      assert.equal(
        (await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect }))
          .available,
        1
      );
      assert.equal(
        (await runCallRecordingFinalization(f.pool, "fixture", { terminalGraceSeconds: 0, inspect })).claimed,
        0
      );
      const config = {
        ...f.config,
        JWT_SECRET: "h02-isolated-secret",
        JWT_EXPIRES_SECONDS: 3600,
        MEDIA_TICKET_TTL_SECONDS: 60,
        MEDIA_TICKET_MAX_LIFETIME_SECONDS: 3600
      } as AppConfig;
      await app.register(cookie);
      registerDashboardRoutes(app, config, f.pool);
      const headers = (u: any) => ({
        authorization: `Bearer ${signAuthToken(config, { sub: u.id, email: u.email, role: u.role, ver: u.auth_version })}`
      });
      const admin = headers(current);
      const former = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
      const playback = `/admin/calls/${c.callId}/recording`;
      const zip = `/admin/campaigns/${f.campaignId}/recordings.zip`;
      for (const u of [former, unrelated, unrelatedAgent]) {
        for (const path of [playback, zip])
          assert.equal((await app.inject({ url: path, headers: headers(u) })).statusCode, 403);
        assert.equal(
          (await app.inject({ method: "POST", url: `${playback}-ticket`, headers: headers(u) })).statusCode,
          403
        );
      }
      assert.equal((await app.inject({ url: playback })).statusCode, 401);
      const full = await app.inject({ url: playback, headers: admin });
      assert.equal(full.statusCode, 200, full.body);
      assert.deepEqual(full.rawPayload, data);
      const range = await app.inject({ url: playback, headers: { ...admin, range: "bytes=2-8" } });
      assert.equal(range.statusCode, 206);
      assert.deepEqual(range.rawPayload, data.subarray(2, 9));
      const ticket = await app.inject({ method: "POST", url: `${playback}-ticket`, headers: admin });
      assert.equal(ticket.statusCode, 200, ticket.body);
      const ticketUrl = ticket.json().url;
      const streamed = await app.inject({ url: ticketUrl, headers: { range: "bytes=0-3" } });
      assert.equal(streamed.statusCode, 206, streamed.body);
      assert.deepEqual(streamed.rawPayload, data.subarray(0, 4));
      const archive = await app.inject({ url: zip, headers: admin });
      assert.equal(archive.statusCode, 200, archive.body);
      assert.equal(archive.rawPayload.readUInt32LE(0), 0x04034b50);
      assert.ok(archive.rawPayload.includes(Buffer.from(`${c.callId}.wav`)));
      assert.ok(archive.rawPayload.includes(data));
      const before = (
        await f.pool.query("select call_recording_path,campaign_id from calls where id=$1", [c.callId])
      ).rows[0];
      await runRetention(f.pool, {
        dryRun: false,
        callRetentionDays: 7,
        recordingRetentionDays: 30,
        pcapRetentionDays: 7
      });
      assert.deepEqual(
        (await f.pool.query("select call_recording_path,campaign_id from calls where id=$1", [c.callId]))
          .rows[0],
        before
      );
      assert.deepEqual(await readFile(file), data);
      await f.pool.query("update users set role='agent' where id=$1", [current.id]);
      assert.equal((await app.inject({ url: ticketUrl })).statusCode, 401, "ticket revalidates issuer role");
    } finally {
      await app.close();
      await f.finish();
    }
  }
);

function wav() {
  const bytes = Buffer.alloc(16044);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(16000, 40);
  for (let i = 0; i < 8000; i++)
    bytes.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / 8000)), 44 + i * 2);
  return bytes;
}
