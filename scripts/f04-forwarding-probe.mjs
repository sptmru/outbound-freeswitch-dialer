import { relay } from "./a05-executor.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { endpoint, until, decodeUlaw, assertTone } from "./a05-media.mjs";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { inboundFallbackExecutor, advanceInboundFallback } from "../apps/api/dist-test/inbound-fallback.js";
export async function runForwarding({
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
  esl,
  command
}) {
  const pool = f.pool;
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
  await writeFile(join(directory, "f04.wav"), bytes);
  const audio = (
    await pool.query(
      "insert into recordings(campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes) values($1,'F04',$2,'/a02/f04.wav',1,$3) returning id",
      [f.campaignId, join(directory, "f04.wav"), bytes.length]
    )
  ).rows[0].id;
  const flow = (
    await pool.query("insert into inbound_flows(campaign_id,name) values($1,'F04') returning id", [
      f.campaignId
    ])
  ).rows[0].id;
  for (const [index, scenario] of [
    "answered",
    "busy",
    "rejected",
    "no_answer",
    "caller_exit_late_answer",
    "restart_before_send",
    "restart_after_send",
    "lost_response",
    "originate_failure"
  ].entries()) {
    if (process.env.F04_SCENARIO && process.env.F04_SCENARIO !== scenario) continue;
    let releaseAnswer = () => {},
      cancels = 0;
    const held = ["no_answer", "caller_exit_late_answer"].includes(scenario);
    const answerGate = held ? new Promise((r) => (releaseAnswer = r)) : undefined;
    const phone = await endpoint({
      username: "external",
      password: "fixture",
      source: "127.0.0.3",
      frequency: 880,
      rejectCode: scenario === "busy" ? 486 : scenario === "rejected" ? 603 : undefined,
      answerGate,
      onCancel: () => cancels++
    });
    try {
      const forwarding = {
        SIP_TRUNK_MODE: scenario === "originate_failure" ? "registration" : "ip_auth",
        SIP_TRUNK_USERNAME: "unconfigured-disposable-gateway",
        SIP_TRUNK_PROXY: phone.address,
        SIP_TRUNK_CALLER_ID: "+12025550100"
      };
      const version = (
        await pool.query(
          "insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot) values($1,$2,$3,20000,$4,'[]') returning id",
          [
            flow,
            f.campaignId,
            index + 1,
            JSON.stringify([
              { type: "forward_external", target: "+14155550101", timeoutMs: 5000 },
              { type: "play_audio", recordingId: audio, timeoutMs: 5000 },
              { type: "hangup" }
            ])
          ]
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
        "F04 customer waiting"
      );
      await until(
        async () =>
          (
            await pool.query("select queue_deadline_at<=clock_timestamp() due from calls where id=$1", [
              c.row.uuid
            ])
          ).rows[0].due,
        "queue deadline",
        20000
      );
      let worker = inboundFallbackExecutor(pool, executor, esl, forwarding);
      const op = await advanceInboundFallback(pool, c.row.uuid, undefined, forwarding);
      assert.equal(op.command_kind, "forward_external");
      if (scenario === "restart_before_send")
        worker = inboundFallbackExecutor(pool, executor, esl, forwarding);
      if (scenario === "lost_response") {
        const wire = await relay();
        try {
          worker = inboundFallbackExecutor(pool, executor, { ...esl, port: wire.port }, forwarding);
          const pending = worker.tick(c.row.uuid);
          await until(() => wire.queued, "fixed forwarding frame held");
          wire.forward();
          await pending;
          assert.equal(wire.sends.length, 1);
        } finally {
          await wire.close();
        }
        worker = inboundFallbackExecutor(pool, executor, esl, forwarding);
      } else await worker.tick(c.row.uuid);
      if (scenario !== "originate_failure") {
        await until(() => phone.invites.length, "native external INVITE");
        assert.match(phone.invites[0].headers.from, /12025550100/);
      }
      if (scenario === "restart_after_send")
        worker = inboundFallbackExecutor(pool, executor, esl, forwarding);
      const successful = ["answered", "restart_before_send", "restart_after_send", "lost_response"].includes(
        scenario
      );
      if (successful) {
        await until(
          () =>
            checked(
              async () =>
                (
                  await pool.query(
                    "select 1 from call_participants where call_id=$1 and role='external' and connected_at is not null",
                    [c.row.uuid]
                  )
                ).rowCount
            ),
          "exact native bridge"
        );
        await until(() => phone.received.length > 3200, "customer audio at external endpoint");
        assertTone(phone.received.slice(-1600), 440);
        if (scenario === "answered") {
          await until(
            () => Date.now() > Number(op.request.flowDeadlineEpoch) * 1000 + 1000,
            "past original flow guard",
            25000
          );
          assert.equal(
            (await call(c.row.uuid)).ended_at,
            null,
            "connected conversation survives flow deadline"
          );
        }
        if (scenario === "restart_after_send")
          await command(`uuid_kill ${op.request.externalUuid} NORMAL_CLEARING`);
        else c.control.hangup();
      } else if (scenario === "caller_exit_late_answer") {
        c.control.hangup();
        await until(() => cancels > 0, "native CANCEL after customer exit");
        releaseAnswer();
      }
      await until(
        () =>
          checked(async () => {
            await worker.tick(c.row.uuid);
            return Boolean((await call(c.row.uuid)).ended_at);
          }),
        `F04 ${scenario} terminal`,
        20000
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
        "forward operations resolved",
        15000
      );
      await recover();
      await clean(c.row.uuid);
      assert.equal(
        new Set(phone.invites.map((i) => i.id)).size,
        scenario === "originate_failure" ? 0 : 1,
        "at most one logical external dial"
      );
      assert.equal(await command(`uuid_exists ${op.request.externalUuid}`), "false");
      const operations = (
        await pool.query(
          "select * from call_operations where call_id=$1 and request->>'inboundFallback'='true' order by (request->>'step')::int",
          [c.row.uuid]
        )
      ).rows;
      assert.equal(operations[0].id, op.id);
      assert.equal(operations[0].result.outcome, successful ? "connected" : "failed");
      const samples = result.rtp.filter((p) => p.type === 0).flatMap((p) => p.payload.map(decodeUlaw));
      if (successful) assertTone(samples.slice(-1600), 880);
      if (["busy", "rejected", "no_answer", "originate_failure"].includes(scenario)) {
        assert.ok(
          operations.some((o) => o.command_kind === "play_audio"),
          "saved failure continuation"
        );
        assertTone(samples.slice(-1600), 660);
      }
      if (held) assert.ok(cancels > 0);
      await pass(`F04 native ${scenario}`, {
        uuid: c.row.uuid,
        externalUuid: op.request.externalUuid,
        operations,
        cancels,
        invites: phone.invites,
        audio: result.audio
      });
    } finally {
      phone.close();
    }
  }
  await pool.query("update inbound_queues set no_answer_flow_version_id=null where id=$1", [queue]);
  assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
}
