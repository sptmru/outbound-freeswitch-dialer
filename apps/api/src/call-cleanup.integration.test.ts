import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { test } from "node:test";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { persistCoordinatedCallEvent, reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import { finalizeCallTransaction } from "./call-finalization.js";
import { __testing as events, reconcileActiveCalls } from "./esl-events.js";
import { dropVoicemailForCall, endDialerCall } from "./dashboard/calls.js";
import { setManualCallStatus } from "./dashboard/manual-call-status.js";
import type { AppConfig } from "./config.js";
import { runMigrations } from "./db.js";
import { reserveAgentCallSlot, releaseAgentCallSlot } from "./agent-call-slots.js";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 30000
};
const config = { FREESWITCH_ESL_ENABLED: true } as AppConfig;
async function event(f: any, s: any, agent = false, eventName = "CHANNEL_HANGUP_COMPLETE", extra = {}) {
  const legUuid = agent ? s.agentUuid : s.customerUuid;
  await persistCoordinatedCallEvent(f.pool, {
    callId: s.callId,
    legUuid,
    eventName,
    eventUuid: randomUUID(),
    hangupCause: "NORMAL_CLEARING",
    ...extra
  });
}
async function report(f: any, name: string, checks: unknown) {
  if (process.env.INBOUND_TEST_ARTIFACTS)
    await writeFile(
      `${process.env.INBOUND_TEST_ARTIFACTS}/c06-${name}.json`,
      JSON.stringify(
        {
          status: "passed",
          database: (await f.pool.query("select version()")).rows[0],
          media: "simulated ESL events; real PostgreSQL",
          checks,
          transcript: f.transcript,
          snapshot: await f.snapshot()
        },
        null,
        2
      )
    );
}

test("C06.1 missing leg, unresolved sender, exact cleanup and duplicate replay", options, async () => {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  try {
    const s = await f.seed({ unresolved: true });
    assert.deepEqual(await reconcileCoordinatedCallCleanup(f.pool, s.callId), {
      slots: 0,
      resources: 0,
      uncertain: true
    });
    assert.equal((await f.snapshot()).agent_call_slots[0].state, "uncertain");
    // False uuid_exists / legacy watchdog cannot finalize native work or issue commands.
    assert.equal(
      (
        await finalizeCallTransaction(f.pool, {
          callId: s.callId,
          resolve: () => ({ state: "failed", outcome: "failed" })
        })
      ).status,
      "not_applicable"
    );
    let sends = 0;
    await reconcileActiveCalls(config, f.pool, { info() {}, warn() {}, error() {} }, async () => {
      sends++;
      throw new Error("legacy probe forbidden");
    });
    assert.equal(sends, 0);
    await event(f, { ...s, agentUuid: randomUUID() }, true);
    assert.equal((await f.snapshot()).call_legs.filter((l: any) => l.ended_at).length, 0);
    await event(f, s, true);
    await event(f, s, false);
    assert.equal((await f.snapshot()).agent_call_slots[0].state, "uncertain");
    assert.ok((await f.snapshot()).call_capacity_reservations.every((r: any) => r.state === "uncertain"));
    await f.transaction(s.callId, async (a: any) =>
      a.client.query(
        "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='controlled sender stopped; exact job terminal' where id=$1",
        [s.operationId]
      )
    );
    assert.deepEqual(await reconcileCoordinatedCallCleanup(f.pool, s.callId), {
      slots: 1,
      resources: 3,
      uncertain: false
    });
    assert.deepEqual(await reconcileCoordinatedCallCleanup(f.pool, s.callId), {
      slots: 0,
      resources: 0,
      uncertain: false
    });
    await event(f, s, true);
    await event(f, s, false);
    assert.equal((await f.snapshot()).agent_call_slots[0].state, "free");
    assert.ok((await f.snapshot()).call_capacity_reservations.every((r: any) => r.state === "released"));
    await report(f, "unresolved-replay", { sends, exactlyOnceRelease: true });
  } finally {
    await f.cleanup();
  }
});

