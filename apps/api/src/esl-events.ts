import net from "node:net";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";

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

type AgentRegistrationEvent = {
  eventSubclass: "sofia::register" | "sofia::unregister" | "sofia::expire";
  registered: boolean;
  sipUsername: string;
};

export function startFreeSwitchEventListener(config: AppConfig, pool: pg.Pool, logger: Logger): () => void {
  if (!config.FREESWITCH_ESL_ENABLED) {
    logger.info({ enabled: false }, "FreeSWITCH event listener disabled");
    return () => undefined;
  }

  let stopped = false;
  let socket: net.Socket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

      for (const frame of extraction.frames) {
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
            logger.info({ events: EVENT_NAMES }, "FreeSWITCH event listener subscribed");
            continue;
          }
          nextSocket.destroy(new Error(frame.headers["reply-text"] ?? "FreeSWITCH ESL event subscription failed"));
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
          void persistFreeSwitchEvent(config, pool, frame).catch((error: unknown) => {
            logger.error(error, "failed to persist FreeSWITCH event");
          });
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
      if (socket === nextSocket) {
        socket = null;
      }
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.destroy();
    socket = null;
  };
}

async function persistFreeSwitchEvent(config: AppConfig, pool: pg.Pool, frame: EslFrame): Promise<void> {
  const eventName = frame.headers["event-name"];
  if (eventName === "BACKGROUND_JOB") {
    await persistBackgroundJobEvent(pool, frame);
    return;
  }
  if (eventName === "CUSTOM" && isAgentRegistrationEvent(frame)) {
    await persistAgentRegistrationEvent(config, pool, frame);
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
    frame.headers["unique-id"] ?? frame.headers["variable_uuid"] ?? frame.headers["variable_origination_uuid"] ?? null;
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
    [callId, eventType, state, eventName, legType === "agent" ? legUuid : null, legType === "customer" ? legUuid : null, raw]
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
          and state not in ('completed', 'failed', 'canceled')
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
          and state not in ('completed', 'failed', 'canceled', 'bridged')
      `,
      [callId]
    );
  }

  if ((eventName === "CHANNEL_ANSWER" && legType === "customer") || eventName === "CHANNEL_BRIDGE") {
    await pool.query(
      `
        update calls
        set state = 'bridged',
            answered_at = coalesce(answered_at, now()),
            updated_at = now()
        where id = $1
          and state not in ('completed', 'failed', 'canceled')
      `,
      [callId]
    );

    if (legType === "customer" && legUuid) {
      await startVoicemailDetection(config, pool, {
        callId,
        customerLegUuid: legUuid
      });
    }
  }

  if (eventName === "CHANNEL_HANGUP" || eventName === "CHANNEL_HANGUP_COMPLETE" || eventName === "CHANNEL_DESTROY") {
    const outcome = mapHangupCauseToOutcome(frame.headers["hangup-cause"]);
    const terminalState = outcome === "failed" ? "failed" : "completed";
    await pool.query(
      `
        update calls
        set state = $2,
            outcome = coalesce(outcome, $3),
            ended_at = coalesce(ended_at, now()),
            updated_at = now()
        where id = $1
          and state not in ('completed', 'failed', 'canceled')
      `,
      [callId, terminalState, outcome]
    );
    await pool.query(
      `
        update agents
        set status = case when registered then 'ready' else 'offline' end,
            updated_at = now()
        where id = (
          select agent_id
          from calls
          where id = $1
        )
      `,
      [callId]
    );
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
      [callId]
    );
  }
}

async function startVoicemailDetection(
  config: AppConfig,
  pool: pg.Pool,
  input: { callId: string; customerLegUuid: string }
): Promise<void> {
  const alreadyStarted = await pool.query<{ id: string }>(
    `
      select id
      from call_events
      where call_id = $1
        and customer_leg_uuid = $2
        and event_type = 'voicemail_detection_started'
      limit 1
    `,
    [input.callId, input.customerLegUuid]
  );
  if (alreadyStarted.rowCount) {
    return;
  }

  const raw: Record<string, unknown> = {};
  const modules: Array<{ module: "mod_avmd" | "mod_amd"; command: string }> = [
    { module: "mod_avmd", command: `avmd ${input.customerLegUuid} start` },
    { module: "mod_amd", command: `amd ${input.customerLegUuid} start` }
  ];

  for (const module of modules) {
    try {
      const moduleExists = await sendFreeSwitchApiCommand(config, `module_exists ${module.module}`);
      if (moduleExists.body.trim() !== "true") {
        raw[module.module] = { status: "unavailable" };
        continue;
      }
      const response = await sendFreeSwitchApiCommand(config, module.command);
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
        'bridged',
        'voicemail detection start',
        $2,
        $3::jsonb
      )
    `,
    [input.callId, input.customerLegUuid, JSON.stringify(raw)]
  );
}

