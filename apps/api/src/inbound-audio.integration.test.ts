import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import type { AppConfig } from "./config.js";
import { signAuthToken } from "./auth/tokens.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { mutateInboundConfiguration } from "./inbound-admin.js";
import { saveInboundFlowSchema, saveInboundQueueSchema } from "./call-coordination-contracts.js";
import { createRecording, deleteRecording, restoreDeletedRecording } from "./dashboard/recordings.js";
import { importIngressRecord } from "./inbound-ingress.js";
import { admitInboundQueue } from "./inbound-queue.js";
import type { IngressRecord } from "./ingress-journal.js";

const execute = promisify(execFile);
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const receipt = () => ({ idempotencyKey: randomUUID(), expectedRevision: null });
async function fixture() {
  const schema = `f02_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const connection = databaseConfig(testDatabaseUrl(), schema);
  const pool = new pg.Pool({ ...connection, max: 10 });
  await runMigrations(pool);
  await pool.query("update call_admission_migration set reconciliation_required=false,reconciled_at=now()");
  const directory = await mkdtemp("/tmp/f02-audio-");
  const campaign = (
    await pool.query("insert into campaigns(name,status) values('F02','active') returning id")
  ).rows[0].id;
  const users = (
    await pool.query(`insert into users(email,name,password_hash,role) values
    ('f02-admin@test','F02','fixture','admin'),('f02-agent@test','F02','fixture','agent') returning *`)
  ).rows;
  const owner = users.find((u) => u.role === "admin")!;
  const config = {
    JWT_SECRET: "f02-isolated-test-secret",
    JWT_EXPIRES_SECONDS: 3600,
    MEDIA_TICKET_TTL_SECONDS: 60,
    VOICEMAIL_UPLOAD_MAX_BYTES: 100000,
    VOICEMAIL_RECORDINGS_STORAGE_DIR: directory,
    FFMPEG_PATH: process.env.FFMPEG_PATH ?? "ffmpeg",
    FFPROBE_PATH: process.env.FFPROBE_PATH ?? "ffprobe"
  } as AppConfig;
  const app = Fastify();
  await app.register(cookie);
  await app.register(multipart);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError ? reply.code(400).send({ message: "Invalid request" }) : reply.send(error)
  );
  registerDashboardRoutes(app, config, pool);
  const headers = (role = "admin") => {
    const u = users.find((user) => user.role === role)!;
    return {
      authorization: `Bearer ${signAuthToken(config, { sub: u.id, email: u.email, role: u.role, ver: u.auth_version })}`
    };
  };
  const actor = { id: owner.id, authVersion: owner.auth_version, requestId: "f02-test" };
  const audio = async (name = "F02", useForCampaign = false) => {
    const filePath = join(directory, `${randomUUID()}.wav`);
    await writeFile(filePath, wav());
    return createRecording(pool, {
      name,
      filePath,
      runtimeFilePath: filePath,
      durationSeconds: 2,
      fileSizeBytes: (await readFile(filePath)).length,
      campaignId: campaign,
      useForCampaign
    });
  };
  const flowInput = (id: string) =>
    saveInboundFlowSchema.parse({
      ...receipt(),
      campaignId: campaign,
      name: "F02 flow",
      definition: {
        flowTimeoutMs: 90000,
        actions: [{ type: "play_audio", recordingId: id, timeoutMs: 10000 }, { type: "hangup" }]
      }
    });
  const queueInput = (id: string | null) =>
    saveInboundQueueSchema.parse({
      ...receipt(),
      campaignId: campaign,
      name: "F02 queue",
      waitingRecordingId: id,
      noAnswerFlowVersionId: null,
      configuration: {}
    });
  const queue = async (id: string | null) =>
    (await mutateInboundConfiguration(pool, actor, "queues", "POST", null, queueInput(id))) as {
      id: string;
      revision: string;
    };
  const upload = (
    buffer: Buffer,
    filename = "audio.wav",
    extra: Record<string, string> = {},
    role = "admin"
  ) => {
    const boundary = "f02boundary";
    const fields = Object.entries({ campaignId: campaign, ...extra })
      .map(
        ([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      )
      .join("");
    return app.inject({
      method: "POST",
      url: "/admin/recordings",
      headers: { ...headers(role), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ])
    });
  };
  const captured = async (queueId: string, id: string) => {
    const row: IngressRecord = {
      uuid: randomUUID(),
      journalId: randomUUID(),
      sequence: 1,
      arrivedUs: Date.now() * 1000,
      did: "+12025550100",
      routeRevision: "1",
      numberId: randomUUID(),
      queueId,
      queueRevision: "1",
      campaignId: campaign,
      timeoutMs: 60000,
      routeData: Buffer.from(
        JSON.stringify({ waiting_audio_id: id, queue_timeout_ms: 60000, max_waiting_calls: 40 })
      ).toString("base64url"),
      callingNumber: "anonymous",
      terminalUs: null,
      terminalReason: null
    };
    await importIngressRecord(pool, row);
    return row;
  };
  return {
    pool,
    connection,
    directory,
    campaign,
    owner,
    config,
    actor,
    app,
    headers,
    audio,
    flowInput,
    queueInput,
    queue,
    upload,
    captured,
    async cleanup() {
      await app.close();
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

// A real stereo 16 kHz fixture, deliberately different from canonical output.
function wav(seconds = 2): Buffer {
  const rate = 16000,
    channels = 2,
    data = rate * channels * 2 * seconds;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < rate * seconds; i++)
    for (let c = 0; c < channels; c++)
      b.writeInt16LE(
        Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / rate)),
        44 + (i * channels + c) * 2
      );
  return b;
}

test(
  "F02.1 API/decoder: WAV and MP3 normalization, scoped preview ranges, expiry and access revocation",
  options,
  async () => {
    const f = await fixture();
    try {
      // Dedicated DB execution must fail, never silently skip absent decoders.
      const source = join(f.directory, "source.wav"),
        mp3 = join(f.directory, "source.mp3");
      await writeFile(source, wav());
      await execute(f.config.FFMPEG_PATH, ["-v", "error", "-y", "-i", source, mp3]);
      for (const [bytes, name] of [
        [wav(), "greeting.WAV"],
        [await readFile(mp3), "greeting.mp3"]
      ] as const) {
        // Input exceeds this test's upload budget; valid canonical fixture remains bounded.
        f.config.VOICEMAIL_UPLOAD_MAX_BYTES = 200000;
        const r = await f.upload(bytes, name);
        assert.equal(r.statusCode, 201, r.body);
        const item = r.json().item;
        assert.equal(item.isAssigned, false);
        assert.equal(
          (await f.pool.query("select voicemail_recording_id from campaigns where id=$1", [f.campaign]))
            .rows[0].voicemail_recording_id,
          null
        );
        const row = (await f.pool.query("select * from recordings where id=$1", [item.id])).rows[0];
        const probe = await execute(f.config.FFPROBE_PATH, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_name,sample_rate,channels",
          "-of",
          "json",
          row.file_path
        ]);
        assert.deepEqual(JSON.parse(probe.stdout).streams, [
          { codec_name: "pcm_s16le", sample_rate: "8000", channels: 1 }
        ]);
        const ticket = await f.app.inject({
          method: "POST",
          url: `/admin/recordings/${item.id}/audio-ticket`,
          headers: f.headers()
        });
        assert.equal(ticket.statusCode, 200, ticket.body);
        const url = ticket.json().url;
        const preview = await f.app.inject({ url, headers: { range: "bytes=0-31" } });
        assert.equal(preview.statusCode, 206, preview.body);
        assert.equal(preview.rawPayload.length, 32);
        assert.equal(preview.rawPayload.toString("ascii", 0, 4), "RIFF");
        assert.equal((await f.app.inject({ url, headers: { range: "bytes=999999-" } })).statusCode, 416);
        assert.equal(
          (await f.app.inject({ url: `/admin/recordings/${randomUUID()}/audio?${url.split("?")[1]}` }))
            .statusCode,
          401
        );
        assert.equal((await f.app.inject({ url: `/admin/recordings/${item.id}/audio` })).statusCode, 401);
        assert.equal(
          (await f.app.inject({ url: `/admin/recordings/${item.id}/audio`, headers: f.headers("agent") }))
            .statusCode,
          403
        );
        await f.pool.query("update media_access_tickets set expires_at=now()-interval '1 second'");
        assert.equal((await f.app.inject({ url })).statusCode, 401);
        const fresh = await f.app.inject({
          method: "POST",
          url: `/admin/recordings/${item.id}/audio-ticket`,
          headers: f.headers()
        });
        await f.pool.query("update users set is_active=false where id=$1", [f.owner.id]);
        assert.equal((await f.app.inject({ url: fresh.json().url })).statusCode, 401);
        await f.pool.query("update users set is_active=true where id=$1", [f.owner.id]);
        await f.pool.query(
          "update media_access_tickets set created_at=now()-interval '5 hours',expires_at=now()+interval '1 minute'"
        );
        assert.equal((await f.app.inject({ url: fresh.json().url })).statusCode, 401);
      }
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F02.1 API: malformed, unsupported, oversized and over-duration uploads leave no assets",
  options,
  async () => {
    const f = await fixture();
    try {
      for (const [buffer, name, status] of [
        [Buffer.from("not audio"), "broken.wav", 400],
        [Buffer.alloc(0), "empty.wav", 400],
        [wav(), "audio.ogg", 400],
        [wav(), "huge.wav", 413]
      ] as const) {
        const r = await f.upload(buffer, name);
        assert.equal(r.statusCode, status, r.body);
        assert.deepEqual(await readdir(f.directory), []);
      }
      assert.equal((await f.upload(wav(), "agent.wav", {}, "agent")).statusCode, 403);
      const source = join(f.directory, "long.wav");
      await execute(f.config.FFMPEG_PATH, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=8000:cl=mono",
        "-t",
        "301",
        "-c:a",
        "libmp3lame",
        source + ".mp3"
      ]);
      f.config.VOICEMAIL_UPLOAD_MAX_BYTES = 2000000;
      assert.equal((await f.upload(await readFile(source + ".mp3"), "long.mp3")).statusCode, 400);
      assert.deepEqual(await readdir(f.directory), ["long.wav.mp3"]);
      const ogg = join(f.directory, "disguised.ogg");
      await execute(f.config.FFMPEG_PATH, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=1",
        ogg
      ]);
      const unsupported = await f.upload(await readFile(ogg), "disguised.wav");
      assert.equal(unsupported.statusCode, 400, unsupported.body);
      assert.match(unsupported.json().message, /WAV or MP3/);
      const decoder = f.config.FFPROBE_PATH;
      f.config.FFPROBE_PATH = join(f.directory, "missing-decoder");
      assert.equal((await f.upload(wav(), "unavailable.wav")).statusCode, 503);
      f.config.FFPROBE_PATH = decoder;
      assert.equal((await f.pool.query("select count(*)::int as n from recordings")).rows[0].n, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F02.2/F02.3 DB/API: independent assignments, immutable versions, published pre-import waiting pin and safe cleanup",
  options,
  async () => {
    const f = await fixture();
    try {
      const outbound = await f.audio("Outbound", true),
        a = await f.audio("Inbound A"),
        b = await f.audio("Inbound B");
      const q = await f.queue(a.id);
      const flow = (await mutateInboundConfiguration(
        f.pool,
        f.actor,
        "flows",
        "POST",
        null,
        f.flowInput(a.id)
      )) as { id: string; revision: string };
      const v1 = (await f.pool.query("select * from inbound_flow_versions where flow_id=$1", [flow.id]))
        .rows[0];
      await f.pool.query(
        `insert into inbound_ingress_route_snapshots(configuration_hash,number_id,queue_id,campaign_id,snapshot)
      values($1,$2,$3,$4,$5)`,
        ["a".repeat(64), randomUUID(), q.id, f.campaign, { queue_snapshot: { waiting_audio_id: b.id } }]
      );
      await mutateInboundConfiguration(f.pool, f.actor, "queues", "PATCH", q.id, {
        ...f.queueInput(null),
        expectedRevision: q.revision
      });
      const latest = (await mutateInboundConfiguration(f.pool, f.actor, "flows", "PATCH", flow.id, {
        ...f.flowInput(b.id),
        expectedRevision: flow.revision
      })) as { revision: string };
      await mutateInboundConfiguration(f.pool, f.actor, "flows", "PATCH", flow.id, {
        ...f.flowInput(b.id),
        enabled: false,
        expectedRevision: latest.revision
      });
      assert.deepEqual(
        (await f.pool.query("select * from inbound_flow_versions where id=$1", [v1.id])).rows[0],
        v1
      );
      assert.equal((await deleteRecording(f.pool, a.id)).status, "in_use");
      // b also pins via flow; an independent waiting-only published asset must pin before any call exists.
      const waiting = await f.audio("Published waiting only");
      await f.pool.query(
        `insert into inbound_ingress_route_snapshots(configuration_hash,number_id,queue_id,campaign_id,snapshot)
      values($1,$2,$3,$4,$5)`,
        ["b".repeat(64), randomUUID(), q.id, f.campaign, { queue_snapshot: { waiting_audio_id: waiting.id } }]
      );
      assert.equal((await deleteRecording(f.pool, waiting.id)).status, "in_use");
      const protectedDelete = await f.app.inject({
        method: "DELETE",
        url: `/admin/recordings/${waiting.id}`,
        headers: f.headers()
      });
      assert.equal(protectedDelete.statusCode, 409, protectedDelete.body);
      assert.match(protectedDelete.json().message, /retained snapshots/);
      assert.equal(
        (await f.pool.query("select voicemail_recording_id from campaigns where id=$1", [f.campaign])).rows[0]
          .voicemail_recording_id,
        outbound.id
      );
      const unused = await f.audio("Unused");
      const path = (await f.pool.query("select file_path from recordings where id=$1", [unused.id])).rows[0]
        .file_path;
      const r = await f.app.inject({
        method: "DELETE",
        url: `/admin/recordings/${unused.id}`,
        headers: f.headers()
      });
      assert.equal(r.statusCode, 200, r.body);
      await assert.rejects(readFile(path), { code: "ENOENT" });
      await restoreDeletedRecording(f.pool, unused.id);
      assert.equal(
        (await f.pool.query("select voicemail_recording_id from campaigns where id=$1", [f.campaign])).rows[0]
          .voicemail_recording_id,
        outbound.id
      );
      assert.equal(
        (
          await f.app.inject({
            method: "PATCH",
            url: `/admin/recordings/${unused.id}/default`,
            headers: f.headers()
          })
        ).statusCode,
        410
      );
      const other = (await f.pool.query("insert into campaigns(name) values('Other') returning id")).rows[0]
        .id;
      await assert.rejects(
        mutateInboundConfiguration(f.pool, f.actor, "queues", "POST", null, {
          ...f.queueInput(a.id),
          campaignId: other
        }),
        /audio_unavailable/
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F02.2/F02.3 DB: captured waiting audio survives replacement, admission, terminal uncertainty and disable",
  options,
  async () => {
    const f = await fixture();
    try {
      const a = await f.audio(),
        b = await f.audio();
      const q = await f.queue(a.id);
      const row = await f.captured(q.id, a.id);
      await mutateInboundConfiguration(f.pool, f.actor, "queues", "PATCH", q.id, {
        ...f.queueInput(b.id),
        expectedRevision: q.revision
      });
      assert.equal((await deleteRecording(f.pool, a.id)).status, "in_use");
      const operation = await admitInboundQueue(f.pool, row.uuid);
      assert.ok(operation);
      const path = (await f.pool.query("select runtime_file_path from recordings where id=$1", [a.id]))
        .rows[0].runtime_file_path;
      assert.equal(operation.request.audio, path);
      assert.ok((await readFile(path)).length > 0);
      // Terminal history with an unresolved operation still retains its asset.
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [operation.id]);
      await f.pool.query("update calls set state='failed',outcome='failed',ended_at=now() where id=$1", [
        row.uuid
      ]);
      await f.pool.query(
        "update inbound_ingress_evidence set terminal_at=now(),terminal_reason='fixture',evidence_sequence=evidence_sequence+1 where call_id=$1",
        [row.uuid]
      );
      assert.equal((await deleteRecording(f.pool, a.id)).status, "in_use");
      // Explicitly settle only this synthetic operation; the real FS runner supplies native evidence.
      await f.pool.query(
        "update call_operations set state='canceled',resolved_at=now(),resolution_evidence='F02 synthetic terminal fixture' where id=$1",
        [operation.id]
      );
      assert.equal((await deleteRecording(f.pool, a.id)).status, "deleted");
    } finally {
      await f.cleanup();
    }
  }
);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Bind real independent backend connections; only pause before commit to control
// order. pg_blocking_pids proves the competitor is waiting on the database lock.
function boundPool(client: pg.PoolClient, beforeCommit?: () => Promise<void>): pg.Pool {
  return {
    connect: async () =>
      new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, params?: unknown[]) => {
              if (sql === "commit") await beforeCommit?.();
              return target.query(sql, params);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      })
  } as unknown as pg.Pool;
}
for (const resource of ["flows", "queues"] as const) {
  for (const order of ["reference-commit", "reference-rollback", "delete-commit"] as const) {
    test(`F02.3 DB race: ${resource} versus deletion, ${order}`, options, async () => {
      const f = await fixture(),
        held = barrier(),
        resume = barrier();
      let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
      try {
        const audio = await f.audio();
        const a = await f.pool.connect(),
          b = await f.pool.connect();
        const ap = (await a.query("select pg_backend_pid() as p")).rows[0].p;
        const bp = (await b.query("select pg_backend_pid() as p")).rows[0].p;
        const input = resource === "flows" ? f.flowInput(audio.id) : f.queueInput(audio.id);
        const stop = async () => {
          held.resolve();
          await resume.promise;
        };
        if (order === "delete-commit") {
          first = deleteRecording(boundPool(a, stop), audio.id);
          await held.promise;
          second = mutateInboundConfiguration(boundPool(b), f.actor, resource, "POST", null, input);
        } else {
          first = mutateInboundConfiguration(
            boundPool(a),
            f.actor,
            resource,
            "POST",
            null,
            input,
            async () => {
              await stop();
              if (order === "reference-rollback") throw new Error("F02 rollback checkpoint");
            }
          );
          await held.promise;
          second = deleteRecording(boundPool(b), audio.id);
        }
        void first.catch(() => {});
        void second.catch(() => {});
        await assertBlocked(f.pool, bp, ap);
        resume.resolve();
        if (order === "reference-rollback") {
          await assert.rejects(first, /F02 rollback checkpoint/);
          assert.equal(((await second) as { status: string }).status, "deleted");
        } else if (order === "delete-commit") {
          assert.equal(((await first) as { status: string }).status, "deleted");
          await assert.rejects(second, /audio_unavailable/);
        } else {
          await first;
          assert.equal(((await second) as { status: string }).status, "in_use");
        }
      } finally {
        resume.resolve();
        await Promise.allSettled([first, second]);
        await f.cleanup();
      }
    });
  }
}

test(
  "F02.3 DB race: published snapshot pins audio against concurrent deletion before any call exists",
  options,
  async () => {
    const f = await fixture();
    const a = await f.pool.connect(),
      b = await f.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const audio = await f.audio(),
        q = await f.queue(null);
      const ap = (await a.query("select pg_backend_pid() as p")).rows[0].p;
      const bp = (await b.query("select pg_backend_pid() as p")).rows[0].p;
      await a.query("begin");
      // Direct trigger path also takes FOR SHARE, independent of the publisher's lock.
      await a.query(
        `insert into inbound_ingress_route_snapshots(configuration_hash,number_id,queue_id,campaign_id,snapshot)
      values($1,$2,$3,$4,$5)`,
        ["c".repeat(64), randomUUID(), q.id, f.campaign, { queue_snapshot: { waiting_audio_id: audio.id } }]
      );
      pending = deleteRecording(boundPool(b), audio.id);
      void pending.catch(() => {});
      await assertBlocked(f.pool, bp, ap);
      await a.query("commit");
      assert.equal(((await pending) as { status: string }).status, "in_use");
    } finally {
      await a.query("rollback");
      a.release();
      await Promise.allSettled([pending]);
      await f.cleanup();
    }
  }
);

test(
  "F02.3 DB race: queue admission claim holds captured waiting asset through replacement",
  options,
  async () => {
    const f = await fixture(),
      held = barrier(),
      resume = barrier();
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    try {
      const audio = await f.audio(),
        q = await f.queue(audio.id),
        row = await f.captured(q.id, audio.id);
      await mutateInboundConfiguration(f.pool, f.actor, "queues", "PATCH", q.id, {
        ...f.queueInput(null),
        expectedRevision: q.revision
      });
      const a = await f.pool.connect(),
        b = await f.pool.connect();
      const ap = (await a.query("select pg_backend_pid() as p")).rows[0].p;
      const bp = (await b.query("select pg_backend_pid() as p")).rows[0].p;
      first = admitInboundQueue(boundPool(a), row.uuid, async () => {
        held.resolve();
        await resume.promise;
      });
      void first.catch(() => {});
      await held.promise;
      second = deleteRecording(boundPool(b), audio.id);
      void second.catch(() => {});
      await assertBlocked(f.pool, bp, ap);
      resume.resolve();
      await first;
      assert.equal(((await second) as { status: string }).status, "in_use");
    } finally {
      resume.resolve();
      await Promise.allSettled([first, second]);
      await f.cleanup();
    }
  }
);

test(
  "F02 DB upgrade: populated 040 snapshots retain waiting pins and predecessor checksums on replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const audio = await f.audio(),
        q = await f.queue(null);
      await f.pool.query(`drop trigger pin_published_waiting_audio on inbound_ingress_route_snapshots;
      drop function pin_published_waiting_audio();
      drop trigger retain_published_waiting_audio on recordings; drop function retain_published_waiting_audio();
      alter table inbound_ingress_route_snapshots drop column waiting_audio_id;
      delete from schema_migrations where filename='041_inbound_audio_references.sql'`);
      await f.pool.query(
        `insert into inbound_ingress_route_snapshots(configuration_hash,number_id,queue_id,campaign_id,snapshot)
      values($1,$2,$3,$4,$5)`,
        ["d".repeat(64), randomUUID(), q.id, f.campaign, { queue_snapshot: { waiting_audio_id: audio.id } }]
      );
      const snapshots = (
        await f.pool.query(
          "select configuration_hash,number_id,snapshot from inbound_ingress_route_snapshots"
        )
      ).rows;
      const history = (
        await f.pool.query("select * from schema_migrations where filename<'041' order by filename")
      ).rows;
      await runMigrations(f.pool);
      await runMigrations(f.pool);
      assert.deepEqual(
        (await f.pool.query("select * from schema_migrations where filename<'041' order by filename")).rows,
        history
      );
      assert.deepEqual(
        (
          await f.pool.query(
            "select configuration_hash,number_id,snapshot from inbound_ingress_route_snapshots"
          )
        ).rows,
        snapshots
      );
      assert.equal((await deleteRecording(f.pool, audio.id)).status, "in_use");
      await assert.rejects(
        f.pool.query("update recordings set is_active=false where id=$1", [audio.id]),
        /Published waiting audio requires explicit drained retention/
      );
    } finally {
      await f.cleanup();
    }
  }
);
