// Extends the isolated D04 product-entrypoint runner. Real SIP/RTP waiting playback;
// no F03 fallback implementation, browser, provider, or production activation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRecording, deleteRecording } from "../apps/api/dist-test/dashboard/recordings.js";
import { mutateInboundConfiguration } from "../apps/api/dist-test/inbound-admin.js";
import {
  saveInboundQueueSchema,
  saveInboundFlowSchema
} from "../apps/api/dist-test/call-coordination-contracts.js";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { until, decodeUlaw, assertTone } from "./a05-media.mjs";
const receipt = () => ({ idempotencyKey: randomUUID(), expectedRevision: null });
function tone(frequency) {
  const rate = 8000,
    data = rate * 2 * 2,
    b = Buffer.alloc(44 + data);
  b.write("RIFF");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < data / 2; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / rate)), 44 + i * 2);
  return b;
}
export async function runInboundAudioReplacement({
  f,
  queue,
  directory,
  config,
  startCall,
  recover,
  call,
  clean,
  checked,
  pass
}) {
  const pool = f.pool;
  const owner = (
    await pool.query(
      "insert into users(email,name,password_hash,role) values($1,'F02','fixture','admin') returning *",
      [`${randomUUID()}@test`]
    )
  ).rows[0];
  const actor = { id: owner.id, authVersion: owner.auth_version, requestId: "f02-fs" };
  const audio = async (name, frequency, useForCampaign = false) => {
    const filename = `f02-${name}.wav`,
      filePath = join(directory, filename),
      runtimeFilePath = `/a02/${filename}`;
    const bytes = tone(frequency);
    await writeFile(filePath, bytes);
    return createRecording(pool, {
      name,
      campaignId: f.campaignId,
      useForCampaign,
      filePath,
      runtimeFilePath,
      durationSeconds: 2,
      fileSizeBytes: bytes.length
    });
  };
  const outbound = await audio("outbound", 440, true),
    a = await audio("old", 660),
    b = await audio("new", 880);
  const flowInput = (id) =>
    saveInboundFlowSchema.parse({
      ...receipt(),
      campaignId: f.campaignId,
      name: "F02 FS flow",
      definition: {
        flowTimeoutMs: 90000,
        actions: [{ type: "play_audio", recordingId: id, timeoutMs: 10000 }, { type: "hangup" }]
      }
    });
  const flow = await mutateInboundConfiguration(pool, actor, "flows", "POST", null, flowInput(a.id));
  const queueInput = (id, version, revision) =>
    saveInboundQueueSchema.parse({
      ...receipt(),
      expectedRevision: revision,
      campaignId: f.campaignId,
      name: "F02 FS queue",
      waitingRecordingId: id,
      noAnswerFlowVersionId: version,
      configuration: { queueTimeoutMs: 15000 }
    });
  let q = (await pool.query("select * from inbound_queues where id=$1", [queue])).rows[0];
  await mutateInboundConfiguration(
    pool,
    actor,
    "queues",
    "PATCH",
    queue,
    queueInput(a.id, flow.versionId, q.desired_revision)
  );
  assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
  const oldVersion = (await pool.query("select * from inbound_flow_versions where id=$1", [flow.versionId]))
    .rows[0];
  const started = Date.now(),
    c = await startCall();
  await recover();
  await until(
    () => checked(async () => Boolean((await call(c.row.uuid)).pstn_answered_at)),
    "F02 waiting answer"
  );
  await delay(400); // media observation window, not a race-order control
  const replacementMs = Date.now() - started;
  const v2 = await mutateInboundConfiguration(pool, actor, "flows", "PATCH", flow.id, {
    ...flowInput(b.id),
    expectedRevision: flow.revision
  });
  q = (await pool.query("select * from inbound_queues where id=$1", [queue])).rows[0];
  const [replacement, deletion] = await Promise.all([
    mutateInboundConfiguration(
      pool,
      actor,
      "queues",
      "PATCH",
      queue,
      queueInput(b.id, v2.versionId, q.desired_revision)
    ),
    deleteRecording(pool, a.id)
  ]);
  assert.equal(deletion.status, "in_use");
  assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
  assert.deepEqual(
    (await pool.query("select * from inbound_flow_versions where id=$1", [flow.versionId])).rows[0],
    oldVersion
  );
  const op = (
    await pool.query(
      "select o.* from call_operations o join inbound_queue_admissions a on a.operation_id=o.id where a.call_id=$1",
      [c.row.uuid]
    )
  ).rows[0];
  assert.equal(op.request.audio, "/a02/f02-old.wav");
  assert.equal(
    (await pool.query("select voicemail_recording_id from campaigns where id=$1", [f.campaignId])).rows[0]
      .voicemail_recording_id,
    outbound.id
  );
  assert.ok((await readFile(join(directory, "f02-old.wav"))).length > 0);
  await delay(600);
  c.control.hangup();
  const result = await c.result;
  assert.equal(result.final, 200);
  assert.ok(result.bye);
  const samples = (predicate) =>
    result.rtp.filter((p) => p.type === 0 && predicate(p.ms)).flatMap((p) => p.payload.map(decodeUlaw));
  const before = assertTone(
    samples((ms) => ms < replacementMs),
    660
  );
  const after = assertTone(
    samples((ms) => ms > replacementMs + 100),
    660
  );
  await until(() => checked(async () => Boolean((await call(c.row.uuid)).ended_at)), "F02 customer terminal");
  await recover();
  await clean(c.row.uuid);
  assert.equal((await deleteRecording(pool, a.id)).status, "in_use");
  await pass("F02.2/F02.3 real waiting WAV survives concurrent replacement/deletion and flow v2", {
    uuid: c.row.uuid,
    operation: op.id,
    oldVersion: flow.versionId,
    newVersion: v2.versionId,
    replacement: replacement.id,
    deletion,
    before,
    after,
    terminal: await call(c.row.uuid)
  });
  const next = await startCall();
  await recover();
  await until(
    () => checked(async () => Boolean((await call(next.row.uuid)).pstn_answered_at)),
    "F02 replacement answer"
  );
  await delay(400);
  next.control.hangup();
  const nextResult = await next.result;
  assert.equal(nextResult.final, 200);
  assert.ok(nextResult.bye);
  const fresh = assertTone(
    nextResult.rtp.filter((p) => p.type === 0).flatMap((p) => p.payload.map(decodeUlaw)),
    880
  );
  await until(() => checked(async () => Boolean((await call(next.row.uuid)).ended_at)), "F02 next terminal");
  await recover();
  await clean(next.row.uuid);
  await pass("F02.2 real subsequent call selects replacement audio", {
    uuid: next.row.uuid,
    audio: fresh,
    terminal: await call(next.row.uuid)
  });
  // Restore only the fixture queue's tone for the existing D04 regression matrix.
  q = (await pool.query("select * from inbound_queues where id=$1", [queue])).rows[0];
  await mutateInboundConfiguration(
    pool,
    actor,
    "queues",
    "PATCH",
    queue,
    queueInput(null, null, q.desired_revision)
  );
  assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
}
