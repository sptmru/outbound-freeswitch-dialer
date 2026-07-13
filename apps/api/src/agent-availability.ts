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
        and wrap_up_until <= now()
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
        and not exists (
          select 1
          from calls
          where calls.agent_id = agents.id
            and calls.ended_at is null
            and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
        )
      returning availability_status, wrap_up_until
    `,
    [agentId, status]
  );
  return result.rows[0] ? mapAgentAvailability(result.rows[0]) : null;
}

export async function finishAgentCall(
  queryable: Queryable,
  agentId: string,
  wrapUpSeconds: number | undefined,
  options: { skipWrapUp?: boolean } = {}
): Promise<void> {
  const seconds = Math.max(0, wrapUpSeconds ?? 0);
  await queryable.query(
    `
      update agents
      set status = case when registered then 'ready' else 'offline' end,
          availability_status = case
            when availability_status = 'paused' then 'paused'
            when $2::boolean then 'available'
            when registered and $3::integer > 0 then 'wrap_up'
            else 'available'
          end,
          wrap_up_until = case
            when $2::boolean or availability_status = 'paused' or not registered or $3::integer = 0 then null
            else now() + make_interval(secs => $3::integer)
          end,
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
    [agentId, Boolean(options.skipWrapUp), seconds]
  );
}

function mapAgentAvailability(row: AgentAvailabilityRow | undefined): AgentAvailability {
  return {
    status: row?.availability_status ?? "available",
    wrapUpUntil: row?.wrap_up_until?.toISOString() ?? null
  };
}
