import { supervisorHandoverFixture } from "./g04-supervisor-handover.mjs";
import {
  persistCoordinatedCallEvent,
  reconcileCoordinatedCallCleanup
} from "../apps/api/dist-test/call-cleanup.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTransferOffer, mutateTransferOffer } from "../apps/api/dist-test/transfer-offers.js";
import {
  transferConnectionDriver,
  prepareTransferCommands,
  settleTransferConnection,
  transferConnectionCommand,
  validateTransferConnection,
  transferConnectionExecutor
} from "../apps/api/dist-test/transfer-connection.js";
import { relay } from "./a05-executor.mjs";
import { createCommandDriver } from "../apps/api/dist-test/call-command-transport.js";
import { endpoint, until, assertTone, decodeUlaw } from "./a05-media.mjs";

/** Real product G01 intent -> C03 transfer executor -> real SIP/RTP, in the
 * network-none E02 lab. Desk verification remains an explicit SQL fixture.
 */
export async function proveTransferExecution({
  f,
  c,
  phone,
  command,
  pass,
  limited,
  direction = "inbound",
  lossBoundary
}) {
  const user = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'G02','agent','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0].id;
  const username = `desk_${randomUUID().replaceAll("-", "")}`;
  const recipient = (
    await f.pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','G02',true) returning id",
      [user, username]
    )
  ).rows[0].id;
  const campaign = (await f.pool.query("select campaign_id from calls where id=$1", [c.row.uuid])).rows[0]
    .campaign_id;
  const targetPhone = await endpoint({ username, password: "fixture", source: "127.0.0.4", frequency: 440 });
  const desk = (
    await f.pool.query(
      "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,endpoint_pin,verified_generation,verified_at,actor_auth_version) values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,$4,$4,1,clock_timestamp(),1) returning id",
      [recipient, campaign, username, `sofia/internal-webrtc/sip:${username}@${targetPhone.address}`]
    )
  ).rows[0].id;
  await f.pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [recipient]
  );
  const source = { userId: f.userId, agentId: f.agentId, authVersion: 1 },
    target = { userId: user, agentId: recipient, authVersion: 1 };
  const input = (session) => ({
    deskSessionId: session,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  });
  const runtime = transferConnectionExecutor(f.pool, limited.executor, {
    host: "127.0.0.1",
    port: 8021,
    password: "a02-disposable-only"
  });
  const supervision =
    process.env.G04_SUPERVISION === "1" && !lossBoundary
      ? await supervisorHandoverFixture({ f, callId: c.row.uuid, command, limited, pass, direction })
      : null;
  async function transfer(from, to, sourceDesk, targetDesk, fault = false) {
    if (supervision) await supervision.before(fault ? "join" : "whisper");
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp() where id=any($1::uuid[])",
      [[sourceDesk, targetDesk]]
    );
    const t = await createTransferOffer(f.pool, from, c.row.uuid, {
      ...input(sourceDesk),
      recipientAgentId: to.agentId
    });
    const response = await mutateTransferOffer(f.pool, to, t.offerId, input(targetDesk), "accept");
    assert.equal(response.status, "connecting");
    assert.equal(
      (await f.pool.query("select agent_id from calls where id=$1", [c.row.uuid])).rows[0].agent_id,
      from.agentId
    );
    if (fault && !supervision) await delayedBridge(response.operationId);
    await runtime.wakeExecutor(response.operationId);
    await until(
      async () => {
        await runtime.reconcile();
        return (
          (await f.pool.query("select state from call_transfers where id=$1", [t.transfer.id])).rows[0]
            .state === "completed"
        );
      },
      "G02 confirmed handover",
      15000
    );
    const root = (await f.pool.query("select * from call_operations where id=$1", [response.operationId]))
      .rows[0];
    assert.equal(await command(`uuid_exists ${root.request.customerUuid}`), "true");
    assert.equal(
      await command(`uuid_getvar ${root.request.customerUuid} bridge_uuid`),
      root.request.agentUuid
    );
    assert.equal(
      (await f.pool.query("select agent_id from calls where id=$1", [c.row.uuid])).rows[0].agent_id,
      to.agentId
    );
    assert.equal(
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [from.agentId])).rows[0]
        .state,
      "free"
    );
    assert.equal(
      (await f.pool.query("select state from agent_call_slots where agent_id=$1", [to.agentId])).rows[0]
        .state,
      "active"
    );
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int n from call_capacity_reservations where call_id=$1 and resource_type='transfer_overlap' and state<>'released'",
          [c.row.uuid]
        )
      ).rows[0].n,
      0
    );
    if (supervision) {
      await supervision.isolation(to.agentId === recipient ? targetPhone : phone);
      await supervision.after(to.agentId === recipient ? targetPhone : phone, to, targetDesk);
    }
    const oldCount = targetPhone.invites.length + phone.invites.length;
    await runtime.wakeExecutor(response.operationId);
    assert.equal(targetPhone.invites.length + phone.invites.length, oldCount);
    await command(`uuid_kill ${root.request.sourceUuid} NORMAL_CLEARING`).catch((error) =>
      assert.match(error.message, /No such channel/)
    );
    assert.equal(
      await command(`uuid_getvar ${root.request.customerUuid} bridge_uuid`),
      root.request.agentUuid
    );
    const packets = c.control.packets;
    const sample = () =>
      c.control.samples ? c.control.samples() : packets().flatMap((p) => p.payload.map(decodeUlaw));
    const beforeMedia = sample().length;
    await until(() => sample().length >= beforeMedia + 2400, "fresh recipient-to-customer RTP");
    const expected = to.agentId === recipient ? 440 : 660;
    const reverseTone = assertTone(sample().slice(-2400), expected);
    return { root, transferId: t.transfer.id, reverseTone };
  }
  async function delayedBridge(id) {
    await prepareTransferCommands(f.pool, id);
    const ops = (
      await f.pool.query("select * from call_operations where id=$1 or idempotency_scope=$2", [
        id,
        `transfer-execution:${id}`
      ])
    ).rows;
    const driver = transferConnectionDriver({
      host: "127.0.0.1",
      port: 8021,
      password: "a02-disposable-only"
    });
    for (const key of ["prepare_customer", "prepare_source", "originate", "park"]) {
      const op = ops.find((o) => (o.request.transferAction ?? "originate") === key);
      const done = await until(
        async () => {
          const r = await limited.executor.run(op.id, "normal", driver);
          return r.status === "terminal" ? r : null;
        },
        `G02 prepared ${key} command reconciliation`,
        10000
      );
      assert.equal(done.operation.state, "succeeded");
    }
    const bridge = ops.find((o) => o.request.transferAction === "bridge");
    const transport = await relay();
    try {
      const faultDriver = createCommandDriver({
        host: "127.0.0.1",
        port: transport.port,
        password: "a02-disposable-only",
        buildCommand: transferConnectionCommand,
        validate: validateTransferConnection,
        verify: async () => null,
        reconcile: async () => null
      });
      const running = limited.executor.run(bridge.id, "normal", faultDriver);
      await until(() => transport.queued, "G02 bridge bytes held before FS");
      const pid = (
        await f.pool.query(
          "select backend_pid from call_execution_attempts where operation_id=$1 order by started_at desc limit 1",
          [bridge.id]
        )
      ).rows[0].backend_pid;
      assert.equal((await f.pool.query("select pg_terminate_backend($1) ok", [pid])).rows[0].ok, true);
      await running;
      await settleTransferConnection(f.pool, id);
      assert.equal(
        (await f.pool.query("select agent_id from calls where id=$1", [c.row.uuid])).rows[0].agent_id,
        target.agentId
      );
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from agent_call_slots where call_id=$1 and state<>'free'",
            [c.row.uuid]
          )
        ).rows[0].n,
        2
      );
      // Replacement obtains the C03 lock but has no completed job: zero resend/release.
      await runtime.wakeExecutor(id);
      assert.equal(transport.sends.length, 0);
      transport.forward();
      await until(
        async () =>
          (
            await f.pool.query(
              "select 1 from call_events where event_type='transfer_command_job' and raw_json->>'jobUuid'=$1",
              [bridge.command_uuid]
            )
          ).rowCount,
        "late fixed bridge job"
      );
      assert.equal(transport.sends.length, 1);
      await runtime.wakeExecutor(id);
      assert.equal(
        (
          await f.pool.query("select count(*)::int n from call_execution_attempts where operation_id=$1", [
            bridge.id
          ])
        ).rows[0].n,
        1
      );
    } finally {
      await transport.close();
    }
  }
  async function sourceReuse(oldRoot) {
    const customer = await endpoint({
      username: "g02_reuse_customer",
      password: "fixture",
      source: "127.0.0.6",
      frequency: 880
    });
    const newer = await f.seed();
    const sourceRoute = (
      await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [
        f.input.deskSessionId
      ])
    ).rows[0].verified_endpoint;
    try {
      for (const [uuid, route] of [
        [newer.customerUuid, `sofia/internal-webrtc/sip:g02_reuse_customer@${customer.address}`],
        [newer.agentUuid, sourceRoute]
      ]) {
        assert.match(
          await command(
            `originate {origination_uuid=${uuid},outbound_dialer_call_id=${newer.callId},hangup_after_bridge=true}${route} &park()`
          ),
          /^\+OK/
        );
        await until(
          async () => (await command(`uuid_getvar ${uuid} current_application`)) === "park",
          "reused source fixture parked"
        );
      }
      await command(`uuid_bridge ${newer.customerUuid} ${newer.agentUuid}`);
      await until(
        async () => (await command(`uuid_getvar ${newer.customerUuid} bridge_uuid`)) === newer.agentUuid,
        "reused source actual bridge"
      );
      await f.pool.query("update agent_call_slots set state='active' where agent_id=$1", [f.agentId]);
      await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
      const oldEvent = (
        await f.pool.query(
          "select freeswitch_event_uuid from call_events where call_id=$1 and agent_leg_uuid=$2 and freeswitch_event_name='CHANNEL_HANGUP_COMPLETE' limit 1",
          [c.row.uuid, oldRoot.request.sourceUuid]
        )
      ).rows[0];
      await persistCoordinatedCallEvent(f.pool, {
        callId: c.row.uuid,
        legUuid: oldRoot.request.sourceUuid,
        eventName: "CHANNEL_HANGUP_COMPLETE",
        eventUuid: oldEvent?.freeswitch_event_uuid ?? randomUUID()
      });
      await runtime.wakeExecutor(oldRoot.id);
      await command(`uuid_kill ${oldRoot.request.sourceUuid} NORMAL_CLEARING`).catch((error) =>
        assert.match(error.message, /No such channel/)
      );
      const slot = (await f.pool.query("select call_id from agent_call_slots where agent_id=$1", [f.agentId]))
        .rows[0];
      assert.equal(slot.call_id, newer.callId);
      assert.equal(
        (await f.pool.query("select availability_status from agents where id=$1", [f.agentId])).rows[0]
          .availability_status,
        "paused"
      );
      assert.equal(await command(`uuid_exists ${newer.agentUuid}`), "true");
      assert.equal(
        await command(`uuid_getvar ${oldRoot.request.customerUuid} bridge_uuid`),
        oldRoot.request.agentUuid
      );
      const at = targetPhone.received.length;
      await until(
        () => targetPhone.received.length > at + 2400,
        "old transfer fresh media after source new call"
      );
      assertTone(targetPhone.received.slice(-2400), 880);
      await command(`uuid_kill ${newer.customerUuid} NORMAL_CLEARING`);
      await until(async () => {
        try {
          await reconcileCoordinatedCallCleanup(f.pool, newer.callId);
        } catch (error) {
          if (error.reason === "discovery_changed") return false;
          throw error;
        }
        return (
          (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
            .state === "free"
        );
      }, "source new call cleanup");
      await f.pool.query("update agents set availability_status='available' where id=$1", [f.agentId]);
      await pass(
        `G02.4 ${direction} old finalization/replay cannot release source's new real call or clear pause`,
        { oldCall: c.row.uuid, newCall: newer.callId, slot }
      );
    } finally {
      await command(`uuid_kill ${newer.customerUuid} NORMAL_CLEARING`).catch((error) =>
        assert.match(error.message, /No such channel/)
      );
      customer.close();
    }
  }
  async function loseSource(boundary) {
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp() where id=any($1::uuid[])",
      [[desk, f.input.deskSessionId]]
    );
    const t = await createTransferOffer(f.pool, source, c.row.uuid, {
      ...input(f.input.deskSessionId),
      recipientAgentId: recipient
    });
    const accepted = await mutateTransferOffer(f.pool, target, t.offerId, input(desk), "accept");
    await prepareTransferCommands(f.pool, accepted.operationId);
    const ops = (
      await f.pool.query("select * from call_operations where id=$1 or idempotency_scope=$2", [
        accepted.operationId,
        `transfer-execution:${accepted.operationId}`
      ])
    ).rows;
    const driver = transferConnectionDriver({
      host: "127.0.0.1",
      port: 8021,
      password: "a02-disposable-only"
    });
    const count = {
      customer_terminal_before_originate: 2,
      before_originate: 2,
      before_park: 3,
      after_park: 4,
      after_bridge: 5
    }[boundary];
    for (const key of ["prepare_customer", "prepare_source", "originate", "park", "bridge"].slice(0, count)) {
      const op = ops.find((o) => (o.request.transferAction ?? "originate") === key);
      if (key === "bridge") {
        const lostResult = createCommandDriver({
          host: "127.0.0.1",
          port: 8021,
          password: "a02-disposable-only",
          buildCommand: transferConnectionCommand,
          validate: validateTransferConnection,
          verify: async () => null,
          reconcile: async () => null
        });
        assert.equal((await limited.executor.run(op.id, "normal", lostResult)).status, "uncertain");
        await until(
          async () =>
            (
              await f.pool.query(
                "select 1 from call_events where event_type='transfer_command_job' and raw_json->>'jobUuid'=$1",
                [op.command_uuid]
              )
            ).rowCount,
          "bridge persisted by independent observer"
        );
      } else {
        const done = await until(
          async () => {
            const r = await limited.executor.run(op.id, "normal", driver);
            return r.status === "terminal" ? r : null;
          },
          `source-loss ${key}`,
          10000
        );
        assert.equal(done.operation.state, "succeeded");
      }
    }
    const root = ops.find((o) => o.id === accepted.operationId);
    const customerEnded = boundary === "customer_terminal_before_originate";
    await command(
      `uuid_kill ${customerEnded ? root.request.customerUuid : root.request.sourceUuid} NORMAL_CLEARING`
    );
    await until(
      async () =>
        (
          await f.pool.query("select ended_at from call_legs where call_id=$1 and freeswitch_uuid=$2", [
            c.row.uuid,
            customerEnded ? root.request.customerUuid : root.request.sourceUuid
          ])
        ).rows[0].ended_at,
      "source concrete terminal"
    );
    await until(
      async () => {
        await runtime.reconcile();
        return (await f.pool.query("select closed_at from call_transfers where id=$1", [t.transfer.id]))
          .rows[0].closed_at;
      },
      "bounded source-loss recovery/termination",
      15000
    );
    const result = (
      await f.pool.query("select state,reason from call_transfers where id=$1", [t.transfer.id])
    ).rows[0];
    const call = (await f.pool.query("select agent_id,ended_at,outcome from calls where id=$1", [c.row.uuid]))
      .rows[0];
    if (["after_park", "after_bridge"].includes(boundary)) {
      assert.equal(result.state, "completed");
      assert.equal(call.agent_id, recipient);
      assert.equal(call.ended_at, null);
      const at = targetPhone.received.length;
      await until(() => targetPhone.received.length > at + 2400, "source-loss recovered two-way audio");
      assertTone(targetPhone.received.slice(-2400), 880);
      const sample = () =>
        c.control.samples
          ? c.control.samples()
          : c.control.packets().flatMap((p) => p.payload.map(decodeUlaw));
      const mediaAt = sample().length;
      await until(() => sample().length > mediaAt + 2400, "source-loss reverse media");
      assertTone(sample().slice(-2400), 440);
    } else {
      assert.equal(result.state, customerEnded ? "canceled" : "failed");
      assert.ok(call.ended_at);
      assert.equal(call.outcome, customerEnded ? "customer_hung_up" : "failed");
    }
    await pass(`G02.2/G02.3 ${direction} source disappears ${boundary}: ${result.state}`, {
      transferId: t.transfer.id,
      result,
      call
    });
    return runtime;
  }
  try {
    if (lossBoundary) return await loseSource(lossBoundary);
    // Rejection and actual 180/no-answer/CANCEL must both preserve the source.
    for (const failureMode of ["486", "no-answer"]) {
      let cancels = 0;
      targetPhone.setBehavior(
        failureMode === "486"
          ? { rejectCode: 486 }
          : { answerGate: new Promise(() => {}), onCancel: () => cancels++ }
      );
      await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [desk]);
      const rejected = await createTransferOffer(f.pool, source, c.row.uuid, {
        ...input(f.input.deskSessionId),
        recipientAgentId: recipient
      });
      const rejectedAccept = await mutateTransferOffer(
        f.pool,
        target,
        rejected.offerId,
        input(desk),
        "accept"
      );
      await runtime.wakeExecutor(rejectedAccept.operationId);
      await until(
        async () => {
          await runtime.reconcile();
          return (
            (await f.pool.query("select state from call_transfers where id=$1", [rejected.transfer.id]))
              .rows[0].state === "failed"
          );
        },
        "G02 rejected recipient cleanup",
        15000
      );
      assert.equal(
        (await f.pool.query("select state from call_transfers where id=$1", [rejected.transfer.id])).rows[0]
          .state,
        "failed"
      );
      assert.equal(
        (await f.pool.query("select agent_id from calls where id=$1", [c.row.uuid])).rows[0].agent_id,
        source.agentId
      );
      const samples = phone.received.length;
      await until(() => phone.received.length > samples + 2400, "G02 failure source RTP");
      const sourceTone = assertTone(phone.received.slice(-2400), 880);
      const sample = () =>
        c.control.samples
          ? c.control.samples()
          : c.control.packets().flatMap((p) => p.payload.map(decodeUlaw));
      const at = sample().length;
      await until(() => sample().length >= at + 2400, "failed transfer preserves source-to-customer RTP");
      const callerTone = assertTone(sample().slice(-2400), 660);
      const root = (
        await f.pool.query("select * from call_operations where id=$1", [rejectedAccept.operationId])
      ).rows[0];
      const job = (
        await f.pool.query(
          "select raw_json from call_events where event_type='transfer_command_job' and raw_json->>'jobUuid'=$1 order by created_at limit 1",
          [root.command_uuid]
        )
      ).rows[0].raw_json;
      assert.match(job.body, /^-ERR/);
      if (failureMode === "no-answer")
        assert.ok(cancels > 0, "actual SIP CANCEL observed after unanswered ringing");
      assert.equal(
        await command(`uuid_getvar ${root.request.customerUuid} bridge_uuid`),
        root.request.sourceUuid
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [recipient])).rows[0]
          .state,
        "free"
      );
      await pass(`G02.2 ${direction} recipient ${failureMode} preserves two-way source audio`, {
        sourceTone,
        callerTone,
        job,
        cancels
      });
      targetPhone.setBehavior();
    }
    const first = await transfer(source, target, f.input.deskSessionId, desk);
    const at = targetPhone.received.length;
    await until(() => targetPhone.received.length >= at + 2400, "G02 recipient customer audio");
    assertTone(targetPhone.received.slice(-2400), 880);
    await pass(
      `G02.1/G02.4 ${direction} transfer confirms owner only on bridge, exact source cleanup and overlap release`,
      first
    );
    await sourceReuse(first.root);
    const back = await transfer(target, source, desk, f.input.deskSessionId, true);
    const backAt = phone.received.length;
    await until(() => phone.received.length >= backAt + 2400, "G02 repeated source return audio");
    assertTone(phone.received.slice(-2400), 880);
    await pass(
      supervision
        ? `G04.3 ${direction} A-B-A transfer ends join before handover and preserves customer media`
        : `G02.1/G02.3 ${direction} A-B-A transfer, lost execution lock/delayed bridge and late old-leg cleanup preserve customer`,
      back
    );
    return runtime;
  } finally {
    supervision?.close();
    targetPhone.close();
  }
}

