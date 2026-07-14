import type pg from "pg";
import type { RetentionRunResponse } from "@outbound-dialer/shared";
import type { AppConfig } from "../config.js";
import { recordRetentionFailure, recordRetentionSuccess } from "../metrics.js";
import { runRetention } from "./retention.js";

const retentionAdvisoryLockId = 182_923_117;

export type LockedRetentionResult =
  { status: "completed"; result: RetentionRunResponse } | { status: "locked" };

export async function runRetentionWithAdvisoryLock(
  pool: pg.Pool,
  input: { callRetentionDays: number; recordingRetentionDays: number; pcapRetentionDays: number },
  options: { runner?: typeof runRetention } = {}
): Promise<LockedRetentionResult> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::integer) as acquired",
      [retentionAdvisoryLockId]
    );
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired) {
      return { status: "locked" };
    }

    const runner = options.runner ?? runRetention;
    return {
      status: "completed",
      result: await runner(pool, {
        dryRun: false,
        callRetentionDays: input.callRetentionDays,
        recordingRetentionDays: input.recordingRetentionDays,
        pcapRetentionDays: input.pcapRetentionDays
      })
    };
  } finally {
    try {
      if (acquired) {
        await client.query("select pg_advisory_unlock($1::integer)", [retentionAdvisoryLockId]);
      }
    } finally {
      client.release();
    }
  }
}

export function startRetentionScheduler(
  pool: pg.Pool,
  config: AppConfig,
  logger: RetentionLogger
): { runNow: () => Promise<"completed" | "locked" | "overlap" | "disabled" | "error">; stop: () => void } {
  let stopped = false;
  let running = false;

  const runNow = async (): Promise<"completed" | "locked" | "overlap" | "disabled" | "error"> => {
    if (!config.RETENTION_ENABLED || stopped) {
      return "disabled";
    }
    if (running) {
      return "overlap";
    }
    running = true;
    try {
      const result = await runRetentionWithAdvisoryLock(
        pool,
        {
          callRetentionDays: config.CALL_LOG_RETENTION_DAYS,
          recordingRetentionDays: config.CALL_RECORDING_RETENTION_DAYS,
          pcapRetentionDays: config.PCAP_RETENTION_DAYS
        },
        {
          runner: (runnerPool, input) =>
            runRetention(runnerPool, input, {
              onUnlinkError: (error, recording) => {
                logger.error(
                  { error, callId: recording.id },
                  "Call recording retention unlink failed; metadata was preserved"
                );
              },
              onPcapUnlinkError: (error, capture) => {
                logger.error(
                  { error, callId: capture.call_id },
                  "PCAP retention unlink failed; metadata was preserved"
                );
              }
            })
        }
      );
      if (result.status === "locked") {
        logger.info({}, "Retention run skipped because another API instance holds the advisory lock");
        return "locked";
      }
      recordRetentionSuccess(result.result);
      logger.info(result.result, "Retention run completed");
      return "completed";
    } catch (error) {
      recordRetentionFailure();
      logger.error({ error }, "Retention run failed");
      return "error";
    } finally {
      running = false;
    }
  };

  if (config.RETENTION_ENABLED) void runNow();
  const interval = setInterval(() => void runNow(), config.RETENTION_RUN_INTERVAL_SECONDS * 1000);
  interval.unref();

  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    }
  };
}

export type RetentionLogger = {
  info: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
};
