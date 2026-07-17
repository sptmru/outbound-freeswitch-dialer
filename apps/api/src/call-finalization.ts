import type { CallOutcome, CallState } from "@outbound-dialer/shared";
import type pg from "pg";
import { finishAgentCall } from "./agent-availability.js";

type TerminalCallState = Extract<CallState, "canceled" | "completed" | "failed">;
type TerminalContactStatus = "completed" | "new";

export interface LockedCallForFinalization {
  agentId: string | null;
  answeredAt: Date | null;
  contactId: string | null;
  endedAt: Date | null;
  outcome: CallOutcome | null;
  state: CallState;
  voicemailSignalStatus: string | null;
}

export interface CallFinalizationDecision {
  outcome: CallOutcome;
  state: TerminalCallState;
}

export interface CallFinalizationEvent {
  agentLegUuid?: string | null;
  apiCommandName?: string | null;
  customerLegUuid?: string | null;
  eventType: string;
  freeswitchEventName?: string | null;
  freeswitchEventUuid?: string | null;
  raw?: Record<string, unknown>;
  reasonCode?: string | null;
  state: string;
}

export interface FinalizeCallInput {
  callId: string;
  event?: CallFinalizationEvent;
  persistEventWhenAlreadyFinalized?: boolean;
  resolve: (call: LockedCallForFinalization) => CallFinalizationDecision | null;
  terminal?: {
    eventAt?: Date | null;
    eventName?: string | null;
    source: string;
  };
}

export interface FinalizeCallResult {
  agentId: string | null;
  contactId: string | null;
  outcome: CallOutcome | null;
  status: "already_finalized" | "finalized" | "missing" | "not_applicable";
}

export interface LockedCallOwner {
  agentId: string | null;
  found: boolean;
}

export async function lockCallOwnerAgent(
  client: pg.PoolClient,
  callId: string,
  userId?: string
): Promise<LockedCallOwner> {
  const owner = userId
    ? await client.query<{ agent_id: string | null }>(
        `
          select calls.agent_id
          from calls
          join agents on agents.id = calls.agent_id
          where calls.id = $1
            and agents.user_id = $2
        `,
        [callId, userId]
      )
    : await client.query<{ agent_id: string | null }>("select agent_id from calls where id = $1", [callId]);
  if (!owner.rowCount) {
    return { agentId: null, found: false };
  }
  const agentId = owner.rows[0]?.agent_id ?? null;
  if (agentId) {
    // Call creation locks the agent before checking active calls. Every
    // terminal transaction must preserve that order to avoid a lock cycle.
    await client.query("select id from agents where id = $1 for update", [agentId]);
  }
  return { agentId, found: true };
}

/**
 * Persist the durable side of call finalization as one retry-safe unit.
 *
 * The call row is locked before deciding the outcome. Replays still run the
 * cleanup section when the call was already finalized, which repairs a legacy
 * partial write without changing the winning terminal outcome.
 */
