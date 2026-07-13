import { stat } from "node:fs/promises";
import type pg from "pg";
import { probeRecording } from "./dashboard/recordings.js";

const terminalGraceSeconds = 5;
const staleClaimSeconds = 5 * 60;
const defaultBatchSize = 10;
const defaultIntervalMs = 30_000;

type ClaimedRecording = {
  id: string;
  call_recording_path: string;
  claim_token: string;
};

export type RecordingInspection = {
  durationSeconds: number;
  fileSizeBytes: number;
};

export type CallRecordingFinalizationResult = {
  claimed: number;
  available: number;
  failed: number;
  skipped: number;
};

export type CallRecordingFinalizerLogger = {
  info: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
};

export async function inspectCallRecording(
  filePath: string,
  ffprobePath: string
): Promise<RecordingInspection> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size <= 0) {
    throw new Error("Call recording is missing or empty");
  }

  const probe = await probeRecording(filePath, ffprobePath);
  return {
    durationSeconds: Math.max(1, Math.round(probe.durationSeconds)),
    fileSizeBytes: file.size
  };
}

export async function runCallRecordingFinalization(
  pool: pg.Pool,
  ffprobePath: string,
  options: {
    inspect?: typeof inspectCallRecording;
    batchSize?: number;
    terminalGraceSeconds?: number;
    staleClaimSeconds?: number;
  } = {}
): Promise<CallRecordingFinalizationResult> {
  const graceSeconds = options.terminalGraceSeconds ?? terminalGraceSeconds;
  const batchSize = options.batchSize ?? defaultBatchSize;
  const failedWithoutPath = await markTerminalRecordingsWithoutPath(pool, graceSeconds, batchSize);
  const claimed = await claimTerminalRecordings(pool, {
    batchSize,
    terminalGraceSeconds: graceSeconds,
    staleClaimSeconds: options.staleClaimSeconds ?? staleClaimSeconds
  });
  const result: CallRecordingFinalizationResult = {
    claimed: failedWithoutPath + claimed.length,
    available: 0,
    failed: failedWithoutPath,
    skipped: 0
  };
  const inspect = options.inspect ?? inspectCallRecording;

  for (const recording of claimed) {
    try {
      const inspection = await inspect(recording.call_recording_path, ffprobePath);
      if (await markRecordingAvailable(pool, recording, inspection)) {
        result.available += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      const reason = describeFailure(error);
      if (await markRecordingFailed(pool, recording, reason)) {
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
    }
  }

  return result;
}

export function startCallRecordingFinalizer(
  pool: pg.Pool,
  ffprobePath: string,
  logger: CallRecordingFinalizerLogger,
  options: { intervalMs?: number } = {}
): { runNow: () => Promise<"completed" | "overlap" | "stopped" | "error">; stop: () => void } {
  let stopped = false;
  let running = false;

  const runNow = async (): Promise<"completed" | "overlap" | "stopped" | "error"> => {
    if (stopped) {
      return "stopped";
    }
    if (running) {
      return "overlap";
    }

    running = true;
    try {
      const result = await runCallRecordingFinalization(pool, ffprobePath);
      if (result.claimed > 0) {
        logger.info(result, "Call recording finalization run completed");
      }
      return "completed";
    } catch (error) {
      logger.error({ error }, "Call recording finalization run failed");
      return "error";
    } finally {
      running = false;
    }
  };

  void runNow();
  const interval = setInterval(() => void runNow(), options.intervalMs ?? defaultIntervalMs);
  interval.unref();

  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    }
  };
}

