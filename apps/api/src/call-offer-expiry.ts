import type pg from "pg";

/** SQL only, under common admission and recipient locks. No slot/customer
 * mutation. The B04 trigger captures immutable per-call exclusions atomically.
 */
export async function expireInboundOffers(client: pg.PoolClient, agentIds: string[]) {
  return client.query(
    `with stamp as materialized(select clock_timestamp() as at)
     update call_offers o set state='expired',reason='deadline_elapsed',closed_at=stamp.at
     from stamp where o.kind='inbound' and o.state='pending'
       and o.agent_id=any($1::uuid[]) and o.deadline_at<=stamp.at returning o.id`,
    [agentIds]
  );
}
