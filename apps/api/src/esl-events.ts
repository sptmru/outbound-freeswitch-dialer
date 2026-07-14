import net from "node:net";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { CoalescedTask } from "./coalesced-task.js";
import type { AppConfig } from "./config.js";
import { finishAgentCall } from "./agent-availability.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import {
  configureFreeSwitchEventQueueMetrics,
  recordFreeSwitchEslReconnect,
  recordFreeSwitchEventError,
  recordFreeSwitchEventProcessed,
  recordFreeSwitchPersistenceOverflow,
  recordFreeSwitchPersistenceRetry,
  setFreeSwitchEventQueueDepth,
  setFreeSwitchEventListenerConnected
} from "./metrics.js";
import { OrderedRetryQueue } from "./ordered-retry-queue.js";

interface Logger {
  error: (value: unknown, message?: string) => void;
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
}

interface EslFrame {
  body: string;
  headers: Record<string, string>;
}

const EVENT_NAMES = [
  "BACKGROUND_JOB",
  "CHANNEL_CREATE",
  "CHANNEL_PROGRESS_MEDIA",
  "CHANNEL_ANSWER",
  "CHANNEL_BRIDGE",
  "CHANNEL_HANGUP",
  "CHANNEL_HANGUP_COMPLETE",
  "CHANNEL_DESTROY",
  // FreeSWITCH treats every token after CUSTOM as a custom event subclass.
  // Keep it last so CHANNEL_* names remain regular event subscriptions.
  "CUSTOM"
].join(" ");

const AGENT_SIP_PROFILE = "internal-webrtc";
const VOICEMAIL_PLAYBACK_EVENT_PREFIX = "outbound_dialer::voicemail_playback_";
const VOICEMAIL_DROP_ACTIVE_STATES = [
  "voicemail_drop_requested",
  "voicemail_playback_started",
  "agent_released"
] as const;

type AgentRegistrationEvent = {
  eventSubclass: "sofia::register" | "sofia::unregister" | "sofia::expire";
  registered: boolean;
  sipUsername: string;
};

export function startFreeSwitchEventListener(config: AppConfig, pool: pg.Pool, logger: Logger): () => void {
  configureFreeSwitchEventQueueMetrics(config.FREESWITCH_ESL_EVENT_QUEUE_MAX_SIZE);
  if (!config.FREESWITCH_ESL_ENABLED) {
    setFreeSwitchEventListenerConnected(false);
    logger.info({ enabled: false }, "FreeSWITCH event listener disabled");
    return () => undefined;
  }

  let stopped = false;
  let socket: net.Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const persistenceQueue = new OrderedRetryQueue<EslFrame>({
    initialRetryMilliseconds: config.FREESWITCH_ESL_EVENT_RETRY_INITIAL_MS,
    isTransientError: isTransientPersistenceError,
    maxRetryMilliseconds: Math.max(
      config.FREESWITCH_ESL_EVENT_RETRY_INITIAL_MS,
      config.FREESWITCH_ESL_EVENT_RETRY_MAX_MS
    ),
    maxSize: config.FREESWITCH_ESL_EVENT_QUEUE_MAX_SIZE,
    onDepthChanged: setFreeSwitchEventQueueDepth,
    onPermanentFailure: (error, frame) => {
      recordFreeSwitchEventError();
      logger.error(
        {
          eventName: frame.headers["event-name"] ?? null,
          eventSubclass: frame.headers["event-subclass"] ?? null,
          callId: frame.headers["variable_outbound_dialer_call_id"] ?? null,
          message: error instanceof Error ? error.message : String(error)
        },
        "non-retryable FreeSWITCH event persistence failure"
      );
    },
    onRetry: (error, frame, attempt, delayMilliseconds) => {
      recordFreeSwitchPersistenceRetry();
      logger.warn(
        {
          attempt,
          callId: frame.headers["variable_outbound_dialer_call_id"] ?? null,
          delayMilliseconds,
          eventName: frame.headers["event-name"] ?? null,
          message: error instanceof Error ? error.message : String(error),
          queueDepth: persistenceQueue.size
        },
        "retrying FreeSWITCH event persistence after transient failure"
      );
    },
    process: async (frame) => {
      await persistFreeSwitchEvent(config, pool, frame);
      recordFreeSwitchEventProcessed(frame.headers["event-name"]);
    }
  });

  const reconciliationTask = new CoalescedTask(
    async () => {
      await persistenceQueue.waitForIdle();
      if (!stopped) {
        await reconcileActiveCalls(config, pool, logger);
      }
    },
    (error) => logger.error(error, "failed to reconcile active calls from FreeSWITCH event listener")
  );

  const reconciliationTimer = setInterval(
    () => reconciliationTask.request(),
    config.FREESWITCH_ESL_RECONCILE_INTERVAL_SECONDS * 1000
  );
  reconciliationTimer.unref?.();

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  };

  const connect = () => {
    if (stopped) {
      return;
    }
    if (persistenceQueue.isAtCapacity) {
      scheduleReconnect();
      return;
    }

    const nextSocket = net.createConnection({
      host: config.FREESWITCH_ESL_HOST,
      port: config.FREESWITCH_ESL_PORT,
      timeout: 5000
    });
    socket = nextSocket;
    nextSocket.setKeepAlive(true, 15000);

    let buffer = "";
    let stage: "auth_request" | "auth_reply" | "subscribe_reply" | "events" = "auth_request";

    nextSocket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const extraction = extractFrames(buffer);
      buffer = extraction.rest;

      for (const [frameIndex, frame] of extraction.frames.entries()) {
        if (stage === "auth_request") {
          if (frame.headers["content-type"] === "auth/request") {
            nextSocket.write(`auth ${config.FREESWITCH_ESL_PASSWORD}\n\n`);
            stage = "auth_reply";
          }
          continue;
        }

        if (stage === "auth_reply") {
          if (frame.headers["reply-text"]?.startsWith("+OK")) {
            nextSocket.write(`event plain ${EVENT_NAMES}\n\n`);
            stage = "subscribe_reply";
            continue;
          }
          nextSocket.destroy(new Error(frame.headers["reply-text"] ?? "FreeSWITCH ESL auth failed"));
          continue;
        }

        if (stage === "subscribe_reply") {
          if (
            frame.headers["content-type"] === "command/reply" &&
            frame.headers["reply-text"]?.startsWith("+OK")
          ) {
            nextSocket.setTimeout(0);
            stage = "events";
            setFreeSwitchEventListenerConnected(true);
            logger.info({ events: EVENT_NAMES }, "FreeSWITCH event listener subscribed");
            reconciliationTask.request();
            continue;
          }
          nextSocket.destroy(
            new Error(frame.headers["reply-text"] ?? "FreeSWITCH ESL event subscription failed")
          );
          continue;
        }

        if (stage === "events") {
          const callId = frame.headers["variable_outbound_dialer_call_id"];
          if (callId) {
            logger.info(
              {
                callId,
                eventName: frame.headers["event-name"] ?? null,
                eventSubclass: frame.headers["event-subclass"] ?? null,
                legType: frame.headers["variable_outbound_dialer_leg_type"] ?? null,
                legUuid: frame.headers["unique-id"] ?? frame.headers["variable_uuid"] ?? null
              },
              "FreeSWITCH tagged event received"
            );
          }
          if (!persistenceQueue.enqueue(frame)) {
            const unqueuedFrames = extraction.frames.length - frameIndex;
            recordFreeSwitchPersistenceOverflow();
            setFreeSwitchEventListenerConnected(false);
            logger.error(
              {
                capacity: persistenceQueue.maxSize,
                eventName: frame.headers["event-name"] ?? null,
                bufferedBytes: Buffer.byteLength(buffer),
                queueDepth: persistenceQueue.size,
                unqueuedFrames
              },
              "FreeSWITCH event persistence queue overflow; disconnecting listener for reconciliation"
            );
            nextSocket.destroy(new Error("FreeSWITCH event persistence queue overflow"));
            break;
          }
        }
      }
    });

    nextSocket.on("connect", () => {
      logger.info(
        { host: config.FREESWITCH_ESL_HOST, port: config.FREESWITCH_ESL_PORT },
        "FreeSWITCH event listener connected"
      );
    });

    nextSocket.on("timeout", () => {
      nextSocket.destroy(new Error("FreeSWITCH event listener timed out"));
    });

    nextSocket.on("error", (error) => {
      if (!stopped) {
        logger.warn({ message: error.message }, "FreeSWITCH event listener error");
      }
    });

    nextSocket.on("close", () => {
      setFreeSwitchEventListenerConnected(false);
      if (socket === nextSocket) {
        socket = null;
      }
      if (!stopped) {
        recordFreeSwitchEslReconnect();
      }
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    stopped = true;
    setFreeSwitchEventListenerConnected(false);
    clearInterval(reconciliationTimer);
    reconciliationTask.stop();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.destroy();
    socket = null;
    const discardedEvents = persistenceQueue.stop();
    if (discardedEvents) {
      logger.warn(
        { discardedEvents },
        "FreeSWITCH event listener stopped with unpersisted events still in memory"
      );
    }
  };
}

