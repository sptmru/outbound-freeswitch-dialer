import assert from "node:assert/strict";
import { loadDesk, loadMutation } from "../tests/fixtures/inbound/load-desk.mjs";
import { readIngressRecords } from "../apps/api/dist-test/ingress-agent.js";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { dispatchInboundOffers } from "../apps/api/dist-test/inbound-dispatcher.js";
import { createTransferOffer, mutateTransferOffer } from "../apps/api/dist-test/transfer-offers.js";
import { transferConnectionExecutor } from "../apps/api/dist-test/transfer-connection.js";
import { inboundFallbackExecutor } from "../apps/api/dist-test/inbound-fallback.js";
import { invite } from "./a02-ingress-probe.mjs";
import { assertTone, decodeUlaw, endpoint, until } from "./a05-media.mjs";
import { recordingProbe } from "./h02-recording-probe.mjs";

export async function runSipRtpMixed({
  f,
  socket,
  config,
  app,
  limited,
  esl,
  command,
  recover,
  runtime,
  clean,
  pass
}) {
  const { pool } = f;
  const one = (sql, values) => pool.query(sql, values).then(({ rows }) => rows[0]);
  const devices = [];
  const calls = [];
  const jobs = [];
  const transfer = transferConnectionExecutor(pool, limited.executor, esl);
  let releaseTargets = () => {};
  const answerGate = new Promise((release) => {
    releaseTargets = release;
  });
  async function start(index, did) {
    const caller = `+120255501${80 + index}`;
    let control;
    const promise = invite({
      port: 5090,
      caller,
      did,
      frequency: 880,
      maxRtpPort: 20160,
      timeoutMs: 45000,
      control: (c) => {
        control = c;
      }
    });
    promise.catch(() => {});
    const call = {
      promise,
      get control() {
        return control;
      },
      wire: undefined
    };
    calls.push(call);
    const record = await until(
      async () => (await readIngressRecords(socket)).find((row) => row.callingNumber === caller),
      "I03 mixed exact journal capture"
    );
    call.id = record.uuid;
    return call;
  }
  const device = async (username, frequency, extra) => {
    const phone = await endpoint({
      username,
      password: "fixture",
      source: "127.0.0.3",
      frequency,
      maxRtpPort: 20160,
      ...extra
    });
    devices.push(phone);
    return phone;
  };
  const speaker = (call, frequency) =>
    assertTone(
      call.wire.rtp.slice(-15).flatMap(({ payload }) => payload.map(decodeUlaw)),
      frequency
    );
  async function finish(call) {
    call.control.hangup();
    call.wire = await call.promise;
    assert.equal(call.wire.final, 200);
    assert.ok(call.wire.bye);
  }
  async function recording(call) {
    const artifact = await recordingProbe({ pool, callId: call.id, customerUuid: call.id, command });
    assert.ok(artifact, "I03 mixed recording is required");
    return artifact;
  }
  try {
    const secondary = await one(
      "insert into campaigns(name,status,call_recording_enabled) values('I03 forwarding','active',true) returning id"
    );
    const flow = await one("insert into inbound_flows(campaign_id,name) values($1,'I03') returning id", [
      secondary.id
    ]);
    const version = await one(
      `insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot)
       values($1,$2,1,30000,$3,'[]') returning id`,
      [
        flow.id,
        secondary.id,
        JSON.stringify([
          { type: "forward_external", target: "+14155550101", timeoutMs: 20000 },
          { type: "hangup" }
        ])
      ]
    );
    const queue = await one(
      "insert into inbound_queues(campaign_id,name,queue_timeout_ms,no_answer_flow_version_id) values($1,'I03 forwarding',15000,$2) returning id",
      [secondary.id, version.id]
    );
    const did = "+12025550101";
    await pool.query(
      "insert into inbound_numbers(normalized_did,label,queue_id,enabled) values($1,'I03 forwarding',$2,true)",
      [did, queue.id]
    );
    assert.equal(await new InboundConfigurationPublisher(pool, config).reconcile(), "applied");
    const external = await device("i03_external", 990);
    const forward = inboundFallbackExecutor(pool, limited.executor, esl, {
      SIP_TRUNK_MODE: "ip_auth",
      SIP_TRUNK_PROXY: external.address,
      SIP_TRUNK_CALLER_ID: "+12025550100"
    });
    const forwarded = await start(0, did);
    await recover();
    const forwardRecording = await recording(forwarded);
    await forwardRecording.mark("answered waiting", [440]);
    const agents = [];
    for (let i = 0; i < 2; i++) {
      const source = await loadDesk(pool, config, f.campaignId, `i03-mixed-from-${i}`, (username) =>
        device(username, 660)
      );
      const target = await loadDesk(pool, config, f.campaignId, `i03-mixed-to-${i}`, (username) =>
        device(username, 550, { answerGate })
      );
      agents.push({ source, target });
    }
    await until(
      async () =>
        (
          await one("select queue_deadline_at<=clock_timestamp() as due from calls where id=$1", [
            forwarded.id
          ])
        ).due,
      "I03 second queue deadline",
      18000
    );
    await forward.tick(forwarded.id);
    await until(
      async () =>
        (
          await one(
            "select 1 as connected from call_participants where call_id=$1 and role='external' and connected_at is not null",
            [forwarded.id]
          )
        )?.connected,
      "I03 native external bridge"
    );
    await forwardRecording.mark("external conversation", [880, 990]);
    await pool.query("update agent_desk_sessions set verified_at=clock_timestamp()");
    for (let i = 0; i < agents.length; i++) {
      const pair = agents[i];
      const call = await start(i + 1);
      pair.call = call;
      await recover();
      const offer = await dispatchInboundOffers(pool, pair.source.id);
      assert.equal(offer?.callId, call.id);
      const response = await app.inject({
        method: "POST",
        url: `/agent/call-offers/${offer.id}/accept`,
        headers: pair.source.headers,
        payload: loadMutation(pair.source)
      });
      assert.equal(response.statusCode, 200, response.body);
      await runtime.wakeExecutor(response.json().operationId);
      await until(
        async () => (await one("select state from calls where id=$1", [call.id])).state === "agent_connected",
        "I03 native source bridge"
      );
      pair.recording = await recording(call);
      await pair.recording.mark("source conversation", [880, 660]);
    }
    for (const { call, source, target } of agents) {
      const offer = await createTransferOffer(
        pool,
        { userId: source.userId, agentId: source.id, authVersion: 1 },
        call.id,
        { ...loadMutation(source), recipientAgentId: target.id }
      );
      assert.ok(offer.offerId, JSON.stringify(offer));
      const accepted = await mutateTransferOffer(
        pool,
        { userId: target.userId, agentId: target.id, authVersion: 1 },
        offer.offerId,
        loadMutation(target),
        "accept"
      );
      assert.equal(accepted.status, "connecting", JSON.stringify(accepted));
      call.transferId = offer.transfer.id;
      const job = transfer.wakeExecutor(accepted.operationId);
      job.catch(() => {});
      jobs.push(job);
    }
    await until(
      () => agents.every(({ target }) => target.phone.invites.length === 1),
      "both actual transfer INVITEs"
    );
    const overlap = await one(
      `select count(*) filter (where resource_type='transfer_overlap')::int transfers,
              count(*) filter (where resource_type='external_forward')::int forwarding
       from call_capacity_reservations where state<>'released'`
    );
    assert.deepEqual(overlap, { transfers: 2, forwarding: 1 });
    for (const { call, source } of agents) {
      assert.equal((await one("select agent_id from calls where id=$1", [call.id])).agent_id, source.id);
      assertTone(source.phone.received.slice(-2400), 880);
    }
    assertTone(external.received.slice(-2400), 880);
    releaseTargets();
    await Promise.all(jobs);
    await until(async () => {
      await transfer.reconcile();
      const result = await one("select count(*)::int completed from call_transfers where state='completed'");
      return result.completed === 2;
    }, "both confirmed transfers");
    for (const pair of agents) {
      assert.equal(
        (await one("select agent_id from calls where id=$1", [pair.call.id])).agent_id,
        pair.target.id
      );
      await until(() => pair.target.phone.received.length >= 2400, "transferred customer retained audio");
      assertTone(pair.target.phone.received.slice(-2400), 880);
      await pair.recording.mark("recipient conversation", [880, 550]);
    }
    const externalInvites = new Set(external.invites.map(({ id }) => id)).size;
    assert.equal(externalInvites, 1);
    for (const pair of agents) {
      await finish(pair.call);
      speaker(pair.call, 550);
      await transfer.reconcile();
      await clean(pair.call.id);
    }
    await finish(forwarded);
    speaker(forwarded, 990);
    await until(
      async () => {
        await forward.tick(forwarded.id);
        const remaining = await one(
          "select count(*)::int as n from call_operations where call_id=$1 and resolved_at is null",
          [forwarded.id]
        );
        return remaining.n === 0;
      },
      "I03 exact terminal forwarding receipt persisted",
      15000
    );
    await clean(forwarded.id);
    await recover();
    const recordings = [];
    for (const capture of [forwardRecording, ...agents.map((pair) => pair.recording)])
      recordings.push(await capture.finish());
    await pass(
      "I03.2 two concurrent native transfers overlap one external forward with retained recordings",
      {
        overlap,
        externalInvites,
        customerIds: calls.map(({ id }) => id),
        recordings
      }
    );
  } finally {
    releaseTargets();
    for (const call of calls) {
      if (call.wire || !call.control) continue;
      try {
        call.control.cancel();
        call.control.hangup();
      } catch (error) {
        if (error.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING")
          console.error("I03 mixed caller cleanup failed", error.message);
      }
    }
    await Promise.allSettled([...jobs, ...calls.map(({ promise }) => promise)]);
    for (const phone of devices) phone.close();
  }
}