export async function finalizeCallTransaction(
  pool: pg.Pool,
  input: FinalizeCallInput
): Promise<FinalizeCallResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owner = await lockCallOwnerAgent(client, input.callId);
    if (!owner.found) {
      await client.query("rollback");
      return { agentId: null, contactId: null, outcome: null, status: "missing" };
    }
    const selected = await client.query<{
      agent_id: string | null;
      answered_at: Date | null;
      contact_id: string | null;
      ended_at: Date | null;
      outcome: CallOutcome | null;
      state: CallState;
      voicemail_signal_status: string | null;
    }>(
      `
        select
          agent_id,
          answered_at,
          contact_id,
          ended_at,
          outcome,
          state,
          voicemail_signal_status
        from calls
        where id = $1
        for update
      `,
      [input.callId]
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("rollback");
      return { agentId: null, contactId: null, outcome: null, status: "missing" };
    }

    const call: LockedCallForFinalization = {
      agentId: row.agent_id,
      answeredAt: row.answered_at,
      contactId: row.contact_id,
      endedAt: row.ended_at,
      outcome: row.outcome,
      state: row.state,
      voicemailSignalStatus: row.voicemail_signal_status
    };
    const alreadyFinalized =
      Boolean(call.endedAt) && isTerminalCallState(call.state) && Boolean(call.outcome);
    const resolved = alreadyFinalized ? null : input.resolve(call);
    const decision = alreadyFinalized
      ? null
      : isTerminalCallState(call.state)
        ? decisionForTerminalStateWithoutTimestamp(call, call.state, resolved?.outcome)
        : (resolved ?? (call.endedAt ? decisionForEndedNonTerminalCall(call) : null));
    if (!alreadyFinalized && !decision) {
      await client.query("rollback");
      return {
        agentId: call.agentId,
        contactId: call.contactId,
        outcome: call.outcome,
        status: "not_applicable"
      };
    }

    if (input.event && (!alreadyFinalized || input.persistEventWhenAlreadyFinalized)) {
      await insertCallFinalizationEvent(client, input.callId, call.agentId, input.event);
    }

    let outcome = call.outcome;
    if (decision) {
      const updated = await client.query<{ outcome: CallOutcome }>(
        `
          with stamp as (
            select clock_timestamp() as persisted_at
          )
          update calls
          set state = $2,
              outcome = coalesce(outcome, $3),
              ended_at = coalesce(ended_at, stamp.persisted_at),
              freeswitch_terminal_at = coalesce(freeswitch_terminal_at, $4),
              terminal_persisted_at = coalesce(terminal_persisted_at, stamp.persisted_at),
              terminal_source = coalesce(terminal_source, $5),
              terminal_event_name = coalesce(terminal_event_name, $6),
              finalization_latency_ms = coalesce(finalization_latency_ms, case
                when $4::timestamptz is not null
                  and $4 <= stamp.persisted_at
                  and floor(extract(epoch from (stamp.persisted_at - $4)) * 1000) <= 2147483647
                then floor(extract(epoch from (stamp.persisted_at - $4)) * 1000)::integer
                else null
              end),
              updated_at = stamp.persisted_at
          from stamp
          where id = $1
          returning outcome
        `,
        [
          input.callId,
          decision.state,
          decision.outcome,
          input.terminal?.eventAt ?? null,
          input.terminal?.source ?? null,
          input.terminal?.eventName ?? null
        ]
      );
      outcome = updated.rows[0]?.outcome ?? decision.outcome;
    }

    await client.query(
      `
        update call_legs
        set state = 'ended',
            ended_at = coalesce(ended_at, now())
        where call_id = $1
          and (state <> 'ended' or ended_at is null)
      `,
      [input.callId]
    );

    if (call.contactId) {
      // Serialize with contact reservation. If a newer call was being created,
      // the following UPDATE gets a fresh READ COMMITTED snapshot after it commits.
      await client.query("select id from contacts where id = $1 for update", [call.contactId]);
      const contactStatus = contactStatusForCallOutcome(outcome);
      await client.query(
        `
          update contacts
          set status = $2,
              updated_at = now()
          where id = $1
            and status = 'calling'
            and not exists (
              select 1
              from calls active_call
              where active_call.contact_id = $1
                and active_call.id <> $3
                and active_call.ended_at is null
                and active_call.state not in ('completed', 'failed', 'canceled')
            )
        `,
        [call.contactId, contactStatus, input.callId]
      );
    }
    if (call.agentId) {
      await finishAgentCall(client, call.agentId);
    }

    await client.query("commit");
    return {
      agentId: call.agentId,
      contactId: call.contactId,
      outcome,
      status: decision ? "finalized" : "already_finalized"
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function repairFinalizedCallTransaction(pool: pg.Pool, callId: string): Promise<boolean> {
  const result = await finalizeCallTransaction(pool, {
    callId,
    resolve: () => null,
    terminal: { source: "consistency_repair" }
  });
  return result.status === "already_finalized" || result.status === "finalized";
}

export function contactStatusForCallOutcome(outcome: CallOutcome | null): TerminalContactStatus {
  return outcome &&
    ["answered", "customer_hung_up", "voicemail_detected", "voicemail_dropped"].includes(outcome)
    ? "completed"
    : "new";
}

async function insertCallFinalizationEvent(
  client: pg.PoolClient,
  callId: string,
  agentId: string | null,
  event: CallFinalizationEvent
): Promise<void> {
  await client.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        reason_code,
        freeswitch_event_name,
        freeswitch_event_uuid,
        api_command_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      on conflict (freeswitch_event_uuid)
        where freeswitch_event_uuid is not null
        do nothing
    `,
    [
      callId,
      agentId,
      event.eventType,
      event.state,
      event.reasonCode ?? null,
      event.freeswitchEventName ?? null,
      event.freeswitchEventUuid ?? null,
      event.apiCommandName ?? null,
      event.agentLegUuid ?? null,
      event.customerLegUuid ?? null,
      JSON.stringify(event.raw ?? {})
    ]
  );
}

function isTerminalCallState(state: CallState): state is TerminalCallState {
  return state === "canceled" || state === "completed" || state === "failed";
}

function decisionForTerminalStateWithoutTimestamp(
  call: LockedCallForFinalization,
  state: TerminalCallState,
  resolvedOutcome?: CallOutcome
): CallFinalizationDecision {
  const outcome =
    call.outcome ??
    resolvedOutcome ??
    (state === "failed"
      ? "failed"
      : state === "canceled"
        ? "agent_canceled"
        : call.answeredAt
          ? call.voicemailSignalStatus === "detected"
            ? "voicemail_detected"
            : "customer_hung_up"
          : "not_answered");
  return {
    outcome,
    state
  };
}

function decisionForEndedNonTerminalCall(call: LockedCallForFinalization): CallFinalizationDecision {
  const outcome =
    call.outcome ??
    (call.answeredAt
      ? call.voicemailSignalStatus === "detected"
        ? "voicemail_detected"
        : "customer_hung_up"
      : "failed");
  return {
    outcome,
    state: outcome === "failed" ? "failed" : "completed"
  };
}
