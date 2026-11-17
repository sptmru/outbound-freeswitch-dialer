import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { authorizeServiceInvite } from "./service-invites.js";
import pg from "pg";
import { AdmissionDiscoveryChanged } from "./call-admission.js";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { assertBlocked, databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { createTransferOffer, mutateTransferOffer } from "./transfer-offers.js";
import {
  prepareTransferCommands,
  settleTransferConnection,
  resolveTransferCommand,
  persistTransferJob,
  persistTransferEvent
} from "./transfer-connection.js";
import { reconcileCoordinatedCallCleanup, persistCoordinatedCallEvent } from "./call-cleanup.js";
import type { DurableCommand } from "./call-executor.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 };
async function fixture(inbound: boolean, lateAccept = false) {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  await f.pool.query("update agent_desk_sessions set actor_auth_version=1 where id=$1", [
    f.input.deskSessionId
  ]);
  const c = await f.seed({ inbound });
  await f.pool.query("update agent_call_slots set state='active' where agent_id=$1", [f.agentId]);
  await f.pool.query(
    "update call_participants set joined_at=clock_timestamp(),connected_at=clock_timestamp() where id=$1",
    [c.participantId]
  );
  const user = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'G02','agent','fixture') returning id",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0].id;
  const agent = (
    await f.pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','G02',true) returning id",
      [user, randomUUID()]
    )
  ).rows[0].id;
  const desk = (
    await f.pool.query(
      "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,endpoint_pin,verified_generation,verified_at,actor_auth_version) values($1,$2,1,'g02',clock_timestamp()+interval '1 hour',true,'sofia/internal-webrtc/sip:g02@127.0.0.4:5060','sofia/internal-webrtc/sip:g02@127.0.0.4:5060',1,clock_timestamp(),1) returning id",
      [agent, f.campaignId]
    )
  ).rows[0].id;
  await f.pool.query(
    "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
    [agent]
  );
  const intent = (id: string) => ({
    deskSessionId: id,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  });
  const t = await createTransferOffer(
    f.pool,
    { agentId: f.agentId, userId: f.userId, authVersion: 1 },
    c.callId,
    { ...intent(f.input.deskSessionId), recipientAgentId: agent }
  );
  if (lateAccept) {
    // Wait on the authoritative DB offer deadline, not a wall-clock race sleep.
    while (
      !(
        await f.pool.query(
          "select clock_timestamp()>=deadline_at-interval '5 seconds' due from call_transfers where id=$1",
          [t.transfer!.id]
        )
      ).rows[0].due
    )
      await delay(100);
    await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [desk]);
  }
  const accepted = await mutateTransferOffer(
    f.pool,
    { agentId: agent, userId: user, authVersion: 1 },
    t.offerId!,
    intent(desk),
    "accept"
  );
  assert.ok("operationId" in accepted);
  const root = (await f.pool.query("select * from call_operations where id=$1", [accepted.operationId]))
    .rows[0] as DurableCommand;
  await prepareTransferCommands(f.pool, root.id);
  const ops = async () =>
    (
      await f.pool.query("select * from call_operations where id=$1 or idempotency_scope=$2", [
        root.id,
        `transfer-execution:${root.id}`
      ])
    ).rows as DurableCommand[];
  async function resolve(o: DurableCommand, state = "succeeded") {
    await f.pool.query(
      "update call_operations set state=$2,resolved_at=clock_timestamp(),result='{}',resolution_evidence='simulated DB fixture effect, no FS proof' where id=$1 and resolved_at is null",
      [o.id, state]
    );
  }
  async function finishRestores() {
    for (let i = 0; i < 3; i++) {
      const pending = (await ops()).filter(
        (o) => String(o.request.transferAction).startsWith("restore_") && o.state === "pending"
      );
      for (const o of pending) await resolve(o);
      await settleTransferConnection(f.pool, root.id);
    }
  }
  return { ...f, c, root, agent, t, ops, resolve, finishRestores };
}
for (const inbound of [true, false])
  test(
    `G02.1/G02.4 ${inbound ? "inbound" : "outbound"} handover and source cleanup are distinct fenced boundaries`,
    options,
    async () => {
      const f = await fixture(inbound);
      try {
        const ops = await f.ops();
        assert.equal(ops.length, 5);
        await prepareTransferCommands(f.pool, f.root.id);
        assert.equal((await f.ops()).length, 5);
        for (const o of ops) if (o.request.transferAction !== "bridge") await f.resolve(o);
        await settleTransferConnection(f.pool, f.root.id);
        assert.equal(
          (await f.pool.query("select agent_id from calls where id=$1", [f.c.callId])).rows[0].agent_id,
          f.agentId
        );
        assert.equal(
          (
            await f.pool.query("select connected_at from call_participants where id=$1", [
              f.root.request.participantId
            ])
          ).rows[0].connected_at,
          null
        );
        const bridge = ops.find((o: DurableCommand) => o.request.transferAction === "bridge")!;
        await f.resolve(bridge);
        await settleTransferConnection(f.pool, f.root.id);
        assert.equal(
          (await f.pool.query("select agent_id,campaign_id from calls where id=$1", [f.c.callId])).rows[0]
            .agent_id,
          f.agent
        );
        assert.equal(
          (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
            .state,
          "active"
        );
        const oldCleanup = (await f.ops()).find(
          (o: DurableCommand) => o.request.transferAction === "cleanup_source"
        )!;
        await f.resolve(oldCleanup);
        await settleTransferConnection(f.pool, f.root.id);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [f.t.transfer!.id])).rows[0]
            .state,
          "switching"
        );
        await persistCoordinatedCallEvent(f.pool, {
          callId: f.c.callId,
          legUuid: f.c.agentUuid,
          eventName: "CHANNEL_HANGUP_COMPLETE",
          eventUuid: randomUUID()
        });
        await settleTransferConnection(f.pool, f.root.id);
        await f.finishRestores();
        await reconcileCoordinatedCallCleanup(f.pool, f.c.callId);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [f.t.transfer!.id])).rows[0]
            .state,
          "completed"
        );
        assert.equal(
          (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
            .state,
          "free"
        );
        assert.equal(
          (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agent])).rows[0]
            .state,
          "active"
        );
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from call_capacity_reservations where operation_id=$1 and resource_type='transfer_overlap' and state<>'released'",
              [f.root.id]
            )
          ).rows[0].n,
          0
        );
        // Source reuses its slot for another product call. Old finalization replay is fenced.
        const next = await f.seed();
        await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
        await persistCoordinatedCallEvent(f.pool, {
          callId: f.c.callId,
          legUuid: f.c.agentUuid,
          eventName: "CHANNEL_HANGUP_COMPLETE",
          eventUuid: randomUUID()
        });
        await reconcileCoordinatedCallCleanup(f.pool, f.c.callId);
        assert.equal(
          (await f.pool.query("select call_id from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
            .call_id,
          next.callId
        );
        assert.equal(
          (await f.pool.query("select availability_status from agents where id=$1", [f.agentId])).rows[0]
            .availability_status,
          "paused"
        );
        assert.equal(
          (await f.pool.query("select agent_id,campaign_id,ended_at from calls where id=$1", [f.c.callId]))
            .rows[0].ended_at,
          null
        );
      } finally {
        await f.cleanup();
      }
    }
  );

