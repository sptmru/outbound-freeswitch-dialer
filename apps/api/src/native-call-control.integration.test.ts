import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import net from "node:net";
import { once } from "node:events";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { cleanupHttp, cleanupRecording } from "../../../tests/fixtures/inbound/cleanup-http.mjs";
import {
  createFixtureLogin,
  databaseConfig,
  testDatabaseUrl
} from "../../../tests/fixtures/inbound/database.mjs";
import { CallExecutor } from "./call-executor.js";
import { nativeCallControlExecutor } from "./native-call-control.js";
import { __testing as events } from "./esl-events.js";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use isolated runner" : false,
  timeout: 30000
};
const fixture = () => cleanupFixture(databaseConfig(testDatabaseUrl()));

test(
  "C06 native HTTP authority, staged bootstrap, ambiguity and committed response replay",
  options,
  async () => {
    const f = await fixture(),
      absent = await cleanupHttp(f, { installed: false }),
      http = await cleanupHttp(f);
    try {
      const s = await f.seed(),
        body = { intent: http.intent() };
      assert.equal((await http.api(s.callId, "end", body, {})).statusCode, 401);
      assert.equal(
        (await http.api(s.callId, "end", body, { cookie: `${http.cookieName}=${http.token}` })).statusCode,
        403
      );
      const before = await f.snapshot();
      assert.equal((await absent.api(s.callId, "end", body)).statusCode, 409);
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(
        (await http.api(s.callId, "end", { intent: { ...body.intent, expectedRevision: "2" } })).statusCode,
        409
      );
      assert.equal(
        (await http.api(s.callId, "end", { intent: { ...body.intent, deskSessionId: randomUUID() } }))
          .statusCode,
        409
      );
      assert.equal((await http.api(s.callId, "end", {})).statusCode, 404);
      assert.deepEqual(await f.snapshot(), before);
      const first = await http.api(s.callId, "end", body);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().status, "accepted");
      const committed = await f.snapshot();
      assert.equal(
        committed.call_operations.filter((o: { state: string }) => o.state === "pending").length,
        2
      );
      assert.equal(committed.agent_call_slots[0].state, "releasing");
      assert.deepEqual((await http.api(s.callId, "end", body)).json(), first.json());
      assert.equal(http.wakes.length, 1);
      assert.deepEqual(await f.snapshot(), committed);
      assert.equal(
        (await http.api(s.callId, "end", { intent: { ...body.intent, expectedRevision: "2" } })).json().code,
        "idempotency_conflict"
      );
      assert.equal((await http.api(s.callId, "end")).json().code, "call_outcome_uncertain");
      // Simulated completion plus a different current slot: response-loss replay is inert.
      await f.pool.query(
        "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='fixture never sent' where resolved_at is null"
      );
      for (const leg of [s.agentUuid, s.customerUuid])
        await events.persistFreeSwitchEvent({} as AppConfig, f.pool, {
          headers: {
            "event-name": "CHANNEL_HANGUP_COMPLETE",
            "unique-id": leg,
            variable_outbound_dialer_call_id: s.callId,
            "hangup-cause": "NORMAL_CLEARING",
            "event-uuid": randomUUID()
          },
          body: ""
        });
      const next = await f.seed();
      await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
      const newer = await f.snapshot();
      assert.deepEqual((await http.api(s.callId, "end", body)).json(), first.json());
      assert.deepEqual(await f.snapshot(), newer);
      assert.equal(newer.agent_call_slots[0].call_id, next.callId);
    } finally {
      await http.close();
      await absent.close();
      await f.cleanup();
    }
  }
);

test("C06 native VM selects campaign audio under admission and snapshots the claim", options, async () => {
  const f = await fixture(),
    http = await cleanupHttp(f, {
      wake: async () => {
        throw new Error("simulated scheduler unavailable");
      }
    });
  try {
    const s = await f.seed(),
      body = { intent: http.intent() };
    assert.equal((await http.api(s.callId, "drop-voicemail", body)).json().code, "voicemail_unavailable");
    const recording = await cleanupRecording(f);
    assert.equal(
      (await http.api(s.callId, "drop-voicemail", { ...body, recordingId: randomUUID() })).statusCode,
      400
    );
    const first = await http.api(s.callId, "drop-voicemail", body);
    assert.equal(first.statusCode, 200, first.body);
    await f.pool.query("update campaigns set voicemail_recording_id=null where id=$1", [f.campaignId]);
    const snap = await f.snapshot(),
      ops = snap.call_operations.filter(
        (o: { request: { rootOperationId?: string } }) =>
          o.request.rootOperationId === first.json().operationId
      );
    assert.equal(ops.length, 2);
    assert.equal(
      ops.find((o: { command_kind: string }) => o.command_kind === "play_audio").request.recordingId,
      recording
    );
    assert.equal(
      ops.find((o: { command_kind: string }) => o.command_kind === "release_agent").request.dependsOn,
      first.json().operationId
    );
    assert.equal(snap.calls[0].recording_id, recording);
    assert.equal(
      snap.call_capacity_reservations.filter((r: { state: string }) => r.state === "released").length,
      0
    );
    assert.deepEqual((await http.api(s.callId, "drop-voicemail", body)).json(), first.json());
    assert.deepEqual(await f.snapshot(), snap);
    assert.equal(http.wakes.length, 1);
  } finally {
    await http.close();
    await f.cleanup();
  }
});

