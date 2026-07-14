import http from "node:http";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { extractPcapFilterSelection, type PcapFilterSelection } from "./pcap-filter.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PcapLogger = {
  info: (details: object, message: string) => void;
  warn: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
};

type CaptureResponse = {
  callId: string;
  running: boolean;
  fileSizeBytes?: number;
  message?: string;
};

export async function startCallPcapCapture(
  pool: pg.Pool,
  config: AppConfig,
  callId: string,
  logger?: PcapLogger,
  dependencies: { requestCapture?: typeof requestCapture } = {}
): Promise<void> {
  if (!config.PCAP_CAPTURE_ENABLED) {
    return;
  }

  const filePath = callPcapPath(config.PCAP_STORAGE_DIR, callId);
  try {
    await (dependencies.requestCapture ?? requestCapture)(config.PCAP_CAPTURE_SOCKET, callId, "start");
    const activated = await pool.query<{ call_id: string }>(
      `
        update call_pcaps
        set status = 'capturing',
            file_path = $2,
            started_at = coalesce(started_at, now()),
            failure_reason = null,
            updated_at = now()
        where call_id = $1
          and status = 'pending'
        returning call_id
      `,
      [callId, filePath]
    );
    if (!activated.rowCount) {
      return;
    }
    await insertPcapEvent(pool, callId, "pcap_capture_started", { filePath });
    logger?.info({ callId }, "Per-call PCAP capture started");
  } catch (error) {
    const message = errorMessage(error);
    if (await markPcapFailed(pool, callId, message)) {
      await insertPcapEvent(pool, callId, "pcap_capture_failed", { message });
      logger?.error({ callId, error }, "Per-call PCAP capture failed to start; the call will continue");
    }
  }
}

export function startPcapCaptureFinalizer(
  pool: pg.Pool,
  config: AppConfig,
  logger: PcapLogger,
  intervalMilliseconds = 1_000
): { runNow: () => Promise<void>; stop: () => void } {
  let stopped = false;
  let running = false;

  const runNow = async (): Promise<void> => {
    if (stopped || running || !config.PCAP_CAPTURE_ENABLED) {
      return;
    }
    running = true;
    try {
      const pending = await pool.query<{ call_id: string }>(
        `
          select call_pcaps.call_id
          from call_pcaps
          join calls on calls.id = call_pcaps.call_id
          where call_pcaps.status = 'pending'
            and calls.ended_at is null
          order by call_pcaps.created_at
          limit 20
        `
      );
      for (const capture of pending.rows) {
        await startCallPcapCapture(pool, config, capture.call_id, logger);
      }

      const completed = await pool.query<{ call_id: string; file_path: string | null }>(
        `
          select call_pcaps.call_id, call_pcaps.file_path
          from call_pcaps
          join calls on calls.id = call_pcaps.call_id
          where call_pcaps.status = 'capturing'
            and calls.ended_at is not null
          order by calls.ended_at
          limit 20
        `
      );
      for (const capture of completed.rows) {
        await finalizeCallPcapCapture(pool, config, capture, logger);
      }
    } catch (error) {
      logger.error({ error }, "Per-call PCAP finalizer run failed");
    } finally {
      running = false;
    }
  };

  if (config.PCAP_CAPTURE_ENABLED) {
    void runNow();
  }
  const timer = setInterval(() => void runNow(), intervalMilliseconds);
  timer.unref?.();
  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function finalizeCallPcapCapture(
  pool: pg.Pool,
  config: AppConfig,
  capture: { call_id: string; file_path: string | null },
  logger: PcapLogger,
  dependencies: { requestCapture?: typeof requestCapture } = {}
): Promise<void> {
  try {
    const selection = await loadPcapFilterSelection(pool, capture.call_id);
    const response = await (dependencies.requestCapture ?? requestCapture)(
      config.PCAP_CAPTURE_SOCKET,
      capture.call_id,
      "stop",
      selection
    );
    const filePath = capture.file_path ?? callPcapPath(config.PCAP_STORAGE_DIR, capture.call_id);
    const fileSizeBytes = response.fileSizeBytes ?? (await stat(filePath)).size;
    if (fileSizeBytes <= 24) {
      throw new Error("PCAP capture completed without packets");
    }
    await pool.query(
      `
        update call_pcaps
        set status = 'available',
            file_path = $2,
            file_size_bytes = $3,
            ended_at = coalesce(ended_at, now()),
            failure_reason = null,
            updated_at = now()
        where call_id = $1
          and status = 'capturing'
      `,
      [capture.call_id, filePath, fileSizeBytes]
    );
    await insertPcapEvent(pool, capture.call_id, "pcap_capture_available", { fileSizeBytes });
    logger.info({ callId: capture.call_id, fileSizeBytes }, "Per-call PCAP capture finalized");
  } catch (error) {
    const message = errorMessage(error);
    if (await markPcapFailed(pool, capture.call_id, message)) {
      await insertPcapEvent(pool, capture.call_id, "pcap_capture_failed", { message });
      logger.error({ callId: capture.call_id, error }, "Per-call PCAP capture failed to finalize");
    }
  }
}

async function markPcapFailed(pool: pg.Pool, callId: string, message: string): Promise<boolean> {
  const result = await pool.query<{ call_id: string }>(
    `
      update call_pcaps
      set status = 'failed',
          ended_at = coalesce(ended_at, now()),
          failure_reason = left($2, 1000),
          updated_at = now()
      where call_id = $1
        and status in ('pending', 'capturing')
      returning call_id
    `,
    [callId, message]
  );
  return Boolean(result.rowCount);
}

async function insertPcapEvent(
  pool: pg.Pool,
  callId: string,
  eventType: string,
  raw: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `
      insert into call_events (call_id, agent_id, event_type, state, raw_json)
      select calls.id, calls.agent_id, $2, calls.state, $3::jsonb
      from calls
      where calls.id = $1
    `,
    [callId, eventType, JSON.stringify(raw)]
  );
}

