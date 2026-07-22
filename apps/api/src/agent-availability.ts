import type pg from "pg";
import type { AgentAvailabilityStatus } from "@outbound-dialer/shared";

export interface AgentAvailability {
  status: AgentAvailabilityStatus;
  wrapUpUntil: string | null;
}

type Queryable = pg.Pool | pg.PoolClient;

interface AgentAvailabilityRow {
  availability_status: AgentAvailabilityStatus;
  wrap_up_until: Date | null;
}

export async function getAgentAvailability(queryable: Queryable, userId: string): Promise<AgentAvailability> {
  await queryable.query(
    `
      update agents
      set availability_status = 'available',
          wrap_up_until = null,
          updated_at = now()
      where user_id = $1
        and availability_status = 'wrap_up'
    `,
    [userId]
  );
  const result = await queryable.query<AgentAvailabilityRow>(
    `
      select availability_status, wrap_up_until
      from agents
      where user_id = $1
      limit 1
    `,
    [userId]
  );
  return mapAgentAvailability(result.rows[0]);
}

export async function setAgentAvailability(
  queryable: Queryable,
  agentId: string,
  status: Exclude<AgentAvailabilityStatus, "wrap_up">
): Promise<AgentAvailability | null> {
  const result = await queryable.query<AgentAvailabilityRow>(
    `
      update agents
      set availability_status = $2,
          wrap_up_until = null,
          updated_at = now()
      where id = $1
      returning availability_status, wrap_up_until
    `,
    [agentId, status]
  );
  return result.rows[0] ? mapAgentAvailability(result.rows[0]) : null;
}

export async function finishAgentCall(queryable: Queryable, agentId: string): Promise<void> {
  await queryable.query(
    `
      update agents
      set status = case when registered then 'ready' else 'offline' end,
          availability_status = case
            when availability_status = 'paused' then 'paused'
            else 'available'
          end,
          wrap_up_until = null,
          updated_at = now()
      where id = $1
        and not exists (
          select 1
          from calls active_call
          where active_call.agent_id = agents.id
            and active_call.ended_at is null
            and active_call.state not in ('completed', 'failed', 'canceled', 'agent_released')
        )
    `,
    [agentId]
  );
}

function mapAgentAvailability(row: AgentAvailabilityRow | undefined): AgentAvailability {
  return {
    status: row?.availability_status ?? "available",
    wrapUpUntil: row?.wrap_up_until?.toISOString() ?? null
  };
}