test(
  "G02.3 missing fixed job retains both reservations; wrong bridge cannot hand over",
  options,
  async () => {
    const f = await fixture(true),
      db = await f.pool.connect();
    try {
      const bridge = (await f.ops()).find((o: DurableCommand) => o.request.transferAction === "bridge")!;
      await f.pool.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
        [bridge.id, randomUUID()]
      );
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [bridge.id]);
      let probes = 0;
      const probe = async () => {
        probes++;
        return "false";
      };
      assert.equal(await resolveTransferCommand(bridge, db, probe, new AbortController().signal), null);
      assert.equal(probes, 0);
      await settleTransferConnection(f.pool, f.root.id);
      await f.finishRestores();
      await reconcileCoordinatedCallCleanup(f.pool, f.c.callId);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from agent_call_slots where call_id=$1 and state<>'free'",
            [f.c.callId]
          )
        ).rows[0].n,
        2
      );
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_capacity_reservations where operation_id=$1 and state='released'",
            [f.root.id]
          )
        ).rows[0].n,
        0
      );
      await persistTransferJob(f.pool, {
        jobUuid: bridge.command_uuid,
        body: "+OK",
        headers: { "event-uuid": randomUUID() }
      });
      await persistTransferEvent(f.pool, {
        "event-name": "CHANNEL_BRIDGE",
        "unique-id": f.c.customerUuid,
        "other-leg-unique-id": f.c.agentUuid,
        "event-date-timestamp": String(Date.now() * 1000),
        "event-uuid": randomUUID()
      });
      assert.equal(
        await resolveTransferCommand(bridge, db, async () => "true", new AbortController().signal),
        null
      );
      assert.equal(
        (await f.pool.query("select agent_id from calls where id=$1", [f.c.callId])).rows[0].agent_id,
        f.agentId
      );
      const headers = {
        "event-name": "CHANNEL_BRIDGE",
        "unique-id": f.c.customerUuid,
        "other-leg-unique-id": String(f.root.request.agentUuid),
        "event-uuid": randomUUID(),
        variable_outbound_dialer_transfer_id: randomUUID()
      };
      await persistTransferEvent(f.pool, headers);
      assert.equal(
        await resolveTransferCommand(bridge, db, async () => "true", new AbortController().signal),
        null
      );
      await persistTransferEvent(f.pool, {
        ...headers,
        "event-uuid": randomUUID(),
        variable_outbound_dialer_transfer_id: String(f.root.request.transferId)
      });
      const resolved = await resolveTransferCommand(
        bridge,
        db,
        async (command) => (command.startsWith("uuid_exists ") ? "true" : String(f.root.request.agentUuid)),
        new AbortController().signal
      );
      assert.equal(resolved?.state, "succeeded");
    } finally {
      db.release();
      await f.cleanup();
    }
  }
);

