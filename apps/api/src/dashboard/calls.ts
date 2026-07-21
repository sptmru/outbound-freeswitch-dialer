import type pg from "pg";
import type { CallOutcome, CallState } from "@outbound-dialer/shared";
import type { AppConfig } from "../config.js";
import { finishAgentCall } from "../agent-availability.js";
import { finalizeCallTransaction, lockCallOwnerAgent } from "../call-finalization.js";
import { startCallPcapCapture } from "../pcap-capture.js";
import {
  canOriginateCustomerLeg,
  createFreeSwitchUuid,
  originateAgentBridgeCall,
  sendFreeSwitchApiCommand
} from "../esl.js";
import { lockDefaultRecordingSelection } from "./recordings.js";

interface LockedCallableContact {
  id: string;
  campaignId: string;
  phoneNumber: string;
  normalizedPhoneNumber: string;
  callRecordingEnabled: boolean;
  earlyMediaAvmdEnabled: boolean;
}

const AGENT_RELEASED_CALL_STATE: CallState = "agent_released";
const VOICEMAIL_DROP_AGENT_RELEASE_STATES = new Set<CallState>([
  "voicemail_drop_requested",
  "voicemail_playback_started",
  "agent_released",
  "voicemail_playback_completed"
]);

async function getNextCallableContactForUpdate(
  client: pg.PoolClient,
  campaignId: string,
  retryPolicy: { maxAttempts: number; retryDelaySeconds: number }
): Promise<LockedCallableContact | null> {
  const result = await client.query<{
    id: string;
    campaign_id: string;
    phone_number: string;
    normalized_phone_number: string;
    call_recording_enabled: boolean;
    early_media_avmd_enabled: boolean;
  }>(
    `
      select
        contacts.id,
        contacts.campaign_id,
        contacts.phone_number,
        contacts.normalized_phone_number,
        campaigns.call_recording_enabled,
        campaigns.early_media_avmd_enabled
      from contacts
      join campaigns on campaigns.id = contacts.campaign_id
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.campaign_id = $1
        and campaigns.status = 'active'
        and contacts.status not in ('calling', 'completed', 'suppressed')
        and contacts.attempt_count < $2
        and (
          contacts.last_attempted_at is null
          or contacts.last_attempted_at <= now() - make_interval(secs => $3)
        )
        and suppression_entries.id is null
      order by contacts.last_attempted_at asc nulls first, contacts.created_at asc
      limit 1
      for update of contacts skip locked
    `,
    [campaignId, retryPolicy.maxAttempts, retryPolicy.retryDelaySeconds]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    campaignId: row.campaign_id,
    phoneNumber: row.phone_number,
    normalizedPhoneNumber: row.normalized_phone_number,
    callRecordingEnabled: row.call_recording_enabled,
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled
  };
}

async function getCallableContactForUpdate(
  client: pg.PoolClient,
  contactId: string,
  retryPolicy: { maxAttempts: number; retryDelaySeconds: number }
): Promise<LockedCallableContact | null> {
  const result = await client.query<{
    id: string;
    campaign_id: string;
    phone_number: string;
    normalized_phone_number: string;
    call_recording_enabled: boolean;
    early_media_avmd_enabled: boolean;
  }>(
    `
      select
        contacts.id,
        contacts.campaign_id,
        contacts.phone_number,
        contacts.normalized_phone_number,
        campaigns.call_recording_enabled,
        campaigns.early_media_avmd_enabled
      from contacts
      join campaigns on campaigns.id = contacts.campaign_id
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.id = $1
        and campaigns.status = 'active'
        and contacts.status not in ('calling', 'completed', 'suppressed')
        and contacts.attempt_count < $2
        and (
          contacts.last_attempted_at is null
          or contacts.last_attempted_at <= now() - make_interval(secs => $3)
        )
        and suppression_entries.id is null
      limit 1
      for update of contacts
    `,
    [contactId, retryPolicy.maxAttempts, retryPolicy.retryDelaySeconds]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    campaignId: row.campaign_id,
    phoneNumber: row.phone_number,
    normalizedPhoneNumber: row.normalized_phone_number,
    callRecordingEnabled: row.call_recording_enabled,
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled
  };
}