async function claimTerminalRecordings(
  pool: pg.Pool,
  input: { batchSize: number; terminalGraceSeconds: number; staleClaimSeconds: number }
): Promise<ClaimedRecording[]> {
  const result = await pool.query<ClaimedRecording>(
    `
      with candidates as (
        select id
        from calls
        where ended_at is not null
          and state in ('completed', 'failed', 'canceled')
          and call_recording_path is not null
          and (
            (
              call_recording_status in ('pending', 'recording')
              and ended_at <= now() - make_interval(secs => $1)
            )
            or (
              call_recording_status = 'finalizing'
              and coalesce(call_recording_integrity_checked_at, ended_at)
                <= now() - make_interval(secs => $2)
            )
          )
        order by ended_at asc
        limit $3
        for update skip locked
      )
      update calls
      set call_recording_status = 'finalizing',
          call_recording_integrity_checked_at = clock_timestamp(),
          call_recording_failure_reason = null,
          updated_at = now()
      from candidates
      where calls.id = candidates.id
      returning
        calls.id,
        calls.call_recording_path,
        calls.call_recording_integrity_checked_at::text as claim_token
    `,
    [input.terminalGraceSeconds, input.staleClaimSeconds, input.batchSize]
  );
  return result.rows;
}

async function markRecordingAvailable(
  pool: pg.Pool,
  recording: ClaimedRecording,
  inspection: RecordingInspection
): Promise<boolean> {
  const result = await pool.query(
    `
      with finalized as (
        update calls
        set call_recording_status = 'available',
            call_recording_duration_seconds = $3,
            call_recording_file_size_bytes = $4,
            call_recording_integrity_checked_at = clock_timestamp(),
            call_recording_failure_reason = null,
            updated_at = now()
        where id = $1
          and call_recording_status = 'finalizing'
          and call_recording_integrity_checked_at = $2::timestamptz
        returning id, agent_id, state
      )
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        raw_json
      )
      select
        id,
        agent_id,
        'call_recording_finalized',
        state,
        'ffprobe',
        $5::jsonb
      from finalized
      returning call_id
    `,
    [
      recording.id,
      recording.claim_token,
      inspection.durationSeconds,
      inspection.fileSizeBytes,
      JSON.stringify({
        recordingPath: recording.call_recording_path,
        durationSeconds: inspection.durationSeconds,
        fileSizeBytes: inspection.fileSizeBytes
      })
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function markRecordingFailed(
  pool: pg.Pool,
  recording: ClaimedRecording,
  reason: string
): Promise<boolean> {
  const result = await pool.query(
    `
      with finalized as (
        update calls
        set call_recording_status = 'failed',
            call_recording_duration_seconds = null,
            call_recording_file_size_bytes = null,
            call_recording_integrity_checked_at = clock_timestamp(),
            call_recording_failure_reason = $3,
            updated_at = now()
        where id = $1
          and call_recording_status = 'finalizing'
          and call_recording_integrity_checked_at = $2::timestamptz
        returning id, agent_id, state
      )
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        raw_json
      )
      select
        id,
        agent_id,
        'call_recording_integrity_failed',
        state,
        'ffprobe',
        $4::jsonb
      from finalized
      returning call_id
    `,
    [
      recording.id,
      recording.claim_token,
      reason,
      JSON.stringify({ recordingPath: recording.call_recording_path, reason })
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function markTerminalRecordingsWithoutPath(
  pool: pg.Pool,
  graceSeconds: number,
  batchSize: number
): Promise<number> {
  const reason = "Recording was enabled, but no media file was started";
  const result = await pool.query(
    `
      with candidates as (
        select id
        from calls
        where call_recording_enabled = true
          and call_recording_status = 'pending'
          and call_recording_path is null
          and ended_at is not null
          and ended_at <= now() - make_interval(secs => $1)
          and state in ('completed', 'failed', 'canceled')
        order by ended_at asc
        limit $4
        for update skip locked
      ), unavailable as (
        update calls
        set call_recording_status = 'failed',
            call_recording_integrity_checked_at = clock_timestamp(),
            call_recording_failure_reason = $2,
            updated_at = now()
        from candidates
        where calls.id = candidates.id
        returning calls.id, calls.agent_id, calls.state
      )
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        raw_json
      )
      select
        id,
        agent_id,
        'call_recording_integrity_failed',
        state,
        'ffprobe',
        $3::jsonb
      from unavailable
      returning call_id
    `,
    [graceSeconds, reason, JSON.stringify({ reason }), batchSize]
  );
  return result.rowCount ?? 0;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "Call recording integrity check failed").slice(0, 1_000);
}
