import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { createCallCoordinationRuntime } from "./call-coordination-runtime.js";
import type { AppConfig } from "./config.js";
import { checkCutoverDatabase, finishCallCoordinationCutover } from "./coordination-cutover.js";
import { deskCoordinationSchema } from "./call-coordination-contracts.js";
import { readDeskCoordination } from "./dashboard/desk-coordination.js";

const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};

test(
  "I05 cutover refuses unresolved ownership and changes the marker only after drain",
  options,
  async () => {
    const fixture = await cleanupFixture(databaseConfig(testDatabaseUrl()));
    const { pool } = fixture;
    try {
      await assert.rejects(checkCutoverDatabase(pool), /call starts are open/);
      await pool.query("insert into system_settings(key,value_json) values('ops.call_start_paused','true')");
      await pool.query("update call_admission_migration set reconciliation_required=true,reconciled_at=null");
      const {
        rows: [legacy]
      } = await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'I05 legacy','agent','fixture') returning id",
        [`${randomUUID()}@example.test`]
      );
      const {
        rows: [agent]
      } = await pool.query(
        `insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name)
      values($1,$2,'fixture','fixture','I05 legacy') returning id`,
        [legacy.id, randomUUID()]
      );
      assert.equal(
        (await pool.query("select state from agent_call_slots where agent_id=$1", [agent.id])).rows[0].state,
        "uncertain"
      );
      assert.equal(
        await createCallCoordinationRuntime(pool, { CALL_COORDINATION_ENABLED: false } as AppConfig),
        null
      );
      await assert.rejects(
        createCallCoordinationRuntime(pool, { CALL_COORDINATION_ENABLED: true } as AppConfig),
        /cutover marker disagree/
      );
      const {
        rows: [call]
      } = await pool.query(
        `insert into calls(campaign_id,destination_number,normalized_destination_number)
      values($1,'+12025550100','+12025550100') returning id`,
        [fixture.campaignId]
      );
      await assert.rejects(finishCallCoordinationCutover(pool, true), /calls remain open/);
      assert.equal(
        (await pool.query("select reconciliation_required from call_admission_migration")).rows[0]
          .reconciliation_required,
        true
      );
      await pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
        call.id
      ]);
      await finishCallCoordinationCutover(pool, true);
      const {
        rows: [after]
      } = await pool.query(
        "select state,call_id,reservation_id,reconciliation_required from agent_call_slots where agent_id=$1",
        [agent.id]
      );
      assert.deepEqual(after, {
        state: "free",
        call_id: null,
        reservation_id: null,
        reconciliation_required: false
      });
      await assert.rejects(
        createCallCoordinationRuntime(pool, { CALL_COORDINATION_ENABLED: false } as AppConfig),
        /cutover marker disagree/
      );
      const desk = deskCoordinationSchema.parse(
        await readDeskCoordination(pool, legacy.id, fixture.campaignId)
      );
      assert.equal(desk.session, null);
      assert.equal(desk.actions.manualStart.allowed, false);
      await finishCallCoordinationCutover(pool, false);
      assert.equal(
        await createCallCoordinationRuntime(pool, { CALL_COORDINATION_ENABLED: false } as AppConfig),
        null
      );
      assert.equal(
        (await pool.query("select state from calls where id=$1", [call.id])).rows[0].state,
        "completed"
      );
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  "I05 Desk projection preserves concrete ownership and suppresses new work during drain",
  options,
  async () => {
    const fixture = await cleanupFixture(databaseConfig(testDatabaseUrl()));
    const { pool, userId, campaignId, agentId } = fixture;
    const sessionId = fixture.input.deskSessionId;
    try {
      await pool.query("update agent_desk_sessions set actor_auth_version=1 where id=$1", [sessionId]);
      const idle = deskCoordinationSchema.parse(await readDeskCoordination(pool, userId, campaignId));
      assert.equal(idle.session?.id, sessionId);
      assert.equal(idle.actions.manualStart.allowed, true);
      const call = await fixture.seed();
      await pool.query("update agent_call_slots set state='active' where agent_id=$1", [agentId]);
      const active = deskCoordinationSchema.parse(await readDeskCoordination(pool, userId, campaignId));
      assert.equal(active.slot.callId, call.callId);
      assert.equal(active.slot.reservationId, call.slot.reservationId);
      assert.equal(active.actions.manualStart.allowed, false);
      assert.equal(active.actions.transfer.allowed, true);
      await pool.query(
        "insert into system_settings(key,value_json) values('ops.call_start_paused','true') on conflict(key) do update set value_json='true'"
      );
      const paused = deskCoordinationSchema.parse(await readDeskCoordination(pool, userId, campaignId));
      assert.equal(paused.slot.callId, call.callId);
      assert.equal(paused.actions.transfer.allowed, false);
      await assert.rejects(finishCallCoordinationCutover(pool, false), /calls remain open/);
    } finally {
      await fixture.cleanup();
    }
  }
);