function isTransientPersistenceError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (/^(08|40|53)/.test(code) || /^(55P03|57P0[123])$/.test(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /connection (?:ended|lost|refused|reset|terminated)|database (?:is )?unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|server closed the connection|timeout expired/i.test(
    message
  );
}

async function persistFreeSwitchEvent(config: AppConfig, pool: pg.Pool, frame: EslFrame): Promise<void> {
  const eventName = frame.headers["event-name"];
  if (eventName === "BACKGROUND_JOB") {
    await persistBackgroundJobEvent(config, pool, frame);
    return;
  }
  if (eventName === "CUSTOM" && isAgentRegistrationEvent(frame)) {
    await persistAgentRegistrationEvent(config, pool, frame);
    return;
  }
  if (eventName === "CUSTOM" && isVoicemailPlaybackEvent(frame)) {
    await persistVoicemailPlaybackEvent(config, pool, frame);
    return;
  }
  if (eventName === "CUSTOM" && isVoicemailDetectionEvent(frame)) {
    await persistVoicemailDetectionEvent(pool, frame);
    return;
  }

  const callId = frame.headers["variable_outbound_dialer_call_id"];
  if (!eventName || !callId || !isUuid(callId)) {
    return;
  }

  const legUuid =
    frame.headers["unique-id"] ??
    frame.headers["variable_uuid"] ??
    frame.headers["variable_origination_uuid"] ??
    null;
  const legType = frame.headers["variable_outbound_dialer_leg_type"] === "agent" ? "agent" : "customer";
  const state = mapEventToCallState(eventName, frame.headers["hangup-cause"], legType);
  const eventType = `freeswitch_${eventName.toLowerCase()}`;
  const raw = JSON.stringify({
    headers: frame.headers,
    body: frame.body
  });

  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        freeswitch_event_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values (
        $1,
        (select agent_id from calls where id = $1),
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::jsonb
      )
    `,
    [
      callId,
      eventType,
      state,
      eventName,
      legType === "agent" ? legUuid : null,
      legType === "customer" ? legUuid : null,
      raw
    ]
  );

  if (legUuid) {
    await pool.query(
      `
        update call_legs
        set freeswitch_uuid = coalesce(freeswitch_uuid, $2),
            state = $3,
            answered_at = case when $4 then coalesce(answered_at, now()) else answered_at end,
            ended_at = case when $5 then coalesce(ended_at, now()) else ended_at end
        where call_id = $1
          and type = $6
      `,
      [
        callId,
        legUuid,
        mapEventToLegState(eventName),
        eventName === "CHANNEL_ANSWER",
        isTerminalEvent(eventName),
        legType
      ]
    );
  }

  if (eventName === "CHANNEL_CREATE" && legType === "customer") {
    await pool.query(
      `
        update calls
        set state = 'customer_dialing',
            updated_at = now()
        where id = $1
          and state not in (
            'voicemail_drop_requested',
            'voicemail_playback_started',
            'agent_released',
            'voicemail_playback_completed',
            'completed',
            'failed',
            'canceled'
          )
      `,
      [callId]
    );
  }

  if (eventName === "CHANNEL_ANSWER" && legType === "agent") {
    await pool.query(
      `
        update calls
        set state = 'agent_answered',
            updated_at = now()
        where id = $1
          and state not in (
            'voicemail_drop_requested',
            'voicemail_playback_started',
            'agent_released',
            'voicemail_playback_completed',
            'completed',
            'failed',
            'canceled',
            'bridged'
          )
      `,
      [callId]
    );
  }

  if (eventName === "CHANNEL_PROGRESS_MEDIA" && legType === "customer" && legUuid) {
    await startCallRecording(config, pool, {
      callId,
      customerLegUuid: legUuid,
      phase: "early_media"
    });
    await startVoicemailDetection(config, pool, {
      callId,
      customerLegUuid: legUuid,
      phase: "early_media"
    });
  }

  if ((eventName === "CHANNEL_ANSWER" && legType === "customer") || eventName === "CHANNEL_BRIDGE") {
    await pool.query(
      `
        update calls
        set state = 'bridged',
            answered_at = coalesce(answered_at, now()),
            updated_at = now()
        where id = $1
          and state not in (
            'voicemail_drop_requested',
            'voicemail_playback_started',
            'agent_released',
            'voicemail_playback_completed',
            'completed',
            'failed',
            'canceled'
          )
      `,
      [callId]
    );

    if (legType === "customer" && legUuid) {
      await startCallRecording(config, pool, {
        callId,
        customerLegUuid: legUuid,
        phase: "answered"
      });
      await startVoicemailDetection(config, pool, {
        callId,
        customerLegUuid: legUuid,
        phase: "answered"
      });
    }
  }

  if (isTerminalEvent(eventName) && legType === "customer") {
    const call = await pool.query<{
      agent_id: string | null;
      answered_at: Date | null;
      contact_id: string | null;
      state: string;
      voicemail_signal_status: string | null;
    }>(
      `
        select agent_id, answered_at, contact_id, state, voicemail_signal_status
        from calls
        where id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [callId]
    );
    const current = call.rows[0];
    if (!current) {
      return;
    }
    if (isVoicemailDropActiveState(current.state)) {
      const normalHangup = ["NORMAL_CLEARING", "ORIGINATOR_CANCEL"].includes(
        frame.headers["hangup-cause"]?.toUpperCase() ?? ""
      );
      if (normalHangup) {
        await finalizeCompletedVoicemailPlayback(config, pool, callId, legUuid, {
          headers: frame.headers,
          body: frame.body,
          source: "freeswitch_terminal_event"
        });
        return;
      }
      await finalizeIncompleteVoicemailPlayback(config, pool, {
        agentId: current.agent_id,
        agentReleased: current.state === "agent_released",
        callId,
        contactId: current.contact_id,
        customerLegUuid: legUuid,
        hangupCause: frame.headers["hangup-cause"],
        raw: { headers: frame.headers, body: frame.body },
        source: "freeswitch_terminal_event"
      });
      return;
    }
    const outcome = resolveCustomerHangupOutcome({
      answered: Boolean(current.answered_at),
      hangupCause: frame.headers["hangup-cause"],
      voicemailDetected: current.voicemail_signal_status === "detected"
    });
    const terminalState = outcome === "failed" ? "failed" : "completed";
    const updated = await pool.query(
      `
        update calls
        set state = $2,
            outcome = coalesce(outcome, $3),
            ended_at = coalesce(ended_at, now()),
            updated_at = now()
        where id = $1
          and state not in ('completed', 'failed', 'canceled')
        returning agent_id, contact_id
      `,
      [callId, terminalState, outcome]
    );
    if (!updated.rowCount) {
      return;
    }
    const agentId = updated.rows[0]?.agent_id as string | null | undefined;
    if (agentId) {
      await finishAgentCall(pool, agentId);
    }
    await pool.query(
      `
        update contacts
        set status = $2,
            updated_at = now()
        where id = $1
          and status = 'calling'
      `,
      [updated.rows[0]?.contact_id, contactStatusForOutcome(outcome)]
    );
  }
}

