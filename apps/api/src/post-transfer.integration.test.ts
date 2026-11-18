import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import type { BrowserMediaTelemetryRequest } from "@outbound-dialer/shared";
import { supervisorFixture } from "../../../tests/fixtures/inbound/supervisor.mjs";
import { cleanupHttp, cleanupRecording } from "../../../tests/fixtures/inbound/cleanup-http.mjs";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { createTransferOffer, mutateTransferOffer } from "./transfer-offers.js";
import {
  prepareTransferCommands,
  settleTransferConnection,
  validateTransferConnection
} from "./transfer-connection.js";
import { withCallAdmission } from "./call-admission.js";
import { persistCoordinatedCallEvent, reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import {
  admitSupervisorMutation,
  prepareSupervisorHandover,
  settleSupervisor,
  supervisionQuiescent
} from "./supervisor-coordination.js";
import { nativeControlCommand } from "./native-call-control.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 };
const intent = (deskSessionId: string) => ({
  deskSessionId,
  expectedRevision: "1",
  bindingGeneration: "1",
  idempotencyKey: randomUUID()
});
async function fixture(inbound = false, offered = true) {
  const f = await supervisorFixture(databaseConfig(testDatabaseUrl()));
  const c = await f.seed({ inbound });
  const b = await f.actor();
  await f.pool.query("update agent_call_slots set state='active' where agent_id=$1", [f.agentId]);
  await f.pool.query(
    "update call_participants set joined_at=clock_timestamp()-interval '10 seconds',connected_at=clock_timestamp()-interval '9 seconds' where id=$1",
    [c.participantId]
  );
  await f.pool.query(
    "update agent_desk_sessions set actor_auth_version=1,endpoint_pin=verified_endpoint where id=$1",
    [f.input.deskSessionId]
  );
  await f.pool.query(
    "update agent_desk_sessions set actor_auth_version=1,verified_endpoint=$2,endpoint_pin=$2 where id=$1",
    [b.deskSessionId, `sofia/internal-webrtc/sip:g04@127.0.0.4:5060`]
  );
  const source = { userId: f.userId, agentId: f.agentId, authVersion: 1 };
  const target = { userId: b.userId, agentId: b.agentId, authVersion: 1 };
  const createInput = { ...intent(f.input.deskSessionId), recipientAgentId: b.agentId };
  const create = (pool = f.pool) => createTransferOffer(pool, source, c.callId, createInput);
  const transfer = offered ? await create() : null;
  const accept = () =>
    mutateTransferOffer(f.pool, target, transfer!.offerId, intent(b.deskSessionId), "accept");
  async function resolve(id: string) {
    await f.pool.query(
      "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='simulated DB fixture; no FS proof' where id=$1 and resolved_at is null",
      [id]
    );
  }
  async function handover() {
    const accepted = await accept();
    assert.ok("operationId" in accepted);
    await prepareTransferCommands(f.pool, accepted.operationId);
    for (const row of (
      await f.pool.query("select id from call_operations where call_id=$1 and resolved_at is null", [
        c.callId
      ])
    ).rows)
      await resolve(row.id);
    await settleTransferConnection(f.pool, accepted.operationId);
    const root = (await f.pool.query("select * from call_operations where id=$1", [accepted.operationId]))
      .rows[0];
    await persistCoordinatedCallEvent(f.pool, {
      callId: c.callId,
      legUuid: c.agentUuid,
      eventName: "CHANNEL_HANGUP_COMPLETE",
      eventUuid: randomUUID()
    });
    for (let i = 0; i < 4; i++) {
      for (const row of (
        await f.pool.query("select id from call_operations where call_id=$1 and resolved_at is null", [
          c.callId
        ])
      ).rows)
        await resolve(row.id);
      await settleTransferConnection(f.pool, root.id);
    }
    await reconcileCoordinatedCallCleanup(f.pool, c.callId);
    assert.equal(
      (await f.pool.query("select state from call_transfers where id=$1", [transfer!.transfer.id])).rows[0]
        .state,
      "completed"
    );
    return root;
  }
  return { ...f, c, b, source, target, transfer, create, createInput, accept, handover, resolve };
}

for (const inbound of [false, true])
  for (const action of ["end", "drop-voicemail", "dtmf", "transfer"] as const)
    test(
      `G04.1 ${inbound ? "inbound" : "outbound"} current owner alone controls ${action} after handover`,
      options,
      async () => {
        const f = await fixture(inbound);
        const old = await cleanupHttp(f);
        const current = await cleanupHttp({
          ...f,
          userId: f.b.userId,
          input: { deskSessionId: f.b.deskSessionId }
        });
        const otherActor = await f.actor();
        const unrelated = await cleanupHttp({
          ...f,
          userId: otherActor.userId,
          input: { deskSessionId: otherActor.deskSessionId }
        });
        try {
          await cleanupRecording(f);
          const root = await f.handover();
          const before = await f.snapshot();
          const send = (http: any, overrides: Record<string, unknown> = {}) =>
            action === "transfer"
              ? http.app.inject({
                  method: "POST",
                  url: `/agent/calls/${f.c.callId}/transfers`,
                  headers: { authorization: `Bearer ${http.token}` },
                  payload: { ...http.intent(), recipientAgentId: otherActor.agentId, ...overrides }
                })
              : http.api(f.c.callId, action, {
                  intent: http.intent(),
                  ...(action === "dtmf" ? { digit: "5" } : {}),
                  ...overrides
                });
          for (const http of [old, unrelated]) {
            for (let repeat = 0; repeat < 2; repeat++) assert.equal((await send(http)).statusCode, 409);
            assert.deepEqual(
              await f.snapshot(),
              before,
              "denied controls have no persisted or executor side effects"
            );
          }
          if (action !== "transfer") {
            assert.equal(
              (await send(current, { intent: { ...current.intent(), expectedRevision: "2" } })).statusCode,
              409
            );
            assert.equal(
              (await send(current, { intent: { ...current.intent(), deskSessionId: f.input.deskSessionId } }))
                .statusCode,
              409
            );
            assert.deepEqual(await f.snapshot(), before);
            assert.equal(
              (await old.api(f.c.callId, action, action === "dtmf" ? { digit: "5" } : {})).statusCode,
              action === "dtmf" ? 409 : 404
            );
          }
          // Old accepted create-key replay returns only its immutable historical receipt.
          const replay = await f.create();
          assert.equal(replay.transfer.id, f.transfer!.transfer.id);
          assert.deepEqual(await f.snapshot(), before);
          const body =
            action === "transfer"
              ? { ...current.intent(), recipientAgentId: otherActor.agentId }
              : { intent: current.intent(), ...(action === "dtmf" ? { digit: "5" } : {}) };
          const first = await send(current, body);
          assert.equal(first.statusCode, 200, first.body);
          const after = await f.snapshot();
          assert.deepEqual((await send(current, body)).json(), first.json());
          assert.deepEqual(await f.snapshot(), after);
          assert.equal(current.wakes.length, action === "transfer" ? 0 : 1);
          if (action === "dtmf") {
            const op = after.call_operations.find((o: any) => o.id === first.json().operationId);
            assert.equal(nativeControlCommand(op), `uuid_send_dtmf ${f.c.customerUuid} 5`);
            assert.equal(after.agent_call_slots.find((s: any) => s.agent_id === f.b.agentId).state, "active");
          }
          assert.equal(root.request.sourceParticipantId, f.c.participantId);
        } finally {
          await Promise.all([old.close(), current.close(), unrelated.close()]);
          await f.cleanup();
        }
      }
    );

function telemetry(startedAt: string, endedAt: string, sampleCount = 2): BrowserMediaTelemetryRequest {
  return {
    schemaVersion: 1,
    startedAt,
    endedAt,
    sampleCount,
    microphone: {
      sampleRate: null,
      sampleSize: null,
      channelCount: null,
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      latencySeconds: null
    },
    inbound: {
      codec: null,
      packetsReceived: 100,
      packetsLost: null,
      packetsDiscarded: null,
      jitterSecondsMax: null,
      jitterBufferDelaySeconds: null,
      jitterBufferEmittedCount: null,
      concealedSamples: null,
      totalSamplesReceived: null,
      concealmentEvents: null,
      audioEnergy: null,
      audioDurationSeconds: null
    },
    outbound: {
      codec: null,
      packetsSent: 80,
      bytesSent: null,
      remotePacketsLost: null,
      remoteJitterSecondsMax: null,
      roundTripTimeSecondsMax: null
    },
    connection: { localCandidateType: null, remoteCandidateType: null, protocol: null, relayProtocol: null }
  };
}
test(
  "G04.2 delayed HTTP telemetry is exact-leg/actor/time bounded, replay inert and participation duration independent",
  options,
  async () => {
    const f = await fixture();
    const old = await cleanupHttp(f),
      current = await cleanupHttp({ ...f, userId: f.b.userId, input: { deskSessionId: f.b.deskSessionId } });
    try {
      await f.handover();
      const p = (await f.pool.query("select * from call_participants where id=$1", [f.c.participantId]))
        .rows[0];
      const valid = telemetry(new Date(p.joined_at.getTime() + 1).toISOString(), p.left_at.toISOString());
      const send = (http: any, leg: string, payload = valid) =>
        http.app.inject({
          method: "PUT",
          url: `/agent/calls/${f.c.callId}/legs/${leg}/browser-media`,
          headers: { authorization: `Bearer ${http.token}` },
          payload
        });
      assert.equal((await send(old, f.c.agentUuid)).statusCode, 204);
      const before = (
        await f.pool.query("select * from call_participant_browser_media_stats order by participant_id")
      ).rows;
      assert.equal((await send(old, f.c.agentUuid)).statusCode, 204);
      assert.equal(
        (await send(old, f.c.agentUuid, { ...valid, inbound: { ...valid.inbound, packetsReceived: 999 } }))
          .statusCode,
        204
      );
      assert.equal((await send(old, f.c.agentUuid, { ...valid, sampleCount: 1 })).statusCode, 204);
      assert.deepEqual(
        (await f.pool.query("select * from call_participant_browser_media_stats order by participant_id"))
          .rows,
        before
      );
      for (const [http, leg, value] of [
        [current, f.c.agentUuid, valid],
        [old, f.c.customerUuid, valid],
        [old, randomUUID(), valid],
        [old, f.c.agentUuid, telemetry(new Date(p.joined_at.getTime() - 1).toISOString(), valid.endedAt)],
        [old, f.c.agentUuid, telemetry(valid.startedAt, new Date(p.left_at.getTime() + 1).toISOString())],
        [old, f.c.agentUuid, telemetry(valid.startedAt, new Date(Date.now() + 60000).toISOString())]
      ] as const)
        assert.equal((await send(http, leg, value)).statusCode, 404);
      assert.equal(
        (await send(old, f.c.agentUuid, telemetry(valid.endedAt, valid.startedAt))).statusCode,
        400
      );
      const root = (
        await f.pool.query(
          "select request from call_operations where request->>'transferOfferAcceptance'='true' limit 1"
        )
      ).rows[0].request;
      assert.equal((await send(old, root.agentUuid)).statusCode, 404);
      assert.deepEqual(
        (await f.pool.query("select * from call_participant_browser_media_stats order by participant_id"))
          .rows,
        before
      );
      assert.deepEqual(
        (await f.pool.query("select * from call_participants where id=$1", [f.c.participantId])).rows[0],
        p
      );
      const legacy = await old.app.inject({
        method: "PUT",
        url: `/agent/calls/${f.c.callId}/browser-media`,
        headers: { authorization: `Bearer ${old.token}` },
        payload: valid
      });
      assert.equal(legacy.statusCode, 404);
    } finally {
      await old.close();
      await current.close();
      await f.cleanup();
    }
  }
);

for (const order of ["supervisor_first", "transfer_first", "supervisor_rollback"])
  test(`G04.3 real PostgreSQL ${order} admission race never follows handover`, options, async () => {
    const f = await fixture(false, false),
      admin = await f.actor();
    await f.pool.query(
      "insert into system_settings(key,value_json) values('ops.call_start_paused','false') on conflict do nothing"
    );
    const clients = await Promise.all([f.pool.connect(), f.pool.connect()]);
    let held!: () => void, release!: () => void;
    const holding = new Promise<void>((r) => {
        held = r;
      }),
      go = new Promise<void>((r) => {
        release = r;
      });
    function wrapped(i: number) {
      return {
        query: f.pool.query.bind(f.pool),
        connect: async () => ({
          query: async (sql: string, params?: unknown[]) => {
            if (sql === "commit" && i === 0) {
              held();
              await go;
              if (order === "supervisor_rollback") throw new Error("fixture rollback");
            }
            return clients[i].query(sql, params);
          },
          release() {}
        })
      } as unknown as pg.Pool;
    }
    const start = (pool: pg.Pool) =>
      admitSupervisorMutation(pool, {
        action: "start",
        callId: f.c.callId,
        actorUserId: admin.userId,
        actorAuthVersion: 1,
        key: randomUUID(),
        endpoint: admin.endpoint
      });
    let first: Promise<any> | undefined, second: Promise<any> | undefined;
    try {
      const pids = await Promise.all(
        clients.map(async (c) => (await c.query("select pg_backend_pid() pid")).rows[0].pid)
      );
      first = (order === "transfer_first" ? f.create(wrapped(0)) : start(wrapped(0))).then(
        (value: any) => ({ value }),
        (error: any) => ({ error })
      );
      await holding;
      second = (order === "transfer_first" ? start(wrapped(1)) : f.create(wrapped(1))).then(
        (value: any) => ({ value }),
        (error: any) => ({ error })
      );
      await assertBlocked(f.pool, pids[1], pids[0]);
      release();
      const [a, b] = await Promise.all([first, second]);
      const m = order === "transfer_first" ? b : a,
        t = order === "transfer_first" ? a : b;
      assert.ok(t.value?.transfer, t.error?.message);
      if (order === "transfer_first" || order === "supervisor_rollback") {
        assert.ok(m.error);
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_supervisor_sessions")).rows[0].n,
          0
        );
      } else {
        assert.ok(m.value, m.error?.message);
        const accepted = await mutateTransferOffer(
          f.pool,
          f.target,
          t.value.offerId,
          intent(f.b.deskSessionId),
          "accept"
        );
        assert.ok("operationId" in accepted);
        await prepareTransferCommands(f.pool, accepted.operationId);
        const db = await f.pool.connect();
        try {
          await withCallAdmission(db, { callIds: [f.c.callId] }, (a) =>
            prepareSupervisorHandover(a, f.c.callId, t.value.transfer.id)
          );
        } finally {
          db.release();
        }
        await settleSupervisor(f.pool, f.c.callId);
        assert.equal(
          await supervisionQuiescent(f.pool, f.c.callId),
          true,
          JSON.stringify({
            sessions: (await f.pool.query("select * from call_supervisor_sessions")).rows,
            legs: (await f.pool.query("select * from supervisor_leg_evidence")).rows,
            ops: (
              await f.pool.query(
                "select id,state,resolved_at,request from call_operations where request ? 'supervisorSessionId'"
              )
            ).rows,
            caps: (
              await f.pool.query(
                "select * from call_capacity_reservations where supervisor_session_id is not null"
              )
            ).rows
          })
        );
        assert.equal(
          (await f.pool.query("select state from call_operations where id=$1", [m.value.rootId])).rows[0]
            .state,
          "canceled"
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n,
          0
        );
      }
      assert.equal(
        (await f.pool.query("select agent_id from calls where id=$1", [f.c.callId])).rows[0].agent_id,
        f.agentId
      );
    } finally {
      release();
      await Promise.allSettled([first, second]);
      for (const c of clients) c.release();
      await f.cleanup();
    }
  });

