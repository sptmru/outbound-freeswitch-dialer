import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import { runCallRecordingFinalization } from "./call-recording-finalizer.js";
import { createRecording, deleteRecording, setDefaultRecording } from "./dashboard/recordings.js";
import { runMigrations } from "./db.js";

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
});

async function collectNotifications(client: pg.PoolClient, milliseconds = 100): Promise<string[]> {
  const payloads: string[] = [];
  const onNotification = (message: { payload?: string }) => payloads.push(message.payload ?? "");
  client.on("notification", onNotification);
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  client.off("notification", onNotification);
  return payloads;
}