async function persistVoicemailDetectionEvent(pool: pg.Pool, frame: EslFrame): Promise<void> {
  const legUuid = frame.headers["unique-id"] ?? frame.headers["variable_uuid"] ?? null;
  const eventSubclass = frame.headers["event-subclass"] ?? "";
  if (!legUuid) {
    return;
  }

  const call = await pool.query<{ call_id: string; agent_id: string | null }>(
    `
      select calls.id as call_id, calls.agent_id
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
      values ($1, $2, $3, 'bridged', 'CUSTOM', $4, $5::jsonb)
    `,
    [row.call_id, row.agent_id, signal.eventType, legUuid, raw]
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

async function persistAgentRegistrationEvent(config: AppConfig, pool: pg.Pool, frame: EslFrame): Promise<void> {
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

async function persistBackgroundJobEvent(pool: pg.Pool, frame: EslFrame): Promise<void> {
  const jobUuid = frame.headers["job-uuid"];
  if (!jobUuid || !isFailedBackgroundJob(frame)) {
    return;
  }

  const result = await pool.query<{ call_id: string; agent_id: string | null; customer_leg_uuid: string | null }>(
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
  await pool.query(
    `
      update agents
      set status = case when registered then 'ready' else 'offline' end,
          updated_at = now()
      where id = $1
    `,
    [row.agent_id]
  );
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
      body: contentLength > 0 ? rest.slice(bodyStart, bodyEnd) : headers["reply-text"] ?? ""
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
    return normalizedKey.includes("amd") || normalizedKey.includes("beep") || value.toLowerCase().includes("voicemail");
  });
}

function isAgentRegistrationEvent(frame: EslFrame): boolean {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase();
  return eventSubclass === "sofia::register" || eventSubclass === "sofia::unregister" || eventSubclass === "sofia::expire";
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

function mapVoicemailDetectionSignal(
  frame: EslFrame
): { confidence: number | null; eventType: string; signalType: string; status: "possible" | "detected" } | null {
  const eventSubclass = frame.headers["event-subclass"]?.toLowerCase() ?? "";
  if (eventSubclass === "avmd::beep") {
    return {
      confidence: null,
      eventType: "voicemail_beep_detected",
      signalType: "beep",
      status: "detected"
    };
  }

  const values = Object.values(frame.headers)
    .join(" ")
    .toLowerCase();
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

function isFailedBackgroundJob(frame: EslFrame): boolean {
  return frame.body.trimStart().startsWith("-ERR");
}

function isTerminalEvent(eventName: string): boolean {
  return eventName === "CHANNEL_HANGUP" || eventName === "CHANNEL_HANGUP_COMPLETE" || eventName === "CHANNEL_DESTROY";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const __testing = {
  extractFrames,
  isFailedBackgroundJob,
  isTerminalEvent,
  isUuid,
  isAgentRegistrationEvent,
  isVoicemailDetectionEvent,
  mapAgentRegistrationEvent,
  mapEventToCallState,
  mapEventToLegState,
  mapHangupCauseToOutcome,
  persistFreeSwitchEvent,
  mapVoicemailDetectionSignal,
  parseConfidence,
  parseHeaders
};