type FreeSwitchApiCommandSender = typeof sendFreeSwitchApiCommand;
type MediaStartPhase = "early_media" | "answered";

async function startCallRecording(
  config: AppConfig,
  pool: pg.Pool,
  input: { callId: string; customerLegUuid: string; phase?: MediaStartPhase },
  sendApiCommand: FreeSwitchApiCommandSender = sendFreeSwitchApiCommand
): Promise<void> {
  const phase = input.phase ?? "answered";
  const eventState = phase === "early_media" ? "customer_dialing" : "bridged";
  const recordingPath = buildCallRecordingPath(config.CALL_RECORDINGS_STORAGE_DIR, input.callId);
  const claimed = await pool.query<{ agent_id: string | null }>(
    `
      update calls
      set call_recording_path = $2,
          call_recording_status = 'recording',
          call_recording_failure_reason = null,
          updated_at = now()
      where id = $1
        and call_recording_enabled = true
        and call_recording_path is null
        and ended_at is null
        and state not in ('completed', 'failed', 'canceled')
      returning agent_id
    `,
    [input.callId, recordingPath]
  );
  const call = claimed.rows[0];
  if (!call) {
    return;
  }

  const command = `uuid_record ${input.customerLegUuid} start ${recordingPath}`;
  try {
    await mkdir(config.CALL_RECORDINGS_STORAGE_DIR, { recursive: true });
    const response = await sendApiCommand(config, command);
    await pool.query(
      `
        insert into call_events (
          call_id,
          agent_id,
          event_type,
          state,
          api_command_name,
          customer_leg_uuid,
          raw_json
        )
        values ($1, $2, 'call_recording_started', $3, 'uuid_record', $4, $5::jsonb)
      `,
      [
        input.callId,
        call.agent_id,
        eventState,
        input.customerLegUuid,
        JSON.stringify({ command, phase, recordingPath, response: response.body.trim() })
      ]
    );
  } catch (error) {
    await pool.query(
      `
        update calls
        set call_recording_path = null,
            call_recording_status = 'failed',
            call_recording_failure_reason = $3,
            updated_at = now()
        where id = $1
          and call_recording_path = $2
      `,
      [input.callId, recordingPath, error instanceof Error ? error.message : String(error)]
    );
    await pool.query(
      `
        insert into call_events (
          call_id,
          agent_id,
          event_type,
          state,
          api_command_name,
          customer_leg_uuid,
          raw_json
        )
        values ($1, $2, 'call_recording_failed', $3, 'uuid_record', $4, $5::jsonb)
      `,
      [
        input.callId,
        call.agent_id,
        eventState,
        input.customerLegUuid,
        JSON.stringify({
          command,
          message: error instanceof Error ? error.message : String(error),
          phase,
          recordingPath
        })
      ]
    );
  }
}

function buildCallRecordingPath(storageDir: string, callId: string): string {
  if (!isUuid(callId)) {
    throw new Error("Invalid call ID for call recording path");
  }
  if (/\s/.test(storageDir)) {
    throw new Error("CALL_RECORDINGS_STORAGE_DIR must not contain whitespace");
  }
  return join(storageDir, `${callId}.wav`);
}

