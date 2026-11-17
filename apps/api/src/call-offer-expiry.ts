import type pg from "pg";

/** SQL only, under common admission and recipient locks. No slot/customer
 * mutation. The B04 trigger captures immutable per-call exclusions atomically.
 */
export async function expireInboundOffers(
  client: pg.PoolClient,
  agentIds: string[],
  sourceCallIds: string[] = []
) {
  // Only offered transfers have no media resources. Accepted/uncertain work is
  // never released by expiry. Both history rows share the same closure outcome.
  await client.query(
    `with stamp as materialized(select clock_timestamp() as at)
     update call_transfers t set state=case when c.ended_at is not null then 'canceled' else 'expired' end,
       reason=case when c.ended_at is not null then 'call_closed' else 'deadline_elapsed' end,closed_at=stamp.at
     from stamp,calls c where t.call_id=c.id and t.state='offered' and t.closed_at is null
       and (t.recipient_agent_id=any($1::uuid[]) or t.call_id=any($2::uuid[]))
       and (t.deadline_at<=stamp.at or c.ended_at is not null or exists(
         select 1 from call_offers o where o.transfer_id=t.id and o.state='pending' and o.deadline_at<=stamp.at))`,
    [agentIds, sourceCallIds]
  );
  await client.query(
    `update call_offers o set state=t.state,reason=t.reason,closed_at=t.closed_at
     from call_transfers t where o.transfer_id=t.id and o.state='pending'
       and t.closed_at is not null and (t.recipient_agent_id=any($1::uuid[]) or t.call_id=any($2::uuid[]))`,
    [agentIds, sourceCallIds]
  );
  return client.query(
    `with stamp as materialized(select clock_timestamp() as at)
     update call_offers o set state='expired',reason='deadline_elapsed',closed_at=stamp.at
     from stamp where o.kind='inbound' and o.state='pending'
       and o.agent_id=any($1::uuid[]) and o.deadline_at<=stamp.at returning o.id`,
    [agentIds]
  );
}