for (const order of ["event_first", "job_first"])
  test(
    `G04.3 ${order}: exact stop needs both sender completion and channel end; transfer capacity remains`,
    options,
    async () => {
      const f = await fixture(false, false),
        admin = await f.actor();
      try {
        const { persistCoordinatedSupervisorEvent, supervisorHandoverDriver } =
          await import("./supervisor-coordination.js");
        const s = await admitSupervisorMutation(f.pool, {
          action: "start",
          callId: f.c.callId,
          actorUserId: admin.userId,
          actorAuthVersion: 1,
          key: randomUUID(),
          endpoint: admin.endpoint
        });
        await f.resolve(s.rootId);
        const oldLeg = (
          await f.pool.query("select supervisor_leg_uuid from call_supervisor_sessions where id=$1", [
            s.session.id
          ])
        ).rows[0].supervisor_leg_uuid;
        await persistCoordinatedSupervisorEvent(f.pool, {
          sessionId: s.session.id,
          supervisorLegUuid: oldLeg,
          eventName: "CHANNEL_ANSWER"
        });
        // A pending mode replacement must be canceled by transfer, not re-targeted.
        const mode = await admitSupervisorMutation(f.pool, {
          action: "mode",
          mode: "join",
          sessionId: s.session.id,
          actorUserId: admin.userId,
          actorAuthVersion: 1,
          key: randomUUID(),
          endpoint: admin.endpoint
        });
        const t = await f.create();
        const accepted = await mutateTransferOffer(
          f.pool,
          f.target,
          t.offerId,
          intent(f.b.deskSessionId),
          "accept"
        );
        assert.ok("operationId" in accepted);
        await prepareTransferCommands(f.pool, accepted.operationId);
        const db = await f.pool.connect();
        const prepare = () =>
          withCallAdmission(db, { callIds: [f.c.callId] }, (a) =>
            prepareSupervisorHandover(a, f.c.callId, t.transfer.id)
          );
        try {
          const work = await prepare();
          assert.equal(work.length, 1);
          assert.deepEqual(await prepare(), work, "one fixed stop per generation across retries");
          assert.equal(
            (await f.pool.query("select state from call_operations where id=$1", [mode.rootId])).rows[0]
              .state,
            "canceled"
          );
          const stop = (await f.pool.query("select * from call_operations where id=$1", [work[0]])).rows[0];
          assert.equal(stop.target_uuid, oldLeg);
          await f.pool.query("update call_operations set state='uncertain' where id=$1", [stop.id]);
          const driver = supervisorHandoverDriver(
            { host: "127.0.0.1", port: 1, password: "unused" },
            async () => "false"
          );
          assert.equal(
            await driver.reconcile(stop, new AbortController().signal, db),
            null,
            "absence without a fixed completed job cannot settle or resend"
          );
          const ended = () =>
            persistCoordinatedSupervisorEvent(f.pool, {
              sessionId: s.session.id,
              supervisorLegUuid: oldLeg,
              eventName: "CHANNEL_HANGUP_COMPLETE"
            });
          if (order === "event_first") await ended();
          else {
            await f.resolve(stop.id);
            await settleSupervisor(f.pool, f.c.callId);
          }
          assert.equal(await supervisionQuiescent(f.pool, f.c.callId), false);
          assert.equal(
            (
              await f.pool.query(
                "select count(*)::int n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
                [s.session.id]
              )
            ).rows[0].n,
            1
          );
          const op = (
            await f.pool.query(
              "select * from call_operations where request->>'transferAction'='park' and call_id=$1",
              [f.c.callId]
            )
          ).rows[0];
          await withCallAdmission(db, { callIds: [f.c.callId] }, async (a) =>
            assert.equal(await validateTransferConnection(op, a), false)
          );
          assert.equal(
            (await f.pool.query("select agent_id from calls where id=$1", [f.c.callId])).rows[0].agent_id,
            f.agentId
          );
          if (order === "event_first") await f.resolve(stop.id);
          else await ended();
          await settleSupervisor(f.pool, f.c.callId);
          assert.equal(await supervisionQuiescent(f.pool, f.c.callId), true);
          assert.equal(
            (
              await f.pool.query(
                "select count(*)::int n from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
                [s.session.id]
              )
            ).rows[0].n,
            0
          );
          assert.ok(
            (
              await f.pool.query(
                "select 1 from call_capacity_reservations where operation_id=$1 and state<>'released'",
                [accepted.operationId]
              )
            ).rowCount
          );
        } finally {
          db.release();
        }
      } finally {
        await f.cleanup();
      }
    }
  );