async function getDefaultRecordingId(client: pg.Pool | pg.PoolClient): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      select id
      from recordings
      where is_active = true
      order by is_default desc, created_at desc
      limit 1
    `
  );
  return result.rows[0]?.id ?? null;
}

type CreateDialerCallFailureReason =
  | "active_call"
  | "agent_paused"
  | "agent_not_registered"
  | "lead_not_callable"
  | "maintenance"
  | "no_callable_contacts";

type CreateDialerCallResult =
  { ok: true; callId: string; campaignId: string } | { ok: false; reason: CreateDialerCallFailureReason };

interface DialerCallContext {
  callRecordingEnabled: boolean;
  earlyMediaAvmdEnabled: boolean;
  campaignId: string;
  contactId: string | null;
  destinationNumber: string;
  normalizedDestinationNumber: string;
}

export async function createDialerCall(
  pool: pg.Pool,
  config: AppConfig,
  input: {
    agentId: string;
    campaignId: string | null;
    contactId: string | null | "next";
    destinationNumber?: string;
    normalizedDestinationNumber?: string;
    sipUsername: string;
    manualDial: boolean;
    callRecordingEnabled: boolean;
    earlyMediaAvmdEnabled: boolean;
    eventType: string;
  }
): Promise<CreateDialerCallResult> {
  const client = await pool.connect();
  let callId: string | null = null;
  let callContext: DialerCallContext;
  let committedContext: DialerCallContext | null = null;
  try {
    await client.query("begin");

    // The certificate maintenance workflow updates this same durable row to
    // true before checking active calls. FOR SHARE lets ordinary call starts
    // proceed concurrently, while the maintenance update waits for every
    // in-flight create transaction and closes the check/start race.
    await client.query(
      `insert into system_settings (key, value_json)
       values ('ops.call_start_paused', 'false'::jsonb)
       on conflict (key) do nothing`
    );
    const callStartGate = await client.query<{ paused: boolean }>(
      `select value_json = 'true'::jsonb as paused
       from system_settings
       where key = 'ops.call_start_paused'
       for share`
    );
    if (callStartGate.rows[0]?.paused) {
      await client.query("rollback");
      return { ok: false, reason: "maintenance" };
    }

    await client.query(
      `
        update agents
        set availability_status = 'available',
            wrap_up_until = null,
            updated_at = now()
        where id = $1
          and availability_status = 'wrap_up'
      `,
      [input.agentId]
    );
    const agent = await client.query<{
      availability_status: "available" | "paused" | "wrap_up";
      registered: boolean;
    }>("select registered, availability_status from agents where id = $1 for update", [input.agentId]);
    const agentState = agent.rows[0];
    if (!agentState?.registered) {
      await client.query("rollback");
      return { ok: false, reason: "agent_not_registered" };
    }
    if (agentState.availability_status === "paused") {
      await client.query("rollback");
      return { ok: false, reason: "agent_paused" };
    }
    const activeCall = await client.query<{ id: string }>(
      `
        select id
        from calls
        where agent_id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled', 'agent_released')
        limit 1
        for update
      `,
      [input.agentId]
    );
    if (activeCall.rowCount) {
      await client.query("rollback");
      return { ok: false, reason: "active_call" };
    }

    if (input.contactId === "next") {
      if (!input.campaignId) {
        throw new Error("campaignId is required for next-contact calls");
      }
      const contact = await getNextCallableContactForUpdate(client, input.campaignId, {
        maxAttempts: config.CONTACT_MAX_ATTEMPTS,
        retryDelaySeconds: config.CONTACT_RETRY_DELAY_SECONDS
      });
      if (!contact) {
        await client.query("rollback");
        return { ok: false, reason: "no_callable_contacts" };
      }
      callContext = {
        callRecordingEnabled: contact.callRecordingEnabled,
        earlyMediaAvmdEnabled: contact.earlyMediaAvmdEnabled,
        campaignId: contact.campaignId,
        contactId: contact.id,
        destinationNumber: contact.phoneNumber,
        normalizedDestinationNumber: contact.normalizedPhoneNumber
      };
    } else if (input.contactId) {
      const contact = await getCallableContactForUpdate(client, input.contactId, {
        maxAttempts: config.CONTACT_MAX_ATTEMPTS,
        retryDelaySeconds: config.CONTACT_RETRY_DELAY_SECONDS
      });
      if (!contact) {
        await client.query("rollback");
        return { ok: false, reason: "lead_not_callable" };
      }
      callContext = {
        callRecordingEnabled: contact.callRecordingEnabled,
        earlyMediaAvmdEnabled: contact.earlyMediaAvmdEnabled,
        campaignId: contact.campaignId,
        contactId: contact.id,
        destinationNumber: contact.phoneNumber,
        normalizedDestinationNumber: contact.normalizedPhoneNumber
      };
    } else {
      if (!input.campaignId || !input.destinationNumber || !input.normalizedDestinationNumber) {
        throw new Error("manual dial calls require campaign and destination numbers");
      }
      callContext = {
        callRecordingEnabled: input.callRecordingEnabled,
        earlyMediaAvmdEnabled: input.earlyMediaAvmdEnabled,
        campaignId: input.campaignId,
        contactId: null,
        destinationNumber: input.destinationNumber,
        normalizedDestinationNumber: input.normalizedDestinationNumber
      };
    }

    await lockDefaultRecordingSelection(client);
    const recordingId = await getDefaultRecordingId(client);
    const call = await client.query<{ id: string }>(
      `
        insert into calls (
          agent_id,
          campaign_id,
          contact_id,
          destination_number,
          normalized_destination_number,
          state,
          recording_id,
          manual_dial,
          call_recording_enabled,
          call_recording_status,
          early_media_avmd_enabled,
          started_at
        )
        values ($1, $2, $3, $4, $5, 'customer_dialing', $6, $7, $8, case when $8 then 'pending' else 'disabled' end, $9, now())
        returning id
      `,
      [
        input.agentId,
        callContext.campaignId,
        callContext.contactId,
        callContext.destinationNumber,
        callContext.normalizedDestinationNumber,
        recordingId,
        input.manualDial,
        callContext.callRecordingEnabled,
        callContext.earlyMediaAvmdEnabled
      ]
    );
    callId = call.rows[0].id;

    if (config.PCAP_CAPTURE_ENABLED) {
      await client.query("insert into call_pcaps (call_id, status) values ($1, 'pending')", [callId]);
    }

    await client.query(
      `
        insert into call_legs (call_id, type, state, started_at, sip_uri)
        values
          ($1, 'agent', 'created', now(), $2),
          ($1, 'customer', 'created', now(), null)
      `,
      [callId, `sip:${input.sipUsername}@${config.FREESWITCH_DOMAIN}`]
    );
    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, raw_json)
        values ($1, $2, $3, 'customer_dialing', $4::jsonb)
      `,
      [
        callId,
        input.agentId,
        input.eventType,
        JSON.stringify({
          destinationNumber: callContext.destinationNumber,
          manualDial: input.manualDial
        })
      ]
    );
    await client.query("update agents set status = 'in_call', updated_at = now() where id = $1", [
      input.agentId
    ]);
    if (callContext.contactId) {
      await client.query(
        `
          update contacts
          set status = 'calling',
              attempt_count = attempt_count + 1,
              last_attempted_at = now(),
              updated_at = now()
          where id = $1
        `,
        [callContext.contactId]
      );
    }
    await client.query("commit");
    committedContext = callContext;
  } catch (error) {
    await client.query("rollback");
    const uniqueConflict = mapCreateDialerCallUniqueViolation(error);
    if (uniqueConflict) {
      return { ok: false, reason: uniqueConflict };
    }
    throw error;
  } finally {
    client.release();
  }

  if (!callId || !committedContext) {
    throw new Error("Dialer call transaction completed without a call");
  }

  await startCallPcapCapture(pool, config, callId);

  await syncFreeSwitchOriginate(pool, config, {
    agentId: input.agentId,
    callId,
    destinationNumber: committedContext.destinationNumber,
    sipUsername: input.sipUsername
  });
  return { ok: true, callId, campaignId: committedContext.campaignId };
}