async function startVoicemailDetection(
  config: AppConfig,
  pool: pg.Pool,
  input: { callId: string; customerLegUuid: string; phase?: MediaStartPhase },
  sendApiCommand: FreeSwitchApiCommandSender = sendFreeSwitchApiCommand
): Promise<void> {
  const phase = input.phase ?? "answered";
  if (phase === "early_media") {
    const enabled = await pool.query<{ early_media_avmd_enabled: boolean }>(
      `
        select early_media_avmd_enabled
        from calls
        where id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [input.callId]
    );
    if (!enabled.rows[0]?.early_media_avmd_enabled) {
      return;
    }
  }

  const priorStarts = await pool.query<{ raw_json: unknown }>(
    `
      select raw_json
      from call_events
      where call_id = $1
        and customer_leg_uuid = $2
        and event_type = 'voicemail_detection_started'
    `,
    [input.callId, input.customerLegUuid]
  );

  const attemptedModules = new Set(
    priorStarts.rows.flatMap((row) => getAttemptedVoicemailDetectionModules(row.raw_json))
  );

  const raw: Record<string, unknown> = {};
  const modules: Array<{ module: "mod_avmd" | "mod_amd"; command: string }> = (
    phase === "early_media"
      ? [{ module: "mod_avmd" as const, command: `avmd ${input.customerLegUuid} start` }]
      : [
          { module: "mod_avmd" as const, command: `avmd ${input.customerLegUuid} start` },
          { module: "mod_amd" as const, command: `amd ${input.customerLegUuid} start` }
        ]
  ).filter(({ module }) => !attemptedModules.has(module));
  if (!modules.length) {
    return;
  }

  for (const module of modules) {
    try {
      const moduleExists = await sendApiCommand(config, `module_exists ${module.module}`);
      if (moduleExists.body.trim() !== "true") {
        raw[module.module] = { status: "unavailable" };
        continue;
      }
      const response = await sendApiCommand(config, module.command);
      raw[module.module] = { command: module.command, status: "started", response: response.body.trim() };
    } catch (error) {
      raw[module.module] = {
        command: module.command,
        error: error instanceof Error ? error.message : String(error),
        status: "failed"
      };
    }
  }

  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        customer_leg_uuid,
        raw_json
      )
      values (
        $1,
        (select agent_id from calls where id = $1),
        'voicemail_detection_started',
        $2,
        'voicemail detection start',
        $3,
        $4::jsonb
      )
    `,
    [
      input.callId,
      phase === "early_media" ? "customer_dialing" : "bridged",
      input.customerLegUuid,
      JSON.stringify({ phase, modules: raw })
    ]
  );
}

function getAttemptedVoicemailDetectionModules(value: unknown): Array<"mod_avmd" | "mod_amd"> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const modules =
    record.modules && typeof record.modules === "object"
      ? (record.modules as Record<string, unknown>)
      : record;
  return (["mod_avmd", "mod_amd"] as const).filter((module) => module in modules);
}

type VoicemailPlaybackEventKind = "completed" | "failed" | "started";

function isVoicemailPlaybackEvent(frame: EslFrame): boolean {
  return mapVoicemailPlaybackEventKind(frame) !== null;
}

function mapVoicemailPlaybackEventKind(frame: EslFrame): VoicemailPlaybackEventKind | null {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase() ?? "";
  if (!eventSubclass.startsWith(VOICEMAIL_PLAYBACK_EVENT_PREFIX)) {
    return null;
  }
  const suffix = eventSubclass.slice(VOICEMAIL_PLAYBACK_EVENT_PREFIX.length);
  return suffix === "started" || suffix === "completed" || suffix === "failed" ? suffix : null;
}

function getVoicemailPlaybackCallId(frame: EslFrame): string | null {
  const callId = firstHeader(frame.headers, [
    "outbound-dialer-call-id",
    "outbound_dialer_call_id",
    "variable_voicemail_drop_call_id",
    "variable_outbound_dialer_call_id"
  ]);
  return callId && isUuid(callId) ? callId : null;
}

async function persistVoicemailPlaybackEvent(
  config: AppConfig,
  pool: pg.Pool,
  frame: EslFrame
): Promise<void> {
  const kind = mapVoicemailPlaybackEventKind(frame);
  const callId = getVoicemailPlaybackCallId(frame);
  if (!kind || !callId) {
    return;
  }

  const raw = {
    headers: frame.headers,
    body: frame.body
  };
  const eventLegUuid = firstHeader(frame.headers, [
    "outbound-dialer-customer-leg-uuid",
    "outbound_dialer_customer_leg_uuid",
    "unique-id",
    "variable_uuid"
  ]);

  if (kind === "completed") {
    await finalizeCompletedVoicemailPlayback(config, pool, callId, eventLegUuid, raw);
    return;
  }

  if (kind === "failed") {
    const current = await getActiveVoicemailDrop(pool, callId);
    if (!current) {
      return;
    }
    await finalizeIncompleteVoicemailPlayback(config, pool, {
      agentId: current.agent_id,
      agentReleased: current.state === "agent_released",
      callId,
      contactId: current.contact_id,
      customerLegUuid: eventLegUuid ?? current.customer_leg_uuid,
      forceFailed: true,
      raw,
      source: "freeswitch_playback_failed_event"
    });
    return;
  }

  const current = await getActiveVoicemailDrop(pool, callId);
  if (!current) {
    return;
  }
  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        freeswitch_event_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, 'voicemail_playback_started', 'voicemail_playback_started', 'CUSTOM', $3, $4, $5::jsonb)
      on conflict do nothing
    `,
    [
      callId,
      current.agent_id,
      current.agent_leg_uuid,
      eventLegUuid ?? current.customer_leg_uuid,
      JSON.stringify(raw)
    ]
  );
  await pool.query(
    `
      update calls
      set state = 'voicemail_playback_started',
          voicemail_playback_started_at = coalesce(voicemail_playback_started_at, now()),
          updated_at = now()
      where id = $1
        and ended_at is null
        and state in ('voicemail_drop_requested', 'voicemail_playback_started')
    `,
    [callId]
  );
  await releaseAgentAfterVoicemailPlaybackStarts(config, pool, {
    agentId: current.agent_id,
    agentLegUuid: current.agent_leg_uuid,
    callId,
    customerLegUuid: eventLegUuid ?? current.customer_leg_uuid
  });
}

interface ActiveVoicemailDropRow {
  agent_id: string | null;
  agent_leg_uuid: string | null;
  contact_id: string | null;
  customer_leg_uuid: string | null;
  state: string;
}

async function getActiveVoicemailDrop(pool: pg.Pool, callId: string): Promise<ActiveVoicemailDropRow | null> {
  const result = await pool.query<ActiveVoicemailDropRow>(
    `
      select
        calls.agent_id,
        calls.contact_id,
        calls.state,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        customer_leg.freeswitch_uuid as customer_leg_uuid
      from calls
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where calls.id = $1
        and calls.ended_at is null
        and calls.state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')
      limit 1
    `,
    [callId]
  );
  return result.rows[0] ?? null;
}

async function releaseAgentAfterVoicemailPlaybackStarts(
  config: AppConfig,
  pool: pg.Pool,
  input: {
    agentId: string | null;
    agentLegUuid: string | null;
    callId: string;
    customerLegUuid: string | null;
  },
  sendApiCommand: FreeSwitchApiCommandSender = sendFreeSwitchApiCommand
): Promise<void> {
  const releaseResult: Record<string, unknown> = {};
  let releaseConfirmed = false;
  if (input.agentLegUuid) {
    try {
      const response = await sendApiCommand(config, `uuid_kill ${input.agentLegUuid}`);
      releaseResult.response = response.body.trim();
      releaseConfirmed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      releaseResult.message = message;
      // A missing channel confirms the transfer already released the agent. Other
      // ESL failures remain retryable and must not make the database claim success.
      releaseConfirmed = /no such channel/i.test(message);
    }
  } else {
    releaseResult.message = "Agent leg UUID was not persisted";
  }

  if (!releaseConfirmed) {
    await pool.query(
      `
        insert into call_events (
          call_id,
          agent_id,
          event_type,
          state,
          api_command_name,
          agent_leg_uuid,
          customer_leg_uuid,
          raw_json
        )
        values ($1, $2, 'agent_release_failed', 'voicemail_playback_started', 'uuid_kill', $3, $4, $5::jsonb)
      `,
      [input.callId, input.agentId, input.agentLegUuid, input.customerLegUuid, JSON.stringify(releaseResult)]
    );
    return;
  }

  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, 'agent_released', 'agent_released', 'uuid_kill', $3, $4, $5::jsonb)
      on conflict do nothing
    `,
    [input.callId, input.agentId, input.agentLegUuid, input.customerLegUuid, JSON.stringify(releaseResult)]
  );
  await pool.query(
    `
      update calls
      set state = 'agent_released',
          agent_released_at = coalesce(agent_released_at, now()),
          updated_at = now()
      where id = $1
        and ended_at is null
        and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')
    `,
    [input.callId]
  );
  await pool.query(
    `
      update call_legs
      set state = 'ended',
          ended_at = coalesce(ended_at, now())
      where call_id = $1
        and type = 'agent'
    `,
    [input.callId]
  );
  if (input.agentId) {
    await finishAgentCall(pool, input.agentId);
  }
}