test(
  "C06.2 separate-process cleanup versus real manual admission revalidates commit and rollback",
  options,
  async () => {
    for (const rollback of [false, true]) {
      const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
      try {
        const s = await f.seed({ vm: true });
        // Exact terminal facts are persisted, but cleanup has not yet run.
        await f.transaction(s.callId, async (a: any) => {
          await a.client.query(
            "update call_legs set state='ended',ended_at=clock_timestamp() where participant_id=$1",
            [s.participantId]
          );
          await a.client.query("update call_participants set left_at=clock_timestamp() where id=$1", [
            s.participantId
          ]);
        });
        const request = {
          actorUserId: f.userId,
          route: "/agent/manual-dial/start",
          campaignId: f.campaignId,
          phoneNumber: "+14155550123",
          intent: {
            version: 1,
            startReason: "manual",
            deskSessionId: f.input.deskSessionId,
            expectedRevision: "1",
            bindingGeneration: "1",
            idempotencyKey: randomUUID()
          }
        };
        // Reverse serialization: admission sees the occupied old slot and must
        // roll back before cleanup can make a later retry eligible.
        const early = f.worker({ mode: "start", request });
        await early.wait("ready");
        early.send("go");
        assert.equal((await early.wait("rejected")).reason, "slot_occupied");
        await early.finished();
        const cleaner = f.worker({ mode: "cleanup", callId: s.callId });
        const starter = f.worker({ mode: "start", request });
        const first = await cleaner.wait("ready"),
          second = await starter.wait("ready");
        assert.notEqual(first.pid, second.pid);
        assert.notEqual(first.backend, second.backend);
        cleaner.send("go");
        await cleaner.wait("before-commit");
        starter.send("go");
        await assertBlocked(f.pool, second.backend, first.backend);
        cleaner.send(rollback ? "rollback" : "commit");
        if (rollback) {
          assert.equal((await cleaner.wait("rejected")).reason, "fixture_rollback");
          assert.equal((await starter.wait("rejected")).reason, "slot_occupied");
        } else {
          assert.equal((await cleaner.wait("committed")).result.slots, 1);
          await starter.wait("before-commit");
          starter.send("commit");
          const started = (await starter.wait("committed")).result;
          assert.equal(started.status, "started");
          assert.equal((await f.snapshot()).agent_call_slots[0].call_id, started.callId);
          await reconcileCoordinatedCallCleanup(f.pool, s.callId);
          assert.equal((await f.snapshot()).agent_call_slots[0].call_id, started.callId);
        }
        await cleaner.finished();
        await starter.finished();
        const snapshot = await f.snapshot();
        assert.equal(snapshot.calls.length, rollback ? 1 : 2);
        assert.equal(snapshot.call_operations.length, rollback ? 1 : 2);
        assert.equal(snapshot.contacts.length, 1);
        assert.equal(snapshot.contacts[0].status, "calling", "old customer remains active");
        assert.equal(snapshot.call_offers.length, 0);
        assert.equal(snapshot.call_transfers.length, 0);
        await report(f, `process-race-${rollback}`, { rollback, first, second });
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "C06.2 voicemail release, new slot and pause survive both old completion/hangup orders",
  options,
  async () => {
    for (const completedFirst of [true, false]) {
      const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
      try {
        const old = await f.seed({ vm: true });
        await event(f, old, true, "CHANNEL_HANGUP");
        assert.equal(
          (await f.snapshot()).agent_call_slots[0].state,
          "reserved",
          "hangup alone does not prove cleanup"
        );
        await event(f, old, true);
        let snapshot = await f.snapshot();
        assert.equal(snapshot.calls[0].state, "agent_released");
        assert.equal(snapshot.calls[0].ended_at, null);
        assert.equal(
          snapshot.call_capacity_reservations.find((r: any) => r.resource_type === "browser_channel").state,
          "released"
        );
        assert.ok(
          snapshot.call_capacity_reservations
            .filter((r: any) => r.resource_type !== "browser_channel")
            .every((r: any) => r.state !== "released")
        );
        const next = await f.seed();
        await f.pool.query("update agents set availability_status='paused' where id=$1", [f.agentId]);
        const before = (await f.snapshot()).agent_call_slots[0];
        const complete = () => event(f, old, false, "CUSTOM", { playback: "completed" });
        const hangup = () => event(f, old, false);
        if (completedFirst) {
          await complete();
          await hangup();
        } else {
          await hangup();
          await complete();
        }
        await event(f, old, true);
        await reconcileCoordinatedCallCleanup(f.pool, old.callId);
        snapshot = await f.snapshot();
        assert.deepEqual(snapshot.agent_call_slots[0], before);
        assert.equal(snapshot.agent_call_slots[0].call_id, next.callId);
        assert.equal(snapshot.agents[0].availability_status, "paused");
        assert.equal(snapshot.agents[0].status, "in_call");
        assert.equal(snapshot.call_operations.length, 2);
        assert.equal(snapshot.contacts.find((c: any) => c.id === next.contactId).status, "calling");
        assert.ok(
          snapshot.call_capacity_reservations
            .filter((r: any) => r.call_id === next.callId)
            .every((r: any) => r.state !== "released")
        );
        await report(f, `vm-${completedFirst}`, { completedFirst, old, newCall: next.callId });
      } finally {
        await f.cleanup();
      }
    }
  }
);

test("C06.3 old participant, late setup events and immutable terminal correction", options, async () => {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  try {
    const s = await f.seed();
    await event(f, s, true);
    assert.equal((await f.snapshot()).calls[0].ended_at, null, "agent end is not customer end");
    await f.pool.query("update calls set agent_id=null where id=$1", [s.callId]);
    const next = await f.seed();
    // A -> B -> A shape: a new concrete participation even for the same owner.
    await f.pool.query("update calls set agent_id=null where id=$1", [s.callId]);
    await event(f, s, true);
    await event(f, s, true, "CHANNEL_ANSWER");
    await event(f, s, true, "CHANNEL_BRIDGE");
    assert.equal((await f.snapshot()).agent_call_slots[0].call_id, next.callId);
    await event(f, s, false);
    await f.pool.query("update calls set agent_id=$2 where id=$1", [s.callId, f.agentId]);
    const corrected = await setManualCallStatus(f.pool, {
      callId: s.callId,
      userId: f.userId,
      outcome: "not_answered"
    });
    assert.equal(corrected.status, "updated");
    const before = (await f.snapshot()).calls.find((c: any) => c.id === s.callId);
    for (const eventName of [
      "CHANNEL_ANSWER",
      "CHANNEL_BRIDGE",
      "CHANNEL_HANGUP",
      "CHANNEL_HANGUP_COMPLETE",
      "CHANNEL_DESTROY"
    ]) {
      await event(f, s, true, eventName);
      await event(f, s, false, eventName);
    }
    await event(f, s, false, "CUSTOM", { playback: "completed" });
    assert.deepEqual(
      (await f.snapshot()).calls.find((c: any) => c.id === s.callId),
      before
    );
    assert.equal((await f.snapshot()).agent_call_slots[0].call_id, next.callId);
    // Legacy controls cannot kill native media or fabricate native completion.
    assert.equal(await endDialerCall(f.pool, config, f.userId, next.callId, {} as any), false);
    assert.equal((await dropVoicemailForCall(f.pool, config, f.userId, next.callId)).ok, false);
    await report(f, "terminal-owner", { corrected: corrected.status });
  } finally {
    await f.cleanup();
  }
});

test("C06 admission serializes cleanup, new claim and rollback in both orders", options, async () => {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  try {
    const s = await f.seed({ unresolved: true });
    await event(f, s, true);
    await event(f, s, false);
    const writer = await f.pool.connect();
    const cleanupPool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), f.schema), max: 1 });
    try {
      const waiterBackend = (await cleanupPool.query("select pg_backend_pid() as pid")).rows[0].pid;
      for (const rollback of [true, false]) {
        await writer.query("begin");
        await writer.query("select pg_advisory_xact_lock(72202,0)");
        await writer.query(
          "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='controlled quiescence' where id=$1",
          [s.operationId]
        );
        const blocker = (await writer.query("select pg_backend_pid() as id")).rows[0].id;
        const cleanup = reconcileCoordinatedCallCleanup(cleanupPool, s.callId);
        // Server-observed gate barrier, no sleep to select the winner.
        await assertBlocked(f.pool, waiterBackend, blocker);
        await writer.query(rollback ? "rollback" : "commit");
        const result = await cleanup;
        assert.equal(result.uncertain, rollback);
        assert.equal((await f.snapshot()).agent_call_slots[0].state, rollback ? "uncertain" : "free");
      }
    } finally {
      writer.release();
      await cleanupPool.end();
    }
    const next = await f.seed();
    await reconcileCoordinatedCallCleanup(f.pool, s.callId);
    assert.equal((await f.snapshot()).agent_call_slots[0].call_id, next.callId);
    await report(f, "gate-rollback", { newReservation: next.slot });
  } finally {
    await f.cleanup();
  }
});

