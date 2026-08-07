import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import pg from "pg";
import type { AppConfig } from "./config.js";
import { finalizeCallTransaction, repairFinalizedCallTransaction } from "./call-finalization.js";
import { runCallRecordingFinalization } from "./call-recording-finalizer.js";
import { endDialerCall } from "./dashboard/calls.js";
import { createRecording, deleteRecording, setDefaultRecording } from "./dashboard/recordings.js";
import { importContactsFromCsv, importSuppressionFromCsv, parseCsv } from "./dashboard/csv.js";
import { getCallHistoryPage, getCallHistoryPageBounds } from "./dashboard/responders.js";
import { runMigrations } from "./db.js";
import { __testing as eslTesting, repairFinalizedCallConsistency } from "./esl-events.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("PostgreSQL migration integration", { skip: !databaseUrl }, () => {
  it("applies every migration transactionally, records checksums, and reruns idempotently", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await runMigrations(pool);
      await runMigrations(pool);

      const migrations = await pool.query<{ checksum_sha256: string; filename: string }>(
        "select filename, checksum_sha256 from schema_migrations order by filename"
      );
      assert.ok(migrations.rowCount && migrations.rowCount >= 14);
      for (const migration of migrations.rows) {
        assert.match(migration.filename, /^\d{3}_.+\.sql$/);
        assert.match(migration.checksum_sha256, /^[a-f0-9]{64}$/);
      }

      const auditTable = await pool.query("select auth_version from users limit 0");
      assert.equal(auditTable.fields[0]?.name, "auth_version");
      assert.equal((await pool.query("select 1 from admin_audit_events limit 0")).command, "SELECT");
      assert.equal(
        (await pool.query("select registered from admin_supervisor_endpoints limit 0")).command,
        "SELECT"
      );
      assert.equal(
        (await pool.query("select mode, state from call_supervisor_sessions limit 0")).command,
        "SELECT"
      );

      const notificationClient = await pool.connect();
      try {
        await notificationClient.query("listen outbound_dialer_changes");

        const noOpNotifications = collectNotifications(notificationClient);
        await pool.query("update agents set updated_at = updated_at where false");
        assert.deepEqual(await noOpNotifications, []);

        const insertNotifications = collectNotifications(notificationClient);
        const notificationCampaign = await pool.query<{ id: string }>(
          "insert into campaigns (name) values ('Live event integration') returning id"
        );
        assert.deepEqual(await insertNotifications, ["campaigns"]);
        await notificationClient.query("unlisten outbound_dialer_changes");
        await pool.query("delete from campaigns where id = $1", [notificationCampaign.rows[0]?.id]);
      } finally {
        notificationClient.release();
      }

      const firstRecording = await createRecording(pool, {
        name: "Integration default one",
        filePath: "/tmp/integration-default-one.wav",
        runtimeFilePath: "/tmp/integration-default-one.wav",
        durationSeconds: 1,
        fileSizeBytes: 44,
        makeDefault: false
      });
      const secondRecording = await createRecording(pool, {
        name: "Integration default two",
        filePath: "/tmp/integration-default-two.wav",
        runtimeFilePath: "/tmp/integration-default-two.wav",
        durationSeconds: 1,
        fileSizeBytes: 44,
        makeDefault: false
      });
      assert.equal(firstRecording.status, "default");
      assert.equal(secondRecording.status, "ready");
      const recordingReferenceCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            recording_id
          )
          values ('+14155550109', '+14155550109', 'bridged', $1)
          returning id
        `,
        [secondRecording.id]
      );
      assert.deepEqual(await deleteRecording(pool, secondRecording.id), { status: "in_use" });
      await pool.query("delete from calls where id = $1", [recordingReferenceCall.rows[0]?.id]);
      assert.equal((await setDefaultRecording(pool, secondRecording.id))?.status, "default");
      assert.deepEqual(await deleteRecording(pool, secondRecording.id), {
        status: "deleted",
        filePath: "/tmp/integration-default-two.wav"
      });
      assert.equal(
        (
          await pool.query<{ is_default: boolean }>("select is_default from recordings where id = $1", [
            firstRecording.id
          ])
        ).rows[0]?.is_default,
        true
      );
      await pool.query("delete from recordings where id = any($1::uuid[])", [
        [firstRecording.id, secondRecording.id]
      ]);

      const call = await pool.query<{ id: string }>(
        `
          insert into calls (destination_number, normalized_destination_number, state, ended_at)
          values ('+14155550100', '+14155550100', 'completed', now())
          returning id
        `
      );
      await assert.rejects(
        pool.query("update calls set state = 'bridged' where id = $1", [call.rows[0]?.id]),
        (error: unknown) =>
          Boolean(error && typeof error === "object" && "code" in error && error.code === "23514")
      );
      await pool.query("delete from calls where id = $1", [call.rows[0]?.id]);

      const recordingCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            ended_at,
            call_recording_enabled,
            call_recording_status,
            call_recording_path
          )
          values (
            '+14155550101',
            '+14155550101',
            'completed',
            now() - interval '10 seconds',
            true,
            'recording',
            '/tmp/integration-call-recording.wav'
          )
          returning id
        `
      );
      const finalized = await runCallRecordingFinalization(pool, "unused", {
        terminalGraceSeconds: 0,
        inspect: async () => ({ durationSeconds: 7, fileSizeBytes: 12_345 })
      });
      assert.equal(finalized.available, 1);
      const recording = await pool.query<{
        call_recording_status: string;
        call_recording_duration_seconds: number;
        call_recording_file_size_bytes: string;
      }>(
        `
          select
            call_recording_status,
            call_recording_duration_seconds,
            call_recording_file_size_bytes
          from calls
          where id = $1
        `,
        [recordingCall.rows[0]?.id]
      );
      assert.deepEqual(recording.rows[0], {
        call_recording_status: "available",
        call_recording_duration_seconds: 7,
        call_recording_file_size_bytes: "12345"
      });
      assert.equal(
        Number(
          (
            await pool.query<{ count: string }>(
              "select count(*) as count from call_events where call_id = $1 and event_type = 'call_recording_finalized'",
              [recordingCall.rows[0]?.id]
            )
          ).rows[0]?.count ?? 0
        ),
        1
      );

      const noMediaCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            ended_at,
            call_recording_enabled,
            call_recording_status
          )
          values (
            '+14155550102',
            '+14155550102',
            'failed',
            now() - interval '10 seconds',
            true,
            'pending'
          )
          returning id
        `
      );
      const noMediaFinalized = await runCallRecordingFinalization(pool, "unused", {
        terminalGraceSeconds: 0,
        inspect: async () => ({ durationSeconds: 1, fileSizeBytes: 1 })
      });
      assert.equal(noMediaFinalized.failed, 1);
      const noMedia = await pool.query<{
        call_recording_failure_reason: string;
        call_recording_status: string;
      }>("select call_recording_status, call_recording_failure_reason from calls where id = $1", [
        noMediaCall.rows[0]?.id
      ]);
      assert.equal(noMedia.rows[0]?.call_recording_status, "failed");
      assert.match(noMedia.rows[0]?.call_recording_failure_reason ?? "", /no media file was started/i);

      await pool.query("delete from calls where id = any($1::uuid[])", [
        [recordingCall.rows[0]?.id, noMediaCall.rows[0]?.id]
      ]);
    } finally {
      await pool.end();
    }
  });

  it("adds online FreeSWITCH idempotency without rewriting historical or derived events", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    let callId: string | null = null;
    try {
      await runMigrations(pool);
      const call = await pool.query<{ id: string }>(
        `
          insert into calls (destination_number, normalized_destination_number, state)
          values ('+14155550119', '+14155550119', 'created')
          returning id
        `
      );
      callId = call.rows[0]?.id ?? null;
      const eventUuid = randomUUID();
      const raw = JSON.stringify({ headers: { "event-uuid": eventUuid } });

      await pool.query("drop index call_events_freeswitch_event_uuid_unique_idx");
      await pool.query("alter table call_events drop column freeswitch_event_uuid");
      await pool.query("delete from schema_migrations where filename = any($1::text[])", [
        ["018_freeswitch_event_idempotency.sql", "019_freeswitch_event_idempotency_index.sql"]
      ]);
      await pool.query(
        `
          insert into call_events (
            call_id,
            event_type,
            state,
            freeswitch_event_name,
            raw_json
          )
          values
            ($1, 'freeswitch_channel_hangup', 'completed', 'CHANNEL_HANGUP', $2::jsonb),
            ($1, 'freeswitch_channel_hangup', 'completed', 'CHANNEL_HANGUP', $2::jsonb),
            ($1, 'voicemail_playback_completed', 'completed', 'CUSTOM', $2::jsonb)
        `,
        [callId, raw]
      );

      await runMigrations(pool);

      const events = await pool.query<{
        event_type: string;
        event_uuid: string | null;
        event_count: string;
      }>(
        `
          select
            event_type,
            freeswitch_event_uuid::text as event_uuid,
            count(*)::text as event_count
          from call_events
          where call_id = $1
          group by event_type, freeswitch_event_uuid
          order by event_type
        `,
        [callId]
      );
      assert.deepEqual(events.rows, [
        {
          event_count: "2",
          event_type: "freeswitch_channel_hangup",
          event_uuid: null
        },
        {
          event_count: "1",
          event_type: "voicemail_playback_completed",
          event_uuid: null
        }
      ]);
      assert.equal(
        (
          await pool.query<{ exists: boolean }>(
            "select to_regclass('call_events_freeswitch_event_uuid_unique_idx') is not null as exists"
          )
        ).rows[0]?.exists,
        true
      );
      await pool.query(
        `insert into call_events (
           call_id, event_type, state, freeswitch_event_name,
           freeswitch_event_uuid, raw_json
         ) values ($1, 'freeswitch_channel_hangup', 'completed', 'CHANNEL_HANGUP', $2, $3::jsonb)`,
        [callId, eventUuid, raw]
      );
      await assert.rejects(
        pool.query(
          `insert into call_events (
             call_id, event_type, state, freeswitch_event_name,
             freeswitch_event_uuid, raw_json
           ) values ($1, 'freeswitch_channel_hangup', 'completed', 'CHANNEL_HANGUP', $2, $3::jsonb)`,
          [callId, eventUuid, raw]
        ),
        (error: unknown) =>
          Boolean(error && typeof error === "object" && "code" in error && error.code === "23505")
      );
    } finally {
      if (callId) await pool.query("delete from calls where id = $1", [callId]);
      await runMigrations(pool);
      await pool.end();
    }
  });

  it("serializes duplicate terminal events and repairs finalized call state", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    let callId: string | null = null;
    let repairCallId: string | null = null;
    let newerCallId: string | null = null;
    let campaignId: string | null = null;
    let agentId: string | null = null;
    let userId: string | null = null;
    try {
      await runMigrations(pool);
      const user = await pool.query<{ id: string }>(
        `
          insert into users (email, name, role, password_hash)
          values ($1, 'Finalization integration agent', 'agent', 'unused')
          returning id
        `,
        [`finalization-${suffix}@example.test`]
      );
      userId = user.rows[0]?.id ?? null;
      const agent = await pool.query<{ id: string }>(
        `
          insert into agents (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name,
            status,
            registered
          )
          values ($1, $2, 'unused', 'unused', 'Finalization integration agent', 'in_call', true)
          returning id
        `,
        [userId, `finalization_${suffix.replaceAll("-", "")}`]
      );
      agentId = agent.rows[0]?.id ?? null;
      const campaign = await pool.query<{ id: string }>(
        "insert into campaigns (name, status) values ($1, 'active') returning id",
        [`Finalization integration ${suffix}`]
      );
      campaignId = campaign.rows[0]?.id ?? null;
      const contact = await pool.query<{ id: string }>(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            status
          )
          values ($1, '+14155550120', '+14155550120', 'Concurrent terminal', 'calling')
          returning id
        `,
        [campaignId]
      );
      const call = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            contact_id,
            destination_number,
            normalized_destination_number,
            state,
            answered_at
          )
          values ($1, $2, $3, '+14155550120', '+14155550120', 'bridged', now())
          returning id
        `,
        [agentId, campaignId, contact.rows[0]?.id]
      );
      callId = call.rows[0]?.id ?? null;
      await pool.query(
        `
          insert into call_legs (call_id, type, state, started_at)
          values ($1, 'agent', 'answered', now()), ($1, 'customer', 'answered', now())
        `,
        [callId]
      );

      const eventUuid = randomUUID();
      const finalize = () =>
        finalizeCallTransaction(pool, {
          callId: callId!,
          event: {
            eventType: "freeswitch_channel_hangup",
            freeswitchEventName: "CHANNEL_HANGUP",
            freeswitchEventUuid: eventUuid,
            raw: { headers: { "event-uuid": eventUuid } },
            state: "completed"
          },
          persistEventWhenAlreadyFinalized: true,
          resolve: () => ({ outcome: "customer_hung_up", state: "completed" }),
          terminal: { eventName: "CHANNEL_HANGUP", source: "freeswitch_customer_terminal" }
        });
      const results = await Promise.all([finalize(), finalize()]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["already_finalized", "finalized"]);

      const finalized = await pool.query<{
        agent_status: string;
        call_outcome: string;
        call_state: string;
        contact_status: string;
        open_legs: string;
        terminal_events: string;
      }>(
        `
          select
            calls.state as call_state,
            calls.outcome as call_outcome,
            agents.status as agent_status,
            contacts.status as contact_status,
            (select count(*) from call_legs where call_id = calls.id and ended_at is null) as open_legs,
            (
              select count(*)
              from call_events
              where call_id = calls.id and freeswitch_event_uuid = $2
            ) as terminal_events
          from calls
          join agents on agents.id = calls.agent_id
          join contacts on contacts.id = calls.contact_id
          where calls.id = $1
        `,
        [callId, eventUuid]
      );
      assert.deepEqual(finalized.rows[0], {
        agent_status: "ready",
        call_outcome: "customer_hung_up",
        call_state: "completed",
        contact_status: "completed",
        open_legs: "0",
        terminal_events: "1"
      });

      const repairContact = await pool.query<{ id: string }>(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            status
          )
          values ($1, '+14155550121', '+14155550121', 'Repair terminal', 'calling')
          returning id
        `,
        [campaignId]
      );
      await pool.query("update agents set status = 'in_call' where id = $1", [agentId]);
      const repairCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            contact_id,
            destination_number,
            normalized_destination_number,
            state,
            outcome,
            ended_at
          )
          values ($1, $2, $3, '+14155550121', '+14155550121', 'failed', 'failed', now())
          returning id
        `,
        [agentId, campaignId, repairContact.rows[0]?.id]
      );
      repairCallId = repairCall.rows[0]?.id ?? null;
      await pool.query(
        "insert into call_legs (call_id, type, state, started_at) values ($1, 'customer', 'started', now())",
        [repairCallId]
      );
      const newerCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            contact_id,
            destination_number,
            normalized_destination_number,
            state,
            started_at
          )
          values ($1, $2, $3, '+14155550121', '+14155550121', 'customer_dialing', now())
          returning id
        `,
        [agentId, campaignId, repairContact.rows[0]?.id]
      );
      newerCallId = newerCall.rows[0]?.id ?? null;

      assert.ok((await repairFinalizedCallConsistency(pool)) >= 1);
      const repaired = await pool.query<{
        agent_status: string;
        contact_status: string;
        leg_state: string;
      }>(
        `
          select
            agents.status as agent_status,
            contacts.status as contact_status,
            call_legs.state as leg_state
          from calls
          join agents on agents.id = calls.agent_id
          join contacts on contacts.id = calls.contact_id
          join call_legs on call_legs.call_id = calls.id
          where calls.id = $1
        `,
        [repairCallId]
      );
      assert.deepEqual(repaired.rows[0], {
        agent_status: "in_call",
        contact_status: "calling",
        leg_state: "ended"
      });
    } finally {
      if (callId || repairCallId || newerCallId) {
        await pool.query("delete from calls where id = any($1::uuid[])", [
          [callId, repairCallId, newerCallId].filter(Boolean)
        ]);
      }
      if (campaignId) await pool.query("delete from campaigns where id = $1", [campaignId]);
      if (agentId) await pool.query("delete from agents where id = $1", [agentId]);
      if (userId) await pool.query("delete from users where id = $1", [userId]);
      await pool.end();
    }
  });

  it("discovers and repairs both directions of terminal call inconsistency", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    let terminalWithoutEndId: string | null = null;
    let endedWithoutTerminalId: string | null = null;
    const preservedEndedAt = new Date("2026-07-17T08:00:00.000Z");
    try {
      await runMigrations(pool);
      const terminalWithoutEnd = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            outcome
          )
          values ('+14155550122', '+14155550122', 'failed', 'failed')
          returning id
        `
      );
      terminalWithoutEndId = terminalWithoutEnd.rows[0]?.id ?? null;
      const endedWithoutTerminal = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            ended_at
          )
          values ('+14155550123', '+14155550123', 'customer_dialing', $1)
          returning id
        `,
        [preservedEndedAt]
      );
      endedWithoutTerminalId = endedWithoutTerminal.rows[0]?.id ?? null;

      assert.ok((await repairFinalizedCallConsistency(pool)) >= 2);

      const repaired = await pool.query<{
        ended_at: Date;
        id: string;
        outcome: string;
        state: string;
        terminal_source: string;
      }>(
        `
          select id, state, outcome, ended_at, terminal_source
          from calls
          where id = any($1::uuid[])
          order by id
        `,
        [[terminalWithoutEndId, endedWithoutTerminalId]]
      );
      const terminalRow = repaired.rows.find((row) => row.id === terminalWithoutEndId);
      const inverseRow = repaired.rows.find((row) => row.id === endedWithoutTerminalId);
      assert.deepEqual(
        {
          outcome: terminalRow?.outcome,
          state: terminalRow?.state,
          terminalSource: terminalRow?.terminal_source
        },
        { outcome: "failed", state: "failed", terminalSource: "consistency_repair" }
      );
      assert.ok(terminalRow?.ended_at instanceof Date);
      assert.deepEqual(
        {
          endedAt: inverseRow?.ended_at.toISOString(),
          outcome: inverseRow?.outcome,
          state: inverseRow?.state,
          terminalSource: inverseRow?.terminal_source
        },
        {
          endedAt: preservedEndedAt.toISOString(),
          outcome: "failed",
          state: "failed",
          terminalSource: "consistency_repair"
        }
      );
    } finally {
      if (terminalWithoutEndId || endedWithoutTerminalId) {
        await pool.query("delete from calls where id = any($1::uuid[])", [
          [terminalWithoutEndId, endedWithoutTerminalId].filter(Boolean)
        ]);
      }
      await pool.end();
    }
  });

  it("refreshes contact ownership after waiting for a concurrent contact reservation", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const suffix = randomUUID();
    let campaignId: string | null = null;
    let contactId: string | null = null;
    let newerAgentId: string | null = null;
    let newerCallId: string | null = null;
    let newerUserId: string | null = null;
    let oldAgentId: string | null = null;
    let oldCallId: string | null = null;
    let oldUserId: string | null = null;
    let holder: pg.PoolClient | null = null;
    let pendingRepair: Promise<boolean> | null = null;
    try {
      await runMigrations(pool);
      const oldUser = await pool.query<{ id: string }>(
        `
          insert into users (email, name, role, password_hash)
          values ($1, 'Old repair owner', 'agent', 'unused')
          returning id
        `,
        [`old-repair-${suffix}@example.test`]
      );
      oldUserId = oldUser.rows[0]?.id ?? null;
      const newerUser = await pool.query<{ id: string }>(
        `
          insert into users (email, name, role, password_hash)
          values ($1, 'New contact owner', 'agent', 'unused')
          returning id
        `,
        [`new-contact-${suffix}@example.test`]
      );
      newerUserId = newerUser.rows[0]?.id ?? null;
      const oldAgent = await pool.query<{ id: string }>(
        `
          insert into agents (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name,
            status,
            registered
          )
          values ($1, $2, 'unused', 'unused', 'Old repair owner', 'in_call', true)
          returning id
        `,
        [oldUserId, `old_repair_${suffix.replaceAll("-", "")}`]
      );
      oldAgentId = oldAgent.rows[0]?.id ?? null;
      const newerAgent = await pool.query<{ id: string }>(
        `
          insert into agents (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name,
            status,
            registered
          )
          values ($1, $2, 'unused', 'unused', 'New contact owner', 'in_call', true)
          returning id
        `,
        [newerUserId, `new_contact_${suffix.replaceAll("-", "")}`]
      );
      newerAgentId = newerAgent.rows[0]?.id ?? null;
      const campaign = await pool.query<{ id: string }>(
        "insert into campaigns (name, status) values ($1, 'active') returning id",
        [`Contact lock integration ${suffix}`]
      );
      campaignId = campaign.rows[0]?.id ?? null;
      const contact = await pool.query<{ id: string }>(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            status
          )
          values ($1, '+14155550127', '+14155550127', 'Contact lock integration', 'calling')
          returning id
        `,
        [campaignId]
      );
      contactId = contact.rows[0]?.id ?? null;
      const oldCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            contact_id,
            destination_number,
            normalized_destination_number,
            state,
            outcome,
            ended_at
          )
          values ($1, $2, $3, '+14155550127', '+14155550127', 'failed', 'failed', now())
          returning id
        `,
        [oldAgentId, campaignId, contactId]
      );
      oldCallId = oldCall.rows[0]?.id ?? null;
      await pool.query(
        "insert into call_legs (call_id, type, state, started_at) values ($1, 'customer', 'started', now())",
        [oldCallId]
      );

      holder = await pool.connect();
      await holder.query("begin");
      await holder.query("select id from agents where id = $1 for update", [newerAgentId]);
      await holder.query("select id from contacts where id = $1 for update", [contactId]);
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      pendingRepair = repairFinalizedCallTransaction(pool, oldCallId!);
      assert.match(
        await waitForQueryBlockedBy(pool, holderPid),
        /select id from contacts where id = \$1 for update/i
      );
      const newerCall = await holder.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            contact_id,
            destination_number,
            normalized_destination_number,
            state,
            started_at
          )
          values ($1, $2, $3, '+14155550127', '+14155550127', 'customer_dialing', now())
          returning id
        `,
        [newerAgentId, campaignId, contactId]
      );
      newerCallId = newerCall.rows[0]?.id ?? null;
      await holder.query("commit");
      holder.release();
      holder = null;
      assert.equal(await pendingRepair, true);
      pendingRepair = null;

      const state = await pool.query<{
        contact_status: string;
        newer_agent_status: string;
        newer_ended_at: Date | null;
        old_agent_status: string;
        old_leg_state: string;
      }>(
        `
          select
            contacts.status as contact_status,
            newer_agent.status as newer_agent_status,
            newer_call.ended_at as newer_ended_at,
            old_agent.status as old_agent_status,
            old_leg.state as old_leg_state
          from calls old_call
          join agents old_agent on old_agent.id = old_call.agent_id
          join contacts on contacts.id = old_call.contact_id
          join call_legs old_leg on old_leg.call_id = old_call.id
          join calls newer_call on newer_call.id = $2
          join agents newer_agent on newer_agent.id = newer_call.agent_id
          where old_call.id = $1
        `,
        [oldCallId, newerCallId]
      );
      assert.deepEqual(state.rows[0], {
        contact_status: "calling",
        newer_agent_status: "in_call",
        newer_ended_at: null,
        old_agent_status: "ready",
        old_leg_state: "ended"
      });
    } finally {
      if (holder) {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
      if (pendingRepair) await pendingRepair.catch(() => undefined);
      if (oldCallId || newerCallId) {
        await pool.query("delete from calls where id = any($1::uuid[])", [
          [oldCallId, newerCallId].filter(Boolean)
        ]);
      }
      if (campaignId) await pool.query("delete from campaigns where id = $1", [campaignId]);
      if (oldAgentId || newerAgentId) {
        await pool.query("delete from agents where id = any($1::uuid[])", [
          [oldAgentId, newerAgentId].filter(Boolean)
        ]);
      }
      if (oldUserId || newerUserId) {
        await pool.query("delete from users where id = any($1::uuid[])", [
          [oldUserId, newerUserId].filter(Boolean)
        ]);
      }
      await pool.end();
    }
  });

  it("replays generic FreeSWITCH events without regressing advanced call or leg state", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    let callId: string | null = null;
    const customerLegUuid = randomUUID();
    const rawEventUuid = randomUUID();
    try {
      await runMigrations(pool);
      const call = await pool.query<{ id: string }>(
        `
          insert into calls (
            destination_number,
            normalized_destination_number,
            state,
            started_at
          )
          values ('+14155550128', '+14155550128', 'agent_answered', now())
          returning id
        `
      );
      callId = call.rows[0]?.id ?? null;
      await pool.query(
        `
          insert into call_legs (call_id, type, freeswitch_uuid, state, started_at)
          values ($1, 'customer', $2, 'started', now())
        `,
        [callId, customerLegUuid]
      );
      await pool.query(
        `
          insert into call_events (
            call_id,
            event_type,
            state,
            freeswitch_event_name,
            freeswitch_event_uuid,
            customer_leg_uuid,
            raw_json
          )
          values ($1, 'freeswitch_channel_create', 'customer_dialing', 'CHANNEL_CREATE', $2, $3, $4::jsonb)
        `,
        [callId, rawEventUuid, customerLegUuid, JSON.stringify({ headers: { "event-uuid": rawEventUuid } })]
      );

      await eslTesting.persistFreeSwitchEvent({ CALL_RECORDINGS_STORAGE_DIR: "/tmp" } as AppConfig, pool, {
        body: "",
        headers: {
          "event-name": "CHANNEL_CREATE",
          "event-uuid": rawEventUuid,
          "unique-id": customerLegUuid,
          variable_outbound_dialer_call_id: callId!,
          variable_outbound_dialer_leg_type: "customer"
        }
      });
      assert.equal(
        (await pool.query<{ state: string }>("select state from calls where id = $1", [callId])).rows[0]
          ?.state,
        "customer_dialing"
      );

      await pool.query(
        `
          update calls
          set state = 'bridged', answered_at = now()
          where id = $1
        `,
        [callId]
      );
      await pool.query(
        `
          update call_legs
          set state = 'ended', ended_at = now()
          where call_id = $1 and type = 'customer'
        `,
        [callId]
      );
      await eslTesting.persistFreeSwitchEvent({ CALL_RECORDINGS_STORAGE_DIR: "/tmp" } as AppConfig, pool, {
        body: "",
        headers: {
          "event-name": "CHANNEL_CREATE",
          "event-uuid": rawEventUuid,
          "unique-id": customerLegUuid,
          variable_outbound_dialer_call_id: callId!,
          variable_outbound_dialer_leg_type: "customer"
        }
      });
      const bridgedReplay = await pool.query<{ call_state: string; leg_state: string }>(
        `
          select calls.state as call_state, call_legs.state as leg_state
          from calls
          join call_legs on call_legs.call_id = calls.id and call_legs.type = 'customer'
          where calls.id = $1
        `,
        [callId]
      );
      assert.deepEqual(bridgedReplay.rows[0], { call_state: "bridged", leg_state: "ended" });

      await pool.query("update calls set state = 'voicemail_signal_detected' where id = $1", [callId]);
      await pool.query(
        `
          insert into call_events (
            call_id,
            event_type,
            state,
            api_command_name,
            customer_leg_uuid,
            raw_json
          )
          values ($1, 'voicemail_detection_started', 'bridged', 'voicemail detection start', $2, $3::jsonb)
        `,
        [
          callId,
          customerLegUuid,
          JSON.stringify({
            phase: "answered",
            modules: { mod_amd: { status: "started" }, mod_avmd: { status: "started" } }
          })
        ]
      );
      for (const eventName of ["CHANNEL_ANSWER", "CHANNEL_BRIDGE"]) {
        const eventUuid = randomUUID();
        await pool.query(
          `
            insert into call_events (
              call_id,
              event_type,
              state,
              freeswitch_event_name,
              freeswitch_event_uuid,
              customer_leg_uuid,
              raw_json
            )
            values ($1, $2, 'bridged', $3, $4, $5, $6::jsonb)
          `,
          [
            callId,
            `freeswitch_${eventName.toLowerCase()}`,
            eventName,
            eventUuid,
            customerLegUuid,
            JSON.stringify({ headers: { "event-uuid": eventUuid } })
          ]
        );
        await eslTesting.persistFreeSwitchEvent({ CALL_RECORDINGS_STORAGE_DIR: "/tmp" } as AppConfig, pool, {
          body: "",
          headers: {
            "event-name": eventName,
            "event-uuid": eventUuid,
            "unique-id": customerLegUuid,
            variable_outbound_dialer_call_id: callId!,
            variable_outbound_dialer_leg_type: "customer"
          }
        });
      }

      const signalReplay = await pool.query<{
        call_state: string;
        leg_state: string;
        raw_events: string;
      }>(
        `
          select
            calls.state as call_state,
            call_legs.state as leg_state,
            (
              select count(*)
              from call_events
              where call_id = calls.id and freeswitch_event_uuid is not null
            ) as raw_events
          from calls
          join call_legs on call_legs.call_id = calls.id and call_legs.type = 'customer'
          where calls.id = $1
        `,
        [callId]
      );
      assert.deepEqual(signalReplay.rows[0], {
        call_state: "voicemail_signal_detected",
        leg_state: "ended",
        raw_events: "3"
      });
    } finally {
      if (callId) await pool.query("delete from calls where id = $1", [callId]);
      await pool.end();
    }
  });

  it("locks the agent before call rows while a next-call transaction is in flight", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const suffix = randomUUID();
    let agentId: string | null = null;
    let campaignId: string | null = null;
    let endCallId: string | null = null;
    let releaseCallId: string | null = null;
    let userId: string | null = null;
    let voicemailCallId: string | null = null;
    let holder: pg.PoolClient | null = null;
    let pendingTerminal: Promise<unknown> | null = null;
    try {
      await runMigrations(pool);
      const user = await pool.query<{ id: string }>(
        `
          insert into users (email, name, role, password_hash)
          values ($1, 'Lock order integration agent', 'agent', 'unused')
          returning id
        `,
        [`lock-order-${suffix}@example.test`]
      );
      userId = user.rows[0]?.id ?? null;
      const agent = await pool.query<{ id: string }>(
        `
          insert into agents (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name,
            status,
            registered
          )
          values ($1, $2, 'unused', 'unused', 'Lock order integration agent', 'in_call', true)
          returning id
        `,
        [userId, `lock_order_${suffix.replaceAll("-", "")}`]
      );
      agentId = agent.rows[0]?.id ?? null;
      const campaign = await pool.query<{ id: string }>(
        "insert into campaigns (name, status) values ($1, 'active') returning id",
        [`Lock order integration ${suffix}`]
      );
      campaignId = campaign.rows[0]?.id ?? null;
      const endCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            destination_number,
            normalized_destination_number,
            state,
            answered_at,
            started_at
          )
          values ($1, $2, '+14155550124', '+14155550124', 'bridged', now(), now())
          returning id
        `,
        [agentId, campaignId]
      );
      endCallId = endCall.rows[0]?.id ?? null;
      await pool.query(
        "insert into call_legs (call_id, type, state, started_at) values ($1, 'customer', 'answered', now())",
        [endCallId]
      );

      holder = await pool.connect();
      await holder.query("begin");
      await holder.query("select id from agents where id = $1 for update", [agentId]);
      const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      pendingTerminal = endDialerCall(
        pool,
        { FREESWITCH_ESL_ENABLED: false } as AppConfig,
        userId!,
        endCallId!,
        {
          actorUserId: userId!,
          actorName: "Lock order integration agent",
          actorRole: "agent",
          requestId: "lock-order-integration",
          receivedAt: new Date().toISOString(),
          sourceIp: null,
          authTransport: "unknown",
          userAgent: null,
          origin: null,
          referrer: null,
          secFetchSite: null,
          secFetchMode: null,
          secFetchDest: null,
          selectedCampaignId: campaignId,
          clientContext: null
        }
      );
      assert.match(
        await waitForQueryBlockedBy(pool, holderPid),
        /select id from agents where id = \$1 for update/i
      );
      const activeCall = await holder.query<{ id: string }>(
        `
          select id
          from calls
          where agent_id = $1
            and ended_at is null
            and state not in ('completed', 'failed', 'canceled', 'agent_released')
          limit 1
          for update
        `,
        [agentId]
      );
      assert.equal(activeCall.rows[0]?.id, endCallId);
      await holder.query("commit");
      holder.release();
      holder = null;
      assert.equal(await pendingTerminal, true);
      pendingTerminal = null;

      const ended = await pool.query<{ open_legs: string; state: string }>(
        `
          select
            calls.state,
            (select count(*) from call_legs where call_id = calls.id and ended_at is null) as open_legs
          from calls
          where calls.id = $1
        `,
        [endCallId]
      );
      assert.deepEqual(ended.rows[0], { open_legs: "0", state: "completed" });

      const voicemailCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            destination_number,
            normalized_destination_number,
            state,
            started_at
          )
          values ($1, $2, '+14155550125', '+14155550125', 'voicemail_playback_started', now())
          returning id
        `,
        [agentId, campaignId]
      );
      voicemailCallId = voicemailCall.rows[0]?.id ?? null;
      await pool.query("update agents set status = 'in_call' where id = $1", [agentId]);

      holder = await pool.connect();
      await holder.query("begin");
      await holder.query("select id from agents where id = $1 for update", [agentId]);
      const voicemailHolderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid;
      pendingTerminal = eslTesting.finalizeCompletedVoicemailPlayback(
        {} as AppConfig,
        pool,
        voicemailCallId!,
        null,
        {}
      );
      assert.match(
        await waitForQueryBlockedBy(pool, voicemailHolderPid),
        /select id from agents where id = \$1 for update/i
      );
      const activeDuringPlayback = await holder.query<{ id: string }>(
        `
          select id
          from calls
          where agent_id = $1
            and ended_at is null
            and state not in ('completed', 'failed', 'canceled', 'agent_released')
          limit 1
          for update
        `,
        [agentId]
      );
      assert.equal(activeDuringPlayback.rows[0]?.id, voicemailCallId);
      await holder.query("rollback");
      holder.release();
      holder = null;
      await pendingTerminal;
      pendingTerminal = null;

      const finalState = await pool.query<{
        agent_status: string;
        voicemail_outcome: string;
        voicemail_state: string;
      }>(
        `
          select
            agents.status as agent_status,
            voicemail_call.state as voicemail_state,
            voicemail_call.outcome as voicemail_outcome
          from calls voicemail_call
          join agents on agents.id = voicemail_call.agent_id
          where voicemail_call.id = $1
        `,
        [voicemailCallId]
      );
      assert.deepEqual(finalState.rows[0], {
        agent_status: "ready",
        voicemail_outcome: "voicemail_dropped",
        voicemail_state: "completed"
      });

      const releaseCall = await pool.query<{ id: string }>(
        `
          insert into calls (
            agent_id,
            campaign_id,
            destination_number,
            normalized_destination_number,
            state,
            started_at
          )
          values ($1, $2, '+14155550129', '+14155550129', 'voicemail_playback_started', now())
          returning id
        `,
        [agentId, campaignId]
      );
      releaseCallId = releaseCall.rows[0]?.id ?? null;
      const releaseAgentLegUuid = randomUUID();
      await pool.query(
        `
          insert into call_legs (call_id, type, freeswitch_uuid, state, started_at, answered_at)
          values ($1, 'agent', $2, 'answered', now(), now())
        `,
        [releaseCallId, releaseAgentLegUuid]
      );
      await pool.query("update agents set status = 'in_call' where id = $1", [agentId]);

      holder = await pool.connect();
      await holder.query("begin");
      await holder.query("select id from agents where id = $1 for update", [agentId]);
      const releaseHolderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid;
      pendingTerminal = eslTesting.releaseAgentAfterVoicemailPlaybackStarts(
        {} as AppConfig,
        pool,
        {
          agentId,
          agentLegUuid: releaseAgentLegUuid,
          callId: releaseCallId!,
          customerLegUuid: null
        },
        async () => ({ body: "+OK", headers: {}, raw: "" })
      );
      assert.match(
        await waitForQueryBlockedBy(pool, releaseHolderPid),
        /select id from agents where id = \$1 for update/i
      );
      const activeDuringRelease = await holder.query<{ id: string }>(
        `
          select id
          from calls
          where agent_id = $1
            and ended_at is null
            and state not in ('completed', 'failed', 'canceled', 'agent_released')
          limit 1
          for update
        `,
        [agentId]
      );
      assert.equal(activeDuringRelease.rows[0]?.id, releaseCallId);
      await holder.query("rollback");
      holder.release();
      holder = null;
      await pendingTerminal;
      pendingTerminal = null;

      const released = await pool.query<{
        agent_status: string;
        call_state: string;
        leg_state: string;
      }>(
        `
          select
            agents.status as agent_status,
            calls.state as call_state,
            call_legs.state as leg_state
          from calls
          join agents on agents.id = calls.agent_id
          join call_legs on call_legs.call_id = calls.id and call_legs.type = 'agent'
          where calls.id = $1
        `,
        [releaseCallId]
      );
      assert.deepEqual(released.rows[0], {
        agent_status: "ready",
        call_state: "agent_released",
        leg_state: "ended"
      });
    } finally {
      if (holder) {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
      if (pendingTerminal) await pendingTerminal.catch(() => undefined);
      if (endCallId || voicemailCallId || releaseCallId) {
        await pool.query("delete from calls where id = any($1::uuid[])", [
          [endCallId, voicemailCallId, releaseCallId].filter(Boolean)
        ]);
      }
      if (campaignId) await pool.query("delete from campaigns where id = $1", [campaignId]);
      if (agentId) await pool.query("delete from agents where id = $1", [agentId]);
      if (userId) await pool.query("delete from users where id = $1", [userId]);
      await pool.end();
    }
  });

  it("executes chunked CSV conflict and suppression audit semantics in PostgreSQL", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const phoneSeed = 1_000 + (Number.parseInt(suffix.replaceAll("-", "").slice(0, 6), 16) % 8_000);
    const phone = (offset: number) =>
      `+1415555${String(phoneSeed + offset)
        .slice(-4)
        .padStart(4, "0")}`;
    let userId: string | null = null;
    let campaignId: string | null = null;
    const suppressionNumbers = [phone(3), phone(4), phone(5), phone(6), phone(7)];
    try {
      await runMigrations(pool);
      const user = await pool.query<{ id: string }>(
        `insert into users (email, name, role, password_hash)
         values ($1, 'CSV integration admin', 'admin', 'unused')
         returning id`,
        [`csv-${suffix}@example.test`]
      );
      userId = user.rows[0]?.id ?? null;
      const campaign = await pool.query<{ id: string }>(
        "insert into campaigns (name, status) values ($1, 'active') returning id",
        [`CSV integration ${suffix}`]
      );
      campaignId = campaign.rows[0]?.id ?? null;
      await pool.query(
        `insert into contacts (
           campaign_id, phone_number, normalized_phone_number, display_name, status
         ) values ($1, $2, $2, 'Existing contact', 'new')`,
        [campaignId, phone(2)]
      );

      const contactImport = await importContactsFromCsv(
        pool,
        campaignId!,
        "contacts-integration.csv",
        parseCsv(
          [
            "name,phone,arbitrary CRM field",
            `New contact,${phone(1)},preserved`,
            `Duplicate in file,${phone(1)},duplicate`,
            `Existing contact,${phone(2)},existing`,
            "Invalid phone,not-a-number,invalid"
          ].join("\n")
        ),
        "US"
      );
      assert.deepEqual(
        {
          importedRows: contactImport.importedRows,
          duplicateRows: contactImport.duplicateRows,
          failedRows: contactImport.failedRows
        },
        { importedRows: 1, duplicateRows: 2, failedRows: 3 }
      );
      const importedContact = await pool.query<{ mapped_fields_json: Record<string, string> }>(
        `select mapped_fields_json
         from contacts
         where campaign_id = $1 and normalized_phone_number = $2`,
        [campaignId, phone(1)]
      );
      assert.equal(importedContact.rows[0]?.mapped_fields_json["arbitrary CRM field"], "preserved");
      const contactFailures = await pool.query<{ reason: string; row_number: number }>(
        `select row_number, reason
         from csv_import_failures
         where import_id = $1
         order by row_number`,
        [contactImport.importId]
      );
      assert.deepEqual(
        contactFailures.rows.map((row) => row.row_number),
        [3, 4, 5]
      );

      await pool.query(
        `insert into suppression_entries (
           phone_number, normalized_phone_number, reason, created_by_user_id
         ) values ($1, $1, 'before import', $2)`,
        [phone(4), userId]
      );
      const suppressionImport = await importSuppressionFromCsv(pool, {
        actorUserId: userId!,
        filename: "suppression-integration.csv",
        parsed: parseCsv(
          [
            "phone,reason,arbitrary source field",
            `${phone(3)},first,one`,
            `${phone(3)},last,two`,
            `${phone(4)},existing,three`
          ].join("\n")
        ),
        defaultCountryCode: "US"
      });
      assert.deepEqual(
        {
          importedRows: suppressionImport.importedRows,
          updatedRows: suppressionImport.updatedRows,
          failedRows: suppressionImport.failedRows
        },
        { importedRows: 1, updatedRows: 2, failedRows: 0 }
      );
      const suppressionRows = await pool.query<{ normalized_phone_number: string; reason: string }>(
        `select normalized_phone_number, reason
         from suppression_entries
         where normalized_phone_number = any($1::text[])
         order by normalized_phone_number`,
        [[phone(3), phone(4)]]
      );
      assert.deepEqual(
        suppressionRows.rows.map((row) => row.reason),
        ["last", "existing"]
      );
      const suppressionEvents = await pool.query<{ row_number: number }>(
        `select (metadata_json->>'rowNumber')::integer as row_number
         from suppression_events
         where normalized_phone_number = any($1::text[])
           and metadata_json->>'filename' = 'suppression-integration.csv'
         order by row_number`,
        [[phone(3), phone(4)]]
      );
      assert.deepEqual(
        suppressionEvents.rows.map((row) => row.row_number),
        [2, 3, 4]
      );

      const concurrentImports = await Promise.all([
        importSuppressionFromCsv(pool, {
          actorUserId: userId!,
          filename: "suppression-concurrent-a.csv",
          parsed: parseCsv(`phone,reason\n${phone(5)},a-first\n${phone(6)},a-second`),
          defaultCountryCode: "US"
        }),
        importSuppressionFromCsv(pool, {
          actorUserId: userId!,
          filename: "suppression-concurrent-b.csv",
          parsed: parseCsv(`phone,reason\n${phone(6)},b-first\n${phone(5)},b-second`),
          defaultCountryCode: "US"
        })
      ]);
      assert.equal(
        concurrentImports.reduce((sum, result) => sum + result.importedRows, 0),
        2
      );

      await assert.rejects(
        importSuppressionFromCsv(pool, {
          actorUserId: randomUUID(),
          filename: "suppression-rollback.csv",
          parsed: parseCsv(`phone,reason\n${phone(7)},must rollback`),
          defaultCountryCode: "US"
        })
      );
      assert.equal(
        Number(
          (
            await pool.query<{ count: string }>(
              "select count(*) as count from suppression_entries where normalized_phone_number = $1",
              [phone(7)]
            )
          ).rows[0]?.count ?? 0
        ),
        0
      );
    } finally {
      await pool.query("delete from suppression_events where normalized_phone_number = any($1::text[])", [
        suppressionNumbers
      ]);
      await pool.query("delete from suppression_entries where normalized_phone_number = any($1::text[])", [
        suppressionNumbers
      ]);
      if (campaignId) await pool.query("delete from campaigns where id = $1", [campaignId]);
      if (userId) await pool.query("delete from users where id = $1", [userId]);
      await pool.end();
    }
  });

  it("paginates an export across microsecond timestamps without a live cursor row", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const suffix = randomUUID();
    let campaignId: string | null = null;
    try {
      await runMigrations(pool);
      const campaign = await pool.query<{ id: string }>(
        "insert into campaigns (name, status) values ($1, 'active') returning id",
        [`Export integration ${suffix}`]
      );
      campaignId = campaign.rows[0]?.id ?? null;
      await pool.query(
        `insert into calls (
           campaign_id, destination_number, normalized_destination_number,
           state, outcome, created_at, ended_at
         )
         select $1, '+14155550999', '+14155550999', 'completed', 'answered',
                timestamptz '2026-07-17 12:00:00+00' + series * interval '1 microsecond',
                timestamptz '2026-07-17 12:00:01+00'
         from generate_series(0, 1000) as series`,
        [campaignId]
      );

      const first = await getCallHistoryPage(pool, { page: 1, pageSize: 1_000, campaignId: campaignId! });
      const bounds = getCallHistoryPageBounds(first);
      assert.equal(first.total, 1_001);
      assert.equal(first.items.length, 1_000);
      assert.match(bounds.last?.createdAt ?? "", /\.\d{6}Z$/);
      await pool.query("delete from calls where id = $1", [bounds.last?.id]);

      const second = await getCallHistoryPage(pool, {
        page: 1,
        pageSize: 1_000,
        campaignId: campaignId!,
        snapshot: bounds.first ?? undefined,
        cursor: bounds.last ?? undefined,
        includeTotal: false
      });
      assert.equal(second.items.length, 1);
      assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 1_001);
    } finally {
      if (campaignId) {
        await pool.query("delete from calls where campaign_id = $1", [campaignId]);
        await pool.query("delete from campaigns where id = $1", [campaignId]);
      }
      await pool.end();
    }
  });
});

async function waitForQueryBlockedBy(pool: pg.Pool, blockerPid: number, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{ query: string }>(
      `
        select query
        from pg_stat_activity
        where $1::integer = any(pg_blocking_pids(pid))
        order by query_start asc
        limit 1
      `,
      [blockerPid]
    );
    if (blocked.rows[0]?.query) {
      return blocked.rows[0].query;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a query blocked by PostgreSQL backend ${blockerPid}`);
}

async function collectNotifications(client: pg.PoolClient, milliseconds = 100): Promise<string[]> {
  const payloads: string[] = [];
  const onNotification = (message: { payload?: string }) => payloads.push(message.payload ?? "");
  client.on("notification", onNotification);
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  client.off("notification", onNotification);
  return payloads;
}