async function finalizeCompletedVoicemailPlayback(
  config: AppConfig,
  pool: pg.Pool,
  callId: string,
  eventLegUuid: string | null,
  raw: Record<string, unknown>
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query<{
      agent_id: string | null;
      agent_released_at: Date | null;
      contact_id: string | null;
    }>(
      `
        update calls
        set state = 'completed',
            outcome = 'voicemail_dropped',
            voicemail_playback_completed_at = coalesce(voicemail_playback_completed_at, now()),
            ended_at = coalesce(ended_at, now()),
            updated_at = now()
        where id = $1
          and ended_at is null
          and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')
        returning agent_id, agent_released_at, contact_id
      `,
      [callId]
    );
    const call = updated.rows[0];
    if (!call) {
      await client.query("rollback");
      return;
    }
    await client.query(
      `
        insert into call_events (
          call_id,
          agent_id,
          event_type,
          state,
          freeswitch_event_name,
          customer_leg_uuid,
          raw_json
        )
        values ($1, $2, 'voicemail_playback_completed', 'voicemail_playback_completed', 'CUSTOM', $3, $4::jsonb)
        on conflict do nothing
      `,
      [callId, call.agent_id, eventLegUuid, JSON.stringify(raw)]
    );
    await client.query(
      `
        update call_legs
        set state = 'ended',
            ended_at = coalesce(ended_at, now())
        where call_id = $1
      `,
      [callId]
    );
    if (call.contact_id) {
      await client.query(
        `
          update contacts
          set status = 'completed',
              updated_at = now()
          where id = $1
            and status = 'calling'
        `,
        [call.contact_id]
      );
    }
    if (call.agent_id && !call.agent_released_at) {
      await finishAgentCall(client, call.agent_id);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeIncompleteVoicemailPlayback(
  config: AppConfig,
  pool: pg.Pool,
  input: {
    agentId: string | null;
    agentReleased: boolean;
    callId: string;
    contactId: string | null;
    customerLegUuid: string | null;
    forceFailed?: boolean;
    hangupCause?: string;
    raw: Record<string, unknown>;
    source: string;
  }
): Promise<void> {
  const normalHangup = ["NORMAL_CLEARING", "ORIGINATOR_CANCEL"].includes(
    input.hangupCause?.toUpperCase() ?? ""
  );
  const failed = Boolean(input.forceFailed) || !normalHangup;
  const eventType = failed ? "voicemail_playback_failed" : "voicemail_playback_interrupted";
  const terminalState = failed ? "failed" : "completed";
  const outcome = failed ? "failed" : "customer_hung_up";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query(
      `
        update calls
        set state = $2,
            outcome = $3,
            ended_at = coalesce(ended_at, now()),
            updated_at = now()
        where id = $1
          and ended_at is null
          and state in ('voicemail_drop_requested', 'voicemail_playback_started', 'agent_released')
      `,
      [input.callId, terminalState, outcome]
    );
    if (!updated.rowCount) {
      await client.query("rollback");
      return;
    }
    await client.query(
      `
        insert into call_events (
          call_id,
          agent_id,
          event_type,
          state,
          freeswitch_event_name,
          customer_leg_uuid,
          raw_json
        )
        values ($1, $2, $3, $4, 'CUSTOM', $5, $6::jsonb)
        on conflict do nothing
      `,
      [
        input.callId,
        input.agentId,
        eventType,
        eventType,
        input.customerLegUuid,
        JSON.stringify({ ...input.raw, hangupCause: input.hangupCause ?? null, source: input.source })
      ]
    );
    await client.query(
      `
        update call_legs
        set state = 'ended',
            ended_at = coalesce(ended_at, now())
        where call_id = $1
      `,
      [input.callId]
    );
    if (input.contactId) {
      await client.query(
        `
          update contacts
          set status = 'new',
              updated_at = now()
          where id = $1
            and status = 'calling'
        `,
        [input.contactId]
      );
    }
    if (input.agentId && !input.agentReleased) {
      await finishAgentCall(client, input.agentId);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function persistVoicemailDetectionEvent(pool: pg.Pool, frame: EslFrame): Promise<void> {
  const legUuid = frame.headers["unique-id"] ?? frame.headers["variable_uuid"] ?? null;
  if (!legUuid) {
    return;
  }

  const call = await pool.query<{ call_id: string; agent_id: string | null; call_state: string }>(
    `
      select calls.id as call_id, calls.agent_id, calls.state as call_state
      from call_legs
      join calls on calls.id = call_legs.call_id
      where call_legs.freeswitch_uuid = $1
        and call_legs.type = 'customer'
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      order by calls.created_at desc
      limit 1
    `,
    [legUuid]
  );
  const row = call.rows[0];
  if (!row) {
    return;
  }

  const signal = mapVoicemailDetectionSignal(frame);
  if (!signal) {
    return;
  }

  const raw = JSON.stringify({
    headers: frame.headers,
    body: frame.body
  });

  await pool.query(
    `
      insert into voicemail_detection_events (call_id, signal_type, confidence, raw_json)
      values ($1, $2, $3, $4::jsonb)
    `,
    [row.call_id, signal.signalType, signal.confidence, raw]
  );
  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        freeswitch_event_name,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, $3, $4, 'CUSTOM', $5, $6::jsonb)
    `,
    [row.call_id, row.agent_id, signal.eventType, row.call_state, legUuid, raw]
  );
  await pool.query(
    `
      update calls
      set voicemail_signal_status = $2,
          updated_at = now()
      where id = $1
        and state not in ('completed', 'failed', 'canceled')
        and ($2 = 'detected' or voicemail_signal_status is null or voicemail_signal_status = 'none')
    `,
    [row.call_id, signal.status]
  );
}

async function persistAgentRegistrationEvent(
  config: AppConfig,
  pool: pg.Pool,
  frame: EslFrame
): Promise<void> {
  const registrationEvent = mapAgentRegistrationEvent(config, frame);
  if (!registrationEvent) {
    return;
  }

  await pool.query(
    `
      update agents
      set registered = $2,
          last_registered_at = case when $2 then now() else last_registered_at end,
          last_unregistered_at = case when $2 then last_unregistered_at else now() end,
          status = case
            when $2 and status = 'offline' then 'ready'
            when not $2
              and status in ('ready', 'registered')
              and not exists (
                select 1
                from calls
                where calls.agent_id = agents.id
                  and calls.ended_at is null
                  and calls.state not in ('completed', 'failed', 'canceled')
              )
              then 'offline'
            else status
          end,
          updated_at = now()
      where sip_username = $1
    `,
    [registrationEvent.sipUsername, registrationEvent.registered]
  );
}

async function persistBackgroundJobEvent(config: AppConfig, pool: pg.Pool, frame: EslFrame): Promise<void> {
  const jobUuid = frame.headers["job-uuid"];
  if (!jobUuid || !isFailedBackgroundJob(frame)) {
    return;
  }

  const result = await pool.query<{
    call_id: string;
    agent_id: string | null;
    customer_leg_uuid: string | null;
  }>(
    `
      select
        calls.id as call_id,
        calls.agent_id,
        call_legs.freeswitch_uuid as customer_leg_uuid
      from call_events
      join calls on calls.id = call_events.call_id
      left join call_legs on call_legs.call_id = calls.id and call_legs.type = 'customer'
      where call_events.event_type in ('freeswitch_originate_queued', 'freeswitch_agent_bridge_originate_queued')
        and call_events.raw_json ->> 'jobUuid' = $1
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      order by call_events.created_at desc
      limit 1
    `,
    [jobUuid]
  );
  const row = result.rows[0];
  if (!row) {
    return;
  }

  const raw = JSON.stringify({
    headers: frame.headers,
    body: frame.body
  });

  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        freeswitch_event_name,
        api_command_name,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, 'freeswitch_background_job_failed', 'failed', 'BACKGROUND_JOB', $3, $4, $5::jsonb)
    `,
    [row.call_id, row.agent_id, frame.headers["job-command"] ?? "bgapi originate", row.customer_leg_uuid, raw]
  );
  await pool.query(
    `
      update calls
      set state = 'failed',
          outcome = 'failed',
          ended_at = coalesce(ended_at, now()),
          updated_at = now()
      where id = $1
        and state not in ('completed', 'failed', 'canceled')
    `,
    [row.call_id]
  );
  await pool.query(
    `
      update call_legs
      set state = 'ended',
          ended_at = coalesce(ended_at, now())
      where call_id = $1
    `,
    [row.call_id]
  );
  if (row.agent_id) {
    await finishAgentCall(pool, row.agent_id);
  }
  await pool.query(
    `
      update contacts
      set status = 'new',
          updated_at = now()
      where id = (
        select contact_id
        from calls
        where id = $1
      )
        and status = 'calling'
    `,
    [row.call_id]
  );
}

interface ReconciledCallRow {
  agent_id: string | null;
  agent_leg_uuid: string | null;
  answered_at: Date | null;
  call_id: string;
  contact_id: string | null;
  created_at: Date;
  customer_leg_uuid: string | null;
  state: string;
  voicemail_drop_requested_at: Date | null;
}

export async function reconcileActiveCalls(
  config: AppConfig,
  pool: pg.Pool,
  logger: Logger,
  sendApiCommand: FreeSwitchApiCommandSender = sendFreeSwitchApiCommand
): Promise<void> {
  const result = await pool.query<ReconciledCallRow>(
    `
      select
        calls.id as call_id,
        calls.agent_id,
        calls.contact_id,
        calls.state,
        calls.answered_at,
        calls.created_at,
        calls.voicemail_drop_requested_at,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        customer_leg.freeswitch_uuid as customer_leg_uuid
      from calls
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      order by calls.created_at asc
    `
  );

  let closed = 0;
  for (const call of result.rows) {
    try {
      const customerExists = await freeSwitchUuidExists(config, call.customer_leg_uuid, sendApiCommand);
      if (isVoicemailDropActiveState(call.state)) {
        if (customerExists) {
          const requestTimedOut =
            call.state === "voicemail_drop_requested" &&
            call.voicemail_drop_requested_at !== null &&
            Date.now() - call.voicemail_drop_requested_at.getTime() >=
              (config.VOICEMAIL_DROP_START_TIMEOUT_SECONDS ?? 120) * 1000;
          if (requestTimedOut) {
            await abortTimedOutVoicemailDrop(config, pool, call, logger, sendApiCommand);
            closed += 1;
            continue;
          }
          if (call.state === "voicemail_playback_started") {
            await releaseAgentAfterVoicemailPlaybackStarts(
              config,
              pool,
              {
                agentId: call.agent_id,
                agentLegUuid: call.agent_leg_uuid,
                callId: call.call_id,
                customerLegUuid: call.customer_leg_uuid
              },
              sendApiCommand
            );
          }
          continue;
        }
        await finalizeIncompleteVoicemailPlayback(config, pool, {
          agentId: call.agent_id,
          agentReleased: call.state === "agent_released",
          callId: call.call_id,
          contactId: call.contact_id,
          customerLegUuid: call.customer_leg_uuid,
          forceFailed: true,
          raw: { stateBeforeReconciliation: call.state },
          source: "esl_reconnect_reconciliation"
        });
        closed += 1;
        continue;
      }

      // Originate reserves UUIDs before both channels necessarily exist. Let the
      // existing watchdog own young calls so reconnect recovery does not race it.
      if (Date.now() - call.created_at.getTime() < 60_000 || customerExists) {
        continue;
      }

      const agentExists = await freeSwitchUuidExists(config, call.agent_leg_uuid, sendApiCommand);
      if (agentExists && call.agent_leg_uuid) {
        try {
          await sendApiCommand(config, `uuid_kill ${call.agent_leg_uuid}`);
        } catch (error) {
          logger.warn(
            { callId: call.call_id, message: error instanceof Error ? error.message : String(error) },
            "failed to release orphaned agent leg during reconciliation"
          );
        }
      }
      await finalizeMissingActiveCall(config, pool, call);
      closed += 1;
    } catch (error) {
      logger.warn(
        { callId: call.call_id, message: error instanceof Error ? error.message : String(error) },
        "failed to reconcile active call"
      );
    }
  }

  logger.info({ checked: result.rows.length, closed }, "FreeSWITCH active-call reconciliation completed");
}

async function abortTimedOutVoicemailDrop(
  config: AppConfig,
  pool: pg.Pool,
  call: ReconciledCallRow,
  logger: Logger,
  sendApiCommand: FreeSwitchApiCommandSender
): Promise<void> {
  if (call.customer_leg_uuid) {
    await sendApiCommand(config, `uuid_kill ${call.customer_leg_uuid}`);
  }
  if (call.agent_leg_uuid) {
    try {
      await sendApiCommand(config, `uuid_kill ${call.agent_leg_uuid}`);
    } catch (error) {
      if (!/no such channel/i.test(error instanceof Error ? error.message : String(error))) {
        logger.warn(
          { callId: call.call_id, message: error instanceof Error ? error.message : String(error) },
          "failed to release agent leg after a timed-out voicemail drop"
        );
      }
    }
  }
  await finalizeIncompleteVoicemailPlayback(config, pool, {
    agentId: call.agent_id,
    agentReleased: false,
    callId: call.call_id,
    contactId: call.contact_id,
    customerLegUuid: call.customer_leg_uuid,
    forceFailed: true,
    raw: {
      requestedAt: call.voicemail_drop_requested_at?.toISOString() ?? null,
      timeoutSeconds: config.VOICEMAIL_DROP_START_TIMEOUT_SECONDS ?? 120
    },
    source: "reconciliation_voicemail_start_timeout"
  });
}

async function freeSwitchUuidExists(
  config: AppConfig,
  uuid: string | null,
  sendApiCommand: FreeSwitchApiCommandSender
): Promise<boolean> {
  if (!uuid) {
    return false;
  }
  const response = await sendApiCommand(config, `uuid_exists ${uuid}`);
  return response.body.trim().toLowerCase().startsWith("true");
}

async function finalizeMissingActiveCall(
  config: AppConfig,
  pool: pg.Pool,
  call: ReconciledCallRow
): Promise<void> {
  const outcome = call.answered_at ? "customer_hung_up" : "failed";
  const terminalState = outcome === "failed" ? "failed" : "completed";
  const updated = await pool.query(
    `
      update calls
      set state = $2,
          outcome = $3,
          ended_at = coalesce(ended_at, now()),
          updated_at = now()
      where id = $1
        and ended_at is null
        and state not in ('completed', 'failed', 'canceled')
      returning agent_id, contact_id
    `,
    [call.call_id, terminalState, outcome]
  );
  if (!updated.rowCount) {
    return;
  }
  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, 'freeswitch_reconciliation_closed_missing_call', $3, 'uuid_exists', $4, $5, $6::jsonb)
    `,
    [
      call.call_id,
      call.agent_id,
      terminalState,
      call.agent_leg_uuid,
      call.customer_leg_uuid,
      JSON.stringify({ answered: Boolean(call.answered_at), outcome })
    ]
  );
  await pool.query(
    `
      update call_legs
      set state = 'ended',
          ended_at = coalesce(ended_at, now())
      where call_id = $1
    `,
    [call.call_id]
  );
  if (call.contact_id) {
    await pool.query(
      `
        update contacts
        set status = $2,
            updated_at = now()
        where id = $1
          and status = 'calling'
      `,
      [call.contact_id, contactStatusForOutcome(outcome)]
    );
  }
  if (call.agent_id) {
    await finishAgentCall(pool, call.agent_id);
  }
}

function extractFrames(buffer: string): { frames: EslFrame[]; rest: string } {
  const frames: EslFrame[] = [];
  let rest = buffer;

  while (true) {
    const headerEnd = rest.indexOf("\n\n");
    if (headerEnd === -1) {
      break;
    }

    const headers = parseHeaders(rest.slice(0, headerEnd));
    const contentLength = Number(headers["content-length"] ?? 0);
    const bodyStart = headerEnd + 2;
    const bodyEnd = bodyStart + contentLength;
    if (contentLength > 0 && Buffer.byteLength(rest.slice(bodyStart), "utf8") < contentLength) {
      break;
    }

    const frame = {
      headers,
      body: contentLength > 0 ? rest.slice(bodyStart, bodyEnd) : (headers["reply-text"] ?? "")
    };
    frames.push(unwrapPlainEvent(frame));
    rest = rest.slice(contentLength > 0 ? bodyEnd : bodyStart);
  }

  return { frames, rest };
}

function unwrapPlainEvent(frame: EslFrame): EslFrame {
  if (frame.headers["content-type"] !== "text/event-plain") {
    return frame;
  }

  const separator = frame.body.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const headerEnd = frame.body.indexOf(separator);
  if (headerEnd === -1) {
    return frame;
  }

  const eventHeaders = parseHeaders(frame.body.slice(0, headerEnd));
  if (!eventHeaders["event-name"]) {
    return frame;
  }

  return {
    headers: {
      ...frame.headers,
      ...eventHeaders
    },
    body: frame.body.slice(headerEnd + separator.length)
  };
}

function parseHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1) {
          return null;
        }
        return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
  );
}

function isVoicemailDetectionEvent(frame: EslFrame): boolean {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase() ?? "";
  if (eventSubclass === "avmd::beep") {
    return true;
  }
  if (eventSubclass.includes("amd")) {
    return true;
  }
  return Object.entries(frame.headers).some(([key, value]) => {
    const normalizedKey = key.toLowerCase();
    return (
      normalizedKey.includes("amd") ||
      normalizedKey.includes("beep") ||
      value.toLowerCase().includes("voicemail")
    );
  });
}

function isAgentRegistrationEvent(frame: EslFrame): boolean {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase();
  return (
    eventSubclass === "sofia::register" ||
    eventSubclass === "sofia::unregister" ||
    eventSubclass === "sofia::expire"
  );
}

function mapAgentRegistrationEvent(config: AppConfig, frame: EslFrame): AgentRegistrationEvent | null {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase();
  if (
    eventSubclass !== "sofia::register" &&
    eventSubclass !== "sofia::unregister" &&
    eventSubclass !== "sofia::expire"
  ) {
    return null;
  }

  const profileName = firstHeader(frame.headers, ["profile-name", "sofia-profile-name", "profile"]);
  if (profileName && profileName !== AGENT_SIP_PROFILE) {
    return null;
  }

  const domain = firstHeader(frame.headers, ["from-host", "domain-name", "realm", "sip-auth-realm"]);
  if (domain && domain !== config.FREESWITCH_DOMAIN) {
    return null;
  }

  const sipUsername = firstHeader(frame.headers, [
    "from-user",
    "username",
    "user-name",
    "sip-auth-username",
    "user"
  ]);
  if (!sipUsername) {
    return null;
  }

  return {
    eventSubclass,
    registered: eventSubclass === "sofia::register",
    sipUsername
  };
}

function mapVoicemailDetectionSignal(frame: EslFrame): {
  confidence: number | null;
  eventType: string;
  signalType: string;
  status: "possible" | "detected";
} | null {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase() ?? "";
  if (eventSubclass === "avmd::beep") {
    return {
      confidence: null,
      eventType: "voicemail_beep_detected",
      signalType: "beep",
      status: "detected"
    };
  }

  const values = Object.values(frame.headers).join(" ").toLowerCase();
  const result =
    frame.headers["amd-result"] ??
    frame.headers["amd-status"] ??
    frame.headers["answering-machine-detection"] ??
    frame.headers["machine"] ??
    "";
  const normalizedResult = result.toLowerCase();

  if (normalizedResult.includes("human") || values.includes("amd_status=human")) {
    return null;
  }

  if (
    eventSubclass.includes("amd") &&
    (normalizedResult.includes("machine") ||
      normalizedResult.includes("voicemail") ||
      normalizedResult.includes("answering") ||
      values.includes("machine") ||
      values.includes("voicemail"))
  ) {
    return {
      confidence: parseConfidence(frame.headers["amd-confidence"] ?? frame.headers["confidence"]),
      eventType: "voicemail_machine_detected",
      signalType: "machine",
      status: "detected"
    };
  }

  if (eventSubclass.includes("amd")) {
    return {
      confidence: parseConfidence(frame.headers["amd-confidence"] ?? frame.headers["confidence"]),
      eventType: "voicemail_machine_possible",
      signalType: "machine_possible",
      status: "possible"
    };
  }

  return null;
}

function parseConfidence(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstHeader(headers: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = headers[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function mapEventToCallState(eventName: string, hangupCause?: string, legType = "customer"): string {
  if (eventName === "CHANNEL_ANSWER" && legType === "agent") {
    return "agent_answered";
  }
  if ((eventName === "CHANNEL_ANSWER" && legType === "customer") || eventName === "CHANNEL_BRIDGE") {
    return "bridged";
  }
  if (isTerminalEvent(eventName)) {
    if (legType === "agent") {
      return "agent_released";
    }
    return mapHangupCauseToOutcome(hangupCause) === "failed" ? "failed" : "completed";
  }
  return "customer_dialing";
}

function mapEventToLegState(eventName: string): string {
  if (eventName === "CHANNEL_ANSWER" || eventName === "CHANNEL_BRIDGE") {
    return "answered";
  }
  if (isTerminalEvent(eventName)) {
    return "ended";
  }
  return "started";
}

function mapHangupCauseToOutcome(hangupCause?: string): string {
  const normalized = hangupCause?.toUpperCase() ?? "";
  if (["NORMAL_CLEARING", "ORIGINATOR_CANCEL"].includes(normalized)) {
    return "customer_hung_up";
  }
  if (["USER_BUSY"].includes(normalized)) {
    return "busy";
  }
  if (["NO_ANSWER", "NO_USER_RESPONSE", "CALL_REJECTED"].includes(normalized)) {
    return "not_answered";
  }
  return "failed";
}

function resolveCustomerHangupOutcome(input: {
  answered: boolean;
  hangupCause?: string;
  voicemailDetected: boolean;
}): "busy" | "customer_hung_up" | "failed" | "not_answered" | "voicemail_detected" {
  const normalized = input.hangupCause?.toUpperCase() ?? "";
  if (input.answered) {
    return input.voicemailDetected ? "voicemail_detected" : "customer_hung_up";
  }
  if (normalized === "USER_BUSY") {
    return "busy";
  }
  if (["NO_ANSWER", "NO_USER_RESPONSE", "CALL_REJECTED", "ORIGINATOR_CANCEL"].includes(normalized)) {
    return "not_answered";
  }
  return "failed";
}

function contactStatusForOutcome(
  outcome:
    | "answered"
    | "busy"
    | "customer_hung_up"
    | "failed"
    | "not_answered"
    | "voicemail_detected"
    | "voicemail_dropped"
    | "agent_canceled"
): "completed" | "new" {
  return ["answered", "customer_hung_up", "voicemail_detected", "voicemail_dropped"].includes(outcome)
    ? "completed"
    : "new";
}

function isVoicemailDropActiveState(state: string): boolean {
  return (VOICEMAIL_DROP_ACTIVE_STATES as readonly string[]).includes(state);
}

function isFailedBackgroundJob(frame: EslFrame): boolean {
  return frame.body.trimStart().startsWith("-ERR");
}

function isTerminalEvent(eventName: string): boolean {
  return (
    eventName === "CHANNEL_HANGUP" ||
    eventName === "CHANNEL_HANGUP_COMPLETE" ||
    eventName === "CHANNEL_DESTROY"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const __testing = {
  buildCallRecordingPath,
  eventNames: EVENT_NAMES,
  extractFrames,
  getAttemptedVoicemailDetectionModules,
  isFailedBackgroundJob,
  isTransientPersistenceError,
  isTerminalEvent,
  isUuid,
  isAgentRegistrationEvent,
  isVoicemailPlaybackEvent,
  isVoicemailDetectionEvent,
  contactStatusForOutcome,
  freeSwitchUuidExists,
  getVoicemailPlaybackCallId,
  isVoicemailDropActiveState,
  mapVoicemailPlaybackEventKind,
  mapAgentRegistrationEvent,
  mapEventToCallState,
  mapEventToLegState,
  mapHangupCauseToOutcome,
  resolveCustomerHangupOutcome,
  startCallRecording,
  startVoicemailDetection,
  releaseAgentAfterVoicemailPlaybackStarts,
  finalizeCompletedVoicemailPlayback,
  finalizeIncompleteVoicemailPlayback,
  finalizeMissingActiveCall,
  persistFreeSwitchEvent,
  mapVoicemailDetectionSignal,
  parseConfidence,
  parseHeaders
};