export function createDialerCallFailureMessage(reason: CreateDialerCallFailureReason): string {
  if (reason === "active_call") {
    return "An active call is already in progress";
  }
  if (reason === "agent_not_registered") {
    return "The browser phone must be connected before starting a call";
  }
  if (reason === "agent_paused") {
    return "Resume calling before starting a call";
  }
  if (reason === "no_callable_contacts") {
    return "No callable contacts are available";
  }
  if (reason === "maintenance") {
    return "Calling is temporarily paused for certificate maintenance";
  }
  return "Lead is not callable";
}

function mapCreateDialerCallUniqueViolation(error: unknown): CreateDialerCallFailureReason | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505") {
    return null;
  }
  const constraint = "constraint" in error && typeof error.constraint === "string" ? error.constraint : "";
  if (constraint.includes("agent")) {
    return "active_call";
  }
  if (constraint.includes("contact")) {
    return "lead_not_callable";
  }
  return null;
}

export async function syncFreeSwitchOriginate(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; callId: string; destinationNumber: string; sipUsername: string }
): Promise<void> {
  if (!canOriginateCustomerLeg(config)) {
    await failDialerCallFromFreeSwitch(pool, config, input.agentId, input.callId, null, {
      eventType: "freeswitch_originate_skipped",
      apiCommandName: "bgapi originate",
      raw: {
        reason: "SIP trunk is not configured",
        destinationNumber: input.destinationNumber
      }
    });
    return;
  }

  try {
    const agentLegUuid = await createFreeSwitchUuid(config);
    const customerLegUuid = await createFreeSwitchUuid(config);
    const originate = await originateAgentBridgeCall(config, {
      agentLegUuid,
      callId: input.callId,
      customerLegUuid,
      destinationNumber: input.destinationNumber,
      sipUsername: input.sipUsername
    });
    await pool.query(
      `
        update call_legs
        set freeswitch_uuid = $2,
            state = 'started',
            started_at = coalesce(started_at, now())
        where call_id = $1
          and type = 'agent'
      `,
      [input.callId, originate.agentLegUuid]
    );
    await pool.query(
      `
        update call_legs
        set freeswitch_uuid = $2
        where call_id = $1
          and type = 'customer'
      `,
      [input.callId, originate.customerLegUuid]
    );
    await insertCallEvent(pool, {
      agentId: input.agentId,
      callId: input.callId,
      eventType: "freeswitch_agent_bridge_originate_queued",
      state: "agent_ringing",
      apiCommandName: "bgapi originate",
      agentLegUuid: originate.agentLegUuid,
      customerLegUuid: originate.customerLegUuid,
      raw: {
        command: originate.command,
        jobUuid: originate.jobUuid
      }
    });
    await pool.query(
      `
        update calls
        set state = 'agent_ringing',
            updated_at = now()
        where id = $1
          and state not in ('completed', 'failed', 'canceled')
      `,
      [input.callId]
    );
    scheduleOriginateWatchdog(pool, config, {
      agentId: input.agentId,
      agentLegUuid: originate.agentLegUuid,
      callId: input.callId,
      customerLegUuid: originate.customerLegUuid,
      jobUuid: originate.jobUuid
    });
  } catch (error) {
    await finalizeCallTransaction(pool, {
      callId: input.callId,
      event: {
        apiCommandName: "bgapi originate",
        eventType: "freeswitch_originate_failed",
        raw: { message: error instanceof Error ? error.message : "FreeSWITCH originate failed" },
        state: "failed"
      },
      resolve: () => ({ outcome: "failed", state: "failed" }),
      terminal: { source: "originate_failure" }
    });
  }
}

