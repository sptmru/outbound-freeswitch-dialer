import { unlink } from "node:fs/promises";
import type pg from "pg";
import type { RetentionRunResponse } from "@outbound-dialer/shared";

export async function runRetention(
  pool: pg.Pool,
  input: { dryRun: boolean; callRetentionDays: number; recordingRetentionDays: number },
  options: RetentionOptions = {}
): Promise<RetentionRunResponse> {
  const recordings = await pool.query<{ id: string; call_recording_path: string }>(
    `
      select id, call_recording_path
      from calls
      where call_recording_path is not null
        and coalesce(ended_at, created_at) < now() - ($1::text || ' days')::interval
        and state in ('completed', 'failed', 'canceled')
    `,
    [input.recordingRetentionDays]
  );
  if (input.dryRun) {
    const calls = await pool.query<{ count: string }>(
      `
        select count(*) as count
        from calls
        where coalesce(ended_at, created_at) < now() - ($1::text || ' days')::interval
          and state in ('completed', 'failed', 'canceled')
          and (
            call_recording_path is null
            or coalesce(ended_at, created_at) < now() - ($2::text || ' days')::interval
          )
      `,
      [input.callRetentionDays, input.recordingRetentionDays]
    );
    return {
      dryRun: true,
      callRetentionDays: input.callRetentionDays,
      recordingRetentionDays: input.recordingRetentionDays,
      calls: Number(calls.rows[0]?.count ?? 0),
      recordingFiles: recordings.rowCount ?? recordings.rows.length
    };
  }

  const unlinkFile = options.unlinkFile ?? unlink;
  const unlinkedRecordingIds: string[] = [];
  for (const recording of recordings.rows) {
    try {
      await unlinkFile(recording.call_recording_path);
      unlinkedRecordingIds.push(recording.id);
    } catch (error) {
      if (isMissingFileError(error)) {
        // The desired retained state is already true. Clear stale metadata so
        // the call row can continue through normal retention.
        unlinkedRecordingIds.push(recording.id);
      } else {
        options.onUnlinkError?.(error, recording);
      }
    }
  }

  let deletedCalls = 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (unlinkedRecordingIds.length) {
      await client.query(
        `
          update calls
          set call_recording_path = null,
              call_recording_status = 'expired',
              call_recording_failure_reason = null,
              updated_at = now()
          where id = any($1::uuid[])
            and call_recording_path is not null
            and state in ('completed', 'failed', 'canceled')
        `,
        [unlinkedRecordingIds]
      );
    }
    const deleted = await client.query(
      `
        delete from calls
        where coalesce(ended_at, created_at) < now() - ($1::text || ' days')::interval
          and state in ('completed', 'failed', 'canceled')
          and call_recording_path is null
      `,
      [input.callRetentionDays]
    );
    deletedCalls = deleted.rowCount ?? 0;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return {
    dryRun: false,
    callRetentionDays: input.callRetentionDays,
    recordingRetentionDays: input.recordingRetentionDays,
    calls: deletedCalls,
    recordingFiles: unlinkedRecordingIds.length
  };
}

export type RetentionOptions = {
  unlinkFile?: (path: string) => Promise<void>;
  onUnlinkError?: (error: unknown, recording: { id: string; call_recording_path: string }) => void;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
