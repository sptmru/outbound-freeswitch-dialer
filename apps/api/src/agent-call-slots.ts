import { randomUUID } from "node:crypto";
import type pg from "pg";

export const occupiedSlotStates = ["reserved", "connecting", "active", "releasing", "uncertain"] as const;
export type OccupiedSlotState = (typeof occupiedSlotStates)[number];

export interface SlotToken {
  agentId: string;
  callId: string;
  reservationId: string;
  // PostgreSQL bigint stays a string; do not truncate it through JS numbers.
  generation: string;
}

// Internal persistence primitives only. C01 owns eligibility/common admission;
// callers must supply its transaction client, never a pool or ESL callback.
export async function reserveAgentCallSlot(
  client: pg.PoolClient,
  agentId: string,
  callId: string,
  participantId: string | null = null
): Promise<SlotToken | null> {
  const result = await client.query<{ reservation_id: string; generation: string }>(
    `update agent_call_slots set state='reserved',call_id=$2,participant_id=$3,
       reservation_id=$4 where agent_id=$1 and state='free' and not reconciliation_required
     returning reservation_id,generation`,
    [agentId, callId, participantId, randomUUID()]
  );
  const row = result.rows[0];
  return row ? { agentId, callId, reservationId: row.reservation_id, generation: row.generation } : null;
}

export async function updateAgentCallSlot(
  client: pg.PoolClient,
  token: SlotToken,
  state: OccupiedSlotState
): Promise<boolean> {
  const result = await client.query(
    `update agent_call_slots set state=$5 where agent_id=$1 and call_id=$2
       and reservation_id=$3 and generation=$4 and state<>'free' and not reconciliation_required`,
    [token.agentId, token.callId, token.reservationId, token.generation, state]
  );
  return result.rowCount === 1;
}

// This flag is a caller assertion of resolved commands and confirmed leg cleanup,
// not a substitute for FS evidence. No timestamp/lease-expiry release is provided.
export async function releaseAgentCallSlot(
  client: pg.PoolClient,
  token: SlotToken,
  cleanupConfirmed: boolean
): Promise<boolean> {
  if (!cleanupConfirmed) return false;
  const result = await client.query(
    `update agent_call_slots set state='free',call_id=null,participant_id=null,
       reservation_id=null where agent_id=$1 and call_id=$2 and reservation_id=$3
       and generation=$4 and state<>'free' and not reconciliation_required`,
    [token.agentId, token.callId, token.reservationId, token.generation]
  );
  return result.rowCount === 1;
}