function scheduleOriginateWatchdog(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; agentLegUuid: string; callId: string; customerLegUuid: string; jobUuid: string },
  phase: "agent" | "customer" = "agent",
  retryAttempt = 0,
  retryDelay = false
): void {
  const timer = setTimeout(
    () => {
      void closeMissingOriginateLeg(pool, config, input, phase, retryAttempt);
    },
    originateWatchdogDelayMilliseconds(config, phase, retryDelay)
  );
  timer.unref?.();
}

function originateWatchdogDelayMilliseconds(
  config: AppConfig,
  phase: "agent" | "customer",
  retryDelay: boolean
): number {
  return (
    (retryDelay
      ? (config.ORIGINATE_WATCHDOG_RETRY_SECONDS ?? 5)
      : phase === "agent"
        ? (config.ORIGINATE_AGENT_WATCHDOG_SECONDS ?? 35)
        : (config.ORIGINATE_CUSTOMER_WATCHDOG_SECONDS ?? 50)) * 1000
  );
}

async function closeMissingOriginateLeg(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; agentLegUuid: string; callId: string; customerLegUuid: string; jobUuid: string },
  phase: "agent" | "customer",
  retryAttempt: number,
  sendApiCommand: typeof sendFreeSwitchApiCommand = sendFreeSwitchApiCommand
): Promise<void> {
  try {
    const call = await pool.query<{ state: CallState; ended_at: Date | null }>(
      "select state, ended_at from calls where id = $1",
      [input.callId]
    );
    const row = call.rows[0];
    if (!row || row.ended_at || ["completed", "failed", "canceled"].includes(row.state)) {
      return;
    }

    if (phase === "agent") {
      // A voicemail drop deliberately releases the interactive agent leg while
      // the customer leg continues playback as a background job. The originate
      // watchdog must not reinterpret that expected absence as originate failure.
      if (VOICEMAIL_DROP_AGENT_RELEASE_STATES.has(row.state)) {
        scheduleOriginateWatchdog(pool, config, input, "customer");
        return;
      }
      const response = await sendApiCommand(config, `uuid_exists ${input.agentLegUuid}`);
      if (response.body.trim().toLowerCase().startsWith("true")) {
        scheduleOriginateWatchdog(pool, config, input, "customer");
        return;
      }
      await failDialerCallFromFreeSwitch(pool, config, input.agentId, input.callId, input.customerLegUuid, {
        eventType: "freeswitch_originate_agent_leg_missing",
        apiCommandName: "uuid_exists",
        raw: {
          agentLegUuid: input.agentLegUuid,
          customerLegUuid: input.customerLegUuid,
          jobUuid: input.jobUuid,
          response: response.body.trim() || response.headers["reply-text"] || ""
        }
      });
      return;
    }

    const response = await sendApiCommand(config, `uuid_exists ${input.customerLegUuid}`);
    if (response.body.trim().toLowerCase().startsWith("true")) {
      return;
    }
    await failDialerCallFromFreeSwitch(pool, config, input.agentId, input.callId, input.customerLegUuid, {
      eventType: "freeswitch_originate_leg_missing",
      apiCommandName: "uuid_exists",
      raw: {
        customerLegUuid: input.customerLegUuid,
        jobUuid: input.jobUuid,
        phase,
        response: response.body.trim() || response.headers["reply-text"] || ""
      }
    });
  } catch (error) {
    const nextAttempt = retryAttempt + 1;
    if (nextAttempt <= (config.ORIGINATE_WATCHDOG_MAX_RETRIES ?? 3)) {
      scheduleOriginateWatchdog(pool, config, input, phase, nextAttempt, true);
    }
    try {
      await insertCallEvent(pool, {
        agentId: input.agentId,
        callId: input.callId,
        eventType: "freeswitch_originate_watchdog_failed",
        state: "customer_dialing",
        apiCommandName: "uuid_exists",
        customerLegUuid: input.customerLegUuid,
        raw: {
          customerLegUuid: input.customerLegUuid,
          jobUuid: input.jobUuid,
          phase,
          retryAttempt: nextAttempt,
          retryScheduled: nextAttempt <= (config.ORIGINATE_WATCHDOG_MAX_RETRIES ?? 3),
          message: error instanceof Error ? error.message : "FreeSWITCH originate watchdog failed"
        }
      });
    } catch {
      // The scheduled retry remains authoritative when PostgreSQL is also transiently unavailable.
    }
  }
}