// A fake ESL peer proves the HTTP/DB/executor contract only. Actual FS is a separate lab.
async function mockEsl(onCommand: (command: string, job: string) => Promise<string>) {
  const sockets = new Set<net.Socket>(),
    sent: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write("Content-Type: auth/request\n\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n"),
          frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("auth ") || frame.startsWith("event "))
          socket.write("Content-Type: command/reply\nReply-Text: +OK\n\n");
        else {
          const job = frame.split("\nJob-UUID: ")[1];
          sent.push(frame);
          void onCommand(frame, job)
            .then((body) => {
              socket.write(`Content-Type: command/reply\nReply-Text: +OK\nJob-UUID: ${job}\n\n`);
              const event = `Event-Name: BACKGROUND_JOB\nEvent-UUID: ${randomUUID()}\nJob-UUID: ${job}\n\n${body}`;
              socket.write(
                `Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(event)}\n\n${event}`
              );
            })
            .catch((e) => socket.destroy(e));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    host: "127.0.0.1",
    port: (server.address() as net.AddressInfo).port,
    password: "isolated-only",
    sent,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
}
async function testExecutor(f: Awaited<ReturnType<typeof fixture>>) {
  const role = `c06exec_${randomUUID().replaceAll("-", "")}`,
    admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  const database = await createFixtureLogin(
    admin,
    { connectionString: testDatabaseUrl(), options: `-c search_path=${f.schema}` },
    role,
    8
  );
  await f.pool.query(
    `grant usage on schema ${f.schema} to ${role};grant all on all tables in schema ${f.schema} to ${role};grant usage,select on all sequences in schema ${f.schema} to ${role}`
  );
  const executor = await CallExecutor.create(database, 0);
  return {
    executor,
    async close() {
      await executor.close();
      await admin.query(`drop owned by ${role}`);
      await admin.query(`drop role ${role}`);
      await admin.end();
    }
  };
}

for (const mode of ["end", "end-before-answer", "drop-voicemail"] as const)
  test(`C06 actual HTTP/C03 ${mode}: fixed jobs, exact events, retry and pause`, options, async () => {
    const action = mode === "end-before-answer" ? "end" : mode;
    const f = await fixture(),
      ex = await testExecutor(f);
    let http: Awaited<ReturnType<typeof cleanupHttp>> | undefined;
    const s = await f.seed();
    if (mode === "end-before-answer")
      await f.pool.query(
        "update calls set state='customer_ringing',pstn_answered_at=null,answered_at=null where id=$1",
        [s.callId]
      );
    if (action === "drop-voicemail") await cleanupRecording(f);
    const peer = await mockEsl(async (command) => {
      const leg = command.split(" ")[2];
      await events.persistFreeSwitchEvent({} as AppConfig, f.pool, {
        headers: {
          "event-name": command.includes("uuid_transfer") ? "CUSTOM" : "CHANNEL_HANGUP_COMPLETE",
          ...(command.includes("uuid_transfer")
            ? {
                "event-subclass": "outbound_dialer::voicemail_playback_started",
                "outbound-dialer-customer-leg-uuid": leg
              }
            : {}),
          "unique-id": leg,
          variable_outbound_dialer_call_id: s.callId,
          "event-uuid": randomUUID(),
          "hangup-cause": "NORMAL_CLEARING"
        },
        body: ""
      });
      return "+OK\n";
    });
    try {
      const adapter = nativeCallControlExecutor(f.pool, ex.executor, peer);
      http = await cleanupHttp(f, { wake: adapter.wakeExecutor });
      const body = { intent: http.intent() };
      await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
      const response = await http.api(s.callId, action, body);
      assert.equal(response.statusCode, 200, response.body);
      const snap = await f.snapshot();
      assert.equal(peer.sent.length, 2);
      assert.equal(
        snap.call_operations.filter((o: { resolved_at: Date | null }) => !o.resolved_at).length,
        0
      );
      assert.equal(snap.agent_call_slots[0].state, "free");
      assert.equal(snap.agents[0].availability_status, "paused");
      if (action === "drop-voicemail") {
        assert.equal(snap.calls[0].state, "agent_released");
        assert.equal(snap.calls[0].ended_at, null);
        assert.ok(
          snap.call_capacity_reservations.some(
            (r: { state: string; resource_type: string }) =>
              r.resource_type === "customer_channel" && r.state !== "released"
          )
        );
      } else {
        assert.ok(snap.calls[0].ended_at);
        assert.equal(snap.calls[0].outcome, mode === "end-before-answer" ? "agent_canceled" : "answered");
      }
      assert.deepEqual((await http.api(s.callId, action, body)).json(), response.json());
      await adapter.wakeExecutor(response.json().operationId);
      assert.equal(peer.sent.length, 2);
    } finally {
      await http?.close();
      await peer.close();
      await ex.close();
      await f.cleanup();
    }
  });