/** The initial outbound source conversation is a declared seeded fixture with
 * real originated legs/bridge. G02 execution itself uses the production modules.
 */
export async function proveOutboundTransferExecution({
  f,
  phone,
  command,
  limited,
  pass,
  direction = "outbound",
  lossBoundary
}) {
  const customer = await endpoint({
    username: "g02_customer",
    password: "fixture",
    source: "127.0.0.5",
    frequency: 880
  });
  const seeded = await f.seed({ inbound: direction === "inbound" });
  const contact = (
    await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [
      f.input.deskSessionId
    ])
  ).rows[0].verified_endpoint;
  let runtime;
  try {
    for (const [uuid, route] of [
      [seeded.customerUuid, `sofia/internal-webrtc/sip:g02_customer@${customer.address}`],
      [seeded.agentUuid, contact]
    ]) {
      assert.match(
        await command(
          `originate {origination_uuid=${uuid},outbound_dialer_call_id=${seeded.callId},hangup_after_bridge=false,park_after_bridge=true}${route} &park()`
        ),
        /^\+OK/
      );
      await until(
        async () => (await command(`uuid_getvar ${uuid} current_application`)) === "park",
        "outbound fixture parked"
      );
    }
    assert.match(await command(`uuid_bridge ${seeded.customerUuid} ${seeded.agentUuid}`), /^\+OK/);
    await until(
      async () => (await command(`uuid_getvar ${seeded.customerUuid} bridge_uuid`)) === seeded.agentUuid,
      "outbound fixture bridge"
    );
    await f.pool.query("update agent_call_slots set state='active' where agent_id=$1", [f.agentId]);
    await f.pool.query(
      "update call_participants set joined_at=coalesce(joined_at,clock_timestamp()),connected_at=clock_timestamp() where id=$1",
      [seeded.participantId]
    );
    await f.pool.query(
      "update agent_desk_sessions set actor_auth_version=1,verified_at=clock_timestamp() where id=$1",
      [f.input.deskSessionId]
    );
    runtime = await proveTransferExecution({
      f,
      c: { row: { uuid: seeded.callId }, control: { samples: () => customer.received } },
      phone,
      command,
      limited,
      pass,
      direction,
      lossBoundary
    });
    await command(`uuid_kill ${seeded.customerUuid} NORMAL_CLEARING`).catch((error) =>
      assert.match(error.message, /No such channel/)
    );
    await until(
      async () => {
        await runtime.reconcile();
        return (
          (
            await f.pool.query(
              "select count(*)::int n from call_legs where call_id=$1 and ended_at is null",
              [seeded.callId]
            )
          ).rows[0].n === 0 &&
          (
            await f.pool.query(
              "select count(*)::int n from call_operations where call_id=$1 and resolved_at is null",
              [seeded.callId]
            )
          ).rows[0].n === 0 &&
          (
            await f.pool.query("select count(*)::int n from agent_call_slots where call_id=$1", [
              seeded.callId
            ])
          ).rows[0].n === 0
        );
      },
      "G02 outbound terminal cleanup",
      15000
    );
    assert.equal(
      (await f.pool.query("select count(*)::int n from agent_call_slots where call_id=$1", [seeded.callId]))
        .rows[0].n,
      0
    );
    await pass(
      `G02 ${direction} customer terminal cleans current and former agent legs${lossBoundary ? " after " + lossBoundary : ""}`
    );
  } finally {
    await command(`uuid_kill ${seeded.customerUuid} NORMAL_CLEARING`).catch((error) =>
      assert.match(error.message, /No such channel/)
    );
    customer.close();
  }
}