async function requestCapture(
  socketPath: string,
  callId: string,
  action: "start" | "stop",
  selection?: PcapFilterSelection
): Promise<CaptureResponse> {
  if (!UUID_PATTERN.test(callId)) {
    throw new Error("Invalid call ID for PCAP capture");
  }
  const body = action === "stop" ? JSON.stringify({ selection }) : "";
  return new Promise<CaptureResponse>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        method: "POST",
        path: `/captures/${encodeURIComponent(callId)}/${action}`,
        socketPath,
        timeout: action === "stop" ? 30_000 : 3_000,
        headers: {
          "Content-Length": Buffer.byteLength(body),
          ...(body ? { "Content-Type": "application/json" } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: CaptureResponse;
          try {
            parsed = JSON.parse(body) as CaptureResponse;
          } catch {
            rejectRequest(new Error(`PCAP supervisor returned an invalid response (${response.statusCode})`));
            return;
          }
          if (!response.statusCode || response.statusCode >= 300) {
            rejectRequest(new Error(parsed.message ?? `PCAP supervisor returned ${response.statusCode}`));
            return;
          }
          resolveRequest(parsed);
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("PCAP supervisor request timed out")));
    request.on("error", rejectRequest);
    request.end(body);
  });
}

async function loadPcapFilterSelection(pool: pg.Pool, callId: string): Promise<PcapFilterSelection> {
  const result = await pool.query<{ raw_json: unknown }>(
    `
      select raw_json
      from call_events
      where call_id = $1
        and freeswitch_event_name is not null
      order by created_at
    `,
    [callId]
  );
  return extractPcapFilterSelection(result.rows.map((row) => row.raw_json));
}

export function callPcapPath(storageDir: string, callId: string): string {
  if (!UUID_PATTERN.test(callId)) {
    throw new Error("Invalid call ID for PCAP path");
  }
  const storageRoot = resolve(storageDir);
  const filePath = resolve(storageRoot, `${callId}.pcap`);
  if (!filePath.startsWith(`${storageRoot}${sep}`)) {
    throw new Error("PCAP path escaped the configured storage directory");
  }
  return filePath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = { finalizeCallPcapCapture, loadPcapFilterSelection, requestCapture };