test(
  "C06 dependent release cannot run first; rejected transfer cancels unsent child without freeing live legs",
  options,
  async () => {
    const f = await fixture(),
      ex = await testExecutor(f),
      http = await cleanupHttp(f),
      peer = await mockEsl(async () => "-ERR invalid destination\n");
    try {
      const s = await f.seed();
      await cleanupRecording(f);
      const result = await http.api(s.callId, "drop-voicemail");
      const root = result.json().operationId,
        child = (await f.pool.query("select * from call_operations where request->>'dependsOn'=$1", [root]))
          .rows[0];
      const refused = await ex.executor.run(child.id, "critical", {
        send: async () => {
          throw new Error("must not send");
        },
        reconcile: async () => null
      });
      assert.deepEqual(refused, { status: "deferred", reason: "predecessor_not_succeeded" });
      await nativeCallControlExecutor(f.pool, ex.executor, peer).wakeExecutor(root);
      const snap = await f.snapshot();
      assert.equal(peer.sent.length, 1);
      assert.equal(snap.call_operations.find((o: { id: string }) => o.id === child.id).state, "canceled");
      assert.equal(snap.calls[0].state, "bridged");
      assert.equal(snap.calls[0].ended_at, null);
      assert.equal(snap.agent_call_slots[0].state, "releasing");
      assert.ok(snap.call_capacity_reservations.every((r: { state: string }) => r.state !== "released"));
      // A definitive rejection permits a fresh claim; lifecycle-event uniqueness
      // must not turn the next user action into a database constraint failure.
      const retry = await http.api(s.callId, "drop-voicemail");
      assert.equal(retry.statusCode, 200, retry.body);
      assert.notEqual(retry.json().operationId, root);
      const newer = await f.snapshot();
      // A scheduler replay of the old failed chain cannot reset the newer claim.
      await nativeCallControlExecutor(f.pool, ex.executor, peer).wakeExecutor(root);
      const afterOldReplay = await f.snapshot();
      assert.deepEqual(afterOldReplay.calls, newer.calls);
      assert.deepEqual(afterOldReplay.call_operations, newer.call_operations);
      assert.ok(
        afterOldReplay.call_capacity_reservations.every((r: { state: string }) => r.state !== "released")
      );
      assert.equal(
        afterOldReplay.agent_call_slots[0].reservation_id,
        newer.agent_call_slots[0].reservation_id
      );
      assert.equal(peer.sent.length, 1);
    } finally {
      await http.close();
      await peer.close();
      await ex.close();
      await f.cleanup();
    }
  }
);

test(
  "C06 native ACK/job without concrete cleanup retains uncertain reservation; reconciliation sends no duplicate",
  options,
  async () => {
    const f = await fixture(),
      ex = await testExecutor(f),
      http = await cleanupHttp(f),
      s = await f.seed();
    const peer = await mockEsl(async (command) => {
      const leg = command.split(" ")[2];
      if (leg === s.agentUuid)
        await events.persistFreeSwitchEvent({} as AppConfig, f.pool, {
          headers: {
            "event-name": "CHANNEL_HANGUP_COMPLETE",
            "unique-id": leg,
            variable_outbound_dialer_call_id: s.callId,
            "event-uuid": randomUUID(),
            "hangup-cause": "NORMAL_CLEARING"
          },
          body: ""
        });
      return "+OK\n";
    });
    try {
      const body = { intent: http.intent() },
        response = await http.api(s.callId, "end", body),
        root = response.json().operationId;
      const adapter = nativeCallControlExecutor(f.pool, ex.executor, peer);
      await adapter.wakeExecutor(root);
      const uncertain = await f.snapshot();
      assert.equal(uncertain.call_operations.find((o: { id: string }) => o.id === root).state, "uncertain");
      assert.equal(uncertain.agent_call_slots[0].state, "uncertain");
      assert.ok(uncertain.call_capacity_reservations.every((r: { state: string }) => r.state !== "released"));
      assert.equal(peer.sent.length, 1);
      assert.deepEqual((await http.api(s.callId, "end", body)).json(), response.json());
      await events.persistFreeSwitchEvent({} as AppConfig, f.pool, {
        headers: {
          "event-name": "CHANNEL_HANGUP_COMPLETE",
          "unique-id": s.customerUuid,
          variable_outbound_dialer_call_id: s.callId,
          "event-uuid": randomUUID(),
          "hangup-cause": "NORMAL_CLEARING"
        },
        body: ""
      });
      await adapter.wakeExecutor(root);
      assert.equal(peer.sent.length, 2);
      assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
    } finally {
      await http.close();
      await peer.close();
      await ex.close();
      await f.cleanup();
    }
  }
);