test("C06 migration 031 upgrades an occupied 030 slot and fences participation ABA", options, async () => {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  try {
    // Reconstruct the exact additive 030 shape before inserting upgrade data.
    await f.pool.query(`drop trigger agent_call_slots_capture_participant on agent_call_slots;
      drop function capture_participant_slot_snapshot();
      drop trigger call_participant_slot_snapshot_guard on call_participants;
      drop function preserve_participant_slot_snapshot();
      alter table call_participants drop column slot_reservation_id cascade,drop column slot_generation cascade;
      delete from schema_migrations where filename='031_participant_slot_cleanup.sql'`);
    const s = await f.seed();
    const oldHistory = (
      await f.pool.query(
        "select * from schema_migrations where filename<'031_participant_slot_cleanup.sql' order by filename"
      )
    ).rows;
    await runMigrations(f.pool);
    const p = (await f.pool.query("select * from call_participants where id=$1", [s.participantId])).rows[0];
    assert.equal(p.slot_reservation_id, s.slot.reservationId);
    assert.equal(p.slot_generation, s.slot.generation);
    const replacement = randomUUID();
    await f.pool.query("insert into call_participants(id,call_id,role,agent_id) values($1,$2,'agent',$3)", [
      replacement,
      s.callId,
      f.agentId
    ]);
    await assert.rejects(
      f.pool.query("update agent_call_slots set participant_id=$2 where agent_id=$1", [
        f.agentId,
        replacement
      ]),
      { code: "23514" }
    );
    await assert.rejects(
      f.pool.query("update call_participants set slot_generation=slot_generation+1 where id=$1", [p.id]),
      { code: "23514" }
    );
    await assert.rejects(
      f.transaction(s.callId, async (a: any) => {
        assert.equal(await releaseAgentCallSlot(a.client, s.slot, true), true);
        await reserveAgentCallSlot(a.client, f.agentId, s.callId, p.id);
      }),
      { code: "23514" }
    );
    assert.equal(
      (await f.snapshot()).agent_call_slots[0].reservation_id,
      s.slot.reservationId,
      "failed ABA restores original reservation"
    );
    await runMigrations(f.pool);
    assert.deepEqual(
      (
        await f.pool.query(
          "select * from schema_migrations where filename<'031_participant_slot_cleanup.sql' order by filename"
        )
      ).rows,
      oldHistory
    );
    await report(f, "upgrade-aba", { snapshot: p, forwardOnly: true });
  } finally {
    await f.cleanup();
  }
});

test("C06 real event adapter routes concrete native events without legacy media sends", options, async () => {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  try {
    const s = await f.seed();
    const frame = {
      body: "",
      headers: {
        "event-name": "CHANNEL_HANGUP_COMPLETE",
        "event-uuid": randomUUID(),
        "unique-id": s.agentUuid,
        variable_outbound_dialer_call_id: s.callId,
        variable_outbound_dialer_leg_type: "customer",
        "hangup-cause": "NORMAL_CLEARING"
      }
    };
    await events.persistFreeSwitchEvent(config, f.pool, frame);
    await events.persistFreeSwitchEvent(config, f.pool, frame);
    const snapshot = await f.snapshot();
    assert.equal(snapshot.calls[0].ended_at, null, "concrete agent UUID overrides forged role label");
    assert.equal(snapshot.call_events.length, 1);
    assert.equal(snapshot.agent_call_slots[0].state, "free");
    assert.equal(snapshot.call_legs.find((l: any) => l.type === "customer").ended_at, null);
  } finally {
    await f.cleanup();
  }
});