test(
  "G02.2 recipient pre-switch failure cleans only recipient and preserves source owner/slot",
  options,
  async () => {
    const f = await fixture(false);
    try {
      await f.resolve(f.root, "failed");
      await settleTransferConnection(f.pool, f.root.id);
      const clean = (await f.ops()).find(
        (o: DurableCommand) => o.request.transferAction === "cleanup_recipient"
      )!;
      assert.ok(clean);
      assert.ok(
        !(await f.ops()).some((o: DurableCommand) => o.request.transferAction === "cleanup_customer")
      );
      await f.resolve(clean);
      await persistCoordinatedCallEvent(f.pool, {
        callId: f.c.callId,
        legUuid: String(f.root.request.agentUuid),
        eventName: "CHANNEL_DESTROY",
        eventUuid: randomUUID()
      });
      await settleTransferConnection(f.pool, f.root.id);
      await f.finishRestores();
      await reconcileCoordinatedCallCleanup(f.pool, f.c.callId);
      assert.equal(
        (await f.pool.query("select agent_id,ended_at from calls where id=$1", [f.c.callId])).rows[0]
          .agent_id,
        f.agentId
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agentId])).rows[0]
          .state,
        "active"
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.agent])).rows[0].state,
        "free"
      );
    } finally {
      await f.cleanup();
    }
  }
);

test("G02.2 switching failure terminates truthfully after all fixed cleanup steps", options, async () => {
  const f = await fixture(false);
  try {
    for (const o of await f.ops())
      await f.resolve(o, o.request.transferAction === "bridge" ? "failed" : "succeeded");
    await settleTransferConnection(f.pool, f.root.id);
    for (const step of ["cleanup_recipient", "cleanup_source", "cleanup_customer"]) {
      const op = (await f.ops()).find((o: DurableCommand) => o.request.transferAction === step)!;
      assert.ok(op);
      // Simulated attempted technical hangup; actual C03/FS sends are covered by
      // the separate media matrix. Without this evidence a customer terminal
      // event correctly means cancellation, rather than our technical failure.
      if (step === "cleanup_customer")
        await f.pool.query(
          "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,3)",
          [op.id, randomUUID()]
        );
      await f.resolve(op);
      await persistCoordinatedCallEvent(f.pool, {
        callId: f.c.callId,
        legUuid: op.target_uuid,
        eventName: "CHANNEL_DESTROY",
        eventUuid: randomUUID()
      });
      await settleTransferConnection(f.pool, f.root.id);
    }
    await reconcileCoordinatedCallCleanup(f.pool, f.c.callId);
    const call = (await f.pool.query("select * from calls where id=$1", [f.c.callId])).rows[0];
    assert.ok(call.ended_at);
    assert.equal(call.outcome, "failed");
    assert.equal(
      (await f.pool.query("select state from call_transfers where id=$1", [f.t.transfer!.id])).rows[0].state,
      "failed"
    );
    assert.equal(
      (await f.pool.query("select count(*)::int n from agent_call_slots where call_id=$1", [f.c.callId]))
        .rows[0].n,
      0
    );
  } finally {
    await f.cleanup();
  }
});

