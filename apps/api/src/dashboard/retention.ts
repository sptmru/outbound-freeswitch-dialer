import { unlink } from "node:fs/promises";
import type pg from "pg";
import type { RetentionRunResponse } from "@outbound-dialer/shared";

export async function runRetention(
  pool: pg.Pool,
  input: {
    dryRun: boolean;
    callRetentionDays: number;
    recordingRetentionDays: number;
    pcapRetentionDays: number;
  },
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
  const pcaps = await pool.query<{ call_id: string; file_path: string }>(
    `
      select call_id, file_path
      from call_pcaps
      join calls on calls.id = call_pcaps.call_id
      where call_pcaps.file_path is not null
        and coalesce(calls.ended_at, calls.created_at) < now() - ($1::text || ' days')::interval
        and calls.state in ('completed', 'failed', 'canceled')
    `,
    [input.pcapRetentionDays]
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
          and not exists (
            select 1 from call_pcaps
            where call_pcaps.call_id = calls.id
              and call_pcaps.file_path is not null
              and coalesce(calls.ended_at, calls.created_at) >= now() - ($3::text || ' days')::interval
          )
      `,
      [input.callRetentionDays, input.recordingRetentionDays, input.pcapRetentionDays]
    );
    return {
      dryRun: true,
      callRetentionDays: input.callRetentionDays,
      recordingRetentionDays: input.recordingRetentionDays,
      pcapRetentionDays: input.pcapRetentionDays,
      calls: Number(calls.rows[0]?.count ?? 0),
      recordingFiles: recordings.rowCount ?? recordings.rows.length,
      pcapFiles: pcaps.rowCount ?? pcaps.rows.length
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
  const unlinkedPcapCallIds: string[] = [];
  for (const capture of pcaps.rows) {
    try {
      await unlinkFile(capture.file_path);
      unlinkedPcapCallIds.push(capture.call_id);
    } catch (error) {
      if (isMissingFileError(error)) {
        unlinkedPcapCallIds.push(capture.call_id);
      } else {
        options.onPcapUnlinkError?.(error, capture);
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
    if (unlinkedPcapCallIds.length) {
      await client.query(
        `
          update call_pcaps
          set file_path = null,
              file_size_bytes = null,
              status = 'expired',
              failure_reason = null,
              updated_at = now()
          where call_id = any($1::uuid[])
            and file_path is not null
            and status in ('available', 'failed')
        `,
        [unlinkedPcapCallIds]
      );
    }
    const deleted = await client.query(
      `
        delete from calls
        where coalesce(ended_at, created_at) < now() - ($1::text || ' days')::interval
          and state in ('completed', 'failed', 'canceled')
          and call_recording_path is null
          and not exists (
            select 1 from call_pcaps
            where call_pcaps.call_id = calls.id
              and call_pcaps.file_path is not null
          )
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
    pcapRetentionDays: input.pcapRetentionDays,
    calls: deletedCalls,
    recordingFiles: unlinkedRecordingIds.length,
    pcapFiles: unlinkedPcapCallIds.length
  };
}

export type RetentionOptions = {
  unlinkFile?: (path: string) => Promise<void>;
  onUnlinkError?: (error: unknown, recording: { id: string; call_recording_path: string }) => void;
  onPcapUnlinkError?: (error: unknown, capture: { call_id: string; file_path: string }) => void;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
