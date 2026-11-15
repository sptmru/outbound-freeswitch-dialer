import type pg from "pg";
import { ADMISSION_LOCK_NAMESPACE, AdmissionError } from "./call-admission.js";
import { lockUserMediaAction } from "./user-media-lock.js";

/** Short SQL-only mutations, including feature-off compatibility writers. This
 * cannot allocate slots or media and therefore does not require cutover. Never
 * call from a transaction or while holding a user-media/execution session lock.
 */
export async function withEligibilityTransaction<T>(
  pool: pg.Pool,
  action: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level read committed");
    await client.query("set local lock_timeout='250ms'");
    await client.query("set local statement_timeout='500ms'");
    await client.query("set local idle_in_transaction_session_timeout='1000ms'");
    await client.query("select pg_advisory_xact_lock($1,0)", [ADMISSION_LOCK_NAMESPACE]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockEligibilityAgents(client: pg.PoolClient, agentIds: string[]) {
  const agents = (
    await client.query<{ id: string; user_id: string }>(
      "select id,user_id from agents where id=any($1::uuid[]) order by id",
      [agentIds]
    )
  ).rows;
  for (const user of [...new Set(agents.map((a) => a.user_id))].sort()) {
    await lockUserMediaAction(client, user);
    await client.query("select id from users where id=$1 for share", [user]);
  }
  for (const agent of agents) await client.query("select id from agents where id=$1 for update", [agent.id]);
  for (const agent of agents)
    await client.query("select agent_id from agent_call_slots where agent_id=$1 for update", [agent.id]);
  return agents;
}

/** Recipient-only invalidation. Acceptance/connecting work and occupied slots
 * survive. Elapsed offers keep their permanent deadline exclusion; ordinary
 * eligibility cancellation does not manufacture an Ignore.
 */
export async function cancelPendingAgentWork(client: pg.PoolClient, agentIds: string[], reason: string) {
  await client.query(
    `with stamp as materialized(select clock_timestamp() as at)
     update call_transfers set state=case when deadline_at<=stamp.at then 'expired' else 'canceled' end,
      reason=case when deadline_at<=stamp.at then 'deadline_elapsed' else $2 end,
      closed_at=stamp.at from stamp
     where recipient_agent_id=any($1::uuid[]) and state='offered' and exists(
       select 1 from call_offers o where o.transfer_id=call_transfers.id and o.state='pending')`,
    [agentIds, reason]
  );
  await client.query(
    `with stamp as materialized(select clock_timestamp() as at)
     update call_offers set state=case when deadline_at<=stamp.at then 'expired' else 'canceled' end,
      reason=case when deadline_at<=stamp.at then 'deadline_elapsed' else $2 end,
      closed_at=stamp.at from stamp
     where agent_id=any($1::uuid[]) and state='pending'`,
    [agentIds, reason]
  );
  await client.query(
    `update agent_auto_next_intents set state='canceled',reason=$2,closed_at=clock_timestamp()
     where agent_id=any($1::uuid[]) and state in ('pending','deferred')`,
    [agentIds, reason]
  );
}

/** Internal D01 adapter: authenticated controller and exact binding CAS. It can
 * change the selected campaign or clear readiness, never attest a SIP endpoint.
 * Positive readiness must come from D01's server-side contact verification.
 */
export async function changeDeskEligibility(
  pool: pg.Pool,
  input: {
    actorUserId: string;
    actorAuthVersion: number;
    agentId: string;
    deskSessionId: string;
    expectedRevision: string;
    bindingGeneration: string;
    campaignId?: string;
    clearReadiness?: boolean;
  }
) {
  return withEligibilityTransaction(pool, async (client) => {
    // Parent campaign rows precede media/agent/Desk writes.
    const current = (
      await client.query("select campaign_id from agent_desk_sessions where id=$1", [input.deskSessionId])
    ).rows[0];
    for (const campaign of [...new Set([current?.campaign_id, input.campaignId].filter(Boolean))].sort())
      await client.query("select id from campaigns where id=$1 for share", [campaign]);
    await lockEligibilityAgents(client, [input.agentId]);
    const session = (
      await client.query(
        `select d.* from agent_desk_sessions d join agents a on a.id=d.agent_id
         join users u on u.id=a.user_id where d.id=$1 and a.id=$2 and u.id=$3
         and u.is_active and u.auth_version=$4 and d.revoked_at is null and d.expires_at>clock_timestamp()`,
        [input.deskSessionId, input.agentId, input.actorUserId, input.actorAuthVersion]
      )
    ).rows[0];
    if (!session) throw new AdmissionError("not_controller");
    if (session.revision !== input.expectedRevision || session.binding_generation !== input.bindingGeneration)
      throw new AdmissionError("revision_conflict");
    if (
      input.campaignId &&
      !(await client.query("select 1 from campaigns where id=$1 and status='active'", [input.campaignId]))
        .rowCount
    )
      throw new AdmissionError("campaign_unavailable");
    const campaignChanged = input.campaignId !== undefined && input.campaignId !== session.campaign_id;
    const readinessChanged = input.clearReadiness && (session.ready || session.verified_endpoint !== null);
    if (!campaignChanged && !readinessChanged) return session;
    const updated = (
      await client.query(
        `update agent_desk_sessions set campaign_id=$2,revision=revision+1,
        ready=case when $3 then false else ready end,
        verified_endpoint=case when $3 then null else verified_endpoint end,
        verified_generation=case when $3 then null else verified_generation end,
        verified_at=case when $3 then null else verified_at end where id=$1 returning *`,
        [session.id, input.campaignId ?? session.campaign_id, Boolean(input.clearReadiness)]
      )
    ).rows[0];
    await cancelPendingAgentWork(
      client,
      [input.agentId],
      campaignChanged ? "campaign_changed" : "endpoint_unavailable"
    );
    return updated;
  });
}
