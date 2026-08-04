import type { CallOutcome, ManualCallStatusResponse } from "@outbound-dialer/shared";
import type pg from "pg";
import { lockCallOwnerAgent } from "../call-finalization.js";

type TerminalCallState = ManualCallStatusResponse["state"];

export type SetManualCallStatusResult =
  | { response: ManualCallStatusResponse; status: "updated" | "already_set" }
  | { status: "active" | "locked" | "missing" };

export async function setManualCallStatus(
  pool: pg.Pool,
  input: { callId: string; outcome: CallOutcome; userId: string }
): Promise<SetManualCallStatusResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const owner = await lockCallOwnerAgent(client, input.callId, input.userId);
    if (!owner.found) {
      await client.query("rollback");
      return { status: "missing" };
    }

    const selected = await client.query<{
      ended_at: Date | null;
      manual_status_locked_at: Date | null;
      outcome: CallOutcome | null;
      state: string;
    }>(
      `
        select state, outcome, ended_at, manual_status_locked_at
        from calls
        where id = $1
        for update
      `,
      [input.callId]
    );
    const call = selected.rows[0];
    if (!call) {
      await client.query("rollback");
      return { status: "missing" };
    }

    if (call.manual_status_locked_at) {
      await client.query("rollback");
      if (
        call.outcome !== input.outcome ||
        !isTerminalCallState(call.state) ||
        call.state !== terminalStateForOutcome(input.outcome)
      ) {
        return { status: "locked" };
      }
      return {
        status: "already_set",
        response: {
          callId: input.callId,
          state: call.state,
          outcome: call.outcome,
          manualStatusLockedAt: call.manual_status_locked_at.toISOString()
        }
      };
    }

    if (!call.ended_at || !isTerminalCallState(call.state)) {
      await client.query("rollback");
      return { status: "active" };
    }

    const state = terminalStateForOutcome(input.outcome);
    const updated = await client.query<{
      manual_status_locked_at: Date;
      outcome: CallOutcome;
      state: TerminalCallState;
    }>(
      `
        update calls
        set state = $2,
            outcome = $3,
            manual_status_locked_at = clock_timestamp(),
            manual_status_locked_by_user_id = $4,
            updated_at = clock_timestamp()
        where id = $1
        returning state, outcome, manual_status_locked_at
      `,
      [input.callId, state, input.outcome, input.userId]
    );
    const row = updated.rows[0];
    if (!row) throw new Error("Manual call status update did not return the call");

    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, raw_json)
        values ($1, $2, 'manual_status_set', $3, $4::jsonb)
      `,
      [
        input.callId,
        owner.agentId,
        state,
        JSON.stringify({
          previousState: call.state,
          previousOutcome: call.outcome,
          outcome: input.outcome
        })
      ]
    );
    await client.query("commit");
    return {
      status: "updated",
      response: {
        callId: input.callId,
        state: row.state,
        outcome: row.outcome,
        manualStatusLockedAt: row.manual_status_locked_at.toISOString()
      }
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function terminalStateForOutcome(outcome: CallOutcome): TerminalCallState {
  if (outcome === "failed") return "failed";
  if (outcome === "agent_canceled" || outcome === "suppressed") return "canceled";
  return "completed";
}

function isTerminalCallState(state: string): state is TerminalCallState {
  return state === "completed" || state === "failed" || state === "canceled";
}
