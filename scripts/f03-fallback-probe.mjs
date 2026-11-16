// Extends the isolated D04 runtime: actual queue timeout and retained-leg audio.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until, decodeUlaw, assertTone } from "./a05-media.mjs";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { inboundFallbackExecutor, advanceInboundFallback } from "../apps/api/dist-test/inbound-fallback.js";
function wav() {
  const b = Buffer.alloc(44 + 32000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / 8000)), 44 + i * 2);
  return b;
}
export async function runFallback({
  f,
  queue,
  directory,
  config,
  startCall,
  recover,
  call,
  clean,
  checked,
  pass,
  executor,
  esl
}) {
  const pool = f.pool,
    bytes = wav();
  await writeFile(join(directory, "f03.wav"), bytes);
  const recording = (
    await pool.query(
      `insert into recordings(campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes) values($1,'F03',$2,'/a02/f03.wav',2,$3) returning id`,
      [f.campaignId, join(directory, "f03.wav"), bytes.length]
    )
  ).rows[0].id;
  const missing = (
    await pool.query(
      `insert into recordings(campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes) values($1,'F03 missing','/tmp/missing.wav','/a02/missing.wav',2,$2) returning id`,
      [f.campaignId, bytes.length]
    )
  ).rows[0].id;
  const flow = (
    await pool.query("insert into inbound_flows(campaign_id,name) values($1,'F03') returning id", [
      f.campaignId
    ])
  ).rows[0].id;
  for (const [index, scenario] of [
    "full",
    "chained",
    "missing",
    "interrupted",
    "deadline",
    "restart_before_send",
    "restart_after_send",
    "restart_after_playback"
  ].entries()) {
    const actions = [
      {
        type: "play_audio",
        recordingId: scenario === "missing" ? missing : recording,
        timeoutMs: scenario === "deadline" ? 1000 : 7000
      }
    ];
    if (scenario === "chained") actions.push({ ...actions[0] });
    actions.push({ type: "hangup" });
    const version = (
      await pool.query(
        `insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot) values($1,$2,$3,20000,$4,'[]') returning id`,
        [flow, f.campaignId, index + 1, JSON.stringify(actions)]
      )
    ).rows[0].id;
    await pool.query(
      "update inbound_queues set no_answer_flow_version_id=$2,queue_timeout_ms=15000,waiting_audio_id=null where id=$1",
      [queue, version]
    );
    assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
    const c = await startCall();
    await recover();
    await until(
      () => checked(async () => Boolean((await call(c.row.uuid)).pstn_answered_at)),
      "F03 waiting answer"
    );
    await until(
      async () =>
        (
          await pool.query("select queue_deadline_at<=clock_timestamp() due from calls where id=$1", [
            c.row.uuid
          ])
        ).rows[0].due,
      "actual queue deadline",
      20000
    );
    assert.equal(
      (await call(c.row.uuid)).ended_at,
      null,
      "configured guard must retain customer past queue deadline"
    );
    let worker = inboundFallbackExecutor(pool, executor, esl);
    const op = await advanceInboundFallback(pool, c.row.uuid);
    assert.ok(op);
    if (scenario === "restart_before_send") {
      assert.equal((await advanceInboundFallback(pool, c.row.uuid)).id, op.id);
      worker = inboundFallbackExecutor(pool, executor, esl);
    }
    await worker.tick(c.row.uuid);
    if (scenario === "restart_after_send") worker = inboundFallbackExecutor(pool, executor, esl);
    if (scenario === "interrupted") {
      await until(
        async () =>
          (
            await pool.query(
              "select 1 from call_events where call_id=$1 and event_type='inbound_fallback_started' and raw_json->>'operationId'=$2",
              [c.row.uuid, op.id]
            )
          ).rowCount,
        "playback actually started"
      );
      c.control.hangup();
    }
    if (scenario === "restart_after_playback") {
      await until(
        async () =>
          (
            await pool.query(
              "select 1 from call_events where call_id=$1 and event_type='inbound_fallback_completed'",
              [c.row.uuid]
            )
          ).rowCount,
        "playback evidence before operation persistence"
      );
      assert.equal(
        (await pool.query("select state from call_operations where id=$1", [op.id])).rows[0].state,
        "uncertain"
      );
      worker = inboundFallbackExecutor(pool, executor, esl);
    }
    await until(
      () =>
        checked(async () => {
          await worker.tick(c.row.uuid);
          return Boolean((await call(c.row.uuid)).ended_at);
        }),
      `F03 ${scenario} terminal`,
      15000
    );
    const result = await c.result;
    await until(
      () =>
        checked(async () => {
          await worker.tick(c.row.uuid);
          return !(
            await pool.query("select 1 from call_operations where call_id=$1 and resolved_at is null", [
              c.row.uuid
            ])
          ).rowCount;
        }),
      "all fallback operations resolved"
    );
    await recover();
    await clean(c.row.uuid);
    const operations = (
      await pool.query(
        "select * from call_operations where call_id=$1 and request->>'inboundFallback'='true' order by (request->>'step')::int",
        [c.row.uuid]
      )
    ).rows;
    const events = (
      await pool.query(
        "select event_type,raw_json from call_events where call_id=$1 and event_type like 'inbound_fallback_%' order by id",
        [c.row.uuid]
      )
    ).rows;
    assert.equal(operations[0].id, op.id);
    assert.equal(
      operations[0].result.outcome,
      scenario === "missing"
        ? "failed"
        : scenario === "interrupted" || scenario === "deadline"
          ? "interrupted"
          : "completed"
    );
    assert.equal(
      operations.filter((o) => o.command_kind === "play_audio").length,
      scenario === "chained" ? 2 : 1
    );
    const completed = events.filter((e) => e.event_type === "inbound_fallback_completed");
    assert.equal(
      completed.length,
      scenario === "missing" || scenario === "interrupted" || scenario === "deadline"
        ? 0
        : scenario === "chained"
          ? 2
          : 1
    );
    if (completed.length) {
      const samples = result.rtp.filter((p) => p.type === 0).flatMap((p) => p.payload.map(decodeUlaw));
      // Last playback segment before hangup/park, independent of the 440 Hz waiting tone.
      const tail = samples.slice(-1600);
      assertTone(tail, 660);
    }
    await pass(`F03 actual ${scenario}`, {
      uuid: c.row.uuid,
      operations,
      events,
      sip: result.final,
      audio: result.audio
    });
  }
  await pool.query("update inbound_queues set no_answer_flow_version_id=null where id=$1", [queue]);
  assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
}