async function failDialerCallFromFreeSwitch(
  pool: pg.Pool,
  _config: AppConfig,
  _agentId: string,
  callId: string,
  customerLegUuid: string | null,
  event: { eventType: string; apiCommandName: string; raw: Record<string, unknown> }
): Promise<void> {
  await finalizeCallTransaction(pool, {
    callId,
    event: {
      apiCommandName: event.apiCommandName,
      customerLegUuid,
      eventType: event.eventType,
      raw: event.raw,
      state: "failed"
    },
    resolve: () => ({ outcome: "failed", state: "failed" }),
    terminal: {
      source: event.eventType === "freeswitch_originate_skipped" ? "originate_failure" : "originate_watchdog"
    }
  });
}

async function killFreeSwitchLeg(
  pool: pg.Pool,
  config: AppConfig,
  callId: string,
  agentId: string,
  leg: { type: "agent" | "customer"; uuid: string | null }
): Promise<void> {
  if (!leg.uuid || !config.FREESWITCH_ESL_ENABLED) {
    return;
  }

  try {
    await sendFreeSwitchApiCommand(config, `uuid_kill ${leg.uuid}`);
    await insertCallEvent(pool, {
      agentId,
      callId,
      eventType: "freeswitch_uuid_kill_sent",
      state: "completed",
      apiCommandName: "uuid_kill",
      agentLegUuid: leg.type === "agent" ? leg.uuid : undefined,
      customerLegUuid: leg.type === "customer" ? leg.uuid : undefined,
      raw: { legType: leg.type, legUuid: leg.uuid }
    });
  } catch (error) {
    await insertCallEvent(pool, {
      agentId,
      callId,
      eventType: "freeswitch_uuid_kill_failed",
      state: "completed",
      apiCommandName: "uuid_kill",
      agentLegUuid: leg.type === "agent" ? leg.uuid : undefined,
      customerLegUuid: leg.type === "customer" ? leg.uuid : undefined,
      raw: {
        legType: leg.type,
        legUuid: leg.uuid,
        message: error instanceof Error ? error.message : "FreeSWITCH uuid_kill failed"
      }
    });
  }
}

async function insertCallEvent(
  pool: pg.Pool,
  input: {
    agentId: string;
    callId: string;
    eventType: string;
    state: string;
    apiCommandName?: string;
    agentLegUuid?: string;
    customerLegUuid?: string;
    raw: Record<string, unknown>;
  }
): Promise<void> {
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
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      input.callId,
      input.agentId,
      input.eventType,
      input.state,
      input.apiCommandName ?? null,
      input.agentLegUuid ?? null,
      input.customerLegUuid ?? null,
      JSON.stringify(input.raw)
    ]
  );
}

