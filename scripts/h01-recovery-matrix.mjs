import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { open, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until, endpoint, assertTone, decodeUlaw } from "./a05-media.mjs";
import { InboundConfigurationPublisher } from "../apps/api/dist-test/freeswitch/inbound-config.js";
import { createTransferOffer, mutateTransferOffer } from "../apps/api/dist-test/transfer-offers.js";
import { relay } from "./a05-executor.mjs";
import { DatabaseSync } from "node:sqlite";
import { ingressRequest, readIngressRecords } from "../apps/api/dist-test/ingress-agent.js";
import { openEsl, invite } from "./a02-ingress-probe.mjs";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
import {
  inboundConnectionCommand,
  validateInboundConnection
} from "../apps/api/dist-test/inbound-connection.js";

export async function proveLifecycleRecovery({
  f,
  limited,
  directory,
  socket,
  esl,
  config,
  phone,
  command,
  pass,
  startCall,
  accept,
  restartJournal
}) {
  const log = await open(join(directory, "h01-worker.log"), "a");
  const database = {
    host: join(directory, "socket"),
    database: "e02",
    user: "postgres",
    options: `-c search_path=${f.schema}`,
    connectionTimeoutMillis: 2000
  };
  let child,
    messages = [],
    forwarding;
  const history = [];
  const children = new Set();
  async function end(c) {
    try {
      c.control.hangup();
    } catch (e) {
      if (e.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw e;
    }
    return c.result;
  }
  async function wait(type, ms = 10000) {
    return until(() => messages.find((x) => x.type === type), `H01 worker ${type}`, ms);
  }
  function launch(extra) {
    const worker = fork(new URL("./h01-recovery-worker.mjs", import.meta.url), [], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", log.fd, log.fd, "ipc"]
    });
    const inbox = [];
    children.add(worker);
    worker.once("exit", () => children.delete(worker));
    worker.on("message", (m) => {
      inbox.push(m);
      history.push(m);
    });
    worker.send({ database, executor: limited.database, socket, esl, forwarding, ...extra });
    return { worker, inbox };
  }
  function adopt(worker) {
    assert.equal(child, undefined);
    child = worker.worker;
    messages = worker.inbox;
  }
  async function start(extra = {}) {
    adopt(launch(extra));
    await wait(extra.checkpoint ? "checkpoint" : "subscribed");
    if (!extra.checkpoint && !extra.stopBefore) await wait("pass", 15000);
  }
  async function killWorker(worker) {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    const exit = once(worker, "exit");
    worker.kill("SIGKILL");
    await exit;
  }
  async function stop() {
    if (!child) return;
    await killWorker(child);
    child = undefined;
  }
  const call = async (id) => (await f.pool.query("select * from calls where id=$1", [id])).rows[0];
  async function clean(id) {
    await until(
      async () => {
        const r = (
          await f.pool.query(
            `select
        (select count(*) from call_operations where call_id=$1 and resolved_at is null)::int as operations,
        (select count(*) from call_capacity_reservations where call_id=$1 and state<>'released')::int as capacity,
        (select count(*) from agent_call_slots where call_id=$1 and state<>'free')::int as slots,
        (select count(*) from call_legs where call_id=$1 and ended_at is null)::int as legs`,
            [id]
          )
        ).rows[0];
        return Object.values(r).every((v) => v === 0);
      },
      `H01 complete persisted cleanup ${id}`,
      25000
    );
    assert.ok((await call(id)).ended_at);
  }
  async function sameDeadline(id, before) {
    const after = await call(id);
    assert.deepEqual(
      [after.arrived_at, after.queue_deadline_at, after.campaign_id],
      [before.arrived_at, before.queue_deadline_at, before.campaign_id]
    );
  }
  async function waitForTerminalAck(id) {
    await until(
      async () =>
        (
          await f.pool.query(
            `select 1 from inbound_ingress_evidence
             where ingress_id=$1 and terminal_at is not null and acknowledged_sequence=evidence_sequence`,
            [id]
          )
        ).rowCount === 1,
      "exact terminal journal sequence acknowledged",
      5000
    );
  }
  async function freshDesk() {
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp(),actor_auth_version=1 where id=$1",
      [f.input.deskSessionId]
    );
  }
  async function waiting(id) {
    return (
      (
        await f.pool.query(
          "select 1 from calls c join inbound_queue_admissions a on a.call_id=c.id join call_operations o on o.id=a.operation_id where c.id=$1 and c.state='queued' and c.pstn_answered_at is not null and o.state='succeeded'",
          [id]
        )
      ).rowCount > 0
    );
  }
  async function connected() {
    await freshDesk();
    const c = await startCall();
    await until(async () => await waiting(c.row.uuid), "H01 queue admission", 10000);
    await stop();
    const a = await accept(c);
    const before = await call(c.row.uuid);
    assert.equal(before.state, "connecting");
    await start();
    await until(
      async () => (await call(c.row.uuid)).state === "agent_connected",
      "H01 recovered connection",
      18000
    );
    await sameDeadline(c.row.uuid, before);
    return { c, a, before };
  }
  try {
    // Kill the actual worker at an import or admission boundary before its ACK.
    for (const checkpoint of ["before-insert", "after-commit", "after-admission-commit"]) {
      // The native poll is only ten 100 ms iterations. Start both OS processes
      // before SIP arrival so this case measures the outage, not module loading.
      const faulted = launch({ checkpoint, waitForResume: true });
      const replacement = launch({ waitForResume: true });
      await until(
        () => [faulted, replacement].every((w) => w.inbox.some((m) => m.type === "prepared")),
        "crash worker and replacement initialized"
      );
      const live = await startCall();
      adopt(faulted);
      child.send({ callId: live.row.uuid });
      await wait("checkpoint");
      await stop();
      const before = await call(live.row.uuid);
      assert.equal(
        before?.state,
        { "before-insert": undefined, "after-commit": "received", "after-admission-commit": "queued" }[
          checkpoint
        ]
      );
      assert.equal(await command(`uuid_exists ${live.row.uuid}`), "true");
      const waitingOperation = async () =>
        (
          await f.pool.query(
            `select o.id, o.command_uuid, o.state from inbound_queue_admissions a
             join call_operations o on o.id=a.operation_id where a.call_id=$1`,
            [live.row.uuid]
          )
        ).rows[0];
      const beforeAdmissionAck = await waitingOperation();
      if (checkpoint === "after-admission-commit") {
        assert.equal(beforeAdmissionAck?.state, "pending");
        assert.equal(before.pstn_answered_at, null);
      } else assert.equal(beforeAdmissionAck, undefined);
      const beforeRecovery = performance.now();
      adopt(replacement);
      child.send({});
      await wait("subscribed");
      await until(() => waiting(live.row.uuid), "live ingress reaches confirmed waiting after worker loss");
      const recoveryMs = performance.now() - beforeRecovery;
      const operation = await waitingOperation();
      if (beforeAdmissionAck) {
        assert.equal(operation.id, beforeAdmissionAck.id);
        assert.equal(operation.command_uuid, beforeAdmissionAck.command_uuid);
      }
      const active = await call(live.row.uuid);
      if (before) await sameDeadline(live.row.uuid, before);
      await until(() => live.control.packets().length >= 15, "actual RTP on recovered caller");
      const result = await end(live);
      assert.equal(result.final, 200);
      const waitingTone = assertTone(
        result.rtp.slice(-15).flatMap((p) => p.payload.map(decodeUlaw)),
        440
      );
      await clean(live.row.uuid);
      await waitForTerminalAck(live.row.uuid);
      await stop();
      const replay = (
        await f.pool.query(
          `select
            (extract(epoch from c.arrived_at)*1000000)::bigint::text as arrived,
            (select count(*)::int from call_operations o where o.call_id=c.id and o.request->>'inboundWaiting'='true') as operations,
            (select count(*)::int from call_events e where e.call_id=c.id and e.event_type='inbound_waiting_started') as waiting_events,
            (select count(*)::int from call_execution_attempts where operation_id=$2) as command_attempts
          from calls c where c.id=$1`,
          [live.row.uuid, operation.id]
        )
      ).rows[0];
      assert.deepEqual(replay, {
        arrived: String(live.row.arrivedUs),
        operations: 1,
        waiting_events: 1,
        command_attempts: 1
      });
      await pass(`I02.2 live caller recovers after ${checkpoint} worker loss`, {
        callId: live.row.uuid,
        sipCallId: result.callId,
        sip: result.messages.map(({ first, ms }) => ({ first, ms })),
        checkpoint,
        queueDeadline: active.queue_deadline_at,
        operation,
        recoveryMs,
        waitingTone,
        ...replay
      });

      if (checkpoint === "after-admission-commit") continue;
      const c = await startCall();
      await start({ checkpoint, callId: c.row.uuid });
      await stop();
      const count = (await f.pool.query("select count(*)::int n from calls where id=$1", [c.row.uuid]))
        .rows[0].n;
      assert.equal(count, checkpoint === "before-insert" ? 0 : 1);
      await restartJournal();
      await end(c);
      await start();
      await until(
        async () => Boolean((await call(c.row.uuid))?.ended_at),
        "H01 ended-during-outage journal import",
        15000
      );
      await clean(c.row.uuid);
      await waitForTerminalAck(c.row.uuid);
      const stamps = (
        await f.pool.query(
          `select (extract(epoch from arrived_at)*1000000)::bigint::text as arrived,
             pstn_answered_at, agent_connected_at, fallback_started_at,
             (select count(*)::int from call_operations where call_id=$1) as operations,
             (select count(*)::int from call_offers where call_id=$1) as offers
           from calls where id=$1`,
          [c.row.uuid]
        )
      ).rows[0];
      assert.deepEqual(stamps, {
        arrived: String(c.row.arrivedUs),
        pstn_answered_at: null,
        agent_connected_at: null,
        fallback_started_at: null,
        operations: 0,
        offers: 0
      });
      await pass(
        `H01.3 composed ${checkpoint} worker SIGKILL, journal process restart and ended-during-outage replay`,
        { callId: c.row.uuid, checkpoint, terminalOnly: stamps, history: [...history] }
      );
      await stop();
    }
    // Re-run D03 capture faults with this composition as the only importer.
    async function refused() {
      const result = await invite({ port: 5090, timeoutMs: 5000 });
      assert.equal(result.final, 503);
      assert.equal(result.rtp.length, 0);
      assert.ok(result.messages.find((m) => m.first.startsWith("SIP/2.0 503")).ms < 3000);
    }
    await restartJournal(refused);
    const lock = new DatabaseSync(join(directory, "ingress.sqlite"));
    lock.exec("BEGIN IMMEDIATE");
    try {
      await refused();
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    const journalPid = Number(await readFile(join(directory, "journal-agent.pid"), "utf8"));
    process.kill(journalPid, "SIGSTOP");
    try {
      await refused();
    } finally {
      process.kill(journalPid, "SIGCONT");
    }
    const { capacity, unacknowledged } = JSON.parse(await ingressRequest(socket, "/status"));
    assert.equal(unacknowledged, 0, "journal exhaustion starts without pending receipts from prior cases");
    const captured = [];
    for (let n = 0; n < capacity; n++) {
      const c = await startCall();
      await c.result; // unadmitted native guard ends; its evidence still occupies a slot
      captured.push(c.row);
    }
    const retained = (await readIngressRecords(socket)).map((r) => r.uuid);
    await refused();
    assert.deepEqual(
      (await readIngressRecords(socket)).map((r) => r.uuid),
      retained
    );
    await restartJournal();
    await start();
    for (const row of captured) await clean(row.uuid);
    assert.equal(JSON.parse(await ingressRequest(socket, "/status")).unacknowledged, 0);
    await stop();
    await pass(
      "H01.3 composed D03 unavailable/locked/suspended/full journal refuses before media and replays every retained identity",
      { retained }
    );

    const databaseOutage = await startCall();
    execFileSync("docker", ["stop", process.env.E02_PG_CONTAINER], { stdio: "pipe", timeout: 15000 });
    await end(databaseOutage);
    await restartJournal();
    execFileSync("docker", ["start", process.env.E02_PG_CONTAINER], { stdio: "pipe", timeout: 15000 });
    await until(
      async () => {
        try {
          await f.pool.query("select 1");
          return true;
        } catch {
          return false;
        }
      },
      "H01 PostgreSQL recovery",
      15000
    );
    await start();
    await clean(databaseOutage.row.uuid);
    assert.equal(
      (
        await f.pool.query(
          "select (extract(epoch from arrived_at)*1000000)::bigint::text as at from calls where id=$1",
          [databaseOutage.row.uuid]
        )
      ).rows[0].at,
      String(databaseOutage.row.arrivedUs)
    );
    await stop();
    await pass(
      "H01.3 composed D03 PostgreSQL outage and journal process restart recover ended call without a first row",
      { callId: databaseOutage.row.uuid }
    );
    await start();
    await until(
      async () =>
        !(
          await f.pool.query(
            "select 1 from call_command_fences f join call_operations o on o.id=f.operation_id where o.resolved_at is not null and not exists(select 1 from call_command_receipt_acks a where a.operation_id=o.id) limit 1"
          )
        ).rowCount,
      "H01 old completed receipts acknowledged",
      20000
    );
    const queued = await startCall();
    await until(async () => await waiting(queued.row.uuid), "H01 queued state");
    const queuedBefore = await call(queued.row.uuid);
    await stop();
    await start();
    await until(
      async () => (await call(queued.row.uuid))?.state === "queued",
      "H01 queue after actual worker restart"
    );
    await sameDeadline(queued.row.uuid, queuedBefore);
    await end(queued);
    await clean(queued.row.uuid);
    await pass("H01.1 actual worker/ESL restart preserves queued arrival and deadline", {
      callId: queued.row.uuid
    });

    const { c, a, before } = await connected();
    const op = (await f.pool.query("select * from call_operations where id=$1", [a.result.operationId]))
      .rows[0];
    await until(() => phone.received.length >= 2400, "H01 recovered agent RTP");
    assertTone(phone.received.slice(-2400), 880);
    await pass(
      "H01.1 actual replacement worker resumes committed connecting root with one fixed originate and two-way RTP",
      { callId: c.row.uuid, operationId: op.id }
    );
    // Lost customer events with a live orphan source: generic recovery must
    // create an exact durable cleanup command rather than merely releasing it.
    await command(
      `uuid_setvar_multi ${op.request.agentUuid} hangup_after_bridge=false;park_after_bridge=true`
    );
    await stop();
    await end(c);
    assert.equal(await command(`uuid_exists ${op.request.agentUuid}`), "true");
    await start();
    await clean(c.row.uuid);
    await sameDeadline(c.row.uuid, before);
    assert.equal(await command(`uuid_exists ${op.request.agentUuid}`), "false");
    assert.ok(
      (
        await f.pool.query(
          "select 1 from call_operations where call_id=$1 and request->>'h01Cleanup'='true'",
          [c.row.uuid]
        )
      ).rowCount
    );
    await pass(
      "H01.3 lost terminal events recover customer absence and execute fixed orphan cleanup before slot reuse",
      { callId: c.row.uuid }
    );

    // Hold the actual BGAPI frame, lose its DB lock and revoke it before FS sees
    // it. Later delivery must remain harmless even AFTER SQL ACK/reuse.
    await stop();
    await freshDesk();
    const delayed = await startCall();
    await start();
    await until(async () => await waiting(delayed.row.uuid), "H01 delayed queued");
    await stop();
    const admission = await accept(delayed);
    const root = (
      await f.pool.query("select * from call_operations where id=$1", [admission.result.operationId])
    ).rows[0];
    const transport = await relay();
    try {
      const driver = createCommandDriver({
        ...esl,
        port: transport.port,
        fenced: true,
        buildCommand: inboundConnectionCommand,
        validate: validateInboundConnection,
        verify: async () => null,
        reconcile: async () => null
      });
      const running = limited.executor.run(root.id, "normal", driver);
      await until(() => transport.queued, "H01 original bytes held");
      const pid = (
        await f.pool.query("select backend_pid from call_execution_attempts where operation_id=$1", [root.id])
      ).rows[0].backend_pid;
      await f.pool.query("select pg_terminate_backend($1)", [pid]);
      await running;
      const invites = phone.invites.length;
      await start();
      await until(
        async () =>
          Boolean(
            (await f.pool.query("select resolved_at from call_operations where id=$1", [root.id])).rows[0]
              .resolved_at
          ),
        "H01 revocation persisted"
      );
      await until(
        async () =>
          Boolean(
            (await f.pool.query("select 1 from call_command_receipt_acks where operation_id=$1", [root.id]))
              .rowCount
          ),
        "H01 revocation ACK"
      );
      const witness = await openEsl();
      try {
        await witness.command("event plain BACKGROUND_JOB");
        transport.forward();
        await until(
          () => witness.eventFrames.find((e) => e.headers["job-uuid"] === root.command_uuid),
          "H01 stale native frame finished",
          10000
        );
        const fact = witness.eventFrames.find((e) => e.headers["job-uuid"] === root.command_uuid);
        assert.match(fact.body, /sender already claimed or revoked/);
      } finally {
        witness.close();
      }
      assert.equal(transport.sends.length, 1);
      assert.equal(await command(`uuid_exists ${root.request.agentUuid}`), "false");
      assert.equal(phone.invites.length, invites, "revoked sender cannot originate after replacement lock");
      await end(delayed);
      await clean(delayed.row.uuid);
      await pass(
        "H01.2 real held frame, lost execution lock, atomic native revocation and late delivery after ACK have no media effect",
        { operationId: root.id, sends: transport.sends }
      );
    } finally {
      await transport.close();
    }

    // The opposite ambiguity: FS completed an originate, but neither its sender
    // nor the disconnected listener persisted the result. Recover the real
    // receipt and answered effect; never replay originate to recreate evidence.
    await stop();
    await freshDesk();
    await start();
    const lostReply = await startCall();
    await until(() => waiting(lostReply.row.uuid), "H01 lost-response waiting");
    await stop();
    const lostAdmission = await accept(lostReply);
    const lostRoot = (
      await f.pool.query("select * from call_operations where id=$1", [lostAdmission.result.operationId])
    ).rows[0];
    const lostTransport = await relay();
    const lostWitness = await openEsl();
    try {
      await lostWitness.command("event plain BACKGROUND_JOB");
      const invites = phone.invites.length;
      const driver = createCommandDriver({
        ...esl,
        port: lostTransport.port,
        fenced: true,
        buildCommand: inboundConnectionCommand,
        validate: validateInboundConnection,
        verify: async () => null,
        reconcile: async () => null
      });
      const running = limited.executor.run(lostRoot.id, "normal", driver);
      await until(() => lostTransport.queued, "H01 lost-response original frame");
      lostTransport.forward();
      await until(
        () => lostWitness.eventFrames.find((e) => e.headers["job-uuid"] === lostRoot.command_uuid),
        "H01 actual completed job with lost response",
        10000
      );
      assert.match(
        lostWitness.eventFrames.find((e) => e.headers["job-uuid"] === lostRoot.command_uuid).body,
        /^\+OK/
      );
      const pid = (
        await f.pool.query("select backend_pid from call_execution_attempts where operation_id=$1", [
          lostRoot.id
        ])
      ).rows[0].backend_pid;
      await f.pool.query("select pg_terminate_backend($1)", [pid]);
      await running;
      assert.equal(
        (
          await f.pool.query(
            "select 1 from call_events where call_id=$1 and event_type='inbound_connection_job'",
            [lostRoot.call_id]
          )
        ).rowCount,
        0
      );
      await start();
      await until(
        async () => (await call(lostReply.row.uuid)).state === "agent_connected",
        "H01 positive native receipt recovery",
        15000
      );
      assert.equal(phone.invites.length, invites + 1);
      assert.equal(
        (
          await f.pool.query(
            "select freeswitch_event_name from call_events where call_id=$1 and event_type='inbound_connection_job' and raw_json->>'operationId'=$2",
            [lostRoot.call_id, lostRoot.id]
          )
        ).rows[0].freeswitch_event_name,
        "RECOVERY_NATIVE_RECEIPT"
      );
      await end(lostReply);
      await clean(lostReply.row.uuid);
      await pass(
        "H01.2 completed native originate with lost sender/listener response resumes through durable receipt without another INVITE",
        { operationId: lostRoot.id }
      );
    } finally {
      lostWitness.close();
      await lostTransport.close();
    }

    // A real transfer is stopped after handover, before exact source cleanup.
    const switched = await connected();
    await stop();
    const user = (
      await f.pool.query(
        "insert into users(email,name,role,password_hash) values($1,'H01','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0].id;
    const recipient = (
      await f.pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','H01',true) returning id",
        [user, randomUUID()]
      )
    ).rows[0].id;
    const targetUsername = `desk_${randomUUID().replaceAll("-", "")}`;
    const target = await endpoint({
      username: targetUsername,
      password: "fixture",
      source: "127.0.0.4",
      frequency: 440
    });
    try {
      const desk = (
        await f.pool.query(
          "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,endpoint_pin,verified_generation,verified_at,actor_auth_version) values($1,$2,1,$4,clock_timestamp()+interval '1 hour',true,$3,$3,1,clock_timestamp(),1) returning id",
          [
            recipient,
            f.campaignId,
            `sofia/internal-webrtc/sip:${targetUsername}@${target.address}`,
            targetUsername
          ]
        )
      ).rows[0].id;
      await f.pool.query(
        "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
        [recipient]
      );
      const intent = (id) => ({
        deskSessionId: id,
        expectedRevision: "1",
        bindingGeneration: "1",
        idempotencyKey: randomUUID()
      });
      await freshDesk();
      const transfer = await createTransferOffer(
        f.pool,
        { userId: f.userId, agentId: f.agentId, authVersion: 1 },
        switched.c.row.uuid,
        { ...intent(f.input.deskSessionId), recipientAgentId: recipient }
      );
      const accepted = await mutateTransferOffer(
        f.pool,
        { userId: user, agentId: recipient, authVersion: 1 },
        transfer.offerId,
        intent(desk),
        "accept"
      );
      await start({ stopBefore: "cleanup_source" });
      await wait("checkpoint", 20000);
      assert.equal(
        (await f.pool.query("select state from call_transfers where id=$1", [transfer.transfer.id])).rows[0]
          .state,
        "switching"
      );
      await stop();
      await start();
      await until(
        async () =>
          (await f.pool.query("select state from call_transfers where id=$1", [transfer.transfer.id])).rows[0]
            .state === "completed",
        "H01 switching transfer completed",
        20000
      );
      assert.equal((await call(switched.c.row.uuid)).agent_id, recipient);
      assert.equal(await command(`uuid_exists ${switched.c.row.uuid}`), "true");
      await until(() => target.received.length >= 2400, "H01 transferred RTP");
      assertTone(target.received.slice(-2400), 880);
      await end(switched.c);
      await clean(switched.c.row.uuid);
      await pass(
        "H01.1 switching transfer survives real worker SIGKILL with one handover, exact source cleanup and retained customer UUID",
        { transferId: transfer.transfer.id, rootId: accepted.operationId }
      );
    } finally {
      await target.close();
    }

    const queue = (
      await f.pool.query("select id from inbound_queues where campaign_id=$1 limit 1", [f.campaignId])
    ).rows[0].id;
    const flow = (
      await f.pool.query(
        "insert into inbound_flows(campaign_id,name) values($1,'H01 restart') returning id",
        [f.campaignId]
      )
    ).rows[0].id;
    const bytes = Buffer.alloc(44 + 6 * 16000);
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
    bytes.writeUInt32LE(bytes.length - 44, 40);
    for (let i = 0; i < (bytes.length - 44) / 2; i++)
      bytes.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / 8000)), 44 + i * 2);
    await writeFile(join(directory, "h01.wav"), bytes);
    const recording = (
      await f.pool.query(
        "insert into recordings(campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes) values($1,'H01',$2,'/a02/h01.wav',6,$3) returning id",
        [f.campaignId, join(directory, "h01.wav"), bytes.length]
      )
    ).rows[0].id;
    let version = 0;
    async function publish(actions) {
      const id = (
        await f.pool.query(
          "insert into inbound_flow_versions(flow_id,campaign_id,version,flow_timeout_ms,actions,audio_snapshot) values($1,$2,$3,30000,$4,'[]') returning id",
          [flow, f.campaignId, ++version, JSON.stringify(actions)]
        )
      ).rows[0].id;
      await f.pool.query(
        "update inbound_queues set no_answer_flow_version_id=$2,queue_timeout_ms=15000 where id=$1",
        [queue, id]
      );
      assert.equal(await new InboundConfigurationPublisher(f.pool, config).reconcile(), "applied");
      return id;
    }
    await publish([{ type: "play_audio", recordingId: recording, timeoutMs: 10000 }, { type: "hangup" }]);
    const playback = await startCall();
    await until(
      async () =>
        Boolean(
          (
            await f.pool.query(
              "select 1 from call_events where call_id=$1 and event_type='inbound_fallback_started'",
              [playback.row.uuid]
            )
          ).rowCount
        ),
      "H01 actual fallback playback started",
      22000
    );
    const playbackBefore = await call(playback.row.uuid);
    await stop();
    await start();
    await clean(playback.row.uuid);
    const playbackMedia = await playback.result;
    assertTone(
      playbackMedia.rtp.slice(-20).flatMap((p) => p.payload.map(decodeUlaw)),
      660
    );
    await sameDeadline(playback.row.uuid, playbackBefore);
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int n from call_operations where call_id=$1 and command_kind='play_audio' and request->>'inboundFallback'='true'",
          [playback.row.uuid]
        )
      ).rows[0].n,
      1
    );
    await pass(
      "H01.1 playback worker restart recovers native producer completion, decoded audio and a single unchanged flow step",
      { callId: playback.row.uuid }
    );

    let releaseAnswer;
    const answerGate = new Promise((r) => (releaseAnswer = r));
    const external = await endpoint({
      username: "h01_external",
      password: "fixture",
      source: "127.0.0.5",
      frequency: 990,
      answerGate
    });
    try {
      forwarding = {
        SIP_TRUNK_MODE: "ip_auth",
        SIP_TRUNK_PROXY: external.address,
        SIP_TRUNK_CALLER_ID: "+12025550100"
      };
      await stop();
      await start();
      await publish([
        { type: "forward_external", target: "+14155550101", timeoutMs: 12000 },
        { type: "hangup" }
      ]);
      const forwarded = await startCall();
      await until(() => external.invites.length === 1, "H01 external dialing", 22000);
      const forwardOp = (
        await f.pool.query(
          "select * from call_operations where call_id=$1 and command_kind='forward_external'",
          [forwarded.row.uuid]
        )
      ).rows[0];
      await stop();
      await start();
      assert.equal(external.invites.length, 1);
      releaseAnswer();
      await until(
        async () =>
          Boolean(
            (
              await f.pool.query(
                "select 1 from call_participants where call_id=$1 and role='external' and connected_at is not null",
                [forwarded.row.uuid]
              )
            ).rowCount
          ),
        "H01 forwarded connection",
        12000
      );
      await until(() => external.received.length >= 2400, "H01 external two-way media");
      assertTone(external.received.slice(-2400), 880);
      const forwardBefore = await call(forwarded.row.uuid);
      await stop();
      await start();
      assert.equal(external.invites.length, 1);
      assert.equal(
        await command(`uuid_getvar ${forwarded.row.uuid} bridge_uuid`),
        forwardOp.request.externalUuid
      );
      await sameDeadline(forwarded.row.uuid, forwardBefore);
      await stop();
      await end(forwarded);
      await start();
      await clean(forwarded.row.uuid);
      await pass(
        "H01.1 external dialing and connected restarts retain one external UUID/dial and recover completion lost during outage",
        { callId: forwarded.row.uuid, externalUuid: forwardOp.request.externalUuid }
      );
    } finally {
      releaseAnswer?.();
      await external.close();
      forwarding = undefined;
    }

    // An abrupt FS restart invalidates both old sockets and a delayed old-boot
    // wrapper. The replacement worker must not fabricate a successful job.
    await stop();
    await f.pool.query(
      "update inbound_queues set no_answer_flow_version_id=null,queue_timeout_ms=18000 where id=$1",
      [queue]
    );
    await new InboundConfigurationPublisher(f.pool, config).reconcile();
    await start();
    await freshDesk();
    const lostBoot = await startCall();
    await until(() => waiting(lostBoot.row.uuid), "H01 pre-restart waiting");
    await stop();
    const admitted = await accept(lostBoot);
    const oldRoot = (
      await f.pool.query("select * from call_operations where id=$1", [admitted.result.operationId])
    ).rows[0];
    const held = await relay();
    try {
      const driver = createCommandDriver({
        ...esl,
        port: held.port,
        fenced: true,
        buildCommand: inboundConnectionCommand,
        validate: validateInboundConnection,
        verify: async () => null,
        reconcile: async () => null
      });
      const running = limited.executor.run(oldRoot.id, "normal", driver);
      await until(() => held.queued, "H01 old incarnation bytes held");
      const oldCore = (
        await f.pool.query("select core_uuid from call_command_fences where operation_id=$1", [oldRoot.id])
      ).rows[0].core_uuid;
      const backend = (
        await f.pool.query("select backend_pid from call_execution_attempts where operation_id=$1", [
          oldRoot.id
        ])
      ).rows[0].backend_pid;
      await f.pool.query("select pg_terminate_backend($1)", [backend]);
      await running;
      execFileSync("docker", ["kill", "--signal", "KILL", process.env.E02_FS_CONTAINER]);
      execFileSync("docker", ["start", process.env.E02_FS_CONTAINER]);
      await until(
        async () => {
          try {
            return (
              (await command("global_getvar core_uuid")) !== oldCore &&
              /RUNNING/.test(await command("sofia status"))
            );
          } catch {
            return false;
          }
        },
        "H01 new FS incarnation",
        30000
      );
      await restartJournal();
      await start();
      await clean(lostBoot.row.uuid);
      assert.equal((await call(lostBoot.row.uuid)).outcome, "failed");
      const conf = await command("global_getvar conf_dir");
      await assert.rejects(
        command(
          `lua ${conf}/scripts/outbound-command.lua execute ${oldCore} ${oldRoot.command_uuid} ${oldRoot.id} ${inboundConnectionCommand(oldRoot)}`
        ),
        /-ERR obsolete incarnation/
      );
      assert.equal(
        (await f.pool.query("select result from call_operations where id=$1", [oldRoot.id])).rows[0].result
          .fence,
        "obsolete"
      );
      await end(lostBoot);
      assert.equal(JSON.parse(await command("show channels as json")).row_count, 0);
      await pass(
        "H01.3 abrupt FS restart plus journal replay fences an attempted lost job and rejects a late old-incarnation command",
        { operationId: oldRoot.id, oldCore }
      );
    } finally {
      await held.close();
    }
    await stop();
  } finally {
    await writeFile(join(directory, "h01-history.json"), JSON.stringify(history, null, 2));
    for (const table of ["call_operations", "call_transfers", "call_events", "calls"])
      await writeFile(
        join(directory, `h01-${table}.json`),
        JSON.stringify((await f.pool.query(`select * from ${table}`)).rows, null, 2)
      );
    await stop();
    await Promise.all([...children].map(killWorker));
    await log.close();
  }
}