for (const order of ["terminal_first", "handover_first", "terminal_rollback"])
  test(
    `G02.3 DB barrier ${order}: revalidate customer termination against confirmed bridge`,
    options,
    async () => {
      const f = await fixture(false);
      const config = databaseConfig(testDatabaseUrl(), f.schema);
      const handoverPool = new pg.Pool({ ...config, max: 1 }),
        terminalPool = new pg.Pool({ ...config, max: 1 });
      const blocker = await f.pool.connect();
      let pendingHandover: Promise<unknown> | undefined, pendingTerminal: Promise<unknown> | undefined;
      try {
        for (const o of await f.ops()) await f.resolve(o);
        const setterPid = (await handoverPool.query("select pg_backend_pid() pid")).rows[0].pid;
        const terminalPid = (await terminalPool.query("select pg_backend_pid() pid")).rows[0].pid;
        const blockerPid = (await blocker.query("select pg_backend_pid() pid")).rows[0].pid;
        await blocker.query("begin");
        await blocker.query("select pg_advisory_xact_lock(72202,0)");
        const terminate = async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              return await persistCoordinatedCallEvent(terminalPool, {
                callId: f.c.callId,
                legUuid: f.c.customerUuid,
                eventName: "CHANNEL_HANGUP_COMPLETE",
                eventUuid: randomUUID()
              });
            } catch (error) {
              if (!(error instanceof AdmissionDiscoveryChanged) || attempt === 2) throw error;
            }
          }
        };
        if (order === "terminal_rollback") {
          await blocker.query(
            "update calls set state='completed',outcome='customer_hung_up',ended_at=clock_timestamp() where id=$1",
            [f.c.callId]
          );
          pendingHandover = settleTransferConnection(handoverPool, f.root.id);
          await assertBlocked(f.pool, setterPid, blockerPid);
          await blocker.query("rollback");
          await pendingHandover;
        } else {
          if (order === "terminal_first") {
            pendingTerminal = terminate();
            await assertBlocked(f.pool, terminalPid, blockerPid);
            pendingHandover = settleTransferConnection(handoverPool, f.root.id);
            await assertBlocked(f.pool, setterPid, blockerPid);
          } else {
            pendingHandover = settleTransferConnection(handoverPool, f.root.id);
            await assertBlocked(f.pool, setterPid, blockerPid);
            pendingTerminal = terminate();
            await assertBlocked(f.pool, terminalPid, blockerPid);
          }
          await blocker.query("commit");
          await Promise.all([pendingHandover, pendingTerminal]);
        }
        const row = (await f.pool.query("select * from calls where id=$1", [f.c.callId])).rows[0];
        assert.equal(row.agent_id, order === "terminal_first" ? f.agentId : f.agent);
        assert.equal(Boolean(row.ended_at), order !== "terminal_rollback");
        const participant = (
          await f.pool.query("select connected_at from call_participants where id=$1", [
            f.root.request.participantId
          ])
        ).rows[0];
        assert.equal(Boolean(participant.connected_at), order !== "terminal_first");
        assert.equal(
          (
            await f.pool.query(
              "select count(*)::int n from agent_call_slots where call_id=$1 and state<>'free'",
              [f.c.callId]
            )
          ).rows[0].n,
          2
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n,
          0
        );
      } finally {
        await blocker.query("rollback").catch(() => {});
        await Promise.allSettled([pendingHandover, pendingTerminal]);
        blocker.release();
        await handoverPool.end();
        await terminalPool.end();
        await f.cleanup();
      }
    }
  );

test(
  "G02.2/E04 accepted transfer uses connection deadline after the offer deadline passes",
  options,
  async () => {
    const f = await fixture(false, true);
    try {
      while (
        !(
          await f.pool.query("select clock_timestamp()>=deadline_at due from call_transfers where id=$1", [
            f.t.transfer!.id
          ])
        ).rows[0].due
      )
        await delay(100);
      assert.equal(
        (
          await f.pool.query("select deadline_at>clock_timestamp() valid from call_operations where id=$1", [
            f.root.id
          ])
        ).rows[0].valid,
        true
      );
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [f.root.id]);
      await f.pool.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
        [f.root.id, randomUUID()]
      );
      const intent = f.root.request.intent as Record<string, string>;
      const input = {
        callId: f.c.callId,
        operationId: f.root.id,
        deskSessionId: intent.deskSessionId!,
        bindingGeneration: intent.bindingGeneration!,
        legUuid: String(f.root.request.agentUuid),
        dialogId: randomUUID()
      };
      const actor = { agentId: f.agent, userId: String(f.root.request.actorUserId), authVersion: 1 };
      assert.equal(await authorizeServiceInvite(f.pool, actor, input), true);
      await f.pool.query(
        "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='fixture cancellation' where id=$1",
        [f.root.id]
      );
      assert.equal(await authorizeServiceInvite(f.pool, actor, input), false);
    } finally {
      await f.cleanup();
    }
  }
);