export async function dropVoicemailForCall(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  callId: string,
  recordingId?: string,
  sendApiCommand: typeof sendFreeSwitchApiCommand = sendFreeSwitchApiCommand
): Promise<{ ok: true } | { ok: false; statusCode: 404 | 409 | 502; message: string }> {
  const initial = await getVoicemailDropCall(pool, userId, callId, recordingId);
  const row = initial.rows[0];
  if (!row) {
    return { ok: false, statusCode: 404, message: "Active call not found" };
  }
  if (isVoicemailDropInProgressOrCompleted(row.state, row.outcome)) {
    return { ok: true };
  }
  if (row.ended_at || ["completed", "failed", "canceled"].includes(row.state)) {
    return { ok: false, statusCode: 404, message: "Active call not found" };
  }
  if (recordingId && !row.selected_recording_id) {
    return { ok: false, statusCode: 409, message: "Selected voicemail recording is not available" };
  }
  if (!row.customer_leg_uuid) {
    return { ok: false, statusCode: 409, message: "Customer leg is not ready for voicemail drop" };
  }
  if (row.state !== "bridged" && row.state !== "voicemail_signal_detected") {
    return { ok: false, statusCode: 409, message: "Voicemail drop is available after the customer answers" };
  }
  if (!row.runtime_file_path) {
    return { ok: false, statusCode: 409, message: "No voicemail recording is assigned to this call" };
  }

  const client = await pool.connect();
  let claimed: VoicemailDropCallRow | null = null;
  try {
    await client.query("begin");
    const locked = await getVoicemailDropCall(client, userId, callId, recordingId, true);
    claimed = locked.rows[0] ?? null;
    if (!claimed) {
      await client.query("rollback");
      return { ok: false, statusCode: 404, message: "Active call not found" };
    }
    if (isVoicemailDropInProgressOrCompleted(claimed.state, claimed.outcome)) {
      await client.query("rollback");
      return { ok: true };
    }
    if (
      claimed.ended_at ||
      (claimed.state !== "bridged" && claimed.state !== "voicemail_signal_detected") ||
      !claimed.customer_leg_uuid ||
      !claimed.runtime_file_path ||
      (recordingId && !claimed.selected_recording_id)
    ) {
      await client.query("rollback");
      return { ok: false, statusCode: 409, message: "The call is no longer available for voicemail drop" };
    }

    if (!claimed.effective_recording_id) {
      await client.query("rollback");
      return { ok: false, statusCode: 409, message: "The voicemail recording is no longer available" };
    }
    const lockedRecording = await client.query<{ runtime_file_path: string }>(
      `
        select runtime_file_path
        from recordings
        where id = $1
          and is_active = true
        for key share
      `,
      [claimed.effective_recording_id]
    );
    if (!lockedRecording.rows[0]) {
      await client.query("rollback");
      return { ok: false, statusCode: 409, message: "The voicemail recording is no longer available" };
    }
    claimed.runtime_file_path = lockedRecording.rows[0].runtime_file_path;

    const effectiveRecordingId = claimed.effective_recording_id;
    const updated = await client.query(
      `
        update calls
        set state = 'voicemail_drop_requested',
            recording_id = coalesce($2, recording_id),
            voicemail_drop_requested_at = coalesce(voicemail_drop_requested_at, now()),
            updated_at = now()
        where id = $1
          and ended_at is null
          and state in ('bridged', 'voicemail_signal_detected')
      `,
      [callId, effectiveRecordingId]
    );
    if (!updated.rowCount) {
      await client.query("rollback");
      return { ok: true };
    }
    await client.query(
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
        values ($1, $2, 'voicemail_drop_requested', 'voicemail_drop_requested', 'uuid_transfer', $3, $4, $5::jsonb)
        on conflict do nothing
      `,
      [
        callId,
        claimed.agent_id,
        claimed.agent_leg_uuid,
        claimed.customer_leg_uuid,
        JSON.stringify({ recordingId: effectiveRecordingId, recordingPath: claimed.runtime_file_path })
      ]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  if (!claimed?.customer_leg_uuid || !claimed.runtime_file_path) {
    throw new Error("Voicemail drop was claimed without a customer leg or recording path");
  }

  try {
    const customerLegUuid = assertFreeSwitchApiArgument(claimed.customer_leg_uuid, "customer leg UUID");
    const voicemailPath = assertFreeSwitchApiArgument(claimed.runtime_file_path, "voicemail recording path");
    const safeCallId = assertFreeSwitchApiArgument(callId, "call ID");
    await sendApiCommand(config, `uuid_setvar ${customerLegUuid} voicemail_drop_call_id ${safeCallId}`);
    await sendApiCommand(config, `uuid_setvar ${customerLegUuid} voicemail_drop_file ${voicemailPath}`);
    await sendApiCommand(config, `uuid_transfer ${customerLegUuid} voicemail_drop XML default`);
    await releaseAgentAfterVoicemailDropTransfer(pool, config, callId, claimed, sendApiCommand);
  } catch (error) {
    const message = error instanceof Error ? error.message : "FreeSWITCH voicemail drop failed";
    const explicitCommandRejection = message.trimStart().startsWith("-ERR");
    if (explicitCommandRejection) {
      await pool.query(
        `
          update calls
          set state = $2,
              voicemail_drop_requested_at = null,
              updated_at = now()
          where id = $1
            and ended_at is null
            and state = 'voicemail_drop_requested'
        `,
        [callId, claimed.state]
      );
    }
    await insertCallEvent(pool, {
      agentId: claimed.agent_id,
      callId,
      eventType: "voicemail_drop_failed",
      state: claimed.state,
      apiCommandName: "uuid_transfer",
      agentLegUuid: claimed.agent_leg_uuid ?? undefined,
      customerLegUuid: claimed.customer_leg_uuid,
      raw: {
        ambiguous: !explicitCommandRejection,
        message,
        recordingPath: claimed.runtime_file_path
      }
    });
    return { ok: false, statusCode: 502, message: "The calling service could not start voicemail playback" };
  }

  return { ok: true };
}

async function releaseAgentAfterVoicemailDropTransfer(
  pool: pg.Pool,
  config: AppConfig,
  callId: string,
  call: Pick<VoicemailDropCallRow, "agent_id" | "agent_leg_uuid" | "customer_leg_uuid">,
  sendApiCommand: typeof sendFreeSwitchApiCommand
): Promise<void> {
  const releaseResult: Record<string, unknown> = {};
  let releaseConfirmed = false;
  if (call.agent_leg_uuid) {
    try {
      const response = await sendApiCommand(config, `uuid_kill ${call.agent_leg_uuid}`);
      releaseResult.response = response.body.trim();
      releaseConfirmed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      releaseResult.message = message;
      releaseConfirmed = /no such channel/i.test(message);
    }
  } else {
    releaseResult.message = "Agent leg UUID was not persisted";
  }

  if (!releaseConfirmed) {
    await insertCallEvent(pool, {
      agentId: call.agent_id,
      callId,
      eventType: "agent_release_failed",
      state: "voicemail_drop_requested",
      apiCommandName: "uuid_kill",
      agentLegUuid: call.agent_leg_uuid ?? undefined,
      customerLegUuid: call.customer_leg_uuid ?? undefined,
      raw: releaseResult
    });
    return;
  }

  await pool.query(
    `
      insert into call_events (
        call_id, agent_id, event_type, state, api_command_name,
        agent_leg_uuid, customer_leg_uuid, raw_json
      )
      values ($1, $2, 'agent_released', 'agent_released', 'uuid_kill', $3, $4, $5::jsonb)
      on conflict do nothing
    `,
    [callId, call.agent_id, call.agent_leg_uuid, call.customer_leg_uuid, JSON.stringify(releaseResult)]
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
    [callId]
  );
  await pool.query(
    `
      update call_legs
      set state = 'ended',
          ended_at = coalesce(ended_at, now())
      where call_id = $1
        and type = 'agent'
    `,
    [callId]
  );
  await finishAgentCall(pool, call.agent_id);
}

interface VoicemailDropCallRow {
  agent_id: string;
  contact_id: string | null;
  agent_leg_uuid: string | null;
  customer_leg_uuid: string | null;
  effective_recording_id: string | null;
  ended_at: Date | null;
  outcome: CallOutcome | null;
  runtime_file_path: string | null;
  selected_recording_id: string | null;
  state: CallState;
}

function getVoicemailDropCall(
  queryable: pg.Pool | pg.PoolClient,
  userId: string,
  callId: string,
  recordingId?: string,
  lock = false
): Promise<pg.QueryResult<VoicemailDropCallRow>> {
  return queryable.query<VoicemailDropCallRow>(
    `
      select
        calls.agent_id,
        calls.state,
        calls.outcome,
        calls.ended_at,
        calls.contact_id,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        customer_leg.freeswitch_uuid as customer_leg_uuid,
        selected_recording.id as selected_recording_id,
        coalesce(selected_recording.id, recordings.id) as effective_recording_id,
        coalesce(selected_recording.runtime_file_path, recordings.runtime_file_path) as runtime_file_path
      from calls
      join agents on agents.id = calls.agent_id
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      left join recordings on recordings.id = calls.recording_id and recordings.is_active = true
      left join recordings selected_recording on selected_recording.id = $3 and selected_recording.is_active = true
      where calls.id = $1
        and agents.user_id = $2
      limit 1
      ${lock ? "for update of calls" : ""}
    `,
    [callId, userId, recordingId ?? null]
  );
}

function isVoicemailDropInProgressOrCompleted(state: CallState, outcome: CallOutcome | null): boolean {
  return (
    outcome === "voicemail_dropped" ||
    state === "voicemail_drop_requested" ||
    state === "voicemail_playback_started" ||
    state === AGENT_RELEASED_CALL_STATE ||
    state === "voicemail_playback_completed"
  );
}

export async function sendDtmfForCall(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  callId: string,
  digit: string
): Promise<{ ok: true } | { ok: false; statusCode: 404 | 409 | 502; message: string }> {
  const result = await pool.query<{
    agent_id: string;
    agent_leg_uuid: string | null;
    customer_leg_uuid: string | null;
    state: CallState;
  }>(
    `
      select
        calls.agent_id,
        calls.state,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        customer_leg.freeswitch_uuid as customer_leg_uuid
      from calls
      join agents on agents.id = calls.agent_id
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where calls.id = $1
        and agents.user_id = $2
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      limit 1
    `,
    [callId, userId]
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, statusCode: 404, message: "Active call not found" };
  }
  if (!row.customer_leg_uuid) {
    return { ok: false, statusCode: 409, message: "Customer leg is not ready for DTMF" };
  }
  if (row.state !== "bridged" && row.state !== "voicemail_signal_detected") {
    return { ok: false, statusCode: 409, message: "DTMF is available after the customer answers" };
  }

  try {
    const customerLegUuid = assertFreeSwitchApiArgument(row.customer_leg_uuid, "customer leg UUID");
    await sendFreeSwitchApiCommand(config, `uuid_send_dtmf ${customerLegUuid} ${digit}`);
  } catch (error) {
    await insertCallEvent(pool, {
      agentId: row.agent_id,
      callId,
      eventType: "dtmf_failed",
      state: row.state,
      apiCommandName: "uuid_send_dtmf",
      agentLegUuid: row.agent_leg_uuid ?? undefined,
      customerLegUuid: row.customer_leg_uuid,
      raw: {
        digit,
        message: error instanceof Error ? error.message : "FreeSWITCH DTMF failed"
      }
    });
    return { ok: false, statusCode: 502, message: "The calling service could not send the keypad tone" };
  }

  await insertCallEvent(pool, {
    agentId: row.agent_id,
    callId,
    eventType: "dtmf_sent",
    state: row.state,
    apiCommandName: "uuid_send_dtmf",
    agentLegUuid: row.agent_leg_uuid ?? undefined,
    customerLegUuid: row.customer_leg_uuid,
    raw: { digit }
  });
  return { ok: true };
}

function assertFreeSwitchApiArgument(value: string, label: string): string {
  if (/\s/.test(value)) {
    throw new Error(`${label} contains whitespace and cannot be used in a FreeSWITCH API command`);
  }
  return value;
}

export async function endDialerCall(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  callId: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owner = await lockCallOwnerAgent(client, callId, userId);
    if (!owner.found) {
      await client.query("rollback");
      return false;
    }
    const call = await client.query<{
      id: string;
      agent_id: string;
      contact_id: string | null;
      agent_leg_uuid: string | null;
      customer_leg_uuid: string | null;
      state: CallState;
    }>(
      `
        select
          calls.id,
          calls.agent_id,
          calls.contact_id,
          calls.state,
          agent_leg.freeswitch_uuid as agent_leg_uuid,
          customer_leg.freeswitch_uuid as customer_leg_uuid
        from calls
        join agents on agents.id = calls.agent_id
        left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
        left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
        where calls.id = $1
          and agents.user_id = $2
          and calls.ended_at is null
          and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
        for update of calls
      `,
      [callId, userId]
    );

    const row = call.rows[0];
    if (!row) {
      await client.query("rollback");
      return false;
    }
    const outcome = inferAgentEndOutcome(row.state);

    await client.query(
      `
        with stamp as (select clock_timestamp() as persisted_at)
        update calls
        set state = 'completed',
            outcome = $2,
            ended_at = stamp.persisted_at,
            terminal_persisted_at = stamp.persisted_at,
            terminal_source = 'agent_api',
            updated_at = stamp.persisted_at
        from stamp
        where id = $1
      `,
      [callId, outcome]
    );
    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, raw_json)
        values ($1, $2, 'call_ended', 'completed', $3::jsonb)
      `,
      [callId, row.agent_id, JSON.stringify({ outcome })]
    );
    await client.query(
      `
        update call_legs
        set state = 'ended',
            ended_at = coalesce(ended_at, now())
        where call_id = $1
          and (state <> 'ended' or ended_at is null)
      `,
      [callId]
    );

    if (row.contact_id) {
      const nextStatus = outcome === "agent_canceled" ? "new" : "completed";
      await client.query(
        `
          update contacts
          set status = $2,
              updated_at = now()
          where id = $1
            and status = 'calling'
        `,
        [row.contact_id, nextStatus]
      );
    }

    await finishAgentCall(client, row.agent_id);
    await client.query("commit");
    await killFreeSwitchLeg(pool, config, callId, row.agent_id, { type: "agent", uuid: row.agent_leg_uuid });
    await killFreeSwitchLeg(pool, config, callId, row.agent_id, {
      type: "customer",
      uuid: row.customer_leg_uuid
    });
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function inferAgentEndOutcome(state: CallState): CallOutcome {
  return state === "bridged" || state === "voicemail_signal_detected" ? "answered" : "agent_canceled";
}

export const __testing = {
  closeMissingOriginateLeg,
  getCallableContactForUpdate,
  getNextCallableContactForUpdate,
  originateWatchdogDelayMilliseconds
};
